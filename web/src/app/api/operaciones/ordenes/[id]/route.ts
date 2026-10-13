import { OperationError } from '@/lib/operations/errors'
import { handleWrite } from '@/lib/operations/http'
import { operationsService } from '@/lib/operations/runtime'
import { parseOrderTransition } from '@/lib/operations/validation'

export const dynamic = 'force-dynamic'

/** Aprobar (BORRADOR → APROBADA) o cancelar una orden a Codex, con el estado esperado (V1.8 F3). */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return handleWrite(request, (body, ctx) => {
    const service = operationsService()
    if (!service) throw new OperationError('escritura-deshabilitada')
    return service.transitionOrder(parseOrderTransition(decodeURIComponent(id), body), ctx)
  }, 200)
}
