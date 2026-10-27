import { handleEcoWrite } from '@/lib/radaros/pipeline-escritura-http'
import { parseIdRuta, parseMover } from '@/lib/radaros/pipeline-escritura-validacion'

export const dynamic = 'force-dynamic'

/** Mover un producto de etapa con la tabla de §5.1 (ORD-POS-102): arrastre y «Mover a…» del tablero. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return handleEcoWrite(request, 'eco.producto.mover', (service, body, ctx) => service.moverProducto(parseIdRuta('PRD', id), parseMover(body), ctx), 200)
}
