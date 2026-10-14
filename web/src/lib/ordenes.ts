import type { Dataset, Orden } from './types'

/**
 * Vista de las órdenes a Codex (V1.7/V1.8, docs/migracion-ordenes-codex.md). Lectura pura de ORDENES_CODEX:
 * agrupa por lo que toca hacer y nunca infiere estados (una orden sin ESTADO válido se muestra como tal).
 */

export const ESTADOS_ORDEN = ['BORRADOR', 'APROBADA', 'ENVIADA', 'PR_ABIERTO', 'REVISADA', 'CERRADA', 'CANCELADA'] as const
export type EstadoOrden = (typeof ESTADOS_ORDEN)[number]

/** Qué se espera y de quién en cada estado. */
export const SIGUIENTE_PASO: Record<EstadoOrden, { quien: 'propietario' | 'claude' | 'codex' | 'nadie'; texto: string }> = {
  BORRADOR: { quien: 'propietario', texto: 'Revisar y aprobar' },
  APROBADA: { quien: 'claude', texto: 'Enviar a Codex (abrir el issue)' },
  ENVIADA: { quien: 'codex', texto: 'Lanzar en Codex («Copiar para Codex»); Codex trabaja y abre un PR' },
  PR_ABIERTO: { quien: 'claude', texto: 'Revisar el PR contra los criterios' },
  REVISADA: { quien: 'propietario', texto: 'Fusionar o cerrar el PR' },
  CERRADA: { quien: 'nadie', texto: 'Terminada' },
  CANCELADA: { quien: 'nadie', texto: 'Cancelada' },
}

export type GrupoOrden = 'tu-turno' | 'en-curso' | 'terminadas' | 'invalidas'

export interface OrdenVista {
  orden: Orden
  estado: EstadoOrden | null
  grupo: GrupoOrden
  siguiente: (typeof SIGUIENTE_PASO)[EstadoOrden] | null
  /** Problemas de datos de la fila (no bloquean la vista; se muestran). */
  problemas: string[]
}

const ID = /^ORD-([A-Z]{2,5})-\d{3,}$/

export function estadoOrden(code: string | null): EstadoOrden | null {
  return (ESTADOS_ORDEN as readonly string[]).includes(code ?? '') ? (code as EstadoOrden) : null
}

export function vistaOrden(orden: Orden, ds: Pick<Dataset, 'tareas'>): OrdenVista {
  const estado = estadoOrden(orden.estado)
  const problemas: string[] = []
  const prefijo = ID.exec(orden.id)?.[1]
  if (!prefijo) problemas.push('ORDEN_ID no tiene el formato ORD-PRY-NNN')
  else if (orden.proyectoId && prefijo !== orden.proyectoId) problemas.push('El prefijo de ORDEN_ID no coincide con PROYECTO_ID')
  if (!estado) problemas.push('ESTADO no es válido')
  if (!orden.tareaId) problemas.push('Falta TAREA_ID')
  else if (!ds.tareas.some((t) => t.id === orden.tareaId)) problemas.push(`La tarea ${orden.tareaId} no existe en TAREAS`)
  if (orden.riesgo === 'ALTO') problemas.push('Riesgo ALTO: no se delega')
  if (estado && ['ENVIADA', 'PR_ABIERTO', 'REVISADA'].includes(estado) && !orden.issueUrl) problemas.push('Falta ISSUE_URL')
  if (estado && ['PR_ABIERTO', 'REVISADA'].includes(estado) && !orden.prUrl) problemas.push('Falta PR_URL')

  const siguiente = estado ? SIGUIENTE_PASO[estado] : null
  const grupo: GrupoOrden = !estado
    ? 'invalidas'
    : siguiente?.quien === 'propietario'
      ? 'tu-turno'
      : siguiente?.quien === 'nadie'
        ? 'terminadas'
        : 'en-curso'
  return { orden, estado, grupo, siguiente, problemas }
}

export interface ResumenOrdenes {
  grupos: Record<GrupoOrden, OrdenVista[]>
  porEstado: Array<[EstadoOrden, number]>
}

export function resumenOrdenes(ds: Pick<Dataset, 'ordenes' | 'tareas'>, proyecto?: string): ResumenOrdenes {
  const vistas = ds.ordenes
    .filter((o) => !proyecto || o.proyectoId === proyecto)
    .map((o) => vistaOrden(o, ds))
    .sort((a, b) =>
      (a.estado ? ESTADOS_ORDEN.indexOf(a.estado) : -1) - (b.estado ? ESTADOS_ORDEN.indexOf(b.estado) : -1)
      || (b.orden.actualizadoEn ?? '').localeCompare(a.orden.actualizadoEn ?? '')
      || a.orden.id.localeCompare(b.orden.id))
  const grupos: Record<GrupoOrden, OrdenVista[]> = { 'tu-turno': [], 'en-curso': [], terminadas: [], invalidas: [] }
  for (const v of vistas) grupos[v.grupo].push(v)
  const porEstado = ESTADOS_ORDEN.map((e) => [e, vistas.filter((v) => v.estado === e).length] as [EstadoOrden, number])
    .filter(([, n]) => n > 0)
  return { grupos, porEstado }
}
