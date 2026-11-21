/** Estados del ciclo de vida del cliente. */
export type ConnectionState =
  | 'idle'
  | 'starting'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'stopping'
  | 'stopped'

/** Motivo normalizado de una desconexión. */
export type CloseReason =
  | 'loggedOut'
  | 'banned'
  | 'network'
  | 'restart'
  | 'stale'
  | 'manual'
  | 'unknown'

export interface BackoffOptions {
  /** Retardo base en ms. Por defecto 1000. */
  baseMs?: number
  /** Retardo máximo en ms. Por defecto 60000. */
  maxMs?: number
  /** Factor de crecimiento. Por defecto 2. */
  factor?: number
  /** Jitter relativo [0..1]. Por defecto 0.25. */
  jitter?: number
}

export interface LoggerLike {
  debug(message: string, meta?: unknown): void
  info(message: string, meta?: unknown): void
  warn(message: string, meta?: unknown): void
  error(message: string, meta?: unknown): void
}

/** Clave con la que Baileys identifica un mensaje para reintentar su entrega. */
export interface MessageKey {
  id?: string
  remoteJid?: string
  participant?: string
  fromMe?: boolean
}

/** Contenido de un mensaje saliente guardado para poder reenviarlo. */
export interface MessageStore {
  remember(key: MessageKey, content: Record<string, unknown>): void
  get(key: MessageKey): Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined
  forget(id: string): void
  clear(): void
  readonly size: number
}

/** Caché compatible con `CacheStore` de Baileys. */
export interface RetryCache {
  get<T>(key: string): T | undefined
  set<T>(key: string, value: T): void
  del(key: string): void
  flushAll(): void
}

/** Ajustes para reintentar el descifrado y el reenvío de mensajes. */
export interface MessageRetryOptions {
  /** Retardo entre reintentos de descifrado en ms. Por defecto 250. */
  retryRequestDelayMs?: number
  /** Máximo de reintentos por mensaje. Por defecto 5. */
  maxMsgRetryCount?: number
  /** Recrear la sesión de cifrado cuando falla. Por defecto true. */
  enableAutoSessionRecreation?: boolean
  /** Cachear mensajes recientes para responder reenvíos. Por defecto true. */
  enableRecentMessageCache?: boolean
  /** Tiempo de vida de los mensajes recordados en ms. Por defecto 1 hora. */
  messageTtlMs?: number
  /** Máximo de mensajes recordados. Por defecto 1000. */
  maxRememberedMessages?: number
  /** Store propio de mensajes salientes. Por defecto se crea uno en memoria. */
  messageStore?: MessageStore
  /** Caché propia de contadores de reintento. */
  retryCache?: RetryCache
}

export interface QueueOptions {
  /** Número máximo de mensajes en cola. Por defecto 1000. */
  maxSize?: number
  /** Tiempo de vida de un mensaje en cola. Por defecto 5 minutos. */
  ttlMs?: number
  /** Intentos máximos por mensaje. Por defecto 5. */
  maxAttempts?: number
}

export interface QuickReplyButton {
  /** Id devuelto cuando el usuario pulsa el botón. */
  id: string
  /** Texto mostrado en el botón. */
  label: string
}

export interface ButtonMessageOptions {
  header?: string
  footer?: string
  metadata?: Record<string, unknown>
}

/** Botón moderno: respuesta rápida, enlace o llamada. */
export interface InteractiveButton {
  label: string
  id?: string
  url?: string
  phoneNumber?: string
}

export interface CarouselCard {
  title?: string
  subtitle?: string
  text: string
  footer?: string
  buttons?: QuickReplyButton[]
}

export interface CarouselOptions {
  header?: string
  footer?: string
  metadata?: Record<string, unknown>
}

export type OutboundKind = 'text' | 'buttons' | 'interactive' | 'carousel'

export interface OutboundMessage {
  to: string
  text: string
  id?: string
  kind?: OutboundKind
  buttons?: QuickReplyButton[]
  interactiveButtons?: InteractiveButton[]
  cards?: CarouselCard[]
  header?: string
  footer?: string
  metadata?: Record<string, unknown>
}

export interface NormalizedMessage {
  id: string
  from: string
  text: string
  timestamp: number
  groupId?: string
  buttonId?: string
  buttonText?: string
  /** true si WhatsApp no pudo descifrar el mensaje y mostró el placeholder. */
  unavailable?: boolean
  /** Detalle del stub (CIPHERTEXT, mensaje ausente, etc.). */
  unavailableReason?: string
  raw?: unknown
}

export interface ButtonReply extends NormalizedMessage {
  buttonId: string
}

export interface ClientStats {
  reconnects: number
  messagesSent: number
  messagesFailed: number
  messagesDropped: number
  startedAt: number | null
  connectedAt: number | null
  lastError: unknown
}

export interface ClientStatus {
  state: ConnectionState
  attempt: number
  queueSize: number
  stats: ClientStats
}

