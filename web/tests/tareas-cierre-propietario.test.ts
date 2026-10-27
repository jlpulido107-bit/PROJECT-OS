import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '../deploy/cloudrun/render.mjs'
import { CompleteTaskForm } from '@/components/operations/forms'
import { decide } from '@/lib/authz'
import { buildFixtureTabs } from '@/lib/fixtures'
import { puedeCerrarTareas, tareasCierrePropietario } from '@/lib/operations/config'
import {
  AGENT_EDITABLE_TASK_FIELDS, AGENT_OPERATIONS, AUDIT_NOTA_CIERRE, LIMITS, WRITE_HEADERS, type OperationName, type WriteTab,
} from '@/lib/operations/constants'
import { OperationError } from '@/lib/operations/errors'
import { evaluateWriteRequest } from '@/lib/operations/guard'
import { RateLimiter } from '@/lib/operations/rate-limit'
import { OperationsService, parseAudit } from '@/lib/operations/service'
import { SheetsTableStore } from '@/lib/operations/sheets-table-store'
import { findById, InMemoryTableStore, readView, toRecord, type TableStore } from '@/lib/operations/table-store'
import { parseCompleteTask, parseUpdateTask } from '@/lib/operations/validation'
import { FakeSheets } from './helpers/fake-sheets'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }))

/** Cierre de tareas por el propietario (ORD-POS-106, DEC-POS-023): inerte sin TAREAS_CIERRE_PROPIETARIO. */

