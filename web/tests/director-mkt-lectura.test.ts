import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { render } from '../deploy/cloudrun/render.mjs'
import { decide, respond } from '@/lib/authz'
import { BANDERAS, estadoBandera } from '@/lib/banderas'
import { directorMktLecturaHabilitada, directorMktTokenHash, encargosDelDirectorMkt, esTokenDelDirectorMkt } from '@/lib/director-mkt-lectura'
import { evaluateWriteRequest } from '@/lib/operations/guard'
import { OperationError } from '@/lib/operations/errors'
import { RateLimiter } from '@/lib/operations/rate-limit'
import type { Tarea } from '@/lib/types'

/** Director de Marketing (ORD-POS-170, DEC-POS-038): lectura de sus encargos con token propio, 404 sin bandera. */

const ORIGIN = 'http://127.0.0.1:3000'
const RUTA = '/api/marketing/encargos'
const MKT = 'token-mkt-sintetico-0123456789'
const PM = 'token-pm-sintetico-0123456789'
const TIEMPOS = 'token-tiempos-sintetico-0123456789'
const FINANZAS = 'token-finanzas-sintetico-0123456789'
const sha = (t: string) => createHash('sha256').update(t).digest('hex')
const SECRET = 'secreto-de-prueba-0123456789abcdef'
const env = (extra: Record<string, string | undefined>) => extra as unknown as NodeJS.ProcessEnv

const HASHES = {
  PM_AGENT_TOKEN_SHA256: sha(PM), FINANZAS_AGENTE_TOKEN_SHA256: sha(FINANZAS), TIEMPOS_AGENTE_TOKEN_SHA256: sha(TIEMPOS),
  DIRECTOR_MKT_TOKEN_SHA256: sha(MKT),
}
// Tiempos encendido en los dos casos: su token nunca debe ganar la ruta de Marketing.
const APAGADA = env({ ...HASHES, TIEMPOS_AGENTE: 'true' })
const ENCENDIDA = env({ ...HASHES, TIEMPOS_AGENTE: 'true', DIRECTOR_MKT_LECTURA: 'true' })

const tarea = (id: string, proyectoId: string | null, responsable: string | null): Tarea => ({
  id, proyectoId, hitoId: 'H-1', titulo: `Título ${id}`, descripcion: `Descripción ${id}`, tipo: 'DISEÑO', estado: 'PENDIENTE', prioridad: 'ALTA',
  responsable, fechaPlan: '2026-11-24', fechaLimite: '2026-11-30', horasEstimadas: 2, criterioTerminado: 'criterio-interno', bloqueo: 'bloqueo-interno',
  version: '7', actualizadoEn: null, instrucciones: 'instrucciones-internas',
})
const TAREAS = [
  tarea('BOT-001', 'BOT', 'Propietario'),
  tarea('MES-001', ' mesalenta ', null),
  tarea('ECO-010', 'ECO', ' Director de marketing '),
  tarea('POS-050', 'POS', 'Director de Marketing'),
  tarea('SIG-001', 'SIG', 'Director de Marketing'),
  tarea('SIG-002', 'SIG', 'Persona demo'),
  tarea('POS-051', 'POS', 'PM'),
  tarea('ECO-011', 'ECO', 'Directora de Marketing y Ventas'),
  tarea('BOTICA-1', 'BOTICA', null),
  tarea('X-1', null, null),
]

vi.mock('@/lib/data', () => ({
  getDataset: async () => ({
    ok: true,
    data: {
      source: 'fixtures', tareas: TAREAS,
      decisiones: [{ id: 'DEC-SECRETA-1', asunto: 'decisión que no debe salir' }],
      proyectos: [{ id: 'SIG', nombre: 'proyecto que no debe salir' }],
    },
  }),
}))

const req = (method: string, ruta: string, token: string | null, extra: Record<string, string> = {}) =>
  new NextRequest(new URL(ruta, ORIGIN), { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra } })
const decision = (r: NextRequest, e: NodeJS.ProcessEnv) => decide(r, {
  secret: SECRET, agentTokenSha256: e.PM_AGENT_TOKEN_SHA256, finanzasAgenteTokenSha256: e.FINANZAS_AGENTE_TOKEN_SHA256, tiemposEnv: e, directorMktEnv: e,
})

