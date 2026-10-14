import { ejecutarConClaude } from '@/lib/operations/dispatch'
import { OperationError } from '@/lib/operations/errors'
import { handleWrite } from '@/lib/operations/http'
import { operationsService } from '@/lib/operations/runtime'
import { parseEjecutarOrden } from '@/lib/operations/validation'

export const dynamic = 'force-dynamic'

/**
 * «Ejecutar con Claude» (V1.8 F5a, docs/rutina-claude.md): lanza la rutina de Claude sobre una orden ENVIADA. No escribe
 * en la hoja; deja constancia en el issue. Solo para escritores, con la misma protección que el resto de operaciones.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return handleWrite(request, async (body) => {
    const service = operationsService()
    if (!service) throw new OperationError('escritura-deshabilitada')
    const { ordenId, forzar } = parseEjecutarOrden(decodeURIComponent(id), body)
    const ejecucion = await ejecutarConClaude(service, ordenId, { forzar })
    return { operacion: 'orden.ejecutar', entidad: 'ORDENES_CODEX', id: ordenId, repetida: false, ejecucion }
  }, 200)
}
