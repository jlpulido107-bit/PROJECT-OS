import { civilDateInZone, daysBetween, parseCivilDate, parseTimestamp } from '../dates'
import { normalizeCode } from '../parse'
import { leerTabla, mapear, type Bloque, type Fila } from './tabla'

/**
 * Vista de solo lectura del pipeline de ECOMMERCE (/eco/pipeline, ORD-POS-097, docs/diseno-eco-pipeline.md §2, §5.2 y
 * §8). Funciones puras sobre las filas que el lector de /eco ya trajo en su mismo batchGet: no leen, no escriben, no
 * calculan costos ni puntuaciones. Columnas por encabezado (fila 1), nunca por posición.
 */

/** §3: pestañas del pipeline. Solo se piden las que existen (el lector filtra por los metadatos). */
export const PIPE_TABS = [
  'PIPE_PRODUCTOS', 'PIPE_PROVEEDORES', 'PIPE_COTIZACIONES', 'PIPE_EMBARQUES', 'PIPE_AUDITORIA', 'PIPE_PARAMETROS',
] as const
export type PipeTab = (typeof PIPE_TABS)[number]
export type PipeRaw = Partial<Record<PipeTab, unknown[][]>>

/** §1: etapas fijas, en este orden. */
export const ETAPAS = ['SUGERIDO', 'EVALUANDO', 'COTIZANDO', 'MUESTRA', 'EN_VENTA', 'DESCARTADO'] as const
export type Etapa = (typeof ETAPAS)[number]
export const ETIQUETAS_ETAPA: Record<Etapa, string> = {
  SUGERIDO: 'Sugerido', EVALUANDO: 'Evaluando', COTIZANDO: 'Cotizando', MUESTRA: 'Muestra', EN_VENTA: 'En venta',
  DESCARTADO: 'Descartado',
}
const SIN_ALERTA_ETAPA: readonly Etapa[] = ['EN_VENTA', 'DESCARTADO']

const K = ['K1', 'K2', 'K3', 'K4', 'K5', 'K6'] as const

// atajo: el lector pide A1:AZ (52 columnas, ULTIMA_COLUMNA en schema.ts); §3.1 ocupa 26. Si una pestaña crece más allá
// de AZ, ampliar ULTIMA_COLUMNA.
export const COLUMNAS_PRODUCTOS = [
  'PRODUCTO_ID', 'NOMBRE', 'ASIN', 'IDEA_ID', 'ORIGEN', 'ORIGEN_REF', 'ETAPA', 'ETAPA_DESDE', 'MOTIVO_DESCARTE',
  'KEEPA_FECHA', 'KEEPA_PRECIO_MXN_AVG90', 'KEEPA_BSR_AVG90', 'KEEPA_VENTAS_MES', 'KEEPA_OFERTAS', 'COSTO_MAX_MXN', ...K,
  'PROVEEDOR_ELEGIDO_ID', 'NOTAS', 'CREADO', 'ACTUALIZADO', 'VERSION',
] as const
const OBLIGATORIAS_PRODUCTOS = ['PRODUCTO_ID', 'NOMBRE', 'ETAPA', 'ETAPA_DESDE'] as const

export const COLUMNAS_PROVEEDORES = [
  'PROVEEDOR_ID', 'NOMBRE', 'CANAL', 'PAIS', 'CONTACTO', 'ESTADO', 'NOTAS', 'CREADO', 'ACTUALIZADO', 'VERSION',
] as const
const OBLIGATORIAS_PROVEEDORES = ['PROVEEDOR_ID', 'NOMBRE', 'ESTADO'] as const

export const COLUMNAS_COTIZACIONES = [
  'COTIZACION_ID', 'PRODUCTO_ID', 'PROVEEDOR_ID', 'ESTADO', 'FECHA_SOLICITUD', 'FECHA_RESPUESTA_ESPERADA',
  'FECHA_RECIBIDA', 'PRECIO_UNIT', 'MONEDA', 'MOQ', 'PLAZO_PRODUCCION_DIAS', 'INCOTERM', 'COSTO_ATERRIZADO_MXN',
  'MUESTRA_ESTADO', 'MUESTRA_FECHA_PEDIDO', 'MUESTRA_FECHA_ESPERADA', 'MUESTRA_FECHA_RECIBIDA', 'MUESTRA_COSTO',
  'MUESTRA_MONEDA', 'NOTAS', 'CREADO', 'ACTUALIZADO', 'VERSION',
] as const
const OBLIGATORIAS_COTIZACIONES = ['COTIZACION_ID', 'PRODUCTO_ID', 'PROVEEDOR_ID', 'ESTADO'] as const

