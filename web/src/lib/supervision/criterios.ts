import { hashCriterios, type Criterio } from './key'

/**
 * Extracción de los IDs de CRITERIOS_ACEPTACION de una orden (contrato de supervisión; formato en
 * docs/migracion-supervision.md). Función PURA: sin E/S, reloj ni azar.
 *
 * Formato admitido: cada criterio empieza en el INICIO de una línea con `N.` o `N)` (N entero sin ceros a la izquierda,
 * hasta 3 cifras) y un espacio, seguido de texto. Toda línea siguiente que no empiece así (incluidas las sangradas y las
 * que traen números dentro del texto) es continuación del criterio anterior, salvo que sea un encabezado numérico mal
 * formado al margen («2.», «02. Dos», «2.Dos»), que se rechaza. Todos los criterios usan el mismo
 * delimitador y sus IDs crecen en orden estricto. No hay texto antes del primer criterio.
 *
 * Nada se renumera, completa ni elimina: lo que no cumple el formato se rechaza con el motivo.
 */

export type ResultadoCriterios =
  | { ok: true; criteriosEsperados: string[]; criterios: Criterio[]; hashCriterios: string }
  | { ok: false; motivo: string }

const INICIO = /^([1-9]\d{0,2})([.)])[ \t]+(\S.*)$/
// Encabezado numérico mal formado: `N.` o `N)` pegado al margen que no cumple INICIO (sin texto, sin espacio, ceros a la
// izquierda, más de 3 cifras). Se rechaza en vez de absorberlo como continuación. `3.5` (decimal) no es encabezado.
const ENCABEZADO_MALFORMADO = /^\d+[.)](?!\d)/

export function extraerCriterios(texto: string): ResultadoCriterios {
  const lineas = texto.replace(/\r\n?/g, '\n').split('\n')
  if (lineas.every((l) => l.trim() === '')) return { ok: false, motivo: 'texto de criterios vacío' }
  if (!lineas.some((l) => INICIO.test(l))) return { ok: false, motivo: 'no hay IDs explícitos («N.» o «N)» al inicio de línea)' }

  const bloques: Array<{ id: string; delim: string; lineas: string[] }> = []
  for (const linea of lineas) {
    const m = INICIO.exec(linea)
    if (!m && ENCABEZADO_MALFORMADO.test(linea)) return { ok: false, motivo: `encabezado numérico mal formado al inicio de línea: «${linea.trim()}»` }
    if (m) bloques.push({ id: m[1]!, delim: m[2]!, lineas: [m[3]!] })
    else if (linea.trim() !== '') {
      const actual = bloques.at(-1)
      if (!actual) return { ok: false, motivo: 'hay texto antes del primer criterio numerado («N.» o «N)» al inicio de línea)' }
      actual.lineas.push(linea)
    }
  }
  const vistos = new Set<string>()
  for (const b of bloques) {
    if (vistos.has(b.id)) return { ok: false, motivo: `ID duplicado: ${b.id}` }
    vistos.add(b.id)
  }
  if (new Set(bloques.map((b) => b.delim)).size > 1) return { ok: false, motivo: 'mezcla los delimitadores «N.» y «N)»' }
  for (let i = 1; i < bloques.length; i++) {
    if (Number(bloques[i]!.id) < Number(bloques[i - 1]!.id)) return { ok: false, motivo: `los IDs no están en orden creciente (${bloques[i - 1]!.id} antes de ${bloques[i]!.id})` }
  }

  const criterios = bloques.map((b) => ({ numero: Number(b.id), texto: b.lineas.join('\n') }))
  return { ok: true, criteriosEsperados: bloques.map((b) => b.id), criterios, hashCriterios: hashCriterios(criterios) }
}
