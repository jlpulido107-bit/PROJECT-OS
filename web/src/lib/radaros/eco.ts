import { civilDateInZone, parseTimestamp } from '../dates'
import { cellText, parseNumber } from '../parse'
import { etiquetaK4, type EtiquetaK4 } from './eco-columnas'
import { MAX_DATA_ROWS } from '../schema'
import { construirPipeline, PIPE_TABS, type PipelineVista, type PipeTab } from './pipeline'
import { construirTabulador, type TabuladorVista } from './pipeline-tabulador'
import type { BandejaVista } from './pipeline-bandeja-gemini'
import { leerTabla, mapear, type Bloque, type Fila } from './tabla'

export type { Bloque, Fila } from './tabla'

/**
 * Vista de solo lectura del motor de RADAROS (/eco, ORD-POS-067). Funciones puras sobre las filas que el lector ya
 * trajo: no leen, no escriben y no calculan puntuaciones ni márgenes (docs/diseno-eco-radaros.md §1 y §3).
 * Las columnas se buscan por nombre de encabezado (fila 1), nunca por posición; las no listadas se ignoran.
 */

/**
 * Pestañas que lee /eco (§3). `AMZ_CANDIDATOS` no se pide: sus columnas las fija el diseño de V1.3. `PRODUCTS` (las
 * ideas de RADAROS, solo lectura) da el nombre de cada idea (ORD-POS-113).
 */
export const ECO_TABS = ['AMZ_CORRIDAS', 'SCORING', 'AMZ_RESUMEN', 'UNIT_ECONOMICS', 'ML_TRENDS_ANALISIS_AUTO', 'PRODUCTS'] as const
export type EcoTab = (typeof ECO_TABS)[number]
export type EcoRaw = Partial<Record<EcoTab | PipeTab, unknown[][]>>
/** Lo que pide el lector en un solo batchGet: /eco y las pestañas PIPE_* del pipeline (ORD-POS-097). */
export const ECO_LECTURA = [...ECO_TABS, ...PIPE_TABS] as const

/**
 * ❓ Por confirmar en la activación (diseño §3.2 y §9): nombre de la columna de ID de idea en SCORING y
 * UNIT_ECONOMICS. Hipótesis: `IDEA_ID`, el nombre que usan AMZ_IDEA_ASIN y AMZ_RESUMEN (RADAROS docs/diseno-v1-2.md §5).
 */
export const COLUMNA_ID_IDEA = 'IDEA_ID'
/**
 * ❓ Por confirmar en la activación: la puntuación final la definen las fórmulas actuales de SCORING (RADAROS
 * docs/diseno-v1-2.md §1). Se usa la primera de estas columnas que exista; sin ninguna, el ranking va por ID con aviso.
 */
export const COLUMNAS_PUNTUACION = ['PUNTUACION_FINAL', 'PUNTUACION', 'SCORE_FINAL', 'SCORE'] as const

/** RADAROS docs/diseno-v1-2.md §5 (AMZ_CORRIDAS). */
export const COLUMNAS_CORRIDAS = [
  'CORRIDA_ID', 'SEMANA', 'MARKETPLACE', 'INICIO', 'FIN', 'ESTADO', 'IDEAS', 'ASINS_OK', 'ASINS_FALTAN',
  'KEEPA_TOKENS_CONSUMIDOS', 'KEEPA_TOKENS_RESTANTES', 'SPAPI_LLAMADAS', 'MENSAJE',
] as const
const OBLIGATORIAS_CORRIDAS = ['SEMANA', 'INICIO', 'ESTADO'] as const

/** RADAROS docs/diseno-v1-2.md §2.1, agrupadas como en la tabla del diseño. */
export const GRUPOS_SCORING = {
  Demanda: ['AMZ_DEMANDA_BSR_AVG90', 'AMZ_DEMANDA_CAIDAS_BSR_30D', 'AMZ_DEMANDA_VENTAS_MES', 'AMZ_DEMANDA_RANK_CATEGORIA'],
  Competencia: [
    'AMZ_COMPETENCIA_OFERTAS', 'AMZ_COMPETENCIA_OFERTAS_FBA', 'AMZ_COMPETENCIA_AMAZON_VENDE', 'AMZ_COMPETENCIA_RESENAS',
    'AMZ_COMPETENCIA_RATING',
  ],
  Tendencia: ['AMZ_TENDENCIA_BSR_30_VS_90', 'AMZ_TENDENCIA_VENTAS_DELTA90', 'AMZ_TENDENCIA_PRECIO_30_VS_90', 'AMZ_TENDENCIA_GTRENDS'],
} as const
/**
 * Encabezados de PRODUCTS. ✅ En el libro real (leídos por el PM el 2026-11-02, ORD-POS-135): `PRODUCT_ID` y
 * «Producto / Idea». Los demás se conservan de ORD-POS-113 (RADAROS docs/diseno-v1-2.md §1; sus pruebas usan `ID`).
 * Se usa la primera que exista, comparada con `normalizarEncabezado`; sin columna de nombre, /eco muestra solo el ID.
 */
