import { beforeEach, describe, expect, it } from 'vitest'
import { buildFixtureTabs } from '@/lib/fixtures'
import { WRITE_HEADERS, type WriteTab } from '@/lib/operations/constants'
import { OperationError } from '@/lib/operations/errors'
import { OperationsService } from '@/lib/operations/service'
import { SheetsTableStore } from '@/lib/operations/sheets-table-store'
import { InMemoryTableStore, readView, toRecord, findById, type TableStore } from '@/lib/operations/table-store'
import { parseCreateDecision, parseCreateTask, parseLogTime, parseUpdateTask } from '@/lib/operations/validation'
import { FakeSheets } from './helpers/fake-sheets'

/**
 * Pruebas de CONTRATO: la misma suite corre contra el repositorio simulado (modo `mock`) y contra el adaptador de
 * Sheets preparado (con un servidor de Sheets simulado). Así el mock no puede divergir del futuro adaptador real.
 */

const TODAY = '2026-10-08'
const NOW = new Date('2026-10-08T16:30:00Z') // 10:30 en Mérida
const ACTOR = { actor: 'escritor@example.com' }
let seq = 0
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`

function seed(): Record<string, unknown[][]> {
  return { ...(buildFixtureTabs(TODAY) as Record<string, unknown[][]>), AUDITORIA: [[...WRITE_HEADERS.AUDITORIA]] }
}

/** Decorador para inyectar fallos de escritura en cualquier adaptador. */
class FailingStore implements TableStore {
  readonly failures = new Set<string>()
  constructor(readonly inner: TableStore) {}
  get kind() {
    return this.inner.kind
  }
  readTable(tab: WriteTab) {
    return this.inner.readTable(tab)
  }
  async appendRows(tab: WriteTab, rows: string[][]) {
    if (this.failures.delete(`append ${tab}`)) throw new Error('fallo simulado')
    return this.inner.appendRows(tab, rows)
  }
  async writeRow(tab: WriteTab, row: number, cells: string[]) {
    if (this.failures.delete(`write ${tab}`)) throw new Error('fallo simulado')
    return this.inner.writeRow(tab, row, cells)
  }
}

interface Harness {
  store: FailingStore
  service: OperationsService
  fake?: FakeSheets
}

const ADAPTERS: Array<[string, () => Harness]> = [
  ['InMemoryTableStore (mock)', () => {
    const store = new FailingStore(new InMemoryTableStore(seed()))
    return { store, service: new OperationsService(store, { mode: 'mock', clock: () => NOW }) }
  }],
  ['SheetsTableStore (servidor simulado)', () => {
    const fake = new FakeSheets('HOJA_DE_PRUEBA_SINTETICA_0123456789', seed())
    const store = new FailingStore(new SheetsTableStore({
      spreadsheetId: fake.spreadsheetId,
      getWriteToken: async () => 'token-de-escritura-falso',
      fetchImpl: fake.fetch,
    }))
    return { store, service: new OperationsService(store, { mode: 'mock', clock: () => NOW }), fake }
  }],
]

async function record(store: TableStore, tab: WriteTab, idColumn: string, id: string) {
  const view = await readView(store, tab)
  const rows = findById(view, idColumn, id)
  return rows.length === 1 ? toRecord(view, rows[0]!.cells) : null
}

async function count(store: TableStore, tab: WriteTab) {
  return (await store.readTable(tab)).length - 1
}

function taskInput(extra: Record<string, unknown> = {}) {
  return {
    requestId: uuid(), proyectoId: 'POS', titulo: 'Preparar informe semanal', tipo: 'documentacion', prioridad: 'media',
    criterioTerminado: 'Informe revisado por el usuario', ...extra,
  }
}

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.catch((e: unknown) => e)
  expect(error).toBeInstanceOf(OperationError)
  expect((error as OperationError).code).toBe(code)
  return error as OperationError
}

describe.each(ADAPTERS)('contrato de operaciones — %s', (_name, make) => {
  let h: Harness
  beforeEach(() => {
    h = make()
  })

  describe('almacenamiento', () => {
    it('lee encabezados reales y valida el esquema', async () => {
      const view = await readView(h.store, 'TAREAS')
      expect(view.header).toEqual([...WRITE_HEADERS.TAREAS])
      expect(view.rows[0]!.sheetRow).toBe(2)
    })

    it('rechaza pestañas con columnas faltantes sin escribir nada', async () => {
      const store = new InMemoryTableStore({ ...seed(), TAREAS: [['TAREA_ID', 'TITULO']] })
      const service = new OperationsService(store, { mode: 'mock', clock: () => NOW })
      await expectCode(service.createTask(parseCreateTask(taskInput()), ACTOR), 'esquema-invalido')
      expect(await count(store, 'AUDITORIA')).toBe(0)
    })
  })

  describe('crear tarea', () => {
    it('crea con ID secuencial, estado PENDIENTE, versión 1 y auditoría por campo', async () => {
      const result = await h.service.createTask(parseCreateTask(taskInput({ hitoId: 'DEMO-H1', horasEstimadas: '2,5' })), ACTOR)
      expect(result).toMatchObject({ operacion: 'tarea.crear', entidad: 'TAREAS', id: 'POS-001', version: 1, repetida: false })
      const task = await record(h.store, 'TAREAS', 'TAREA_ID', 'POS-001')
      expect(task).toMatchObject({
        PROYECTO_ID: 'POS', HITO_ID: 'DEMO-H1', TIPO: 'DOCUMENTACION', ESTADO: 'PENDIENTE', PRIORIDAD: 'MEDIA',
        HORAS_ESTIMADAS: '2.5', VERSION: '1', ACTUALIZADO_EN: '2026-10-08T10:30:00-06:00',
      })
      const audit = toRecords(await readView(h.store, 'AUDITORIA'))
      expect(audit.length).toBeGreaterThan(5)
      expect(new Set(audit.map((a) => a.REGISTRO_ID))).toEqual(new Set(['POS-001']))
      expect(audit.every((a) => a.ACTOR === 'escritor@example.com' && a.ENTIDAD === 'TAREAS' && a.VALOR_ANTES === '')).toBe(true)
      expect(audit[0]!.ORIGEN).toMatch(/^dashboard-v1\.4;modo=mock;op=tarea\.crear;req=[0-9a-f-]{36};h=[0-9a-f]{16}$/)
      expect(new Set(audit.map((a) => a.AUDIT_ID)).size).toBe(audit.length)

      const second = await h.service.createTask(parseCreateTask(taskInput({ titulo: 'Segunda tarea' })), ACTOR)
      expect(second.id).toBe('POS-002')
    })

    it('referencias inexistentes o de otro proyecto no escriben nada', async () => {
      await expectCode(h.service.createTask(parseCreateTask(taskInput({ proyectoId: 'XYZ' })), ACTOR), 'proyecto-inexistente')
      await expectCode(h.service.createTask(parseCreateTask(taskInput({ hitoId: 'NO-EXISTE' })), ACTOR), 'hito-inexistente')
      await expectCode(h.service.createTask(parseCreateTask(taskInput({ proyectoId: 'SIG', hitoId: 'DEMO-H1' })), ACTOR), 'hito-inexistente')
      expect(await count(h.store, 'AUDITORIA')).toBe(0)
    })

    it('neutraliza fórmulas y conserva el texto (sin evaluar)', async () => {
      const { id } = await h.service.createTask(parseCreateTask(taskInput({ titulo: '=IMPORTXML("http://x")', descripcion: '@SUM(A1)' })), ACTOR)
      const task = await record(h.store, 'TAREAS', 'TAREA_ID', id)
      expect(task?.TITULO).toBe(`'=IMPORTXML("http://x")`)
      expect(task?.DESCRIPCION).toBe(`'@SUM(A1)`)
    })
  })

  describe('idempotencia', () => {
    it('repetir el mismo requestId devuelve el resultado original sin duplicar', async () => {
      const input = taskInput()
      const first = await h.service.createTask(parseCreateTask(input), ACTOR)
      const audits = await count(h.store, 'AUDITORIA')
      const again = await h.service.createTask(parseCreateTask(input), ACTOR)
      expect(again).toEqual({ ...first, repetida: true })
      expect(await count(h.store, 'AUDITORIA')).toBe(audits)
      expect(findById(await readView(h.store, 'TAREAS'), 'TAREA_ID', first.id)).toHaveLength(1)
    })

    it('el mismo requestId con otro payload → conflicto-idempotencia', async () => {
      const input = taskInput()
      await h.service.createTask(parseCreateTask(input), ACTOR)
      await expectCode(h.service.createTask(parseCreateTask({ ...input, titulo: 'Otro título' }), ACTOR), 'conflicto-idempotencia')
      await expectCode(h.service.logTime(parseLogTime({
        requestId: input.requestId, tareaId: 'DEMO-002', fecha: TODAY, responsable: 'Persona', minutos: 30, tipoTrabajo: 'DESARROLLO',
      }, TODAY), ACTOR), 'conflicto-idempotencia')
    })
  })

  describe('auditoría primero (fail-closed) y conciliación', () => {
    it('si falla la auditoría no se escribe la entidad', async () => {
      h.store.failures.add('append AUDITORIA')
      const before = await count(h.store, 'TAREAS')
      await expectCode(h.service.createTask(parseCreateTask(taskInput()), ACTOR), 'auditoria-fallida')
      expect(await count(h.store, 'TAREAS')).toBe(before)
      expect(await count(h.store, 'AUDITORIA')).toBe(0)
    })

    it('si falla la entidad tras la auditoría: conciliación lo detecta y el reintento la completa', async () => {
      const input = taskInput()
      h.store.failures.add('append TAREAS')
      await expectCode(h.service.createTask(parseCreateTask(input), ACTOR), 'escritura-fallida')
      expect(await record(h.store, 'TAREAS', 'TAREA_ID', 'POS-001')).toBeNull()
      expect((await h.service.reconcile()).pendientes).toEqual([
        expect.objectContaining({ requestId: input.requestId, id: 'POS-001', motivo: 'sin-efecto' }),
      ])
      const retry = await h.service.createTask(parseCreateTask(input), ACTOR)
      expect(retry).toMatchObject({ id: 'POS-001', repetida: true })
      expect(await record(h.store, 'TAREAS', 'TAREA_ID', 'POS-001')).toMatchObject({ TITULO: input.titulo, VERSION: '1' })
      expect((await h.service.reconcile()).pendientes).toEqual([])
    })

    it('edición: fallo de escritura tras auditoría → reintento con el mismo requestId la aplica', async () => {
      const input = { requestId: uuid(), expectedVersion: 2, changes: { prioridad: 'BAJA' } }
      h.store.failures.add('write TAREAS')
      await expectCode(h.service.updateTask(parseUpdateTask('DEMO-002', input), ACTOR), 'escritura-fallida')
      expect((await h.service.reconcile()).pendientes).toEqual([expect.objectContaining({ id: 'DEMO-002', motivo: 'sin-efecto' })])
      const retry = await h.service.updateTask(parseUpdateTask('DEMO-002', input), ACTOR)
      expect(retry).toMatchObject({ version: 3, repetida: true })
      expect(await record(h.store, 'TAREAS', 'TAREA_ID', 'DEMO-002')).toMatchObject({ PRIORIDAD: 'BAJA', VERSION: '3' })
      expect((await h.service.reconcile()).pendientes).toEqual([])
    })

    it('un cambio manual posterior en la hoja aparece como divergente', async () => {
      await h.service.updateTask(parseUpdateTask('DEMO-002', { requestId: uuid(), expectedVersion: 2, changes: { prioridad: 'BAJA' } }), ACTOR)
      const view = await readView(h.store, 'TAREAS')
      const row = findById(view, 'TAREA_ID', 'DEMO-002')[0]!
      const cells = [...row.cells]
      cells[view.index.get('PRIORIDAD')!] = 'ALTA'
      await h.store.writeRow('TAREAS', row.sheetRow, cells)
      expect((await h.service.reconcile()).pendientes).toEqual([expect.objectContaining({ id: 'DEMO-002', motivo: 'divergente' })])
    })
  })

  describe('editar tarea', () => {
    it('aplica cambios permitidos, sube versión y audita antes/después', async () => {
      const result = await h.service.updateTask(parseUpdateTask('DEMO-002', {
        requestId: uuid(), expectedVersion: 2, changes: { estado: 'bloqueado', bloqueo: 'Espera acceso', responsable: 'Otra persona' },
      }), ACTOR)
      expect(result).toMatchObject({ id: 'DEMO-002', version: 3, repetida: false })
      expect(await record(h.store, 'TAREAS', 'TAREA_ID', 'DEMO-002')).toMatchObject({
        ESTADO: 'BLOQUEADO', BLOQUEO: 'Espera acceso', RESPONSABLE: 'Otra persona', VERSION: '3', TITULO: 'Tarea demo en curso',
      })
      const audit = toRecords(await readView(h.store, 'AUDITORIA'))
      expect(audit.map((a) => a.CAMPO).sort()).toEqual(['ACTUALIZADO_EN', 'BLOQUEO', 'ESTADO', 'RESPONSABLE', 'VERSION'])
      expect(audit.find((a) => a.CAMPO === 'ESTADO')).toMatchObject({ VALOR_ANTES: 'EN_PROGRESO', VALOR_DESPUES: 'BLOQUEADO' })
      expect(audit.find((a) => a.CAMPO === 'VERSION')).toMatchObject({ VALOR_ANTES: '2', VALOR_DESPUES: '3' })
    })

    it('versión desactualizada → 409 sin escribir', async () => {
      const error = await expectCode(h.service.updateTask(parseUpdateTask('DEMO-002', { requestId: uuid(), expectedVersion: 1, changes: { prioridad: 'BAJA' } }), ACTOR), 'conflicto-version')
      expect(error.detail).toEqual({ versionActual: 2 })
      expect(await count(h.store, 'AUDITORIA')).toBe(0)
    })

    it('no se puede cerrar ni editar una tarea cerrada', async () => {
      await expectCode(h.service.updateTask(parseUpdateTask('DEMO-001', { requestId: uuid(), expectedVersion: 1, changes: { prioridad: 'BAJA' } }), ACTOR), 'tarea-cerrada')
      expect(() => parseUpdateTask('DEMO-002', { requestId: uuid(), expectedVersion: 2, changes: { estado: 'COMPLETADO' } })).toThrowError(
        expect.objectContaining({ code: 'cierre-no-permitido' }),
      )
      expect(() => parseUpdateTask('DEMO-002', { requestId: uuid(), expectedVersion: 2, changes: { estado: 'cancelado' } })).toThrowError(
        expect.objectContaining({ code: 'cierre-no-permitido' }),
      )
    })

    it('reglas cruzadas: BLOQUEADO exige bloqueo; fechas ordenadas; hito del mismo proyecto; sin cambios', async () => {
      await expectCode(h.service.updateTask(parseUpdateTask('DEMO-002', { requestId: uuid(), expectedVersion: 2, changes: { estado: 'BLOQUEADO' } }), ACTOR), 'validacion')
      await expectCode(h.service.updateTask(parseUpdateTask('DEMO-002', { requestId: uuid(), expectedVersion: 2, changes: { fechaPlan: '2026-12-31' } }), ACTOR), 'validacion')
      await expectCode(h.service.updateTask(parseUpdateTask('DEMO-005', { requestId: uuid(), expectedVersion: 0, changes: { hitoId: 'DEMO-H1' } }), ACTOR), 'hito-inexistente')
      await expectCode(h.service.updateTask(parseUpdateTask('DEMO-002', { requestId: uuid(), expectedVersion: 2, changes: { prioridad: 'ALTA' } }), ACTOR), 'sin-cambios')
      await expectCode(h.service.updateTask(parseUpdateTask('NO-EXISTE', { requestId: uuid(), expectedVersion: 1, changes: { prioridad: 'ALTA' } }), ACTOR), 'tarea-inexistente')
      expect(await count(h.store, 'AUDITORIA')).toBe(0)
    })

    it('concurrencia: dos ediciones con la misma versión → una gana, la otra 409', async () => {
      const a = h.service.updateTask(parseUpdateTask('DEMO-002', { requestId: uuid(), expectedVersion: 2, changes: { prioridad: 'BAJA' } }), ACTOR)
      const b = h.service.updateTask(parseUpdateTask('DEMO-002', { requestId: uuid(), expectedVersion: 2, changes: { responsable: 'Otra' } }), ACTOR)
      const results = await Promise.allSettled([a, b])
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
      expect(rejected.reason.code).toBe('conflicto-version')
      expect(await record(h.store, 'TAREAS', 'TAREA_ID', 'DEMO-002')).toMatchObject({ VERSION: '3' })
    })

    it('si la fila cambia de posición o versión justo antes de escribir → conflicto-concurrente', async () => {
      // Simula a otra persona editando la hoja entre la lectura y la escritura.
      const inner = h.store.inner
      let interfered = false
      const sneaky: TableStore = {
        kind: inner.kind,
        readTable: async (tab) => {
          const values = await inner.readTable(tab)
          if (tab === 'TAREAS' && interfered === false && (await countReads()) === 2) {
            interfered = true
            const header = values[0]!
            const at = values.findIndex((r) => r[0] === 'DEMO-002')
            const cells = [...values[at]!]
            cells[header.indexOf('VERSION')] = '9'
            await inner.writeRow('TAREAS', at + 1, cells)
            return inner.readTable(tab)
          }
          return values
        },
        appendRows: (tab, rows) => inner.appendRows(tab, rows),
        writeRow: (tab, row, cells) => inner.writeRow(tab, row, cells),
      }
      let reads = 0
      const countReads = async () => ++reads
      const service = new OperationsService(sneaky, { mode: 'mock', clock: () => NOW })
      await expectCode(service.updateTask(parseUpdateTask('DEMO-002', { requestId: uuid(), expectedVersion: 2, changes: { prioridad: 'BAJA' } }), ACTOR), 'conflicto-concurrente')
      expect(await record(inner, 'TAREAS', 'TAREA_ID', 'DEMO-002')).toMatchObject({ PRIORIDAD: 'ALTA', VERSION: '9' })
    })

    it('conserva columnas ajenas al contrato al reescribir la fila', async () => {
      const values = seed()
      const tareas = values.TAREAS!.map((row, i) => [...(row as string[]), i === 0 ? 'COLUMNA_EXTRA' : `extra-${i}`])
      const store = new InMemoryTableStore({ ...values, TAREAS: tareas })
      const service = new OperationsService(store, { mode: 'mock', clock: () => NOW })
      await service.updateTask(parseUpdateTask('DEMO-002', { requestId: uuid(), expectedVersion: 2, changes: { prioridad: 'BAJA' } }), ACTOR)
      const row = (await store.readTable('TAREAS')).find((r) => r[0] === 'DEMO-002')!
      expect(row.at(-1)).toBe('extra-2')
    })
  })

  describe('tiempos y decisiones', () => {
    it('registra tiempo con ID aleatorio verificado y referencia válida', async () => {
      const result = await h.service.logTime(parseLogTime({
        requestId: uuid(), tareaId: 'demo-002', fecha: TODAY, responsable: 'Persona demo', minutos: '45', tipoTrabajo: 'desarrollo', notas: '+ nota',
      }, TODAY), ACTOR)
      expect(result.id).toMatch(/^SES-20261008-[0-9A-F]{8}$/)
      expect(await record(h.store, 'TIEMPOS', 'SESION_ID', result.id)).toMatchObject({
        TAREA_ID: 'DEMO-002', MINUTOS_REALES: '45', TIPO_TRABAJO: 'DESARROLLO', NOTAS: "'+ nota", CREADO_EN: '2026-10-08T10:30:00-06:00',
      })
      await expectCode(h.service.logTime(parseLogTime({
        requestId: uuid(), tareaId: 'NO-EXISTE', fecha: TODAY, responsable: 'X', minutos: 5, tipoTrabajo: 'DESARROLLO',
      }, TODAY), ACTOR), 'tarea-inexistente')
    })

    it('registra decisión PENDIENTE con ID secuencial por proyecto', async () => {
      const input = { requestId: uuid(), proyectoId: 'POS', asunto: 'Hosting', decision: 'Usar Cloud Run', justificacion: 'Costo y seguridad', responsable: 'Usuario', evidenciaUrl: 'https://github.com/jlpulido107-bit/PROJECT-OS/pull/6' }
      const result = await h.service.createDecision(parseCreateDecision(input, TODAY), ACTOR)
      expect(result).toMatchObject({ entidad: 'DECISIONES', id: 'DEC-POS-001' })
      expect(await record(h.store, 'DECISIONES', 'DECISION_ID', 'DEC-POS-001')).toMatchObject({ ESTADO: 'PENDIENTE', FECHA: TODAY })
      await expectCode(h.service.createDecision(parseCreateDecision({ ...input, requestId: uuid(), proyectoId: 'XYZ' }, TODAY), ACTOR), 'proyecto-inexistente')
    })
  })
})

