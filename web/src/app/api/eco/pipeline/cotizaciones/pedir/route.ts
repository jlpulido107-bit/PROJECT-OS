import { handleEcoWrite } from '@/lib/radaros/pipeline-escritura-http'
import { parseEco } from '@/lib/radaros/pipeline-escritura-validacion'

export const dynamic = 'force-dynamic'

/**
 * «Pedir» de /eco/cotizaciones (ORD-POS-149, docs/diseno-eco-pipeline.md §16.2): alta SOLICITADA en PIPE_COTIZACIONES con
 * las fechas que pone el servidor. Mismo guard sin agente que el resto del pipeline: cualquier `Authorization` es 401.
 */
export async function POST(request: Request) {
  return handleEcoWrite(request, 'eco.cotizacion.pedir', (service, body, ctx) => service.pedirCotizacion(parseEco('eco.cotizacion.pedir', body), ctx))
}
