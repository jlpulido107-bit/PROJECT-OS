/**
 * Generación de escrituras del pipeline en este proceso (ORD-POS-102). La ruta de escritura la sube tras una escritura
 * correcta y el lector de /eco descarta su caché si cambió: el tablero muestra la tarjeta en su nueva etapa al
 * refrescar. Vive en globalThis porque Next empaqueta por separado rutas API y páginas. No lee ni escribe datos.
 */
const KEY = Symbol.for('project-os.eco.pipeline.generacion')

function estado(): { n: number } {
  const g = globalThis as unknown as Record<symbol, { n: number } | undefined>
  g[KEY] ??= { n: 0 }
  return g[KEY]
}

export function generacionEco(): number {
  return estado().n
}

export function subirGeneracionEco(): void {
  estado().n += 1
}
