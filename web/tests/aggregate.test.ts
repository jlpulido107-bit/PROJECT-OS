import { describe, expect, it } from 'vitest'
import {
  ageLabel, classifyEvidence, dailyPlans, dependenciesFor, executiveSummary, filterTasks, formatMinutes, indexTasks,
  isBlocked, latestSyncRun, mondayOf, paginate, parseTaskFilters, pendingDependencies, projectStats, sortTasks,
  sumMinutes, taskState, weekCapacity,
} from '@/lib/aggregate'
import { buildFixtureTabs } from '@/lib/fixtures'
import { TAB_HEADERS } from '@/lib/schema'
import { buildDataset } from '@/lib/table'

const TODAY = '2026-10-08' // jueves
const NOW = new Date('2026-10-08T18:00:00Z') // 12:00 en Mérida
const ds = buildDataset(buildFixtureTabs(TODAY), { source: 'fixtures', fetchedAt: NOW.getTime() })

describe('estado de tareas', () => {
  it('abierta, cerrada o sin estado', () => {
    expect(taskState({ estado: 'PENDIENTE' })).toBe('abierta')
    expect(taskState({ estado: 'COMPLETADO' })).toBe('cerrada')
    expect(taskState({ estado: 'CANCELADO' })).toBe('cerrada')
    expect(taskState({ estado: null })).toBe('sin-estado')
  })

  it('bloqueo solo cuenta en tareas abiertas', () => {
    expect(isBlocked({ estado: 'PENDIENTE', bloqueo: 'Falta acceso' })).toBe(true)
    expect(isBlocked({ estado: 'BLOQUEADO', bloqueo: null })).toBe(true)
    expect(isBlocked({ estado: 'COMPLETADO', bloqueo: 'histórico' })).toBe(false)
    expect(isBlocked({ estado: 'PENDIENTE', bloqueo: null })).toBe(false)
  })
})

describe('resumen ejecutivo (fixtures sintéticos)', () => {
  const s = executiveSummary(ds, NOW)

  it('cuenta proyectos y tareas sin inventar porcentajes', () => {
    expect(s.proyectos).toBe(4)
    expect(s.tareas).toMatchObject({ total: 5, abiertas: 3, cerradas: 1, sinEstado: 1 })
  })

  it('identifica bloqueos y dependencias pendientes', () => {
    expect(s.bloqueos.tareasBloqueadas?.map((t) => t.id)).toEqual(['DEMO-003'])
    // DEMO-002 depende de DEMO-001 (COMPLETADO) → resuelta; DEMO-005 depende de DEMO-003 → pendiente.
    expect(s.bloqueos.dependenciasPendientes?.map((d) => d.id)).toEqual(['DEMO-D2'])
  })

  it('suma minutos válidos y reporta sesiones sin minutos', () => {
    expect(s.tiempos).toMatchObject({ minutos: 195, sesiones: 4, sesionesSinMinutos: 1 })
    // Semana lunes 5 – domingo 11 de octubre: sesiones del 7 (90) y del 8 (45).
    expect(s.tiempos).toMatchObject({ minutosSemana: 135, semanaDesde: '2026-10-05', semanaHasta: '2026-10-11' })
  })

  it('elige la última sincronización por fecha, no por orden de fila', () => {
    expect(s.ultimoSync?.id).toBe('DEMO-RUN-2')
  })

  it('clasifica evidencias separando eventos observados de tareas validadas', () => {
    expect(s.evidencias).toEqual({
      total: 4, 'evento-observado': 1, 'vinculada-sin-validar': 1, 'tarea-validada': 1, 'vinculo-roto': 1,
    })
  })

  it('sin filas en TIEMPOS el total es "sin datos" (null), no 0', () => {
    const empty = buildDataset({ ...buildFixtureTabs(TODAY), TIEMPOS: [[...TAB_HEADERS.TIEMPOS]] }, { source: 'fixtures', fetchedAt: 0 })
    const summary = executiveSummary(empty, NOW)
    expect(summary.tiempos).toMatchObject({ minutos: null, sesiones: 0, minutosSemana: null })
  })

  it('una pestaña con esquema inválido produce null, no ceros', () => {
    const broken = buildDataset({ ...buildFixtureTabs(TODAY), TAREAS: [['TAREA_ID', 'TITULO']], SYNC_RUNS: undefined }, { source: 'fixtures', fetchedAt: 0 })
    const summary = executiveSummary(broken, NOW)
    expect(summary.tareas).toMatchObject({ total: null, abiertas: null })
    expect(summary.bloqueos).toEqual({ tareasBloqueadas: null, dependenciasPendientes: null })
    expect(summary.ultimoSync).toBeUndefined()
  })

  it('pestaña SYNC_RUNS válida pero vacía → null (sin ejecuciones)', () => {
    const noRuns = buildDataset({ ...buildFixtureTabs(TODAY), SYNC_RUNS: [[...TAB_HEADERS.SYNC_RUNS]] }, { source: 'fixtures', fetchedAt: 0 })
    expect(executiveSummary(noRuns, NOW).ultimoSync).toBeNull()
  })
})

