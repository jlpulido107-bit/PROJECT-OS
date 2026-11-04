import { normalizeCode, parseNumber } from '../parse'
import { COLUMNAS_COTIZACIONES, type PipeRaw } from './pipeline'
import { leerTabla, type Bloque, type Fila } from './tabla'

/**
 * Tabulador de cotizaciones de /eco/pipeline (ORD-POS-145, POS-048; DEC-ECO-008 con las respuestas del propietario del
 * 2026-11-04 en el issue #323; docs/diseno-eco-pipeline.md §14). Funciones puras sobre las filas que el lector de /eco ya
 * trajo: no leen, no escriben. Calcula el costo aterrizado por set normalizado a DDP en el CEDIS de Amazon MX y el
 * COSTO_MAX_MXN de cada producto. Las columnas `COSTO_ATERRIZADO_MXN` (cotización) y `COSTO_MAX_MXN` (producto) de la
 * hoja no se tocan: el cálculo va aparte. Un componente faltante nunca vale 0: el total queda «Por confirmar».
 */

/**
 * Bandera del propietario (§14.6): solo `ECO_TABULADOR=true` exacto, que pone únicamente el propietario con deploy.sh.
 * Apagada, /eco/pipeline no muestra la vista «Comparar» ni el desglose.
 */
export function ecoTabuladorHabilitado(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ECO_TABULADOR === 'true'
}

/** §14.1: columnas que la migración agrega al final de PIPE_COTIZACIONES, después de `VERSION`, en este orden. */
export const COLUMNAS_MIGRACION_COTIZACIONES = [
  'PAIS_ORIGEN', 'CERTIFICADO_ORIGEN', 'UNIDADES_POR_SET', 'CANTIDAD_COTIZADA', 'TIPO_CAMBIO', 'TIPO_CAMBIO_FECHA',
  'FLETE_LOCAL_EXPORT', 'FLETE_INTERNACIONAL', 'SEGURO', 'IGI_PCT', 'DTA', 'AGENTE_ADUANAL', 'FLETE_CEDIS',
  'COSTO_ATERRIZADO_CALC_MXN',
] as const

export interface MigracionCotizaciones {
  /** Columnas de §14.1 que faltan, en el orden en que se agregan al final. Vacía = migración aplicada. */
  faltan: string[]
  /** Encabezado resultante: el actual más las que faltan, al final. */
  encabezado: string[]
  /** Encabezados repetidos (la migración no se aplica sobre una fila 1 así: se corrige a mano primero). */
  repetidos: string[]
  /** La fila 1 aún no tiene `VERSION` (las columnas nuevas van después de ella). */
  sinVersion: boolean
}

/**
 * Plan de la migración explícita de PIPE_COTIZACIONES (§14.1). Idempotente: aplicada sobre su propio resultado no
 * agrega nada. Solo agrega columnas al final; nunca reordena, renombra ni borra.
 */
export function migracionCotizaciones(encabezado: readonly (string | null)[]): MigracionCotizaciones {
  const actual = encabezado.map((h) => (h ?? '').trim())
  const vistos = new Set<string>()
  const repetidos = new Set<string>()
  for (const h of actual) {
    if (!h) continue
    if (vistos.has(h)) repetidos.add(h)
    vistos.add(h)
  }
  const faltan = COLUMNAS_MIGRACION_COTIZACIONES.filter((c) => !vistos.has(c))
  // Sin celdas vacías de cola: las columnas nuevas van justo después de la última con encabezado.
  let fin = actual.length
  while (fin > 0 && !actual[fin - 1]) fin--
  return { faltan, encabezado: [...actual.slice(0, fin), ...faltan], repetidos: [...repetidos], sinVersion: !vistos.has('VERSION') }
}

