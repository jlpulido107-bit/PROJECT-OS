import { CATEGORIES, SEVERITIES, TYPES } from './rules'
import type { Alert, AlertType, Category, Severity } from './types'
import { isCivilDate } from './util'

/** Filtros del centro de control (UI y API). Valores desconocidos ⇒ error, nunca se ignoran en silencio. */
export interface ControlFilters {
  proyecto?: string
  categoria?: Category
  severidad?: Severity
  tipo?: AlertType
}

export class FilterError extends Error {
  constructor(readonly field: string, message: string) {
    super(message)
    this.name = 'FilterError'
  }
}

const PROJECT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/
const SIN_PROYECTO = 'sin-proyecto'

export function parseControlParams(params: URLSearchParams): { filters: ControlFilters; fecha: string | null } {
  const allowed = new Set(['proyecto', 'categoria', 'severidad', 'tipo', 'fecha'])
  const seen = new Set<string>()
  for (const key of params.keys()) {
    if (!allowed.has(key)) throw new FilterError(key, 'Parámetro no reconocido')
    if (seen.has(key)) throw new FilterError(key, 'Parámetro repetido')
    seen.add(key)
  }
  const filters: ControlFilters = {}
  const proyecto = params.get('proyecto')
  if (proyecto !== null) {
    if (proyecto !== SIN_PROYECTO && !PROJECT.test(proyecto)) throw new FilterError('proyecto', 'ID de proyecto inválido')
    filters.proyecto = proyecto
  }
  const categoria = params.get('categoria')
  if (categoria !== null) {
    if (!CATEGORIES.includes(categoria as Category)) throw new FilterError('categoria', `Usa: ${CATEGORIES.join(', ')}`)
    filters.categoria = categoria as Category
  }
  const severidad = params.get('severidad')
  if (severidad !== null) {
    if (!SEVERITIES.includes(severidad as Severity)) throw new FilterError('severidad', `Usa: ${SEVERITIES.join(', ')}`)
    filters.severidad = severidad as Severity
  }
  const tipo = params.get('tipo')
  if (tipo !== null) {
    if (!TYPES.includes(tipo as AlertType)) throw new FilterError('tipo', `Usa: ${TYPES.join(', ')}`)
    filters.tipo = tipo as AlertType
  }
  const fecha = params.get('fecha')
  if (fecha !== null && !isCivilDate(fecha)) throw new FilterError('fecha', 'Usa YYYY-MM-DD')
  return { filters, fecha }
}

export function applyFilters(alerts: Alert[], f: ControlFilters): Alert[] {
  return alerts.filter((a) =>
    (f.proyecto === undefined || (f.proyecto === SIN_PROYECTO ? a.proyectoId === null : a.proyectoId === f.proyecto)) &&
    (f.categoria === undefined || a.categoria === f.categoria) &&
    (f.severidad === undefined || a.severidad === f.severidad) &&
    (f.tipo === undefined || a.tipo === f.tipo))
}