describe('helpers', () => {
  it('sumMinutes devuelve null sin sesiones válidas', () => {
    expect(sumMinutes([])).toEqual({ minutos: null, sesiones: 0, sesionesSinMinutos: 0 })
  })

  it('latestSyncRun sin ejecuciones es null', () => {
    expect(latestSyncRun([])).toBeNull()
  })

  it('classifyEvidence', () => {
    const tasks = indexTasks(ds.tareas)
    expect(classifyEvidence({ tareaId: null }, tasks)).toBe('evento-observado')
    expect(classifyEvidence({ tareaId: 'DEMO-001' }, tasks)).toBe('tarea-validada')
    expect(classifyEvidence({ tareaId: 'DEMO-002' }, tasks)).toBe('vinculada-sin-validar')
    expect(classifyEvidence({ tareaId: 'NO-EXISTE' }, tasks)).toBe('vinculo-roto')
  })

  it('dependenciesFor muestra prerrequisitos y dependientes', () => {
    const deps = dependenciesFor('DEMO-003', ds)
    expect(deps.dependeDe).toEqual([])
    expect(deps.bloqueaA.map((d) => [d.dependencia.id, d.pendiente])).toEqual([['DEMO-D2', true]])
    expect(dependenciesFor('DEMO-002', ds).dependeDe.map((d) => d.pendiente)).toEqual([false])
  })

  it('pendingDependencies ignora dependencias inactivas y tareas dependientes cerradas', () => {
    const deps = [
      { id: 'X1', tareaId: 'DEMO-005', dependeDeTareaId: 'DEMO-003', tipo: null, estado: 'RESUELTA' },
      { id: 'X2', tareaId: 'DEMO-001', dependeDeTareaId: 'DEMO-003', tipo: null, estado: 'ACTIVA' },
    ]
    expect(pendingDependencies({ dependencias: deps, tareas: ds.tareas })).toEqual([])
  })

  it('projectStats', () => {
    expect(projectStats('POS', ds)).toMatchObject({
      hitos: 2, hitosCompletados: 1, tareas: 3, tareasAbiertas: 2, tareasBloqueadas: 1, evidencias: 3,
      minutos: { minutos: 135, sesiones: 3, sesionesSinMinutos: 1 },
    })
    expect(projectStats('DEV', ds)).toMatchObject({ hitos: 0, tareas: 0, minutos: { minutos: null } })
  })

  it('mondayOf', () => {
    expect(mondayOf('2026-10-08')).toBe('2026-10-05')
    expect(mondayOf('2026-10-05')).toBe('2026-10-05')
    expect(mondayOf('2026-10-11')).toBe('2026-10-05')
  })

  it('formatMinutes y ageLabel', () => {
    expect(formatMinutes(45)).toBe('45 min')
    expect(formatMinutes(120)).toBe('2 h')
    expect(formatMinutes(195)).toBe('3 h 15 min')
    expect(ageLabel(0, 30_000)).toBe('hace menos de 1 min')
    expect(ageLabel(0, 5 * 60_000)).toBe('hace 5 min')
  })
})

