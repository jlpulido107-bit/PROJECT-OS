import { createHash } from 'node:crypto'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AplicarPlan } from '@/components/planning/aplicar-plan'
import { decide } from '@/lib/authz'
import { buildFixtureTabs } from '@/lib/fixtures'
import { AGENT_OPERATIONS, OWNER_PLANNING_OPERATIONS, WRITE_HEADERS, type OperationName, type WriteTab } from '@/lib/operations/constants'
import { OperationError } from '@/lib/operations/errors'
import { evaluateWriteRequest } from '@/lib/operations/guard'
import { RateLimiter } from '@/lib/operations/rate-limit'
import { OperationsService, parseAudit } from '@/lib/operations/service'
import { SheetsTableStore } from '@/lib/operations/sheets-table-store'
import { findById, InMemoryTableStore, readView, toRecord, type TableStore } from '@/lib/operations/table-store'
import { parseGuardarPlanDia } from '@/lib/operations/validation'
import {
  bloqueoPlanDia, diasParaAplicar, fijadasRestantes, planActualDe, resultadoDia, type EdicionPlanDia,
} from '@/lib/planificacion-plan-dia'
import { planWeek } from '@/lib/planning/engine'
import { planningInputFromDataset } from '@/lib/planning/input'
import { normalizeScenario } from '@/lib/planning/scenario'
import { buildDataset } from '@/lib/table'
import { FakeSheets } from './helpers/fake-sheets'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }))

/**
 * ORD-POS-140 (DEC-POS-029): `plan.dia.guardar` convierte los movimientos de la simulación en el plan registrado de cada
 * día (PLAN_DIARIO con VERSION y sus PLAN_ITEMS), una llamada por día, con confirmación previa, conflicto por día,
 * AUDITORIA por día, sin tocar TAREAS y sin reescribir días pasados. Datos sintéticos (fixtures) y escritura simulada.
 */

