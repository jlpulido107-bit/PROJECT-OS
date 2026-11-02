import 'server-only'

import { radarosSheetId } from '../config'
import { createWriteTokenProvider } from '../operations/write-credentials'
import { ecoIdeasAltaHabilitada, type IdeasAltaStore } from './ideas-alta'
import { IdeasSheetsStore } from './ideas-alta-store'
import { ecoPipelineWriteServiceAccount } from './pipeline-escritura-config'

/**
 * Único módulo que construye `IdeasSheetsStore` (ORD-POS-131): siempre con RADAROS_SHEET_ID y el token de la cuenta de
 * escritura del pipeline de /eco (ECO_PIPELINE_WRITE_SERVICE_ACCOUNT, suplantación con alcance `spreadsheets`, 10 min).
 * Nunca usa la hoja ni la cuenta de PROJECT-OS. Sin ECO_IDEAS_ALTA=true o sin la escritura del pipeline activa,
 * devuelve null: cero llamadas a IAM o a Sheets.
 */
interface ProcessState {
  store: { key: string; store: IdeasAltaStore } | null
}
const KEY = Symbol.for('project-os.eco.ideas-alta.v1')

function processState(): ProcessState {
  const g = globalThis as unknown as Record<symbol, ProcessState | undefined>
  g[KEY] ??= { store: null }
  return g[KEY]
}

export function ideasAltaStore(env: NodeJS.ProcessEnv = process.env): IdeasAltaStore | null {
  if (!ecoIdeasAltaHabilitada(env)) return null
  const libro = radarosSheetId(env)
  const account = ecoPipelineWriteServiceAccount(env)
  if (!libro || !account) return null
  const state = processState()
  const key = `${libro} ${account}`
  if (state.store?.key !== key) {
    state.store = { key, store: new IdeasSheetsStore({ spreadsheetId: libro, getWriteToken: createWriteTokenProvider(account) }) }
  }
  return state.store.store
}
