import 'server-only'

import { JWT } from 'google-auth-library'
import { cacheSeconds, ConfigError, dataSource, serviceAccount, spreadsheetId } from './config'
import { todayInMerida } from './dates'
import { buildFixtureTabs } from './fixtures'
import { mockWriteTabs, writeGeneration } from './operations/runtime'
import { TABS_READ } from './schema'
import { createSheetsReader, SHEETS_READONLY_SCOPE, SheetsReadError, type SheetsErrorCode } from './sheets-client'
import { buildDataset } from './table'
import type { Dataset } from './types'

export type LoadResult =
  | { ok: true; data: Dataset }
  | { ok: false; error: { code: SheetsErrorCode; message: string }; at: number }

/**
 * Caché corta en memoria del proceso del servidor. No hay segunda base de datos:
 * Sheets sigue siendo la autoridad y cada lectura caduca en DASHBOARD_CACHE_SECONDS.
 */
let cached: { result: LoadResult; expiresAt: number; generation: number } | null = null
let inFlight: Promise<LoadResult> | null = null
let lastForced = 0

const ERROR_CACHE_MS = 10_000
const MIN_FORCED_INTERVAL_MS = 10_000

let jwtClient: { key: string; client: JWT } | null = null

async function accessToken(): Promise<string> {
  const account = serviceAccount()
  if (!jwtClient || jwtClient.key !== account.clientEmail) {
    jwtClient = {
      key: account.clientEmail,
      client: new JWT({ email: account.clientEmail, key: account.privateKey, scopes: [SHEETS_READONLY_SCOPE] }),
    }
  }
  const { token } = await jwtClient.client.getAccessToken()
  if (!token) throw new Error('empty token')
  return token
}

async function load(): Promise<LoadResult> {
  const fetchedAt = Date.now()
  try {
    if (dataSource() === 'fixtures') {
      // En modo de escritura simulada (V1.4) el dashboard muestra el repositorio simulado.
      const raw = mockWriteTabs() ?? buildFixtureTabs(todayInMerida(new Date(fetchedAt)))
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
      // Mensaje propio sin valores de configuración.
      return { ok: false, error: { code: 'config', message: error.message }, at: fetchedAt }
    }
    console.error('[project-os] Error inesperado al leer datos:', error instanceof Error ? error.name : 'desconocido')
    return { ok: false, error: { code: 'unavailable', message: 'No se pudieron leer los datos.' }, at: fetchedAt }
  }
}

/** Devuelve los datos desde caché o leyendo Sheets. Las llamadas concurrentes comparten la lectura. */
export async function getDataset(): Promise<LoadResult> {
  const now = Date.now()
  // V1.4: una escritura simulada (otra generación) invalida la caché.
  if (cached && cached.expiresAt > now && cached.generation === writeGeneration()) return cached.result
  if (inFlight) return inFlight
  const generation = writeGeneration()
  inFlight = load()
    .then((result) => {
      const ttl = result.ok ? safeCacheMs() : ERROR_CACHE_MS
      cached = { result, expiresAt: Date.now() + ttl, generation }
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
