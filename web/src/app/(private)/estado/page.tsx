import type { Metadata } from 'next'
import Link from 'next/link'
import { Freshness, LoadError, TabWarnings } from '@/components/data-state'
import { Badge, DateText, Empty, Section, StateBadge, Text } from '@/components/ui'
import { formatMinutes, type MinutesTotal } from '@/lib/aggregate'
import { revisionEstado, DIAS_ACTIVIDAD, type Alerta, type HitoEstado, type RiesgoHito } from '@/lib/estado'
import { privateData } from '@/lib/page-data'

export const metadata: Metadata = { title: 'Estado de proyectos' }

const hours = (h: number) => `${Number.isInteger(h) ? h : h.toFixed(1)} h`

const RIESGO: Record<RiesgoHito, { label: string; tone: 'ok' | 'warn' | 'danger' | 'info' | 'neutral' | 'muted' }> = {
  vencido: { label: 'Vencida', tone: 'danger' },
  'no-alcanza': { label: 'No alcanza', tone: 'danger' },
  'en-riesgo': { label: 'En riesgo', tone: 'warn' },
  'sin-tareas': { label: 'Sin tareas', tone: 'warn' },
  'sin-fecha': { label: 'Sin fecha', tone: 'neutral' },
  'en-plazo': { label: 'En plazo', tone: 'info' },
  cerrado: { label: 'Completada', tone: 'ok' },
}

const NIVEL_TONE = { alta: 'danger', media: 'warn', baja: 'neutral' } as const
const NIVEL_LABEL = { alta: 'Alta', media: 'Media', baja: 'Baja' } as const

function Alertas({ alertas, label }: { alertas: Alerta[]; label: string }) {
  if (alertas.length === 0) return null
  return (
    <ul className="list" aria-label={label}>
      {alertas.map((a, i) => (
        <li key={i}><Badge tone={NIVEL_TONE[a.nivel]}>{NIVEL_LABEL[a.nivel]}</Badge> {a.texto}</li>
      ))}
    </ul>
  )
}

function PlanVsReal({ asignadas, reales }: { asignadas: number | null; reales: MinutesTotal }) {
  const real = reales.minutos === null ? <span className="muted">sin tiempos</span> : formatMinutes(reales.minutos)
  const plan = asignadas === null ? <span className="muted">sin asignación</span> : hours(asignadas)
  return <>{real} de {plan}</>
}

function Dias({ dias }: { dias: number | null }) {
  if (dias === null) return <span className="muted">sin fecha</span>
  if (dias < 0) return <>hace {-dias} {dias === -1 ? 'día' : 'días'}</>
  if (dias === 0) return <>hoy</>
  return <>en {dias} {dias === 1 ? 'día' : 'días'}</>
}

function HitoFila({ h }: { h: HitoEstado }) {
  const r = RIESGO[h.riesgo]
  return (
    <tr>
      <th scope="row"><span className="mono">{h.hito.id}</span> · <Text value={h.hito.nombre} empty="Sin nombre" /></th>
      <td><DateText value={h.hito.fechaObjetivo} /> <span className="small muted">(<Dias dias={h.diasRestantes} />)</span></td>
      <td><Badge tone={r.tone}>{r.label}</Badge></td>
      <td>{h.tareasAbiertas} de {h.tareas}</td>
      <td>
        {h.horasPendientes === null ? <span className="muted">sin estimar</span> : hours(h.horasPendientes)}
        {h.tareasSinEstimacion > 0 ? <span className="small muted"> (+{h.tareasSinEstimacion} sin estimar)</span> : null}
      </td>
    </tr>
  )
}

