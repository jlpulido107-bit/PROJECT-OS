import 'server-only'

import { createHash } from 'node:crypto'
import { OperationError } from './errors'
import { createGitHubClient, GitHubError, type GitHubClient } from './github'
import type { OperationContext, OperationResult, OperationsService } from './service'
import type { OrderTransitionCommand } from './validation'

/**
 * Aprobar y crear el issue en un paso (V1.8 F4). La aprobación se guarda primero; si el envío a GitHub falla, la orden
 * queda APROBADA y el dashboard ofrece «Crear el issue» para reintentar (el envío es idempotente por ORDEN_ID).
 */

export interface EnvioInfo {
  ok: boolean
  issueUrl?: string
  creado?: boolean
  /** Código sin datos: 'sin-token', 'repo-no-permitido', 'red', 'http-403', 'orden-no-aprobada'… */
  codigo?: string
}

export type ResultadoConEnvio = OperationResult & { envio?: EnvioInfo }

export function githubClient(env: NodeJS.ProcessEnv = process.env): GitHubClient | null {
  const token = env.GITHUB_DISPATCH_TOKEN?.trim()
  return token ? createGitHubClient(token) : null
}

/** requestId v4 determinista derivado de otro (para que reintentar el envío no duplique la transición). */
export function derivedRequestId(requestId: string, salt: string): string {
  const h = createHash('sha256').update(`${salt}:${requestId}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[parseInt(h[16]!, 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/**
 * Un solo envío en curso por orden en este proceso (maxScale 1 ⇒ escritor único): un reintento o una segunda pestaña
 * esperan al envío en curso en vez de crear otro issue.
 */
const enCurso = new Map<string, Promise<EnvioInfo>>()

function enviar(
  service: OperationsService, client: GitHubClient, ordenId: string, requestId: string, ctx: OperationContext,
): Promise<EnvioInfo> {
  const running = enCurso.get(ordenId)
  if (running) return running
  const p = enviarUnaVez(service, client, ordenId, requestId, ctx).finally(() => enCurso.delete(ordenId))
  enCurso.set(ordenId, p)
  return p
}

async function enviarUnaVez(
  service: OperationsService, client: GitHubClient, ordenId: string, requestId: string, ctx: OperationContext,
): Promise<EnvioInfo> {
  const o = await service.readOrder(ordenId)
  if (!o) return { ok: false, codigo: 'orden-inexistente' }
  // Reintento de una aprobación que ya se envió: informar el envío existente, no un fallo.
  if (o.ESTADO === 'ENVIADA' && o.ISSUE_URL) return { ok: true, issueUrl: o.ISSUE_URL, creado: false }
  if (o.ESTADO !== 'APROBADA') return { ok: false, codigo: 'orden-no-aprobada' }
  try {
    const r = await client.enviar({
      ordenId, proyectoId: o.PROYECTO_ID ?? '', tareaId: o.TAREA_ID ?? '', titulo: o.TITULO ?? '', objetivo: o.OBJETIVO ?? '',
      contexto: o.CONTEXTO ?? '', criterios: o.CRITERIOS_ACEPTACION ?? '', fueraDeAlcance: o.FUERA_DE_ALCANCE ?? '',
      comoProbar: o.COMO_PROBAR ?? '', riesgo: o.RIESGO ?? 'BAJO',
    })
    await service.transitionOrder({
      requestId: derivedRequestId(requestId, 'enviar'), ordenId, accion: 'enviar', expectedEstado: 'APROBADA', motivo: null, url: r.issueUrl,
    }, ctx)
    return { ok: true, issueUrl: r.issueUrl, creado: r.creado }
  } catch (error) {
    if (error instanceof GitHubError) {
      console.warn(`[project-os] envío a GitHub fallido: ${typeof error.status === 'number' ? `http-${error.status}` : error.status}`)
      return { ok: false, codigo: typeof error.status === 'number' ? `http-${error.status}` : error.status }
    }
    if (error instanceof OperationError) return { ok: false, codigo: error.code }
    throw error
  }
}

/** Ejecuta la transición pedida y, si corresponde, el envío a GitHub. */
export async function transitionWithDispatch(
  service: OperationsService, cmd: OrderTransitionCommand, ctx: OperationContext,
  client: GitHubClient | null = githubClient(),
): Promise<ResultadoConEnvio> {
  if (cmd.accion === 'enviar' && !cmd.url) {
    // Reintento manual del envío: la orden debe estar APROBADA.
    if (!client) return { operacion: 'orden.enviar', entidad: 'ORDENES_CODEX', id: cmd.ordenId, repetida: false, envio: { ok: false, codigo: 'sin-token' } }
    const envio = await enviar(service, client, cmd.ordenId, cmd.requestId, ctx)
    if (!envio.ok && envio.codigo === 'orden-no-aprobada') throw new OperationError('transicion-no-permitida')
    return { operacion: 'orden.enviar', entidad: 'ORDENES_CODEX', id: cmd.ordenId, repetida: false, envio }
  }
  const result = await service.transitionOrder(cmd, ctx)
  if (cmd.accion !== 'aprobar') return result
  if (!client) return { ...result, envio: { ok: false, codigo: 'sin-token' } }
  return { ...result, envio: await enviar(service, client, cmd.ordenId, cmd.requestId, ctx) }
}
