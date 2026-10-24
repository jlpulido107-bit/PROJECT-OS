import { handleFinanzasWrite } from '@/lib/finanzas/escritura-http'
import { parseConfirmar } from '@/lib/finanzas/escritura-validacion'

export const dynamic = 'force-dynamic'

/** «Confirmar» un recurrente del mes como `REC-<ID>-AAAA-MM` (ORD-POS-077, docs/diseno-finanzas-v2.md §4.3). */
export async function POST(request: Request) {
  return handleFinanzasWrite(request, (service, body, ctx) => service.confirmarRecurrente(parseConfirmar(body), ctx))
}
