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
