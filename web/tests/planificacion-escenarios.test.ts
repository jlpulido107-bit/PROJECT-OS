import { createHash } from 'node:crypto'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EscenariosGuardados } from '@/components/planning/escenarios-guardados'
import { decide } from '@/lib/authz'
import { buildFixtureTabs } from '@/lib/fixtures'
import { AGENT_OPERATIONS, OWNER_PLANNING_OPERATIONS, WRITE_HEADERS, type OperationName, type WriteTab } from '@/lib/operations/constants'
import { OperationError } from '@/lib/operations/errors'
import { evaluateWriteRequest } from '@/lib/operations/guard'
import { RateLimiter } from '@/lib/operations/rate-limit'
import { OperationsService, parseAudit } from '@/lib/operations/service'
import { SheetsTableStore } from '@/lib/operations/sheets-table-store'
import { findById, InMemoryTableStore, readView, toRecord, type TableStore } from '@/lib/operations/table-store'
import { parseArchivarEscenario, parseGuardarEscenario } from '@/lib/operations/validation'
import type { EdicionSemana } from '@/lib/planificacion-edicion'
import {
  AVISO_DATOS_CAMBIADOS, avisoAlCargar, cuerpoEscenario, escenarioDeParametros, escenariosActivos, formularioDeEscenario, huellaDatos,
} from '@/lib/planificacion-escenarios'
import { planWeek } from '@/lib/planning/engine'
import { planningInputFromDataset } from '@/lib/planning/input'
import { normalizeScenario } from '@/lib/planning/scenario'
import { TAB_HEADERS } from '@/lib/schema'
import { buildDataset } from '@/lib/table'
import { FakeSheets } from './helpers/fake-sheets'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }))

/**
 * ORD-POS-141 (DEC-POS-029 d): guardar con nombre un escenario de la simulación en ESCENARIOS y volver a cargarlo. Solo
 * altas y archivar (nunca se borra una fila); cargar re-simula en el navegador y avisa si la huella de los datos cambió;
 * guardar no cambia el plan.
 */

const ORIGIN = 'http://127.0.0.1:3000'
const PM_TOKEN = 'token-pm-de-prueba-sintetico-0123456789'
const TIEMPOS_TOKEN = 'token-tiempos-de-prueba-sintetico-0123456789'
const DUENO = 'dueno@example.com'
const OTRO = 'otro-escritor@example.com'
const HOY = '2026-11-03'
const NOW = new Date('2026-11-03T16:30:00Z')
const HUELLA = '0123456789abcdef'
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

const humano = (ruta: string, body: unknown) => new Request(`${ORIGIN}${ruta}`, {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'x-project-os-csrf': '1' },
})
const conAuthorization = (ruta: string, authorization: string) => new Request(`${ORIGIN}${ruta}`, {
  method: 'POST', body: '{roto', headers: { 'content-type': 'application/json', authorization },
})
const ctx = (email: string | null, e: NodeJS.ProcessEnv, operation: OperationName) => ({
  email, env: e, limiter: new RateLimiter(), agentLimiter: new RateLimiter(5, 60_000), operation,
})

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await promise.then(() => undefined, (e: unknown) => e)
  return error instanceof OperationError ? error.code : undefined
}

/** Fixtures con o sin la pestaña ESCENARIOS de la migración (§11.2), vacía. */
function seed(migrada = true): Record<string, unknown[][]> {
  const tabs = buildFixtureTabs(HOY) as Record<string, unknown[][]>
  return { ...tabs, ...(migrada ? { ESCENARIOS: [[...TAB_HEADERS.ESCENARIOS]] } : {}), AUDITORIA: [[...WRITE_HEADERS.AUDITORIA]] }
}

const ADAPTERS: Array<[string, (migrada?: boolean) => TableStore]> = [
  ['InMemoryTableStore', (migrada = true) => new InMemoryTableStore(seed(migrada))],
  ['SheetsTableStore (servidor simulado)', (migrada = true) => {
    const fake = new FakeSheets('HOJA_DE_PRUEBA_SINTETICA_0123456789', seed(migrada))
    return new SheetsTableStore({ spreadsheetId: fake.spreadsheetId, getWriteToken: async () => 'token-falso', fetchImpl: fake.fetch })
  }],
]