describe('bandera y hash (criterios 2 y 3)', () => {
  it('solo «true» exacto enciende; el hash debe ser válido y distinto de los demás tokens', () => {
    expect(directorMktLecturaHabilitada(ENCENDIDA)).toBe(true)
    expect(directorMktTokenHash(ENCENDIDA)).toBe(sha(MKT))
    for (const valor of [undefined, '', 'TRUE', 'True', ' true', '1', 'on', 'yes']) {
      expect(directorMktTokenHash(env({ ...HASHES, DIRECTOR_MKT_LECTURA: valor })), String(valor)).toBeNull()
    }
    for (const hash of ['', 'abc', sha(PM), sha(TIEMPOS), sha(FINANZAS), sha(PM).toUpperCase()]) {
      expect(directorMktTokenHash(env({ ...HASHES, DIRECTOR_MKT_LECTURA: 'true', DIRECTOR_MKT_TOKEN_SHA256: hash })), hash).toBeNull()
    }
    expect(directorMktTokenHash(env({ ...HASHES, DIRECTOR_MKT_LECTURA: 'true', CALENDARIO_ICS_TOKEN_SHA256: sha(MKT) }))).toBeNull()
  })

  it('el token con cookie de sesión, otro esquema, de otro rol o sin bandera no cuenta', async () => {
    const h = (headers: Record<string, string>) => new Headers(headers)
    expect(await esTokenDelDirectorMkt(h({ authorization: `Bearer ${MKT}` }), ENCENDIDA)).toBe(true)
    expect(await esTokenDelDirectorMkt(h({ authorization: `Bearer ${MKT}` }), APAGADA)).toBe(false)
    expect(await esTokenDelDirectorMkt(h({ authorization: `Bearer ${MKT}`, cookie: 'next-auth.session-token=x' }), ENCENDIDA)).toBe(false)
    expect(await esTokenDelDirectorMkt(h({ authorization: `Basic ${MKT}` }), ENCENDIDA)).toBe(false)
    for (const otro of [PM, TIEMPOS, FINANZAS]) expect(await esTokenDelDirectorMkt(h({ authorization: `Bearer ${otro}` }), ENCENDIDA)).toBe(false)
  })

  it('está en BANDERAS, apagada con el entorno vacío', () => {
    expect(BANDERAS.DIRECTOR_MKT_LECTURA?.nombre).toBe('Lectura de encargos por el Director de Marketing')
    expect(estadoBandera('DIRECTOR_MKT_LECTURA', env({}))?.tipo).toBe('apagada')
    expect(estadoBandera('DIRECTOR_MKT_LECTURA', ENCENDIDA)?.tipo).toBe('encendida')
  })
})

