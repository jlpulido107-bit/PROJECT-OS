import {
  ALL_TABS, BLOCKED_TASK, CANCELLED_PLAN, CATEGORIES, CATEGORY_TABS, CLOSED_MILESTONE, CLOSED_PLAN, CLOSED_TASK, compareIds, compareText,
  ESSENTIAL_TABS, INACTIVE_DEPENDENCY, INACTIVE_PROJECT, PENDING_DECISION, PLANNER_HIGH, RESOLVED_DECISION, SEVERITIES, THRESHOLDS, TYPES,
} from './rules'
import type { Alert, AlertType, Category, Entity, GlobalState, GovernanceInput, GovernanceReport, Severity, TabName } from './types'
import { addDays, canonicalJson, daysBetween, findCycles, fnv1a, isCivilDate, isoMonday } from './util'

/**
 * Motor del centro de control V1.6: función PURA y determinista.
 * - Sin red, Sheets, OAuth, reloj global, azar ni IA: la fecha de referencia y los datos se inyectan.
 * - Misma entrada (en cualquier orden de filas) + misma referencia ⇒ mismo informe.
 * - No modifica la entrada ni ejecuta nada: produce alertas con hechos, inferencias, hipótesis y acciones SUGERIDAS.
 * Reglas: docs/v1-6-governance-contract.md.
 */
export interface GovernanceOptions {
  referenceDate: string
  timeZone?: string
}

type Draft = Omit<Alert, 'id'>

const SEVERITY_RANK: Record<Severity, number> = { critica: 0, alta: 1, media: 2, baja: 3, info: 4 }
const TYPE_RANK: Record<AlertType, number> = { incumplimiento: 0, discrepancia: 1, bloqueo: 2, pendiente: 3, riesgo: 4, revision: 5, diagnostico: 6 }
const ENTITY_ORDER = ['proyecto', 'hito', 'tarea', 'dependencia', 'decision', 'evidencia', 'sesion', 'plan', 'plan-item', 'semana', 'pestana']
const SAFE_REF = /^[A-Za-z0-9_.-]{1,40}$/

