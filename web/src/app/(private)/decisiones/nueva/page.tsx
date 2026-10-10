import type { Metadata } from 'next'
import { LoadError } from '@/components/data-state'
import { DecisionForm } from '@/components/operations/forms'
import { WriteGate } from '@/components/operations/write-access'
import { todayInMerida } from '@/lib/dates'
import { privateData } from '@/lib/page-data'

export const metadata: Metadata = { title: 'Registrar decisión' }

export default async function NewDecisionPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams
  const { user, result } = await privateData('/decisiones/nueva')
  return (
    <>
      <h1>Registrar decisión</h1>
      <WriteGate email={user.email}>
        {!result.ok ? <LoadError result={result} /> : (
          <DecisionForm
            projects={result.data.proyectos.map((p) => ({ value: p.id, label: `${p.id}${p.nombre ? ` · ${p.nombre}` : ''}` }))}
            defaultProject={typeof params.proyecto === 'string' ? params.proyecto.toUpperCase() : undefined}
            today={todayInMerida()}
          />
        )}
      </WriteGate>
    </>
  )
}
