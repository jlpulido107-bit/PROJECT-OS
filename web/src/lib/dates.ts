/**
 * Fechas en hora local de Mérida (America/Merida).
 *
 * Reglas:
 * - Una fecha sin hora ("2026-10-08") es una fecha civil: nunca se convierte por UTC.
 * - Un instante con zona ("2026-10-09T03:21:25+00:00") se muestra en hora de Mérida.
 * - Una fecha-hora sin zona se interpreta como hora local de Mérida.
 * - Cualquier otro formato se marca como inválido; nunca se adivina día/mes.
 */

export const MERIDA_TZ = 'America/Merida'

export interface Parsed<T> {
  /** Valor normalizado; `null` si la celda está vacía o es inválida. */
  value: T | null
  /** `true` si la celda tenía contenido que no se pudo interpretar. */
  invalid: boolean
}

export interface Timestamp {
  /** Milisegundos desde época Unix. Para fechas sin hora, medianoche de Mérida. */
  epochMs: number
  /** Fecha civil en Mérida (YYYY-MM-DD). */
  date: string
  /** `false` si la celda solo tenía fecha. */
  hasTime: boolean
}

const EMPTY = { value: null, invalid: false } as const
const INVALID = { value: null, invalid: true } as const

const DATE_ONLY = /^(\d{4})[-/](\d{2})[-/](\d{2})$/
const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/
const ZONED_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}

function isValidCivil(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const probe = new Date(Date.UTC(y, m - 1, d))
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>()
function partsFormatter(tz: string): Intl.DateTimeFormat {
  let fmt = partsFormatters.get(tz)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    partsFormatters.set(tz, fmt)
  }
  return fmt
}

function zonedParts(epochMs: number, tz: string) {
  const out: Record<string, number> = {}
  for (const part of partsFormatter(tz).formatToParts(new Date(epochMs))) {
    if (part.type !== 'literal') out[part.type] = Number(part.value)
  }
  return {
    year: out.year ?? 0,
    month: out.month ?? 0,
    day: out.day ?? 0,
    hour: out.hour ?? 0,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
  }
}

/** Desfase (ms) de la zona respecto a UTC en un instante dado. */
export function zoneOffsetMs(epochMs: number, tz: string = MERIDA_TZ): number {
  const p = zonedParts(epochMs, tz)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(epochMs / 1000) * 1000
}

/** Convierte una hora de pared en la zona indicada a epoch ms. */
export function zonedTimeToEpoch(
  y: number, m: number, d: number, hh = 0, mm = 0, ss = 0, tz: string = MERIDA_TZ,
): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm, ss)
  let epoch = guess - zoneOffsetMs(guess, tz)
  const corrected = guess - zoneOffsetMs(epoch, tz)
  if (corrected !== epoch) epoch = corrected
  return epoch
}

/** Fecha civil (YYYY-MM-DD) de un instante en la zona indicada. */
export function civilDateInZone(epochMs: number, tz: string = MERIDA_TZ): string {
  const p = zonedParts(epochMs, tz)
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`
}

/** Fecha civil, hora (0–23) y día de la semana (0 = lunes … 6 = domingo) de un instante en la zona indicada. */
export function civilHourInZone(epochMs: number, tz: string = MERIDA_TZ): { date: string; hour: number; weekday: number } {
  const p = zonedParts(epochMs, tz)
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()
  return { date: `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`, hour: p.hour, weekday: (dow + 6) % 7 }
}

export function todayInMerida(now: Date = new Date()): string {
  return civilDateInZone(now.getTime(), MERIDA_TZ)
}

/** Suma días a una fecha civil sin pasar por zonas horarias. */
export function addDays(civil: string, days: number): string {
  const [y, m, d] = civil.split('-').map(Number) as [number, number, number]
  const date = new Date(Date.UTC(y, m - 1, d + days))
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

/** Fecha civil desde una celda. Acepta YYYY-MM-DD, YYYY/MM/DD o un instante ISO con zona. */
export function parseCivilDate(raw: string | null | undefined): Parsed<string> {
  const text = (raw ?? '').trim()
  if (!text) return EMPTY
  const m = DATE_ONLY.exec(text)
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
    return isValidCivil(y, mo, d) ? { value: `${m[1]}-${m[2]}-${m[3]}`, invalid: false } : INVALID
  }
  const ts = parseTimestamp(text)
  return ts.value ? { value: ts.value.date, invalid: false } : INVALID
}

/** Instante desde una celda (fecha, fecha-hora local de Mérida o ISO con zona). */
export function parseTimestamp(raw: string | null | undefined): Parsed<Timestamp> {
  const text = (raw ?? '').trim()
  if (!text) return EMPTY

  const dateOnly = DATE_ONLY.exec(text)
  if (dateOnly) {
    const [y, mo, d] = [Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3])]
    if (!isValidCivil(y, mo, d)) return INVALID
    return {
      value: { epochMs: zonedTimeToEpoch(y, mo, d), date: `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`, hasTime: false },
      invalid: false,
    }
  }

  if (ZONED_DATETIME.test(text)) {
    const epochMs = Date.parse(text)
    if (Number.isNaN(epochMs)) return INVALID
    const [y, mo, d] = text.slice(0, 10).split('-').map(Number) as [number, number, number]
    if (!isValidCivil(y, mo, d)) return INVALID
    return { value: { epochMs, date: civilDateInZone(epochMs), hasTime: true }, invalid: false }
  }

  const local = LOCAL_DATETIME.exec(text)
  if (local) {
    const [y, mo, d, hh, mi, ss] = [1, 2, 3, 4, 5, 6].map((i) => Number(local[i] ?? 0)) as [
      number, number, number, number, number, number,
    ]
    if (!isValidCivil(y, mo, d) || hh > 23 || mi > 59 || ss > 59) return INVALID
    const epochMs = zonedTimeToEpoch(y, mo, d, hh, mi, ss)
    return { value: { epochMs, date: civilDateInZone(epochMs), hasTime: true }, invalid: false }
  }

  return INVALID
}

const civilFormatter = new Intl.DateTimeFormat('es-MX', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
})
const instantFormatter = new Intl.DateTimeFormat('es-MX', {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  hourCycle: 'h23', timeZone: MERIDA_TZ,
})

/** "8 oct 2026" para una fecha civil YYYY-MM-DD. */
export function formatCivilDate(civil: string): string {
  const [y, m, d] = civil.split('-').map(Number) as [number, number, number]
  return civilFormatter.format(new Date(Date.UTC(y, m - 1, d)))
}

/** "8 oct 2026, 21:21" en hora de Mérida; si no tenía hora, solo la fecha. */
export function formatTimestamp(ts: Timestamp): string {
  return ts.hasTime ? instantFormatter.format(new Date(ts.epochMs)) : formatCivilDate(ts.date)
}

export function formatInstant(epochMs: number): string {
  return instantFormatter.format(new Date(epochMs))
}

/** Diferencia en días civiles (b - a). */
export function daysBetween(a: string, b: string): number {
  const toUtc = (s: string) => {
    const [y, m, d] = s.split('-').map(Number) as [number, number, number]
    return Date.UTC(y, m - 1, d)
  }
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000)
}
