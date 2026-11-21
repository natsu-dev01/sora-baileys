import type {
  AdvancedInteractiveOptions,
  AuthSession,
  ButtonMessageOptions,
  CarouselCard,
  CarouselOptions,
  CloseReason,
  ConnectAdapterOptions,
  ListMessageContent,
  LiveSocket,
  MessageKey,
  NormalizedMessage,
  RawInteractiveOptions,
  SocketAdapter,
  SocketAdapterEvents,
  TemplateButtonsContent,
} from '../types.js'
import type { ButtonInput, CarouselCardInput } from '../core/interactive.js'

export interface MockAdapterOptions {
  /** Retardo simulado hasta `open`. Por defecto 10 ms. */
  connectDelayMs?: number
  /** Emitir QR cuando la sesión es nueva. Por defecto true. */
  qrOnFresh?: boolean
  /** Cerrar la conexión automáticamente tras este tiempo. */
  dropAfterMs?: number
  /** Motivo del cierre automático. Por defecto `network`. */
  dropReason?: CloseReason
  /** Latencia simulada al enviar. Por defecto 5 ms. */
  latencyMs?: number
  /** Marcar `isHealthy()` como false para probar el heartbeat. */
  unhealthy?: boolean
}

type Emit = <K extends keyof SocketAdapterEvents>(event: K, payload: SocketAdapterEvents[K]) => void

let counter = 0

const delay = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Transporte en memoria para tests y demos. No habla con WhatsApp.
 * Permite forzar caídas y mensajes para validar la lógica de resiliencia.
 */
export class MockAdapter implements SocketAdapter {
  readonly name = 'mock'

  private current: MockSocket | undefined
  private fresh = true
  private failNextSends = 0
  private readonly options: MockAdapterOptions

  constructor(options: MockAdapterOptions = {}) {
    this.options = options
  }

  async loadAuth(options: { sessionDir: string }): Promise<AuthSession> {
    this.fresh = options.sessionDir.includes('fresh') || this.fresh
    return {
      isFresh: this.fresh,
      save: async () => {},
      snapshot: { sessionDir: options.sessionDir },
    }
  }

  /** Marca la sesión como ya vinculada (para evitar QR en tests). */
  markLinked(): void {
    this.fresh = false
  }

  /** Hace fallar los próximos N envíos para ejercitar la cola. */
  failSends(count = 1): void {
    this.failNextSends = count
  }

  /** Fuerza un cierre del socket activo. */
  drop(reason: CloseReason = 'network', error: unknown = new Error('mock drop')): void {
    this.current?.close(reason, error)
  }

  /** Fuerza un evento de reinicio (como el `connection: connect` de Baileys). */
  requestRestart(): void {
    this.current?.emit('restartRequested', { at: Date.now() })
  }

  /** Inyecta un mensaje entrante. */
  pushMessage(message: Partial<NormalizedMessage> = {}): void {
    this.current?.emit('message', {
      id: message.id ?? `mock-msg-${++counter}`,
      from: message.from ?? '1234567890@s.whatsapp.net',
      text: message.text ?? 'hola desde mock',
      timestamp: message.timestamp ?? Date.now(),
      groupId: message.groupId,
      buttonId: message.buttonId,
      buttonText: message.buttonText,
      unavailable: message.unavailable,
      unavailableReason: message.unavailableReason,
      raw: message.raw,
    })
  }

  /** Inyecta un placeholder indescifrable (como el CIPHERTEXT de Baileys). */
  pushUnavailableMessage(options: {
    id?: string
    from?: string
    reason?: string
  } = {}): void {
    const id = options.id ?? `mock-placeholder-${++counter}`
    const from = options.from ?? '1234567890@s.whatsapp.net'
    const reason = options.reason ?? 'Message absent from node'
    this.pushMessage({
      id,
      from,
      text: 'No se pudo cargar este mensaje',
      unavailable: true,
      unavailableReason: reason,
      raw: {
        key: { id, remoteJid: from },
        messageStubType: 2,
        messageStubParameters: [reason],
      },
    })
  }

  /** Inyecta la respuesta a un botón. */
  pushButton(options: {
    from?: string
    buttonId: string
    buttonText?: string
    text?: string
  }): void {
    this.pushMessage({
      from: options.from,
      text: options.text ?? options.buttonText ?? options.buttonId,
      buttonId: options.buttonId,
      buttonText: options.buttonText,
    })
  }

