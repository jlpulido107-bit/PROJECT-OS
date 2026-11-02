import { MAX_DATA_ROWS } from '../schema'
import { LIMITS } from '../operations/constants'
import { OperationError } from '../operations/errors'
import { asObject, Checker } from '../operations/validation'
import { ecoPipelineWriteStatus } from './pipeline-escritura-config'

/**
 * Alta de ideas en RADAROS por el agente PM (ORD-POS-131, DEC-ECO-007; docs/escritura-v1-8.md §9). Lógica pura, sin
 * red: encabezados esperados, validación del comando, lectura del libro, plan de la fila nueva y verificación. La
 * escritura la hace un `IdeasAltaStore` (ideas-alta-store.ts) y la auditoría el servicio de operaciones.
 *
 * DEC-ECO-007: solo filas NUEVAS al final de PRODUCTS (A a P) y de SCORING (A a L). Nunca edita filas existentes ni
 * escribe en las fórmulas de SCORING (M en adelante), ni en otras pestañas. La fila de SCORING solo se usa si ya trae
 * las fórmulas M a P copiadas (son por fila, no ARRAYFORMULA; datos del PM en el issue #289, 2026-11-02).
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

export const IDEAS_TABS = ['PRODUCTS', 'SCORING'] as const
export type IdeasTab = (typeof IDEAS_TABS)[number]

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
export const ANCHO: Record<IdeasTab, number> = { PRODUCTS: PRODUCTS_HEADERS.length, SCORING: SCORING_HEADERS.length }
/** Columnas de fórmulas por fila de SCORING que deben cubrir la fila nueva: M a P (índices 12 a 15). */
export const SCORING_FORMULAS = [12, 13, 14, 15] as const
/** Columna que debe tener valor tras escribir (M). */
export const SCORING_PRIMERA_FORMULA = 12

export type Celda = string | number

/** Puerto del libro de RADAROS para el alta. Filas 1-based; los arreglos omiten celdas y filas vacías al final. */
export interface IdeasAltaStore {
  readonly libro: string
  /** Valores calculados (UNFORMATTED_VALUE). */
  values(tab: IdeasTab): Promise<unknown[][]>
  /** Contenido tal cual (FORMULA): una celda con fórmula empieza por `=`. */
  formulas(tab: IdeasTab): Promise<unknown[][]>
  /** Escribe `A{fila}:{última}{fila}` con exactamente ANCHO[tab] celdas, en RAW. */
  writeRow(tab: IdeasTab, fila: number, celdas: Celda[]): Promise<void>
}

export function assertIdeasTab(tab: string): asserts tab is IdeasTab {
  if (!(IDEAS_TABS as readonly string[]).includes(tab)) throw new Error('pestaña fuera de la lista cerrada del alta de ideas')
}

