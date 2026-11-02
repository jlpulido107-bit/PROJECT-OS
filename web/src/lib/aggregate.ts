import { addDays, daysBetween, todayInMerida } from './dates'
import {
  BLOCKED_TASK_STATE, CLOSED_TASK_STATES, COMPLETED_STATE, INACTIVE_DEPENDENCY_STATES, type TabName,
} from './schema'
import type { Capacidad, Dataset, Dependencia, Evidencia, PlanDiario, PlanItem, SyncRun, Tarea, Tiempo } from './types'

/**
 * Agregaciones puras sobre el conjunto de datos. Principios:
 * - Un total sin filas de origen es `null` ("sin datos"), nunca un 0 engañoso.
 * - COMPLETADO es el estado registrado en Sheets; el dashboard no cierra ni infiere tareas.
 * - Un commit/PR es actividad observada, no avance de una tarea.
 */

export type TaskState = 'abierta' | 'cerrada' | 'sin-estado'

export function taskState(t: Pick<Tarea, 'estado'>): TaskState {
  if (!t.estado) return 'sin-estado'
  return CLOSED_TASK_STATES.has(t.estado) ? 'cerrada' : 'abierta'
}

export function isBlocked(t: Pick<Tarea, 'estado' | 'bloqueo'>): boolean {
  return taskState(t) === 'abierta' && (t.bloqueo !== null || t.estado === BLOCKED_TASK_STATE)
}

export function dependencyIsActive(d: Pick<Dependencia, 'estado'>): boolean {
  return !d.estado || !INACTIVE_DEPENDENCY_STATES.has(d.estado)
}

export interface DependencyView {
  dependencia: Dependencia
  /** Tarea relacionada (prerrequisito o dependiente), si existe en TAREAS. */
  tarea: Tarea | null
  /** El prerrequisito aún no tiene estado COMPLETADO registrado. */
  pendiente: boolean
}

export function indexTasks(tareas: Tarea[]): Map<string, Tarea> {
  return new Map(tareas.map((t) => [t.id, t]))
}

/** Prerrequisitos de una tarea y tareas que dependen de ella. */
export function dependenciesFor(taskId: string, ds: Pick<Dataset, 'dependencias' | 'tareas'>) {
  const byId = indexTasks(ds.tareas)
  const dependeDe: DependencyView[] = []
  const bloqueaA: DependencyView[] = []
  for (const d of ds.dependencias) {
    if (d.tareaId === taskId && d.dependeDeTareaId) {
      const prereq = byId.get(d.dependeDeTareaId) ?? null
      dependeDe.push({ dependencia: d, tarea: prereq, pendiente: dependencyIsActive(d) && prereq?.estado !== COMPLETED_STATE })
    }
    if (d.dependeDeTareaId === taskId && d.tareaId) {
      const self = byId.get(taskId) ?? null
      bloqueaA.push({ dependencia: d, tarea: byId.get(d.tareaId) ?? null, pendiente: dependencyIsActive(d) && self?.estado !== COMPLETED_STATE })
    }
  }
  return { dependeDe, bloqueaA }
}

/** Dependencias activas cuyo prerrequisito no está COMPLETADO y cuya tarea dependiente sigue abierta. */
export function pendingDependencies(ds: Pick<Dataset, 'dependencias' | 'tareas'>): Dependencia[] {
  const byId = indexTasks(ds.tareas)
  return ds.dependencias.filter((d) => {
    if (!dependencyIsActive(d) || !d.tareaId || !d.dependeDeTareaId) return false
    const dependent = byId.get(d.tareaId)
    if (dependent && taskState(dependent) !== 'abierta') return false
    return byId.get(d.dependeDeTareaId)?.estado !== COMPLETED_STATE
  })
}

export interface MinutesTotal {
  /** Suma de minutos válidos; `null` si no hay ninguna sesión con minutos válidos. */
  minutos: number | null
  sesiones: number
  /** Sesiones con MINUTOS_REALES vacío o inválido (no suman). */
  sesionesSinMinutos: number
}

