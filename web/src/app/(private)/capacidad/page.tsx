import type { Metadata } from 'next'
import { Freshness, LoadError, TabWarnings } from '@/components/data-state'
import { Badge, DateText, Empty, humanize, Section, StateBadge, Text } from '@/components/ui'
import { dailyPlans, formatMinutes, weekCapacity, type MinutesTotal } from '@/lib/aggregate'
import { todayInMerida } from '@/lib/dates'
import { privateData } from '@/lib/page-data'

export const metadata: Metadata = { title: 'Capacidad y plan diario' }

const PLAN_LIMIT = 14

function Minutes({ total, empty = 'Sin registros' }: { total: MinutesTotal | null; empty?: string }) {
  if (!total || total.minutos === null) {
    return <span className="muted">{empty}{total && total.sesionesSinMinutos > 0 ? ` (${total.sesionesSinMinutos} sesiones sin minutos válidos)` : ''}</span>
  }
  return <>{formatMinutes(total.minutos)}{total.sesionesSinMinutos > 0 ? <span className="muted"> (+{total.sesionesSinMinutos} sin minutos válidos)</span> : null}</>
}

const hours = (h: number) => `${Number.isInteger(h) ? h : h.toFixed(1)} h`

export default async function CapacityPage() {
  const { result } = await privateData('/capacidad')
  if (!result.ok) return <><h1>Capacidad y plan diario</h1><LoadError result={result} /></>
  const data = result.data
  const weeks = weekCapacity(data)
  const plans = dailyPlans(data)
  const today = todayInMerida()

  return (
    <>
      <h1>Capacidad y plan diario</h1>
      <Freshness data={data} />
      <TabWarnings data={data} tabs={['CAPACIDAD_SEMANAL', 'ASIGNACIONES', 'PLAN_DIARIO', 'PLAN_ITEMS', 'TIEMPOS']} />

      <Section title="Capacidad semanal" id="capacidad">
        {weeks.length === 0 ? (
          <Empty>No hay semanas registradas en CAPACIDAD_SEMANAL.</Empty>
        ) : (
          <div className="table-wrap" role="region" aria-label="Capacidad por semana" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th scope="col">Semana</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Horas disponibles</th>
                  <th scope="col">Reserva</th>
                  <th scope="col">Horas netas</th>
                  <th scope="col">Planeado</th>
                  <th scope="col">Tiempo real</th>
                </tr>
              </thead>
              <tbody>
                {weeks.map((w) => (
                  <tr key={w.semana.id}>
                    <th scope="row">
                      <span className="mono">{w.semana.id}</span>
                      <br />
                      <span className="small">{w.desde ? <><DateText value={w.desde} /> – <DateText value={w.hasta} /></> : <span className="muted">Sin fecha de inicio</span>}</span>
                    </th>
                    <td><StateBadge code={w.semana.estado} /></td>
                    <td>{w.horasDisponibles === null ? <span className="muted">Sin horas registradas</span> : hours(w.horasDisponibles)}</td>
                    <td>{w.reservaPct === null ? <span className="muted">Sin reserva</span> : `${Math.round(w.reservaPct * 100)} %`}</td>
                    <td>{w.horasNetas === null ? <span className="muted">No calculable</span> : hours(w.horasNetas)}</td>
                    <td>{w.minutosPlaneados === null ? <span className="muted">Sin plan</span> : formatMinutes(w.minutosPlaneados)}</td>
                    <td><Minutes total={w.minutosReales} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">Horas netas = horas disponibles × (1 − reserva). Si no hay horas disponibles registradas, no se calcula nada.</p>
        {weeks.some((w) => w.asignaciones.length > 0) ? (
          <>
            <h3>Asignaciones por proyecto</h3>
            <ul className="list">
              {weeks.flatMap((w) => w.asignaciones.map((a) => (
                <li key={a.id}>
                  <span className="mono">{w.semana.id}</span> · <span className="mono">{a.proyectoId ?? 'sin proyecto'}</span>:{' '}
                  {a.horasObjetivo === null ? <span className="muted">sin horas objetivo</span> : hours(a.horasObjetivo)} ({humanize(a.prioridad)})
                </li>
              )))}
            </ul>
          </>
        ) : (
          <Empty>No hay asignaciones de horas por proyecto registradas (ASIGNACIONES).</Empty>
        )}
      </Section>

      <Section title="Plan diario" id="plan">
        {plans.length === 0 ? (
          <Empty>No hay planes registrados en PLAN_DIARIO.</Empty>
        ) : (
          <div className="stack">
            {plans.slice(0, PLAN_LIMIT).map((p) => (
              <article key={p.plan.id} className={`card${p.plan.fecha === today ? ' card-today' : ''}`} aria-labelledby={`plan-${p.plan.id}`}>
                <header className="card-head">
                  <h3 id={`plan-${p.plan.id}`}>
                    <DateText value={p.plan.fecha} /> <span className="mono small">{p.plan.id}</span>
                  </h3>
                  <div className="badges">
                    {p.plan.fecha === today ? <Badge tone="info">Hoy</Badge> : null}
                    <StateBadge code={p.plan.estado} />
                  </div>
                </header>
                <dl className="meta">
                  <div><dt>Horas objetivo</dt><dd>{p.plan.horasObjetivo === null ? <span className="muted">Sin objetivo</span> : hours(p.plan.horasObjetivo)}</dd></div>
                  <div><dt>Minutos planeados</dt><dd>{p.minutosPlaneados === null ? <span className="muted">Sin minutos planeados</span> : formatMinutes(p.minutosPlaneados)}</dd></div>
                  <div><dt>Tiempo real del día</dt><dd><Minutes total={p.minutosReales} /></dd></div>
                </dl>
                {p.plan.notas ? <p>{p.plan.notas}</p> : null}
                {p.items.length === 0 ? (
                  <Empty>Este plan no tiene elementos en PLAN_ITEMS.</Empty>
                ) : (
                  <ol className="list">
                    {p.items.map(({ item, tarea }) => (
                      <li key={item.id}>
                        <span className="mono">{item.tareaId ?? 'sin tarea'}</span>{tarea?.titulo ? ` · ${tarea.titulo}` : item.tareaId ? ' · tarea no encontrada' : ''}
                        {' — '}{item.minutosPlan === null ? <span className="muted">sin minutos</span> : formatMinutes(item.minutosPlan)}
                        {item.resultadoEsperado ? <> · <Text value={item.resultadoEsperado} /></> : null}
                        {tarea ? <> <StateBadge code={tarea.estado} /></> : null}
                      </li>
                    ))}
                  </ol>
                )}
              </article>
            ))}
            {plans.length > PLAN_LIMIT ? <p className="muted small">Mostrando los {PLAN_LIMIT} planes más recientes.</p> : null}
          </div>
        )}
        {plans.every((p) => p.plan.fecha !== today) ? <Empty>No hay plan registrado para hoy (<DateText value={today} />, hora Mérida).</Empty> : null}
      </Section>
    </>
  )
}
