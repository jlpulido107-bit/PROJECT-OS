import type { Metadata } from 'next'
import { LoadError } from '@/components/data-state'
import { TimeForm } from '@/components/operations/forms'
import { WriteGate } from '@/components/operations/write-access'
import { sortTasks } from '@/lib/aggregate'
import { todayInMerida } from '@/lib/dates'
import { KNOWN_WORK_TYPES } from '@/lib/operations/constants'
import { privateData } from '@/lib/page-data'

export const metadata: Metadata = { title: 'Registrar tiempo' }

export default async function NewTimePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams
  const { user, result } = await privateData('/tiempos/nuevo')
  return (
    <>
      <h1>Registrar tiempo</h1>
      <WriteGate email={user.email}>
        {!result.ok ? <LoadError result={result} /> : (
          <TimeForm
            tasks={sortTasks(result.data.tareas).map((t) => ({ value: t.id, label: `${t.id} · ${t.titulo ?? 'Sin título'}${t.estado ? ` (${t.estado})` : ''}` }))}
            defaultTask={typeof params.tarea === 'string' ? params.tarea.toUpperCase() : undefined}
            today={todayInMerida()}
            workTypes={KNOWN_WORK_TYPES}
          />
        )}
      </WriteGate>
    </>
  )
}