/** §14.2: claves de PIPE_PARAMETROS que lee el tabulador. Porcentajes en puntos (25 = 25 %), con o sin «%». */
export const PAISES_IGI = ['CN', 'US', 'VN', 'CO'] as const
export const CLAVES_PARAMETROS_TABULADOR = [
  'TIPO_CAMBIO_USD_MXN', 'TIPO_CAMBIO_USD_MXN_FECHA', ...PAISES_IGI.map((p) => `IGI_PCT_${p}`), 'IGI_PCT_OTRO', 'DTA_PCT',
  'AGENTE_ADUANAL_REF', 'FLETE_CEDIS_REF', 'MARGEN_K2_PCT', 'PPC_PCT', 'DEVOLUCIONES_PCT',
] as const
/** Valores de la orden (DEC-ECO-008) si la clave no está en PIPE_PARAMETROS; se avisa. */
export const PORCENTAJES_DEFECTO = { MARGEN_K2_PCT: 25, PPC_PCT: 15, DEVOLUCIONES_PCT: 8 } as const
/** Tope del capital del primer lote (criterio 5). */
export const TOPE_CAPITAL_MXN = 30_000

export const INCOTERMS_TABULADOR = ['EXW', 'FCA', 'FOB', 'CIF', 'DAP', 'DDP'] as const
type Incoterm = (typeof INCOTERMS_TABULADOR)[number]
type Base = 'EXW' | 'FOB' | 'CIF' | 'DDP'
/** FCA se trata como FOB y DAP como CIF más impuestos (criterio 1). */
const BASE: Record<Incoterm, Base> = { EXW: 'EXW', FCA: 'FOB', FOB: 'FOB', CIF: 'CIF', DAP: 'CIF', DDP: 'DDP' }

/** Criterio 6. */
export const ESTADOS_TABULADOR = ['SOLICITADA', 'RECIBIDA', 'RECIBIDA (PARCIAL)', 'DESCARTADA'] as const

export const POR_CONFIRMAR = 'Por confirmar'

export type Origen = 'COTIZACION' | 'SUPUESTO' | 'POR_CONFIRMAR'

export interface Componente {
  clave: string
  etiqueta: string
  /** Monto en MXN del embarque cotizado; null = «Por confirmar». */
  mxn: number | null
  origen: Origen
  /** Cómo se obtuvo (porcentaje, tipo de cambio o motivo de «Por confirmar»). */
  detalle: string | null
}

export interface CostoAterrizado {
  incoterm: string | null
  /** Incoterm con el que se calcula (FCA → FOB, DAP → CIF); null si no es válido. */
  base: Base | null
  componentes: Componente[]
  valorAduanaMxn: number | null
  totalMxn: number | null
  sets: number | null
  porSetMxn: number | null
  porUnidadMxn: number | null
  tipoCambio: { valor: number; fecha: string | null; origen: Origen } | null
  /** Componentes que salieron de PIPE_PARAMETROS porque la cotización los dejó vacíos. */
  supuestos: string[]
  /** Lo que falta para tener total; vacío si hay total. */
  porConfirmar: string[]
  avisos: string[]
}

export interface Parametros {
  numero: (clave: string) => number | null
  pct: (clave: string) => number | null
  texto: (clave: string) => string | null
  avisos: string[]
}

const PCT = /^([+-]?\d+(?:[.,]\d+)?)\s*%?$/

/** Porcentaje en puntos (25 o «25 %») como fracción; null si vacío, no numérico o fuera de 0..100. */
export function fraccionDePuntos(raw: string | null | undefined): number | null {
  const m = raw == null ? null : PCT.exec(raw.trim())
  if (!m) return null
  const v = Number(m[1]!.replace(',', '.'))
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v / 100 : null
}

/** Número ≥ 0 o null (vacío o no válido). */
function noNegativo(raw: string | null | undefined): number | null {
  const v = parseNumber(raw ?? null).value
  return v !== null && v >= 0 ? v : null
}

