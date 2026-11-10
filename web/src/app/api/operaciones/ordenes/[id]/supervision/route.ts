import { OperationError } from '@/lib/operations/errors'
import { handleWrite } from '@/lib/operations/http'
import { lanzarSupervision, operacionSupervision } from '@/lib/operations/revision'
import { operationsService } from '@/lib/operations/runtime'
import { decodeIdRuta, parseLanzarSupervision } from '@/lib/operations/validation'

export const dynamic = 'force-dynamic'

/**
 * «Lanzar revisión» / «Pedir corrección» (ORD-POS-037, docs/rutina-claude.md): lanza la rutina de revisión a ciegas o de
 * corrección de un PR. Solo escritores con sesión y CSRF; el agente PM no tiene estas operaciones. Deja constancia en AUDITORIA.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return handleWrite(request, async (body, ctx) => {
    const service = operationsService()
    if (!service) throw new OperationError('escritura-deshabilitada')
    const cmd = parseLanzarSupervision(decodeIdRuta(id), body)
    const supervision = await lanzarSupervision(service, cmd, ctx)
    const operacion = cmd.accion === 'corregir' ? 'orden.corregir_lanzar' : 'orden.revisar_lanzar'
    return { operacion, entidad: 'ORDENES_CODEX', id: cmd.ordenId, repetida: supervision.ok && supervision.nueva === false, supervision }
  }, 200, 'orden.revisar_lanzar', operacionSupervision) // DIS-05: el guard recibe la operación real (revisar o corregir)
}
