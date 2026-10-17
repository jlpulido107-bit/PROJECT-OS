import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extraerCriterios } from '@/lib/supervision/criterios'
import { validarReporte } from '@/lib/supervision/report'

// Criterios de la orden a los que responde el ejemplo de la skill revisar-orden.
const CRITERIOS = [
  '1. Valida los cuatro datos y no lee la descripción del PR antes de dictaminar.',
  '2. Exige evidencia ejecutada y un caso negativo por criterio.',
].join('\n')

const ruta = resolve(__dirname, '../../.claude/skills/revisar-orden/ejemplo-dictamen.json')
const leer = () => JSON.parse(readFileSync(ruta, 'utf8'))

describe('ejemplo de dictamen de la skill revisar-orden', () => {
  const extraidos = extraerCriterios(CRITERIOS)
  if (!extraidos.ok) throw new Error(extraidos.motivo)
  const politica = { ciRequerida: true, criteriosEsperados: extraidos.criteriosEsperados }

  it('lo acepta validarReporte con los criterios extraídos', () => {
    const r = validarReporte(leer(), politica)
    expect(r).toMatchObject({ ok: true })
  })

  it('su hashCriterios es el de los criterios extraídos', () => {
    expect(leer().hashCriterios).toBe(extraidos.hashCriterios)
  })

  it('rechaza el ejemplo si falta un criterio o si el head de la prueba no coincide', () => {
    const sinCriterio = leer()
    sinCriterio.criterios.pop()
    expect(validarReporte(sinCriterio, politica).ok).toBe(false)
    const otroHead = leer()
    otroHead.evidencia.propias[0].sha = 'f'.repeat(40)
    expect(validarReporte(otroHead, politica).ok).toBe(false)
  })
})
