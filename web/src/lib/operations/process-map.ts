/**
 * Mapa POR PROCESO guardado en globalThis con Symbol.for (DIS-03, ORD-POS-154), como el estado de runtime.ts: Next
 * empaqueta por separado rutas API y páginas, y un Map de módulo no se comparte entre ellas. Con la clave global, dos
 * paquetes del mismo proceso ven el mismo «en curso» y no lanzan dos veces lo mismo (maxScale 1 ⇒ escritor único).
 */
export function mapaDeProceso<K, V>(nombre: string): Map<K, V> {
  const g = globalThis as unknown as Record<symbol, Map<K, V> | undefined>
  const key = Symbol.for(`project-os.${nombre}`)
  g[key] ??= new Map<K, V>()
  return g[key]
}