export const COLUMNAS_ID_PRODUCTS = [COLUMNA_ID_IDEA, 'ID', 'PRODUCT_ID'] as const
export const COLUMNAS_NOMBRE_PRODUCTS = ['PRODUCTO_IDEA', 'NOMBRE', 'PRODUCTO', 'NOMBRE_PRODUCTO', 'IDEA', 'DESCRIPCION'] as const
const COLUMNAS_SCORING_AMZ = ['AMZ_SEMANA', ...Object.values(GRUPOS_SCORING).flat(), 'AMZ_ESTADO']

/**
 * Validación macro de Google Trends (K4, ORD-POS-148): columnas que ORD-ECO-024 (RADAROS#54) agregó al final de SCORING
 * (✅ AL:AQ leídas por el PM con el conector el 2026-11-07). Se leen por encabezado; si no está ninguna, /eco no
 * cambia. /eco no consulta SerpApi ni escribe en SCORING: solo muestra lo que RADAROS dejó.
 */
export const COLUMNAS_TRENDS_SCORING = [
  'KW_RAIZ_TRENDS', 'TREND_INTERANUAL', 'TREND_PENDIENTE_52S', 'TREND_CV_52S', 'K4_MACRO_STATUS', 'TREND_FECHA',
] as const
/** Grupo «Macro (Trends)» del detalle de cada idea; `K4_MACRO_STATUS` va como etiqueta en el ranking. */
export const GRUPO_MACRO_TRENDS = ['KW_RAIZ_TRENDS', 'TREND_INTERANUAL', 'TREND_PENDIENTE_52S', 'TREND_CV_52S', 'TREND_FECHA'] as const

/**
 * «Decisión» de SCORING (VALIDATE / RESEARCH / KILL; ✅ existe en el libro real, verificado por POS · Ideas para
 * ORD-POS-151). Se compara con `normalizarEncabezado`: «Decisión» ≡ `DECISION`. Solo se muestra; /eco no la cambia.
 */
export const COLUMNA_DECISION = 'DECISION'

export const COLUMNAS_RESUMEN = ['SEMANA', 'MARKETPLACE', 'IDEA_ID', 'ASINS_USADOS', 'ESTADO'] as const
const OBLIGATORIAS_RESUMEN = ['SEMANA', 'IDEA_ID', 'ESTADO'] as const

/** RADAROS docs/diseno-v1-2.md §2.2. */
export const COLUMNAS_UNIT = [
  'AMZ_ASIN_REF', 'AMZ_PRECIO_MXN', 'AMZ_PRECIO_MXN_AVG90', 'AMZ_COMISION_MXN', 'AMZ_COMISION_PCT', 'AMZ_FBA_MXN',
  'AMZ_OTRAS_TARIFAS_MXN', 'AMZ_TARIFAS_FECHA',
] as const

/** RADAROS src/legacy/RadarV11.gs, radarV11ConstruirAnalisis_. `URL` no se lee (diseño §3.5). */
export const COLUMNAS_TENDENCIAS = [
  'KEYWORD', 'SEMANAS_DISTINTAS', 'PRIMERA_SEMANA', 'ULTIMA_SEMANA', 'ESTADO', 'ETIQUETA_PRELIMINAR', 'POSICION_ULTIMA',
] as const
const OBLIGATORIAS_TENDENCIAS = ['KEYWORD', 'ESTADO'] as const

const MENSAJE_MAX = 200
const CORRIDAS_RECIENTES = 8

const ANTES_V12 = (tab: string) => `${tab} todavía no existe: se crea en la activación de V1.2.`
const NO_EXISTE = (tab: string) => `${tab} no existe en la hoja de RADAROS.`

