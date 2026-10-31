import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { HoyView } from '@/components/planning/hoy'
import { MERIDA_TZ } from '@/lib/dates'
import { buildFixtureTabs } from '@/lib/fixtures'
import { capaHoy, etiqueta, fechaCorta, type CapaHoy } from '@/lib/planificacion-v2'
import { planWeek } from '@/lib/planning/engine'
import { planningInputFromDataset } from '@/lib/planning/input'
import { DEFAULT_SCENARIO } from '@/lib/planning/scenario'
import { TAREAS_INSTRUCCIONES } from '@/lib/schema'
import { buildDataset } from '@/lib/table'
import type { RawTabs } from '@/lib/types'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }))

/** Planificación v2 F1 (ORD-POS-120): regla de lenguaje (§2) y capa Hoy (§3). Solo datos sintéticos. */

const MIERCOLES = '2026-10-28'
const SABADO = '2026-10-31'

type Tabs = Record<string, unknown[][]>

function tabs(today: string, cambiar: (t: Tabs) => void = () => undefined): Tabs {
  const t = structuredClone(buildFixtureTabs(today)) as Tabs
  cambiar(t)
  return t
}

function capa(today: string, t: Tabs): CapaHoy {
  const ds = buildDataset(t as RawTabs, { source: 'fixtures', fetchedAt: 0 })
  return capaHoy(ds, planWeek(planningInputFromDataset(ds), DEFAULT_SCENARIO, { referenceDate: today, timeZone: MERIDA_TZ }))
}

/** Semana con 20 h registradas y sin PLAN_DIARIO: todo lo de hoy lo propone el motor. */
function conCapacidadSinPlan(t: Tabs) {
  t.CAPACIDAD_SEMANAL![1]![2] = '20'
  t.PLAN_DIARIO = [t.PLAN_DIARIO![0]!]
  t.PLAN_ITEMS = [t.PLAN_ITEMS![0]!]
}

const html = (c: CapaHoy, puedeCerrar: boolean) => renderToStaticMarkup(createElement(HoyView, { capa: c, puedeCerrar }))

describe('etiqueta (§2, criterio 1)', () => {
  it('primero el nombre y después el ID', () => {
    expect(etiqueta({ tipo: 'tarea', id: 'POS-041', titulo: 'Probar el corte de fin de mes' }))
      .toEqual({ nombre: 'Probar el corte de fin de mes', id: 'POS-041', texto: 'Probar el corte de fin de mes · POS-041' })
    expect(etiqueta({ tipo: 'orden', id: 'ORD-POS-118', titulo: 'Diseño de Planificación' }).texto).toBe('Diseño de Planificación · ORD-POS-118')
    expect(etiqueta({ tipo: 'hito', id: 'POS-H2', nombre: 'Dashboard usable a diario' }).texto).toBe('Dashboard usable a diario · POS-H2')
    expect(etiqueta({ tipo: 'decision', id: 'DEC-POS-018', asunto: 'Agente de finanzas' }).texto).toBe('Agente de finanzas · DEC-POS-018')
  })

  it('sin nombre, el texto indicado; vacío o solo espacios cuenta como sin nombre', () => {
    expect(etiqueta({ tipo: 'tarea', id: 'POS-041', titulo: null }).texto).toBe('(tarea sin título) · POS-041')
    expect(etiqueta({ tipo: 'tarea', id: 'POS-041', titulo: '   ' }).texto).toBe('(tarea sin título) · POS-041')
    expect(etiqueta({ tipo: 'orden', id: 'ORD-POS-1', titulo: '' }).texto).toBe('(orden sin título) · ORD-POS-1')
    expect(etiqueta({ tipo: 'hito', id: 'POS-H9', nombre: null }).texto).toBe('(hito sin nombre) · POS-H9')
    expect(etiqueta({ tipo: 'decision', id: 'DEC-POS-9', asunto: null }).texto).toBe('(decisión sin asunto) · DEC-POS-9')
  })

  it('el proyecto se muestra por su nombre; el ID solo si no lo tiene, con «(sin nombre)»', () => {
    expect(etiqueta({ tipo: 'proyecto', id: 'POS', nombre: 'PROJECT-OS' })).toEqual({ nombre: 'PROJECT-OS', id: null, texto: 'PROJECT-OS' })
    expect(etiqueta({ tipo: 'proyecto', id: 'POS', nombre: null }).texto).toBe('(sin nombre) · POS')
  })

  it('un PR lleva el título de su orden o, sin él, solo su número', () => {
    expect(etiqueta({ tipo: 'pr', numero: 271, titulo: 'Diseño de Planificación' }).texto).toBe('PR #271 de Diseño de Planificación')
    expect(etiqueta({ tipo: 'pr', numero: 271, titulo: null }).texto).toBe('PR #271')
  })

  it('fechas con día de la semana', () => {
    expect(fechaCorta('2026-10-30')).toBe('vie 30 oct')
    expect(fechaCorta('2026-11-02')).toBe('lun 2 nov')
  })
})

