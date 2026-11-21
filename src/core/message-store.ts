import type { LoggerLike, MessageKey, MessageStore, RetryCache } from '../types.js'

interface StoredMessage {
  content: Record<string, unknown>
  remoteJid?: string
  expiresAt: number
}

export interface MessageStoreOptions {
  /** Tiempo de vida de cada mensaje recordado. Por defecto 1 hora. */
  ttlMs?: number
  /** Máximo de mensajes recordados. Por defecto 1000. */
  maxMessages?: number
}

/**
 * Store en memoria de mensajes salientes. Baileys lo usa a través de `getMessage`
 * para reenviar un mensaje cuando el teléfono vinculado no pudo descifrarlo y
 * muestra el placeholder "No se pudo cargar este mensaje...".
 */
export function createMessageStore(
  options: MessageStoreOptions = {},
  logger?: LoggerLike,
): MessageStore {
  const ttlMs = Math.max(1000, options.ttlMs ?? 60 * 60 * 1000)
  const maxMessages = Math.max(1, Math.floor(options.maxMessages ?? 1000))
  const entries = new Map<string, StoredMessage>()

  const prune = (): void => {
    const now = Date.now()
    for (const [id, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(id)
    }
    while (entries.size > maxMessages) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      entries.delete(oldest)
    }
  }

  return {
    get size(): number {
      prune()
      return entries.size
    },

    remember(key: MessageKey, content: Record<string, unknown>): void {
      const id = typeof key.id === 'string' ? key.id : undefined
      if (!id || Object.keys(content).length === 0) return
      entries.delete(id)
      entries.set(id, {
        content,
        remoteJid: key.remoteJid,
        expiresAt: Date.now() + ttlMs,
      })
      prune()
      logger?.debug?.('message remembered for retry', { id, size: entries.size })
    },

    get(key: MessageKey): Record<string, unknown> | undefined {
      const id = typeof key.id === 'string' ? key.id : undefined
      if (!id) return undefined
      const entry = entries.get(id)
      if (!entry) return undefined
      if (entry.expiresAt <= Date.now()) {
        entries.delete(id)
        return undefined
      }
      if (key.remoteJid && entry.remoteJid && entry.remoteJid !== key.remoteJid) {
        return undefined
      }
      // Reinsertar para mantener el orden LRU.
      entries.delete(id)
      entries.set(id, entry)
      return entry.content
    },

    forget(id: string): void {
      entries.delete(id)
    },

    clear(): void {
      entries.clear()
    },
  }
}

/** Caché mínima compatible con `CacheStore` de Baileys para contadores de reintento. */
export function createRetryCache(maxEntries = 5000): RetryCache {
  const entries = new Map<string, unknown>()

  return {
    get<T>(key: string): T | undefined {
      return entries.get(key) as T | undefined
    },
    set<T>(key: string, value: T): void {
      entries.delete(key)
      entries.set(key, value)
      if (entries.size > maxEntries) {
        const oldest = entries.keys().next().value
        if (oldest !== undefined) entries.delete(oldest)
      }
    },
    del(key: string): void {
      entries.delete(key)
    },
    flushAll(): void {
      entries.clear()
    },
  }
}
