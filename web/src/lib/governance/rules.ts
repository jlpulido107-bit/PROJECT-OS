import type { AlertType, Category, Severity, TabName } from './types'

/** Reglas y umbrales documentados en docs/v1-6-governance-contract.md §4–§5. Cambiarlos requiere aprobación. */

export const CLOSED_TASK = new Set(['COMPLETADO', 'CANCELADO'])
export const BLOCKED_TASK = 'BLOQUEADO'
export const CLOSED_MILESTONE = new Set(['COMPLETADO', 'CANCELADO'])
export const INACTIVE_DEPENDENCY = new Set(['RESUELTA', 'INACTIVA', 'CANCELADA'])
export const INACTIVE_PROJECT = new Set(['COMPLETADO', 'CANCELADO', 'CERRADO', 'PAUSADO', 'SUSPENDIDO', 'ARCHIVADO'])
export const PENDING_DECISION = new Set(['PENDIENTE', 'EN_REVISION', 'PROPUESTA', 'POR_DECIDIR', 'BORRADOR'])
export const RESOLVED_DECISION = new Set(['APROBADA', 'RECHAZADA', 'DESCARTADA', 'CANCELADA', 'SUSTITUIDA', 'IMPLEMENTADA'])
export const CLOSED_PLAN = new Set(['CERRADO', 'COMPLETADO', 'CANCELADO', 'DESCARTADO'])
export const CANCELLED_PLAN = new Set(['CANCELADO', 'DESCARTADO'])

export const THRESHOLDS = {
  /** Decisión pendiente con FECHA de al menos N días ⇒ severidad alta. */
  decisionAntiguaDias: 14,
  /** Tarea que vence en [hoy, hoy + N] ⇒ riesgo. */
  venceProntoDias: 3,
  /** Ventana de riesgo para bloqueos, dependencias e hitos. */
  ventanaRiesgoDias: 7,
} as const

export const ESSENTIAL_TABS: readonly TabName[] = ['TAREAS', 'DECISIONES', 'PROYECTOS']

/** Pestañas necesarias para afirmar "sin alertas" en cada categoría. */
export const CATEGORY_TABS: Record<Category, TabName[]> = {
  decisiones: ['DECISIONES', 'PROYECTOS'],
  bloqueos: ['TAREAS'],
  dependencias: ['DEPENDENCIAS', 'TAREAS'],
  vencimientos: ['TAREAS', 'HITOS'],
  evidencias: ['EVIDENCIAS', 'TAREAS'],
  discrepancias: ['PROYECTOS', 'HITOS', 'TAREAS', 'DECISIONES', 'TIEMPOS'],
  capacidad: ['CAPACIDAD_SEMANAL', 'ASIGNACIONES', 'PLAN_DIARIO', 'PLAN_ITEMS', 'TAREAS'],
  datos: [],
}

export const CATEGORIES: Category[] = ['decisiones', 'bloqueos', 'dependencias', 'vencimientos', 'evidencias', 'discrepancias', 'capacidad', 'datos']
export const SEVERITIES: Severity[] = ['critica', 'alta', 'media', 'baja', 'info']
export const TYPES: AlertType[] = ['incumplimiento', 'discrepancia', 'bloqueo', 'pendiente', 'riesgo', 'revision', 'diagnostico']
export const ALL_TABS: TabName[] = ['PROYECTOS', 'HITOS', 'TAREAS', 'DEPENDENCIAS', 'EVIDENCIAS', 'DECISIONES', 'TIEMPOS', 'PLAN_DIARIO', 'PLAN_ITEMS', 'CAPACIDAD_SEMANAL', 'ASIGNACIONES']

/** Señales del planificador V1.5 que se tratan como severidad alta. */
export const PLANNER_HIGH = new Set(['sobrecarga', 'planes-exceden-capacidad', 'asignaciones-exceden-capacidad'])

export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Orden natural determinista de IDs (POS-2 antes de POS-10). */
export function compareIds(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g
  const pa = a.match(re) ?? []
  const pb = b.match(re) ?? []
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i]!
    const y = pb[i]!
    if (/^\d/.test(x) && /^\d/.test(y)) {
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