const ORIGIN = 'http://127.0.0.1:3000'
const TOKEN = 'token-de-prueba-sintetico-0123456789'
const DUENO = 'dueno@example.com'
const OTRO = 'otro-escritor@example.com'
const NOW = new Date('2026-10-27T16:30:00Z')
let seq = 0
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`

const BASE = {
  NEXTAUTH_URL: ORIGIN, AUTH_ALLOWED_EMAILS: `${DUENO},${OTRO}`, AUTH_WRITER_EMAILS: `${DUENO},${OTRO}`,
  PROJECT_OS_WRITE_MODE: 'mock', DASHBOARD_DATA_SOURCE: 'fixtures', PM_AGENT_TOKEN_SHA256: createHash('sha256').update(TOKEN).digest('hex'),
}
const ENCENDIDA = { ...BASE, TAREAS_CIERRE_PROPIETARIO: 'true', TAREAS_CIERRE_PROPIETARIO_EMAIL: DUENO }
const env = (extra: Record<string, string | undefined>) => extra as unknown as NodeJS.ProcessEnv

const humano = (body: unknown) => new Request(`${ORIGIN}/api/operaciones/tareas/DEMO-002/completar`, {
  method: 'POST', body: JSON.stringify(body),
  headers: { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'x-project-os-csrf': '1' },
})
const conAuthorization = (authorization: string, body: unknown) => new Request(`${ORIGIN}/api/operaciones/tareas/DEMO-002/completar`, {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', authorization },
})
const ctx = (email: string | null, e: NodeJS.ProcessEnv, operation: OperationName = 'tarea.completar') => ({
  email, env: e, limiter: new RateLimiter(), agentLimiter: new RateLimiter(5, 60_000), operation,
})

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await promise.then(() => undefined, (e: unknown) => e)
  return error instanceof OperationError ? error.code : undefined
}

function seed(): Record<string, unknown[][]> {
  return { ...(buildFixtureTabs('2026-10-27') as Record<string, unknown[][]>), AUDITORIA: [[...WRITE_HEADERS.AUDITORIA]] }
}

const ADAPTERS: Array<[string, () => TableStore]> = [
  ['InMemoryTableStore', () => new InMemoryTableStore(seed())],
  ['SheetsTableStore (servidor simulado)', () => {
    const fake = new FakeSheets('HOJA_DE_PRUEBA_SINTETICA_0123456789', seed())
    return new SheetsTableStore({ spreadsheetId: fake.spreadsheetId, getWriteToken: async () => 'token-falso', fetchImpl: fake.fetch })
  }],
]

async function tarea(store: TableStore, id: string) {
  const view = await readView(store, 'TAREAS')
  return toRecord(view, findById(view, 'TAREA_ID', id)[0]!.cells)
}
const filas = async (store: TableStore, tab: WriteTab) => (await store.readTable(tab)).length - 1

describe('bandera TAREAS_CIERRE_PROPIETARIO (criterio 1)', () => {
  it('solo «true» exacto con un único correo del propietario que esté en AUTH_ALLOWED_EMAILS', () => {
    expect(tareasCierrePropietario(env(ENCENDIDA))).toBe(DUENO)
    expect(tareasCierrePropietario(env({ ...ENCENDIDA, TAREAS_CIERRE_PROPIETARIO_EMAIL: ` ${DUENO.toUpperCase()} ` }))).toBe(DUENO)
    for (const valor of [undefined, '', 'TRUE', 'True', ' true', '1', 'on', 'yes']) {
      expect(tareasCierrePropietario(env({ ...ENCENDIDA, TAREAS_CIERRE_PROPIETARIO: valor })), String(valor)).toBeNull()
    }
    for (const correo of [undefined, '', 'no-es-correo', `${DUENO},${OTRO}`, `${DUENO} ${OTRO}`, `${DUENO};${OTRO}`, 'fuera@example.com']) {
      expect(tareasCierrePropietario(env({ ...ENCENDIDA, TAREAS_CIERRE_PROPIETARIO_EMAIL: correo })), String(correo)).toBeNull()
    }
    expect(puedeCerrarTareas(DUENO, env(ENCENDIDA))).toBe(true)
    expect(puedeCerrarTareas(OTRO, env(ENCENDIDA))).toBe(false)
    expect(puedeCerrarTareas(DUENO, env(BASE))).toBe(false)
    expect(puedeCerrarTareas(null, env(ENCENDIDA))).toBe(false)
  })

  describe('render.mjs', () => {
    const template = readFileSync(path.join(__dirname, '..', 'deploy', 'cloudrun', 'service.template.yaml'), 'utf8')
    const VARS = {
      SERVICE_NAME: 'project-os-dashboard', PROJECT_ID: 'project-os-511102', REGION: 'northamerica-south1',
      IMAGE: `us-docker.pkg.dev/proj-os-1/repo/dash@sha256:${'a'.repeat(64)}`, RUNTIME_SA: 'runtime@project-os-511102.iam.gserviceaccount.com',
      SERVICE_URL: 'https://dash.example.com', OAUTH_CLIENT_ID: '123-abc.apps.googleusercontent.com', SECRET_VERSION_NEXTAUTH: '1',
      SECRET_VERSION_OAUTH: '1', SECRET_VERSION_ALLOWLIST: '1', WRITE_MODE: 'sheets',
      WRITE_SERVICE_ACCOUNT: 'writer@project-os-511102.iam.gserviceaccount.com', SECRET_VERSION_WRITERS: '1',
    }
    const ON = { ...VARS, TAREAS_CIERRE_PROPIETARIO: 'true', TAREAS_CIERRE_PROPIETARIO_EMAIL: DUENO }

    it('sin la bandera el YAML no cambia; con ella agrega las dos variables', () => {
      const sin = render(template, VARS)
      expect(sin).not.toContain('TAREAS_CIERRE_PROPIETARIO')
      expect(render(template, { ...VARS, TAREAS_CIERRE_PROPIETARIO: ' ', TAREAS_CIERRE_PROPIETARIO_EMAIL: '' })).toBe(sin)
      expect(render(template, ON)).toMatch(
        new RegExp(`- name: TAREAS_CIERRE_PROPIETARIO\\n\\s+value: 'true'\\n\\s+- name: TAREAS_CIERRE_PROPIETARIO_EMAIL\\n\\s+value: '${DUENO}'\\n`),
      )
    })

    it.each([
      [{ TAREAS_CIERRE_PROPIETARIO: 'TRUE' }, 'TAREAS_CIERRE_PROPIETARIO solo admite true'],
      [{ TAREAS_CIERRE_PROPIETARIO: 'on' }, 'TAREAS_CIERRE_PROPIETARIO solo admite true'],
      [{ TAREAS_CIERRE_PROPIETARIO_EMAIL: '' }, 'van juntas'],
      [{ TAREAS_CIERRE_PROPIETARIO: '' }, 'van juntas'],
      [{ TAREAS_CIERRE_PROPIETARIO_EMAIL: `${DUENO},${OTRO}` }, 'debe ser un único correo'],
      [{ TAREAS_CIERRE_PROPIETARIO_EMAIL: "dueno'@example.com" }, 'debe ser un único correo'],
      [{ WRITE_MODE: '' }, 'exige WRITE_MODE=sheets'],
    ])('rechaza %o', (cambio, mensaje) => {
      expect(() => render(template, { ...ON, ...cambio })).toThrow(mensaje)
    })
  })
})

describe('guard (criterios 2, 5 y 6)', () => {
  const body = () => ({ requestId: uuid(), expectedVersion: 2 })

  it('bandera apagada: el propietario recibe cierre-no-permitido', async () => {
    expect(await codeOf(evaluateWriteRequest(humano(body()), ctx(DUENO, env(BASE))))).toBe('cierre-no-permitido')
    expect(await codeOf(evaluateWriteRequest(humano(body()), ctx(DUENO, env({ ...ENCENDIDA, TAREAS_CIERRE_PROPIETARIO: 'TRUE' }))))).toBe('cierre-no-permitido')
  })

  it('bandera encendida: pasa solo la sesión del propietario', async () => {
    const r = await evaluateWriteRequest(humano(body()), ctx(DUENO, env(ENCENDIDA)))
    expect(r.actor).toBe(DUENO)
    expect(r.agent).toBeUndefined()
  })

  it('otro escritor permitido que no es el propietario → cierre-no-permitido', async () => {
    expect(await codeOf(evaluateWriteRequest(humano(body()), ctx(OTRO, env(ENCENDIDA))))).toBe('cierre-no-permitido')
  })

  it('las demás verificaciones siguen antes: sin sesión, sin CSRF o con la escritura apagada no llega al cierre', async () => {
    expect(await codeOf(evaluateWriteRequest(humano(body()), ctx(null, env(ENCENDIDA))))).toBe('no-autenticado')
    const sinCsrf = new Request(`${ORIGIN}/x`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', origin: ORIGIN } })
    expect(await codeOf(evaluateWriteRequest(sinCsrf, ctx(DUENO, env(ENCENDIDA))))).toBe('origen-invalido')
    expect(await codeOf(evaluateWriteRequest(humano(body()), ctx(DUENO, env({ ...ENCENDIDA, PROJECT_OS_WRITE_MODE: 'disabled' }))))).toBe('escritura-deshabilitada')
  })

  it('cualquier Authorization (token válido del PM o no) → cierre-no-permitido, aun con la bandera encendida', async () => {
    for (const authorization of [`Bearer ${TOKEN}`, 'Bearer otro-token', 'Basic abc', '']) {
      expect(await codeOf(evaluateWriteRequest(conAuthorization(authorization, body()), ctx(null, env(ENCENDIDA)))), authorization).toBe('cierre-no-permitido')
    }
  })

  it('el proxy no deja llegar el token del PM a /completar: sin sesión, no autenticado (la API repite el rechazo)', async () => {
    const hash = createHash('sha256').update(TOKEN).digest('hex')
    const completar = new NextRequest(new URL('/api/operaciones/tareas/DEMO-002/completar', ORIGIN), { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } })
    expect((await decide(completar, { secret: 'secreto-de-prueba-0123456789abcdef', agentTokenSha256: hash })).action).toBe('unauthenticated')
    const editar = new NextRequest(new URL('/api/operaciones/tareas/DEMO-002', ORIGIN), { method: 'PATCH', headers: { authorization: `Bearer ${TOKEN}` } })
    expect((await decide(editar, { secret: 'x', agentTokenSha256: hash })).action).toBe('agent')
  })

  it('el PM sigue sin cerrar por la edición: AGENT_OPERATIONS y sus campos no cambian', async () => {
    expect(AGENT_OPERATIONS).toEqual(['tarea.crear', 'tarea.editar', 'decision.crear', 'orden.crear', 'orden.aprobar'])
    expect(AGENT_EDITABLE_TASK_FIELDS).toEqual(['titulo', 'descripcion', 'prioridad', 'hitoId', 'fechaPlan', 'fechaLimite', 'horasEstimadas', 'criterioTerminado'])
    const editar = conAuthorization(`Bearer ${TOKEN}`, { requestId: uuid(), expectedVersion: 2, changes: { estado: 'COMPLETADO' } })
    expect(await codeOf(evaluateWriteRequest(editar, ctx(null, env(ENCENDIDA), 'tarea.editar')))).toBe('operacion-no-permitida')
  })

  it('la edición sigue sin cerrar ni cancelar, también para el propietario con la bandera', () => {
    for (const estado of ['COMPLETADO', 'CANCELADO']) {
      expect(() => parseUpdateTask('DEMO-002', { requestId: uuid(), expectedVersion: 2, changes: { estado } })).toThrow(OperationError)
    }
  })
})

describe('validación del cierre', () => {
  it('solo requestId, expectedVersion y nota (≤ 500); el estado destino no se elige', () => {
    expect(parseCompleteTask(' demo-002 ', { requestId: '00000000-0000-4000-8000-000000000001', expectedVersion: 2 }))
      .toEqual({ requestId: '00000000-0000-4000-8000-000000000001', tareaId: 'DEMO-002', expectedVersion: 2, nota: null })
    expect(parseCompleteTask('DEMO-002', { requestId: uuid(), expectedVersion: 2, nota: ' listo ' }).nota).toBe('listo')
    expect(LIMITS.notaCierre).toBe(500)
    const invalidos: unknown[] = [
      { requestId: uuid(), expectedVersion: 2, nota: 'x'.repeat(501) },
      { requestId: uuid(), expectedVersion: 2, estado: 'CANCELADO' },
      { requestId: uuid(), expectedVersion: 2, changes: { estado: 'PENDIENTE' } },
      { requestId: uuid() },
      { expectedVersion: 2 },
    ]
    for (const body of invalidos) expect(() => parseCompleteTask('DEMO-002', body), JSON.stringify(body)).toThrow(OperationError)
  })
})

describe.each(ADAPTERS)('servicio — %s (criterios 4 y 6)', (_name, make) => {
  let store: TableStore
  let service: OperationsService
  beforeEach(() => {
    store = make()
    service = new OperationsService(store, { mode: 'mock', clock: () => NOW })
  })
  const dueno = { actor: DUENO }

  it('propietario con bandera → COMPLETADO auditado, con VERSION y la nota solo en AUDITORIA', async () => {
    const antes = await tarea(store, 'DEMO-002')
    const r = await service.completeTask(parseCompleteTask('DEMO-002', { requestId: uuid(), expectedVersion: 2, nota: 'Revisado con el criterio' }), dueno)
    expect(r).toMatchObject({ operacion: 'tarea.completar', entidad: 'TAREAS', id: 'DEMO-002', version: 3, repetida: false })
    const despues = await tarea(store, 'DEMO-002')
    expect(despues).toMatchObject({ ESTADO: 'COMPLETADO', VERSION: '3', CRITERIO_TERMINADO: antes.CRITERIO_TERMINADO, BLOQUEO: antes.BLOQUEO })
    expect(Object.values(despues)).not.toContain('Revisado con el criterio')
    const [op] = parseAudit(await readView(store, 'AUDITORIA'))
    expect(op).toMatchObject({ operacion: 'tarea.completar', entidad: 'TAREAS', id: 'DEMO-002', integridad: 'completa' })
    expect(op!.fields.get('ESTADO')).toEqual({ antes: 'EN_PROGRESO', despues: 'COMPLETADO' })
    expect(op!.fields.get('VERSION')).toEqual({ antes: '2', despues: '3' })
    expect(op!.fields.get(AUDIT_NOTA_CIERRE)).toEqual({ antes: '', despues: 'Revisado con el criterio' })
    const audit = await store.readTable('AUDITORIA')
    expect(audit.slice(1).every((row) => row[2] === DUENO && !String(row[8]).includes('agente=pm'))).toBe(true)
    expect((await service.reconcile()).pendientes).toEqual([])
  })

  it('sin nota no audita NOTA_CIERRE; desde BLOQUEADO o PENDIENTE también cierra', async () => {
    await service.completeTask(parseCompleteTask('DEMO-003', { requestId: uuid(), expectedVersion: 1 }), dueno)
    expect(await tarea(store, 'DEMO-003')).toMatchObject({ ESTADO: 'COMPLETADO', VERSION: '2' })
    expect(parseAudit(await readView(store, 'AUDITORIA'))[0]!.fields.has(AUDIT_NOTA_CIERRE)).toBe(false)
  })

  it('conflicto de VERSION: no escribe nada', async () => {
    const antes = [await filas(store, 'AUDITORIA'), await tarea(store, 'DEMO-002')]
    const error = await service.completeTask(parseCompleteTask('DEMO-002', { requestId: uuid(), expectedVersion: 1 }), dueno).catch((e: unknown) => e)
    expect((error as OperationError).code).toBe('conflicto-version')
    expect((error as OperationError).detail).toEqual({ versionActual: 2 })
    expect([await filas(store, 'AUDITORIA'), await tarea(store, 'DEMO-002')]).toEqual(antes)
  })

  it('repetición idempotente: el mismo requestId no duplica; con otro payload es conflicto', async () => {
    const cmd = { requestId: uuid(), expectedVersion: 2, nota: 'listo' }
    await service.completeTask(parseCompleteTask('DEMO-002', cmd), dueno)
    const auditoria = await filas(store, 'AUDITORIA')
    const otra = await service.completeTask(parseCompleteTask('DEMO-002', cmd), dueno)
    expect(otra).toMatchObject({ repetida: true, version: 3 })
    expect(await filas(store, 'AUDITORIA')).toBe(auditoria)
    const error = await service.completeTask(parseCompleteTask('DEMO-002', { ...cmd, nota: 'otra' }), dueno).catch((e: unknown) => e)
    expect((error as OperationError).code).toBe('conflicto-idempotencia')
  })

  it('roll-forward: auditado pero sin escribir la tarea, el reintento la completa', async () => {
    const cmd = { requestId: uuid(), expectedVersion: 2, nota: 'listo' }
    const writeRow = store.writeRow.bind(store)
    store.writeRow = async () => { throw new Error('fallo simulado') }
    expect(await codeOf(service.completeTask(parseCompleteTask('DEMO-002', cmd), dueno))).toBe('escritura-fallida')
    expect((await service.reconcile()).pendientes).toEqual([expect.objectContaining({ operacion: 'tarea.completar', motivo: 'sin-efecto' })])
    store.writeRow = writeRow
    expect(await service.completeTask(parseCompleteTask('DEMO-002', cmd), dueno)).toMatchObject({ repetida: true, version: 3 })
    expect(await tarea(store, 'DEMO-002')).toMatchObject({ ESTADO: 'COMPLETADO', VERSION: '3' })
    expect((await service.reconcile()).pendientes).toEqual([])
  })

  it('una tarea cerrada no se vuelve a cerrar ni se reabre', async () => {
    expect(await codeOf(service.completeTask(parseCompleteTask('DEMO-001', { requestId: uuid(), expectedVersion: 1 }), dueno))).toBe('tarea-cerrada')
    await service.completeTask(parseCompleteTask('DEMO-002', { requestId: uuid(), expectedVersion: 2 }), dueno)
    expect(await codeOf(service.updateTask(parseUpdateTask('DEMO-002', { requestId: uuid(), expectedVersion: 3, changes: { estado: 'PENDIENTE' } }), dueno))).toBe('tarea-cerrada')
  })

  it('tarea inexistente', async () => {
    expect(await codeOf(service.completeTask(parseCompleteTask('POS-999', { requestId: uuid(), expectedVersion: 1 }), dueno))).toBe('tarea-inexistente')
  })
})

describe('interfaz (criterios 2 y 3)', () => {
  it('el botón «Marcar completada» solo se pinta con puedeCerrarTareas', () => {
    const page = readFileSync(path.join(__dirname, '..', 'src', 'app', '(private)', 'tareas', '[id]', 'editar', 'page.tsx'), 'utf8')
    expect(page).toMatch(/\{puedeCerrarTareas\(user\.email\) \? \(\s*<CompleteTaskForm/)
    expect(page.match(/<CompleteTaskForm/g)).toHaveLength(1)
  })

  it('el formulario abre con el botón y no llama al servidor al pintarse', () => {
    const html = renderToStaticMarkup(createElement(CompleteTaskForm, { task: { id: 'DEMO-002', version: 2, criterioTerminado: 'Panel accesible' } }))
    expect(html).toContain('Marcar completada')
    expect(html).not.toContain('Panel accesible')
  })
})
