import { createHash } from 'node:crypto'
import { encode } from 'next-auth/jwt'
import { NextRequest } from 'next/server'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST as postDecision } from '@/app/api/operaciones/decisiones/route'
import { PATCH as patchOrden } from '@/app/api/operaciones/ordenes/[id]/route'
import { POST as ejecutarOrden } from '@/app/api/operaciones/ordenes/[id]/ejecutar/route'
import { POST as postOrden } from '@/app/api/operaciones/ordenes/route'
import { PATCH as patchTarea } from '@/app/api/operaciones/tareas/[id]/route'
import { POST as postTarea } from '@/app/api/operaciones/tareas/route'
import { POST as postTiempo } from '@/app/api/operaciones/tiempos/route'
import { proxy } from '@/proxy'
import { auditTable, mockWriteTabs } from '@/lib/operations/runtime'

/** Recorrido real proxy → ruta → servicio del agente PM (ORD-POS-027, H1 y H1-bis), en modo mock. */

const TOKEN = 'token-de-prueba-sintetico-0123456789'
const SECRET = 'secreto-de-prueba-solo-para-tests-0123456789abcdef'
const HOST = 'http://localhost:3000'
const KEYS = ['PROJECT_OS_WRITE_MODE', 'DASHBOARD_DATA_SOURCE', 'PM_AGENT_TOKEN_SHA256', 'NEXTAUTH_SECRET', 'AUTH_ALLOWED_EMAILS', 'AUTH_WRITER_EMAILS', 'NEXTAUTH_URL', 'K_SERVICE']
const saved: Record<string, string | undefined> = {}
let seq = 0
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`

beforeAll(() => {
  for (const key of KEYS) saved[key] = process.env[key]
  Object.assign(process.env, {
    PROJECT_OS_WRITE_MODE: 'mock', DASHBOARD_DATA_SOURCE: 'fixtures', NEXTAUTH_SECRET: SECRET,
    PM_AGENT_TOKEN_SHA256: createHash('sha256').update(TOKEN).digest('hex'),
    AUTH_ALLOWED_EMAILS: 'escritor@example.com', AUTH_WRITER_EMAILS: 'escritor@example.com', NEXTAUTH_URL: HOST,
  })
  delete process.env.K_SERVICE
})
// El limitador del agente es del proceso: cada prueba parte de una ráfaga completa (reloj simulado).
let clock = Date.now()
beforeEach(() => {
  clock += 10 * 60_000
  vi.useFakeTimers({ toFake: ['Date'], now: clock })
})
afterEach(() => vi.useRealTimers())
afterAll(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

type Handler = (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>
const params = (id: string) => ({ params: Promise.resolve({ id }) })

function build(method: string, path: string, body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) {
  return new NextRequest(new URL(path, HOST), {
    method, headers: { 'content-type': 'application/json', ...headers },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  })
}

/** Proxy y, si lo deja pasar, el handler. Devuelve el estado final y si el proxy dejó pasar la petición. */
async function through(handler: Handler, request: NextRequest, id = 'X') {
  const gate = await proxy(request)
  if (gate.headers.get('x-middleware-next') !== '1') return { status: gate.status, passed: false }
  const response = await handler(request, params(id))
  return { status: response.status, passed: true, json: await response.json() as Record<string, unknown> }
}

const tareasTable = async () => (mockWriteTabs()?.TAREAS ?? []) as unknown[][]
const rows = async () => ((await auditTable()) ?? []).length
const task = { proyectoId: 'POS', titulo: 'Tarea del PM', tipo: 'DESARROLLO', prioridad: 'MEDIA', criterioTerminado: 'Hecho' }
const decision = { proyectoId: 'POS', asunto: 'Asunto', decision: 'Decisión', justificacion: 'Porque', responsable: 'PM' }
const order = { proyectoId: 'POS', tareaId: 'DEMO-002', titulo: 'Agregar prueba', objetivo: 'Cubrir X', criterios: '1. npm test pasa\n2. Lint sin errores', fueraDeAlcance: 'nada', comoProbar: 'npm test', riesgo: 'BAJO' }

describe('agente PM: proxy → ruta → servicio', () => {
  it('token válido sin sesión crea tarea, decisión y orden, y edita campos, como agente-pm', async () => {
    const before = await rows()
    const created = [
      await through(postTarea as Handler, build('POST', '/api/operaciones/tareas', { ...task, requestId: uuid() })),
      await through(postDecision as Handler, build('POST', '/api/operaciones/decisiones', { ...decision, requestId: uuid() })),
      await through(postOrden as Handler, build('POST', '/api/operaciones/ordenes', { ...order, requestId: uuid() })),
    ]
    expect(created.map((r) => [r.passed, r.status])).toEqual([[true, 201], [true, 201], [true, 201]])
    const edit = build('PATCH', '/api/operaciones/tareas/DEMO-002', { requestId: uuid(), expectedVersion: 2, changes: { titulo: 'Título nuevo' } })
    expect(await through(patchTarea as Handler, edit, 'DEMO-002')).toMatchObject({ passed: true, status: 200 })
    const added = ((await auditTable()) ?? []).slice(before)
    expect(added.length).toBeGreaterThan(4)
    expect(added.every((row) => row[2] === 'agente-pm' && row[8]!.endsWith(';agente=pm'))).toBe(true)
  })

  it('orden.crear con todos los criterios en una línea → 422 con el mismo error de campo que el formulario (ORD-POS-044)', async () => {
    const before = await rows()
    const request = build('POST', '/api/operaciones/ordenes', { ...order, requestId: uuid(), criterios: '1. npm test 2. Lint' })
    const r = await through(postOrden as Handler, request)
    expect(r).toMatchObject({ passed: true, status: 422, json: { error: { codigo: 'validacion' } } })
    expect(JSON.stringify(r.json)).toContain('el criterio 1 contiene «2.» en la misma línea')
    expect(await rows()).toBe(before)
  })

  it('editar ESTADO o BLOQUEO llega a la ruta y recibe 403 sin escribir', async () => {
    const before = await rows()
    for (const field of ['estado', 'bloqueo']) {
      const request = build('PATCH', '/api/operaciones/tareas/DEMO-002', { requestId: uuid(), expectedVersion: 3, changes: { [field]: 'BLOQUEADO' } })
      expect(await through(patchTarea as Handler, request, 'DEMO-002')).toMatchObject({ passed: true, status: 403 })
    }
    expect(await rows()).toBe(before)
  })

  it('tarea.crear con bloqueo → 403 operacion-no-permitida sin filas en TAREAS ni AUDITORIA; sin bloqueo sigue creando', async () => {
    const tareas = async () => (await tareasTable()).length
    const [auditBefore, tareasBefore] = [await rows(), await tareas()]
    for (const bloqueo of ['Esperando a X', '', null]) {
      const request = build('POST', '/api/operaciones/tareas', { ...task, requestId: uuid(), bloqueo })
      expect(await through(postTarea as Handler, request)).toMatchObject({ passed: true, status: 403, json: { error: { codigo: 'operacion-no-permitida' } } })
    }
    expect([await rows(), await tareas()]).toEqual([auditBefore, tareasBefore])
    const ok = await through(postTarea as Handler, build('POST', '/api/operaciones/tareas', { ...task, requestId: uuid() }))
    expect(ok).toMatchObject({ passed: true, status: 201 })
    expect(await tareas()).toBe(tareasBefore + 1)
  })

  it.each([
    ['token inválido', { authorization: 'Bearer otro-token' }],
    ['sin Authorization ni cookie', {}],
    ['esquema distinto de Bearer', { authorization: `Basic ${TOKEN}` }],
  ])('%s → 401 en el proxy, sin filas', async (_n, headers) => {
    const before = await rows()
    const result = await through(postTarea as Handler, build('POST', '/api/operaciones/tareas', { ...task, requestId: uuid() }, headers))
    expect(result).toEqual({ status: 401, passed: false })
    expect(await rows()).toBe(before)
  })

  it('sin PM_AGENT_TOKEN_SHA256 definida el token no abre nada', async () => {
    const hash = process.env.PM_AGENT_TOKEN_SHA256
    delete process.env.PM_AGENT_TOKEN_SHA256
    try {
      const before = await rows()
      const result = await through(postTarea as Handler, build('POST', '/api/operaciones/tareas', { ...task, requestId: uuid() }))
      expect(result).toEqual({ status: 401, passed: false })
      expect(await rows()).toBe(before)
    } finally {
      process.env.PM_AGENT_TOKEN_SHA256 = hash
    }
  })

  it('token y cookie de sesión válida a la vez → 400 de la ruta, sin filas', async () => {
    const cookie = await encode({ token: { email: 'escritor@example.com', sub: '1' }, secret: SECRET })
    const before = await rows()
    const headers = { authorization: `Bearer ${TOKEN}`, cookie: `next-auth.session-token=${cookie}` }
    const result = await through(postTarea as Handler, build('POST', '/api/operaciones/tareas', { ...task, requestId: uuid() }, headers))
    expect(result).toMatchObject({ passed: true, status: 400 })
    expect(await rows()).toBe(before)
  })

  it('token con cookie inválida → 401 del proxy', async () => {
    const headers = { authorization: `Bearer ${TOKEN}`, cookie: 'next-auth.session-token=basura' }
    const result = await through(postTarea as Handler, build('POST', '/api/operaciones/tareas', { ...task, requestId: uuid() }, headers))
    expect(result).toEqual({ status: 401, passed: false })
  })

  it('GET con token válido y otras rutas o páginas siguen exigiendo sesión (H1-bis)', async () => {
    for (const path of ['/api/operaciones/tareas', '/api/operaciones/decisiones', '/api/operaciones/ordenes', '/api/operaciones/tareas/DEMO-002']) {
      const gate = await proxy(build('GET', path, null))
      expect(gate.status, path).toBe(401)
    }
    const page = await proxy(build('GET', '/proyectos', null))
    expect(page.status).toBe(307)
    expect(page.headers.get('location')).toContain('/login')
  })

  it('operaciones prohibidas: el proxy las frena sin sesión y, saltándolo, la ruta responde 403; nunca hay filas', async () => {
    const before = await rows()
    const cases: Array<[Handler, string, string, string]> = [
      [postTiempo as Handler, 'POST', '/api/operaciones/tiempos', 'X'],
      [patchOrden as Handler, 'PATCH', '/api/operaciones/ordenes/ORD-POS-901', 'ORD-POS-901'],
      [ejecutarOrden as Handler, 'POST', '/api/operaciones/ordenes/ORD-POS-901/ejecutar', 'ORD-POS-901'],
    ]
    for (const [handler, method, path, id] of cases) {
      const request = () => build(method, path, { requestId: uuid(), accion: 'APROBAR', expectedEstado: 'BORRADOR' })
      expect(await through(handler, request(), id), path).toEqual({ status: 401, passed: false })
      expect((await handler(request(), params(id))).status, path).toBe(403)
    }
    expect(await rows()).toBe(before)
  })

  it('el agente PM no puede usar el cierre asistido (ORD-POS-046): 403 operacion-no-permitida sin filas', async () => {
    const before = await rows()
    const request = build('PATCH', '/api/operaciones/ordenes/ORD-POS-902', { requestId: uuid(), accion: 'CERRAR_FUSIONADO', expectedEstado: 'PR_ABIERTO' })
    expect(await patchOrden(request, params('ORD-POS-902'))).toMatchObject({ status: 403 })
    const again = build('PATCH', '/api/operaciones/ordenes/ORD-POS-902', { requestId: uuid(), accion: 'CERRAR_FUSIONADO', expectedEstado: 'PR_ABIERTO' })
    expect(await (await patchOrden(again, params('ORD-POS-902'))).json()).toMatchObject({ error: { codigo: 'operacion-no-permitida' } })
    expect(await rows()).toBe(before)
  })

  it('exceder el límite propio del agente → 429 sin filas nuevas', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await through(postTarea as Handler, build('POST', '/api/operaciones/tareas', { ...task, requestId: uuid() }))).status).toBe(201)
    }
    const before = await rows()
    const sixth = await through(postTarea as Handler, build('POST', '/api/operaciones/tareas', { ...task, requestId: uuid() }))
    expect(sixth).toMatchObject({ passed: true, status: 429 })
    expect(await rows()).toBe(before)
  })
})
