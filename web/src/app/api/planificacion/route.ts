import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth'
import { getDataset } from '@/lib/data'
import { MERIDA_TZ } from '@/lib/dates'
import { isCivilDate } from '@/lib/planning/calendar'
import { planWeek } from '@/lib/planning/engine'
import { planningInputFromDataset } from '@/lib/planning/input'
import { referenceDateFor } from '@/lib/planning/reference'
import { ScenarioError, scenarioFromSearchParams } from '@/lib/planning/scenario'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0' }

/**
 * Propuesta de planificación (V1.5) en JSON. SOLO LECTURA: genera una simulación a partir de los datos y del
 * escenario de la URL; no guarda nada, no escribe en Sheets y no hay método para aplicar la propuesta.
 * Parámetros: los del escenario (ver docs/planificacion-v1-5.md) y `fecha=YYYY-MM-DD` para fijar la referencia.
 */
export async function GET(request: Request) {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'No autenticado' }, { status: 401, headers: NO_STORE })

  const params = new URL(request.url).searchParams
  const fecha = params.get('fecha')
  params.delete('fecha')
  if (fecha !== null && !isCivilDate(fecha)) {
    return NextResponse.json({ error: 'Parámetro inválido', campo: 'fecha', detalle: 'Usa YYYY-MM-DD' }, { status: 400, headers: NO_STORE })
  }
  let scenario
  try {
    scenario = scenarioFromSearchParams(params)
  } catch (error) {
    if (error instanceof ScenarioError) {
      return NextResponse.json({ error: 'Parámetro inválido', campo: error.field, detalle: error.message }, { status: 400, headers: NO_STORE })
    }
    throw error
  }

  const result = await getDataset()
  if (!result.ok) {
    return NextResponse.json({ error: result.error.message, code: result.error.code }, { status: 503, headers: NO_STORE })
  }
  const plan = planWeek(planningInputFromDataset(result.data), scenario, {
    referenceDate: fecha ?? referenceDateFor(Date.now(), MERIDA_TZ),
    timeZone: MERIDA_TZ,
  })
  return NextResponse.json(
    { simulacion: true, aviso: 'Propuesta simulada: no se guardó ni se aplicó.', fuente: result.data.source, escenario: scenario, plan },
    { headers: NO_STORE },
  )
}
