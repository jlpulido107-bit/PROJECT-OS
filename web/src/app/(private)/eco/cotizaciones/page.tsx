import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { destinoCotizaciones } from '@/lib/radaros/pipeline-compras'

/**
 * /eco/cotizaciones (ORD-POS-149) se unió a /eco/pipeline en ORD-POS-150 (POS-053): la bandeja en 3 pasos vive ahora en
 * los chips y en la ficha de cada producto. Verifica la sesión, no lee ningún dato y redirige conservando el paso (`?paso=`).
 */
export default async function EcoCotizacionesPage({ searchParams }: { searchParams: Promise<{ paso?: string | string[] }> }) {
  await requireUser('/eco/cotizaciones')
  redirect(destinoCotizaciones(await searchParams))
}
