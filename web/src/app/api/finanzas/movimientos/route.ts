import { handleFinanzasWrite } from '@/lib/finanzas/escritura-http'
import { parseMovimiento } from '@/lib/finanzas/escritura-validacion'

export const dynamic = 'force-dynamic'

/** «Nuevo movimiento» y «Ajustar» en MOVIMIENTOS de FINANZAS (ORD-POS-077, docs/diseno-finanzas-v2.md §3). */
export async function POST(request: Request) {
  return handleFinanzasWrite(request, (service, body, ctx) => service.crearMovimiento(parseMovimiento(body), ctx))
}
