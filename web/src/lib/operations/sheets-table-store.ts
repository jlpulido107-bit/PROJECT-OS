import { MAX_DATA_ROWS, ULTIMA_COLUMNA } from '../schema'
import { MIGRATION_TABS, type WriteTab } from './constants'
import { esPestanaAuditoria, type PestanasAuditoria } from './auditoria-periodo'
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

export class SheetsTableStore implements TableStore, PestanasAuditoria {
  readonly kind = 'sheets' as const
  private readonly fetchImpl: typeof fetch
  private readonly spreadsheet: string
  private readonly base: string

  constructor(private readonly options: SheetsTableStoreOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.spreadsheet = API + encodeURIComponent(options.spreadsheetId)
    this.base = this.spreadsheet + '/values/'
  }

  private call(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<unknown> {
    return this.request(method, this.base + path, body)
  }

  private async request(method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown): Promise<unknown> {
    const token = await this.options.getWriteToken()
    const response = await this.fetchImpl(url, {
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
    return this.readRange(tab, (error) => {
      // Sheets responde 400 a un rango de una pestaña que no existe: si la crea una migración (ORD-POS-141), se dice así.
      if (MIGRATION_TABS.includes(tab) && error instanceof Error && error.message === 'HTTP 400') return pestanaFaltante(tab)
      return new OperationError('lectura-fallida')
    })
  }

  private async readRange(tab: string, onError: (error: unknown) => OperationError): Promise<string[][]> {
    const range = encodeURIComponent(`${quoteTab(tab)}!A1:${ULTIMA_COLUMNA}${MAX_DATA_ROWS + 2}`)
    let data: { values?: unknown }
    try {
      data = (await this.call('GET', `${range}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`)) as { values?: unknown }
    } catch (error) {
      throw onError(error)
    }
    const values = Array.isArray(data.values) ? (data.values as unknown[][]) : []
    if (values.length > MAX_DATA_ROWS + 1) throw new OperationError('lectura-fallida', { detail: { motivo: 'limite-filas' } })
    return values.map((row) => (Array.isArray(row) ? row.map((c) => (c === null || c === undefined ? '' : String(c))) : []))
  }

  async appendRows(tab: WriteTab, rows: string[][]): Promise<void> {
    await this.append(tab, rows)
  }

  private async append(tab: string, rows: string[][]): Promise<void> {
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

  /* --------- Pestañas físicas de la auditoría por periodo (ORD-POS-153, auditoria-periodo.ts) --------- */

  async pestanasAuditoria(): Promise<string[]> {
    const data = (await this.request('GET', `${this.spreadsheet}?fields=${encodeURIComponent('sheets.properties.title')}`)) as {
      sheets?: Array<{ properties?: { title?: unknown } }>
    }
    if (!Array.isArray(data.sheets)) throw new OperationError('lectura-fallida')
    return data.sheets.map((s) => s.properties?.title).filter((t): t is string => typeof t === 'string' && esPestanaAuditoria(t))
  }

  async leerPestanaAuditoria(nombre: string): Promise<string[][]> {
    if (!esPestanaAuditoria(nombre)) throw new OperationError('lectura-fallida')
    return this.readRange(nombre, () => new OperationError('lectura-fallida'))
  }

  async agregarAPestanaAuditoria(nombre: string, rows: string[][]): Promise<void> {
    if (!esPestanaAuditoria(nombre)) throw new OperationError('auditoria-fallida')
    await this.append(nombre, rows)
  }

  /**
   * Migración de la rotación: `addSheet` con el título (si ya existe, Sheets responde 400 y se sigue), y el encabezado en
   * la fila 1 solo si está vacía. Con otro encabezado falla: nunca sobrescribe una pestaña con datos.
   */
  async crearPestanaAuditoria(nombre: string, encabezado: readonly string[]): Promise<void> {
    if (!esPestanaAuditoria(nombre) || encabezado.length === 0) throw new OperationError('auditoria-fallida')
    try {
      await this.request('POST', `${this.spreadsheet}:batchUpdate`, { requests: [{ addSheet: { properties: { title: nombre } } }] })
    } catch (error) {
      if (!(error instanceof Error && error.message === 'HTTP 400')) throw new OperationError('auditoria-fallida')
    }
    const actual = await this.leerPestanaAuditoria(nombre)
    const primera = (actual[0] ?? []).map((c) => c.trim())
    if (actual.length === 0 || primera.every((c) => c === '')) {
      if (actual.length > 1) throw new OperationError('auditoria-fallida')
      const a1 = `${quoteTab(nombre)}!A1:${columnLetter(encabezado.length - 1)}1`
      await this.request('PUT', `${this.base}${encodeURIComponent(a1)}?valueInputOption=RAW`, { range: a1, majorDimension: 'ROWS', values: [[...encabezado]] })
      return
    }
    const esperado = [...encabezado]
    while (primera.length && primera.at(-1) === '') primera.pop()
    while (esperado.length && esperado.at(-1) === '') esperado.pop()
    if (primera.length !== esperado.length || primera.some((c, i) => c !== esperado[i])) throw new OperationError('auditoria-fallida')
  }
}
