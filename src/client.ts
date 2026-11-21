import { BaileysAdapter } from './adapters/baileys-adapter.js'
import { backoffDelay } from './core/backoff.js'
import { Emitter } from './core/emitter.js'
import { createLogger } from './core/logger.js'
import { RetryQueue } from './core/queue.js'
import type {
  AuthSession,
  ButtonMessageOptions,
  ButtonReply,
  ClientEvents,
  ClientOptions,
  ClientStats,
  ClientStatus,
  CloseReason,
  ConnectionState,
  LiveSocket,
  NormalizedMessage,
  OutboundMessage,
  QuickReplyButton,
  SocketAdapter,
  SocketAdapterEvents,
} from './types.js'

interface ResolvedOptions {
  sessionDir: string
  appName: string
  phoneNumber?: string
  printQR: boolean
  backoff: NonNullable<ClientOptions['backoff']>
  maxReconnectAttempts: number
  heartbeatEveryMs: number
  staleAfterMs: number
  restartDelayMs: number
  reconnectOnLoggedOut: boolean
  reconnectOnBanned: boolean
  queue: NonNullable<ClientOptions['queue']>
  socketOptions: Record<string, unknown>
}

let messageSequence = 0

/**
 * Cliente principal. Mantiene una máquina de estados, aplica backoff con jitter,
 * hace heartbeat, guarda credenciales sin bloquear y encola mensajes When
 * la conexión no está lista.
 */
export class BaileysClient {
  private readonly opts: ResolvedOptions
  private readonly logger = createLogger({ prefix: '[sora/baileys]' })
  private readonly adapter: SocketAdapter
  private readonly events: Emitter<ClientEvents>
  private readonly queue: RetryQueue<OutboundMessage>
  private readonly stats: ClientStats = {
    reconnects: 0,
    messagesSent: 0,
    messagesFailed: 0,
    messagesDropped: 0,
    startedAt: null,
    connectedAt: null,
    lastError: undefined,
  }

  private state: ConnectionState = 'idle'
  private attempt = 0
  private generation = 0
  private auth: AuthSession | undefined
  private socket: LiveSocket | undefined
  private reconnectTimer: NodeJS.Timeout | undefined
  private heartbeatTimer: NodeJS.Timeout | undefined
  private credsTimer: NodeJS.Timeout | undefined
  private credsChain: Promise<void> = Promise.resolve()
  private lastActivityAt = 0
  private stopped = false
  private starting: Promise<void> | undefined
  private stopping: Promise<void> | undefined

  constructor(options: ClientOptions = {}) {
    this.opts = resolveOptions(options)
    this.logger = options.logger ?? this.logger
    this.adapter = options.adapter ?? new BaileysAdapter(this.logger)
    this.events = new Emitter<ClientEvents>((error, event) => {
      this.logger.error('event listener failed', { event, error })
    })

    this.queue = new RetryQueue<OutboundMessage>({
      ...this.opts.queue,
      logger: this.logger,
      onSend: async (payload) => {
        const socket = this.socket
        if (!socket || this.state !== 'connected') throw new Error('socket not ready')
        const result = payload.buttons
          ? await this.sendButtonsThrough(socket, payload)
          : await socket.sendText(payload.to, payload.text, payload.metadata)
        this.stats.messagesSent += 1
        this.events.emit('sent', {
          id: result.id,
          to: payload.to,
          kind: payload.buttons ? 'buttons' : 'text',
        })
      },
    })
  }

  get status(): ClientStatus {
    return {
      state: this.state,
      attempt: this.attempt,
      queueSize: this.queue.size,
      stats: { ...this.stats },
    }
  }

  get sessionDir(): string {
    return this.opts.sessionDir
  }

  on<K extends keyof ClientEvents>(event: K, listener: (payload: ClientEvents[K]) => void): () => void {
    return this.events.on(event, listener)
  }

  once<K extends keyof ClientEvents>(event: K, listener: (payload: ClientEvents[K]) => void): () => void {
    return this.events.once(event, listener)
  }

