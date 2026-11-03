import { PLAN_CANCELLED_STATES } from './planning/rules'
import type { PlanningInput, PlanResult } from './planning/types'

/**
 * Aplicar los movimientos de la simulación al plan registrado (ORD-POS-140, DEC-POS-029; docs/escritura-v1-8.md §11.1).
 * Funciones puras, sin red ni Next: qué se escribirá en PLAN_DIARIO y PLAN_ITEMS por cada día con tareas movidas, el
 * cuerpo de cada POST /api/operaciones/plan-dia (una llamada por día) y cómo se cuenta el resultado de cada día.
 *
 * Reglas: solo los bloques movidos (fijados) se registran; los demás bloques propuestos siguen siendo propuesta. Los
 * minutos movidos se suman a los que la tarea ya tenga registrados ese día (el motor solo mueve lo que aún no estaba
 * planeado). Nada se quita ni se borra: los elementos ya registrados que no se mueven no van en el cuerpo y el servidor
 * no los toca. Días pasados, nunca. TAREAS no se toca (ni FECHA_PLAN ni ESTADO).
 */

/** Lo que el servidor manda al navegador con la edición encendida para la sesión del propietario. */
export interface EdicionPlanDia {
  /** PLAN_DIARIO ya tiene la columna VERSION (migración de §11.2). */
  migrada: boolean
  /** VERSION de cada PLAN_ID; null si la celda está vacía o no es entera (ese plan no se edita hasta escribir 1). */
  versiones: Record<string, number | null>
}

export interface ElementoPlanDia {
  tareaId: string
  titulo: string | null
  orden: number
  /** Minutos que la tarea ya tiene registrados ese día; null si no tiene fila en el plan. */
  minutosAntes: number | null
  minutosMovidos: number
  /** Lo que se escribirá en MINUTOS_PLAN: antes + movidos. */
  minutosPlan: number
}

export interface CuerpoPlanDia {
  fecha: string
  items: Array<{ tareaId: string; orden: number; minutosPlan: number }>
  expectedVersion?: number
}

export type DiaParaAplicar =
  | {
    tipo: 'listo'
    fecha: string
    /** PLAN_ID existente, o el que tendrá el alta (`PLAN-AAAA-MM-DD`). */
    planId: string
    nuevo: boolean
    /** Versión vista del plan existente; null en un alta. */
    version: number | null
    elementos: ElementoPlanDia[]
    cuerpo: CuerpoPlanDia
  }
  | { tipo: 'bloqueado'; fecha: string; motivo: string; elementos: ElementoPlanDia[] }

const PESTANAS_PLAN = ['PLAN_DIARIO', 'PLAN_ITEMS', 'TAREAS'] as const

/** Por qué no se puede aplicar nada (migración o pestañas incompletas); null si se puede. */
export function bloqueoPlanDia(input: PlanningInput, edicion: EdicionPlanDia): string | null {
  if (!edicion.migrada) return 'Falta la migración: PLAN_DIARIO aún no tiene la columna VERSION (la añade el propietario, docs/escritura-v1-8.md §11.2).'
  const faltan = PESTANAS_PLAN.filter((t) => input.pestanasNoDisponibles.includes(t))
  if (faltan.length) return `No se puede leer completa ${faltan.join(', ')}: sin el plan actual no se escribe nada.`
  return null
}

/**
 * Días con bloques movidos que todavía no pasan (desde la fecha de referencia), con lo que se escribirá en cada uno. Un
 * día con más de un plan activo, un plan sin VERSION o una fila de la tarea sin minutos válidos queda bloqueado con su
 * motivo y no se manda.
 */
