import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_BUTTONS,
  button,
  buildMessageParams,
  getInteractiveReply,
  interactive,
  interactiveNodes,
  normalizeButton,
  normalizeButtons,
} from '../dist/index.js'

const fakeUpstream = {
  generateWAMessageFromContent: (jid, content, options = {}) => ({
    key: { id: options.messageId ?? 'generated', remoteJid: jid },
    message: content,
  }),
  normalizeMessageContent: (message) => message,
  generateMessageIDV2: () => 'generated-id',
  isJidGroup: (jid) => jid.endsWith('@g.us'),
  prepareWAMessageMedia: async (content) => {
    const kind = Object.keys(content)[0]
    return { [`${kind}Message`]: { url: 'https://cdn.test/media' } }
  },
}

function fakeSocket(overrides = {}) {
  const relayed = []
  const sent = []
  const socket = {
    relayMessage: async (jid, message, options) => {
      relayed.push({ jid, message, options })
    },
    sendMessage: async (jid, content, options) => {
      sent.push({ jid, content, options })
      return { key: { id: 'fallback-id' } }
    },
    waUploadToServer: async () => ({ url: 'https://cdn.test/upload' }),
    authState: { creds: { me: { id: 'bot@s.whatsapp.net' } } },
    user: { id: 'bot@s.whatsapp.net' },
    ...overrides,
  }
  return { socket, relayed, sent }
}

test('normalizeButton acepta formatos antiguos, modernos y nativos', () => {
  assert.deepEqual(normalizeButton('Sí'), {
    name: 'quick_reply',
    buttonParamsJson: '{"display_text":"Sí","id":"Sí"}',
  })
  assert.deepEqual(normalizeButton({ id: 'yes', label: 'Sí' }), {
    name: 'quick_reply',
    buttonParamsJson: '{"display_text":"Sí","id":"yes"}',
  })
  assert.deepEqual(normalizeButton({ text: 'Web', url: 'https://sora.dev' }), {
    name: 'cta_url',
    buttonParamsJson: '{"display_text":"Web","url":"https://sora.dev","merchant_url":"https://sora.dev"}',
  })
  assert.deepEqual(normalizeButton({ text: 'Llamar', phone: '+52 55 1234 5678' }), {
    name: 'cta_call',
    buttonParamsJson: '{"display_text":"Llamar","phone_number":"525512345678"}',
  })
  assert.equal(normalizeButton({ text: 'Copiar', copy: 'ABC' }).name, 'cta_copy')
  assert.equal(normalizeButton({ text: 'Opciones', list: [{ title: 'A', rows: [] }] }).name, 'single_select')
  assert.equal(normalizeButton(button.flow('Abrir', { flowId: 'flow-1' })).name, 'galaxy_message')
  assert.throws(() => normalizeButton({}), /Botón inválido/)
})

test('normalizeButtons respeta el máximo y agrega señales multi-botón', () => {
  const items = Array.from({ length: 5 }, (_, index) => ({ text: `Opción ${index}`, id: `opt-${index}` }))

  const simple = normalizeButtons(items)
  assert.equal(simple.length, MAX_BUTTONS)

  const multiple = normalizeButtons(items, { multiple: true })
  assert.equal(multiple.length, 2 + items.length)
  assert.equal(multiple[0].name, 'single_select')
  assert.equal(multiple[1].name, 'call_permission_request')
  assert.match(multiple[2].buttonParamsJson, /has_multiple_buttons/)
})

test('buildMessageParams construye bottom sheet, tap target y oferta', () => {
  const now = Date.now()
  const params = buildMessageParams({
    raw: { custom: 1 },
    bottomSheet: { listTitle: 'Menú' },
    tapTarget: { canonicalUrl: 'https://sora.dev', buttonIndex: 2 },
    limitedTimeOffer: { text: 'Oferta', copyCode: 'CUPON', expirationTime: now },
  })

  assert.equal(params.custom, 1)
  assert.equal(params.bottom_sheet.list_title, 'Menú')
  assert.deepEqual(params.bottom_sheet.divider_indices, [1, 2, 3, 4, 5, 999])
  assert.equal(params.tap_target_configuration.canonical_url, 'https://sora.dev')
  assert.equal(params.tap_target_configuration.button_index, 2)
  assert.equal(params.limited_time_offer.expiration_time, now)
})

