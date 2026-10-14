import { OperationError } from '@/lib/operations/errors'
import { handleWrite } from '@/lib/operations/http'
import { operationsService } from '@/lib/operations/runtime'
import { parseCreateOrder } from '@/lib/operations/validation'

export const dynamic = 'force-dynamic'

/** Crear una orden en BORRADOR (V1.8 F3). */
export async function POST(request: Request) {
  return handleWrite(request, (body, ctx) => {
    const service = operationsService()
    if (!service) throw new OperationError('escritura-deshabilitada')
    return service.createOrder(parseCreateOrder(body), ctx)
  }, 201)
}
