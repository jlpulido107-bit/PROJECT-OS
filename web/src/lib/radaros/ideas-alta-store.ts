import { MAX_DATA_ROWS, ULTIMA_COLUMNA } from '../schema'
import { assertAnexo, assertFila, assertIdeasTab, type AmzTab, type Celda, type IdeasAltaStore, type IdeasTab } from './ideas-alta'
import { letraColumna } from './pipeline-escritura-store'

/**
 * Almacén de ESCRITURA del alta de ideas en el libro de RADAROS (ORD-POS-131, DEC-ECO-007). Único archivo del alta con
 * un endpoint de escritura de Sheets. Recibe un `spreadsheetId` fijo al construirse (ideas-alta-runtime.ts, siempre
 * RADAROS_SHEET_ID) y nunca uno por petición.
 *
 * - Lista CERRADA de pestañas: PRODUCTS, SCORING y, por DEC-ECO-017 (ORD-POS-160), AMZ_IDEA_ASIN y AMZ_NICHO; cualquier
 *   otra lanza un error de programación antes de pedir el token.
 * - PRODUCTS y SCORING: batchUpdate de valores con UN rango `A<n>:P<n>` o `A<n>:L<n>`, con exactamente ese ancho
 *   (`assertFila`). Así nunca se escribe en las fórmulas de SCORING (M en adelante). Sin append: la fila nueva de SCORING
 *   ya existe con sus fórmulas.
 * - AMZ_IDEA_ASIN y AMZ_NICHO: solo el anexado de valores con insertDataOption=INSERT_ROWS de UNA fila desde A, con el ancho
 *   del encabezado (3 a 52 celdas, `assertAnexo`). Inserta filas: nunca sobrescribe una que el motor haya anexado.
 * - Solo valueInputOption=RAW (nunca evalúa fórmulas). Nunca lee ni propaga el cuerpo de un error.
 */

export interface IdeasSheetsStoreOptions {
  spreadsheetId: string
  getWriteToken: () => Promise<string>
  fetchImpl?: typeof fetch
}

const API = 'https://sheets.googleapis.com/v4/spreadsheets/'
const TIMEOUT_MS = 15_000

function quoteTab(tab: string) {
  return `'${tab.replace(/'/g, "''")}'`
}

export class IdeasSheetsStore implements IdeasAltaStore {
  readonly libro: string
  private readonly fetchImpl: typeof fetch
  private readonly base: string

