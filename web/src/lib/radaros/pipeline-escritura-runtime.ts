import 'server-only'

import { radarosSheetId } from '../config'
import { RateLimiter } from '../operations/rate-limit'
import { createWriteTokenProvider } from '../operations/write-credentials'
import { ecoPipelineWriteMode, ecoPipelineWriteServiceAccount } from './pipeline-escritura-config'
import { EcoPipelineWriteService } from './pipeline-escritura-service'
import { EcoSheetsStore } from './pipeline-escritura-store'

/**
 * Estado del servicio de escritura del pipeline en este proceso (ORD-POS-102). Único módulo que construye
 * `EcoSheetsStore`: siempre con RADAROS_SHEET_ID y el token de ECO_PIPELINE_WRITE_SERVICE_ACCOUNT (suplantación,
 * alcance `spreadsheets`, 10 min, web/src/lib/operations/write-credentials.ts). Nunca usa la hoja de PROJECT-OS ni las
 * cuentas de las otras vías de escritura. El proveedor de token se crea al construir el servicio, y el servicio solo se
 * pide tras pasar el guard: sin modo activo, cero llamadas a IAM o a Sheets.
 */
interface ProcessState {
  service: { key: string; service: EcoPipelineWriteService } | null
  limiter: RateLimiter
}
const KEY = Symbol.for('project-os.eco.pipeline.escritura.v1')

function processState(): ProcessState {
  const g = globalThis as unknown as Record<symbol, ProcessState | undefined>
  // Ráfaga de 10 y 1 operación cada 3 s (§4.2): el arrastre genera más operaciones que un formulario.
  g[KEY] ??= { service: null, limiter: new RateLimiter(10, 3_000) }
  return g[KEY]
}

/** Servicio de escritura del pipeline, o null si la escritura está deshabilitada. */
export function ecoPipelineWriteService(env: NodeJS.ProcessEnv = process.env): EcoPipelineWriteService | null {
  if (ecoPipelineWriteMode(env) !== 'sheets') return null
  const libro = radarosSheetId(env)
  const account = ecoPipelineWriteServiceAccount(env)
  if (!libro || !account) return null
  const state = processState()
  const key = `${libro} ${account}`
  if (state.service?.key !== key) {
    const store = new EcoSheetsStore({ spreadsheetId: libro, getWriteToken: createWriteTokenProvider(account) })
    state.service = { key, service: new EcoPipelineWriteService(store) }
  }
  return state.service.service
}

export function ecoPipelineRateLimiter(): RateLimiter {
  return processState().limiter
}
