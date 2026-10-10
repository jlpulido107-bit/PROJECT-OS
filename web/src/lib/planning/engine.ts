import { addCivilDays, civilDaysBetween, isCivilDate, isoMonday, isoWeekday, isoWeekId, weekDays } from './calendar'
import { analyzeDependencies } from './graph'
import { fingerprint } from './fingerprint'
import {
  BLOCKED_TASK_STATE, CLOSED_TASK_STATES, compareIds, FAIRNESS_FLOOR_MIN, hoursToMinutes, INACTIVE_PROJECT_STATES,
  MAX_BLOCK_MIN, MIN_BLOCK_MIN, normalizeProjectPriority, normalizeTaskPriority, PLAN_CANCELLED_STATES, PROJECT_WEIGHT,
} from './rules'
import type { DayPlan, Issue, PlanningInput, PlanResult, ProjectPlan, Reason, Scenario, TaskPlan } from './types'

/**
 * Motor de planificación V1.5: función PURA y determinista.
 * - Sin reloj, red, Sheets, OAuth ni variables de entorno: la fecha de referencia y la zona se inyectan.
 * - Misma entrada (en cualquier orden de filas) + mismo escenario + misma referencia ⇒ misma salida.
 * - No modifica la entrada. Produce PROPUESTAS; nunca escribe ni aplica nada.
 * Reglas y fórmulas: docs/v1-5-planning-contract.md.
 */

export interface PlanOptions {
  /** Fecha civil de referencia (hoy) en la zona indicada, `YYYY-MM-DD`. */
  referenceDate: string
  /** Zona de referencia (solo se informa; la conversión instante → fecha ocurre fuera del motor). */
  timeZone?: string
}

/** Pestañas sin las cuales no se puede garantizar una propuesta correcta. */
export const REQUIRED_TABS = ['PROYECTOS', 'TAREAS', 'DEPENDENCIAS', 'CAPACIDAD_SEMANAL', 'ASIGNACIONES', 'PLAN_DIARIO', 'PLAN_ITEMS', 'TIEMPOS'] as const

const NO_PROJECT = '∅'

const REASON_TEXT: Record<Reason, string> = {
  cerrada: 'Tarea cerrada.',
  'sin-estado': 'Sin ESTADO registrado: no se puede saber si sigue abierta.',
  bloqueada: 'Bloqueada (estado BLOQUEADO o BLOQUEO registrado).',
  'dependencia-pendiente': 'Tiene prerrequisitos sin COMPLETADO.',
  'dependencia-inexistente': 'Depende de una tarea que no existe en TAREAS.',
  'ciclo-dependencias': 'Forma parte de un ciclo de dependencias.',
  'id-duplicado': 'Su TAREA_ID está duplicado en la hoja: no se sabe qué fila es la válida.',
  'sin-proyecto': 'Sin PROYECTO_ID: no se puede repartir capacidad.',
  'proyecto-inexistente': 'Su proyecto no existe en PROYECTOS.',
  'proyecto-inactivo': 'Su proyecto no está activo.',
  'programada-despues': 'Su FECHA_PLAN es posterior a esta semana.',
  'sin-estimacion': 'Sin HORAS_ESTIMADAS válidas: requiere estimación manual.',
  'estimacion-agotada': 'El tiempo registrado ya cubre la estimación (supuesto de descuento activo): requiere re-estimar.',
  'ya-planificada': 'Toda su necesidad ya está en planes diarios registrados.',
}

export function reasonText(reason: Reason): string {
  return REASON_TEXT[reason]
}

const byId = <T extends { id: string }>(rows: readonly T[]): T[] => [...rows].sort((a, b) => compareIds(a.id, b.id))

