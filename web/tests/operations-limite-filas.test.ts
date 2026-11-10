import { describe, expect, it, vi } from 'vitest'
import { buildFixtureTabs } from '@/lib/fixtures'
import { ordenarPestanasAuditoria, siguientePestanaAuditoria, type PestanasAuditoria } from '@/lib/operations/auditoria-periodo'
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
 * escribir nada (ni AUDITORIA), en lugar de dejar una pestaña por encima del límite y bloquear todas las lecturas.
 * ORD-POS-153: AUDITORIA ya no se bloquea: en el tope sigue en una pestaña nueva AUDITORIA_AAAA_MM.
 */

const TODAY = '2026-10-08'
const NOW = new Date('2026-10-08T16:30:00Z')
const ACTOR = { actor: 'escritor@example.com' }
let seq = 0
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`

/** `filas` filas de auditoría antiguas (sintéticas, sin ORIGEN del dashboard: no cuentan como operaciones). */
const viejas = (filas: number, prefijo = 'AUD-ANTIGUA') =>
  Array.from({ length: filas }, (_, i) => [`${prefijo}-${i + 1}`, '2026-01-01T00:00:00-06:00', 'sistema', 'TAREAS', 'POS-000', 'NOTA', '', 'x', 'archivo-manual'])

/** AUDITORIA con `filas` filas antiguas; `extra` agrega o reemplaza pestañas (p. ej. una AUDITORIA_AAAA_MM o TAREAS llena). */
function seed(filas: number, extra: Record<string, unknown[][]> = {}): Record<string, unknown[][]> {
  return { ...(buildFixtureTabs(TODAY) as Record<string, unknown[][]>), AUDITORIA: [[...WRITE_HEADERS.AUDITORIA], ...viejas(filas)], ...extra }
}

type Store = TableStore & PestanasAuditoria
const ADAPTERS: Array<[string, (filas: number, extra?: Record<string, unknown[][]>) => Store]> = [
  ['InMemoryTableStore (mock)', (filas, extra) => new InMemoryTableStore(seed(filas, extra))],
  ['SheetsTableStore (servidor simulado)', (filas, extra) => {
    const fake = new FakeSheets('HOJA_DE_PRUEBA_SINTETICA_0123456789', seed(filas, extra))
    return new SheetsTableStore({ spreadsheetId: fake.spreadsheetId, getWriteToken: async () => 'token-de-escritura-falso', fetchImpl: fake.fetch })
  }],
]

const crearTarea = (service: OperationsService, requestId = uuid()) => service.createTask(parseCreateTask({
  requestId, proyectoId: 'POS', titulo: 'Preparar informe semanal', tipo: 'documentacion', prioridad: 'media',
  criterioTerminado: 'Informe revisado por el usuario',
}), ACTOR)

const filas = async (store: TableStore, tab: 'AUDITORIA' | 'TAREAS') => (await store.readTable(tab)).length - 1
/** Filas de datos de una pestaña FÍSICA de auditoría (sin pasar por la AUDITORIA lógica). */
const fisica = async (store: Store, nombre: string) => (await store.leerPestanaAuditoria(nombre)).length - 1
const servicio = (store: Store, now = NOW) => new OperationsService(store, { mode: 'mock', clock: () => now })
/** Filas de AUDITORIA que deja un alta de tarea (una por campo). */
const FILAS_ALTA = 9

describe.each(ADAPTERS)('Límite de filas de la hoja maestra · %s', (_name, make) => {
  it('el alta de tarea deja FILAS_ALTA filas de AUDITORIA (base de las demás pruebas)', async () => {
    const store = make(0)
    await crearTarea(servicio(store))
    expect(await filas(store, 'AUDITORIA')).toBe(FILAS_ALTA)
  })

  it('al 79 % la respuesta ok no lleva aviso', async () => {
    // 79 % de 5000 = 3950; el alta añade una fila de AUDITORIA por campo y queda por debajo de 4000.
    const store = make(Math.floor(MAX_DATA_ROWS * 0.79))
    const result = await crearTarea(servicio(store))
    expect(await filas(store, 'AUDITORIA')).toBeLessThan(FILAS_AVISO)
    expect(result.repetida).toBe(false)
    expect(result).not.toHaveProperty('aviso')
  })

  it('al 80 % AUDITORIA dice en qué pestaña escribe y no pide archivar', async () => {
    const store = make(FILAS_AVISO)
    const result = await crearTarea(servicio(store))
    expect(result.id).toMatch(/^POS-\d{3}$/)
    expect(result.aviso).toContain('AUDITORIA escribe en AUDITORIA')
    expect(result.aviso).toContain(String(MAX_DATA_ROWS))
    expect(result.aviso).not.toContain('archívala')
    expect(result.aviso).not.toContain('TAREAS')
  })

  it('criterio 1: en el tope crea AUDITORIA_AAAA_MM con el encabezado idéntico, escribe ahí y no toca la anterior', async () => {
    const store = make(MAX_DATA_ROWS)
    const antes = await store.leerPestanaAuditoria('AUDITORIA')
    const tareasAntes = await filas(store, 'TAREAS')
    const result = await crearTarea(servicio(store))
    expect(result.repetida).toBe(false)
    expect(result.aviso).toContain('pestaña nueva AUDITORIA_2026_10')
    expect(await store.pestanasAuditoria()).toContain('AUDITORIA_2026_10')
    const nueva = await store.leerPestanaAuditoria('AUDITORIA_2026_10')
    expect(nueva[0]).toEqual([...WRITE_HEADERS.AUDITORIA])
    expect(nueva).toHaveLength(1 + FILAS_ALTA)
    expect(nueva.slice(1).every((r) => r[4] === result.id)).toBe(true)
    expect(await store.leerPestanaAuditoria('AUDITORIA')).toEqual(antes)
    expect(await filas(store, 'TAREAS')).toBe(tareasAntes + 1)
    // La AUDITORIA lógica (la que leen Inicio, /metricas y /agentes) es la vigente y la anterior.
    expect((await servicio(store).leerAuditoria()).length - 1).toBe(MAX_DATA_ROWS + FILAS_ALTA)
  })

  it('criterio 1: a pocas filas del tope el lote completo va a la pestaña nueva, sin partirse', async () => {
    const store = make(MAX_DATA_ROWS - 1)
    await crearTarea(servicio(store))
    expect(await fisica(store, 'AUDITORIA')).toBe(MAX_DATA_ROWS - 1)
    expect(await fisica(store, 'AUDITORIA_2026_10')).toBe(FILAS_ALTA)
  })

  it('criterio 3: un requestId repetido en la frontera no duplica, ni el de la anterior ni el de la nueva', async () => {
    // La primera alta llena AUDITORIA justo hasta el tope; la segunda rota.
    const store = make(MAX_DATA_ROWS - FILAS_ALTA)
    const service = servicio(store)
    const [reqA, reqB] = [uuid(), uuid()]
    const a = await crearTarea(service, reqA)
    expect(await fisica(store, 'AUDITORIA')).toBe(MAX_DATA_ROWS)
    const b = await crearTarea(service, reqB)
    expect(await fisica(store, 'AUDITORIA_2026_10')).toBe(FILAS_ALTA)
    const tareas = await filas(store, 'TAREAS')
    const repA = await crearTarea(service, reqA)
    const repB = await crearTarea(service, reqB)
    expect(repA).toMatchObject({ id: a.id, repetida: true })
    expect(repB).toMatchObject({ id: b.id, repetida: true })
    expect(await filas(store, 'TAREAS')).toBe(tareas)
    expect(await fisica(store, 'AUDITORIA')).toBe(MAX_DATA_ROWS)
    expect(await fisica(store, 'AUDITORIA_2026_10')).toBe(FILAS_ALTA)
    // La conciliación lee las dos pestañas y no ve nada pendiente.
    expect((await service.reconcile()).pendientes).toEqual([])
  })

  it('criterio 2: si falla la creación de la pestaña nueva, 503 pestana-llena y no escribe nada', async () => {
    const store = make(MAX_DATA_ROWS)
    vi.spyOn(store, 'crearPestanaAuditoria').mockRejectedValueOnce(new Error('HTTP 500'))
    const tareasAntes = await filas(store, 'TAREAS')
    const error = await crearTarea(servicio(store)).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OperationError)
    expect((error as OperationError).code).toBe('pestana-llena')
    expect((error as OperationError).status).toBe(503)
    expect((error as OperationError).detail).toMatchObject({ pestana: 'AUDITORIA', limite: MAX_DATA_ROWS, rotacion: 'fallida' })
    expect(await fisica(store, 'AUDITORIA')).toBe(MAX_DATA_ROWS)
    expect(await filas(store, 'TAREAS')).toBe(tareasAntes)
    const nuevas = (await store.pestanasAuditoria()).filter((n) => n !== 'AUDITORIA')
    for (const n of nuevas) expect(await fisica(store, n)).toBe(0)
  })

  it('criterio 2: si no se puede leer la pestaña nueva, tampoco escribe nada', async () => {
    const store = make(MAX_DATA_ROWS)
    const leer = store.leerPestanaAuditoria.bind(store)
    vi.spyOn(store, 'leerPestanaAuditoria').mockImplementation(async (n) => {
      if (n !== 'AUDITORIA') throw new OperationError('lectura-fallida')
      return leer(n)
    })
    const tareasAntes = await filas(store, 'TAREAS')
    const error = await crearTarea(servicio(store)).catch((e: unknown) => e)
    expect((error as OperationError).code).toBe('pestana-llena')
    expect((error as OperationError).status).toBe(503)
    expect(await filas(store, 'TAREAS')).toBe(tareasAntes)
    vi.restoreAllMocks()
    // Puede quedar creada pero sin filas de datos; no bloquea: la siguiente rotación la reusa y escribe ahí.
    expect(await fisica(store, 'AUDITORIA_2026_10')).toBeLessThanOrEqual(0)
    await crearTarea(servicio(store))
    expect(await fisica(store, 'AUDITORIA_2026_10')).toBe(FILAS_ALTA)
    expect(await store.leerPestanaAuditoria('AUDITORIA_2026_10').then((v) => v[0])).toEqual([...WRITE_HEADERS.AUDITORIA])
    expect(await filas(store, 'TAREAS')).toBe(tareasAntes + 1)
  })

  it('criterio 2: si no se puede saber qué pestañas hay, 503 lectura-fallida sin escribir', async () => {
    const store = make(10)
    vi.spyOn(store, 'pestanasAuditoria').mockRejectedValueOnce(new Error('HTTP 500'))
    const tareasAntes = await filas(store, 'TAREAS')
    const error = await crearTarea(servicio(store)).catch((e: unknown) => e)
    expect((error as OperationError).code).toBe('lectura-fallida')
    expect((error as OperationError).status).toBe(503)
    expect(await filas(store, 'TAREAS')).toBe(tareasAntes)
    expect(await fisica(store, 'AUDITORIA')).toBe(10)
  })

  it('criterio 6: dos rotaciones seguidas (el mismo mes y el siguiente); solo se leen la vigente y la anterior', async () => {
    // AUDITORIA y AUDITORIA_2026_10 llenas: en octubre la siguiente es AUDITORIA_2026_10_2.
    const store = make(MAX_DATA_ROWS, { AUDITORIA_2026_10: [[...WRITE_HEADERS.AUDITORIA], ...viejas(MAX_DATA_ROWS, 'AUD-OCT')] })
    await crearTarea(servicio(store))
    expect(await fisica(store, 'AUDITORIA_2026_10_2')).toBe(FILAS_ALTA)
    const logica = await servicio(store).leerAuditoria()
    expect(logica.length - 1).toBe(MAX_DATA_ROWS + FILAS_ALTA)
    expect(logica.some((r) => r[0]?.startsWith('AUD-ANTIGUA'))).toBe(false)
    // Se llena la _2 y en noviembre rota a AUDITORIA_2026_11.
    await store.agregarAPestanaAuditoria('AUDITORIA_2026_10_2', viejas(MAX_DATA_ROWS - FILAS_ALTA, 'AUD-OCT2'))
    const nov = new Date('2026-11-03T16:30:00Z')
    const result = await crearTarea(servicio(store, nov))
    expect(result.aviso).toContain('AUDITORIA_2026_11')
    expect(await fisica(store, 'AUDITORIA_2026_11')).toBe(FILAS_ALTA)
    for (const n of ['AUDITORIA', 'AUDITORIA_2026_10', 'AUDITORIA_2026_10_2']) expect(await fisica(store, n)).toBe(MAX_DATA_ROWS)
    expect(ordenarPestanasAuditoria(await store.pestanasAuditoria())).toEqual(['AUDITORIA', 'AUDITORIA_2026_10', 'AUDITORIA_2026_10_2', 'AUDITORIA_2026_11'])
    const logica2 = await servicio(store).leerAuditoria()
    expect(logica2.length - 1).toBe(MAX_DATA_ROWS + FILAS_ALTA)
    expect(logica2.some((r) => r[0]?.startsWith('AUD-OCT-'))).toBe(false)
  })

  it('criterio 1 y 6: las demás pestañas conservan su tope (TAREAS llena → 503 sin escribir, ni AUDITORIA)', async () => {
    const base = buildFixtureTabs(TODAY) as Record<string, unknown[][]>
    const tareas = base.TAREAS!
    const relleno = Array.from({ length: MAX_DATA_ROWS - (tareas.length - 1) }, (_, i) => tareas[1]!.map((c, j) => (j === 0 ? `POS-R${i}` : c)))
    const store = make(10, { TAREAS: [...tareas, ...relleno] })
    expect(await filas(store, 'TAREAS')).toBe(MAX_DATA_ROWS)
    const error = await crearTarea(servicio(store)).catch((e: unknown) => e)
    expect((error as OperationError).code).toBe('pestana-llena')
    expect((error as OperationError).detail).toEqual({ pestana: 'TAREAS', limite: MAX_DATA_ROWS })
    expect(await fisica(store, 'AUDITORIA')).toBe(10)
    expect(await store.pestanasAuditoria()).toEqual(['AUDITORIA'])
  })

  it('la migración es idempotente y nunca sobrescribe una pestaña con otro encabezado', async () => {
    const store = make(3)
    const enc = [...WRITE_HEADERS.AUDITORIA]
    await store.crearPestanaAuditoria('AUDITORIA_2026_12', enc)
    await store.crearPestanaAuditoria('AUDITORIA_2026_12', enc)
    expect(await store.leerPestanaAuditoria('AUDITORIA_2026_12')).toEqual([enc])
    await store.agregarAPestanaAuditoria('AUDITORIA_2026_12', viejas(2))
    await store.crearPestanaAuditoria('AUDITORIA_2026_12', enc)
    expect(await fisica(store, 'AUDITORIA_2026_12')).toBe(2)
    await expect(store.crearPestanaAuditoria('AUDITORIA_2026_12', [...enc, 'OTRA'])).rejects.toBeInstanceOf(OperationError)
    await expect(store.crearPestanaAuditoria('TAREAS', enc)).rejects.toBeInstanceOf(OperationError)
    expect(await fisica(store, 'AUDITORIA')).toBe(3)
  })

  it('la vigente y la anterior con encabezados distintos: esquema-invalido, sin mezclar columnas', async () => {
    const store = make(3, { AUDITORIA_2026_10: [[...WRITE_HEADERS.AUDITORIA, 'EXTRA']] })
    const error = await crearTarea(servicio(store)).catch((e: unknown) => e)
    expect((error as OperationError).code).toBe('esquema-invalido')
  })
})

describe('Nombre de la pestaña siguiente (ORD-POS-153)', () => {
  const oct = new Date('2026-10-08T16:30:00Z')
  it('mes de Mérida, sufijo si ya existe y nunca antes de la vigente', () => {
    expect(siguientePestanaAuditoria(['AUDITORIA'], oct)).toBe('AUDITORIA_2026_10')
    expect(siguientePestanaAuditoria(['AUDITORIA', 'AUDITORIA_2026_10'], oct)).toBe('AUDITORIA_2026_10_2')
    expect(siguientePestanaAuditoria(['AUDITORIA', 'AUDITORIA_2026_10', 'AUDITORIA_2026_10_2'], oct)).toBe('AUDITORIA_2026_10_3')
    expect(siguientePestanaAuditoria(['AUDITORIA', 'AUDITORIA_2026_09'], oct)).toBe('AUDITORIA_2026_10')
    // 1 de noviembre a las 05:00 UTC sigue siendo 31 de octubre en Mérida.
    expect(siguientePestanaAuditoria(['AUDITORIA'], new Date('2026-11-01T05:00:00Z'))).toBe('AUDITORIA_2026_10')
  })

  it('ordena por año, mes y rotación (10 después de 9) e ignora otras pestañas', () => {
    expect(ordenarPestanasAuditoria(['AUDITORIA_2026_10_10', 'TAREAS', 'AUDITORIA_2026_10_9', 'AUDITORIA', 'AUDITORIA_2026_10', 'AUDITORIA_X']))
      .toEqual(['AUDITORIA', 'AUDITORIA_2026_10', 'AUDITORIA_2026_10_9', 'AUDITORIA_2026_10_10'])
  })
})

describe('El aviso llega a lo que muestra el dashboard', () => {
  const aviso = 'TAREAS pasa del 80 % del límite de 5000 filas: archívala a mano (docs/escritura-v1-8.md §12) antes de que se bloquee la escritura.'

  it('EstadoGuardado (edición en línea, capacidad, escenarios) recibe el aviso de la respuesta ok', () => {
    expect(estadoGuardado({ status: 'done', result: { version: 3, repetida: false, aviso } })).toEqual({ tipo: 'guardado', version: 3, repetida: false, aviso })
    expect(estadoGuardado({ status: 'done', result: { version: 3, repetida: false } })).not.toHaveProperty('aviso')
  })

  it('«Aplicar movimientos al plan» conserva el aviso de cada día', () => {
    expect(resultadoDia('2026-10-09', { ok: true, id: 'PLAN-2026-10-09', version: 1, repetida: false, aviso })).toMatchObject({ tipo: 'guardado', aviso })
  })
})
