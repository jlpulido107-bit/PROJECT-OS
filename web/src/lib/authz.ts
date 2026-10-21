import { getToken } from 'next-auth/jwt'
import { NextResponse, type NextRequest } from 'next/server'
import { allowedEmails, isEmailAllowed, isPublicPath } from './access'

export type AuthDecision =
  | { action: 'public' }
  | { action: 'allow'; email: string }
  /** Agente PM con token válido (ORD-POS-027): la API vuelve a verificar token, operación y campos. */
  | { action: 'agent' }
  | { action: 'unauthenticated' }
  | { action: 'forbidden' }

/**
 * Decide el acceso a una petición a partir de la cookie de sesión cifrada (JWE) de NextAuth.
 * Una cookie ausente, manipulada, expirada o firmada con otro secreto → no autenticado.
 */
export async function decide(
  req: NextRequest,
  opts: { secret?: string; allowed?: Set<string>; agentTokenSha256?: string } = {},
): Promise<AuthDecision> {
  if (isPublicPath(req.nextUrl.pathname)) return { action: 'public' }
  if (await isAgentRequest(req, opts.agentTokenSha256 ?? process.env.PM_AGENT_TOKEN_SHA256)) return { action: 'agent' }
  const secret = opts.secret ?? process.env.NEXTAUTH_SECRET
  if (!secret) return { action: 'unauthenticated' }
  let token: Awaited<ReturnType<typeof getToken>> = null
  try {
    token = await getToken({ req, secret })
  } catch {
    token = null
  }
  if (!token?.email) return { action: 'unauthenticated' }
  if (!isEmailAllowed(token.email, opts.allowed ?? allowedEmails())) return { action: 'forbidden' }
  return { action: 'allow', email: token.email }
}

/** Únicas rutas que el agente PM puede alcanzar sin sesión: POST de altas y PATCH de una tarea o de una orden (DEC-POS-011). */
const AGENT_ROUTES: Array<[method: string, path: RegExp]> = [
  ['POST', /^\/api\/operaciones\/(tareas|decisiones|ordenes)\/?$/],
  ['PATCH', /^\/api\/operaciones\/(tareas|ordenes)\/[^/]+\/?$/],
]

/** Comparación en tiempo constante de dos cadenas hex del mismo largo. */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Petición del agente PM: ruta y método de la lista, `Authorization: Bearer` y SHA-256 (Web Crypto) igual a
 * PM_AGENT_TOKEN_SHA256. Sin variable válida, o con cookie de sesión presente, nunca; el guard de la API repite todo.
 */
async function isAgentRequest(req: NextRequest, expected: string | undefined): Promise<boolean> {
  const hash = (expected ?? '').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(hash)) return false
  if (!AGENT_ROUTES.some(([method, path]) => req.method === method && path.test(req.nextUrl.pathname))) return false
  if (/next-auth\.session-token/.test(req.headers.get('cookie') ?? '')) return false
  const token = /^Bearer (\S+)$/.exec(req.headers.get('authorization') ?? '')?.[1]
  if (!token) return false
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  const actual = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
  return sameHex(actual, hash)
}

const NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0' }

/** Respuesta del proxy: APIs → 401/403 JSON sin datos; páginas → redirección a /login. */
export function respond(decision: AuthDecision, req: NextRequest): NextResponse {
  if (decision.action === 'public' || decision.action === 'allow' || decision.action === 'agent') return NextResponse.next()
  const isApi = req.nextUrl.pathname.startsWith('/api/')
  if (isApi) {
    return decision.action === 'forbidden'
      ? NextResponse.json({ error: 'No autorizado' }, { status: 403, headers: NO_STORE })
      : NextResponse.json({ error: 'No autenticado' }, { status: 401, headers: NO_STORE })
  }
  const login = new URL('/login', req.nextUrl.origin)
  if (decision.action === 'forbidden') {
    login.searchParams.set('error', 'AccessDenied')
  } else {
    login.searchParams.set('callbackUrl', req.nextUrl.pathname + req.nextUrl.search)
  }
  return NextResponse.redirect(login, { headers: NO_STORE })
}
