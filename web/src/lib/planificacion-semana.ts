import { SUPUESTO_RESERVA_VACIA } from './planning/engine'
import type { PlanResult } from './planning/types'

/**
 * Capa Semana de Planificación v2 (ORD-POS-121, POS-040; diseño docs/diseno-planificacion-v2.md §5, fase F2). Funciones
 * puras de solo lectura sobre el resultado de `planWeek` (CAPACIDAD_SEMANAL, PLAN_ITEMS y TIEMPOS) que /planificacion ya
 * calcula en el navegador; los hitos van en `planificacion-semana-hitos.ts` (servidor).
 * No escriben ni recalculan lo que el motor ya calcula. Si falta una fuente, el bloque es `sin-datos` con su motivo;
 * nunca un 0.
 */

export type Bloque<T> = { estado: 'ok'; datos: T } | { estado: 'sin-datos'; motivo: string }

export interface DiaSemana {
  fecha: string
  laborable: boolean
  esHoy: boolean
  esPasado: boolean
  /**
   * Capacidad del día en minutos (`DayPlan.capacidadMin`); `null` si no es laborable o ya pasó: el motor solo reparte la
   * capacidad entre los días que quedan y aquí no se recalcula.
   */
  disponibleMin: number | null
  /** Plan registrado (PLAN_ITEMS) más lo propuesto por el motor. */
  planeadoMin: number
  /** Minutos de TIEMPOS; `null` en los días que aún no llegan (no hay «real» del futuro). */
  realMin: number | null
  /** Minutos planeados por encima de la capacidad del día; `null` si no se pasa o no hay capacidad. */
  excesoMin: number | null
}

export interface DiasSemana {
  semanaIso: string
  lunes: string
  domingo: string
  origen: 'dato' | 'supuesto'
  semanaId: string | null
  horasDisponibles: number | null
  /** Reserva en porcentaje (0–100). */
  reservaPct: number | null
  /** false si RESERVA_PCT está vacía y el motor no descuenta reserva (la vista lo dice con palabras, nunca «0 %»). */
  reservaRegistrada: boolean
  netaMin: number | null
  planeadoMin: number
  dias: DiaSemana[]
}

const sinDatos = (motivo: string) => ({ estado: 'sin-datos', motivo }) as const

/** Bloque de días de la capa Semana a partir del resultado del motor (sigue el escenario de la vista). */
export function diasSemana(plan: PlanResult, pestanasNoDisponibles: readonly string[]): Bloque<DiasSemana> {
  for (const tab of ['CAPACIDAD_SEMANAL', 'PLAN_ITEMS', 'TIEMPOS'] as const) {
    if (pestanasNoDisponibles.includes(tab)) return sinDatos(`La pestaña ${tab} no se pudo leer completa: sin horas de la semana.`)
  }
  const cap = plan.capacidad
  if (cap.origen === 'faltante') return sinDatos('sin capacidad registrada para esta semana en CAPACIDAD_SEMANAL.')
  if (cap.origen === 'ambigua') return sinDatos('Hay más de una fila de CAPACIDAD_SEMANAL para esta semana: deja una sola.')
  const hoy = plan.referencia.fecha
  const dias = plan.dias.map((d): DiaSemana => {
    const planeadoMin = d.planExistenteMin + d.propuestoMin
    const disponibleMin = d.laborable ? d.capacidadMin : null
    const exceso = disponibleMin === null ? 0 : planeadoMin - disponibleMin
    return {
      fecha: d.fecha,
      laborable: d.laborable,
      esHoy: d.fecha === hoy,
      esPasado: d.fecha < hoy,
      disponibleMin,
      planeadoMin,
      realMin: d.fecha <= hoy ? d.realMin : null,
      excesoMin: exceso > 0 ? exceso : null,
    }
  })
  return {
    estado: 'ok',
    datos: {
      semanaIso: plan.referencia.semanaIso,
      lunes: plan.referencia.lunes,
      domingo: plan.referencia.domingo,
      origen: cap.origen,
      semanaId: cap.semanaId,
      horasDisponibles: cap.horasDisponibles,
      reservaPct: cap.reservaPct,
      reservaRegistrada: !plan.supuestos.includes(SUPUESTO_RESERVA_VACIA),
      netaMin: cap.netaMin,
      planeadoMin: dias.reduce((acc, d) => acc + d.planeadoMin, 0),
      dias,
    },
  }
}

/** Texto de días restantes: «vence en 14 días», «vence hoy», «vencido hace 2 días», «sin fecha objetivo». */
export function textoDias(dias: number | null): string {
  if (dias === null) return 'sin fecha objetivo'
  if (dias === 0) return 'vence hoy'
  if (dias > 0) return `vence en ${dias} ${dias === 1 ? 'día' : 'días'}`
  return `vencido hace ${-dias} ${dias === -1 ? 'día' : 'días'}`
}


/** «45 min», «2 h», «2 h 30 min» (regla de lenguaje, §2). */
export function minutosTexto(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  if (h === 0) return `${m} min`
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

const DIAS_CORTOS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb']
const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']

/** «vie 31 oct» para una fecha civil YYYY-MM-DD (sin pasar por la zona del navegador). */
export function fechaCorta(civil: string): string {
  const [y, m, d] = civil.split('-').map(Number) as [number, number, number]
  return `${DIAS_CORTOS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MESES_CORTOS[m - 1]}`
}

/** Texto del día para la barra y su tabla: planeado de disponible, real y exceso, siempre con palabras. */
export function textoDia(d: DiaSemana): string {
  if (!d.laborable) return '(no laborable)'
  const partes = [
    d.disponibleMin !== null ? `${minutosTexto(d.planeadoMin)} de ${minutosTexto(d.disponibleMin)}`
      : d.esPasado ? `${minutosTexto(d.planeadoMin)} planeadas (día pasado)`
        : `${minutosTexto(d.planeadoMin)} planeadas, sin capacidad`,
  ]
  if (d.excesoMin !== null) partes.push(`${minutosTexto(d.excesoMin)} por encima de la capacidad`)
  if (d.realMin !== null) partes.push(d.realMin === 0 ? 'sin tiempo real registrado' : `real ${minutosTexto(d.realMin)}`)
  return partes.join(' · ')
}
