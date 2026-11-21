import test from 'node:test'
import assert from 'node:assert/strict'
import { backoffDelay, resolveBackoff } from '../dist/index.js'

test('backoff crece de forma exponencial y respeta el techo', () => {
  const opts = { baseMs: 1000, maxMs: 10_000, factor: 2, jitter: 0 }
  assert.equal(backoffDelay(1, opts), 1000)
  assert.equal(backoffDelay(2, opts), 2000)
  assert.equal(backoffDelay(3, opts), 4000)
  assert.equal(backoffDelay(10, opts), 10_000)
})

test('el jitter es simétrico y nunca baja de cero', () => {
  const opts = { baseMs: 1000, maxMs: 10_000, factor: 2, jitter: 0.5 }
  assert.equal(backoffDelay(2, opts, () => 1), 3000)
  assert.equal(backoffDelay(2, opts, () => 0), 1000)
  assert.equal(backoffDelay(2, opts, () => 0.5), 2000)
})

test('resolveBackoff sanea valores inválidos', () => {
  assert.deepEqual(resolveBackoff({ baseMs: -5, jitter: 4, factor: 0 }), {
    baseMs: 0,
    maxMs: 60_000,
    factor: 1,
    jitter: 1,
  })
})
