import { NextResponse } from 'next/server'
import { getDataset } from '@/lib/data'
import { directorMktLecturaHabilitada, encargosDelDirectorMkt, esTokenDelDirectorMkt } from '@/lib/director-mkt-lectura'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0' }

/**
 * Encargos del Director de Marketing (ORD-POS-170, DEC-POS-038) en JSON. SOLO LECTURA: lee TAREAS, filtra y devuelve
 * seis datos por tarea; no guarda nada ni escribe en Sheets. Sin DIRECTOR_MKT_LECTURA=true responde 404 a todos; con
 * ella, solo entra el token propio del Director de Marketing (ni la sesión ni los tokens del PM, Tiempos o finanzas).
 * Solo exporta GET: cualquier otro método recibe 405. Nada de DECISIONES, FINANZAS ni del proyecto SIG.
 */
export async function GET(request: Request) {
  if (!directorMktLecturaHabilitada()) return NextResponse.json({ error: 'No encontrado' }, { status: 404, headers: NO_STORE })
  if (!(await esTokenDelDirectorMkt(request.headers))) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401, headers: NO_STORE })
  }
  const result = await getDataset()
  if (!result.ok) {
    return NextResponse.json({ error: result.error.message, code: result.error.code }, { status: 503, headers: NO_STORE })
  }
  return NextResponse.json({ fuente: result.data.source, encargos: encargosDelDirectorMkt(result.data.tareas) }, { headers: NO_STORE })
}
