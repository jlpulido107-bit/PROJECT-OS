import { isoWeekId } from './planning/calendar'
import type { PlanningInput } from './planning/types'

/**
 * Panel «Capacidad de la semana» de /planificacion (ORD-POS-139, DEC-POS-029 c; docs/escritura-v1-8.md §11.1). Funciones
 * puras, sin red ni Next: qué fila de CAPACIDAD_SEMANAL corresponde a la semana de la vista, qué valores muestra el
 * formulario y qué cuerpo se manda a POST /api/operaciones/capacidad. Vacío se queda vacío: nunca 0.
 */

export const CAMPOS_CAPACIDAD = ['horasDisponibles', 'reservaPct', 'estado'] as const
export type CampoCapacidad = (typeof CAMPOS_CAPACIDAD)[number]

/** Valores tal como se muestran en el formulario; '' = vacío (nunca 0). La reserva va en porcentaje 0–100. */
export type ValoresCapacidad = Record<CampoCapacidad, string>

export const ETIQUETA_CAPACIDAD: Record<CampoCapacidad, string> = {
  horasDisponibles: 'Horas disponibles',
  reservaPct: 'Reserva (%)',
  estado: 'Estado de la semana',
}

/** Estados que ofrece el formulario; el motor solo trata APROBADA como definitiva. Se conserva cualquier otro de la hoja. */
export const ESTADOS_CAPACIDAD = ['BORRADOR', 'APROBADA'] as const

/** Lo que el servidor manda al navegador con la edición encendida para la sesión del propietario. */
export interface EdicionCapacidad {
  /** CAPACIDAD_SEMANAL ya tiene la columna VERSION (migración de §11.2). */
  migrada: boolean
  /** VERSION de cada SEMANA_ID; null si la celda está vacía o no es entera (no se edita hasta escribir 1). */
  versiones: Record<string, number | null>
}

/** Fila de la semana de la vista: ninguna (alta), una (edición) o varias (ambigua: no se edita). */
export type ObjetivoCapacidad =
  | { tipo: 'nueva'; semanaId: string; fechaInicio: string; valores: ValoresCapacidad }
  | { tipo: 'existente'; semanaId: string; fechaInicio: string; valores: ValoresCapacidad }
  | { tipo: 'ambigua'; semanaIds: string[] }

const redondear2 = (n: number) => Math.round(n * 100) / 100

/** Valores del formulario de una fila de la entrada del motor (reserva como fracción 0–1 → porcentaje). */
export function valoresDeCapacidad(c: PlanningInput['capacidad'][number]): ValoresCapacidad {
  return {
    horasDisponibles: c.horasDisponibles === null ? '' : String(c.horasDisponibles),
    reservaPct: c.reservaPct === null ? '' : String(redondear2(c.reservaPct * 100)),
    estado: c.estado ?? '',
  }
}

/**
 * La fila de la semana lunes..domingo con la misma regla que el motor (FECHA_INICIO dentro de la semana). Sin fila,
 * propone un alta con SEMANA_ID ISO (`2026-W45`) y FECHA_INICIO = el lunes, todo lo demás vacío.
 */
export function capacidadSemana(input: PlanningInput, lunes: string, domingo: string): ObjetivoCapacidad {
  const filas = input.capacidad.filter((c) => c.fechaInicio !== null && c.fechaInicio >= lunes && c.fechaInicio <= domingo)
  if (filas.length > 1) return { tipo: 'ambigua', semanaIds: filas.map((c) => c.id) }
  const fila = filas[0]
  if (fila) return { tipo: 'existente', semanaId: fila.id, fechaInicio: fila.fechaInicio!, valores: valoresDeCapacidad(fila) }
  return { tipo: 'nueva', semanaId: isoWeekId(lunes), fechaInicio: lunes, valores: { horasDisponibles: '', reservaPct: '', estado: '' } }
}

export type CuerpoCapacidad = {
  semanaId: string
  fechaInicio: string
  horasDisponibles: string | null
  reservaPct: string | null
  estado: string | null
  expectedVersion?: number
}

const limpio = (raw: unknown) => (typeof raw === 'string' ? raw.trim() : '')

/**
 * Cuerpo de POST /api/operaciones/capacidad (sin requestId, que pone el envío). Es el estado completo de la fila; vacío
 * va como null y la celda queda vacía. En una edición, null si nada cambió; en un alta siempre hay cuerpo.
 */
export function cuerpoCapacidad(
  objetivo: Exclude<ObjetivoCapacidad, { tipo: 'ambigua' }>, version: number | null, escrito: Readonly<Record<string, unknown>>,
): CuerpoCapacidad | null {
  const v = Object.fromEntries(CAMPOS_CAPACIDAD.map((c) => [c, limpio(escrito[c])])) as ValoresCapacidad
  const cuerpo: CuerpoCapacidad = {
    semanaId: objetivo.semanaId,
    fechaInicio: objetivo.fechaInicio,
    horasDisponibles: v.horasDisponibles === '' ? null : v.horasDisponibles.replace(',', '.'),
    reservaPct: v.reservaPct === '' ? null : v.reservaPct.replace(',', '.'),
    estado: v.estado === '' ? null : v.estado.toUpperCase(),
  }
  if (objetivo.tipo === 'nueva') return cuerpo
  const sinCambios = CAMPOS_CAPACIDAD.every((c) => {
    const antes = objetivo.valores[c]
    const ahora = v[c]
    if (c === 'estado') return antes.toUpperCase() === ahora.toUpperCase()
    return antes === ahora || (antes !== '' && ahora !== '' && Number(antes) === Number(ahora.replace(',', '.')))
  })
  if (sinCambios) return null
  return version === null ? cuerpo : { ...cuerpo, expectedVersion: version }
}

/** Texto de cada valor: vacío siempre con palabras, nunca 0. */
export function textoCapacidad(campo: CampoCapacidad, valor: string): string {
  if (campo === 'horasDisponibles') return valor === '' ? 'Sin capacidad registrada' : `${valor} h`
  if (campo === 'reservaPct') return valor === '' ? 'Sin reserva registrada' : `${valor} %`
  return valor === '' ? 'Sin estado' : valor
}

/** Por qué el formulario no se muestra aunque la edición esté encendida; null si se puede editar. */
export function bloqueoCapacidad(objetivo: ObjetivoCapacidad, edicion: EdicionCapacidad): string | null {
  if (!edicion.migrada) return 'Falta la migración: CAPACIDAD_SEMANAL aún no tiene la columna VERSION (la añade el propietario, docs/escritura-v1-8.md §11.2).'
  if (objetivo.tipo === 'ambigua') return `Hay más de una fila de CAPACIDAD_SEMANAL para esta semana (${objetivo.semanaIds.join(', ')}): deja una sola en la hoja.`
  if (objetivo.tipo === 'existente' && (edicion.versiones[objetivo.semanaId] ?? null) === null) {
    return `La fila ${objetivo.semanaId} no tiene VERSION: escribe 1 en la hoja, según la migración, para editarla aquí.`
  }
  return null
}
