import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SinDesplegar, TablaSemanas } from '@/components/metricas'
import { lunesDe, metricas, percentil } from '@/lib/metricas'
import { WRITE_HEADERS } from '@/lib/operations/constants'
import { InMemoryTableStore, readView } from '@/lib/operations/table-store'
import type { Orden } from '@/lib/types'

/** /metricas (ORD-POS-072): cálculos con fixtures de ORDENES_CODEX y AUDITORIA. */

const orden = (id: string, estado: string, riesgo = 'BAJO'): Orden => ({
  id, proyectoId: 'POS', tareaId: 'POS-021', titulo: 't', objetivo: null, contexto: null, criterios: null, fueraDeAlcance: null,
  comoProbar: null, riesgo, sensible: null, estado, issueUrl: null, prUrl: null, notas: null, actualizadoEn: null,
})

let req = 0
/** Filas de AUDITORIA de una operación del dashboard (mismo formato que OperationsService.auditFirst). */
function op(operacion: string, id: string, fecha: string, campos: Record<string, [string, string]>, integra = true): string[][] {
  req++
  const requestId = `00000000-0000-4000-8000-${String(req).padStart(12, '0')}`
  const origen = `dashboard-v1.4;modo=sheets;op=${operacion};req=${requestId};h=${'a'.repeat(16)}`
  const entries = Object.entries(campos)
  const total = String(entries.length + (integra ? 0 : 1)).padStart(2, '0')
  return entries.map(([campo, [antes, despues]], i) => [
    `AUD-20261019100000-${req.toString(16).toUpperCase().padStart(4, '0')}-${String(i + 1).padStart(2, '0')}-${total}`,
    fecha, 'actor', 'ORDENES_CODEX', id, campo, antes, despues, origen,
  ])
}
const crear = (id: string, fecha: string) => op('orden.crear', id, fecha, { ORDEN_ID: ['', id], ESTADO: ['', 'BORRADOR'] })
const cerrar = (id: string, fecha: string, fusionado = true) =>
  op(fusionado ? 'orden.cerrar_fusionado' : 'orden.cerrar', id, fecha, { ESTADO: ['REVISADA', 'CERRADA'] })
const corregir = (id: string, fecha: string, clave: string) =>
  op('orden.corregir_lanzar', id, fecha, { SESION: ['', 'https://claude.ai/code/session_x'], CLAVE: ['', clave] })

async function vista(filas: string[][][]) {
  return readView(new InMemoryTableStore({ AUDITORIA: [[...WRITE_HEADERS.AUDITORIA], ...filas.flat()] }), 'AUDITORIA')
}

