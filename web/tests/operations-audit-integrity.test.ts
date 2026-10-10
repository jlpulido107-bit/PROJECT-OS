import { describe, expect, it } from 'vitest'
import { buildFixtureTabs } from '@/lib/fixtures'
import { WRITE_HEADERS, type WriteTab } from '@/lib/operations/constants'
import { OperationError } from '@/lib/operations/errors'
import { OperationsService } from '@/lib/operations/service'
import { InMemoryTableStore, type TableStore } from '@/lib/operations/table-store'
import { parseCreateTask, parseUpdateTask } from '@/lib/operations/validation'

/**
 * Revisión de integración (PR #8): concurrencia sin CAS y robustez de la conciliación ante auditorías
 * parciales, contradictorias o alteraciones sin operación auditada. Todo en memoria; nunca Sheets real.
 */
const TODAY = '2026-10-08'
const NOW = new Date('2026-10-08T16:30:00Z')
const ACTOR = { actor: 'escritor@example.com' }
let seq = 0
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`
const seed = () => ({ ...(buildFixtureTabs(TODAY) as Record<string, unknown[][]>), AUDITORIA: [[...WRITE_HEADERS.AUDITORIA]] })
const service = (store: TableStore) => new OperationsService(store, { mode: 'mock', clock: () => NOW })
const newTask = () => parseCreateTask({ requestId: uuid(), proyectoId: 'POS', titulo: 'Tarea de concurrencia', tipo: 'DESARROLLO', prioridad: 'MEDIA', criterioTerminado: 'Hecho' })
const edit = (id: string, version: number, changes: Record<string, unknown>, requestId = uuid()) => parseUpdateTask(id, { requestId, expectedVersion: version, changes })

async function code(promise: Promise<unknown>) {
  const error = await promise.catch((e: unknown) => e)
  expect(error).toBeInstanceOf(OperationError)
  return (error as OperationError).code
}

/** Decorador: ejecuta `hook` justo antes del PRÓXIMO writeRow de TAREAS (entre la relectura de guarda y la escritura). */
class RaceStore implements TableStore {
  hook: (() => Promise<void>) | null = null
  constructor(readonly inner: TableStore) {}
  get kind() {
    return this.inner.kind
  }
  readTable(tab: WriteTab) {
    return this.inner.readTable(tab)
  }
  appendRows(tab: WriteTab, rows: string[][]) {
    return this.inner.appendRows(tab, rows)
  }
  async writeRow(tab: WriteTab, row: number, cells: string[]) {
    if (tab === 'TAREAS' && this.hook) {
      const hook = this.hook
      this.hook = null
      await hook()
    }
    return this.inner.writeRow(tab, row, cells)
  }
}

describe('dos escritores independientes (sin CAS atómico en Sheets)', () => {
  it('ambos leen VERSION=N: el segundo recibe conflicto-version si escribe después del primero', async () => {
    const base = new InMemoryTableStore(seed())
    const a = service(base)
    const b = service(base) // otra instancia: su mutex no coordina con el de A
    const { id } = await a.createTask(newTask(), ACTOR)
    await a.updateTask(edit(id, 1, { prioridad: 'ALTA' }), ACTOR)
    expect(await code(b.updateTask(edit(id, 1, { prioridad: 'BAJA' }), ACTOR))).toBe('conflicto-version')
  })

  it('carrera fina entre la relectura de guarda y la escritura: la actualización perdida es posible y la conciliación la detecta', async () => {
    const base = new InMemoryTableStore(seed())
    const a = service(base)
    const race = new RaceStore(base)
    const b = service(race)
    const { id } = await a.createTask(newTask(), ACTOR)
    // B pasa su guarda con VERSION=1; antes de que escriba, A completa su edición (VERSION 1 → 2).
    race.hook = async () => {
      await a.updateTask(edit(id, 1, { prioridad: 'ALTA' }), ACTOR)
    }
    const resultB = await b.updateTask(edit(id, 1, { titulo: 'Título de B' }), ACTOR)
    // LIMITACIÓN DOCUMENTADA (contrato §6): no hay compare-and-swap; B sobrescribe a A sin error.
    expect(resultB.version).toBe(2)
    const report = await a.reconcile()
    expect(report.pendientes.filter((p) => p.motivo === 'actualizacion-perdida').map((p) => p.id)).toEqual([id])
  })
})

describe('integridad de la auditoría', () => {
  async function auditRows(store: TableStore) {
    return (await store.readTable('AUDITORIA')).slice(1)
  }
  async function rewriteAudit(store: InMemoryTableStore, mutate: (rows: string[][]) => string[][]) {
    const all = await store.readTable('AUDITORIA')
    const header = all[0]!
    const next = new InMemoryTableStore({ ...(await snapshotAll(store)), AUDITORIA: [header, ...mutate(all.slice(1))] })
    return next
  }
  async function snapshotAll(store: InMemoryTableStore) {
    const out: Record<string, unknown[][]> = {}
    for (const tab of ['TAREAS', 'TIEMPOS', 'DECISIONES', 'PROYECTOS', 'HITOS'] as WriteTab[]) out[tab] = await store.readTable(tab)
    return out
  }
  const col = (name: string) => (WRITE_HEADERS.AUDITORIA as readonly string[]).indexOf(name)

  it('AUDIT_ID incluye índice y total por solicitud (NN-TT)', async () => {
    const store = new InMemoryTableStore(seed())
    await service(store).createTask(newTask(), ACTOR)
    const ids = (await auditRows(store)).map((r) => r[col('AUDIT_ID')]!)
    expect(ids.every((id) => /^AUD-\d{14}-[0-9A-F]{8}-\d{2}-\d{2}$/.test(id))).toBe(true)
    expect(ids.map((id) => id.slice(-5))).toEqual(ids.map((_, i) => `${String(i + 1).padStart(2, '0')}-${String(ids.length).padStart(2, '0')}`))
  })

  it('auditoría parcial (faltan filas): la conciliación la marca y un reintento no la da por buena', async () => {
    const store = new InMemoryTableStore(seed())
    const cmd = newTask()
    const { id } = await service(store).createTask(cmd, ACTOR)
    const partial = await rewriteAudit(store, (rows) => rows.slice(0, rows.length - 2))
    const report = await service(partial).reconcile()
    expect(report.pendientes.find((p) => p.id === id)?.motivo).toBe('auditoria-parcial')
    expect(await code(service(partial).createTask(cmd, ACTOR))).toBe('auditoria-inconsistente')
  })

  it('filas contradictorias en la misma solicitud (otro registro u otro hash) ⇒ inconsistente', async () => {
    const store = new InMemoryTableStore(seed())
    const cmd = newTask()
    const { id } = await service(store).createTask(cmd, ACTOR)
    const tampered = await rewriteAudit(store, (rows) => rows.map((r, i) => (i === 1 ? r.map((c, j) => (j === col('REGISTRO_ID') ? 'POS-999' : c)) : r)))
    const report = await service(tampered).reconcile()
    expect(report.pendientes.find((p) => p.id === id || p.id === 'POS-999')?.motivo).toBe('auditoria-inconsistente')
    expect(await code(service(tampered).createTask(cmd, ACTOR))).toBe('auditoria-inconsistente')
  })

  it('alta repetida cuando la fila existe pero fue alterada sin operación auditada ⇒ estado-divergente (no "repetida")', async () => {
    const store = new InMemoryTableStore(seed())
    const cmd = newTask()
    const { id } = await service(store).createTask(cmd, ACTOR)
    const rows = await store.readTable('TAREAS')
    const header = rows[0]!
    const at = rows.findIndex((r) => r[header.indexOf('TAREA_ID')] === id)
    const altered = [...rows[at]!]
    altered[header.indexOf('TITULO')] = 'Cambiado a mano'
    await store.writeRow('TAREAS', at + 1, altered)
    expect(await code(service(store).createTask(cmd, ACTOR))).toBe('estado-divergente')
    expect((await service(store).reconcile()).pendientes.find((p) => p.id === id)?.motivo).toBe('divergente')
  })

  it('reintento legítimo tras ediciones auditadas posteriores sigue siendo "repetida" (alta y edición)', async () => {
    const store = new InMemoryTableStore(seed())
    const svc = service(store)
    const create = newTask()
    const { id } = await svc.createTask(create, ACTOR)
    const first = edit(id, 1, { prioridad: 'ALTA' })
    await svc.updateTask(first, ACTOR)
    await svc.updateTask(edit(id, 2, { titulo: 'Segundo cambio' }), ACTOR)
    expect((await svc.createTask(create, ACTOR)).repetida).toBe(true)
    const replay = await svc.updateTask(first, ACTOR)
    expect(replay).toMatchObject({ repetida: true, version: 2 })
    expect((await svc.reconcile()).pendientes).toEqual([])
  })

  it('edición aplicada y luego alterada a mano (misma VERSION, sin operación) ⇒ estado-divergente', async () => {
    const store = new InMemoryTableStore(seed())
    const svc = service(store)
    const { id } = await svc.createTask(newTask(), ACTOR)
    const change = edit(id, 1, { prioridad: 'ALTA' })
    await svc.updateTask(change, ACTOR)
    const rows = await store.readTable('TAREAS')
    const header = rows[0]!
    const at = rows.findIndex((r) => r[header.indexOf('TAREA_ID')] === id)
    const altered = [...rows[at]!]
    altered[header.indexOf('PRIORIDAD')] = 'BAJA'
    await store.writeRow('TAREAS', at + 1, altered)
    expect(await code(svc.updateTask(change, ACTOR))).toBe('estado-divergente')
  })
})