const ESCENARIO = { semana: 'actual', ajusteHoras: 2, sobrecargaPct: 10, prioridadProyecto: { SIG: 'ALTA' }, fijadas: { 'POS-001': '2026-11-05' } }
const guardar = (extra: Record<string, unknown> = {}) =>
  parseGuardarEscenario({ requestId: uuid(), nombre: 'Semana con SIG primero', semanaId: '2026-w45', parametros: ESCENARIO, huella: HUELLA, ...extra })

function errorDe(fn: () => unknown): OperationError {
  try { fn() } catch (e) { return e as OperationError }
  throw new Error('no lanzó')
}

async function fila(store: TableStore, id: string) {
  const view = await readView(store, 'ESCENARIOS')
  const rows = findById(view, 'ESCENARIO_ID', id)
  return rows.length === 1 ? toRecord(view, rows[0]!.cells) : null
}
const filas = async (store: TableStore, tab: WriteTab) => (await store.readTable(tab)).length - 1

describe('validación (criterio 1: escenario validado por scenario.ts)', () => {
  it('normaliza el escenario con normalizeScenario y lo guarda como JSON canónico', () => {
    const c = guardar()
    expect(c).toMatchObject({ nombre: 'Semana con SIG primero', semanaId: '2026-W45', huella: HUELLA })
    expect(JSON.parse(c.parametros)).toEqual(normalizeScenario(ESCENARIO))
    // Canónico: el mismo escenario con las claves en otro orden da el mismo texto (y el mismo hash de idempotencia).
    const reordenado = Object.fromEntries(Object.entries(ESCENARIO).reverse())
    expect(guardar({ parametros: reordenado }).parametros).toBe(c.parametros)
    // Sin movimientos, `fijadas` no se guarda (escenario idéntico al de antes de ORD-POS-137).
    expect(JSON.parse(guardar({ parametros: { fijadas: {} } }).parametros)).not.toHaveProperty('fijadas')
  })

  it.each([
    [{ parametros: { ...ESCENARIO, sobrecargaPct: 400 } }, 'parametros.sobrecargaPct'],
    [{ parametros: { ...ESCENARIO, reservaPct: 101 } }, 'parametros.reservaPct'],
    [{ parametros: { ...ESCENARIO, semana: 'pasada' } }, 'parametros.semana'],
    [{ parametros: { ...ESCENARIO, fijadas: { 'POS-001': '05/11/2026' } } }, 'parametros.fijadas'],
    [{ parametros: { ...ESCENARIO, otra: 1 } }, 'parametros.otra'],
    [{ parametros: [] }, 'parametros'],
    [{ parametros: 'texto' }, 'parametros'],
    [{ parametros: undefined }, 'parametros'],
    [{ nombre: '' }, 'nombre'],
    [{ nombre: 'x'.repeat(81) }, 'nombre'],
    [{ huella: 'corta' }, 'huella'],
    [{ semanaId: 'con espacios' }, 'semanaId'],
    [{ estado: 'ARCHIVADO' }, 'estado'],
    [{ version: 1 }, 'version'],
  ])('rechaza %o', (extra, campo) => {
    const body: Record<string, unknown> = { requestId: uuid(), nombre: 'n', semanaId: '2026-W45', parametros: ESCENARIO, huella: HUELLA, ...extra }
    if (Object.hasOwn(extra, 'parametros') && (extra as Record<string, unknown>).parametros === undefined) delete body.parametros
    const error = errorDe(() => parseGuardarEscenario(body))
    expect(error.code).toBe('validacion')
    expect(Object.keys(error.fields ?? {})).toContain(campo)
  })

  it('PARAMETROS de más de 2000 caracteres se rechaza (contrato §11.1)', () => {
    const fijadas = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`POS-${String(i).padStart(3, '0')}`, '2026-11-05']))
    expect(errorDe(() => guardar({ parametros: { fijadas } })).fields).toHaveProperty('parametros')
  })

  it('archivar exige ESC-NNN y la versión esperada', () => {
    expect(parseArchivarEscenario({ requestId: uuid(), escenarioId: 'ESC-001', expectedVersion: 1 })).toMatchObject({ escenarioId: 'ESC-001', expectedVersion: 1 })
    for (const extra of [{ escenarioId: 'POS-001' }, { expectedVersion: 0 }, { expectedVersion: '1' }, { estado: 'ACTIVO' }]) {
      expect(errorDe(() => parseArchivarEscenario({ requestId: uuid(), escenarioId: 'ESC-001', expectedVersion: 1, ...extra })).code, JSON.stringify(extra)).toBe('validacion')
    }
  })
})

