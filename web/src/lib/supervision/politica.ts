import type { PoliticaReporte } from './report'

/**
 * Repositorios sin CI (ORD-POS-051): única fuente de verdad. Allí un CONFORME exige CI_AUSENTE y pruebas propias del
 * revisor en verde (contrato, caso 7). Se decide por el repositorio de la orden, nunca por la ausencia de checks (una CI
 * que aún no arranca también da cero) ni por texto del dictamen o del PR. Cualquier otro repositorio requiere CI.
 */
export const REPOS_SIN_CI: readonly string[] = Object.freeze(['jlpulido107-bit/SIGSAH', 'jlpulido107-bit/RADAROS'])

export const repoSinCi = (repo: string): boolean => REPOS_SIN_CI.some((r) => r.toLowerCase() === repo.toLowerCase())

/** Política de validación del dictamen para el repositorio de la orden. */
export const politicaDeRepo = (repo: string, criteriosEsperados: readonly string[]): PoliticaReporte =>
  ({ ciRequerida: !repoSinCi(repo), criteriosEsperados })
