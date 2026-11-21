import type { LoggerLike } from '../types.js'

/**
 * Botones / mensajes interactivos de Sora (Baileys).
 *
 * Native flow + nodos `biz`/`bot` para que WhatsApp muestre los botones.
 * Incluye fallback automático a texto si algo falla.
 *
 * El módulo no importa Baileys de forma estática: las primitivas se cargan con
 * un `import()` dinámico (inyectable en tests) para que el core siga funcionando
 * sin el peer opcional instalado.
 */

export const MAX_BUTTONS = 3
export const MAX_MULTI_BUTTONS = 10
export const MAX_CAROUSEL_CARDS = 10

export const MESSAGE_WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'deviceSentMessage',
  'editedMessage',
] as const

export const SPECIAL_FLOWS = new Set([
  'mpm',
  'cta_catalog',
  'send_location',
  'call_permission_request',
  'wa_payment_transaction_details',
  'automated_greeting_message_view_catalog',
])

export interface NativeFlowButton {
  name: string
  buttonParamsJson: string
}

export type ButtonInput = unknown

export interface NormalizeButtonsOptions {
  multiple?: boolean
  max?: number
}

export interface MessageParamsOptions {
  raw?: Record<string, unknown>
  bottomSheet?: BottomSheetOptions
  tapTarget?: TapTargetOptions
  limitedTimeOffer?: LimitedTimeOfferOptions
}

export interface BottomSheetOptions {
  inThreadButtonsLimit?: number
  dividerIndices?: number[]
  listTitle?: string
  buttonTitle?: string
}

export interface TapTargetOptions {
  title?: string
  description?: string
  canonicalUrl?: string
  domain?: string
  buttonIndex?: number
}

export interface LimitedTimeOfferOptions {
  text?: string
  url?: string
  copyCode?: string
  expirationTime?: number
}

export interface BinaryNodeLike {
  tag: string
  attrs: Record<string, string>
  content?: string | BinaryNodeLike | Array<string | BinaryNodeLike>
}

export interface GeneratedWAMessage {
  key: { id?: string; remoteJid?: string }
  message?: Record<string, unknown>
  messageTimestamp?: unknown
}

export interface UpstreamHelpers {
  generateWAMessageFromContent(
    jid: string,
    content: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): GeneratedWAMessage
  normalizeMessageContent?(message: Record<string, unknown> | undefined): Record<string, unknown> | undefined
  generateMessageIDV2?(userJid?: string): string
  isJidGroup?(jid: string): boolean
  prepareWAMessageMedia?(
    content: Record<string, unknown>,
    options: Record<string, unknown>,
  ): Promise<Record<string, unknown>>
}

export interface InteractiveDeps {
  /** Upstream ya cargado por el adaptador. Tiene prioridad sobre `specifier`. */
  upstream?: UpstreamHelpers
  /** Por defecto `@sora/baileys/upstream`. Variable para no resolverlo en compile time. */
  specifier?: string
  logger?: LoggerLike
}

