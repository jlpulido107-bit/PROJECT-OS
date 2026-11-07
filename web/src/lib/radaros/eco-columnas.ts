import { civilDateInZone, daysBetween, formatTimestamp, parseCivilDate, parseTimestamp } from '../dates'
import { parseNumber } from '../parse'

/**
 * Títulos en español, unidad, formato y ayuda de las columnas AMZ_* que muestra /eco (ORD-POS-113). Solo presentación:
 * funciones puras sobre el texto que ya trajo el lector; no calculan puntuaciones ni cambian datos. Significados de
 * RADAROS docs/diseno-v1-2.md §2.1 y §2.2. Un encabezado que no está en el mapa se muestra tal cual.
 */

/**
 * `fraccion_pct`: porcentaje que la hoja puede guardar como fracción (0.1293 = 12.93 %); ver `porcentajeDeFraccion`.
 * `fecha_serie`: fecha que la hoja puede guardar como número de serie de Sheets; ver `fechaDeSerie` (ORD-POS-115).
 */
export type Formato = 'entero' | 'decimal' | 'mxn' | 'pct' | 'fraccion_pct' | 'fecha_serie' | 'texto'

export interface Columna {
  titulo: string
  formato: Formato
  /** Una línea; se muestra como ayuda (ⓘ) en el encabezado. */
  ayuda: string
}

