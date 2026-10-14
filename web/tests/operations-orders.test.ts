import { describe, expect, it } from 'vitest'
import { buildFixtureTabs } from '@/lib/fixtures'
import { WRITE_HEADERS, type WriteTab } from '@/lib/operations/constants'
import { OperationError } from '@/lib/operations/errors'
import { OperationsService } from '@/lib/operations/service'
import { SheetsTableStore } from '@/lib/operations/sheets-table-store'
import { findById, InMemoryTableStore, readView, toRecord, type TableStore } from '@/lib/operations/table-store'
import { parseCreateOrder, parseOrderTransition } from '@/lib/operations/validation'
import { FakeSheets } from './helpers/fake-sheets'

/** Órdenes desde el dashboard (V1.8 F3), contra el mock y contra el adaptador de Sheets simulado. */

const NOW = new Date('2026-10-14T16:30:00Z') // 10:30 en Mérida
const ACTOR = { actor: 'escritor@example.com' }
let seq = 0
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`

function seed(): Record<string, unknown[][]> {
  return { ...(buildFixtureTabs('2026-10-14') as Record<string, unknown[][]>), AUDITORIA: [[...WRITE_HEADERS.AUDITORIA]] }
}

const ADAPTERS: Array<[string, () => { store: TableStore; service: OperationsService }]> = [
  ['mock', () => {
    const store = new InMemoryTableStore(seed())
    return { store, service: new OperationsService(store, { mode: 'mock', clock: () => NOW }) }
  }],
  ['sheets (servidor simulado)', () => {
    const fake = new FakeSheets('HOJA_DE_PRUEBA_SINTETICA_0123456789', seed())
    const store = new SheetsTableStore({ spreadsheetId: fake.spreadsheetId, getWriteToken: async () => 't', fetchImpl: fake.fetch })
    return { store, service: new OperationsService(store, { mode: 'sheets', clock: () => NOW }) }
  }],
]

const NEW_ORDER = {
  proyectoId: 'POS', tareaId: 'DEMO-002', titulo: 'Agregar prueba', objetivo: 'Cubrir el caso X',
  criterios: 'npm test pasa', fueraDeAlcance: 'No tocar src', comoProbar: 'npm test', riesgo: 'BAJO',
}

async function orden(store: TableStore, id: string) {
  const view = await readView(store, 'ORDENES_CODEX' as WriteTab)
  const rows = findById(view, 'ORDEN_ID', id)
  return rows.length === 1 ? toRecord(view, rows[0]!.cells) : null
}

async function code(p: Promise<unknown>) {
  try {
    await p
    return 'ok'
  } catch (error) {
    return error instanceof OperationError ? error.code : String(error)
  }
}

describe.each(ADAPTERS)('órdenes a Codex — %s', (_name, make) => {
  it('crea en BORRADOR con ID secuencial del proyecto y auditoría por campo', async () => {
    const { store, service } = make()
    const r = await service.createOrder(parseCreateOrder({ ...NEW_ORDER, requestId: uuid() }), ACTOR)
    // Los fixtures ya tienen ORD-POS-901 y ORD-POS-902.
    expect(r).toEqual({ operacion: 'orden.crear', entidad: 'ORDENES_CODEX', id: 'ORD-POS-903', repetida: false })
    expect(await orden(store, 'ORD-POS-903')).toMatchObject({ ESTADO: 'BORRADOR', TAREA_ID: 'DEMO-002', RIESGO: 'BAJO', ACTUALIZADO_EN: '2026-10-14' })
    const audit = (await store.readTable('AUDITORIA')).slice(1)
    expect(audit.every((row) => row[3] === 'ORDENES_CODEX' && row[4] === 'ORD-POS-903')).toBe(true)
  })

  it('repetir la misma solicitud no duplica', async () => {
    const { store, service } = make()
    const requestId = uuid()
    await service.createOrder(parseCreateOrder({ ...NEW_ORDER, requestId }), ACTOR)
    const again = await service.createOrder(parseCreateOrder({ ...NEW_ORDER, requestId }), ACTOR)
    expect(again.repetida).toBe(true)
    expect((await store.readTable('ORDENES_CODEX' as WriteTab)).length - 1).toBe(4)
  })

  it('rechaza tarea de otro proyecto o inexistente', async () => {
    const { service } = make()
    expect(await code(service.createOrder(parseCreateOrder({ ...NEW_ORDER, tareaId: 'DEMO-005', requestId: uuid() }), ACTOR))).toBe('tarea-inexistente')
    expect(await code(service.createOrder(parseCreateOrder({ ...NEW_ORDER, tareaId: 'NO-001', requestId: uuid() }), ACTOR))).toBe('tarea-inexistente')
    expect(await code(service.createOrder(parseCreateOrder({ ...NEW_ORDER, proyectoId: 'ZZZ', requestId: uuid() }), ACTOR))).toBe('proyecto-inexistente')
  })

  it('aprueba solo desde BORRADOR y con el estado que vio el propietario', async () => {
    const { store, service } = make()
    expect(await code(service.transitionOrder(parseOrderTransition('ORD-POS-901', { accion: 'APROBAR', expectedEstado: 'APROBADA', requestId: uuid() }), ACTOR))).toBe('conflicto-version')
    const r = await service.transitionOrder(parseOrderTransition('ORD-POS-901', { accion: 'APROBAR', expectedEstado: 'BORRADOR', requestId: uuid() }), ACTOR)
    expect(r).toMatchObject({ operacion: 'orden.aprobar', id: 'ORD-POS-901', repetida: false })
    expect(await orden(store, 'ORD-POS-901')).toMatchObject({ ESTADO: 'APROBADA', ACTUALIZADO_EN: '2026-10-14', TITULO: 'Orden demo por aprobar' })
    // Aprobar otra vez (otra solicitud) no es una transición válida.
    expect(await code(service.transitionOrder(parseOrderTransition('ORD-POS-901', { accion: 'APROBAR', expectedEstado: 'APROBADA', requestId: uuid() }), ACTOR))).toBe('transicion-no-permitida')
    // ORD-POS-902 está en PR_ABIERTO: no se aprueba.
    expect(await code(service.transitionOrder(parseOrderTransition('ORD-POS-902', { accion: 'APROBAR', expectedEstado: 'PR_ABIERTO', requestId: uuid() }), ACTOR))).toBe('transicion-no-permitida')
  })

  it('reintentar la misma aprobación es idempotente', async () => {
    const { store, service } = make()
    const requestId = uuid()
    const cmd = () => parseOrderTransition('ORD-POS-901', { accion: 'APROBAR', expectedEstado: 'BORRADOR', requestId })
    await service.transitionOrder(cmd(), ACTOR)
    const auditRows = (await store.readTable('AUDITORIA')).length
    expect((await service.transitionOrder(cmd(), ACTOR)).repetida).toBe(true)
    expect((await store.readTable('AUDITORIA')).length).toBe(auditRows)
  })

  it('cancela con motivo en NOTAS; las órdenes cerradas no cambian', async () => {
    const { store, service } = make()
    await service.transitionOrder(parseOrderTransition('ORD-POS-902', { accion: 'CANCELAR', expectedEstado: 'PR_ABIERTO', motivo: 'Ya no hace falta', requestId: uuid() }), ACTOR)
    expect(await orden(store, 'ORD-POS-902')).toMatchObject({ ESTADO: 'CANCELADA', NOTAS: 'Cancelada: Ya no hace falta' })
    expect(await code(service.transitionOrder(parseOrderTransition('ORD-ECO-901', { accion: 'CANCELAR', expectedEstado: 'CERRADA', motivo: 'x y z', requestId: uuid() }), ACTOR))).toBe('orden-cerrada')
  })

  it('no aprueba una orden incompleta o de riesgo ALTO', async () => {
    const { store, service } = make()
    const tabs = await store.readTable('ORDENES_CODEX' as WriteTab)
    const header = tabs[0]!
    const row = [...tabs[1]!]
    row[header.indexOf('RIESGO')] = 'ALTO'
    await store.writeRow('ORDENES_CODEX' as WriteTab, 2, row)
    expect(await code(service.transitionOrder(parseOrderTransition('ORD-POS-901', { accion: 'APROBAR', expectedEstado: 'BORRADOR', requestId: uuid() }), ACTOR))).toBe('orden-incompleta')
  })

  it('la conciliación cubre las órdenes', async () => {
    const { service } = make()
    await service.createOrder(parseCreateOrder({ ...NEW_ORDER, requestId: uuid() }), ACTOR)
    await service.transitionOrder(parseOrderTransition('ORD-POS-903', { accion: 'APROBAR', expectedEstado: 'BORRADOR', requestId: uuid() }), ACTOR)
    expect((await service.reconcile()).pendientes).toEqual([])
  })
})

describe('validación de órdenes', () => {
  it('rechaza riesgo ALTO, estado en el alta y campos desconocidos', () => {
    expect(() => parseCreateOrder({ ...NEW_ORDER, riesgo: 'ALTO', requestId: uuid() })).toThrow(OperationError)
    expect(() => parseCreateOrder({ ...NEW_ORDER, estado: 'APROBADA', requestId: uuid() })).toThrow(OperationError)
    expect(() => parseCreateOrder({ ...NEW_ORDER, issueUrl: 'https://x', requestId: uuid() })).toThrow(OperationError)
  })

  it('cancelar exige motivo; aprobar no lo admite; el ID debe ser ORD-PRY-NNN', () => {
    expect(() => parseOrderTransition('ORD-POS-001', { accion: 'CANCELAR', expectedEstado: 'BORRADOR', requestId: uuid() })).toThrow(OperationError)
    expect(() => parseOrderTransition('ORD-POS-001', { accion: 'APROBAR', expectedEstado: 'BORRADOR', motivo: 'algo', requestId: uuid() })).toThrow(OperationError)
    expect(() => parseOrderTransition('POS-001', { accion: 'APROBAR', expectedEstado: 'BORRADOR', requestId: uuid() })).toThrow(OperationError)
    expect(parseOrderTransition('ord-pos-001', { accion: 'aprobar', expectedEstado: 'borrador', requestId: uuid() })).toMatchObject({ ordenId: 'ORD-POS-001', accion: 'aprobar', expectedEstado: 'BORRADOR', motivo: null })
  })
})