describe('filtros de tareas', () => {
  const ids = (f: Record<string, string>) => filterTasks(ds.tareas, parseTaskFilters(f)).map((t) => t.id).sort()

  it('por proyecto, estado (sin distinguir mayúsculas), responsable y prioridad', () => {
    expect(ids({ proyecto: 'POS' })).toEqual(['DEMO-001', 'DEMO-002', 'DEMO-003'])
    expect(ids({ estado: 'pendiente' })).toEqual(['DEMO-003', 'DEMO-005'])
    expect(ids({ responsable: 'otra persona demo' })).toEqual(['DEMO-003'])
    expect(ids({ prioridad: 'BAJA' })).toEqual(['DEMO-004'])
  })

  it('valores vacíos explícitos', () => {
    expect(ids({ estado: '__SIN__' })).toEqual(['DEMO-004'])
    expect(ids({ responsable: '__SIN__' })).toEqual(['DEMO-004'])
  })

  it('por bloqueo', () => {
    expect(ids({ bloqueo: 'si' })).toEqual(['DEMO-003'])
    expect(ids({ bloqueo: 'no' })).not.toContain('DEMO-003')
  })

  it('por rango de fechas (FECHA_LIMITE o FECHA_PLAN); sin fecha se excluye', () => {
    // Límites: DEMO-002 el 12, DEMO-005 el 17, DEMO-003 el 18; DEMO-004 no tiene fecha.
    expect(ids({ desde: '2026-10-10', hasta: '2026-10-20' })).toEqual(['DEMO-002', 'DEMO-003', 'DEMO-005'])
    expect(ids({ desde: '2026-10-13', hasta: '2026-10-17' })).toEqual(['DEMO-005'])
    expect(ids({ hasta: '2026-10-05' })).toEqual(['DEMO-001'])
  })

  it('búsqueda libre y parámetros mal formados', () => {
    expect(ids({ q: 'bloqueada' })).toEqual(['DEMO-003'])
    const f = parseTaskFilters({ desde: '10/10/2026', bloqueo: 'tal vez', pagina: '2' })
    expect(f).toMatchObject({ desde: undefined, bloqueo: undefined })
  })

  it('ordena abiertas primero, por prioridad y fecha límite', () => {
    expect(sortTasks(ds.tareas).map((t) => t.id)).toEqual(['DEMO-002', 'DEMO-005', 'DEMO-003', 'DEMO-004', 'DEMO-001'])
  })
})

describe('paginación', () => {
  const items = Array.from({ length: 53 }, (_, i) => i)
  it('limita la página al rango válido', () => {
    expect(paginate(items, '2', 25)).toMatchObject({ page: 2, pageCount: 3, from: 26, to: 50, total: 53 })
    expect(paginate(items, '99', 25)).toMatchObject({ page: 3, from: 51, to: 53 })
    expect(paginate(items, 'abc', 25).page).toBe(1)
    expect(paginate(items, '-4', 25).page).toBe(1)
    expect(paginate([], undefined, 25)).toMatchObject({ page: 1, pageCount: 1, from: 0, to: 0 })
  })
})

describe('capacidad y plan diario', () => {
  it('sin horas disponibles no calcula horas netas', () => {
    const [current, previous] = weekCapacity(ds)
    expect(current).toMatchObject({ desde: '2026-10-05', hasta: '2026-10-11', horasDisponibles: null, horasNetas: null })
    expect(current?.minutosReales).toMatchObject({ minutos: 135 })
    expect(current?.minutosPlaneados).toBe(150)
    expect(previous?.horasNetas).toBeCloseTo(17)
    expect(previous?.minutosReales).toMatchObject({ minutos: 60, sesiones: 1 })
    expect(previous?.minutosPlaneados).toBeNull()
    expect(previous?.asignaciones.map((a) => a.id)).toEqual(['DEMO-A1', 'DEMO-A2'])
  })

  it('ordena planes por fecha y elementos por ORDEN', () => {
    const [today, yesterday] = dailyPlans(ds)
    expect(today?.plan.id).toBe('DEMO-P1')
    expect(today?.items.map(({ item }) => item.id)).toEqual(['DEMO-PI1', 'DEMO-PI2'])
    expect(today?.minutosPlaneados).toBe(150)
    expect(today?.minutosReales).toMatchObject({ minutos: 45, sesionesSinMinutos: 1 })
    expect(yesterday?.minutosPlaneados).toBeNull()
  })
})
