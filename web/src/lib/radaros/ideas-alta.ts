import { MAX_DATA_ROWS } from '../schema'
import { LIMITS } from '../operations/constants'
import { OperationError } from '../operations/errors'
import { asObject, Checker } from '../operations/validation'
import { ASIN, asinDeEnlaceAmazon, ENLACE_MAX, ERROR_ENLACE, PALABRA_MAX } from './idea-amazon'
import { ecoPipelineWriteStatus } from './pipeline-escritura-config'

/**
 * Alta de ideas en RADAROS por el agente PM (ORD-POS-131, DEC-ECO-007; docs/escritura-v1-8.md §9). Lógica pura, sin
 * red: encabezados esperados, validación del comando, lectura del libro, plan de la fila nueva y verificación. La
 * escritura la hace un `IdeasAltaStore` (ideas-alta-store.ts) y la auditoría el servicio de operaciones.
 *
 * DEC-ECO-007: solo filas NUEVAS al final de PRODUCTS (A a P) y de SCORING (A a L). Nunca edita filas existentes ni
 * escribe en las fórmulas de SCORING (M en adelante), ni en otras pestañas. La fila de SCORING solo se usa si ya trae
 * las fórmulas M a P copiadas (son por fila, no ARRAYFORMULA; datos del PM en el issue #289, 2026-11-02).
 *
 * DEC-ECO-017 (ORD-POS-160): si el comando trae un enlace de Amazon México (o un ASIN) y una palabra de búsqueda, además
 * agrega una fila NUEVA al final de AMZ_IDEA_ASIN (la idea, el ASIN, ACTIVO=SI, PRINCIPAL=SI, ORIGEN=POS) y otra de
 * AMZ_NICHO (la idea, la palabra, ACTIVO=SI), con las columnas ubicadas por su encabezado. Nunca edita filas existentes
 * de esas pestañas ni toca otra pestaña AMZ_*. Sin esos campos el alta es la de siempre y no lee AMZ_*.
 */

/** Bandera del propietario (DEC-ECO-007 e): solo el valor exacto `true`. */
export function ecoIdeasAltaFlag(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ECO_IDEAS_ALTA === 'true'
}

/**
 * Encendida de verdad: la bandera y la escritura del pipeline de /eco activa, porque el alta usa SU cuenta de escritura
 * (ECO_PIPELINE_WRITE_SERVICE_ACCOUNT) y su libro (RADAROS_SHEET_ID) con todas sus comprobaciones.
 */
export function ecoIdeasAltaHabilitada(env: NodeJS.ProcessEnv = process.env): boolean {
  return ecoIdeasAltaFlag(env) && ecoPipelineWriteStatus(env).mode === 'sheets'
}

export const IDEAS_TABS = ['PRODUCTS', 'SCORING', 'AMZ_IDEA_ASIN', 'AMZ_NICHO'] as const
export type IdeasTab = (typeof IDEAS_TABS)[number]
/** Pestañas de ancho fijo (DEC-ECO-007). */
export type IdeasTabFija = 'PRODUCTS' | 'SCORING'
/** Pestañas de DEC-ECO-017: solo una fila nueva al final, por encabezado. */
export const AMZ_TABS = ['AMZ_IDEA_ASIN', 'AMZ_NICHO'] as const
export type AmzTab = (typeof AMZ_TABS)[number]
const esAmzTab = (tab: IdeasTab): tab is AmzTab => (AMZ_TABS as readonly string[]).includes(tab)

/** Encabezados exactos de la fila 1 (PM, libro de RADAROS, 2026-11-02, issue #289). */
export const PRODUCTS_HEADERS = [
  'PRODUCT_ID', 'Producto / Idea', 'Categoría', 'Bucket', 'Cliente objetivo', 'Problema que resuelve', 'Canal inicial',
  'Nivel', 'Estado', 'Confidence', 'Precio observado MXN', 'Capital prueba est. MXN', 'Red flag', 'Por validar',
  'Siguiente decisión', 'Owner',
] as const
export const SCORING_HEADERS = [
  'PRODUCT_ID', 'Producto', 'Demanda', 'Competencia', 'Unit Economics', 'Diferenciación', 'Capital', 'Logística', 'Riesgo',
  'Tendencia', 'Complejidad', 'Marca',
] as const

