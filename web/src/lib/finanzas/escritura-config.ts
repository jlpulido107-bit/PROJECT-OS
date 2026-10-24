import { isEmailAllowed, parseAllowedEmails } from '../access'
import { finanzasConfig } from '../config'

/**
 * Escritura de finanzas (ORD-POS-077, docs/diseno-finanzas-v2.md §2 y §7 con la opción C de §6, decidida por el
 * propietario el 2026-10-23). Inerte por defecto: solo se escribe si se cumplen TODAS las condiciones de
 * `finanzasWriteStatus`. Es independiente de la escritura de PROJECT-OS: ni PROJECT_OS_WRITE_MODE ni AUTH_WRITER_EMAILS
 * la encienden, y su cuenta de servicio es otra.
 *
 * - FINANZAS_WRITE_MODE=sheets exacto (cualquier otro valor, o ausente: deshabilitada; no hay modo simulado).
 * - FINANZAS_SHEET_ID válido (`finanzasConfig`: con formato y distinto de PROJECT-OS y de RADAROS).
 * - FINANZAS_WRITE_SERVICE_ACCOUNT: cuenta de servicio exclusiva de FINANZAS, distinta de la cuenta de lectura
 *   (SHEETS_EXPECTED_SERVICE_ACCOUNT) y de la de escritura de PROJECT-OS (PROJECT_OS_WRITE_SERVICE_ACCOUNT).
 * - FINANZAS_WRITER_EMAIL: un único correo, que además debe estar en AUTH_ALLOWED_EMAILS.
 */

export type FinanzasWriteReason =
  | 'deshabilitada'
  | 'modo-invalido'
  | 'sin-libro'
  | 'sin-cuenta'
  | 'cuenta-de-lectura'
  | 'cuenta-de-project-os'
  | 'sin-escritor'
  | 'escritor-ambiguo'
  | 'escritor-no-permitido'

export interface FinanzasWriteStatus {
  mode: 'disabled' | 'sheets'
  reason: FinanzasWriteReason | null
}

const SERVICE_ACCOUNT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/
const EMAIL = /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/

/** FINANZAS_WRITE_SERVICE_ACCOUNT con formato de cuenta de servicio, o null. No compara con las otras cuentas. */
export function finanzasWriteServiceAccount(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.FINANZAS_WRITE_SERVICE_ACCOUNT?.trim().toLowerCase() ?? ''
  return SERVICE_ACCOUNT.test(value) ? value : null
}

/** FINANZAS_WRITER_EMAIL si es exactamente un correo; una lista (coma, espacio o punto y coma) no vale. */
function writerEmail(env: NodeJS.ProcessEnv): { email: string } | { email: null; reason: 'sin-escritor' | 'escritor-ambiguo' } {
  const raw = env.FINANZAS_WRITER_EMAIL?.trim().toLowerCase() ?? ''
  if (!raw) return { email: null, reason: 'sin-escritor' }
  if (/[\s,;]/.test(raw)) return { email: null, reason: 'escritor-ambiguo' }
  return EMAIL.test(raw) ? { email: raw } : { email: null, reason: 'sin-escritor' }
}

export function finanzasWriteStatus(env: NodeJS.ProcessEnv = process.env): FinanzasWriteStatus {
  const requested = env.FINANZAS_WRITE_MODE
  if (requested === undefined || requested.trim() === '' || requested.trim() === 'disabled') return { mode: 'disabled', reason: 'deshabilitada' }
  if (requested !== 'sheets') return { mode: 'disabled', reason: 'modo-invalido' }
  if (finanzasConfig(env).id === null) return { mode: 'disabled', reason: 'sin-libro' }
  const account = finanzasWriteServiceAccount(env)
  if (!account) return { mode: 'disabled', reason: 'sin-cuenta' }
  if (account === env.SHEETS_EXPECTED_SERVICE_ACCOUNT?.trim().toLowerCase()) return { mode: 'disabled', reason: 'cuenta-de-lectura' }
  if (account === env.PROJECT_OS_WRITE_SERVICE_ACCOUNT?.trim().toLowerCase()) return { mode: 'disabled', reason: 'cuenta-de-project-os' }
  const writer = writerEmail(env)
  if (writer.email === null) return { mode: 'disabled', reason: writer.reason }
  if (!isEmailAllowed(writer.email, parseAllowedEmails(env.AUTH_ALLOWED_EMAILS))) return { mode: 'disabled', reason: 'escritor-no-permitido' }
  return { mode: 'sheets', reason: null }
}

/** `sheets` solo con todas las condiciones; si falta cualquiera, `disabled`. */
export function finanzasWriteMode(env: NodeJS.ProcessEnv = process.env): 'disabled' | 'sheets' {
  return finanzasWriteStatus(env).mode
}

/** El único escritor de finanzas, solo si la escritura está activa. */
export function finanzasWriter(env: NodeJS.ProcessEnv = process.env): string | null {
  if (finanzasWriteMode(env) !== 'sheets') return null
  return env.FINANZAS_WRITER_EMAIL!.trim().toLowerCase()
}

/** Para pintar u ocultar los botones; el servidor repite todo en cada petición. */
export function finanzasCanWrite(email: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  const writer = finanzasWriter(env)
  return writer !== null && typeof email === 'string' && email.trim().toLowerCase() === writer
}
