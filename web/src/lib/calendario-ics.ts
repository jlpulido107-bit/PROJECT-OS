import { taskState } from './aggregate'
import { addDays } from './dates'
import { etiqueta } from './planificacion-v2'
import { PLAN_CANCELLED_STATES } from './planning/rules'
import type { Dataset, Tarea } from './types'

/**
 * Generador del calendario ICS de solo lectura (ORD-POS-142; contrato en docs/escritura-v1-8.md §11.4 y §11.5).
 * Función pura: recibe los datos ya leídos y la fecha de hoy en Mérida; no lee el reloj, no escribe nada y solo usa
 * TAREAS, PLAN_DIARIO y PLAN_ITEMS. Sale solo SUMMARY, la fecha, UID y DTSTAMP: nunca DESCRIPCION, INSTRUCCIONES, NOTAS,
 * RESPONSABLE, correos ni datos de otras pestañas.
 */

/** Hoy y los 13 días siguientes (§11.5). */
export const DIAS_VENTANA = 14

/** Pestañas que lee el calendario: si alguna no se leyó completa no se genera (no se publica un calendario a medias). */
export const PESTANAS_CALENDARIO = ['TAREAS', 'PLAN_DIARIO', 'PLAN_ITEMS'] as const

export interface EventoIcs {
  uid: string
  /** Fecha civil YYYY-MM-DD del evento de día completo. */
  fecha: string
  summary: string
  /** Instante (epoch ms) del ACTUALIZADO_EN de la hoja; si falta, la medianoche UTC de la fecha (nunca el reloj). */
  dtstamp: number
}

type DatosCalendario = Pick<Dataset, 'tareas' | 'planes' | 'planItems'>

const medianocheUtc = (civil: string): number => {
  const [y, m, d] = civil.split('-').map(Number) as [number, number, number]
  return Date.UTC(y, m - 1, d)
}

const maxDefinido = (...valores: Array<number | undefined>): number | undefined => {
  const vistos = valores.filter((v): v is number => v !== undefined && Number.isFinite(v))
  return vistos.length > 0 ? Math.max(...vistos) : undefined
}

const nombreTarea = (id: string, t: Tarea) => etiqueta({ tipo: 'tarea', id, titulo: t.titulo }).texto

/**
 * Eventos de los próximos 14 días, ordenados por fecha, plan antes que vencimiento y por ID de tarea.
 * - Plan: ítems de PLAN_ITEMS de un PLAN_DIARIO no cancelado con fecha en la ventana y MINUTOS_PLAN > 0 (vacío o 0 no
 *   sale: vacío ≠ 0 y una tarea quitada del día queda en 0). La tarea debe existir en TAREAS y no estar cerrada. Si la
 *   misma tarea tiene más de un ítem en la misma fecha, sale un solo evento con la suma (el UID es por tarea y fecha).
 * - Vencimiento: tareas abiertas con FECHA_LIMITE en la ventana.
 */
