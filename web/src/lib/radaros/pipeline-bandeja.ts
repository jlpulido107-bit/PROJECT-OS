import { normalizeCode } from '../parse'
import { alertasCotizacion, type PipelineVista } from './pipeline'
import { costoAterrizado, precioObjetivo, type FilaComparada, type PrecioObjetivo, type TabuladorVista } from './pipeline-tabulador'
import type { Fila } from './tabla'

/**
 * Bandeja de cotizaciones de /eco/cotizaciones (ORD-POS-149, POS-052; docs/diseno-eco-pipeline.md §16). Funciones puras
 * sobre lo que el lector de /eco ya trajo: no leen ni escriben. Reparte las cotizaciones en los 3 pasos (esperando
 * respuesta, por completar, listas para comparar) con los números del tabulador (§14), sin duplicar sus cálculos.
 */

export type Columna = 'esperando' | 'porCompletar' | 'listas'

export interface TarjetaCotizacion {
  id: string
  productoId: string | null
  producto: string | null
  proveedorId: string | null
  proveedor: string | null
  estado: string
  /** SOLICITADA con FECHA_RESPUESTA_ESPERADA anterior a hoy (§5.2). */
  vencida: boolean
  /** Fila de la hoja (para la edición con VERSION). */
  fila: Fila
  /**
   * Valores por columna que «Recibir» muestra antes de guardar (criterio 4): MONEDA USD, PAIS_ORIGEN del proveedor,
   * CERTIFICADO_ORIGEN NO y UNIDADES_POR_SET de otra cotización del mismo producto. Solo donde la hoja está vacía.
   */
  defectos: Record<string, string>
  /** Fila del tabulador del producto (costo por set, veredicto, capital); null si el producto no existe. */
  comparada: FilaComparada | null
  /** Precio objetivo (criterio 6); null en SOLICITADA (todavía no hay moneda ni incoterm). */
  objetivo: PrecioObjetivo | null
  /** Qué le falta al tabulador (paso «Por completar»). */
  faltan: string[]
  /** Texto corto en inglés para «Copiar seguimiento» (criterio 7). No se envía nada. */
  seguimiento: string
}

export interface Bandeja {
  hoy: string
  esperando: TarjetaCotizacion[]
  porCompletar: TarjetaCotizacion[]
  listas: TarjetaCotizacion[]
  /** RECHAZADA y estados no válidos: no van en ninguna columna; se cuentan. */
  fuera: number
}

/** Columna de una cotización: SOLICITADA espera; RECIBIDA sin costo por set del tabulador, por completar; RECIBIDA o
 * ELEGIDA con costo, lista. RECHAZADA (o un estado fuera de la lista) no entra. */
export function columnaDe(estado: string, porSetMxn: number | null): Columna | null {
  if (estado === 'SOLICITADA') return 'esperando'
  if (estado === 'RECIBIDA' || estado === 'ELEGIDA') return porSetMxn === null ? 'porCompletar' : 'listas'
  return null
}

/** Texto de seguimiento (criterio 7): corto, en inglés, sin datos de personas. */
export function textoSeguimiento(proveedor: string | null, producto: string | null, fechaSolicitud: string | null): string {
  const quien = proveedor ? `Hello ${proveedor} team,` : 'Hello,'
  const que = producto ? ` for ${producto}` : ''
  const cuando = fechaSolicitud ? ` sent on ${fechaSolicitud}` : ''
  return `${quien} following up on our quotation request${que}${cuando}. Could you please share the unit price (per piece or per set), MOQ, Incoterm and lead time? Thank you.`
}

