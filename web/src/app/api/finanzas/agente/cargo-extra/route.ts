import { handleFinanzasAgente } from '@/lib/finanzas/agente-http'
import { parseCargoExtra } from '@/lib/finanzas/agente-validacion'

export const dynamic = 'force-dynamic'

/** Cargo extra del corte en MOVIMIENTOS, o su cierre «sin cargo» (ORD-POS-092, docs/diseno-finanzas-v3.md §4.3 y §5). */
export async function POST(request: Request) {
  return handleFinanzasAgente(request, (service, body) => service.registrarCargoExtra(parseCargoExtra(body)))
}
