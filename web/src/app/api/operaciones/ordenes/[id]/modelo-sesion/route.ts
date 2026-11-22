import { OperationError } from '@/lib/operations/errors'
import { handleWrite } from '@/lib/operations/http'
import { registrarModeloDeSesion } from '@/lib/operations/modelo-sesion'
import { operationsService } from '@/lib/operations/runtime'
import { decodeIdRuta, parseModeloSesion } from '@/lib/operations/validation'

export const dynamic = 'force-dynamic'

/**
 * Alta del modelo real de una sesión enlazada a la orden (ORD-POS-165, DEC-POS-039). Solo el token del agente PM y solo
 * con SUPERVISION_MODELO_SESION=true (guard.ts); ninguna sesión de navegador. Deja constancia en AUDITORIA y nada más.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return handleWrite(request, (body, ctx) => {
    const service = operationsService()
    if (!service) throw new OperationError('escritura-deshabilitada')
    return registrarModeloDeSesion(service, parseModeloSesion(decodeIdRuta(id), body), ctx)
  }, 201, 'orden.modelo_sesion')
}
