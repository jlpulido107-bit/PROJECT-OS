import { normalizeCode } from '../parse'
import { ETAPAS, type Etapa, type Tarjeta } from './pipeline'
import type { Bandeja, Columna, TarjetaCotizacion } from './pipeline-bandeja'
import type { Comparacion, FilaComparada } from './pipeline-tabulador'

/**
 * Compras por producto en /eco/pipeline (ORD-POS-150, POS-053; docs/diseno-eco-pipeline.md §17). Solo presentación y
 * navegación: funciones puras sobre lo que ya calculan `construirBandeja` (§16) y el tabulador (§14). No leen, no
 * escriben y no recalculan nada.
 */

export const PASOS: ReadonlyArray<{ paso: Columna; titulo: string; vacio: string }> = [
  { paso: 'esperando', titulo: 'Esperando respuesta', vacio: 'Ninguna SOLICITADA.' },
  { paso: 'porCompletar', titulo: 'Por completar', vacio: 'Ninguna RECIBIDA a la que le falten datos.' },
  { paso: 'listas', titulo: 'Listas para decidir', vacio: 'Ninguna lista todavía.' },
]

/** `?paso=` válido o null (cualquier otro valor se ignora). */
export function parsePaso(raw: string | undefined): Columna | null {
  return PASOS.find((p) => p.paso === raw)?.paso ?? null
}

/** Filtro de etapa de la lista: «Activas» (sin Descartado) por omisión, «Todas» o una etapa. */
export type FiltroEtapa = 'ACTIVAS' | 'TODAS' | Etapa
export function parseEtapa(raw: string | undefined): FiltroEtapa {
  if (raw === 'TODAS') return 'TODAS'
  return ETAPAS.find((e) => e === raw) ?? 'ACTIVAS'
}

export function filtrarPorEtapa(tarjetas: readonly Tarjeta[], etapa: FiltroEtapa): Tarjeta[] {
  if (etapa === 'TODAS') return [...tarjetas]
  if (etapa === 'ACTIVAS') return tarjetas.filter((t) => t.etapa !== 'DESCARTADO')
  return tarjetas.filter((t) => t.etapa === etapa)
}

/** Cotizaciones de la bandeja agrupadas por producto y paso. */
export type PorPaso = Record<Columna, TarjetaCotizacion[]>
export function porProducto(bandeja: Bandeja): Map<string, PorPaso> {
  const out = new Map<string, PorPaso>()
  for (const { paso } of PASOS) {
    for (const t of bandeja[paso]) {
      if (!t.productoId) continue
      const g = out.get(t.productoId) ?? { esperando: [], porCompletar: [], listas: [] }
      g[paso].push(t)
      out.set(t.productoId, g)
    }
  }
  return out
}

/** Criterio 1: al tocar un chip, solo los productos con al menos una cotización en ese paso. */
export function filtrarPorPaso(tarjetas: readonly Tarjeta[], paso: Columna | null, grupos: Map<string, PorPaso>): Tarjeta[] {
  return paso ? tarjetas.filter((t) => (grupos.get(t.id)?.[paso].length ?? 0) > 0) : [...tarjetas]
}

const RECHAZADA = (f: FilaComparada) => ['RECHAZADA', 'DESCARTADA'].includes(normalizeCode(f.estado) ?? '')

/**
 * Criterio 2: la mejor cotización es la primera con costo por set en el orden de «Comparar» (de menor a mayor costo,
 * RECHAZADA al final). Una RECHAZADA nunca es la mejor, aunque sea la única con costo.
 */
export function mejorCotizacion(cmp: Comparacion | null): FilaComparada | null {
  return cmp?.filas.find((f) => f.costo.porSetMxn !== null && !RECHAZADA(f)) ?? null
}

/** Query de un enlace de la vista: conserva los filtros y cambia solo lo indicado (undefined o '' lo quita). */
export function conParams(actual: Record<string, string | undefined>, cambios: Record<string, string | undefined>, hash = ''): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries({ ...actual, ...cambios })) if (v) q.set(k, v)
  const s = q.toString()
  return `/eco/pipeline${s ? `?${s}` : ''}${hash}`
}

/** Criterio 5: /eco/cotizaciones redirige a /eco/pipeline y conserva el paso de la bandeja (si es válido). */
export function destinoCotizaciones(params: { paso?: string | string[] }): string {
  const paso = parsePaso(typeof params.paso === 'string' ? params.paso : undefined)
  return paso ? `/eco/pipeline?paso=${paso}#productos` : '/eco/pipeline#productos'
}
