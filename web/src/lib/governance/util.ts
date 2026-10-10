/** Utilidades puras del motor de control: fechas civiles, huella y ciclos. Sin reloj, red ni entorno. */

const CIVIL = /^(\d{4})-(\d{2})-(\d{2})$/

export function isCivilDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const m = CIVIL.exec(value)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const probe = new Date(Date.UTC(y, mo - 1, d))
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d
}

const toUtc = (civil: string) => {
  const [y, m, d] = civil.split('-').map(Number) as [number, number, number]
  return Date.UTC(y, m - 1, d)
}

export function addDays(civil: string, days: number): string {
  const date = new Date(toUtc(civil) + days * 86_400_000)
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

/** Días civiles b − a. */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000)
}

/** Lunes (ISO) de la semana que contiene la fecha. */
export function isoMonday(civil: string): string {
  const dow = new Date(toUtc(civil)).getUTCDay()
  return addDays(civil, -((dow + 6) % 7))
}

/** Serialización canónica (claves ordenadas) para la huella. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

/** FNV-1a de 32 bits (no criptográfico): IDs estables de alertas y huella de entrada. */
export function fnv1a(text: string, seed = 0x811c9dc5): string {
  let hash = seed >>> 0
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * Ciclos de un grafo dirigido (componentes fuertemente conexas de Tarjan, iterativo).
 * Devuelve solo las componentes con más de un nodo o con autoarista, ordenadas de forma determinista.
 */
export function findCycles(edges: Map<string, Set<string>>, compare: (a: string, b: string) => number): string[][] {
  const nodes = new Set<string>()
  for (const [from, tos] of edges) {
    nodes.add(from)
    for (const to of tos) nodes.add(to)
  }
  const succ = (n: string) => [...(edges.get(n) ?? [])].sort(compare)
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const out: string[][] = []
  let counter = 0
  const open = (n: string) => {
    index.set(n, counter)
    low.set(n, counter)
    counter += 1
    stack.push(n)
    onStack.add(n)
  }
  for (const start of [...nodes].sort(compare)) {
    if (index.has(start)) continue
    open(start)
    const work: Array<{ node: string; next: string[]; i: number }> = [{ node: start, next: succ(start), i: 0 }]
    while (work.length) {
      const frame = work[work.length - 1]!
      if (frame.i < frame.next.length) {
        const w = frame.next[frame.i++]!
        if (!index.has(w)) {
          open(w)
          work.push({ node: w, next: succ(w), i: 0 })
        } else if (onStack.has(w)) low.set(frame.node, Math.min(low.get(frame.node)!, index.get(w)!))
        continue
      }
      work.pop()
      const parent = work[work.length - 1]
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!))
      if (low.get(frame.node) === index.get(frame.node)) {
        const comp: string[] = []
        let w: string
        do {
          w = stack.pop()!
          onStack.delete(w)
          comp.push(w)
        } while (w !== frame.node)
        if (comp.length > 1 || edges.get(comp[0]!)?.has(comp[0]!)) out.push(comp.sort(compare))
      }
    }
  }
  return out.sort((a, b) => compare(a[0]!, b[0]!))
}