describe('proxy (criterios 2, 3 y 5)', () => {
  it('bandera apagada: 404 para cualquier token, método o sesión', async () => {
    for (const token of [MKT, PM, TIEMPOS, FINANZAS, null]) {
      for (const method of ['GET', 'POST', 'DELETE']) {
        const r = req(method, RUTA, token)
        const d = await decision(r, APAGADA)
        expect(d.action, `${method} ${token}`).toBe('not-found')
        expect(respond(d, r).status).toBe(404)
      }
    }
    const conCookie = req('GET', RUTA, null, { cookie: 'next-auth.session-token=x' })
    expect((await decision(conCookie, APAGADA)).action).toBe('not-found')
  })

  it('bandera encendida: GET pasa; cualquier otro método → 405 con Allow: GET', async () => {
    expect((await decision(req('GET', RUTA, MKT), ENCENDIDA)).action).toBe('agent')
    expect((await decision(req('GET', `${RUTA}/`, MKT), ENCENDIDA)).action).toBe('agent')
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      const r = req(method, RUTA, MKT)
      const d = await decision(r, ENCENDIDA)
      expect(d.action, method).toBe('method-not-allowed')
      const res = respond(d, r)
      expect(res.status, method).toBe(405)
      expect(res.headers.get('allow')).toBe('GET')
    }
  })

  it('los tokens del PM, de Tiempos y de finanzas, o ninguno, reciben 401', async () => {
    for (const token of [PM, TIEMPOS, FINANZAS, 'otro-token', null]) {
      for (const method of ['GET', 'POST']) {
        const r = req(method, RUTA, token)
        const d = await decision(r, ENCENDIDA)
        expect(d.action, `${method} ${token}`).toBe('unauthenticated')
        expect(respond(d, r).status).toBe(401)
      }
    }
  })

  it('si el hash es el del PM o el de Tiempos, ese token tampoco lee', async () => {
    for (const otro of [PM, TIEMPOS]) {
      const mismo = env({ ...HASHES, TIEMPOS_AGENTE: 'true', DIRECTOR_MKT_LECTURA: 'true', DIRECTOR_MKT_TOKEN_SHA256: sha(otro) })
      expect((await decision(req('GET', RUTA, otro), mismo)).action).toBe('unauthenticated')
    }
  })

  it('el token del Director de Marketing no alcanza ninguna otra ruta ni página', async () => {
    for (const [method, ruta] of [
      ['GET', '/api/resumen'], ['GET', '/api/planificacion'], ['GET', '/api/marketing'], ['GET', '/api/marketing/encargos/otra'],
      ['POST', '/api/operaciones/tareas'], ['PATCH', '/api/operaciones/tareas/DEMO-002'], ['POST', '/api/operaciones/tiempos'],
      ['POST', '/api/finanzas/agente/rendimiento'], ['GET', '/decisiones'], ['GET', '/finanzas'],
    ] as const) {
      const r = req(method, ruta, MKT)
      const d = await decision(r, ENCENDIDA)
      expect(d.action, ruta).toBe('unauthenticated')
      expect(respond(d, r).status, ruta).toBe(ruta.startsWith('/api/') ? 401 : 307)
    }
  })

  it('con cookie de sesión el token no cuenta: decide la sesión', async () => {
    const r = req('GET', RUTA, MKT, { cookie: 'next-auth.session-token=manipulada' })
    expect((await decision(r, ENCENDIDA)).action).toBe('unauthenticated')
  })
})