/** Ancho que se escribe: PRODUCTS A:P (16) y SCORING A:L (12). Nunca más. */
export const ANCHO: Record<IdeasTabFija, number> = { PRODUCTS: PRODUCTS_HEADERS.length, SCORING: SCORING_HEADERS.length }
/** Columnas de fórmulas por fila de SCORING que deben cubrir la fila nueva: M a P (índices 12 a 15). */
export const SCORING_FORMULAS = [12, 13, 14, 15] as const
/** Columna que debe tener valor tras escribir (M). */
export const SCORING_PRIMERA_FORMULA = 12

/**
 * Columnas que el alta escribe en AMZ_IDEA_ASIN y AMZ_NICHO, por encabezado (RADAROS src/73_CorridaAmz.js `AMZ.HOJAS` y
 * docs/dictamen.md §10, leídos el 2026-11-18). Las demás columnas de la fila nueva (NOTA, ALTA_FECHA u otras) quedan vacías.
 */
export const AMZ_COLUMNAS = {
  AMZ_IDEA_ASIN: ['IDEA_ID', 'ASIN', 'ACTIVO', 'PRINCIPAL', 'ORIGEN'],
  AMZ_NICHO: ['ID', 'PALABRA_CLAVE', 'ACTIVO'],
} as const satisfies Record<AmzTab, readonly string[]>
/** Valores fijos de DEC-ECO-017. */
export const AMZ_SI = 'SI'
export const AMZ_ORIGEN = 'POS'
/** Ancho máximo de una fila de AMZ_*: lo que alcanza a leer el almacén (A a ULTIMA_COLUMNA, 52 columnas). */
export const AMZ_ANCHO_MAX = 52

export type Celda = string | number

/** Puerto del libro de RADAROS para el alta. Filas 1-based; los arreglos omiten celdas y filas vacías al final. */
export interface IdeasAltaStore {
  readonly libro: string
  /** Valores calculados (UNFORMATTED_VALUE). */
  values(tab: IdeasTab): Promise<unknown[][]>
  /** Contenido tal cual (FORMULA): una celda con fórmula empieza por `=`. */
  formulas(tab: IdeasTab): Promise<unknown[][]>
  /** Escribe `A{fila}:{última}{fila}` en RAW: exactamente ANCHO[tab] celdas, o el ancho del encabezado en AMZ_*. */
  writeRow(tab: IdeasTab, fila: number, celdas: Celda[]): Promise<void>
}

export function assertIdeasTab(tab: string): asserts tab is IdeasTab {
  if (!(IDEAS_TABS as readonly string[]).includes(tab)) throw new Error('pestaña fuera de la lista cerrada del alta de ideas')
}

export function assertFila(tab: IdeasTab, fila: number, celdas: readonly Celda[]) {
  if (!Number.isInteger(fila) || fila < 2 || fila > MAX_DATA_ROWS + 1) throw new Error('fila fuera de rango')
  if (esAmzTab(tab) ? celdas.length < AMZ_COLUMNAS[tab].length || celdas.length > AMZ_ANCHO_MAX : celdas.length !== ANCHO[tab]) {
    throw new Error('ancho de fila distinto del permitido')
  }
}

/* ------------------------------------ Comando ------------------------------------ */

/** Campos de PRODUCTS B a P en el cuerpo, en orden de columna. */
const CAMPOS_PRODUCTS = [
  'producto', 'categoria', 'bucket', 'clienteObjetivo', 'problema', 'canalInicial', 'nivel', 'estado', 'confidence',
  'precioObservadoMxn', 'capitalPruebaMxn', 'redFlag', 'porValidar', 'siguienteDecision', 'owner',
] as const
/** Puntajes de SCORING C a L, en orden de columna. */
export const CAMPOS_PUNTAJES = [
  'demanda', 'competencia', 'unitEconomics', 'diferenciacion', 'capital', 'logistica', 'riesgo', 'tendencia', 'complejidad', 'marca',
] as const
const MONTOS = new Set(['precioObservadoMxn', 'capitalPruebaMxn'])
const TEXTO_MAX = 500
const MONTO_MAX = 100_000_000

