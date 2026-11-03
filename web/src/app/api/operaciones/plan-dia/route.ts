import { OperationError } from '@/lib/operations/errors'
import { handleWrite } from '@/lib/operations/http'
import { operationsService } from '@/lib/operations/runtime'
import { parseGuardarPlanDia } from '@/lib/operations/validation'

export const dynamic = 'force-dynamic'

/**
 * Guardar el plan registrado de un día en PLAN_DIARIO y PLAN_ITEMS (ORD-POS-140, DEC-POS-029): una llamada por día, con
 * su requestId. Solo la sesión del propietario con PLANIFICACION_EDICION_PROPIETARIO; el guard rechaza cualquier token
 * (PM, Tiempos, finanzas) y a los demás escritores sin leer el cuerpo.
 */
export async function POST(request: Request) {
  return handleWrite(request, (body, ctx) => {
    const service = operationsService()
    if (!service) throw new OperationError('escritura-deshabilitada')
    return service.guardarPlanDia(parseGuardarPlanDia(body), ctx)
  }, 201, 'plan.dia.guardar')
}