describe('adaptador de Sheets (servidor simulado)', () => {
  it('usa el token de escritura, RAW e INSERT_ROWS; nunca USER_ENTERED', async () => {
    const fake = new FakeSheets('HOJA_DE_PRUEBA_SINTETICA_0123456789', seed())
    const store = new SheetsTableStore({ spreadsheetId: fake.spreadsheetId, getWriteToken: async () => 'token-de-escritura-falso', fetchImpl: fake.fetch })
    const service = new OperationsService(store, { mode: 'mock', clock: () => NOW })
    await service.createTask(parseCreateTask(taskInput()), ACTOR)
    await service.updateTask(parseUpdateTask('DEMO-002', { requestId: uuid(), expectedVersion: 2, changes: { prioridad: 'BAJA' } }), ACTOR)
    const writes = fake.calls.filter((c) => c.method !== 'GET')
    expect(writes.map((c) => `${c.method} ${c.path.split('!')[0]}`)).toEqual([
      "POST 'AUDITORIA'", "POST 'TAREAS'", "POST 'AUDITORIA'", "PUT 'TAREAS'",
    ])
    for (const call of fake.calls) expect(call.authorization).toBe('Bearer token-de-escritura-falso')
    for (const call of writes) expect(call.query.get('valueInputOption')).toBe('RAW')
    expect(writes.filter((c) => c.method === 'POST').every((c) => c.query.get('insertDataOption') === 'INSERT_ROWS')).toBe(true)
    expect(fake.calls.some((c) => c.query.toString().includes('USER_ENTERED'))).toBe(false)
  })

  it('un error HTTP de la API se traduce en códigos seguros', async () => {
    const fake = new FakeSheets('HOJA_DE_PRUEBA_SINTETICA_0123456789', seed())
    const store = new SheetsTableStore({ spreadsheetId: fake.spreadsheetId, getWriteToken: async () => 't', fetchImpl: fake.fetch })
    const service = new OperationsService(store, { mode: 'mock', clock: () => NOW })
    fake.failures.add('GET PROYECTOS')
    await expectCode(service.createTask(parseCreateTask(taskInput()), ACTOR), 'lectura-fallida')
    fake.failures.add('POST AUDITORIA')
    await expectCode(service.createTask(parseCreateTask(taskInput()), ACTOR), 'auditoria-fallida')
    expect((await store.readTable('TAREAS')).some((r) => r[0] === 'POS-001')).toBe(false)
  })
})

function toRecords(view: Awaited<ReturnType<typeof readView>>) {
  return view.rows.map((r) => toRecord(view, r.cells))
}