const byId = <T extends { id: string }>(rows: readonly T[]): T[] => [...rows].sort((a, b) => compareIds(a.id, b.id))
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function buildGovernanceReport(raw: GovernanceInput, options: GovernanceOptions): GovernanceReport {
  if (!isCivilDate(options.referenceDate)) throw new Error('referenceDate debe ser una fecha civil YYYY-MM-DD válida')
  const ref = options.referenceDate
  const zone = options.timeZone ?? 'America/Merida'

  const input: GovernanceInput = {
    proyectos: byId(raw.proyectos), hitos: byId(raw.hitos), tareas: byId(raw.tareas), dependencias: byId(raw.dependencias),
    evidencias: byId(raw.evidencias), decisiones: byId(raw.decisiones), tiempos: byId(raw.tiempos), planes: byId(raw.planes),
    planItems: byId(raw.planItems), capacidad: byId(raw.capacidad), asignaciones: byId(raw.asignaciones),
    pestanas: Object.fromEntries(ALL_TABS.filter((t) => raw.pestanas[t]).map((t) => [t, { ...raw.pestanas[t]!, duplicateIds: [...raw.pestanas[t]!.duplicateIds].sort(compareIds) }])),
    ...(raw.planificacion ? { planificacion: { semanaIso: raw.planificacion.semanaIso, conflictos: [...raw.planificacion.conflictos].sort((a, b) => compareText(a.codigo, b.codigo) || compareText(a.refs.join(','), b.refs.join(','))) } } : {}),
  }
  const available = (tab: TabName) => {
    const s = input.pestanas[tab]
    return !!s && s.ok && !s.truncated
  }

  const alerts = new Map<string, Alert>()
  const add = (draft: Draft) => {
    const entidades = dedupeEntities(draft.entidades)
    const key = `${draft.regla}|${entidades.map((e) => `${e.tipo}:${e.id}`).join(',')}`
    const id = `${draft.regla}-${fnv1a(key)}`
    if (!alerts.has(id)) alerts.set(id, { ...draft, entidades, id })
  }

  const projects = new Map(input.proyectos.map((p) => [p.id, p]))
  const tasks = new Map(input.tareas.map((t) => [t.id, t]))
  const hitos = new Map(input.hitos.map((h) => [h.id, h]))
  const isOpen = (estado: string | null) => estado !== null && !CLOSED_TASK.has(estado)
  const isBlocked = (t: GovernanceInput['tareas'][number]) => isOpen(t.estado) && (t.estado === BLOCKED_TASK || t.tieneBloqueo)
  const projectInactive = (id: string | null) => {
    const p = id ? projects.get(id) : undefined
    return !!p?.estado && INACTIVE_PROJECT.has(p.estado)
  }
  const soon = addDays(ref, THRESHOLDS.ventanaRiesgoDias)
  const deadlineFacts = (fecha: string | null): { inferencias: string[]; dias: number | null } => {
    if (!fecha) return { inferencias: [], dias: null }
    const d = daysBetween(fecha, ref)
    if (d > 0) return { inferencias: [`FECHA_LIMITE ${fecha} < ${ref} ⇒ vencida hace ${plural(d, 'día', 'días')}.`], dias: d }
    return { inferencias: [`FECHA_LIMITE ${fecha}: faltan ${plural(-d, 'día', 'días')}.`], dias: null }
  }

  /* ------------------------------------ Datos ------------------------------------ */
  for (const tab of ALL_TABS) {
    const s = input.pestanas[tab]
    if (!s || !s.ok || s.truncated) {
      add({
        regla: 'pestana-no-disponible', categoria: 'datos', tipo: 'diagnostico',
        severidad: ESSENTIAL_TABS.includes(tab) ? 'critica' : 'alta', confianza: 'alta', proyectoId: null,
        entidades: [{ tipo: 'pestana', id: tab }],
        hechos: [!s ? `La pestaña ${tab} no se pudo leer.` : s.truncated ? `La pestaña ${tab} superó el límite de filas: se leyó truncada.` : `La pestaña ${tab} no tiene los encabezados esperados.`],
        inferencias: ['Las reglas que dependen de esta pestaña no pueden afirmar ausencia de alertas.'],
        hipotesis: [], acciones: [`Revisar la pestaña ${tab} en Google Sheets (encabezados y tamaño).`],
        diasVencido: null, fechaClave: null,
      })
    }
    if (s && s.duplicateIds.length) {
      add({
        regla: 'ids-duplicados', categoria: 'datos', tipo: 'discrepancia', severidad: 'media', confianza: 'alta', proyectoId: null,
        entidades: [{ tipo: 'pestana', id: tab }],
        hechos: [`${tab} tiene IDs repetidos: ${s.duplicateIds.slice(0, 20).join(', ')}${s.duplicateIds.length > 20 ? ` y ${s.duplicateIds.length - 20} más` : ''}.`],
        inferencias: ['Solo se usa la primera fila de cada ID; las demás se ignoran.'],
        hipotesis: [], acciones: ['Corregir los IDs duplicados en Google Sheets (IDs estables y únicos).'],
        diasVencido: null, fechaClave: null,
      })
    }
    if (s && s.invalidCells > 0) {
      add({
        regla: 'celdas-invalidas', categoria: 'datos', tipo: 'diagnostico', severidad: 'baja', confianza: 'alta', proyectoId: null,
        entidades: [{ tipo: 'pestana', id: tab }],
        hechos: [`${tab}: ${plural(s.invalidCells, 'celda con formato inválido', 'celdas con formato inválido')}.`],
        inferencias: ['Esas celdas se tratan como vacías.'], hipotesis: [],
        acciones: ['Revisar el detalle en la sección de diagnóstico del panel.'], diasVencido: null, fechaClave: null,
      })
    }
  }

  /* ---------------------------------- Decisiones ---------------------------------- */
  for (const d of input.decisiones) {
    const base = { proyectoId: d.proyectoId, diasVencido: null, fechaClave: d.fecha }
    const ent: Entity[] = [{ tipo: 'decision', id: d.id }, ...(d.proyectoId ? [{ tipo: 'proyecto' as const, id: d.proyectoId }] : [])]
    if (!d.estado) {
      add({ ...base, regla: 'decision-sin-estado', categoria: 'decisiones', tipo: 'diagnostico', severidad: 'baja', confianza: 'alta', entidades: ent,
        hechos: ['DECISIONES.ESTADO vacío.'], inferencias: ['No se puede saber si está pendiente o resuelta.'], hipotesis: [],
        acciones: ['Registrar el ESTADO de la decisión en Sheets.'] })
    } else if (PENDING_DECISION.has(d.estado)) {
      const age = d.fecha ? daysBetween(d.fecha, ref) : null
      const old = age !== null && age >= THRESHOLDS.decisionAntiguaDias
      add({ ...base, regla: 'decision-pendiente', categoria: 'decisiones', tipo: 'pendiente', severidad: old ? 'alta' : 'media', confianza: 'alta', entidades: ent,
        hechos: [`DECISIONES.ESTADO = ${d.estado}.`, d.fecha ? `DECISIONES.FECHA = ${d.fecha}.` : 'DECISIONES.FECHA vacía.'],
        inferencias: age === null ? ['Antigüedad desconocida (sin fecha).'] : age < 0 ? [`FECHA futura (${d.fecha}).`] : [`Pendiente desde hace ${plural(age, 'día', 'días')}${old ? ` (≥ ${THRESHOLDS.decisionAntiguaDias})` : ''}.`],
        hipotesis: old ? ['Puede estar frenando trabajo del proyecto.'] : [],
        acciones: ['Resolver la decisión y registrar el nuevo ESTADO en Sheets. Registrarla no autoriza merges, despliegues, escrituras ni gasto.'] })
      if (available('PROYECTOS') && projectInactive(d.proyectoId)) {
        add({ ...base, regla: 'decision-proyecto-inactivo', categoria: 'discrepancias', tipo: 'discrepancia', severidad: 'alta', confianza: 'alta', entidades: ent,
          hechos: [`DECISIONES.ESTADO = ${d.estado}.`, `PROYECTOS.ESTADO de ${d.proyectoId} = ${projects.get(d.proyectoId!)!.estado}.`],
          inferencias: ['Decisión pendiente en un proyecto inactivo.'], hipotesis: [],
          acciones: ['Descartar la decisión o reactivar el proyecto, registrándolo en Sheets.'] })
      }
    } else if (!RESOLVED_DECISION.has(d.estado)) {
      add({ ...base, regla: 'decision-estado-desconocido', categoria: 'decisiones', tipo: 'revision', severidad: 'baja', confianza: 'media', entidades: ent,
        hechos: [`DECISIONES.ESTADO = ${d.estado}.`], inferencias: ['Estado fuera de las listas documentadas: no se asume pendiente ni resuelta.'], hipotesis: [],
        acciones: ['Usar un estado documentado o proponer añadirlo al contrato.'] })
    }
    if (available('PROYECTOS') && (!d.proyectoId || !projects.has(d.proyectoId))) {
      add({ ...base, regla: 'decision-proyecto-inexistente', categoria: 'discrepancias', tipo: 'discrepancia', severidad: 'media', confianza: 'alta', entidades: ent,
        hechos: [d.proyectoId ? `DECISIONES.PROYECTO_ID = ${d.proyectoId}, que no está en PROYECTOS.` : 'DECISIONES.PROYECTO_ID vacío.'],
        inferencias: [], hipotesis: [], acciones: ['Corregir el PROYECTO_ID de la decisión en Sheets.'] })
    }
  }

  /* ------------------------------------ Tareas ------------------------------------ */
  const evidenceByTask = new Map<string, Array<GovernanceInput['evidencias'][number]>>()
  for (const e of input.evidencias) if (e.tareaId) evidenceByTask.set(e.tareaId, [...(evidenceByTask.get(e.tareaId) ?? []), e])
  for (const t of input.tareas) {
    const tEnt: Entity[] = [{ tipo: 'tarea', id: t.id }]
    const base = { proyectoId: t.proyectoId, fechaClave: t.fechaLimite }
    if (!t.estado) {
      add({ ...base, regla: 'tarea-sin-estado', categoria: 'discrepancias', tipo: 'diagnostico', severidad: 'baja', confianza: 'alta', entidades: tEnt, diasVencido: null,
        hechos: ['TAREAS.ESTADO vacío.'], inferencias: ['No se puede saber si la tarea sigue abierta.'], hipotesis: [], acciones: ['Registrar el ESTADO en Sheets.'] })
    }
    const deadline = deadlineFacts(t.fechaLimite)
    if (isBlocked(t)) {
      const urgent = t.fechaLimite !== null && t.fechaLimite <= soon
      add({ ...base, regla: 'tarea-bloqueada', categoria: 'bloqueos', tipo: 'bloqueo', severidad: urgent ? 'alta' : 'media', confianza: 'alta', entidades: tEnt, diasVencido: deadline.dias,
        hechos: [`TAREAS.ESTADO = ${t.estado}.`, ...(t.tieneBloqueo ? ['TAREAS.BLOQUEO registrado (texto en Sheets).'] : [])],
        inferencias: [...deadline.inferencias, ...(urgent ? [`Límite dentro de ${THRESHOLDS.ventanaRiesgoDias} días o ya vencido.`] : [])],
        hipotesis: urgent ? ['El bloqueo puede impedir cumplir la fecha límite.'] : [],
        acciones: ['Resolver el bloqueo o actualizar BLOQUEO y ESTADO en Sheets.'] })
    }
    if (isOpen(t.estado) && t.fechaLimite) {
      if (t.fechaLimite < ref) {
        add({ ...base, regla: 'tarea-vencida', categoria: 'vencimientos', tipo: 'incumplimiento', severidad: 'alta', confianza: 'alta', entidades: tEnt, diasVencido: deadline.dias,
          hechos: [`TAREAS.ESTADO = ${t.estado}.`, `TAREAS.FECHA_LIMITE = ${t.fechaLimite}.`], inferencias: deadline.inferencias, hipotesis: [],
          acciones: ['Renegociar FECHA_LIMITE o registrar el cierre real en Sheets (el panel no cierra tareas).'] })
      } else if (!isBlocked(t) && t.fechaLimite <= addDays(ref, THRESHOLDS.venceProntoDias)) {
        add({ ...base, regla: 'tarea-vence-pronto', categoria: 'vencimientos', tipo: 'riesgo', severidad: 'media', confianza: 'media', entidades: tEnt, diasVencido: null,
          hechos: [`TAREAS.ESTADO = ${t.estado}.`, `TAREAS.FECHA_LIMITE = ${t.fechaLimite}.`], inferencias: deadline.inferencias,
          hipotesis: ['Riesgo de no terminar a tiempo.'], acciones: ['Confirmar que la tarea está planificada antes de su límite.'] })
      }
    }
    const broken: string[] = []
    if (available('PROYECTOS')) {
      if (!t.proyectoId) broken.push('TAREAS.PROYECTO_ID vacío.')
      else if (!projects.has(t.proyectoId)) broken.push(`TAREAS.PROYECTO_ID = ${t.proyectoId}, que no está en PROYECTOS.`)
    }
    if (available('HITOS') && t.hitoId && !hitos.has(t.hitoId)) broken.push(`TAREAS.HITO_ID = ${t.hitoId}, que no está en HITOS.`)
    if (broken.length) {
      add({ ...base, regla: 'tarea-referencia-rota', categoria: 'discrepancias', tipo: 'discrepancia', severidad: 'media', confianza: 'alta', entidades: tEnt, diasVencido: null,
        hechos: broken, inferencias: [], hipotesis: [], acciones: ['Corregir las referencias de la tarea en Sheets.'] })
    }
    if (t.estado === 'COMPLETADO' && available('EVIDENCIAS')) {
      const ev = evidenceByTask.get(t.id) ?? []
      const confirmed = ev.filter((e) => e.verificacion === 'CONFIRMADO')
      if (confirmed.length === 0) {
        add({ ...base, regla: 'tarea-completada-sin-evidencia', categoria: 'evidencias', tipo: 'revision', severidad: 'baja', confianza: 'baja', diasVencido: null,
          entidades: [...tEnt, ...ev.map((e) => ({ tipo: 'evidencia' as const, id: e.id }))],
          hechos: ['TAREAS.ESTADO = COMPLETADO.', ev.length === 0 ? 'No hay filas en EVIDENCIAS con este TAREA_ID.' : `${plural(ev.length, 'evidencia vinculada', 'evidencias vinculadas')}, ninguna con VERIFICACION = CONFIRMADO.`],
          inferencias: [], hipotesis: ['Podría faltar evidencia del cierre. No hay una regla formal que la exija: es una revisión, no un incumplimiento.'],
          acciones: ['Revisar si el cierre necesita evidencia. El estado registrado no se modifica.'] })
      }
    }
  }

  /* --------------------------------- Dependencias --------------------------------- */
  if (available('DEPENDENCIAS') && available('TAREAS')) {
    const edges = new Map<string, Set<string>>()
    const seen = new Set<string>()
    for (const d of input.dependencias) {
      if (d.estado && INACTIVE_DEPENDENCY.has(d.estado)) continue
      if (!d.tareaId || !d.dependeDeTareaId) continue
      const pair = `${d.tareaId}\u0000${d.dependeDeTareaId}`
      if (seen.has(pair)) continue
      seen.add(pair)
      const dependent = tasks.get(d.tareaId)
      if (!dependent || !isOpen(dependent.estado)) continue
      const prereq = tasks.get(d.dependeDeTareaId)
      const ent: Entity[] = [{ tipo: 'dependencia', id: d.id }, { tipo: 'tarea', id: d.tareaId }, { tipo: 'tarea', id: d.dependeDeTareaId }]
      const base = { proyectoId: dependent.proyectoId, fechaClave: dependent.fechaLimite }
      if (!prereq) {
        add({ ...base, regla: 'dependencia-inexistente', categoria: 'dependencias', tipo: 'discrepancia', severidad: 'alta', confianza: 'alta', diasVencido: null,
          entidades: ent.slice(0, 2), hechos: [`DEPENDENCIAS ${d.id}: ${d.tareaId} depende de ${d.dependeDeTareaId}, que no está en TAREAS.`],
          inferencias: [`${d.tareaId} no puede habilitarse.`], hipotesis: [], acciones: ['Corregir el prerrequisito o marcar la dependencia como INACTIVA en Sheets.'] })
        continue
      }
      if (prereq.estado === 'COMPLETADO') continue
      if (prereq.estado === 'CANCELADO') {
        add({ ...base, regla: 'dependencia-prerrequisito-cancelado', categoria: 'dependencias', tipo: 'discrepancia', severidad: 'alta', confianza: 'alta', diasVencido: null, entidades: ent,
          hechos: [`${d.dependeDeTareaId}: TAREAS.ESTADO = CANCELADO.`, `DEPENDENCIAS ${d.id} sigue activa.`],
          inferencias: [`${d.tareaId} nunca se habilitará mientras la dependencia siga activa.`], hipotesis: [],
          acciones: ['Marcar la dependencia como INACTIVA o definir un nuevo prerrequisito en Sheets.'] })
        continue
      }
      const deadline = deadlineFacts(dependent.fechaLimite)
      const urgent = dependent.fechaLimite !== null && dependent.fechaLimite <= soon
      add({ ...base, regla: 'dependencia-pendiente', categoria: 'dependencias', tipo: 'bloqueo', severidad: urgent ? 'alta' : 'media', confianza: 'alta', diasVencido: deadline.dias, entidades: ent,
        hechos: [`${d.tareaId} depende de ${d.dependeDeTareaId} (DEPENDENCIAS ${d.id}).`, `${d.dependeDeTareaId}: TAREAS.ESTADO = ${prereq.estado ?? 'vacío'}.`],
        inferencias: [`${d.tareaId} no puede empezar hasta que ${d.dependeDeTareaId} esté COMPLETADO.`, ...deadline.inferencias],
        hipotesis: urgent ? [`${d.tareaId} puede incumplir su límite por esta dependencia.`] : [],
        acciones: [`Priorizar ${d.dependeDeTareaId} o replanificar ${d.tareaId}.`] })
      if (!edges.has(d.dependeDeTareaId)) edges.set(d.dependeDeTareaId, new Set())
      edges.get(d.dependeDeTareaId)!.add(d.tareaId)
    }
    for (const cycle of findCycles(edges, compareIds)) {
      add({
        regla: 'dependencia-circular', categoria: 'dependencias', tipo: 'discrepancia', severidad: 'critica', confianza: 'alta',
        proyectoId: tasks.get(cycle[0]!)?.proyectoId ?? null, diasVencido: null, fechaClave: null,
        entidades: cycle.map((id) => ({ tipo: 'tarea' as const, id })),
        hechos: [`Dependencias activas forman un ciclo: ${cycle.join(' → ')}${cycle.length > 1 ? ` → ${cycle[0]}` : ' (autodependencia)'}.`],
        inferencias: ['Ninguna de estas tareas puede habilitarse nunca.'], hipotesis: [],
        acciones: ['Eliminar o marcar como INACTIVA la dependencia que sobra en Sheets.'],
      })
    }
  }

  /* ------------------------------------- Hitos ------------------------------------- */
  const openTasksByHito = new Map<string, string[]>()
  for (const t of input.tareas) if (t.hitoId && isOpen(t.estado)) openTasksByHito.set(t.hitoId, [...(openTasksByHito.get(t.hitoId) ?? []), t.id])
  for (const h of input.hitos) {
    const open = !h.estado || !CLOSED_MILESTONE.has(h.estado)
    const ent: Entity[] = [{ tipo: 'hito', id: h.id }]
    const base = { proyectoId: h.proyectoId, fechaClave: h.fechaObjetivo }
    const openTasks = available('TAREAS') ? (openTasksByHito.get(h.id) ?? []) : []
    if (open && h.fechaObjetivo && h.fechaObjetivo < ref) {
      const dias = daysBetween(h.fechaObjetivo, ref)
      add({ ...base, regla: 'hito-vencido', categoria: 'vencimientos', tipo: 'incumplimiento', severidad: 'alta', confianza: 'alta', entidades: ent, diasVencido: dias,
        hechos: [`HITOS.ESTADO = ${h.estado ?? 'vacío'}.`, `HITOS.FECHA_OBJETIVO = ${h.fechaObjetivo}.`],
        inferencias: [`Vencido hace ${plural(dias, 'día', 'días')}.`, ...(openTasks.length ? [`${plural(openTasks.length, 'tarea abierta', 'tareas abiertas')} en el hito.`] : [])],
        hipotesis: [], acciones: ['Replanificar el hito o registrar su cierre real en Sheets.'] })
    } else if (open && h.fechaObjetivo && h.fechaObjetivo <= soon && openTasks.length > 0) {
      add({ ...base, regla: 'hito-en-riesgo', categoria: 'vencimientos', tipo: 'riesgo', severidad: 'media', confianza: 'baja', entidades: [...ent, ...openTasks.map((id) => ({ tipo: 'tarea' as const, id }))], diasVencido: null,
        hechos: [`HITOS.FECHA_OBJETIVO = ${h.fechaObjetivo}.`, `${plural(openTasks.length, 'tarea abierta', 'tareas abiertas')}: ${openTasks.join(', ')}.`],
        inferencias: [`Vence dentro de ${THRESHOLDS.ventanaRiesgoDias} días.`],
        hipotesis: ['Riesgo de retraso del hito (heurística: no se conoce el trabajo restante).'],
        acciones: ['Revisar si las tareas abiertas caben antes de la fecha objetivo.'] })
    }
    if (h.estado === 'COMPLETADO' && openTasks.length > 0) {
      add({ ...base, regla: 'hito-completado-con-tareas-abiertas', categoria: 'discrepancias', tipo: 'discrepancia', severidad: 'alta', confianza: 'alta',
        entidades: [...ent, ...openTasks.map((id) => ({ tipo: 'tarea' as const, id }))], diasVencido: null,
        hechos: ['HITOS.ESTADO = COMPLETADO.', `Tareas del hito abiertas: ${openTasks.join(', ')}.`], inferencias: ['El estado del hito contradice el de sus tareas.'], hipotesis: [],
        acciones: ['Cerrar o mover las tareas, o corregir el estado del hito en Sheets.'] })
    }
    if (available('PROYECTOS') && (!h.proyectoId || !projects.has(h.proyectoId))) {
      add({ ...base, regla: 'hito-proyecto-inexistente', categoria: 'discrepancias', tipo: 'discrepancia', severidad: 'media', confianza: 'alta', entidades: ent, diasVencido: null,
        hechos: [h.proyectoId ? `HITOS.PROYECTO_ID = ${h.proyectoId}, que no está en PROYECTOS.` : 'HITOS.PROYECTO_ID vacío.'], inferencias: [], hipotesis: [],
        acciones: ['Corregir el PROYECTO_ID del hito en Sheets.'] })
    }
  }

  /* ---------------------------------- Proyectos ---------------------------------- */
  if (available('PROYECTOS') && available('TAREAS')) {
    for (const p of input.proyectos) {
      if (!projectInactive(p.id)) continue
      const openTasks = input.tareas.filter((t) => t.proyectoId === p.id && isOpen(t.estado)).map((t) => t.id)
      const openHitos = available('HITOS') ? input.hitos.filter((h) => h.proyectoId === p.id && (!h.estado || !CLOSED_MILESTONE.has(h.estado))).map((h) => h.id) : []
      if (!openTasks.length && !openHitos.length) continue
      add({ regla: 'proyecto-inactivo-con-trabajo-abierto', categoria: 'discrepancias', tipo: 'revision', severidad: 'media', confianza: 'media', proyectoId: p.id,
        entidades: [{ tipo: 'proyecto', id: p.id }], diasVencido: null, fechaClave: null,
        hechos: [`PROYECTOS.ESTADO = ${p.estado}.`, `${plural(openTasks.length, 'tarea abierta', 'tareas abiertas')} y ${plural(openHitos.length, 'hito abierto', 'hitos abiertos')}.`],
        inferencias: ['Trabajo abierto en un proyecto inactivo.'], hipotesis: [],
        acciones: ['Cancelar o mover el trabajo abierto, o reactivar el proyecto en Sheets.'] })
    }
  }

  /* ------------------------------ Referencias rotas ------------------------------ */
  if (available('TAREAS')) {
    for (const e of input.evidencias) {
      if (!e.tareaId || tasks.has(e.tareaId)) continue
      add({ regla: 'evidencia-vinculo-roto', categoria: 'evidencias', tipo: 'discrepancia', severidad: 'baja', confianza: 'alta', proyectoId: null,
        entidades: [{ tipo: 'evidencia', id: e.id }], diasVencido: null, fechaClave: null,
        hechos: [`EVIDENCIAS.TAREA_ID = ${e.tareaId}, que no está en TAREAS.`], inferencias: [], hipotesis: [], acciones: ['Corregir el TAREA_ID de la evidencia en Sheets.'] })
    }
    const orphanTimes = new Map<string, string[]>()
    for (const s of input.tiempos) if (s.tareaId && !tasks.has(s.tareaId)) orphanTimes.set(s.tareaId, [...(orphanTimes.get(s.tareaId) ?? []), s.id])
    for (const [taskId, sessions] of [...orphanTimes].sort(([a], [b]) => compareIds(a, b))) {
      add({ regla: 'tiempo-tarea-inexistente', categoria: 'discrepancias', tipo: 'discrepancia', severidad: 'baja', confianza: 'alta', proyectoId: null,
        entidades: sessions.map((id) => ({ tipo: 'sesion' as const, id })), diasVencido: null, fechaClave: null,
        hechos: [`${plural(sessions.length, 'sesión', 'sesiones')} de TIEMPOS con TAREA_ID = ${taskId}, que no está en TAREAS.`],
        inferencias: ['Ese tiempo no se puede atribuir a ningún proyecto.'], hipotesis: [], acciones: ['Corregir el TAREA_ID de las sesiones en Sheets.'] })
    }
  }

  /* ---------------------------------- Capacidad ---------------------------------- */
  const lunes = isoMonday(ref)
  const domingo = addDays(lunes, 6)
  if (available('CAPACIDAD_SEMANAL') && available('PLAN_DIARIO') && available('PLAN_ITEMS')) {
    const weekRows = input.capacidad.filter((c) => c.fechaInicio !== null && c.fechaInicio >= lunes && c.fechaInicio <= domingo)
    const weekPlans = input.planes.filter((p) => p.fecha !== null && p.fecha >= lunes && p.fecha <= domingo && !(p.estado && CANCELLED_PLAN.has(p.estado)))
    const weekPlanIds = new Set(weekPlans.map((p) => p.id))
    const plannedMin = input.planItems
      .filter((i) => i.planId !== null && weekPlanIds.has(i.planId) && i.minutosPlan !== null && Number.isFinite(i.minutosPlan) && i.minutosPlan > 0)
      .reduce((acc, i) => acc + Math.round(i.minutosPlan!), 0)
    const row = weekRows.length === 1 ? weekRows[0]! : null
    const assignments = row && available('ASIGNACIONES') ? input.asignaciones.filter((a) => a.semanaId === row.id) : []
    const assignedMin = assignments.reduce((acc, a) => acc + (a.horasObjetivo !== null && Number.isFinite(a.horasObjetivo) && a.horasObjetivo > 0 ? Math.round(a.horasObjetivo * 60) : 0), 0)
    const semanaEnt: Entity[] = row ? [{ tipo: 'semana', id: row.id }] : weekRows.map((r) => ({ tipo: 'semana' as const, id: r.id }))
    const fmt = (min: number) => `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`
    if (row && row.horasDisponibles !== null && Number.isFinite(row.horasDisponibles) && row.horasDisponibles >= 0) {
      const reserva = row.reservaPct ?? 0
      const neta = Math.max(0, Math.round(row.horasDisponibles * 60 * (1 - reserva)))
      const capFacts = [`CAPACIDAD_SEMANAL ${row.id}: HORAS_DISPONIBLES = ${row.horasDisponibles}, RESERVA_PCT = ${row.reservaPct === null ? 'vacía (0 %)' : `${Math.round(reserva * 1000) / 10} %`}.`]
      if (plannedMin > neta) {
        add({ regla: 'compromiso-excede-capacidad', categoria: 'capacidad', tipo: 'incumplimiento', severidad: 'alta', confianza: 'alta', proyectoId: null,
          entidades: [...semanaEnt, ...weekPlans.map((p) => ({ tipo: 'plan' as const, id: p.id }))], diasVencido: null, fechaClave: lunes,
          hechos: [...capFacts, `PLAN_ITEMS de la semana ${lunes} a ${domingo}: ${fmt(plannedMin)}.`],
          inferencias: [`Capacidad neta ${fmt(neta)} < comprometido ${fmt(plannedMin)} (exceso ${fmt(plannedMin - neta)}).`], hipotesis: [],
          acciones: ['Reducir o mover elementos de los planes diarios, o revisar la capacidad registrada.'] })
      }
      if (assignedMin > neta) {
        add({ regla: 'asignaciones-exceden-capacidad', categoria: 'capacidad', tipo: 'riesgo', severidad: 'media', confianza: 'alta', proyectoId: null,
          entidades: semanaEnt, diasVencido: null, fechaClave: lunes,
          hechos: [...capFacts, `ASIGNACIONES de ${row.id}: ${fmt(assignedMin)}.`],
          inferencias: [`Las asignaciones superan la capacidad neta (${fmt(neta)}).`], hipotesis: ['No todo lo asignado podrá hacerse esta semana.'],
          acciones: ['Ajustar HORAS_OBJETIVO de las asignaciones o la capacidad en Sheets.'] })
      }
    } else if (plannedMin > 0 || assignments.length > 0 || (weekRows.length > 1 && weekPlans.length > 0)) {
      add({ regla: 'capacidad-no-verificable', categoria: 'capacidad', tipo: 'diagnostico', severidad: 'media', confianza: 'alta', proyectoId: null,
        entidades: semanaEnt.length ? semanaEnt : weekPlans.map((p) => ({ tipo: 'plan' as const, id: p.id })), diasVencido: null, fechaClave: lunes,
        hechos: [weekRows.length === 0 ? `No hay fila en CAPACIDAD_SEMANAL para ${lunes} a ${domingo}.` : weekRows.length > 1 ? `${weekRows.length} filas de CAPACIDAD_SEMANAL para la misma semana.` : `${row!.id}: HORAS_DISPONIBLES vacía.`,
          `Comprometido en PLAN_ITEMS: ${fmt(plannedMin)}${assignedMin ? `; asignado: ${fmt(assignedMin)}` : ''}.`],
        inferencias: ['No se puede comprobar si el trabajo comprometido cabe en la capacidad.'], hipotesis: [],
        acciones: ['Registrar una única fila de capacidad con HORAS_DISPONIBLES para la semana.'] })
    }
  }
  if (available('PLAN_DIARIO') && available('PLAN_ITEMS')) {
    const planById = new Map(input.planes.map((p) => [p.id, p]))
    if (available('TAREAS')) {
      for (const item of input.planItems) {
        const plan = item.planId ? planById.get(item.planId) : undefined
        if (!plan || !plan.fecha || plan.fecha < ref || (plan.estado && CANCELLED_PLAN.has(plan.estado)) || !item.tareaId) continue
        const task = tasks.get(item.tareaId)
        const problem = !task ? 'no existe en TAREAS' : !task.estado ? 'no tiene ESTADO' : CLOSED_TASK.has(task.estado) ? `está ${task.estado}` : isBlocked(task) ? 'está bloqueada' : null
        if (!problem) continue
        add({ regla: 'plan-con-tarea-no-ejecutable', categoria: 'capacidad', tipo: 'discrepancia', severidad: 'media', confianza: 'alta', proyectoId: task?.proyectoId ?? null,
          entidades: [{ tipo: 'plan', id: plan.id }, { tipo: 'plan-item', id: item.id }, { tipo: 'tarea', id: item.tareaId }], diasVencido: null, fechaClave: plan.fecha,
          hechos: [`PLAN_ITEMS ${item.id} (plan ${plan.id}, ${plan.fecha}) incluye ${item.tareaId}, que ${problem}.`],
          inferencias: ['Ese tiempo comprometido no puede ejecutarse tal como está planificado.'], hipotesis: [],
          acciones: ['Quitar o sustituir el elemento del plan en Sheets.'] })
      }
    }
    for (const p of input.planes) {
      if (!p.fecha || p.fecha >= ref || (p.estado && CLOSED_PLAN.has(p.estado))) continue
      const dias = daysBetween(p.fecha, ref)
      add({ regla: 'plan-diario-sin-cerrar', categoria: 'capacidad', tipo: 'revision', severidad: 'baja', confianza: 'media', proyectoId: null,
        entidades: [{ tipo: 'plan', id: p.id }], diasVencido: dias, fechaClave: p.fecha,
        hechos: [`PLAN_DIARIO ${p.id}: FECHA = ${p.fecha}, ESTADO = ${p.estado ?? 'vacío'}.`],
        inferencias: [`Compromiso de hace ${plural(dias, 'día', 'días')} sin cierre registrado.`], hipotesis: [],
        acciones: ['Cerrar el plan diario en Sheets con su resultado real.'] })
    }
  }

  /* ----------------------- Señales opcionales del planificador V1.5 ----------------------- */
  if (input.planificacion) {
    const planIds = new Set(input.planes.map((p) => p.id))
    for (const c of input.planificacion.conflictos) {
      const code = c.codigo.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 60)
      if (!code) continue
      const refs = c.refs.filter((r) => SAFE_REF.test(r)).slice(0, 50)
      const high = PLANNER_HIGH.has(code)
      add({ regla: `planificacion-${code}`, categoria: 'capacidad', tipo: high ? 'riesgo' : 'revision', severidad: high ? 'alta' : 'baja', confianza: 'media',
        proyectoId: null, diasVencido: null, fechaClave: null,
        entidades: refs.map((r) => ({ tipo: tasks.has(r) ? 'tarea' as const : planIds.has(r) ? 'plan' as const : 'semana' as const, id: r })),
        hechos: [`Planificador V1.5 (${SAFE_REF.test(input.planificacion.semanaIso) ? input.planificacion.semanaIso : 'semana'}): conflicto ${code}.`],
        inferencias: [], hipotesis: ['Señal de una propuesta simulada: no es un dato registrado.'], acciones: ['Revisar la propuesta en Planificación.'] })
    }
  }

  /* ------------------------------- Orden y resumen ------------------------------- */
  const alertas = [...alerts.values()].sort((a, b) =>
    SEVERITY_RANK[a.severidad] - SEVERITY_RANK[b.severidad] ||
    TYPE_RANK[a.tipo] - TYPE_RANK[b.tipo] ||
    (b.diasVencido ?? -1) - (a.diasVencido ?? -1) ||
    compareIds(a.proyectoId ?? '~', b.proyectoId ?? '~') ||
    compareText(a.regla, b.regla) ||
    compareIds(a.entidades.map((e) => e.id).join('|'), b.entidades.map((e) => e.id).join('|')) ||
    compareText(a.id, b.id))

  const count = <K extends string>(keys: readonly K[], pick: (a: Alert) => K, list = alertas) =>
    Object.fromEntries(keys.map((k) => [k, list.filter((a) => pick(a) === k).length])) as Record<K, number>
  const cobertura = CATEGORIES.map((categoria) => {
    const n = alertas.filter((a) => a.categoria === categoria).length
    const pestanasFaltantes = CATEGORY_TABS[categoria].filter((t) => !available(t))
    return { categoria, alertas: n, pestanasFaltantes, estado: n > 0 ? 'con-alertas' as const : pestanasFaltantes.length ? 'sin-datos' as const : 'sin-alertas-detectadas' as const }
  })
  const estadoGlobal: GlobalState = alertas.some((a) => a.severidad === 'critica') ? 'critico'
    : alertas.some((a) => a.severidad === 'alta' || a.severidad === 'media') ? 'requiere-atencion'
    : cobertura.some((c) => c.pestanasFaltantes.length > 0) ? 'datos-incompletos'
    : alertas.length > 0 ? 'revisiones-sugeridas'
    : 'sin-alertas-detectadas'

  const projectIds = [...new Set([...input.proyectos.map((p) => p.id), ...alertas.map((a) => a.proyectoId).filter((p): p is string => p !== null)])].sort(compareIds)
  const proyectos = projectIds.map((id) => {
    const list = alertas.filter((a) => a.proyectoId === id)
    const p = projects.get(id)
    return {
      id, registrado: !!p, activo: p ? !(p.estado && INACTIVE_PROJECT.has(p.estado)) : null, total: list.length,
      porSeveridad: count(SEVERITIES, (a) => a.severidad, list),
      maxSeveridad: list.length ? list[0]!.severidad : null,
    }
  })

  const canonical = canonicalJson({ input, ref, zone })
  return {
    version: 'control-v1.6',
    referencia: { fecha: ref, zona: zone, semana: { lunes, domingo } },
    estadoGlobal,
    resumen: {
      total: alertas.length,
      porSeveridad: count(SEVERITIES, (a) => a.severidad),
      porCategoria: count(CATEGORIES, (a) => a.categoria) as Record<Category, number>,
      porTipo: count(TYPES, (a) => a.tipo),
    },
    cobertura,
    proyectos,
    alertas,
    huella: fnv1a(canonical) + fnv1a(canonical, 0x01000193 ^ 0x5bd1e995),
  }
}

function dedupeEntities(list: Entity[]): Entity[] {
  const seen = new Set<string>()
  const out: Entity[] = []
  for (const e of list) {
    const key = `${e.tipo}:${e.id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(e)
  }
  return out.sort((a, b) => ENTITY_ORDER.indexOf(a.tipo) - ENTITY_ORDER.indexOf(b.tipo) || compareIds(a.id, b.id))
}