export default async function EstadoPage() {
  const { result } = await privateData('/estado')
  if (!result.ok) return <><h1>Estado de proyectos</h1><LoadError result={result} /></>
  const data = result.data
  // Render por petición: la revisión depende de la fecha de hoy en Mérida.
  const r = revisionEstado(data, new Date())
  const s = r.semana

  return (
    <>
      <h1>Estado de proyectos</h1>
      <Freshness data={data} />
      <TabWarnings data={data} tabs={['PROYECTOS', 'HITOS', 'TAREAS', 'CAPACIDAD_SEMANAL', 'ASIGNACIONES', 'TIEMPOS', 'EVIDENCIAS']} />
      <p className="muted small">
        Lectura de la hoja: metas, tareas y horas tal como están registradas. Las alertas no cambian ningún estado.
      </p>

      <Section title={s.semanaId ? `Semana ${s.semanaId}` : 'Semana en curso'} id="semana">
        <p className="small"><DateText value={s.desde} /> – <DateText value={s.hasta} /> (hoy <DateText value={r.hoy} />)</p>
        <dl className="meta meta-wide">
          <div><dt>Horas netas</dt><dd>{s.horasNetas === null ? <span className="muted">Sin capacidad registrada</span> : <>{hours(s.horasNetas)} <span className="small muted">de {hours(s.horasDisponibles ?? 0)}</span></>}</dd></div>
          <div><dt>Capacidad</dt><dd><StateBadge code={s.estadoCapacidad} /></dd></div>
          <div><dt>Asignadas a proyectos</dt><dd>{s.horasAsignadas === null ? <span className="muted">Sin asignaciones</span> : hours(s.horasAsignadas)}</dd></div>
          <div><dt>Tiempo real registrado</dt><dd>{s.minutosReales.minutos === null ? <span className="muted">Sin tiempos esta semana</span> : `${formatMinutes(s.minutosReales.minutos)} (${s.minutosReales.sesiones} sesiones)`}</dd></div>
        </dl>
        <Alertas alertas={r.alertasGenerales} label="Alertas de la semana" />
      </Section>

      {r.proyectos.length === 0 ? <Empty>No hay proyectos en PROYECTOS.</Empty> : null}
      {r.proyectos.map((p) => {
        const id = `proyecto-${p.proyecto.id}`
        return (
          <Section key={p.proyecto.id} id={id} title={`${p.proyecto.id} · ${p.proyecto.nombre ?? 'Sin nombre'}`}
            actions={<Link href={`/proyectos/${encodeURIComponent(p.proyecto.id)}`}>Ver proyecto →</Link>}>
            <div className="badges">
              <StateBadge code={p.proyecto.estado} />
              <StateBadge code={p.proyecto.prioridad} label="Prioridad" />
            </div>
            <dl className="meta meta-wide">
              <div><dt>Próxima meta</dt><dd>{p.proximoHito ? <><Text value={p.proximoHito.hito.nombre} empty={p.proximoHito.hito.id} /> · <Dias dias={p.proximoHito.diasRestantes} /></> : <span className="muted">Sin meta abierta con fecha</span>}</dd></div>
              <div><dt>Esta semana (real de plan)</dt><dd><PlanVsReal asignadas={p.horasAsignadas} reales={p.minutosReales} /></dd></div>
              <div><dt>Tareas abiertas</dt><dd>{p.tareasAbiertas}{p.tareasBloqueadas.length > 0 ? <> · <Badge tone="danger">{p.tareasBloqueadas.length} {p.tareasBloqueadas.length === 1 ? 'bloqueada' : 'bloqueadas'}</Badge></> : null}</dd></div>
              <div><dt>Actividad ({DIAS_ACTIVIDAD} días)</dt><dd>{p.actividad.evidencias} {p.actividad.evidencias === 1 ? 'evidencia' : 'evidencias'}{p.actividad.ultima ? <span className="small muted"> · última <DateText value={p.actividad.ultima} /></span> : <span className="small muted"> · ninguna registrada</span>}</dd></div>
            </dl>
            <Alertas alertas={p.alertas} label={`Alertas de ${p.proyecto.id}`} />
            {p.hitos.length === 0 ? (
              <Empty>Este proyecto no tiene metas en HITOS.</Empty>
            ) : (
              <div className="table-wrap" role="region" aria-label={`Metas de ${p.proyecto.id}`} tabIndex={0}>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Meta</th>
                      <th scope="col">Fecha</th>
                      <th scope="col">Riesgo</th>
                      <th scope="col">Tareas abiertas</th>
                      <th scope="col">Horas pendientes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.hitos.map((h) => <HitoFila key={h.hito.id} h={h} />)}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        )
      })}
      <p className="muted small">
        «No alcanza»: las horas estimadas pendientes de la meta superan la asignación semanal del proyecto por las semanas que
        quedan. «En riesgo»: vence en 3 días o menos con tareas abiertas.
      </p>
    </>
  )
}
