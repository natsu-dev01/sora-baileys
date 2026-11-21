# @sora/baileys

Cliente de WhatsApp Web propio, tipado y **orientado a resiliencia**. No es un copia/pega de Baileys: es una capa nueva con una máquina de estados, backoff con jitter, heartbeat, cola de envío y persistencia atómica. El transporte real se inyecta mediante un adaptador; el incluido usa `@whiskeysockets/baileys` como peer **opcional**.

> Proyecto no oficial. Úsalo responsablemente y respeta los términos de WhatsApp.

## ¿Qué mejora frente al patrón clásico de Baileys?

| Problema común | Solución aquí |
| --- | --- |
| `connection.update` mal gestionado → reconexiones infinitas o ninguna | Máquina de estados con motivos normalizados (`loggedOut`, `banned`, `network`, `restart`, `stale`, `manual`) |
| Reconexiones sin backoff que saturan el servidor | `backoffDelay()` exponencial con jitter simétrico y techo configurable |
| Eventos de un socket viejo mezclados con el nuevo | `generation` invalida eventos tardíos tras cada reconexión |
| Mensajes enviados mientras no hay conexión se pierden | `RetryQueue` con TTL, dedupe por id, límite de intentos y flush al reconectar |
| Sesión corrupta al escribir | `JsonFileStore` escribe con `temp + rename` y aparta archivos corruptos |
| Guardado de credenciales concurrente | Guardado con debounce y cola serializada |
| QR/pairing mezclados en la lógica de negocio | Eventos `qr` y `pairingCode` separados, con opción de imprimir QR |
| Difícil de testear sin WhatsApp | `MockAdapter` incluido: fallos, caídas, mensajes, botones y healthcheck simulados |
| Elegir QR o pairing code a mano | Menú CLI con flechas/atajos en `examples/cli-bot.mjs` y `choose()` reutilizable |
| Botones de WhatsApp mezclados con texto plano | `sendButtons()` + evento `button` con `buttonId` normalizado |
| Placeholder «No se pudo cargar este mensaje» | Store de mensajes salientes + `getMessage` + reenvío automático |

## Instalación

Instálalo directamente desde GitHub:

```bash
npm install github:natsu-dev01/sora-baileys
```

El paquete se instala como `@sora/baileys`, así que los imports no cambian:

```js
import { BaileysClient } from '@sora/baileys'
```

También puedes fijar un commit concreto:

```bash
npm install github:natsu-dev01/sora-baileys#06858d7
```

## Inicio rápido (con transporte real)

```js
import { BaileysClient } from '@sora/baileys'

const client = new BaileysClient({
  sessionDir: './sessions/bot',
  appName: 'Mi Bot',
  // phoneNumber: '5215512345678', // si quieres pairing code en vez de QR
  printQR: false,
  backoff: { baseMs: 1000, maxMs: 60_000, jitter: 0.3 },
  socketOptions: { printQRInTerminal: true },
})

client.on('qr', ({ raw }) => console.log('QR:', raw))
client.on('pairingCode', ({ code }) => console.log('Código:', code))
client.on('connected', () => console.log('conectado'))
client.on('disconnected', ({ reason, willReconnect }) => {
  console.log(`desconectado: ${reason} → reconectar: ${willReconnect}`)
})
client.on('message', async (msg) => {
  if (msg.text.toLowerCase() === 'ping') {
    await client.sendText(msg.from, 'pong')
  }
})

await client.start()
```

`start()` inicia el ciclo y resuelve cuando arranca el primer intento. Para esperar a la conexión:

```js
await client.start()
await client.waitForState('connected', 30_000)
```

## Inicio rápido (sin WhatsApp)

```js
import { BaileysClient, MockAdapter } from '@sora/baileys'

const adapter = new MockAdapter({ connectDelayMs: 10, dropAfterMs: 1000 })
const client = new BaileysClient({ adapter, sessionDir: 'demo-fresh' })

client.on('qr', ({ raw }) => console.log(raw))
client.on('disconnected', (p) => console.log('caída:', p.reason))
await client.start()
await client.waitForEvent('connected')

await client.sendText('123@s.whatsapp.net', 'hola')
adapter.drop('network') // provoca reconexión con backoff
```

## Botones de WhatsApp

```js
await client.sendButtons(
  msg.from,
  'Elige una opción',
  [
    { id: 'opcion_1', label: 'Opción 1' },
    { id: 'opcion_2', label: 'Opción 2' },
    { id: 'opcion_3', label: 'Opción 3' },
  ],
  { header: 'Sora', footer: 'Respuesta rápida' },
)

client.on('button', (reply) => {
  console.log(reply.buttonId, reply.buttonText, reply.from)
})
```

- WhatsApp permite **máximo 3** botones y textos de hasta 20 caracteres; el cliente valida ambos.
- Los mensajes con botones usan la misma cola que el texto: si se envían durante una caída, se reintentan al reconectar.
- El adaptador de Baileys envía `buttonsMessage` con botones de tipo `RESPONSE`.
- El evento `button` se emite además de `message`, para que no tengas que inspeccionar el raw.

## API principal

### `new BaileysClient(options)`