export const COLUMNAS_ECO: Readonly<Record<string, Columna>> = {
  AMZ_SEMANA: { titulo: 'Semana de los datos de Amazon', formato: 'texto', ayuda: 'Última semana ISO con resumen OK de la idea.' },
  AMZ_ESTADO: { titulo: 'Estado de la última semana', formato: 'texto', ayuda: 'OK, PARCIAL, SIN_ASIN o ERROR de la última semana de la idea.' },
  AMZ_DEMANDA_BSR_AVG90: {
    titulo: 'Ranking de ventas, promedio 90 días (menor = vende más)', formato: 'entero',
    ayuda: 'Ranking de ventas de Amazon promedio de 90 días (Keepa); un número menor significa más ventas.',
  },
  AMZ_DEMANDA_CAIDAS_BSR_30D: {
    titulo: 'Ventas detectadas en 30 días (caídas del ranking)', formato: 'entero',
    ayuda: 'Veces que bajó el ranking en 30 días (Keepa); cada caída suele ser una venta.',
  },
  AMZ_DEMANDA_VENTAS_MES: {
    titulo: 'Ventas al mes (unidades, estimado)', formato: 'entero',
    ayuda: '«Comprados el mes pasado» que publica Amazon (Keepa); vacío si Amazon no lo da.',
  },
  AMZ_DEMANDA_RANK_CATEGORIA: {
    titulo: 'Posición en su categoría', formato: 'entero', ayuda: 'Ranking en la categoría del catálogo de Amazon (SP-API).',
  },
  AMZ_COMPETENCIA_OFERTAS: { titulo: 'Vendedores con oferta nueva', formato: 'entero', ayuda: 'Número de ofertas nuevas del producto.' },
  AMZ_COMPETENCIA_OFERTAS_FBA: {
    titulo: 'Ofertas con envío de Amazon (FBA)', formato: 'entero', ayuda: 'Ofertas nuevas que usan la logística de Amazon.',
  },
  AMZ_COMPETENCIA_AMAZON_VENDE: { titulo: '¿Amazon lo vende?', formato: 'texto', ayuda: 'SI si Amazon vende el producto directamente.' },
  AMZ_COMPETENCIA_RESENAS: { titulo: 'Reseñas (número)', formato: 'entero', ayuda: 'Número de reseñas del producto.' },
  AMZ_COMPETENCIA_RATING: { titulo: 'Calificación (0 a 5 estrellas)', formato: 'decimal', ayuda: 'Calificación promedio de los compradores.' },
  AMZ_TENDENCIA_BSR_30_VS_90: {
    titulo: 'Ranking 30 días ÷ 90 días (menor que 1 = mejora)', formato: 'decimal',
    ayuda: 'Ranking promedio de 30 días entre el de 90; por debajo de 1 vende más que antes.',
  },
  AMZ_TENDENCIA_VENTAS_DELTA90: {
    titulo: 'Cambio de ventas contra 90 días (%)', formato: 'pct',
    ayuda: 'Porcentaje de cambio de las ventas al mes contra su promedio de 90 días.',
  },
  AMZ_TENDENCIA_PRECIO_30_VS_90: {
    titulo: 'Precio 30 días ÷ 90 días (menor que 1 = baja)', formato: 'decimal',
    ayuda: 'Precio promedio de 30 días entre el de 90; por debajo de 1 el precio está bajando.',
  },
  AMZ_TENDENCIA_GTRENDS: {
    titulo: 'Interés en Google Trends (0 a 100)', formato: 'entero', ayuda: 'Valor que anota el propietario a mano desde Google Trends.',
  },
  AMZ_ASIN_REF: { titulo: 'ASIN de referencia', formato: 'texto', ayuda: 'Producto de Amazon usado para precio y tarifas.' },
  AMZ_PRECIO_MXN: { titulo: 'Precio con Buy Box (MXN)', formato: 'mxn', ayuda: 'Precio de la oferta ganadora, envío incluido.' },
  AMZ_PRECIO_MXN_AVG90: { titulo: 'Precio promedio 90 días (MXN)', formato: 'mxn', ayuda: 'Precio promedio de 90 días, para no evaluar sobre una oferta puntual.' },
  AMZ_COMISION_MXN: { titulo: 'Comisión de Amazon (MXN)', formato: 'mxn', ayuda: 'Comisión por referencia sobre el precio con Buy Box.' },
  AMZ_COMISION_PCT: { titulo: 'Comisión de Amazon (%)', formato: 'fraccion_pct', ayuda: 'Comisión entre el precio con Buy Box.' },
  AMZ_FBA_MXN: { titulo: 'Tarifa FBA por unidad (MXN)', formato: 'mxn', ayuda: 'Tarifa de logística de Amazon por unidad (estimación).' },
  AMZ_OTRAS_TARIFAS_MXN: { titulo: 'Otras tarifas (MXN)', formato: 'mxn', ayuda: 'Resto de las tarifas estimadas (cierre variable y otras).' },
  AMZ_TARIFAS_FECHA: { titulo: 'Fecha de la estimación de tarifas', formato: 'fecha_serie', ayuda: 'Cuándo se pidió la estimación a SP-API.' },
  // Validación macro de Trends (K4, ORD-POS-148; RADAROS ORD-ECO-024). Con SIN_DATOS las métricas van vacías: «—».
  KW_RAIZ_TRENDS: { titulo: 'Keyword en Google Trends', formato: 'texto', ayuda: 'Término raíz que RADAROS consultó en Google Trends.' },
  TREND_INTERANUAL: {
    titulo: 'Interanual (últimas 13 semanas ÷ las mismas 13 de hace un año)', formato: 'decimal',
    ayuda: 'Por encima de 1, más interés que hace un año.',
  },
  TREND_PENDIENTE_52S: { titulo: 'Pendiente de 52 semanas (% al mes)', formato: 'pct', ayuda: 'Cambio del interés por mes en el último año.' },
  TREND_CV_52S: {
    titulo: 'Variación de 52 semanas (CV)', formato: 'decimal', ayuda: 'Coeficiente de variación del interés; alto = demanda irregular o estacional.',
  },
  TREND_FECHA: { titulo: 'Fecha de la consulta a Trends', formato: 'fecha_serie', ayuda: 'Cuándo consultó RADAROS a Google Trends.' },
}

/**
 * Tabla «Últimas corridas» (AMZ_CORRIDAS, ORD-POS-135). Mapa aparte para no cambiar el título de `ESTADO` en otras
 * tablas de /eco (Tendencias). Significados de RADAROS docs/diseno-v1-2.md §5. `CORRIDA_ID` no va como columna.
 */
