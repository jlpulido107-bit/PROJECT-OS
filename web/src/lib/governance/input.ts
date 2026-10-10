import type { Dataset } from '../types'
import { ALL_TABS } from './rules'
import type { GovernanceInput, PlannerSignals, TabState } from './types'

/**
 * Proyección del conjunto de datos para el motor de control. SIN texto libre: ni títulos, ni descripciones,
 * ni notas, ni el texto de BLOQUEO o de las decisiones (solo si BLOQUEO está vacío o no).
 */
export function governanceInputFromDataset(ds: Dataset, planificacion?: PlannerSignals): GovernanceInput {
  const invalid = new Map<string, number>()
  for (const issue of ds.issues) invalid.set(issue.tab, (invalid.get(issue.tab) ?? 0) + 1)
  const pestanas: GovernanceInput['pestanas'] = {}
  for (const tab of ALL_TABS) {
    const s = ds.tabs[tab]
    if (!s) continue
    const state: TabState = { ok: s.ok, truncated: s.truncated, duplicateIds: [...s.duplicateIds], invalidCells: invalid.get(tab) ?? 0 }
    pestanas[tab] = state
  }
  return {
    proyectos: ds.proyectos.map((p) => ({ id: p.id, estado: p.estado })),
    hitos: ds.hitos.map((h) => ({ id: h.id, proyectoId: h.proyectoId, estado: h.estado, fechaObjetivo: h.fechaObjetivo })),
    tareas: ds.tareas.map((t) => ({ id: t.id, proyectoId: t.proyectoId, hitoId: t.hitoId, estado: t.estado, tieneBloqueo: t.bloqueo !== null, fechaLimite: t.fechaLimite })),
    dependencias: ds.dependencias.map((d) => ({ id: d.id, tareaId: d.tareaId, dependeDeTareaId: d.dependeDeTareaId, estado: d.estado })),
    evidencias: ds.evidencias.map((e) => ({ id: e.id, tareaId: e.tareaId, verificacion: e.verificacion })),
    decisiones: ds.decisiones.map((d) => ({ id: d.id, proyectoId: d.proyectoId, fecha: d.fecha, estado: d.estado })),
    tiempos: ds.tiempos.map((t) => ({ id: t.id, tareaId: t.tareaId })),
    planes: ds.planes.map((p) => ({ id: p.id, fecha: p.fecha, estado: p.estado })),
    planItems: ds.planItems.map((i) => ({ id: i.id, planId: i.planId, tareaId: i.tareaId, minutosPlan: i.minutosPlan })),
    capacidad: ds.capacidad.map((c) => ({ id: c.id, fechaInicio: c.fechaInicio, horasDisponibles: c.horasDisponibles, reservaPct: c.reservaPct })),
    asignaciones: ds.asignaciones.map((a) => ({ id: a.id, semanaId: a.semanaId, horasObjetivo: a.horasObjetivo })),
    pestanas,
    // Solo código y referencias: cualquier texto adicional del planificador (p. ej. `mensaje`) se descarta.
    ...(planificacion ? { planificacion: { semanaIso: planificacion.semanaIso, conflictos: planificacion.conflictos.map((c) => ({ codigo: c.codigo, refs: [...c.refs] })) } } : {}),
  }
}

/** Etiquetas legibles SOLO para la página privada (nunca para la API ni los registros). */
export interface GovernanceLabels {
  proyectos: Record<string, string>
  tareas: Record<string, string>
  hitos: Record<string, string>
  decisiones: Record<string, string>
}

export function governanceLabels(ds: Dataset): GovernanceLabels {
  const pick = <T extends { id: string }>(rows: T[], f: (r: T) => string | null) =>
    Object.fromEntries(rows.flatMap((r) => { const v = f(r); return v ? [[r.id, v.slice(0, 160)]] : [] }))
  return {
    proyectos: pick(ds.proyectos, (p) => p.nombre),
    tareas: pick(ds.tareas, (t) => t.titulo),
    hitos: pick(ds.hitos, (h) => h.nombre),
    decisiones: pick(ds.decisiones, (d) => d.asunto),
  }
}
