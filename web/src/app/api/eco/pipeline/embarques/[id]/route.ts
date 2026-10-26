import { handleEcoWrite } from '@/lib/radaros/pipeline-escritura-http'
import { parseEco, parseIdRuta } from '@/lib/radaros/pipeline-escritura-validacion'

export const dynamic = 'force-dynamic'

/** Edición con `expectedVersion` en PIPE_EMBARQUES (ORD-POS-102, docs/diseno-eco-pipeline.md §4.1). Sin ruta DELETE. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return handleEcoWrite(request, 'eco.embarque.editar', (service, body, ctx) => service.editarEmbarque(parseIdRuta('EMB', id), parseEco('eco.embarque.editar', body), ctx), 200)
}
