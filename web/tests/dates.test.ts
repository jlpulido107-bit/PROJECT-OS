import { describe, expect, it } from 'vitest'
import {
  addDays, civilDateInZone, daysBetween, formatCivilDate, formatTimestamp, parseCivilDate, parseTimestamp, todayInMerida,
  zonedTimeToEpoch,
} from '@/lib/dates'

describe('fechas civiles', () => {
  it('acepta AAAA-MM-DD y AAAA/MM/DD sin desplazar el día', () => {
    expect(parseCivilDate('2026-10-08')).toEqual({ value: '2026-10-08', invalid: false })
    expect(parseCivilDate(' 2026/10/08 ')).toEqual({ value: '2026-10-08', invalid: false })
  })

  it('celda vacía no es inválida ni cero', () => {
    expect(parseCivilDate('')).toEqual({ value: null, invalid: false })
    expect(parseCivilDate(null)).toEqual({ value: null, invalid: false })
    expect(parseCivilDate('   ')).toEqual({ value: null, invalid: false })
  })

  it('rechaza fechas imposibles y formatos ambiguos día/mes', () => {
    expect(parseCivilDate('2026-02-30').invalid).toBe(true)
    expect(parseCivilDate('08/10/2026').invalid).toBe(true)
    expect(parseCivilDate('mañana').invalid).toBe(true)
  })

  it('un instante con zona se convierte a la fecha local de Mérida', () => {
    // 03:21 UTC del 9 de octubre = 21:21 del 8 de octubre en Mérida (UTC-6).
    expect(parseCivilDate('2026-10-09T03:21:25+00:00').value).toBe('2026-10-08')
  })

  it('formatea una fecha civil sin cambiar el día por zona horaria', () => {
    expect(formatCivilDate('2026-10-08')).toMatch(/^8 oct\.? 2026$/)
  })
})

describe('instantes', () => {
  it('interpreta ISO con zona', () => {
    const ts = parseTimestamp('2026-10-09T03:21:25+00:00').value
    expect(ts).toEqual({ epochMs: Date.UTC(2026, 9, 9, 3, 21, 25), date: '2026-10-08', hasTime: true })
    expect(formatTimestamp(ts!)).toMatch(/8 oct\.? 2026.*21:21/)
  })

  it('una fecha-hora sin zona es hora local de Mérida', () => {
    const ts = parseTimestamp('2026-10-08 18:30').value
    expect(ts?.epochMs).toBe(Date.UTC(2026, 9, 9, 0, 30))
    expect(ts?.date).toBe('2026-10-08')
  })

  it('una fecha sin hora equivale a medianoche de Mérida y se marca sin hora', () => {
    const ts = parseTimestamp('2026-10-08').value
    expect(ts).toEqual({ epochMs: Date.UTC(2026, 9, 8, 6), date: '2026-10-08', hasTime: false })
  })

  it('marca como inválidos los textos no reconocidos', () => {
    expect(parseTimestamp('ayer').invalid).toBe(true)
    expect(parseTimestamp('2026-13-01T00:00:00Z').invalid).toBe(true)
    expect(parseTimestamp('2026-10-08 25:00').invalid).toBe(true)
  })
})

describe('zona America/Merida', () => {
  it('"hoy" depende de Mérida, no de UTC', () => {
    expect(todayInMerida(new Date('2026-10-09T05:59:59Z'))).toBe('2026-10-08')
    expect(todayInMerida(new Date('2026-10-09T06:00:00Z'))).toBe('2026-10-09')
  })

  it('convierte hora de pared a epoch y de vuelta', () => {
    const epoch = zonedTimeToEpoch(2026, 1, 15, 23, 0, 0)
    expect(epoch).toBe(Date.UTC(2026, 0, 16, 5, 0, 0))
    expect(civilDateInZone(epoch)).toBe('2026-01-15')
  })

  it('suma días y calcula diferencias en fechas civiles', () => {
    expect(addDays('2026-10-30', 3)).toBe('2026-11-02')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(daysBetween('2026-10-08', '2026-10-15')).toBe(7)
  })
})