export function sumMinutes(tiempos: Tiempo[]): MinutesTotal {
  let minutos = 0
  let validas = 0
  for (const t of tiempos) {
    if (t.minutosReales === null) continue
    minutos += t.minutosReales
    validas += 1
  }
  return { minutos: validas > 0 ? minutos : null, sesiones: tiempos.length, sesionesSinMinutos: tiempos.length - validas }
}

export function latestSyncRun(runs: SyncRun[]): SyncRun | null {
  let best: SyncRun | null = null
  let bestTime = -Infinity
  for (const run of runs) {
    const time = run.fin?.epochMs ?? run.inicio?.epochMs ?? -Infinity
    if (best === null || time > bestTime) {
      best = run
      bestTime = time
    }
  }
  return best
}

export type EvidenceClass = 'evento-observado' | 'vinculada-sin-validar' | 'tarea-validada' | 'vinculo-roto'

/**
 * Distingue actividad observada de tarea validada:
 * - evento-observado: evidencia sin TAREA_ID (p. ej. commit sincronizado desde GitHub).
 * - vinculada-sin-validar: ligada a una tarea cuyo estado registrado no es COMPLETADO.
 * - tarea-validada: ligada a una tarea con estado COMPLETADO registrado por una persona en Sheets.
 * - vinculo-roto: TAREA_ID que no existe en TAREAS.
 */
export function classifyEvidence(e: Pick<Evidencia, 'tareaId'>, tasks: Map<string, Tarea>): EvidenceClass {
  if (!e.tareaId) return 'evento-observado'
  const task = tasks.get(e.tareaId)
  if (!task) return 'vinculo-roto'
  return task.estado === COMPLETED_STATE ? 'tarea-validada' : 'vinculada-sin-validar'
}

export interface ExecutiveSummary {
  proyectos: number | null
  tareas: {
    total: number | null
    abiertas: number | null
    cerradas: number | null
    sinEstado: number | null
    porEstado: Array<[string, number]>
  }
  bloqueos: {
    tareasBloqueadas: Tarea[] | null
    dependenciasPendientes: Dependencia[] | null
  }
  tiempos: (MinutesTotal & { minutosSemana: number | null; semanaDesde: string; semanaHasta: string }) | null
  ultimoSync: SyncRun | null | undefined
  evidencias: Record<EvidenceClass, number> & { total: number } | null
}

function okTab(ds: Dataset, ...tabs: TabName[]): boolean {
  return tabs.every((t) => ds.tabs[t]?.ok)
}

/** Lunes de la semana (fecha civil) que contiene `day`. */
export function mondayOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0 = domingo
  return addDays(day, -((dow + 6) % 7))
}

