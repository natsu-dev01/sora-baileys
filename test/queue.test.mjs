import test from 'node:test'
import assert from 'node:assert/strict'
import { RetryQueue } from '../dist/index.js'

test('flush envía en orden y vacía la cola', async () => {
  const sent = []
  const queue = new RetryQueue({
    onSend: async (payload) => { sent.push(payload.text) },
  })

  queue.enqueue({ to: 'a', text: 'uno' }, '1')
  queue.enqueue({ to: 'b', text: 'dos' }, '2')
  queue.enqueue({ to: 'c', text: 'tres' }, '3')

  const result = await queue.flush()
  assert.deepEqual(sent, ['uno', 'dos', 'tres'])
  assert.deepEqual(result, { sent: 3, failed: 0, dropped: 0 })
  assert.equal(queue.size, 0)
})

test('los fallos se reintentan y se descartan al agotar intentos', async () => {
  let attempts = 0
  const queue = new RetryQueue({
    maxAttempts: 3,
    onSend: async () => {
      attempts += 1
      if (attempts < 3) throw new Error('temporal')
    },
  })

  queue.enqueue({ to: 'a', text: 'hola' }, 'retry')
  assert.deepEqual(await queue.flush(), { sent: 0, failed: 1, dropped: 0 })
  assert.deepEqual(await queue.flush(), { sent: 0, failed: 1, dropped: 0 })
  assert.deepEqual(await queue.flush(), { sent: 1, failed: 0, dropped: 0 })
  assert.equal(queue.size, 0)
})

test('un id repetido no duplica el mensaje', () => {
  const queue = new RetryQueue({ onSend: async () => {} })
  queue.enqueue({ to: 'a', text: 'viejo' }, 'mismo')
  queue.enqueue({ to: 'a', text: 'nuevo' }, 'mismo')
  assert.equal(queue.size, 1)
  assert.equal(queue.peek()[0].payload.text, 'nuevo')
})

test('los mensajes expirados se descartan sin enviarse', async () => {
  let now = 1000
  let sent = 0
  const queue = new RetryQueue({
    ttlMs: 100,
    now: () => now,
    onSend: async () => { sent += 1 },
  })

  queue.enqueue({ to: 'a', text: 'hola' }, 'ttl')
  now = 1101
  const result = await queue.flush()

  assert.deepEqual(result, { sent: 0, failed: 0, dropped: 1 })
  assert.equal(sent, 0)
})
