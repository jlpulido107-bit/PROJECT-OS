import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PlanningView } from '@/components/planning/planning-view'
import { MERIDA_TZ } from '@/lib/dates'
import { buildFixtureTabs } from '@/lib/fixtures'
import { esDelPropietario, misPendientes } from '@/lib/inicio'
import { huellaDatos } from '@/lib/planificacion-escenarios'
import { diasSemana } from '@/lib/planificacion-semana'
import { capaHoy } from '@/lib/planificacion-v2'
import { planWeek } from '@/lib/planning/engine'
import { planningInputFromDataset } from '@/lib/planning/input'
import { esDeAntigravity } from '@/lib/planning/rules'
import { DEFAULT_SCENARIO, normalizeScenario } from '@/lib/planning/scenario'
import type { PlanningInput, PlanResult, Scenario } from '@/lib/planning/types'
import { TAB_HEADERS, type TabName } from '@/lib/schema'
import { buildDataset } from '@/lib/table'
import type { RawTabs } from '@/lib/types'
import { baseInput, dep, task } from './helpers/planning-data'

/**
 * ORD-POS-181 (POS-071): Inicio y la planificación no cuentan como del propietario los encargos de Antigravity, que son
 * tareas de TAREAS con RESPONSABLE «Antigravity» (la convención es de ORD-POS-180). Solo datos sintéticos.
 */

type Row = Record<string, string>

/** Hoja sintética con todas las pestañas y solo las filas que se pasan. */
function hoja(rows: Partial<Record<TabName, Row[]>>) {
  const raw: RawTabs = {}
  for (const tab of Object.keys(TAB_HEADERS) as TabName[]) {
    const headers = TAB_HEADERS[tab] as readonly string[]
    raw[tab] = [[...headers], ...(rows[tab] ?? []).map((r) => headers.map((h) => r[h] ?? ''))]
  }
  return buildDataset(raw, { source: 'fixtures', fetchedAt: 0 })
}

const ENCARGO = ['Antigravity', 'antigravity', ' ANTIGRAVITY ', 'Antigravity (taller)']
const DEL_PROPIETARIO = ['Usuario', 'Persona demo', '', null]