export const COLUMNAS_CORRIDAS_ECO: Readonly<Record<string, Columna>> = {
  SEMANA: { titulo: 'Semana', formato: 'texto', ayuda: 'Semana ISO (AAAA-Www) que procesó la corrida.' },
  INICIO: { titulo: 'Inicio', formato: 'texto', ayuda: 'Fecha y hora de Mérida en que empezó la corrida.' },
  FIN: { titulo: 'Fin', formato: 'texto', ayuda: 'Fecha y hora de Mérida en que terminó la corrida.' },
  ESTADO: { titulo: 'Estado', formato: 'texto', ayuda: 'Cómo terminó la corrida; pasa el puntero sobre el estado para ver qué significa.' },
  IDEAS: { titulo: 'Ideas', formato: 'entero', ayuda: 'Ideas activas que revisó la corrida.' },
  ASINS_OK: { titulo: 'ASIN con datos', formato: 'entero', ayuda: 'Productos de Amazon (ASIN) con datos completos.' },
  ASINS_FALTAN: { titulo: 'ASIN sin datos', formato: 'entero', ayuda: 'ASIN que quedaron sin datos; la siguiente corrida de la semana los completa.' },
  KEEPA_TOKENS_CONSUMIDOS: { titulo: 'Tokens de Keepa', formato: 'entero', ayuda: 'Tokens de Keepa que consumió la corrida.' },
  SPAPI_LLAMADAS: { titulo: 'Llamadas a SP-API', formato: 'entero', ayuda: 'Llamadas a la API de vendedores de Amazon (SP-API).' },
  MENSAJE: { titulo: 'Mensaje', formato: 'texto', ayuda: 'Nota del motor sobre la corrida (recortada a 200 caracteres).' },
}

export interface EstadoCorrida {
  texto: string
  tono: 'ok' | 'warn' | 'danger' | 'muted' | 'neutral'
  ayuda: string
}

/** Estados de AMZ_CORRIDAS en palabras (ORD-POS-135); RADAROS docs/diseno-v1-2.md §5 y docs/modo-descubrir.md. */
export const ESTADOS_CORRIDA: Readonly<Record<string, EstadoCorrida>> = {
  OK: { texto: 'completa', tono: 'ok', ayuda: 'Todo lo planeado quedó escrito.' },
  OMITIDA: {
    texto: 'omitida: ya hubo una completa esa semana', tono: 'muted',
    ayuda: 'Ya había una corrida completa de esa semana y marketplace; esta no llamó a ninguna API.',
  },
  PARCIAL: {
    texto: 'parcial', tono: 'warn',
    ayuda: 'El tope de tokens o de tiempo la cortó, o SP-API falló; la siguiente corrida de la semana completa lo que faltó.',
  },
  ERROR: { texto: 'error', tono: 'danger', ayuda: 'La corrida falló (Keepa respondió con error, faltó configuración o el bloqueo estaba ocupado) y no dejó datos.' },
  ERROR_DATOS: {
    texto: 'error de datos', tono: 'danger',
    ayuda: 'Más de la mitad de las filas nuevas salieron sin tarifas: se escribieron, pero los datos no alcanzan para decidir.',
  },
  NEEDS_REAUTH: { texto: 'falta reautorizar SP-API', tono: 'danger', ayuda: 'El propietario debe reautorizar SP-API.' },
  INERTE: { texto: 'motor apagado', tono: 'muted', ayuda: 'El motor está apagado (AMZ_ACTIVO sin activar).' },
}

/** Estado de una corrida en palabras; uno no reconocido se muestra tal cual, sin explicación. */
export function estadoCorrida(raw: string | null): EstadoCorrida | null {
  if (!raw) return null
  return ESTADOS_CORRIDA[raw.trim().toUpperCase()] ?? { texto: raw, tono: 'neutral', ayuda: `Estado no reconocido: ${raw}.` }
}

/** Fecha y hora de Mérida de INICIO o FIN; si la celda no se entiende como fecha, el texto tal cual; vacía, null. */
export function formatearInstante(raw: string | null): string | null {
  if (!raw?.trim()) return null
  const ts = parseTimestamp(raw).value
  return ts ? formatTimestamp(ts) : raw
}

export const SIN_DATO = 'sin dato'

/** Título en español; sin traducción, el encabezado tal cual. `mapa` cambia la tabla de traducciones (corridas). */
export function tituloColumna(col: string, mapa: Readonly<Record<string, Columna>> = COLUMNAS_ECO): string {
  return mapa[col]?.titulo ?? col
}

