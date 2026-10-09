import type { Metadata } from 'next'
import Link from 'next/link'
import { Freshness, LoadError, TabWarnings } from '@/components/data-state'
import { DateText, Empty, humanize, StateBadge, Text } from '@/components/ui'
import { formatMinutes, projectStats } from '@/lib/aggregate'
import { privateData } from '@/lib/page-data'

export const metadata: Metadata = { title: 'Proyectos' }

export default async function ProjectsPage() {
  const { result } = await privateData('/proyectos')
  if (!result.ok) return <><h1>Proyectos</h1><LoadError result={result} /></>
  const data = result.data
  return (
    <>
      <h1>Proyectos</h1>
      <Freshness data={data} />
      <TabWarnings data={data} tabs={['PROYECTOS', 'HITOS', 'TAREAS', 'TIEMPOS']} />
      {data.proyectos.length === 0 ? (
        <Empty>No hay proyectos registrados en la pestaña PROYECTOS.</Empty>
      ) : (
        <ul className="cards" aria-label="Proyectos registrados">
          {data.proyectos.map((p) => {
            const st = projectStats(p.id, data)
            return (
              <li key={p.id} className="card">
                <h2 className="card-title">
                  <Link href={`/proyectos/${encodeURIComponent(p.id)}`}>
                    <span className="mono">{p.id}</span> · <Text value={p.nombre} empty="Sin nombre" />
                  </Link>
                </h2>
                <p><Text value={p.objetivo} empty="Objetivo sin registrar" /></p>
                <div className="badges">
                  <StateBadge code={p.estado} />
                  <StateBadge code={p.prioridad} label="Prioridad" />
                  <span className="badge badge-muted">Fase: {humanize(p.fase)}</span>
                </div>
                <dl className="meta">
                  <div><dt>Tareas abiertas</dt><dd>{st.tareas === 0 ? <span className="muted">Sin tareas</span> : `${st.tareasAbiertas} de ${st.tareas}`}</dd></div>
                  <div><dt>Hitos completados</dt><dd>{st.hitos === 0 ? <span className="muted">Sin hitos</span> : `${st.hitosCompletados} de ${st.hitos}`}</dd></div>
                  <div><dt>Tiempo real</dt><dd>{st.minutos.minutos === null ? <span className="muted">Sin registros</span> : formatMinutes(st.minutos.minutos)}</dd></div>
                  <div><dt>Fecha objetivo</dt><dd><DateText value={p.fechaObjetivo} /></dd></div>
                </dl>
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}
