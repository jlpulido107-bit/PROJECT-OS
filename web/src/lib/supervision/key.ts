import { createHash } from 'node:crypto'

/**
 * Clave idempotente y hash de criterios (contrato §5; formato en docs/migracion-supervision.md).
 * Funciones PURAS y deterministas: sin E/S, reloj ni azar.
 */

export interface Criterio {
  /** Número del criterio en la orden (1, 2, 3…). Cambiarlo cambia el hash. */
  numero: number
  texto: string
}

export interface PartesClave {
  repo: string
  pr: number
  headSha: string
  baseSha: string
  hashCriterios: string
  versionContrato: string
  versionPolitica: string
}

/** CRLF/LF, espacios finales y espacios repetidos no cambian el texto de un criterio. */
export function normalizarTexto(texto: string): string {
  return texto.replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim()
}

/**
 * Huella SHA-256 (64 hex) de los criterios. El orden de la lista, el número y el texto normalizado forman la entrada:
 * cambiar cualquiera cambia el hash.
 */
export function hashCriterios(criterios: readonly Criterio[]): string {
  const entrada = criterios.map((c) => `${c.numero}\t${normalizarTexto(c.texto)}`).join('\n')
  return createHash('sha256').update(entrada, 'utf8').digest('hex')
}

/** `REPO|PR|HEAD_SHA|BASE_SHA|HASH_CRITERIOS|VERSION_CONTRATO|VERSION_POLITICA`. */
export function claveIdempotente(p: PartesClave): string {
  return [p.repo, String(p.pr), p.headSha, p.baseSha, p.hashCriterios, p.versionContrato, p.versionPolitica].join('|')
}
