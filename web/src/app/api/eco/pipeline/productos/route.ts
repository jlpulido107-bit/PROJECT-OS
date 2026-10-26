import { handleEcoWrite } from '@/lib/radaros/pipeline-escritura-http'
import { parseEco } from '@/lib/radaros/pipeline-escritura-validacion'

export const dynamic = 'force-dynamic'

/** Alta en PIPE_PRODUCTOS (ORD-POS-102, docs/diseno-eco-pipeline.md §4.1). Sin ruta DELETE. */
export async function POST(request: Request) {
  return handleEcoWrite(request, 'eco.producto.crear', (service, body, ctx) => service.crearProducto(parseEco('eco.producto.crear', body), ctx))
}
