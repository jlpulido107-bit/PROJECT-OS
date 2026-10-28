import { describe, expect, it, vi } from 'vitest'
import { createSheetsReader, SHEETS_READONLY_SCOPE, SheetsReadError, tabRange } from '@/lib/sheets-client'

const TOKEN = 'ya29.token-de-prueba-no-real'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function reader(fetchImpl: typeof fetch) {
  return createSheetsReader({
    spreadsheetId: 'HOJA_SINTETICA_1234567890abcdef',
    getAccessToken: async () => TOKEN,
    fetchImpl,
    sleep: async () => {},
  })
}

describe('cliente de Google Sheets (solo lectura)', () => {
  it('usa el alcance de solo lectura', () => {
    expect(SHEETS_READONLY_SCOPE).toBe('https://www.googleapis.com/auth/spreadsheets.readonly')
  })

  it('escapa nombres de pestaña en rangos A1 e incluye fila centinela', () => {
    expect(tabRange("O'Brien")).toBe("'O''Brien'!A1:AZ5002")
  })

  it('lee solo pestañas existentes con GET y token en cabecera (no en la URL)', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      if (String(url).includes('values:batchGet')) {
        return jsonResponse({ valueRanges: [{ values: [['PROYECTO_ID'], ['SIG']] }, {}] })
      }
      return jsonResponse({ sheets: [{ properties: { title: 'PROYECTOS' } }, { properties: { title: 'TAREAS' } }, { properties: { title: 'OTRA' } }] })
    }) as unknown as typeof fetch

    const tabs = await reader(fetchImpl).readTabs(['PROYECTOS', 'TAREAS', 'HITOS'])
    expect(tabs).toEqual({ PROYECTOS: [['PROYECTO_ID'], ['SIG']], TAREAS: [] })
    expect(tabs.HITOS).toBeUndefined()
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call.init?.method).toBe('GET')
      expect(call.init?.body).toBeUndefined()
      expect(call.url).not.toContain(TOKEN)
      expect((call.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
    }
    const batch = new URL(calls[1]!.url)
    expect(batch.pathname).toMatch(/\/values:batchGet$/)
    expect(batch.searchParams.getAll('ranges')).toEqual(["'PROYECTOS'!A1:AZ5002", "'TAREAS'!A1:AZ5002"])
    expect(batch.searchParams.get('valueRenderOption')).toBe('FORMATTED_VALUE')
  })

  it('valueRenderOption opcional (ORD-POS-074): por defecto FORMATTED_VALUE; UNFORMATTED_VALUE solo si se pide', async () => {
    const urls: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url))
      if (String(url).includes('values:batchGet')) return jsonResponse({ valueRanges: [{ values: [['X']] }] })
      return jsonResponse({ sheets: [{ properties: { title: 'PROYECTOS' } }] })
    }) as unknown as typeof fetch
    await reader(fetchImpl).readTabs(['PROYECTOS'], {})
    await reader(fetchImpl).readTabs(['PROYECTOS'], { valueRenderOption: 'UNFORMATTED_VALUE' })
    const [porDefecto, sinFormato] = urls.filter((u) => u.includes('values:batchGet')).map((u) => new URL(u).searchParams)
    expect(porDefecto!.get('valueRenderOption')).toBe('FORMATTED_VALUE')
    expect(sinFormato!.get('valueRenderOption')).toBe('UNFORMATTED_VALUE')
    expect(sinFormato!.get('dateTimeRenderOption')).toBe('FORMATTED_STRING')
  })

  it.each([
    [401, 'auth'],
    [403, 'permission'],
    [404, 'not-found'],
    [400, 'unavailable'],
  ])('HTTP %i → error %s sin exponer el cuerpo de la respuesta', async (status, code) => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: 'detalle interno secreto' } }, status)) as unknown as typeof fetch
    const error = await reader(fetchImpl).readTabs(['PROYECTOS']).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SheetsReadError)
    expect((error as SheetsReadError).code).toBe(code)
    expect((error as Error).message).not.toContain('detalle interno')
    expect((error as Error).message).not.toContain(TOKEN)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('reintenta una vez ante 429/5xx', async () => {
    let n = 0
    const fetchImpl = vi.fn(async () => {
      n += 1
      if (n === 1) return new Response('', { status: 503 })
      return jsonResponse({ sheets: [] })
    }) as unknown as typeof fetch
    await expect(reader(fetchImpl).readTabs(['PROYECTOS'])).resolves.toEqual({})
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('cuota agotada tras el reintento → error quota', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 429 })) as unknown as typeof fetch
    await expect(reader(fetchImpl).readTabs(['PROYECTOS'])).rejects.toMatchObject({ code: 'quota' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('fallo al obtener token → error auth genérico', async () => {
    const r = createSheetsReader({
      spreadsheetId: 'HOJA_SINTETICA_1234567890abcdef',
      getAccessToken: async () => { throw new Error('invalid_grant: clave privada XYZ') },
      fetchImpl: vi.fn() as unknown as typeof fetch,
    })
    const error = await r.readTabs(['PROYECTOS']).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'auth' })
    expect((error as Error).message).not.toContain('XYZ')
  })

  it('timeout de red → error timeout', async () => {
    const fetchImpl = vi.fn(async () => { throw new DOMException('timeout', 'TimeoutError') }) as unknown as typeof fetch
    await expect(reader(fetchImpl).readTabs(['PROYECTOS'])).rejects.toMatchObject({ code: 'timeout' })
  })

  it('respuesta inesperada → invalid-response', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('batchGet') ? jsonResponse({ valueRanges: [] }) : jsonResponse({ sheets: [{ properties: { title: 'PROYECTOS' } }] }),
    ) as unknown as typeof fetch
    await expect(reader(fetchImpl).readTabs(['PROYECTOS'])).rejects.toMatchObject({ code: 'invalid-response' })
  })
})