export function executiveSummary(ds: Dataset, now: Date = new Date()): ExecutiveSummary {
  const tareasOk = okTab(ds, 'TAREAS')
  const porEstado = new Map<string, number>()
  for (const t of ds.tareas) {
    const key = t.estado ?? 'SIN ESTADO'
    porEstado.set(key, (porEstado.get(key) ?? 0) + 1)
  }
  const states = ds.tareas.map(taskState)
  const today = todayInMerida(now)
  const weekStart = mondayOf(today)
  const weekEnd = addDays(weekStart, 6)
  const tiemposSemana = ds.tiempos.filter((t) => t.fecha !== null && t.fecha >= weekStart && t.fecha <= weekEnd)

  const tasks = indexTasks(ds.tareas)
  const evidenceCounts = { 'evento-observado': 0, 'vinculada-sin-validar': 0, 'tarea-validada': 0, 'vinculo-roto': 0 }
  for (const e of ds.evidencias) evidenceCounts[classifyEvidence(e, tasks)] += 1

  return {
    proyectos: okTab(ds, 'PROYECTOS') ? ds.proyectos.length : null,
    tareas: {
      total: tareasOk ? ds.tareas.length : null,
      abiertas: tareasOk ? states.filter((s) => s === 'abierta').length : null,
      cerradas: tareasOk ? states.filter((s) => s === 'cerrada').length : null,
      sinEstado: tareasOk ? states.filter((s) => s === 'sin-estado').length : null,
      porEstado: [...porEstado.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    },
    bloqueos: {
      tareasBloqueadas: tareasOk ? ds.tareas.filter(isBlocked) : null,
      dependenciasPendientes: okTab(ds, 'TAREAS', 'DEPENDENCIAS') ? pendingDependencies(ds) : null,
    },
    tiempos: okTab(ds, 'TIEMPOS')
      ? { ...sumMinutes(ds.tiempos), minutosSemana: sumMinutes(tiemposSemana).minutos, semanaDesde: weekStart, semanaHasta: weekEnd }
      : null,
    // undefined = pestaña no disponible; null = pestaña sin ejecuciones registradas.
    ultimoSync: okTab(ds, 'SYNC_RUNS') ? latestSyncRun(ds.syncRuns) : undefined,
    evidencias: okTab(ds, 'EVIDENCIAS') ? { ...evidenceCounts, total: ds.evidencias.length } : null,
  }
}

export interface ProjectStats {
  hitos: number
  hitosCompletados: number
  tareas: number
  tareasAbiertas: number
  tareasBloqueadas: number
  evidencias: number
  minutos: MinutesTotal
}

export function projectStats(projectId: string, ds: Dataset): ProjectStats {
  const tareas = ds.tareas.filter((t) => t.proyectoId === projectId)
  const taskIds = new Set(tareas.map((t) => t.id))
  const hitos = ds.hitos.filter((h) => h.proyectoId === projectId)
  return {
    hitos: hitos.length,
    hitosCompletados: hitos.filter((h) => h.estado === COMPLETED_STATE).length,
    tareas: tareas.length,
    tareasAbiertas: tareas.filter((t) => taskState(t) === 'abierta').length,
    tareasBloqueadas: tareas.filter(isBlocked).length,
    evidencias: ds.evidencias.filter((e) => e.proyectoId === projectId).length,
    minutos: sumMinutes(ds.tiempos.filter((t) => t.tareaId !== null && taskIds.has(t.tareaId))),
  }
}

/* ----------------------------- Filtros de tareas ----------------------------- */

export interface TaskFilters {
  proyecto?: string
  estado?: string
  responsable?: string
  prioridad?: string
  /** Rango inclusivo sobre FECHA_LIMITE, o FECHA_PLAN si no hay límite. */
  desde?: string
  hasta?: string
  bloqueo?: 'si' | 'no'
  /** Texto libre sobre ID, título y descripción. */
  q?: string
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const SIN = '__SIN__'
export const FILTER_EMPTY_VALUE = SIN
/** Estado «Abiertas» de /tareas (ORD-POS-130): todo lo que no está en CLOSED_TASK_STATES, sin estado incluido. */
export const FILTER_OPEN_VALUE = '__ABIERTAS__'
const TASK_FILTER_KEYS = ['proyecto', 'estado', 'responsable', 'prioridad', 'desde', 'hasta', 'bloqueo', 'q'] as const

/**
 * Filtros de la vista /tareas (ORD-POS-130): sin ningún parámetro de filtro en la URL (solo `/tareas` o `?pagina=N`)
 * arranca con Estado = abiertas. Cualquier URL con un parámetro de filtro, aunque esté vacío, se lee igual que antes.
 */
export function parseTaskViewFilters(params: Record<string, string | string[] | undefined>): TaskFilters {
  const f = parseTaskFilters(params)
  const conFiltro = TASK_FILTER_KEYS.some((k) => params[k] !== undefined)
  return conFiltro ? f : { ...f, estado: FILTER_OPEN_VALUE }
}

function pickParam(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value
  const trimmed = v?.trim()
  return trimmed ? trimmed.slice(0, 120) : undefined
}

/** Lee filtros desde los parámetros de URL, descartando valores mal formados. */
export function parseTaskFilters(params: Record<string, string | string[] | undefined>): TaskFilters {
  const desde = pickParam(params.desde)
  const hasta = pickParam(params.hasta)
  const bloqueo = pickParam(params.bloqueo)
  return {
    proyecto: pickParam(params.proyecto),
    estado: pickParam(params.estado)?.toUpperCase(),
    responsable: pickParam(params.responsable),
    prioridad: pickParam(params.prioridad)?.toUpperCase(),
    desde: desde && ISO_DAY.test(desde) ? desde : undefined,
    hasta: hasta && ISO_DAY.test(hasta) ? hasta : undefined,
    bloqueo: bloqueo === 'si' || bloqueo === 'no' ? bloqueo : undefined,
    q: pickParam(params.q),
  }
}

function matches(value: string | null, wanted: string | undefined, normalize = (s: string) => s): boolean {
  if (wanted === undefined) return true
  if (wanted === SIN) return value === null
  return value !== null && normalize(value) === normalize(wanted)
}

export function filterTasks(tareas: Tarea[], f: TaskFilters): Tarea[] {
  const q = f.q?.toLocaleLowerCase('es')
  return tareas.filter((t) => {
    if (!matches(t.proyectoId, f.proyecto)) return false
    if (f.estado === FILTER_OPEN_VALUE) {
      if (t.estado !== null && CLOSED_TASK_STATES.has(t.estado)) return false
    } else if (!matches(t.estado, f.estado)) return false
    if (!matches(t.responsable, f.responsable, (s) => s.toLocaleLowerCase('es'))) return false
    if (!matches(t.prioridad, f.prioridad)) return false
    if (f.bloqueo === 'si' && !isBlocked(t)) return false
    if (f.bloqueo === 'no' && isBlocked(t)) return false
    if (f.desde || f.hasta) {
      const day = t.fechaLimite ?? t.fechaPlan
      if (day === null) return false
      if (f.desde && day < f.desde) return false
      if (f.hasta && day > f.hasta) return false
    }
    if (q) {
      const haystack = [t.id, t.titulo, t.descripcion].filter(Boolean).join(' ').toLocaleLowerCase('es')
      if (!haystack.includes(q)) return false
    }
    return true
  })
}

const PRIORITY_ORDER: Record<string, number> = { CRITICA: 0, ALTA: 1, MEDIA: 2, BAJA: 3 }

/** Abiertas primero, luego prioridad, fecha límite e ID (orden estable). */
export function sortTasks(tareas: Tarea[]): Tarea[] {
  const stateRank: Record<TaskState, number> = { abierta: 0, 'sin-estado': 1, cerrada: 2 }
  return [...tareas].sort((a, b) =>
    stateRank[taskState(a)] - stateRank[taskState(b)] ||
    (PRIORITY_ORDER[a.prioridad ?? ''] ?? 9) - (PRIORITY_ORDER[b.prioridad ?? ''] ?? 9) ||
    (a.fechaLimite ?? '9999').localeCompare(b.fechaLimite ?? '9999') ||
    a.id.localeCompare(b.id, 'es', { numeric: true }))
}

/** Valores distintos (no vacíos) para poblar selectores de filtro. */
export function distinctValues<T>(items: T[], pick: (item: T) => string | null): string[] {
  return [...new Set(items.map(pick).filter((v): v is string => v !== null))].sort((a, b) => a.localeCompare(b, 'es'))
}

/* --------------------------------- Paginación --------------------------------- */

export interface Page<T> {
  items: T[]
  page: number
  pageCount: number
  total: number
  from: number
  to: number
}

export function paginate<T>(items: T[], rawPage: string | string[] | undefined, pageSize: number): Page<T> {
  const total = items.length
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const requested = Number.parseInt(pickParam(rawPage) ?? '1', 10)
  const page = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), pageCount) : 1
  const start = (page - 1) * pageSize
  const pageItems = items.slice(start, start + pageSize)
  return { items: pageItems, page, pageCount, total, from: total === 0 ? 0 : start + 1, to: start + pageItems.length }
}

