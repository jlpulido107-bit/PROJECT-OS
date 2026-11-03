import { getToken } from 'next-auth/jwt'
import { NextResponse, type NextRequest } from 'next/server'
import { allowedEmails, isEmailAllowed, isPublicPath } from './access'
import { CALENDARIO_ICS_RUTA } from './calendario-ics-acceso'
import { esTokenDeTiempos, TIEMPOS_AGENTE_RUTA } from './tiempos-agente'

export type AuthDecision =
  | { action: 'public' }
  | { action: 'allow'; email: string }
  /**
   * Agente PM con token válido (ORD-POS-027), o agente de finanzas con el suyo en sus rutas (ORD-POS-092): la API
   * vuelve a verificar token, operación y campos.
   */
  | { action: 'agent' }
  /** Token de Tiempos válido en /api/planificacion con un método distinto de GET (ORD-POS-112). */
  | { action: 'method-not-allowed' }
  | { action: 'unauthenticated' }
  | { action: 'forbidden' }

/**
 * Decide el acceso a una petición a partir de la cookie de sesión cifrada (JWE) de NextAuth.
 * Una cookie ausente, manipulada, expirada o firmada con otro secreto → no autenticado.
 */
export async function decide(
  req: NextRequest,
  opts: {
    secret?: string; allowed?: Set<string>; agentTokenSha256?: string; finanzasAgenteTokenSha256?: string
    /** Entorno del rol Tiempos (bandera y los tres hashes); por defecto process.env. */
    tiemposEnv?: NodeJS.ProcessEnv
  } = {},
): Promise<AuthDecision> {
  if (isPublicPath(req.nextUrl.pathname)) return { action: 'public' }
  // ORD-POS-142 (escritura §11.3): única exención sin sesión, GET y la ruta exacta del calendario ICS. El proxy no valida
  // el secreto ni lee la hoja: la ruta responde 404 sin PLANIFICACION_ICS, sin token o con uno que no coincide.
  if (req.method === 'GET' && req.nextUrl.pathname === CALENDARIO_ICS_RUTA) return { action: 'public' }
  const pmHash = opts.agentTokenSha256 ?? process.env.PM_AGENT_TOKEN_SHA256
  if (await isAgentRequest(req, pmHash, AGENT_ROUTES)) return { action: 'agent' }
  const finanzasHash = opts.finanzasAgenteTokenSha256 ?? process.env.FINANZAS_AGENTE_TOKEN_SHA256
  // Un hash igual al del PM dejaría entrar el token del PM a las rutas de finanzas: nunca coincide (diseño v3 §2.3).
  if (normalHash(finanzasHash) !== normalHash(pmHash) && await isAgentRequest(req, finanzasHash, FINANZAS_AGENT_ROUTES)) return { action: 'agent' }
  // ORD-POS-112: el token de Tiempos solo alcanza /api/planificacion y solo con GET; inerte sin TIEMPOS_AGENTE=true.
  if (TIEMPOS_AGENTE_RUTA.test(req.nextUrl.pathname) && await esTokenDeTiempos(req.headers, opts.tiemposEnv ?? process.env)) {
    return req.method === 'GET' ? { action: 'agent' } : { action: 'method-not-allowed' }
  }
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

/**
 * Únicas rutas que el agente PM puede alcanzar sin sesión: POST de altas y PATCH de una tarea o de una orden
 * (DEC-POS-011). El alta en TIEMPOS (ORD-POS-112) pasa el proxy, pero la API la rechaza sin TIEMPOS_AGENTE=true; igual
 * el alta de ideas en RADAROS (ORD-POS-131) sin ECO_IDEAS_ALTA=true.
 */
const AGENT_ROUTES: Array<[method: string, path: RegExp]> = [
  ['POST', /^\/api\/operaciones\/(tareas|decisiones|ordenes|tiempos|ideas)\/?$/],
  ['PATCH', /^\/api\/operaciones\/(tareas|ordenes)\/[^/]+\/?$/],
]

/** Únicas rutas del agente de finanzas, con su propio token (ORD-POS-092, docs/diseno-finanzas-v3.md §2.4). */
const FINANZAS_AGENT_ROUTES: Array<[method: string, path: RegExp]> = [
  ['POST', /^\/api\/finanzas\/agente\/(rendimiento|cargo-extra)\/?$/],
]

const normalHash = (hash: string | undefined) => (hash ?? '').trim().toLowerCase()

/** Comparación en tiempo constante de dos cadenas hex del mismo largo. */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Petición de un agente: ruta y método de su lista, `Authorization: Bearer` y SHA-256 (Web Crypto) igual a su hash
 * (PM_AGENT_TOKEN_SHA256 o FINANZAS_AGENTE_TOKEN_SHA256). Sin variable válida, o con cookie de sesión presente, nunca;
 * el guard de la API repite todo.
 */
async function isAgentRequest(req: NextRequest, expected: string | undefined, routes: Array<[method: string, path: RegExp]>): Promise<boolean> {
  const hash = normalHash(expected)
  if (!/^[0-9a-f]{64}$/.test(hash)) return false
  if (!routes.some(([method, path]) => req.method === method && path.test(req.nextUrl.pathname))) return false
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
  if (decision.action === 'method-not-allowed') {
    return NextResponse.json({ error: 'Método no permitido' }, { status: 405, headers: { ...NO_STORE, Allow: 'GET' } })
  }
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