describe('guard: solo el propietario con su bandera', () => {
  const rutas: Array<[string, OperationName]> = [['/api/operaciones/escenarios', 'escenario.guardar'], ['/api/operaciones/escenarios/archivar', 'escenario.archivar']]

  it.each(rutas)('%s: apagada, otro escritor o cualquier Authorization → 403 sin leer el cuerpo', async (ruta, op) => {
    expect(await codeOf(evaluateWriteRequest(humano(ruta, '{roto'), ctx(DUENO, env(BASE), op)))).toBe('operacion-no-permitida')
    expect(await codeOf(evaluateWriteRequest(humano(ruta, '{roto'), ctx(OTRO, env(ENCENDIDA), op)))).toBe('operacion-no-permitida')
    for (const authorization of [`Bearer ${PM_TOKEN}`, `Bearer ${TIEMPOS_TOKEN}`, 'Bearer otro', '']) {
      expect(await codeOf(evaluateWriteRequest(conAuthorization(ruta, authorization), ctx(DUENO, env(ENCENDIDA), op))), authorization).toBe('operacion-no-permitida')
    }
    // Encendida y con la sesión del propietario, pasa (y ahí sí lee el cuerpo).
    expect(await codeOf(evaluateWriteRequest(humano(ruta, '{roto'), ctx(DUENO, env(ENCENDIDA), op)))).toBe('json-invalido')
    expect((await evaluateWriteRequest(humano(ruta, { requestId: uuid() }), ctx(DUENO, env(ENCENDIDA), op))).actor).toBe(DUENO)
  })

  it('son operaciones del propietario, nunca del agente; el proxy no deja pasar los tokens sin sesión', async () => {
    expect(OWNER_PLANNING_OPERATIONS).toEqual(expect.arrayContaining(['escenario.guardar', 'escenario.archivar']))
    expect(AGENT_OPERATIONS).not.toContain('escenario.guardar')
    expect(AGENT_OPERATIONS).not.toContain('escenario.archivar')
    for (const [ruta] of rutas) {
      for (const token of [PM_TOKEN, TIEMPOS_TOKEN]) {
        const req = new NextRequest(new URL(ruta, ORIGIN), { method: 'POST', headers: { authorization: `Bearer ${token}` } })
        expect((await decide(req, { secret: 'secreto-de-prueba-0123456789abcdef', agentTokenSha256: sha(PM_TOKEN), tiemposEnv: env(ENCENDIDA) })).action, ruta).toBe('unauthenticated')
      }
    }
  })
})