describe('criterio 1: esDelPropietario excluye los encargos de Antigravity', () => {
  it('un RESPONSABLE que nombra a Antigravity no es el propietario', () => {
    for (const responsable of ENCARGO) {
      expect(esDeAntigravity(responsable), responsable).toBe(true)
      expect(esDelPropietario({ responsable }), responsable).toBe(false)
    }
  })

  it('caso negativo: lo demás sigue como estaba (propietario, vacío, Claude y Codex)', () => {
    for (const responsable of DEL_PROPIETARIO) {
      expect(esDeAntigravity(responsable), String(responsable)).toBe(false)
      expect(esDelPropietario({ responsable }), String(responsable)).toBe(true)
    }
    for (const responsable of ['Claude Code', 'Codex']) {
      expect(esDeAntigravity(responsable), responsable).toBe(false)
      expect(esDelPropietario({ responsable }), responsable).toBe(false)
    }
  })

  it('Inicio › Mis pendientes no lista un encargo vencido ni uno por vencer; las mismas filas del propietario, sí', () => {
    const HOY = '2026-10-25'
    const tareas = (agente: string): Row[] => [
      { TAREA_ID: 'POS-001', PROYECTO_ID: 'POS', TITULO: 'Mía vencida', ESTADO: 'PENDIENTE', RESPONSABLE: 'Usuario', FECHA_LIMITE: '2026-10-20' },
      { TAREA_ID: 'POS-002', PROYECTO_ID: 'POS', TITULO: 'Encargo vencido', ESTADO: 'PENDIENTE', RESPONSABLE: agente, FECHA_LIMITE: '2026-10-20' },
      { TAREA_ID: 'POS-003', PROYECTO_ID: 'POS', TITULO: 'Encargo por vencer', ESTADO: 'EN_PROGRESO', RESPONSABLE: agente, FECHA_LIMITE: '2026-10-28' },
      { TAREA_ID: 'POS-004', PROYECTO_ID: 'POS', TITULO: 'Mía por vencer', ESTADO: 'PENDIENTE', RESPONSABLE: '', FECHA_LIMITE: '2026-10-28' },
    ]
    const pendientes = (agente: string) => {
      const p = misPendientes(hoja({ TAREAS: tareas(agente) }), HOY, null, { prs: null, recurrentes: { motivo: 'sin FINANZAS' } })
      if (p.tareas.estado !== 'ok') throw new Error(p.tareas.motivo)
      return p.tareas.datos.map((t) => [t.tarea.id, t.marca])
    }
    expect(pendientes('Antigravity')).toEqual([['POS-001', 'vencido'], ['POS-004', 'proximo']])
    expect(pendientes('Usuario')).toEqual([['POS-001', 'vencido'], ['POS-002', 'vencido'], ['POS-003', 'proximo'], ['POS-004', 'proximo']])
  })

  it('Planificación › Hoy: «vencen hoy, fuera del plan» tampoco lo lista', () => {
    const MIERCOLES = '2026-10-28'
    const fuera = (responsable: string) => {
      const t = structuredClone(buildFixtureTabs(MIERCOLES)) as Record<string, unknown[][]>
      t.TAREAS![5]![8] = responsable // DEMO-005, RESPONSABLE
      t.TAREAS![5]![10] = MIERCOLES // FECHA_LIMITE = hoy; no está en el plan de hoy
      const ds = buildDataset(t as RawTabs, { source: 'fixtures', fetchedAt: 0 })
      const c = capaHoy(ds, planWeek(planningInputFromDataset(ds), DEFAULT_SCENARIO, { referenceDate: MIERCOLES, timeZone: MERIDA_TZ }))
      if (c.estado !== 'ok') throw new Error(c.estado)
      return c.fueraDelPlan.map((v) => v.tareaId)
    }
    expect(fuera('Antigravity')).toEqual([])
    expect(fuera('Persona demo')).toEqual(['DEMO-005'])
  })
})

// Semana del lunes 5 al domingo 11 de octubre de 2026, 20 h sin reserva (4 h por día); referencia el lunes.
const LUNES = '2026-10-05'
const plan = (input: PlanningInput, scenario: Partial<Record<keyof Scenario, unknown>> = {}) =>
  planWeek(input, normalizeScenario(scenario), { referenceDate: LUNES })
const propuestas = (r: PlanResult) => [...new Set(r.dias.flatMap((d) => d.items.map((i) => i.tareaId)))]
const refs = (r: PlanResult) => [...r.preguntas, ...r.conflictos].flatMap((i) => i.refs)
const codigos = (r: PlanResult) => [...r.preguntas, ...r.conflictos].map((i) => i.codigo)
const semana = (r: PlanResult) => {
  const s = diasSemana(r, [])
  if (s.estado !== 'ok') throw new Error(s.motivo)
  return s.datos
}

