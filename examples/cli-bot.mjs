import { BaileysClient, MockAdapter, choose, promptText } from '../dist/index.js'

const print = (line = '') => console.log(line)

print('=== @sora/baileys · consola interactiva ===')

let method
try {
  method = await choose({
    title: '¿Cómo quieres conectar?',
    choices: [
      { value: 'qr', label: 'QR', hint: 'escanear con el móvil' },
      { value: 'pair', label: 'Pairing code', hint: 'código de 8 dígitos' },
      { value: 'mock', label: 'Modo demo', hint: 'sin WhatsApp, reconexión simulada' },
    ],
  })
} catch {
  print('Selección cancelada.')
  process.exit(0)
}

let phoneNumber
if (method === 'pair') {
  phoneNumber = await promptText('Número con código de país (sin + ni guiones)')
}

const adapter = method === 'mock'
  ? new MockAdapter({ connectDelayMs: 50, dropAfterMs: 8000, dropReason: 'network' })
  : undefined

const client = new BaileysClient({
  adapter,
  sessionDir: method === 'mock' ? 'demo-fresh' : './sessions/cli-bot',
  appName: 'Sora CLI',
  phoneNumber,
  printQR: false,
  backoff: { baseMs: 1000, maxMs: 30_000, jitter: 0.3 },
  socketOptions: method === 'qr' ? { printQRInTerminal: true } : {},
})

client.on('qr', ({ raw }) => print(`QR recibido: ${raw}`))
client.on('pairingCode', ({ code }) => print(`Código de vinculación: ${code}`))
client.on('state', ({ previous, current }) => print(`estado: ${previous} → ${current}`))
client.on('connected', () => print('✅ conectado'))
client.on('disconnected', ({ reason, willReconnect }) => {
  print(`🔌 desconectado (${reason}) · reconectar=${willReconnect}`)
})
client.on('message', (msg) => print(`📩 ${msg.from}: ${msg.text || '[botón]'}`))
client.on('button', (reply) => print(`🔘 ${reply.from} pulsó: ${reply.buttonId}`))
client.on('sent', ({ id, kind }) => print(`📤 enviado ${kind}: ${id}`))
client.on('error', ({ where, error }) => console.error(`error en ${where}:`, error))

await client.start()
print('Cliente iniciado. Usa el menú para enviar mensajes.')

for (;;) {
  let action
  try {
    action = await choose({
      title: `\nEstado: ${client.status.state} · cola: ${client.status.queueSize} · reconnects: ${client.status.stats.reconnects}`,
      choices: [
        { value: 'status', label: 'Ver estado', hint: 'stats completas' },
        { value: 'send', label: 'Enviar mensaje', hint: 'texto simple' },
        { value: 'buttons', label: 'Enviar botones', hint: 'hasta 3 opciones' },
        { value: 'restart', label: 'Reconectar', hint: 'reinicia el socket' },
        { value: 'exit', label: 'Salir', hint: 'detiene el cliente' },
      ],
    })
  } catch {
    action = 'exit'
  }

  try {
    if (action === 'status') {
      print(JSON.stringify(client.status, null, 2))
    } else if (action === 'send') {
      const to = await promptText('Para (JID o número)')
      const text = await promptText('Mensaje')
      const result = await client.sendText(to, text)
      print(result.queued ? `Encolado: ${result.id}` : `Enviado: ${result.id}`)
    } else if (action === 'buttons') {
      const to = await promptText('Para (JID o número)')
      const text = await promptText('Pregunta')
      const label = await promptText('Texto del botón 1')
      const id = await promptText('Id del botón 1', 'opcion_1')
      const result = await client.sendButtons(to, text, [{ id, label }], {
        header: 'Sora',
        footer: 'Elige una opción',
      })
      print(result.queued ? `Botones encolados: ${result.id}` : `Botones enviados: ${result.id}`)
    } else if (action === 'restart') {
      await client.restart()
      print('Socket reiniciado.')
    } else {
      await client.stop()
      print('Hasta luego.')
      break
    }
  } catch (error) {
    console.error('Acción fallida:', error)
  }
}
