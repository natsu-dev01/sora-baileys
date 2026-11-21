import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DebouncedWriter, JsonFileStore, fileExists } from '../dist/index.js'

const tempRoot = await mkdtemp(join(tmpdir(), 'sora-store-'))

test('JsonFileStore escribe y lee JSON de forma atómica', async () => {
  const file = join(tempRoot, 'state.json')
  const store = new JsonFileStore(file)

  assert.equal(await store.read(), null)
  await store.write({ connected: true, attempt: 3 })
  assert.deepEqual(await store.read(), { connected: true, attempt: 3 })
  assert.equal(await fileExists(file), true)
})

test('JsonFileStore aparta archivos corruptos en vez de sobrescribirlos', async () => {
  const file = join(tempRoot, 'corrupt.json')
  await writeFile(file, '{ this is not json', 'utf8')
  const store = new JsonFileStore(file)

  assert.equal(await store.read(), null)
  assert.equal(await fileExists(file), false)
  const entries = await (await import('node:fs/promises')).readdir(tempRoot)
  assert.ok(entries.some((entry) => entry.startsWith('corrupt.json.corrupt-')))
})

test('DebouncedWriter agrupa varias escrituras en una', async () => {
  const file = join(tempRoot, 'debounced.json')
  const store = new JsonFileStore(file)
  const writer = new DebouncedWriter(store, 15)

  writer.schedule({ value: 1 })
  writer.schedule({ value: 2 })
  writer.schedule({ value: 3 })
  await writer.flush()

  const raw = await readFile(file, 'utf8')
  assert.deepEqual(JSON.parse(raw), { value: 3 })
})
