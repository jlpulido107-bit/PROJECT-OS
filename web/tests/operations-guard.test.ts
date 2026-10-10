import { describe, expect, it } from 'vitest'
import { canWrite, isWriter, writeModeStatus, writerEmails } from '@/lib/operations/config'
import { OperationError } from '@/lib/operations/errors'
import { CSRF_HEADER, evaluateWriteRequest } from '@/lib/operations/guard'
import { RateLimiter } from '@/lib/operations/rate-limit'

const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv
const ORIGIN = 'http://127.0.0.1:3000'
const BASE = {
  NEXTAUTH_URL: ORIGIN,
  AUTH_ALLOWED_EMAILS: 'lector@example.com, escritor@example.com',
  AUTH_WRITER_EMAILS: 'escritor@example.com',
  PROJECT_OS_WRITE_MODE: 'mock',
  DASHBOARD_DATA_SOURCE: 'fixtures',
}

function request(body: unknown = { requestId: 'x' }, headers: Record<string, string> = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return new Request(`${ORIGIN}/api/operaciones/tareas`, {
    method: 'POST',
    body: text,
    headers: { origin: ORIGIN, 'content-type': 'application/json', [CSRF_HEADER]: '1', 'sec-fetch-site': 'same-origin', ...headers },
  })
}

async function code(promise: Promise<unknown>) {
  const error = await promise.catch((e: unknown) => e)
  expect(error).toBeInstanceOf(OperationError)
  return { code: (error as OperationError).code, status: (error as OperationError).status }
}

const ctx = (email: string | null, vars: Record<string, string> = BASE) => ({ email, env: env(vars), limiter: new RateLimiter() })

describe('modo de escritura (por defecto nadie escribe)', () => {
  it('sin configuración: deshabilitado', () => {
    expect(writeModeStatus(env({}))).toEqual({ mode: 'disabled', requested: 'disabled', reason: 'deshabilitada' })
    expect(canWrite('escritor@example.com', env({ AUTH_ALLOWED_EMAILS: 'escritor@example.com', AUTH_WRITER_EMAILS: 'escritor@example.com' }))).toBe(false)
  })

  it('sheets está reconocido pero bloqueado en V1.4', () => {
    expect(writeModeStatus(env({ ...BASE, PROJECT_OS_WRITE_MODE: 'sheets', DASHBOARD_DATA_SOURCE: 'sheets' }))).toMatchObject({ mode: 'disabled', reason: 'sheets-no-habilitado' })
  })

  it('mock solo con fixtures y fuera de Cloud Run; valores desconocidos deshabilitan', () => {
    expect(writeModeStatus(env(BASE)).mode).toBe('mock')
    expect(writeModeStatus(env({ ...BASE, DASHBOARD_DATA_SOURCE: 'sheets' }))).toMatchObject({ mode: 'disabled', reason: 'mock-requiere-fixtures' })
    expect(writeModeStatus(env({ ...BASE, DASHBOARD_DATA_SOURCE: '' }))).toMatchObject({ mode: 'disabled', reason: 'mock-requiere-fixtures' })
    expect(writeModeStatus(env({ ...BASE, K_SERVICE: 'project-os-dashboard' }))).toMatchObject({ mode: 'disabled', reason: 'mock-no-permitido-en-cloud-run' })
    expect(writeModeStatus(env({ ...BASE, PROJECT_OS_WRITE_MODE: 'on' }))).toMatchObject({ mode: 'disabled', reason: 'modo-invalido' })
  })

  it('la allowlist de login NO da permiso de escritura; escritores deben ser lectores', () => {
    expect(isWriter('lector@example.com', env(BASE))).toBe(false)
    expect(isWriter('ESCRITOR@example.com', env(BASE))).toBe(true)
    expect([...writerEmails(env({ ...BASE, AUTH_WRITER_EMAILS: 'escritor@example.com, intruso@example.com' }))]).toEqual(['escritor@example.com'])
    expect(writerEmails(env({ ...BASE, AUTH_WRITER_EMAILS: '' })).size).toBe(0)
  })
})

