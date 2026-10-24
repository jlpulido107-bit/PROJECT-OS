import 'server-only'

import { dictamenSuficiente, evaluarDictamen } from '../supervision/dictamen'
import { ORDER_RISKS } from './constants'
import { pmPuedeRegistrarPr } from './config'
import { OperationError } from './errors'
import { routineClient, RoutineError, type RoutineClient } from './claude-routine'
import { createGitHubClient, GitHubError, REPOSITORIOS, repoDeUrl, type GitHubClient } from './github'
import type { OperationContext, OperationResult, OperationsService } from './service'
import { derivedRequestId, partesAutorizacion, type OrderTransitionCommand } from './validation'

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

export function githubClient(env: NodeJS.ProcessEnv = process.env, opciones: { maxLlamadas?: number } = {}): GitHubClient | null {
  const token = env.GITHUB_DISPATCH_TOKEN?.trim()
  return token ? createGitHubClient(token, fetch, opciones) : null
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
  let repetidaPm = false
  if (ctx.agent) {
    // El registro manual de un issue (ENVIAR con url) es del propietario (ORD-POS-059).
    if (cmd.accion === 'enviar' && cmd.url) throw new OperationError('transicion-reservada-pm')
    // ORD-POS-063: REGISTRAR_PR del PM solo con la bandera del propietario y sin url libre (también lo filtra el guard).
    if (cmd.accion === 'registrar_pr' && (cmd.url || !pmPuedeRegistrarPr())) throw new OperationError('transicion-reservada-pm')
    // Un reintento con el mismo requestId se repite sin reevaluar autorización ni dictamen (ORD-POS-059).
    const auditada = await service.autorizacionAuditada(cmd)
    repetidaPm = auditada !== null
    ctx = { ...ctx, autorizacion: auditada ?? await autorizacionPm(service, cmd, client) }
    // El PR registrado es el detectado y auditado en AUTORIZACION (`pr <url> head <sha>`), también al repetir.
    if (cmd.accion === 'registrar_pr') cmd = { ...cmd, url: /^pr (\S+) head /.exec(ctx.autorizacion ?? '')?.[1] ?? null }
  }
  if (cmd.accion === 'enviar' && !cmd.url) {
    // Reintento manual del envío: la orden debe estar APROBADA.
    if (!client) return { operacion: 'orden.enviar', entidad: 'ORDENES_CODEX', id: cmd.ordenId, repetida: repetidaPm, envio: { ok: false, codigo: 'sin-token' } }
    const envio = await enviar(service, client, cmd.ordenId, cmd.requestId, ctx)
    if (!envio.ok && envio.codigo === 'orden-no-aprobada') throw new OperationError('transicion-no-permitida')
    return { operacion: 'orden.enviar', entidad: 'ORDENES_CODEX', id: cmd.ordenId, repetida: repetidaPm, envio, ...(await alEnviar(service, cmd.ordenId, envio, client, rutina)) }
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
 * DEC-POS-011: el agente PM aprueba o envía solo con el «sí» citado y nunca una orden de riesgo ALTO; marca REVISADA solo
 * con un dictamen CONFORME suficiente del head actual (el que /ordenes da por listo), releído en GitHub. Devuelve lo que se audita como AUTORIZACION; no escribe.
 */
async function autorizacionPm(service: OperationsService, cmd: OrderTransitionCommand, client: GitHubClient | null): Promise<string> {
  if (!['aprobar', 'enviar', 'revisar', 'registrar_pr'].includes(cmd.accion)) throw new OperationError('transicion-reservada-pm')
  const o = await service.readOrder(cmd.ordenId)
  if (!o) throw new OperationError('orden-inexistente')
  if (cmd.accion === 'registrar_pr') return prDetectadoPm(o.PROYECTO_ID ?? '', cmd.ordenId, client)
  if (cmd.accion !== 'revisar') {
    if (!cmd.autorizacion) throw new OperationError('validacion', { fields: { autorizacion: 'Requerido para el agente PM' } })
    if (!(ORDER_RISKS as readonly string[]).includes((o.RIESGO ?? '').toUpperCase())) throw new OperationError('riesgo-alto-pm')
    // ORD-POS-059: el ID de esta orden, «sí» con tilde como palabra y la fecha de hoy en Mérida con un día de margen.
    const a = partesAutorizacion(cmd.autorizacion)
    const dias = a ? Math.abs(Date.parse(`${a.fecha}T00:00:00Z`) - Date.parse(`${service.hoy()}T00:00:00Z`)) / 86_400_000 : Infinity
    if (!a || a.ordenId !== cmd.ordenId || !/(?:^|\P{L})sí(?:\P{L}|$)/iu.test(a.cita) || dias > 1) throw new OperationError('autorizacion-no-valida')
    if (await service.citaUsadaEnOtraOrden(`«${a.cita}» ${a.fecha}`, cmd.ordenId)) throw new OperationError('autorizacion-no-valida')
    return cmd.autorizacion
  }
  const repo = REPOSITORIOS[o.PROYECTO_ID ?? '']
  const numero = /\/pull\/(\d+)$/.exec(o.PR_URL ?? '')?.[1]
  if (!repo || !numero || repoDeUrl(o.PR_URL ?? '', 'pull') !== repo) throw new OperationError('dictamen-no-valido')
  if (!client) throw new OperationError('github-no-disponible')
  let datos: Awaited<ReturnType<GitHubClient['datosDictamen']>>
  try {
    datos = await client.datosDictamen(o.PROYECTO_ID!, o.PR_URL!)
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error
    throw new OperationError('github-no-disponible')
  }
  const ev = evaluarDictamen(datos, { id: cmd.ordenId, riesgo: o.RIESGO ?? null, criterios: o.CRITERIOS_ACEPTACION ?? null }, { repo, numero: Number(numero) })
  if (ev.estado.tipo !== 'vigente') throw new OperationError('dictamen-no-valido')
  if (!dictamenSuficiente(ev)) throw new OperationError('dictamen-insuficiente')
  return `dictamen ${ev.estado.dictamen.veredicto} head ${datos.headSha} comentario ${ev.estado.dictamen.comentarioId}`
}

/**
 * ORD-POS-063: el PR que /ordenes detecta (prDeOrden), solo si es el único de la orden y está abierto. Devuelve lo que se
 * audita como AUTORIZACION, con la URL y el head; no escribe. El estado ENVIADA lo exige la transición.
 */
async function prDetectadoPm(proyectoId: string, ordenId: string, client: GitHubClient | null): Promise<string> {
  if (!proyectoId) throw new OperationError('orden-sin-proyecto')
  if (!client) throw new OperationError('github-no-disponible')
  let r: Awaited<ReturnType<GitHubClient['prDetectadoDeOrden']>>
  try {
    r = await client.prDetectadoDeOrden(proyectoId, ordenId)
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error
    throw new OperationError('github-no-disponible')
  }
  if (!r.pr || r.total !== 1 || r.pr.estado !== 'abierto') throw new OperationError('pr-no-detectado')
  return `pr ${r.pr.url} head ${r.pr.headSha}`
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