export const COLUMNAS_EMBARQUES = [
  'EMBARQUE_ID', 'PRODUCTO_ID', 'COTIZACION_ID', 'UNIDADES', 'ESTADO', 'FECHA_PAGO', 'FECHA_SALIDA',
  'FECHA_LLEGADA_ESPERADA', 'FECHA_LLEGADA', 'COSTO_TOTAL', 'MONEDA', 'NOTAS', 'CREADO', 'ACTUALIZADO', 'VERSION',
] as const
const OBLIGATORIAS_EMBARQUES = ['EMBARQUE_ID', 'PRODUCTO_ID', 'ESTADO'] as const

/**
 * §3.5: para el historial de etapas solo se leen estas columnas, y solo se guardan las filas con `CAMPO` = `ETAPA`.
 * `ACTOR` (un correo) y los cambios de otros campos (entre ellos `CONTACTO`) nunca entran en la vista.
 */
const COLUMNAS_HISTORIAL = ['FECHA_HORA', 'REGISTRO_ID', 'CAMPO', 'VALOR_ANTES', 'VALOR_DESPUES'] as const

/** ❓ §3.6 dice «clave y valor» sin fijar los encabezados; hipótesis: `CLAVE` y `VALOR`. Se confirma al crearla. */
const COLUMNAS_PARAMETROS = ['CLAVE', 'VALOR'] as const
export const DIAS_ALERTA_ETAPA_DEFECTO = 14

/** ASIN de Amazon: 10 caracteres [A-Z0-9] (no solo los que empiezan por B0, como los ISBN-10 de libros). */
const ASIN = /^[A-Z0-9]{10}$/
export function asinValido(asin: string): boolean {
  return ASIN.test(asin)
}

const SIN_CREAR = (tab: string) => `${tab}: pestaña sin crear (la crea el propietario en la activación del pipeline, diseño §8).`
const SIN_FILAS = (tab: string) => `${tab}: sin filas todavía.`

function tabla(tab: PipeTab, rows: unknown[][] | undefined, columnas: readonly string[], obligatorias: readonly string[]) {
  return leerTabla(tab, rows, columnas, obligatorias, SIN_CREAR(tab), SIN_FILAS(tab))
}

export interface Alerta {
  tipo: 'cotizacion' | 'muestra' | 'embarque' | 'etapa'
  /** ID de la fila que la provoca (cotización, embarque o producto). */
  ref: string
  detalle: string
}

/** Fecha de negocio `AAAA-MM-DD` anterior a hoy. Vacía o no válida: no vence (la no válida se avisa aparte). */
function antesDeHoy(raw: string | null | undefined, hoy: string): boolean {
  const fecha = parseCivilDate(raw).value
  return fecha !== null && fecha < hoy
}

function fechaNoValida(raw: string | null | undefined): boolean {
  return parseCivilDate(raw).invalid
}

/** §5.2: cotización `SOLICITADA` y muestra `PEDIDA` con su fecha esperada ya pasada. */
export function alertasCotizacion(c: Fila, hoy: string): Alerta[] {
  const id = c.COTIZACION_ID ?? '—'
  const alertas: Alerta[] = []
  if (normalizeCode(c.ESTADO ?? null) === 'SOLICITADA' && antesDeHoy(c.FECHA_RESPUESTA_ESPERADA, hoy)) {
    alertas.push({ tipo: 'cotizacion', ref: id, detalle: `Cotización ${id} sin respuesta desde ${c.FECHA_RESPUESTA_ESPERADA}.` })
  }
  if (normalizeCode(c.MUESTRA_ESTADO ?? null) === 'PEDIDA' && antesDeHoy(c.MUESTRA_FECHA_ESPERADA, hoy)) {
    alertas.push({ tipo: 'muestra', ref: id, detalle: `Muestra de ${id} esperada el ${c.MUESTRA_FECHA_ESPERADA}.` })
  }
  return alertas
}

/** §5.2: embarque `PAGADO` o `EN_TRANSITO` con la llegada esperada ya pasada. */
export function alertaEmbarque(e: Fila, hoy: string): Alerta | null {
  const estado = normalizeCode(e.ESTADO ?? null)
  if ((estado === 'PAGADO' || estado === 'EN_TRANSITO') && antesDeHoy(e.FECHA_LLEGADA_ESPERADA, hoy)) {
    const id = e.EMBARQUE_ID ?? '—'
    return { tipo: 'embarque', ref: id, detalle: `Embarque ${id} esperado el ${e.FECHA_LLEGADA_ESPERADA}.` }
  }
  return null
}