describe('verificación de peticiones de escritura (orden)', () => {
  it('sin sesión → 401', async () => {
    expect(await code(evaluateWriteRequest(request(), ctx(null)))).toEqual({ code: 'no-autenticado', status: 401 })
  })

  it('correo fuera de la allowlist → 403 sin-permiso-lectura', async () => {
    expect(await code(evaluateWriteRequest(request(), ctx('intruso@example.com')))).toEqual({ code: 'sin-permiso-lectura', status: 403 })
  })

  it.each([
    ['sin Origin', { origin: '' }],
    ['Origin de otro sitio', { origin: 'https://evil.example' }],
    ['Sec-Fetch-Site cross-site', { 'sec-fetch-site': 'cross-site' }],
    ['sin cabecera CSRF', { [CSRF_HEADER]: '' }],
    ['cabecera CSRF incorrecta', { [CSRF_HEADER]: 'true' }],
  ] as Array<[string, Record<string, string>]>)('%s → 403 origen-invalido', async (_name, headers) => {
    const req = request({ requestId: 'x' }, headers)
    if (headers.origin === '') req.headers.delete('origin')
    expect(await code(evaluateWriteRequest(req, ctx('escritor@example.com')))).toEqual({ code: 'origen-invalido', status: 403 })
  })

  it('modo deshabilitado → 403 incluso para escritores', async () => {
    const vars = { ...BASE, PROJECT_OS_WRITE_MODE: 'disabled' }
    expect(await code(evaluateWriteRequest(request(), ctx('escritor@example.com', vars)))).toEqual({ code: 'escritura-deshabilitada', status: 403 })
    const sheets = { ...BASE, PROJECT_OS_WRITE_MODE: 'sheets' }
    expect(await code(evaluateWriteRequest(request(), ctx('escritor@example.com', sheets)))).toEqual({ code: 'escritura-deshabilitada', status: 403 })
  })

  it('lector autenticado (allowlist de escritores vacía o sin incluirlo) → 403', async () => {
    expect(await code(evaluateWriteRequest(request(), ctx('lector@example.com')))).toEqual({ code: 'sin-permiso-escritura', status: 403 })
    const empty = { ...BASE, AUTH_WRITER_EMAILS: '' }
    expect(await code(evaluateWriteRequest(request(), ctx('escritor@example.com', empty)))).toEqual({ code: 'sin-permiso-escritura', status: 403 })
  })

  it('tipo de contenido no JSON → 415', async () => {
    const req = request('a=1', { 'content-type': 'application/x-www-form-urlencoded' })
    expect(await code(evaluateWriteRequest(req, ctx('escritor@example.com')))).toEqual({ code: 'tipo-contenido', status: 415 })
  })

  it('payload mayor a 16 KiB → 413 (por cabecera y por cuerpo real)', async () => {
    const big = JSON.stringify({ requestId: 'x', titulo: 'x'.repeat(17_000) })
    expect(await code(evaluateWriteRequest(request(big), ctx('escritor@example.com')))).toEqual({ code: 'payload-demasiado-grande', status: 413 })
    const lying = request(big, { 'content-length': '10' })
    expect(await code(evaluateWriteRequest(lying, ctx('escritor@example.com')))).toEqual({ code: 'payload-demasiado-grande', status: 413 })
  })

  it('JSON inválido → 400', async () => {
    expect(await code(evaluateWriteRequest(request('{no json'), ctx('escritor@example.com')))).toEqual({ code: 'json-invalido', status: 400 })
  })

  it('límite de frecuencia por actor → 429', async () => {
    const limiter = new RateLimiter(3, 60_000, () => 0)
    const c = { email: 'escritor@example.com', env: env(BASE), limiter }
    for (let i = 0; i < 3; i++) await evaluateWriteRequest(request(), c)
    expect(await code(evaluateWriteRequest(request(), c))).toEqual({ code: 'demasiadas-solicitudes', status: 429 })
  })

  it('petición válida → actor normalizado y cuerpo', async () => {
    const result = await evaluateWriteRequest(request({ requestId: 'abc' }), ctx('Escritor@Example.com'))
    expect(result).toEqual({ actor: 'escritor@example.com', body: { requestId: 'abc' } })
  })
})

describe('límite de frecuencia', () => {
  it('se recupera con el tiempo y es independiente por actor', () => {
    let now = 0
    const limiter = new RateLimiter(2, 1000, () => now)
    expect([limiter.take('a'), limiter.take('a'), limiter.take('a')]).toEqual([true, true, false])
    expect(limiter.take('b')).toBe(true)
    now = 1000
    expect(limiter.take('a')).toBe(true)
    expect(limiter.take('a')).toBe(false)
  })
})

describe('OperationError entre paquetes', () => {
  it('se reconoce aunque venga de otra copia de la clase (rutas y páginas se empaquetan aparte)', () => {
    const foreign = Object.assign(new Error('x'), { [Symbol.for('project-os.operation-error')]: true, code: 'validacion' })
    expect(foreign instanceof OperationError).toBe(true)
    expect(new OperationError('validacion') instanceof OperationError).toBe(true)
    expect(new Error('x') instanceof OperationError).toBe(false)
    expect((null as unknown as object) instanceof OperationError).toBe(false)
  })
})
