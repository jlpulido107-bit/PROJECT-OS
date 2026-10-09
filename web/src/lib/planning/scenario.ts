import type { ProjectPriority, Scenario } from './types'

/**
 * Escenarios de simulación. Los valores por defecto reproducen los datos registrados sin supuestos:
 * - sin ajuste de horas, reserva y prioridades de Sheets;
 * - no se inventan horas de capacidad ni de estimación;
 * - el tiempo registrado NO se descuenta de la estimación (no se asume que equivalga a avance).
 */
export const DEFAULT_SCENARIO: Scenario = Object.freeze({
  semana: 'actual',
  ajusteHoras: 0,
  reservaPct: null,
  horasSiFaltan: null,
  diasLaborables: Object.freeze([1, 2, 3, 4, 5]) as unknown as number[],
  prioridadProyecto: Object.freeze({}) as Record<string, ProjectPriority>,
  horasSiSinEstimacion: null,
  sobrecargaPct: 0,
  descontarRegistrado: false,
}) as Scenario

export const SCENARIO_LIMITS = {
  ajusteHoras: { min: -168, max: 168 },
  reservaPct: { min: 0, max: 100 },
  horasSiFaltan: { min: 0, max: 168 },
  horasSiSinEstimacion: { min: 0.25, max: 40 },
  sobrecargaPct: { min: 0, max: 300 },
} as const

const PROJECT_PRIORITIES: readonly ProjectPriority[] = ['ALTA', 'MEDIA', 'BAJA']
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/

export class ScenarioError extends Error {
  constructor(readonly field: string, message: string) {
    super(message)
    this.name = 'ScenarioError'
  }
}

function finite(field: string, value: unknown, min: number, max: number, step = 0.25): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  if (!Number.isFinite(n)) throw new ScenarioError(field, 'Debe ser un número')
  if (n < min || n > max) throw new ScenarioError(field, `Debe estar entre ${min} y ${max}`)
  const rounded = Math.round(n / step) * step
  if (Math.abs(rounded - n) > 1e-9) throw new ScenarioError(field, `Usa múltiplos de ${step}`)
  return rounded
}

/**
 * Valida y normaliza un escenario parcial (de la UI o de la API). Lanza ScenarioError ante valores inválidos:
 * nunca corrige en silencio un valor fuera de rango.
 */
