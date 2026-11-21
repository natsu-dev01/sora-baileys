import { BaileysClient, MockAdapter } from '../dist/index.js'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Transporte falso: demuestra reconexión, cola y eventos sin WhatsApp.
const adapter = new MockAdapter({
  connectDelayMs: 40,
  dropAfterMs: 1500,
  dropReason: 'network',
})

const client = new BaileysClient({
  adapter,
  sessionDir: 'demo-fresh',
  backoff: { baseMs: 250, maxMs: 1500, jitter: 0.2 },
  restartDelayMs: 100,
})

client.on('state', ({ previous, current }) => {
  console.log(`estado: ${previous} -> ${current}`)
})
client.on('qr', ({ raw }) => console.log('QR simulado:', raw))
client.on('connected', () => console.log('conectado ✅'))
client.on('disconnected', ({ reason, willReconnect }) => {
  console.log(`desconectado (${reason}), reconectar=${willReconnect}`)
})
client.on('message', (message) => console.log('mensaje:', message.text))
client.on('sent', ({ id }) => console.log('enviado:', id))
client.on('flushed', ({ sent }) => console.log('cola vaciada, enviados:', sent))

const connected = client.waitForEvent('connected')
await client.start()
await connected

await client.sendText('1111@s.whatsapp.net', 'primer mensaje')
adapter.pushMessage({ text: 'hola bot' })

// Este mensaje se encola durante la caída automática y se envía al reconectar.
await delay(1700)
await client.sendText('2222@s.whatsapp.net', 'mensaje en cola')
await delay(1200)

console.log('status final:', client.status)
await client.stop()
