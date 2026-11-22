import test from 'node:test'
import assert from 'node:assert/strict'
import { silenceDecryptLogs, getSuppressedDecryptErrorCount } from '../dist/index.js'

test('silencia solo el ruido de descifrado de libsignal', () => {
  const original = console.error
  const seen = []
  console.error = (...args) => seen.push(args)
  try {
    const before = getSuppressedDecryptErrorCount()
    const release = silenceDecryptLogs()

    console.error('Failed to decrypt message with any known session...')
    console.error('Session error:Error: Bad MAC Error: Bad MAC', 'at Object.verifyMAC (...)')
    console.error('Session error:Error: No matching sessions found for message')
    console.error('este error sí debe verse')

    assert.deepEqual(seen, [['este error sí debe verse']])
    assert.equal(getSuppressedDecryptErrorCount(), before + 3)

    release()
    console.error('después de liberar')
    assert.deepEqual(seen, [
      ['este error sí debe verse'],
      ['después de liberar'],
    ])
  } finally {
    console.error = original
  }
})

test('el filtro sigue activo hasta liberar todas las conexiones', () => {
  const original = console.error
  const seen = []
  console.error = (...args) => seen.push(args)
  try {
    const first = silenceDecryptLogs()
    const second = silenceDecryptLogs()

    first()
    console.error('Failed to decrypt message with any known session...')
    assert.deepEqual(seen, [])

    second()
    console.error('Failed to decrypt message with any known session...')
    assert.deepEqual(seen, [['Failed to decrypt message with any known session...']])
  } finally {
    console.error = original
  }
})
