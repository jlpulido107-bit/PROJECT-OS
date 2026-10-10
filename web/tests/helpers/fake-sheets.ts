/**
 * Servidor de Google Sheets API v4 SIMULADO (solo pruebas). Implementa lo que usa SheetsTableStore:
 * GET values/{range}, POST values/{range}:append, PUT values/{range}. Nunca hay red real.
 * Imita a Sheets: omite celdas vacías al final de cada fila en las lecturas.
 */
export interface FakeCall {
  method: string
  path: string
  query: URLSearchParams
  authorization: string | null
  body: unknown
}

function trimTrailing(row: string[]) {
  let end = row.length
  while (end > 0 && (row[end - 1] ?? '') === '') end -= 1
  return row.slice(0, end)
}

export class FakeSheets {
  readonly tabs = new Map<string, string[][]>()
  readonly calls: FakeCall[] = []
  /** Próximas operaciones que deben fallar (p. ej. 'POST AUDITORIA'). */
  readonly failures = new Set<string>()

  constructor(readonly spreadsheetId: string, initial: Record<string, unknown[][]>) {
    for (const [tab, values] of Object.entries(initial)) {
      this.tabs.set(tab, values.map((row) => trimTrailing(row.map((c) => (c === null || c === undefined ? '' : String(c))))))
    }
  }

  private parseRange(raw: string) {
    const match = /^'((?:[^']|'')+)'!([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(raw)
    if (!match) throw new Error(`rango no soportado: ${raw}`)
    return { tab: match[1]!.replace(/''/g, "'"), startRow: Number(match[3]) }
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const prefix = `/v4/spreadsheets/${encodeURIComponent(this.spreadsheetId)}/values/`
    if (url.hostname !== 'sheets.googleapis.com' || !url.pathname.startsWith(prefix)) {
      return new Response('{}', { status: 404 })
    }
    let rangePart = decodeURIComponent(url.pathname.slice(prefix.length))
    const isAppend = rangePart.endsWith(':append')
    if (isAppend) rangePart = rangePart.slice(0, -':append'.length)
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const headers = new Headers(init?.headers)
    this.calls.push({ method, path: rangePart + (isAppend ? ':append' : ''), query: url.searchParams, authorization: headers.get('authorization'), body })
    const { tab, startRow } = this.parseRange(rangePart)
    if (this.failures.delete(`${method} ${tab}`)) return new Response('{"error":"simulado"}', { status: 500 })
    const values = this.tabs.get(tab)
    if (!values) return new Response('{}', { status: 400 })

    if (method === 'GET') {
      return Response.json({ range: rangePart, majorDimension: 'ROWS', values: values.map((r) => [...r]) })
    }
    if (method === 'POST' && isAppend) {
      for (const row of (body as { values: string[][] }).values) values.push(trimTrailing(row.map(String)))
      return Response.json({ updates: { updatedRows: (body as { values: unknown[] }).values.length } })
    }
    if (method === 'PUT') {
      const row = (body as { values: string[][] }).values[0]!
      while (values.length < startRow) values.push([])
      values[startRow - 1] = trimTrailing(row.map(String))
      return Response.json({ updatedRows: 1 })
    }
    return new Response('{}', { status: 405 })
  }
}
