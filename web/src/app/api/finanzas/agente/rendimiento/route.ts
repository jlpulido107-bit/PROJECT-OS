import { handleFinanzasAgente } from '@/lib/finanzas/agente-http'
import { parseRendimiento } from '@/lib/finanzas/agente-validacion'

export const dynamic = 'force-dynamic'

/** Rendimiento del corte en RENDIMIENTO_CLAUDE (ORD-POS-092, docs/diseno-finanzas-v3.md §4.2). No es gasto. */
export async function POST(request: Request) {
  return handleFinanzasAgente(request, (service, body) => service.registrarRendimiento(parseRendimiento(body)))
}
