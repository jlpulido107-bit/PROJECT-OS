import type { Metadata } from 'next'
import { Freshness, LoadError, TabWarnings } from '@/components/data-state'
import { PlanningView } from '@/components/planning/planning-view'
import { MERIDA_TZ } from '@/lib/dates'
import { planningInputFromDataset } from '@/lib/planning/input'
import { referenceDateFor } from '@/lib/planning/reference'
import { privateData } from '@/lib/page-data'

export const metadata: Metadata = { title: 'Planificación' }

export default async function PlanningPage() {
  const { result } = await privateData('/planificacion')
  if (!result.ok) return <><h1>Planificación</h1><LoadError result={result} /></>
  const data = result.data
  // El servidor fija la fecha de referencia (hoy en Mérida); el motor puro se ejecuta en el navegador para
  // simular escenarios al instante, sin enviar nada de vuelta.
  return (
    <>
      <h1>Planificación semanal y diaria</h1>
      <Freshness data={data} />
      <TabWarnings data={data} tabs={['PROYECTOS', 'TAREAS', 'DEPENDENCIAS', 'CAPACIDAD_SEMANAL', 'ASIGNACIONES', 'PLAN_DIARIO', 'PLAN_ITEMS', 'TIEMPOS']} />
      <PlanningView input={planningInputFromDataset(data)} referenceDate={referenceDateFor(data.fetchedAt, MERIDA_TZ)} timeZone={MERIDA_TZ} />
    </>
  )
}
