import type { PoliticaReporte } from './report'

/**
 * Repositorios sin CI (ORD-POS-051): única fuente de verdad. Allí un CONFORME exige CI_AUSENTE y pruebas propias del
 * revisor en verde (contrato, caso 7). Se decide por el repositorio de la orden, nunca por la ausencia de checks (una CI
 * que aún no arranca también da cero) ni por texto del dictamen o del PR. Cualquier otro repositorio requiere CI.
 * SIGSAH salió de la lista en ORD-POS-144: ya tiene CI (workflow Validar) y sus dictámenes exigen la CI del head.
 */
export const REPOS_SIN_CI: readonly string[] = Object.freeze(['jlpulido107-bit/RADAROS'])

export const repoSinCi = (repo: string): boolean => REPOS_SIN_CI.some((r) => r.toLowerCase() === repo.toLowerCase())

/** Política de validación del dictamen para el repositorio de la orden. */
export const politicaDeRepo = (repo: string, criteriosEsperados: readonly string[]): PoliticaReporte =>
  ({ ciRequerida: !repoSinCi(repo), criteriosEsperados })

/**
 * Familia de un modelo declarado en el dictamen (DEC-POS-022). «Otro modelo» se compara por familia, nunca por el texto
 * libre de `modelo`: un sufijo distinto del mismo modelo, o un nombre inventado (p. ej. `gemini-supervisado`), no cuenta.
 * null = no reconocido, y un modelo no reconocido nunca cuenta como revisor distinto.
 */
export function familiaModelo(modelo: string | undefined): string | null {
  const m = modelo?.toLowerCase() ?? ''
  const claude = /^claude-(opus|sonnet|haiku|fable)-\d[a-z0-9._-]*$/.exec(m)
  if (claude) return claude[1]!
  return /^gemini-(?:\d[a-z0-9._-]*|code-assist)$/.test(m) ? 'gemini' : null
}

export const esFamiliaClaude = (familia: string | null): boolean => familia !== null && familia !== 'gemini'

/**
 * Familia del modelo que implementa y corrige las órdenes (docs/operacion.md: Opus). El firmante de un SEGUNDO
 * gemini-supervisado no puede ser de esta familia (DEC-POS-022).
 * atajo: es la asignación operativa, no se lee del PR; mejorarlo si la orden llega a registrar su implementador.
 */
export const FAMILIA_IMPLEMENTADOR = 'opus'

/**
 * Columna SENSIBLE de ORDENES_CODEX (DEC-POS-019, docs/migracion-ordenes-codex.md): solo `NO` marca una orden no
 * sensible. Vacía, ausente o cualquier otro valor = sensible, para no relajar la revisión por omisión.
 */
export const ordenSensible = (valor: string | null | undefined): boolean => valor?.trim().toUpperCase() !== 'NO'