  /** Simula la respuesta a un botón interactivo moderno. */
  pushInteractiveReply(options: {
    from?: string
    id: string
    displayText?: string
  }): void {
    this.pushMessage({
      from: options.from,
      text: options.displayText ?? options.id,
      buttonId: options.id,
      buttonText: options.displayText,
      raw: {
        interactiveResponseMessage: {
          nativeFlowResponseMessage: {
            name: 'quick_reply',
            paramsJson: JSON.stringify({ id: options.id, display_text: options.displayText ?? options.id }),
          },
        },
      },
    })
  }

  /** Botones enviados en el último socket (para assert en tests). */
  get sentButtons(): Array<{ to: string; text: string; buttons: ButtonInput[] }> {
    return this.current?.sentButtons ?? []
  }

  get sentInteractive(): Array<{ to: string; text: string; buttons: ButtonInput[] }> {
    return this.current?.sentInteractive ?? []
  }

  get sentCarousels(): Array<{ to: string; cards: Array<CarouselCard | CarouselCardInput> }> {
    return this.current?.sentCarousels ?? []
  }

  get sentLists(): Array<{ to: string; content: ListMessageContent }> {
    return this.current?.sentLists ?? []
  }

  get sentTemplates(): Array<{ to: string; content: TemplateButtonsContent }> {
    return this.current?.sentTemplates ?? []
  }

  get sentRawInteractive(): Array<{ to: string; content: Record<string, unknown> }> {
    return this.current?.sentRawInteractive ?? []
  }

  /** Reenvíos solicitados en el socket activo. */
  get resendRequests(): Array<{ key: MessageKey; raw?: unknown }> {
    return this.current?.resendRequests ?? []
  }

  get sentMetadata(): Array<Record<string, unknown>> {
    return this.current?.sentMetadata ?? []
  }

  get presences(): Array<{ presence: string; jid: string }> {
    return this.current?.presences ?? []
  }

  get followedNewsletters(): string[] {
    return this.current?.followedNewsletters ?? []
  }

  get mutedNewsletters(): string[] {
    return this.current?.mutedNewsletters ?? []
  }

  async connect(options: ConnectAdapterOptions): Promise<LiveSocket> {
    const emit: Emit = options.onEvent

    if (options.phoneNumber) {
      queueMicrotask(() => emit('pairingCode', { code: '12345678' }))
    } else if (this.fresh && this.options.qrOnFresh !== false) {
      queueMicrotask(() => emit('qr', { raw: `mock-qr-${++counter}` }))
    }

    await delay(this.options.connectDelayMs ?? 10)

    const socket = new MockSocket({
      emit,
      latencyMs: this.options.latencyMs ?? 5,
      unhealthy: this.options.unhealthy ?? false,
      shouldFail: () => this.failNextSends > 0 && (this.failNextSends--, true),
      onClose: () => {
        if (this.current === socket) this.current = undefined
      },
    })
    this.current = socket
    this.fresh = false
    emit('open', { at: Date.now() })

    if (this.options.dropAfterMs !== undefined) {
      const timer = setTimeout(() => {
        this.drop(this.options.dropReason ?? 'network')
      }, this.options.dropAfterMs)
      timer.unref?.()
    }

    return socket
  }
}

interface MockSocketOptions {
  emit: Emit
  latencyMs: number
  unhealthy: boolean
  shouldFail: () => boolean
  onClose: () => void
}

class MockSocket implements LiveSocket {
  private closed = false
  readonly sentButtons: Array<{ to: string; text: string; buttons: ButtonInput[] }> = []
  readonly sentInteractive: Array<{ to: string; text: string; buttons: ButtonInput[] }> = []
  readonly sentCarousels: Array<{ to: string; cards: Array<CarouselCard | CarouselCardInput> }> = []
  readonly sentLists: Array<{ to: string; content: ListMessageContent }> = []
  readonly sentTemplates: Array<{ to: string; content: TemplateButtonsContent }> = []
  readonly sentRawInteractive: Array<{ to: string; content: Record<string, unknown> }> = []
  readonly resendRequests: Array<{ key: MessageKey; raw?: unknown }> = []
  readonly sentMetadata: Array<Record<string, unknown>> = []
  readonly presences: Array<{ presence: string; jid: string }> = []
  readonly followedNewsletters: string[] = []
  readonly mutedNewsletters: string[] = []

  constructor(private readonly opts: MockSocketOptions) {}

  async sendText(to: string, text: string, metadata?: Record<string, unknown>): Promise<{ id: string }> {
    if (this.closed) throw new Error('socket closed')
    await delay(this.opts.latencyMs)
    if (this.opts.shouldFail()) throw new Error('mock send failure')
    this.sentMetadata.push({ ...metadata })
    return { id: `mock-sent-${++counter}-${metadata?.tag ?? 'ok'}` }
  }

