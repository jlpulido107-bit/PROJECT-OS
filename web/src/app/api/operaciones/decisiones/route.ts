import { todayInMerida } from '@/lib/dates'
import { OperationError } from '@/lib/operations/errors'
import { handleWrite } from '@/lib/operations/http'
import { operationsService } from '@/lib/operations/runtime'
import { parseCreateDecision } from '@/lib/operations/validation'

export const dynamic = 'force-dynamic'

/** Registrar decisión en estado PENDIENTE (V1.4). */
export async function POST(request: Request) {
  return handleWrite(request, (body, ctx) => {
    const service = operationsService()
    if (!service) throw new OperationError('escritura-deshabilitada')
    return service.createDecision(parseCreateDecision(body, todayInMerida()), ctx)
  }, 201, 'decision.crear')
}