export function leerParametros(rows: unknown[][] | undefined): Parametros {
  const valores = new Map<string, string>()
  const t = leerTabla('PIPE_PARAMETROS', rows, ['CLAVE', 'VALOR'], ['CLAVE', 'VALOR'], '', '')
  if (t.estado === 'ok') {
    for (const f of t.datos.filas) if (f.CLAVE && f.VALOR != null && !valores.has(f.CLAVE)) valores.set(f.CLAVE, f.VALOR)
  }
  const avisos: string[] = []
  const invalido = (clave: string) => {
    const a = `PIPE_PARAMETROS: ${clave} no es un valor válido; se trata como vacío.`
    if (!avisos.includes(a)) avisos.push(a)
  }
  return {
    texto: (clave) => valores.get(clave) ?? null,
    numero: (clave) => {
      const raw = valores.get(clave)
      if (raw === undefined) return null
      const v = noNegativo(raw)
      if (v === null) invalido(clave)
      return v
    },
    pct: (clave) => {
      const raw = valores.get(clave)
      if (raw === undefined) return null
      const v = fraccionDePuntos(raw)
      if (v === null) invalido(clave)
      return v
    },
    avisos,
  }
}

const fmtPct = (f: number) => `${Number((f * 100).toFixed(4))} %`

/**
 * Costo aterrizado de una cotización (DEC-ECO-008, §14.3). Montos del embarque cotizado (`CANTIDAD_COTIZADA` unidades):
 * `PRECIO_UNIT`, `FLETE_LOCAL_EXPORT`, `FLETE_INTERNACIONAL` y `SEGURO` en la `MONEDA` de la cotización (MXN o USD);
 * `AGENTE_ADUANAL` y `FLETE_CEDIS` en MXN; `IGI_PCT` y `DTA` en puntos porcentuales sobre el valor en aduana.
 */
