import { isEmailAllowed, parseAllowedEmails } from '../access'

/**
 * Política de escritura (contrato V1.4 §4; escritura real en V1.8, docs/plan-v1-8-automatizacion.md). Por defecto
 * NADIE escribe:
 * - PROJECT_OS_WRITE_MODE=disabled (por defecto) | mock | sheets
 * - AUTH_WRITER_EMAILS vacío ⇒ ningún escritor. Un escritor debe estar también en AUTH_ALLOWED_EMAILS.
 * - `sheets` exige datos reales (DASHBOARD_DATA_SOURCE=sheets) y una cuenta de servicio de ESCRITURA dedicada
 *   (PROJECT_OS_WRITE_SERVICE_ACCOUNT), distinta de la cuenta lectora; el servidor la suplanta (write-credentials.ts).
 */

export type WriteMode = 'disabled' | 'mock' | 'sheets'

export type WriteModeReason =
  | 'deshabilitada'
  | 'modo-invalido'
  | 'sheets-no-habilitado'
  | 'sheets-requiere-datos-reales'
  | 'sheets-sin-cuenta-escritura'
  | 'sheets-misma-cuenta'
  | 'mock-requiere-fixtures'
  | 'mock-no-permitido-en-cloud-run'

export interface WriteModeStatus {
  /** Modo efectivo. */
  mode: 'disabled' | 'mock' | 'sheets'
  requested: string
  reason: WriteModeReason | null
}

export function writeModeStatus(env: NodeJS.ProcessEnv = process.env): WriteModeStatus {
  const requested = (env.PROJECT_OS_WRITE_MODE ?? 'disabled').trim().toLowerCase() || 'disabled'
  if (requested === 'disabled') return { mode: 'disabled', requested, reason: 'deshabilitada' }
  if (requested === 'sheets') {
    // Escritura real (V1.8): solo sobre datos reales y con una cuenta de escritura dedicada, distinta de la lectora.
    if ((env.DASHBOARD_DATA_SOURCE ?? 'sheets').trim().toLowerCase() !== 'sheets') {
      return { mode: 'disabled', requested, reason: 'sheets-requiere-datos-reales' }
    }
    const account = writeServiceAccount(env)
    if (!account) return { mode: 'disabled', requested, reason: 'sheets-sin-cuenta-escritura' }
    const reader = env.SHEETS_EXPECTED_SERVICE_ACCOUNT?.trim().toLowerCase()
    if (reader && reader === account) return { mode: 'disabled', requested, reason: 'sheets-misma-cuenta' }
    return { mode: 'sheets', requested, reason: null }
  }
  if (requested !== 'mock') return { mode: 'disabled', requested, reason: 'modo-invalido' }
  if (env.K_SERVICE?.trim()) return { mode: 'disabled', requested, reason: 'mock-no-permitido-en-cloud-run' }
  if ((env.DASHBOARD_DATA_SOURCE ?? 'sheets').trim().toLowerCase() !== 'fixtures') {
    // Nunca mezclar escrituras simuladas con datos reales de Sheets.
    return { mode: 'disabled', requested, reason: 'mock-requiere-fixtures' }
  }
  return { mode: 'mock', requested, reason: null }
}

const SERVICE_ACCOUNT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/

/** Cuenta de servicio de escritura (PROJECT_OS_WRITE_SERVICE_ACCOUNT) o null si falta o no es válida. */
export function writeServiceAccount(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.PROJECT_OS_WRITE_SERVICE_ACCOUNT?.trim().toLowerCase() ?? ''
  return SERVICE_ACCOUNT.test(value) ? value : null
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

/**
 * ORD-POS-063 (DEC-POS-014): REGISTRAR_PR del agente PM, apagado por defecto. Solo el valor exacto `true` lo enciende,
 * y solo el propietario lo pone en Cloud Run con deploy.sh tras registrar la decisión que amplía DEC-POS-011.
 */
export function pmPuedeRegistrarPr(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PM_PUEDE_REGISTRAR_PR === 'true'
}

/**
 * ORD-POS-100 (DEC-POS-022, DEC-POS-014): el SEGUNDO de origen gemini-supervisado cuenta como segundo revisor solo con
 * SEGUNDO_GEMINI_SUPERVISADO=on, que pone únicamente el propietario en Cloud Run con deploy.sh. Apagada por defecto.
 */
export function segundoGeminiSupervisado(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SEGUNDO_GEMINI_SUPERVISADO === 'on'
}

/**
 * ORD-POS-106 (DEC-POS-023, DEC-POS-014): cierre de tareas por el propietario, apagado por defecto. Solo con
 * TAREAS_CIERRE_PROPIETARIO=true exacto y un único correo en TAREAS_CIERRE_PROPIETARIO_EMAIL que además esté en
 * AUTH_ALLOWED_EMAILS. Devuelve ese correo, o null si falta cualquier condición. Solo el propietario la pone en Cloud Run
 * con deploy.sh; el token del agente PM nunca cierra (guard.ts).
 */
export function tareasCierrePropietario(env: NodeJS.ProcessEnv = process.env): string | null {
  return correoPropietario(env.TAREAS_CIERRE_PROPIETARIO, env.TAREAS_CIERRE_PROPIETARIO_EMAIL, env)
}

/** Comprobación de correo de DEC-POS-023: bandera `true` exacta y un único correo que además esté en AUTH_ALLOWED_EMAILS. */
function correoPropietario(bandera: string | undefined, correo: string | undefined, env: NodeJS.ProcessEnv): string | null {
  if (bandera !== 'true') return null
  const email = correo?.trim().toLowerCase() ?? ''
  if (!/^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/.test(email)) return null
  return isEmailAllowed(email, parseAllowedEmails(env.AUTH_ALLOWED_EMAILS)) ? email : null
}

/**
 * ORD-POS-136 (DEC-POS-029 a, b y g): edición en línea de FECHA_PLAN, HORAS_ESTIMADAS e HITO_ID desde la capa Semana,
 * apagada por defecto. Solo con PLANIFICACION_EDICION_PROPIETARIO=true exacto y un único correo en
 * PLANIFICACION_EDICION_PROPIETARIO_EMAIL que esté en AUTH_ALLOWED_EMAILS (misma comprobación que DEC-POS-023). Solo
 * decide si la tarjeta muestra el formulario: el guardado usa PATCH /api/operaciones/tareas/{id} sin cambios en el
 * servidor. Solo el propietario la pone en Cloud Run con deploy.sh.
 */
export function planificacionEdicionPropietario(env: NodeJS.ProcessEnv = process.env): string | null {
  return correoPropietario(env.PLANIFICACION_EDICION_PROPIETARIO, env.PLANIFICACION_EDICION_PROPIETARIO_EMAIL, env)
}

/** La sesión es la del propietario con PLANIFICACION_EDICION_PROPIETARIO encendida (ORD-POS-136). */
export function puedeEditarPlanificacion(email: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  const owner = planificacionEdicionPropietario(env)
  return owner !== null && typeof email === 'string' && email.trim().toLowerCase() === owner
}

/** El correo de la sesión es el del propietario con la bandera encendida (para mostrar el botón; el guard lo repite). */
export function puedeCerrarTareas(email: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  const owner = tareasCierrePropietario(env)
  return owner !== null && typeof email === 'string' && email.trim().toLowerCase() === owner
}
