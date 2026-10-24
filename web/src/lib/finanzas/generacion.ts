/**
 * Generación de escrituras de finanzas en este proceso (ORD-POS-077). La ruta de escritura la sube tras un alta
 * correcta y el lector de /finanzas descarta su caché si cambió. Vive en globalThis porque Next empaqueta por separado
 * rutas API y páginas. No lee ni escribe datos.
 */
const KEY = Symbol.for('project-os.finanzas.generacion')

function estado(): { n: number } {
  const g = globalThis as unknown as Record<symbol, { n: number } | undefined>
  g[KEY] ??= { n: 0 }
  return g[KEY]
}

export function generacionFinanzas(): number {
  return estado().n
}

export function subirGeneracionFinanzas(): void {
  estado().n += 1
}
