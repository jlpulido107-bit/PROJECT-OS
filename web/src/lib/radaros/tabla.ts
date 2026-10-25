import { cellText } from '../parse'
import { MAX_DATA_ROWS } from '../schema'

/** Lectura por encabezado (fila 1) compartida por /eco y /eco/pipeline: funciones puras, sin red. */

export type Fila = Record<string, string | null>

export type Bloque<T> =
  | { estado: 'ausente'; tab: string; mensaje: string }
  | { estado: 'sin-filas'; tab: string; mensaje: string }
  | { estado: 'columnas-faltantes'; tab: string; faltan: string[] }
  | { estado: 'ok'; tab: string; truncado: boolean; datos: T }

export interface Tabla {
  encabezados: Set<string>
  filas: Fila[]
}

/** Filas con solo las columnas pedidas, buscadas por encabezado. Las filas vacías se ignoran. */
export function leerTabla(
  tab: string, rows: unknown[][] | undefined, columnas: readonly string[], obligatorias: readonly string[], ausente: string,
  sinFilas: string,
): Bloque<Tabla> {
  if (rows === undefined) return { estado: 'ausente', tab, mensaje: ausente }
  const header = (rows[0] ?? []).map(cellText)
  const indice = new Map<string, number>()
  header.forEach((h, i) => {
    if (h !== null && !indice.has(h)) indice.set(h, i)
  })
  const faltan = obligatorias.filter((c) => !indice.has(c))
  if (faltan.length) return { estado: 'columnas-faltantes', tab, faltan }
  // El lector pide encabezado + MAX_DATA_ROWS + 1 fila centinela.
  const truncado = rows.length > MAX_DATA_ROWS + 1
  const filas: Fila[] = []
  for (const row of rows.slice(1, MAX_DATA_ROWS + 1)) {
    const fila: Fila = {}
    let vacia = true
    for (const c of columnas) {
      const i = indice.get(c)
      const v = i === undefined ? null : cellText(row[i])
      fila[c] = v
      if (v !== null) vacia = false
    }
    if (!vacia) filas.push(fila)
  }
  if (filas.length === 0 && !truncado) return { estado: 'sin-filas', tab, mensaje: sinFilas }
  return { estado: 'ok', tab, truncado, datos: { encabezados: new Set(indice.keys()), filas } }
}

export function mapear<T, U>(b: Bloque<T>, f: (datos: T) => U): Bloque<U> {
  return b.estado === 'ok' ? { ...b, datos: f(b.datos) } : b
}