  async sendButtons(
    to: string,
    text: string,
    buttons: ButtonInput[],
    _options?: ButtonMessageOptions,
  ): Promise<{ id: string }> {
    if (this.closed) throw new Error('socket closed')
    await delay(this.opts.latencyMs)
    if (this.opts.shouldFail()) throw new Error('mock send failure')
    this.sentMetadata.push({ ..._options?.metadata })
    this.sentButtons.push({ to, text, buttons })
    return { id: `mock-buttons-${++counter}` }
  }

  async sendInteractive(
    to: string,
    text: string,
    buttons: ButtonInput[],
    _options?: ButtonMessageOptions,
  ): Promise<{ id: string }> {
    if (this.closed) throw new Error('socket closed')
    await delay(this.opts.latencyMs)
    if (this.opts.shouldFail()) throw new Error('mock send failure')
    this.sentMetadata.push({ ..._options?.metadata })
    this.sentInteractive.push({ to, text, buttons })
    return { id: `mock-interactive-${++counter}` }
  }

  async sendCarousel(
    to: string,
    cards: Array<CarouselCard | CarouselCardInput>,
    _options?: CarouselOptions,
  ): Promise<{ id: string }> {
    if (this.closed) throw new Error('socket closed')
    await delay(this.opts.latencyMs)
    if (this.opts.shouldFail()) throw new Error('mock send failure')
    this.sentMetadata.push({ ..._options?.metadata })
    this.sentCarousels.push({ to, cards })
    return { id: `mock-carousel-${++counter}` }
  }

  async sendListMessage(
    to: string,
    content: ListMessageContent,
    options?: AdvancedInteractiveOptions,
  ): Promise<{ id: string }> {
    if (this.closed) throw new Error('socket closed')
    await delay(this.opts.latencyMs)
    if (this.opts.shouldFail()) throw new Error('mock send failure')
    this.sentMetadata.push({ ...options?.metadata })
    this.sentLists.push({ to, content })
    return { id: `mock-list-${++counter}` }
  }

  async sendTemplateButtons(
    to: string,
    content: TemplateButtonsContent,
    options?: AdvancedInteractiveOptions,
  ): Promise<{ id: string }> {
    if (this.closed) throw new Error('socket closed')
    await delay(this.opts.latencyMs)
    if (this.opts.shouldFail()) throw new Error('mock send failure')
    this.sentMetadata.push({ ...options?.metadata })
    this.sentTemplates.push({ to, content })
    return { id: `mock-template-${++counter}` }
  }

  async sendInteractiveMessage(
    to: string,
    content: Record<string, unknown>,
    options?: RawInteractiveOptions,
  ): Promise<{ id: string }> {
    if (this.closed) throw new Error('socket closed')
    await delay(this.opts.latencyMs)
    if (this.opts.shouldFail()) throw new Error('mock send failure')
    this.sentMetadata.push({ ...options?.metadata })
    this.sentRawInteractive.push({ to, content })
    return { id: `mock-interactive-raw-${++counter}` }
  }

  async requestMessageResend(key: MessageKey, raw?: unknown): Promise<void> {
    if (this.closed) throw new Error('socket closed')
    this.resendRequests.push({ key, raw })
  }

  async sendPresenceUpdate(presence: 'composing' | 'paused', jid: string): Promise<void> {
    if (this.closed) throw new Error('socket closed')
    this.presences.push({ presence, jid })
  }

  async followNewsletter(jid: string): Promise<void> {
    if (this.closed) throw new Error('socket closed')
    this.followedNewsletters.push(jid)
  }

  async muteNewsletter(jid: string): Promise<void> {
    if (this.closed) throw new Error('socket closed')
    this.mutedNewsletters.push(jid)
  }

  isHealthy(): boolean {
    return !this.closed && !this.opts.unhealthy
  }

  async disconnect(): Promise<void> {
    this.close('manual')
  }

  close(reason: CloseReason, error: unknown = new Error(`mock close: ${reason}`)): void {
    if (this.closed) return
    this.closed = true
    this.opts.onClose()
    this.opts.emit('close', { reason, error, at: Date.now() })
  }

  emit<K extends keyof SocketAdapterEvents>(event: K, payload: SocketAdapterEvents[K]): void {
    if (this.closed) return
    this.opts.emit(event, payload)
  }
}