/** §5.2: más de `DIAS_ALERTA_ETAPA` días en la etapa, salvo `EN_VENTA` y `DESCARTADO`. */
export function alertaEtapa(id: string, etapa: Etapa, dias: number | null, limite: number): Alerta | null {
  if (dias === null || SIN_ALERTA_ETAPA.includes(etapa) || dias <= limite) return null
  return { tipo: 'etapa', ref: id, detalle: `${dias} días en ${ETIQUETAS_ETAPA[etapa]} (aviso a partir de ${limite + 1}).` }
}

export interface Parametros {
  diasAlertaEtapa: number
  /** Etiqueta de K1 … K6; sin `PIPE_PARAMETROS`, los propios nombres. */
  etiquetasK: Record<(typeof K)[number], string>
  avisos: string[]
  bloque: Bloque<null>
}

function parametros(rows: unknown[][] | undefined): Parametros {
  const t = tabla('PIPE_PARAMETROS', rows, COLUMNAS_PARAMETROS, COLUMNAS_PARAMETROS)
  const valores = new Map<string, string>()
  if (t.estado === 'ok') {
    for (const f of t.datos.filas) {
      const valor = f.VALOR
      if (f.CLAVE && valor != null && !valores.has(f.CLAVE)) valores.set(f.CLAVE, valor)
    }
  }
  const avisos: string[] = []
  let diasAlertaEtapa = DIAS_ALERTA_ETAPA_DEFECTO
  const dias = valores.get('DIAS_ALERTA_ETAPA')
  if (dias !== undefined) {
    if (/^\d{1,4}$/.test(dias)) diasAlertaEtapa = Number(dias)
    else avisos.push(`DIAS_ALERTA_ETAPA no es un entero; se usa ${DIAS_ALERTA_ETAPA_DEFECTO}.`)
  }
  const etiquetasK = Object.fromEntries(K.map((k) => [k, valores.get(`${k}_NOMBRE`) ?? k])) as Parametros['etiquetasK']
  return { diasAlertaEtapa, etiquetasK, avisos, bloque: mapear(t, () => null) }
}

export interface Tarjeta {
  id: string
  nombre: string | null
  asin: string | null
  /** null sin ASIN (es opcional). */
  asinValido: boolean | null
  /** null si `ETAPA` no es una de §1: la tarjeta va a «fuera de etapa». */
  etapa: Etapa | null
  etapaTexto: string | null
  /** Días civiles en Mérida desde `ETAPA_DESDE`; null si falta o no se entiende. */
  dias: number | null
  origen: string | null
  proveedorElegido: { id: string; nombre: string | null } | null
  alertas: Alerta[]
  avisos: string[]
  fila: Fila
}

export interface Productos {
  tarjetas: Tarjeta[]
  /** Filas con datos pero sin `PRODUCTO_ID`: no se pintan. */
  sinId: number
}

export interface PipelineVista {
  /** Fecha civil de hoy en Mérida, la que decide qué está vencido. */
  hoy: string
  parametros: Parametros
  productos: Bloque<Productos>
  proveedores: Bloque<{ filas: Fila[] }>
  cotizaciones: Bloque<{ filas: Fila[] }>
  embarques: Bloque<{ filas: Fila[] }>
  /** Solo filas de `PIPE_AUDITORIA` con `CAMPO` = `ETAPA`, en el orden de la hoja. */
  historial: Bloque<{ filas: Fila[] }>
}

function filas<T extends { filas: Fila[] }>(b: Bloque<T>): Fila[] {
  return b.estado === 'ok' ? b.datos.filas : []
}

function agrupar(lista: Fila[], col: string): Map<string, Fila[]> {
  const m = new Map<string, Fila[]>()
  for (const f of lista) {
    const k = f[col]
    if (k) m.set(k, [...(m.get(k) ?? []), f])
  }
  return m
}

