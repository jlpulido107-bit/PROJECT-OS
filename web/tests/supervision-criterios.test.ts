import { describe, expect, it } from 'vitest'
import { extraerCriterios } from '../src/lib/supervision/criterios'
import { hashCriterios } from '../src/lib/supervision/key'

const ok = (t: string) => {
  const r = extraerCriterios(t)
  if (!r.ok) throw new Error(r.motivo)
  return r
}
const motivo = (t: string) => {
  const r = extraerCriterios(t)
  if (r.ok) throw new Error('debía rechazarse')
  return r.motivo
}

describe('extraerCriterios', () => {
  it('admite «N.» y «N)» con continuaciones y números internos sin crear criterios', () => {
    expect(ok('1. Uno\n2. Dos').criteriosEsperados).toEqual(['1', '2'])
    expect(ok('1) Uno\n2) Dos').criteriosEsperados).toEqual(['1', '2'])
    const r = ok('1. Uno con 2. dentro y 3) también\n   2) sangrada es continuación\ncontinúa con 15 casos\n\n2. Dos\r\n3. Tres')
    expect(r.criteriosEsperados).toEqual(['1', '2', '3'])
    expect(r.criterios[0]!.texto).toContain('continúa con 15 casos')
    expect(r.criterios[0]!.texto).toContain('2) sangrada')
  })

  it('conserva los IDs explícitos sin renumerar (huecos permitidos, en orden)', () => {
    expect(ok('2. Dos\n5. Cinco').criteriosEsperados).toEqual(['2', '5'])
  })

  it('hash: usa hashCriterios y cambia con el contenido o el orden', () => {
    const r = ok('1. Uno\n2. Dos')
    expect(r.hashCriterios).toBe(hashCriterios([{ numero: 1, texto: 'Uno' }, { numero: 2, texto: 'Dos' }]))
    expect(r.hashCriterios).toBe(ok('1. Uno  \r\n2. Dos').hashCriterios)
    expect(ok('1. Uno\n2. Dos y más').hashCriterios).not.toBe(r.hashCriterios)
    expect(ok('1. Dos\n2. Uno').hashCriterios).not.toBe(r.hashCriterios)
    expect(ok('1) Uno\n2) Dos').hashCriterios).toBe(r.hashCriterios)
  })

  it('rechaza vacío, sin IDs, duplicados y estructura ambigua con motivo', () => {
    expect(motivo('')).toMatch(/vacío/)
    expect(motivo(' \n\t\n')).toMatch(/vacío/)
    expect(motivo('Cumplir esto\nY esto')).toMatch(/IDs explícitos/)
    expect(motivo('- uno\n- dos')).toMatch(/IDs explícitos/)
    expect(motivo('1. Uno\n1. Otro')).toMatch(/duplicado: 1/)
    expect(motivo('1. Uno\n2) Dos')).toMatch(/delimitadores/)
    expect(motivo('Introducción\n1. Uno')).toMatch(/antes del primer criterio/)
    expect(motivo('2. Dos\n1. Uno')).toMatch(/orden creciente/)
    expect(motivo('01. Uno')).toMatch(/IDs explícitos/)
    expect(motivo('1.Uno')).toMatch(/IDs explícitos/)
    expect(motivo('1. \n2. Dos')).toMatch(/mal formado/)
  })

  it('rechaza encabezados mal formados después de un criterio válido (no los absorbe)', () => {
    expect(motivo('1. Uno\n2. ')).toMatch(/mal formado/)
    expect(motivo('1. Uno\n1. ')).toMatch(/mal formado/)
    expect(motivo('1. Uno\n02. Dos')).toMatch(/mal formado/)
    expect(motivo('1. Uno\n2.Dos')).toMatch(/mal formado/)
    expect(motivo('1) Uno\n2)')).toMatch(/mal formado/)
    expect(motivo('1) Uno\n2)3 pruebas')).toMatch(/mal formado/)
    expect(ok('1. Uno\n3.5 litros\n   2. sangrada\n2. Dos').criteriosEsperados).toEqual(['1', '2'])
  })
})