export function ayudaColumna(col: string, mapa: Readonly<Record<string, Columna>> = COLUMNAS_ECO): string | null {
  return mapa[col]?.ayuda ?? null
}

/** «ID · nombre»; sin nombre, solo el ID. */
export function etiquetaIdea(id: string, nombre: string | null | undefined): string {
  return nombre ? `${id} · ${nombre}` : id
}

const MILES_COMA = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/

/**
 * Número de un FORMATTED_VALUE: quita `$`, `MXN` y `%`, y acepta separador de miles con coma.
 * atajo: supone la configuración regional es-MX de la hoja (coma = miles, punto = decimal); con otra, «1.234» se lee
 * como decimal. Mejorarlo si la hoja de RADAROS cambia de configuración regional.
 */
function numeroCelda(raw: string): number | null {
  const t = raw.replace(/MXN|\$|%|\s/g, '')
  if (MILES_COMA.test(t)) return Number(t.replace(/,/g, ''))
  return parseNumber(t).value
}

/**
 * Regla de `fraccion_pct` (ORD-POS-115): un valor con `%` (la columna con formato de porcentaje en la hoja) ya es
 * porcentaje y se muestra igual; sin `%`, un número entre 0 y 1, ambos incluidos, es fracción y se multiplica por 100
 * (0.1293 → 12.93 %, 1 → 100 %, 0 → 0 %); mayor que 1 o negativo ya es porcentaje (12.9 → 12.9 %). RADAROS escribe
 * AMZ_COMISION_PCT como comisión ÷ precio, así que 1 es una comisión igual al precio y no un 1 %.
 */
function porcentajeDeFraccion(raw: string, n: number): number {
  return !raw.includes('%') && n >= 0 && n <= 1 ? n * 100 : n
}

const SERIE = /^\d+(?:\.\d+)?$/
const FECHA_TEXTO = /^(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})(?:\D|$)/
const DIA_MS = 86_400_000
/** Día 0 de los números de serie de Sheets (1899-12-30) en días desde la época Unix. */
const SERIE_EPOCA_UNIX = 25_569
/** Último serie admitido: 9999-12-31, el mismo tope que Sheets; más allá `Date` da años de 6 cifras o lanza RangeError. */
const SERIE_MAXIMO = 2_958_465

/**
 * Fecha AAAA-MM-DD de una celda `fecha_serie` (ORD-POS-115), o `null` = sin dato.
 * - Número de serie de Sheets (46323.43388): su parte entera es el día. El serie ya es la hora de pared de la hoja,
 *   así que no se convierte por UTC (misma regla que lib/dates.ts).
 *   atajo: supone que la hoja de RADAROS está en America/Merida; con otra zona, la fecha sería la de esa zona.
 *   Mejorarlo si la hoja cambia de zona horaria.
 * - Fecha en texto (la columna con formato de fecha llega así por FORMATTED_VALUE): tal cual.
 * - Vacío, cualquier otro texto o un serie fuera de 1…9999-12-31 (p. ej. un timestamp Unix): sin dato.
 */
function fechaDeSerie(raw: string): string | null {
  const t = raw.trim()
  if (FECHA_TEXTO.test(t)) return t
  if (!SERIE.test(t)) return null
  const dias = Math.floor(Number(t))
  if (dias < 1 || dias > SERIE_MAXIMO) return null
  return new Date((dias - SERIE_EPOCA_UNIX) * DIA_MS).toISOString().slice(0, 10)
}

/**
 * Validación macro K4 de `K4_MACRO_STATUS` (ORD-POS-148). Solo presentación: el estado lo decide RADAROS; un VETO es una
 * propuesta de KILL que decide el propietario, nunca una acción de /eco.
 */
export interface EtiquetaK4 {
  tipo: 'APROBADO' | 'ESTACIONAL' | 'VETO' | 'SIN_DATOS' | 'OTRO'
  texto: string
  tono: EstadoCorrida['tono']
  ayuda: string
  /** `TREND_FECHA` con más de `K4_VIGENCIA_DIAS` días (zona America/Merida). */
  vencida: boolean
}

export const K4_VIGENCIA_DIAS = 30
const K4_PREFIJO = /^(APROBADO|ESTACIONAL|VETO|SIN_DATOS)(?![A-Z0-9_])\s*:?\s*(.*)$/i
const FECHA_DMY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/

