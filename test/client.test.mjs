import test from 'node:test'
import assert from 'node:assert/strict'
import { BaileysClient, MockAdapter, createMessageStore, toMillis } from '../dist/index.js'
import { normalizeMessage } from '../dist/adapters/baileys-adapter.js'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const fastOptions = {
  backoff: { baseMs: 5, maxMs: 20, jitter: 0 },
  restartDelayMs: 5,
  heartbeatEveryMs: 1000,
  staleAfterMs: 5000,
  sending: {
    maxConcurrent: 1,
    messagesPerMinute: 0,
    perRecipientCooldownMs: 0,
    jitterMs: 0,
    sendTimeoutMs: 0,
  },
}

test('arranca, emite QR, conecta, recibe y envía mensajes', async () => {
  const adapter = new MockAdapter({ connectDelayMs: 5 })
  const client = new BaileysClient({
    ...fastOptions,
    adapter,
    sessionDir: 'fresh-qr-test',
  })

  const qrPromise = client.waitForEvent('qr')
  const connectedPromise = client.waitForEvent('connected')
  await client.start()

  const qr = await qrPromise
  assert.match(qr.raw, /mock-qr/)
  await connectedPromise
  assert.equal(client.status.state, 'connected')

  const messagePromise = client.waitForEvent('message')
  adapter.pushMessage({ text: 'ping' })
  const message = await messagePromise
  assert.equal(message.text, 'ping')

  const result = await client.sendText('1234@s.whatsapp.net', 'hola')
  assert.equal(result.queued, false)
  assert.equal(client.status.stats.messagesSent, 1)

  await client.stop()
  assert.equal(client.status.state, 'stopped')
})

test('reconecta tras caída de red y vacía la cola', async () => {
  const adapter = new MockAdapter({ connectDelayMs: 5, qrOnFresh: false })
  adapter.markLinked()
  const client = new BaileysClient({
    ...fastOptions,
    adapter,
    sessionDir: 'linked-reconnect-test',
  })

  const firstConnected = client.waitForEvent('connected')
  await client.start()
  await firstConnected

  const disconnected = client.waitForEvent('disconnected', 2000, (p) => p.reason === 'network')
  const flushed = client.waitForEvent('flushed', 3000)
  const secondConnected = client.waitForEvent('connected', 3000)

  adapter.drop('network')
  assert.equal((await disconnected).willReconnect, true)

  const queued = await client.sendText('5678@s.whatsapp.net', 'mensaje en cola')
  assert.equal(queued.queued, true)
  assert.equal(client.status.queueSize, 1)

  await secondConnected
  const result = await flushed
  assert.equal(result.sent, 1)
  assert.equal(client.status.queueSize, 0)

  await client.stop()
})

test('logout detiene el cliente sin reconectar', async () => {
  const adapter = new MockAdapter({ connectDelayMs: 5, qrOnFresh: false })
  adapter.markLinked()
  const client = new BaileysClient({
    ...fastOptions,
    adapter,
    sessionDir: 'linked-logout-test',
  })

  const connected = client.waitForEvent('connected')
  await client.start()
  await connected

  let logoutEvents = 0
  client.on('disconnected', (payload) => {
    if (payload.reason === 'loggedOut') logoutEvents += 1
  })

  adapter.drop('loggedOut')
  await client.waitForState('stopped', 2000)
  await delay(50)

  assert.equal(logoutEvents, 1)
  assert.equal(client.status.state, 'stopped')
})

test('un restartRequested reconecta con un socket nuevo', async () => {
  const adapter = new MockAdapter({ connectDelayMs: 5, qrOnFresh: false })
  adapter.markLinked()
  const client = new BaileysClient({
    ...fastOptions,
    adapter,
    sessionDir: 'linked-restart-test',
  })

  const firstConnected = client.waitForEvent('connected')
  await client.start()
  await firstConnected

  const secondConnected = client.waitForEvent('connected', 2000)
  adapter.requestRestart()
  await secondConnected

  assert.equal(client.status.state, 'connected')
  assert.equal(client.status.stats.reconnects, 1)
  await client.stop()
})

test('envía botones de respuesta rápida y emite el button reply', async () => {
  const adapter = new MockAdapter({ connectDelayMs: 5, qrOnFresh: false })
  adapter.markLinked()
  const client = new BaileysClient({
    ...fastOptions,
    adapter,
    sessionDir: 'linked-buttons-test',
  })

  const connected = client.waitForEvent('connected')
  await client.start()
  await connected

  const sent = client.waitForEvent('sent', 2000, (p) => p.kind === 'buttons')
  const result = await client.sendButtons('1234@s.whatsapp.net', '¿Continuar?', [
    { id: 'yes', label: 'Sí' },
    { id: 'no', label: 'No' },
  ], { header: 'Confirmación', footer: 'Sora' })

  assert.equal(result.queued, false)
  await sent
  assert.deepEqual(adapter.sentButtons[0], {
    to: '1234@s.whatsapp.net',
    text: '¿Continuar?',
    buttons: [
      { id: 'yes', label: 'Sí' },
      { id: 'no', label: 'No' },
    ],
  })

  const buttonReply = client.waitForEvent('button')
  adapter.pushButton({ buttonId: 'yes', buttonText: 'Sí' })
  assert.equal((await buttonReply).buttonId, 'yes')

  await assert.rejects(
    () => client.sendButtons('1234@s.whatsapp.net', 'test', []),
    /al menos un botón/,
  )
  await assert.rejects(
    () => client.sendButtons('1234@s.whatsapp.net', 'test', Array.from({ length: 4 }, (_, i) => ({ id: `${i}`, label: `${i}` }))),
    /máximo 3 botones/,
  )

  await client.stop()
})

