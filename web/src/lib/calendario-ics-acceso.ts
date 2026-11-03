/**
 * Calendario ICS de solo lectura (ORD-POS-142, DEC-POS-029 e y g; contrato en docs/escritura-v1-8.md §11.3). Apagado por
 * defecto: solo con PLANIFICACION_ICS=true exacto, que pone únicamente el propietario con deploy.sh, y con
 * CALENDARIO_ICS_TOKEN_SHA256 (montado desde Secret Manager) distinto de los hashes del PM, de Tiempos y de finanzas.
 * El secreto viaja en la URL (`?token=`); el servidor solo conoce su SHA-256. Solo Web Crypto: lo puede usar el proxy.
 */

export { CALENDARIO_ICS_RUTA } from './calendario-ics-enlace'

const HEX64 = /^[0-9a-f]{64}$/
const normal = (hash: string | undefined) => (hash ?? '').trim().toLowerCase()

/** Bandera del propietario: solo el valor exacto `true`. */
export function planificacionIcsHabilitado(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PLANIFICACION_ICS === 'true'
}

/**
 * Hash esperado del secreto del calendario, o null: bandera apagada, hash sin formato o igual al del PM, al de Tiempos o
 * al del agente de finanzas (ese token abriría el calendario).
 */
export function calendarioIcsTokenHash(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!planificacionIcsHabilitado(env)) return null
  const hash = normal(env.CALENDARIO_ICS_TOKEN_SHA256)
  if (!HEX64.test(hash)) return null
  for (const otro of [env.PM_AGENT_TOKEN_SHA256, env.TIEMPOS_AGENTE_TOKEN_SHA256, env.FINANZAS_AGENTE_TOKEN_SHA256]) {
    if (hash === normal(otro)) return null
  }
  return hash
}

/** Comparación en tiempo constante de dos cadenas hex del mismo largo. */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * El secreto recibido abre el calendario: bandera encendida, hash válido y SHA-256 del secreto igual al hash, comparado
 * en tiempo constante (se comparan los hashes, del mismo largo, nunca el secreto contra un valor guardado).
 */
export async function esSecretoDelCalendario(token: string | null | undefined, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const expected = calendarioIcsTokenHash(env)
  if (!expected || !token || token.length > 512) return false
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  const actual = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
  return sameHex(actual, expected)
}

