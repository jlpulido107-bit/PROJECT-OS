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
 * Un modelo de Claude puede llevar el sufijo `[1m]` (ventana de contexto de la sesión, p. ej. `claude-opus-5-5[1m]`):
 * es el mismo modelo y la misma familia (ORD-POS-161). Solo ese sufijo, una vez y al final; cualquier otro da null.
 */
export function familiaModelo(modelo: string | undefined): string | null {
  const m = modelo?.toLowerCase() ?? ''
  const claude = /^claude-(opus|sonnet|haiku|fable)-\d[a-z0-9._-]*(?:\[1m\])?$/.exec(m)
  if (claude) return claude[1]!
  return /^gemini-(?:\d[a-z0-9._-]*|code-assist)$/.test(m) ? 'gemini' : null
}

export const esFamiliaClaude = (familia: string | null): boolean => familia !== null && familia !== 'gemini'

/**
 * Familia del modelo que implementa las órdenes: fuente única (ORD-POS-158). Los documentos y las skills remiten a
 * esta constante en vez de nombrar un modelo. El firmante de un SEGUNDO, de cualquier origen, no puede ser de esta
 * familia (DEC-POS-035, ORD-POS-161; antes solo el gemini-supervisado, DEC-POS-022).
 * Para cambiar de implementador: cambiar este valor (uno de los que devuelve familiaModelo), en un PR.
 * atajo: es la asignación operativa, no se lee del PR ni distingue a un corrector de otra familia; mejorarlo si la
 * orden llega a registrar quién la implementó y quién la corrigió.
 */
export const FAMILIA_IMPLEMENTADOR = 'fable'

/**
 * Columna SENSIBLE de ORDENES_CODEX (DEC-POS-019, docs/migracion-ordenes-codex.md): solo `NO` marca una orden no
 * sensible. Vacía, ausente o cualquier otro valor = sensible, para no relajar la revisión por omisión.
 */
export const ordenSensible = (valor: string | null | undefined): boolean => valor?.trim().toUpperCase() !== 'NO'