export function costoAterrizado(c: Fila, p: Parametros): CostoAterrizado {
  const supuestos: string[] = []
  const porConfirmar: string[] = []
  const avisos: string[] = []
  const componentes: Componente[] = []
  const falta = (etiqueta: string, motivo: string): Componente => {
    porConfirmar.push(`${etiqueta}: ${motivo}`)
    return { clave: '', etiqueta, mxn: null, origen: 'POR_CONFIRMAR', detalle: motivo }
  }
  const numeroDe = (col: string): number | null => {
    const raw = c[col] ?? null
    const v = noNegativo(raw)
    if (raw !== null && v === null) avisos.push(`${col} no es un número ≥ 0 («${raw.slice(0, 40)}»); se trata como vacío.`)
    return v
  }

  const incotermTexto = c.INCOTERM ?? null
  const incoterm = INCOTERMS_TABULADOR.find((i) => i === normalizeCode(incotermTexto)) ?? null
  const base = incoterm ? BASE[incoterm] : null
  if (!base) porConfirmar.push(incotermTexto ? `INCOTERM «${incotermTexto}» no es EXW, FCA, FOB, CIF, DAP ni DDP` : 'INCOTERM vacío')

  // Tipo de cambio: 1 en MXN; en USD, el de la cotización o el de PIPE_PARAMETROS (SUPUESTO).
  const moneda = normalizeCode(c.MONEDA ?? null)
  let tipoCambio: CostoAterrizado['tipoCambio'] = null
  if (moneda === 'MXN') tipoCambio = { valor: 1, fecha: null, origen: 'COTIZACION' }
  else if (moneda === 'USD') {
    const propio = numeroDe('TIPO_CAMBIO')
    if (propio !== null && propio > 0) tipoCambio = { valor: propio, fecha: c.TIPO_CAMBIO_FECHA ?? null, origen: 'COTIZACION' }
    else {
      const param = p.numero('TIPO_CAMBIO_USD_MXN')
      if (param !== null && param > 0) {
        tipoCambio = { valor: param, fecha: p.texto('TIPO_CAMBIO_USD_MXN_FECHA'), origen: 'SUPUESTO' }
        supuestos.push('Tipo de cambio')
      } else porConfirmar.push('Tipo de cambio: vacío en la cotización y en PIPE_PARAMETROS (TIPO_CAMBIO_USD_MXN)')
    }
  } else porConfirmar.push(c.MONEDA ? `MONEDA «${c.MONEDA}»: el tabulador solo convierte MXN y USD` : 'MONEDA vacía')
  const fx = tipoCambio?.valor ?? null
  /** Un monto convertido con el tipo de cambio de PIPE_PARAMETROS es también SUPUESTO. */
  const origenFx = (): Origen => (tipoCambio?.origen === 'SUPUESTO' ? 'SUPUESTO' : 'COTIZACION')

  const cantidad = numeroDe('CANTIDAD_COTIZADA')
  const enMoneda = (col: string, etiqueta: string): Componente => {
    const v = numeroDe(col)
    if (v === null) return { ...falta(etiqueta, `${col} vacío`), clave: col }
    if (fx === null) return { ...falta(etiqueta, 'sin tipo de cambio'), clave: col }
    return { clave: col, etiqueta, mxn: v * fx, origen: origenFx(), detalle: moneda === 'USD' ? `${v} USD × ${fx}` : null }
  }

  // Mercancía: PRECIO_UNIT × CANTIDAD_COTIZADA.
  const precio = numeroDe('PRECIO_UNIT')
  let mercancia: Componente
  if (precio === null) mercancia = falta('Mercancía', 'PRECIO_UNIT vacío')
  else if (cantidad === null || cantidad <= 0) mercancia = falta('Mercancía', 'CANTIDAD_COTIZADA vacía o 0')
  else if (fx === null) mercancia = falta('Mercancía', 'sin tipo de cambio')
  else mercancia = { clave: 'PRECIO_UNIT', etiqueta: 'Mercancía', mxn: precio * cantidad * fx, origen: origenFx(), detalle: `${precio} ${moneda} × ${cantidad}${fx !== 1 ? ` × ${fx}` : ''}` }
  componentes.push({ ...mercancia, clave: 'PRECIO_UNIT' })

  /** Componente en MXN con respaldo en PIPE_PARAMETROS (SUPUESTO). */
  const enMxn = (col: string, ref: string, etiqueta: string): Componente => {
    const v = numeroDe(col)
    if (v !== null) return { clave: col, etiqueta, mxn: v, origen: 'COTIZACION', detalle: null }
    const param = p.numero(ref)
    if (param !== null) {
      supuestos.push(etiqueta)
      return { clave: col, etiqueta, mxn: param, origen: 'SUPUESTO', detalle: `${ref} de PIPE_PARAMETROS` }
    }
    return { ...falta(etiqueta, `${col} vacío y sin ${ref} en PIPE_PARAMETROS`), clave: col }
  }

  /** Porcentaje de la cotización o de PIPE_PARAMETROS (SUPUESTO). */
  const porcentaje = (col: string, ref: string, etiqueta: string): { f: number | null; origen: Origen; detalle: string } => {
    const raw = c[col] ?? null
    const propio = fraccionDePuntos(raw)
    if (raw !== null && propio === null) avisos.push(`${col} no es un porcentaje de 0 a 100 («${raw.slice(0, 40)}»); se trata como vacío.`)
    if (propio !== null) return { f: propio, origen: 'COTIZACION', detalle: fmtPct(propio) }
    const param = p.pct(ref)
    if (param !== null) {
      supuestos.push(etiqueta)
      return { f: param, origen: 'SUPUESTO', detalle: `${fmtPct(param)} (${ref} de PIPE_PARAMETROS)` }
    }
    return { f: null, origen: 'POR_CONFIRMAR', detalle: `${col} vacío y sin ${ref} en PIPE_PARAMETROS` }
  }

  if (base === 'EXW') componentes.push(enMoneda('FLETE_LOCAL_EXPORT', 'Flete local y despacho de exportación'))
  if (base === 'EXW' || base === 'FOB') {
    componentes.push(enMoneda('FLETE_INTERNACIONAL', 'Flete internacional'), enMoneda('SEGURO', 'Seguro'))
  }

  // Valor en aduana (base del IGI y del DTA): mercancía + fletes y seguro previos a la frontera.
  const suma = (lista: Componente[]) => (lista.some((x) => x.mxn === null) ? null : lista.reduce((s, x) => s + (x.mxn as number), 0))
  const valorAduanaMxn = base && base !== 'DDP' ? suma(componentes) : null

  if (base && base !== 'DDP') {
    // IGI: 0 con certificado de origen (T-MEC o CPTPP); si no, el de la cotización o el del país en PIPE_PARAMETROS.
    const cert = normalizeCode(c.CERTIFICADO_ORIGEN ?? null)
    if (c.CERTIFICADO_ORIGEN && cert !== 'SI' && cert !== 'NO') avisos.push(`CERTIFICADO_ORIGEN «${c.CERTIFICADO_ORIGEN}» no es SI ni NO; se trata como NO.`)
    if (cert === 'SI') componentes.push({ clave: 'IGI_PCT', etiqueta: 'IGI', mxn: 0, origen: 'COTIZACION', detalle: 'Certificado de origen: IGI 0 %' })
    else {
      if (cert !== 'NO') supuestos.push('Certificado de origen (se supone NO)')
      const pais = normalizeCode(c.PAIS_ORIGEN ?? null)
      const clavePais = pais ? `IGI_PCT_${(PAISES_IGI as readonly string[]).includes(pais) ? pais : 'OTRO'}` : null
      const propio = fraccionDePuntos(c.IGI_PCT ?? null)
      const igi = propio !== null || clavePais ? porcentaje('IGI_PCT', clavePais ?? 'IGI_PCT_<país>', 'IGI') : { f: null, origen: 'POR_CONFIRMAR' as Origen, detalle: 'IGI_PCT y PAIS_ORIGEN vacíos' }
      if (igi.f === null || valorAduanaMxn === null) componentes.push({ ...falta('IGI', igi.f === null ? igi.detalle : 'sin valor en aduana'), clave: 'IGI_PCT' })
      else componentes.push({ clave: 'IGI_PCT', etiqueta: 'IGI', mxn: valorAduanaMxn * igi.f, origen: igi.origen, detalle: `${igi.detalle} del valor en aduana` })
    }
    const dta = porcentaje('DTA', 'DTA_PCT', 'DTA')
    if (dta.f === null || valorAduanaMxn === null) componentes.push({ ...falta('DTA', dta.f === null ? dta.detalle : 'sin valor en aduana'), clave: 'DTA' })
    else componentes.push({ clave: 'DTA', etiqueta: 'DTA', mxn: valorAduanaMxn * dta.f, origen: dta.origen, detalle: `${dta.detalle} del valor en aduana` })
    componentes.push(enMxn('AGENTE_ADUANAL', 'AGENTE_ADUANAL_REF', 'Agente aduanal'))
  }
  // DDP: flete al CEDIS solo si la cotización no lo incluye (0 en FLETE_CEDIS = incluido).
  if (base) componentes.push(enMxn('FLETE_CEDIS', 'FLETE_CEDIS_REF', 'Flete al CEDIS'))

  const totalMxn = base ? suma(componentes) : null
  const unidadesSet = numeroDe('UNIDADES_POR_SET')
  let sets: number | null = null
  if (unidadesSet === null || unidadesSet <= 0) porConfirmar.push('UNIDADES_POR_SET vacío o 0')
  else if (cantidad !== null && cantidad > 0) sets = cantidad / unidadesSet
  const porSetMxn = totalMxn !== null && sets !== null ? totalMxn / sets : null
  const porUnidadMxn = totalMxn !== null && cantidad !== null && cantidad > 0 ? totalMxn / cantidad : null
  return {
    incoterm: incotermTexto, base, componentes, valorAduanaMxn, totalMxn, sets, porSetMxn, porUnidadMxn, tipoCambio,
    supuestos: [...new Set(supuestos)], porConfirmar: totalMxn !== null && porSetMxn !== null ? [] : porConfirmar, avisos,
  }
}

