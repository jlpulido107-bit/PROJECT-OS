import 'server-only'

import { cacheSeconds, ConfigError, dataSource, spreadsheetId } from './config'
import { createTokenProvider, type TokenProvider } from './credentials'
import { todayInMerida } from './dates'
import { buildFixtureTabs } from './fixtures'
import { TABS_READ } from './schema'
import { createSheetsReader, SheetsReadError, type SheetsErrorCode } from './sheets-client'
import { buildDataset } from './table'
import type { Dataset } from './types'

export type LoadResult =
  | { ok: true; data: Dataset }
  | { ok: false; error: { code: SheetsErrorCode; message: string }; at: number }

/**
 * Caché corta en memoria del proceso del servidor. No hay segunda base de datos:
 * Sheets sigue siendo la autoridad y cada lectura caduca en DASHBOARD_CACHE_SECONDS.
 */
let cached: { result: LoadResult; expiresAt: number } | null = null
let inFlight: Promise<LoadResult> | null = null
let lastForced = 0

const ERROR_CACHE_MS = 10_000
const MIN_FORCED_INTERVAL_MS = 10_000

let tokenProvider: TokenProvider | null = null

/** Proveedor de tokens según la política explícita de credenciales (clave local o ADC). */
function accessToken(): Promise<string> {
  tokenProvider ??= createTokenProvider()
  return tokenProvider.getAccessToken()
}

async function load(): Promise<LoadResult> {
  const fetchedAt = Date.now()
  try {
    if (dataSource() === 'fixtures') {
      const raw = buildFixtureTabs(todayInMerida(new Date(fetchedAt)))
      return { ok: true, data: buildDataset(raw, { source: 'fixtures', fetchedAt }) }
    }
    const reader = createSheetsReader({ spreadsheetId: spreadsheetId(), getAccessToken: accessToken })
    const raw = await reader.readTabs(TABS_READ)
    return { ok: true, data: buildDataset(raw, { source: 'sheets', fetchedAt }) }
  } catch (error) {
    if (error instanceof SheetsReadError) {
      return { ok: false, error: { code: error.code, message: error.message }, at: fetchedAt }
    }
    if (error instanceof ConfigError) {
      // Mensaje propio sin valores de configuración ni secretos: seguro para logs del servidor.
      console.warn('[project-os] Configuración inválida:', error.message)
      return { ok: false, error: { code: 'config', message: error.message }, at: fetchedAt }
    }
    console.error('[project-os] Error inesperado al leer datos:', error instanceof Error ? error.name : 'desconocido')
    return { ok: false, error: { code: 'unavailable', message: 'No se pudieron leer los datos.' }, at: fetchedAt }
  }
}

/** Devuelve los datos desde caché o leyendo Sheets. Las llamadas concurrentes comparten la lectura. */
export async function getDataset(): Promise<LoadResult> {
  const now = Date.now()
  if (cached && cached.expiresAt > now) return cached.result
  if (inFlight) return inFlight
  inFlight = load()
    .then((result) => {
      const ttl = result.ok ? safeCacheMs() : ERROR_CACHE_MS
      cached = { result, expiresAt: Date.now() + ttl }
      return result
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

function safeCacheMs(): number {
  try {
    return cacheSeconds() * 1000
  } catch {
    return 60_000
  }
}

/**
 * Invalida la caché para la siguiente lectura (botón "Actualizar").
 * Limita la frecuencia para no agotar la cuota de la API.
 */
export function invalidateDataset(): boolean {
  const now = Date.now()
  if (now - lastForced < MIN_FORCED_INTERVAL_MS) return false
  lastForced = now
  cached = null
  return true
}
