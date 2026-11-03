import { calendarioDesdeDataset } from '@/lib/calendario-ics'
import { esSecretoDelCalendario } from '@/lib/calendario-ics-acceso'
import { getDataset } from '@/lib/data'
import { MERIDA_TZ } from '@/lib/dates'
import { referenceDateFor } from '@/lib/planning/reference'

export const dynamic = 'force-dynamic'

const BASE = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' }

/**
 * Calendario ICS de solo lectura (ORD-POS-142, DEC-POS-029 e; contrato en docs/escritura-v1-8.md §11.3 a §11.5).
 * El proxy deja pasar sin sesión solo GET a esta ruta exacta; aquí se valida el secreto de `?token=`: sin
 * PLANIFICACION_ICS=true, sin hash válido, sin token o con uno que no coincide, 404 sin leer la hoja. No escribe nada,
 * no usa Google Tasks y no hay ida y vuelta. Solo exporta GET.
 */
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get('token')
  if (!(await esSecretoDelCalendario(token))) {
    return new Response('No encontrado', { status: 404, headers: { ...BASE, 'Content-Type': 'text/plain; charset=utf-8' } })
  }
  const result = await getDataset()
  const calendario = result.ok ? calendarioDesdeDataset(result.data, referenceDateFor(Date.now(), MERIDA_TZ)) : null
  if (!calendario?.ok) {
    // Sin datos completos no se publica un calendario a medias: la app de calendario conserva la copia anterior.
    return new Response('Calendario no disponible', { status: 503, headers: { ...BASE, 'Content-Type': 'text/plain; charset=utf-8' } })
  }
  return new Response(calendario.ics, {
    headers: { ...BASE, 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'inline; filename="planificacion.ics"' },
  })
}