| Opción | Default | Descripción |
| --- | --- | --- |
| `sessionDir` | `./sessions/default` | Carpeta de credenciales del adaptador. |
| `appName` | `Sora Baileys` | Nombre del dispositivo vinculado. |
| `phoneNumber` | — | Si se da, se solicita pairing code. Se normaliza a dígitos. |
| `printQR` | `false` | Imprime el valor raw del QR en consola además de emitir el evento. |
| `backoff` | `{baseMs:1000,maxMs:60000,factor:2,jitter:0.25}` | Política de reintento. |
| `maxReconnectAttempts` | `Infinity` | Intentos consecutivos fallidos antes de detenerse. |
| `heartbeatEveryMs` | `30000` | Frecuencia del chequeo de salud (mínimo 1000). |
| `staleAfterMs` | `120000` | Sin actividad durante este tiempo se fuerza reconexión. |
| `reconnectOnLoggedOut` | `false` | Reconectar incluso tras logout. |
| `reconnectOnBanned` | `false` | Reconectar incluso tras `403`. |
| `restartDelayMs` | `250` | Pausa antes de recrear el socket tras un `restart` interno. |
| `queue` | `{maxSize:1000,ttlMs:300000,maxAttempts:5}` | Cola de mensajes pendientes. |
| `adapter` | `BaileysAdapter` | Transporte inyectable. |
| `logger` | logger console | Implementa `debug/info/warn/error`. |
| `socketOptions` | `{}` | Opciones crudas para el socket del adaptador. |
| `retry` | ver abajo | Reintentos de descifrado y reenvío de mensajes. |

### Métodos

- `start(): Promise<void>` — arranca el ciclo (idempotente).
- `stop(): Promise<void>` — detiene, guarda credenciales y suelta el socket (idempotente).
- `restart(): Promise<void>` — `stop()` + limpieza + `start()`.
- `sendText(to, text, metadata?): Promise<{id, queued}>` — envía o encola.
- `sendButtons(to, text, buttons, options?): Promise<{id, queued}>` — botones de respuesta rápida (máx. 3).
- `requestResend(key, raw?)` — pide al móvil que reenvíe un placeholder; devuelve `true` si se solicitó.
- `storedMessages` — store de mensajes salientes usado por Baileys para responder reenvíos.
- `choose(config)` / `promptText(question)` — menú CLI y entrada de texto, exportados desde el paquete.
- `waitForState(state, timeoutMs?)` / `waitForEvent(event, timeoutMs?, predicate?)`.
- `on/once/off` para los eventos tipados.
- `status` — `{ state, attempt, queueSize, stats }`.

### Eventos

`state`, `connecting`, `connected`, `disconnected`, `qr`, `pairingCode`, `message`, `messageUnavailable`, `button`, `sent`, `queued`, `flushed`, `error`.

## Reintentos de descifrado

El cliente guarda los mensajes salientes y se los pasa a Baileys mediante `getMessage`. Cuando el móvil vinculado no puede descifrar un mensaje, Baileys vuelve a enviarlo en vez de dejar el placeholder «No se pudo cargar este mensaje…».

```js
const client = new BaileysClient({
  retry: {
    retryRequestDelayMs: 250,
    maxMsgRetryCount: 5,
    enableAutoSessionRecreation: true,
    messageTtlMs: 3_600_000,
    maxRememberedMessages: 1000,
  },
})

client.on('messageUnavailable', async (msg) => {
  await client.requestResend({ id: msg.id, remoteJid: msg.from }, msg.raw)
})
```

Los placeholders no se emiten como `message`. El evento `messageUnavailable` ya dispara un reenvío automáticamente; llama a `requestResend()` solo si quieres forzar otro intento.

## Estado de la sesión

- `loggedOut` (401) y `badSession` (500) detienen por defecto: requieren borrar la carpeta de sesión y volver a vincular.
- `forbidden` (403) se trata como `banned` y detiene por defecto.
- `restartRequired` (515) provoca un reinicio controlado del socket sin esperar el backoff completo.
- `network`, `connectionLost`, `timedOut` y `connectionReplaced` reconectan con backoff.

Puedes cambiar este comportamiento con `reconnectOnLoggedOut`, `reconnectOnBanned` y `maxReconnectAttempts`.

## Escribir tu propio adaptador

Implementa `SocketAdapter`:

```ts
interface SocketAdapter {
  name: string
  loadAuth(options: { sessionDir: string; logger?: LoggerLike }): Promise<AuthSession>
  connect(options: ConnectAdapterOptions): Promise<LiveSocket>
}
```

El adaptador debe traducir los eventos de su transporte a `open`, `close`, `qr`, `pairingCode`, `message`, `restartRequested`, `credsUpdated` y `error`. Toda la política de resiliencia queda en el cliente.

## Correcciones incluidas en esta pasada

- Race condición real: si el adaptador emitía `open` antes de devolver el socket, la cola no se vaciaba. Ahora se fuerza un segundo flush al asignar el socket.
- El mock volvía a pedir QR tras cada reconexión; ahora marca la sesión como vinculada después del primer `open`.
- Respuestas de botón de `buttonsResponseMessage` y `templateButtonReplyMessage` se normalizan en `buttonId`/`buttonText`.
- Validación de botones (1-3, id/label obligatorios, 20 caracteres máximos) antes de tocar el transporte.
- `messageTimestamp` de Baileys (segundos o `Long`) se normaliza a ms; el heartbeat ya no cierra el socket con `stale` falso.
- TypeScript actualizado a 7.x y build/tests verificados (23/23).

## Limitaciones

- No reimplementa el protocolo de WhatsApp: el transporte real sigue siendo Baileys. La mejora está en la capa de confiabilidad y diseño.
- No incluye motor de bases de datos: la persistencia de sesión la gestiona el adaptador (por defecto, archivos).
- El QR entregado en el evento `qr` es el valor raw; para dibujarlo en terminal usa `socketOptions.printQRInTerminal` o una librería de QR.

## Licencia

MIT.
