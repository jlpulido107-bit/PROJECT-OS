import { civilDateInZone, MERIDA_TZ, zoneOffsetMs } from '../dates'

function pad(n: number, w = 2) {
  return String(n).padStart(w, '0')
}

/** Instante ISO 8601 con el desfase de Mérida, p. ej. 2026-10-09T10:15:00-06:00. */
export function meridaIsoTimestamp(now: Date): string {
  const epoch = Math.floor(now.getTime() / 1000) * 1000
  const offset = zoneOffsetMs(epoch, MERIDA_TZ)
  const local = new Date(epoch + offset)
  const sign = offset < 0 ? '-' : '+'
  const abs = Math.abs(offset) / 60000
  return (
    `${pad(local.getUTCFullYear(), 4)}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

/** AAAAMMDD en Mérida (para IDs). */
export function meridaCompactDate(now: Date): string {
  return civilDateInZone(now.getTime(), MERIDA_TZ).replace(/-/g, '')
}
