import { handleEcoWrite } from '@/lib/radaros/pipeline-escritura-http'
import { parseEco, parseIdRuta } from '@/lib/radaros/pipeline-escritura-validacion'

export const dynamic = 'force-dynamic'

/** Edición con `expectedVersion` en PIPE_PROVEEDORES (ORD-POS-102, docs/diseno-eco-pipeline.md §4.1). Sin ruta DELETE. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return handleEcoWrite(request, 'eco.proveedor.editar', (service, body, ctx) => service.editarProveedor(parseIdRuta('PRV', id), parseEco('eco.proveedor.editar', body), ctx), 200)
}
