import type { PlanningInput } from '@/lib/planning/types'

type Task = PlanningInput['tareas'][number]

/** Constructor de entradas sintéticas para el planificador (todas las pestañas disponibles, sin duplicados). */
export function emptyInput(): PlanningInput {
  return {
    proyectos: [], hitos: [], tareas: [], dependencias: [], capacidad: [], asignaciones: [], planes: [], planItems: [], tiempos: [],
    pestanasNoDisponibles: [],
    idsDuplicados: { TAREAS: [], PROYECTOS: [], DEPENDENCIAS: [] },
  }
}

export function project(id: string, prioridad: string | null = 'MEDIA', estado: string | null = 'EN_PROGRESO') {
  return { id, nombre: `Proyecto ${id}`, estado, prioridad }
}

export function task(id: string, proyectoId: string | null, horas: number | null, extra: Partial<Task> = {}): Task {
  return {
    id, proyectoId, hitoId: null, titulo: `Tarea ${id}`, estado: 'PENDIENTE', prioridad: 'MEDIA',
    fechaPlan: null, fechaLimite: null, horasEstimadas: horas, bloqueo: null, ...extra,
  }
}

export function week(id: string, fechaInicio: string, horas: number | null, reservaPct: number | null = 0, estado = 'APROBADA') {
  return { id, fechaInicio, horasDisponibles: horas, reservaPct, estado }
}

export function dep(id: string, tareaId: string | null, dependeDeTareaId: string | null, estado: string | null = 'ACTIVA') {
  return { id, tareaId, dependeDeTareaId, estado }
}

/** Datos base: semana del 5 al 11 de octubre de 2026 con 20 h y reserva 0; referencia el lunes 5. */
export function baseInput(overrides: Partial<PlanningInput> = {}): PlanningInput {
  return {
    ...emptyInput(),
    proyectos: [project('POS', 'ALTA'), project('SIG', 'MEDIA')],
    capacidad: [week('S41', '2026-10-05', 20, 0)],
    ...overrides,
  }
}

/** Congela en profundidad (para comprobar que el motor no muta su entrada). */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v)
    Object.freeze(value)
  }
  return value
}

/** PRNG determinista (mulberry32) para pruebas de propiedades reproducibles. */
export function rng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
    chance: (p: number) => next() < p,
    shuffle: <T>(items: T[]): T[] => {
      const out = [...items]
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1))
        ;[out[i], out[j]] = [out[j]!, out[i]!]
      }
      return out
    },
  }
}
