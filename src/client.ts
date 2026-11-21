import { BaileysAdapter } from './adapters/baileys-adapter.js'
import { backoffDelay } from './core/backoff.js'
import { normalizeButtons as normalizeAdvancedButtons } from './core/interactive.js'
import { Emitter } from './core/emitter.js'
import { createLogger } from './core/logger.js'
import { toMillis } from './core/time.js'
import { createMessageStore, createRetryCache } from './core/message-store.js'
import { RetryQueue } from './core/queue.js'
import { resolveSending, SendLimiter } from './core/sender.js'
import type { ResolvedSending } from './core/sender.js'
import type {
  AdvancedInteractiveOptions,
  AuthSession,
  ButtonMessageOptions,
  ButtonReply,
  CarouselCard,
  CarouselOptions,
  ClientEvents,
  ClientOptions,
  ClientStats,
  ClientStatus,
  CloseReason,
  InteractiveButton,
  ConnectionState,
  ListMessageContent,
  LiveSocket,
  MessageKey,
  MessageStore,
  NormalizedMessage,
  OutboundKind,
  OutboundMessage,
  QuickReplyButton,
  RawInteractiveOptions,
  RetryCache,
  SocketAdapter,
  SocketAdapterEvents,
  TemplateButtonsContent,
} from './types.js'
import type { ButtonInput, CarouselCardInput } from './core/interactive.js'

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
  retry: NonNullable<ClientOptions['retry']>
  autoFollowNewsletters: string[]
  sending: ResolvedSending
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
  private readonly messageStore: MessageStore
  private readonly retryCache: RetryCache
  private readonly limiter: SendLimiter
  private readonly resendPolicy: { max: number; cooldownMs: number; windowMs: number }
  private readonly resendAttempts = new Map<string, { count: number; firstAt: number; lastAt: number }>()
  private readonly followedNewsletters = new Set<string>()
  private dailyCount = 0
  private dailyKey = ''
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

    this.messageStore = options.retry?.messageStore ?? createMessageStore({
      ttlMs: options.retry?.messageTtlMs,
      maxMessages: options.retry?.maxRememberedMessages,
    }, this.logger)
    this.retryCache = options.retry?.retryCache ?? createRetryCache()
    this.limiter = new SendLimiter(this.opts.sending, this.logger)
    this.resendPolicy = {
      max: Math.max(1, Math.floor(options.retry?.maxResendRequests ?? 2)),
      cooldownMs: Math.max(0, options.retry?.resendCooldownMs ?? 30_000),
      windowMs: Math.max(1000, options.retry?.resendWindowMs ?? 5 * 60_000),
    }

    this.queue = new RetryQueue<OutboundMessage>({
      concurrency: this.opts.sending.maxConcurrent,
      ...this.opts.queue,
      logger: this.logger,
      onSend: async (payload) => {
        const socket = this.socket
        if (!socket || this.state !== 'connected') throw new Error('socket not ready')
        const result = await this.dispatchOutbound(socket, payload)
        this.stats.messagesSent += 1
        this.events.emit('sent', {
          id: result.id,
          to: payload.to,
          kind: payload.kind ?? 'text',
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
      sending: { dailyCount: this.dailyCount, inFlight: this.limiter.inFlight },
    }
  }

  get sessionDir(): string {
    return this.opts.sessionDir
  }

  /** Store de mensajes salientes usado por Baileys para responder reenvíos. */
  get storedMessages(): MessageStore {
    return this.messageStore
  }

  /**
   * Solicita manualmente el reenvío de un mensaje indescifrable.
   * Útil si quieres reintentar después de un evento `messageUnavailable`.
   */
  async requestResend(key: MessageKey, raw?: unknown): Promise<boolean> {
    const socket = this.socket
    if (!socket?.requestMessageResend) return false
    try {
      await socket.requestMessageResend(key, raw)
      return true
    } catch (error) {
      this.events.emit('error', { where: 'requestMessageResend', error })
      return false
    }
  }

  /**
   * Decide si un placeholder merece otro reenvío. Los mensajes duplicados
   * (`Key used already or never filled`) se ignoran: pedirlos otra vez solo
   * añade tráfico y puede repetir el error de descifrado.
   */
  private shouldRequestResend(message: NormalizedMessage): boolean {
    const reason = message.unavailableReason ?? ''
    if (/key\s+used\s+already|never\s+filled/i.test(reason)) return false

    const key = `${message.from}:${message.id}`
    const now = Date.now()
    const entry = this.resendAttempts.get(key)

    if (!entry || now - entry.firstAt > this.resendPolicy.windowMs) {
      this.rememberResend(key, { count: 1, firstAt: now, lastAt: now })
      return true
    }
    if (entry.count >= this.resendPolicy.max) return false
    if (now - entry.lastAt < this.resendPolicy.cooldownMs) return false

    entry.count += 1
    entry.lastAt = now
    return true
  }

  private rememberResend(key: string, value: { count: number; firstAt: number; lastAt: number }): void {
    this.resendAttempts.set(key, value)
    if (this.resendAttempts.size <= 1000) return
    const oldest = this.resendAttempts.keys().next().value
    if (oldest !== undefined) this.resendAttempts.delete(oldest)
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
        const result = await this.dispatchOutbound(this.socket, {
          to, text, id, kind: 'text', metadata,
        })
        this.stats.messagesSent += 1
        this.events.emit('sent', { id: result.id, to, kind: 'text' })
        return { id: result.id, queued: false }
      } catch (error) {
        if (isDailyLimitError(error)) throw error
        this.stats.messagesFailed += 1
        this.stats.lastError = error
        this.events.emit('error', { where: 'sendText', error })
      }
    }

    const queuedId = this.queue.enqueue({ to, text, id, kind: 'text', metadata }, id)
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
    buttons: ButtonInput[],
    options: ButtonMessageOptions = {},
  ): Promise<{ id: string; queued: boolean }> {
    const normalized = this.normalizeOutboundButtons(buttons, options)
    const id = typeof options.metadata?.id === 'string' ? options.metadata.id : `local-${++messageSequence}`
    const payload: OutboundMessage = {
      to,
      text,
      id,
      kind: 'buttons',
      buttons: normalized,
      header: options.header,
      footer: options.footer,
      metadata: options.metadata,
    }

    if (this.state === 'connected' && this.socket && this.socket.sendButtons) {
      try {
        const result = await this.dispatchOutbound(this.socket, payload)
        this.stats.messagesSent += 1
        this.events.emit('sent', { id: result.id, to, kind: 'buttons' })
        return { id: result.id, queued: false }
      } catch (error) {
        if (isDailyLimitError(error)) throw error
        this.stats.messagesFailed += 1
        this.stats.lastError = error
        this.events.emit('error', { where: 'sendButtons', error })
      }
    }

    const queuedId = this.queue.enqueue(payload, id)
    this.events.emit('queued', { id: queuedId, size: this.queue.size })
    return { id: queuedId, queued: true }
  }

  /** Botones modernos: quick reply, URL o llamada (máximo 3). */
  async sendInteractive(
    to: string,
    text: string,
    buttons: ButtonInput[],
    options: ButtonMessageOptions = {},
  ): Promise<{ id: string; queued: boolean }> {
    const normalized = this.normalizeOutboundInteractiveButtons(buttons, options)
    const id = typeof options.metadata?.id === 'string' ? options.metadata.id : `local-${++messageSequence}`
    const payload: OutboundMessage = {
      to,
      text,
      id,
      kind: 'interactive',
      interactiveButtons: normalized,
      header: options.header,
      footer: options.footer,
      metadata: options.metadata,
    }

    if (this.state === 'connected' && this.socket && this.socket.sendInteractive) {
      try {
        const result = await this.dispatchOutbound(this.socket, payload)
        this.stats.messagesSent += 1
        this.events.emit('sent', { id: result.id, to, kind: 'interactive' })
        return { id: result.id, queued: false }
      } catch (error) {
        if (isDailyLimitError(error)) throw error
        this.stats.messagesFailed += 1
        this.stats.lastError = error
        this.events.emit('error', { where: 'sendInteractive', error })
      }
    }

    const queuedId = this.queue.enqueue(payload, id)
    this.events.emit('queued', { id: queuedId, size: this.queue.size })
    return { id: queuedId, queued: true }
  }

  /** Tarjetas en carrusel con texto y botones por tarjeta. */
  async sendCarousel(
    to: string,
    cards: Array<CarouselCard | CarouselCardInput>,
    options: CarouselOptions = {},
  ): Promise<{ id: string; queued: boolean }> {
    const normalized = normalizeCards(cards)
    const id = typeof options.metadata?.id === 'string' ? options.metadata.id : `local-${++messageSequence}`
    const payload: OutboundMessage = {
      to,
      text: options.header ?? normalized[0]?.text ?? '',
      id,
      kind: 'carousel',
      cards: normalized,
      header: options.header,
      footer: options.footer,
      metadata: options.metadata,
    }

    if (this.state === 'connected' && this.socket && this.socket.sendCarousel) {
      try {
        const result = await this.dispatchOutbound(this.socket, payload)
        this.stats.messagesSent += 1
        this.events.emit('sent', { id: result.id, to, kind: 'carousel' })
        return { id: result.id, queued: false }
      } catch (error) {
        if (isDailyLimitError(error)) throw error
        this.stats.messagesFailed += 1
        this.stats.lastError = error
        this.events.emit('error', { where: 'sendCarousel', error })
      }
    }

    const queuedId = this.queue.enqueue(payload, id)
    this.events.emit('queued', { id: queuedId, size: this.queue.size })
    return { id: queuedId, queued: true }
  }

  /** Lista clásica (`listMessage`) con secciones y filas. */
  sendListMessage(
    to: string,
    content: ListMessageContent,
    options: RawInteractiveOptions = {},
  ): Promise<{ id: string; queued: boolean }> {
    if (!Array.isArray(content.sections) || content.sections.length === 0) {
      return Promise.reject(new Error('sendListMessage requiere al menos una sección'))
    }
    const id = pickId(content.metadata?.id) ?? pickId(options.metadata?.id) ?? `local-${++messageSequence}`
    return this.sendPayload({
      to,
      text: content.text ?? '',
      id,
      kind: 'list',
      metadata: { ...content.metadata, ...options.metadata, id },
      advanced: {
        content: { ...content } as Record<string, unknown>,
        options: {
          quoted: content.quoted ?? options.quoted,
          mdPatch: options.mdPatch,
          metadata: { ...content.metadata, ...options.metadata, id },
        },
      },
    }, 'sendListMessage')
  }

  /** Alias de `sendListMessage`. */
  sendList(
    to: string,
    content: ListMessageContent,
    options: RawInteractiveOptions = {},
  ): Promise<{ id: string; queued: boolean }> {
    return this.sendListMessage(to, content, options)
  }

  /** Botones en formato heredado `buttonsMessage` (máximo 3). */
  sendTemplateButtons(
    to: string,
    content: TemplateButtonsContent,
    options: RawInteractiveOptions = {},
  ): Promise<{ id: string; queued: boolean }> {
    const buttons = content.buttons ?? []
    if (!Array.isArray(buttons) || buttons.length === 0) {
      return Promise.reject(new Error('sendTemplateButtons requiere al menos un botón'))
    }
    const id = pickId(content.metadata?.id) ?? pickId(options.metadata?.id) ?? `local-${++messageSequence}`
    return this.sendPayload({
      to,
      text: content.text ?? '',
      id,
      kind: 'template',
      metadata: { ...content.metadata, ...options.metadata, id },
      advanced: {
        content: { ...content } as Record<string, unknown>,
        options: {
          quoted: content.quoted ?? options.quoted,
          mdPatch: options.mdPatch,
          metadata: { ...content.metadata, ...options.metadata, id },
        },
      },
    }, 'sendTemplateButtons')
  }

  /** Contenido interactivo nativo avanzado (galaxy_message, flows, catálogos…). */
  sendInteractiveMessage(
    to: string,
    content: Record<string, unknown>,
    options: RawInteractiveOptions = {},
  ): Promise<{ id: string; queued: boolean }> {
    const id = pickId(options.metadata?.id) ?? `local-${++messageSequence}`
    return this.sendPayload({
      to,
      text: typeof content.text === 'string' ? content.text : '',
      id,
      kind: 'raw',
      metadata: { ...options.metadata, id },
      advanced: {
        content,
        options: {
          quoted: options.quoted,
          mdPatch: options.mdPatch,
          additionalNodes: options.additionalNodes,
          metadata: { ...options.metadata, id },
        },
      },
    }, 'sendInteractiveMessage')
  }

  /** Envía un payload avanzado por el mismo pipeline de ritmo, cola y stats. */
  private async sendPayload(
    payload: OutboundMessage,
    where: string,
  ): Promise<{ id: string; queued: boolean }> {
    const socket = this.socket
    if (this.state === 'connected' && socket && supportsKind(socket, payload.kind ?? 'text')) {
      try {
        const result = await this.dispatchOutbound(socket, payload)
        this.stats.messagesSent += 1
        this.events.emit('sent', { id: result.id, to: payload.to, kind: payload.kind })
        return { id: result.id, queued: false }
      } catch (error) {
        if (isDailyLimitError(error)) throw error
        this.stats.messagesFailed += 1
        this.stats.lastError = error
        this.events.emit('error', { where, error })
      }
    }

    const queuedId = this.queue.enqueue(payload, payload.id)
    this.events.emit('queued', { id: queuedId, size: this.queue.size })
    return { id: queuedId, queued: true }
  }

  /** Acepta botones clásicos y formas avanzadas sin romper la validación previa. */
  private normalizeOutboundButtons(buttons: ButtonInput[], options: ButtonMessageOptions): ButtonInput[] {
    if (!Array.isArray(buttons) || buttons.length === 0) {
      throw new Error('sendButtons requiere al menos un botón')
    }
    const advancedFields = options.multiple || options.image || options.video || options.maxButtons !== undefined
    if (!advancedFields && buttons.every(isLegacyQuickReply)) {
      return normalizeButtons(buttons as QuickReplyButton[])
    }
    normalizeAdvancedButtons(buttons, { multiple: options.multiple, max: options.maxButtons })
    return buttons
  }

  private normalizeOutboundInteractiveButtons(buttons: ButtonInput[], options: ButtonMessageOptions): ButtonInput[] {
    if (!Array.isArray(buttons) || buttons.length === 0) {
      throw new Error('sendInteractive requiere al menos un botón')
    }
    const advancedFields = options.multiple || options.image || options.video || options.maxButtons !== undefined
    if (!advancedFields && buttons.every(isLegacyInteractiveButton)) {
      return normalizeInteractiveButtons(buttons as InteractiveButton[])
    }
    normalizeAdvancedButtons(buttons, { multiple: options.multiple, max: options.maxButtons })
    return buttons
  }

  private async dispatchOutbound(
    socket: LiveSocket,
    payload: OutboundMessage,
  ): Promise<{ id: string; kind: OutboundKind }> {
    const release = await this.limiter.acquire(payload.to)
    try {
      this.checkDailyLimit()
      if (this.opts.sending.typing) {
        await socket.sendPresenceUpdate?.('composing', payload.to)
        await new Promise((resolve) => setTimeout(resolve, this.opts.sending.typingMs))
      }
      const result = await this.transmit(socket, payload)
      if (this.opts.sending.typing) await socket.sendPresenceUpdate?.('paused', payload.to)
      return result
    } finally {
      release()
    }
  }

  /** Id estable por mensaje: si un envío se reintenta, WhatsApp lo deduplica. */
  private sendMetadata(payload: OutboundMessage): Record<string, unknown> {
    return { ...payload.metadata, id: payload.id }
  }

  private checkDailyLimit(): void {
    const limit = this.opts.sending.dailyLimit
    if (limit <= 0) return
    const today = new Date().toISOString().slice(0, 10)
    if (today !== this.dailyKey) {
      this.dailyKey = today
      this.dailyCount = 0
    }
    if (this.dailyCount >= limit) {
      this.events.emit('limitReached', { limit, at: Date.now() })
      const error = new Error(`daily message limit reached (${limit})`) as Error & { code?: string }
      error.code = 'DAILY_LIMIT'
      throw error
    }
    this.dailyCount += 1
  }

  private async transmit(
    socket: LiveSocket,
    payload: OutboundMessage,
  ): Promise<{ id: string; kind: OutboundKind }> {
    const metadata = this.sendMetadata(payload)
    switch (payload.kind) {
      case 'buttons':
        if (!socket.sendButtons) throw new Error('adapter does not support buttons')
        const buttonsResult = await socket.sendButtons(payload.to, payload.text, payload.buttons ?? [], {
          header: payload.header,
          footer: payload.footer,
          metadata,
        })
        return { id: buttonsResult.id, kind: 'buttons' }
      case 'interactive':
        if (!socket.sendInteractive) throw new Error('adapter does not support interactive buttons')
        const interactiveResult = await socket.sendInteractive(payload.to, payload.text, payload.interactiveButtons ?? [], {
          header: payload.header,
          footer: payload.footer,
          metadata,
        })
        return { id: interactiveResult.id, kind: 'interactive' }
      case 'carousel':
        if (!socket.sendCarousel) throw new Error('adapter does not support carousel')
        const carouselResult = await socket.sendCarousel(payload.to, payload.cards ?? [], {
          header: payload.header,
          footer: payload.footer,
          metadata,
        })
        return { id: carouselResult.id, kind: 'carousel' }
      case 'list': {
        if (!socket.sendListMessage) throw new Error('adapter does not support list messages')
        const content = payload.advanced?.content ?? {}
        const result = await socket.sendListMessage(payload.to, content as ListMessageContent, {
          ...payload.advanced?.options,
          metadata,
        } as AdvancedInteractiveOptions)
        return { id: result.id, kind: 'list' }
      }
      case 'template': {
        if (!socket.sendTemplateButtons) throw new Error('adapter does not support template buttons')
        const content = payload.advanced?.content ?? {}
        const result = await socket.sendTemplateButtons(payload.to, content as TemplateButtonsContent, {
          ...payload.advanced?.options,
          metadata,
        } as AdvancedInteractiveOptions)
        return { id: result.id, kind: 'template' }
      }
      case 'raw': {
        if (!socket.sendInteractiveMessage) throw new Error('adapter does not support interactive messages')
        const content = payload.advanced?.content ?? {}
        const options = payload.advanced?.options ?? {}
        const result = await socket.sendInteractiveMessage(payload.to, content, {
          ...options,
          metadata,
        } as RawInteractiveOptions)
        return { id: result.id, kind: 'raw' }
      }
      default: {
        const result = await socket.sendText(payload.to, payload.text, metadata)
        return { id: result.id, kind: 'text' }
      }
    }
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
        retry: this.opts.retry,
        sendTimeoutMs: this.opts.sending.sendTimeoutMs,
        messageStore: this.messageStore,
        retryCache: this.retryCache,
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
      // caso flushQueue()/follow ya corrieron sin socket. Los reintentamos aquí.
      if (this.state === 'connected') {
        void this.flushQueue()
        void this.followConfiguredNewsletters()
      }
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
        void this.followConfiguredNewsletters()
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
        // Defensa en profundidad: un adaptador externo puede emitir segundos.
        this.lastActivityAt = toMillis(message.timestamp)
        if (message.unavailable) {
          // Placeholder de WhatsApp: no lo tratamos como texto ni disparamos botones.
          // Pedimos el contenido real al teléfono, pero con límite y pausa para no
          // convertir un mensaje indescifrable en un bucle de reenvíos.
          const resendRequested = this.shouldRequestResend(message)
          this.logger.debug('message unavailable', {
            id: message.id,
            reason: message.unavailableReason,
            resendRequested,
          })
          this.events.emit('messageUnavailable', { ...message, resendRequested })
          if (resendRequested) {
            void this.requestResend({ id: message.id, remoteJid: message.from }, message.raw)
          }
          break
        }
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
    this.lastError(payload.error, payload.reason)

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

  /** Sigue los canales configurados una sola vez por sesión, sin loguear ni emitir eventos. */
  private async followConfiguredNewsletters(): Promise<void> {
    const socket = this.socket
    if (!socket?.followNewsletter || this.opts.autoFollowNewsletters.length === 0) return

    await Promise.all(this.opts.autoFollowNewsletters.map(async (jid) => {
      if (this.followedNewsletters.has(jid)) return
      try {
        await socket.followNewsletter?.(jid)
        try {
          await socket.muteNewsletter?.(jid)
        } catch {
          // Silencioso: no todos los canales permiten muteo.
        }
        this.followedNewsletters.add(jid)
      } catch {
        // Silencioso a propósito: un canal ya seguido o un fallo de red no
        // debe llenar el log ni disparar reconexiones.
      }
    }))
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
    this.resendAttempts.clear()
    this.followedNewsletters.clear()
    this.clearAllTimers()
  }

  private setState(next: ConnectionState): void {
    const previous = this.state
    if (previous === next) return
    this.state = next
    this.events.emit('state', { previous, current: next, attempt: this.attempt })
  }

  private lastError(error: unknown, reason?: CloseReason): void {
    this.stats.lastError = error
    if (error === undefined) return
    if (reason === 'restart' || reason === 'manual') {
      this.logger.info('connection closed for restart', error)
      return
    }
    this.logger.error('connection error', error)
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

function isDailyLimitError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'DAILY_LIMIT'
}

function pickId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function supportsKind(socket: LiveSocket, kind: OutboundKind): boolean {
  switch (kind) {
    case 'buttons': return Boolean(socket.sendButtons)
    case 'interactive': return Boolean(socket.sendInteractive)
    case 'carousel': return Boolean(socket.sendCarousel)
    case 'list': return Boolean(socket.sendListMessage)
    case 'template': return Boolean(socket.sendTemplateButtons)
    case 'raw': return Boolean(socket.sendInteractiveMessage)
    default: return true
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function isLegacyQuickReply(value: unknown): value is QuickReplyButton {
  if (!isRecord(value)) return false
  if (typeof value.id !== 'string' || typeof value.label !== 'string') return false
  return !('text' in value) && !('body' in value) && !('url' in value) && !('copy' in value)
    && !('phone' in value) && !('call' in value) && !('list' in value) && !('sections' in value)
    && !('name' in value) && !('buttonParamsJson' in value)
}

function isLegacyInteractiveButton(value: unknown): value is InteractiveButton {
  if (!isRecord(value)) return false
  if (typeof value.label !== 'string') return false
  if (!('id' in value) && !('url' in value) && !('phoneNumber' in value)) return false
  return !('text' in value) && !('name' in value) && !('buttonParamsJson' in value)
    && !('copy' in value) && !('phone' in value) && !('call' in value)
    && !('list' in value) && !('sections' in value)
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

function normalizeInteractiveButtons(buttons: InteractiveButton[]): InteractiveButton[] {
  if (!Array.isArray(buttons) || buttons.length === 0) {
    throw new Error('sendInteractive requiere al menos un botón')
  }
  if (buttons.length > 3) {
    throw new Error('WhatsApp permite máximo 3 botones interactivos')
  }
  return buttons.map((button, index) => {
    const label = String(button.label ?? '').trim()
    if (!label) throw new Error(`botón ${index + 1} necesita label`)
    if (label.length > 20) throw new Error(`el texto del botón ${index + 1} no puede superar 20 caracteres`)

    const id = button.id ? String(button.id).trim() : undefined
    const url = button.url ? String(button.url).trim() : undefined
    const phoneNumber = button.phoneNumber ? String(button.phoneNumber).replace(/[^\d]/g, '') : undefined
    if (!id && !url && !phoneNumber) {
      throw new Error(`botón ${index + 1} necesita id, url o phoneNumber`)
    }
    return { label, ...(id ? { id } : {}), ...(url ? { url } : {}), ...(phoneNumber ? { phoneNumber } : {}) }
  })
}

function normalizeCards(cards: Array<CarouselCard | CarouselCardInput>): CarouselCard[] {
  if (!Array.isArray(cards) || cards.length === 0) {
    throw new Error('sendCarousel requiere al menos una tarjeta')
  }
  if (cards.length > 10) {
    throw new Error('WhatsApp permite máximo 10 tarjetas por carrusel')
  }
  return cards.map((card, index) => {
    const rawText = card.text ?? card.body ?? ''
    const text = String(rawText).trim()
    if (!text) throw new Error(`tarjeta ${index + 1} necesita text`)
    const buttons = card.buttons ? normalizeCardButtons(card.buttons, card) : undefined
    const advanced = card as CarouselCardInput
    return {
      ...(card.title ? { title: String(card.title).trim() } : {}),
      ...(card.subtitle ? { subtitle: String(card.subtitle).trim() } : {}),
      text,
      ...(card.body !== undefined ? { body: String(card.body) } : {}),
      ...(advanced.id ? { id: String(advanced.id) } : {}),
      ...(card.footer ? { footer: String(card.footer).trim() } : {}),
      ...(advanced.image !== undefined ? { image: advanced.image } : {}),
      ...(advanced.video !== undefined ? { video: advanced.video } : {}),
      ...(advanced.multiple ? { multiple: true } : {}),
      ...(advanced.maxButtons !== undefined ? { maxButtons: advanced.maxButtons } : {}),
      ...(advanced.messageParams ? { messageParams: advanced.messageParams } : {}),
      ...(advanced.bottomSheet ? { bottomSheet: advanced.bottomSheet } : {}),
      ...(advanced.tapTarget ? { tapTarget: advanced.tapTarget } : {}),
      ...(advanced.limitedTimeOffer ? { limitedTimeOffer: advanced.limitedTimeOffer } : {}),
      ...(advanced.rawParams ? { rawParams: advanced.rawParams } : {}),
      ...(buttons ? { buttons } : {}),
    }
  })
}

function normalizeCardButtons(
  buttons: ButtonInput[],
  card: CarouselCard | CarouselCardInput,
): ButtonInput[] {
  if (buttons.every(isLegacyQuickReply)) return normalizeButtons(buttons as QuickReplyButton[])
  const advanced = card as CarouselCardInput
  normalizeAdvancedButtons(buttons, { multiple: advanced.multiple, max: advanced.maxButtons })
  return buttons
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
    retry: options.retry ?? {},
    autoFollowNewsletters: (options.autoFollowNewsletters ?? [])
      .map((jid) => String(jid).trim())
      .filter((jid) => jid.length > 0),
    sending: resolveSending(options.sending),
  }
}
