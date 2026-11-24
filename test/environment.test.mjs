import test from 'node:test'
import assert from 'node:assert/strict'
import {
  detectEnvironment,
  describeEnvironment,
  resolveEnvironmentTuning,
} from '../dist/index.js'

test('detecta Termux y usa el perfil lite', () => {
  const profile = detectEnvironment({ TERMUX_VERSION: '0.118.0' })
  assert.equal(profile.isTermux, true)
  assert.equal(profile.name, 'lite')

  const tuning = resolveEnvironmentTuning(profile.name)
  assert.equal(tuning.maxRememberedMessages, 200)
  assert.equal(tuning.queue.maxSize, 300)
  assert.equal(tuning.sending.maxConcurrent, 1)
  assert.equal(tuning.heartbeatEveryMs, 60_000)
  assert.match(describeEnvironment(profile), /termux/)
})

test('detecta container/VPS y respeta SORA_LOW_MEMORY', () => {
  const vps = detectEnvironment({ container: 'docker' })
  assert.equal(vps.isContainer, true)
  assert.equal(vps.name, 'vps')
  assert.equal(resolveEnvironmentTuning(vps.name).sending.maxConcurrent, 2)

  const forcedLite = detectEnvironment({ container: 'docker', SORA_LOW_MEMORY: '1' })
  assert.equal(forcedLite.name, 'lite')
  assert.equal(forcedLite.lowMemory, true)
})

test('SORA_PROFILE manda sobre la detección automática', () => {
  const profile = detectEnvironment({
    TERMUX_VERSION: '0.118.0',
    SORA_LOW_MEMORY: '1',
    SORA_PROFILE: 'full',
  })
  assert.equal(profile.name, 'full')
  assert.equal(resolveEnvironmentTuning(profile.name).queue.maxSize, 1000)
})
