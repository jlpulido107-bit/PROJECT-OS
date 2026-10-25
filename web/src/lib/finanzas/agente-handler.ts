import { OperationError } from '../operations/errors'
import type { RateLimiter } from '../operations/rate-limit'
import { finanzasAgenteMode } from './agente-config'
import { evaluateFinanzasAgenteRequest, rejectNonAgent } from './agente-guard'
import type { FinanzasAgenteResultado, FinanzasAgenteService } from './agente-service'
import type { FinanzasRespuesta } from './escritura-handler'
import { subirGeneracionFinanzas } from './generacion'

/**
 * Núcleo de las rutas del agente de finanzas, sin Next (ORD-POS-092): se prueba con dobles de token y de `fetch`. El
 * servicio (y con él el proveedor de token de Google) solo se pide DESPUÉS del guard: sin modo activo o con la
 * petición rechazada no hay ninguna llamada a IAM ni a Sheets (diseño v3 §8.1).
 */
export interface FinanzasAgenteHandlerDeps {
  env: NodeJS.ProcessEnv
  limiter: RateLimiter
  service: () => FinanzasAgenteService | null
}

function requestIdOf(body: unknown): string | undefined {
  const id = body && typeof body === 'object' ? (body as Record<string, unknown>).requestId : undefined
  return typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id) ? id : undefined
}

function errorBody(error: OperationError, requestId?: string): FinanzasRespuesta {
  if (error.status >= 500 || error.code.startsWith('conflicto') || error.code === 'verificacion-fallida') {
    // Solo código y requestId: nunca montos, citas ni valores.
    console.warn(`[project-os] agente de finanzas rechazado: ${error.code}${requestId ? ` req=${requestId}` : ''}`)
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

export async function finanzasAgenteWrite(
  request: Request,
  deps: FinanzasAgenteHandlerDeps,
  run: (service: FinanzasAgenteService, body: unknown) => Promise<FinanzasAgenteResultado>,
): Promise<FinanzasRespuesta> {
  let requestId: string | undefined
  try {
    // Antes de leer el cuerpo: sin el token del agente (o con cookie de sesión) es 401.
    rejectNonAgent(request, deps.env)
    const { body } = await evaluateFinanzasAgenteRequest(request, { env: deps.env, limiter: deps.limiter })
    requestId = requestIdOf(body)
    const service = finanzasAgenteMode(deps.env) === 'sheets' ? deps.service() : null
    if (!service) throw new OperationError('escritura-deshabilitada')
    const result = await run(service, body)
    subirGeneracionFinanzas()
    return { status: result.repetida ? 200 : 201, body: { ok: true, ...result, requestId } }
  } catch (error) {
    if (error instanceof OperationError) return errorBody(error, requestId)
    console.error('[project-os] error inesperado en el agente de finanzas:', error instanceof Error ? error.name : 'desconocido')
    return { status: 500, body: { ok: false, error: { codigo: 'error-interno', mensaje: 'No se pudo completar la operación.' } } }
  }
}
