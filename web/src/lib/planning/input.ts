import type { Dataset } from '../types'
import type { PlanningInput } from './types'

const TABS = ['PROYECTOS', 'HITOS', 'TAREAS', 'DEPENDENCIAS', 'CAPACIDAD_SEMANAL', 'ASIGNACIONES', 'PLAN_DIARIO', 'PLAN_ITEMS', 'TIEMPOS'] as const

/**
 * Proyección mínima del conjunto de datos para el planificador (solo lectura).
 * Excluye responsables, notas, descripciones, URLs y marcas de tiempo: no hacen falta para planificar.
 */
export function planningInputFromDataset(ds: Dataset): PlanningInput {
  return {
    proyectos: ds.proyectos.map((p) => ({ id: p.id, nombre: p.nombre, estado: p.estado, prioridad: p.prioridad })),
    hitos: ds.hitos.map((h) => ({ id: h.id, proyectoId: h.proyectoId, estado: h.estado })),
    tareas: ds.tareas.map((t) => ({
      id: t.id,
      proyectoId: t.proyectoId,
      hitoId: t.hitoId,
      titulo: t.titulo,
      estado: t.estado,
      prioridad: t.prioridad,
      fechaPlan: t.fechaPlan,
      fechaLimite: t.fechaLimite,
      horasEstimadas: t.horasEstimadas,
      bloqueo: t.bloqueo,
    })),
    dependencias: ds.dependencias.map((d) => ({ id: d.id, tareaId: d.tareaId, dependeDeTareaId: d.dependeDeTareaId, estado: d.estado })),
    capacidad: ds.capacidad.map((c) => ({ id: c.id, fechaInicio: c.fechaInicio, horasDisponibles: c.horasDisponibles, reservaPct: c.reservaPct, estado: c.estado })),
    asignaciones: ds.asignaciones.map((a) => ({ id: a.id, semanaId: a.semanaId, proyectoId: a.proyectoId, horasObjetivo: a.horasObjetivo })),
    planes: ds.planes.map((p) => ({ id: p.id, fecha: p.fecha, semanaId: p.semanaId, estado: p.estado, horasObjetivo: p.horasObjetivo })),
    planItems: ds.planItems.map((i) => ({ id: i.id, planId: i.planId, tareaId: i.tareaId, orden: i.orden, minutosPlan: i.minutosPlan })),
    tiempos: ds.tiempos.map((t) => ({ id: t.id, tareaId: t.tareaId, fecha: t.fecha, minutosReales: t.minutosReales })),
    pestanasNoDisponibles: TABS.filter((tab) => !ds.tabs[tab]?.ok || ds.tabs[tab]?.truncated),
    idsDuplicados: {
      TAREAS: ds.tabs.TAREAS?.duplicateIds ?? [],
      PROYECTOS: ds.tabs.PROYECTOS?.duplicateIds ?? [],
      DEPENDENCIAS: ds.tabs.DEPENDENCIAS?.duplicateIds ?? [],
    },
  }
}