export function eventosCalendario(ds: DatosCalendario, hoy: string): EventoIcs[] {
  const fin = addDays(hoy, DIAS_VENTANA - 1)
  const enVentana = (f: string | null): f is string => f !== null && f >= hoy && f <= fin
  const tareas = new Map(ds.tareas.map((t) => [t.id, t]))

  const planes = new Map(ds.planes
    .filter((p) => enVentana(p.fecha) && !(p.estado && PLAN_CANCELLED_STATES.has(p.estado)))
    .map((p) => [p.id, p]))
  const plan = new Map<string, { tareaId: string; fecha: string; minutos: number; stamp: number | undefined }>()
  for (const item of ds.planItems) {
    const p = item.planId !== null ? planes.get(item.planId) : undefined
    const t = item.tareaId ? tareas.get(item.tareaId) : undefined
    const min = item.minutosPlan
    if (!p || !t || taskState(t) === 'cerrada' || min === null || !Number.isFinite(min) || min <= 0) continue
    const clave = `${t.id}\u0000${p.fecha}`
    const previo = plan.get(clave)
    const stamp = maxDefinido(previo?.stamp, p.actualizadoEn?.epochMs, item.actualizadoEn?.epochMs)
    plan.set(clave, { tareaId: t.id, fecha: p.fecha!, minutos: (previo?.minutos ?? 0) + min, stamp })
  }

  const eventos: Array<EventoIcs & { orden: number; tareaId: string }> = []
  for (const e of plan.values()) {
    const t = tareas.get(e.tareaId)!
    eventos.push({
      uid: `${e.tareaId}-${e.fecha}-plan@project-os`,
      fecha: e.fecha,
      // Los minutos tal como están en la hoja (sumados si hay más de un ítem), sin redondear a horas.
      summary: `${nombreTarea(e.tareaId, t)} · ${e.minutos} min`,
      dtstamp: e.stamp ?? t.actualizadoEn?.epochMs ?? medianocheUtc(e.fecha),
      orden: 0,
      tareaId: e.tareaId,
    })
  }
  for (const t of ds.tareas) {
    if (taskState(t) !== 'abierta' || !enVentana(t.fechaLimite)) continue
    eventos.push({
      uid: `${t.id}-${t.fechaLimite}-vence@project-os`,
      fecha: t.fechaLimite,
      summary: `Vence: ${nombreTarea(t.id, t)}`,
      dtstamp: t.actualizadoEn?.epochMs ?? medianocheUtc(t.fechaLimite),
      orden: 1,
      tareaId: t.id,
    })
  }
  eventos.sort((a, b) => a.fecha.localeCompare(b.fecha) || a.orden - b.orden || a.tareaId.localeCompare(b.tareaId))
  return eventos.map(({ uid, fecha, summary, dtstamp }) => ({ uid, fecha, summary, dtstamp }))
}

/* ------------------------------------- RFC 5545 ------------------------------------- */

/** Escape de TEXT (RFC 5545 §3.3.11): \ ; , y saltos de línea; los demás caracteres de control se quitan. */
export function escaparTexto(texto: string): string {
  return texto
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/[\u0000-\u001f\u007f]/g, '')
}

const encoder = new TextEncoder()

/**
 * Plegado de líneas (RFC 5545 §3.1): ninguna línea pasa de 75 octetos sin contar CRLF; la continuación empieza con un
 * espacio. Nunca corta un carácter UTF-8 a la mitad.
 */
export function plegarLinea(linea: string): string {
  const partes: string[] = []
  let actual = ''
  let octetos = 0
  for (const ch of linea) {
    const n = encoder.encode(ch).length
    const limite = partes.length === 0 ? 75 : 74
    if (octetos + n > limite) {
      partes.push(actual)
      actual = ''
      octetos = 0
    }
    actual += ch
    octetos += n
  }
  partes.push(actual)
  return partes.join('\r\n ')
}

const fechaIcs = (civil: string) => civil.replace(/-/g, '')

/** Instante en UTC con el formato de DATE-TIME (YYYYMMDDTHHMMSSZ). */
const instanteIcs = (epochMs: number) => new Date(epochMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')

/** El archivo .ics completo, con CRLF y líneas plegadas. */
export function calendarioIcs(eventos: EventoIcs[]): string {
  const lineas = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//PROJECT-OS//Planificacion//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escaparTexto('PROJECT-OS · Planificación')}`,
  ]
  for (const e of eventos) {
    lineas.push(
      'BEGIN:VEVENT',
      `UID:${escaparTexto(e.uid)}`,
      `DTSTAMP:${instanteIcs(e.dtstamp)}`,
      `DTSTART;VALUE=DATE:${fechaIcs(e.fecha)}`,
      `DTEND;VALUE=DATE:${fechaIcs(addDays(e.fecha, 1))}`,
      `SUMMARY:${escaparTexto(e.summary)}`,
      'END:VEVENT',
    )
  }
  lineas.push('END:VCALENDAR')
  return lineas.map(plegarLinea).join('\r\n') + '\r\n'
}

export type ResultadoCalendario = { ok: true; ics: string } | { ok: false; motivo: string }

/** Calendario a partir del conjunto de datos; sin una de sus tres pestañas leída completa, no se genera. */
export function calendarioDesdeDataset(ds: Dataset, hoy: string): ResultadoCalendario {
  for (const tab of PESTANAS_CALENDARIO) {
    const st = ds.tabs[tab]
    if (!st.ok || st.truncated) return { ok: false, motivo: `La pestaña ${tab} no se pudo leer completa.` }
  }
  return { ok: true, ics: calendarioIcs(eventosCalendario(ds, hoy)) }
}