/**
 * Día civil de `TREND_FECHA`: AAAA-MM-DD (con o sin hora), número de serie de Sheets o D/M/AAAA.
 * atajo: D/M/AAAA supone la configuración regional es-MX de la hoja (igual que `numeroCelda`); con otra, mejorarlo.
 * Sin fecha entendible, null: la etiqueta no se marca vencida porque no se sabe.
 */
function fechaCivilCelda(raw: string | null): string | null {
  const t = raw?.trim()
  if (!t) return null
  const dmy = FECHA_DMY.exec(t)
  if (dmy) return parseCivilDate(`${dmy[3]}-${dmy[2]!.padStart(2, '0')}-${dmy[1]!.padStart(2, '0')}`).value
  const f = fechaDeSerie(t)
  return f ? parseCivilDate(f).value : null
}

/** Etiqueta K4 según el inicio de `K4_MACRO_STATUS`; sin valor, null (no se muestra etiqueta). */
export function etiquetaK4(status: string | null, fecha: string | null, now: number): EtiquetaK4 | null {
  const s = status?.trim()
  if (!s) return null
  const m = K4_PREFIJO.exec(s)
  const tipo = (m ? m[1]!.toUpperCase() : 'OTRO') as EtiquetaK4['tipo']
  const detalle = m?.[2]?.trim() ?? ''
  const conDetalle = (base: string) => (detalle ? `${base}: ${detalle}` : base)
  const base: Omit<EtiquetaK4, 'vencida'> = {
    APROBADO: { tipo, texto: 'K4 aprobado', tono: 'ok' as const, ayuda: 'La demanda en Google Trends pasa la validación macro.' },
    ESTACIONAL: { tipo, texto: conDetalle('K4 estacional'), tono: 'warn' as const, ayuda: 'Demanda estacional: concentra su interés en esos meses.' },
    VETO: {
      tipo, texto: 'K4 veto: propuesta KILL: decide el propietario', tono: 'danger' as const,
      ayuda: `RADAROS propone descartar la idea; /eco no la descarta. ${s}`,
    },
    SIN_DATOS: { tipo, texto: conDetalle('K4 sin datos'), tono: 'muted' as const, ayuda: 'No hubo datos de Trends; las métricas quedan vacías.' },
    OTRO: { tipo, texto: `K4: ${s}`, tono: 'neutral' as const, ayuda: `Valor de K4_MACRO_STATUS no reconocido: ${s}.` },
  }[tipo]
  const civil = fechaCivilCelda(fecha)
  const vencida = civil !== null && daysBetween(civil, civilDateInZone(now)) > K4_VIGENCIA_DIAS
  if (!vencida) return { ...base, vencida }
  return {
    ...base, vencida, texto: `${base.texto} · consulta vencida`,
    ayuda: `${base.ayuda} Consulta de Trends del ${civil}: más de ${K4_VIGENCIA_DIAS} días.`,
  }
}

const ENTERO = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 0 })
const DECIMAL = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 2 })
const MXN = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' })

/**
 * Valor listo para mostrar; `null` = «sin dato» (vacío, columna sin leer o no numérico en una columna numérica).
 * Porcentaje: `25%` o `25` se muestran «25 %» (❓ RADAROS docs/diseno-v1-2.md §2.1: Keepa da el delta en puntos
 * porcentuales); nunca se multiplica por 100. Solo `fraccion_pct` multiplica una fracción (ver `porcentajeDeFraccion`).
 */
export function formatearValor(col: string, raw: string | null): string | null {
  if (raw === null) return null
  const formato = COLUMNAS_ECO[col]?.formato ?? 'texto'
  if (formato === 'texto') return raw
  if (formato === 'fecha_serie') return fechaDeSerie(raw)
  const n = numeroCelda(raw)
  if (n === null) return null
  if (formato === 'entero') return ENTERO.format(n)
  if (formato === 'mxn') return MXN.format(n)
  if (formato === 'pct') return `${DECIMAL.format(n)} %`
  if (formato === 'fraccion_pct') return `${DECIMAL.format(porcentajeDeFraccion(raw, n))} %`
  return DECIMAL.format(n)
}