/** Semana ISO (`AAAA-Www`) del día civil en Mérida; misma regla que `semanaISODesdeTexto` de RADAROS (70_Puro.js). */
export function semanaIsoMerida(epochMs: number): string {
  const [y, m, d] = civilDateInZone(epochMs).split('-').map(Number) as [number, number, number]
  const fecha = new Date(Date.UTC(y, m - 1, d))
  fecha.setUTCDate(fecha.getUTCDate() + 4 - (fecha.getUTCDay() || 7))
  const anio = fecha.getUTCFullYear()
  const semana = Math.ceil(((fecha.getTime() - Date.UTC(anio, 0, 1)) / 86_400_000 + 1) / 7)
  return `${anio}-W${String(semana).padStart(2, '0')}`
}

export interface Corridas {
  ultima: Fila | null
  recientes: Fila[]
  avisos: string[]
}

function corridas(rows: unknown[][] | undefined, now: number): Bloque<Corridas> {
  const tabla = leerTabla('AMZ_CORRIDAS', rows, COLUMNAS_CORRIDAS, OBLIGATORIAS_CORRIDAS, ANTES_V12('AMZ_CORRIDAS'),
    'Sin filas todavía: el motor no ha corrido.')
  return mapear(tabla, ({ filas }) => {
    const conMensaje = filas.map((f): Fila => {
      const m = f.MENSAJE ?? null
      return { ...f, MENSAJE: m && m.length > MENSAJE_MAX ? `${m.slice(0, MENSAJE_MAX)}…` : m }
    })
    // INICIO más reciente primero; si alguna fecha no se entiende, el orden de la hoja (se agrega al final) invertido.
    const epochs = conMensaje.map((f) => parseTimestamp(f.INICIO).value?.epochMs ?? null)
    const orden = conMensaje.map((f, i) => ({ f, i, t: epochs[i] }))
    if (epochs.every((t) => t !== null)) orden.sort((a, b) => (b.t as number) - (a.t as number) || b.i - a.i)
    else orden.reverse()
    const recientes = orden.slice(0, CORRIDAS_RECIENTES).map((o) => o.f)
    const ultima = recientes[0] ?? null
    const avisos: string[] = []
    const estado = ultima?.ESTADO?.toUpperCase()
    if (estado === 'NEEDS_REAUTH') avisos.push('El propietario debe reautorizar SP-API.')
    if (estado === 'INERTE') avisos.push('El motor está apagado (AMZ_ACTIVO sin activar).')
    const semana = semanaIsoMerida(now)
    if (!filas.some((f) => f.SEMANA === semana)) avisos.push(`Sin corrida esta semana (${semana}).`)
    return { ultima, recientes, avisos }
  })
}

/**
 * Encabezado comparable (ORD-POS-135): mayúsculas, sin acentos y cada tramo de signos (espacios, `/`, guiones…) como un
 * solo `_`, sin `_` en los extremos: «Producto / Idea» ≡ `PRODUCTO_IDEA`.
 */
export const normalizarEncabezado = (h: string) => h.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase()
  .replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')

/** Nombre de cada idea leído de PRODUCTS por encabezado; sin pestaña o sin columnas reconocidas, un mapa vacío. */
export function nombresIdeas(rows: unknown[][] | undefined): Map<string, string> {
  const nombres = new Map<string, string>()
  const header = (rows?.[0] ?? []).map((h) => normalizarEncabezado(cellText(h) ?? ''))
  const buscar = (candidatas: readonly string[]) => candidatas.map((c) => header.indexOf(c)).find((i) => i >= 0)
  const [iId, iNombre] = [buscar(COLUMNAS_ID_PRODUCTS), buscar(COLUMNAS_NOMBRE_PRODUCTS)]
  if (!rows || iId === undefined || iNombre === undefined) return nombres
  for (const row of rows.slice(1, MAX_DATA_ROWS + 1)) {
    const [id, nombre] = [cellText(row[iId]), cellText(row[iNombre])]
    if (id && nombre && !nombres.has(id)) nombres.set(id, nombre)
  }
  return nombres
}

export interface IdeaRanking {
  id: string
  /** Nombre de PRODUCTS; null si no hay. */
  nombre: string | null
  puntuacion: string | null
  campos: Fila
  /** Etiqueta K4 de `K4_MACRO_STATUS` (ORD-POS-148); null sin valor. */
  k4: EtiquetaK4 | null
  /** «Decisión» de SCORING tal cual (VALIDATE / RESEARCH / KILL, ORD-POS-151); null vacía o sin la columna. */
  decision: string | null
  resumen: { ultimaSemana: string; estado: string | null; semanas: number } | null
}