  off<K extends keyof ClientEvents>(event: K, listener: (payload: ClientEvents[K]) => void): void {
    this.events.off(event, listener)
  }

  /** Inicia el ciclo de conexión. Resuelve cuando el primer intento arranca, no cuando conecta. */
  start(): Promise<void> {
    if (this.starting) return this.starting
    if (this.state === 'starting' || this.state === 'connecting' || this.state === 'connected' || this.state === 'reconnecting') {
      return Promise.resolve()
    }
    if (this.state === 'stopped') this.resetForStart()

    this.stopped = false
    this.stats.startedAt ??= Date.now()
    this.setState('starting')
    this.starting = (async () => {
      try {
        await this.beginCycle()
      } finally {
        this.starting = undefined
      }
    })()
    return this.starting
  }

  /** Detiene el cliente de forma idempotente y espera a soltar el socket. */
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.stopping = this.stopInternal()
    try {
      await this.stopping
    } finally {
      this.stopping = undefined
    }
  }

  /** Reinicia limpiando la sesión en memoria (útil tras logout o cambio de número). */
  async restart(): Promise<void> {
    await this.stop()
    this.resetForStart()
    await this.start()
  }

  /**
   * Envía texto. Si no hay conexión (o falla el envío), el mensaje queda en cola
   * y se reintenta al reconectar.
   */
  async sendText(to: string, text: string, metadata?: Record<string, unknown>): Promise<{ id: string; queued: boolean }> {
    const id = typeof metadata?.id === 'string' ? metadata.id : `local-${++messageSequence}`

    if (this.state === 'connected' && this.socket) {
      try {
        const result = await this.socket.sendText(to, text, metadata)
        this.stats.messagesSent += 1
        this.events.emit('sent', { id: result.id, to, kind: 'text' })
        return { id: result.id, queued: false }
      } catch (error) {
        this.stats.messagesFailed += 1
        this.stats.lastError = error
        this.events.emit('error', { where: 'sendText', error })
      }
    }

    const queuedId = this.queue.enqueue({ to, text, id, metadata }, id)
    this.events.emit('queued', { id: queuedId, size: this.queue.size })
    return { id: queuedId, queued: true }
  }

  /**
   * Envía un mensaje con botones de respuesta rápida (máximo 3 en WhatsApp).
   * Si el socket no soporta botones o falla, el mensaje se encola igual que un texto.
   */
  async sendButtons(
    to: string,
    text: string,
    buttons: QuickReplyButton[],
    options: ButtonMessageOptions = {},
  ): Promise<{ id: string; queued: boolean }> {
    const normalized = normalizeButtons(buttons)
    const id = typeof options.metadata?.id === 'string' ? options.metadata.id : `local-${++messageSequence}`
    const payload: OutboundMessage = {
      to,
      text,
      id,
      buttons: normalized,
      header: options.header,
      footer: options.footer,
      metadata: options.metadata,
    }

    if (this.state === 'connected' && this.socket && this.socket.sendButtons) {
      try {
        const result = await this.sendButtonsThrough(this.socket, payload)
        this.stats.messagesSent += 1
        this.events.emit('sent', { id: result.id, to, kind: 'buttons' })
        return { id: result.id, queued: false }
      } catch (error) {
        this.stats.messagesFailed += 1
        this.stats.lastError = error
        this.events.emit('error', { where: 'sendButtons', error })
      }
    }

    const queuedId = this.queue.enqueue(payload, id)
    this.events.emit('queued', { id: queuedId, size: this.queue.size })
    return { id: queuedId, queued: true }
  }

  private async sendButtonsThrough(
    socket: LiveSocket,
    payload: OutboundMessage,
  ): Promise<{ id: string }> {
    if (!socket.sendButtons) throw new Error('adapter does not support buttons')
    return socket.sendButtons(payload.to, payload.text, payload.buttons ?? [], {
      header: payload.header,
      footer: payload.footer,
      metadata: payload.metadata,
    })
  }

  /** espera a que el cliente alcance un estado. */
  waitForState(target: ConnectionState, timeoutMs = 10_000): Promise<ClientStatus> {
    if (this.state === target) return Promise.resolve(this.status)
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout
      const off = this.events.on('state', ({ current }) => {
        if (current !== target) return
        cleanup()
        resolve(this.status)
      })
      const cleanup = (): void => {
        off()
        clearTimeout(timer)
      }
      timer = setTimeout(() => {
        cleanup()
        reject(new Error(`timeout waiting for state "${target}" (current: ${this.state})`))
      }, timeoutMs)
      timer.unref?.()
    })
  }

  /** Espera un evento con filtro opcional; útil en tests y scripts. */
  waitForEvent<K extends keyof ClientEvents>(
    event: K,
    timeoutMs = 10_000,
    predicate?: (payload: ClientEvents[K]) => boolean,
  ): Promise<ClientEvents[K]> {
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout
      const off = this.events.on(event, (payload) => {
        if (predicate && !predicate(payload)) return
        cleanup()
        resolve(payload)
      })
      const cleanup = (): void => {
        off()
        clearTimeout(timer)
      }
      timer = setTimeout(() => {
        cleanup()
        reject(new Error(`timeout waiting for event "${String(event)}"`))
      }, timeoutMs)
      timer.unref?.()
    })
  }

  private async beginCycle(): Promise<void> {
    if (this.stopped) return
    const gen = ++this.generation
    this.attempt += 1
    this.setState('connecting')
    this.events.emit('connecting', { attempt: this.attempt })

    try {
      if (!this.auth) {
        this.auth = await this.adapter.loadAuth({
          sessionDir: this.opts.sessionDir,
          logger: this.logger,
        })
      }
      const socket = await this.adapter.connect({
        auth: this.auth,
        phoneNumber: this.opts.phoneNumber,
        printQR: this.opts.printQR,
        appName: this.opts.appName,
        socketOptions: this.opts.socketOptions,
        logger: this.logger,
        onEvent: (event, payload) => this.handleAdapterEvent(gen, event, payload),
      })

      if (gen !== this.generation || this.stopped) {
        await socket.disconnect?.().catch((error: unknown) => {
          this.events.emit('error', { where: 'disconnect-stale', error })
        })
        return
      }
      this.socket = socket
      // El adaptador puede emitir `open` antes de que connect() resuelva; en ese
      // caso flushQueue() ya corrió sin socket. Reintentamos el vaciado aquí.
      if (this.state === 'connected') void this.flushQueue()
    } catch (error) {
      if (gen !== this.generation || this.stopped) return
      this.events.emit('error', { where: 'connect', error })
      this.handleClose(gen, { reason: 'network', error, at: Date.now() })
    }
  }

  private handleAdapterEvent<K extends keyof SocketAdapterEvents>(
    gen: number,
    event: K,
    payload: SocketAdapterEvents[K],
  ): void {
    if (gen !== this.generation || this.stopped) return

    switch (event) {
      case 'open': {
        const open = payload as SocketAdapterEvents['open']
        const connectedAttempt = this.attempt
        this.lastActivityAt = open.at
        this.attempt = 0
        this.stats.connectedAt = open.at
        this.stats.lastError = undefined
        if (this.state !== 'connected') {
          this.setState('connected')
          this.events.emit('connected', { connectedAt: open.at, attempt: connectedAttempt })
          this.startHeartbeat(gen)
        }
        void this.flushQueue()
        break
      }
      case 'close':
        this.handleClose(gen, payload as SocketAdapterEvents['close'])
        break
      case 'qr': {
        const qr = payload as SocketAdapterEvents['qr']
        if (this.opts.printQR) process.stdout.write(`\n${qr.raw}\n`)
        this.events.emit('qr', { raw: qr.raw })
        break
      }
      case 'pairingCode': {
        const pairing = payload as SocketAdapterEvents['pairingCode']
        this.logger.info('pairing code generated', { code: pairing.code })
        this.events.emit('pairingCode', { code: pairing.code })
        break
      }
      case 'message': {
        const message = payload as NormalizedMessage
        this.lastActivityAt = message.timestamp
        this.events.emit('message', message)
        if (message.buttonId) {
          this.events.emit('button', { ...message, buttonId: message.buttonId } as ButtonReply)
        }
        break
      }
      case 'restartRequested':
        this.handleRestart(gen)
        break
      case 'credsUpdated':
        this.scheduleCredsSave()
        break
      case 'error': {
        const failure = payload as SocketAdapterEvents['error']
        this.stats.lastError = failure.error
        this.events.emit('error', failure)
        break
      }
    }
  }

  private handleClose(gen: number, payload: SocketAdapterEvents['close']): void {
    if (gen !== this.generation || this.stopped) return
    this.generation += 1
    this.clearConnectionTimers()
    this.lastError(payload.error)

    const socket = this.socket
    this.socket = undefined
    void socket?.disconnect?.().catch((error: unknown) => {
      this.events.emit('error', { where: 'disconnect', error })
    })

    const willReconnect = this.shouldReconnect(payload.reason)
    this.events.emit('disconnected', {
      reason: payload.reason,
      error: payload.error,
      willReconnect,
    })

    if (!willReconnect) {
      this.stopped = true
      this.setState('stopped')
      return
    }

    if (payload.reason === 'restart') {
      this.stats.reconnects += 1
      this.setState('reconnecting')
      this.scheduleTimer(this.opts.restartDelayMs, () => void this.beginCycle())
      return
    }

    this.scheduleReconnect()
  }

  private handleRestart(gen: number): void {
    if (gen !== this.generation || this.stopped) return
    this.generation += 1
    this.clearConnectionTimers()

    const socket = this.socket
    this.socket = undefined
    void socket?.disconnect?.().catch((error: unknown) => {
      this.events.emit('error', { where: 'disconnect-restart', error })
    })

    this.stats.reconnects += 1
    this.events.emit('disconnected', { reason: 'restart', willReconnect: true })
    this.setState('reconnecting')
    this.scheduleTimer(this.opts.restartDelayMs, () => void this.beginCycle())
  }

  private shouldReconnect(reason: CloseReason): boolean {
    if (reason === 'manual') return false
    if (reason === 'loggedOut' && !this.opts.reconnectOnLoggedOut) return false
    if (reason === 'banned' && !this.opts.reconnectOnBanned) return false
    if (this.attempt >= this.opts.maxReconnectAttempts) {
      this.logger.warn('max reconnect attempts reached', { attempts: this.attempt })
      return false
    }
    return true
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    const delay = backoffDelay(this.attempt, this.opts.backoff)
    this.stats.reconnects += 1
    this.setState('reconnecting')
    this.logger.warn('scheduling reconnect', { attempt: this.attempt, delayMs: delay })
    this.scheduleTimer(delay, () => void this.beginCycle())
  }

  private startHeartbeat(gen: number): void {
    if (this.opts.heartbeatEveryMs <= 0) return
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = setInterval(() => {
      void this.checkHealth(gen)
    }, this.opts.heartbeatEveryMs)
    this.heartbeatTimer.unref?.()
  }

  private async checkHealth(gen: number): Promise<void> {
    if (gen !== this.generation || this.state !== 'connected' || this.stopped) return

    const stale = Date.now() - this.lastActivityAt > this.opts.staleAfterMs
    let healthy = true
    try {
      const result = await this.socket?.isHealthy?.()
      if (result === false) healthy = false
    } catch (error) {
      healthy = false
      this.lastError(error)
    }

    if (!stale && healthy) return

    const error = new Error(stale ? 'connection stale' : 'health check failed')
    this.logger.warn('forcing reconnect', { stale, healthy })
    this.events.emit('error', { where: 'heartbeat', error })
    this.handleClose(gen, { reason: 'stale', error, at: Date.now() })
  }

  private async flushQueue(): Promise<void> {
    if (this.state !== 'connected' || !this.socket) return
    const result = await this.queue.flush()
    if (result.dropped > 0) this.stats.messagesDropped += result.dropped
    if (result.sent + result.failed + result.dropped > 0) this.events.emit('flushed', result)
  }

  private scheduleCredsSave(): void {
    if (this.credsTimer) return
    this.credsTimer = setTimeout(() => {
      this.credsTimer = undefined
      void this.flushCreds()
    }, 250)
    this.credsTimer.unref?.()
  }

  private async flushCreds(): Promise<void> {
    if (this.credsTimer) {
      clearTimeout(this.credsTimer)
      this.credsTimer = undefined
    }
    if (!this.auth) return
    const auth = this.auth
    this.credsChain = this.credsChain
      .then(() => auth.save())
      .catch((error: unknown) => {
        this.events.emit('error', { where: 'saveCreds', error })
      })
    await this.credsChain
  }

  private async stopInternal(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'idle') {
      this.stopped = true
      this.clearAllTimers()
      this.setState('stopped')
      return
    }

    this.stopped = true
    this.generation += 1
    this.setState('stopping')
    this.clearConnectionTimers()

    await this.flushCreds()
    const socket = this.socket
    this.socket = undefined
    try {
      await socket?.disconnect?.()
    } catch (error) {
      this.events.emit('error', { where: 'stop', error })
    }

    this.setState('stopped')
    this.events.emit('disconnected', { reason: 'manual', willReconnect: false })
  }

  private resetForStart(): void {
    this.auth = undefined
    this.socket = undefined
    this.attempt = 0
    this.generation += 1
    this.stats.connectedAt = null
    this.stats.lastError = undefined
    this.lastActivityAt = 0
    this.clearAllTimers()
  }

  private setState(next: ConnectionState): void {
    const previous = this.state
    if (previous === next) return
    this.state = next
    this.events.emit('state', { previous, current: next, attempt: this.attempt })
  }

  private lastError(error: unknown): void {
    this.stats.lastError = error
    if (error !== undefined) this.logger.error('connection error', error)
  }

  private scheduleTimer(ms: number, callback: () => void): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    const timer = setTimeout(() => {
      if (this.reconnectTimer === timer) this.reconnectTimer = undefined
      callback()
    }, Math.max(0, ms))
    timer.unref?.()
    this.reconnectTimer = timer
  }

  private clearConnectionTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.reconnectTimer = undefined
    this.heartbeatTimer = undefined
  }

  private clearAllTimers(): void {
    this.clearConnectionTimers()
    if (this.credsTimer) clearTimeout(this.credsTimer)
    this.credsTimer = undefined
  }
}

