import { describe, expect, it } from 'vitest'
import { addCivilDays } from '@/lib/planning/calendar'
import { planWeek } from '@/lib/planning/engine'
import { MIN_BLOCK_MIN } from '@/lib/planning/rules'
import { normalizeScenario } from '@/lib/planning/scenario'
import type { PlanningInput, PlanResult, Scenario } from '@/lib/planning/types'
import { deepFreeze, rng } from './helpers/planning-data'

/**
 * Pruebas de propiedades: 400 conjuntos de datos sintéticos aleatorios (semilla fija ⇒ reproducibles),
 * con escenarios aleatorios. Cada resultado debe cumplir todas las invariantes del contrato (§7).
 */
const CASES = 400
const MONDAY = '2026-10-05'
const STATES = ['PENDIENTE', 'PENDIENTE', 'PENDIENTE', 'EN_PROGRESO', 'EN_PROGRESO', 'BLOQUEADO', 'COMPLETADO', 'CANCELADO', null, 'REVISION']
const PRIORITIES = ['CRITICA', 'ALTA', 'MEDIA', 'BAJA', 'P1', null]

function randomCase(seed: number): { input: PlanningInput; scenario: Scenario; ref: string } {
  const r = rng(seed)
  const projectIds = ['POS', 'SIG', 'ECO', 'DEV'].slice(0, r.int(1, 4))
  const day = (from: number, to: number) => addCivilDays(MONDAY, r.int(from, to))
  const proyectos = projectIds.map((id) => ({ id, nombre: id, estado: r.chance(0.1) ? 'PAUSADO' : 'EN_PROGRESO', prioridad: r.pick(['ALTA', 'MEDIA', 'BAJA', null]) }))
  const nTasks = r.int(0, 25)
  const tareas = Array.from({ length: nTasks }, (_, i) => ({
    id: `T-${i + 1}`,
    proyectoId: r.chance(0.05) ? null : r.chance(0.05) ? 'ZZZ' : r.pick(projectIds),
    hitoId: null,
    titulo: `Tarea ${i + 1}`,
    estado: r.pick(STATES),
    prioridad: r.pick(PRIORITIES),
    fechaPlan: r.chance(0.3) ? day(-3, 12) : null,
    fechaLimite: r.chance(0.4) ? day(-7, 20) : null,
    horasEstimadas: r.chance(0.15) ? null : r.pick([0, 0.25, 0.5, 1, 2, 3.5, 6, 12, 40]),
    bloqueo: r.chance(0.08) ? 'Bloqueo' : null,
  }))
  const ids = tareas.map((t) => t.id)
  const dependencias = ids.length < 2 ? [] : Array.from({ length: r.int(0, 6) }, (_, i) => ({
    id: `D-${i + 1}`,
    tareaId: r.pick(ids),
    dependeDeTareaId: r.chance(0.08) ? 'T-999' : r.pick(ids),
    estado: r.pick(['ACTIVA', 'ACTIVA', 'ACTIVA', 'INACTIVA', null]),
  }))
  const capacidad = r.chance(0.12) ? [] : [{
    id: 'S41', fechaInicio: r.chance(0.9) ? MONDAY : addCivilDays(MONDAY, 2),
    horasDisponibles: r.chance(0.1) ? null : r.pick([0, 2, 5, 10, 20, 35, 60]),
    reservaPct: r.pick([null, 0, 0.1, 0.25, 0.5, 1]), estado: r.pick(['APROBADA', 'BORRADOR']),
  }]
  if (r.chance(0.05)) capacidad.push({ id: 'S41b', fechaInicio: MONDAY, horasDisponibles: 5, reservaPct: 0, estado: 'APROBADA' })
  const asignaciones = projectIds.filter(() => r.chance(0.3)).map((p, i) => ({ id: `A-${i}`, semanaId: 'S41', proyectoId: p, horasObjetivo: r.pick([0, 1, 3, 8, null]) }))
  const planes = Array.from({ length: r.int(0, 4) }, (_, i) => ({ id: `P-${i}`, fecha: day(0, 6), semanaId: 'S41', estado: r.pick(['PLANIFICADO', 'CERRADO', 'CANCELADO']), horasObjetivo: r.pick([null, 1, 2, 4, 9]) }))
  const planItems = planes.flatMap((p, i) => Array.from({ length: r.int(0, 3) }, (_, j) => ({
    id: `PI-${i}-${j}`, planId: p.id, tareaId: ids.length && r.chance(0.9) ? r.pick(ids) : null, orden: j + 1, minutosPlan: r.pick([null, 15, 30, 60, 120, 300]),
  })))
  const tiempos = Array.from({ length: r.int(0, 10) }, (_, i) => ({
    id: `S-${i}`, tareaId: ids.length ? r.pick(ids) : null, fecha: day(-10, 6), minutosReales: r.pick([null, 10, 30, 45, 90, 240]),
  }))
  const input: PlanningInput = {
    proyectos, hitos: [], tareas, dependencias, capacidad, asignaciones, planes, planItems, tiempos,
    pestanasNoDisponibles: r.chance(0.04) ? ['TIEMPOS'] : [],
    idsDuplicados: { TAREAS: ids.length && r.chance(0.1) ? [r.pick(ids)] : [], PROYECTOS: [], DEPENDENCIAS: [] },
  }
  const scenario = normalizeScenario({
    semana: r.chance(0.2) ? 'siguiente' : 'actual',
    ajusteHoras: r.pick([0, 0, -5, 3, -100]),
    reservaPct: r.chance(0.2) ? r.pick([0, 20, 100]) : null,
    horasSiFaltan: r.chance(0.3) ? r.pick([0, 8, 25]) : null,
    diasLaborables: r.pick([[1, 2, 3, 4, 5], [1, 3, 5], [6, 7], [1, 2, 3, 4, 5, 6, 7]]),
    horasSiSinEstimacion: r.chance(0.3) ? 1 : null,
    sobrecargaPct: r.pick([0, 0, 50, 200]),
    descontarRegistrado: r.chance(0.3),
    prioridadProyecto: r.chance(0.2) ? { [r.pick(projectIds)]: r.pick(['ALTA', 'BAJA']) } : {},
  })
  return { input, scenario, ref: day(0, 6) }
}

