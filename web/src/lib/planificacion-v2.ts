import { formatMinutes, taskState } from './aggregate'
import { esDelPropietario } from './inicio'
import { PLAN_CANCELLED_STATES } from './planning/rules'
import type { PlanResult } from './planning/types'
import type { Dataset, Tarea } from './types'

/**
 * Planificación v2, fase F1 (ORD-POS-120, diseño docs/diseno-planificacion-v2.md §2 y §3): regla de lenguaje y capa Hoy.
 * Funciones puras sobre lo que /planificacion ya lee (la hoja y `planWeek`): no leen ni escriben nada.
 */

/* --------------------------------- §2 Regla de lenguaje --------------------------------- */

export type Entidad =
  | { tipo: 'tarea'; id: string; titulo: string | null }
  | { tipo: 'proyecto'; id: string; nombre: string | null }
  | { tipo: 'orden'; id: string; titulo: string | null }
  | { tipo: 'hito'; id: string; nombre: string | null }
  | { tipo: 'decision'; id: string; asunto: string | null }
  | { tipo: 'pr'; numero: number; titulo: string | null }

export interface Etiqueta {
  /** Lo que se lee primero: el nombre, o el texto de §2 si la fila no lo tiene. */
  nombre: string
  /** El ID que va después, en letra pequeña; `null` si no se muestra (un proyecto con nombre). */
  id: string | null
  /** Las dos partes en una línea: «nombre · ID». */
  texto: string
}

const SIN_NOMBRE: Record<Exclude<Entidad['tipo'], 'pr' | 'proyecto'>, string> = {
  tarea: '(tarea sin título)',
  orden: '(orden sin título)',
  hito: '(hito sin nombre)',
  decision: '(decisión sin asunto)',
}

const limpio = (v: string | null): string | null => (v && v.trim() !== '' ? v.trim() : null)
const armar = (nombre: string, id: string | null): Etiqueta => ({ nombre, id, texto: id ? `${nombre} · ${id}` : nombre })

/** Nunca un código suelto: primero el nombre y después el ID (§2). */
export function etiqueta(e: Entidad): Etiqueta {
  switch (e.tipo) {
    case 'proyecto': {
      const nombre = limpio(e.nombre)
      return nombre ? armar(nombre, null) : armar('(sin nombre)', e.id)
    }
    case 'pr': {
      const titulo = limpio(e.titulo)
      return titulo ? armar(`PR #${e.numero} de ${titulo}`, null) : armar(`PR #${e.numero}`, null)
    }
    case 'tarea':
    case 'orden':
      return armar(limpio(e.titulo) ?? SIN_NOMBRE[e.tipo], e.id)
    case 'hito':
      return armar(limpio(e.nombre) ?? SIN_NOMBRE.hito, e.id)
    case 'decision':
      return armar(limpio(e.asunto) ?? SIN_NOMBRE.decision, e.id)
  }
}

/* --------------------------------------- Formato --------------------------------------- */

const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb']
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']

/** «vie 31 oct» para una fecha civil YYYY-MM-DD (sin pasar por la zona del servidor). */
export function fechaCorta(civil: string): string {
  const [y, m, d] = civil.split('-').map(Number) as [number, number, number]
  return `${DIAS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MESES[m - 1]}`
}

export const duracion = formatMinutes

/* --------------------------------------- §3 Capa Hoy --------------------------------------- */

export interface TarjetaHoy {
  tareaId: string
  etiqueta: Etiqueta
  /** `null` si la tarea no tiene proyecto. */
  proyecto: Etiqueta | null
  minutos: number
  /** Minutos registrados en TIEMPOS para la tarea («ya llevas»). */
  registradoMin: number
  venceHoy: boolean
  vencida: boolean
  instrucciones: string | null
  /** Del PLAN_ITEMS registrado o propuesto por el motor. */
  origen: 'registrado' | 'propuesto'
  /** Datos para `CompleteTaskForm`; `null` si la tarea no está en TAREAS (no se puede cerrar desde aquí). */
  cierre: { id: string; version: number; criterioTerminado: string } | null
}

export interface VenceHoy {
  tareaId: string
  etiqueta: Etiqueta
}

export type CapaHoy =
  | { estado: 'sin-datos'; fecha: string; motivo: string }
  | { estado: 'no-laborable'; fecha: string; motivo: string; fueraDelPlan: VenceHoy[] }
  | { estado: 'ok'; fecha: string; tarjetas: TarjetaHoy[]; totalMin: number; capacidadMin: number | null; fueraDelPlan: VenceHoy[] }

const TABS_HOY = ['TAREAS', 'PLAN_DIARIO', 'PLAN_ITEMS'] as const
/** El resto de REQUIRED_TABS del motor: sin ellas `planWeek` no propone nada. */
const OTRAS_TABS_MOTOR = ['PROYECTOS', 'DEPENDENCIAS', 'CAPACIDAD_SEMANAL', 'ASIGNACIONES', 'TIEMPOS'] as const

function etiquetaTarea(id: string, t: Tarea | undefined): Etiqueta {
  return etiqueta({ tipo: 'tarea', id, titulo: t?.titulo ?? null })
}

