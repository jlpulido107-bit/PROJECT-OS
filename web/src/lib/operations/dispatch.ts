import 'server-only'

import { OperationError } from './errors'
import { routineClient, RoutineError, type RoutineClient } from './claude-routine'
import { createGitHubClient, GitHubError, type GitHubClient } from './github'
import type { OperationContext, OperationResult, OperationsService } from './service'
import { derivedRequestId, type OrderTransitionCommand } from './validation'

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

/** Resultado de lanzar a Claude (F5a). Sin datos sensibles: la URL de la sesión es privada de la cuenta del propietario. */
export interface EjecucionInfo {
  ok: boolean
  sessionUrl?: string
  /** true si se lanzó ahora; false si ya había una sesión lanzada para el issue. */
  nueva?: boolean
  /** 'sin-rutina', 'sin-token', 'orden-no-enviada', 'orden-inexistente', 'http-429', 'red'… */
  codigo?: string
}

export type ResultadoConEnvio = OperationResult & { envio?: EnvioInfo; ejecucion?: EjecucionInfo }

export function githubClient(env: NodeJS.ProcessEnv = process.env): GitHubClient | null {
  const token = env.GITHUB_DISPATCH_TOKEN?.trim()
  return token ? createGitHubClient(token) : null
}

export { derivedRequestId }

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

const ejecutando = new Map<string, Promise<EjecucionInfo>>()

/**
 * Lanza a Claude sobre una orden ENVIADA (F5a). Sin `forzar`, si el issue ya tiene una sesión lanzada por el dashboard,
 * la devuelve en vez de lanzar otra. Una sola ejecución en curso por orden en este proceso (escritor único).
 */
export function ejecutarConClaude(
  service: OperationsService, ordenId: string,
  { github = githubClient(), rutina = routineClient(), forzar = false }: { github?: GitHubClient | null; rutina?: RoutineClient | null; forzar?: boolean } = {},
): Promise<EjecucionInfo> {
  const running = ejecutando.get(ordenId)
  if (running) return running
  const p = ejecutarUnaVez(service, ordenId, github, rutina, forzar).finally(() => ejecutando.delete(ordenId))
  ejecutando.set(ordenId, p)
  return p
}

async function ejecutarUnaVez(
  service: OperationsService, ordenId: string, github: GitHubClient | null, rutina: RoutineClient | null, forzar: boolean,
): Promise<EjecucionInfo> {
  if (!rutina) return { ok: false, codigo: 'sin-rutina' }
  if (!github) return { ok: false, codigo: 'sin-token' }
  const o = await service.readOrder(ordenId)
  if (!o) return { ok: false, codigo: 'orden-inexistente' }
  const proyectoId = o.PROYECTO_ID ?? ''
  const issueUrl = o.ISSUE_URL ?? ''
  if (o.ESTADO !== 'ENVIADA' || !issueUrl) return { ok: false, codigo: 'orden-no-enviada' }
  try {
    if (!forzar) {
      const previa = await github.lanzamientoPrevio(proyectoId, issueUrl)
      if (previa) return { ok: true, sessionUrl: previa, nueva: false }
    }
    const { sessionUrl } = await rutina.ejecutar({ ordenId, proyectoId, issueUrl })
    try {
      await github.registrarLanzamiento(proyectoId, issueUrl, sessionUrl)
    } catch {
      // La sesión ya corre; si no queda constancia en el issue, solo se pierde la detección de duplicados.
      console.warn('[project-os] no se pudo registrar el lanzamiento de Claude en el issue')
    }
    return { ok: true, sessionUrl, nueva: true }
  } catch (error) {
    if (error instanceof RoutineError || error instanceof GitHubError) {
      const codigo = typeof error.status === 'number' ? `http-${error.status}` : error.status
      console.warn(`[project-os] lanzamiento de Claude fallido: ${codigo}`)
      return { ok: false, codigo }
    }
    throw error
  }
}

/** Ejecuta la transición pedida y, si corresponde, el envío a GitHub. */
export async function transitionWithDispatch(
  service: OperationsService, cmd: OrderTransitionCommand, ctx: OperationContext,
  client: GitHubClient | null = githubClient(),
  rutina: RoutineClient | null = routineClient(),
): Promise<ResultadoConEnvio> {
  if (cmd.accion === 'enviar' && !cmd.url) {
    // Reintento manual del envío: la orden debe estar APROBADA.
    if (!client) return { operacion: 'orden.enviar', entidad: 'ORDENES_CODEX', id: cmd.ordenId, repetida: false, envio: { ok: false, codigo: 'sin-token' } }
    const envio = await enviar(service, client, cmd.ordenId, cmd.requestId, ctx)
    if (!envio.ok && envio.codigo === 'orden-no-aprobada') throw new OperationError('transicion-no-permitida')
    return { operacion: 'orden.enviar', entidad: 'ORDENES_CODEX', id: cmd.ordenId, repetida: false, envio, ...(await alEnviar(service, cmd.ordenId, envio, client, rutina)) }
  }
  if (cmd.accion === 'cerrar_fusionado') {
    const url = (await service.prUrlCierreAuditado(cmd.requestId, cmd.ordenId)) ?? (await prFusionado(service, cmd.ordenId, client))
    return service.transitionOrder({ ...cmd, url }, ctx)
  }
  const result = await service.transitionOrder(cmd, ctx)
  if (cmd.accion !== 'aprobar') return result
  if (!client) return { ...result, envio: { ok: false, codigo: 'sin-token' } }
  const envio = await enviar(service, client, cmd.ordenId, cmd.requestId, ctx)
  return { ...result, envio, ...(await alEnviar(service, cmd.ordenId, envio, client, rutina)) }
}

/**
 * Cierre asistido (ORD-POS-046): relee en GitHub el PR registrado o detectado de la orden. Solo un PR fusionado cuyo
 * título empieza por `[ORDEN_ID]` permite cerrar; devuelve su URL para PR_URL. Nunca cierra sin el clic del propietario.
 */
async function prFusionado(service: OperationsService, ordenId: string, client: GitHubClient | null): Promise<string> {
  if (!client) throw new OperationError('github-no-disponible')
  const o = await service.readOrder(ordenId)
  if (!o) throw new OperationError('orden-inexistente')
  if (!o.PROYECTO_ID) throw new OperationError('orden-sin-proyecto')
  let pr: Awaited<ReturnType<GitHubClient['prParaCierre']>>
  try {
    pr = await client.prParaCierre(o.PROYECTO_ID, ordenId, o.PR_URL || null)
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error
    console.warn(`[project-os] lectura del PR para el cierre fallida: ${typeof error.status === 'number' ? `http-${error.status}` : error.status}`)
    throw new OperationError('github-no-disponible')
  }
  if (!pr?.fusionado || !pr.deLaOrden) throw new OperationError('pr-no-fusionado')
  return pr.url
}

/** Con la rutina configurada, una orden recién enviada se ejecuta sola: aprobar = llamar a Claude (F5a). */
async function alEnviar(
  service: OperationsService, ordenId: string, envio: EnvioInfo, github: GitHubClient, rutina: RoutineClient | null,
): Promise<{ ejecucion?: EjecucionInfo }> {
  if (!envio.ok || !rutina) return {}
  return { ejecucion: await ejecutarConClaude(service, ordenId, { github, rutina }) }
}
