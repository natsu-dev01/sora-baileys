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

    const socket = mod.makeWASocket({
      auth,
      printQRInTerminal: false,
      browser: mod.Browsers.ubuntu(options.appName ?? 'Sora Baileys'),
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

    return new BaileysLiveSocket(socket)
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

function normalizeMessage(message: Record<string, unknown>): import('../types.js').NormalizedMessage {
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

  const remoteJid = key.remoteJid ?? ''
  const rawTimestamp = message.messageTimestamp
  const timestamp = typeof rawTimestamp === 'number'
    ? rawTimestamp
    : Number((rawTimestamp as { toString?: () => string } | undefined)?.toString?.() ?? Date.now())

  return {
    id: key.id ?? `unknown-${Date.now()}`,
    from: remoteJid,
    text: content.conversation ?? content.extendedTextMessage?.text ?? buttonText ?? interactiveText ?? '',
    timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
    groupId: remoteJid.endsWith('@g.us') ? remoteJid : undefined,
    buttonId: buttonId ?? interactiveId,
    buttonText: buttonText ?? interactiveText,
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
  constructor(private readonly socket: BaileysSocket) {}

  async sendText(to: string, text: string, metadata?: Record<string, unknown>): Promise<{ id: string }> {
    const result = await this.socket.sendMessage(to, { text }, metadata)
    return { id: result?.key?.id ?? `unknown-${Date.now()}` }
  }

  async sendButtons(
    to: string,
    text: string,
    buttons: QuickReplyButton[],
    options: ButtonMessageOptions = {},
  ): Promise<{ id: string }> {
    const hasHeader = Boolean(options.header)
    const result = await this.socket.sendMessage(to, {
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
    }, options.metadata)

    return { id: result?.key?.id ?? `unknown-${Date.now()}` }
  }

  async sendInteractive(
    to: string,
    text: string,
    buttons: InteractiveButton[],
    options: ButtonMessageOptions = {},
  ): Promise<{ id: string }> {
    const result = await this.socket.sendMessage(to, {
      interactiveMessage: {
        body: { text },
        ...(options.header ? { header: { title: options.header } } : {}),
        ...(options.footer ? { footer: { text: options.footer } } : {}),
        nativeFlowMessage: {
          buttons: toNativeFlowButtons(buttons),
          messageVersion: 3,
        },
      },
    }, options.metadata)

    return { id: result?.key?.id ?? `unknown-${Date.now()}` }
  }

  async sendCarousel(
    to: string,
    cards: CarouselCard[],
    options: CarouselOptions = {},
  ): Promise<{ id: string }> {
    const result = await this.socket.sendMessage(to, {
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
    }, options.metadata)

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