/** Datos de Amazon de una idea: UNIT_ECONOMICS (columnas AMZ_*) o la última semana de AMZ_RESUMEN (sin prefijo). */
const COLUMNAS_UE = ['IDEA_ID', 'AMZ_PRECIO_MXN', 'AMZ_COMISION_MXN', 'AMZ_COMISION_PCT', 'AMZ_FBA_MXN', 'AMZ_TARIFAS_FECHA'] as const
const COLUMNAS_RES = ['SEMANA', 'IDEA_ID', 'ESTADO', 'PRECIO_MXN', 'COMISION_MXN', 'COMISION_PCT', 'FBA_MXN', 'TARIFAS_FECHA'] as const

export interface CostoMaximo {
  /** null = «Por confirmar». */
  mxn: number | null
  precio: { mxn: number; fuente: 'UNIT_ECONOMICS' | 'AMZ_RESUMEN' } | null
  comisionMxn: number | null
  fbaMxn: number | null
  porcentajes: { ppc: number; devoluciones: number; margenK2: number }
  /** Fecha de los datos: la de AMZ_RESUMEN o la de UNIT_ECONOMICS; «sin fecha» si no hay. */
  fecha: string
  porConfirmar: string[]
}

export interface DatosAmazon {
  ue: Map<string, Fila>
  resumen: Map<string, Fila>
}

