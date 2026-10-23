import { civilDateInZone, parseTimestamp } from '../dates'
import { cellText, parseNumber } from '../parse'
import { MAX_DATA_ROWS } from '../schema'

/**
 * Vista de solo lectura del motor de RADAROS (/eco, ORD-POS-067). Funciones puras sobre las filas que el lector ya
 * trajo: no leen, no escriben y no calculan puntuaciones ni márgenes (docs/diseno-eco-radaros.md §1 y §3).
 * Las columnas se buscan por nombre de encabezado (fila 1), nunca por posición; las no listadas se ignoran.
 */

/** Pestañas que lee /eco (§3). `AMZ_CANDIDATOS` no se pide: sus columnas las fija el diseño de V1.3. */
export const ECO_TABS = ['AMZ_CORRIDAS', 'SCORING', 'AMZ_RESUMEN', 'UNIT_ECONOMICS', 'ML_TRENDS_ANALISIS_AUTO'] as const
export type EcoTab = (typeof ECO_TABS)[number]
export type EcoRaw = Partial<Record<EcoTab, unknown[][]>>

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
const COLUMNAS_SCORING_AMZ = ['AMZ_SEMANA', ...Object.values(GRUPOS_SCORING).flat(), 'AMZ_ESTADO']

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

export type Fila = Record<string, string | null>

export type Bloque<T> =
  | { estado: 'ausente'; tab: string; mensaje: string }
  | { estado: 'sin-filas'; tab: string; mensaje: string }
  | { estado: 'columnas-faltantes'; tab: string; faltan: string[] }
  | { estado: 'ok'; tab: string; truncado: boolean; datos: T }

interface Tabla {
  encabezados: Set<string>
  filas: Fila[]
}

/** Filas con solo las columnas pedidas, buscadas por encabezado. Las filas vacías se ignoran. */
function leerTabla(
  tab: string, rows: unknown[][] | undefined, columnas: readonly string[], obligatorias: readonly string[], ausente: string,
  sinFilas: string,
): Bloque<Tabla> {
  if (rows === undefined) return { estado: 'ausente', tab, mensaje: ausente }
  const header = (rows[0] ?? []).map(cellText)
  const indice = new Map<string, number>()
  header.forEach((h, i) => {
    if (h !== null && !indice.has(h)) indice.set(h, i)
  })
  const faltan = obligatorias.filter((c) => !indice.has(c))
  if (faltan.length) return { estado: 'columnas-faltantes', tab, faltan }
  // El lector pide encabezado + MAX_DATA_ROWS + 1 fila centinela.
  const truncado = rows.length > MAX_DATA_ROWS + 1
  const filas: Fila[] = []
  for (const row of rows.slice(1, MAX_DATA_ROWS + 1)) {
    const fila: Fila = {}
    let vacia = true
    for (const c of columnas) {
      const i = indice.get(c)
      const v = i === undefined ? null : cellText(row[i])
      fila[c] = v
      if (v !== null) vacia = false
    }
    if (!vacia) filas.push(fila)
  }
  if (filas.length === 0 && !truncado) return { estado: 'sin-filas', tab, mensaje: sinFilas }
  return { estado: 'ok', tab, truncado, datos: { encabezados: new Set(indice.keys()), filas } }
}

function mapear<T, U>(b: Bloque<T>, f: (datos: T) => U): Bloque<U> {
  return b.estado === 'ok' ? { ...b, datos: f(b.datos) } : b
}

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

export interface IdeaRanking {
  id: string
  puntuacion: string | null
  campos: Fila
  resumen: { ultimaSemana: string; estado: string | null; semanas: number } | null
}

export interface Ranking {
  columnaPuntuacion: string | null
  /** false si SCORING aún no tiene ninguna columna AMZ_* (antes de activar V1.2). */
  conColumnasAmz: boolean
  ideas: IdeaRanking[]
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

function ranking(scoring: unknown[][] | undefined, resumenRows: unknown[][] | undefined): Bloque<Ranking> {
  const columnas = [COLUMNA_ID_IDEA, ...COLUMNAS_PUNTUACION, ...COLUMNAS_SCORING_AMZ]
  const tabla = leerTabla('SCORING', scoring, columnas, [COLUMNA_ID_IDEA], NO_EXISTE('SCORING'), 'Sin ideas en SCORING.')
  const { bloque, porIdea } = resumenPorIdea(resumenRows)
  return mapear(tabla, ({ encabezados, filas }) => {
    const columnaPuntuacion = COLUMNAS_PUNTUACION.find((c) => encabezados.has(c)) ?? null
    const ideas: IdeaRanking[] = filas.filter((f) => f[COLUMNA_ID_IDEA]).map((f) => {
      const id = f[COLUMNA_ID_IDEA] as string
      const r = porIdea.get(id)
      return {
        id, puntuacion: columnaPuntuacion ? (f[columnaPuntuacion] ?? null) : null, campos: f,
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
    return { columnaPuntuacion, conColumnasAmz: COLUMNAS_SCORING_AMZ.some((c) => encabezados.has(c)), ideas, resumen: bloque }
  })
}

export interface UnitEconomics {
  conColumnasAmz: boolean
  filas: Fila[]
}

function unitEconomics(rows: unknown[][] | undefined): Bloque<UnitEconomics> {
  const tabla = leerTabla('UNIT_ECONOMICS', rows, [COLUMNA_ID_IDEA, ...COLUMNAS_UNIT], [COLUMNA_ID_IDEA],
    NO_EXISTE('UNIT_ECONOMICS'), 'Sin ideas en UNIT_ECONOMICS.')
  return mapear(tabla, ({ encabezados, filas }) => ({
    conColumnasAmz: COLUMNAS_UNIT.some((c) => encabezados.has(c)),
    filas: filas.filter((f) => f[COLUMNA_ID_IDEA]),
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
}

/** Cada bloque resuelve su propio estado (diseño §4): un bloque con problema no impide pintar los demás. */
export function construirEco(raw: EcoRaw, now: number): EcoVista {
  return {
    corridas: corridas(raw.AMZ_CORRIDAS, now),
    ranking: ranking(raw.SCORING, raw.AMZ_RESUMEN),
    unitEconomics: unitEconomics(raw.UNIT_ECONOMICS),
    candidatos: { estado: 'pendiente', mensaje: 'AMZ_CANDIDATOS: pendiente de V1.3 (sus columnas las fija el diseño de V1.3).' },
    tendencias: tendencias(raw.ML_TRENDS_ANALISIS_AUTO),
  }
}
