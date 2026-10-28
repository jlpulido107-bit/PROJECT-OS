import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { render } from '../deploy/cloudrun/render.mjs'
import { GET as getPlanificacion } from '@/app/api/planificacion/route'
import { decide, respond } from '@/lib/authz'
import { AGENT_OPERATIONS, type OperationName } from '@/lib/operations/constants'
import { OperationError } from '@/lib/operations/errors'
import { evaluateWriteRequest } from '@/lib/operations/guard'
import { RateLimiter } from '@/lib/operations/rate-limit'
import { esTokenDeTiempos, tiemposAgenteHabilitado, tiemposAgenteTokenHash } from '@/lib/tiempos-agente'

/** Rol Tiempos (ORD-POS-112): lectura de /api/planificacion con token propio y `tiempo.crear` del PM, inertes sin bandera. */

const ORIGIN = 'http://127.0.0.1:3000'
const TIEMPOS = 'token-tiempos-sintetico-0123456789'
const PM = 'token-pm-sintetico-0123456789'
const FINANZAS = 'token-finanzas-sintetico-0123456789'
const sha = (t: string) => createHash('sha256').update(t).digest('hex')
const SECRET = 'secreto-de-prueba-0123456789abcdef'
const env = (extra: Record<string, string | undefined>) => extra as unknown as NodeJS.ProcessEnv

const HASHES = { PM_AGENT_TOKEN_SHA256: sha(PM), FINANZAS_AGENTE_TOKEN_SHA256: sha(FINANZAS), TIEMPOS_AGENTE_TOKEN_SHA256: sha(TIEMPOS) }
const APAGADA = env(HASHES)
const ENCENDIDA = env({ ...HASHES, TIEMPOS_AGENTE: 'true' })

const req = (method: string, ruta: string, token: string | null, extra: Record<string, string> = {}) =>
  new NextRequest(new URL(ruta, ORIGIN), { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra } })
const decision = (r: NextRequest, e: NodeJS.ProcessEnv) => decide(r, {
  secret: SECRET, agentTokenSha256: e.PM_AGENT_TOKEN_SHA256, finanzasAgenteTokenSha256: e.FINANZAS_AGENTE_TOKEN_SHA256, tiemposEnv: e,
})

describe('bandera y hash (criterios 1 y 3)', () => {
  it('solo «true» exacto enciende; el hash debe ser válido y distinto del PM y del agente de finanzas', () => {
    expect(tiemposAgenteHabilitado(ENCENDIDA)).toBe(true)
    expect(tiemposAgenteTokenHash(ENCENDIDA)).toBe(sha(TIEMPOS))
    for (const valor of [undefined, '', 'TRUE', 'True', ' true', '1', 'on', 'yes']) {
      expect(tiemposAgenteTokenHash(env({ ...HASHES, TIEMPOS_AGENTE: valor })), String(valor)).toBeNull()
    }
    for (const hash of ['', 'abc', sha(PM), sha(FINANZAS), sha(PM).toUpperCase()]) {
      expect(tiemposAgenteTokenHash(env({ ...HASHES, TIEMPOS_AGENTE: 'true', TIEMPOS_AGENTE_TOKEN_SHA256: hash })), hash).toBeNull()
    }
  })

  it('el token con cookie de sesión, otro esquema o sin bandera no cuenta', async () => {
    const h = (headers: Record<string, string>) => new Headers(headers)
    expect(await esTokenDeTiempos(h({ authorization: `Bearer ${TIEMPOS}` }), ENCENDIDA)).toBe(true)
    expect(await esTokenDeTiempos(h({ authorization: `Bearer ${TIEMPOS}` }), APAGADA)).toBe(false)
    expect(await esTokenDeTiempos(h({ authorization: `Bearer ${TIEMPOS}`, cookie: 'next-auth.session-token=x' }), ENCENDIDA)).toBe(false)
    expect(await esTokenDeTiempos(h({ authorization: `Basic ${TIEMPOS}` }), ENCENDIDA)).toBe(false)
    expect(await esTokenDeTiempos(h({ authorization: `Bearer ${PM}` }), ENCENDIDA)).toBe(false)
  })
})

