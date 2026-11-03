import { OperationError } from '@/lib/operations/errors'
import { handleWrite } from '@/lib/operations/http'
import { operationsService } from '@/lib/operations/runtime'
import { parseRegistrarCapacidad } from '@/lib/operations/validation'

export const dynamic = 'force-dynamic'

/**
 * Registrar la capacidad de una semana en CAPACIDAD_SEMANAL (ORD-POS-139, DEC-POS-029 c): alta sin expectedVersion o
 * edición con ella. Solo la sesión del propietario con PLANIFICACION_EDICION_PROPIETARIO; el guard rechaza cualquier
 * token (PM, Tiempos, finanzas) y a los demás escritores sin leer el cuerpo.
 */
export async function POST(request: Request) {
  return handleWrite(request, (body, ctx) => {
    const service = operationsService()
    if (!service) throw new OperationError('escritura-deshabilitada')
    return service.registrarCapacidad(parseRegistrarCapacidad(body), ctx)
  }, 201, 'capacidad.registrar')
}
