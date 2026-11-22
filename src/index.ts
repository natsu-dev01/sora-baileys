import { BaileysClient } from './client.js'

export { choose, promptText } from './cli/menu.js'
export type { MenuChoice, MenuConfig } from './cli/menu.js'
export { BaileysClient } from './client.js'
export { BaileysAdapter, classifyClose, resolveBaileysRetryOptions } from './adapters/baileys-adapter.js'
export { MockAdapter } from './adapters/mock-adapter.js'
export type { MockAdapterOptions } from './adapters/mock-adapter.js'
export { backoffDelay, resolveBackoff, DEFAULT_BACKOFF } from './core/backoff.js'
export type { ResolvedBackoff } from './core/backoff.js'
export { Emitter } from './core/emitter.js'
export type { Listener } from './core/emitter.js'
export { createLogger, noopLogger } from './core/logger.js'
export type { LogLevel, LoggerOptions } from './core/logger.js'
export { silenceDecryptLogs, getSuppressedDecryptErrorCount } from './core/decrypt-logs.js'
/** Módulo interactivo avanzado (native flow, listas, carruseles y flows). */
export * as interactive from './core/interactive.js'
export {
  button,
  getInteractiveReply,
  normalizeButton,
  normalizeButtons,
  buildMessageParams,
  interactiveNodes,
  prepareHeader,
  relayInteractive,
  sendInteractiveMessage,
  sendButtons as sendNativeButtons,
  sendList,
  sendListMessage,
  sendTemplateButtons,
  sendCarousel as sendNativeCarousel,
  MAX_BUTTONS,
  MAX_MULTI_BUTTONS,
  MAX_CAROUSEL_CARDS,
} from './core/interactive.js'
export type * from './core/interactive.js'
export { createMessageStore, createRetryCache } from './core/message-store.js'
export type { MessageStoreOptions } from './core/message-store.js'
export { toMillis } from './core/time.js'
export { SendLimiter, resolveSending } from './core/sender.js'
export type { ResolvedSending } from './core/sender.js'
export { RetryQueue } from './core/queue.js'
export type { FlushResult, QueueConfig, QueueItem } from './core/queue.js'
export { DebouncedWriter, JsonFileStore, fileExists } from './store/file-store.js'
export type * from './types.js'

export function createClient(options?: import('./types.js').ClientOptions): BaileysClient {
  return new BaileysClient(options)
}