export interface ClientEvents {
  state: { previous: ConnectionState; current: ConnectionState; attempt: number }
  connecting: { attempt: number }
  connected: { connectedAt: number; attempt: number }
  disconnected: { reason: CloseReason; error?: unknown; willReconnect: boolean }
  qr: { raw: string }
  pairingCode: { code: string }
  message: NormalizedMessage
  /** Mensaje indescifrable; el cliente ya solicitó su reenvío al teléfono. */
  messageUnavailable: NormalizedMessage
  button: ButtonReply
  sent: { id: string; to: string; kind?: OutboundKind }
  queued: { id: string; size: number }
  flushed: { sent: number; failed: number; dropped: number }
  error: { where: string; error: unknown }
}

export interface ClientOptions {
  /** Carpeta donde se guarda la sesión. Por defecto `./sessions/default`. */
  sessionDir?: string
  /** Nombre mostrado como dispositivo vinculado. Por defecto `Sora Baileys`. */
  appName?: string
  /** Número para pairing code (sin +, espacios ni guiones). Si se da, se usa en vez de QR. */
  phoneNumber?: string
  /** Imprimir QR en consola. Por defecto false; usa el evento `qr`. */
  printQR?: boolean
  logger?: LoggerLike
  backoff?: BackoffOptions
  /** Intentos máximos de reconexión. Por defecto Infinity. */
  maxReconnectAttempts?: number
  /** Cada cuánto se revisa la salud de la conexión. Por defecto 30000 ms. */
  heartbeatEveryMs?: number
  /** Sin actividad durante este tiempo se fuerza reconexión. Por defecto 120000 ms. */
  staleAfterMs?: number
  /** Reconectar aunque el motivo sea loggedOut. Por defecto false. */
  reconnectOnLoggedOut?: boolean
  /** Reconectar aunque el motivo sea banned. Por defecto false. */
  reconnectOnBanned?: boolean
  /** Retardo antes de reconectar tras un `restart` interno. Por defecto 250 ms. */
  restartDelayMs?: number
  queue?: QueueOptions
  /** Adaptador de transporte. Por defecto se crea un BaileysAdapter bajo demanda. */
  adapter?: SocketAdapter
  /** Opciones crudas que se pasan al socket del adaptador. */
  socketOptions?: Record<string, unknown>
  /** Reintentos de descifrado/reenvío. Por defecto activados. */
  retry?: MessageRetryOptions
}

/** Eventos que un adaptador puede emitir hacia el cliente. */
export interface SocketAdapterEvents {
  open: { at: number }
  close: { reason: CloseReason; error?: unknown; at: number }
  qr: { raw: string }
  pairingCode: { code: string }
  message: NormalizedMessage
  restartRequested: { at: number }
  credsUpdated: { at: number }
  error: { error: unknown; where: string }
}

/** Sesión de autenticación cargada por el adaptador. */
export interface AuthSession {
  /** Persistir credenciales de forma segura (el cliente la llama con debounce). */
  save(): Promise<void>
  /** true si no hay credenciales previas y hace falta QR/pairing. */
  isFresh: boolean
  /** Dato opaco para inspección o migración. */
  snapshot?: unknown
}

/** Socket vivo devuelto por el adaptador. */
export interface LiveSocket {
  sendText(to: string, text: string, metadata?: Record<string, unknown>): Promise<{ id: string }>
  sendButtons?(
    to: string,
    text: string,
    buttons: QuickReplyButton[],
    options?: ButtonMessageOptions,
  ): Promise<{ id: string }>
  sendInteractive?(
    to: string,
    text: string,
    buttons: InteractiveButton[],
    options?: ButtonMessageOptions,
  ): Promise<{ id: string }>
  sendCarousel?(
    to: string,
    cards: CarouselCard[],
    options?: CarouselOptions,
  ): Promise<{ id: string }>
  isHealthy?(): boolean | Promise<boolean>
  disconnect?(): Promise<void>
  requestPairingCode?(phoneNumber: string): Promise<string>
  /** Pide al teléfono vinculado que reenvíe el contenido de un placeholder. */
  requestMessageResend?(key: MessageKey, raw?: unknown): Promise<void>
}

export interface ConnectAdapterOptions {
  auth: AuthSession
  phoneNumber?: string
  printQR?: boolean
  appName?: string
  socketOptions?: Record<string, unknown>
  retry?: MessageRetryOptions
  messageStore?: MessageStore
  retryCache?: RetryCache
  logger?: LoggerLike
  onEvent: <K extends keyof SocketAdapterEvents>(event: K, payload: SocketAdapterEvents[K]) => void
}

/** Contrato que debe cumplir un transporte (Baileys, mock, otro). */
export interface SocketAdapter {
  readonly name: string
  loadAuth(options: { sessionDir: string; logger?: LoggerLike }): Promise<AuthSession>
  connect(options: ConnectAdapterOptions): Promise<LiveSocket>
}