describe('capa Hoy (§3, criterios 2 y 3)', () => {
  it('ok con el plan registrado de hoy: en su orden, con nombre, proyecto, minutos y «ya llevas»', () => {
    const c = capa(MIERCOLES, tabs(MIERCOLES))
    expect(c.estado).toBe('ok')
    if (c.estado !== 'ok') return
    expect(c.tarjetas.map((t) => [t.tareaId, t.minutos, t.origen])).toEqual([['DEMO-002', 120, 'registrado'], ['DEMO-003', 30, 'registrado']])
    expect(c.tarjetas[0]!.etiqueta.texto).toBe('Tarea demo en curso · DEMO-002')
    expect(c.tarjetas[0]!.proyecto).toEqual({ nombre: 'PROJECT-OS', id: null, texto: 'PROJECT-OS' })
    expect(c.tarjetas[0]!.registradoMin).toBe(45)
    expect(c.tarjetas[0]!.cierre).toEqual({ id: 'DEMO-002', version: 2, criterioTerminado: 'Panel accesible en móvil y escritorio' })
    expect(c.totalMin).toBe(150)
  })

  it('ok con lo que propone el motor cuando no hay plan registrado', () => {
    const c = capa(MIERCOLES, tabs(MIERCOLES, conCapacidadSinPlan))
    expect(c.estado).toBe('ok')
    if (c.estado !== 'ok') return
    expect(c.tarjetas.length).toBeGreaterThan(0)
    expect(c.tarjetas.every((t) => t.origen === 'propuesto' && t.minutos > 0)).toBe(true)
    expect(c.capacidadMin).not.toBeNull()
    expect(c.totalMin).toBeLessThanOrEqual(c.capacidadMin!)
  })

  it('omite las tareas cerradas e incluye las instrucciones si la columna existe', () => {
    const c = capa(MIERCOLES, tabs(MIERCOLES, (t) => {
      t.TAREAS = [[...t.TAREAS![0]!, TAREAS_INSTRUCCIONES], ...t.TAREAS!.slice(1)]
      t.TAREAS![2]![16] = '1. Abrir la vista\n2. Probar en móvil' // DEMO-002
      t.TAREAS![3]![6] = 'COMPLETADO' // DEMO-003
    }))
    if (c.estado !== 'ok') throw new Error(c.estado)
    expect(c.tarjetas.map((t) => t.tareaId)).toEqual(['DEMO-002'])
    expect(c.tarjetas[0]!.instrucciones).toBe('1. Abrir la vista\n2. Probar en móvil')
    expect(html(c, false)).toContain('Instrucciones (2 pasos)')
  })

  it('«vencen hoy fuera del plan»: abiertas del propietario con límite hoy que no están en el plan', () => {
    const c = capa(MIERCOLES, tabs(MIERCOLES, (t) => {
      t.TAREAS![5]![10] = MIERCOLES // DEMO-005, fuera del plan
      t.TAREAS![2]![10] = MIERCOLES // DEMO-002, en el plan: no se repite
    }))
    if (c.estado !== 'ok') throw new Error(c.estado)
    expect(c.fueraDelPlan.map((v) => v.etiqueta.texto)).toEqual(['Tarea demo pendiente · DEMO-005'])
    expect(c.tarjetas.find((t) => t.tareaId === 'DEMO-002')!.venceHoy).toBe(true)
    expect(html(c, false)).toContain('También vencen hoy, fuera del plan:')
  })

  it('sin-datos si PLAN_ITEMS, PLAN_DIARIO o TAREAS no son válidas, con el motivo', () => {
    for (const tab of ['PLAN_ITEMS', 'PLAN_DIARIO', 'TAREAS']) {
      const c = capa(MIERCOLES, tabs(MIERCOLES, (t) => { t[tab] = [['X_ID']] }))
      expect(c).toMatchObject({ estado: 'sin-datos' })
      if (c.estado === 'sin-datos') expect(c.motivo).toContain(tab)
    }
  })

  it('sin-datos sin capacidad registrada ni plan de hoy: nunca «0 tareas»', () => {
    const c = capa(MIERCOLES, tabs(MIERCOLES, (t) => { t.PLAN_DIARIO = [t.PLAN_DIARIO![0]!] }))
    expect(c).toMatchObject({ estado: 'sin-datos' })
    if (c.estado === 'sin-datos') expect(c.motivo).toContain('CAPACIDAD_SEMANAL')
    const out = html(c, true)
    expect(out).toContain('Sin datos.')
    expect(out).not.toMatch(/0 tareas|Marcar completada/)
  })

  it('día no laborable sin plan registrado', () => {
    const c = capa(SABADO, tabs(SABADO, conCapacidadSinPlan))
    expect(c).toMatchObject({ estado: 'no-laborable', fecha: SABADO })
    expect(html(c, true)).toContain('Hoy · sáb 31 oct')
  })

  it('día laborable sin nada que proponer: «nada planeado para hoy», no un 0', () => {
    const c = capa(MIERCOLES, tabs(MIERCOLES, (t) => {
      conCapacidadSinPlan(t)
      for (const row of t.TAREAS!.slice(1)) if (row[0]) row[6] = 'COMPLETADO'
    }))
    expect(c).toMatchObject({ estado: 'ok', tarjetas: [] })
    expect(html(c, true)).toContain('Nada planeado para hoy.')
    expect(html(c, true)).not.toContain('0 tareas')
  })
})

