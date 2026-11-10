import { OperationError } from '@/lib/operations/errors'
import { handleWrite } from '@/lib/operations/http'
import { operationsService } from '@/lib/operations/runtime'
import { decodeIdRuta, parseUpdateTask } from '@/lib/operations/validation'

export const dynamic = 'force-dynamic'

/** Editar campos permitidos de una tarea con control de versión (V1.4). Cerrar tareas no está permitido. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return handleWrite(request, (body, ctx) => {
    const service = operationsService()
    if (!service) throw new OperationError('escritura-deshabilitada')
    return service.updateTask(parseUpdateTask(decodeIdRuta(id), body), ctx)
  }, 200, 'tarea.editar')
}