export interface Ranking {
  columnaPuntuacion: string | null
  /** false si SCORING aún no tiene ninguna columna AMZ_* (antes de activar V1.2). */
  conColumnasAmz: boolean
  /** false si SCORING no tiene ninguna columna de Trends (ORD-POS-148): sin etiqueta K4 ni grupo «Macro (Trends)». */
  conColumnasTrends: boolean
  /** false si SCORING no tiene la columna «Decisión» (ORD-POS-151). */
  conColumnaDecision: boolean
  ideas: IdeaRanking[]
  /** Nombre de PRODUCTS por ID de idea. */
  nombres: Map<string, string>
  resumen: Bloque<null>
}

function resumenPorIdea(rows: unknown[][] | undefined) {
  const tabla = leerTabla('AMZ_RESUMEN', rows, COLUMNAS_RESUMEN, OBLIGATORIAS_RESUMEN, ANTES_V12('AMZ_RESUMEN'),
    'Sin filas todavía: el motor no ha corrido.')
  const porIdea = new Map<string, { ultimaSemana: string; estado: string | null; semanas: Set<string> }>()
  if (tabla.estado === 'ok') {
    for (const f of tabla.datos.filas) {
      if (!f.IDEA_ID || !f.SEMANA) continue
      const actual = porIdea.get(f.IDEA_ID)
      if (!actual) porIdea.set(f.IDEA_ID, { ultimaSemana: f.SEMANA, estado: f.ESTADO ?? null, semanas: new Set([f.SEMANA]) })
      else {
        actual.semanas.add(f.SEMANA)
        // `AAAA-Www` ordena como texto.
        if (f.SEMANA >= actual.ultimaSemana) Object.assign(actual, { ultimaSemana: f.SEMANA, estado: f.ESTADO ?? null })
      }
    }
  }
  return { bloque: mapear(tabla, () => null), porIdea }
}

function ranking(
  scoring: unknown[][] | undefined, resumenRows: unknown[][] | undefined, nombres: Map<string, string>, now: number,
): Bloque<Ranking> {
  // «Decisión» se busca por encabezado normalizado (≡ `DECISION`) y se lee con su encabezado tal cual (ORD-POS-151).
  const colDecision = (scoring?.[0] ?? []).map(cellText).find((h): h is string => h !== null && normalizarEncabezado(h) === COLUMNA_DECISION) ?? null
  const columnas = [COLUMNA_ID_IDEA, ...COLUMNAS_PUNTUACION, ...COLUMNAS_SCORING_AMZ, ...COLUMNAS_TRENDS_SCORING, ...(colDecision ? [colDecision] : [])]
  const tabla = leerTabla('SCORING', scoring, columnas, [COLUMNA_ID_IDEA], NO_EXISTE('SCORING'), 'Sin ideas en SCORING.')
  const { bloque, porIdea } = resumenPorIdea(resumenRows)
  return mapear(tabla, ({ encabezados, filas }) => {
    const columnaPuntuacion = COLUMNAS_PUNTUACION.find((c) => encabezados.has(c)) ?? null
    const ideas: IdeaRanking[] = filas.filter((f) => f[COLUMNA_ID_IDEA]).map((f) => {
      const id = f[COLUMNA_ID_IDEA] as string
      const r = porIdea.get(id)
      return {
        id, nombre: nombres.get(id) ?? null, puntuacion: columnaPuntuacion ? (f[columnaPuntuacion] ?? null) : null, campos: f,
        k4: etiquetaK4(f.K4_MACRO_STATUS ?? null, f.TREND_FECHA ?? null, now),
        decision: colDecision ? (f[colDecision] ?? null) : null,
        resumen: r ? { ultimaSemana: r.ultimaSemana, estado: r.estado, semanas: r.semanas.size } : null,
      }
    })
    const numero = (v: string | null) => parseNumber(v?.replace(/%$/, '') ?? null).value
    // Orden de SCORING (mayor primero); sin puntuación numérica, al final y por ID. Nunca otro criterio.
    ideas.sort((a, b) => {
      const [x, y] = [numero(a.puntuacion), numero(b.puntuacion)]
      if (x !== null && y !== null && x !== y) return y - x
      if ((x === null) !== (y === null)) return x === null ? 1 : -1
      return a.id.localeCompare(b.id, 'es')
    })
    return {
      columnaPuntuacion, conColumnasAmz: COLUMNAS_SCORING_AMZ.some((c) => encabezados.has(c)),
      conColumnasTrends: COLUMNAS_TRENDS_SCORING.some((c) => encabezados.has(c)), conColumnaDecision: colDecision !== null, ideas, nombres,
      resumen: bloque,
    }
  })
}

