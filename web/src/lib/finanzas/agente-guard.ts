import { createHash, timingSafeEqual } from 'node:crypto'
import { LIMITS } from '../operations/constants'
import { OperationError } from '../operations/errors'
import type { RateLimiter } from '../operations/rate-limit'
import { finanzasAgenteMode, finanzasAgenteTokenHash } from './agente-config'

/**
 * Guard propio de las rutas del agente de finanzas (ORD-POS-092, docs/diseno-finanzas-v3.md §2.3). No reutiliza
 * `evaluateWriteRequest` (PM) ni `evaluateFinanzasWriteRequest` (propietario): ninguno de los dos tiene rama para este
 * token, y este no tiene rama de sesión. Orden: 401 sin `Authorization` o con cookie de sesión → 401 token que no
 * cuadra (incluido el del PM) → 403 modo → 415 → 413 → 429 → 400 JSON. Función pura, probable sin Next.
 */
export interface FinanzasAgenteContext {
  env: NodeJS.ProcessEnv
  limiter: RateLimiter
}

/** Actor de la AUDITORIA de FINANZAS para todo lo que escribe el agente (§6). */
export const FINANZAS_AGENTE_ACTOR = 'agente-finanzas'
const RATE_KEY = 'finanzas-agente'
const NEXTAUTH_SESSION_COOKIE = /next-auth\.session-token/

/**
 * SHA-256 del token contra FINANZAS_AGENTE_TOKEN_SHA256 en tiempo constante. Sin hash válido, o si es el mismo que
 * PM_AGENT_TOKEN_SHA256 (el token del PM entraría aquí), nunca coincide.
 */
export function finanzasAgenteTokenMatches(token: string, env: NodeJS.ProcessEnv): boolean {
  const expected = finanzasAgenteTokenHash(env)
  if (!expected || expected === (env.PM_AGENT_TOKEN_SHA256 ?? '').trim().toLowerCase()) return false
  const actual = createHash('sha256').update(token, 'utf8').digest()
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'))
}

/** 401 antes de mirar el modo o el cuerpo: sin `Authorization: Bearer` del agente, o con cookie de sesión. */
export function rejectNonAgent(request: Request, env: NodeJS.ProcessEnv): void {
  if (NEXTAUTH_SESSION_COOKIE.test(request.headers.get('cookie') ?? '')) throw new OperationError('no-autenticado')
  const token = /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '')?.[1]
  if (!token || !finanzasAgenteTokenMatches(token, env)) throw new OperationError('no-autenticado')
}

export async function evaluateFinanzasAgenteRequest(request: Request, ctx: FinanzasAgenteContext): Promise<{ actor: string; body: unknown }> {
  rejectNonAgent(request, ctx.env)
  if (finanzasAgenteMode(ctx.env) !== 'sheets') throw new OperationError('escritura-deshabilitada')

  const type = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (type !== 'application/json') throw new OperationError('tipo-contenido')
  if (Number(request.headers.get('content-length') ?? '0') > LIMITS.bodyBytes) throw new OperationError('payload-demasiado-grande')
  if (!ctx.limiter.take(RATE_KEY)) throw new OperationError('demasiadas-solicitudes')

  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > LIMITS.bodyBytes) throw new OperationError('payload-demasiado-grande')
  try {
    return { actor: FINANZAS_AGENTE_ACTOR, body: JSON.parse(text) as unknown }
  } catch {
    throw new OperationError('json-invalido')
  }
}