test('envía botones interactivos y tarjetas en carrusel', async () => {
  const adapter = new MockAdapter({ connectDelayMs: 5, qrOnFresh: false })
  adapter.markLinked()
  const client = new BaileysClient({
    ...fastOptions,
    adapter,
    sessionDir: 'linked-carousel-test',
  })

  const connected = client.waitForEvent('connected')
  await client.start()
  await connected

  const interactiveSent = client.waitForEvent('sent', 2000, (p) => p.kind === 'interactive')
  const interactive = await client.sendInteractive('1234@s.whatsapp.net', '¿Qué haces?', [
    { label: 'Web', url: 'https://sora.dev' },
    { label: 'Llamar', phoneNumber: '5215512345678' },
    { label: 'Sí', id: 'yes' },
  ])
  assert.equal(interactive.queued, false)
  await interactiveSent
  assert.deepEqual(adapter.sentInteractive[0].buttons, [
    { label: 'Web', url: 'https://sora.dev' },
    { label: 'Llamar', phoneNumber: '5215512345678' },
    { label: 'Sí', id: 'yes' },
  ])

  const carouselSent = client.waitForEvent('sent', 2000, (p) => p.kind === 'carousel')
  const carousel = await client.sendCarousel('1234@s.whatsapp.net', [
    { title: 'Uno', text: 'Primera tarjeta', buttons: [{ id: 'a', label: 'A' }] },
    { title: 'Dos', text: 'Segunda tarjeta', footer: 'Fin' },
  ], { header: 'Menú' })
  assert.equal(carousel.queued, false)
  await carouselSent
  assert.equal(adapter.sentCarousels[0].cards.length, 2)
  assert.deepEqual(adapter.sentCarousels[0].cards[0].buttons, [{ id: 'a', label: 'A' }])

  const buttonReply = client.waitForEvent('button')
  adapter.pushInteractiveReply({ id: 'yes', displayText: 'Sí' })
  assert.equal((await buttonReply).buttonId, 'yes')

  await assert.rejects(
    () => client.sendInteractive('1234@s.whatsapp.net', 'x', []),
    /al menos un botón/,
  )
  await assert.rejects(
    () => client.sendCarousel('1234@s.whatsapp.net', []),
    /al menos una tarjeta/,
  )

  await client.stop()
})

test('el heartbeat fuerza reconexión cuando el socket está unhealthy', async () => {
  const adapter = new MockAdapter({ connectDelayMs: 5, qrOnFresh: false, unhealthy: true })
  adapter.markLinked()
  const client = new BaileysClient({
    ...fastOptions,
    adapter,
    sessionDir: 'linked-stale-test',
  })

  const connected = client.waitForEvent('connected')
  const stale = client.waitForEvent('disconnected', 2500, (p) => p.reason === 'stale')

  await client.start()
  await connected
  await stale

  assert.equal(client.status.state, 'reconnecting')
  await client.stop()
})

test('pide reenvío de placeholders y no los emite como mensajes normales', async () => {
  const adapter = new MockAdapter({ connectDelayMs: 5, qrOnFresh: false })
  adapter.markLinked()
  const client = new BaileysClient({
    ...fastOptions,
    adapter,
    sessionDir: 'linked-placeholder-test',
  })

  const connected = client.waitForEvent('connected')
  await client.start()
  await connected

  let normalMessages = 0
  client.on('message', () => { normalMessages += 1 })
  const unavailable = client.waitForEvent('messageUnavailable', 2000)

  adapter.pushUnavailableMessage({ id: 'placeholder-1' })
  const event = await unavailable
  assert.equal(event.id, 'placeholder-1')
  assert.equal(event.unavailable, true)
  assert.equal(event.unavailableReason, 'Message absent from node')

  await delay(20)
  assert.equal(normalMessages, 0)
  assert.equal(adapter.resendRequests.length, 1)
  assert.equal(adapter.resendRequests[0].key.id, 'placeholder-1')
  assert.equal(adapter.resendRequests[0].key.remoteJid, '1234567890@s.whatsapp.net')

  // El contenido real llega después del reenvío y sí se entrega al bot.
  const real = client.waitForEvent('message', 2000, (m) => m.id === 'placeholder-1')
  adapter.pushMessage({ id: 'placeholder-1', text: 'ya descifrado' })
  assert.equal((await real).text, 'ya descifrado')
  assert.equal(normalMessages, 1)

  await client.stop()
})

