/**
 * Baileys entrega `messageTimestamp` en segundos (y a veces como `Long`),
 * mientras que el cliente trabaja en milisegundos. Normaliza ambos formatos
 * sin convertir dos veces un valor que ya está en ms.
 */
export function toMillis(value: unknown, fallback = Date.now()): number {
  let raw: number

  if (typeof value === 'number') {
    raw = value
  } else if (value !== null && typeof value === 'object' && typeof (value as { toString?: unknown }).toString === 'function') {
    raw = Number((value as { toString: () => string }).toString())
  } else {
    raw = Number.NaN
  }

  if (!Number.isFinite(raw) || raw <= 0) return fallback

  // ~1.79e9 = segundos, ~1.79e12 = milisegundos.
  const ms = raw < 1e12 ? raw * 1000 : raw
  return Number.isFinite(ms) ? ms : fallback
}
