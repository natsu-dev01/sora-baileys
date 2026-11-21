import { BaileysClient } from '../dist/index.js'

/**
 * Bot real. Requiere el peer opcional:
 *   npm install @whiskeysockets/baileys
 *
 * Opcional: PHONE_NUMBER=52155... para usar pairing code en vez de QR.
 */
const client = new BaileysClient({
  sessionDir: './sessions/real-bot',
  appName: 'Sora Bot',
  phoneNumber: process.env.PHONE_NUMBER,
  printQR: false,
  backoff: { baseMs: 1000, maxMs: 60_000, jitter: 0.3 },
  socketOptions: {
    // Baileys dibuja el QR en terminal cuando no hay sesión guardada.
    printQRInTerminal: !process.env.PHONE_NUMBER,
    markOnlineOnConnect: false,
  },
})

client.on('qr', ({ raw }) => console.log('QR recibido (valor raw):', raw))
client.on('pairingCode', ({ code }) => console.log('Código de vinculación:', code))
client.on('connected', () => console.log('✅ conectado'))
client.on('disconnected', ({ reason, willReconnect }) => {
  console.log(`🔌 desconectado: ${reason} | reconectar: ${willReconnect}`)
})
client.on('error', ({ where, error }) => console.error(`error en ${where}:`, error))
client.on('button', (reply) => {
  console.log(`🔘 ${reply.from} pulsó ${reply.buttonId} (${reply.buttonText ?? ''})`)
})
client.on('message', async (message) => {
  const text = message.text.trim().toLowerCase()
  console.log(`mensaje de ${message.from}: ${message.text || '[respuesta de botón]'}`)

  if (text === 'ping') {
    await client.sendText(message.from, 'pong 🤖')
  } else if (text === '/botones') {
    await client.sendButtons(
      message.from,
      'Elige una opción',
      [
        { id: 'opcion_1', label: 'Opción 1' },
        { id: 'opcion_2', label: 'Opción 2' },
        { id: 'opcion_3', label: 'Opción 3' },
      ],
      { header: 'Sora Baileys', footer: 'Respuesta rápida' },
    )
  }
})

const shutdown = async () => {
  console.log('deteniendo...')
  await client.stop()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

await client.start()
console.log('bot iniciado; status:', client.status)