describe('utilidades', () => {
  it('lunesDe: lunes de la semana civil', () => {
    expect(lunesDe('2026-10-19')).toBe('2026-10-19') // lunes
    expect(lunesDe('2026-10-25')).toBe('2026-10-19') // domingo
    expect(lunesDe('2026-10-01')).toBe('2026-09-28')
  })

  it('percentil: mediana con par e impar y p90 por rango más cercano', () => {
    expect(percentil([], 50)).toBeNull()
    expect(percentil([3, 1, 2], 50)).toBe(2)
    expect(percentil([4, 1, 3, 2], 50)).toBe(2.5)
    expect(percentil([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9)
    expect(percentil([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 90)).toBe(10)
    expect(percentil([7], 90)).toBe(7)
  })
})

describe('metricas', () => {
  it('agrupa por semana de cierre: fusionadas, ciclo (mediana y p90), rondas y riesgo', async () => {
    const ordenes = [orden('ORD-POS-001', 'CERRADA'), orden('ORD-POS-002', 'CERRADA', 'MEDIO'), orden('ORD-POS-003', 'CERRADA', 'MEDIO'), orden('ORD-POS-004', 'CERRADA')]
    const audit = await vista([
      crear('ORD-POS-001', '2026-10-19T10:00:00-06:00'), cerrar('ORD-POS-001', '2026-10-20T10:00:00-06:00'),
      crear('ORD-POS-002', '2026-10-18T10:00:00-06:00'), corregir('ORD-POS-002', '2026-10-21T09:00:00-06:00', 'k1'),
      corregir('ORD-POS-002', '2026-10-21T11:00:00-06:00', 'k2'), cerrar('ORD-POS-002', '2026-10-22T10:00:00-06:00'),
      crear('ORD-POS-003', '2026-10-20T10:00:00-06:00'), cerrar('ORD-POS-003', '2026-10-25T22:00:00-06:00', false),
      crear('ORD-POS-004', '2026-10-01T10:00:00-06:00'), cerrar('ORD-POS-004', '2026-10-27T10:00:00-06:00'),
    ])
    const m = metricas(ordenes, audit)
    expect(m.semanas.map((s) => s.semana)).toEqual(['2026-10-26', '2026-10-19'])
    const s = m.semanas[1]!
    expect(s.fusionadas).toBe(2)
    expect(s.cerradasSinConfirmar).toBe(1)
    // Ciclos: 1 d, 4 d y 5,5 d → mediana 4, p90 5,5.
    expect(s.ciclo).toEqual({ n: 3, medianaDias: 4, p90Dias: 5.5 })
    expect(s.rondas).toEqual({ total: 2, promedio: 0.7 })
    expect(s.porRiesgo).toEqual({ BAJO: 1, MEDIO: 2, ALTO: 0, SIN_RIESGO: 0 })
    expect(m.semanas[0]).toMatchObject({ fusionadas: 1, ciclo: { n: 1, medianaDias: 26, p90Dias: 26 } })
    expect(m.cerradasSinAuditoria).toEqual([])
    expect(m.sinAlta).toEqual([])
  })

  it('el 25 a las 22:00 en Mérida sigue en la semana del 19 (no en la UTC del 26)', async () => {
    const m = metricas([orden('ORD-POS-001', 'CERRADA')], await vista([cerrar('ORD-POS-001', '2026-10-25T22:00:00-06:00')]))
    expect(m.semanas.map((s) => s.semana)).toEqual(['2026-10-19'])
  })

  it('sin alta no hay ciclo; CERRADA sin cierre auditado queda fuera; una orden reabierta en la hoja no cuenta', async () => {
    const ordenes = [orden('ORD-POS-001', 'CERRADA'), orden('ORD-POS-002', 'CERRADA'), orden('ORD-POS-003', 'REVISADA')]
    const audit = await vista([cerrar('ORD-POS-001', '2026-10-20T10:00:00-06:00'), cerrar('ORD-POS-003', '2026-10-20T10:00:00-06:00')])
    const m = metricas(ordenes, audit)
    expect(m.semanas).toHaveLength(1)
    expect(m.semanas[0]).toMatchObject({ fusionadas: 1, ciclo: { n: 0, medianaDias: null, p90Dias: null } })
    expect(m.sinAlta).toEqual(['ORD-POS-001'])
    expect(m.cerradasSinAuditoria).toEqual(['ORD-POS-002'])
  })

  it('ignora operaciones parciales, de otras entidades o ajenas al dashboard, y cuenta una ronda por CLAVE', async () => {
    const ordenes = [orden('ORD-POS-001', 'CERRADA', 'RARO')]
    const ajena = [['AUD-X', '2026-10-21T10:00:00-06:00', 'a', 'ORDENES_CODEX', 'ORD-POS-001', 'ESTADO', 'REVISADA', 'CERRADA', 'a mano']]
    const audit = await vista([
      crear('ORD-POS-001', '2026-10-19T10:00:00-06:00'),
      corregir('ORD-POS-001', '2026-10-19T11:00:00-06:00', 'k1'), corregir('ORD-POS-001', '2026-10-19T12:00:00-06:00', 'k1'),
      op('orden.corregir_lanzar', 'ORD-POS-001', '2026-10-19T13:00:00-06:00', { SESION: ['', 's'], CLAVE: ['', 'k2'] }, false),
      ajena,
      cerrar('ORD-POS-001', '2026-10-20T10:00:00-06:00'),
    ])
    const m = metricas(ordenes, audit)
    expect(m.eventos[0]).toMatchObject({ riesgo: 'SIN_RIESGO', rondas: 1 })
    expect(m.semanas[0]!.porRiesgo.SIN_RIESGO).toBe(1)
  })

  it('AUDITORIA vacía: sin semanas y todas las CERRADA se listan como sin cierre auditado', async () => {
    const m = metricas([orden('ORD-POS-001', 'CERRADA'), orden('ORD-POS-002', 'BORRADOR')], await vista([]))
    expect(m.semanas).toEqual([])
    expect(m.cerradasSinAuditoria).toEqual(['ORD-POS-001'])
  })
})

describe('render', () => {
  it('tabla semanal y «sin dato» de despliegue', async () => {
    const m = metricas([orden('ORD-POS-001', 'CERRADA', 'MEDIO')], await vista([
      crear('ORD-POS-001', '2026-10-19T10:00:00-06:00'), cerrar('ORD-POS-001', '2026-10-21T10:00:00-06:00'),
    ]))
    const tabla = renderToStaticMarkup(createElement(TablaSemanas, { m }))
    expect(tabla).toContain('19 oct 2026')
    expect(tabla).toContain('2 d')
    expect(tabla).toContain('MEDIO: 1')
    expect(renderToStaticMarkup(createElement(TablaSemanas, { m: { ...m, semanas: [] } }))).toContain('No hay órdenes cerradas')
    expect(renderToStaticMarkup(createElement(SinDesplegar, { fusionadas: 3 }))).toContain('Sin dato')
  })
})
