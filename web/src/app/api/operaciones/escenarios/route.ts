import { OperationError } from '@/lib/operations/errors'
import { handleWrite } from '@/lib/operations/http'
import { operationsService } from '@/lib/operations/runtime'
import { parseGuardarEscenario } from '@/lib/operations/validation'

export const dynamic = 'force-dynamic'

/**
 * Guardar un escenario de simulación en ESCENARIOS (ORD-POS-141, DEC-POS-029 d): solo alta, nunca cambia el plan. Solo la
 * sesión del propietario con PLANIFICACION_EDICION_PROPIETARIO; el guard rechaza cualquier token (PM, Tiempos, finanzas)
 * y a los demás escritores sin leer el cuerpo.
 */
export async function POST(request: Request) {
  return handleWrite(request, (body, ctx) => {
    const service = operationsService()
    if (!service) throw new OperationError('escritura-deshabilitada')
    return service.guardarEscenario(parseGuardarEscenario(body), ctx)
  }, 201, 'escenario.guardar')
}
