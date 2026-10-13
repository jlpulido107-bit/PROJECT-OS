import { isBlocked, mondayOf, sumMinutes, taskState, type MinutesTotal } from './aggregate'
import { addDays, daysBetween, todayInMerida } from './dates'
import { COMPLETED_STATE } from './schema'
import type { Dataset, Hito, Proyecto, Tarea } from './types'

/**
 * Revisión de estado por proyecto (V1.7). Lectura pura de la hoja:
 * - Solo se usan datos registrados; un total sin filas de origen es `null`, nunca un 0 engañoso.
 * - Las alertas señalan huecos y riesgos; no cambian estados ni cierran nada.
 * - Plan vs real compara ASIGNACIONES con TIEMPOS de la semana en curso (hora Mérida).
 */

/** Días antes de la fecha objetivo en que una meta con trabajo abierto se marca en riesgo. */
export const DIAS_RIESGO = 3
/** Días hacia atrás para contar la actividad registrada en EVIDENCIAS. */
export const DIAS_ACTIVIDAD = 7

export type RiesgoHito = 'cerrado' | 'vencido' | 'no-alcanza' | 'en-riesgo' | 'sin-tareas' | 'sin-fecha' | 'en-plazo'
export type NivelAlerta = 'alta' | 'media' | 'baja'

export interface Alerta {
  nivel: NivelAlerta
  texto: string
}

export interface HitoEstado {
  hito: Hito
  diasRestantes: number | null
  tareas: number
  tareasAbiertas: number
  /** Suma de HORAS_ESTIMADAS de las tareas abiertas; `null` si ninguna tiene estimación. */
  horasPendientes: number | null
  tareasSinEstimacion: number
  /** Horas que caben hasta la fecha con la asignación semanal del proyecto; `null` si no se puede calcular. */
  horasAlcanzables: number | null
  riesgo: RiesgoHito
}

export interface SemanaEstado {
  semanaId: string | null
  desde: string
  hasta: string
  horasDisponibles: number | null
  horasNetas: number | null
  estadoCapacidad: string | null
  /** Suma de ASIGNACIONES de la semana; `null` si no hay ninguna con horas. */
  horasAsignadas: number | null
  minutosReales: MinutesTotal
  /** Sesiones de la semana sin tarea o con una tarea que no existe: no cuentan para ningún proyecto. */
  sesionesSinProyecto: number
}

export interface ProyectoEstado {
  proyecto: Proyecto
  hitos: HitoEstado[]
  proximoHito: HitoEstado | null
  tareasAbiertas: number
  tareasBloqueadas: Tarea[]
  tareasVencidas: Tarea[]
  tareasSinHito: number
  tareasSinEstimacion: number
  horasAsignadas: number | null
  minutosReales: MinutesTotal
  actividad: { evidencias: number; ultima: string | null }
  alertas: Alerta[]
}

export interface RevisionEstado {
  hoy: string
  semana: SemanaEstado
  proyectos: ProyectoEstado[]
  alertasGenerales: Alerta[]
}

const RIESGO_ORDEN: Record<RiesgoHito, number> = {
  vencido: 0, 'no-alcanza': 1, 'en-riesgo': 2, 'sin-tareas': 3, 'sin-fecha': 4, 'en-plazo': 5, cerrado: 6,
}

const NIVEL_ORDEN: Record<NivelAlerta, number> = { alta: 0, media: 1, baja: 2 }

function sumOrNull(values: Array<number | null>): number | null {
  const valid = values.filter((v): v is number => v !== null)
  return valid.length > 0 ? valid.reduce((a, b) => a + b, 0) : null
}

