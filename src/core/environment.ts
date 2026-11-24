import { existsSync } from 'node:fs'
import { cpus, totalmem } from 'node:os'
import type { QueueOptions, SendingOptions, MessageRetryOptions } from '../types.js'

/**
 * Perfil de ejecución. En Termux y en VPS/containers pequeños los defaults del
 * cliente (1000 mensajes recordados, 3 envíos en paralelo, heartbeat de 30 s)
 * son demasiado agresivos: suben el consumo de RAM y mantienen el CPU despierto.
 *
 * La librería no instala handlers de proceso: solo elige defaults seguros y
 * deja que la aplicación los sobrescriba.
 */

export type RuntimeProfile = 'lite' | 'vps' | 'full'

export interface EnvironmentProfile {
  name: RuntimeProfile
  isTermux: boolean
  isContainer: boolean
  lowMemory: boolean
  totalMemoryMb: number
  cpuCount: number
}

export interface EnvironmentTuning {
  maxRememberedMessages: number
  messageTtlMs: number
  retryCacheMaxEntries: number
  queue: QueueOptions
  sending: SendingOptions
  heartbeatEveryMs: number
  staleAfterMs: number
  retry: MessageRetryOptions
}

type EnvLookup = Record<string, string | undefined>

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on'])

function isTrue(value: string | undefined): boolean {
  return typeof value === 'string' && TRUE_VALUES.has(value.trim().toLowerCase())
}

/** Detecta el entorno. Pura para poder probarla con un `env` falso. */
export function detectEnvironment(env: EnvLookup = process.env): EnvironmentProfile {
  const isTermux = Boolean(
    env.TERMUX_VERSION || /com\.termux/i.test(`${env.PREFIX ?? ''} ${env.HOME ?? ''}`),
  )
  const isContainer = existsSync('/.dockerenv') || Boolean(
    env.container || env.KUBERNETES_SERVICE_HOST,
  )
  const totalMemoryMb = Math.round(totalmem() / (1024 * 1024))
  const lowMemory = isTrue(env.SORA_LOW_MEMORY) || (totalMemoryMb > 0 && totalMemoryMb <= 2048)

  const requested = String(env.SORA_PROFILE ?? '').trim().toLowerCase()
  const name: RuntimeProfile = requested === 'lite' || requested === 'vps' || requested === 'full'
    ? requested
    : lowMemory || isTermux ? 'lite' : isContainer ? 'vps' : 'full'

  return {
    name,
    isTermux,
    isContainer,
    lowMemory,
    totalMemoryMb,
    cpuCount: Math.max(1, cpus().length || 1),
  }
}

export const environment: EnvironmentProfile = detectEnvironment()

const LITE: EnvironmentTuning = {
  maxRememberedMessages: 200,
  messageTtlMs: 30 * 60_000,
  retryCacheMaxEntries: 1000,
  queue: { maxSize: 300, ttlMs: 3 * 60_000, maxAttempts: 3 },
  sending: {
    maxConcurrent: 1,
    messagesPerMinute: 30,
    burst: 2,
    perRecipientCooldownMs: 1200,
    jitterMs: 600,
    sendTimeoutMs: 30_000,
  },
  heartbeatEveryMs: 60_000,
  staleAfterMs: 180_000,
  retry: {
    retryRequestDelayMs: 1500,
    maxMsgRetryCount: 2,
    enableAutoSessionRecreation: false,
    enableRecentMessageCache: true,
    suppressDecryptErrors: true,
    messageTtlMs: 30 * 60_000,
    maxRememberedMessages: 200,
    maxResendRequests: 1,
    resendCooldownMs: 60_000,
    resendWindowMs: 5 * 60_000,
  },
}

const VPS: EnvironmentTuning = {
  maxRememberedMessages: 500,
  messageTtlMs: 60 * 60_000,
  retryCacheMaxEntries: 3000,
  queue: { maxSize: 600, ttlMs: 5 * 60_000, maxAttempts: 4 },
  sending: {
    maxConcurrent: 2,
    messagesPerMinute: 45,
    burst: 3,
    perRecipientCooldownMs: 1000,
    jitterMs: 500,
    sendTimeoutMs: 20_000,
  },
  heartbeatEveryMs: 45_000,
  staleAfterMs: 150_000,
  retry: {
    retryRequestDelayMs: 1000,
    maxMsgRetryCount: 3,
    enableAutoSessionRecreation: false,
    enableRecentMessageCache: true,
    suppressDecryptErrors: true,
    messageTtlMs: 60 * 60_000,
    maxRememberedMessages: 500,
    maxResendRequests: 2,
    resendCooldownMs: 30_000,
    resendWindowMs: 5 * 60_000,
  },
}

const FULL: EnvironmentTuning = {
  maxRememberedMessages: 1000,
  messageTtlMs: 60 * 60_000,
  retryCacheMaxEntries: 5000,
  queue: { maxSize: 1000, ttlMs: 5 * 60_000, maxAttempts: 5 },
  sending: {
    maxConcurrent: 3,
    messagesPerMinute: 60,
    burst: 5,
    perRecipientCooldownMs: 800,
    jitterMs: 400,
    sendTimeoutMs: 15_000,
  },
  heartbeatEveryMs: 30_000,
  staleAfterMs: 120_000,
  retry: {
    retryRequestDelayMs: 1000,
    maxMsgRetryCount: 3,
    enableAutoSessionRecreation: false,
    enableRecentMessageCache: true,
    suppressDecryptErrors: true,
    messageTtlMs: 60 * 60_000,
    maxRememberedMessages: 1000,
    maxResendRequests: 2,
    resendCooldownMs: 30_000,
    resendWindowMs: 5 * 60_000,
  },
}

const PROFILES: Record<RuntimeProfile, EnvironmentTuning> = { lite: LITE, vps: VPS, full: FULL }

/** Defaults del perfil indicado (o del detectado). El usuario siempre gana. */
export function resolveEnvironmentTuning(name: RuntimeProfile = environment.name): EnvironmentTuning {
  return PROFILES[name]
}

/** Texto corto para logs del usuario. */
export function describeEnvironment(profile: EnvironmentProfile = environment): string {
  return `${profile.name}${profile.isTermux ? ' · termux' : ''}${profile.isContainer ? ' · container' : ''}${profile.lowMemory ? ' · low-memory' : ''}`
}
