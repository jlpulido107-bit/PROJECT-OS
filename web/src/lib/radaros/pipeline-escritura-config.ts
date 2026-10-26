import { isEmailAllowed, parseAllowedEmails } from '../access'
import { radarosSheetId } from '../config'

/**
 * Escritura del pipeline de /eco (ORD-POS-102, docs/diseno-eco-pipeline.md §4.2 y §7.1). Inerte por defecto: solo se
 * escribe si se cumplen TODAS las condiciones de `ecoPipelineWriteStatus`. Es independiente de la escritura de
 * PROJECT-OS y de la de finanzas: ni PROJECT_OS_WRITE_MODE, ni FINANZAS_WRITE_MODE, ni AUTH_WRITER_EMAILS, ni
 * FINANZAS_WRITER_EMAIL la encienden, y su cuenta de servicio es otra.
 *
 * - ECO_PIPELINE_WRITE_MODE=sheets exacto (cualquier otro valor, o ausente: deshabilitada; no hay modo simulado).
 * - RADAROS_SHEET_ID válido (`radarosSheetId`: con formato y distinto de PROJECT-OS).
 * - ECO_PIPELINE_WRITE_SERVICE_ACCOUNT: cuenta exclusiva del pipeline, distinta de la de lectura
 *   (SHEETS_EXPECTED_SERVICE_ACCOUNT), de la de PROJECT-OS (PROJECT_OS_WRITE_SERVICE_ACCOUNT) y de las dos de finanzas
 *   (FINANZAS_WRITE_SERVICE_ACCOUNT y FINANZAS_AGENTE_SERVICE_ACCOUNT). Sin SHEETS_EXPECTED_SERVICE_ACCOUNT no se puede
 *   probar que sean distintas: deshabilitada.
 * - ECO_PIPELINE_WRITER_EMAIL: un único correo, que además debe estar en AUTH_ALLOWED_EMAILS.
 */

export type EcoPipelineWriteReason =
  | 'deshabilitada'
  | 'modo-invalido'
  | 'sin-libro'
  | 'sin-cuenta'
  | 'sin-cuenta-de-lectura'
  | 'cuenta-de-lectura'
  | 'cuenta-de-project-os'
  | 'cuenta-de-finanzas'
  | 'cuenta-del-agente-de-finanzas'
  | 'sin-escritor'
  | 'escritor-ambiguo'
  | 'escritor-no-permitido'

export interface EcoPipelineWriteStatus {
  mode: 'disabled' | 'sheets'
  reason: EcoPipelineWriteReason | null
}

const SERVICE_ACCOUNT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/
const EMAIL = /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/

const normal = (v: string | undefined) => v?.trim().toLowerCase() ?? ''

/** ECO_PIPELINE_WRITE_SERVICE_ACCOUNT con formato de cuenta de servicio, o null. No compara con las otras cuentas. */
export function ecoPipelineWriteServiceAccount(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = normal(env.ECO_PIPELINE_WRITE_SERVICE_ACCOUNT)
  return SERVICE_ACCOUNT.test(value) ? value : null
}

/** ECO_PIPELINE_WRITER_EMAIL si es exactamente un correo; una lista (coma, espacio o punto y coma) no vale. */
function writerEmail(env: NodeJS.ProcessEnv): { email: string } | { email: null; reason: 'sin-escritor' | 'escritor-ambiguo' } {
  const raw = normal(env.ECO_PIPELINE_WRITER_EMAIL)
  if (!raw) return { email: null, reason: 'sin-escritor' }
  if (/[\s,;]/.test(raw)) return { email: null, reason: 'escritor-ambiguo' }
  return EMAIL.test(raw) ? { email: raw } : { email: null, reason: 'sin-escritor' }
}

export function ecoPipelineWriteStatus(env: NodeJS.ProcessEnv = process.env): EcoPipelineWriteStatus {
  const requested = env.ECO_PIPELINE_WRITE_MODE
  if (requested === undefined || requested.trim() === '' || requested.trim() === 'disabled') return { mode: 'disabled', reason: 'deshabilitada' }
  if (requested !== 'sheets') return { mode: 'disabled', reason: 'modo-invalido' }
  if (radarosSheetId(env) === null) return { mode: 'disabled', reason: 'sin-libro' }
  const account = ecoPipelineWriteServiceAccount(env)
  if (!account) return { mode: 'disabled', reason: 'sin-cuenta' }
  const reader = normal(env.SHEETS_EXPECTED_SERVICE_ACCOUNT)
  if (!reader) return { mode: 'disabled', reason: 'sin-cuenta-de-lectura' }
  if (account === reader) return { mode: 'disabled', reason: 'cuenta-de-lectura' }
  if (account === normal(env.PROJECT_OS_WRITE_SERVICE_ACCOUNT)) return { mode: 'disabled', reason: 'cuenta-de-project-os' }
  if (account === normal(env.FINANZAS_WRITE_SERVICE_ACCOUNT)) return { mode: 'disabled', reason: 'cuenta-de-finanzas' }
  if (account === normal(env.FINANZAS_AGENTE_SERVICE_ACCOUNT)) return { mode: 'disabled', reason: 'cuenta-del-agente-de-finanzas' }
  const writer = writerEmail(env)
  if (writer.email === null) return { mode: 'disabled', reason: writer.reason }
  if (!isEmailAllowed(writer.email, parseAllowedEmails(env.AUTH_ALLOWED_EMAILS))) return { mode: 'disabled', reason: 'escritor-no-permitido' }
  return { mode: 'sheets', reason: null }
}

/** `sheets` solo con todas las condiciones; si falta cualquiera, `disabled`. */
export function ecoPipelineWriteMode(env: NodeJS.ProcessEnv = process.env): 'disabled' | 'sheets' {
  return ecoPipelineWriteStatus(env).mode
}

/** El único escritor del pipeline, solo si la escritura está activa. */
export function ecoPipelineWriter(env: NodeJS.ProcessEnv = process.env): string | null {
  if (ecoPipelineWriteMode(env) !== 'sheets') return null
  return normal(env.ECO_PIPELINE_WRITER_EMAIL)
}

/** Para pintar u ocultar el arrastre y «Mover a…»; el servidor repite todo en cada petición (§4.2). */
export function ecoPipelineCanWrite(email: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  const writer = ecoPipelineWriter(env)
  return writer !== null && typeof email === 'string' && email.trim().toLowerCase() === writer
}
