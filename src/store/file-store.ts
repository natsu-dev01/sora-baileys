import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { LoggerLike } from '../types.js'

/**
 * Almacén JSON con escritura atómica (temp + rename) y recuperación ante
 * archivos corruptos: los renombra a `.corrupt-<timestamp>` en vez de borrarlos.
 */
export class JsonFileStore<T extends object> {
  private writeChain: Promise<void> = Promise.resolve()

  constructor(
    readonly filePath: string,
    private readonly logger?: LoggerLike,
  ) {}

  async read(): Promise<T | null> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
    try {
      return JSON.parse(raw) as T
    } catch (error) {
      const backup = `${this.filePath}.corrupt-${Date.now()}`
      this.logger?.warn('corrupt state detected, moving aside', { filePath: this.filePath, backup })
      await rename(this.filePath, backup).catch(() => undefined)
      return null
    }
  }

  async readOr(defaultValue: T): Promise<T> {
    return (await this.read()) ?? defaultValue
  }

  async write(data: T): Promise<void> {
    const operation = this.writeChain.then(() => this.writeNow(data))
    this.writeChain = operation.catch(() => undefined)
    return operation
  }

  async update(mutator: (current: T | null) => T | Promise<T>): Promise<T> {
    const current = await this.read()
    const next = await mutator(current)
    await this.write(next)
    return next
  }

  private async writeNow(data: T): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    const temp = `${this.filePath}.${process.pid}.${Date.now().toString(36)}.tmp`
    const serialized = JSON.stringify(data, null, 2)
    await writeFile(temp, serialized, { encoding: 'utf8', mode: 0o600 })

    try {
      await rename(temp, this.filePath)
    } catch (error) {
      // En Windows rename() puede fallar si el destino existe y está abierto.
      if (isExistsError(error)) {
        await rm(this.filePath, { force: true })
        await rename(temp, this.filePath)
      } else {
        await rm(temp, { force: true }).catch(() => undefined)
        throw error
      }
    }
  }
}

/** Agrupa varias escrituras en una sola transacción diferida. */
export class DebouncedWriter<T extends object> {
  private timer: NodeJS.Timeout | undefined
  private pending: T | undefined

  constructor(
    private readonly store: JsonFileStore<T>,
    private readonly delayMs = 250,
  ) {}

  schedule(data: T): void {
    this.pending = data
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, this.delayMs)
    this.timer.unref?.()
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (!this.pending) return
    const data = this.pending
    this.pending = undefined
    await this.store.write(data)
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

function isNotFound(error: unknown): boolean {
  return isErrno(error, 'ENOENT')
}

function isExistsError(error: unknown): boolean {
  return isErrno(error, 'EEXIST') || isErrno(error, 'EPERM') || isErrno(error, 'EACCES')
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
