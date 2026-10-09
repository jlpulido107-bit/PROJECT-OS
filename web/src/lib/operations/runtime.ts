import 'server-only'

import { todayInMerida } from '../dates'
import { buildFixtureTabs } from '../fixtures'
import type { RawTabs } from '../types'
import { WRITE_HEADERS } from './constants'
import { writeModeStatus } from './config'
import { RateLimiter } from './rate-limit'
import { OperationsService } from './service'
import { InMemoryTableStore } from './table-store'

/**
 * Estado del motor de operaciones en este proceso. En V1.4 solo existe el repositorio SIMULADO:
 * el adaptador de Sheets (sheets-table-store.ts) no se importa aquí, de modo que ningún camino de la app
 * puede escribir en Google Sheets (verificado por tests/security.test.ts).
 */
interface Runtime {
  store: InMemoryTableStore
  service: OperationsService
}

/**
 * Estado POR PROCESO guardado en globalThis: Next empaqueta por separado rutas API y páginas, de modo que el estado
 * de módulo no se comparte entre ellas. `generation` invalida la caché del dashboard tras cada escritura.
 */
interface ProcessState {
  runtime: Runtime | null
  limiter: RateLimiter
  generation: number
}
const KEY = Symbol.for('project-os.operations.v1-4')

function processState(): ProcessState {
  const g = globalThis as unknown as Record<symbol, ProcessState | undefined>
  g[KEY] ??= { runtime: null, limiter: new RateLimiter(), generation: 0 }
  return g[KEY]
}

function mockRuntime(): Runtime {
  const state = processState()
  state.runtime ??= createMockRuntime()
  return state.runtime
}

function createMockRuntime(): Runtime {
  const tabs = buildFixtureTabs(todayInMerida()) as Record<string, unknown[][]>
  // AUDITORIA no forma parte de los fixtures de lectura: se crea con su encabezado real.
  const store = new InMemoryTableStore({ ...tabs, AUDITORIA: [[...WRITE_HEADERS.AUDITORIA]] })
  return { store, service: new OperationsService(store, { mode: 'mock' }) }
}

/** Servicio de operaciones, o null si la escritura está deshabilitada. */
export function operationsService(): OperationsService | null {
  if (writeModeStatus().mode !== 'mock') return null
  return mockRuntime().service
}

/**
 * Pestañas del repositorio simulado para que el dashboard muestre las operaciones (solo en modo mock;
 * en cualquier otro modo devuelve null y el dashboard lee su fuente habitual).
 */
export function mockWriteTabs(): RawTabs | null {
  if (writeModeStatus().mode !== 'mock') return null
  return mockRuntime().store.snapshot() as RawTabs
}

/** Filas de AUDITORIA del repositorio simulado (solo modo mock; contienen correos de actores: solo para escritores). */
export function mockAuditTable(): string[][] | null {
  if (writeModeStatus().mode !== 'mock') return null
  return mockRuntime().store.snapshot().AUDITORIA ?? null
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
