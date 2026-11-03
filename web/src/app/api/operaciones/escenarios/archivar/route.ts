import { OperationError } from '@/lib/operations/errors'
import { handleWrite } from '@/lib/operations/http'
import { operationsService } from '@/lib/operations/runtime'
import { parseArchivarEscenario } from '@/lib/operations/validation'

export const dynamic = 'force-dynamic'

/**
 * Archivar un escenario de ESCENARIOS (ORD-POS-141): ESTADO ARCHIVADO con la versión esperada; nunca se borra la fila.
 * Mismo guard que guardar: solo la sesión del propietario con su bandera.
 */
export async function POST(request: Request) {
  return handleWrite(request, (body, ctx) => {
    const service = operationsService()
    if (!service) throw new OperationError('escritura-deshabilitada')
    return service.archivarEscenario(parseArchivarEscenario(body), ctx)
  }, 200, 'escenario.archivar')
}
