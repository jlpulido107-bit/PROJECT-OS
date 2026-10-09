import type { ProjectPriority } from './types'

/**
 * Reglas documentadas (docs/v1-5-planning-contract.md §4). Las prioridades son CATEGORÍAS de texto:
 * se ordenan, no se suman ni se promedian. El único uso numérico es el peso de reparto entre proyectos,
 * fijado y publicado aquí.
 */

/** Categorías de prioridad de tarea, de mayor a menor. Un valor fuera de la lista es "desconocido". */
export const TASK_PRIORITY_ORDER = ['CRITICA', 'ALTA', 'MEDIA', 'BAJA'] as const
/** Sinónimos aceptados (se normalizan a la categoría documentada). */
const TASK_PRIORITY_ALIASES: Record<string, (typeof TASK_PRIORITY_ORDER)[number]> = {
  CRITICA: 'CRITICA', CRÍTICA: 'CRITICA', URGENTE: 'CRITICA',
  ALTA: 'ALTA', MEDIA: 'MEDIA', NORMAL: 'MEDIA', BAJA: 'BAJA',
}

export function normalizeTaskPriority(raw: string | null): { categoria: string; rango: number; desconocida: boolean } {
  const key = (raw ?? '').trim().toUpperCase()
  const known = TASK_PRIORITY_ALIASES[key]
  if (known) return { categoria: known, rango: TASK_PRIORITY_ORDER.indexOf(known), desconocida: false }
  // Desconocida o vacía: después de BAJA, nunca descartada en silencio.
  return { categoria: key === '' ? 'SIN_PRIORIDAD' : key, rango: TASK_PRIORITY_ORDER.length, desconocida: true }
}

/** Peso de reparto entre proyectos por categoría de prioridad del proyecto. */
export const PROJECT_WEIGHT: Record<ProjectPriority | 'SIN_PRIORIDAD', number> = {
  ALTA: 3,
  MEDIA: 2,
  BAJA: 1,
  SIN_PRIORIDAD: 1,
}

export function normalizeProjectPriority(raw: string | null): ProjectPriority | 'SIN_PRIORIDAD' {
  const key = (raw ?? '').trim().toUpperCase()
  if (key === 'ALTA' || key === 'CRITICA' || key === 'URGENTE') return 'ALTA'
  if (key === 'MEDIA' || key === 'NORMAL') return 'MEDIA'
  if (key === 'BAJA') return 'BAJA'
  return 'SIN_PRIORIDAD'
}

/** Estados de tarea cerrados (registrados por personas en Sheets; el motor nunca los infiere). */
export const CLOSED_TASK_STATES = new Set(['COMPLETADO', 'CANCELADO'])
export const BLOCKED_TASK_STATE = 'BLOQUEADO'
/** Estados de proyecto que excluyen sus tareas de la propuesta. */
export const INACTIVE_PROJECT_STATES = new Set(['COMPLETADO', 'CANCELADO', 'CERRADO', 'PAUSADO', 'SUSPENDIDO', 'ARCHIVADO'])
/** Estados de dependencia que ya no exigen el prerrequisito (igual que el dashboard V1.2). */
export const INACTIVE_DEPENDENCY_STATES = new Set(['RESUELTA', 'INACTIVA', 'CANCELADA'])
/** Estados de plan diario que se consideran ejecutados o descartados (no reservan capacidad futura). */
export const PLAN_CANCELLED_STATES = new Set(['CANCELADO', 'DESCARTADO'])

/** Mínimo de minutos por bloque diario: no se proponen fragmentos menores salvo que sea el resto de la tarea. */
export const MIN_BLOCK_MIN = 30
/** Máximo de minutos de una misma tarea por día (evita que una tarea acapare la jornada). */
export const MAX_BLOCK_MIN = 180
/** Piso anti-inanición: minutos garantizados (si caben) a cada proyecto con demanda elegible. */
export const FAIRNESS_FLOOR_MIN = 60

/** Comparación de cadenas independiente de la configuración regional (determinista). */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Orden natural de IDs (POS-2 antes de POS-10), determinista. */
export function compareIds(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g
  const pa = a.match(re) ?? []
  const pb = b.match(re) ?? []
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i]!
    const y = pb[i]!
    const nx = /^\d/.test(x)
    const ny = /^\d/.test(y)
    if (nx && ny) {
      const d = Number(x) - Number(y)
      if (d !== 0) return d
      if (x.length !== y.length) return x.length - y.length
    } else {
      const c = compareText(x, y)
      if (c !== 0) return c
    }
  }
  return pa.length - pb.length || compareText(a, b)
}

/** Horas → minutos enteros (redondeo al minuto). Devuelve null ante valores no finitos o negativos. */
export function hoursToMinutes(hours: number | null): number | null {
  if (hours === null || !Number.isFinite(hours) || hours < 0) return null
  return Math.round(hours * 60)
}
