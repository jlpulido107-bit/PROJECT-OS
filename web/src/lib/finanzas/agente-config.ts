import { finanzasConfig } from '../config'
import { finanzasWriteServiceAccount } from './escritura-config'

/**
 * Escritura del agente de finanzas (ORD-POS-092, docs/diseno-finanzas-v3.md §2 y §8.1, DEC-POS-018). Inerte por
 * defecto: las rutas `/api/finanzas/agente/…` escriben solo si se cumplen TODAS las condiciones de
 * `finanzasAgenteStatus`. No depende de FINANZAS_WRITE_MODE ni de PROJECT_OS_WRITE_MODE: se enciende y se apaga sola.
 *
 * - FINANZAS_AGENTE_MODE=sheets exacto (ausente o con otro valor: deshabilitada).
 * - FINANZAS_SHEET_ID válido (`finanzasConfig`).
 * - FINANZAS_AGENTE_SERVICE_ACCOUNT con formato, del mismo proyecto que la cuenta de lectura y distinta de ella, de la
 *   escritura de PROJECT-OS y de la escritura del propietario en FINANZAS.
 * - FINANZAS_AGENTE_TOKEN_SHA256 (montado desde Secret Manager), distinto de PM_AGENT_TOKEN_SHA256.
 */

export type FinanzasAgenteReason =
  | 'deshabilitada'
  | 'modo-invalido'
  | 'sin-libro'
  | 'sin-cuenta'
  | 'sin-cuenta-de-lectura'
  | 'cuenta-de-otro-proyecto'
  | 'cuenta-de-lectura'
  | 'cuenta-de-project-os'
  | 'cuenta-del-propietario'
  | 'sin-hash'
  | 'hash-del-pm'

export interface FinanzasAgenteStatus {
  mode: 'disabled' | 'sheets'
  reason: FinanzasAgenteReason | null
}

const HEX64 = /^[0-9a-f]{64}$/

/** FINANZAS_AGENTE_SERVICE_ACCOUNT con formato de cuenta de servicio, o null. No compara con las otras cuentas. */
export function finanzasAgenteServiceAccount(env: NodeJS.ProcessEnv = process.env): string | null {
  return finanzasWriteServiceAccount({ FINANZAS_WRITE_SERVICE_ACCOUNT: env.FINANZAS_AGENTE_SERVICE_ACCOUNT } as unknown as NodeJS.ProcessEnv)
}

/** Hash esperado del token del agente de finanzas (hex en minúsculas), o null si no es un SHA-256 válido. */
export function finanzasAgenteTokenHash(env: NodeJS.ProcessEnv = process.env): string | null {
  const hash = (env.FINANZAS_AGENTE_TOKEN_SHA256 ?? '').trim().toLowerCase()
  return HEX64.test(hash) ? hash : null
}

export function finanzasAgenteStatus(env: NodeJS.ProcessEnv = process.env): FinanzasAgenteStatus {
  const requested = env.FINANZAS_AGENTE_MODE
  if (requested === undefined || requested.trim() === '' || requested.trim() === 'disabled') return { mode: 'disabled', reason: 'deshabilitada' }
  if (requested !== 'sheets') return { mode: 'disabled', reason: 'modo-invalido' }
  if (finanzasConfig(env).id === null) return { mode: 'disabled', reason: 'sin-libro' }
  const account = finanzasAgenteServiceAccount(env)
  if (!account) return { mode: 'disabled', reason: 'sin-cuenta' }
  const reader = env.SHEETS_EXPECTED_SERVICE_ACCOUNT?.trim().toLowerCase() ?? ''
  if (!reader) return { mode: 'disabled', reason: 'sin-cuenta-de-lectura' }
  if (account.split('@')[1] !== reader.split('@')[1]) return { mode: 'disabled', reason: 'cuenta-de-otro-proyecto' }
  if (account === reader) return { mode: 'disabled', reason: 'cuenta-de-lectura' }
  if (account === env.PROJECT_OS_WRITE_SERVICE_ACCOUNT?.trim().toLowerCase()) return { mode: 'disabled', reason: 'cuenta-de-project-os' }
  if (account === env.FINANZAS_WRITE_SERVICE_ACCOUNT?.trim().toLowerCase()) return { mode: 'disabled', reason: 'cuenta-del-propietario' }
  const hash = finanzasAgenteTokenHash(env)
  if (!hash) return { mode: 'disabled', reason: 'sin-hash' }
  if (hash === (env.PM_AGENT_TOKEN_SHA256 ?? '').trim().toLowerCase()) return { mode: 'disabled', reason: 'hash-del-pm' }
  return { mode: 'sheets', reason: null }
}

/** `sheets` solo con todas las condiciones; si falta cualquiera, `disabled`. */
export function finanzasAgenteMode(env: NodeJS.ProcessEnv = process.env): 'disabled' | 'sheets' {
  return finanzasAgenteStatus(env).mode
}