test('expone el store de mensajes y reenvía la configuración de reintentos', async () => {
  class CapturingAdapter extends MockAdapter {
    constructor() {
      super({ connectDelayMs: 5, qrOnFresh: false })
      this.lastConnect = undefined
    }
    async connect(options) {
      this.lastConnect = options
      return super.connect(options)
    }
  }

  const adapter = new CapturingAdapter()
  adapter.markLinked()
  const messageStore = createMessageStore()
  const client = new BaileysClient({
    ...fastOptions,
    adapter,
    sessionDir: 'linked-retry-options-test',
    retry: {
      messageStore,
      maxMsgRetryCount: 9,
      retryRequestDelayMs: 40,
      enableAutoSessionRecreation: false,
    },
  })

  const connected = client.waitForEvent('connected')
  await client.start()
  await connected

  assert.equal(client.storedMessages, messageStore)
  assert.equal(adapter.lastConnect.messageStore, messageStore)
  assert.equal(adapter.lastConnect.retry.maxMsgRetryCount, 9)
  assert.equal(adapter.lastConnect.retry.retryRequestDelayMs, 40)
  assert.equal(adapter.lastConnect.retry.enableAutoSessionRecreation, false)

  await client.stop()
})

test('el store recuerda mensajes para reintentos y respeta límites', () => {
  const store = createMessageStore({ maxMessages: 2 })
  store.remember({ id: 'a', remoteJid: '1@s.whatsapp.net' }, { text: 'A' })
  store.remember({ id: 'b', remoteJid: '1@s.whatsapp.net' }, { text: 'B' })
  store.remember({ id: 'c', remoteJid: '1@s.whatsapp.net' }, { text: 'C' })

  assert.equal(store.size, 2)
  assert.equal(store.get({ id: 'a' }), undefined)
  assert.deepEqual(store.get({ id: 'c' }), { text: 'C' })
  assert.equal(store.get({ id: 'c', remoteJid: 'otro@s.whatsapp.net' }), undefined)

  store.forget('c')
  assert.equal(store.get({ id: 'c' }), undefined)
  store.clear()
  assert.equal(store.size, 0)
})

test('normaliza messageTimestamp de segundos a milisegundos', () => {
  const nowMs = Date.now()
  const seconds = Math.floor(nowMs / 1000)

  assert.equal(toMillis(seconds), seconds * 1000)
  assert.equal(toMillis(nowMs), nowMs)
  assert.equal(toMillis({ toString: () => String(seconds) }), seconds * 1000)
  assert.equal(toMillis(0, 123), 123)
  assert.equal(toMillis('nope', 123), 123)

  const normalized = normalizeMessage({
    key: { id: 'ts-1', remoteJid: '1234@s.whatsapp.net' },
    message: { conversation: 'ping' },
    messageTimestamp: seconds,
  })
  assert.equal(normalized.timestamp, seconds * 1000)
  assert.ok(normalized.timestamp > 1e12)
})

test('un messageTimestamp en segundos no dispara stale en el heartbeat', async () => {
  const adapter = new MockAdapter({ connectDelayMs: 5, qrOnFresh: false })
  adapter.markLinked()
  const client = new BaileysClient({
    ...fastOptions,
    adapter,
    heartbeatEveryMs: 1000,
    staleAfterMs: 2000,
    sessionDir: 'seconds-timestamp-stale-test',
  })

  const connected = client.waitForEvent('connected')
  await client.start()
  await connected

  adapter.pushMessage({
    text: 'ping',
    timestamp: Math.floor(Date.now() / 1000),
  })

  await delay(1150)

  assert.equal(client.status.state, 'connected')
  assert.equal(client.status.stats.reconnects, 0)
  await client.stop()
})

test('aplica dailyLimit, ids estables y presencia de escritura', async () => {
  const adapter = new MockAdapter({ connectDelayMs: 5, qrOnFresh: false })
  adapter.markLinked()
  const client = new BaileysClient({
    ...fastOptions,
    adapter,
    sessionDir: 'linked-sending-policy-test',
    sending: {
      ...fastOptions.sending,
      dailyLimit: 2,
      typing: true,
      typingMs: 100,
    },
  })

  const connected = client.waitForEvent('connected')
  await client.start()
  await connected

  await client.sendText('1@s.whatsapp.net', 'uno')
  await client.sendText('2@s.whatsapp.net', 'dos')
  const limit = client.waitForEvent('limitReached', 2000)
  await assert.rejects(
    () => client.sendText('3@s.whatsapp.net', 'tres'),
    /daily message limit/,
  )
  await limit

  assert.equal(adapter.sentMetadata.length, 2)
  assert.match(adapter.sentMetadata[0].id, /^local-/)
  assert.notEqual(adapter.sentMetadata[0].id, adapter.sentMetadata[1].id)
  assert.deepEqual(adapter.presences.map((p) => p.presence), [
    'composing', 'paused', 'composing', 'paused',
  ])

  await client.stop()
})
