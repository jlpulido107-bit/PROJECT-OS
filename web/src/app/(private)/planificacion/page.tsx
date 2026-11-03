import type { Metadata } from 'next'
import { Freshness, LoadError, TabWarnings } from '@/components/data-state'
import { FlujoView } from '@/components/planning/flujo'
import { HoyView } from '@/components/planning/hoy'
import { PlanningView } from '@/components/planning/planning-view'
import { LLAMADAS_AGENTES } from '@/lib/agentes-data'
import { MERIDA_TZ } from '@/lib/dates'
import { fuenteBanderas } from '@/lib/banderas'
import { commitDesplegado } from '@/lib/despliegue'
import { canWrite, isWriter, puedeCerrarTareas, puedeEditarPlanificacion } from '@/lib/operations/config'
import { githubClient } from '@/lib/operations/dispatch'
import type { EdicionSemana } from '@/lib/planificacion-edicion'
import { capaFlujo, githubDeFlujo } from '@/lib/planificacion-flujo'
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
  // Capa Flujo (ORD-POS-123): solo lectura de GitHub con el cliente de tope LLAMADAS_AGENTES, la caché de listas de
  // /agentes y la de dictámenes de /ordenes, dentro de LIMITE_GLOBAL_MS; lo que no cupo queda «sin datos». Desplegada
  // (ORD-POS-124) compara con el commit desplegado (DEPLOY_COMMIT_SHA) con el mismo cliente; sin él queda apagada.
  const client = githubClient(process.env, { maxLlamadas: LLAMADAS_AGENTES })
  const ordenesOk = data.tabs.ORDENES_CODEX.ok && !data.tabs.ORDENES_CODEX.truncated
  const commit = commitDesplegado()
  // Activada (ORD-POS-125): la columna BANDERA y el estado de la bandera, solo para la sesión del propietario.
  const flujo = capaFlujo(data.ordenes, ordenesOk, client && ordenesOk ? await githubDeFlujo(client, data.ordenes, { commit }) : null,
    { commit, banderas: fuenteBanderas(data.ordenesConBandera, isWriter(user.email)) })
  // Edición en línea de la capa Semana (ORD-POS-136, DEC-POS-029): solo el propietario con PLANIFICACION_EDICION_PROPIETARIO
  // y la escritura habilitada. Apagada, no se mandan versiones al navegador y la tarjeta dice «Edición apagada».
  const edicion: EdicionSemana = puedeEditarPlanificacion(user.email) && canWrite(user.email)
    ? {
        encendida: true,
        versiones: Object.fromEntries(data.tareas.map((t) => [t.id, Number(t.version ?? '0') || 0])),
        hitosPorProyecto: data.hitos.reduce<Record<string, Array<{ value: string; label: string }>>>((acc, h) => {
          if (h.proyectoId) (acc[h.proyectoId] ??= []).push({ value: h.id, label: `${h.id}${h.nombre ? ` · ${h.nombre}` : ''}` })
          return acc
        }, {}),
        // Panel «Capacidad de la semana» (ORD-POS-139): la VERSION de cada fila; vacía o no entera = null (no se edita).
        capacidad: {
          migrada: data.capacidadConVersion,
          versiones: Object.fromEntries(data.capacidad.map((c) => [c.id, /^\d+$/.test(c.version ?? '') ? Number(c.version) : null])),
        },
      }
    : { encendida: false }
  // El servidor fija la fecha de referencia (hoy en Mérida); el motor puro se ejecuta en el navegador para
  // simular escenarios al instante, sin enviar nada de vuelta.
  return (
    <>
      <h1>Planificación semanal y diaria</h1>
      <Freshness data={data} />
      <TabWarnings data={data} tabs={['PROYECTOS', 'HITOS', 'TAREAS', 'DEPENDENCIAS', 'CAPACIDAD_SEMANAL', 'ASIGNACIONES', 'PLAN_DIARIO', 'PLAN_ITEMS', 'TIEMPOS', 'ORDENES_CODEX']} />
      <HoyView capa={hoy} puedeCerrar={puedeCerrar} />
      <FlujoView capa={flujo} />
      {/* Semana visible y «Detalle del plan» plegado: los pinta PlanningView, porque la capa Semana sigue el escenario del cliente. */}
      <PlanningView input={input} referenceDate={referenceDate} timeZone={MERIDA_TZ} hitosSemana={hitosSemana(data, referenceDate)} edicion={edicion} />
    </>
  )
}
