import 'server-only'

import { readFileSync } from 'node:fs'
import type { DataSource } from './types'

/**
 * Configuración del servidor. Nada de este módulo debe llegar al navegador:
 * ninguna variable usa el prefijo NEXT_PUBLIC_ y el módulo importa `server-only`.
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

export function dataSource(env: NodeJS.ProcessEnv = process.env): DataSource {
  const value = (env.DASHBOARD_DATA_SOURCE ?? 'sheets').trim().toLowerCase()
  if (value === 'fixtures' && env.K_SERVICE?.trim()) {
    // Cloud Run define K_SERVICE: allí los datos sintéticos podrían confundirse con datos reales.
    throw new ConfigError('Los datos sintéticos (fixtures) no se permiten en Cloud Run')
  }
  if (value === 'sheets' || value === 'fixtures') return value
  throw new ConfigError('DASHBOARD_DATA_SOURCE debe ser "sheets" o "fixtures"')
}

/** Segundos de caché en memoria del servidor (0–300). Por defecto 60. */
export function cacheSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DASHBOARD_CACHE_SECONDS?.trim()
  if (!raw) return 60
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) throw new ConfigError('DASHBOARD_CACHE_SECONDS debe ser un entero ≥ 0')
  return Math.min(value, 300)
}

const SPREADSHEET_ID = /^[A-Za-z0-9_-]{20,100}$/

export function spreadsheetId(env: NodeJS.ProcessEnv = process.env): string {
  const id = env.SHEETS_SPREADSHEET_ID?.trim()
  if (!id || !SPREADSHEET_ID.test(id)) throw new ConfigError('Falta SHEETS_SPREADSHEET_ID o no es válido')
  return id
}

/**
 * Libro de RADAROS para /eco (ORD-POS-067, docs/diseno-eco-radaros.md §2). Opcional e inerte por defecto: sin
 * RADAROS_SHEET_ID, vacía, con formato no válido o igual a SHEETS_SPREADSHEET_ID no hay libro y /eco no lee nada.
 * Nunca lanza ni devuelve el valor en un mensaje.
 */
export type RadarosConfig = { id: string } | { id: null; motivo: 'ausente' | 'no-valido' }

export function radarosConfig(env: NodeJS.ProcessEnv = process.env): RadarosConfig {
  const id = env.RADAROS_SHEET_ID?.trim()
  if (!id) return { id: null, motivo: 'ausente' }
  // /eco nunca lee la hoja de PROJECT-OS (diseño §2, regla 2).
  if (!SPREADSHEET_ID.test(id) || id === env.SHEETS_SPREADSHEET_ID?.trim()) return { id: null, motivo: 'no-valido' }
  return { id }
}

export function radarosSheetId(env: NodeJS.ProcessEnv = process.env): string | null {
  return radarosConfig(env).id
}

/**
 * Libro FINANZAS para /finanzas (ORD-POS-074, docs/diseno-finanzas.md §3). Opcional e inerte por defecto: sin
 * FINANZAS_SHEET_ID, vacía, con formato no válido o igual a SHEETS_SPREADSHEET_ID o a RADAROS_SHEET_ID no hay libro y
 * /finanzas no lee nada. Nunca lanza ni devuelve el valor en un mensaje.
 */
export type FinanzasConfig = { id: string } | { id: null; motivo: 'ausente' | 'no-valido' }

export function finanzasConfig(env: NodeJS.ProcessEnv = process.env): FinanzasConfig {
  const id = env.FINANZAS_SHEET_ID?.trim()
  if (!id) return { id: null, motivo: 'ausente' }
  // FINANZAS es un libro aparte: nunca la hoja de PROJECT-OS ni la de RADAROS (diseño §3, regla 1).
  const otras = [env.SHEETS_SPREADSHEET_ID?.trim(), env.RADAROS_SHEET_ID?.trim()]
  if (!SPREADSHEET_ID.test(id) || otras.includes(id)) return { id: null, motivo: 'no-valido' }
  return { id }
}

export function finanzasSheetId(env: NodeJS.ProcessEnv = process.env): string | null {
  return finanzasConfig(env).id
}

export interface ServiceAccount {
  clientEmail: string
  privateKey: string
}

/**
 * Credenciales de la cuenta de servicio: JSON completo en
 * PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_JSON, o ruta a un archivo fuera del repositorio en
 * PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_FILE. Los mensajes de error nunca incluyen el contenido.
 */
export function serviceAccount(env: NodeJS.ProcessEnv = process.env): ServiceAccount {
  let json = env.PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_JSON?.trim()
  const file = env.PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_FILE?.trim()
  if (!json && file) {
    try {
      json = readFileSync(file, 'utf8')
    } catch {
      throw new ConfigError('No se pudo leer el archivo de la cuenta de servicio')
    }
  }
  if (!json) throw new ConfigError('Falta configurar la cuenta de servicio de Google (solo servidor)')
  let info: Record<string, unknown>
  try {
    info = JSON.parse(json) as Record<string, unknown>
  } catch {
    throw new ConfigError('La credencial de la cuenta de servicio no es JSON válido')
  }
  if (info.type !== 'service_account' || typeof info.client_email !== 'string' || typeof info.private_key !== 'string') {
    throw new ConfigError('Se esperaba una credencial de tipo service_account')
  }
  return { clientEmail: info.client_email, privateKey: info.private_key }
}
