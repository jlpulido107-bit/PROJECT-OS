import { handleEcoWrite } from '@/lib/radaros/pipeline-escritura-http'
import { ecoBandejaGeminiHabilitada } from '@/lib/radaros/pipeline-bandeja-gemini'
import { parseBandejaConfirmar, parseIdRuta } from '@/lib/radaros/pipeline-escritura-validacion'

export const dynamic = 'force-dynamic'

/**
 * «Confirmar» de la bandeja de Gemini (ORD-POS-155, docs/diseno-eco-pipeline.md §18.3): crea o actualiza el proveedor o
 * la cotización con el servicio del pipeline y marca la fila CONFIRMADA. Inerte sin ECO_BANDEJA_GEMINI=true. Sin DELETE.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return handleEcoWrite(request, 'eco.bandeja.confirmar',
    (service, body, ctx) => service.confirmarBandeja(parseIdRuta('BAN', id), parseBandejaConfirmar(body), ctx), 200, ecoBandejaGeminiHabilitada)
}
