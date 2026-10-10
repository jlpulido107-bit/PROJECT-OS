import { ALL_TABS } from '@/lib/governance/rules'
import type { GovernanceInput, TabState } from '@/lib/governance/types'

type Task = GovernanceInput['tareas'][number]

const okTab = (): TabState => ({ ok: true, truncated: false, duplicateIds: [], invalidCells: 0 })

/** Entrada vacía con todas las pestañas legibles. */
export function govInput(overrides: Partial<GovernanceInput> = {}): GovernanceInput {
  return {
    proyectos: [{ id: 'POS', estado: 'EN_PROGRESO' }, { id: 'SIG', estado: 'EN_PROGRESO' }],
    hitos: [], tareas: [], dependencias: [], evidencias: [], decisiones: [], tiempos: [], planes: [], planItems: [], capacidad: [], asignaciones: [],
    pestanas: Object.fromEntries(ALL_TABS.map((t) => [t, okTab()])),
    ...overrides,
  }
}

export function gTask(id: string, extra: Partial<Task> = {}): Task {
  return { id, proyectoId: 'POS', hitoId: null, estado: 'PENDIENTE', tieneBloqueo: false, fechaLimite: null, ...extra }
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v)
    Object.freeze(value)
  }
  return value
}

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
