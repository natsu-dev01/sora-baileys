import test from 'node:test'
import assert from 'node:assert/strict'
import { choose, promptText } from '../dist/index.js'

test('el menú expone API y valida opciones vacías', async () => {
  assert.equal(typeof choose, 'function')
  assert.equal(typeof promptText, 'function')
  await assert.rejects(() => choose({ choices: [] }), /al menos una opción/)
})
