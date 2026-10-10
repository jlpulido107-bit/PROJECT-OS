import type { Metadata } from 'next'
import { LoadError } from '@/components/data-state'
import { NewTaskForm } from '@/components/operations/forms'
import { WriteGate } from '@/components/operations/write-access'
import { KNOWN_TASK_TYPES } from '@/lib/operations/constants'
import { privateData } from '@/lib/page-data'

export const metadata: Metadata = { title: 'Nueva tarea' }

export default async function NewTaskPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams
  const { user, result } = await privateData('/tareas/nueva')
  return (
    <>
      <h1>Nueva tarea</h1>
      <WriteGate email={user.email}>
        {!result.ok ? <LoadError result={result} /> : (
          <NewTaskForm
            projects={result.data.proyectos.map((p) => ({ value: p.id, label: `${p.id}${p.nombre ? ` · ${p.nombre}` : ''}` }))}
            milestones={result.data.hitos.filter((h) => h.proyectoId).map((h) => ({ value: h.id, label: `${h.id}${h.nombre ? ` · ${h.nombre}` : ''}`, project: h.proyectoId! }))}
            defaultProject={typeof params.proyecto === 'string' ? params.proyecto.toUpperCase() : undefined}
            taskTypes={[...new Set([...KNOWN_TASK_TYPES, ...result.data.tareas.map((t) => t.tipo).filter((t): t is string => Boolean(t))])].sort()}
          />
        )}
      </WriteGate>
    </>
  )
}
