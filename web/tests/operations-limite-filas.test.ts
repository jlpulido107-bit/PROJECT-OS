import { describe, expect, it } from 'vitest'
import { buildFixtureTabs } from '@/lib/fixtures'
import { WRITE_HEADERS } from '@/lib/operations/constants'
import { OperationError } from '@/lib/operations/errors'
import { FILAS_AVISO } from '@/lib/operations/limite-filas'
import { OperationsService } from '@/lib/operations/service'
import { SheetsTableStore } from '@/lib/operations/sheets-table-store'
import { InMemoryTableStore, type TableStore } from '@/lib/operations/table-store'
import { parseCreateTask } from '@/lib/operations/validation'
import { estadoGuardado } from '@/lib/planificacion-edicion'
import { resultadoDia } from '@/lib/planificacion-plan-dia'
import { MAX_DATA_ROWS } from '@/lib/schema'
import { FakeSheets } from './helpers/fake-sheets'

/**
 * ORD-POS-143: la hoja maestra avisa al 80 % de MAX_DATA_ROWS en la respuesta ok y, en el tope, responde 503 sin
 * escribir nada (ni AUDITORIA), en lugar de dejar AUDITORIA por encima del límite y bloquear todas las lecturas.
 */

const TODAY = '2026-10-08'
const NOW = new Date('2026-10-08T16:30:00Z')
const ACTOR = { actor: 'escritor@example.com' }
let seq = 0
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`

/** AUDITORIA con `filas` filas de datos antiguas (sintéticas, sin ORIGEN del dashboard: no cuentan como operaciones). */
function seed(filas: number): Record<string, unknown[][]> {
  const viejas = Array.from({ length: filas }, (_, i) => [`AUD-ANTIGUA-${i + 1}`, '2026-01-01T00:00:00-06:00', 'sistema', 'TAREAS', 'POS-000', 'NOTA', '', 'x', 'archivo-manual'])
  return { ...(buildFixtureTabs(TODAY) as Record<string, unknown[][]>), AUDITORIA: [[...WRITE_HEADERS.AUDITORIA], ...viejas] }
}

const ADAPTERS: Array<[string, (filas: number) => TableStore]> = [
  ['InMemoryTableStore (mock)', (filas) => new InMemoryTableStore(seed(filas))],
  ['SheetsTableStore (servidor simulado)', (filas) => {
    const fake = new FakeSheets('HOJA_DE_PRUEBA_SINTETICA_0123456789', seed(filas))
    return new SheetsTableStore({ spreadsheetId: fake.spreadsheetId, getWriteToken: async () => 'token-de-escritura-falso', fetchImpl: fake.fetch })
  }],
]

const crearTarea = (service: OperationsService) => service.createTask(parseCreateTask({
  requestId: uuid(), proyectoId: 'POS', titulo: 'Preparar informe semanal', tipo: 'documentacion', prioridad: 'media',
  criterioTerminado: 'Informe revisado por el usuario',
}), ACTOR)

const filas = async (store: TableStore, tab: 'AUDITORIA' | 'TAREAS') => (await store.readTable(tab)).length - 1

describe.each(ADAPTERS)('Límite de filas de la hoja maestra · %s', (_name, make) => {
  it('al 79 % la respuesta ok no lleva aviso', async () => {
    // 79 % de 5000 = 3950; el alta añade una fila de AUDITORIA por campo y queda por debajo de 4000.
    const store = make(Math.floor(MAX_DATA_ROWS * 0.79))
    const result = await crearTarea(new OperationsService(store, { mode: 'mock', clock: () => NOW }))
    expect(await filas(store, 'AUDITORIA')).toBeLessThan(FILAS_AVISO)
    expect(result.repetida).toBe(false)
    expect(result).not.toHaveProperty('aviso')
  })

  it('al 80 % la respuesta ok lleva el aviso con la pestaña y el límite', async () => {
    const store = make(FILAS_AVISO)
    const result = await crearTarea(new OperationsService(store, { mode: 'mock', clock: () => NOW }))
    expect(result.id).toMatch(/^POS-\d{3}$/)
    expect(result.aviso).toContain('AUDITORIA pasa del 80 %')
    expect(result.aviso).toContain(String(MAX_DATA_ROWS))
    expect(result.aviso).not.toContain('TAREAS')
  })

  it('en el tope responde 503 pestana-llena y no escribe nada, ni AUDITORIA', async () => {
    const store = make(MAX_DATA_ROWS)
    const tareasAntes = await filas(store, 'TAREAS')
    const error = await crearTarea(new OperationsService(store, { mode: 'mock', clock: () => NOW })).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OperationError)
    expect((error as OperationError).code).toBe('pestana-llena')
    expect((error as OperationError).status).toBe(503)
    expect((error as OperationError).detail).toEqual({ pestana: 'AUDITORIA', limite: MAX_DATA_ROWS })
    expect(await filas(store, 'AUDITORIA')).toBe(MAX_DATA_ROWS)
    expect(await filas(store, 'TAREAS')).toBe(tareasAntes)
  })

  it('a pocas filas del tope, si la auditoría lo pasaría, tampoco escribe', async () => {
    const store = make(MAX_DATA_ROWS - 1)
    const error = await crearTarea(new OperationsService(store, { mode: 'mock', clock: () => NOW })).catch((e: unknown) => e)
    expect((error as OperationError).code).toBe('pestana-llena')
    expect(await filas(store, 'AUDITORIA')).toBe(MAX_DATA_ROWS - 1)
  })
})

describe('El aviso llega a lo que muestra el dashboard', () => {
  const aviso = 'AUDITORIA pasa del 80 % del límite de 5000 filas: archívala a mano (docs/escritura-v1-8.md §12) antes de que se bloquee la escritura.'

  it('EstadoGuardado (edición en línea, capacidad, escenarios) recibe el aviso de la respuesta ok', () => {
    expect(estadoGuardado({ status: 'done', result: { version: 3, repetida: false, aviso } })).toEqual({ tipo: 'guardado', version: 3, repetida: false, aviso })
    expect(estadoGuardado({ status: 'done', result: { version: 3, repetida: false } })).not.toHaveProperty('aviso')
  })

  it('«Aplicar movimientos al plan» conserva el aviso de cada día', () => {
    expect(resultadoDia('2026-10-09', { ok: true, id: 'PLAN-2026-10-09', version: 1, repetida: false, aviso })).toMatchObject({ tipo: 'guardado', aviso })
  })
})