const horas = (h: number) => `${Number.isInteger(h) ? h : h.toFixed(1)} h`
const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`

function semanaEnCurso(ds: Dataset, hoy: string): Omit<SemanaEstado, 'minutosReales' | 'sesionesSinProyecto' | 'horasAsignadas'> {
  const fila = [...ds.capacidad]
    .filter((c) => c.fechaInicio !== null && c.fechaInicio <= hoy && hoy <= addDays(c.fechaInicio, 6))
    .sort((a, b) => (b.fechaInicio ?? '').localeCompare(a.fechaInicio ?? '') || a.id.localeCompare(b.id))[0]
  if (!fila || fila.fechaInicio === null) {
    const desde = mondayOf(hoy)
    return { semanaId: null, desde, hasta: addDays(desde, 6), horasDisponibles: null, horasNetas: null, estadoCapacidad: null }
  }
  return {
    semanaId: fila.id,
    desde: fila.fechaInicio,
    hasta: addDays(fila.fechaInicio, 6),
    horasDisponibles: fila.horasDisponibles,
    horasNetas: fila.horasDisponibles === null ? null : fila.horasDisponibles * (1 - (fila.reservaPct ?? 0)),
    estadoCapacidad: fila.estado,
  }
}

function riesgoHito(h: Omit<HitoEstado, 'riesgo'>): RiesgoHito {
  if (h.hito.estado === COMPLETED_STATE) return 'cerrado'
  if (h.diasRestantes === null) return 'sin-fecha'
  if (h.diasRestantes < 0) return 'vencido'
  if (h.tareas === 0) return 'sin-tareas'
  if (h.horasPendientes !== null && h.horasAlcanzables !== null && h.horasPendientes > h.horasAlcanzables) return 'no-alcanza'
  if (h.tareasAbiertas > 0 && h.diasRestantes <= DIAS_RIESGO) return 'en-riesgo'
  return 'en-plazo'
}

export function revisionEstado(ds: Dataset, now: Date = new Date()): RevisionEstado {
  const hoy = todayInMerida(now)
  const base = semanaEnCurso(ds, hoy)
  const enSemana = (dia: string | null) => dia !== null && dia >= base.desde && dia <= base.hasta
  const asignacionesSemana = base.semanaId === null ? [] : ds.asignaciones.filter((a) => a.semanaId === base.semanaId)
  const tiemposSemana = ds.tiempos.filter((t) => enSemana(t.fecha))
  const proyectoDeTarea = new Map(ds.tareas.map((t) => [t.id, t.proyectoId]))
  const inicioActividad = addDays(hoy, -(DIAS_ACTIVIDAD - 1))

  const semana: SemanaEstado = {
    ...base,
    horasAsignadas: sumOrNull(asignacionesSemana.map((a) => a.horasObjetivo)),
    minutosReales: sumMinutes(tiemposSemana),
    sesionesSinProyecto: tiemposSemana.filter((t) => !t.tareaId || !proyectoDeTarea.get(t.tareaId)).length,
  }

  const proyectos = ds.proyectos.map((proyecto): ProyectoEstado => {
    const tareas = ds.tareas.filter((t) => t.proyectoId === proyecto.id)
    const abiertas = tareas.filter((t) => taskState(t) === 'abierta')
    const horasAsignadas = base.semanaId === null
      ? null
      : sumOrNull(asignacionesSemana.filter((a) => a.proyectoId === proyecto.id).map((a) => a.horasObjetivo))
    const minutosReales = sumMinutes(
      tiemposSemana.filter((t) => t.tareaId !== null && proyectoDeTarea.get(t.tareaId) === proyecto.id),
    )

    const hitos = ds.hitos
      .filter((h) => h.proyectoId === proyecto.id)
      .map((hito): HitoEstado => {
        const deHito = tareas.filter((t) => t.hitoId === hito.id)
        const abiertasHito = deHito.filter((t) => taskState(t) === 'abierta')
        const diasRestantes = hito.fechaObjetivo ? daysBetween(hoy, hito.fechaObjetivo) : null
        const semanas = diasRestantes === null || diasRestantes < 0 ? null : Math.ceil((diasRestantes + 1) / 7)
        const sinRiesgo = {
          hito,
          diasRestantes,
          tareas: deHito.length,
          tareasAbiertas: abiertasHito.length,
          horasPendientes: sumOrNull(abiertasHito.map((t) => t.horasEstimadas)),
          tareasSinEstimacion: abiertasHito.filter((t) => t.horasEstimadas === null).length,
          horasAlcanzables: horasAsignadas === null || semanas === null ? null : horasAsignadas * semanas,
        }
        return { ...sinRiesgo, riesgo: riesgoHito(sinRiesgo) }
      })
      .sort((a, b) =>
        RIESGO_ORDEN[a.riesgo] - RIESGO_ORDEN[b.riesgo]
        || (a.hito.fechaObjetivo ?? '9999').localeCompare(b.hito.fechaObjetivo ?? '9999')
        || a.hito.id.localeCompare(b.hito.id))

    const proximoHito = hitos
      .filter((h) => h.riesgo !== 'cerrado' && h.diasRestantes !== null && h.diasRestantes >= 0)
      .sort((a, b) => (a.diasRestantes ?? 0) - (b.diasRestantes ?? 0) || a.hito.id.localeCompare(b.hito.id))[0] ?? null
    const tareasVencidas = abiertas.filter((t) => t.fechaLimite !== null && t.fechaLimite < hoy)
    const tareasBloqueadas = tareas.filter(isBlocked)
    const tareasSinHito = abiertas.filter((t) => !t.hitoId).length
    const tareasSinEstimacion = abiertas.filter((t) => t.horasEstimadas === null).length
    const evidencias = ds.evidencias.filter((e) => e.proyectoId === proyecto.id && e.fecha !== null && e.fecha >= inicioActividad && e.fecha <= hoy)
    const ultima = ds.evidencias
      .filter((e) => e.proyectoId === proyecto.id && e.fecha !== null && e.fecha <= hoy)
      .reduce<string | null>((max, e) => (max === null || (e.fecha ?? '') > max ? e.fecha : max), null)

    const alertas: Alerta[] = []
    for (const h of hitos) {
      const nombre = `«${h.hito.nombre ?? h.hito.id}»`
      if (h.riesgo === 'vencido') alertas.push({ nivel: 'alta', texto: `La meta ${nombre} venció hace ${plural(-(h.diasRestantes ?? 0), 'día', 'días')} y no está COMPLETADO.` })
      if (h.riesgo === 'no-alcanza') alertas.push({ nivel: 'alta', texto: `La meta ${nombre} pide ${horas(h.horasPendientes ?? 0)} y al ritmo asignado solo caben ${horas(h.horasAlcanzables ?? 0)} antes de la fecha.` })
      if (h.riesgo === 'en-riesgo') alertas.push({ nivel: 'media', texto: `La meta ${nombre} vence en ${plural(h.diasRestantes ?? 0, 'día', 'días')} con ${plural(h.tareasAbiertas, 'tarea abierta', 'tareas abiertas')}.` })
      if (h.riesgo === 'sin-tareas') alertas.push({ nivel: 'media', texto: `La meta ${nombre} no tiene tareas ligadas (HITO_ID).` })
      if (h.riesgo === 'sin-fecha') alertas.push({ nivel: 'baja', texto: `La meta ${nombre} no tiene fecha objetivo.` })
    }
    if (hitos.every((h) => h.riesgo === 'cerrado') && abiertas.length > 0) {
      alertas.push({ nivel: 'media', texto: 'Hay trabajo abierto pero ninguna meta abierta.' })
    }
    if (tareasVencidas.length > 0) alertas.push({ nivel: 'alta', texto: `${plural(tareasVencidas.length, 'tarea abierta pasó', 'tareas abiertas pasaron')} su fecha límite.` })
    if (tareasBloqueadas.length > 0) alertas.push({ nivel: 'alta', texto: `${plural(tareasBloqueadas.length, 'tarea bloqueada', 'tareas bloqueadas')}.` })
    if (tareasSinEstimacion > 0) alertas.push({ nivel: 'baja', texto: `${plural(tareasSinEstimacion, 'tarea abierta sin', 'tareas abiertas sin')} HORAS_ESTIMADAS.` })
    if (tareasSinHito > 0) alertas.push({ nivel: 'baja', texto: `${plural(tareasSinHito, 'tarea abierta sin', 'tareas abiertas sin')} meta (HITO_ID).` })
    if (horasAsignadas !== null && horasAsignadas > 0 && minutosReales.minutos === null && hoy > base.desde) {
      alertas.push({ nivel: 'media', texto: `Esta semana tiene ${horas(horasAsignadas)} asignadas y ningún tiempo registrado.` })
    }
    if (horasAsignadas !== null && minutosReales.minutos !== null && minutosReales.minutos / 60 > horasAsignadas) {
      alertas.push({ nivel: 'media', texto: `Las horas reales (${horas(minutosReales.minutos / 60)}) ya superan las asignadas (${horas(horasAsignadas)}).` })
    }
    alertas.sort((a, b) => NIVEL_ORDEN[a.nivel] - NIVEL_ORDEN[b.nivel])

    return {
      proyecto,
      hitos,
      proximoHito,
      tareasAbiertas: abiertas.length,
      tareasBloqueadas,
      tareasVencidas,
      tareasSinHito,
      tareasSinEstimacion,
      horasAsignadas,
      minutosReales,
      actividad: { evidencias: evidencias.length, ultima },
      alertas,
    }
  })

  const alertasGenerales: Alerta[] = []
  if (semana.semanaId === null) {
    alertasGenerales.push({ nivel: 'alta', texto: `No hay fila en CAPACIDAD_SEMANAL para la semana del ${semana.desde}.` })
  } else {
    if (semana.horasDisponibles === null) alertasGenerales.push({ nivel: 'alta', texto: `La semana ${semana.semanaId} no tiene HORAS_DISPONIBLES.` })
    if (semana.estadoCapacidad !== 'APROBADA') alertasGenerales.push({ nivel: 'media', texto: `La capacidad de ${semana.semanaId} no está APROBADA.` })
    if (semana.horasAsignadas === null) alertasGenerales.push({ nivel: 'media', texto: `La semana ${semana.semanaId} no tiene ASIGNACIONES por proyecto.` })
    if (semana.horasNetas !== null && semana.horasAsignadas !== null && semana.horasAsignadas > semana.horasNetas + 1e-9) {
      alertasGenerales.push({ nivel: 'alta', texto: `Asignaste ${horas(semana.horasAsignadas)} y solo hay ${horas(semana.horasNetas)} netas.` })
    }
  }
  if (semana.sesionesSinProyecto > 0) {
    alertasGenerales.push({ nivel: 'baja', texto: `${plural(semana.sesionesSinProyecto, 'sesión', 'sesiones')} de TIEMPOS sin tarea válida: no cuentan para ningún proyecto.` })
  }

  return { hoy, semana, proyectos, alertasGenerales }
}
