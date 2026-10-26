import { handleEcoWrite } from '@/lib/radaros/pipeline-escritura-http'
import { parseEco, parseIdRuta } from '@/lib/radaros/pipeline-escritura-validacion'

export const dynamic = 'force-dynamic'

/** Edición con `expectedVersion` en PIPE_COTIZACIONES (ORD-POS-102, docs/diseno-eco-pipeline.md §4.1). Sin ruta DELETE. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return handleEcoWrite(request, 'eco.cotizacion.editar', (service, body, ctx) => service.editarCotizacion(parseIdRuta('COT', id), parseEco('eco.cotizacion.editar', body), ctx), 200)
}
