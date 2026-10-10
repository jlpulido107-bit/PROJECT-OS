/**
 * Huella determinista (no criptográfica) de un valor JSON: dos FNV-1a de 32 bits sobre una serialización
 * canónica (claves ordenadas). Sirve para comprobar reproducibilidad, no para seguridad.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

function fnv1a(text: string, seed: number): string {
  let hash = seed >>> 0
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export function fingerprint(value: unknown): string {
  const text = canonicalJson(value)
  return fnv1a(text, 0x811c9dc5) + fnv1a(text, 0x01000193 ^ 0x5bd1e995)
}