describe('proxy (criterios 1, 3 y 5)', () => {
  it('bandera apagada: el token de Tiempos recibe 401 en /api/planificacion', async () => {
    const d = await decision(req('GET', '/api/planificacion', TIEMPOS), APAGADA)
    expect(d.action).toBe('unauthenticated')
    expect(respond(d, req('GET', '/api/planificacion', TIEMPOS)).status).toBe(401)
  })

  it('bandera encendida: GET pasa; cualquier otro método → 405 con Allow: GET', async () => {
    expect((await decision(req('GET', '/api/planificacion', TIEMPOS), ENCENDIDA)).action).toBe('agent')
    expect((await decision(req('GET', '/api/planificacion/', TIEMPOS), ENCENDIDA)).action).toBe('agent')
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      const r = req(method, '/api/planificacion', TIEMPOS)
      const d = await decision(r, ENCENDIDA)
      expect(d.action, method).toBe('method-not-allowed')
      const res = respond(d, r)
      expect(res.status, method).toBe(405)
      expect(res.headers.get('allow')).toBe('GET')
    }
  })

  it('cualquier otra ruta o página con el token de Tiempos → 401 o /login', async () => {
    for (const [method, ruta] of [
      ['GET', '/api/resumen'], ['GET', '/api/planificacion/otra'], ['POST', '/api/operaciones/tiempos'], ['POST', '/api/operaciones/tareas'],
      ['PATCH', '/api/operaciones/tareas/DEMO-002'], ['POST', '/api/finanzas/agente/rendimiento'], ['GET', '/planificacion'],
    ] as const) {
      const r = req(method, ruta, TIEMPOS)
      const d = await decision(r, ENCENDIDA)
      expect(d.action, ruta).toBe('unauthenticated')
      expect(respond(d, r).status, ruta).toBe(ruta.startsWith('/api/') ? 401 : 307)
    }
  })

  it('el token del PM no gana la lectura de Tiempos y el de Tiempos no gana las rutas del PM', async () => {
    expect((await decision(req('GET', '/api/planificacion', PM), ENCENDIDA)).action).toBe('unauthenticated')
    expect((await decision(req('GET', '/api/planificacion', FINANZAS), ENCENDIDA)).action).toBe('unauthenticated')
    expect((await decision(req('POST', '/api/operaciones/tiempos', PM), ENCENDIDA)).action).toBe('agent')
    expect((await decision(req('POST', '/api/operaciones/tiempos', TIEMPOS), ENCENDIDA)).action).toBe('unauthenticated')
  })

  it('si el hash de Tiempos es el del PM, el token del PM tampoco lee', async () => {
    const mismo = env({ ...HASHES, TIEMPOS_AGENTE: 'true', TIEMPOS_AGENTE_TOKEN_SHA256: sha(PM) })
    expect((await decision(req('GET', '/api/planificacion', PM), mismo)).action).toBe('unauthenticated')
  })

  it('con cookie de sesión el token no cuenta: decide la sesión', async () => {
    const r = req('GET', '/api/planificacion', TIEMPOS, { cookie: 'next-auth.session-token=manipulada' })
    expect((await decision(r, ENCENDIDA)).action).toBe('unauthenticated')
  })
})

describe('ruta GET /api/planificacion (criterios 1 y 3)', () => {
  const KEYS = ['DASHBOARD_DATA_SOURCE', 'TIEMPOS_AGENTE', 'TIEMPOS_AGENTE_TOKEN_SHA256', 'PM_AGENT_TOKEN_SHA256', 'FINANZAS_AGENTE_TOKEN_SHA256']
  const saved: Record<string, string | undefined> = {}
  beforeAll(() => {
    for (const key of KEYS) saved[key] = process.env[key]
    Object.assign(process.env, { DASHBOARD_DATA_SOURCE: 'fixtures', ...HASHES })
  })
  afterAll(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })
  const get = (token: string) => getPlanificacion(new Request(`${ORIGIN}/api/planificacion?fecha=2026-10-27`, { headers: { authorization: `Bearer ${token}` } }))

  it('bandera apagada: 401 aunque el token sea el de Tiempos', async () => {
    delete process.env.TIEMPOS_AGENTE
    expect((await get(TIEMPOS)).status).toBe(401)
    process.env.TIEMPOS_AGENTE = 'TRUE'
    expect((await get(TIEMPOS)).status).toBe(401)
  })

  it('bandera encendida: el token de Tiempos lee la simulación sin correos; el del PM no', async () => {
    process.env.TIEMPOS_AGENTE = 'true'
    const ok = await get(TIEMPOS)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('cache-control')).toContain('no-store')
    const texto = await ok.text()
    expect(JSON.parse(texto)).toMatchObject({ simulacion: true })
    expect(texto).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
    expect((await get(PM)).status).toBe(401)
    expect((await get(FINANZAS)).status).toBe(401)
  })

  it('solo exporta GET (Next responde 405 a los demás métodos)', async () => {
    const mod = await import('@/app/api/planificacion/route')
    expect(Object.keys(mod).filter((k) => /^[A-Z]+$/.test(k))).toEqual(['GET'])
  })
})

