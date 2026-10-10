import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth'
import { getDataset } from '@/lib/data'
import { civilDateInZone, MERIDA_TZ } from '@/lib/dates'
import { buildGovernanceReport } from '@/lib/governance/engine'
import { applyFilters, FilterError, parseControlParams } from '@/lib/governance/filters'
import { governanceInputFromDataset } from '@/lib/governance/input'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0' }

/**
 * Centro de control (V1.6) en JSON. SOLO LECTURA: alertas con hechos, inferencias, hipótesis y acciones SUGERIDAS.
 * Sin texto libre de la hoja (títulos, notas, bloqueos, texto de decisiones), sin correos y sin métodos mutadores.
 * Parámetros: proyecto, categoria, severidad, tipo y fecha=YYYY-MM-DD (referencia).
 */
export async function GET(request: Request) {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'No autenticado' }, { status: 401, headers: NO_STORE })

  let parsed
  try {
    parsed = parseControlParams(new URL(request.url).searchParams)
  } catch (error) {
    if (error instanceof FilterError) {
      return NextResponse.json({ error: 'Parámetro inválido', campo: error.field, detalle: error.message }, { status: 400, headers: NO_STORE })
    }
    throw error
  }

  const result = await getDataset()
  if (!result.ok) {
    return NextResponse.json({ error: result.error.message, code: result.error.code }, { status: 503, headers: NO_STORE })
  }
  const report = buildGovernanceReport(governanceInputFromDataset(result.data), {
    referenceDate: parsed.fecha ?? civilDateInZone(Date.now(), MERIDA_TZ),
    timeZone: MERIDA_TZ,
  })
  const alertas = applyFilters(report.alertas, parsed.filters)
  return NextResponse.json(
    {
      soloLectura: true,
      aviso: 'Informe de solo lectura: el panel no aprueba, cierra, envía ni ejecuta nada. Una decisión registrada no autoriza merges, despliegues, escrituras ni gasto.',
      fuente: result.data.source,
      filtros: parsed.filters,
      totalSinFiltros: report.alertas.length,
      informe: { ...report, alertas },
    },
    { headers: NO_STORE },
  )
}
