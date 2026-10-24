import { MAX_DATA_ROWS } from '../schema'

/**
 * Almacén de ESCRITURA del libro FINANZAS (ORD-POS-077, docs/diseno-finanzas-v2.md §5). Es el único archivo de
 * finanzas con endpoints de escritura de Sheets y no conoce otro libro: recibe un `spreadsheetId` fijo al construirse
 * (lo pone escritura-runtime.ts, siempre FINANZAS_SHEET_ID) y nunca uno por petición.
 *
 * - Lee con `UNFORMATTED_VALUE` (montos como número) y fechas `FORMATTED_STRING`, como la vista de /finanzas.
 * - Escribe solo con `:append` y valueInputOption=RAW (nunca evalúa fórmulas); los montos viajan como número JSON.
 * - Nunca lee ni propaga el cuerpo de un error: solo el estado HTTP.
 */

export const FINANZAS_WRITE_TABS = ['MOVIMIENTOS', 'PARAMETROS', 'RECURRENTES', 'AUDITORIA'] as const
export type FinanzasWriteTab = (typeof FINANZAS_WRITE_TABS)[number]
export type Celda = string | number

export interface FinanzasStore {
  /** Libro al que está ligado (para las pruebas cruzadas; nunca se muestra). */
  readonly libro: string
  /** Títulos de las pestañas del libro. */
  tabs(): Promise<string[]>
  /** Valores de las pestañas pedidas, con encabezado; una pestaña ausente no aparece. */
  read(tabs: readonly FinanzasWriteTab[]): Promise<Partial<Record<FinanzasWriteTab, unknown[][]>>>
  append(tab: FinanzasWriteTab, rows: Celda[][]): Promise<void>
}

export interface FinanzasSheetsStoreOptions {
  spreadsheetId: string
  getWriteToken: () => Promise<string>
  fetchImpl?: typeof fetch
}

const API = 'https://sheets.googleapis.com/v4/spreadsheets/'
const TIMEOUT_MS = 15_000

function quoteTab(tab: string) {
  return `'${tab.replace(/'/g, "''")}'`
}

export class FinanzasSheetsStore implements FinanzasStore {
  readonly libro: string
  private readonly fetchImpl: typeof fetch
  private readonly base: string

  constructor(private readonly options: FinanzasSheetsStoreOptions) {
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

  async read(tabs: readonly FinanzasWriteTab[]): Promise<Partial<Record<FinanzasWriteTab, unknown[][]>>> {
    if (!tabs.length) return {}
    const params = new URLSearchParams()
    for (const tab of tabs) params.append('ranges', `${quoteTab(tab)}!A1:Z${MAX_DATA_ROWS + 2}`)
    params.set('majorDimension', 'ROWS')
    params.set('valueRenderOption', 'UNFORMATTED_VALUE')
    params.set('dateTimeRenderOption', 'FORMATTED_STRING')
    const data = (await this.call('GET', `/values:batchGet?${params.toString()}`)) as { valueRanges?: Array<{ values?: unknown }> }
    const ranges = data.valueRanges ?? []
    const out: Partial<Record<FinanzasWriteTab, unknown[][]>> = {}
    tabs.forEach((tab, i) => {
      const values = ranges[i]?.values
      out[tab] = Array.isArray(values) ? (values as unknown[][]).map((row) => (Array.isArray(row) ? row : [])) : []
    })
    return out
  }

  async append(tab: FinanzasWriteTab, rows: Celda[][]): Promise<void> {
    const range = encodeURIComponent(`${quoteTab(tab)}!A1`)
    await this.call('POST', `/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { majorDimension: 'ROWS', values: rows })
  }
}

/** Libro FINANZAS en memoria, para las pruebas: misma semántica (celdas vacías al final se omiten). */
export class InMemoryFinanzasStore implements FinanzasStore {
  private readonly data = new Map<string, unknown[][]>()

  constructor(readonly libro: string, initial: Partial<Record<string, unknown[][]>>) {
    for (const [tab, values] of Object.entries(initial)) if (values) this.data.set(tab, values.map((row) => [...row]))
  }

  async tabs(): Promise<string[]> {
    return [...this.data.keys()]
  }

  async read(tabs: readonly FinanzasWriteTab[]): Promise<Partial<Record<FinanzasWriteTab, unknown[][]>>> {
    const out: Partial<Record<FinanzasWriteTab, unknown[][]>> = {}
    for (const tab of tabs) {
      const values = this.data.get(tab)
      if (values) out[tab] = values.map((row) => [...row])
    }
    return out
  }

  async append(tab: FinanzasWriteTab, rows: Celda[][]): Promise<void> {
    const values = this.data.get(tab)
    if (!values) throw new Error('HTTP 400')
    for (const row of rows) {
      const copy = [...row]
      while (copy.length && copy[copy.length - 1] === '') copy.pop()
      values.push(copy)
    }
  }

  snapshot(): Record<string, unknown[][]> {
    return Object.fromEntries([...this.data.entries()].map(([tab, values]) => [tab, values.map((row) => [...row])]))
  }
}