/** Lo que DEC-ECO-017 agrega a la idea: su ASIN principal y su palabra de búsqueda. */
export interface AmazonIdea {
  asin: string
  palabraClave: string
}

export interface AltaIdeaCommand {
  requestId: string
  /** `PAQ-AAAA-MM-DD-NN «sí PAQ-… del propietario» AAAA-MM-DD` (DEC-POS-013): se audita como AUTORIZACION. */
  autorizacion: string
  /** PRODUCTS B a P (15 celdas; '' = vacía). B (producto) es obligatoria. */
  products: Celda[]
  /** SCORING C a L (10 celdas): entero 1 a 5 o ''. */
  puntajes: Celda[]
  /** DEC-ECO-017: solo presente si el cuerpo trae `enlaceAmazon` o `asin` (así el hash de un alta sin ellos no cambia). */
  amazon?: AmazonIdea
}

const PAQ = /^(PAQ-\d{4}-\d{2}-\d{2}-\d{2}) «([^«»]+)» (\d{4}-\d{2}-\d{2})$/u

function fechaValida(fecha: string): boolean {
  const t = Date.parse(`${fecha}T00:00:00Z`)
  return !Number.isNaN(t) && new Date(t).toISOString().startsWith(fecha)
}

/** Forma de la autorización: el paquete, la cita con «sí» y ese mismo paquete, y una fecha que existe. */
export function autorizacionPaqValida(texto: string): boolean {
  const m = PAQ.exec(texto.normalize('NFC'))
  if (!m) return false
  const [, paq, cita, fecha] = m as unknown as [string, string, string, string]
  return /(?:^|\P{L})sí(?:\P{L}|$)/iu.test(cita) && cita.includes(paq) && fechaValida(fecha)
}

function monto(c: Checker, input: Record<string, unknown>, key: string): Celda {
  const raw = input[key]
  if (raw === undefined || raw === null || raw === '') return ''
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim().replace(',', '.') : null
  if (text === null || !/^\d{1,9}(\.\d{1,2})?$/.test(text) || Number(text) > MONTO_MAX) {
    c.setError(key, `Monto entre 0 y ${MONTO_MAX} con hasta 2 decimales`)
    return ''
  }
  return Number(text)
}

export function parseAltaIdea(body: unknown): AltaIdeaCommand {
  const input = asObject(body)
  const c = new Checker(input, ['requestId', 'autorizacion', 'puntajes', 'enlaceAmazon', 'asin', 'palabraClave', ...CAMPOS_PRODUCTS])
  const requestId = c.requestId()
  const autorizacion = c.text('autorizacion', { required: true, max: LIMITS.motivo }) ?? ''
  if (autorizacion && !autorizacionPaqValida(autorizacion)) {
    c.setError('autorizacion', 'Formato: PAQ-AAAA-MM-DD-NN «sí PAQ-AAAA-MM-DD-NN literal del propietario» AAAA-MM-DD')
  }
  const products: Celda[] = CAMPOS_PRODUCTS.map((key) => {
    if (MONTOS.has(key)) return monto(c, input, key)
    const required = key === 'producto'
    return c.text(key, { required, max: required ? LIMITS.titulo : TEXTO_MAX, multiline: false }) ?? ''
  })

  const puntajes: Celda[] = CAMPOS_PUNTAJES.map(() => '')
  const raw = input.puntajes
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== 'object' || Array.isArray(raw)) c.setError('puntajes', 'Debe ser un objeto')
    else {
      const p = new Checker(raw as Record<string, unknown>, CAMPOS_PUNTAJES, 'puntajes.')
      CAMPOS_PUNTAJES.forEach((key, i) => {
        const v = (raw as Record<string, unknown>)[key]
        if (v === undefined || v === null || v === '') return
        if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5) puntajes[i] = v
        else p.setError(key, 'Entero del 1 al 5 o vacío')
      })
      Object.assign(c.errors, p.errors)
    }
  }
  const amazon = parseAmazon(c, input)
  c.done()
  return { requestId, autorizacion, products, puntajes, ...(amazon ? { amazon } : {}) }
}