export function normalizeScenario(partial: Partial<Record<keyof Scenario, unknown>>): Scenario {
  const s: Scenario = {
    ...DEFAULT_SCENARIO,
    diasLaborables: [...DEFAULT_SCENARIO.diasLaborables],
    prioridadProyecto: {},
  }
  if (partial.semana !== undefined) {
    if (partial.semana !== 'actual' && partial.semana !== 'siguiente') throw new ScenarioError('semana', 'Usa "actual" o "siguiente"')
    s.semana = partial.semana
  }
  if (partial.ajusteHoras !== undefined) {
    s.ajusteHoras = finite('ajusteHoras', partial.ajusteHoras, SCENARIO_LIMITS.ajusteHoras.min, SCENARIO_LIMITS.ajusteHoras.max)
  }
  if (partial.reservaPct !== undefined && partial.reservaPct !== null && partial.reservaPct !== '') {
    s.reservaPct = finite('reservaPct', partial.reservaPct, SCENARIO_LIMITS.reservaPct.min, SCENARIO_LIMITS.reservaPct.max, 1)
  }
  if (partial.horasSiFaltan !== undefined && partial.horasSiFaltan !== null && partial.horasSiFaltan !== '') {
    s.horasSiFaltan = finite('horasSiFaltan', partial.horasSiFaltan, SCENARIO_LIMITS.horasSiFaltan.min, SCENARIO_LIMITS.horasSiFaltan.max)
  }
  if (partial.horasSiSinEstimacion !== undefined && partial.horasSiSinEstimacion !== null && partial.horasSiSinEstimacion !== '') {
    s.horasSiSinEstimacion = finite(
      'horasSiSinEstimacion', partial.horasSiSinEstimacion,
      SCENARIO_LIMITS.horasSiSinEstimacion.min, SCENARIO_LIMITS.horasSiSinEstimacion.max,
    )
  }
  if (partial.sobrecargaPct !== undefined) {
    s.sobrecargaPct = finite('sobrecargaPct', partial.sobrecargaPct, SCENARIO_LIMITS.sobrecargaPct.min, SCENARIO_LIMITS.sobrecargaPct.max, 1)
  }
  if (partial.descontarRegistrado !== undefined) {
    const v = partial.descontarRegistrado
    if (v !== true && v !== false && v !== 'true' && v !== 'false') throw new ScenarioError('descontarRegistrado', 'Usa true o false')
    s.descontarRegistrado = v === true || v === 'true'
  }
  if (partial.diasLaborables !== undefined) {
    const raw = partial.diasLaborables
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? (raw === '' ? [] : raw.split(',')) : null
    if (!list) throw new ScenarioError('diasLaborables', 'Lista de días 1–7')
    const days = new Set<number>()
    for (const item of list) {
      const n = typeof item === 'number' ? item : Number(String(item).trim())
      if (!Number.isInteger(n) || n < 1 || n > 7) throw new ScenarioError('diasLaborables', 'Cada día debe ser 1 (lunes) a 7 (domingo)')
      days.add(n)
    }
    s.diasLaborables = [...days].sort((a, b) => a - b)
  }
  if (partial.prioridadProyecto !== undefined) {
    const raw = partial.prioridadProyecto
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ScenarioError('prioridadProyecto', 'Objeto proyecto → prioridad')
    const entries = Object.entries(raw as Record<string, unknown>)
    if (entries.length > 50) throw new ScenarioError('prioridadProyecto', 'Demasiados proyectos')
    for (const [project, value] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (!PROJECT_ID.test(project)) throw new ScenarioError('prioridadProyecto', 'ID de proyecto inválido')
      if (!PROJECT_PRIORITIES.includes(value as ProjectPriority)) throw new ScenarioError('prioridadProyecto', 'Usa ALTA, MEDIA o BAJA')
      s.prioridadProyecto[project] = value as ProjectPriority
    }
  }
  return s
}

/** Escenario desde parámetros de URL (API GET). `prioridad.SIG=ALTA` fija la prioridad simulada de un proyecto. */
export function scenarioFromSearchParams(params: URLSearchParams): Scenario {
  const known = new Set(['semana', 'ajusteHoras', 'reservaPct', 'horasSiFaltan', 'diasLaborables', 'horasSiSinEstimacion', 'sobrecargaPct', 'descontarRegistrado'])
  const partial: Partial<Record<keyof Scenario, unknown>> = {}
  const priorities: Record<string, string> = {}
  for (const [key, value] of params.entries()) {
    if (key.startsWith('prioridad.')) priorities[key.slice('prioridad.'.length)] = value
    else if (known.has(key)) {
      if (Object.hasOwn(partial, key)) throw new ScenarioError(key, 'Parámetro repetido')
      partial[key as keyof Scenario] = value
    } else throw new ScenarioError(key, 'Parámetro no reconocido')
  }
  if (Object.keys(priorities).length > 0) partial.prioridadProyecto = priorities
  return normalizeScenario(partial)
}

/** Indica si el escenario difiere de los datos registrados (para el aviso de simulación). */
export function isDefaultScenario(s: Scenario): boolean {
  return (
    s.semana === DEFAULT_SCENARIO.semana &&
    s.ajusteHoras === 0 &&
    s.reservaPct === null &&
    s.horasSiFaltan === null &&
    s.horasSiSinEstimacion === null &&
    s.sobrecargaPct === 0 &&
    !s.descontarRegistrado &&
    s.diasLaborables.join(',') === DEFAULT_SCENARIO.diasLaborables.join(',') &&
    Object.keys(s.prioridadProyecto).length === 0
  )
}
