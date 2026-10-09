import type { Parsed } from './dates'

/**
 * Normalización de celdas leídas de Sheets (FORMATTED_VALUE).
 * Celda ausente, vacía o solo espacios → `null`. Nunca se convierte un vacío en 0.
 */
export function cellText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  const text = (typeof raw === 'string' ? raw : String(raw)).replace(/ /g, ' ').trim()
  return text === '' ? null : text
}

const NUMBER = /^[+-]?\d+(?:[.,]\d+)?$/

/** Número decimal; acepta coma o punto decimal. Separadores de miles se rechazan (ambiguos). */
export function parseNumber(raw: string | null): Parsed<number> {
  if (raw === null) return { value: null, invalid: false }
  const text = raw.replace(/\s/g, '')
  if (!NUMBER.test(text)) return { value: null, invalid: true }
  const value = Number(text.replace(',', '.'))
  return Number.isFinite(value) ? { value, invalid: false } : { value: null, invalid: true }
}

/** Número mayor o igual a cero (minutos, horas). */
export function parseNonNegative(raw: string | null): Parsed<number> {
  const parsed = parseNumber(raw)
  if (parsed.value !== null && parsed.value < 0) return { value: null, invalid: true }
  return parsed
}

/** Porcentaje como fracción 0..1. Acepta "15%" o "0.15"; "15" sin % es ambiguo → inválido. */
export function parseFraction(raw: string | null): Parsed<number> {
  if (raw === null) return { value: null, invalid: false }
  const text = raw.replace(/\s/g, '')
  const isPercent = text.endsWith('%')
  const parsed = parseNumber(isPercent ? text.slice(0, -1) : text)
  if (parsed.value === null) return parsed
  const value = isPercent ? parsed.value / 100 : parsed.value
  if (value < 0 || value > 1) return { value: null, invalid: true }
  return { value, invalid: false }
}

/** URL segura para un enlace: solo https/http, sin credenciales embebidas. */
export function parseSafeUrl(raw: string | null): Parsed<string> {
  if (raw === null) return { value: null, invalid: false }
  try {
    const url = new URL(raw)
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
      return { value: null, invalid: true }
    }
    return { value: url.toString(), invalid: false }
  } catch {
    return { value: null, invalid: true }
  }
}

/** Mayúsculas sin espacios extremos, para comparar estados/prioridades. */
export function normalizeCode(raw: string | null): string | null {
  return raw === null ? null : raw.trim().toUpperCase()
}
