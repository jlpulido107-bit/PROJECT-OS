import { isEmailAllowed, parseAllowedEmails } from '../access'

/**
 * Política de escritura V1.4 (contrato §4). Por defecto NADIE escribe:
 * - PROJECT_OS_WRITE_MODE=disabled (por defecto) | mock | sheets
 * - AUTH_WRITER_EMAILS vacío ⇒ ningún escritor. Un escritor debe estar también en AUTH_ALLOWED_EMAILS.
 */

export type WriteMode = 'disabled' | 'mock' | 'sheets'

export type WriteModeReason =
  | 'deshabilitada'
  | 'modo-invalido'
  | 'sheets-no-habilitado'
  | 'mock-requiere-fixtures'
  | 'mock-no-permitido-en-cloud-run'

export interface WriteModeStatus {
  /** Modo efectivo: solo 'mock' permite escribir en esta versión. */
  mode: 'disabled' | 'mock'
  requested: string
  reason: WriteModeReason | null
}

export function writeModeStatus(env: NodeJS.ProcessEnv = process.env): WriteModeStatus {
  const requested = (env.PROJECT_OS_WRITE_MODE ?? 'disabled').trim().toLowerCase() || 'disabled'
  if (requested === 'disabled') return { mode: 'disabled', requested, reason: 'deshabilitada' }
  if (requested === 'sheets') {
    // Escritura real: requiere aprobación, credencial de escritura dedicada y el runbook (docs/operaciones-v1-4.md).
    return { mode: 'disabled', requested, reason: 'sheets-no-habilitado' }
  }
  if (requested !== 'mock') return { mode: 'disabled', requested, reason: 'modo-invalido' }
  if (env.K_SERVICE?.trim()) return { mode: 'disabled', requested, reason: 'mock-no-permitido-en-cloud-run' }
  if ((env.DASHBOARD_DATA_SOURCE ?? 'sheets').trim().toLowerCase() !== 'fixtures') {
    // Nunca mezclar escrituras simuladas con datos reales de Sheets.
    return { mode: 'disabled', requested, reason: 'mock-requiere-fixtures' }
  }
  return { mode: 'mock', requested, reason: null }
}

export function writerEmails(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const readers = parseAllowedEmails(env.AUTH_ALLOWED_EMAILS)
  return new Set([...parseAllowedEmails(env.AUTH_WRITER_EMAILS)].filter((email) => readers.has(email)))
}

export function isWriter(email: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  return isEmailAllowed(email, writerEmails(env))
}

/** Escritura posible para este usuario ahora mismo (para mostrar u ocultar controles; el servidor vuelve a verificar). */
export function canWrite(email: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  return writeModeStatus(env).mode !== 'disabled' && isWriter(email, env)
}
