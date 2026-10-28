import { OperationError } from '@/lib/operations/errors'
import { handleWrite } from '@/lib/operations/http'
import { operationsService } from '@/lib/operations/runtime'
import { parseCompleteTask } from '@/lib/operations/validation'

export const dynamic = 'force-dynamic'

/**
 * Marcar una tarea como COMPLETADA (ORD-POS-106, DEC-POS-023). Inerte sin TAREAS_CIERRE_PROPIETARIO: el guard responde
 * cierre-no-permitido a todo el que no sea la sesión del propietario con la bandera encendida, y siempre al agente PM.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return handleWrite(request, (body, ctx) => {
    const service = operationsService()
    if (!service) throw new OperationError('escritura-deshabilitada')
    return service.completeTask(parseCompleteTask(decodeURIComponent(id), body), ctx)
  }, 200, 'tarea.completar')
}
