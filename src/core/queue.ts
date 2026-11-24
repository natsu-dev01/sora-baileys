import { environment, resolveEnvironmentTuning } from './environment.js'
import type { LoggerLike, QueueOptions } from '../types.js'

export interface QueueItem<T> {
  id: string
  payload: T
  attempts: number
  createdAt: number
  expiresAt: number
}

export interface FlushResult {
  sent: number
  failed: number
  dropped: number
}

export interface QueueConfig<T = unknown> extends QueueOptions {
  onSend: (payload: T, item: QueueItem<T>) => Promise<void>
  logger?: LoggerLike
  now?: () => number
}

let sequence = 0

function nextId(): string {
  sequence += 1
  return `q-${Date.now().toString(36)}-${sequence.toString(36)}`
}

/**
 * Cola secuencial con TTL, deduplicación por id y límite de intentos.
 * El orden de envío es el de inserción, lo cual importa para mensajes.
 */
export class RetryQueue<T> {
  private readonly items: QueueItem<T>[] = []
  /** Índice por id: la deduplicación y el borrado dejan de ser O(n). */
  private readonly byId = new Map<string, QueueItem<T>>()
  private readonly maxSize: number
  private readonly ttlMs: number
  private readonly maxAttempts: number
  private readonly concurrency: number
  private readonly now: () => number
  private readonly onSend: (payload: T, item: QueueItem<T>) => Promise<void>
  private readonly logger?: LoggerLike
  private flushing = false

  constructor(config: QueueConfig<T>) {
    const tuning = resolveEnvironmentTuning(environment.name).queue
    this.maxSize = Math.max(1, config.maxSize ?? tuning.maxSize ?? 1000)
    this.ttlMs = Math.max(1, config.ttlMs ?? tuning.ttlMs ?? 5 * 60_000)
    this.maxAttempts = Math.max(1, config.maxAttempts ?? tuning.maxAttempts ?? 5)
    this.concurrency = Math.max(1, Math.floor(config.concurrency ?? 1))
    this.now = config.now ?? (() => Date.now())
    this.onSend = config.onSend
    this.logger = config.logger
  }

  get size(): number {
    return this.items.length
  }

  enqueue(payload: T, id?: string): string {
    const key = id ?? nextId()
    const existing = this.byId.get(key)
    if (existing) {
      existing.payload = payload
      existing.expiresAt = this.now() + this.ttlMs
      return key
    }
    if (this.items.length >= this.maxSize) {
      const removed = this.items.shift()
      if (removed) this.byId.delete(removed.id)
      this.logger?.warn('queue full, dropping oldest message', { id: removed?.id })
    }
    const at = this.now()
    const item: QueueItem<T> = {
      id: key,
      payload,
      attempts: 0,
      createdAt: at,
      expiresAt: at + this.ttlMs,
    }
    this.items.push(item)
    this.byId.set(key, item)
    return key
  }

  async flush(): Promise<FlushResult> {
    if (this.flushing) return { sent: 0, failed: 0, dropped: 0 }
    this.flushing = true
    const result: FlushResult = { sent: 0, failed: 0, dropped: 0 }
    try {
      const snapshot = [...this.items]
      let cursor = 0
      const worker = async (): Promise<void> => {
        for (;;) {
          const item = snapshot[cursor++]
          if (!item) return
          // Puede haberse reemplazado por otro item con el mismo id mientras se vaciaba.
          if (this.byId.get(item.id) !== item) continue

          const at = this.now()
          if (item.expiresAt <= at) {
            this.remove(item)
            result.dropped += 1
            continue
          }

          item.attempts += 1
          try {
            await this.onSend(item.payload, item)
            this.remove(item)
            result.sent += 1
          } catch (error) {
            if (item.attempts >= this.maxAttempts) {
              this.remove(item)
              result.dropped += 1
              this.logger?.error('queue message exceeded max attempts', { id: item.id, error })
            } else {
              result.failed += 1
              this.logger?.warn('queue message will be retried', { id: item.id, attempts: item.attempts })
            }
          }
        }
      }
      const workers = Math.min(this.concurrency, snapshot.length)
      await Promise.all(Array.from({ length: workers }, () => worker()))
    } finally {
      this.flushing = false
    }
    return result
  }

  peek(): readonly QueueItem<T>[] {
    return this.items
  }

  clear(): void {
    this.items.length = 0
    this.byId.clear()
  }

  private remove(item: QueueItem<T>): void {
    if (this.byId.get(item.id) !== item) return
    this.byId.delete(item.id)
    const index = this.items.indexOf(item)
    if (index >= 0) this.items.splice(index, 1)
  }
}
