import type { Metadata } from 'next'
import { VistaAgentes } from '@/components/agentes/agentes'
import { Freshness, LoadError, TabWarnings } from '@/components/data-state'
import { writeAccess } from '@/components/operations/write-access'
import {
  conteoOrdenes, dictamenesPorOrden, gastoClaude, mapaLanzamientos, ordenesDelFiltro, parseFiltroAgentes, tiempoAFusion,
  type FuenteClaude,
} from '@/lib/agentes'
import { githubDeAgentes, LIMITE_GLOBAL_MS, LLAMADAS_AGENTES } from '@/lib/agentes-data'
import { getFinanzas } from '@/lib/finanzas/data'
import { eventosOrdenes } from '@/lib/metricas'
import { WRITE_HEADERS } from '@/lib/operations/constants'
import { githubClient } from '@/lib/operations/dispatch'
import { auditTable } from '@/lib/operations/runtime'
import { InMemoryTableStore, readView, type TableView } from '@/lib/operations/table-store'
import { privateData } from '@/lib/page-data'

export const metadata: Metadata = { title: 'Agentes' }

type Search = Record<string, string | string[] | undefined>

/**
 * Cómo trabaja el sistema de agentes (ORD-POS-078, POS-029). Solo lectura: ORDENES_CODEX, AUDITORIA (como en
 * /metricas: cuenta de escritura y solo para escritores), FINANZAS y los PRs de GitHub. Solo muestra agregados; si
 * falta una fuente, su tarjeta dice «sin datos». GitHub con tope de llamadas y tiempo máximo global (ORD-POS-080,
 * lib/agentes-data.ts).
 */
export default async function AgentesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams
  const { user, result } = await privateData('/agentes')
  if (!result.ok) return <><h1>Agentes</h1><LoadError result={result} /></>
  const data = result.data
  const filtro = parseFiltroAgentes(params)

  let audit: TableView | null = null
  if (writeAccess(user.email).allowed) {
    try {
      const rows = await auditTable()
      if (rows) audit = await readView(new InMemoryTableStore({ AUDITORIA: rows.length ? rows : [[...WRITE_HEADERS.AUDITORIA]] }), 'AUDITORIA')
    } catch {
      console.warn('[project-os] /agentes: no se pudo leer AUDITORIA')
    }
  }
  const eventos = audit ? eventosOrdenes(data.ordenes, audit) : null
  const base = ordenesDelFiltro(data.ordenes, eventos, filtro)

  const client = githubClient(process.env, { maxLlamadas: LLAMADAS_AGENTES })
  const gh = client ? await githubDeAgentes(client, filtro.proyecto, base.estado === 'ok' ? base.datos.ordenes : null) : null
  const prs = gh?.prs ?? null

  const finanzas = await getFinanzas()
  const fuenteClaude: FuenteClaude = finanzas.estado === 'ok' ? finanzas.vista.claude
    : { estado: 'sin-fuente', mensaje: finanzas.estado === 'no-configurado' ? 'FINANZAS no está configurado en este despliegue.' : 'No se pudo leer FINANZAS.' }

  return (
    <>
      <h1>Agentes</h1>
      <Freshness data={data} />
      <TabWarnings data={data} tabs={['ORDENES_CODEX']} />
      <p className="muted small">
        Solo lectura. {audit ? null : 'AUDITORIA no está disponible para esta sesión (solo se lee para escritores con la escritura activa). '}
        {client ? null : 'Sin token de GitHub en este servidor. '}
        {gh?.vencido ? `GitHub no terminó en ${LIMITE_GLOBAL_MS / 1000} s: lo que faltaba sale «sin datos». ` : null}
      </p>
      <VistaAgentes filtro={filtro} ind={{
        ordenes: conteoOrdenes(base),
        fusion: tiempoAFusion(data.ordenes, eventos, prs, filtro, gh?.truncados),
        dictamenes: dictamenesPorOrden(base, eventos, prs, gh?.dictamenes ?? null),
        lanzamientos: mapaLanzamientos(audit, data.ordenes, filtro),
        claude: gastoClaude(fuenteClaude, filtro),
      }} />
    </>
  )
}
