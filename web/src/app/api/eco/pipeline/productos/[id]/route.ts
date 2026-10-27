import { handleEcoWrite } from '@/lib/radaros/pipeline-escritura-http'
import { parseEco, parseIdRuta } from '@/lib/radaros/pipeline-escritura-validacion'

export const dynamic = 'force-dynamic'

/** Edición con `expectedVersion` en PIPE_PRODUCTOS (ORD-POS-102, docs/diseno-eco-pipeline.md §4.1). Sin ruta DELETE. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return handleEcoWrite(request, 'eco.producto.editar', (service, body, ctx) => service.editarProducto(parseIdRuta('PRD', id), parseEco('eco.producto.editar', body), ctx), 200)
}
