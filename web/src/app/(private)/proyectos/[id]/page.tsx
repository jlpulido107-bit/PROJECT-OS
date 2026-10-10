import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Freshness, LoadError, TabWarnings } from '@/components/data-state'
import { EvidenceItem } from '@/components/evidence-item'
import { writeAccess } from '@/components/operations/write-access'
import { TaskCard } from '@/components/task-card'
import { DateText, Empty, ExternalLink, humanize, Section, StateBadge, Text } from '@/components/ui'
import { formatMinutes, indexTasks, projectStats, sortTasks } from '@/lib/aggregate'
import { formatTimestamp } from '@/lib/dates'
import { privateData } from '@/lib/page-data'

export const metadata: Metadata = { title: 'Proyecto' }

const EVIDENCE_LIMIT = 20

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await params
  const id = decodeURIComponent(rawId)
  const { user, result } = await privateData(`/proyectos/${encodeURIComponent(id)}`)
  if (!result.ok) return <><h1>Proyecto</h1><LoadError result={result} /></>
  const data = result.data
  const project = data.proyectos.find((p) => p.id === id)
  if (!project) notFound()
  const canEdit = writeAccess(user.email).allowed

  const st = projectStats(project.id, data)
  const hitos = data.hitos.filter((h) => h.proyectoId === project.id)
  const tareas = sortTasks(data.tareas.filter((t) => t.proyectoId === project.id))
  const evidencias = data.evidencias
    .filter((e) => e.proyectoId === project.id)
    .sort((a, b) => (b.fecha ?? '').localeCompare(a.fecha ?? '') || b.id.localeCompare(a.id))
  const decisiones = data.decisiones.filter((d) => d.proyectoId === project.id)
  const tasks = indexTasks(data.tareas)

  return (
    <>
      <p className="breadcrumb"><Link href="/proyectos">← Proyectos</Link></p>
      <h1><span className="mono">{project.id}</span> · <Text value={project.nombre} empty="Sin nombre" /></h1>
      <Freshness data={data} />
      <TabWarnings data={data} tabs={['HITOS', 'TAREAS', 'EVIDENCIAS', 'DECISIONES', 'DEPENDENCIAS', 'TIEMPOS']} />

      <div className="badges">
        <StateBadge code={project.estado} />
        <StateBadge code={project.prioridad} label="Prioridad" />
        <span className="badge badge-muted">Fase: {humanize(project.fase)}</span>
      </div>
      <dl className="meta meta-wide">
        <div><dt>Objetivo</dt><dd><Text value={project.objetivo} /></dd></div>
        <div><dt>Responsable</dt><dd><Text value={project.responsable} /></dd></div>
        <div><dt>Inicio</dt><dd><DateText value={project.fechaInicio} /></dd></div>
        <div><dt>Fecha objetivo</dt><dd><DateText value={project.fechaObjetivo} /></dd></div>
        <div><dt>Repositorio</dt><dd>{project.repositorioUrl ? <ExternalLink href={project.repositorioUrl}>{project.repositorioUrl.replace(/^https:\/\//, '')}</ExternalLink> : <span className="muted">Sin repositorio</span>}</dd></div>
        <div><dt>Tiempo real</dt><dd>{st.minutos.minutos === null ? <span className="muted">Sin registros</span> : `${formatMinutes(st.minutos.minutos)} (${st.minutos.sesiones} sesiones)`}</dd></div>
        <div><dt>Notas</dt><dd><Text value={project.notas} empty="Sin notas" /></dd></div>
        <div><dt>Actualizado</dt><dd>{project.actualizadoEn ? formatTimestamp(project.actualizadoEn) : <span className="muted">Sin registrar</span>}</dd></div>
      </dl>

      <Section title={`Hitos (${hitos.length})`} id="hitos">
        {hitos.length === 0 ? (
          <Empty>Este proyecto no tiene hitos registrados.</Empty>
        ) : (
          <ul className="cards">
            {hitos.map((h) => (
              <li key={h.id} className="card">
                <h3 className="card-title"><span className="mono">{h.id}</span> · <Text value={h.nombre} empty="Sin nombre" /></h3>
                <div className="badges"><StateBadge code={h.estado} /></div>
                <dl className="meta">
                  <div><dt>Resultado esperado</dt><dd><Text value={h.resultadoEsperado} /></dd></div>
                  <div><dt>Criterio de aceptación</dt><dd><Text value={h.criterioAceptacion} /></dd></div>
                  <div><dt>Fecha objetivo</dt><dd><DateText value={h.fechaObjetivo} /></dd></div>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`Tareas (${st.tareasAbiertas} abiertas de ${tareas.length})`} id="tareas"
        actions={<span className="section-links">{canEdit ? <Link href={`/tareas/nueva?proyecto=${encodeURIComponent(project.id)}`}>Nueva tarea</Link> : null}<Link href={`/tareas?proyecto=${encodeURIComponent(project.id)}`}>Filtrar tareas</Link></span>}>
        {tareas.length === 0 ? <Empty>Este proyecto no tiene tareas registradas.</Empty> : (
          <div className="stack">{tareas.map((t) => <TaskCard key={t.id} task={t} data={data} canEdit={canEdit} />)}</div>
        )}
      </Section>

      <Section title={`Evidencias (${evidencias.length})`} id="evidencias"
        actions={<Link href={`/actividad?proyecto=${encodeURIComponent(project.id)}`}>Ver toda la actividad</Link>}>
        {evidencias.length === 0 ? <Empty>No hay evidencias registradas para este proyecto.</Empty> : (
          <>
            <ul className="stack plain">
              {evidencias.slice(0, EVIDENCE_LIMIT).map((e) => <li key={e.id}><EvidenceItem evidence={e} tasks={tasks} /></li>)}
            </ul>
            {evidencias.length > EVIDENCE_LIMIT ? <p className="muted small">Mostrando las {EVIDENCE_LIMIT} más recientes.</p> : null}
          </>
        )}
      </Section>

      <Section title={`Decisiones (${decisiones.length})`} id="decisiones"
        actions={canEdit ? <Link href={`/decisiones/nueva?proyecto=${encodeURIComponent(project.id)}`}>Registrar decisión</Link> : undefined}>
        {decisiones.length === 0 ? <Empty>No hay decisiones registradas para este proyecto.</Empty> : (
          <ul className="cards">
            {decisiones.map((d) => (
              <li key={d.id} className="card">
                <h3 className="card-title"><span className="mono">{d.id}</span> · <Text value={d.asunto} empty="Sin asunto" /></h3>
                <div className="badges"><StateBadge code={d.estado} /><DateText value={d.fecha} /></div>
                <p><strong>Decisión:</strong> <Text value={d.decision} /></p>
                <p><strong>Justificación:</strong> <Text value={d.justificacion} /></p>
                {d.evidenciaUrl ? <p><ExternalLink href={d.evidenciaUrl}>Evidencia</ExternalLink></p> : null}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  )
}
