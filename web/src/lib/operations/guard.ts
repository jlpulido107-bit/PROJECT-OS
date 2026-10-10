import { isEmailAllowed, parseAllowedEmails } from '../access'
import { LIMITS } from './constants'
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

export async function evaluateWriteRequest(
  request: Request,
  ctx: WriteRequestContext,
): Promise<{ actor: string; body: unknown }> {
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

  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > LIMITS.bodyBytes) throw new OperationError('payload-demasiado-grande')
  try {
    return { actor: ctx.email.toLowerCase(), body: JSON.parse(text) as unknown }
  } catch {
    throw new OperationError('json-invalido')
  }
}
