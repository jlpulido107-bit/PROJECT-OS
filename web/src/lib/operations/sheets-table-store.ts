import { MAX_DATA_ROWS, ULTIMA_COLUMNA } from '../schema'
import { MIGRATION_TABS, type WriteTab } from './constants'
import { OperationError } from './errors'
import { pestanaFaltante, type TableStore } from './table-store'

/**
 * Adaptador de ESCRITURA a Google Sheets (V1.4) — PREPARADO, NO CONECTADO.
 *
 * - Ningún módulo de la aplicación lo importa: el modo `sheets` está bloqueado (operations/config.ts) y
 *   tests/security.test.ts falla si algún archivo de `src/` lo importa.
 * - Solo se ejercita en pruebas de contrato contra un servidor de Sheets simulado (tests/helpers/fake-sheets.ts).
 * - Requiere un proveedor de token de ESCRITURA dedicado (cuenta de servicio distinta del lector, Editor solo del
 *   spreadsheet maestro, alcance `spreadsheets`). Ese proveedor NO existe en este código: su incorporación es parte
 *   del runbook de activación (docs/operaciones-v1-4.md) y requiere aprobación explícita.
 * - Escribe con valueInputOption=RAW (nunca evalúa fórmulas).
 */
export interface SheetsTableStoreOptions {
  spreadsheetId: string
  getWriteToken: () => Promise<string>
  fetchImpl?: typeof fetch
}

const API = 'https://sheets.googleapis.com/v4/spreadsheets/'
const TIMEOUT_MS = 15_000

function quoteTab(tab: string) {
  return `'${tab.replace(/'/g, "''")}'`
}

function columnLetter(index: number): string {
  let n = index + 1
  let letters = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    letters = String.fromCharCode(65 + rem) + letters
    n = Math.floor((n - 1) / 26)
  }
  return letters
}

export class SheetsTableStore implements TableStore {
  readonly kind = 'sheets' as const
  private readonly fetchImpl: typeof fetch
  private readonly base: string

  constructor(private readonly options: SheetsTableStoreOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.base = API + encodeURIComponent(options.spreadsheetId) + '/values/'
  }

  private async call(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<unknown> {
    const token = await this.options.getWriteToken()
    const response = await this.fetchImpl(this.base + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    })
    // Nunca se lee ni se propaga el cuerpo de un error.
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.json()
  }

  async readTable(tab: WriteTab): Promise<string[][]> {
    const range = encodeURIComponent(`${quoteTab(tab)}!A1:${ULTIMA_COLUMNA}${MAX_DATA_ROWS + 2}`)
    let data: { values?: unknown }
    try {
      data = (await this.call('GET', `${range}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`)) as { values?: unknown }
    } catch (error) {
      // Sheets responde 400 a un rango de una pestaña que no existe: si la crea una migración (ORD-POS-141), se dice así.
      if (MIGRATION_TABS.includes(tab) && error instanceof Error && error.message === 'HTTP 400') throw pestanaFaltante(tab)
      throw new OperationError('lectura-fallida')
    }
    const values = Array.isArray(data.values) ? (data.values as unknown[][]) : []
    if (values.length > MAX_DATA_ROWS + 1) throw new OperationError('lectura-fallida', { detail: { motivo: 'limite-filas' } })
    return values.map((row) => (Array.isArray(row) ? row.map((c) => (c === null || c === undefined ? '' : String(c))) : []))
  }

  async appendRows(tab: WriteTab, rows: string[][]): Promise<void> {
    const range = encodeURIComponent(`${quoteTab(tab)}!A1`)
    await this.call('POST', `${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      majorDimension: 'ROWS',
      values: rows,
    })
  }

  async writeRow(tab: WriteTab, sheetRow: number, row: string[]): Promise<void> {
    if (!Number.isInteger(sheetRow) || sheetRow < 2) throw new OperationError('conflicto-concurrente')
    const a1 = `${quoteTab(tab)}!A${sheetRow}:${columnLetter(Math.max(row.length, 1) - 1)}${sheetRow}`
    await this.call('PUT', `${encodeURIComponent(a1)}?valueInputOption=RAW`, {
      range: a1,
      majorDimension: 'ROWS',
      values: [row],
    })
  }
}
