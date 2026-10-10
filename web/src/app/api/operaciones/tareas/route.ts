import { OperationError } from '@/lib/operations/errors'
import { handleWrite } from '@/lib/operations/http'
import { operationsService } from '@/lib/operations/runtime'
import { parseCreateTask } from '@/lib/operations/validation'

export const dynamic = 'force-dynamic'

/** Crear tarea (V1.4). Requiere sesión, escritor autorizado y modo de escritura activo; ver docs/v1-4-write-contract.md. */
export async function POST(request: Request) {
  return handleWrite(request, (body, ctx) => {
    const service = operationsService()
    if (!service) throw new OperationError('escritura-deshabilitada')
    return service.createTask(parseCreateTask(body), ctx)
  }, 201)
}