/** Lo mínimo que el socket necesita para relajar mensajes interactivos. */
export interface InteractiveSocket {
  relayMessage(
    jid: string,
    message: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<unknown>
  sendMessage?(
    jid: string,
    content: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<{ key?: { id?: string } } | undefined>
  waUploadToServer?(source: unknown, type?: string): Promise<unknown>
  authState?: { creds?: { me?: { id?: string } } }
  user?: { id?: string }
}

export interface HeaderInput {
  title?: string
  image?: unknown
  video?: unknown
}

export interface RelayInteractiveOptions {
  quoted?: unknown
  mdPatch?: boolean
  messageId?: string
  additionalNodes?: BinaryNodeLike[]
}

export interface InteractiveSendOptions extends RelayInteractiveOptions {
  /** Texto alternativo cuando el mensaje interactivo no puede enviarse. */
  fallbackText?: string
}

export interface ButtonsContent {
  title?: string
  text: unknown
  footer?: unknown
  buttons?: ButtonInput[]
  image?: unknown
  video?: unknown
  quoted?: unknown
  fallbackText?: string
  contextInfo?: Record<string, unknown>
  multiple?: boolean
  maxButtons?: number
  messageParams?: Record<string, unknown>
  bottomSheet?: BottomSheetOptions
  tapTarget?: TapTargetOptions
  limitedTimeOffer?: LimitedTimeOfferOptions
  rawParams?: Record<string, unknown>
  mdPatch?: boolean
  additionalNodes?: BinaryNodeLike[]
}

export interface ListContent {
  title?: string
  text?: unknown
  footer?: unknown
  buttonText?: string
  sections?: unknown[]
  quoted?: unknown
  fallbackText?: string
  contextInfo?: Record<string, unknown>
  listType?: number
}

export interface TemplateButtonsInput {
  text?: unknown
  footer?: unknown
  buttons?: ButtonInput[]
  quoted?: unknown
  fallbackText?: string
  contextInfo?: Record<string, unknown>
}

export interface CarouselCardInput {
  id?: string
  title?: unknown
  subtitle?: unknown
  body?: unknown
  text?: unknown
  footer?: unknown
  image?: unknown
  video?: unknown
  buttons?: ButtonInput[]
  multiple?: boolean
  maxButtons?: number
  messageParams?: Record<string, unknown>
  bottomSheet?: BottomSheetOptions
  tapTarget?: TapTargetOptions
  limitedTimeOffer?: LimitedTimeOfferOptions
  rawParams?: Record<string, unknown>
}

export interface CarouselContent {
  text?: unknown
  footer?: unknown
  cards?: CarouselCardInput[]
  quoted?: unknown
  fallbackText?: string
  mdPatch?: boolean
  additionalNodes?: BinaryNodeLike[]
}

const upstreamCache = new Map<string, Promise<UpstreamHelpers>>()

function fallbackMessageId(): string {
  return `sora-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/** Carga el upstream una sola vez. El specifier es variable a propósito. */
async function loadUpstream(deps: InteractiveDeps = {}): Promise<UpstreamHelpers> {
  if (deps.upstream) return deps.upstream
  const specifier = deps.specifier ?? '@sora/baileys/upstream'
  let pending = upstreamCache.get(specifier)
  if (!pending) {
    pending = import(specifier).then((module) => module as unknown as UpstreamHelpers)
    upstreamCache.set(specifier, pending)
  }
  return pending
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function unwrapMessage(message: unknown): Record<string, unknown> {
  let current = message
  for (let depth = 0; depth < 8; depth += 1) {
    const record = asRecord(current)
    const wrapper = MESSAGE_WRAPPERS.find((key) => {
      const inner = asRecord(record[key])
      return Boolean(inner.message)
    })
    if (!wrapper) return record
    current = asRecord(asRecord(record[wrapper]).message)
  }
  return asRecord(current)
}

function toJson(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value ?? {})
}

function nativeParams(button: NativeFlowButton): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(button.buttonParamsJson))
  } catch {
    return {}
  }
}

function displayOf(nativeButton: NativeFlowButton): string {
  const params = nativeParams(nativeButton)
  return pickString(params.display_text)
    ?? pickString(params.title)
    ?? pickString(params.id)
    ?? (typeof params.text === 'string' ? params.text : undefined)
    ?? 'Opción'
}

/** Normaliza botones antiguos, modernos y nativos a `nativeFlowMessage.buttons`. */
export function normalizeButton(button: ButtonInput): NativeFlowButton {
  if (typeof button === 'string') {
    return {
      name: 'quick_reply',
      buttonParamsJson: toJson({ display_text: button, id: button }),
    }
  }

  const value = asRecord(button)
  if (Object.keys(value).length === 0) throw new Error('Botón inválido')

  if (typeof value.name === 'string' && (value.buttonParamsJson !== undefined || value.params !== undefined)) {
    return {
      name: value.name,
      buttonParamsJson: toJson(value.buttonParamsJson ?? value.params),
    }
  }

  // Formato heredado de Baileys.
  if (value.buttonId !== undefined && asRecord(value.buttonText).displayText !== undefined) {
    return {
      name: 'quick_reply',
      buttonParamsJson: toJson({
        display_text: String(asRecord(value.buttonText).displayText),
        id: String(value.buttonId),
      }),
    }
  }

  const label = pickString(value.text)
    ?? pickString(value.displayText)
    ?? pickString(value.texto)
    ?? pickString(value.label)
    ?? ''

  if (value.copy !== undefined || value.codigo !== undefined) {
    return {
      name: 'cta_copy',
      buttonParamsJson: toJson({
        display_text: label || 'Copiar',
        ...(value.id !== undefined ? { id: String(value.id) } : {}),
        copy_code: String(value.copy ?? value.codigo),
      }),
    }
  }

  const url = pickString(value.url)
  if (url) {
    return {
      name: 'cta_url',
      buttonParamsJson: toJson({
        display_text: label || 'Abrir',
        url,
        merchant_url: url,
      }),
    }
  }

  const phone = pickString(value.call) ?? pickString(value.phone) ?? pickString(value.telefono) ?? pickString(value.phoneNumber)
  if (phone) {
    return {
      name: 'cta_call',
      buttonParamsJson: toJson({
        display_text: label || 'Llamar',
        phone_number: phone.replace(/[^\d]/g, ''),
      }),
    }
  }

  const sections = value.sections ?? value.list ?? value.secciones
  if (sections !== undefined) {
    return {
      name: 'single_select',
      buttonParamsJson: toJson({
        title: pickString(value.title) ?? pickString(value.titulo) ?? (label || 'Opciones'),
        sections,
        ...(value.multiple ? { has_multiple_buttons: true } : {}),
      }),
    }
  }

  const id = pickString(value.id)
  if (id !== undefined || label) {
    return {
      name: 'quick_reply',
      buttonParamsJson: toJson({
        display_text: label || String(id),
        id: id ?? label,
        ...(pickString(value.type) ? { type: value.type } : {}),
      }),
    }
  }

  if (value.buttonParamsJson !== undefined) {
    return { name: pickString(value.name) ?? 'quick_reply', buttonParamsJson: toJson(value.buttonParamsJson) }
  }

  throw new Error(
    'Botón inválido: usa { text, id }, { text, url }, { text, copy }, { text, phone } o { name, buttonParamsJson }',
  )
}

function markMultiple(button: NativeFlowButton): NativeFlowButton {
  const params = nativeParams(button)
  if (params.has_multiple_buttons) return button
  return {
    name: button.name,
    buttonParamsJson: JSON.stringify({ ...params, has_multiple_buttons: true }),
  }
}

export function normalizeButtons(
  buttons: readonly ButtonInput[] = [],
  options: NormalizeButtonsOptions = {},
): NativeFlowButton[] {
  const useMultiple = Boolean(options.multiple)
  const max = Math.max(1, Number(options.max) || (useMultiple ? MAX_MULTI_BUTTONS : MAX_BUTTONS))
  const source = Array.isArray(buttons) ? buttons : []
  let normalized = source.filter(Boolean).slice(0, max).map((button) => normalizeButton(button))

  if (useMultiple) {
    normalized = normalized.map(markMultiple)
    return [
      { name: 'single_select', buttonParamsJson: '{"has_multiple_buttons":true}' },
      { name: 'call_permission_request', buttonParamsJson: '{"has_multiple_buttons":true}' },
      ...normalized,
    ]
  }

  return normalized
}

export function buildMessageParams(options: MessageParamsOptions = {}): Record<string, unknown> {
  const params: Record<string, unknown> = { ...(options.raw ?? {}) }

  if (options.bottomSheet) {
    const sheet = options.bottomSheet
    params.bottom_sheet = {
      in_thread_buttons_limit: Number(sheet.inThreadButtonsLimit) || 2,
      divider_indices: Array.isArray(sheet.dividerIndices) ? sheet.dividerIndices : [1, 2, 3, 4, 5, 999],
      list_title: sheet.listTitle || 'Opciones',
      button_title: sheet.buttonTitle || 'Ver opciones',
    }
  }

  if (options.tapTarget) {
    const tap = options.tapTarget
    params.tap_target_configuration = {
      title: tap.title || '',
      description: tap.description || '',
      canonical_url: tap.canonicalUrl || '',
      domain: tap.domain || '',
      button_index: Number(tap.buttonIndex) || 0,
    }
  }

  if (options.limitedTimeOffer) {
    const offer = options.limitedTimeOffer
    params.limited_time_offer = {
      text: offer.text || '',
      ...(offer.url ? { url: offer.url } : {}),
      ...(offer.copyCode ? { copy_code: offer.copyCode } : {}),
      expiration_time: Number(offer.expirationTime) || Date.now() + 3_600_000,
    }
  }

  return params
}

function buttonsFallbackText(buttons: readonly NativeFlowButton[]): string {
  return buttons.map((button) => `• ${displayOf(button)}`).join('\n')
}

function mediaSource(value: unknown): unknown {
  if (typeof value === 'string') return { url: value }
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return value
  return value
}

export async function prepareHeader(
  header: HeaderInput | undefined,
  socket: InteractiveSocket,
  deps: InteractiveDeps = {},
): Promise<Record<string, unknown> | undefined> {
  if (!header) return undefined
  const { title, image, video } = header
  const media = video ?? image
  if (media === undefined || media === null) {
    return pickString(title) ? { title: String(title), hasMediaAttachment: false } : undefined
  }
  if (!socket.waUploadToServer) throw new Error('El socket todavía no puede subir archivos')

  const upstream = await loadUpstream(deps)
  if (!upstream.prepareWAMessageMedia) throw new Error('El upstream no puede preparar multimedia')
  const type = video !== undefined && video !== null ? 'video' : 'image'
  const prepared = await upstream.prepareWAMessageMedia(
    { [type]: mediaSource(media) },
    { upload: socket.waUploadToServer },
  )
  return {
    ...(pickString(title) ? { title: String(title) } : {}),
    hasMediaAttachment: true,
    ...prepared,
  }
}

function isGroupJid(jid: string, deps: InteractiveDeps): boolean {
  return deps.upstream?.isJidGroup?.(jid) ?? jid.endsWith('@g.us')
}

export function interactiveNodes(
  chat: string,
  content: Record<string, unknown> | undefined,
  deps: InteractiveDeps = {},
): BinaryNodeLike[] {
  const nativeFlow = asRecord(asRecord(content?.interactiveMessage).nativeFlowMessage)
  const buttons = Array.isArray(nativeFlow.buttons) ? nativeFlow.buttons : []
  const firstButton = pickString(asRecord(buttons[0]).name)
  const nodes: BinaryNodeLike[] = []

  if (firstButton === 'review_and_pay' || firstButton === 'payment_info') {
    nodes.push({
      tag: 'biz',
      attrs: {
        native_flow_name: firstButton === 'review_and_pay' ? 'order_details' : firstButton,
      },
    })
  } else if (content?.listMessage) {
    nodes.push({
      tag: 'biz',
      attrs: {},
      content: [{ tag: 'list', attrs: { v: '2', type: 'product_list' } }],
    })
  } else {
    const special = firstButton ? SPECIAL_FLOWS.has(firstButton) : false
    const isLegacy = Boolean(content?.buttonsMessage)
    nodes.push({
      tag: 'biz',
      attrs: {
        actual_actors: '2',
        host_storage: '2',
        privacy_mode_ts: String(Math.floor(Date.now() / 1000) - 77_980_457),
      },
      content: [
        {
          tag: 'interactive',
          attrs: { type: 'native_flow', v: '1' },
          content: [
            {
              tag: 'native_flow',
              attrs: special && !isLegacy ? { v: '2', name: firstButton ?? '' } : { v: '9', name: 'mixed' },
            },
          ],
        },
        { tag: 'quality_control', attrs: { source_type: 'third_party' } },
      ],
    })
  }

  if (!isGroupJid(chat, deps)) nodes.push({ tag: 'bot', attrs: { biz_bot: '1' } })
  return nodes
}

export function patchForMd(message: unknown): unknown {
  const record = asRecord(message)
  if (Object.keys(record).length === 0) return message
  if (asRecord(record.documentWithCaptionMessage).message) return message
  if (record.interactiveMessage || record.buttonsMessage || record.listMessage) {
    return { documentWithCaptionMessage: { message: { ...record } } }
  }
  return message
}

export async function relayInteractive(
  socket: InteractiveSocket,
  chat: string,
  content: Record<string, unknown>,
  options: RelayInteractiveOptions = {},
  deps: InteractiveDeps = {},
): Promise<GeneratedWAMessage> {
  if (!socket?.relayMessage) throw new Error('El socket no puede enviar mensajes interactivos')

  const upstream = await loadUpstream(deps)
  const userJid = socket.authState?.creds?.me?.id ?? socket.user?.id
  const messageId = pickString(options.messageId)
    ?? upstream.generateMessageIDV2?.(userJid)
    ?? fallbackMessageId()
  const fullMsg = upstream.generateWAMessageFromContent(chat, content, {
    userJid,
    quoted: options.quoted,
    messageId,
    timestamp: new Date(),
  })

  const msg = fullMsg.message as Record<string, unknown> | undefined
  const normalized = upstream.normalizeMessageContent?.(msg) ?? msg
  const isInteractive = Boolean(
    normalized?.interactiveMessage || normalized?.buttonsMessage || normalized?.listMessage,
  )
  const nodes = [...(options.additionalNodes ?? [])]
  if (isInteractive) nodes.push(...interactiveNodes(chat, normalized, deps))

  const wireMessage = options.mdPatch ? patchForMd(fullMsg.message) : fullMsg.message
  await socket.relayMessage(chat, wireMessage as Record<string, unknown>, {
    messageId: fullMsg.key.id ?? messageId,
    additionalNodes: nodes.length ? nodes : undefined,
  })

  return fullMsg
}

function fallbackTextFor(content: ButtonsContent, buttons: readonly NativeFlowButton[]): string {
  return content.fallbackText
    || [content.text, buttonsFallbackText(buttons), content.footer]
      .filter((part): part is string => part !== undefined && part !== null && String(part).length > 0)
      .map(String)
      .join('\n\n')
}

async function sendTextFallback(
  socket: InteractiveSocket,
  chat: string,
  text: string,
  contextInfo: Record<string, unknown> | undefined,
  quoted: unknown,
): Promise<void> {
  if (!socket.sendMessage) throw new Error('El socket no puede enviar el fallback de texto')
  await socket.sendMessage(
    chat,
    { text, ...(contextInfo ? { contextInfo } : {}) },
    quoted ? { quoted } : undefined,
  )
}

export async function sendButtons(
  socket: InteractiveSocket,
  chat: string,
  content: ButtonsContent,
  options: InteractiveSendOptions = {},
  deps: InteractiveDeps = {},
): Promise<GeneratedWAMessage | null> {
  const normalized = normalizeButtons(content.buttons ?? [], {
    multiple: content.multiple,
    max: content.maxButtons,
  })
  if (!normalized.length) throw new Error('Se necesita al menos un botón')

  const params = buildMessageParams({
    raw: content.messageParams ?? content.rawParams,
    bottomSheet: content.bottomSheet,
    tapTarget: content.tapTarget,
    limitedTimeOffer: content.limitedTimeOffer,
  })
  const messageParamsJson = Object.keys(params).length ? toJson(params) : ''
  const header = await prepareHeader({ title: content.title, image: content.image, video: content.video }, socket, deps)

  try {
    return await relayInteractive(socket, chat, {
      interactiveMessage: {
        ...(content.contextInfo ? { contextInfo: content.contextInfo } : {}),
        ...(header ? { header } : {}),
        body: { text: String(content.text ?? '') },
        ...(content.footer ? { footer: { text: String(content.footer) } } : {}),
        nativeFlowMessage: {
          buttons: normalized,
          messageParamsJson,
          messageVersion: 1,
        },
      },
    }, { quoted: content.quoted, mdPatch: content.mdPatch, messageId: options.messageId, additionalNodes: content.additionalNodes }, deps)
  } catch (error) {
    await sendTextFallback(socket, chat, fallbackTextFor(content, normalized), content.contextInfo, content.quoted)
    return null
  }
}

/** Lista nativa (`single_select`) construida sobre `sendButtons`. */
export async function sendList(
  socket: InteractiveSocket,
  chat: string,
  content: ListContent,
  options: InteractiveSendOptions = {},
  deps: InteractiveDeps = {},
): Promise<GeneratedWAMessage | null> {
  const buttonText = content.buttonText || 'Ver opciones'
  return sendButtons(socket, chat, {
    title: content.title,
    text: content.text ?? '',
    footer: content.footer,
    quoted: content.quoted,
    fallbackText: content.fallbackText,
    contextInfo: content.contextInfo,
    buttons: [{ title: buttonText, text: buttonText, list: content.sections ?? [] }],
  }, options, deps)
}

/** Lista clásica (`listMessage`) con secciones y filas. */
export async function sendListMessage(
  socket: InteractiveSocket,
  chat: string,
  content: ListContent,
  options: InteractiveSendOptions = {},
  deps: InteractiveDeps = {},
): Promise<GeneratedWAMessage | null> {
  if (!Array.isArray(content.sections) || content.sections.length === 0) {
    throw new Error('La lista necesita al menos una sección')
  }

  try {
    return await relayInteractive(socket, chat, {
      listMessage: {
        title: content.title ? String(content.title) : undefined,
        description: String(content.text ?? ''),
        buttonText: String(content.buttonText || 'Ver opciones'),
        listType: typeof content.listType === 'number' ? content.listType : 1,
        sections: content.sections,
        footerText: content.footer ? String(content.footer) : undefined,
        ...(content.contextInfo ? { contextInfo: content.contextInfo } : {}),
      },
    }, { quoted: content.quoted, mdPatch: options.mdPatch, messageId: options.messageId, additionalNodes: options.additionalNodes }, deps)
  } catch (error) {
    const fallback = content.fallbackText
      || [content.title, content.text].filter(Boolean).join('\n')
      || 'Opciones'
    await sendTextFallback(socket, chat, String(fallback), content.contextInfo, content.quoted)
    return null
  }
}

/** Envío crudo de contenido interactivo con nodos `biz`/`bot`. */
export async function sendInteractiveMessage(
  socket: InteractiveSocket,
  chat: string,
  content: Record<string, unknown>,
  options: RelayInteractiveOptions & { additionalNodes?: BinaryNodeLike[] } = {},
  deps: InteractiveDeps = {},
): Promise<GeneratedWAMessage> {
  const upstream = await loadUpstream(deps)
  const userJid = socket.authState?.creds?.me?.id ?? socket.user?.id
  const messageId = pickString(options.messageId)
    ?? upstream.generateMessageIDV2?.(userJid)
    ?? fallbackMessageId()
  const fullMsg = upstream.generateWAMessageFromContent(chat, content, {
    userJid,
    quoted: options.quoted,
    messageId,
    timestamp: new Date(),
  })

  const msg = fullMsg.message as Record<string, unknown> | undefined
  const normalized = upstream.normalizeMessageContent?.(msg) ?? msg
  const nodes = [...(options.additionalNodes ?? [])]
  if (normalized?.interactiveMessage || normalized?.buttonsMessage || normalized?.listMessage) {
    nodes.push(...interactiveNodes(chat, normalized, deps))
  }

  const wireMessage = options.mdPatch ? patchForMd(fullMsg.message) : fullMsg.message
  await socket.relayMessage(chat, wireMessage as Record<string, unknown>, {
    messageId: fullMsg.key.id ?? messageId,
    additionalNodes: nodes.length ? nodes : undefined,
  })
  return fullMsg
}

/** Botones en formato heredado `buttonsMessage` (máximo 3). */
export async function sendTemplateButtons(
  socket: InteractiveSocket,
  chat: string,
  content: TemplateButtonsInput,
  options: InteractiveSendOptions = {},
  deps: InteractiveDeps = {},
): Promise<GeneratedWAMessage | null> {
  const raw = (content.buttons ?? []).filter(Boolean).slice(0, MAX_BUTTONS)
  if (!raw.length) throw new Error('Se necesita al menos un botón')

  const legacyButtons = raw.map((button, index) => {
    const normalized = normalizeButton(button)
    const params = nativeParams(normalized)
    return {
      buttonId: pickString(params.id) ?? `button_${index + 1}`,
      buttonText: {
        displayText: pickString(params.display_text) ?? pickString(params.title) ?? `Botón ${index + 1}`,
      },
      type: 1,
    }
  })

  try {
    return await sendInteractiveMessage(socket, chat, {
      buttonsMessage: {
        contentText: String(content.text ?? ''),
        footerText: content.footer ? String(content.footer) : undefined,
        buttons: legacyButtons,
        ...(content.contextInfo ? { contextInfo: content.contextInfo } : {}),
      },
    }, { quoted: content.quoted, mdPatch: options.mdPatch, messageId: options.messageId, additionalNodes: options.additionalNodes }, deps)
  } catch (error) {
    const fallback = content.fallbackText
      || [content.text, buttonsFallbackText(raw.map(normalizeButton)), content.footer]
        .filter((part): part is string => part !== undefined && part !== null && String(part).length > 0)
        .map(String)
        .join('\n\n')
    await sendTextFallback(socket, chat, fallback, content.contextInfo, content.quoted)
    return null
  }
}

export async function sendCarousel(
  socket: InteractiveSocket,
  chat: string,
  content: CarouselContent,
  options: InteractiveSendOptions = {},
  deps: InteractiveDeps = {},
): Promise<GeneratedWAMessage | null> {
  const cards = content.cards ?? []
  if (!Array.isArray(cards) || cards.length === 0) {
    throw new Error('El carrusel necesita al menos una tarjeta')
  }

  try {
    const preparedCards: Record<string, unknown>[] = []
    for (const card of cards.slice(0, MAX_CAROUSEL_CARDS)) {
      const header = await prepareHeader({
        title: pickString(card.title),
        image: card.image,
        video: card.video,
      }, socket, deps)
      const buttons = normalizeButtons(card.buttons ?? [], { multiple: card.multiple, max: card.maxButtons })
      const params = buildMessageParams({
        raw: card.messageParams ?? card.rawParams,
        bottomSheet: card.bottomSheet,
        tapTarget: card.tapTarget,
        limitedTimeOffer: card.limitedTimeOffer,
      })
      const messageParamsJson = Object.keys(params).length ? toJson(params) : ''
      const body = String(card.body ?? card.text ?? '')

      preparedCards.push({
        ...(header ? { header } : {}),
        body: { text: body },
        ...(card.footer ? { footer: { text: String(card.footer) } } : {}),
        ...(buttons.length
          ? { nativeFlowMessage: { buttons, messageParamsJson, messageVersion: 1 } }
          : {}),
      })
    }

    return await relayInteractive(socket, chat, {
      interactiveMessage: {
        body: { text: String(content.text ?? '') },
        ...(content.footer ? { footer: { text: String(content.footer) } } : {}),
        carouselMessage: { cards: preparedCards, messageVersion: 1 },
      },
    }, { quoted: content.quoted, mdPatch: content.mdPatch, messageId: options.messageId, additionalNodes: content.additionalNodes }, deps)
  } catch (error) {
    deps.logger?.warn?.('[interactive] carrusel falló', error)
    if (!socket.sendMessage) throw error

    const intro = content.fallbackText ?? content.text
    if (intro !== undefined && intro !== null && String(intro).length > 0) {
      await socket.sendMessage(chat, { text: String(intro) }, content.quoted ? { quoted: content.quoted } : undefined)
    }

    for (const card of cards) {
      const caption = [card.title, card.body ?? card.text, card.footer]
        .filter((part): part is string => part !== undefined && part !== null && String(part).length > 0)
        .map(String)
        .join('\n\n')
      const media = card.video ?? card.image
      if (media !== undefined && media !== null) {
        await socket.sendMessage(chat, {
          [card.video !== undefined && card.video !== null ? 'video' : 'image']: mediaSource(media),
          caption: caption || undefined,
        }, content.quoted ? { quoted: content.quoted } : undefined).catch(() => undefined)
      } else if (caption) {
        await socket.sendMessage(chat, { text: caption }, content.quoted ? { quoted: content.quoted } : undefined)
      }
    }

    const cardButtons = cards.slice(0, MAX_BUTTONS).map((card, index) => ({
      text: pickString(card.title) ?? pickString(card.body) ?? pickString(card.text) ?? 'Abrir',
      id: pickString(card.id)
        ?? pickString(asRecord(card.buttons?.[0]).id)
        ?? pickString(card.title)
        ?? `card_${index + 1}`,
    }))

    if (cardButtons.length) {
      await sendButtons(socket, chat, {
        text: content.text ? String(content.text) : 'Opciones',
        footer: content.footer,
        buttons: cardButtons,
        quoted: content.quoted,
      }, options, deps)
    }
    return null
  }
}

/** Extrae el id de la respuesta a un botón, lista o flujo. */
export function getInteractiveReply(message: unknown): string | null {
  const content = unwrapMessage(asRecord(message).message ?? message)
  const native = asRecord(asRecord(content.interactiveResponseMessage).nativeFlowResponseMessage)
  if (typeof native.paramsJson === 'string') {
    try {
      const params = asRecord(JSON.parse(native.paramsJson))
      const id = params.id ?? params.button_id ?? params.selectedId ?? params.selected_id
      if (id !== undefined && id !== null) return String(id)
    } catch {
      return null
    }
  }

  const buttons = asRecord(content.buttonsResponseMessage)
  const list = asRecord(content.listResponseMessage)
  const single = asRecord(list.singleSelectReply)
  const template = asRecord(content.templateButtonReplyMessage)
  const id = buttons.selectedButtonId
    ?? single.selectedRowId
    ?? template.selectedId
    ?? template.selectedButtonId
  return id !== undefined && id !== null ? String(id) : null
}

export interface FlowButtonConfig {
  mode?: string
  flowMessageVersion?: string
  flowToken?: string
  flowId?: string
  flowCta?: string
  flowAction?: string
  flowActionPayload?: Record<string, unknown>
  flowMetadata?: Record<string, unknown>
}

export const button = {
  /** Respuesta rápida: al tocarlo vuelve a entrar al handler como comando. */
  reply: (text: string, id: string = text): NativeFlowButtonInput => ({ text, id }),
  /** Respuesta rápida con `type: reply` (la variante que usan varios bots). */
  replyTyped: (text: string, id: string = text): NativeFlowButtonInput => ({ text, id, type: 'reply' }),
  url: (text: string, url: string): NativeFlowButtonInput => ({ text, url }),
  copy: (text: string, code: string): NativeFlowButtonInput => ({ text, copy: code }),
  call: (text: string, phone: string): NativeFlowButtonInput => ({ text, call: phone }),
  phone: (text: string, phone: string): NativeFlowButtonInput => ({ text, phone }),
  /** Lista nativa (`single_select`). */
  list: (text: string, sections: unknown[], title?: string): NativeFlowButtonInput => ({
    text,
    list: sections,
    ...(title ? { title } : {}),
  }),
  /** Lista con bandera `has_multiple_buttons` para mostrarse junto a más acciones. */
  multiList: (text: string, sections: unknown[], title?: string): NativeFlowButtonInput => ({
    text,
    list: sections,
    ...(title ? { title } : {}),
    multiple: true,
  }),
  /** Botón señal que habilita más de 3 acciones. */
  signal: (): NativeFlowButton => ({
    name: 'single_select',
    buttonParamsJson: '{"has_multiple_buttons":true}',
  }),
  /** Solicitud de permiso de llamada. */
  callPermission: (text = 'Permitir llamadas'): NativeFlowButton => ({
    name: 'call_permission_request',
    buttonParamsJson: toJson({ display_text: text, has_multiple_buttons: true }),
  }),
  /** Flujo de WhatsApp (`galaxy_message`). */
  flow: (text: string, config: FlowButtonConfig = {}): NativeFlowButton => ({
    name: 'galaxy_message',
    buttonParamsJson: toJson({
      mode: config.mode || 'published',
      flow_message_version: config.flowMessageVersion || '3',
      flow_token: config.flowToken || '',
      flow_id: config.flowId || '',
      flow_cta: text || config.flowCta || 'Abrir',
      flow_action: config.flowAction || 'navigate',
      flow_action_payload: config.flowActionPayload ?? {},
      flow_metadata: config.flowMetadata ?? {},
    }),
  }),
  galaxy: (text: string, config: FlowButtonConfig = {}): NativeFlowButton => button.flow(text, config),
}

export interface NativeFlowButtonInput {
  text?: string
  id?: string
  type?: string
  url?: string
  copy?: string
  codigo?: string
  call?: string
  phone?: string
  telefono?: string
  phoneNumber?: string
  list?: unknown[]
  sections?: unknown[]
  secciones?: unknown[]
  title?: string
  titulo?: string
  multiple?: boolean
  name?: string
  buttonParamsJson?: string | Record<string, unknown>
  params?: string | Record<string, unknown>
}
