import { OperationError } from '../operations/errors'
import type { RateLimiter } from '../operations/rate-limit'
import { ecoPipelineWriteMode } from './pipeline-escritura-config'
import { evaluateEcoWriteRequest, rejectAuthorization } from './pipeline-escritura-guard'
import type { EcoContext, EcoPipelineWriteService, EcoResultado } from './pipeline-escritura-service'
import { subirGeneracionEco } from './pipeline-generacion'

/**
 * Núcleo de las rutas de escritura del pipeline, sin Next (ORD-POS-102): se prueba con dobles de sesión, de token y
 * de `fetch`. El servicio (y con él el proveedor de token) solo se pide DESPUÉS del guard: con la escritura apagada o
 * la petición rechazada no hay ninguna llamada a IAM ni a Sheets (§7.1).
 */
export interface EcoHandlerDeps {
  /** Correo de la sesión; no se llama si la petición trae `Authorization`. */
  sessionEmail: () => Promise<string | null>
  env: NodeJS.ProcessEnv
  limiter: RateLimiter
  service: () => EcoPipelineWriteService | null
}

export interface EcoRespuesta {
  status: number
  body: Record<string, unknown>
}

/** `conflicto-version` en el pipeline habla del registro, no de una tarea. */
const MENSAJES: Partial<Record<string, string>> = {
  'conflicto-version': 'El registro cambió desde que lo abriste (etapa o versión). Recarga y vuelve a intentarlo.',
}

/** ORD-POS-104 (H2): la pestaña llena se nombra (es una de las cinco PIPE_*, nunca un valor de la hoja). */
function mensajeDe(error: OperationError): string {
  const { pestana, limite } = error.detail ?? {}
  if (error.code === 'eco-pestana-llena' && pestana) {
    return `La pestaña ${pestana} llegó al límite de ${limite} filas: archívala (diseño /eco pipeline §7.2) y vuelve a intentarlo. No se escribió nada.`
  }
  // ORD-POS-146: el ID del proveedor existente y las columnas de la migración pendiente (nombres fijos del esquema).
  const { id, columnas } = error.detail ?? {}
  if (error.code === 'proveedor-duplicado' && id) return `Ya existe el proveedor ${id} con ese nombre; no se duplica. No se escribió nada.`
  if (error.code === 'eco-migracion-pendiente' && pestana && columnas) {
    return `${pestana} aún no tiene ${String(columnas).split(',').join(', ')}: la migración la aplica el propietario (diseño /eco pipeline §14.1 y §15.1). Deja esos campos vacíos o espera la migración. No se escribió nada.`
  }
  return MENSAJES[error.code] ?? error.message
}

function requestIdOf(body: unknown): string | undefined {
  const id = body && typeof body === 'object' ? (body as Record<string, unknown>).requestId : undefined
  return typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id) ? id : undefined
}

function errorBody(error: OperationError, operacion: string, requestId?: string): EcoRespuesta {
  // §6.4: operación, código y requestId; nunca correos, contactos ni valores de campos.
  if (error.status >= 409) console.warn(`[project-os] eco rechazada: ${operacion} ${error.code}${requestId ? ` req=${requestId}` : ''}`)
  return {
    status: error.status,
    body: {
      ok: false,
      error: {
        codigo: error.code, mensaje: mensajeDe(error),
        ...(error.fields ? { campos: error.fields } : {}), ...(error.detail ? { detalle: error.detail } : {}),
      },
      ...(requestId ? { requestId } : {}),
    },
  }
}

export async function ecoPipelineWrite(
  request: Request,
  deps: EcoHandlerDeps,
  operacion: string,
  run: (service: EcoPipelineWriteService, body: unknown, ctx: EcoContext) => Promise<EcoResultado>,
  creado = 201,
): Promise<EcoRespuesta> {
  let requestId: string | undefined
  try {
    // Antes de leer la sesión o el cuerpo: cualquier Authorization (el token del PM o el del agente) es 401.
    rejectAuthorization(request)
    const { actor, body } = await evaluateEcoWriteRequest(request, { email: await deps.sessionEmail(), env: deps.env, limiter: deps.limiter })
    requestId = requestIdOf(body)
    const service = ecoPipelineWriteMode(deps.env) === 'sheets' ? deps.service() : null
    if (!service) throw new OperationError('escritura-deshabilitada')
    const result = await run(service, body, { actor })
    subirGeneracionEco()
    return { status: result.repetida ? 200 : creado, body: { ok: true, ...result, requestId } }
  } catch (error) {
    if (error instanceof OperationError) return errorBody(error, operacion, requestId)
    console.error('[project-os] error inesperado en eco:', operacion, error instanceof Error ? error.name : 'desconocido')
    return { status: 500, body: { ok: false, error: { codigo: 'error-interno', mensaje: 'No se pudo completar la operación.' } } }
  }
}