describe('sin permisos de escritura (criterio 2)', () => {
  it('el guard de operaciones rechaza el token del Director de Marketing', async () => {
    const e = env({ ...HASHES, DIRECTOR_MKT_LECTURA: 'true', TIEMPOS_AGENTE: 'true', PROJECT_OS_WRITE_MODE: 'mock', DASHBOARD_DATA_SOURCE: 'fixtures' })
    for (const operation of ['tarea.crear', 'tiempo.crear', 'decision.crear'] as const) {
      const r = new Request(`${ORIGIN}/api/operaciones/tareas`, {
        method: 'POST', body: JSON.stringify({ requestId: '00000000-0000-4000-8000-000000000001' }),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${MKT}` },
      })
      const error = await evaluateWriteRequest(r, { email: null, env: e, limiter: new RateLimiter(), agentLimiter: new RateLimiter(5, 60_000), operation })
        .then(() => undefined, (x: unknown) => x)
      expect(error instanceof OperationError ? error.code : undefined, operation).toBe('no-autenticado')
    }
  })
})

describe('filtro (criterio 1)', () => {
  it('solo RESPONSABLE «Director de Marketing» o proyectos BOT y MESALENTA; nunca SIG', () => {
    expect(encargosDelDirectorMkt(TAREAS).map((t) => t.id)).toEqual(['BOT-001', 'MES-001', 'ECO-010', 'POS-050'])
    expect(encargosDelDirectorMkt([])).toEqual([])
  })

  it('cada encargo lleva solo ID, título, estado, prioridad, fechas y descripción', () => {
    expect(encargosDelDirectorMkt(TAREAS)[0]).toEqual({
      id: 'BOT-001', titulo: 'Título BOT-001', estado: 'PENDIENTE', prioridad: 'ALTA', fechaPlan: '2026-11-24', fechaLimite: '2026-11-30',
      descripcion: 'Descripción BOT-001',
    })
  })
})

describe('ruta GET /api/marketing/encargos (criterios 1, 2, 3 y 5)', () => {
  const KEYS = ['DIRECTOR_MKT_LECTURA', 'TIEMPOS_AGENTE', ...Object.keys(HASHES)]
  const saved: Record<string, string | undefined> = {}
  beforeAll(() => {
    for (const key of KEYS) saved[key] = process.env[key]
    Object.assign(process.env, { ...HASHES, TIEMPOS_AGENTE: 'true' })
  })
  afterAll(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })
  const get = async (token: string | null, extra: Record<string, string> = {}) => {
    const { GET } = await import('@/app/api/marketing/encargos/route')
    return GET(new Request(`${ORIGIN}${RUTA}`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra } }))
  }

  it('bandera apagada: 404 aunque el token sea el del Director de Marketing', async () => {
    for (const valor of [undefined, 'TRUE', 'on']) {
      if (valor === undefined) delete process.env.DIRECTOR_MKT_LECTURA
      else process.env.DIRECTOR_MKT_LECTURA = valor
      for (const token of [MKT, PM, null]) expect((await get(token)).status, `${valor} ${token}`).toBe(404)
    }
  })

  it('bandera encendida: el token propio lee solo sus encargos; los demás tokens y la sesión, 401', async () => {
    process.env.DIRECTOR_MKT_LECTURA = 'true'
    const ok = await get(MKT)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('cache-control')).toContain('no-store')
    const texto = await ok.text()
    const cuerpo = JSON.parse(texto) as { encargos: Array<Record<string, unknown>> }
    expect(Object.keys(cuerpo).sort()).toEqual(['encargos', 'fuente'])
    expect(cuerpo.encargos.map((t) => t.id)).toEqual(['BOT-001', 'MES-001', 'ECO-010', 'POS-050'])
    for (const t of cuerpo.encargos) {
      expect(Object.keys(t).sort()).toEqual(['descripcion', 'estado', 'fechaLimite', 'fechaPlan', 'id', 'prioridad', 'titulo'])
    }
    expect(texto).not.toMatch(/SIG|DEC-|decisi|interno|internas|Propietario|Director de/i)
    for (const token of [PM, TIEMPOS, FINANZAS, null]) expect((await get(token)).status, String(token)).toBe(401)
    expect((await get(MKT, { cookie: 'next-auth.session-token=x' })).status).toBe(401)
  })

  it('solo exporta GET (Next responde 405 a los demás métodos)', async () => {
    const mod = await import('@/app/api/marketing/encargos/route')
    expect(Object.keys(mod).filter((k) => /^[A-Z]+$/.test(k))).toEqual(['GET'])
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
  const ON = { ...VARS, DIRECTOR_MKT_LECTURA: 'true', SECRET_VERSION_DIRECTOR_MKT: '3' }

  it('sin la bandera el YAML no cambia; con ella agrega la bandera y el hash desde Secret Manager', () => {
    const sin = render(template, VARS)
    expect(sin).not.toContain('DIRECTOR_MKT')
    expect(render(template, { ...VARS, DIRECTOR_MKT_LECTURA: ' ', SECRET_VERSION_DIRECTOR_MKT: '' })).toBe(sin)
    expect(render(template, ON)).toMatch(new RegExp(
      "- name: DIRECTOR_MKT_LECTURA\\n\\s+value: 'true'\\n\\s+- name: DIRECTOR_MKT_TOKEN_SHA256\\n\\s+valueFrom:\\n\\s+secretKeyRef:\\n" +
      "\\s+name: project-os-director-mkt-token-sha256\\n\\s+key: '3'\\n",
    ))
  })

  it.each([
    [{ DIRECTOR_MKT_LECTURA: 'TRUE' }, 'DIRECTOR_MKT_LECTURA solo admite true'],
    [{ DIRECTOR_MKT_LECTURA: 'on' }, 'DIRECTOR_MKT_LECTURA solo admite true'],
    [{ DIRECTOR_MKT_LECTURA: '' }, 'van juntas'],
    [{ SECRET_VERSION_DIRECTOR_MKT: '' }, 'van juntas'],
    [{ SECRET_VERSION_DIRECTOR_MKT: 'latest' }, 'SECRET_VERSION_DIRECTOR_MKT no tiene el formato esperado'],
  ])('rechaza %o', (cambio, mensaje) => {
    expect(() => render(template, { ...ON, ...cambio })).toThrow(mensaje)
  })
})
