import { createRetryCache } from '../core/message-store.js'
import { toMillis } from '../core/time.js'
import type {
  AuthSession,
  ButtonMessageOptions,
  CarouselCard,
  CarouselOptions,
  CloseReason,
  ConnectAdapterOptions,
  InteractiveButton,
  LiveSocket,
  LoggerLike,
  MessageKey,
  MessageStore,
  QuickReplyButton,
  SocketAdapter,
} from '../types.js'

/**
 * Tipos estructurales mínimos. Evitamos depender de los tipos de Baileys en
 * tiempo de compilación: el paquete es un peer opcional.
 */
interface DisconnectReasonMap {
  loggedOut: number
  forbidden: number
  badSession: number
  restartRequired: number
  [key: string]: number
}

interface BaileysModule {
  makeWASocket: (options: Record<string, unknown>) => BaileysSocket
  useMultiFileAuthState: (dir: string) => Promise<{
    state: Record<string, unknown>
    saveCreds: () => Promise<void>
  }>
  DisconnectReason: DisconnectReasonMap
  Browsers: {
    ubuntu: (name: string) => unknown
    windows: (name: string) => unknown
  }
}

interface BaileysSocket {
  ev: {
    on(event: string, listener: (payload: never) => void): void
  }
  sendMessage(jid: string, content: Record<string, unknown>, options?: Record<string, unknown>): Promise<{
    key?: { id?: string }
  } | undefined>
  requestPairingCode?: (phoneNumber: string) => Promise<string>
  requestPlaceholderResend?: (
    key: Record<string, unknown>,
    data?: Record<string, unknown>,
  ) => Promise<string | undefined>
  sendPresenceUpdate?: (presence: string, jid: string) => Promise<void>
  end?: (error?: unknown) => void
  authState?: { creds?: { registered?: boolean } }
  ws?: { readyState?: number }
}

let cachedModule: BaileysModule | undefined

async function loadBaileysModule(logger?: LoggerLike): Promise<BaileysModule> {
  if (cachedModule) return cachedModule
  try {
    // Specifier no literal: mantiene el peer opcional fuera del grafo de tipos.
    const specifier = '@whiskeysockets/baileys'
    const mod = (await import(specifier)) as unknown as BaileysModule
    cachedModule = mod
    return mod
  } catch (error) {
    logger?.error('@whiskeysockets/baileys is required for BaileysAdapter')
    throw new Error(
      'BaileysAdapter necesita @whiskeysockets/baileys. Instálalo con: npm install @whiskeysockets/baileys',
      { cause: error },
    )
  }
}

/**
 * Adaptador de transporte sobre Baileys. Toda la lógica de reconexión, cola y
 * salud vive en el cliente; aquí solo se traducen eventos y se llama al socket.
 */
export class BaileysAdapter implements SocketAdapter {
  readonly name = 'baileys'

  constructor(private readonly logger?: LoggerLike) {}

  async loadAuth(options: { sessionDir: string; logger?: LoggerLike }): Promise<AuthSession> {
    const mod = await loadBaileysModule(options.logger ?? this.logger)
    const { state, saveCreds } = await mod.useMultiFileAuthState(options.sessionDir)
    const creds = state.creds as { me?: unknown; registered?: boolean } | undefined
    return {
      isFresh: !creds?.me,
      save: saveCreds,
      snapshot: state,
    }
  }

