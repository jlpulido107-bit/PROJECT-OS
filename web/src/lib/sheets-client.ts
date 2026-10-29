import 'server-only'

import { ConfigError } from './config'
import { MAX_DATA_ROWS, ULTIMA_COLUMNA } from './schema'

/**
 * Cliente de SOLO LECTURA de Google Sheets API v4.
 * - Alcance OAuth: spreadsheets.readonly (no puede escribir aunque la cuenta tenga permiso de Editor).
 * - Solo usa métodos GET. Nunca registra cuerpos de respuesta, tokens ni URLs con credenciales.
 */

export const SHEETS_READONLY_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly'
const API = 'https://sheets.googleapis.com/v4/spreadsheets/'
const TIMEOUT_MS = 15_000
const RETRY_DELAY_MS = 800

export type SheetsErrorCode =
  | 'config' | 'auth' | 'permission' | 'not-found' | 'quota' | 'unavailable' | 'timeout' | 'invalid-response'

const MESSAGES: Record<SheetsErrorCode, string> = {
  config: 'La conexión con Google Sheets no está configurada en el servidor.',
  auth: 'No se pudo autenticar la cuenta de servicio con Google.',
  permission: 'La cuenta de servicio no tiene acceso a la hoja. Compártela como Lector con esa cuenta.',
  'not-found': 'No se encontró la hoja de cálculo configurada.',
  quota: 'Google Sheets limitó temporalmente las lecturas (cuota). Intenta de nuevo en un minuto.',
  unavailable: 'Google Sheets no respondió correctamente. Intenta de nuevo más tarde.',
  timeout: 'La lectura de Google Sheets tardó demasiado.',
  'invalid-response': 'Google Sheets devolvió una respuesta inesperada.',
}

export type ValueRenderOption = 'FORMATTED_VALUE' | 'UNFORMATTED_VALUE'

export class SheetsReadError extends Error {
  readonly code: SheetsErrorCode
  constructor(code: SheetsErrorCode, message: string = MESSAGES[code]) {
    super(message)
    this.name = 'SheetsReadError'
    this.code = code
  }
}

export interface SheetsReaderOptions {
  spreadsheetId: string
  /** Devuelve un access token OAuth de la cuenta de servicio. */
  getAccessToken: () => Promise<string>
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

function statusError(status: number): SheetsReadError {
  if (status === 401) return new SheetsReadError('auth')
  if (status === 403) return new SheetsReadError('permission')
  if (status === 404) return new SheetsReadError('not-found')
  if (status === 429) return new SheetsReadError('quota')
  return new SheetsReadError('unavailable')
}

/** Rango A1 con el nombre de pestaña escapado. */
export function tabRange(tab: string): string {
  // Encabezado + MAX_DATA_ROWS + 1 fila centinela para detectar truncamiento.
  return `'${tab.replace(/'/g, "''")}'!A1:${ULTIMA_COLUMNA}${MAX_DATA_ROWS + 2}`
}

export function createSheetsReader(options: SheetsReaderOptions) {
  const fetchImpl = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const base = API + encodeURIComponent(options.spreadsheetId)

  async function getJson(url: string): Promise<unknown> {
    let token: string
    try {
      token = await options.getAccessToken()
    } catch (error) {
      // Un error de configuración (p. ej. identidad ADC inesperada) se propaga con su mensaje seguro.
      if (error instanceof ConfigError) throw error
      throw new SheetsReadError('auth')
    }
    for (let attempt = 0; ; attempt++) {
      let response: Response
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
          cache: 'no-store',
        })
      } catch (error) {
        const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
        if (attempt === 0 && !timeout) {
          await sleep(RETRY_DELAY_MS)
          continue
        }
        throw new SheetsReadError(timeout ? 'timeout' : 'unavailable')
      }
      if (response.ok) {
        try {
          return await response.json()
        } catch {
          throw new SheetsReadError('invalid-response')
        }
      }
      // Un reintento para fallos transitorios; nunca se lee ni registra el cuerpo del error.
      if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
        await sleep(RETRY_DELAY_MS)
        continue
      }
      throw statusError(response.status)
    }
  }

  /** Títulos de las pestañas existentes. */
  async function sheetTitles(): Promise<Set<string>> {
    const data = (await getJson(`${base}?fields=${encodeURIComponent('sheets.properties.title')}`)) as {
      sheets?: Array<{ properties?: { title?: unknown } }>
    }
    if (!data || !Array.isArray(data.sheets)) throw new SheetsReadError('invalid-response')
    return new Set(
      data.sheets.map((s) => s.properties?.title).filter((t): t is string => typeof t === 'string'),
    )
  }

  /**
   * Lee las pestañas indicadas en una sola petición batchGet.
   * Las pestañas inexistentes se devuelven como `undefined` (se reportan como error de esquema).
   * `valueRenderOption` por defecto `FORMATTED_VALUE`; /finanzas pide `UNFORMATTED_VALUE` para sumar montos como números
   * (ORD-POS-074, docs/diseno-finanzas.md §3, regla 3). Las fechas siguen como texto formateado.
   */
  async function readTabs<T extends string>(
    tabs: readonly T[], options: { valueRenderOption?: ValueRenderOption } = {},
  ): Promise<Partial<Record<T, unknown[][]>>> {
    const titles = await sheetTitles()
    const present = tabs.filter((t) => titles.has(t))
    const result: Partial<Record<T, unknown[][]>> = {}
    if (present.length === 0) return result
    const params = new URLSearchParams()
    for (const tab of present) params.append('ranges', tabRange(tab))
    params.set('majorDimension', 'ROWS')
    params.set('valueRenderOption', options.valueRenderOption ?? 'FORMATTED_VALUE')
    params.set('dateTimeRenderOption', 'FORMATTED_STRING')
    const data = (await getJson(`${base}/values:batchGet?${params.toString()}`)) as {
      valueRanges?: Array<{ values?: unknown }>
    }
    if (!data || !Array.isArray(data.valueRanges) || data.valueRanges.length !== present.length) {
      throw new SheetsReadError('invalid-response')
    }
    present.forEach((tab, i) => {
      const values = data.valueRanges?.[i]?.values
      result[tab] = Array.isArray(values) ? (values.filter(Array.isArray) as unknown[][]) : []
    })
    return result
  }

  return { readTabs, sheetTitles }
}
