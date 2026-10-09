import { NextResponse } from 'next/server'
import { executiveSummary } from '@/lib/aggregate'
import { currentUser } from '@/lib/auth'
import { getDataset } from '@/lib/data'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0' }

/** Resumen ejecutivo en JSON (solo conteos). Requiere sesión autorizada; no escribe en Sheets. */
export async function GET() {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'No autenticado' }, { status: 401, headers: NO_STORE })
  const result = await getDataset()
  if (!result.ok) {
    return NextResponse.json({ error: result.error.message, code: result.error.code }, { status: 503, headers: NO_STORE })
  }
  const s = executiveSummary(result.data)
  return NextResponse.json(
    {
      fuente: result.data.source,
      leidoEn: new Date(result.data.fetchedAt).toISOString(),
      proyectos: s.proyectos,
      tareas: { total: s.tareas.total, abiertas: s.tareas.abiertas, cerradas: s.tareas.cerradas, sinEstado: s.tareas.sinEstado },
      bloqueos: {
        tareasBloqueadas: s.bloqueos.tareasBloqueadas?.length ?? null,
        dependenciasPendientes: s.bloqueos.dependenciasPendientes?.length ?? null,
      },
      tiempos: s.tiempos
        ? { minutos: s.tiempos.minutos, sesiones: s.tiempos.sesiones, sesionesSinMinutos: s.tiempos.sesionesSinMinutos }
        : null,
      ultimoSync: s.ultimoSync ? { id: s.ultimoSync.id, estado: s.ultimoSync.estado, fin: s.ultimoSync.fin?.epochMs ?? null } : s.ultimoSync ?? null,
      evidencias: s.evidencias,
      pestanas: Object.values(result.data.tabs).map(({ tab, ok, truncated }) => ({ tab, ok, truncated })),
    },
    { headers: NO_STORE },
  )
}