  async connect(options: ConnectAdapterOptions): Promise<LiveSocket> {
    const mod = await loadBaileysModule(options.logger)
    const auth = options.auth.snapshot as Record<string, unknown> | undefined

    const retry = options.retry ?? {}
    const messageStore = options.messageStore
    const socket = mod.makeWASocket({
      auth,
      printQRInTerminal: false,
      browser: mod.Browsers.ubuntu(options.appName ?? 'Sora Baileys'),
      retryRequestDelayMs: retry.retryRequestDelayMs ?? 250,
      maxMsgRetryCount: retry.maxMsgRetryCount ?? 5,
      enableAutoSessionRecreation: retry.enableAutoSessionRecreation ?? true,
      enableRecentMessageCache: retry.enableRecentMessageCache ?? true,
      msgRetryCounterCache: options.retryCache ?? createRetryCache(),
      // Baileys invoca este callback cuando el móvil pide reenviar un mensaje
      // que no pudo descifrar. Sin él aparece el placeholder en el chat.
      getMessage: async (key: Record<string, unknown>) => {
        const content = await messageStore?.get(key as MessageKey)
        return content ?? undefined
      },
      ...options.socketOptions,
    })

    const emit = options.onEvent

    socket.ev.on('connection.update', (payload: never) => {
      const update = payload as {
        connection?: string
        qr?: string
        lastDisconnect?: { error?: unknown }
      }
      if (update.qr) emit('qr', { raw: update.qr })

      if (update.connection === 'open') {
        emit('open', { at: Date.now() })
      } else if (update.connection === 'connect') {
        // Baileys pide recrear el socket tras escanear el QR en algunas versiones.
        emit('restartRequested', { at: Date.now() })
      } else if (update.connection === 'close') {
        const error = update.lastDisconnect?.error
        emit('close', { reason: classifyClose(mod, error), error, at: Date.now() })
      }
    })

    socket.ev.on('messages.upsert', (payload: never) => {
      const update = payload as { messages?: Record<string, unknown>[] }
      for (const message of update.messages ?? []) {
        if (message.key && (message.key as { fromMe?: boolean }).fromMe) continue
        emit('message', normalizeMessage(message))
      }
    })

    socket.ev.on('creds.update', () => {
      emit('credsUpdated', { at: Date.now() })
    })

    if (options.phoneNumber) {
      const registered = (socket.authState?.creds?.registered ??
        ((auth?.creds as { registered?: boolean } | undefined)?.registered)) === true
      if (!registered && socket.requestPairingCode) {
        void socket.requestPairingCode(options.phoneNumber)
          .then((code) => emit('pairingCode', { code }))
          .catch((error: unknown) => emit('error', { error, where: 'requestPairingCode' }))
      }
    }

    return new BaileysLiveSocket(socket, messageStore, options.sendTimeoutMs)
  }
}

export function classifyClose(mod: BaileysModule, error: unknown): CloseReason {
  const status = extractStatus(error)
  const reasons = mod.DisconnectReason
  if (status === reasons.loggedOut || status === reasons.badSession) return 'loggedOut'
  if (status === reasons.forbidden) return 'banned'
  if (status === reasons.restartRequired) return 'restart'
  return 'network'
}

function extractStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const direct = (error as { statusCode?: unknown }).statusCode
  if (typeof direct === 'number') return direct
  const output = (error as { output?: { statusCode?: unknown } }).output
  if (output && typeof output.statusCode === 'number') return output.statusCode
  const boom = (error as { isBoom?: boolean; data?: unknown }).data
  if (boom && typeof boom === 'object' && 'statusCode' in boom) {
    const value = (boom as { statusCode?: unknown }).statusCode
    if (typeof value === 'number') return value
  }
  return undefined
}

