import 'server-only'

import { cacheSeconds, ConfigError, finanzasConfig } from '../config'
import { createTokenProvider, type TokenProvider } from '../credentials'
import { createSheetsReader, SheetsReadError, type SheetsErrorCode } from '../sheets-client'
import { construirFinanzas, FINANZAS_TABS, type FinanzasVista } from './finanzas'
import { generacionFinanzas } from './generacion'

/**
 * Lector de FINANZAS para /finanzas (docs/diseno-finanzas.md §3, ORD-POS-074). Reutiliza el cliente de solo lectura
 * (alcance `spreadsheets.readonly`, solo GET a sheets.googleapis.com) con la cuenta de lectura de siempre, y tiene su
 * propia caché: ninguna otra página lo usa. Inerte por defecto: sin FINANZAS_SHEET_ID válida no pide token ni lee nada.
 */

export type FinanzasResult =
  | { estado: 'no-configurado'; motivo: 'ausente' | 'no-valido' }
  | { estado: 'error'; code: SheetsErrorCode; message: string; reintentar: boolean; at: number }
  | { estado: 'ok'; vista: FinanzasVista; fetchedAt: number }

export interface FinanzasLoaderDeps {
  env?: NodeJS.ProcessEnv
  getAccessToken?: () => Promise<string>
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const ERROR_CACHE_MS = 10_000
const TRANSITORIOS: readonly SheetsErrorCode[] = ['quota', 'unavailable', 'timeout']

export function createFinanzasLoader(deps: FinanzasLoaderDeps = {}) {
  const env = deps.env ?? process.env
  const now = deps.now ?? Date.now
  let tokenProvider: TokenProvider | null = null
  const getAccessToken = deps.getAccessToken ?? (() => {
    tokenProvider ??= createTokenProvider(env)
    return tokenProvider.getAccessToken()
  })
  let cached: { id: string; result: FinanzasResult; expiresAt: number; generacion: number } | null = null
  let inFlight: { id: string; promise: Promise<FinanzasResult> } | null = null

  async function read(id: string): Promise<FinanzasResult> {
    const fetchedAt = now()
    try {
      const reader = createSheetsReader({ spreadsheetId: id, getAccessToken, fetchImpl: deps.fetchImpl, sleep: deps.sleep })
      // Metadatos + un batchGet solo con MOVIMIENTOS, PARAMETROS y RECURRENTES (v2 §4.2) si existen: como máximo 2
      // lecturas. Montos sin formato (números), fechas como texto (§3, regla 3).
      const raw = await reader.readTabs(FINANZAS_TABS, { valueRenderOption: 'UNFORMATTED_VALUE' })
      return { estado: 'ok', vista: construirFinanzas(raw, fetchedAt), fetchedAt }
    } catch (error) {
      if (error instanceof SheetsReadError) {
        return { estado: 'error', code: error.code, message: error.message, reintentar: TRANSITORIOS.includes(error.code), at: fetchedAt }
      }
      if (error instanceof ConfigError) {
        console.warn('[project-os] /finanzas: configuración inválida:', error.message)
        return { estado: 'error', code: 'config', message: error.message, reintentar: false, at: fetchedAt }
      }
      console.error('[project-os] /finanzas: error inesperado:', error instanceof Error ? error.name : 'desconocido')
      return { estado: 'error', code: 'unavailable', message: 'No se pudieron leer los datos de FINANZAS.', reintentar: true, at: fetchedAt }
    }
  }

  function ttlMs(result: FinanzasResult): number {
    if (result.estado !== 'ok') return ERROR_CACHE_MS
    try {
      return cacheSeconds(env) * 1000
    } catch {
      return 60_000
    }
  }

  /** Resuelve la variable ANTES de pedir un token: sin libro válido, cero llamadas. */
  async function load(): Promise<FinanzasResult> {
    const config = finanzasConfig(env)
    if (config.id === null) return { estado: 'no-configurado', motivo: config.motivo }
    const id = config.id
    // Tras un alta de finanzas en este proceso (ORD-POS-077) la caché se descarta.
    if (cached && cached.id === id && cached.expiresAt > now() && cached.generacion === generacionFinanzas()) return cached.result
    if (inFlight?.id === id) return inFlight.promise
    const generacion = generacionFinanzas()
    const promise = read(id)
      .then((result) => {
        cached = { id, result, expiresAt: now() + ttlMs(result), generacion }
        return result
      })
      .finally(() => {
        if (inFlight?.promise === promise) inFlight = null
      })
    inFlight = { id, promise }
    return promise
  }

  return { load }
}

let loader: ReturnType<typeof createFinanzasLoader> | null = null

export function getFinanzas(): Promise<FinanzasResult> {
  loader ??= createFinanzasLoader()
  return loader.load()
}
