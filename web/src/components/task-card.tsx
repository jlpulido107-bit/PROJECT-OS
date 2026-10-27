import Link from 'next/link'
import { dependenciesFor, isBlocked } from '@/lib/aggregate'
import { CLOSED_TASK_STATES } from '@/lib/schema'
import type { Dataset, Tarea } from '@/lib/types'
import { Instrucciones } from './instrucciones'
import { Badge, DateText, humanize, StateBadge, Text } from './ui'

export function TaskCard({ task, data, canEdit = false }: { task: Tarea; data: Dataset; canEdit?: boolean }) {
  const deps = dependenciesFor(task.id, data)
  const blocked = isBlocked(task)
  return (
    <article className={`card task${blocked ? ' task-blocked' : ''}`} aria-labelledby={`t-${task.id}`} id={`tarea-${task.id}`}>
      <header className="card-head">
        <h3 id={`t-${task.id}`}>
          <span className="mono">{task.id}</span> · <Text value={task.titulo} empty="Sin título" />
        </h3>
        <div className="badges">
          <StateBadge code={task.estado} />
          <StateBadge code={task.prioridad} label="Prioridad" />
          {blocked ? <Badge tone="danger">Bloqueada</Badge> : null}
        </div>
      </header>
      {task.descripcion ? <p>{task.descripcion}</p> : null}
      {task.instrucciones ? (
        <details className="instrucciones-tarea">
          <summary>Instrucciones</summary>
          <Instrucciones texto={task.instrucciones} />
        </details>
      ) : null}
      <dl className="meta">
        <div><dt>Proyecto</dt><dd>{task.proyectoId ? <Link href={`/proyectos/${encodeURIComponent(task.proyectoId)}`}>{task.proyectoId}</Link> : <span className="muted">Sin proyecto</span>}</dd></div>
        <div><dt>Hito</dt><dd><Text value={task.hitoId} empty="Sin hito" /></dd></div>
        <div><dt>Tipo</dt><dd>{humanize(task.tipo)}</dd></div>
        <div><dt>Responsable</dt><dd><Text value={task.responsable} /></dd></div>
        <div><dt>Fecha plan</dt><dd><DateText value={task.fechaPlan} /></dd></div>
        <div><dt>Fecha límite</dt><dd><DateText value={task.fechaLimite} /></dd></div>
        <div><dt>Horas estimadas</dt><dd>{task.horasEstimadas === null ? <span className="muted">Sin estimar</span> : task.horasEstimadas}</dd></div>
        <div><dt>Versión</dt><dd><Text value={task.version} /></dd></div>
      </dl>
      <p><strong>Criterio de terminado:</strong> <Text value={task.criterioTerminado} empty="Sin criterio registrado" /></p>
      {task.bloqueo ? <p className="blocker"><strong>Bloqueo:</strong> {task.bloqueo}</p> : null}
      {deps.dependeDe.length > 0 || deps.bloqueaA.length > 0 ? (
        <div className="deps">
          {deps.dependeDe.length > 0 ? (
            <p>
              <strong>Depende de:</strong>{' '}
              {deps.dependeDe.map(({ dependencia, tarea, pendiente }, i) => (
                <span key={dependencia.id}>
                  {i > 0 ? ', ' : ''}
                  <span className="mono">{dependencia.dependeDeTareaId}</span> ({humanize(dependencia.tipo)}
                  {tarea ? `, ${humanize(tarea.estado)}` : ', tarea no encontrada'})
                  {pendiente ? <Badge tone="warn">pendiente</Badge> : <Badge tone="ok">resuelta</Badge>}
                </span>
              ))}
            </p>
          ) : null}
          {deps.bloqueaA.length > 0 ? (
            <p>
              <strong>Requerida por:</strong>{' '}
              {deps.bloqueaA.map(({ dependencia }, i) => (
                <span key={dependencia.id}>{i > 0 ? ', ' : ''}<span className="mono">{dependencia.tareaId}</span></span>
              ))}
            </p>
          ) : null}
        </div>
      ) : null}
      {canEdit ? (
        <div className="card-actions">
          {task.estado === null || !CLOSED_TASK_STATES.has(task.estado) ? (
            <Link className="button" href={`/tareas/${encodeURIComponent(task.id)}/editar`}>Editar</Link>
          ) : null}
          <Link className="button" href={`/tiempos/nuevo?tarea=${encodeURIComponent(task.id)}`}>Registrar tiempo</Link>
        </div>
      ) : null}
    </article>
  )
}
