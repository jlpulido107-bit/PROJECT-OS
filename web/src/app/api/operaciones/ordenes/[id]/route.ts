import { transitionWithDispatch } from '@/lib/operations/dispatch'
import { OperationError } from '@/lib/operations/errors'
import { handleWrite } from '@/lib/operations/http'
import { operationsService } from '@/lib/operations/runtime'
import { parseOrderTransition } from '@/lib/operations/validation'

export const dynamic = 'force-dynamic'

/** Transiciones de una orden con el estado esperado (V1.8 F3). Aprobar también crea su issue en GitHub (F4). */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return handleWrite(request, (body, ctx) => {
    const service = operationsService()
    if (!service) throw new OperationError('escritura-deshabilitada')
    return transitionWithDispatch(service, parseOrderTransition(decodeURIComponent(id), body), ctx)
  }, 200, 'orden.aprobar') // el agente PM solo aprueba, envía y marca REVISADA (DEC-POS-011, guard y dispatch)
}
