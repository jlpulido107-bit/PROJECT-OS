import { isEmailAllowed, parseAllowedEmails } from '../access'
import { LIMITS } from '../operations/constants'
import { OperationError } from '../operations/errors'
import type { RateLimiter } from '../operations/rate-limit'
import { ecoPipelineCanWrite, ecoPipelineWriteMode } from './pipeline-escritura-config'

/** Misma cabecera anti-CSRF que el resto del dashboard (la pone el tablero). */
const CSRF_HEADER = 'x-project-os-csrf'

/**
 * Guard de las rutas de escritura del pipeline (ORD-POS-102, docs/diseno-eco-pipeline.md §4.1 y §4.2). Propio y SIN
 * rama de agente: no reutiliza `evaluateWriteRequest` ni `evaluateFinanzasWriteRequest`, para que un cambio futuro en
 * otra vía no abra estas rutas. Orden: 401 con `Authorization` (antes de leer sesión o cuerpo) → 401 sin sesión →
 * 403 lector → 403 origen/CSRF → 403 modo → 403 escritor → 415 → 413 → 429 → 400 JSON. Función pura, probable sin Next.
 */
export interface EcoWriteContext {
  /** Correo de la sesión NextAuth verificada en el servidor, o null. */
  email: string | null
  env: NodeJS.ProcessEnv
  limiter: RateLimiter
}

/** Cualquier `Authorization` (el token del PM, el del agente de finanzas u otro) se rechaza, aunque venga con cookie. */
export function rejectAuthorization(request: Request): void {
  if (request.headers.has('authorization')) throw new OperationError('no-autenticado')
}

function expectedOrigin(request: Request, env: NodeJS.ProcessEnv): string {
  try {
    if (env.NEXTAUTH_URL) return new URL(env.NEXTAUTH_URL).origin
  } catch {
    // URL inválida: se usa el origen de la propia petición.
  }
  return new URL(request.url).origin
}

export async function evaluateEcoWriteRequest(request: Request, ctx: EcoWriteContext): Promise<{ actor: string; body: unknown }> {
  rejectAuthorization(request)
  if (!ctx.email) throw new OperationError('no-autenticado')
  if (!isEmailAllowed(ctx.email, parseAllowedEmails(ctx.env.AUTH_ALLOWED_EMAILS))) throw new OperationError('sin-permiso-lectura')

  const origin = request.headers.get('origin')
  const fetchSite = request.headers.get('sec-fetch-site')
  if (
    !origin || origin !== expectedOrigin(request, ctx.env) ||
    (fetchSite !== null && fetchSite !== 'same-origin') ||
    request.headers.get(CSRF_HEADER) !== '1'
  ) {
    throw new OperationError('origen-invalido')
  }

  if (ecoPipelineWriteMode(ctx.env) !== 'sheets') throw new OperationError('escritura-deshabilitada')
  if (!ecoPipelineCanWrite(ctx.email, ctx.env)) throw new OperationError('sin-permiso-escritura')

  const type = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (type !== 'application/json') throw new OperationError('tipo-contenido')
  if (Number(request.headers.get('content-length') ?? '0') > LIMITS.bodyBytes) throw new OperationError('payload-demasiado-grande')
  if (!ctx.limiter.take('eco')) throw new OperationError('demasiadas-solicitudes')

  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > LIMITS.bodyBytes) throw new OperationError('payload-demasiado-grande')
  try {
    return { actor: ctx.email.trim().toLowerCase(), body: JSON.parse(text) as unknown }
  } catch {
    throw new OperationError('json-invalido')
  }
}
