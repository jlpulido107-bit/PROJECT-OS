import { writeModeStatus } from '@/lib/operations/config'
import { OperationError } from '@/lib/operations/errors'
import { handleWrite } from '@/lib/operations/http'
import { operationsService } from '@/lib/operations/runtime'
import { parseAltaIdea } from '@/lib/radaros/ideas-alta'
import { ideasAltaStore } from '@/lib/radaros/ideas-alta-runtime'

export const dynamic = 'force-dynamic'

/**
 * Alta de una idea en PRODUCTS y SCORING del libro de RADAROS (ORD-POS-131, DEC-ECO-007). Solo el agente PM con su token
 * y ECO_IDEAS_ALTA=true (guard); la auditoría va a AUDITORIA de PROJECT-OS, que exige su escritura real (`sheets`).
 */
export async function POST(request: Request) {
  return handleWrite(request, (body, ctx) => {
    const service = operationsService()
    const ideas = ideasAltaStore()
    if (!service || !ideas || writeModeStatus().mode !== 'sheets') throw new OperationError('escritura-deshabilitada')
    return service.altaIdea(parseAltaIdea(body), ctx, ideas)
  }, 201, 'idea.alta')
}
