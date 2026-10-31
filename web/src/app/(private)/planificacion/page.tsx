import type { Metadata } from 'next'
import { Freshness, LoadError, TabWarnings } from '@/components/data-state'
import { HoyView } from '@/components/planning/hoy'
import { PlanningView } from '@/components/planning/planning-view'
import { MERIDA_TZ } from '@/lib/dates'
import { canWrite, puedeCerrarTareas } from '@/lib/operations/config'
import { hitosSemana } from '@/lib/planificacion-semana-hitos'
import { capaHoy } from '@/lib/planificacion-v2'
import { planWeek } from '@/lib/planning/engine'
import { planningInputFromDataset } from '@/lib/planning/input'
import { referenceDateFor } from '@/lib/planning/reference'
import { DEFAULT_SCENARIO } from '@/lib/planning/scenario'
import { privateData } from '@/lib/page-data'

export const metadata: Metadata = { title: 'Planificación' }

export default async function PlanningPage() {
  const { user, result } = await privateData('/planificacion')
  if (!result.ok) return <><h1>Planificación</h1><LoadError result={result} /></>
  const data = result.data
  const input = planningInputFromDataset(data)
  const referenceDate = referenceDateFor(data.fetchedAt, MERIDA_TZ)
  // Capa Hoy (ORD-POS-120): el mismo motor puro con el escenario por omisión, en el servidor y solo lectura.
  const hoy = capaHoy(data, planWeek(input, DEFAULT_SCENARIO, { referenceDate, timeZone: MERIDA_TZ }))
  // El botón de cierre solo para el propietario con la bandera encendida y la escritura habilitada; el guard lo repite.
  const puedeCerrar = puedeCerrarTareas(user.email) && canWrite(user.email)
  // El servidor fija la fecha de referencia (hoy en Mérida); el motor puro se ejecuta en el navegador para
  // simular escenarios al instante, sin enviar nada de vuelta.
  return (
    <>
      <h1>Planificación semanal y diaria</h1>
      <Freshness data={data} />
      <TabWarnings data={data} tabs={['PROYECTOS', 'HITOS', 'TAREAS', 'DEPENDENCIAS', 'CAPACIDAD_SEMANAL', 'ASIGNACIONES', 'PLAN_DIARIO', 'PLAN_ITEMS', 'TIEMPOS']} />
      <HoyView capa={hoy} puedeCerrar={puedeCerrar} />
      {/* Semana visible y «Detalle del plan» plegado: los pinta PlanningView, porque la capa Semana sigue el escenario del cliente. */}
      <PlanningView input={input} referenceDate={referenceDate} timeZone={MERIDA_TZ} hitosSemana={hitosSemana(data, referenceDate)} />
    </>
  )
}
