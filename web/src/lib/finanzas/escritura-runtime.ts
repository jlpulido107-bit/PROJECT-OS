import 'server-only'

import { finanzasSheetId } from '../config'
import { createWriteTokenProvider } from '../operations/write-credentials'
import { RateLimiter } from '../operations/rate-limit'
import { finanzasWriteMode, finanzasWriteServiceAccount } from './escritura-config'
import { FinanzasWriteService } from './escritura-service'
import { FinanzasSheetsStore } from './escritura-store'

/**
 * Estado del servicio de escritura de finanzas en este proceso (ORD-POS-077). Único módulo que construye
 * `FinanzasSheetsStore`: siempre con FINANZAS_SHEET_ID y el token de FINANZAS_WRITE_SERVICE_ACCOUNT (suplantación,
 * alcance `spreadsheets`, 10 min). Nunca usa la hoja ni la cuenta de escritura de PROJECT-OS. El proveedor de
 * token se crea al construir el servicio, y el servicio solo se pide tras pasar el guard: sin modo activo, cero
 * llamadas a IAM o a Sheets.
 */
interface ProcessState {
  service: { key: string; service: FinanzasWriteService } | null
  limiter: RateLimiter
}
const KEY = Symbol.for('project-os.finanzas.escritura.v2')

function processState(): ProcessState {
  const g = globalThis as unknown as Record<symbol, ProcessState | undefined>
  // Ráfaga de 5 y 1 alta cada 10 s (§2.2).
  g[KEY] ??= { service: null, limiter: new RateLimiter(5, 10_000) }
  return g[KEY]
}

/** Servicio de escritura de finanzas, o null si la escritura está deshabilitada. */
export function finanzasWriteService(env: NodeJS.ProcessEnv = process.env): FinanzasWriteService | null {
  if (finanzasWriteMode(env) !== 'sheets') return null
  const libro = finanzasSheetId(env)
  const account = finanzasWriteServiceAccount(env)
  if (!libro || !account) return null
  const state = processState()
  const key = `${libro} ${account}`
  if (state.service?.key !== key) {
    const store = new FinanzasSheetsStore({ spreadsheetId: libro, getWriteToken: createWriteTokenProvider(account) })
    state.service = { key, service: new FinanzasWriteService(store) }
  }
  return state.service.service
}

export function finanzasRateLimiter(): RateLimiter {
  return processState().limiter
}