const ORIGIN = 'http://127.0.0.1:3000'
const PM_TOKEN = 'token-pm-de-prueba-sintetico-0123456789'
const TIEMPOS_TOKEN = 'token-tiempos-de-prueba-sintetico-0123456789'
const DUENO = 'dueno@example.com'
const OTRO = 'otro-escritor@example.com'
const HOY = '2026-11-03' // martes; DEMO-P1 es el plan de hoy (VERSION 1 tras la migración) y DEMO-P0 el de ayer
const MANANA = '2026-11-04'
const NOW = new Date('2026-11-03T16:30:00Z')
let seq = 0
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`
const sha = (t: string) => createHash('sha256').update(t).digest('hex')

const BASE = {
  NEXTAUTH_URL: ORIGIN, AUTH_ALLOWED_EMAILS: `${DUENO},${OTRO}`, AUTH_WRITER_EMAILS: `${DUENO},${OTRO}`,
  PROJECT_OS_WRITE_MODE: 'mock', DASHBOARD_DATA_SOURCE: 'fixtures', PM_AGENT_TOKEN_SHA256: sha(PM_TOKEN),
  TIEMPOS_AGENTE: 'true', TIEMPOS_AGENTE_TOKEN_SHA256: sha(TIEMPOS_TOKEN),
}
const ENCENDIDA = { ...BASE, PLANIFICACION_EDICION_PROPIETARIO: 'true', PLANIFICACION_EDICION_PROPIETARIO_EMAIL: DUENO }
const env = (extra: Record<string, string | undefined>) => extra as unknown as NodeJS.ProcessEnv

const humano = (body: unknown) => new Request(`${ORIGIN}/api/operaciones/plan-dia`, {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'x-project-os-csrf': '1' },
})
const conAuthorization = (authorization: string, body: unknown) => new Request(`${ORIGIN}/api/operaciones/plan-dia`, {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', authorization },
})
const ctx = (email: string | null, e: NodeJS.ProcessEnv, operation: OperationName = 'plan.dia.guardar') => ({
  email, env: e, limiter: new RateLimiter(), agentLimiter: new RateLimiter(5, 60_000), operation,
})

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await promise.then(() => undefined, (e: unknown) => e)
  return error instanceof OperationError ? error.code : undefined
}

/** Fixtures con o sin la migración VERSION de PLAN_DIARIO (filas existentes con VERSION = 1) y 20 h de capacidad. */
function seed(migrada = true): Record<string, unknown[][]> {
  const tabs = buildFixtureTabs(HOY) as Record<string, unknown[][]>
  const planes = tabs.PLAN_DIARIO!
  const cap = tabs.CAPACIDAD_SEMANAL!.map((row, i) => (i === 1 ? [row[0], row[1], '20', ...row.slice(3)] : row))
  return {
    ...tabs,
    CAPACIDAD_SEMANAL: cap,
    PLAN_DIARIO: migrada ? planes.map((row, i) => [...row, ...Array(7 - row.length).fill(''), i === 0 ? 'VERSION' : '1']) : planes,
    AUDITORIA: [[...WRITE_HEADERS.AUDITORIA]],
  }
}

const ADAPTERS: Array<[string, (migrada?: boolean) => TableStore]> = [
  ['InMemoryTableStore', (migrada = true) => new InMemoryTableStore(seed(migrada))],
  ['SheetsTableStore (servidor simulado)', (migrada = true) => {
    const fake = new FakeSheets('HOJA_DE_PRUEBA_SINTETICA_0123456789', seed(migrada))
    return new SheetsTableStore({ spreadsheetId: fake.spreadsheetId, getWriteToken: async () => 'token-falso', fetchImpl: fake.fetch })
  }],
]

async function registro(store: TableStore, tab: 'PLAN_DIARIO' | 'PLAN_ITEMS', id: string) {
  const view = await readView(store, tab)
  const rows = findById(view, tab === 'PLAN_DIARIO' ? 'PLAN_ID' : 'PLAN_ITEM_ID', id)
  return rows.length === 1 ? toRecord(view, rows[0]!.cells) : null
}
const filas = async (store: TableStore, tab: WriteTab) => (await store.readTable(tab)).length - 1
const cmd = (extra: Record<string, unknown>) => parseGuardarPlanDia({ requestId: uuid(), fecha: MANANA, items: [{ tareaId: 'DEMO-005', orden: 1, minutosPlan: 60 }], ...extra })
const dueno = { actor: DUENO }

describe('validación', () => {
  it('fecha, items (tarea, orden, minutos) y expectedVersion; estado y horasObjetivo ausentes no se tocan; null = vacío', () => {
    expect(cmd({})).toEqual({ requestId: expect.any(String), fecha: MANANA, items: [{ tareaId: 'DEMO-005', orden: 1, minutosPlan: 60 }] })
    expect(cmd({ estado: 'en_curso', horasObjetivo: '2,5', expectedVersion: 2 })).toMatchObject({ estado: 'EN_CURSO', horasObjetivo: '2.5', expectedVersion: 2 })
    expect(cmd({ estado: null, horasObjetivo: '' })).toMatchObject({ estado: null, horasObjetivo: null })
    expect(cmd({ items: [{ tareaId: 'demo-005', orden: '2', minutosPlan: 0 }] }).items).toEqual([{ tareaId: 'DEMO-005', orden: 2, minutosPlan: 0 }])
  })

  it.each([
    [{ fecha: '04/11/2026' }, 'fecha'], [{ items: [] }, 'items'], [{ items: 'DEMO-005' }, 'items'],
    [{ items: [{ tareaId: 'DEMO-005', orden: 1, minutosPlan: 1441 }] }, 'items.0.minutosPlan'],
    [{ items: [{ tareaId: 'DEMO-005', orden: 1, minutosPlan: -1 }] }, 'items.0.minutosPlan'],
    [{ items: [{ tareaId: 'DEMO-005', orden: 0, minutosPlan: 30 }] }, 'items.0.orden'],
    [{ items: [{ tareaId: 'no válido', orden: 1, minutosPlan: 30 }] }, 'items.0.tareaId'],
    [{ items: [{ tareaId: 'DEMO-005', orden: 1, minutosPlan: 30, notas: 'x' }] }, 'items.0.notas'],
    [{ items: [{ tareaId: 'DEMO-005', orden: 1, minutosPlan: 30 }, { tareaId: 'DEMO-005', orden: 2, minutosPlan: 30 }] }, 'items.1.tareaId'],
    [{ horasObjetivo: '25' }, 'horasObjetivo'], [{ expectedVersion: 0 }, 'expectedVersion'], [{ notas: 'no' }, 'notas'], [{ version: 2 }, 'version'],
  ])('rechaza %o', (extra, campo) => {
    const error = (() => { try { cmd(extra) } catch (e) { return e } })() as OperationError
    expect(error).toBeInstanceOf(OperationError)
    expect(error.code).toBe('validacion')
    expect(Object.keys(error.fields ?? {})).toContain(campo)
  })
})

describe('guard: solo el propietario con su bandera', () => {
  const body = () => ({ requestId: uuid(), fecha: MANANA, items: [{ tareaId: 'DEMO-005', orden: 1, minutosPlan: 60 }] })

  it('apagada: 403; encendida: solo el propietario; otro escritor 403, sin leer el cuerpo', async () => {
    expect(await codeOf(evaluateWriteRequest(humano(body()), ctx(DUENO, env(BASE))))).toBe('operacion-no-permitida')
    expect((await evaluateWriteRequest(humano(body()), ctx(DUENO, env(ENCENDIDA)))).actor).toBe(DUENO)
    expect(await codeOf(evaluateWriteRequest(humano('{roto'), ctx(OTRO, env(ENCENDIDA))))).toBe('operacion-no-permitida')
  })

  it('el token del PM, el de Tiempos y cualquier Authorization: 403 aun con la bandera; el proxy pide sesión', async () => {
    for (const authorization of [`Bearer ${PM_TOKEN}`, `Bearer ${TIEMPOS_TOKEN}`, 'Bearer otro', '']) {
      expect(await codeOf(evaluateWriteRequest(conAuthorization(authorization, '{roto'), ctx(DUENO, env(ENCENDIDA)))), authorization).toBe('operacion-no-permitida')
    }
    expect(OWNER_PLANNING_OPERATIONS).toEqual(['capacidad.registrar', 'plan.dia.guardar', 'escenario.guardar', 'escenario.archivar']) // + ORD-POS-141
    expect(AGENT_OPERATIONS).not.toContain('plan.dia.guardar')
    for (const token of [PM_TOKEN, TIEMPOS_TOKEN]) {
      const req = new NextRequest(new URL('/api/operaciones/plan-dia', ORIGIN), { method: 'POST', headers: { authorization: `Bearer ${token}` } })
      expect((await decide(req, { secret: 'secreto-de-prueba-0123456789abcdef', agentTokenSha256: sha(PM_TOKEN), tiemposEnv: env(ENCENDIDA) })).action, token).toBe('unauthenticated')
    }
  })
})

describe.each(ADAPTERS)('servicio — %s', (_name, make) => {
  let store: TableStore
  let service: OperationsService
  beforeEach(() => {
    store = make()
    service = new OperationsService(store, { mode: 'mock', clock: () => NOW })
  })

  it('sin la migración VERSION de PLAN_DIARIO: 422 migracion-pendiente y no escribe nada, ni AUDITORIA', async () => {
    store = make(false)
    service = new OperationsService(store, { mode: 'mock', clock: () => NOW })
    const error = await service.guardarPlanDia(cmd({}), dueno).catch((e: unknown) => e) as OperationError
    expect(error.code).toBe('migracion-pendiente')
    expect(error.status).toBe(422)
    expect([await filas(store, 'PLAN_DIARIO'), await filas(store, 'PLAN_ITEMS'), await filas(store, 'AUDITORIA')]).toEqual([2, 3, 0])
  })

  it('criterio 1: alta del día con VERSION 1 y su PLAN_ITEMS (IDs estables); criterio 4: TAREAS intacta y AUDITORIA del día', async () => {
    const tareas = await store.readTable('TAREAS')
    const r = await service.guardarPlanDia(cmd({}), dueno)
    expect(r).toMatchObject({ operacion: 'plan.dia.guardar', entidad: 'PLAN_DIARIO', id: `PLAN-${MANANA}`, version: 1, repetida: false })
    expect(await registro(store, 'PLAN_DIARIO', `PLAN-${MANANA}`)).toMatchObject({ FECHA: MANANA, ESTADO: '', HORAS_OBJETIVO: '', SEMANA_ID: '', NOTAS: '', VERSION: '1' })
    expect(await registro(store, 'PLAN_ITEMS', `PLAN-${MANANA}-DEMO-005`)).toMatchObject({ PLAN_ID: `PLAN-${MANANA}`, TAREA_ID: 'DEMO-005', ORDEN: '1', MINUTOS_PLAN: '60', RESULTADO_ESPERADO: '' })
    expect(await store.readTable('TAREAS')).toEqual(tareas)
    const ops = parseAudit(await readView(store, 'AUDITORIA'))
    expect(ops.map((o) => [o.entidad, o.id, o.integridad])).toEqual([['PLAN_DIARIO', `PLAN-${MANANA}`, 'completa'], ['PLAN_ITEMS', `PLAN-${MANANA}-DEMO-005`, 'completa']])
    expect(ops[0]!.fields.get('VERSION')).toEqual({ antes: '', despues: '1' })
    expect(ops[0]!.fields.has('HORAS_OBJETIVO')).toBe(false) // vacío no se audita como 0
    expect(ops[1]!.fields.get('MINUTOS_PLAN')).toEqual({ antes: '', despues: '60' })
    expect(ops.every((o) => o.operacion === 'plan.dia.guardar')).toBe(true)
    const audit = await store.readTable('AUDITORIA')
    expect(audit.slice(1).every((row) => row[2] === DUENO && !String(row[8]).includes('agente=pm'))).toBe(true)
    expect(audit.slice(1).some((row) => row[3] === 'TAREAS')).toBe(false)
  })

  it('edición del plan de hoy con expectedVersion: actualiza y agrega elementos, sube VERSION, no toca los demás', async () => {
    const intacto = await registro(store, 'PLAN_ITEMS', 'DEMO-PI2')
    const r = await service.guardarPlanDia(cmd({ fecha: HOY, expectedVersion: 1, items: [{ tareaId: 'DEMO-002', orden: 1, minutosPlan: 180 }, { tareaId: 'DEMO-005', orden: 3, minutosPlan: 45 }] }), dueno)
    expect(r).toMatchObject({ id: 'DEMO-P1', version: 2, repetida: false })
    expect(await registro(store, 'PLAN_DIARIO', 'DEMO-P1')).toMatchObject({ VERSION: '2', ESTADO: 'EN_CURSO', HORAS_OBJETIVO: '3', NOTAS: 'Plan demo de hoy' })
    expect(await registro(store, 'PLAN_ITEMS', 'DEMO-PI1')).toMatchObject({ MINUTOS_PLAN: '180', ORDEN: '1', RESULTADO_ESPERADO: 'Vista de tareas filtrable' })
    expect(await registro(store, 'PLAN_ITEMS', 'DEMO-P1-DEMO-005')).toMatchObject({ PLAN_ID: 'DEMO-P1', MINUTOS_PLAN: '45', ORDEN: '3' })
    expect(await registro(store, 'PLAN_ITEMS', 'DEMO-PI2')).toEqual(intacto)
    const ops = parseAudit(await readView(store, 'AUDITORIA'))
    expect(ops.map((o) => [o.entidad, o.id])).toEqual([['PLAN_DIARIO', 'DEMO-P1'], ['PLAN_ITEMS', 'DEMO-PI1'], ['PLAN_ITEMS', 'DEMO-P1-DEMO-005']])
    expect(ops[0]!.fields.get('VERSION')).toEqual({ antes: '1', despues: '2' })
    expect(ops[1]!.fields.get('MINUTOS_PLAN')).toEqual({ antes: '120', despues: '180' })
    expect(ops[1]!.fields.has('ORDEN')).toBe(false)
    expect(ops.every((o) => o.integridad === 'completa')).toBe(true)
  })

  it('criterio 3: conflicto de versión en un día no guarda ese día, devuelve el plan actual, y el otro día sigue', async () => {
    const antes = [await store.readTable('PLAN_DIARIO'), await store.readTable('PLAN_ITEMS')]
    const error = await service.guardarPlanDia(cmd({ fecha: HOY, expectedVersion: 7 }), dueno).catch((e: unknown) => e) as OperationError
    expect(error.code).toBe('conflicto-version')
    expect(error.status).toBe(409)
    expect(error.detail).toMatchObject({ versionActual: 1, planActual: { planId: 'DEMO-P1', version: 1, items: [
      { tareaId: 'DEMO-003', orden: '2', minutosPlan: '30' }, { tareaId: 'DEMO-002', orden: '1', minutosPlan: '120' },
    ] } })
    expect([await store.readTable('PLAN_DIARIO'), await store.readTable('PLAN_ITEMS')]).toEqual(antes)
    expect(await filas(store, 'AUDITORIA')).toBe(0)
    // Alta de un día que ya tiene plan (otra pestaña lo creó): también es conflicto, con el plan actual.
    const alta = await service.guardarPlanDia(cmd({ fecha: HOY }), dueno).catch((e: unknown) => e) as OperationError
    expect(alta.code).toBe('conflicto-version')
    expect(planActualDe(alta.detail)).toMatchObject({ planId: 'DEMO-P1', version: 1 })
    // El otro día de la misma aplicación sigue su curso.
    expect(await service.guardarPlanDia(cmd({}), dueno)).toMatchObject({ id: `PLAN-${MANANA}`, version: 1 })
  })

  it('criterio 5: días pasados no se reescriben (dia-pasado) y no se escribe nada', async () => {
    const error = await service.guardarPlanDia(cmd({ fecha: '2026-11-02', expectedVersion: 1 }), dueno).catch((e: unknown) => e) as OperationError
    expect(error.code).toBe('dia-pasado')
    expect(error.status).toBe(422)
    expect(await filas(store, 'AUDITORIA')).toBe(0)
  })

  it('solo tareas abiertas existentes; sin cambios = sin-cambios; elemento repetido o dos planes activos = 409', async () => {
    expect(await codeOf(service.guardarPlanDia(cmd({ items: [{ tareaId: 'DEMO-001', orden: 1, minutosPlan: 30 }] }), dueno))).toBe('tarea-cerrada')
    expect(await codeOf(service.guardarPlanDia(cmd({ items: [{ tareaId: 'DEMO-999', orden: 1, minutosPlan: 30 }] }), dueno))).toBe('tarea-inexistente')
    expect(await codeOf(service.guardarPlanDia(cmd({ fecha: HOY, expectedVersion: 1, items: [{ tareaId: 'DEMO-002', orden: 1, minutosPlan: 120 }] }), dueno))).toBe('sin-cambios')
    await store.appendRows('PLAN_ITEMS', [['DEMO-PI9', 'DEMO-P1', 'DEMO-002', '4', '15']])
    expect(await codeOf(service.guardarPlanDia(cmd({ fecha: HOY, expectedVersion: 1, items: [{ tareaId: 'DEMO-002', orden: 1, minutosPlan: 200 }] }), dueno))).toBe('plan-item-duplicado')
    await store.appendRows('PLAN_DIARIO', [['DEMO-P2', HOY, '', 'BORRADOR', '', '', '', '1']])
    expect(await codeOf(service.guardarPlanDia(cmd({ fecha: HOY, expectedVersion: 1 }), dueno))).toBe('plan-diario-duplicado')
    expect(await filas(store, 'AUDITORIA')).toBe(0)
  })

  it('un plan sin VERSION no se edita (version-faltante); un plan cancelado no cuenta como activo', async () => {
    await store.appendRows('PLAN_DIARIO', [['DEMO-P3', MANANA, '', 'BORRADOR', '', '', '', '']])
    expect(await codeOf(service.guardarPlanDia(cmd({ expectedVersion: 1 }), dueno))).toBe('version-faltante')
    store = make()
    service = new OperationsService(store, { mode: 'mock', clock: () => NOW })
    await store.appendRows('PLAN_DIARIO', [['DEMO-P4', MANANA, '', 'CANCELADO', '', '', '', '3']])
    expect(await service.guardarPlanDia(cmd({}), dueno)).toMatchObject({ id: `PLAN-${MANANA}`, version: 1 })
  })

  it('idempotencia: el mismo requestId y cuerpo devuelve repetida sin filas nuevas; otro cuerpo, conflicto-idempotencia', async () => {
    const c = cmd({})
    await service.guardarPlanDia(c, dueno)
    const conteo = [await filas(store, 'PLAN_DIARIO'), await filas(store, 'PLAN_ITEMS'), await filas(store, 'AUDITORIA')]
    expect(await service.guardarPlanDia(c, dueno)).toMatchObject({ id: `PLAN-${MANANA}`, version: 1, repetida: true })
    expect([await filas(store, 'PLAN_DIARIO'), await filas(store, 'PLAN_ITEMS'), await filas(store, 'AUDITORIA')]).toEqual(conteo)
    expect(await codeOf(service.guardarPlanDia({ ...c, items: [{ tareaId: 'DEMO-005', orden: 1, minutosPlan: 90 }] }, dueno))).toBe('conflicto-idempotencia')
  })
})

/** Almacén que falla una vez al escribir en una pestaña: simula una caída entre la auditoría y la entidad. */
class FallaUnaVez extends InMemoryTableStore {
  constructor(initial: Record<string, unknown[][]>, private tab: WriteTab | null) { super(initial) }
  override async appendRows(tab: WriteTab, rows: string[][]) {
    if (tab === this.tab) { this.tab = null; throw new Error('caída') }
    return super.appendRows(tab, rows)
  }
  override async writeRow(tab: WriteTab, sheetRow: number, row: string[]) {
    if (tab === this.tab) { this.tab = null; throw new Error('caída') }
    return super.writeRow(tab, sheetRow, row)
  }
}

describe('roll-forward (§11.4): un reintento con el mismo requestId completa lo auditado', () => {
  it.each([['PLAN_ITEMS'], ['PLAN_DIARIO']] as const)('caída al escribir %s en un alta: el reintento la completa sin duplicar', async (tab) => {
    const store = new FallaUnaVez(seed(), tab)
    const service = new OperationsService(store, { mode: 'mock', clock: () => NOW })
    const c = cmd({})
    expect(await codeOf(service.guardarPlanDia(c, dueno))).toBe('escritura-fallida')
    expect(await service.guardarPlanDia(c, dueno)).toMatchObject({ id: `PLAN-${MANANA}`, version: 1, repetida: true })
    expect(await registro(store, 'PLAN_DIARIO', `PLAN-${MANANA}`)).toMatchObject({ VERSION: '1' })
    expect(await registro(store, 'PLAN_ITEMS', `PLAN-${MANANA}-DEMO-005`)).toMatchObject({ MINUTOS_PLAN: '60' })
    expect(await filas(store, 'PLAN_DIARIO')).toBe(3)
    expect(await filas(store, 'PLAN_ITEMS')).toBe(4)
  })

  it('caída al escribir el plan en una edición: los elementos ya escritos se dan por hechos y el plan sube a VERSION 2', async () => {
    const store = new FallaUnaVez(seed(), 'PLAN_DIARIO')
    const service = new OperationsService(store, { mode: 'mock', clock: () => NOW })
    const c = cmd({ fecha: HOY, expectedVersion: 1, items: [{ tareaId: 'DEMO-002', orden: 1, minutosPlan: 150 }] })
    expect(await codeOf(service.guardarPlanDia(c, dueno))).toBe('escritura-fallida')
    expect(await registro(store, 'PLAN_ITEMS', 'DEMO-PI1')).toMatchObject({ MINUTOS_PLAN: '150' })
    expect(await registro(store, 'PLAN_DIARIO', 'DEMO-P1')).toMatchObject({ VERSION: '1' })
    expect(await service.guardarPlanDia(c, dueno)).toMatchObject({ id: 'DEMO-P1', version: 2, repetida: true })
    expect(await registro(store, 'PLAN_DIARIO', 'DEMO-P1')).toMatchObject({ VERSION: '2' })
  })
})

/* ----------------------------------- Vista: qué se escribe ----------------------------------- */

/** Con una tarea abierta sintética estimada (DEMO-006, 2 h) que el motor propone esta semana. */
function seedVista(): Record<string, unknown[][]> {
  const tabs = seed()
  return { ...tabs, TAREAS: [...tabs.TAREAS!, ['DEMO-006', 'POS', '', 'Tarea demo estimada', '', 'DESARROLLO', 'PENDIENTE', 'ALTA', '', '', '', '2', '', '', '1', '']] }
}

const MIGRADA: EdicionPlanDia = { migrada: true, versiones: { 'DEMO-P1': 1, 'DEMO-P0': 1 } }

function vista(tabs: Record<string, unknown[][]> = seedVista(), fijadas: Record<string, string> = {}) {
  const input = planningInputFromDataset(buildDataset(tabs, { source: 'fixtures', fetchedAt: NOW.getTime() }))
  const plan = planWeek(input, normalizeScenario({ fijadas }), { referenceDate: HOY, timeZone: 'America/Merida' })
  return { input, plan }
}

describe('diasParaAplicar (criterio 2: lo que se escribirá por día)', () => {
  it('sin movimientos no hay nada que aplicar', () => {
    const { input, plan } = vista()
    expect(diasParaAplicar(plan, input, MIGRADA)).toEqual([])
  })

  it('un bloque movido a un día sin plan: alta del plan con ese elemento; a hoy: suma a lo ya registrado con su versión', () => {
    const base = vista()
    const candidata = base.plan.dias.flatMap((d) => d.items).find((i) => i.tareaId !== 'DEMO-002' && i.tareaId !== 'DEMO-003')
    expect(candidata, 'los fixtures deben proponer alguna tarea').toBeDefined()
    const { input, plan } = vista(seedVista(), { [candidata!.tareaId]: MANANA })
    const [dia] = diasParaAplicar(plan, input, MIGRADA)
    expect(dia).toMatchObject({ tipo: 'listo', fecha: MANANA, planId: `PLAN-${MANANA}`, nuevo: true, version: null })
    if (dia?.tipo !== 'listo') return
    expect(dia.cuerpo).toEqual({ fecha: MANANA, items: [{ tareaId: candidata!.tareaId, orden: 1, minutosPlan: dia.elementos[0]!.minutosMovidos }] })
    expect(dia.cuerpo).not.toHaveProperty('expectedVersion')

    const hoy = vista(seedVista(), { [candidata!.tareaId]: HOY })
    const [d2] = diasParaAplicar(hoy.plan, hoy.input, MIGRADA)
    expect(d2).toMatchObject({ tipo: 'listo', fecha: HOY, planId: 'DEMO-P1', nuevo: false, version: 1 })
    if (d2?.tipo !== 'listo') return
    expect(d2.cuerpo.expectedVersion).toBe(1)
    expect(d2.elementos[0]).toMatchObject({ minutosAntes: null, orden: 3 }) // después de los ORDEN 1 y 2 registrados
  })

  it('sin migración, con PLAN_ITEMS incompleta o un plan sin VERSION: bloqueado con su motivo', () => {
    const { input, plan } = vista()
    expect(bloqueoPlanDia(input, { migrada: false, versiones: {} })).toMatch(/migración/)
    expect(bloqueoPlanDia({ ...input, pestanasNoDisponibles: ['PLAN_ITEMS'] }, MIGRADA)).toMatch(/PLAN_ITEMS/)
    expect(bloqueoPlanDia(input, MIGRADA)).toBeNull()
    const candidata = plan.dias.flatMap((d) => d.items).find((i) => i.tareaId !== 'DEMO-002' && i.tareaId !== 'DEMO-003')!
    const hoy = vista(seedVista(), { [candidata.tareaId]: HOY })
    expect(diasParaAplicar(hoy.plan, hoy.input, { migrada: true, versiones: { 'DEMO-P1': null } })[0]).toMatchObject({ tipo: 'bloqueado', motivo: expect.stringContaining('VERSION') })
  })

  it('resultados: guardado, conflicto con el plan actual y error; los días guardados salen de la simulación', () => {
    expect(resultadoDia(MANANA, { ok: true, id: `PLAN-${MANANA}`, version: 1, repetida: false })).toEqual({ tipo: 'guardado', fecha: MANANA, planId: `PLAN-${MANANA}`, version: 1, repetida: false })
    const conflicto = resultadoDia(HOY, { ok: false, error: { codigo: 'conflicto-version', mensaje: 'cambió', detalle: { versionActual: 2, planActual: { planId: 'DEMO-P1', version: 2, items: [{ tareaId: 'DEMO-002', orden: '1', minutosPlan: '' }] } } } })
    expect(conflicto).toMatchObject({ tipo: 'conflicto', planActual: { planId: 'DEMO-P1', version: 2, items: [{ tareaId: 'DEMO-002', minutosPlan: '' }] } })
    expect(resultadoDia(HOY, null)).toMatchObject({ tipo: 'error', codigo: 'error' })
    const r = [resultadoDia(MANANA, { ok: true, id: 'X', version: 1 }), conflicto]
    expect(fijadasRestantes({ 'DEMO-005': MANANA, 'DEMO-002': HOY }, r)).toEqual({ 'DEMO-002': HOY })
  })

  it('la vista no escribe sin confirmar: el botón abre la lista, no envía nada', () => {
    const base = vista()
    const candidata = base.plan.dias.flatMap((d) => d.items).find((i) => i.tareaId !== 'DEMO-002' && i.tareaId !== 'DEMO-003')!
    const { input, plan } = vista(seedVista(), { [candidata.tareaId]: MANANA })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const html = renderToStaticMarkup(createElement(AplicarPlan, { plan, input, edicion: MIGRADA, onGuardados: () => undefined }))
    expect(html).toContain('Aplicar movimientos al plan…')
    expect(html).not.toContain('Confirmar y guardar')
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
    const sinMigrar = renderToStaticMarkup(createElement(AplicarPlan, { plan, input, edicion: { migrada: false, versiones: {} }, onGuardados: () => undefined }))
    expect(sinMigrar).toContain('Falta la migración')
  })
})

describe('el motor respeta lo guardado', () => {
  it('tras guardar el movimiento, el plan registrado reserva esos minutos y la tarea ya no se vuelve a proponer', async () => {
    const store = new InMemoryTableStore(seedVista())
    const service = new OperationsService(store, { mode: 'mock', clock: () => NOW })
    const base = vista()
    const candidata = base.plan.dias.flatMap((d) => d.items).find((i) => i.tareaId !== 'DEMO-002' && i.tareaId !== 'DEMO-003')!
    const movida = vista(seedVista(), { [candidata.tareaId]: MANANA })
    const [dia] = diasParaAplicar(movida.plan, movida.input, MIGRADA)
    if (dia?.tipo !== 'listo') throw new Error('día no listo')
    await service.guardarPlanDia(parseGuardarPlanDia({ ...dia.cuerpo, requestId: uuid() }), dueno)
    const tabs = Object.fromEntries(await Promise.all(Object.keys(seedVista()).map(async (t) => [t, await store.readTable(t as WriteTab)])))
    const despues = vista(tabs)
    const manana = despues.plan.dias.find((d) => d.fecha === MANANA)!
    expect(manana.planRegistrado).toBe(`PLAN-${MANANA}`)
    expect(manana.planExistenteMin).toBeGreaterThanOrEqual(dia.elementos[0]!.minutosPlan)
    expect(despues.plan.tareas.find((t) => t.id === candidata.tareaId)!.yaPlanificadoMin).toBe(dia.elementos[0]!.minutosPlan)
  })
})