describe.each(ADAPTERS)('servicio — %s (criterios 1, 3 y 4)', (_name, make) => {
  let store: TableStore
  let service: OperationsService
  beforeEach(() => {
    store = make()
    service = new OperationsService(store, { mode: 'mock', clock: () => NOW })
  })
  const dueno = { actor: DUENO }

  it('sin la pestaña ESCENARIOS: 422 migracion-pendiente y no escribe nada, ni AUDITORIA', async () => {
    store = make(false)
    service = new OperationsService(store, { mode: 'mock', clock: () => NOW })
    for (const run of [() => service.guardarEscenario(guardar(), dueno), () => service.archivarEscenario(parseArchivarEscenario({ requestId: uuid(), escenarioId: 'ESC-001', expectedVersion: 1 }), dueno)]) {
      const error = await run().catch((e: unknown) => e) as OperationError
      expect(error.code).toBe('migracion-pendiente')
      expect(error.status).toBe(422)
      expect(error.detail).toEqual({ pestana: 'ESCENARIOS' })
    }
    expect(await filas(store, 'AUDITORIA')).toBe(0)
  })

  it('guardar: alta ESC-001 con nombre, semana, escenario, huella, ACTIVO y VERSION 1, auditada por el propietario', async () => {
    const c = guardar()
    const r = await service.guardarEscenario(c, dueno)
    expect(r).toMatchObject({ operacion: 'escenario.guardar', entidad: 'ESCENARIOS', id: 'ESC-001', version: 1, repetida: false })
    expect(await fila(store, 'ESC-001')).toEqual({
      ESCENARIO_ID: 'ESC-001', NOMBRE: 'Semana con SIG primero', SEMANA_ID: '2026-W45', PARAMETROS: c.parametros,
      CREADO_EN: expect.stringMatching(/^2026-11-03T10:30:00/), HUELLA: HUELLA, ESTADO: 'ACTIVO', VERSION: '1',
    })
    const [op] = parseAudit(await readView(store, 'AUDITORIA'))
    expect(op).toMatchObject({ operacion: 'escenario.guardar', entidad: 'ESCENARIOS', id: 'ESC-001', integridad: 'completa' })
    expect(op!.fields.get('HUELLA')).toEqual({ antes: '', despues: HUELLA })
    const audit = await store.readTable('AUDITORIA')
    expect(audit.slice(1).every((row) => row[2] === DUENO && row[3] === 'ESCENARIOS')).toBe(true)
    // El siguiente toma el ID siguiente: solo altas, nunca se sobrescribe una fila.
    expect((await service.guardarEscenario(guardar({ nombre: 'Otro' }), dueno)).id).toBe('ESC-002')
    expect(await filas(store, 'ESCENARIOS')).toBe(2)
  })

  it('criterio 4: guardar no cambia el plan (ninguna otra pestaña de datos se toca)', async () => {
    const tabs = ['TAREAS', 'CAPACIDAD_SEMANAL', 'TIEMPOS', 'DECISIONES', 'ORDENES_CODEX'] as const
    const antes = await Promise.all(tabs.map((t) => store.readTable(t)))
    await service.guardarEscenario(guardar(), dueno)
    await service.archivarEscenario(parseArchivarEscenario({ requestId: uuid(), escenarioId: 'ESC-001', expectedVersion: 1 }), dueno)
    expect(await Promise.all(tabs.map((t) => store.readTable(t)))).toEqual(antes)
  })

  it('idempotencia: el mismo requestId repite sin otra fila; con otro cuerpo, 409 conflicto-idempotencia', async () => {
    const c = guardar()
    await service.guardarEscenario(c, dueno)
    expect(await service.guardarEscenario(c, dueno)).toMatchObject({ id: 'ESC-001', repetida: true, version: 1 })
    expect(await filas(store, 'ESCENARIOS')).toBe(1)
    expect(await codeOf(service.guardarEscenario({ ...c, nombre: 'Otro nombre' }, dueno))).toBe('conflicto-idempotencia')
  })

  it('criterio 3: archivar pasa a ARCHIVADO con VERSION + 1, sin borrar la fila ni tocar sus datos', async () => {
    const c = guardar()
    await service.guardarEscenario(c, dueno)
    const a = parseArchivarEscenario({ requestId: uuid(), escenarioId: 'ESC-001', expectedVersion: 1 })
    expect(await service.archivarEscenario(a, dueno)).toMatchObject({ operacion: 'escenario.archivar', id: 'ESC-001', version: 2, repetida: false })
    expect(await fila(store, 'ESC-001')).toMatchObject({ ESTADO: 'ARCHIVADO', VERSION: '2', PARAMETROS: c.parametros, HUELLA: HUELLA, NOMBRE: 'Semana con SIG primero' })
    expect(await filas(store, 'ESCENARIOS')).toBe(1)
    const ops = parseAudit(await readView(store, 'AUDITORIA'))
    expect(ops.at(-1)).toMatchObject({ operacion: 'escenario.archivar', integridad: 'completa' })
    expect(ops.at(-1)!.fields.get('ESTADO')).toEqual({ antes: 'ACTIVO', despues: 'ARCHIVADO' })
    // Reintento del mismo requestId: repetida, sin otra escritura.
    expect(await service.archivarEscenario(a, dueno)).toMatchObject({ repetida: true, version: 2 })
    // Ya archivado, o con la versión vieja: no se escribe.
    expect(await codeOf(service.archivarEscenario(parseArchivarEscenario({ requestId: uuid(), escenarioId: 'ESC-001', expectedVersion: 2 }), dueno))).toBe('escenario-archivado')
    const conflicto = await service.archivarEscenario(parseArchivarEscenario({ requestId: uuid(), escenarioId: 'ESC-001', expectedVersion: 1 }), dueno).catch((e: unknown) => e) as OperationError
    expect(conflicto.code).toBe('conflicto-version')
    expect(conflicto.detail).toEqual({ versionActual: 2 })
    expect(await codeOf(service.archivarEscenario(parseArchivarEscenario({ requestId: uuid(), escenarioId: 'ESC-009', expectedVersion: 1 }), dueno))).toBe('escenario-inexistente')
    expect(await filas(store, 'ESCENARIOS')).toBe(1)
  })

  it('la conciliación no ve pendientes tras guardar y archivar', async () => {
    await service.guardarEscenario(guardar(), dueno)
    await service.archivarEscenario(parseArchivarEscenario({ requestId: uuid(), escenarioId: 'ESC-001', expectedVersion: 1 }), dueno)
    expect((await service.reconcile()).pendientes).toEqual([])
  })
})

