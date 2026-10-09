import { WRITE_HEADERS, type WriteTab } from './constants'
import { OperationError } from './errors'

/**
 * Puerto de almacenamiento a nivel de tabla (pestaña de Sheets). El servicio de operaciones solo conoce este
 * contrato; hay dos adaptadores con las mismas pruebas de contrato:
 * - InMemoryTableStore (modo `mock`, pruebas).
 * - SheetsTableStore (preparado, NO conectado a la app en V1.4; ver sheets-table-store.ts).
 *
 * Semántica común (igual que la API de Sheets):
 * - `readTable` devuelve la fila 1 (encabezados) y las filas de datos; las celdas vacías al final de una fila se omiten.
 * - Los números de fila son los de la hoja (encabezados = 1).
 * - `appendRows` agrega al final; `writeRow` sobrescribe una fila completa.
 */
export interface TableStore {
  readonly kind: 'mock' | 'sheets'
  readTable(tab: WriteTab): Promise<string[][]>
  appendRows(tab: WriteTab, rows: string[][]): Promise<void>
  writeRow(tab: WriteTab, sheetRow: number, row: string[]): Promise<void>
}

function trimTrailing(row: string[]): string[] {
  let end = row.length
  while (end > 0 && (row[end - 1] ?? '') === '') end -= 1
  return row.slice(0, end)
}

/** Repositorio en memoria del proceso (modo simulado). No persiste: se pierde al reiniciar. */
export class InMemoryTableStore implements TableStore {
  readonly kind = 'mock' as const
  private readonly tabs = new Map<string, string[][]>()

  constructor(initial: Partial<Record<string, unknown[][]>>) {
    for (const [tab, values] of Object.entries(initial)) {
      if (!values) continue
      this.tabs.set(tab, values.map((row) => trimTrailing((row ?? []).map((cell) => (cell === null || cell === undefined ? '' : String(cell))))))
    }
  }

  async readTable(tab: WriteTab): Promise<string[][]> {
    const values = this.tabs.get(tab)
    if (!values) throw new OperationError('esquema-invalido')
    return values.map((row) => [...row])
  }

  async appendRows(tab: WriteTab, rows: string[][]): Promise<void> {
    const values = this.tabs.get(tab)
    if (!values) throw new OperationError('esquema-invalido')
    for (const row of rows) values.push(trimTrailing([...row]))
  }

  async writeRow(tab: WriteTab, sheetRow: number, row: string[]): Promise<void> {
    const values = this.tabs.get(tab)
    if (!values || sheetRow < 2 || sheetRow > values.length) throw new OperationError('conflicto-concurrente')
    values[sheetRow - 1] = trimTrailing([...row])
  }

  /** Copia de todas las pestañas (para que el dashboard muestre el estado simulado). */
  snapshot(): Record<string, string[][]> {
    return Object.fromEntries([...this.tabs.entries()].map(([tab, values]) => [tab, values.map((row) => [...row])]))
  }
}

/* ------------------------------ Mapeo por encabezados ------------------------------ */

export interface TableView {
  tab: WriteTab
  /** Encabezados reales de la fila 1 (orden real de la hoja). */
  header: string[]
  index: Map<string, number>
  /** Filas de datos con su número de fila en la hoja. */
  rows: Array<{ sheetRow: number; cells: string[] }>
}

/**
 * Lee una pestaña y valida que contenga TODAS las columnas del contrato (por nombre, sin duplicados).
 * Columnas adicionales se toleran. Si el esquema no coincide no se escribe nada (`esquema-invalido`).
 */
export async function readView(store: TableStore, tab: WriteTab): Promise<TableView> {
  const values = await store.readTable(tab)
  const header = (values[0] ?? []).map((h) => h.trim())
  const index = new Map<string, number>()
  for (const [i, name] of header.entries()) {
    if (!name) continue
    if (index.has(name)) throw new OperationError('esquema-invalido', { detail: { tab } })
    index.set(name, i)
  }
  for (const column of WRITE_HEADERS[tab]) {
    if (!index.has(column)) throw new OperationError('esquema-invalido', { detail: { tab } })
  }
  return {
    tab,
    header,
    index,
    rows: values.slice(1).map((cells, i) => ({ sheetRow: i + 2, cells })),
  }
}

export function cell(view: TableView, cells: string[], column: string): string {
  const at = view.index.get(column)
  return at === undefined ? '' : (cells[at] ?? '').trim()
}

/** Registro → fila en el orden real de encabezados; columnas no contempladas quedan vacías. */
export function toRow(view: TableView, record: Record<string, string>): string[] {
  return view.header.map((name) => record[name] ?? '')
}

export function toRecord(view: TableView, cells: string[]): Record<string, string> {
  const record: Record<string, string> = {}
  for (const column of WRITE_HEADERS[view.tab]) record[column] = cell(view, cells, column)
  return record
}

export function findById(view: TableView, idColumn: string, id: string) {
  return view.rows.filter((row) => cell(view, row.cells, idColumn) === id)
}
