import { NextResponse } from 'next/server'
import { deploymentProblems } from '@/lib/deployment'

export const dynamic = 'force-dynamic'

const HEADERS = { 'Cache-Control': 'no-store' }
let reported = ''

/**
 * Sonda pública de salud/arranque. No lee Google Sheets, no requiere sesión y no devuelve datos ni
 * detalles de configuración: solo `ok` (200) o `unavailable` (503). Los códigos de problema se
 * registran en el servidor (sin valores) una vez por cambio.
 */
export async function GET() {
  const problems = deploymentProblems()
  if (problems.length === 0) return NextResponse.json({ status: 'ok' }, { headers: HEADERS })
  const summary = problems.join(',')
  if (summary !== reported) {
    reported = summary
    console.warn('[project-os] Configuración incompleta o insegura:', summary)
  }
  return NextResponse.json({ status: 'unavailable' }, { status: 503, headers: HEADERS })
}