describe('guard de tiempo.crear (criterios 2, 3 y 5)', () => {
  const BASE = { ...HASHES, PROJECT_OS_WRITE_MODE: 'mock', DASHBOARD_DATA_SOURCE: 'fixtures' }
  const ctx = (e: NodeJS.ProcessEnv, operation: OperationName = 'tiempo.crear') => ({
    email: null, env: e, limiter: new RateLimiter(), agentLimiter: new RateLimiter(5, 60_000), operation,
  })
  const alta = (token: string) => new Request(`${ORIGIN}/api/operaciones/tiempos`, {
    method: 'POST', body: JSON.stringify({ requestId: '00000000-0000-4000-8000-000000000001' }),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  })
  const codeOf = async (p: Promise<unknown>) => {
    const e = await p.then(() => undefined, (x: unknown) => x)
    return e instanceof OperationError ? e.code : undefined
  }

  it('bandera apagada → operacion-no-permitida antes de leer el cuerpo', async () => {
    for (const valor of [undefined, 'TRUE', 'on']) {
      expect(await codeOf(evaluateWriteRequest(alta(PM), ctx(env({ ...BASE, TIEMPOS_AGENTE: valor })))), String(valor)).toBe('operacion-no-permitida')
    }
  })

  it('bandera encendida → pasa como agente-pm; el token de Tiempos no escribe', async () => {
    const r = await evaluateWriteRequest(alta(PM), ctx(env({ ...BASE, TIEMPOS_AGENTE: 'true' })))
    expect(r).toMatchObject({ actor: 'agente-pm', agent: true })
    expect(await codeOf(evaluateWriteRequest(alta(TIEMPOS), ctx(env({ ...BASE, TIEMPOS_AGENTE: 'true' }))))).toBe('no-autenticado')
  })

  it('la bandera no agrega otras operaciones al PM ni toca AGENT_OPERATIONS', async () => {
    expect(AGENT_OPERATIONS).not.toContain('tiempo.crear')
    expect(await codeOf(evaluateWriteRequest(alta(PM), ctx(env({ ...BASE, TIEMPOS_AGENTE: 'true' }), 'tiempo.registrar')))).toBe('operacion-no-permitida')
  })
})

describe('render.mjs (criterio 3)', () => {
  const template = readFileSync(path.join(__dirname, '..', 'deploy', 'cloudrun', 'service.template.yaml'), 'utf8')
  const VARS = {
    SERVICE_NAME: 'project-os-dashboard', PROJECT_ID: 'project-os-511102', REGION: 'northamerica-south1',
    IMAGE: `us-docker.pkg.dev/proj-os-1/repo/dash@sha256:${'a'.repeat(64)}`, RUNTIME_SA: 'runtime@project-os-511102.iam.gserviceaccount.com',
    SERVICE_URL: 'https://dash.example.com', OAUTH_CLIENT_ID: '123-abc.apps.googleusercontent.com', SECRET_VERSION_NEXTAUTH: '1',
    SECRET_VERSION_OAUTH: '1', SECRET_VERSION_ALLOWLIST: '1',
  }
  const ON = { ...VARS, TIEMPOS_AGENTE: 'true', SECRET_VERSION_TIEMPOS_AGENTE: '3' }

  it('sin la bandera el YAML no cambia; con ella agrega la bandera y el hash desde Secret Manager', () => {
    const sin = render(template, VARS)
    expect(sin).not.toContain('TIEMPOS_AGENTE')
    expect(render(template, { ...VARS, TIEMPOS_AGENTE: ' ', SECRET_VERSION_TIEMPOS_AGENTE: '' })).toBe(sin)
    expect(render(template, ON)).toMatch(new RegExp(
      "- name: TIEMPOS_AGENTE\\n\\s+value: 'true'\\n\\s+- name: TIEMPOS_AGENTE_TOKEN_SHA256\\n\\s+valueFrom:\\n\\s+secretKeyRef:\\n" +
      "\\s+name: project-os-tiempos-agente-token-sha256\\n\\s+key: '3'\\n",
    ))
  })

  it.each([
    [{ TIEMPOS_AGENTE: 'TRUE' }, 'TIEMPOS_AGENTE solo admite true'],
    [{ TIEMPOS_AGENTE: 'on' }, 'TIEMPOS_AGENTE solo admite true'],
    [{ TIEMPOS_AGENTE: '' }, 'van juntas'],
    [{ SECRET_VERSION_TIEMPOS_AGENTE: '' }, 'van juntas'],
    [{ SECRET_VERSION_TIEMPOS_AGENTE: 'latest' }, 'SECRET_VERSION_TIEMPOS_AGENTE no tiene el formato esperado'],
  ])('rechaza %o', (cambio, mensaje) => {
    expect(() => render(template, { ...ON, ...cambio })).toThrow(mensaje)
  })
})