describe('criterio 2: la carga del plan no suma los encargos de Antigravity', () => {
  const mia = task('POS-1', 'POS', 2)
  const encargo = (extra: Partial<PlanningInput['tareas'][number]> = {}) => task('POS-2', 'POS', 3, { deAntigravity: true, ...extra })

  it('un encargo con horas no se propone ni suma demanda; la misma tarea sin la marca sí (caso negativo)', () => {
    const r = plan(baseInput({ tareas: [mia, encargo()] }))
    expect(r.tareas.map((t) => t.id)).toEqual(['POS-1'])
    expect(propuestas(r)).toEqual(['POS-1'])
    expect(r.capacidad.propuestoMin).toBe(120)
    expect(r.proyectos.find((p) => p.id === 'POS')).toMatchObject({ demandaMin: 120, presupuestoMin: 120, propuestoMin: 120, tareasPropuestas: 1 })
    expect(semana(r).planeadoMin).toBe(120)
    expect(r.resumen).toMatchObject({ elegibles: 1, propuestas: 1, excluidas: 0, deAntigravityOmitidas: 1 })

    const sinMarca = plan(baseInput({ tareas: [mia, task('POS-2', 'POS', 3)] }))
    expect(propuestas(sinMarca)).toEqual(['POS-1', 'POS-2'])
    expect(sinMarca.capacidad.propuestoMin).toBe(300)
    expect(semana(sinMarca).planeadoMin).toBe(300)
    expect(sinMarca.resumen.deAntigravityOmitidas).toBe(0)
  })

  it('sin horas (la convención) tampoco entra con «horas si falta la estimación», ni se pregunta por él', () => {
    const escenario = { horasSiSinEstimacion: 4 }
    const vencido = { horasEstimadas: null, fechaLimite: '2026-10-01', prioridad: 'P9' }
    const r = plan(baseInput({ tareas: [mia, encargo(vencido)] }), escenario)
    expect(r.capacidad.propuestoMin).toBe(120)
    expect(refs(r)).not.toContain('POS-2')
    expect(codigos(r)).toEqual([])

    // Caso negativo: sin la marca, el supuesto la planifica (4 h) y el motor avisa de ella.
    const sinMarca = plan(baseInput({ tareas: [mia, task('POS-2', 'POS', 3, vencido)] }), escenario)
    expect(sinMarca.capacidad.propuestoMin).toBe(360)
    expect(codigos(sinMarca)).toEqual(['prioridad-desconocida', 'tareas-vencidas'])
    expect(plan(baseInput({ tareas: [mia, task('POS-2', 'POS', 3, vencido)] })).preguntas.map((q) => q.codigo)).toEqual(['sin-estimacion'])
  })

  it('un encargo cerrado cuenta como cerrado, no como encargo', () => {
    const r = plan(baseInput({ tareas: [mia, encargo({ estado: 'COMPLETADO' })] }))
    expect(r.resumen).toMatchObject({ cerradasOmitidas: 1, deAntigravityOmitidas: 0 })
  })

  it('sigue contando como prerrequisito: quien depende de un encargo abierto espera, y se habilita al completarse', () => {
    const con = (estado: string) => plan(baseInput({
      tareas: [mia, encargo({ estado, horasEstimadas: null })],
      dependencias: [dep('D1', 'POS-1', 'POS-2')],
    }))
    const abierto = con('PENDIENTE')
    expect(abierto.tareas.find((t) => t.id === 'POS-1')!.motivos).toEqual(['dependencia-pendiente'])
    expect(codigos(abierto)).not.toContain('dependencia-inexistente')
    expect(abierto.capacidad.propuestoMin).toBe(0)
    expect(propuestas(con('COMPLETADO'))).toEqual(['POS-1'])
  })

  it('lo que el propietario ya registró sobre un encargo (PLAN_ITEMS, TIEMPOS) se respeta como uso; no se propone nada más de él', () => {
    const r = plan(baseInput({
      tareas: [mia, encargo()],
      planes: [{ id: 'P1', fecha: LUNES, semanaId: 'S41', estado: 'PLANIFICADO', horasObjetivo: null }],
      planItems: [{ id: 'PI1', planId: 'P1', tareaId: 'POS-2', orden: 1, minutosPlan: 60 }],
      tiempos: [{ id: 'T1', tareaId: 'POS-2', fecha: '2026-10-06', minutosReales: 30 }],
    }))
    expect(r.capacidad.usadoMin).toBe(90)
    expect(r.proyectos.find((p) => p.id === 'POS')).toMatchObject({ usadoMin: 90, demandaMin: 120, propuestoMin: 120 })
    expect(codigos(r)).not.toContain('plan-item-tarea-inexistente')
    expect(propuestas(r)).toEqual(['POS-1'])
  })

  it('un movimiento simulado sobre un encargo no lo coloca: avisa y no cambia nada', () => {
    const r = plan(baseInput({ tareas: [mia, encargo()] }), { fijadas: { 'POS-2': '2026-10-07' } })
    expect(propuestas(r)).toEqual(['POS-1'])
    expect(r.conflictos.map((c) => c.codigo)).toEqual(['fijada-sin-tiempo'])
  })
})