export interface UnitEconomics {
  conColumnasAmz: boolean
  filas: Fila[]
  /** Nombre de PRODUCTS por ID de idea. */
  nombres: Map<string, string>
}

function unitEconomics(rows: unknown[][] | undefined, nombres: Map<string, string>): Bloque<UnitEconomics> {
  const tabla = leerTabla('UNIT_ECONOMICS', rows, [COLUMNA_ID_IDEA, ...COLUMNAS_UNIT], [COLUMNA_ID_IDEA],
    NO_EXISTE('UNIT_ECONOMICS'), 'Sin ideas en UNIT_ECONOMICS.')
  return mapear(tabla, ({ encabezados, filas }) => ({
    conColumnasAmz: COLUMNAS_UNIT.some((c) => encabezados.has(c)),
    filas: filas.filter((f) => f[COLUMNA_ID_IDEA]),
    nombres,
  }))
}

export interface Tendencias {
  filas: Fila[]
  estados: string[]
  etiquetas: string[]
}

function tendencias(rows: unknown[][] | undefined): Bloque<Tendencias> {
  const tabla = leerTabla('ML_TRENDS_ANALISIS_AUTO', rows, COLUMNAS_TENDENCIAS, OBLIGATORIAS_TENDENCIAS,
    NO_EXISTE('ML_TRENDS_ANALISIS_AUTO'), 'Sin términos todavía: V1.1 no ha generado el análisis.')
  return mapear(tabla, ({ filas }) => {
    const distintos = (c: string) => [...new Set(filas.map((f) => f[c]).filter((v): v is string => v !== null))].sort()
    return { filas, estados: distintos('ESTADO'), etiquetas: distintos('ETIQUETA_PRELIMINAR') }
  })
}

/** Filtro por ESTADO y ETIQUETA_PRELIMINAR; conserva el orden de la hoja. */
export function filtrarTendencias(filas: Fila[], filtro: { estado?: string; etiqueta?: string }): Fila[] {
  return filas.filter((f) => (!filtro.estado || f.ESTADO === filtro.estado) && (!filtro.etiqueta || f.ETIQUETA_PRELIMINAR === filtro.etiqueta))
}

export interface EcoVista {
  corridas: Bloque<Corridas>
  ranking: Bloque<Ranking>
  unitEconomics: Bloque<UnitEconomics>
  candidatos: { estado: 'pendiente'; mensaje: string }
  tendencias: Bloque<Tendencias>
  pipeline: PipelineVista
  /** Tabulador de cotizaciones (ORD-POS-145); /eco/pipeline solo lo muestra con ECO_TABULADOR=true. */
  tabulador: TabuladorVista
  /** Nombre de PRODUCTS por ID de idea, para «ID · nombre» en /eco y /eco/pipeline (ORD-POS-135). */
  nombres: Map<string, string>
  /** Bandeja de Gemini (ORD-POS-155): `apagada` sin ECO_BANDEJA_GEMINI=true (entonces ni se lee la pestaña). */
  bandejaGemini: BandejaVista
}

/** Cada bloque resuelve su propio estado (diseño §4): un bloque con problema no impide pintar los demás. */
export function construirEco(raw: EcoRaw, now: number, bandejaGemini: BandejaVista = { estado: 'apagada' }): EcoVista {
  const nombres = nombresIdeas(raw.PRODUCTS)
  return {
    corridas: corridas(raw.AMZ_CORRIDAS, now),
    ranking: ranking(raw.SCORING, raw.AMZ_RESUMEN, nombres, now),
    unitEconomics: unitEconomics(raw.UNIT_ECONOMICS, nombres),
    candidatos: { estado: 'pendiente', mensaje: 'AMZ_CANDIDATOS: pendiente de V1.3 (sus columnas las fija el diseño de V1.3).' },
    tendencias: tendencias(raw.ML_TRENDS_ANALISIS_AUTO),
    pipeline: construirPipeline(raw, now),
    tabulador: construirTabulador(raw),
    nombres,
    bandejaGemini,
  }
}