function normalizeButtons(buttons: QuickReplyButton[]): QuickReplyButton[] {
  if (!Array.isArray(buttons) || buttons.length === 0) {
    throw new Error('sendButtons requiere al menos un botón')
  }
  if (buttons.length > 3) {
    throw new Error('WhatsApp permite máximo 3 botones de respuesta rápida')
  }
  return buttons.map((button, index) => {
    const id = String(button.id ?? '').trim()
    const label = String(button.label ?? '').trim()
    if (!id || !label) throw new Error(`botón ${index + 1} necesita id y label`)
    if (label.length > 20) throw new Error(`el texto del botón ${index + 1} no puede superar 20 caracteres`)
    return { id, label }
  })
}

function resolveOptions(options: ClientOptions): ResolvedOptions {
  const phone = options.phoneNumber?.replace(/[^\d]/g, '')
  return {
    sessionDir: options.sessionDir ?? './sessions/default',
    appName: options.appName ?? 'Sora Baileys',
    phoneNumber: phone && phone.length > 0 ? phone : undefined,
    printQR: options.printQR ?? false,
    backoff: options.backoff ?? {},
    maxReconnectAttempts: options.maxReconnectAttempts ?? Infinity,
    heartbeatEveryMs: Math.max(1000, options.heartbeatEveryMs ?? 30_000),
    staleAfterMs: Math.max(2000, options.staleAfterMs ?? 120_000),
    restartDelayMs: Math.max(0, options.restartDelayMs ?? 250),
    reconnectOnLoggedOut: options.reconnectOnLoggedOut ?? false,
    reconnectOnBanned: options.reconnectOnBanned ?? false,
    queue: options.queue ?? {},
    socketOptions: options.socketOptions ?? {},
  }
}