export function diasParaAplicar(plan: PlanResult, input: PlanningInput, edicion: EdicionPlanDia): DiaParaAplicar[] {
  const titulos = new Map(input.tareas.map((t) => [t.id, t.titulo]))
  const dias: DiaParaAplicar[] = []
  for (const d of plan.dias) {
    const movidos = d.items.filter((i) => i.fijada === true && i.minutos > 0)
    if (movidos.length === 0) continue
    const base = movidos.map((i) => ({ tareaId: i.tareaId, titulo: titulos.get(i.tareaId) ?? null, orden: 0, minutosAntes: null, minutosMovidos: i.minutos, minutosPlan: i.minutos }))
    if (d.esPasado || d.fecha < plan.referencia.fecha) {
      dias.push({ tipo: 'bloqueado', fecha: d.fecha, motivo: 'El día ya pasó: su plan no se reescribe.', elementos: base })
      continue
    }
    const activos = input.planes.filter((p) => p.fecha === d.fecha && !(p.estado && PLAN_CANCELLED_STATES.has(p.estado)))
    if (activos.length > 1) {
      dias.push({ tipo: 'bloqueado', fecha: d.fecha, motivo: `Hay ${activos.length} planes activos para este día (${activos.map((p) => p.id).join(', ')}): deja uno solo en la hoja.`, elementos: base })
      continue
    }
    const existente = activos[0]
    const version = existente ? edicion.versiones[existente.id] ?? null : null
    if (existente && version === null) {
      dias.push({ tipo: 'bloqueado', fecha: d.fecha, motivo: `El plan ${existente.id} no tiene VERSION: escribe 1 en la hoja, según la migración, para guardarlo aquí.`, elementos: base })
      continue
    }
    const registrados = existente ? input.planItems.filter((i) => i.planId === existente.id) : []
    let siguiente = registrados.reduce((max, i) => (i.orden !== null && Number.isFinite(i.orden) ? Math.max(max, Math.round(i.orden)) : max), 0)
    const elementos: ElementoPlanDia[] = []
    let motivo: string | null = null
    for (const m of [...movidos].sort((a, b) => a.orden - b.orden)) {
      const filas = registrados.filter((i) => i.tareaId === m.tareaId)
      if (filas.length > 1) {
        motivo = `El plan tiene más de una fila de ${m.tareaId}: deja una sola en la hoja.`
        break
      }
      const fila = filas[0]
      if (fila && (fila.minutosPlan === null || !Number.isFinite(fila.minutosPlan) || fila.minutosPlan < 0)) {
        motivo = `La fila de ${m.tareaId} en el plan no tiene MINUTOS_PLAN válidos: corrígela en la hoja (no se suponen minutos).`
        break
      }
      const antes = fila ? Math.round(fila.minutosPlan!) : null
      const orden = fila && fila.orden !== null && Number.isInteger(fila.orden) && fila.orden >= 1 ? fila.orden : ++siguiente
      elementos.push({ tareaId: m.tareaId, titulo: titulos.get(m.tareaId) ?? null, orden, minutosAntes: antes, minutosMovidos: m.minutos, minutosPlan: (antes ?? 0) + m.minutos })
    }
    if (motivo) {
      dias.push({ tipo: 'bloqueado', fecha: d.fecha, motivo, elementos: base })
      continue
    }
    const cuerpo: CuerpoPlanDia = {
      fecha: d.fecha,
      items: elementos.map((e) => ({ tareaId: e.tareaId, orden: e.orden, minutosPlan: e.minutosPlan })),
      ...(existente ? { expectedVersion: version! } : {}),
    }
    dias.push({ tipo: 'listo', fecha: d.fecha, planId: existente?.id ?? `PLAN-${d.fecha}`, nuevo: !existente, version, elementos, cuerpo })
  }
  return dias
}

/** Plan actual de un día tal como lo devuelve el servidor en un conflicto (`detalle.planActual`). */
export interface PlanActual {
  planId: string
  version: number | null
  items: Array<{ tareaId: string; orden: string; minutosPlan: string }>
}

export type ResultadoDia =
  | { tipo: 'guardado'; fecha: string; planId: string; version: number | null; repetida: boolean }
  | { tipo: 'conflicto'; fecha: string; mensaje: string; planActual: PlanActual | null }
  | { tipo: 'error'; fecha: string; codigo: string; mensaje: string }

/** Lee `detalle.planActual` de la respuesta de un conflicto; cualquier otra forma = null (no se inventa nada). */
export function planActualDe(detalle: unknown): PlanActual | null {
  const raw = detalle && typeof detalle === 'object' ? (detalle as Record<string, unknown>).planActual : null
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  if (typeof p.planId !== 'string' || !Array.isArray(p.items)) return null
  const items = p.items.flatMap((i) => {
    if (!i || typeof i !== 'object') return []
    const r = i as Record<string, unknown>
    return typeof r.tareaId === 'string' ? [{ tareaId: r.tareaId, orden: String(r.orden ?? ''), minutosPlan: String(r.minutosPlan ?? '') }] : []
  })
  return { planId: p.planId, version: typeof p.version === 'number' ? p.version : null, items }
}

/** Texto de un elemento del plan actual: los minutos tal como están en la hoja; vacío se dice, nunca 0. */
export function textoItemActual(i: PlanActual['items'][number]): string {
  return `${i.tareaId} · ${i.minutosPlan === '' ? 'sin minutos' : `${i.minutosPlan} min`}`
}

/** Resultado de una respuesta del servidor para un día. */
export function resultadoDia(fecha: string, json: unknown): ResultadoDia {
  const r = json && typeof json === 'object' ? (json as Record<string, unknown>) : null
  if (r?.ok === true) {
    return { tipo: 'guardado', fecha, planId: typeof r.id === 'string' ? r.id : '', version: typeof r.version === 'number' ? r.version : null, repetida: r.repetida === true }
  }
  const error = r && r.error && typeof r.error === 'object' ? (r.error as Record<string, unknown>) : null
  const codigo = typeof error?.codigo === 'string' ? error.codigo : 'error'
  const mensaje = typeof error?.mensaje === 'string' ? error.mensaje : 'No se pudo completar la operación.'
  if (codigo === 'conflicto-version' || codigo === 'conflicto-concurrente') return { tipo: 'conflicto', fecha, mensaje, planActual: planActualDe(error?.detalle) }
  return { tipo: 'error', fecha, codigo, mensaje }
}

/** Fallos tras los cuales reintentar el MISMO cuerpo reutiliza el requestId (el servidor completa lo auditado). */
export const REINTENTO_MISMA_SOLICITUD = new Set(['escritura-fallida', 'verificacion-fallida', 'red'])

/** Movimientos que quedan tras guardar: los de los días guardados ya están en el plan registrado. */
export function fijadasRestantes(fijadas: Record<string, string>, resultados: ResultadoDia[]): Record<string, string> {
  const guardados = new Set(resultados.filter((r) => r.tipo === 'guardado').map((r) => r.fecha))
  return Object.fromEntries(Object.entries(fijadas).filter(([, fecha]) => !guardados.has(fecha)))
}
