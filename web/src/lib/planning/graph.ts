import { CLOSED_TASK_STATES, compareIds, INACTIVE_DEPENDENCY_STATES } from './rules'
import type { Issue, PlanningInput } from './types'

/**
 * Grafo dirigido de dependencias: arista prerrequisito → dependiente.
 * Solo cuentan las dependencias activas; un prerrequisito está satisfecho únicamente si su estado registrado
 * en Sheets es COMPLETADO (el motor nunca infiere cierres).
 */
export interface DependencyAnalysis {
  /** Prerrequisitos no satisfechos por tarea dependiente. */
  pendientes: Map<string, string[]>
  /** Prerrequisitos que no existen en TAREAS, por tarea dependiente. */
  inexistentes: Map<string, string[]>
  /** Tareas que forman parte de un ciclo (incluye autodependencias). */
  enCiclo: Set<string>
  /** Ciclos encontrados (cada uno ordenado por ID). */
  ciclos: string[][]
  /** Número de tareas dependientes (con la dependencia aún exigible) por prerrequisito. */
  desbloquea: Map<string, number>
  conflictos: Issue[]
}

const COMPLETED = 'COMPLETADO'

export function analyzeDependencies(input: Pick<PlanningInput, 'tareas' | 'dependencias'>): DependencyAnalysis {
  const tasks = new Map(input.tareas.map((t) => [t.id, t]))
  const pendientes = new Map<string, string[]>()
  const inexistentes = new Map<string, string[]>()
  const desbloquea = new Map<string, number>()
  const conflictos: Issue[] = []
  const edges = new Map<string, Set<string>>() // prerrequisito → dependientes (no satisfechas)
  const seenPairs = new Set<string>()
  const incomplete: string[] = []
  const orphan: string[] = []
  const duplicatePairs: string[] = []

  const deps = [...input.dependencias].sort((a, b) => compareIds(a.id, b.id))
  for (const d of deps) {
    if (d.estado && INACTIVE_DEPENDENCY_STATES.has(d.estado)) continue
    if (!d.tareaId || !d.dependeDeTareaId) {
      incomplete.push(d.id)
      continue
    }
    const pair = `${d.tareaId}\u0000${d.dependeDeTareaId}`
    if (seenPairs.has(pair)) {
      duplicatePairs.push(d.id)
      continue
    }
    seenPairs.add(pair)
    const dependent = tasks.get(d.tareaId)
    if (!dependent) {
      orphan.push(d.id)
      continue
    }
    // Una tarea dependiente ya cerrada no exige nada.
    if (dependent.estado && CLOSED_TASK_STATES.has(dependent.estado)) continue
    const prereq = tasks.get(d.dependeDeTareaId)
    if (!prereq) {
      push(inexistentes, d.tareaId, d.dependeDeTareaId)
      continue
    }
    if (prereq.estado === COMPLETED) continue
    push(pendientes, d.tareaId, d.dependeDeTareaId)
    desbloquea.set(d.dependeDeTareaId, (desbloquea.get(d.dependeDeTareaId) ?? 0) + 1)
    if (!edges.has(d.dependeDeTareaId)) edges.set(d.dependeDeTareaId, new Set())
    edges.get(d.dependeDeTareaId)!.add(d.tareaId)
  }

  if (incomplete.length) conflictos.push({ codigo: 'dependencia-incompleta', mensaje: 'Dependencias sin TAREA_ID o sin DEPENDE_DE_TAREA_ID: se ignoran.', refs: incomplete })
  if (orphan.length) conflictos.push({ codigo: 'dependencia-huerfana', mensaje: 'Dependencias de tareas que no existen en TAREAS: se ignoran.', refs: orphan })
  if (duplicatePairs.length) conflictos.push({ codigo: 'dependencia-duplicada', mensaje: 'Dependencias repetidas (misma pareja de tareas): se cuentan una vez.', refs: duplicatePairs })

  const ciclos = stronglyConnected(edges).filter((c) => c.length > 1 || edges.get(c[0]!)?.has(c[0]!))
  const enCiclo = new Set(ciclos.flat())

  for (const list of [...pendientes.values(), ...inexistentes.values()]) list.sort(compareIds)
  return { pendientes, inexistentes, enCiclo, ciclos, desbloquea, conflictos }
}

function push(map: Map<string, string[]>, key: string, value: string) {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

/** Componentes fuertemente conexas (Tarjan iterativo, sin recursión). Orden determinista. */
function stronglyConnected(edges: Map<string, Set<string>>): string[][] {
  const nodes = new Set<string>()
  for (const [from, tos] of edges) {
    nodes.add(from)
    for (const to of tos) nodes.add(to)
  }
  const sortedNodes = [...nodes].sort(compareIds)
  const succ = (n: string) => [...(edges.get(n) ?? [])].sort(compareIds)
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const result: string[][] = []
  let counter = 0

  for (const start of sortedNodes) {
    if (index.has(start)) continue
    const work: Array<{ node: string; next: string[]; i: number }> = [{ node: start, next: succ(start), i: 0 }]
    index.set(start, counter)
    low.set(start, counter)
    counter += 1
    stack.push(start)
    onStack.add(start)
    while (work.length) {
      const frame = work[work.length - 1]!
      if (frame.i < frame.next.length) {
        const w = frame.next[frame.i++]!
        if (!index.has(w)) {
          index.set(w, counter)
          low.set(w, counter)
          counter += 1
          stack.push(w)
          onStack.add(w)
          work.push({ node: w, next: succ(w), i: 0 })
        } else if (onStack.has(w)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(w)!))
        }
        continue
      }
      work.pop()
      const parent = work[work.length - 1]
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!))
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = []
        let w: string
        do {
          w = stack.pop()!
          onStack.delete(w)
          component.push(w)
        } while (w !== frame.node)
        result.push(component.sort(compareIds))
      }
    }
  }
  return result.sort((a, b) => compareIds(a[0]!, b[0]!))
}
