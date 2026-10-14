/**
 * Ejecución automática de órdenes con Claude (V1.8 F5a, docs/rutina-claude.md).
 *
 * El dashboard «llama» a una rutina de Claude Code (claude.ai/code → Routines) por su disparador de API. La rutina abre
 * una sesión en la nube con los 3 repositorios y ejecuta la orden con `/ejecutar-orden` hasta el PR.
 *
 * - El token es de la rutina (no es una clave de la API de Anthropic) y vive en Secret Manager:
 *   CLAUDE_ROUTINE_TOKEN. El ID de la rutina no es secreto: CLAUDE_ROUTINE_ID.
 * - El texto enviado lleva solo datos validados (ID de orden y URL del issue del repositorio del proyecto). La rutina lee
 *   la orden en el issue y comprueba allí su autor y su título; nunca recibe texto libre de la hoja.
 * - Errores sin cuerpo: solo el estado HTTP. Nunca se registra el token.
 */

import { REPOSITORIOS, repoDeUrl } from './github'

const API = 'https://api.anthropic.com/v1/claude_code/routines'
const TIMEOUT_MS = 20_000
const ROUTINE_ID = /^[A-Za-z0-9_-]{8,80}$/
const ORDEN_ID = /^ORD-(POS|SIG|ECO)-\d{3,}$/
const SESSION_URL = /^https:\/\/claude\.ai\/code\/[A-Za-z0-9_/-]{1,200}$/

export class RoutineError extends Error {
  constructor(readonly status: number | 'red' | 'respuesta-invalida' | 'datos-invalidos') {
    super(`rutina ${status}`)
  }
}

export interface EjecucionOrden {
  ordenId: string
  proyectoId: string
  issueUrl: string
}

/** Texto para el bloque `routine-fire-payload`: solo datos validados. Lanza RoutineError si algo no cuadra. */
export function textoRutina(e: EjecucionOrden): string {
  const repo = REPOSITORIOS[e.proyectoId]
  if (!ORDEN_ID.test(e.ordenId) || !repo || !e.ordenId.startsWith(`ORD-${e.proyectoId}-`) || repoDeUrl(e.issueUrl, 'issues') !== repo) {
    throw new RoutineError('datos-invalidos')
  }
  return [`ORDEN_ID: ${e.ordenId}`, `REPOSITORIO: ${repo}`, `ISSUE: ${e.issueUrl}`].join('\n')
}

export function createRoutineClient(routineId: string, token: string, fetchImpl: typeof fetch = fetch) {
  if (!ROUTINE_ID.test(routineId)) throw new RoutineError('datos-invalidos')
  return {
    /** Lanza una ejecución y devuelve la URL de la sesión de Claude Code. */
    async ejecutar(e: EjecucionOrden): Promise<{ sessionUrl: string }> {
      const text = textoRutina(e)
      let response: Response
      try {
        response = await fetchImpl(`${API}/${routineId}/fire`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'anthropic-beta': 'experimental-cc-routine-2026-04-01',
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ text }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
          cache: 'no-store',
        })
      } catch {
        throw new RoutineError('red')
      }
      if (!response.ok) throw new RoutineError(response.status)
      let body: { claude_code_session_url?: unknown }
      try {
        body = (await response.json()) as typeof body
      } catch {
        throw new RoutineError('respuesta-invalida')
      }
      const url = typeof body.claude_code_session_url === 'string' ? body.claude_code_session_url : ''
      if (!SESSION_URL.test(url)) throw new RoutineError('respuesta-invalida')
      return { sessionUrl: url }
    },
  }
}

export type RoutineClient = ReturnType<typeof createRoutineClient>

/** Cliente de la rutina si está configurada (ID válido y token); null si no. */
export function routineClient(env: NodeJS.ProcessEnv = process.env): RoutineClient | null {
  const id = env.CLAUDE_ROUTINE_ID?.trim()
  const token = env.CLAUDE_ROUTINE_TOKEN?.trim()
  if (!id || !token || !ROUTINE_ID.test(id)) return null
  return createRoutineClient(id, token)
}