/**
 * `enlaceAmazon` o `asin` (uno solo) con `palabraClave`: van juntos o no va ninguno. Un enlace que no es de un producto
 * de amazon.com.mx o un ASIN mal formado es un error de validación (422): no se lee ni se escribe nada.
 */
function parseAmazon(c: Checker, input: Record<string, unknown>): AmazonIdea | null {
  const dado = (key: string) => input[key] !== undefined && input[key] !== null && input[key] !== ''
  const conEnlace = dado('enlaceAmazon')
  const conAsin = dado('asin')
  if (!conEnlace && !conAsin) {
    if (dado('palabraClave')) c.setError('palabraClave', 'Solo va junto con enlaceAmazon o asin')
    return null
  }
  let asin: string | null = null
  if (conEnlace && conAsin) c.setError('asin', 'Envía enlaceAmazon o asin, no los dos')
  else if (conEnlace) {
    const enlace = input.enlaceAmazon
    asin = typeof enlace === 'string' && enlace.length <= ENLACE_MAX ? asinDeEnlaceAmazon(enlace) : null
    if (!asin) c.setError('enlaceAmazon', ERROR_ENLACE)
  } else {
    asin = c.pattern('asin', ASIN, true, 'ASIN de 10 caracteres (mayúsculas y dígitos)')
  }
  const palabraClave = c.text('palabraClave', { required: true, max: PALABRA_MAX, multiline: false })
  return asin && palabraClave ? { asin, palabraClave } : null
}

/* --------------------------------- Lectura y plan --------------------------------- */

const texto = (v: unknown): string => (v === null || v === undefined ? '' : String(v)).normalize('NFC').trim()
const vacia = (v: unknown) => texto(v) === ''
const ID_IDEA = /^EC-(\d{3,})$/

export interface LibroIdeas {
  products: unknown[][]
  scoring: unknown[][]
  scoringFormulas: unknown[][]
  /** Solo si el alta trae Amazon (DEC-ECO-017): contenido tal cual (FORMULA) de las dos pestañas. */
  amz?: Record<AmzTab, unknown[][]>
}

/** Posición (0-based) de cada columna requerida de una pestaña AMZ_* y ancho de su encabezado. */
export interface ColumnasAmz {
  pos: Record<string, number>
  ancho: number
}

/** Posiciones por encabezado, o las columnas requeridas que faltan o están repetidas en la fila 1 (lo leído: A a AZ). */
function columnasAmz(tab: AmzTab, values: unknown[][]): ColumnasAmz | string[] {
  const enc = (values[0] ?? []).map(texto)
  const pos: Record<string, number> = {}
  const malas = AMZ_COLUMNAS[tab].filter((c) => {
    const p = enc.flatMap((v, i) => (v === c ? [i] : []))
    pos[c] = p[0] ?? -1
    return p.length !== 1
  })
  return malas.length ? [...malas] : { pos, ancho: enc.length }
}

function columnasAmzOk(tab: AmzTab, values: unknown[][]): ColumnasAmz {
  const c = columnasAmz(tab, values)
  if (Array.isArray(c)) throw new OperationError('idea-encabezados-distintos', { detail: { [tab]: c.join(',') } })
  return c
}

