import type { Tarea } from './types'

/**
 * Director de Marketing (ORD-POS-170, DEC-POS-038): lectura de sus encargos por GET /api/marketing/encargos con un token
 * propio. Apagado por defecto: la ruta responde 404 sin DIRECTOR_MKT_LECTURA=true exacto, que pone únicamente el
 * propietario con deploy.sh, y el token solo entra con DIRECTOR_MKT_TOKEN_SHA256 (montado desde Secret Manager) distinto
 * de los hashes del PM, de Tiempos, del agente de finanzas y del calendario ICS. No da ningún permiso de escritura.
 * Solo Web Crypto: lo usan el proxy y la ruta.
 */

/** Única ruta del token del Director de Marketing; cualquier método distinto de GET recibe 405. */
export const DIRECTOR_MKT_RUTA = /^\/api\/marketing\/encargos\/?$/

const HEX64 = /^[0-9a-f]{64}$/
const NEXTAUTH_SESSION_COOKIE = /next-auth\.session-token/
const normal = (hash: string | undefined) => (hash ?? '').trim().toLowerCase()

/** Bandera del propietario: solo el valor exacto `true`. */
export function directorMktLecturaHabilitada(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DIRECTOR_MKT_LECTURA === 'true'
}

/** Hash esperado del token, o null: bandera apagada, hash sin formato o igual al de otro token (ese token entraría aquí). */
export function directorMktTokenHash(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!directorMktLecturaHabilitada(env)) return null
  const hash = normal(env.DIRECTOR_MKT_TOKEN_SHA256)
  if (!HEX64.test(hash)) return null
  for (const otro of [env.PM_AGENT_TOKEN_SHA256, env.TIEMPOS_AGENTE_TOKEN_SHA256, env.FINANZAS_AGENTE_TOKEN_SHA256, env.CALENDARIO_ICS_TOKEN_SHA256]) {
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
 * La petición trae `Authorization: Bearer` con el token del Director de Marketing, sin cookie de sesión y con la bandera
 * encendida. No mira ruta ni método: eso lo deciden el proxy y la ruta.
 */
export async function esTokenDelDirectorMkt(headers: Headers, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const expected = directorMktTokenHash(env)
  if (!expected) return false
  if (NEXTAUTH_SESSION_COOKIE.test(headers.get('cookie') ?? '')) return false
  const token = /^Bearer (\S+)$/.exec(headers.get('authorization') ?? '')?.[1]
  if (!token) return false
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  const actual = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
  return sameHex(actual, expected)
}

/** Lo único que sale de cada tarea (criterio 1): sin responsable, notas, versión, bloqueo ni marcas de tiempo. */
export interface EncargoMkt {
  id: string
  titulo: string | null
  estado: string | null
  prioridad: string | null
  fechaPlan: string | null
  fechaLimite: string | null
  descripcion: string | null
}

const RESPONSABLE = 'director de marketing'
const PROYECTOS = new Set(['BOT', 'MESALENTA'])
/** SIG nunca sale, ni siquiera con el responsable correcto (criterio 1: «nada de SIG»). */
const PROYECTO_EXCLUIDO = 'SIG'
const clave = (v: string | null) => (v ?? '').trim()

/** Tareas del Director de Marketing: RESPONSABLE «Director de Marketing» (salvo en SIG) o PROYECTO_ID BOT o MESALENTA. */
export function encargosDelDirectorMkt(tareas: readonly Tarea[]): EncargoMkt[] {
  return tareas
    .filter((t) => {
      const proyecto = clave(t.proyectoId).toUpperCase()
      if (proyecto === PROYECTO_EXCLUIDO) return false
      return PROYECTOS.has(proyecto) || clave(t.responsable).toLowerCase() === RESPONSABLE
    })
    .map((t) => ({
      id: t.id, titulo: t.titulo, estado: t.estado, prioridad: t.prioridad, fechaPlan: t.fechaPlan, fechaLimite: t.fechaLimite,
      descripcion: t.descripcion,
    }))
}