export function assertFila(tab: IdeasTab, fila: number, celdas: readonly Celda[]) {
  if (!Number.isInteger(fila) || fila < 2 || fila > MAX_DATA_ROWS + 1) throw new Error('fila fuera de rango')
  if (celdas.length !== ANCHO[tab]) throw new Error('ancho de fila distinto del permitido')
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

export interface AltaIdeaCommand {
  requestId: string
  /** `PAQ-AAAA-MM-DD-NN «sí PAQ-… del propietario» AAAA-MM-DD` (DEC-POS-013): se audita como AUTORIZACION. */
  autorizacion: string
  /** PRODUCTS B a P (15 celdas; '' = vacía). B (producto) es obligatoria. */
  products: Celda[]
  /** SCORING C a L (10 celdas): entero 1 a 5 o ''. */
  puntajes: Celda[]
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
  const c = new Checker(input, ['requestId', 'autorizacion', 'puntajes', ...CAMPOS_PRODUCTS])
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
  c.done()
  return { requestId, autorizacion, products, puntajes }
}

/* --------------------------------- Lectura y plan --------------------------------- */

const texto = (v: unknown): string => (v === null || v === undefined ? '' : String(v)).normalize('NFC').trim()
const vacia = (v: unknown) => texto(v) === ''
const ID_IDEA = /^EC-(\d{3,})$/

export interface LibroIdeas {
  products: unknown[][]
  scoring: unknown[][]
  scoringFormulas: unknown[][]
}

/** Lee lo necesario y compara encabezados (A a P y A a L, exactos y en orden). Si difieren, no se escribe nada. */
export async function leerLibroIdeas(store: IdeasAltaStore): Promise<LibroIdeas> {
  let libro: LibroIdeas
  try {
    const [products, scoring, scoringFormulas] = await Promise.all([store.values('PRODUCTS'), store.values('SCORING'), store.formulas('SCORING')])
    libro = { products, scoring, scoringFormulas }
  } catch {
    throw new OperationError('lectura-fallida')
  }
  const distintas = (fila: unknown[] | undefined, esperados: readonly string[]) =>
    esperados.map((h, i) => (texto(fila?.[i]) === h ? null : i)).filter((i): i is number => i !== null)
  const p = distintas(libro.products[0], PRODUCTS_HEADERS)
  const s = distintas(libro.scoring[0], SCORING_HEADERS)
  if (p.length || s.length) {
    // Solo letras de columna, nunca el contenido de la hoja.
    const letras = (xs: number[]) => xs.map((i) => String.fromCharCode(65 + i)).join(',')
    throw new OperationError('idea-encabezados-distintos', { detail: { ...(p.length ? { PRODUCTS: letras(p) } : {}), ...(s.length ? { SCORING: letras(s) } : {}) } })
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
}

/** Las dos filas completas (A:P y A:L). SCORING B se copia de PRODUCTS B: un solo nombre (issue #289, respuesta 3). */
export function planIdea(id: string, cmd: Pick<AltaIdeaCommand, 'products' | 'puntajes'>): PlanIdea {
  return { id, products: [id, ...cmd.products], scoring: [id, cmd.products[0]!, ...cmd.puntajes] }
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
export function comprobarIdea(plan: PlanIdea, libro: LibroIdeas): { filaP: number | null; filaS: number | null } {
  const enProducts = filaDeId(libro.products, plan.id)
  const enScoring = filaDeId(libro.scoring, plan.id)
  if (filasConId(libro.products, plan.id) > 1 || filasConId(libro.scoring, plan.id) > 1) throw new OperationError('conflicto-concurrente')
  if (enProducts && !filaCoincide(enProducts.row, plan.products)) throw new OperationError('estado-divergente')
  if (enScoring && !filaCoincide(enScoring.row, plan.scoring)) throw new OperationError('estado-divergente')
  return { filaP: enProducts ? null : filaProducts(libro.products), filaS: enScoring ? null : filaScoring(libro.scoringFormulas) }
}

/**
 * Relee el libro, repite las comprobaciones, escribe lo que falte del plan (PRODUCTS y luego SCORING) y verifica
 * releyendo: las filas coinciden y M de SCORING tiene valor. Si la idea ya está completa, no escribe nada.
 */
export async function escribirIdea(store: IdeasAltaStore, plan: PlanIdea): Promise<void> {
  const { filaP, filaS } = comprobarIdea(plan, await leerLibroIdeas(store))

  try {
    if (filaP !== null) await store.writeRow('PRODUCTS', filaP, plan.products)
    if (filaS !== null) await store.writeRow('SCORING', filaS, plan.scoring)
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
  if (vacia(s.row[SCORING_PRIMERA_FORMULA])) throw new OperationError('idea-sin-calculo', { detail: { fila: s.fila } })
}

/* ------------------------------ Auditoría (AUDITORIA) ------------------------------ */

/** CAMPO de AUDITORIA de cada celda: `PRODUCTS!<encabezado>` y `SCORING!<encabezado>` (C a L). */
export const campoProducts = (i: number) => `PRODUCTS!${PRODUCTS_HEADERS[i]}`
export const campoScoring = (i: number) => `SCORING!${SCORING_HEADERS[i]}`

/** Diferencias de la alta para AUDITORIA: PRODUCT_ID, celdas no vacías y AUTORIZACION. */
export function auditDiff(plan: PlanIdea, autorizacion: string): Map<string, { antes: string; despues: string }> {
  const diff = new Map<string, { antes: string; despues: string }>()
  diff.set('PRODUCT_ID', { antes: '', despues: plan.id })
  plan.products.forEach((v, i) => { if (i > 0 && v !== '') diff.set(campoProducts(i), { antes: '', despues: String(v) }) })
  plan.scoring.forEach((v, i) => { if (i > 1 && v !== '') diff.set(campoScoring(i), { antes: '', despues: String(v) }) })
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
  return planIdea(id, { products, puntajes })
}