/** Lee lo necesario y compara encabezados (A a P y A a L, exactos y en orden). Si difieren, no se escribe nada. */
export async function leerLibroIdeas(store: IdeasAltaStore, conAmazon = false): Promise<LibroIdeas> {
  let libro: LibroIdeas
  try {
    const [products, scoring, scoringFormulas, ideaAsin, nicho] = await Promise.all([
      store.values('PRODUCTS'), store.values('SCORING'), store.formulas('SCORING'),
      conAmazon ? store.formulas('AMZ_IDEA_ASIN') : null, conAmazon ? store.formulas('AMZ_NICHO') : null,
    ])
    libro = { products, scoring, scoringFormulas, ...(ideaAsin && nicho ? { amz: { AMZ_IDEA_ASIN: ideaAsin, AMZ_NICHO: nicho } } : {}) }
  } catch {
    throw new OperationError('lectura-fallida')
  }
  const distintas = (fila: unknown[] | undefined, esperados: readonly string[]) =>
    esperados.map((h, i) => (texto(fila?.[i]) === h ? null : i)).filter((i): i is number => i !== null)
  const p = distintas(libro.products[0], PRODUCTS_HEADERS)
  const s = distintas(libro.scoring[0], SCORING_HEADERS)
  // AMZ_*: nombres de las columnas requeridas que faltan o están repetidas (constantes del código).
  const amz = libro.amz ? AMZ_TABS.map((tab) => [tab, columnasAmz(tab, libro.amz![tab])] as const).filter(([, c]) => Array.isArray(c)) : []
  if (p.length || s.length || amz.length) {
    // Solo letras de columna (o nombres de columnas requeridas), nunca el contenido de la hoja.
    const letras = (xs: number[]) => xs.map((i) => String.fromCharCode(65 + i)).join(',')
    throw new OperationError('idea-encabezados-distintos', {
      detail: {
        ...(p.length ? { PRODUCTS: letras(p) } : {}), ...(s.length ? { SCORING: letras(s) } : {}),
        ...Object.fromEntries(amz.map(([tab, c]) => [tab, (c as string[]).join(',')])),
      },
    })
  }
  return libro
}

/** Siguiente EC-NNN libre según la columna A de PRODUCTS (máximo + 1, al menos 3 dígitos). */
export function siguienteIdIdea(products: unknown[][]): string {
  let max = 0
  for (const row of products.slice(1)) {
    const m = ID_IDEA.exec(texto(row?.[0]))
    if (m && Number(m[1]) > max) max = Number(m[1])
  }
  return `EC-${String(max + 1).padStart(3, '0')}`
}

const filasConId = (values: unknown[][], id: string) => values.slice(1).filter((row) => texto(row?.[0]) === id).length

/** Primera fila de PRODUCTS con A vacía; si tiene algo en B a P, no se toca (no se editan filas existentes). */
export function filaProducts(products: unknown[][]): number {
  const i = products.findIndex((row, n) => n > 0 && vacia(row?.[0]))
  const fila = i === -1 ? Math.max(products.length, 1) + 1 : i + 1
  const row = products[fila - 1] ?? []
  if (row.slice(0, ANCHO.PRODUCTS).some((v) => !vacia(v))) throw new OperationError('idea-fila-ocupada', { detail: { pestana: 'PRODUCTS', fila } })
  return fila
}

/**
 * Primera fila de SCORING con A a L vacías (en contenido, también sin fórmulas). Solo vale si ya trae fórmulas en M a P
 * (las existentes cubren la fila nueva); si no, `scoring-sin-formulas` y no se escribe nada.
 */
export function filaScoring(scoringFormulas: unknown[][]): number {
  const libre = (row: unknown[] | undefined) => (row ?? []).slice(0, ANCHO.SCORING).every(vacia)
  const i = scoringFormulas.findIndex((row, n) => n > 0 && libre(row))
  const fila = i === -1 ? Math.max(scoringFormulas.length, 1) + 1 : i + 1
  const row = scoringFormulas[fila - 1] ?? []
  const cubierta = SCORING_FORMULAS.every((col) => texto(row[col]).startsWith('='))
  if (!cubierta) throw new OperationError('scoring-sin-formulas', { detail: { fila } })
  return fila
}

