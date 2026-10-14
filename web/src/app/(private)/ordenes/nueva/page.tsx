import type { Metadata } from 'next'
import { LoadError } from '@/components/data-state'
import { OrderForm } from '@/components/operations/forms'
import { WriteGate } from '@/components/operations/write-access'
import { taskState } from '@/lib/aggregate'
import { privateData } from '@/lib/page-data'

export const metadata: Metadata = { title: 'Nueva orden' }

/** Proyectos con repositorio (las órdenes se ejecutan en GitHub). */
const PROYECTOS_CON_REPO = new Set(['SIG', 'ECO', 'POS'])

export default async function NewOrderPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams
  const { user, result } = await privateData('/ordenes/nueva')
  return (
    <>
      <h1>Nueva orden</h1>
      <WriteGate email={user.email}>
        {!result.ok ? <LoadError result={result} /> : (
          <OrderForm
            projects={result.data.proyectos
              .filter((p) => PROYECTOS_CON_REPO.has(p.id) || result.data.source === 'fixtures')
              .map((p) => ({ value: p.id, label: `${p.id}${p.nombre ? ` · ${p.nombre}` : ''}` }))}
            tasks={result.data.tareas
              .filter((t) => t.proyectoId && taskState(t) === 'abierta')
              .map((t) => ({ value: t.id, label: `${t.id}${t.titulo ? ` · ${t.titulo}` : ''}`, proyectoId: t.proyectoId! }))}
            defaultProject={typeof params.proyecto === 'string' ? params.proyecto.toUpperCase() : undefined}
          />
        )}
      </WriteGate>
    </>
  )
}
