import { handleEcoWrite } from '@/lib/radaros/pipeline-escritura-http'
import { ecoBandejaGeminiHabilitada } from '@/lib/radaros/pipeline-bandeja-gemini'
import { parseBandejaRechazar, parseIdRuta } from '@/lib/radaros/pipeline-escritura-validacion'

export const dynamic = 'force-dynamic'

/**
 * «Rechazar» de la bandeja de Gemini (ORD-POS-155, docs/diseno-eco-pipeline.md §18.3): marca la fila RECHAZADA con el
 * motivo al final de NOTAS. Inerte sin ECO_BANDEJA_GEMINI=true. Nunca borra la fila.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return handleEcoWrite(request, 'eco.bandeja.rechazar',
    (service, body, ctx) => service.rechazarBandeja(parseIdRuta('BAN', id), parseBandejaRechazar(body), ctx), 200, ecoBandejaGeminiHabilitada)
}
