import { MAX_DATA_ROWS } from '../schema'

/**
 * Almacén de ESCRITURA del pipeline en el libro de RADAROS (ORD-POS-102, docs/diseno-eco-pipeline.md §6.2). Es el único
 * archivo del pipeline con endpoints de escritura de Sheets y no conoce otro libro: recibe un `spreadsheetId` fijo al
 * construirse (lo pone pipeline-escritura-runtime.ts, siempre RADAROS_SHEET_ID) y nunca uno por petición.
 *
 * - Lista CERRADA de pestañas: cualquier otra (SCORING, AMZ_*, PRODUCTS, PIPE_PARAMETROS…) lanza un error de
 *   programación antes de pedir el token. Esas pestañas solo las lee /eco con la cuenta de lectura.
 * - Rangos construidos aquí (`'<PESTAÑA>'!A<n>:<col><n>`), nunca uno que venga en la petición.
 * - Edita celda por celda (`'<PESTAÑA>'!X<n>:X<n>`): solo las columnas que cambian, para no pisar fórmulas ni columnas
 *   que el propietario añada al final.
 * - Escribe solo con valueInputOption=RAW (nunca evalúa fórmulas). Nunca lee ni propaga el cuerpo de un error.
 */

export const ECO_WRITE_TABS = ['PIPE_PRODUCTOS', 'PIPE_PROVEEDORES', 'PIPE_COTIZACIONES', 'PIPE_EMBARQUES', 'PIPE_AUDITORIA'] as const
export type EcoWriteTab = (typeof ECO_WRITE_TABS)[number]
export type Celda = string | number

/** Error de programación (no de usuario): una pestaña fuera de la lista cerrada nunca llega a Google. */
export function assertEcoTab(tab: string): asserts tab is EcoWriteTab {
  if (!(ECO_WRITE_TABS as readonly string[]).includes(tab)) throw new Error('pestaña fuera de la lista cerrada del pipeline')
}

export interface CeldaCambio {
  /** Índice de columna desde 0 (A = 0). */
  columna: number
  valor: Celda
}

export interface EcoPipelineStore {
  /** Libro al que está ligado (para las pruebas cruzadas; nunca se muestra). */
  readonly libro: string
  /** Títulos de las pestañas del libro. */
  tabs(): Promise<string[]>
  /** Valores de las pestañas pedidas, con encabezado; una pestaña ausente no aparece. */
  read(tabs: readonly EcoWriteTab[]): Promise<Partial<Record<EcoWriteTab, unknown[][]>>>
  /** Una fila con `valueRenderOption=FORMULA` (para no pisar una fórmula de la hoja). `fila` es 1-based. */
  formulas(tab: EcoWriteTab, fila: number): Promise<unknown[]>
  append(tab: EcoWriteTab, rows: Celda[][]): Promise<void>
  /** Celdas de UNA fila existente (1-based). */
  update(tab: EcoWriteTab, fila: number, celdas: CeldaCambio[]): Promise<void>
}

export interface EcoSheetsStoreOptions {
  spreadsheetId: string
  getWriteToken: () => Promise<string>
  fetchImpl?: typeof fetch
}

const API = 'https://sheets.googleapis.com/v4/spreadsheets/'
const TIMEOUT_MS = 15_000
/** 52 columnas: §3.1 ocupa 26 y el propietario puede añadir otras al final. */
const ULTIMA = 'AZ'

