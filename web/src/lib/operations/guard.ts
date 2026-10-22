import { isEmailAllowed, parseAllowedEmails } from '../access'
import { createHash, timingSafeEqual } from 'node:crypto'
import { AGENT_ACTOR, AGENT_EDITABLE_TASK_FIELDS, AGENT_OPERATIONS, AGENT_ORDER_ACTIONS, LIMITS, type OperationName } from './constants'
import { isWriter, writeModeStatus } from './config'
import { OperationError } from './errors'
import type { RateLimiter } from './rate-limit'

/**
 * Verificaciones de una petición de escritura, en orden (contrato §4–5). Función pura y probable sin Next:
 * 401 sesión → 403 lector → 403 origen/CSRF → 403 modo → 403 escritor → 415 → 413 → 429 → 400 JSON.
 */
export interface WriteRequestContext {
  /** Correo de la sesión NextAuth verificada en el servidor, o null. */
  email: string | null
  env: NodeJS.ProcessEnv
  limiter: RateLimiter
  /** Operación que la ruta va a ejecutar; el agente PM solo puede las de la lista blanca. */
  operation?: OperationName
  /** Límite propio del agente PM (clave `agente-pm`). Sin él, el acceso del agente se rechaza. */
  agentLimiter?: RateLimiter
}

export const CSRF_HEADER = 'x-project-os-csrf'

function expectedOrigin(request: Request, env: NodeJS.ProcessEnv): string {
  try {
    if (env.NEXTAUTH_URL) return new URL(env.NEXTAUTH_URL).origin
  } catch {
    // URL inválida: se usa el origen de la propia petición.
  }
  return new URL(request.url).origin
}

const NEXTAUTH_SESSION_COOKIE = /next-auth\.session-token/

/** SHA-256 del token Bearer contra PM_AGENT_TOKEN_SHA256 en tiempo constante; sin variable válida, nunca coincide. */
function agentTokenMatches(token: string, env: NodeJS.ProcessEnv): boolean {
  const expected = (env.PM_AGENT_TOKEN_SHA256 ?? '').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(expected)) return false
  const actual = createHash('sha256').update(token, 'utf8').digest()
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'))
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > LIMITS.bodyBytes) throw new OperationError('payload-demasiado-grande')
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new OperationError('json-invalido')
  }
}

/** Agente PM: token propio, lista blanca de operaciones y de campos; sin sesión, CSRF ni escritores (no hay navegador). */
async function evaluateAgentRequest(
  request: Request, ctx: WriteRequestContext, authorization: string,
): Promise<{ actor: string; body: unknown; agent: true }> {
  if (NEXTAUTH_SESSION_COOKIE.test(request.headers.get('cookie') ?? '')) throw new OperationError('credenciales-ambiguas')
  const token = /^Bearer (\S+)$/.exec(authorization)?.[1]
  if (!token || !ctx.agentLimiter || !agentTokenMatches(token, ctx.env)) throw new OperationError('no-autenticado')
  if (!ctx.operation || !AGENT_OPERATIONS.includes(ctx.operation)) throw new OperationError('operacion-no-permitida')
  if (writeModeStatus(ctx.env).mode === 'disabled') throw new OperationError('escritura-deshabilitada')

  const type = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (type !== 'application/json') throw new OperationError('tipo-contenido')
  if (Number(request.headers.get('content-length') ?? '0') > LIMITS.bodyBytes) throw new OperationError('payload-demasiado-grande')
  if (!ctx.agentLimiter.take(AGENT_ACTOR)) throw new OperationError('demasiadas-solicitudes')

  const body = await readJson(request)
  if (ctx.operation === 'tarea.crear' && body && typeof body === 'object' && !Array.isArray(body)) {
    // DEC-POS-005: el PM no fija bloqueos de tareas, tampoco al crearlas.
    if (Object.keys(body).some((key) => key.toLowerCase() === 'bloqueo')) throw new OperationError('operacion-no-permitida')
  }
  if (ctx.operation === 'orden.aprobar') {
    // DEC-POS-011: cerrar, cancelar y las demás transiciones son del propietario, antes de validar nada más.
    const accion = body && typeof body === 'object' ? (body as Record<string, unknown>).accion : undefined
    // El parser normaliza la acción; el guard también, para no rechazar « revisar » ni dejar pasar otra grafía (ORD-POS-059).
    if (typeof accion !== 'string' || !AGENT_ORDER_ACTIONS.includes(accion.trim().toUpperCase())) throw new OperationError('transicion-reservada-pm')
  }
  if (ctx.operation === 'tarea.editar') {
    const changes = body && typeof body === 'object' ? (body as Record<string, unknown>).changes : undefined
    if (changes && typeof changes === 'object' && !Array.isArray(changes)) {
      const allowed: readonly string[] = AGENT_EDITABLE_TASK_FIELDS
      if (Object.keys(changes).some((key) => !allowed.includes(key))) throw new OperationError('operacion-no-permitida')
    }
  }
  return { actor: AGENT_ACTOR, body, agent: true }
}

export async function evaluateWriteRequest(
  request: Request,
  ctx: WriteRequestContext,
): Promise<{ actor: string; body: unknown; agent?: true }> {
  const authorization = request.headers.get('authorization')
  if (authorization !== null) return evaluateAgentRequest(request, ctx, authorization)
  if (!ctx.email) throw new OperationError('no-autenticado')
  if (!isEmailAllowed(ctx.email, parseAllowedEmails(ctx.env.AUTH_ALLOWED_EMAILS))) {
    throw new OperationError('sin-permiso-lectura')
  }

  const origin = request.headers.get('origin')
  const fetchSite = request.headers.get('sec-fetch-site')
  if (
    !origin || origin !== expectedOrigin(request, ctx.env) ||
    (fetchSite !== null && fetchSite !== 'same-origin') ||
    request.headers.get(CSRF_HEADER) !== '1'
  ) {
    throw new OperationError('origen-invalido')
  }

  if (writeModeStatus(ctx.env).mode === 'disabled') throw new OperationError('escritura-deshabilitada')
  if (!isWriter(ctx.email, ctx.env)) throw new OperationError('sin-permiso-escritura')

  const type = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (type !== 'application/json') throw new OperationError('tipo-contenido')
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > LIMITS.bodyBytes) throw new OperationError('payload-demasiado-grande')

  if (!ctx.limiter.take(ctx.email.toLowerCase())) throw new OperationError('demasiadas-solicitudes')

  return { actor: ctx.email.toLowerCase(), body: await readJson(request) }
}