describe('criterio 2: de la hoja al plan (RESPONSABLE → marca → motor → Hoy y Semana)', () => {
  const MIERCOLES = '2026-10-28'
  /** Fixtures con 20 h registradas y sin plan del día: lo de hoy lo propone el motor (DEMO-002, la única elegible). */
  const conResponsable = (responsable: string) => {
    const t = structuredClone(buildFixtureTabs(MIERCOLES)) as Record<string, unknown[][]>
    t.CAPACIDAD_SEMANAL![1]![2] = '20'
    t.PLAN_DIARIO = [t.PLAN_DIARIO![0]!]
    t.PLAN_ITEMS = [t.PLAN_ITEMS![0]!]
    t.TAREAS![2]![8] = responsable // DEMO-002
    const ds = buildDataset(t as RawTabs, { source: 'fixtures', fetchedAt: 0 })
    const input = planningInputFromDataset(ds)
    const r = planWeek(input, DEFAULT_SCENARIO, { referenceDate: MIERCOLES, timeZone: MERIDA_TZ })
    return { input, r, hoy: capaHoy(ds, r) }
  }

  it('la tarea de Antigravity no sale en Hoy ni en las horas planeadas de la semana; con otro RESPONSABLE, sí', () => {
    const encargo = conResponsable('Antigravity')
    expect(encargo.r.tareas.map((t) => t.id)).not.toContain('DEMO-002')
    expect(encargo.r.resumen.deAntigravityOmitidas).toBe(1)
    expect(encargo.hoy).toMatchObject({ estado: 'ok', tarjetas: [], totalMin: 0 })
    expect(semana(encargo.r).planeadoMin).toBe(0)

    const mia = conResponsable('Persona demo')
    expect(mia.r.resumen.deAntigravityOmitidas).toBe(0)
    expect(mia.hoy.estado === 'ok' && mia.hoy.tarjetas.map((t) => t.tareaId)).toEqual(['DEMO-002'])
    expect(semana(mia.r).planeadoMin).toBe(390) // 6,5 h
  })

  it('de RESPONSABLE solo sale la marca: su texto no se proyecta y, sin encargos, la entrada es la de antes', () => {
    const encargo = conResponsable('Antigravity (taller)').input
    expect(encargo.tareas.filter((t) => t.deAntigravity).map((t) => t.id)).toEqual(['DEMO-002'])
    expect(JSON.stringify(encargo)).not.toMatch(/taller|Persona demo|responsable/i)

    const mia = conResponsable('Persona demo').input
    expect(mia.tareas.some((t) => 'deAntigravity' in t)).toBe(false)
    // La huella de los datos no depende del texto de RESPONSABLE, solo de la marca.
    expect(huellaDatos(conResponsable('Usuario').input)).toBe(huellaDatos(mia))
    expect(huellaDatos(encargo)).not.toBe(huellaDatos(mia))
    expect(huellaDatos(conResponsable('Antigravity').input)).toBe(huellaDatos(encargo))
  })
})

describe('la vista dice cuántos encargos dejó fuera', () => {
  const html = (tareas: PlanningInput['tareas']) => renderToStaticMarkup(createElement(PlanningView, {
    input: baseInput({ tareas }), referenceDate: LUNES, timeZone: MERIDA_TZ, hitosSemana: { estado: 'ok', datos: [] },
  }))
  const mia = task('POS-1', 'POS', 2)

  it('uno o varios, con palabras; el encargo no aparece en ninguna lista', () => {
    const uno = html([mia, task('POS-2', 'POS', 3, { deAntigravity: true, titulo: 'Investigar proveedores' })])
    expect(uno).toContain('1 encargo de Antigravity no se lista: no ocupa tu capacidad.')
    expect(uno).not.toMatch(/POS-2|Investigar proveedores/)
    expect(html([mia, task('POS-2', 'POS', 3, { deAntigravity: true }), task('POS-3', 'POS', null, { deAntigravity: true })]))
      .toContain('2 encargos de Antigravity no se listan: no ocupan tu capacidad.')
  })

  it('sin encargos no dice nada', () => {
    expect(html([mia, task('POS-2', 'POS', 3)])).not.toContain('Antigravity')
  })
})