export interface PlanIdea {
  id: string
  products: Celda[]
  scoring: Celda[]
  /** DEC-ECO-017: las filas de AMZ_* se arman al escribir, con las columnas del encabezado de ese momento. */
  amazon?: AmazonIdea
}

/** Las dos filas completas (A:P y A:L). SCORING B se copia de PRODUCTS B: un solo nombre (issue #289, respuesta 3). */
export function planIdea(id: string, cmd: Pick<AltaIdeaCommand, 'products' | 'puntajes' | 'amazon'>): PlanIdea {
  return { id, products: [id, ...cmd.products], scoring: [id, cmd.products[0]!, ...cmd.puntajes], ...(cmd.amazon ? { amazon: cmd.amazon } : {}) }
}

/** Valores por encabezado de la fila nueva de cada pestaña AMZ_* (DEC-ECO-017). */
export function valoresAmz(id: string, amazon: AmazonIdea): Record<AmzTab, Record<string, string>> {
  return {
    AMZ_IDEA_ASIN: { IDEA_ID: id, ASIN: amazon.asin, ACTIVO: AMZ_SI, PRINCIPAL: AMZ_SI, ORIGEN: AMZ_ORIGEN },
    AMZ_NICHO: { ID: id, PALABRA_CLAVE: amazon.palabraClave, ACTIVO: AMZ_SI },
  }
}

/**
 * Qué falta escribir en una pestaña AMZ_* (null = la fila ya está y coincide). Solo filas nuevas al final: la fila es
 * la siguiente a la última con contenido (también cuenta una fórmula). Una fila de la idea que no coincide con lo
 * planeado no se corrige (`estado-divergente`): nunca se editan filas existentes.
 */
function comprobarAmz(tab: AmzTab, values: unknown[][], valores: Record<string, string>, clave: readonly string[]): { fila: number; celdas: Celda[] } | null {
  const { pos, ancho } = columnasAmzOk(tab, values)
  const mismas = values.filter((row, n) => n > 0 && clave.every((c) => texto(row?.[pos[c]!]) === valores[c]))
  if (mismas.length > 1) throw new OperationError('conflicto-concurrente')
  if (mismas.length === 1) {
    if (!Object.entries(valores).every(([c, v]) => igual(mismas[0]![pos[c]!], v))) throw new OperationError('estado-divergente')
    return null
  }
  const fila = Math.max(values.length, 1) + 1
  if (fila > MAX_DATA_ROWS + 1) throw new OperationError('pestana-llena', { detail: { pestana: tab } })
  const celdas: Celda[] = Array.from({ length: ancho }, () => '')
  for (const [c, v] of Object.entries(valores)) celdas[pos[c]!] = v
  return { fila, celdas }
}

/**
 * Comprobaciones de AMZ_IDEA_ASIN y AMZ_NICHO antes de escribir nada (DEC-ECO-017): columnas por encabezado, el ASIN no
 * está en otra idea (activo o no: `idea-asin-en-otra-idea`) y las filas nuevas van al final.
 */
export function comprobarAmazon(plan: PlanIdea, libro: LibroIdeas): Record<AmzTab, { fila: number; celdas: Celda[] } | null> | null {
  if (!plan.amazon) return null
  if (!libro.amz) throw new Error('alta con Amazon sin leer AMZ_*')
  const ideaAsin = libro.amz.AMZ_IDEA_ASIN
  const { pos } = columnasAmzOk('AMZ_IDEA_ASIN', ideaAsin)
  const ajena = ideaAsin.findIndex((row, n) => n > 0 && texto(row?.[pos.ASIN!]).toUpperCase() === plan.amazon!.asin && texto(row?.[pos.IDEA_ID!]) !== plan.id)
  if (ajena !== -1) throw new OperationError('idea-asin-en-otra-idea', { detail: { fila: ajena + 1 } })
  const v = valoresAmz(plan.id, plan.amazon)
  return {
    AMZ_IDEA_ASIN: comprobarAmz('AMZ_IDEA_ASIN', ideaAsin, v.AMZ_IDEA_ASIN, ['IDEA_ID', 'ASIN']),
    AMZ_NICHO: comprobarAmz('AMZ_NICHO', libro.amz.AMZ_NICHO, v.AMZ_NICHO, ['ID']),
  }
}

