import 'server-only'

import { finanzasSheetId } from '../config'
import { createWriteTokenProvider } from '../operations/write-credentials'
import { RateLimiter } from '../operations/rate-limit'
import { finanzasAgenteMode, finanzasAgenteServiceAccount } from './agente-config'
import { FinanzasAgenteService } from './agente-service'
import { FinanzasSheetsStore } from './escritura-store'

/**
 * Estado del servicio del agente de finanzas en este proceso (ORD-POS-092). Único módulo que construye su almacén:
 * siempre con FINANZAS_SHEET_ID y el token de FINANZAS_AGENTE_SERVICE_ACCOUNT (suplantación, alcance `spreadsheets`,
 * 10 min), nunca con la cuenta del propietario ni con la de PROJECT-OS. El servicio solo se pide tras pasar el guard.
 */
interface ProcessState {
  service: { key: string; service: FinanzasAgenteService } | null
  limiter: RateLimiter
}
const KEY = Symbol.for('project-os.finanzas.agente.v3')

function processState(): ProcessState {
  const g = globalThis as unknown as Record<symbol, ProcessState | undefined>
  // Ráfaga de 3 y 1 alta por minuto (§2.3): dos cortes al mes no necesitan más.
  g[KEY] ??= { service: null, limiter: new RateLimiter(3, 60_000) }
  return g[KEY]
}

/** Servicio del agente de finanzas, o null si su escritura está deshabilitada. */
export function finanzasAgenteService(env: NodeJS.ProcessEnv = process.env): FinanzasAgenteService | null {
  if (finanzasAgenteMode(env) !== 'sheets') return null
  const libro = finanzasSheetId(env)
  const account = finanzasAgenteServiceAccount(env)
  if (!libro || !account) return null
  const state = processState()
  const key = `${libro} ${account}`
  if (state.service?.key !== key) {
    const store = new FinanzasSheetsStore({ spreadsheetId: libro, getWriteToken: createWriteTokenProvider(account) })
    state.service = { key, service: new FinanzasAgenteService(store) }
  }
  return state.service.service
}

export function finanzasAgenteRateLimiter(): RateLimiter {
  return processState().limiter
}
