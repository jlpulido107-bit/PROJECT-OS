/**
 * Rol Tiempos (ORD-POS-112, DEC-POS-025 PENDIENTE, DEC-POS-014): lectura de /api/planificacion con un token propio, solo
 * GET. Apagado por defecto: el token entra solo con TIEMPOS_AGENTE=true exacto, que pone únicamente el propietario con
 * deploy.sh, y con TIEMPOS_AGENTE_TOKEN_SHA256 (montado desde Secret Manager) distinto de PM_AGENT_TOKEN_SHA256 y de
 * FINANZAS_AGENTE_TOKEN_SHA256. La misma bandera habilita `tiempo.crear` del PM (guard de operaciones).
 * Solo Web Crypto: lo usan el proxy y la ruta.
 */

/** Única ruta del token de Tiempos; cualquier método distinto de GET recibe 405. */
export const TIEMPOS_AGENTE_RUTA = /^\/api\/planificacion\/?$/

const HEX64 = /^[0-9a-f]{64}$/
const NEXTAUTH_SESSION_COOKIE = /next-auth\.session-token/
const normal = (hash: string | undefined) => (hash ?? '').trim().toLowerCase()

/** Bandera del propietario: solo el valor exacto `true`. */
export function tiemposAgenteHabilitado(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TIEMPOS_AGENTE === 'true'
}

/**
 * Hash esperado del token de Tiempos, o null: bandera apagada, hash sin formato o igual al del PM o al del agente de
 * finanzas (ese token entraría aquí).
 */
export function tiemposAgenteTokenHash(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!tiemposAgenteHabilitado(env)) return null
  const hash = normal(env.TIEMPOS_AGENTE_TOKEN_SHA256)
  if (!HEX64.test(hash)) return null
  if (hash === normal(env.PM_AGENT_TOKEN_SHA256) || hash === normal(env.FINANZAS_AGENTE_TOKEN_SHA256)) return null
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
 * La petición trae `Authorization: Bearer` con el token de Tiempos, sin cookie de sesión y con la bandera encendida.
 * No mira ruta ni método: eso lo deciden el proxy y la ruta.
 */
export async function esTokenDeTiempos(headers: Headers, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const expected = tiemposAgenteTokenHash(env)
  if (!expected) return false
  if (NEXTAUTH_SESSION_COOKIE.test(headers.get('cookie') ?? '')) return false
  const token = /^Bearer (\S+)$/.exec(headers.get('authorization') ?? '')?.[1]
  if (!token) return false
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  const actual = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
  return sameHex(actual, expected)
}
