import 'server-only'

import { cacheSeconds, ConfigError, radarosConfig } from '../config'
import { createTokenProvider, type TokenProvider } from '../credentials'
import { createSheetsReader, SheetsReadError, type SheetsErrorCode } from '../sheets-client'
import { construirEco, ECO_LECTURA, type EcoVista } from './eco'
import { ecoBandejaGeminiHabilitada, leerBandeja, PESTANA_BANDEJA, type BandejaVista } from './pipeline-bandeja-gemini'
import { generacionEco } from './pipeline-generacion'

/**
 * Lector de RADAROS para /eco (docs/diseno-eco-radaros.md §2). Reutiliza el cliente de solo lectura (alcance
 * `spreadsheets.readonly`, solo GET a sheets.googleapis.com) con la cuenta de lectura de siempre, y tiene su propia
 * caché: ninguna otra página lo usa. Inerte por defecto: sin RADAROS_SHEET_ID válida no pide token ni lee nada.
 */

export type EcoResult =
  | { estado: 'no-configurado'; motivo: 'ausente' | 'no-valido' }
  | { estado: 'error'; code: SheetsErrorCode; message: string; reintentar: boolean; at: number }
  | { estado: 'ok'; vista: EcoVista; fetchedAt: number }

export interface EcoLoaderDeps {
  env?: NodeJS.ProcessEnv
  getAccessToken?: () => Promise<string>
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** Generación de escrituras del pipeline (ORD-POS-102): si cambió, la caché se descarta. */
  generacion?: () => number
}

const ERROR_CACHE_MS = 10_000
const TRANSITORIOS: readonly SheetsErrorCode[] = ['quota', 'unavailable', 'timeout']

export function createEcoLoader(deps: EcoLoaderDeps = {}) {
  const env = deps.env ?? process.env
  const now = deps.now ?? Date.now
  const generacion = deps.generacion ?? generacionEco
  let tokenProvider: TokenProvider | null = null
  const getAccessToken = deps.getAccessToken ?? (() => {
    tokenProvider ??= createTokenProvider(env)
    return tokenProvider.getAccessToken()
  })
  let cached: { id: string; result: EcoResult; expiresAt: number; generacion: number } | null = null
  let inFlight: { id: string; promise: Promise<EcoResult>; generacion: number } | null = null

  async function read(id: string): Promise<EcoResult> {
    const fetchedAt = now()
    try {
      const reader = createSheetsReader({ spreadsheetId: id, getAccessToken, fetchImpl: deps.fetchImpl, sleep: deps.sleep })
      // Metadatos + un batchGet solo con las pestañas de §3 y las PIPE_* que existen: como máximo 2 lecturas.
      const raw = await reader.readTabs(ECO_LECTURA)
      return { estado: 'ok', vista: construirEco(raw, fetchedAt, await bandeja(reader)), fetchedAt }
    } catch (error) {
      if (error instanceof SheetsReadError) {
        return { estado: 'error', code: error.code, message: error.message, reintentar: TRANSITORIOS.includes(error.code), at: fetchedAt }
      }
      if (error instanceof ConfigError) {
        console.warn('[project-os] /eco: configuración inválida:', error.message)
        return { estado: 'error', code: 'config', message: error.message, reintentar: false, at: fetchedAt }
      }
      console.error('[project-os] /eco: error inesperado:', error instanceof Error ? error.name : 'desconocido')
      return { estado: 'error', code: 'unavailable', message: 'No se pudieron leer los datos de RADAROS.', reintentar: true, at: fetchedAt }
    }
  }

  /**
   * ORD-POS-155 (§18.2): la bandeja de Gemini solo se lee con ECO_BANDEJA_GEMINI=true, en su propio GET con
   * valueRenderOption=FORMULA para ver las fórmulas (criterio 4). Un fallo de esta lectura no tumba /eco: queda en la
   * bandeja, con su mensaje.
   */
  async function bandeja(reader: ReturnType<typeof createSheetsReader>): Promise<BandejaVista> {
    if (!ecoBandejaGeminiHabilitada(env)) return { estado: 'apagada' }
    try {
      const r = await reader.readTabs([PESTANA_BANDEJA], { valueRenderOption: 'FORMULA' })
      return leerBandeja(r[PESTANA_BANDEJA])
    } catch (error) {
      const mensaje = error instanceof SheetsReadError ? error.message : 'No se pudo leer la bandeja de Gemini.'
      return { estado: 'error', mensaje }
    }
  }

  function ttlMs(result: EcoResult): number {
    if (result.estado !== 'ok') return ERROR_CACHE_MS
    try {
      return cacheSeconds(env) * 1000
    } catch {
      return 60_000
    }
  }

  /** Resuelve la variable ANTES de pedir un token: sin libro válido, cero llamadas. */
  async function load(): Promise<EcoResult> {
    const config = radarosConfig(env)
    if (config.id === null) return { estado: 'no-configurado', motivo: config.motivo }
    const id = config.id
    const gen = generacion()
    if (cached && cached.id === id && cached.expiresAt > now() && cached.generacion === gen) return cached.result
    if (inFlight?.id === id && inFlight.generacion === gen) return inFlight.promise
    const promise = read(id)
      .then((result) => {
        cached = { id, result, expiresAt: now() + ttlMs(result), generacion: gen }
        return result
      })
      .finally(() => {
        if (inFlight?.promise === promise) inFlight = null
      })
    inFlight = { id, promise, generacion: gen }
    return promise
  }

  return { load }
}

let loader: ReturnType<typeof createEcoLoader> | null = null

export function getEco(): Promise<EcoResult> {
  loader ??= createEcoLoader()
  return loader.load()
}
