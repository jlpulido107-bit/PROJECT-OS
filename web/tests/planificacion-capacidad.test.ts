import { createHash } from 'node:crypto'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EstadoGuardado } from '@/components/operations/estado-guardado'
import { CapaSemana } from '@/components/planning/capa-semana'
import { CapacidadSemana } from '@/components/planning/capacidad-semana'
import { decide } from '@/lib/authz'
import { buildFixtureTabs } from '@/lib/fixtures'
import { AGENT_OPERATIONS, OWNER_PLANNING_OPERATIONS, WRITE_HEADERS, type OperationName, type WriteTab } from '@/lib/operations/constants'
import { OperationError } from '@/lib/operations/errors'
import { evaluateWriteRequest } from '@/lib/operations/guard'
import { RateLimiter } from '@/lib/operations/rate-limit'
import { OperationsService, parseAudit } from '@/lib/operations/service'
import { SheetsTableStore } from '@/lib/operations/sheets-table-store'
import { findById, InMemoryTableStore, readView, toRecord, type TableStore } from '@/lib/operations/table-store'
import { parseRegistrarCapacidad } from '@/lib/operations/validation'
import {
  bloqueoCapacidad, capacidadSemana, cuerpoCapacidad, textoCapacidad, type EdicionCapacidad, type ObjetivoCapacidad,
} from '@/lib/planificacion-capacidad'
import type { EdicionSemana } from '@/lib/planificacion-edicion'
import { diasSemana } from '@/lib/planificacion-semana'
import { planWeek } from '@/lib/planning/engine'
import { planningInputFromDataset } from '@/lib/planning/input'
import { DEFAULT_SCENARIO } from '@/lib/planning/scenario'
import { buildDataset } from '@/lib/table'
import { FakeSheets } from './helpers/fake-sheets'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }))

/**
 * ORD-POS-139 (DEC-POS-029 c): `capacidad.registrar` crea o edita la fila de la semana en CAPACIDAD_SEMANAL, solo la
 * sesión del propietario con PLANIFICACION_EDICION_PROPIETARIO, con VERSION (migración de §11.2) y AUDITORIA.
 */

const ORIGIN = 'http://127.0.0.1:3000'
const PM_TOKEN = 'token-pm-de-prueba-sintetico-0123456789'
const TIEMPOS_TOKEN = 'token-tiempos-de-prueba-sintetico-0123456789'
const DUENO = 'dueno@example.com'
const OTRO = 'otro-escritor@example.com'
const HOY = '2026-11-03' // martes: la semana de la vista va del lunes 2026-11-02 al domingo 2026-11-08
const NOW = new Date('2026-11-03T16:30:00Z')
const SEMANA = 'DEMO-2026-11-02' // fila de la semana actual en los fixtures: horas vacías, reserva 0.15, BORRADOR
const ANTERIOR = 'DEMO-2026-10-26' // semana anterior: 20 h, 15%, APROBADA
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

const humano = (body: unknown) => new Request(`${ORIGIN}/api/operaciones/capacidad`, {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'x-project-os-csrf': '1' },
})
const conAuthorization = (authorization: string, body: unknown) => new Request(`${ORIGIN}/api/operaciones/capacidad`, {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', authorization },
})
const ctx = (email: string | null, e: NodeJS.ProcessEnv, operation: OperationName = 'capacidad.registrar') => ({
  email, env: e, limiter: new RateLimiter(), agentLimiter: new RateLimiter(5, 60_000), operation,
})

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await promise.then(() => undefined, (e: unknown) => e)
  return error instanceof OperationError ? error.code : undefined
}