describe('cargar (criterio 2): re-simula en el navegador y avisa si la huella cambió', () => {
  const tabs = buildFixtureTabs(HOY) as Record<string, unknown[][]>
  const data = buildDataset(tabs, { source: 'fixtures', fetchedAt: NOW.getTime() })
  const input = planningInputFromDataset(data)
  const opts = { referenceDate: HOY, timeZone: 'America/Merida' }

  it('la huella es la de los datos del motor: no cambia por guardar escenarios, sí por cambiar las tareas', () => {
    const huella = huellaDatos(input)
    const fila = ['ESC-001', 'n', '2026-W45', '{}', '2026-11-03T10:30:00-06:00', huella, 'ACTIVO', '1']
    const conEscenarios = buildDataset({ ...tabs, ESCENARIOS: [[...TAB_HEADERS.ESCENARIOS], fila] }, { source: 'fixtures', fetchedAt: NOW.getTime() })
    expect(conEscenarios.escenarios).toHaveLength(1)
    expect(huellaDatos(planningInputFromDataset(conEscenarios))).toBe(huella)
    const otraTarea = { ...input, tareas: input.tareas.map((t, i) => (i === 0 ? { ...t, horasEstimadas: (t.horasEstimadas ?? 0) + 1 } : t)) }
    expect(huellaDatos(otraTarea)).not.toBe(huella)
  })

  it('ida y vuelta: lo guardado se carga como el mismo escenario y da la misma propuesta', () => {
    const escenario = normalizeScenario(ESCENARIO)
    const cuerpo = cuerpoEscenario('  Mi escenario ', '2026-W45', escenario, huellaDatos(input))
    if ('error' in cuerpo) throw new Error(cuerpo.error)
    expect(cuerpo.nombre).toBe('Mi escenario')
    const parametros = parseGuardarEscenario({ requestId: uuid(), ...cuerpo }).parametros
    const cargado = escenarioDeParametros(parametros)
    if (!('escenario' in cargado)) throw new Error(cargado.problema)
    expect(cargado.escenario).toEqual(escenario)
    expect(planWeek(input, cargado.escenario, opts)).toEqual(planWeek(input, escenario, opts))
    expect(formularioDeEscenario(cargado.escenario)).toMatchObject({ ajusteHoras: '2', sobrecargaPct: '10', reservaPct: '', prioridadProyecto: { SIG: 'ALTA' } })
    expect(cuerpoEscenario('   ', '2026-W45', escenario, HUELLA)).toEqual({ error: 'Escribe un nombre para el escenario' })
  })

  it('escenario guardado con huella vieja: «los datos cambiaron desde que lo guardaste»; misma huella, sin aviso', () => {
    const actual = huellaDatos(input)
    expect(avisoAlCargar({ huella: 'ffffffffffffffff' }, actual)).toBe(AVISO_DATOS_CAMBIADOS)
    expect(AVISO_DATOS_CAMBIADOS.toLowerCase()).toBe('los datos cambiaron desde que lo guardaste')
    expect(avisoAlCargar({ huella: null }, actual)).toBe(AVISO_DATOS_CAMBIADOS)
    expect(avisoAlCargar({ huella: actual }, actual)).toBeNull()
  })

  it('lista solo los ACTIVO, del más nuevo al más viejo; PARAMETROS dañado no se carga', () => {
    const base = { semanaId: '2026-W45', creadoEn: null, huella: HUELLA, version: '1' }
    const lista = escenariosActivos([
      { ...base, id: 'ESC-001', nombre: 'Viejo', parametros: '{"ajusteHoras":2}', estado: 'ACTIVO' },
      { ...base, id: 'ESC-002', nombre: 'Archivado', parametros: '{}', estado: 'ARCHIVADO' },
      { ...base, id: 'ESC-010', nombre: 'Roto', parametros: '{"sobrecargaPct":999}', estado: 'ACTIVO', version: null },
      { ...base, id: 'ESC-003', nombre: 'No JSON', parametros: '{', estado: 'ACTIVO' },
    ])
    expect(lista.map((g) => g.id)).toEqual(['ESC-010', 'ESC-003', 'ESC-001'])
    expect(lista[0]).toMatchObject({ escenario: null, version: null, problema: expect.stringContaining('sobrecargaPct') })
    expect(lista[1]).toMatchObject({ escenario: null, problema: 'PARAMETROS no es JSON válido' })
    expect(lista[2]!.escenario).toMatchObject({ ajusteHoras: 2 })
  })
})