export function datosAmazon(raw: { UNIT_ECONOMICS?: unknown[][]; AMZ_RESUMEN?: unknown[][] }): DatosAmazon {
  const ue = new Map<string, Fila>()
  const t = leerTabla('UNIT_ECONOMICS', raw.UNIT_ECONOMICS, COLUMNAS_UE, ['IDEA_ID'], '', '')
  if (t.estado === 'ok') for (const f of t.datos.filas) if (f.IDEA_ID && !ue.has(f.IDEA_ID)) ue.set(f.IDEA_ID, f)
  const resumen = new Map<string, Fila>()
  const r = leerTabla('AMZ_RESUMEN', raw.AMZ_RESUMEN, COLUMNAS_RES, ['SEMANA', 'IDEA_ID'], '', '')
  if (r.estado === 'ok') {
    // Última semana con ESTADO OK; si ninguna es OK, la última. `AAAA-Www` ordena como texto.
    const mejor = (a: Fila | undefined, b: Fila) => {
      if (!a) return b
      const [okA, okB] = [a.ESTADO === 'OK', b.ESTADO === 'OK']
      if (okA !== okB) return okB ? b : a
      return (b.SEMANA ?? '') >= (a.SEMANA ?? '') ? b : a
    }
    for (const f of r.datos.filas) if (f.IDEA_ID && f.SEMANA) resumen.set(f.IDEA_ID, mejor(resumen.get(f.IDEA_ID), f))
  }
  return { ue, resumen }
}

/**
 * COSTO_MAX_MXN (DEC-ECO-008, §14.4) = precio − comisión − FBA − PPC % × precio − devoluciones % × precio − margen K2 % ×
 * precio; todos los porcentajes sobre el mismo precio, no en cadena. El IVA de importación no entra.
 */
