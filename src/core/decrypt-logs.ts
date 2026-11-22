/**
 * libsignal imprime directamente por `console.error` cuando no encuentra una
 * sesión válida para descifrar un mensaje. Es ruido esperado en cuentas con
 * mucho tráfico (Bad MAC, sesiones descartadas, reenvíos duplicados) y Baileys
 * ya gestiona el fallo lanzando `SessionError`.
 *
 * Este módulo intercepta únicamente esas dos líneas concretas, sin tocar otros
 * errores de la aplicación, y mantiene un contador para saber cuántas se
 * silenciaron. Es acumulable: varias conexiones pueden instalar el filtro y
 * solo se retira cuando la última se libera.
 */

const DECRYPT_HEADER = 'Failed to decrypt message with any known session'
const SESSION_ERROR_PREFIX = 'Session error:'
const SESSION_ERROR_REASONS = /Bad MAC|No matching sessions found|No session record|No sessions available/

let originalConsoleError: typeof console.error | undefined
let installations = 0
let suppressedCount = 0

/** Instala el filtro y devuelve una función idempotente para liberarlo. */
export function silenceDecryptLogs(): () => void {
  installations += 1

  if (installations === 1) {
    originalConsoleError = console.error
    const forward = originalConsoleError
    const filtered: typeof console.error = (...args) => {
      if (isDecryptNoise(args)) {
        suppressedCount += 1
        return
      }
      forward.apply(console, args)
    }
    console.error = filtered
  }

  let released = false
  return () => {
    if (released) return
    released = true
    installations -= 1
    if (installations === 0 && originalConsoleError) {
      console.error = originalConsoleError
      originalConsoleError = undefined
    }
  }
}

/** Número total de líneas de descifrado silenciadas en este proceso. */
export function getSuppressedDecryptErrorCount(): number {
  return suppressedCount
}

function isDecryptNoise(args: unknown[]): boolean {
  const first = args[0]
  if (typeof first !== 'string') return false
  if (first.startsWith(DECRYPT_HEADER)) return true
  return first.startsWith(SESSION_ERROR_PREFIX) && SESSION_ERROR_REASONS.test(first)
}