export function construirBandeja(v: PipelineVista, tab: TabuladorVista): Bandeja {
  // Las filas del tabulador traen también las columnas de las migraciones (PRECIO_POR, EVIDENCIA_URL…).
  const cots = tab.cotizaciones
  const tarjetas = v.productos.estado === 'ok' ? v.productos.datos.tarjetas : []
  const productos = new Map(tarjetas.map((t) => [t.id, t]))
  const proveedores = new Map((v.proveedores.estado === 'ok' ? v.proveedores.datos.filas : []).flatMap((p) => (p.PROVEEDOR_ID ? [[p.PROVEEDOR_ID, p] as const] : [])))
  // Una comparación por producto (la misma de «Comparar cotizaciones»).
  const comparaciones = new Map<string, ReturnType<TabuladorVista['comparar']>>()
  const comparar = (productoId: string) => {
    if (!comparaciones.has(productoId)) comparaciones.set(productoId, tab.comparar(productoId, productos.get(productoId)?.fila.IDEA_ID ?? null))
    return comparaciones.get(productoId)!
  }
  // UNIDADES_POR_SET «del producto si se conoce»: la última cotización del producto que lo tenga.
  const unidadesPorSet = new Map<string, string>()
  for (const c of cots) if (c.PRODUCTO_ID && c.UNIDADES_POR_SET) unidadesPorSet.set(c.PRODUCTO_ID, c.UNIDADES_POR_SET)

  const bandeja: Bandeja = { hoy: v.hoy, esperando: [], porCompletar: [], listas: [], fuera: 0 }
  for (const c of cots) {
    const id = c.COTIZACION_ID
    if (!id) continue
    const estado = normalizeCode(c.ESTADO ?? null) ?? ''
    const productoId = c.PRODUCTO_ID ?? null
    const prod = productoId ? productos.get(productoId) : undefined
    const cmp = prod ? comparar(prod.id) : null
    const comparada = cmp?.filas.find((f) => f.id === id) ?? null
    const costo = comparada?.costo ?? costoAterrizado(c, tab.parametros)
    const columna = columnaDe(estado, costo.porSetMxn)
    if (!columna) {
      bandeja.fuera++
      continue
    }
    const prv = c.PROVEEDOR_ID ? proveedores.get(c.PROVEEDOR_ID) : undefined
    const defectos: Record<string, string> = {}
    if (!c.MONEDA) defectos.MONEDA = 'USD'
    if (!c.PAIS_ORIGEN && prv?.PAIS) defectos.PAIS_ORIGEN = prv.PAIS
    if (!c.CERTIFICADO_ORIGEN) defectos.CERTIFICADO_ORIGEN = 'NO'
    const ups = productoId ? unidadesPorSet.get(productoId) : undefined
    if (!c.UNIDADES_POR_SET && ups) defectos.UNIDADES_POR_SET = ups
    bandeja[columna].push({
      id, productoId, producto: prod?.nombre ?? null, proveedorId: c.PROVEEDOR_ID ?? null, proveedor: prv?.NOMBRE ?? null, estado,
      vencida: alertasCotizacion(c, v.hoy).some((a) => a.tipo === 'cotizacion'), fila: c, defectos, comparada,
      objetivo: estado === 'SOLICITADA' ? null : precioObjetivo(c, tab.parametros, cmp?.costoMaximo.mxn ?? null),
      faltan: costo.porConfirmar, seguimiento: textoSeguimiento(prv?.NOMBRE ?? null, prod?.nombre ?? null, c.FECHA_SOLICITUD ?? null),
    })
  }
  // Vencidas primero y luego por fecha esperada; las listas, por costo por set (menor primero).
  bandeja.esperando.sort((a, b) => Number(b.vencida) - Number(a.vencida) || (a.fila.FECHA_RESPUESTA_ESPERADA ?? '').localeCompare(b.fila.FECHA_RESPUESTA_ESPERADA ?? '') || a.id.localeCompare(b.id))
  bandeja.listas.sort((a, b) => (a.comparada?.costo.porSetMxn ?? Infinity) - (b.comparada?.costo.porSetMxn ?? Infinity) || a.id.localeCompare(b.id))
  return bandeja
}
