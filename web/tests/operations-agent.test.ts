import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildFixtureTabs } from '@/lib/fixtures'
import { AGENT_ACTOR, WRITE_HEADERS, type OperationName } from '@/lib/operations/constants'
import { OperationError } from '@/lib/operations/errors'
import { evaluateWriteRequest } from '@/lib/operations/guard'
import { RateLimiter } from '@/lib/operations/rate-limit'
import { OperationsService } from '@/lib/operations/service'
import { InMemoryTableStore } from '@/lib/operations/table-store'
import { parseCreateDecision, parseCreateOrder, parseCreateTask, parseUpdateTask } from '@/lib/operations/validation'

/** Acceso del agente PM (DEC-POS-005, ORD-POS-027): token propio, lista blanca y auditoría agente-pm. */

const ORIGIN = 'http://127.0.0.1:3000'
const TOKEN = 'token-de-prueba-sintetico-0123456789'
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const ENV = {
  NEXTAUTH_URL: ORIGIN, AUTH_ALLOWED_EMAILS: 'escritor@example.com', AUTH_WRITER_EMAILS: 'escritor@example.com',
  PROJECT_OS_WRITE_MODE: 'mock', DASHBOARD_DATA_SOURCE: 'fixtures', PM_AGENT_TOKEN_SHA256: sha(TOKEN),
} as unknown as NodeJS.ProcessEnv

