import type { LoggerLike, SendingOptions } from '../types.js'

export interface ResolvedSending {
  maxConcurrent: number
  messagesPerMinute: number
  burst: number
  perRecipientCooldownMs: number
  jitterMs: number
  sendTimeoutMs: number
  dailyLimit: number
  typing: boolean
  typingMs: number
}

export function resolveSending(options: SendingOptions = {}): ResolvedSending {
  return {
    maxConcurrent: Math.max(1, Math.floor(options.maxConcurrent ?? 3)),
    messagesPerMinute: Math.max(0, options.messagesPerMinute ?? 60),
    burst: Math.max(1, Math.floor(options.burst ?? 5)),
    perRecipientCooldownMs: Math.max(0, options.perRecipientCooldownMs ?? 800),
    jitterMs: Math.max(0, options.jitterMs ?? 400),
    sendTimeoutMs: Math.max(0, options.sendTimeoutMs ?? 15_000),
    dailyLimit: Math.max(0, Math.floor(options.dailyLimit ?? 0)),
    typing: options.typing ?? false,
    typingMs: Math.max(100, options.typingMs ?? 1200),
  }
}

const delay = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Regula los envíos salientes:
 * - ráfaga + token bucket global para no disparar ráfagas sospechosas,
 * - espaciado con jitter por destinatario (y orden por destinatario),
 * - concurrencia acotada para seguir siendo rápido con varios chats.
 */
export class SendLimiter {
  private readonly opts: ResolvedSending
  private readonly ratePerMs: number
  private tokens: number
  private lastRefillAt = Date.now()
  private active = 0
  private readonly waiters: Array<() => void> = []
  private readonly nextByRecipient = new Map<string, number>()
  private readonly tailByRecipient = new Map<string, Promise<void>>()
  private lock: Promise<void> = Promise.resolve()

  constructor(options: ResolvedSending, private readonly logger?: LoggerLike) {
    this.opts = options
    this.ratePerMs = options.messagesPerMinute / 60_000
    this.tokens = options.burst
  }

  /** Reserva un hueco de envío. La función devuelta debe llamarse al terminar. */
  async acquire(to: string): Promise<() => void> {
    const previous = this.tailByRecipient.get(to) ?? Promise.resolve()
    let finishRecipient!: () => void
    const current = new Promise<void>((resolve) => { finishRecipient = resolve })
    this.tailByRecipient.set(to, current)

    let releaseSlot: (() => void) | undefined
    try {
      await previous
      const wait = await this.reserveRecipient(to)
      if (wait > 0) await delay(wait)
      await this.takeToken()
      releaseSlot = await this.takeSlot()
    } catch (error) {
      finishRecipient()
      if (this.tailByRecipient.get(to) === current) this.tailByRecipient.delete(to)
      throw error
    }

    let released = false
    return () => {
      if (released) return
      released = true
      releaseSlot?.()
      finishRecipient()
      if (this.tailByRecipient.get(to) === current) this.tailByRecipient.delete(to)
    }
  }

  get inFlight(): number {
    return this.active
  }

  private withLock<T>(fn: () => T): Promise<T> {
    const result = this.lock.then(fn)
    this.lock = result.then(() => undefined, () => undefined)
    return result
  }

  private reserveRecipient(to: string): Promise<number> {
    return this.withLock(() => {
      const now = Date.now()
      const last = this.nextByRecipient.get(to) ?? 0
      const wait = Math.max(0, last - now)
      const jitter = this.opts.jitterMs > 0
        ? Math.round(Math.random() * this.opts.jitterMs)
        : 0
      this.nextByRecipient.set(to, Math.max(now, last) + this.opts.perRecipientCooldownMs + jitter)
      return wait
    })
  }

  private async takeToken(): Promise<void> {
    if (this.ratePerMs <= 0) return
    for (;;) {
      const wait = await this.withLock(() => {
        const now = Date.now()
        this.tokens = Math.min(this.opts.burst, this.tokens + (now - this.lastRefillAt) * this.ratePerMs)
        this.lastRefillAt = now
        if (this.tokens >= 1) {
          this.tokens -= 1
          return 0
        }
        return Math.max(1, Math.ceil((1 - this.tokens) / this.ratePerMs))
      })
      if (wait === 0) {
        this.logger?.debug?.('send admitted', { inFlight: this.active, tokens: this.tokens })
        return
      }
      await delay(wait)
    }
  }

  private takeSlot(): Promise<() => void> {
    if (this.active < this.opts.maxConcurrent) {
      this.active += 1
      return Promise.resolve(() => this.releaseSlot())
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    }).then(() => () => this.releaseSlot())
  }

  private releaseSlot(): void {
    const next = this.waiters.shift()
    if (next) {
      next()
      return
    }
    this.active = Math.max(0, this.active - 1)
  }
}
