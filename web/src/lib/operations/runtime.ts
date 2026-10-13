import 'server-only'

import { spreadsheetId } from '../config'
import { todayInMerida } from '../dates'
import { buildFixtureTabs } from '../fixtures'
import type { RawTabs } from '../types'
import { WRITE_HEADERS } from './constants'
import { writeModeStatus, writeServiceAccount } from './config'
import { RateLimiter } from './rate-limit'
import { OperationsService } from './service'
import { SheetsTableStore } from './sheets-table-store'
import { InMemoryTableStore, type TableStore } from './table-store'
import { createWriteTokenProvider } from './write-credentials'

/**
 * Estado del motor de operaciones en este proceso:
 * - `mock`: repositorio en memoria con datos sintéticos (V1.4).
 * - `sheets` (V1.8): adaptador de escritura real, con token de la cuenta de escritura dedicada (suplantación).
 *   Este es el ÚNICO módulo que importa sheets-table-store.ts (verificado por tests/security.test.ts).
 */
interface Runtime {
  store: TableStore
  service: OperationsService
}

/**
 * Estado POR PROCESO guardado en globalThis: Next empaqueta por separado rutas API y páginas, de modo que el estado
 * de módulo no se comparte entre ellas. `generation` invalida la caché del dashboard tras cada escritura.
 */
interface ProcessState {
  runtime: Runtime | null
  sheetsRuntime: Runtime | null
  limiter: RateLimiter
  generation: number
}
const KEY = Symbol.for('project-os.operations.v1-4')

function processState(): ProcessState {
  const g = globalThis as unknown as Record<symbol, ProcessState | undefined>
  g[KEY] ??= { runtime: null, sheetsRuntime: null, limiter: new RateLimiter(), generation: 0 }
  return g[KEY]
}

function mockRuntime(): Runtime & { store: InMemoryTableStore } {
  const state = processState()
  state.runtime ??= createMockRuntime()
  return state.runtime as Runtime & { store: InMemoryTableStore }
}

function sheetsRuntime(): Runtime {
  const state = processState()
  if (!state.sheetsRuntime) {
    const account = writeServiceAccount()
    if (!account) throw new Error('sin cuenta de escritura')
    const store = new SheetsTableStore({ spreadsheetId: spreadsheetId(), getWriteToken: createWriteTokenProvider(account) })
    state.sheetsRuntime = { store, service: new OperationsService(store, { mode: 'sheets' }) }
  }
  return state.sheetsRuntime
}

function createMockRuntime(): Runtime {
  const tabs = buildFixtureTabs(todayInMerida()) as Record<string, unknown[][]>
  // AUDITORIA no forma parte de los fixtures de lectura: se crea con su encabezado real.
  const store = new InMemoryTableStore({ ...tabs, AUDITORIA: [[...WRITE_HEADERS.AUDITORIA]] })
  return { store, service: new OperationsService(store, { mode: 'mock' }) }
}

/** Servicio de operaciones, o null si la escritura está deshabilitada. */
export function operationsService(): OperationsService | null {
  const mode = writeModeStatus().mode
  if (mode === 'mock') return mockRuntime().service
  if (mode === 'sheets') return sheetsRuntime().service
  return null
}

/** Filas de AUDITORIA del almacén de escritura activo (contienen correos de actores: solo para escritores). */
export async function auditTable(): Promise<string[][] | null> {
  const mode = writeModeStatus().mode
  if (mode === 'mock') return mockRuntime().store.snapshot().AUDITORIA ?? null
  if (mode === 'sheets') return sheetsRuntime().store.readTable('AUDITORIA')
  return null
}

/**
 * Pestañas del repositorio simulado para que el dashboard muestre las operaciones (solo en modo mock;
 * en cualquier otro modo devuelve null y el dashboard lee su fuente habitual).
 */
export function mockWriteTabs(): RawTabs | null {
  if (writeModeStatus().mode !== 'mock') return null
  return mockRuntime().store.snapshot() as RawTabs
}

export function writeRateLimiter(): RateLimiter {
  return processState().limiter
}

/** Generación de escrituras del proceso: el dashboard descarta su caché si cambió. */
export function writeGeneration(): number {
  return processState().generation
}

/** Tras una escritura correcta: la próxima lectura del dashboard refleja el cambio. */
export function bumpWriteGeneration(): void {
  processState().generation += 1
}
