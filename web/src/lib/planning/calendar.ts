/**
 * Calendario civil del planificador: semanas ISO 8601 (lunes a domingo).
 * Todo opera sobre fechas civiles `YYYY-MM-DD` con aritmética UTC de calendario (sin horas ni zonas),
 * por lo que no hay errores de desfase. La conversión instante → fecha civil se hace fuera del motor.
 */

const CIVIL = /^(\d{4})-(\d{2})-(\d{2})$/

export function isCivilDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const m = CIVIL.exec(value)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const probe = new Date(Date.UTC(y, mo - 1, d))
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d
}

function toUtc(civil: string): number {
  const [y, m, d] = civil.split('-').map(Number) as [number, number, number]
  return Date.UTC(y, m - 1, d)
}

function fromUtc(ms: number): string {
  const date = new Date(ms)
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

export function addCivilDays(civil: string, days: number): string {
  return fromUtc(toUtc(civil) + days * 86_400_000)
}

/** Día ISO de la semana: 1 = lunes … 7 = domingo. */
export function isoWeekday(civil: string): number {
  const dow = new Date(toUtc(civil)).getUTCDay()
  return dow === 0 ? 7 : dow
}

export function isoMonday(civil: string): string {
  return addCivilDays(civil, 1 - isoWeekday(civil))
}

/** Identificador ISO de la semana, p. ej. `2026-W41`. El año ISO es el del jueves de esa semana. */
export function isoWeekId(civil: string): string {
  const thursday = addCivilDays(isoMonday(civil), 3)
  const year = Number(thursday.slice(0, 4))
  const jan4Monday = isoMonday(`${year}-01-04`)
  const week = Math.round((toUtc(thursday) - toUtc(jan4Monday)) / (7 * 86_400_000)) + 1
  return `${year}-W${String(week).padStart(2, '0')}`
}

export function weekDays(monday: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addCivilDays(monday, i))
}

/** Diferencia en días civiles (b − a). */
export function civilDaysBetween(a: string, b: string): number {
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000)
}