export function costoMaximo(ideaId: string | null, amz: DatosAmazon, p: Parametros): CostoMaximo {
  const porcentaje = (clave: keyof typeof PORCENTAJES_DEFECTO) => p.pct(clave) ?? PORCENTAJES_DEFECTO[clave] / 100
  const porcentajes = { ppc: porcentaje('PPC_PCT'), devoluciones: porcentaje('DEVOLUCIONES_PCT'), margenK2: porcentaje('MARGEN_K2_PCT') }
  const vacio = (motivo: string): CostoMaximo => ({ mxn: null, precio: null, comisionMxn: null, fbaMxn: null, porcentajes, fecha: 'sin fecha', porConfirmar: [motivo] })
  if (!ideaId) return vacio('El producto no tiene IDEA_ID: no se sabe de qué idea salen el precio y las tarifas')
  const ue = amz.ue.get(ideaId)
  const res = amz.resumen.get(ideaId)
  const de = (colUe: string, colRes: string) => noNegativo(ue?.[colUe]) ?? noNegativo(res?.[colRes])
  const precioUe = noNegativo(ue?.AMZ_PRECIO_MXN)
  const precioRes = noNegativo(res?.PRECIO_MXN)
  const precio = precioUe !== null ? { mxn: precioUe, fuente: 'UNIT_ECONOMICS' as const } : precioRes !== null ? { mxn: precioRes, fuente: 'AMZ_RESUMEN' as const } : null
  const fecha = precio?.fuente === 'AMZ_RESUMEN' ? (res?.TARIFAS_FECHA ?? (res?.SEMANA ? `semana ${res.SEMANA}` : 'sin fecha'))
    : precio ? (ue?.AMZ_TARIFAS_FECHA ?? 'sin fecha') : 'sin fecha'
  let comisionMxn = de('AMZ_COMISION_MXN', 'COMISION_MXN')
  // Sin monto: AMZ_COMISION_PCT = comisión / precio (fracción, RADAROS diseno-v1-2.md §2.2); «15%» se lee como 0.15.
  const pctRaw = (ue?.AMZ_COMISION_PCT ?? res?.COMISION_PCT ?? '').trim()
  if (comisionMxn === null && precio && pctRaw) {
    const pct = parseNumber(pctRaw.replace(/%$/, '')).value
    if (pct !== null && pct >= 0) comisionMxn = precio.mxn * (pctRaw.endsWith('%') ? pct / 100 : pct)
  }
  const fbaMxn = de('AMZ_FBA_MXN', 'FBA_MXN')
  const porConfirmar: string[] = []
  if (!precio) porConfirmar.push(`Sin precio de venta de ${ideaId} en UNIT_ECONOMICS ni en AMZ_RESUMEN`)
  if (comisionMxn === null) porConfirmar.push(`Sin comisión de Amazon de ${ideaId}`)
  if (fbaMxn === null) porConfirmar.push(`Sin tarifa FBA de ${ideaId}`)
  if (!precio || comisionMxn === null || fbaMxn === null) return { ...vacio(''), precio, comisionMxn, fbaMxn, fecha, porConfirmar }
  const { ppc, devoluciones, margenK2 } = porcentajes
  const mxn = precio.mxn - comisionMxn - fbaMxn - (ppc + devoluciones + margenK2) * precio.mxn
  return { mxn, precio, comisionMxn, fbaMxn, porcentajes, fecha, porConfirmar: [] }
}

export interface FilaComparada {
  id: string
  estado: string | null
  /** false si ESTADO no es uno de los del criterio 6. */
  estadoValido: boolean
  proveedorId: string | null
  proveedor: string | null
  pais: string | null
  incoterm: string | null
  moq: number | null
  plazoDias: string | null
  costo: CostoAterrizado
  /** `COSTO_ATERRIZADO_CALC_MXN` de la hoja, si lo tiene, y si difiere del cálculo (más de 1 MXN). */
  calcHoja: { valor: string; difiere: boolean } | null
  /** porSet − COSTO_MAX_MXN: ≤ 0 cumple; null = «Por confirmar». */
  diferenciaMxn: number | null
  /** MOQ × costo aterrizado por unidad. */
  capitalPrimerLoteMxn: number | null
}

export interface Comparacion {
  productoId: string
  costoMaximo: CostoMaximo
  filas: FilaComparada[]
}

export interface TabuladorVista {
  /** Plan de la migración sobre la fila 1 leída de PIPE_COTIZACIONES; null si la pestaña no existe. */
  migracion: MigracionCotizaciones | null
  parametros: Parametros
  bloque: Bloque<null>
  comparar: (productoId: string, ideaId: string | null) => Comparacion
}

const COLUMNAS_LECTURA = [...COLUMNAS_COTIZACIONES, ...COLUMNAS_MIGRACION_COTIZACIONES] as const

/** Orden de la vista «Comparar»: costo aterrizado por set de menor a mayor; «Por confirmar» y DESCARTADA al final. */
function ordenar(a: FilaComparada, b: FilaComparada): number {
  const descartada = (f: FilaComparada) => (normalizeCode(f.estado) === 'DESCARTADA' ? 1 : 0)
  if (descartada(a) !== descartada(b)) return descartada(a) - descartada(b)
  const [x, y] = [a.costo.porSetMxn, b.costo.porSetMxn]
  if (x !== null && y !== null && x !== y) return x - y
  if ((x === null) !== (y === null)) return x === null ? 1 : -1
  return a.id.localeCompare(b.id, 'es')
}