/**
 * Qué hacer hoy (§3): los PLAN_ITEMS registrados de hoy y, después, lo que el motor propone para hoy con el escenario
 * por omisión, en ese orden. Sin una fuente válida es `sin-datos` con el motivo, nunca un 0.
 */
export function capaHoy(ds: Dataset, plan: PlanResult): CapaHoy {
  const fecha = plan.referencia.fecha
  for (const tab of TABS_HOY) {
    const st = ds.tabs[tab]
    if (!st.ok || st.truncated) {
      return { estado: 'sin-datos', fecha, motivo: `La pestaña ${tab} no se pudo leer completa: no se sabe qué hay planeado para hoy.` }
    }
  }
  const tareas = new Map(ds.tareas.map((t) => [t.id, t]))
  const proyectos = new Map(ds.proyectos.map((p) => [p.id, p]))
  const planes = new Map(plan.tareas.map((p) => [p.id, p]))
  const dia = plan.dias.find((d) => d.fecha === fecha)

  // 1) Lo registrado para hoy (PLAN_DIARIO no cancelado + sus PLAN_ITEMS), en el orden registrado.
  const planesHoy = ds.planes
    .filter((p) => p.fecha === fecha && !(p.estado && PLAN_CANCELLED_STATES.has(p.estado)))
    .map((p) => p.id)
    .sort()
  const filas: Array<{ tareaId: string; minutos: number; origen: TarjetaHoy['origen'] }> = []
  const registrados = ds.planItems
    .filter((i) => i.planId !== null && planesHoy.includes(i.planId) && i.tareaId && i.minutosPlan !== null && Number.isFinite(i.minutosPlan) && i.minutosPlan >= 0)
    .sort((a, b) => planesHoy.indexOf(a.planId!) - planesHoy.indexOf(b.planId!) || (a.orden ?? Infinity) - (b.orden ?? Infinity) || a.id.localeCompare(b.id))
  for (const i of registrados) filas.push({ tareaId: i.tareaId!, minutos: Math.round(i.minutosPlan!), origen: 'registrado' })
  // 2) Lo que el motor propone para hoy.
  for (const i of [...(dia?.items ?? [])].sort((a, b) => a.orden - b.orden)) filas.push({ tareaId: i.tareaId, minutos: i.minutos, origen: 'propuesto' })

  const tarjetas: TarjetaHoy[] = []
  for (const f of filas) {
    const t = tareas.get(f.tareaId)
    if (t && taskState(t) === 'cerrada') continue
    const previa = tarjetas.find((x) => x.tareaId === f.tareaId)
    if (previa) {
      previa.minutos += f.minutos
      continue
    }
    const proyecto = t?.proyectoId ? etiqueta({ tipo: 'proyecto', id: t.proyectoId, nombre: proyectos.get(t.proyectoId)?.nombre ?? null }) : null
    tarjetas.push({
      tareaId: f.tareaId,
      etiqueta: etiquetaTarea(f.tareaId, t),
      proyecto,
      minutos: f.minutos,
      registradoMin: planes.get(f.tareaId)?.registradoMin ?? 0,
      venceHoy: t?.fechaLimite === fecha,
      vencida: t?.fechaLimite !== null && t?.fechaLimite !== undefined && t.fechaLimite < fecha,
      instrucciones: limpio(t?.instrucciones ?? null),
      origen: f.origen,
      cierre: t ? { id: t.id, version: Number(t.version ?? '0') || 0, criterioTerminado: t.criterioTerminado ?? '' } : null,
    })
  }

  // Misma regla que «Mis pendientes» de Inicio (abiertas, del propietario), solo las que vencen hoy.
  const enPlan = new Set(tarjetas.map((t) => t.tareaId))
  const fueraDelPlan = ds.tareas
    .filter((t) => taskState(t) === 'abierta' && t.fechaLimite === fecha && esDelPropietario(t) && !enPlan.has(t.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((t) => ({ tareaId: t.id, etiqueta: etiquetaTarea(t.id, t) }))

  if (registrados.length === 0) {
    if (dia && !dia.laborable) return { estado: 'no-laborable', fecha, motivo: 'Hoy no es día laborable: no hay capacidad registrada.', fueraDelPlan }
    if (plan.estado === 'datos-insuficientes') {
      const faltan = OTRAS_TABS_MOTOR.filter((tab) => !ds.tabs[tab].ok || ds.tabs[tab].truncated)
      const motivo = faltan.length > 0
        ? `No se pudo leer completa ${faltan.length === 1 ? 'la pestaña' : 'las pestañas'} ${faltan.join(', ')}: el plan del día no se calcula.`
        : plan.capacidad.origen === 'ambigua'
          ? 'Hay más de una fila de CAPACIDAD_SEMANAL para esta semana: el plan del día no se calcula hasta dejar una.'
          : 'No hay capacidad registrada para esta semana en CAPACIDAD_SEMANAL: el plan del día no se calcula.'
      return { estado: 'sin-datos', fecha, motivo }
    }
  }
  return {
    estado: 'ok',
    fecha,
    tarjetas,
    totalMin: tarjetas.reduce((acc, t) => acc + t.minutos, 0),
    capacidadMin: dia?.capacidadMin ?? null,
    fueraDelPlan,
  }
}