const igual = (a: unknown, b: Celda) => texto(a) === texto(b)

/** La fila escrita coincide con el plan (A:P o A:L). */
export function filaCoincide(row: unknown[] | undefined, esperado: readonly Celda[]): boolean {
  return esperado.every((v, i) => igual(row?.[i], v))
}

export function filaDeId(values: unknown[][], id: string): { fila: number; row: unknown[] } | null {
  const i = values.findIndex((row, n) => n > 0 && texto(row?.[0]) === id)
  return i === -1 ? null : { fila: i + 1, row: values[i] ?? [] }
}

export function idOcupado(libro: LibroIdeas, id: string): boolean {
  return filasConId(libro.products, id) > 0 || filasConId(libro.scoring, id) > 0
}

/**
 * Comprobaciones de las dos pestañas antes de escribir nada: la idea no está duplicada ni distinta de lo planeado, la
 * fila libre de PRODUCTS está vacía y la de SCORING trae las fórmulas M a P. Si SCORING no está cubierta, tampoco se
 * escribe PRODUCTS. Devuelve las filas que faltan por escribir (null = ya está escrita y coincide).
 */
export function comprobarIdea(plan: PlanIdea, libro: LibroIdeas): { filaP: number | null; filaS: number | null; amz: ReturnType<typeof comprobarAmazon> } {
  const enProducts = filaDeId(libro.products, plan.id)
  const enScoring = filaDeId(libro.scoring, plan.id)
  if (filasConId(libro.products, plan.id) > 1 || filasConId(libro.scoring, plan.id) > 1) throw new OperationError('conflicto-concurrente')
  if (enProducts && !filaCoincide(enProducts.row, plan.products)) throw new OperationError('estado-divergente')
  if (enScoring && !filaCoincide(enScoring.row, plan.scoring)) throw new OperationError('estado-divergente')
  return { filaP: enProducts ? null : filaProducts(libro.products), filaS: enScoring ? null : filaScoring(libro.scoringFormulas), amz: comprobarAmazon(plan, libro) }
}

/**
 * Relee el libro, repite las comprobaciones, escribe lo que falte del plan (PRODUCTS y luego SCORING) y verifica
 * releyendo: las filas coinciden y M de SCORING tiene valor. Si la idea ya está completa, no escribe nada.
 */
export async function escribirIdea(store: IdeasAltaStore, plan: PlanIdea): Promise<void> {
  const { filaP, filaS, amz } = comprobarIdea(plan, await leerLibroIdeas(store, Boolean(plan.amazon)))

  try {
    if (filaP !== null) await store.writeRow('PRODUCTS', filaP, plan.products)
    if (filaS !== null) await store.writeRow('SCORING', filaS, plan.scoring)
    // atajo: entre la relectura y esta escritura el motor de RADAROS (Apps Script) podría anexar una fila en la misma
    // posición; la verificación de abajo lo detecta (`verificacion-fallida`), no lo evita. Mejorar si llega a pasar.
    for (const tab of AMZ_TABS) if (amz?.[tab]) await store.writeRow(tab, amz[tab].fila, amz[tab].celdas)
  } catch (error) {
    if (error instanceof OperationError) throw error
    throw new OperationError('escritura-fallida')
  }

  let products: unknown[][], scoring: unknown[][]
  try {
    ;[products, scoring] = await Promise.all([store.values('PRODUCTS'), store.values('SCORING')])
  } catch {
    throw new OperationError('verificacion-fallida')
  }
  const p = filaDeId(products, plan.id)
  const s = filaDeId(scoring, plan.id)
  if (!p || !s || filasConId(products, plan.id) !== 1 || filasConId(scoring, plan.id) !== 1) throw new OperationError('verificacion-fallida')
  if (!filaCoincide(p.row, plan.products) || !filaCoincide(s.row, plan.scoring)) throw new OperationError('verificacion-fallida')
  if (plan.amazon) {
    // Las dos filas de AMZ_* están, una sola vez y como se planearon (comprobarAmazon devuelve null en las dos).
    let pendientes: ReturnType<typeof comprobarAmazon>
    try {
      const [ideaAsin, nicho] = await Promise.all([store.formulas('AMZ_IDEA_ASIN'), store.formulas('AMZ_NICHO')])
      pendientes = comprobarAmazon(plan, { products, scoring, scoringFormulas: [], amz: { AMZ_IDEA_ASIN: ideaAsin, AMZ_NICHO: nicho } })
    } catch {
      throw new OperationError('verificacion-fallida')
    }
    if (!pendientes || AMZ_TABS.some((tab) => pendientes[tab] !== null)) throw new OperationError('verificacion-fallida')
  }
  if (vacia(s.row[SCORING_PRIMERA_FORMULA])) throw new OperationError('idea-sin-calculo', { detail: { fila: s.fila } })
}

