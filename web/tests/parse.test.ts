import { describe, expect, it } from 'vitest'
import { cellText, normalizeCode, parseFraction, parseNonNegative, parseNumber, parseSafeUrl } from '@/lib/parse'

describe('celdas', () => {
  it('normaliza vacíos a null, nunca a cero', () => {
    expect(cellText(undefined)).toBeNull()
    expect(cellText(null)).toBeNull()
    expect(cellText('')).toBeNull()
    expect(cellText('   ')).toBeNull()
    expect(cellText(' SIG ')).toBe('SIG')
    expect(cellText(0)).toBe('0')
  })

  it('normaliza códigos de estado', () => {
    expect(normalizeCode(' en_progreso ')).toBe('EN_PROGRESO')
    expect(normalizeCode(null)).toBeNull()
  })
})

describe('números', () => {
  it('acepta punto o coma decimal', () => {
    expect(parseNumber('90').value).toBe(90)
    expect(parseNumber('6,5').value).toBe(6.5)
    expect(parseNumber(' 1.25 ').value).toBe(1.25)
  })

  it('vacío no es inválido ni cero', () => {
    expect(parseNumber(null)).toEqual({ value: null, invalid: false })
  })

  it('marca texto y separadores de miles como inválidos', () => {
    expect(parseNumber('n/d')).toEqual({ value: null, invalid: true })
    expect(parseNumber('1,234.5').invalid).toBe(true)
    expect(parseNumber('1e3').invalid).toBe(true)
  })

  it('rechaza minutos negativos', () => {
    expect(parseNonNegative('-5')).toEqual({ value: null, invalid: true })
    expect(parseNonNegative('0').value).toBe(0)
  })
})

describe('porcentajes', () => {
  it('acepta 15% y 0.15', () => {
    expect(parseFraction('15%').value).toBeCloseTo(0.15)
    expect(parseFraction('0.15').value).toBeCloseTo(0.15)
    expect(parseFraction('0,15').value).toBeCloseTo(0.15)
  })

  it('rechaza valores ambiguos o fuera de rango', () => {
    expect(parseFraction('15').invalid).toBe(true)
    expect(parseFraction('150%').invalid).toBe(true)
  })
})

describe('URLs', () => {
  it('solo permite http(s) sin credenciales', () => {
    expect(parseSafeUrl('https://github.com/jlpulido107-bit/PROJECT-OS/pull/1').value).toBe(
      'https://github.com/jlpulido107-bit/PROJECT-OS/pull/1',
    )
    expect(parseSafeUrl('javascript:alert(1)').invalid).toBe(true)
    expect(parseSafeUrl('https://user:pass@example.com/').invalid).toBe(true)
    expect(parseSafeUrl('no es url').invalid).toBe(true)
    expect(parseSafeUrl(null)).toEqual({ value: null, invalid: false })
  })
})
