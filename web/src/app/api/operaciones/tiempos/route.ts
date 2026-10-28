import { todayInMerida } from '@/lib/dates'
import { OperationError } from '@/lib/operations/errors'
import { handleWrite } from '@/lib/operations/http'
import { operationsService } from '@/lib/operations/runtime'
import { parseLogTime } from '@/lib/operations/validation'

export const dynamic = 'force-dynamic'

/**
 * Registrar sesión de trabajo en TIEMPOS (V1.4). Con `Authorization` es el agente PM y la operación es 'tiempo.crear'
 * (ORD-POS-112), que el guard solo permite con TIEMPOS_AGENTE=true.
 */
export async function POST(request: Request) {
  const op = request.headers.has('authorization') ? 'tiempo.crear' : 'tiempo.registrar'
  return handleWrite(request, (body, ctx) => {
    const service = operationsService()
    if (!service) throw new OperationError('escritura-deshabilitada')
    return service.logTime(parseLogTime(body, todayInMerida()), ctx, op)
  }, 201, op)
}
