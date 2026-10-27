import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { LoadError } from '@/components/data-state'
import { Instrucciones } from '@/components/instrucciones'
import { EditTaskForm } from '@/components/operations/forms'
import { WriteGate } from '@/components/operations/write-access'
import { Text } from '@/components/ui'
import { KNOWN_TASK_TYPES } from '@/lib/operations/constants'
import { privateData } from '@/lib/page-data'
import { CLOSED_TASK_STATES } from '@/lib/schema'

export const metadata: Metadata = { title: 'Editar tarea' }

export default async function EditTaskPage({ params }: { params: Promise<{ id: string }> }) {
  const id = decodeURIComponent((await params).id).toUpperCase()
  const { user, result } = await privateData(`/tareas/${encodeURIComponent(id)}/editar`)
  if (!result.ok) return <><h1>Editar tarea</h1><LoadError result={result} /></>
  const task = result.data.tareas.find((t) => t.id === id)
  if (!task) notFound()
  const closed = task.estado !== null && CLOSED_TASK_STATES.has(task.estado)
  return (
    <>
      <p className="breadcrumb"><Link href={`/tareas?q=${encodeURIComponent(task.id)}`}>← Tareas</Link></p>
      <h1><span className="mono">{task.id}</span> · <Text value={task.titulo} empty="Sin título" /></h1>
      {task.instrucciones ? (
        <section aria-labelledby="instrucciones-titulo">
          <h2 id="instrucciones-titulo">Instrucciones</h2>
          <Instrucciones texto={task.instrucciones} />
        </section>
      ) : null}
      <WriteGate email={user.email}>
        {closed ? (
          <div className="alert alert-info" role="note">
            <p>Esta tarea está <strong>cerrada</strong> ({task.estado}). Reabrirla o modificarla requiere aprobación humana fuera del dashboard.</p>
          </div>
        ) : (
          <EditTaskForm
            key={task.version ?? '0'}
            task={{
              id: task.id,
              version: Number(task.version ?? '0') || 0,
              hitoId: task.hitoId ?? '',
              titulo: task.titulo ?? '',
              descripcion: task.descripcion ?? '',
              tipo: task.tipo ?? '',
              estado: task.estado ?? 'PENDIENTE',
              prioridad: task.prioridad ?? '',
              responsable: task.responsable ?? '',
              fechaPlan: task.fechaPlan ?? '',
              fechaLimite: task.fechaLimite ?? '',
              horasEstimadas: task.horasEstimadas === null ? '' : String(task.horasEstimadas),
              criterioTerminado: task.criterioTerminado ?? '',
              bloqueo: task.bloqueo ?? '',
              instrucciones: task.instrucciones ?? '',
            }}
            milestones={result.data.hitos.filter((h) => h.proyectoId === task.proyectoId).map((h) => ({ value: h.id, label: `${h.id}${h.nombre ? ` · ${h.nombre}` : ''}` }))}
            taskTypes={[...new Set([...KNOWN_TASK_TYPES, ...result.data.tareas.map((t) => t.tipo).filter((t): t is string => Boolean(t))])].sort()}
          />
        )}
      </WriteGate>
    </>
  )
}