/** Fixtures con o sin la migración VERSION de CAPACIDAD_SEMANAL (las filas existentes con VERSION = 1). */
function seed(migrada = true): Record<string, unknown[][]> {
  const tabs = buildFixtureTabs(HOY) as Record<string, unknown[][]>
  const cap = tabs.CAPACIDAD_SEMANAL!
  return {
    ...tabs,
    CAPACIDAD_SEMANAL: migrada ? cap.map((row, i) => [...row, ...Array(7 - row.length).fill(''), i === 0 ? 'VERSION' : '1']) : cap,
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

async function fila(store: TableStore, id: string) {
  const view = await readView(store, 'CAPACIDAD_SEMANAL')
  const rows = findById(view, 'SEMANA_ID', id)
  return rows.length === 1 ? toRecord(view, rows[0]!.cells) : null
}
const filas = async (store: TableStore, tab: WriteTab) => (await store.readTable(tab)).length - 1
const cmd = (extra: Record<string, unknown>) => parseRegistrarCapacidad({ requestId: uuid(), semanaId: SEMANA, fechaInicio: '2026-11-02', ...extra })

describe('validación (criterio 2)', () => {
  it('horas 0–168 y reserva 0–100; vacío o null queda null, nunca 0; 0 explícito es 0', () => {
    expect(cmd({ horasDisponibles: '20', reservaPct: 15, estado: 'aprobada' })).toMatchObject({ horasDisponibles: '20', reservaPct: '15', estado: 'APROBADA' })
    expect(cmd({ horasDisponibles: '', reservaPct: null })).toMatchObject({ horasDisponibles: null, reservaPct: null, estado: null })
    expect(cmd({})).toMatchObject({ horasDisponibles: null, reservaPct: null })
    expect(cmd({ horasDisponibles: 0, reservaPct: '0' })).toMatchObject({ horasDisponibles: '0', reservaPct: '0' })
    expect(cmd({ horasDisponibles: '168', reservaPct: '100' })).toMatchObject({ horasDisponibles: '168', reservaPct: '100' })
    expect(cmd({ horasDisponibles: '12,5' }).horasDisponibles).toBe('12.5')
    expect(cmd({}).expectedVersion).toBeUndefined()
    expect(cmd({ expectedVersion: 3 }).expectedVersion).toBe(3)
  })

  it.each([
    [{ horasDisponibles: '168.01' }, 'horasDisponibles'], [{ horasDisponibles: -1 }, 'horasDisponibles'], [{ horasDisponibles: 'veinte' }, 'horasDisponibles'],
    [{ reservaPct: '100.5' }, 'reservaPct'], [{ reservaPct: '-5' }, 'reservaPct'], [{ reservaPct: '15%' }, 'reservaPct'],
    [{ notas: 'no' }, 'notas'], [{ version: 2 }, 'version'], [{ expectedVersion: 0 }, 'expectedVersion'], [{ expectedVersion: '2' }, 'expectedVersion'],
    [{ semanaId: 'con espacios' }, 'semanaId'], [{ fechaInicio: '02/11/2026' }, 'fechaInicio'], [{ estado: 'aprobada!' }, 'estado'],
  ])('rechaza %o', (extra, campo) => {
    const error = (() => { try { cmd(extra) } catch (e) { return e } })() as OperationError
    expect(error).toBeInstanceOf(OperationError)
    expect(error.code).toBe('validacion')
    expect(Object.keys(error.fields ?? {})).toContain(campo)
  })
})

describe('guard: solo el propietario con su bandera (criterio 3)', () => {
  const body = () => ({ requestId: uuid(), semanaId: SEMANA, fechaInicio: '2026-11-02', horasDisponibles: '20' })

  it('bandera apagada (o mal escrita): el propietario recibe 403 operacion-no-permitida', async () => {
    expect(await codeOf(evaluateWriteRequest(humano(body()), ctx(DUENO, env(BASE))))).toBe('operacion-no-permitida')
    for (const valor of ['TRUE', 'on', '1']) {
      expect(await codeOf(evaluateWriteRequest(humano(body()), ctx(DUENO, env({ ...ENCENDIDA, PLANIFICACION_EDICION_PROPIETARIO: valor })))), valor).toBe('operacion-no-permitida')
    }
  })

  it('bandera encendida: pasa solo la sesión del propietario; otro escritor recibe 403', async () => {
    expect((await evaluateWriteRequest(humano(body()), ctx(DUENO, env(ENCENDIDA)))).actor).toBe(DUENO)
    expect(await codeOf(evaluateWriteRequest(humano(body()), ctx(OTRO, env(ENCENDIDA))))).toBe('operacion-no-permitida')
  })

  it('apagada o con otro escritor no lee el cuerpo: un JSON roto sigue siendo 403, no 400', async () => {
    expect(await codeOf(evaluateWriteRequest(humano('{roto'), ctx(DUENO, env(BASE))))).toBe('operacion-no-permitida')
    expect(await codeOf(evaluateWriteRequest(humano('{roto'), ctx(OTRO, env(ENCENDIDA))))).toBe('operacion-no-permitida')
    expect(await codeOf(evaluateWriteRequest(humano('{roto'), ctx(DUENO, env(ENCENDIDA))))).toBe('json-invalido')
  })

  it('el token del PM y el de Tiempos (válidos) y cualquier otro Authorization reciben 403, aun con la bandera', async () => {
    for (const authorization of [`Bearer ${PM_TOKEN}`, `Bearer ${TIEMPOS_TOKEN}`, 'Bearer otro', 'Basic abc', '']) {
      expect(await codeOf(evaluateWriteRequest(conAuthorization(authorization, '{roto'), ctx(DUENO, env(ENCENDIDA)))), authorization).toBe('operacion-no-permitida')
    }
    expect(OWNER_PLANNING_OPERATIONS).toContain('capacidad.registrar')
    expect(AGENT_OPERATIONS).not.toContain('capacidad.registrar')
  })

  it('el proxy no deja pasar sin sesión ni el token del PM ni el de Tiempos a /api/operaciones/capacidad', async () => {
    const e = env(ENCENDIDA)
    for (const token of [PM_TOKEN, TIEMPOS_TOKEN]) {
      const req = new NextRequest(new URL('/api/operaciones/capacidad', ORIGIN), { method: 'POST', headers: { authorization: `Bearer ${token}` } })
      expect((await decide(req, { secret: 'secreto-de-prueba-0123456789abcdef', agentTokenSha256: sha(PM_TOKEN), tiemposEnv: e })).action, token).toBe('unauthenticated')
    }
  })
})

describe.each(ADAPTERS)('servicio — %s (criterios 1, 2 y conflicto entre dos pestañas)', (_name, make) => {
  let store: TableStore
  let service: OperationsService
  beforeEach(() => {
    store = make()
    service = new OperationsService(store, { mode: 'mock', clock: () => NOW })
  })
  const dueno = { actor: DUENO }

  it('sin la migración VERSION: 422 migracion-pendiente y no escribe nada, ni AUDITORIA', async () => {
    store = make(false)
    service = new OperationsService(store, { mode: 'mock', clock: () => NOW })
    const antes = await store.readTable('CAPACIDAD_SEMANAL')
    const error = await service.registrarCapacidad(cmd({ horasDisponibles: '20', expectedVersion: 1 }), dueno).catch((e: unknown) => e) as OperationError
    expect(error.code).toBe('migracion-pendiente')
    expect(error.status).toBe(422)
    expect(await store.readTable('CAPACIDAD_SEMANAL')).toEqual(antes)
    expect(await filas(store, 'AUDITORIA')).toBe(0)
  })

  it('edición con expectedVersion: escribe solo esos campos, sube VERSION, conserva NOTAS y audita antes y después', async () => {
    const antes = (await fila(store, SEMANA))!
    const r = await service.registrarCapacidad(cmd({ horasDisponibles: '25.5', reservaPct: '20', estado: 'APROBADA', expectedVersion: 1 }), dueno)
    expect(r).toMatchObject({ operacion: 'capacidad.registrar', entidad: 'CAPACIDAD_SEMANAL', id: SEMANA, version: 2, repetida: false })
    expect(await fila(store, SEMANA)).toMatchObject({
      HORAS_DISPONIBLES: '25.5', RESERVA_PCT: '20%', ESTADO: 'APROBADA', VERSION: '2', NOTAS: antes.NOTAS, FECHA_INICIO: '2026-11-02',
    })
    const [op] = parseAudit(await readView(store, 'AUDITORIA'))
    expect(op).toMatchObject({ operacion: 'capacidad.registrar', entidad: 'CAPACIDAD_SEMANAL', id: SEMANA, integridad: 'completa' })
    expect(op!.fields.get('HORAS_DISPONIBLES')).toEqual({ antes: '', despues: '25.5' })
    expect(op!.fields.get('RESERVA_PCT')).toEqual({ antes: '0.15', despues: '20%' })
    expect(op!.fields.get('ESTADO')).toEqual({ antes: 'BORRADOR', despues: 'APROBADA' })
    expect(op!.fields.get('VERSION')).toEqual({ antes: '1', despues: '2' })
    expect(op!.fields.has('NOTAS')).toBe(false)
    expect(op!.fields.has('FECHA_INICIO')).toBe(false)
    const audit = await store.readTable('AUDITORIA')
    expect(audit.slice(1).every((row) => row[2] === DUENO && !String(row[8]).includes('agente=pm'))).toBe(true)
  })

  it('alta si la semana no existe: fila nueva con VERSION 1, vacíos vacíos, y AUDITORIA de la creación', async () => {
    const r = await service.registrarCapacidad(parseRegistrarCapacidad({
      requestId: uuid(), semanaId: '2026-w46', fechaInicio: '2026-11-09', horasDisponibles: '18', reservaPct: '',
    }), dueno)
    expect(r).toMatchObject({ entidad: 'CAPACIDAD_SEMANAL', id: '2026-W46', version: 1, repetida: false })
    expect(await fila(store, '2026-W46')).toMatchObject({
      SEMANA_ID: '2026-W46', FECHA_INICIO: '2026-11-09', HORAS_DISPONIBLES: '18', RESERVA_PCT: '', ESTADO: '', NOTAS: '', VERSION: '1',
    })
    const [op] = parseAudit(await readView(store, 'AUDITORIA'))
    expect(op).toMatchObject({ id: '2026-W46', integridad: 'completa' })
    expect(op!.fields.get('SEMANA_ID')).toEqual({ antes: '', despues: '2026-W46' })
    expect(op!.fields.get('VERSION')).toEqual({ antes: '', despues: '1' })
    expect(op!.fields.has('RESERVA_PCT')).toBe(false) // vacío: no se audita como 0
  })

  it('vacío se guarda vacío: la hoja queda sin valor y la vista dice «sin capacidad registrada», nunca 0', async () => {
    await service.registrarCapacidad(cmd({ horasDisponibles: '20', reservaPct: '10', expectedVersion: 1 }), dueno)
    await service.registrarCapacidad(cmd({ horasDisponibles: '', reservaPct: null, expectedVersion: 2 }), dueno)
    expect(await fila(store, SEMANA)).toMatchObject({ HORAS_DISPONIBLES: '', RESERVA_PCT: '', VERSION: '3' })
    const ds = buildDataset(Object.fromEntries(await Promise.all(Object.keys(seed()).map(async (t) => [t, await store.readTable(t as WriteTab)]))), { source: 'fixtures', fetchedAt: NOW.getTime() })
    expect(ds.capacidad.find((c) => c.id === SEMANA)).toMatchObject({ horasDisponibles: null, reservaPct: null, version: '3' })
    const input = planningInputFromDataset(ds)
    const plan = planWeek(input, DEFAULT_SCENARIO, { referenceDate: HOY, timeZone: 'America/Merida' })
    const dias = diasSemana(plan, input.pestanasNoDisponibles)
    expect(dias).toEqual({ estado: 'sin-datos', motivo: expect.stringContaining('sin capacidad registrada') })
    const objetivo = capacidadSemana(input, plan.referencia.lunes, plan.referencia.domingo)
    const html = renderToStaticMarkup(createElement(CapacidadSemana, { objetivo, edicion: { encendida: false } }))
    expect(html).toContain('Horas disponibles: Sin capacidad registrada')
    expect(html).toContain('Reserva (%): Sin reserva registrada')
    expect(html).not.toMatch(/: 0 h|: 0 %/)
  })

  it('tras guardar, la capacidad de la semana y las barras se recalculan con lo guardado', async () => {
    const leer = async () => {
      const ds = buildDataset(Object.fromEntries(await Promise.all(Object.keys(seed()).map(async (t) => [t, await store.readTable(t as WriteTab)]))), { source: 'fixtures', fetchedAt: NOW.getTime() })
      const input = planningInputFromDataset(ds)
      return { input, plan: planWeek(input, DEFAULT_SCENARIO, { referenceDate: HOY, timeZone: 'America/Merida' }) }
    }
    const antes = await leer()
    expect(antes.plan.capacidad.origen).toBe('faltante')
    await service.registrarCapacidad(cmd({ horasDisponibles: '20', reservaPct: '25', estado: 'APROBADA', expectedVersion: 1 }), dueno)
    const despues = await leer()
    expect(despues.plan.capacidad).toMatchObject({ origen: 'dato', horasDisponibles: 20, reservaPct: 25, netaMin: 900 })
    const dias = diasSemana(despues.plan, despues.input.pestanasNoDisponibles)
    expect(dias.estado).toBe('ok')
    if (dias.estado !== 'ok') return
    expect(dias.datos.netaMin).toBe(900)
    expect(dias.datos.reservaRegistrada).toBe(true)
    expect(dias.datos.dias.some((d) => d.disponibleMin !== null && d.disponibleMin > 0)).toBe(true)
  })

  it('conflicto entre dos pestañas: las dos vieron VERSION 1; la segunda recibe conflicto-version y no escribe nada', async () => {
    await service.registrarCapacidad(cmd({ horasDisponibles: '20', expectedVersion: 1 }), dueno) // pestaña A
    const antes = [await filas(store, 'AUDITORIA'), await fila(store, SEMANA)]
    const error = await service.registrarCapacidad(cmd({ horasDisponibles: '30', expectedVersion: 1 }), dueno).catch((e: unknown) => e) as OperationError // pestaña B
    expect(error.code).toBe('conflicto-version')
    expect(error.status).toBe(409)
    expect(error.detail).toEqual({ versionActual: 2 })
    expect([await filas(store, 'AUDITORIA'), await fila(store, SEMANA)]).toEqual(antes)
    // B recarga (versión 2) y guarda lo suyo sobre lo actual.
    expect(await service.registrarCapacidad(cmd({ horasDisponibles: '30', expectedVersion: 2 }), dueno)).toMatchObject({ version: 3 })
  })

  it('dos pestañas dan de alta la misma semana: la segunda recibe conflicto-concurrente sin escribir', async () => {
    const alta = { semanaId: '2026-W46', fechaInicio: '2026-11-09', horasDisponibles: '10' }
    await service.registrarCapacidad(parseRegistrarCapacidad({ requestId: uuid(), ...alta }), dueno)
    const antes = await filas(store, 'AUDITORIA')
    expect(await codeOf(service.registrarCapacidad(parseRegistrarCapacidad({ requestId: uuid(), ...alta, horasDisponibles: '12' }), dueno))).toBe('conflicto-concurrente')
    expect(await filas(store, 'AUDITORIA')).toBe(antes)
    expect(await fila(store, '2026-W46')).toMatchObject({ HORAS_DISPONIBLES: '10', VERSION: '1' })
  })

  it('otros rechazos sin escribir: semana inexistente con versión, VERSION vacía, otra fila en la misma semana y sin cambios', async () => {
    expect(await codeOf(service.registrarCapacidad(parseRegistrarCapacidad({ requestId: uuid(), semanaId: 'X-1', fechaInicio: '2026-12-07', expectedVersion: 1 }), dueno))).toBe('semana-inexistente')
    expect(await codeOf(service.registrarCapacidad(parseRegistrarCapacidad({ requestId: uuid(), semanaId: 'OTRA', fechaInicio: '2026-11-04', horasDisponibles: '5' }), dueno))).toBe('capacidad-semana-ocupada')
    expect(await codeOf(service.registrarCapacidad(cmd({ fechaInicio: '2026-10-27', expectedVersion: 1 }), dueno))).toBe('capacidad-semana-ocupada')
    // 0.15 en la hoja y 15 en el formulario son la misma reserva: no hay cambio falso.
    expect(await codeOf(service.registrarCapacidad(cmd({ reservaPct: '15', estado: 'BORRADOR', expectedVersion: 1 }), dueno))).toBe('sin-cambios')
    expect(await filas(store, 'AUDITORIA')).toBe(0)
  })

  it('una fila con VERSION vacía no se edita (409 version-faltante); el servidor nunca la supone', async () => {
    const view = await readView(store, 'CAPACIDAD_SEMANAL')
    const row = findById(view, 'SEMANA_ID', ANTERIOR)[0]!
    const cells = [...row.cells]
    cells[view.index.get('VERSION')!] = ''
    await store.writeRow('CAPACIDAD_SEMANAL', row.sheetRow, cells)
    const error = await service.registrarCapacidad(parseRegistrarCapacidad({ requestId: uuid(), semanaId: ANTERIOR, fechaInicio: '2026-10-26', horasDisponibles: '22', expectedVersion: 1 }), dueno).catch((e: unknown) => e) as OperationError
    expect(error.code).toBe('version-faltante')
    expect(error.status).toBe(409)
    expect(await filas(store, 'AUDITORIA')).toBe(0)
  })

  it('idempotencia: el mismo requestId no duplica (alta y edición); con otro cuerpo es conflicto-idempotencia', async () => {
    const alta = parseRegistrarCapacidad({ requestId: uuid(), semanaId: '2026-W46', fechaInicio: '2026-11-09', horasDisponibles: '10' })
    await service.registrarCapacidad(alta, dueno)
    const edicion = cmd({ horasDisponibles: '20', expectedVersion: 1 })
    await service.registrarCapacidad(edicion, dueno)
    const [cap, auditoria] = [await filas(store, 'CAPACIDAD_SEMANAL'), await filas(store, 'AUDITORIA')]
    expect(await service.registrarCapacidad(alta, dueno)).toMatchObject({ repetida: true, version: 1, id: '2026-W46' })
    expect(await service.registrarCapacidad(edicion, dueno)).toMatchObject({ repetida: true, version: 2, id: SEMANA })
    expect([await filas(store, 'CAPACIDAD_SEMANAL'), await filas(store, 'AUDITORIA')]).toEqual([cap, auditoria])
    expect(await codeOf(service.registrarCapacidad({ ...edicion, horasDisponibles: '21' }, dueno))).toBe('conflicto-idempotencia')
  })

  it('roll-forward: auditado pero sin escribir la fila, el reintento con el mismo requestId la completa', async () => {
    const edicion = cmd({ horasDisponibles: '20', expectedVersion: 1 })
    const writeRow = store.writeRow.bind(store)
    store.writeRow = async () => { throw new Error('fallo simulado') }
    expect(await codeOf(service.registrarCapacidad(edicion, dueno))).toBe('escritura-fallida')
    expect(await fila(store, SEMANA)).toMatchObject({ HORAS_DISPONIBLES: '', VERSION: '1' })
    store.writeRow = writeRow
    expect(await service.registrarCapacidad(edicion, dueno)).toMatchObject({ repetida: true, version: 2 })
    expect(await fila(store, SEMANA)).toMatchObject({ HORAS_DISPONIBLES: '20', VERSION: '2' })

    const alta = parseRegistrarCapacidad({ requestId: uuid(), semanaId: '2026-W46', fechaInicio: '2026-11-09', horasDisponibles: '10' })
    const appendRows = store.appendRows.bind(store)
    store.appendRows = async (tab, rows) => { if (tab === 'CAPACIDAD_SEMANAL') throw new Error('fallo simulado'); return appendRows(tab, rows) }
    expect(await codeOf(service.registrarCapacidad(alta, dueno))).toBe('escritura-fallida')
    expect(await fila(store, '2026-W46')).toBeNull()
    store.appendRows = appendRows
    expect(await service.registrarCapacidad(alta, dueno)).toMatchObject({ repetida: true, version: 1 })
    expect(await fila(store, '2026-W46')).toMatchObject({ HORAS_DISPONIBLES: '10', VERSION: '1' })
  })
})

describe('panel «Capacidad de la semana» (criterios 2 y 4)', () => {
  const ds = buildDataset(seed(), { source: 'fixtures', fetchedAt: NOW.getTime() })
  const input = planningInputFromDataset(ds)
  const capacidad: EdicionCapacidad = { migrada: true, versiones: { [SEMANA]: 1, [ANTERIOR]: 1 } }
  const encendida: EdicionSemana = { encendida: true, versiones: {}, hitosPorProyecto: {}, capacidad }

  it('la fila de la semana: existente, nueva (SEMANA_ID ISO y el lunes) o ambigua', () => {
    expect(ds.capacidadConVersion).toBe(true)
    expect(buildDataset(seed(false), { source: 'fixtures', fetchedAt: 0 }).capacidadConVersion).toBe(false)
    expect(capacidadSemana(input, '2026-11-02', '2026-11-08')).toEqual({
      tipo: 'existente', semanaId: SEMANA, fechaInicio: '2026-11-02', valores: { horasDisponibles: '', reservaPct: '15', estado: 'BORRADOR' },
    })
    expect(capacidadSemana(input, '2026-11-09', '2026-11-15')).toMatchObject({ tipo: 'nueva', semanaId: '2026-W46', fechaInicio: '2026-11-09' })
    const doble = { ...input, capacidad: [...input.capacidad, { ...input.capacidad[0]!, id: 'OTRA' }] }
    expect(capacidadSemana(doble, '2026-11-02', '2026-11-08')).toMatchObject({ tipo: 'ambigua', semanaIds: [SEMANA, 'OTRA'] })
  })

  it('cuerpo: estado completo con vacío como null, expectedVersion al editar, null si nada cambió', () => {
    const existente = capacidadSemana(input, '2026-11-02', '2026-11-08') as Exclude<ObjetivoCapacidad, { tipo: 'ambigua' }>
    expect(cuerpoCapacidad(existente, 1, { horasDisponibles: ' 20 ', reservaPct: '15', estado: 'BORRADOR', notas: 'x' })).toEqual({
      semanaId: SEMANA, fechaInicio: '2026-11-02', horasDisponibles: '20', reservaPct: '15', estado: 'BORRADOR', expectedVersion: 1,
    })
    expect(cuerpoCapacidad(existente, 1, { horasDisponibles: '', reservaPct: '15.0', estado: 'borrador' })).toBeNull()
    expect(cuerpoCapacidad(existente, 1, { horasDisponibles: '', reservaPct: '', estado: 'BORRADOR' })).toMatchObject({ horasDisponibles: null, reservaPct: null })
    const nueva = capacidadSemana(input, '2026-11-09', '2026-11-15') as Exclude<ObjetivoCapacidad, { tipo: 'ambigua' }>
    expect(cuerpoCapacidad(nueva, null, { horasDisponibles: '', reservaPct: '', estado: '' })).toEqual({
      semanaId: '2026-W46', fechaInicio: '2026-11-09', horasDisponibles: null, reservaPct: null, estado: null,
    })
  })

  it('textos de vacío con palabras y motivos de bloqueo (sin migración, VERSION vacía, ambigua)', () => {
    expect(textoCapacidad('horasDisponibles', '')).toBe('Sin capacidad registrada')
    expect(textoCapacidad('reservaPct', '')).toBe('Sin reserva registrada')
    expect(textoCapacidad('horasDisponibles', '0')).toBe('0 h')
    const existente = capacidadSemana(input, '2026-11-02', '2026-11-08')
    expect(bloqueoCapacidad(existente, capacidad)).toBeNull()
    expect(bloqueoCapacidad(existente, { migrada: false, versiones: {} })).toContain('migración')
    expect(bloqueoCapacidad(existente, { migrada: true, versiones: { [SEMANA]: null } })).toContain('no tiene VERSION')
    expect(bloqueoCapacidad({ tipo: 'ambigua', semanaIds: ['A', 'B'] }, capacidad)).toContain('más de una fila')
  })

  it('apagada (o sin datos de capacidad): «Edición apagada» y sin formulario; encendida: formulario con su versión', () => {
    const objetivo = capacidadSemana(input, '2026-11-02', '2026-11-08')
    const apagada = renderToStaticMarkup(createElement(CapacidadSemana, { objetivo, edicion: { encendida: false } }))
    expect(apagada).toContain('Capacidad de la semana')
    expect(apagada).toContain('Edición apagada')
    expect(apagada).not.toContain('<form')
    const sinCapacidad = renderToStaticMarkup(createElement(CapacidadSemana, { objetivo, edicion: { ...encendida, capacidad: undefined } }))
    expect(sinCapacidad).toContain('Edición apagada')
    const html = renderToStaticMarkup(createElement(CapacidadSemana, { objetivo, edicion: encendida }))
    expect(html).toContain('<form')
    expect(html).toContain('Guardar capacidad')
    expect(html).toContain('versión 1')
    expect(html).toMatch(/max="168"/)
    expect(html).toMatch(/max="100"/)
    expect(html).toContain('Vacío = sin capacidad registrada (no es 0)')
    expect(html).toContain('aria-live="polite"')
    const nueva = renderToStaticMarkup(createElement(CapacidadSemana, { objetivo: capacidadSemana(input, '2026-11-09', '2026-11-15'), edicion: encendida }))
    expect(nueva).toContain('fila nueva 2026-W46')
    expect(nueva).toContain('Sin capacidad registrada para esta semana')
    const bloqueada = renderToStaticMarkup(createElement(CapacidadSemana, { objetivo, edicion: { ...encendida, capacidad: { migrada: false, versiones: {} } } }))
    expect(bloqueada).toContain('Falta la migración')
    expect(bloqueada).not.toContain('<form')
  })

  it('mismos estados de guardado que ORD-POS-136 (EstadoGuardado): guardando, guardado con versión, conflicto y error', () => {
    const r = (estado: Parameters<typeof EstadoGuardado>[0]['estado']) => renderToStaticMarkup(createElement(EstadoGuardado, { estado, registro: 'la capacidad de la semana', actual: 'A', tuyo: 'B' }))
    expect(r({ tipo: 'guardando' })).toContain('Guardando…')
    expect(r({ tipo: 'guardado', version: 2, repetida: false })).toContain('Versión 2.')
    const conflicto = r({ tipo: 'conflicto', versionActual: 3, mensaje: '' })
    expect(conflicto).toContain('Otra sesión cambió la capacidad de la semana')
    expect(conflicto).toContain('Valor actual: A')
    expect(r({ tipo: 'error', mensaje: 'Entre 0 y 168', campos: {} })).toContain('Lo que escribiste sigue en el formulario')
  })

  it('la capa Semana pinta el panel; con RESERVA_PCT vacía dice «sin reserva registrada», nunca «0 %»', () => {
    const conHoras = { ...input, capacidad: input.capacidad.map((c) => (c.id === SEMANA ? { ...c, horasDisponibles: 20, reservaPct: null } : c)) }
    const plan = planWeek(conHoras, DEFAULT_SCENARIO, { referenceDate: HOY, timeZone: 'America/Merida' })
    const html = renderToStaticMarkup(createElement(CapaSemana, {
      dias: diasSemana(plan, conHoras.pestanasNoDisponibles), hitos: { estado: 'ok', datos: [] }, capacidad: capacidadSemana(conHoras, plan.referencia.lunes, plan.referencia.domingo),
    }))
    expect(html).toContain('Capacidad de la semana')
    expect(html).toContain('(sin reserva registrada)')
    expect(html).not.toContain('reserva 0 %')
  })
})