function checkInvariants(result: PlanResult, input: PlanningInput, scenario: Scenario) {
  const tasks = new Map(input.tareas.map((t) => [t.id, t]))
  const byTask = new Map<string, Array<{ fecha: string; minutos: number }>>()
  // Números válidos en todo el resultado: finitos y nunca negativos.
  const walk = (v: unknown, path: string) => {
    if (typeof v === 'number') expect(Number.isFinite(v) && v >= 0, `${path} = ${v}`).toBe(true)
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`)
  }
  walk(result, 'resultado')

  const cap = result.capacidad
  expect(cap.propuestoMin).toBeLessThanOrEqual(cap.colocableMin)
  expect(cap.colocableMin).toBeLessThanOrEqual(cap.libreMin)
  if (cap.netaMin !== null) expect(cap.libreMin).toBeLessThanOrEqual(cap.netaMin)
  if (result.estado === 'datos-insuficientes') expect(cap.propuestoMin).toBe(0)

  for (const d of result.dias) {
    expect(d.propuestoMin).toBe(d.items.reduce((a, i) => a + i.minutos, 0))
    expect(d.propuestoMin).toBeLessThanOrEqual(d.libreMin)
    if (d.items.length) {
      expect(d.esPasado).toBe(false)
      expect(d.fecha >= result.referencia.desde).toBe(true)
    }
    for (const item of d.items) {
      expect(Number.isInteger(item.minutos) && item.minutos > 0).toBe(true)
      const task = tasks.get(item.tareaId)!
      const planned = result.tareas.find((t) => t.id === item.tareaId)!
      // Nunca se recomienda una tarea no elegible.
      expect(planned.categoria).not.toBe('excluida')
      expect(['COMPLETADO', 'CANCELADO', 'BLOQUEADO']).not.toContain(task.estado)
      expect(task.estado).not.toBeNull()
      expect(task.bloqueo).toBeNull()
      expect(input.idsDuplicados.TAREAS).not.toContain(task.id)
      if (task.fechaPlan) expect(d.fecha >= task.fechaPlan).toBe(true)
      if (task.horasEstimadas === null) expect(scenario.horasSiSinEstimacion).not.toBeNull()
      // Orden de dependencias: ningún prerrequisito activo sin COMPLETADO.
      for (const dep of input.dependencias) {
        if (dep.tareaId !== task.id || !dep.dependeDeTareaId) continue
        if (dep.estado && ['RESUELTA', 'INACTIVA', 'CANCELADA'].includes(dep.estado)) continue
        expect(tasks.get(dep.dependeDeTareaId)?.estado).toBe('COMPLETADO')
      }
      byTask.set(item.tareaId, [...(byTask.get(item.tareaId) ?? []), { fecha: d.fecha, minutos: item.minutos }])
    }
    // Una tarea aparece como mucho una vez por día.
    expect(new Set(d.items.map((i) => i.tareaId)).size).toBe(d.items.length)
  }

  for (const t of result.tareas) {
    const scheduled = (byTask.get(t.id) ?? []).reduce((a, x) => a + x.minutos, 0)
    expect(t.propuestoMin).toBe(scheduled)
    expect(t.propuestoMin).toBeLessThanOrEqual(t.necesidadMin)
    // Fragmentos < MIN_BLOCK_MIN solo como último bloque de la tarea o en días cuya capacidad es menor.
    const list = byTask.get(t.id) ?? []
    list.forEach((x, i) => {
      if (x.minutos < MIN_BLOCK_MIN && i < list.length - 1) {
        const day = result.dias.find((d) => d.fecha === x.fecha)!
        expect(day.libreMin).toBeLessThan(MIN_BLOCK_MIN)
      }
    })
    if (t.categoria === 'excluida') expect(t.propuestoMin).toBe(0)
    expect(t.explicacion.length).toBeGreaterThan(0)
  }
  // Asignaciones: nada por encima de las horas objetivo del proyecto (menos lo ya usado).
  for (const p of result.proyectos) {
    if (p.asignadoMin !== null) expect(p.propuestoMin).toBeLessThanOrEqual(Math.max(0, p.asignadoMin - p.usadoMin))
  }
  expect(result.proyectos.reduce((a, p) => a + p.propuestoMin, 0)).toBe(cap.propuestoMin)
}

describe(`invariantes del planificador (${CASES} casos aleatorios reproducibles)`, () => {
  it('capacidad, elegibilidad, dependencias, asignaciones y números válidos', () => {
    let proposals = 0
    for (let seed = 1; seed <= CASES; seed++) {
      const { input, scenario, ref } = randomCase(seed)
      const result = planWeek(input, scenario, { referenceDate: ref })
      try {
        checkInvariants(result, input, scenario)
      } catch (error) {
        throw new Error(`Semilla ${seed}: ${(error as Error).message}`)
      }
      if (result.capacidad.propuestoMin > 0) proposals += 1
    }
    // Las semillas ejercitan de verdad el reparto (no solo casos vacíos).
    expect(proposals).toBeGreaterThan(CASES / 6)
  })

  it('determinismo: misma salida en dos ejecuciones y con filas barajadas; la entrada no se muta', () => {
    for (let seed = 1; seed <= CASES / 4; seed++) {
      const { input, scenario, ref } = randomCase(seed)
      const snapshot = structuredClone(input)
      const frozen = deepFreeze(structuredClone(input))
      const a = planWeek(frozen, scenario, { referenceDate: ref })
      const r = rng(seed * 7919)
      const shuffled: PlanningInput = {
        ...input,
        proyectos: r.shuffle(input.proyectos), tareas: r.shuffle(input.tareas), dependencias: r.shuffle(input.dependencias),
        capacidad: r.shuffle(input.capacidad), asignaciones: r.shuffle(input.asignaciones), planes: r.shuffle(input.planes),
        planItems: r.shuffle(input.planItems), tiempos: r.shuffle(input.tiempos),
      }
      const b = planWeek(shuffled, scenario, { referenceDate: ref })
      expect(b, `semilla ${seed}`).toEqual(a)
      expect(planWeek(input, scenario, { referenceDate: ref })).toEqual(a)
      expect(input).toEqual(snapshot)
    }
  })
})