describe('tarjetas y botón de cierre (criterio 2)', () => {
  const c = capa(MIERCOLES, tabs(MIERCOLES))

  it('nombre antes que el ID, proyecto, minutos y «ya llevas»', () => {
    const out = html(c, false)
    expect(out).toContain('Hoy · mié 28 oct')
    expect(out).toContain('2 tareas · 2 h 30 min')
    expect(out).toMatch(/Tarea demo en curso · <a [^>]*class="mono small"[^>]*>DEMO-002<\/a>/)
    expect(out).toContain('PROJECT-OS')
    expect(out).toContain('ya llevas 45 min')
    expect(out).toContain('(sin instrucciones)')
  })

  it('con puedeCerrarTareas, el CompleteTaskForm de siempre', () => {
    const out = html(c, true)
    expect(out.match(/Marcar completada/g)?.length).toBe(2)
    expect(out).not.toContain('El cierre lo hace el propietario')
  })

  it('sin puedeCerrarTareas no hay botón y la tarjeta lo dice', () => {
    const out = html(c, false)
    expect(out).not.toContain('Marcar completada')
    expect(out.match(/El cierre lo hace el propietario/g)?.length).toBe(2)
  })
})

describe('página /planificacion (criterios 2 y 4)', () => {
  const page = readFileSync(path.join(import.meta.dirname, '..', 'src', 'app', '(private)', 'planificacion', 'page.tsx'), 'utf8')

  it('Hoy arriba y la vista actual debajo, plegada como «Detalle del plan», con la misma entrada', () => {
    const hoy = page.indexOf('<HoyView')
    const detalle = page.indexOf('<summary>Detalle del plan</summary>')
    expect(hoy).toBeGreaterThan(0)
    expect(detalle).toBeGreaterThan(hoy)
    expect(page.indexOf('<PlanningView input={input}')).toBeGreaterThan(detalle)
  })

  it('el botón depende de puedeCerrarTareas y la capa no escribe', () => {
    expect(page).toMatch(/puedeCerrarTareas\(user\.email\)/)
    const lib = readFileSync(path.join(import.meta.dirname, '..', 'src', 'lib', 'planificacion-v2.ts'), 'utf8')
    expect(lib).not.toMatch(/fetch\(|process\.env|Date\.now\(|new Date\(\s*\)/)
  })
})
