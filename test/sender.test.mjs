import test from 'node:test'
import assert from 'node:assert/strict'
import { SendLimiter, resolveSending } from '../dist/index.js'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('resolveSending sanea valores inválidos', () => {
  const resolved = resolveSending({
    maxConcurrent: 0,
    messagesPerMinute: -5,
    burst: 0,
    perRecipientCooldownMs: -1,
    jitterMs: -1,
    sendTimeoutMs: -1,
    dailyLimit: -2,
    typingMs: 10,
  })

  assert.equal(resolved.maxConcurrent, 1)
  assert.equal(resolved.messagesPerMinute, 0)
  assert.equal(resolved.burst, 1)
  assert.equal(resolved.perRecipientCooldownMs, 0)
  assert.equal(resolved.jitterMs, 0)
  assert.equal(resolved.sendTimeoutMs, 0)
  assert.equal(resolved.dailyLimit, 0)
  assert.equal(resolved.typingMs, 100)
})

test('serializa por destinatario sin frenar a los demás', async () => {
  const limiter = new SendLimiter(resolveSending({
    maxConcurrent: 3,
    messagesPerMinute: 0,
    perRecipientCooldownMs: 60,
    jitterMs: 0,
  }))

  const releaseA = await limiter.acquire('a@s.whatsapp.net')

  const otherStart = Date.now()
  const releaseB = await limiter.acquire('b@s.whatsapp.net')
  assert.ok(Date.now() - otherStart < 40)

  const sameStart = Date.now()
  const pending = limiter.acquire('a@s.whatsapp.net')
  releaseA()
  const releaseA2 = await pending
  assert.ok(Date.now() - sameStart >= 40)

  releaseA2()
  releaseB()
})

test('el token bucket limita la ráfaga global', async () => {
  const limiter = new SendLimiter(resolveSending({
    maxConcurrent: 3,
    messagesPerMinute: 600,
    burst: 1,
    perRecipientCooldownMs: 0,
    jitterMs: 0,
  }))

  const releases = []
  const start = Date.now()
  for (let i = 0; i < 3; i += 1) {
    releases.push(await limiter.acquire(`jid-${i}@s.whatsapp.net`))
  }
  assert.ok(Date.now() - start >= 180)
  assert.equal(limiter.inFlight, 3)
  releases.forEach((release) => release())
  await delay(1)
  assert.equal(limiter.inFlight, 0)
})
