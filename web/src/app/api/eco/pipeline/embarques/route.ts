import { handleEcoWrite } from '@/lib/radaros/pipeline-escritura-http'
import { parseEco } from '@/lib/radaros/pipeline-escritura-validacion'

export const dynamic = 'force-dynamic'

/** Alta en PIPE_EMBARQUES (ORD-POS-102, docs/diseno-eco-pipeline.md §4.1). Sin ruta DELETE. */
export async function POST(request: Request) {
  return handleEcoWrite(request, 'eco.embarque.crear', (service, body, ctx) => service.crearEmbarque(parseEco('eco.embarque.crear', body), ctx))
}