describe('panel «Escenarios guardados»', () => {
  const escenario = normalizeScenario({})
  const guardados = escenariosActivos([{ id: 'ESC-001', nombre: 'Plan A', semanaId: '2026-W45', parametros: '{}', creadoEn: null, huella: HUELLA, estado: 'ACTIVO', version: '1' }])
  const encendida: EdicionSemana = { encendida: true, versiones: {}, hitosPorProyecto: {}, escenarios: { migrada: true } }
  const render = (edicion: EdicionSemana) => renderToStaticMarkup(createElement(EscenariosGuardados, {
    guardados, edicion, escenario, semanaId: '2026-W45', huellaActual: HUELLA, onCargar: () => undefined,
  }))

  it('apagada: se puede cargar, no guardar ni archivar', () => {
    const html = render({ encendida: false })
    expect(html).toContain('data-edicion="apagada"')
    expect(html).toContain('Cargar')
    expect(html).not.toContain('Guardar escenario')
    expect(html).not.toContain('Archivar')
  })

  it('sin la migración: avisa y no muestra Guardar ni Archivar', () => {
    const html = render({ ...encendida, escenarios: { migrada: false } })
    expect(html).toContain('Falta la migración')
    expect(html).not.toContain('Guardar escenario')
    expect(html).not.toContain('Archivar')
  })

  it('encendida y migrada: Guardar con nombre y Archivar por escenario; sin botón Borrar', () => {
    const html = render(encendida)
    expect(html).toContain('Guardar escenario')
    expect(html).toContain('Archivar')
    expect(html).toContain('Plan A')
    expect(html).not.toMatch(/Borrar|Eliminar/)
  })
})