const NOW = new Date('2026-10-14T16:30:00Z')
let seq = 0
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`

function setup() {
  const tabs = { ...(buildFixtureTabs('2026-10-14') as Record<string, unknown[][]>), AUDITORIA: [[...WRITE_HEADERS.AUDITORIA]] }
  const store = new InMemoryTableStore(tabs)
  return { store, service: new OperationsService(store, { mode: 'mock', clock: () => NOW }) }
}

function req(body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) {
  return new Request(`${ORIGIN}/api/operaciones/tareas`, {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers },
  })
}

const ctx = (operation: OperationName, env = ENV, agentLimiter = new RateLimiter(5, 60_000)) =>
  ({ email: null, env, limiter: new RateLimiter(), agentLimiter, operation })

async function fails(promise: Promise<unknown>) {
  const error = await promise.catch((e: unknown) => e)
  expect(error).toBeInstanceOf(OperationError)
  return [(error as OperationError).code, (error as OperationError).status]
}

describe('token del agente PM (criterio 1)', () => {
  it('token válido sin cookie: actor agente-pm', async () => {
    const r = await evaluateWriteRequest(req({ requestId: 'x' }), ctx('tarea.crear'))
    expect(r).toEqual({ actor: AGENT_ACTOR, body: { requestId: 'x' }, agent: true })
  })

  it.each([
    ['token incorrecto', { authorization: 'Bearer otro-token' }, ENV],
    ['esquema distinto de Bearer', { authorization: `Basic ${TOKEN}` }, ENV],
    ['Bearer vacío', { authorization: 'Bearer ' }, ENV],
    ['sin variable PM_AGENT_TOKEN_SHA256', { authorization: `Bearer ${TOKEN}` }, { ...ENV, PM_AGENT_TOKEN_SHA256: undefined } as unknown as NodeJS.ProcessEnv],
    ['variable con formato inválido', { authorization: `Bearer ${TOKEN}` }, { ...ENV, PM_AGENT_TOKEN_SHA256: 'abc' } as unknown as NodeJS.ProcessEnv],
  ])('%s → 401 sin revelar el motivo', async (_n, headers, env) => {
    expect(await fails(evaluateWriteRequest(req({}, headers), ctx('tarea.crear', env)))).toEqual(['no-autenticado', 401])
  })

  it('token y cookie de sesión a la vez → 400', async () => {
    const headers = { authorization: `Bearer ${TOKEN}`, cookie: 'a=1; next-auth.session-token=abc' }
    expect(await fails(evaluateWriteRequest(req({}, headers), ctx('tarea.crear')))).toEqual(['credenciales-ambiguas', 400])
    const secure = { authorization: `Bearer ${TOKEN}`, cookie: '__Secure-next-auth.session-token.0=abc' }
    expect(await fails(evaluateWriteRequest(req({}, secure), ctx('tarea.crear')))).toEqual(['credenciales-ambiguas', 400])
  })

  it('escritura deshabilitada → 403 aun con token válido', async () => {
    const env = { ...ENV, PROJECT_OS_WRITE_MODE: 'disabled' } as unknown as NodeJS.ProcessEnv
    expect(await fails(evaluateWriteRequest(req({}), ctx('tarea.crear', env)))).toEqual(['escritura-deshabilitada', 403])
  })
})

describe('lista blanca de operaciones (criterio 2)', () => {
  it.each(['tarea.crear', 'tarea.editar', 'decision.crear', 'orden.crear'] as const)('%s permitida', async (op) => {
    expect((await evaluateWriteRequest(req({ changes: { titulo: 'x' } }), ctx(op))).actor).toBe(AGENT_ACTOR)
  })

  it.each([
    'orden.enviar', 'orden.cancelar', 'orden.registrar_pr', 'orden.revisar', 'orden.cerrar',
    'orden.ejecutar', 'tiempo.registrar',
  ] as const)('%s → 403', async (op) => {
    expect(await fails(evaluateWriteRequest(req({}), ctx(op)))).toEqual(['operacion-no-permitida', 403])
  })

  it('orden.aprobar (PATCH de una orden) solo con APROBAR, ENVIAR o REVISAR (DEC-POS-011)', async () => {
    for (const accion of ['APROBAR', 'ENVIAR', 'REVISAR']) expect((await evaluateWriteRequest(req({ accion }), ctx('orden.aprobar'))).actor).toBe(AGENT_ACTOR)
    for (const body of [{ accion: 'CERRAR' }, { accion: 'CANCELAR' }, { accion: 'CERRAR_FUSIONADO' }, {}]) {
      expect(await fails(evaluateWriteRequest(req(body), ctx('orden.aprobar')))).toEqual(['transicion-reservada-pm', 403])
    }
  })

  it('orden.aprobar normaliza la acción (trim y mayúsculas) antes de la lista del PM (ORD-POS-059)', async () => {
    for (const accion of [' revisar ', 'Enviar', 'aprobar\t']) expect((await evaluateWriteRequest(req({ accion }), ctx('orden.aprobar'))).actor).toBe(AGENT_ACTOR)
    for (const accion of [' cerrar ', 'Cancelar']) {
      expect(await fails(evaluateWriteRequest(req({ accion }), ctx('orden.aprobar')))).toEqual(['transicion-reservada-pm', 403])
    }
  })

  it('sin operación declarada → 403 (falla cerrada)', async () => {
    const c = { ...ctx('tarea.crear'), operation: undefined }
    expect(await fails(evaluateWriteRequest(req({}), c))).toEqual(['operacion-no-permitida', 403])
  })

  it('el humano con sesión no cambia: sigue exigiendo CSRF y escritor', async () => {
    const human = new Request(`${ORIGIN}/api/operaciones/tareas`, {
      method: 'POST', body: '{}', headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-project-os-csrf': '1' },
    })
    const r = await evaluateWriteRequest(human, { email: 'escritor@example.com', env: ENV, limiter: new RateLimiter() })
    expect(r).toEqual({ actor: 'escritor@example.com', body: {} })
  })
})

describe('tarea.editar del agente (criterio 3)', () => {
  it.each(['estado', 'bloqueo', 'tipo', 'responsable'])('cambiar %s → 403', async (field) => {
    const body = { requestId: uuid(), expectedVersion: 1, changes: { [field]: 'x' } }
    expect(await fails(evaluateWriteRequest(req(body), ctx('tarea.editar')))).toEqual(['operacion-no-permitida', 403])
  })

  it('tarea.crear con bloqueo → 403; sin bloqueo pasa', async () => {
    const body = { requestId: 'x', titulo: 'T', bloqueo: 'Esperando' }
    expect(await fails(evaluateWriteRequest(req(body), ctx('tarea.crear')))).toEqual(['operacion-no-permitida', 403])
    expect((await evaluateWriteRequest(req({ requestId: 'x', titulo: 'T' }), ctx('tarea.crear'))).actor).toBe(AGENT_ACTOR)
  })

  it('campos permitidos pasan y respetan VERSION', async () => {
    const { store, service } = setup()
    const changes = { titulo: 'Título nuevo', descripcion: 'd', prioridad: 'ALTA', fechaPlan: '2026-10-20', fechaLimite: '2026-10-30', horasEstimadas: '3', criterioTerminado: 'Hecho' }
    const body = { requestId: uuid(), expectedVersion: 2, changes }
    const checked = await evaluateWriteRequest(req(body), ctx('tarea.editar'))
    await expect(service.updateTask(parseUpdateTask('DEMO-002', checked.body), { actor: checked.actor, agent: true })).resolves.toMatchObject({ operacion: 'tarea.editar' })
    const stale = { requestId: uuid(), expectedVersion: 2, changes: { titulo: 'Otro título' } }
    await expect(service.updateTask(parseUpdateTask('DEMO-002', stale), { actor: AGENT_ACTOR, agent: true })).rejects.toMatchObject({ code: 'conflicto-version' })
    expect((await store.readTable('AUDITORIA')).length).toBeGreaterThan(1)
  })
})

describe('creación y auditoría del agente (criterios 4 y 5)', () => {
  const AGENT = { actor: AGENT_ACTOR, agent: true as const }
  const order = { proyectoId: 'POS', tareaId: 'DEMO-002', titulo: 'Agregar prueba', objetivo: 'Cubrir X', criterios: '1. npm test pasa\n2. Lint sin errores', fueraDeAlcance: 'nada', comoProbar: 'npm test', riesgo: 'BAJO' }

  it('crea tarea, decisión PENDIENTE y orden BORRADOR con ACTOR agente-pm y ;agente=pm', async () => {
    const { store, service } = setup()
    await service.createTask(parseCreateTask({ requestId: uuid(), proyectoId: 'POS', titulo: 'Tarea del PM', tipo: 'DESARROLLO', prioridad: 'MEDIA', criterioTerminado: 'Hecho' }), AGENT)
    await service.createDecision(parseCreateDecision({ requestId: uuid(), proyectoId: 'POS', asunto: 'Asunto', decision: 'Decisión', justificacion: 'Porque', responsable: 'PM' }, '2026-10-14'), AGENT)
    await service.createOrder(parseCreateOrder({ ...order, requestId: uuid() }), AGENT)
    const audit = (await store.readTable('AUDITORIA')).slice(1)
    expect(audit.length).toBeGreaterThan(3)
    expect(audit.every((row) => row[2] === AGENT_ACTOR && row[8]!.endsWith(';agente=pm'))).toBe(true)
    expect(audit.some((row) => row[5] === 'ESTADO' && row[7] === 'PENDIENTE')).toBe(true)
    expect(audit.some((row) => row[5] === 'ESTADO' && row[7] === 'BORRADOR')).toBe(true)
    expect((await store.readTable('ORDENES_CODEX')).flat()).not.toContain('ENVIADA')
  })

  it('no puede fijar otro estado ni riesgo ALTO', () => {
    expect(() => parseCreateOrder({ ...order, requestId: uuid(), riesgo: 'ALTO' })).toThrow(OperationError)
    const decision = { requestId: uuid(), proyectoId: 'POS', asunto: 'Asunto', decision: 'Decisión', justificacion: 'Porque', responsable: 'PM' }
    expect(() => parseCreateDecision({ ...decision, estado: 'APROBADA' }, '2026-10-14')).toThrow(OperationError)
  })

  it('idempotencia por requestId igual que para humanos', async () => {
    const { store, service } = setup()
    const input = { requestId: uuid(), proyectoId: 'POS', titulo: 'Tarea del PM', tipo: 'DESARROLLO', prioridad: 'MEDIA', criterioTerminado: 'Hecho' }
    const first = await service.createTask(parseCreateTask(input), AGENT)
    const again = await service.createTask(parseCreateTask(input), AGENT)
    expect(first.repetida).toBe(false)
    expect(again).toMatchObject({ id: first.id, repetida: true })
    const ids = (await store.readTable('AUDITORIA')).slice(1).map((row) => row[4])
    expect(new Set(ids)).toEqual(new Set([first.id]))
  })
})

describe('límite de frecuencia del agente (criterio 6)', () => {
  it('agota su ráfaga → 429, con clave propia y más estricto que el humano', async () => {
    const agentLimiter = new RateLimiter(2, 60_000, () => 0)
    const c = ctx('tarea.crear', ENV, agentLimiter)
    await evaluateWriteRequest(req({}), c)
    await evaluateWriteRequest(req({}), c)
    expect(await fails(evaluateWriteRequest(req({}), c))).toEqual(['demasiadas-solicitudes', 429])
  })
})
