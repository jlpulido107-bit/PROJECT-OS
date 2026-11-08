import type { EtiquetaK4 } from './eco-columnas'
import type { IdeaRanking } from './eco'
import { ETIQUETAS_ETAPA, type Tarjeta } from './pipeline'

/**
 * Ranking de /eco en un renglón por idea (ORD-POS-151, POS-053). Funciones puras de presentación y navegación sobre lo
 * que ya construyen `construirEco` (SCORING) y `construirPipeline` (PIPE_PRODUCTOS): no leen, no escriben y no
 * calculan puntuaciones, K4 ni costos.
 */

/** Filtro K4 de la lista: `?k4=`. «Sin datos» = `SIN_DATOS` o sin valor en `K4_MACRO_STATUS`. */
export const FILTROS_K4 = [
  ['', 'Todos'], ['aprobado', 'Aprobado'], ['estacional', 'Estacional'], ['veto', 'Veto'], ['sin-datos', 'Sin datos'],
] as const
export type FiltroK4 = Exclude<(typeof FILTROS_K4)[number][0], ''>

export function parseFiltroK4(raw: string | undefined): FiltroK4 | null {
  return FILTROS_K4.find(([v]) => v !== '' && v === raw)?.[0] as FiltroK4 | undefined ?? null
}

export function coincideK4(k4: EtiquetaK4 | null, filtro: FiltroK4 | null): boolean {
  if (filtro === null) return true
  if (filtro === 'sin-datos') return k4 === null || k4.tipo === 'SIN_DATOS'
  return k4?.tipo === filtro.toUpperCase()
}

/**
 * Producto de PIPE_PRODUCTOS por `IDEA_ID`. Si una idea tiene varios, el primero no descartado en el orden de la hoja;
 * si todos están descartados, el primero.
 */
export function productosPorIdea(tarjetas: readonly Tarjeta[]): Map<string, Tarjeta> {
  const out = new Map<string, Tarjeta>()
  for (const t of tarjetas) {
    const idea = t.fila.IDEA_ID
    if (!idea) continue
    const actual = out.get(idea)
    if (!actual || (actual.etapa === 'DESCARTADO' && t.etapa !== 'DESCARTADO')) out.set(idea, t)
  }
  return out
}

/** Filtros al cambiar (criterio 5); conservan el orden del ranking. */
export function filtrarIdeas(
  ideas: readonly IdeaRanking[], filtro: { k4: FiltroK4 | null; conProducto: boolean }, productos: ReadonlyMap<string, Tarjeta>,
): IdeaRanking[] {
  return ideas.filter((i) => coincideK4(i.k4, filtro.k4) && (!filtro.conProducto || productos.has(i.id)))
}

export const SIN_PRODUCTO = 'Sin producto en compras'

/** «Cotizando, 9 días»; sin etapa reconocida, su texto tal cual; sin días, «días: —». */
export function etapaDeProducto(t: Tarjeta): string {
  const etapa = t.etapa ? ETIQUETAS_ETAPA[t.etapa] : `Etapa: ${t.etapaTexto ?? 'vacía'}`
  return `${etapa}, ${t.dias === null ? 'días: —' : `${t.dias} ${t.dias === 1 ? 'día' : 'días'}`}`
}

/** Ancla de una idea abierta (`#idea-<ID>`); los espacios del ID pasan a `-`. */
export const anclaIdea = (id: string) => `idea-${id.replace(/\s+/g, '-')}`

/** Ficha del producto en Compras (ORD-POS-150). */
export const enlaceFichaCompras = (productoId: string) => `/eco/pipeline?producto=${encodeURIComponent(productoId)}#ficha-producto`

/** Query de /eco con los filtros del ranking; vacío o false los quita. */
export function hrefFiltros(filtro: { k4: FiltroK4 | null; conProducto: boolean }, otros: Record<string, string | undefined> = {}): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries({ ...otros, k4: filtro.k4 ?? undefined, compras: filtro.conProducto ? '1' : undefined })) if (v) q.set(k, v)
  const s = q.toString()
  return `/eco${s ? `?${s}` : ''}#ranking`
}
