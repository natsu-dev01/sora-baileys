import type { LoggerLike } from '../types.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
}

export interface LoggerOptions {
  level?: LogLevel
  prefix?: string
  sink?: (line: string) => void
}

const defaultSink = (line: string): void => {
  process.stdout.write(`${line}\n`)
}

export function createLogger(options: LoggerOptions = {}): LoggerLike {
  const level = options.level ?? 'info'
  const prefix = options.prefix ?? '[sora/baileys]'
  const sink = options.sink ?? defaultSink
  const threshold = LEVELS[level]

  const write = (name: Exclude<LogLevel, 'silent'>, message: string, meta?: unknown): void => {
    if (LEVELS[name] < threshold) return
    const suffix = meta === undefined ? '' : ` ${serialize(meta)}`
    sink(`${prefix} ${name.toUpperCase()} ${message}${suffix}`)
  }

  return {
    debug: (message, meta) => write('debug', message, meta),
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
  }
}

export function noopLogger(): LoggerLike {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }
}

function serialize(meta: unknown): string {
  if (meta instanceof Error) return meta.stack ?? meta.message
  if (typeof meta === 'string') return meta
  try {
    return JSON.stringify(meta)
  } catch {
    return String(meta)
  }
}