/** 0 → A, 25 → Z, 26 → AA. */
export function letraColumna(i: number): string {
  let n = i + 1
  let s = ''
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

function quoteTab(tab: string) {
  return `'${tab.replace(/'/g, "''")}'`
}

function filaValida(fila: number) {
  if (!Number.isInteger(fila) || fila < 2 || fila > MAX_DATA_ROWS + 1) throw new Error('fila fuera de rango')
}

export class EcoSheetsStore implements EcoPipelineStore {
  readonly libro: string
  private readonly fetchImpl: typeof fetch
  private readonly base: string

  constructor(private readonly options: EcoSheetsStoreOptions) {
    this.libro = options.spreadsheetId
    this.fetchImpl = options.fetchImpl ?? fetch
    this.base = API + encodeURIComponent(options.spreadsheetId)
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const token = await this.options.getWriteToken()
    const response = await this.fetchImpl(this.base + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.json()
  }

  async tabs(): Promise<string[]> {
    const data = (await this.call('GET', '?fields=sheets.properties.title')) as { sheets?: Array<{ properties?: { title?: unknown } }> }
    return (data.sheets ?? []).map((s) => s.properties?.title).filter((t): t is string => typeof t === 'string')
  }

  async read(tabs: readonly EcoWriteTab[]): Promise<Partial<Record<EcoWriteTab, unknown[][]>>> {
    tabs.forEach(assertEcoTab)
    if (!tabs.length) return {}
    const params = new URLSearchParams()
    for (const tab of tabs) params.append('ranges', `${quoteTab(tab)}!A1:${ULTIMA}${MAX_DATA_ROWS + 2}`)
    params.set('majorDimension', 'ROWS')
    params.set('valueRenderOption', 'UNFORMATTED_VALUE')
    params.set('dateTimeRenderOption', 'FORMATTED_STRING')
    const data = (await this.call('GET', `/values:batchGet?${params.toString()}`)) as { valueRanges?: Array<{ values?: unknown }> }
    const ranges = data.valueRanges ?? []
    const out: Partial<Record<EcoWriteTab, unknown[][]>> = {}
    tabs.forEach((tab, i) => {
      const values = ranges[i]?.values
      out[tab] = Array.isArray(values) ? (values as unknown[][]).map((row) => (Array.isArray(row) ? row : [])) : []
    })
    return out
  }

  async formulas(tab: EcoWriteTab, fila: number): Promise<unknown[]> {
    assertEcoTab(tab)
    filaValida(fila)
    const range = encodeURIComponent(`${quoteTab(tab)}!A${fila}:${ULTIMA}${fila}`)
    const data = (await this.call('GET', `/values/${range}?majorDimension=ROWS&valueRenderOption=FORMULA`)) as { values?: unknown }
    const row = Array.isArray(data.values) ? (data.values as unknown[][])[0] : undefined
    return Array.isArray(row) ? row : []
  }

  async append(tab: EcoWriteTab, rows: Celda[][]): Promise<void> {
    assertEcoTab(tab)
    const range = encodeURIComponent(`${quoteTab(tab)}!A1`)
    await this.call('POST', `/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { majorDimension: 'ROWS', values: rows })
  }

  async update(tab: EcoWriteTab, fila: number, celdas: CeldaCambio[]): Promise<void> {
    assertEcoTab(tab)
    filaValida(fila)
    if (!celdas.length) return
    const data = celdas.map(({ columna, valor }) => {
      const c = letraColumna(columna)
      return { range: `${quoteTab(tab)}!${c}${fila}:${c}${fila}`, majorDimension: 'ROWS', values: [[valor]] }
    })
    await this.call('POST', '/values:batchUpdate', { valueInputOption: 'RAW', data })
  }
}

/** Libro de RADAROS en memoria, para las pruebas: misma lista cerrada y misma semántica (vacías al final se omiten). */
export class InMemoryEcoStore implements EcoPipelineStore {
  private readonly data = new Map<string, unknown[][]>()
  /** Celdas con fórmula: `PESTAÑA!fila!columna` → texto de la fórmula. */
  readonly formulasHoja = new Map<string, string>()

  constructor(readonly libro: string, initial: Partial<Record<string, unknown[][]>>) {
    for (const [tab, values] of Object.entries(initial)) if (values) this.data.set(tab, values.map((row) => [...row]))
  }

  async tabs(): Promise<string[]> {
    return [...this.data.keys()]
  }

  async read(tabs: readonly EcoWriteTab[]): Promise<Partial<Record<EcoWriteTab, unknown[][]>>> {
    tabs.forEach(assertEcoTab)
    const out: Partial<Record<EcoWriteTab, unknown[][]>> = {}
    for (const tab of tabs) {
      const values = this.data.get(tab)
      if (values) out[tab] = values.map((row) => [...row])
    }
    return out
  }

  async formulas(tab: EcoWriteTab, fila: number): Promise<unknown[]> {
    assertEcoTab(tab)
    filaValida(fila)
    const row = [...(this.data.get(tab)?.[fila - 1] ?? [])]
    for (const [k, f] of this.formulasHoja) {
      const [t, n, c] = k.split('!')
      if (t === tab && Number(n) === fila) row[Number(c)] = f
    }
    return row
  }

  async append(tab: EcoWriteTab, rows: Celda[][]): Promise<void> {
    assertEcoTab(tab)
    const values = this.data.get(tab)
    if (!values) throw new Error('HTTP 400')
    for (const row of rows) {
      const copy = [...row]
      while (copy.length && copy[copy.length - 1] === '') copy.pop()
      values.push(copy)
    }
  }

  async update(tab: EcoWriteTab, fila: number, celdas: CeldaCambio[]): Promise<void> {
    assertEcoTab(tab)
    filaValida(fila)
    const values = this.data.get(tab)
    if (!values) throw new Error('HTTP 400')
    while (values.length < fila) values.push([])
    const row = values[fila - 1]!
    for (const { columna, valor } of celdas) {
      while (row.length <= columna) row.push('')
      row[columna] = valor
    }
    while (row.length && row[row.length - 1] === '') row.pop()
  }

  snapshot(): Record<string, unknown[][]> {
    return Object.fromEntries([...this.data.entries()].map(([tab, values]) => [tab, values.map((row) => [...row])]))
  }
}