function fmtMin(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  if (h === 0) return `${m} min`
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

export function planWeek(rawInput: PlanningInput, scenario: Scenario, options: PlanOptions): PlanResult {
  if (!isCivilDate(options.referenceDate)) throw new Error('referenceDate debe ser una fecha civil YYYY-MM-DD válida')
  const zone = options.timeZone ?? 'America/Merida'
  const ref = options.referenceDate

  // Copias ordenadas: el orden de las filas de la hoja nunca cambia el resultado.
  const input: PlanningInput = {
    proyectos: byId(rawInput.proyectos),
    hitos: byId(rawInput.hitos),
    tareas: byId(rawInput.tareas),
    dependencias: byId(rawInput.dependencias),
    capacidad: byId(rawInput.capacidad),
    asignaciones: byId(rawInput.asignaciones),
    planes: byId(rawInput.planes),
    planItems: byId(rawInput.planItems),
    tiempos: byId(rawInput.tiempos),
    pestanasNoDisponibles: [...rawInput.pestanasNoDisponibles].sort(),
    idsDuplicados: {
      TAREAS: [...rawInput.idsDuplicados.TAREAS].sort(compareIds),
      PROYECTOS: [...rawInput.idsDuplicados.PROYECTOS].sort(compareIds),
      DEPENDENCIAS: [...rawInput.idsDuplicados.DEPENDENCIAS].sort(compareIds),
    },
  }

  const conflictos: Issue[] = []
  const preguntas: Issue[] = []
  const supuestos: string[] = []

  /* ------------------------------- Semana y días ------------------------------- */
  const lunes = scenario.semana === 'siguiente' ? addCivilDays(isoMonday(ref), 7) : isoMonday(ref)
  const domingo = addCivilDays(lunes, 6)
  const desde = scenario.semana === 'siguiente' ? lunes : ref
  const days = weekDays(lunes)
  const working = new Set(scenario.diasLaborables)
  if (scenario.semana === 'siguiente') supuestos.push(`Escenario: se planifica la semana siguiente (${isoWeekId(lunes)}).`)

  const missingTabs = REQUIRED_TABS.filter((t) => input.pestanasNoDisponibles.includes(t))
  for (const tab of missingTabs) {
    preguntas.push({ codigo: 'pestana-no-disponible', mensaje: `La pestaña ${tab} no se pudo leer completa: revisa sus encabezados o su tamaño antes de planificar.`, refs: [tab] })
  }

  /* --------------------------------- Capacidad --------------------------------- */
  const weekRows = input.capacidad.filter((c) => c.fechaInicio !== null && c.fechaInicio >= lunes && c.fechaInicio <= domingo)
  let capOrigin: PlanResult['capacidad']['origen'] = 'faltante'
  let capRow: PlanningInput['capacidad'][number] | null = null
  let horas: number | null = null
  let reserva: number | null = null
  if (weekRows.length > 1) {
    capOrigin = 'ambigua'
    preguntas.push({
      codigo: 'capacidad-ambigua',
      mensaje: `Hay ${weekRows.length} filas de CAPACIDAD_SEMANAL para la semana ${isoWeekId(lunes)} (${lunes} a ${domingo}). ¿Cuál es la vigente? Deja una sola.`,
      refs: weekRows.map((r) => r.id),
    })
  } else if (weekRows.length === 1) {
    capRow = weekRows[0]!
    if (capRow.fechaInicio !== lunes) {
      conflictos.push({ codigo: 'semana-no-inicia-lunes', mensaje: `FECHA_INICIO ${capRow.fechaInicio} no es lunes; se asocia a la semana ISO que la contiene (${lunes}).`, refs: [capRow.id] })
    }
    if (capRow.horasDisponibles !== null) {
      capOrigin = 'dato'
      horas = capRow.horasDisponibles
    }
  }
  if (capOrigin === 'faltante') {
    if (scenario.horasSiFaltan !== null) {
      capOrigin = 'supuesto'
      horas = scenario.horasSiFaltan
      supuestos.push(`Escenario: capacidad no registrada; se suponen ${scenario.horasSiFaltan} h disponibles (no es un dato).`)
    } else {
      preguntas.push({
        codigo: 'capacidad-faltante',
        mensaje: capRow
          ? `¿Cuántas horas tienes disponibles la semana ${capRow.id} (${lunes} a ${domingo})? Registra HORAS_DISPONIBLES en CAPACIDAD_SEMANAL.`
          : `No hay fila en CAPACIDAD_SEMANAL con FECHA_INICIO entre ${lunes} y ${domingo}. ¿Cuántas horas tendrás esa semana?`,
        refs: capRow ? [capRow.id] : [],
      })
    }
  }
  if (horas !== null && scenario.ajusteHoras !== 0) {
    supuestos.push(`Escenario: ${scenario.ajusteHoras > 0 ? '+' : ''}${scenario.ajusteHoras} h sobre las horas disponibles.`)
    horas += scenario.ajusteHoras
    if (horas < 0) {
      conflictos.push({ codigo: 'horas-negativas', mensaje: 'El ajuste deja las horas disponibles por debajo de 0: se usa 0.', refs: [] })
      horas = 0
    }
  }
  if (horas !== null) {
    if (scenario.reservaPct !== null) {
      reserva = scenario.reservaPct / 100
      supuestos.push(`Escenario: reserva del ${scenario.reservaPct} %.`)
    } else if (capRow && capRow.reservaPct !== null) {
      reserva = capRow.reservaPct
    } else {
      reserva = 0
      supuestos.push('RESERVA_PCT vacía: se usa 0 % de reserva.')
    }
  }
  const netaMin = horas === null || reserva === null ? null : Math.max(0, Math.round(horas * 60 * (1 - reserva)))
  if (capRow && capRow.estado && capRow.estado !== 'APROBADA' && capOrigin === 'dato') {
    conflictos.push({ codigo: 'capacidad-no-aprobada', mensaje: `La capacidad de la semana está en estado ${capRow.estado}: la propuesta usa esas horas, pero no están aprobadas.`, refs: [capRow.id] })
  }

  /* ------------------------ Proyectos, tareas y tiempos ------------------------ */
  const projects = new Map(input.proyectos.map((p) => [p.id, p]))
  const tasks = new Map(input.tareas.map((t) => [t.id, t]))
  const projectOfTask = (taskId: string | null): string => {
    const t = taskId ? tasks.get(taskId) : undefined
    return t?.proyectoId ?? NO_PROJECT
  }
  const dupTasks = new Set(input.idsDuplicados.TAREAS)
  if (input.idsDuplicados.PROYECTOS.length) {
    conflictos.push({ codigo: 'proyecto-duplicado', mensaje: 'PROYECTO_ID duplicados: se usa la primera fila de cada uno.', refs: input.idsDuplicados.PROYECTOS })
  }
  if (input.idsDuplicados.DEPENDENCIAS.length) {
    conflictos.push({ codigo: 'dependencia-id-duplicado', mensaje: 'DEPENDENCIA_ID duplicados: se usa la primera fila de cada uno.', refs: input.idsDuplicados.DEPENDENCIAS })
  }

  const registeredByTask = new Map<string, number>()
  for (const t of input.tiempos) {
    if (!t.tareaId || t.minutosReales === null || !Number.isFinite(t.minutosReales) || t.minutosReales < 0) continue
    registeredByTask.set(t.tareaId, (registeredByTask.get(t.tareaId) ?? 0) + Math.round(t.minutosReales))
  }

  /* ------------------- Uso de la semana (sin doble descuento) ------------------- */
  // Por día y por proyecto: días pasados = tiempo real; desde la referencia = máx(plan registrado, real).
  const activePlans = input.planes.filter((p) => p.fecha !== null && p.fecha >= lunes && p.fecha <= domingo && !(p.estado && PLAN_CANCELLED_STATES.has(p.estado)))
  const planById = new Map(activePlans.map((p) => [p.id, p]))
  const plannedByDayProject = new Map<string, Map<string, number>>()
  const plannedFutureByTask = new Map<string, number>()
  const itemsWithoutMinutes: string[] = []
  const itemsUnknownTask: string[] = []
  for (const item of input.planItems) {
    const plan = item.planId ? planById.get(item.planId) : undefined
    if (!plan) continue
    if (item.minutosPlan === null || !Number.isFinite(item.minutosPlan) || item.minutosPlan < 0) {
      itemsWithoutMinutes.push(item.id)
      continue
    }
    const minutes = Math.round(item.minutosPlan)
    if (item.tareaId && !tasks.has(item.tareaId)) itemsUnknownTask.push(item.id)
    addNested(plannedByDayProject, plan.fecha!, projectOfTask(item.tareaId), minutes)
    if (item.tareaId && plan.fecha! >= desde) plannedFutureByTask.set(item.tareaId, (plannedFutureByTask.get(item.tareaId) ?? 0) + minutes)
  }
  if (itemsWithoutMinutes.length) conflictos.push({ codigo: 'plan-item-sin-minutos', mensaje: 'Elementos de plan sin MINUTOS_PLAN válidos: no reservan capacidad.', refs: itemsWithoutMinutes })
  if (itemsUnknownTask.length) conflictos.push({ codigo: 'plan-item-tarea-inexistente', mensaje: 'Elementos de plan con una tarea que no existe en TAREAS.', refs: itemsUnknownTask })
  const datesWithPlans = new Map<string, string[]>()
  for (const p of activePlans) datesWithPlans.set(p.fecha!, [...(datesWithPlans.get(p.fecha!) ?? []), p.id])
  for (const [fecha, ids] of datesWithPlans) {
    if (ids.length > 1) conflictos.push({ codigo: 'plan-diario-duplicado', mensaje: `Hay ${ids.length} planes diarios para ${fecha}: se respetan todos.`, refs: ids })
  }

  const realByDayProject = new Map<string, Map<string, number>>()
  for (const t of input.tiempos) {
    if (!t.fecha || t.fecha < lunes || t.fecha > domingo) continue
    if (t.minutosReales === null || !Number.isFinite(t.minutosReales) || t.minutosReales < 0) continue
    addNested(realByDayProject, t.fecha, projectOfTask(t.tareaId), Math.round(t.minutosReales))
  }

  const usedByDay = new Map<string, number>()
  const usedByProject = new Map<string, number>()
  for (const d of days) {
    const planned = plannedByDayProject.get(d) ?? new Map<string, number>()
    const real = realByDayProject.get(d) ?? new Map<string, number>()
    const buckets = new Set([...planned.keys(), ...real.keys()])
    let used = 0
    for (const b of [...buckets].sort()) {
      const u = d < desde ? (real.get(b) ?? 0) : Math.max(planned.get(b) ?? 0, real.get(b) ?? 0)
      used += u
      usedByProject.set(b, (usedByProject.get(b) ?? 0) + u)
    }
    usedByDay.set(d, used)
  }
  const usadoMin = days.reduce((acc, d) => acc + (usedByDay.get(d) ?? 0), 0)

  /* -------------------------- Capacidad por día restante -------------------------- */
  const planTargetByDay = new Map<string, number>()
  for (const p of activePlans) {
    const target = hoursToMinutes(p.horasObjetivo)
    if (target !== null && target > 0) planTargetByDay.set(p.fecha!, (planTargetByDay.get(p.fecha!) ?? 0) + target)
  }
  const pastUsed = days.filter((d) => d < desde).reduce((acc, d) => acc + (usedByDay.get(d) ?? 0), 0)
  const capacityByDay = new Map<string, number>()
  let weeklyFree = 0
  if (netaMin !== null) {
    if (pastUsed > netaMin) {
      conflictos.push({ codigo: 'semana-excedida', mensaje: `El tiempo ya registrado esta semana (${fmtMin(pastUsed)}) supera la capacidad neta (${fmtMin(netaMin)}).`, refs: [] })
    }
    const remainingNet = Math.max(0, netaMin - pastUsed)
    const remainingDays = days.filter((d) => d >= desde && (working.has(isoWeekday(d)) || planTargetByDay.has(d)))
    const fixedDays = remainingDays.filter((d) => planTargetByDay.has(d))
    const fixedTotal = fixedDays.reduce((acc, d) => acc + planTargetByDay.get(d)!, 0)
    if (fixedTotal > remainingNet) {
      conflictos.push({ codigo: 'planes-exceden-capacidad', mensaje: `Los HORAS_OBJETIVO de planes diarios registrados (${fmtMin(fixedTotal)}) superan la capacidad neta restante (${fmtMin(remainingNet)}).`, refs: fixedDays.flatMap((d) => datesWithPlans.get(d) ?? []) })
    }
    // Cuota diaria: la capacidad neta se reparte por igual entre los días laborables de la semana (el resto, minuto
    // a minuto, a los primeros días). La capacidad no usada de días pasados NO se traslada a los días restantes.
    const workingDays = days.filter((d) => working.has(isoWeekday(d)))
    const share = new Map(workingDays.map((d, i) => [d, Math.floor(netaMin / workingDays.length) + (i < netaMin % workingDays.length ? 1 : 0)]))
    for (const d of remainingDays) capacityByDay.set(d, planTargetByDay.get(d) ?? share.get(d) ?? 0)
    const futureUsed = days.filter((d) => d >= desde).reduce((acc, d) => acc + (usedByDay.get(d) ?? 0), 0)
    weeklyFree = Math.max(0, remainingNet - futureUsed)
    if (remainingNet - futureUsed < 0) {
      conflictos.push({ codigo: 'sobrecarga', mensaje: `Lo ya planificado o registrado desde ${desde} (${fmtMin(futureUsed)}) supera la capacidad restante (${fmtMin(remainingNet)}): no se propone nada nuevo.`, refs: [] })
    }
    if (netaMin === 0) conflictos.push({ codigo: 'capacidad-cero', mensaje: 'La capacidad neta de la semana es 0 (sin horas o reserva del 100 %).', refs: capRow ? [capRow.id] : [] })
    if (remainingDays.length === 0 && remainingNet > 0) {
      conflictos.push({ codigo: 'sin-dias-laborables', mensaje: 'No quedan días laborables en la semana desde la fecha de referencia.', refs: [] })
    }
  }
  const freeByDay = new Map<string, number>()
  for (const [d, cap] of capacityByDay) {
    const used = usedByDay.get(d) ?? 0
    if (used > cap) conflictos.push({ codigo: 'dia-sobreasignado', mensaje: `El ${d} ya tiene ${fmtMin(used)} planificados o registrados, por encima de su capacidad (${fmtMin(cap)}).`, refs: datesWithPlans.get(d) ?? [] })
    freeByDay.set(d, Math.max(0, cap - used))
  }

  /* --------------------------- Asignaciones existentes --------------------------- */
  const assignedByProject = new Map<string, number>()
  if (capRow) {
    const rows = input.asignaciones.filter((a) => a.semanaId === capRow!.id)
    const counts = new Map<string, string[]>()
    for (const a of rows) {
      if (!a.proyectoId) {
        conflictos.push({ codigo: 'asignacion-sin-proyecto', mensaje: 'Asignación sin PROYECTO_ID: se ignora.', refs: [a.id] })
        continue
      }
      counts.set(a.proyectoId, [...(counts.get(a.proyectoId) ?? []), a.id])
      if (!projects.has(a.proyectoId)) conflictos.push({ codigo: 'asignacion-proyecto-inexistente', mensaje: `Asignación para un proyecto que no existe (${a.proyectoId}).`, refs: [a.id] })
    }
    for (const [project, ids] of counts) {
      if (ids.length > 1) {
        preguntas.push({ codigo: 'asignacion-duplicada', mensaje: `El proyecto ${project} tiene ${ids.length} asignaciones esta semana: ¿cuál vale? Mientras tanto no se usa ninguna como límite.`, refs: ids })
        continue
      }
      const row = rows.find((a) => a.id === ids[0])!
      const minutes = hoursToMinutes(row.horasObjetivo)
      if (minutes === null) {
        conflictos.push({ codigo: 'asignacion-sin-horas', mensaje: `La asignación de ${project} no tiene HORAS_OBJETIVO válidas: no limita.`, refs: [row.id] })
        continue
      }
      assignedByProject.set(project, minutes)
    }
    const assignedTotal = [...assignedByProject.values()].reduce((a, b) => a + b, 0)
    if (netaMin !== null && assignedTotal > netaMin) {
      conflictos.push({ codigo: 'asignaciones-exceden-capacidad', mensaje: `Las ASIGNACIONES suman ${fmtMin(assignedTotal)}, más que la capacidad neta (${fmtMin(netaMin)}). No se sobreasigna: manda la capacidad libre.`, refs: rows.map((r) => r.id) })
    }
  }

  /* ---------------------------- Clasificación de tareas ---------------------------- */
  const deps = analyzeDependencies(input)
  conflictos.push(...deps.conflictos)
  for (const cycle of deps.ciclos) {
    preguntas.push({ codigo: 'ciclo-dependencias', mensaje: `Ciclo de dependencias entre ${cycle.join(', ')}: ¿cuál dependencia sobra? Ninguna de estas tareas se propone.`, refs: cycle })
  }

  const factor = (100 + scenario.sobrecargaPct) / 100
  if (scenario.sobrecargaPct > 0) supuestos.push(`Escenario: sobrecarga, estimaciones +${scenario.sobrecargaPct} %.`)
  if (scenario.horasSiSinEstimacion !== null) supuestos.push(`Escenario: las tareas sin estimación se planifican con ${scenario.horasSiSinEstimacion} h supuestas (no es un dato).`)
  if (scenario.descontarRegistrado) supuestos.push('Escenario: se descuenta el tiempo registrado de la estimación. No significa que la tarea haya avanzado lo mismo.')
  const simulatedPriorities = Object.keys(scenario.prioridadProyecto)
  if (simulatedPriorities.length) supuestos.push(`Escenario: prioridad simulada para ${simulatedPriorities.map((p) => `${p} = ${scenario.prioridadProyecto[p]}`).join(', ')}.`)

  const plans: TaskPlan[] = []
  let cerradasOmitidas = 0
  const noEstimate: string[] = []
  const noState: string[] = []
  const unknownPriority: string[] = []
  const missingPrereq: string[] = []
  const noProject: string[] = []
  const unknownProject: string[] = []
  const overEstimate: string[] = []
  const closedMilestone: string[] = []
  const cancelledPrereq: string[] = []
  const hitos = new Map(input.hitos.map((h) => [h.id, h]))

  for (const t of input.tareas) {
    if (t.estado && CLOSED_TASK_STATES.has(t.estado)) {
      cerradasOmitidas += 1
      continue
    }
    const motivos: Reason[] = []
    const explicacion: string[] = []
    const priority = normalizeTaskPriority(t.prioridad)
    if (priority.desconocida) unknownPriority.push(t.id)
    if (dupTasks.has(t.id)) motivos.push('id-duplicado')
    if (!t.estado) {
      motivos.push('sin-estado')
      noState.push(t.id)
    }
    if (t.estado === BLOCKED_TASK_STATE || t.bloqueo) {
      motivos.push('bloqueada')
      if (t.bloqueo) explicacion.push(`Bloqueo registrado: «${t.bloqueo}».`)
    }
    const project = t.proyectoId ? projects.get(t.proyectoId) : undefined
    if (!t.proyectoId) {
      motivos.push('sin-proyecto')
      noProject.push(t.id)
    } else if (!project) {
      motivos.push('proyecto-inexistente')
      unknownProject.push(t.id)
    } else if (project.estado && INACTIVE_PROJECT_STATES.has(project.estado)) {
      motivos.push('proyecto-inactivo')
      explicacion.push(`El proyecto ${project.id} está ${project.estado}.`)
    }
    const missing = deps.inexistentes.get(t.id)
    if (missing) {
      motivos.push('dependencia-inexistente')
      missingPrereq.push(t.id)
      explicacion.push(`Depende de ${missing.join(', ')}, que no existe en TAREAS.`)
    }
    if (deps.enCiclo.has(t.id)) motivos.push('ciclo-dependencias')
    const pending = deps.pendientes.get(t.id)
    if (pending) {
      motivos.push('dependencia-pendiente')
      if (pending.some((id) => tasks.get(id)?.estado === 'CANCELADO')) cancelledPrereq.push(t.id)
      explicacion.push(`Espera a ${pending.map((id) => `${id} (${tasks.get(id)?.estado ?? 'sin estado'})`).join(', ')}: se habilita cuando esté COMPLETADO en Sheets.`)
    }
    if (t.fechaPlan && t.fechaPlan > domingo) {
      motivos.push('programada-despues')
      explicacion.push(`FECHA_PLAN ${t.fechaPlan}, después del ${domingo}.`)
    }
    if (t.hitoId) {
      const hito = hitos.get(t.hitoId)
      if (hito?.estado && CLOSED_TASK_STATES.has(hito.estado)) closedMilestone.push(t.id)
    }

    // Estimación (minutos). Nunca se inventa: un supuesto solo existe si el escenario lo pide.
    let estimacionMin = hoursToMinutes(t.horasEstimadas)
    let estimacionSupuesta = false
    if (estimacionMin === null && scenario.horasSiSinEstimacion !== null) {
      estimacionMin = hoursToMinutes(scenario.horasSiSinEstimacion)
      estimacionSupuesta = true
    }
    if (estimacionMin !== null && factor !== 1) estimacionMin = Math.round(estimacionMin * factor)
    const registradoMin = registeredByTask.get(t.id) ?? 0
    const yaPlanificadoMin = plannedFutureByTask.get(t.id) ?? 0
    let necesidadMin = 0
    if (estimacionMin === null) {
      motivos.push('sin-estimacion')
      noEstimate.push(t.id)
    } else {
      let remaining = estimacionMin
      if (scenario.descontarRegistrado) {
        remaining = Math.max(0, estimacionMin - registradoMin)
        if (remaining === 0) {
          motivos.push('estimacion-agotada')
          overEstimate.push(t.id)
        }
      } else if (registradoMin >= estimacionMin && registradoMin > 0) {
        overEstimate.push(t.id)
        explicacion.push(`El tiempo registrado (${fmtMin(registradoMin)}) ya iguala o supera la estimación (${fmtMin(estimacionMin)}): conviene re-estimar.`)
      }
      necesidadMin = Math.max(0, remaining - yaPlanificadoMin)
      if (remaining > 0 && necesidadMin === 0 && yaPlanificadoMin > 0) motivos.push('ya-planificada')
    }

    const vencida = t.fechaLimite !== null && t.fechaLimite < ref
    const venceEnSemana = t.fechaLimite !== null && !vencida && t.fechaLimite <= domingo
    const excluded = motivos.length > 0
    plans.push({
      id: t.id,
      proyectoId: t.proyectoId,
      titulo: t.titulo,
      estado: t.estado,
      prioridad: priority.categoria,
      prioridadDesconocida: priority.desconocida,
      fechaLimite: t.fechaLimite,
      vencida,
      venceEnSemana,
      categoria: excluded ? 'excluida' : 'sin-capacidad',
      motivos,
      estimacionMin,
      estimacionSupuesta,
      registradoMin,
      yaPlanificadoMin,
      necesidadMin: excluded ? 0 : necesidadMin,
      propuestoMin: 0,
      rango: null,
      desbloquea: deps.desbloquea.get(t.id) ?? 0,
      explicacion,
    })
  }

  const ask = (codigo: string, ids: string[], mensaje: string) => {
    if (ids.length) preguntas.push({ codigo, mensaje, refs: ids })
  }
  ask('sin-estimacion', noEstimate, `¿Cuántas horas estimas para ${noEstimate.length === 1 ? 'esta tarea' : `estas ${noEstimate.length} tareas`}? Registra HORAS_ESTIMADAS; mientras tanto no se planifican.`)
  ask('sin-estado', noState, 'Estas tareas no tienen ESTADO: ¿siguen abiertas? Registra su estado.')
  ask('dependencia-inexistente', missingPrereq, 'Estas tareas dependen de tareas que no existen: ¿se renombró el prerrequisito o la dependencia debe marcarse INACTIVA?')
  ask('sin-proyecto', noProject, 'Estas tareas no tienen PROYECTO_ID: ¿a qué proyecto pertenecen?')
  ask('proyecto-inexistente', unknownProject, 'Estas tareas apuntan a un proyecto que no está en PROYECTOS: ¿falta registrarlo?')
  ask('prerrequisito-cancelado', cancelledPrereq, 'Estas tareas dependen de una tarea CANCELADA: ¿la dependencia debe marcarse INACTIVA o hay un nuevo prerrequisito?')
  ask('estimacion-excedida', overEstimate, 'El tiempo registrado ya iguala o supera la estimación de estas tareas: ¿cuánto falta realmente?')
  if (unknownPriority.length) {
    conflictos.push({ codigo: 'prioridad-desconocida', mensaje: 'Prioridad vacía o fuera de CRITICA/ALTA/MEDIA/BAJA: se ordenan después de BAJA.', refs: unknownPriority })
  }
  if (closedMilestone.length) {
    conflictos.push({ codigo: 'hito-cerrado', mensaje: 'Tareas abiertas en hitos ya cerrados: revisa si siguen vigentes.', refs: closedMilestone })
  }

  /* ----------------------------------- Orden ----------------------------------- */
  const priorityRank = new Map(input.tareas.map((t) => [t.id, normalizeTaskPriority(t.prioridad).rango]))
  const eligible = plans
    .filter((p) => p.categoria !== 'excluida' && p.necesidadMin > 0)
    .sort((a, b) =>
      Number(!a.vencida) - Number(!b.vencida) ||
      Number(!a.venceEnSemana) - Number(!b.venceEnSemana) ||
      priorityRank.get(a.id)! - priorityRank.get(b.id)! ||
      b.desbloquea - a.desbloquea ||
      Number(a.estado !== 'EN_PROGRESO') - Number(b.estado !== 'EN_PROGRESO') ||
      (a.fechaLimite ?? '9999-12-31').localeCompare(b.fechaLimite ?? '9999-12-31') ||
      compareIds(a.id, b.id))
  eligible.forEach((p, i) => {
    p.rango = i + 1
  })
  for (const p of plans) {
    if (p.categoria !== 'excluida' && p.necesidadMin === 0 && p.motivos.length === 0) {
      // Necesidad cero sin motivo de exclusión (p. ej. estimación 0 h): no hay nada que proponer.
      p.categoria = 'excluida'
      p.explicacion.push('Su necesidad para esta semana es 0 min.')
    }
  }

  const insufficient = missingTabs.length > 0 || capOrigin === 'faltante' || capOrigin === 'ambigua'

  /* --------------------------- Reparto entre proyectos --------------------------- */
  const projectIds = [...new Set(eligible.map((p) => p.proyectoId!))].sort(compareIds)
  const priorityOf = (id: string) => {
    const simulated = scenario.prioridadProyecto[id]
    return { categoria: simulated ?? normalizeProjectPriority(projects.get(id)?.prioridad ?? null), simulada: simulated !== undefined }
  }
  const weight = (id: string) => PROJECT_WEIGHT[priorityOf(id).categoria]
  const demand = new Map(projectIds.map((id) => [id, eligible.filter((p) => p.proyectoId === id).reduce((acc, p) => acc + p.necesidadMin, 0)]))
  const capOf = (id: string) => (assignedByProject.has(id) ? Math.max(0, assignedByProject.get(id)! - (usedByProject.get(id) ?? 0)) : Infinity)
  const budget = new Map(projectIds.map((id) => [id, 0]))
  const unmet = (id: string) => Math.max(0, Math.min(demand.get(id)!, capOf(id)) - budget.get(id)!)
  let R = insufficient ? 0 : weeklyFree
  const give = (id: string, amount: number) => {
    const take = Math.max(0, Math.min(amount, unmet(id), R))
    budget.set(id, budget.get(id)! + take)
    R -= take
    return take
  }
  // 1) Urgencia: vencidas y con límite esta semana, en orden global (cada una suma su necesidad a su proyecto).
  for (const p of eligible) if (p.vencida || p.venceEnSemana) give(p.proyectoId!, p.necesidadMin)
  // 2) Piso anti-inanición: cada proyecto con demanda recibe hasta FAIRNESS_FLOOR_MIN, por peso y luego ID.
  const byWeight = [...projectIds].sort((a, b) => weight(b) - weight(a) || compareIds(a, b))
  for (const id of byWeight) give(id, FAIRNESS_FLOOR_MIN - budget.get(id)!)
  // 3) Reparto proporcional al peso (water-filling entero, determinista).
  for (let guard = 0; R > 0 && guard < 1000; guard++) {
    const active = byWeight.filter((id) => unmet(id) > 0)
    if (active.length === 0) break
    const totalW = active.reduce((acc, id) => acc + weight(id), 0)
    const pool = R
    let given = 0
    for (const id of active) given += give(id, Math.floor((pool * weight(id)) / totalW))
    if (given === 0) give(active[0]!, R)
  }

  // Dentro de cada proyecto, por orden global: objetivo semanal de cada tarea.
  const weeklyTarget = new Map<string, number>()
  const budgetLeft = new Map(budget)
  for (const p of eligible) {
    const left = budgetLeft.get(p.proyectoId!)!
    const take = Math.min(left, p.necesidadMin)
    weeklyTarget.set(p.id, take)
    budgetLeft.set(p.proyectoId!, left - take)
  }

  /* ------------------------------ Secuencia diaria ------------------------------ */
  const remainingTarget = new Map(weeklyTarget)
  const dayItems = new Map<string, DayPlan['items']>(days.map((d) => [d, []]))
  const scheduledByTask = new Map<string, number>()
  const daysByTask = new Map<string, string[]>()
  let globalLeft = insufficient ? 0 : weeklyFree
  const schedulingDays = days.filter((d) => (freeByDay.get(d) ?? 0) > 0)
  for (const d of schedulingDays) {
    let c = Math.min(freeByDay.get(d)!, globalLeft)
    const items = dayItems.get(d)!
    const startable = (p: TaskPlan) => {
      const task = tasks.get(p.id)!
      return (remainingTarget.get(p.id) ?? 0) > 0 && (!task.fechaPlan || task.fechaPlan <= d)
    }
    const place = (p: TaskPlan, max: number, motivo: string) => {
      const rem = remainingTarget.get(p.id)!
      const chunk = Math.min(rem, max, c)
      // Sin fragmentos < MIN_BLOCK_MIN (salvo el resto de la tarea) cuando el día ya tiene algo; un día cuya
      // capacidad total es menor que un bloque sí se usa.
      if (chunk <= 0 || (chunk < MIN_BLOCK_MIN && chunk < rem && items.length > 0)) return
      const existing = items.find((i) => i.tareaId === p.id)
      if (existing) existing.minutos += chunk
      else {
        items.push({ tareaId: p.id, proyectoId: p.proyectoId, minutos: chunk, orden: items.length + 1, motivo })
        daysByTask.set(p.id, [...(daysByTask.get(p.id) ?? []), d])
      }
      c -= chunk
      globalLeft -= chunk
      remainingTarget.set(p.id, rem - chunk)
      scheduledByTask.set(p.id, (scheduledByTask.get(p.id) ?? 0) + chunk)
    }
    // Pasada 1: como máximo MAX_BLOCK_MIN por tarea y día (variedad, evita acaparar la jornada).
    for (const p of eligible) if (c > 0 && startable(p)) place(p, MAX_BLOCK_MIN, shortMotive(p))
    // Pasada 2: el hueco restante se reparte POR TURNOS de MIN_BLOCK_MIN entre las tareas con trabajo pendiente,
    // en el orden global. Una tarea solo supera MAX_BLOCK_MIN por delante de otra cuando esa otra ya no puede
    // recibir más (sin objetivo pendiente o sin hueco), nunca acaparando el día mientras haya alternativas.
    for (let guard = 0; c > 0 && guard < 10_000; guard++) {
      const before = c
      for (const p of eligible) if (c > 0 && startable(p)) place(p, MIN_BLOCK_MIN, shortMotive(p))
      if (c === before) break
    }
  }

  /* --------------------------- Resultado por tarea --------------------------- */
  for (const p of plans) {
    if (p.categoria === 'excluida') {
      p.explicacion.unshift(...p.motivos.map(reasonText))
      continue
    }
    const scheduled = scheduledByTask.get(p.id) ?? 0
    p.propuestoMin = scheduled
    p.categoria = scheduled === 0 ? 'sin-capacidad' : scheduled >= p.necesidadMin ? 'propuesta' : 'parcial'
    const why: string[] = []
    if (p.vencida) why.push(`Vencida desde ${p.fechaLimite} (${civilDaysBetween(p.fechaLimite!, ref)} días).`)
    else if (p.venceEnSemana) why.push(`Vence el ${p.fechaLimite}, dentro de esta semana.`)
    why.push(`Prioridad ${p.prioridad}${p.prioridadDesconocida ? ' (no documentada: va después de BAJA)' : ''}.`)
    if (p.desbloquea > 0) why.push(`Desbloquea ${p.desbloquea} tarea${p.desbloquea === 1 ? '' : 's'}.`)
    if (p.estado === 'EN_PROGRESO') why.push('Ya está en curso.')
    const parts = [`estimación ${fmtMin(p.estimacionMin!)}${p.estimacionSupuesta ? ' (SUPUESTA, escenario)' : ''}`]
    if (scenario.descontarRegistrado && p.registradoMin > 0) parts.push(`− registrado ${fmtMin(p.registradoMin)}`)
    if (p.yaPlanificadoMin > 0) parts.push(`− ya planificado ${fmtMin(p.yaPlanificadoMin)}`)
    why.push(`Necesita ${fmtMin(p.necesidadMin)} esta semana (${parts.join(' ')}).`)
    if (!scenario.descontarRegistrado && p.registradoMin > 0) why.push(`Tiempo registrado: ${fmtMin(p.registradoMin)} (no se descuenta: no equivale a avance).`)
    if (scheduled > 0) why.push(`Propuesto: ${fmtMin(scheduled)} (${(daysByTask.get(p.id) ?? []).join(', ')}).`)
    if (scheduled < p.necesidadMin) {
      const target = weeklyTarget.get(p.id) ?? 0
      if (insufficient) why.push('No se propone tiempo: faltan datos de capacidad (ver preguntas).')
      else if (target < p.necesidadMin) {
        why.push(assignedByProject.has(p.proyectoId!) && budget.get(p.proyectoId!)! >= capOf(p.proyectoId!)
          ? `Faltan ${fmtMin(p.necesidadMin - scheduled)}: se agotó la asignación de horas de ${p.proyectoId} (ASIGNACIONES).`
          : `Faltan ${fmtMin(p.necesidadMin - scheduled)}: no queda capacidad libre para ${p.proyectoId} tras repartir por urgencia, piso y peso.`)
      } else why.push(`Faltan ${fmtMin(p.necesidadMin - scheduled)}: no hubo hueco diario (FECHA_PLAN o días llenos).`)
    }
    p.explicacion.unshift(...why)
    if (p.fechaLimite && p.fechaLimite >= desde && p.fechaLimite <= domingo) {
      const late = (daysByTask.get(p.id) ?? []).some((d) => d > p.fechaLimite!)
      if (late || scheduled < p.necesidadMin) {
        conflictos.push({ codigo: 'no-cabe-antes-del-limite', mensaje: `${p.id} no queda completa en la propuesta antes de su límite (${p.fechaLimite}).`, refs: [p.id] })
      }
    }
  }
  const overdue = plans.filter((p) => p.vencida).map((p) => p.id)
  if (overdue.length) conflictos.push({ codigo: 'tareas-vencidas', mensaje: 'Tareas abiertas con FECHA_LIMITE pasada: se priorizan, pero conviene renegociar la fecha.', refs: overdue })

  /* --------------------------------- Proyectos --------------------------------- */
  const allProjectIds = [...new Set([...input.proyectos.map((p) => p.id), ...projectIds])].sort(compareIds)
  const proyectos: ProjectPlan[] = allProjectIds.map((id) => {
    const pr = priorityOf(id)
    const propuesto = plans.filter((p) => p.proyectoId === id).reduce((acc, p) => acc + p.propuestoMin, 0)
    return {
      id,
      nombre: projects.get(id)?.nombre ?? null,
      prioridad: pr.categoria,
      prioridadSimulada: pr.simulada,
      peso: PROJECT_WEIGHT[pr.categoria],
      asignadoMin: assignedByProject.get(id) ?? null,
      usadoMin: usedByProject.get(id) ?? 0,
      demandaMin: demand.get(id) ?? 0,
      presupuestoMin: budget.get(id) ?? 0,
      propuestoMin: propuesto,
      tareasPropuestas: plans.filter((p) => p.proyectoId === id && p.propuestoMin > 0).length,
    }
  })

  /* ----------------------------------- Días ----------------------------------- */
  const dias: DayPlan[] = days.map((d) => {
    const items = dayItems.get(d)!
    const planned = [...(plannedByDayProject.get(d)?.values() ?? [])].reduce((a, b) => a + b, 0)
    const real = [...(realByDayProject.get(d)?.values() ?? [])].reduce((a, b) => a + b, 0)
    return {
      fecha: d,
      laborable: working.has(isoWeekday(d)),
      esPasado: d < desde,
      capacidadMin: capacityByDay.has(d) ? capacityByDay.get(d)! : null,
      planExistenteMin: planned,
      realMin: real,
      usadoMin: usedByDay.get(d) ?? 0,
      libreMin: freeByDay.get(d) ?? 0,
      propuestoMin: items.reduce((acc, i) => acc + i.minutos, 0),
      planRegistrado: (datesWithPlans.get(d) ?? [])[0] ?? null,
      items,
    }
  })
  const propuestoMin = dias.reduce((acc, d) => acc + d.propuestoMin, 0)
  // Hueco realmente colocable: suma de huecos diarios restantes, acotada por el saldo semanal.
  const colocableMin = insufficient ? 0 : Math.min(weeklyFree, days.filter((d) => d >= desde).reduce((acc, d) => acc + (freeByDay.get(d) ?? 0), 0))

  const tareas = [...plans].sort((a, b) => (a.rango ?? Infinity) - (b.rango ?? Infinity) || compareIds(a.id, b.id))
  const result: Omit<PlanResult, 'huella'> = {
    version: 'planificacion-v1.5',
    estado: insufficient ? 'datos-insuficientes' : 'propuesta',
    referencia: { fecha: ref, zona: zone, semanaIso: isoWeekId(lunes), lunes, domingo, desde },
    capacidad: {
      origen: capOrigin,
      semanaId: capRow?.id ?? null,
      estadoSemana: capRow?.estado ?? null,
      horasDisponibles: horas,
      reservaPct: reserva === null ? null : Math.round(reserva * 1000) / 10,
      netaMin,
      usadoMin,
      libreMin: insufficient ? 0 : weeklyFree,
      colocableMin,
      propuestoMin,
    },
    proyectos,
    tareas,
    dias,
    resumen: {
      elegibles: tareas.filter((p) => p.categoria !== 'excluida').length,
      propuestas: tareas.filter((p) => p.categoria === 'propuesta').length,
      parciales: tareas.filter((p) => p.categoria === 'parcial').length,
      sinCapacidad: tareas.filter((p) => p.categoria === 'sin-capacidad').length,
      excluidas: tareas.filter((p) => p.categoria === 'excluida').length,
      cerradasOmitidas,
    },
    conflictos,
    preguntas,
    supuestos,
  }
  return { ...result, huella: fingerprint({ input, scenario, ref, zone }) }
}

function shortMotive(p: TaskPlan): string {
  if (p.vencida) return 'Vencida'
  if (p.venceEnSemana) return `Vence ${p.fechaLimite}`
  if (p.desbloquea > 0) return `Desbloquea ${p.desbloquea}`
  return `Prioridad ${p.prioridad}`
}

function addNested(map: Map<string, Map<string, number>>, a: string, b: string, value: number) {
  let inner = map.get(a)
  if (!inner) {
    inner = new Map()
    map.set(a, inner)
  }
  inner.set(b, (inner.get(b) ?? 0) + value)
}