  constructor(private readonly options: IdeasSheetsStoreOptions) {
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

  private async read(tab: IdeasTab, render: 'UNFORMATTED_VALUE' | 'FORMULA'): Promise<unknown[][]> {
    assertIdeasTab(tab)
    const range = encodeURIComponent(`${quoteTab(tab)}!A1:${ULTIMA_COLUMNA}${MAX_DATA_ROWS + 2}`)
    const data = (await this.call('GET', `/values/${range}?majorDimension=ROWS&valueRenderOption=${render}&dateTimeRenderOption=FORMATTED_STRING`)) as { values?: unknown }
    return Array.isArray(data.values) ? (data.values as unknown[][]).map((row) => (Array.isArray(row) ? row : [])) : []
  }

  values(tab: IdeasTab): Promise<unknown[][]> {
    return this.read(tab, 'UNFORMATTED_VALUE')
  }

  formulas(tab: IdeasTab): Promise<unknown[][]> {
    return this.read(tab, 'FORMULA')
  }

  async writeRow(tab: IdeasTab, fila: number, celdas: Celda[]): Promise<void> {
    assertIdeasTab(tab)
    assertFila(tab, fila, celdas)
    const range = `${quoteTab(tab)}!A${fila}:${letraColumna(celdas.length - 1)}${fila}`
    await this.call('POST', '/values:batchUpdate', { valueInputOption: 'RAW', data: [{ range, majorDimension: 'ROWS', values: [celdas] }] })
  }

  async appendRow(tab: AmzTab, celdas: Celda[]): Promise<void> {
    assertIdeasTab(tab)
    assertAnexo(tab, celdas)
    const range = `${quoteTab(tab)}!A1:${letraColumna(celdas.length - 1)}1`
    await this.call('POST', `/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      range, majorDimension: 'ROWS', values: [celdas],
    })
  }
}

/**
 * Doble del libro para las pruebas: misma lista cerrada y mismo ancho. `formulasHoja` marca celdas con fórmula
 * (`PESTAÑA!fila!columna` → texto) y `calcular` simula su valor (por defecto, el ID de la fila si A tiene valor).
 */
export class InMemoryIdeasStore implements IdeasAltaStore {
  private readonly data = new Map<IdeasTab, unknown[][]>()
  readonly formulasHoja = new Map<string, string>()
  /** En un anexado, `fila` es donde quedó la fila (la siguiente a la última con contenido, también una fórmula). */
  readonly escrituras: Array<{ tab: IdeasTab; fila: number; celdas: Celda[]; anexo?: true }> = []
  calcular: (tab: IdeasTab, row: unknown[], col: number) => unknown = (_tab, row) => (row[0] === undefined || row[0] === '' ? '' : `calc:${String(row[0])}`)

  constructor(readonly libro: string, initial: Partial<Record<IdeasTab, unknown[][]>>) {
    for (const tab of Object.keys(initial) as IdeasTab[]) this.data.set(tab, (initial[tab] ?? []).map((row) => [...row]))
  }

  private rows(tab: IdeasTab): unknown[][] {
    assertIdeasTab(tab)
    const values = this.data.get(tab)
    if (!values) throw new Error('HTTP 400')
    return values
  }

  private formulaRows(tab: IdeasTab): Map<number, Map<number, string>> {
    const out = new Map<number, Map<number, string>>()
    for (const [k, f] of this.formulasHoja) {
      const [t, n, c] = k.split('!')
      if (t !== tab) continue
      if (!out.has(Number(n))) out.set(Number(n), new Map())
      out.get(Number(n))!.set(Number(c), f)
    }
    return out
  }

  private render(tab: IdeasTab, formulas: boolean): unknown[][] {
    const values = this.rows(tab).map((row) => [...row])
    for (const [fila, cols] of this.formulaRows(tab)) {
      while (values.length < fila) values.push([])
      const row = values[fila - 1]!
      for (const [col, f] of cols) {
        while (row.length <= col) row.push('')
        row[col] = formulas ? f : this.calcular(tab, row, col)
      }
    }
    return values.map((row) => {
      const copy = [...row]
      while (copy.length && (copy[copy.length - 1] === '' || copy[copy.length - 1] === undefined)) copy.pop()
      return copy
    })
  }

  async values(tab: IdeasTab): Promise<unknown[][]> {
    return this.render(tab, false)
  }

  async formulas(tab: IdeasTab): Promise<unknown[][]> {
    return this.render(tab, true)
  }

  async writeRow(tab: IdeasTab, fila: number, celdas: Celda[]): Promise<void> {
    assertIdeasTab(tab)
    assertFila(tab, fila, celdas)
    const values = this.rows(tab)
    while (values.length < fila) values.push([])
    const row = values[fila - 1]!
    celdas.forEach((v, i) => {
      while (row.length <= i) row.push('')
      row[i] = v
    })
    this.escrituras.push({ tab, fila, celdas: [...celdas] })
  }

  /** Como el anexado de Sheets con INSERT_ROWS: inserta la fila tras la última con contenido; nunca sobrescribe. */
  async appendRow(tab: AmzTab, celdas: Celda[]): Promise<void> {
    assertIdeasTab(tab)
    assertAnexo(tab, celdas)
    this.anexar(tab, celdas)
    this.escrituras.push({ tab, fila: this.render(tab, true).length, celdas: [...celdas], anexo: true })
  }

  /** Simula a otro escritor (el motor de RADAROS) que anexa una fila; no cuenta como escritura del alta. */
  anexarDelMotor(tab: AmzTab, celdas: unknown[]): void {
    this.anexar(tab, celdas)
  }

  private anexar(tab: AmzTab, celdas: readonly unknown[]): void {
    const values = this.rows(tab)
    const n = this.render(tab, true).length
    while (values.length < n) values.push([])
    values.splice(n, 0, [...celdas])
  }

  snapshot(): Record<string, unknown[][]> {
    return Object.fromEntries([...this.data.entries()].map(([tab, values]) => [tab, values.map((row) => [...row])]))
  }
}
