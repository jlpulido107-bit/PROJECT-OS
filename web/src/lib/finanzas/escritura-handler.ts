import { OperationError } from '../operations/errors'
import type { RateLimiter } from '../operations/rate-limit'
import { finanzasWriteMode } from './escritura-config'
import { evaluateFinanzasWriteRequest, rejectAuthorization } from './escritura-guard'
import type { FinanzasContext, FinanzasResultado, FinanzasWriteService } from './escritura-service'
import { subirGeneracionFinanzas } from './generacion'

/**
 * Núcleo de las rutas de escritura de finanzas, sin Next (ORD-POS-077): se prueba con dobles de sesión, de token y de
 * `fetch`. El servicio (y con él el proveedor de token) solo se pide DESPUÉS del guard: con la escritura apagada o la
 * petición rechazada no hay ninguna llamada a IAM ni a Sheets.
 */
export interface FinanzasHandlerDeps {
  /** Correo de la sesión; no se llama si la petición trae `Authorization`. */
  sessionEmail: () => Promise<string | null>
  env: NodeJS.ProcessEnv
  limiter: RateLimiter
  service: () => FinanzasWriteService | null
}

export interface FinanzasRespuesta {
  status: number
  body: Record<string, unknown>
}

function requestIdOf(body: unknown): string | undefined {
  const id = body && typeof body === 'object' ? (body as Record<string, unknown>).requestId : undefined
  return typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id) ? id : undefined
}

function errorBody(error: OperationError, requestId?: string): FinanzasRespuesta {
  if (error.status >= 500 || error.code.startsWith('conflicto') || error.code === 'verificacion-fallida') {
    // Solo código y requestId: nunca correos, montos ni valores.
    console.warn(`[project-os] finanzas rechazada: ${error.code}${requestId ? ` req=${requestId}` : ''}`)
  }
  return {
    status: error.status,
    body: {
      ok: false,
      error: { codigo: error.code, mensaje: error.message, ...(error.fields ? { campos: error.fields } : {}), ...(error.detail ? { detalle: error.detail } : {}) },
      ...(requestId ? { requestId } : {}),
    },
  }
}

export async function finanzasWrite(
  request: Request,
  deps: FinanzasHandlerDeps,
  run: (service: FinanzasWriteService, body: unknown, ctx: FinanzasContext) => Promise<FinanzasResultado>,
): Promise<FinanzasRespuesta> {
  let requestId: string | undefined
  try {
    // Antes de leer la sesión o el cuerpo: cualquier Authorization (p. ej. el token del PM) es 401.
    rejectAuthorization(request)
    const { actor, body } = await evaluateFinanzasWriteRequest(request, { email: await deps.sessionEmail(), env: deps.env, limiter: deps.limiter })
    requestId = requestIdOf(body)
    const service = finanzasWriteMode(deps.env) === 'sheets' ? deps.service() : null
    if (!service) throw new OperationError('escritura-deshabilitada')
    const result = await run(service, body, { actor })
    subirGeneracionFinanzas()
    return { status: result.repetida ? 200 : 201, body: { ok: true, ...result, requestId } }
  } catch (error) {
    if (error instanceof OperationError) return errorBody(error, requestId)
    console.error('[project-os] error inesperado en finanzas:', error instanceof Error ? error.name : 'desconocido')
    return { status: 500, body: { ok: false, error: { codigo: 'error-interno', mensaje: 'No se pudo completar la operación.' } } }
  }
}