/* ------------------------------ Auditoría (AUDITORIA) ------------------------------ */

/** CAMPO de AUDITORIA de cada celda: `PRODUCTS!<encabezado>` y `SCORING!<encabezado>` (C a L). */
export const campoProducts = (i: number) => `PRODUCTS!${PRODUCTS_HEADERS[i]}`
export const campoScoring = (i: number) => `SCORING!${SCORING_HEADERS[i]}`
/** CAMPO de AUDITORIA de las celdas de AMZ_* (DEC-ECO-017): `AMZ_IDEA_ASIN!<columna>` y `AMZ_NICHO!<columna>`. */
export const campoAmz = (tab: AmzTab, columna: string) => `${tab}!${columna}`

/** Diferencias de la alta para AUDITORIA: PRODUCT_ID, celdas no vacías y AUTORIZACION. */
export function auditDiff(plan: PlanIdea, autorizacion: string): Map<string, { antes: string; despues: string }> {
  const diff = new Map<string, { antes: string; despues: string }>()
  diff.set('PRODUCT_ID', { antes: '', despues: plan.id })
  plan.products.forEach((v, i) => { if (i > 0 && v !== '') diff.set(campoProducts(i), { antes: '', despues: String(v) }) })
  plan.scoring.forEach((v, i) => { if (i > 1 && v !== '') diff.set(campoScoring(i), { antes: '', despues: String(v) }) })
  if (plan.amazon) {
    const v = valoresAmz(plan.id, plan.amazon)
    for (const tab of AMZ_TABS) for (const [c, valor] of Object.entries(v[tab])) diff.set(campoAmz(tab, c), { antes: '', despues: valor })
  }
  diff.set('AUTORIZACION', { antes: '', despues: autorizacion })
  return diff
}

/** Reconstruye el plan desde la auditoría (reintento con el mismo requestId tras una escritura incompleta). */
export function planDesdeAuditoria(id: string, fields: Map<string, { antes: string; despues: string }>): PlanIdea {
  const products: Celda[] = PRODUCTS_HEADERS.slice(1).map((_, j) => {
    const v = fields.get(campoProducts(j + 1))?.despues ?? ''
    return v !== '' && MONTOS.has(CAMPOS_PRODUCTS[j]!) ? Number(v) : v
  })
  const puntajes: Celda[] = CAMPOS_PUNTAJES.map((_, j) => {
    const v = fields.get(campoScoring(j + 2))?.despues ?? ''
    return v === '' ? '' : Number(v)
  })
  const asin = fields.get(campoAmz('AMZ_IDEA_ASIN', 'ASIN'))?.despues ?? ''
  const palabraClave = fields.get(campoAmz('AMZ_NICHO', 'PALABRA_CLAVE'))?.despues ?? ''
  return planIdea(id, { products, puntajes, ...(asin && palabraClave ? { amazon: { asin, palabraClave } } : {}) })
}