test('interactiveNodes distingue chats privados y grupos', () => {
  const content = { interactiveMessage: { nativeFlowMessage: { buttons: [{ name: 'quick_reply' }] } } }
  const privateNodes = interactiveNodes('1@s.whatsapp.net', content, { upstream: fakeUpstream })
  const groupNodes = interactiveNodes('1@g.us', content, { upstream: fakeUpstream })

  assert.deepEqual(privateNodes.map((node) => node.tag), ['biz', 'bot'])
  assert.deepEqual(groupNodes.map((node) => node.tag), ['biz'])
  assert.deepEqual(privateNodes[0].content[0].content[0].attrs, { v: '9', name: 'mixed' })
})

test('getInteractiveReply lee respuestas nativas, clásicas y wrappers', () => {
  assert.equal(getInteractiveReply({
    message: {
      interactiveResponseMessage: {
        nativeFlowResponseMessage: { paramsJson: '{"button_id":"flow-1"}' },
      },
    },
  }), 'flow-1')
  assert.equal(getInteractiveReply({
    message: { buttonsResponseMessage: { selectedButtonId: 'yes' } },
  }), 'yes')
  assert.equal(getInteractiveReply({
    message: { listResponseMessage: { singleSelectReply: { selectedRowId: 'row-2' } } },
  }), 'row-2')
  assert.equal(getInteractiveReply({
    message: {
      viewOnceMessageV2: {
        message: { templateButtonReplyMessage: { selectedId: 'template-1' } },
      },
    },
  }), 'template-1')
  assert.equal(getInteractiveReply({ message: {} }), null)
})

test('sendButtons usa relayMessage con nodos biz/bot e id estable', async () => {
  const { socket, relayed } = fakeSocket()
  const result = await interactive.sendButtons(socket, '1@s.whatsapp.net', {
    text: '¿Continuar?',
    buttons: [{ text: 'Sí', id: 'yes' }, { text: 'No', id: 'no' }],
    footer: 'Sora',
  }, { messageId: 'local-42' }, { upstream: fakeUpstream })

  assert.equal(result.key.id, 'local-42')
  assert.equal(relayed.length, 1)
  assert.equal(relayed[0].options.messageId, 'local-42')
  assert.equal(relayed[0].message.interactiveMessage.body.text, '¿Continuar?')
  assert.equal(relayed[0].message.interactiveMessage.nativeFlowMessage.buttons.length, 2)
  assert.deepEqual(relayed[0].options.additionalNodes.map((node) => node.tag), ['biz', 'bot'])
})

test('sendCarousel prepara cabeceras multimedia y limita a 10 tarjetas', async () => {
  const { socket, relayed } = fakeSocket()
  const cards = Array.from({ length: 12 }, (_, index) => ({
    title: `Tarjeta ${index}`,
    body: `Cuerpo ${index}`,
    image: `https://cdn.test/${index}.jpg`,
    buttons: [{ text: `Abrir ${index}`, id: `open-${index}` }],
  }))

  await interactive.sendCarousel(socket, '1@s.whatsapp.net', { text: 'Menú', cards }, {}, { upstream: fakeUpstream })

  const sentCards = relayed[0].message.interactiveMessage.carouselMessage.cards
  assert.equal(sentCards.length, 10)
  assert.equal(sentCards[0].header.hasMediaAttachment, true)
  assert.deepEqual(sentCards[0].header.imageMessage, { url: 'https://cdn.test/media' })
  assert.equal(sentCards[0].nativeFlowMessage.messageVersion, 1)
})

test('sendButtons cae a texto cuando el socket no puede relajar', async () => {
  const { socket, sent } = fakeSocket({ relayMessage: undefined })
  const result = await interactive.sendButtons(socket, '1@s.whatsapp.net', {
    text: 'Menú',
    buttons: [{ text: 'Sí', id: 'yes' }],
  }, {}, { upstream: fakeUpstream })

  assert.equal(result, null)
  assert.equal(sent.length, 1)
  assert.match(sent[0].content.text, /Menú/)
  assert.match(sent[0].content.text, /Sí/)
})