/* ------------------------------ Capacidad y plan ------------------------------ */

export interface WeekCapacity {
  semana: Capacidad
  desde: string | null
  hasta: string | null
  horasDisponibles: number | null
  reservaPct: number | null
  /** Horas disponibles menos la reserva; `null` si faltan horas disponibles. */
  horasNetas: number | null
  minutosReales: MinutesTotal | null
  minutosPlaneados: number | null
  asignaciones: Dataset['asignaciones']
}

export function weekCapacity(ds: Dataset): WeekCapacity[] {
  return [...ds.capacidad]
    .sort((a, b) => (b.fechaInicio ?? '').localeCompare(a.fechaInicio ?? '') || b.id.localeCompare(a.id))
    .map((semana) => {
      const desde = semana.fechaInicio
      const hasta = desde ? addDays(desde, 6) : null
      const inWeek = (day: string | null) => desde !== null && hasta !== null && day !== null && day >= desde && day <= hasta
      const tiempos = ds.tiempos.filter((t) => inWeek(t.fecha))
      const planIds = new Set(ds.planes.filter((p) => p.semanaId === semana.id || inWeek(p.fecha)).map((p) => p.id))
      const items = ds.planItems.filter((i) => i.planId !== null && planIds.has(i.planId))
      const planned = items.filter((i) => i.minutosPlan !== null)
      const horasNetas =
        semana.horasDisponibles === null ? null : semana.horasDisponibles * (1 - (semana.reservaPct ?? 0))
      return {
        semana,
        desde,
        hasta,
        horasDisponibles: semana.horasDisponibles,
        reservaPct: semana.reservaPct,
        horasNetas,
        minutosReales: desde ? sumMinutes(tiempos) : null,
        minutosPlaneados: planned.length > 0 ? planned.reduce((acc, i) => acc + (i.minutosPlan ?? 0), 0) : null,
        asignaciones: ds.asignaciones.filter((a) => a.semanaId === semana.id),
      }
    })
}

