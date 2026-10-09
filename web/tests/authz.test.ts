import { encode } from 'next-auth/jwt'
import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'
import { isEmailAllowed, isPublicPath, parseAllowedEmails, safeCallbackPath, sessionMaxAge } from '@/lib/access'
import { decide, respond } from '@/lib/authz'

/**
 * Prueba de autorización de rutas: sin sesión válida y correo permitido, ninguna página ni API
 * privada pasa del proxy. Usa la misma cookie cifrada (JWE) que emite NextAuth.
 */

const SECRET = 'secreto-de-prueba-solo-para-tests-0123456789abcdef'
const ALLOWED = parseAllowedEmails('revisor@example.com')
const COOKIE = 'next-auth.session-token'

async function sessionCookie(email: string, opts: { secret?: string; maxAge?: number } = {}) {
  return encode({ token: { email, name: 'Revisor', sub: '1' }, secret: opts.secret ?? SECRET, maxAge: opts.maxAge })
}

function request(path: string, cookie?: string) {
  const headers = new Headers()
  if (cookie) headers.set('cookie', `${COOKIE}=${cookie}`)
  return new NextRequest(new URL(path, 'http://localhost:3000'), { headers })
}

async function check(path: string, cookie?: string) {
  const req = request(path, cookie)
  const decision = await decide(req, { secret: SECRET, allowed: ALLOWED })
  return { decision, response: respond(decision, req) }
}

const PRIVATE_PAGES = ['/', '/proyectos', '/proyectos/POS', '/tareas?estado=PENDIENTE', '/actividad', '/capacidad']

describe('autorización de rutas (proxy)', () => {
  it.each(PRIVATE_PAGES)('sin sesión, la página %s redirige a /login sin datos', async (path) => {
    const { decision, response } = await check(path)
    expect(decision.action).toBe('unauthenticated')
    expect(response.status).toBe(307)
    const location = new URL(response.headers.get('location')!)
    expect(location.pathname).toBe('/login')
    expect(location.searchParams.get('callbackUrl')).toBe(path)
    expect(await response.text()).toBe('')
  })

  it('sin sesión, la API privada responde 401 sin datos', async () => {
    const { response } = await check('/api/resumen')
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'No autenticado' })
    expect(response.headers.get('cache-control')).toContain('no-store')
  })

  it('cookie firmada con otro secreto → no autenticado', async () => {
    const forged = await sessionCookie('revisor@example.com', { secret: 'otro-secreto-cualquiera-0123456789abcdef' })
    expect((await check('/api/resumen', forged)).response.status).toBe(401)
    expect((await check('/', forged)).decision.action).toBe('unauthenticated')
  })

  it('cookie manipulada → no autenticado', async () => {
    const valid = await sessionCookie('revisor@example.com')
    const tampered = valid.slice(0, -4) + (valid.endsWith('AAAA') ? 'BBBB' : 'AAAA')
    expect((await check('/', tampered)).decision.action).toBe('unauthenticated')
    expect((await check('/', 'no-es-un-jwt')).decision.action).toBe('unauthenticated')
  })

  it('sesión expirada → no autenticado', async () => {
    const expired = await sessionCookie('revisor@example.com', { maxAge: -60 })
    expect((await check('/', expired)).decision.action).toBe('unauthenticated')
  })

  it('sesión válida de un correo NO permitido → 403 en API y redirección AccessDenied en páginas', async () => {
    const stranger = await sessionCookie('intruso@example.com')
    const api = await check('/api/resumen', stranger)
    expect(api.response.status).toBe(403)
    expect(await api.response.json()).toEqual({ error: 'No autorizado' })
    const page = await check('/tareas', stranger)
    expect(page.decision.action).toBe('forbidden')
    expect(new URL(page.response.headers.get('location')!).searchParams.get('error')).toBe('AccessDenied')
  })

  it('sesión válida de un correo permitido (sin distinguir mayúsculas) → acceso', async () => {
    const ok = await sessionCookie('Revisor@Example.com')
    for (const path of [...PRIVATE_PAGES, '/api/resumen']) {
      const { decision, response } = await check(path, ok)
      expect(decision).toEqual({ action: 'allow', email: 'Revisor@Example.com' })
      expect(response.headers.get('x-middleware-next')).toBe('1')
    }
  })

  it('sin NEXTAUTH_SECRET configurado, todo lo privado queda cerrado', async () => {
    const ok = await sessionCookie('revisor@example.com')
    const req = request('/', ok)
    const prev = process.env.NEXTAUTH_SECRET
    delete process.env.NEXTAUTH_SECRET
    try {
      expect(await decide(req, { allowed: ALLOWED })).toEqual({ action: 'unauthenticated' })
    } finally {
      if (prev !== undefined) process.env.NEXTAUTH_SECRET = prev
    }
  })

  it('lista de permitidos vacía → nadie entra', async () => {
    const ok = await sessionCookie('revisor@example.com')
    const decision = await decide(request('/', ok), { secret: SECRET, allowed: parseAllowedEmails('') })
    expect(decision.action).toBe('forbidden')
  })

  it('solo /login, /api/auth/* y recursos estáticos son públicos', async () => {
    for (const path of ['/login', '/api/auth/session', '/api/auth/callback/google', '/_next/static/x.js', '/robots.txt']) {
      expect(isPublicPath(path)).toBe(true)
    }
    for (const path of ['/', '/api/resumen', '/api/authx', '/loginx', '/login/../tareas', '/proyectos']) {
      expect(isPublicPath(new URL(path, 'http://x').pathname)).toBe(false)
    }
  })
})

describe('política de usuarios y sesiones', () => {
  it('lista de correos sin distinguir mayúsculas; ignora entradas inválidas', () => {
    const allowed = parseAllowedEmails(' A@Example.com, b@example.com;no-es-correo ,, ')
    expect([...allowed]).toEqual(['a@example.com', 'b@example.com'])
    expect(isEmailAllowed('a@EXAMPLE.com', allowed)).toBe(true)
    expect(isEmailAllowed('c@example.com', allowed)).toBe(false)
    expect(isEmailAllowed(undefined, allowed)).toBe(false)
  })

  it('duración de sesión: 8 h por defecto, máximo 7 días', () => {
    expect(sessionMaxAge({} as NodeJS.ProcessEnv)).toBe(28_800)
    expect(sessionMaxAge({ AUTH_SESSION_MAX_AGE_SECONDS: '3600' } as unknown as NodeJS.ProcessEnv)).toBe(3600)
    expect(sessionMaxAge({ AUTH_SESSION_MAX_AGE_SECONDS: '99999999' } as unknown as NodeJS.ProcessEnv)).toBe(604_800)
    expect(sessionMaxAge({ AUTH_SESSION_MAX_AGE_SECONDS: 'x' } as unknown as NodeJS.ProcessEnv)).toBe(28_800)
  })

  it('el destino tras login solo puede ser una ruta interna', () => {
    expect(safeCallbackPath('/tareas?estado=PENDIENTE')).toBe('/tareas?estado=PENDIENTE')
    expect(safeCallbackPath('//evil.example')).toBe('/')
    expect(safeCallbackPath('/\\evil.example')).toBe('/')
    expect(safeCallbackPath('https://evil.example')).toBe('/')
    expect(safeCallbackPath(undefined)).toBe('/')
  })
})