const ESTADO_NORMAL = (e: string | null) => (e ?? '').trim().toUpperCase().replace(/\s+/g, ' ')

export function construirTabulador(raw: PipeRaw & { UNIT_ECONOMICS?: unknown[][]; AMZ_RESUMEN?: unknown[][] }): TabuladorVista {
  const parametros = leerParametros(raw.PIPE_PARAMETROS)
  const amz = datosAmazon(raw)
  const t = leerTabla('PIPE_COTIZACIONES', raw.PIPE_COTIZACIONES, COLUMNAS_LECTURA, ['COTIZACION_ID', 'PRODUCTO_ID'],
    'PIPE_COTIZACIONES: pestaña sin crear.', 'PIPE_COTIZACIONES: sin filas todavía.')
  const migracion = raw.PIPE_COTIZACIONES ? migracionCotizaciones((raw.PIPE_COTIZACIONES[0] ?? []).map((h) => (h == null ? null : String(h)))) : null
  const proveedores = new Map<string, Fila>()
  const tp = leerTabla('PIPE_PROVEEDORES', raw.PIPE_PROVEEDORES, ['PROVEEDOR_ID', 'NOMBRE', 'PAIS'], ['PROVEEDOR_ID'], '', '')
  if (tp.estado === 'ok') for (const f of tp.datos.filas) if (f.PROVEEDOR_ID && !proveedores.has(f.PROVEEDOR_ID)) proveedores.set(f.PROVEEDOR_ID, f)
  const cotizaciones = t.estado === 'ok' ? t.datos.filas : []

  function comparar(productoId: string, ideaId: string | null): Comparacion {
    const max = costoMaximo(ideaId, amz, parametros)
    const filas = cotizaciones.filter((c) => c.PRODUCTO_ID === productoId && c.COTIZACION_ID).map((c): FilaComparada => {
      const costo = costoAterrizado(c, parametros)
      const prov = c.PROVEEDOR_ID ? proveedores.get(c.PROVEEDOR_ID) : undefined
      const moq = noNegativo(c.MOQ)
      const calc = c.COSTO_ATERRIZADO_CALC_MXN ?? null
      const calcNum = parseNumber(calc).value
      const estado = c.ESTADO ?? null
      return {
        id: c.COTIZACION_ID as string, estado, estadoValido: (ESTADOS_TABULADOR as readonly string[]).includes(ESTADO_NORMAL(estado)),
        proveedorId: c.PROVEEDOR_ID ?? null, proveedor: prov?.NOMBRE ?? null, pais: c.PAIS_ORIGEN ?? prov?.PAIS ?? null,
        incoterm: c.INCOTERM ?? null, moq, plazoDias: c.PLAZO_PRODUCCION_DIAS ?? null, costo,
        calcHoja: calc === null ? null : { valor: calc, difiere: costo.porSetMxn === null || calcNum === null || Math.abs(calcNum - costo.porSetMxn) > 1 },
        diferenciaMxn: costo.porSetMxn !== null && max.mxn !== null ? costo.porSetMxn - max.mxn : null,
        capitalPrimerLoteMxn: moq !== null && costo.porUnidadMxn !== null ? moq * costo.porUnidadMxn : null,
      }
    })
    return { productoId, costoMaximo: max, filas: filas.sort(ordenar) }
  }

  return { migracion, parametros, bloque: t.estado === 'ok' ? { ...t, datos: null } : t, comparar }
}

/** «Cumple» o «No cumple por X MXN» (criterio 5); «Por confirmar» si falta el costo o el máximo. */
export function veredicto(diferenciaMxn: number | null): string {
  if (diferenciaMxn === null) return POR_CONFIRMAR
  return diferenciaMxn <= 0 ? 'Cumple' : `No cumple por ${formatoMxn(diferenciaMxn)} MXN`
}

/** Montos con 2 decimales y separador de miles; null = «Por confirmar» (nunca 0). */
export function formatoMxn(v: number | null): string {
  if (v === null) return POR_CONFIRMAR
  return v.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
