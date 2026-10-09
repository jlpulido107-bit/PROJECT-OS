import { getToken } from 'next-auth/jwt'
import { NextResponse, type NextRequest } from 'next/server'
import { allowedEmails, isEmailAllowed, isPublicPath } from './access'

export type AuthDecision =
  | { action: 'public' }
  | { action: 'allow'; email: string }
  | { action: 'unauthenticated' }
  | { action: 'forbidden' }

/**
 * Decide el acceso a una petición a partir de la cookie de sesión cifrada (JWE) de NextAuth.
 * Una cookie ausente, manipulada, expirada o firmada con otro secreto → no autenticado.
 */
export async function decide(
  req: NextRequest,
  opts: { secret?: string; allowed?: Set<string> } = {},
): Promise<AuthDecision> {
  if (isPublicPath(req.nextUrl.pathname)) return { action: 'public' }
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

const NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0' }

/** Respuesta del proxy: APIs → 401/403 JSON sin datos; páginas → redirección a /login. */
export function respond(decision: AuthDecision, req: NextRequest): NextResponse {
  if (decision.action === 'public' || decision.action === 'allow') return NextResponse.next()
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