export function normalizeMessage(message: Record<string, unknown>): import('../types.js').NormalizedMessage {
  const key = (message.key ?? {}) as { id?: string; remoteJid?: string }
  const content = (message.message ?? {}) as {
    conversation?: string
    extendedTextMessage?: { text?: string }
    buttonsResponseMessage?: { selectedButtonId?: string; selectedDisplayText?: string }
    templateButtonReplyMessage?: { selectedId?: string; selectedDisplayText?: string }
    interactiveResponseMessage?: {
      nativeFlowResponseMessage?: { name?: string; paramsJson?: string }
      body?: { text?: string }
    }
  }
  const buttonReply = (content.buttonsResponseMessage ?? content.templateButtonReplyMessage) as
    | { selectedButtonId?: string; selectedId?: string; selectedDisplayText?: string }
    | undefined
  const buttonId = buttonReply?.selectedButtonId ?? buttonReply?.selectedId
  const buttonText = buttonReply?.selectedDisplayText

  const nativeFlow = content.interactiveResponseMessage?.nativeFlowResponseMessage
  const nativeParams = parseJson<{ id?: string; display_text?: string; text?: string }>(nativeFlow?.paramsJson)
  const interactiveId = nativeParams?.id ?? nativeParams?.text
  const interactiveText = nativeParams?.display_text ?? content.interactiveResponseMessage?.body?.text

  const rawStub = message.messageStubType
  const stubType = typeof rawStub === 'number'
    ? rawStub
    : rawStub === 'CIPHERTEXT' ? 2 : rawStub === 'FUTUREPROOF' ? 3 : 0
  const stubParams = (Array.isArray(message.messageStubParameters) ? message.messageStubParameters : [])
    .map((param) => String(param))
  const missingContent = stubParams.some((param) =>
    param === 'Message absent from node' || param === 'Key used already or never filled',
  )
  // 2 = CIPHERTEXT, 3 = FUTUREPROOF en el enum de WhatsApp.
  const unavailable = stubType === 2 || stubType === 3 || missingContent
  const unavailableReason = missingContent
    ? stubParams.find((param) => param === 'Message absent from node' || param === 'Key used already or never filled')
    : stubType === 2 ? 'CIPHERTEXT' : stubType === 3 ? 'FUTUREPROOF' : undefined

  const remoteJid = key.remoteJid ?? ''
  const timestamp = toMillis(message.messageTimestamp)

  return {
    id: key.id ?? `unknown-${Date.now()}`,
    from: remoteJid,
    text: content.conversation ?? content.extendedTextMessage?.text ?? buttonText ?? interactiveText ?? '',
    timestamp,
    groupId: remoteJid.endsWith('@g.us') ? remoteJid : undefined,
    buttonId: unavailable ? undefined : buttonId ?? interactiveId,
    buttonText: unavailable ? undefined : buttonText ?? interactiveText,
    unavailable: unavailable || undefined,
    unavailableReason,
    raw: message,
  }
}

function toNativeFlowButtons(buttons: InteractiveButton[]): Array<{ name: string; buttonParamsJson: string }> {
  return buttons.map((button) => {
    if (button.url) {
      return {
        name: 'url',
        buttonParamsJson: JSON.stringify({ display_text: button.label, url: button.url }),
      }
    }
    if (button.phoneNumber) {
      return {
        name: 'call',
        buttonParamsJson: JSON.stringify({ display_text: button.label, phone_number: button.phoneNumber }),
      }
    }
    return {
      name: 'quick_reply',
      buttonParamsJson: JSON.stringify({ display_text: button.label, id: button.id ?? button.label }),
    }
  })
}

function parseJson<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

class BaileysLiveSocket implements LiveSocket {
  constructor(
    private readonly socket: BaileysSocket,
    private readonly store?: MessageStore,
    private readonly sendTimeoutMs = 0,
  ) {}

