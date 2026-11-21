import type { BackoffOptions } from '../types.js'

export interface ResolvedBackoff {
  baseMs: number
  maxMs: number
  factor: number
  jitter: number
}

export const DEFAULT_BACKOFF: ResolvedBackoff = {
  baseMs: 1000,
  maxMs: 60_000,
  factor: 2,
  jitter: 0.25,
}

export function resolveBackoff(options: BackoffOptions = {}): ResolvedBackoff {
  return {
    baseMs: Math.max(0, options.baseMs ?? DEFAULT_BACKOFF.baseMs),
    maxMs: Math.max(0, options.maxMs ?? DEFAULT_BACKOFF.maxMs),
    factor: Math.max(1, options.factor ?? DEFAULT_BACKOFF.factor),
    jitter: clamp(options.jitter ?? DEFAULT_BACKOFF.jitter, 0, 1),
  }
}

/**
 * Retardo para el intento `attempt` (1 = primer reintento).
 * Jitter simétrico para evitar que varias sesiones se sincronicen.
 */
export function backoffDelay(
  attempt: number,
  options: BackoffOptions = {},
  random: () => number = Math.random,
): number {
  const opts = resolveBackoff(options)
  const safeAttempt = Math.max(1, Math.floor(attempt))
  const exponential = opts.baseMs * Math.pow(opts.factor, safeAttempt - 1)
  const capped = Math.min(opts.maxMs, exponential)
  const r = clamp(random(), 0, 1)
  const spread = (r * 2 - 1) * opts.jitter
  return Math.max(0, Math.round(capped * (1 + spread)))
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