/** Cada pestaña resuelve su propio estado (§8): una con problema no impide pintar las demás. */
export function construirPipeline(raw: PipeRaw, now: number): PipelineVista {
  const hoy = civilDateInZone(now)
  const params = parametros(raw.PIPE_PARAMETROS)
  const proveedores = mapear(tabla('PIPE_PROVEEDORES', raw.PIPE_PROVEEDORES, COLUMNAS_PROVEEDORES, OBLIGATORIAS_PROVEEDORES), ({ filas: f }) => ({ filas: f }))
  const cotizaciones = mapear(tabla('PIPE_COTIZACIONES', raw.PIPE_COTIZACIONES, COLUMNAS_COTIZACIONES, OBLIGATORIAS_COTIZACIONES), ({ filas: f }) => ({ filas: f }))
  const embarques = mapear(tabla('PIPE_EMBARQUES', raw.PIPE_EMBARQUES, COLUMNAS_EMBARQUES, OBLIGATORIAS_EMBARQUES), ({ filas: f }) => ({ filas: f }))
  const historial = mapear(tabla('PIPE_AUDITORIA', raw.PIPE_AUDITORIA, COLUMNAS_HISTORIAL, COLUMNAS_HISTORIAL), ({ filas: f }) => ({
    filas: f.filter((x) => x.CAMPO === 'ETAPA'),
  }))

  const nombreProveedor = new Map(filas(proveedores).filter((p) => p.PROVEEDOR_ID).map((p) => [p.PROVEEDOR_ID as string, p.NOMBRE ?? null]))
  const cotPorProducto = agrupar(filas(cotizaciones), 'PRODUCTO_ID')
  const embPorProducto = agrupar(filas(embarques), 'PRODUCTO_ID')

  const productos = mapear(tabla('PIPE_PRODUCTOS', raw.PIPE_PRODUCTOS, COLUMNAS_PRODUCTOS, OBLIGATORIAS_PRODUCTOS), ({ filas: lista }) => {
    const tarjetas: Tarjeta[] = []
    let sinId = 0
    for (const f of lista) {
      const id = f.PRODUCTO_ID
      if (!id) {
        sinId++
        continue
      }
      const codigo = normalizeCode(f.ETAPA ?? null)
      const etapa = ETAPAS.find((e) => e === codigo) ?? null
      const desde = parseTimestamp(f.ETAPA_DESDE).value
      const dias = desde ? daysBetween(desde.date, hoy) : null
      const avisos: string[] = []
      if (f.ETAPA_DESDE && !desde) avisos.push('ETAPA_DESDE no es una fecha válida.')
      const alertas: Alerta[] = []
      const cots = cotPorProducto.get(id) ?? []
      for (const c of cots) {
        alertas.push(...alertasCotizacion(c, hoy))
        for (const col of ['FECHA_RESPUESTA_ESPERADA', 'MUESTRA_FECHA_ESPERADA'] as const) {
          if (fechaNoValida(c[col])) avisos.push(`${c.COTIZACION_ID ?? 'Cotización'}: ${col} no es AAAA-MM-DD.`)
        }
      }
      for (const e of embPorProducto.get(id) ?? []) {
        const a = alertaEmbarque(e, hoy)
        if (a) alertas.push(a)
        if (fechaNoValida(e.FECHA_LLEGADA_ESPERADA)) avisos.push(`${e.EMBARQUE_ID ?? 'Embarque'}: FECHA_LLEGADA_ESPERADA no es AAAA-MM-DD.`)
      }
      if (etapa) {
        const a = alertaEtapa(id, etapa, dias, params.diasAlertaEtapa)
        if (a) alertas.push(a)
      }
      const asin = f.ASIN ?? null
      const elegido = f.PROVEEDOR_ELEGIDO_ID ?? null
      tarjetas.push({
        id, nombre: f.NOMBRE ?? null, asin, asinValido: asin === null ? null : asinValido(asin), etapa, etapaTexto: f.ETAPA ?? null,
        dias, origen: f.ORIGEN ?? null, proveedorElegido: elegido ? { id: elegido, nombre: nombreProveedor.get(elegido) ?? null } : null,
        alertas, avisos, fila: f,
      })
    }
    return { tarjetas, sinId }
  })

  return { hoy, parametros: params, productos, proveedores, cotizaciones, embarques, historial }
}

/** Tarjetas de una etapa, en el orden de la hoja. */
export function enEtapa(tarjetas: Tarjeta[], etapa: Etapa): Tarjeta[] {
  return tarjetas.filter((t) => t.etapa === etapa)
}

export interface FiltroTablero {
  proveedor?: string
  origen?: string
  vencidas?: boolean
}

/** §2.1: filtros por proveedor elegido, origen y «con seguimiento vencido». */
export function filtrarTarjetas(tarjetas: Tarjeta[], filtro: FiltroTablero): Tarjeta[] {
  return tarjetas.filter((t) => (!filtro.proveedor || t.proveedorElegido?.id === filtro.proveedor)
    && (!filtro.origen || t.origen === filtro.origen)
    && (!filtro.vencidas || t.alertas.length > 0))
}

/**
 * Criterio 4 (H2 del revisor PRIMERO de #224): `CONTACTO` solo para el escritor del dashboard. La vista en caché es la
 * misma para todos los lectores, así que se recorta por petición antes de pintar. ORD-POS-102 (H1 de #228): las `NOTAS`
 * del proveedor tampoco, porque pueden llevar datos de contacto.
 */
export function paraLector(vista: PipelineVista, verContacto: boolean): PipelineVista {
  if (verContacto) return vista
  const proveedores = mapear(vista.proveedores, ({ filas: f }) => ({ filas: f.map((p) => ({ ...p, CONTACTO: null, NOTAS: null })) }))
  return { ...vista, proveedores }
}