export interface DailyPlanView {
  plan: PlanDiario
  items: Array<{ item: PlanItem; tarea: Tarea | null }>
  minutosPlaneados: number | null
  minutosReales: MinutesTotal
}

export function dailyPlans(ds: Dataset): DailyPlanView[] {
  const tasks = indexTasks(ds.tareas)
  return [...ds.planes]
    .sort((a, b) => (b.fecha ?? '').localeCompare(a.fecha ?? '') || b.id.localeCompare(a.id))
    .map((plan) => {
      const items = ds.planItems
        .filter((i) => i.planId === plan.id)
        .sort((a, b) => (a.orden ?? Infinity) - (b.orden ?? Infinity) || a.id.localeCompare(b.id))
        .map((item) => ({ item, tarea: item.tareaId ? tasks.get(item.tareaId) ?? null : null }))
      const planned = items.filter(({ item }) => item.minutosPlan !== null)
      return {
        plan,
        items,
        minutosPlaneados: planned.length > 0 ? planned.reduce((acc, { item }) => acc + (item.minutosPlan ?? 0), 0) : null,
        minutosReales: sumMinutes(ds.tiempos.filter((t) => plan.fecha !== null && t.fecha === plan.fecha)),
      }
    })
}

/* ---------------------------------- Formato ---------------------------------- */

/** "2 h 30 min"; los ceros explícitos solo se muestran si hay registros. */
export function formatMinutes(minutes: number): string {
  const rounded = Math.round(minutes)
  const h = Math.floor(rounded / 60)
  const m = rounded % 60
  if (h === 0) return `${m} min`
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

/** Antigüedad legible de los datos respecto a `now`. */
export function ageLabel(fromEpoch: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - fromEpoch) / 1000))
  if (seconds < 60) return 'hace menos de 1 min'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `hace ${minutes} min`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `hace ${hours} h` : `hace ${Math.round(hours / 24)} días`
}

export function daysUntil(day: string, now: Date = new Date()): number {
  return daysBetween(todayInMerida(now), day)
}