  /**
   * Envía con id estable y timeout. El id evita duplicados si un envío lento se
   * reintenta; el timeout evita promesas colgadas con el upstream.
   */
  private async send(
    to: string,
    content: Record<string, unknown>,
    metadata?: Record<string, unknown>,
  ): Promise<{ key?: { id?: string } } | undefined> {
    const options: Record<string, unknown> = { ...metadata }
    const id = typeof options.id === 'string' && options.id.length > 0 ? options.id : undefined
    if (id) options.messageId = id

    if (this.sendTimeoutMs <= 0) {
      return this.socket.sendMessage(to, content, options)
    }

    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        this.socket.sendMessage(to, content, options),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`sendMessage timeout after ${this.sendTimeoutMs}ms`)),
            this.sendTimeoutMs,
          )
          timer.unref?.()
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async sendPresenceUpdate(presence: 'composing' | 'paused', jid: string): Promise<void> {
    if (!this.socket.sendPresenceUpdate) return
    await this.socket.sendPresenceUpdate(presence, jid)
  }

  /** Guarda el contenido exacto que Baileys cifró para poder reenviarlo tras un retry. */
  private remember(
    content: Record<string, unknown>,
    remoteJid: string,
    resultId?: string,
    localId?: string,
  ): void {
    if (!this.store) return
    const ids = new Set<string>()
    if (resultId) ids.add(resultId)
    if (localId) ids.add(localId)
    for (const id of ids) {
      this.store.remember({ id, remoteJid, fromMe: true }, content)
    }
  }

  async requestMessageResend(key: MessageKey, raw?: unknown): Promise<void> {
    const request = this.socket.requestPlaceholderResend
    if (!request) return
    const message = (raw ?? {}) as {
      key?: Record<string, unknown>
      messageTimestamp?: unknown
      pushName?: string
    }
    const fullKey = {
      remoteJid: key.remoteJid,
      id: key.id,
      fromMe: key.fromMe,
      participant: key.participant,
    }
    await request(fullKey, {
      key: message.key ?? fullKey,
      ...(message.messageTimestamp !== undefined ? { messageTimestamp: message.messageTimestamp } : {}),
      ...(message.pushName ? { pushName: message.pushName } : {}),
    })
  }

  async sendText(to: string, text: string, metadata?: Record<string, unknown>): Promise<{ id: string }> {
    const content: Record<string, unknown> = { text }
    const result = await this.send(to, content, metadata)
    this.remember(content, to, result?.key?.id, metadata?.id as string | undefined)
    return { id: result?.key?.id ?? `unknown-${Date.now()}` }
  }

  async sendButtons(
    to: string,
    text: string,
    buttons: QuickReplyButton[],
    options: ButtonMessageOptions = {},
  ): Promise<{ id: string }> {
    const hasHeader = Boolean(options.header)
    const content: Record<string, unknown> = {
      buttonsMessage: {
        contentText: text,
        ...(hasHeader ? { text: options.header, headerType: 2 } : { headerType: 1 }),
        ...(options.footer ? { footerText: options.footer } : {}),
        buttons: buttons.map((button) => ({
          buttonId: button.id,
          buttonText: { displayText: button.label },
          type: 1,
        })),
      },
    }
    const result = await this.send(to, content, options.metadata)
    this.remember(content, to, result?.key?.id, options.metadata?.id as string | undefined)

    return { id: result?.key?.id ?? `unknown-${Date.now()}` }
  }

  async sendInteractive(
    to: string,
    text: string,
    buttons: InteractiveButton[],
    options: ButtonMessageOptions = {},
  ): Promise<{ id: string }> {
    const content: Record<string, unknown> = {
      interactiveMessage: {
        body: { text },
        ...(options.header ? { header: { title: options.header } } : {}),
        ...(options.footer ? { footer: { text: options.footer } } : {}),
        nativeFlowMessage: {
          buttons: toNativeFlowButtons(buttons),
          messageVersion: 3,
        },
      },
    }
    const result = await this.send(to, content, options.metadata)
    this.remember(content, to, result?.key?.id, options.metadata?.id as string | undefined)

    return { id: result?.key?.id ?? `unknown-${Date.now()}` }
  }

  async sendCarousel(
    to: string,
    cards: CarouselCard[],
    options: CarouselOptions = {},
  ): Promise<{ id: string }> {
    const content: Record<string, unknown> = {
      interactiveMessage: {
        body: { text: options.header ?? cards[0]?.text ?? '' },
        ...(options.footer ? { footer: { text: options.footer } } : {}),
        carouselMessage: {
          cards: cards.map((card) => ({
            ...(card.title || card.subtitle
              ? { header: { title: card.title ?? '', subtitle: card.subtitle ?? '', hasMediaAttachment: false } }
              : {}),
            body: { text: card.text },
            ...(card.footer ? { footer: { text: card.footer } } : {}),
            ...(card.buttons && card.buttons.length > 0
              ? {
                  nativeFlowMessage: {
                    buttons: card.buttons.map((button) => ({
                      name: 'quick_reply',
                      buttonParamsJson: JSON.stringify({ display_text: button.label, id: button.id }),
                    })),
                    messageVersion: 3,
                  },
                }
              : {}),
          })),
          messageVersion: 1,
          carouselCardType: 1,
        },
      },
    }
    const result = await this.send(to, content, options.metadata)
    this.remember(content, to, result?.key?.id, options.metadata?.id as string | undefined)

    return { id: result?.key?.id ?? `unknown-${Date.now()}` }
  }

  isHealthy(): boolean {
    if (!this.socket.ws) return true
    return this.socket.ws.readyState === 1
  }

  async disconnect(): Promise<void> {
    this.socket.end?.(new Error('sora/baileys: client stopped'))
  }
}
