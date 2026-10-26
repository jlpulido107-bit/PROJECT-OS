import 'server-only'

import { todayInMerida } from '../dates'
import { ORDENES_SENSIBLE } from '../schema'
import { evaluarDictamen, type PlanLanzamiento } from '../supervision/dictamen'
import { rutinasSupervision, RoutineError, textoSupervision, type RutinasSupervision } from './claude-routine'
import { githubClient } from './dispatch'
import { OperationError } from './errors'
import { GitHubError, REPOSITORIOS, repoDeUrl, type GitHubClient } from './github'
import type { OperationContext, OperationsService } from './service'
import { payloadHash, type LanzarSupervisionCommand } from './validation'

/**
 * «Lanzar revisión» y «Pedir corrección» desde /ordenes (ORD-POS-037). El servidor vuelve a leer la orden y el PR en
 * GitHub, recalcula qué toca (dictamenes del PR) y solo lanza si coincide con lo que el propietario vio. El texto de la
 * rutina sale únicamente de datos validados o derivados; el token nunca sale de claude-routine.ts.
 */

export interface SupervisionInfo {
  ok: boolean
  sessionUrl?: string
  /** true si se lanzó ahora; false si el mismo requestId ya había lanzado esta sesión. */
  nueva?: boolean
  /** 'sin-rutina', 'head-cambio', 'sin-accion', 'correlativo-agotado', 'resultado-incierto', 'http-429', 'red', 'auditoria-pendiente'… (nunca cuerpos de respuesta). */
  codigo?: string
}

/** Clave de un paso de supervisión (ORD-POS-039): orden + acción + head + correlativo del plan. */
export function claveLanzamiento(ordenId: string, plan: PlanLanzamiento): string {
  return `${ordenId}|${plan.tipo === 'CORREGIR' ? 'corregir' : 'revisar'}|${plan.headSha}|${plan.n}`
}

const enCurso = new Map<string, Promise<SupervisionInfo>>()

export function lanzarSupervision(
  service: OperationsService, cmd: LanzarSupervisionCommand, ctx: OperationContext,
  { github = githubClient(), rutinas = rutinasSupervision() }: { github?: GitHubClient | null; rutinas?: RutinasSupervision } = {},
): Promise<SupervisionInfo> {
  // Por orden y acción: revisar y corregir concurrentes no comparten resultado (ORD-POS-045).
  const k = `${cmd.ordenId}|${cmd.accion}`
  const running = enCurso.get(k)
  if (running) return running
  const p = lanzarUnaVez(service, cmd, ctx, github, rutinas).finally(() => enCurso.delete(k))
  enCurso.set(k, p)
  return p
}

async function lanzarUnaVez(
  service: OperationsService, cmd: LanzarSupervisionCommand, ctx: OperationContext, github: GitHubClient | null, rutinas: RutinasSupervision,
): Promise<SupervisionInfo> {
  const op = cmd.accion === 'corregir' ? 'orden.corregir_lanzar' : 'orden.revisar_lanzar'
  const hash = payloadHash(op, { ordenId: cmd.ordenId, headEsperado: cmd.headEsperado })
  const previa = await service.sesionLanzada(op, cmd.requestId, hash, cmd.ordenId)
  if (previa) return { ok: true, sessionUrl: previa, nueva: false }
  if (!github) return { ok: false, codigo: 'sin-token' }
  const o = await service.readOrder(cmd.ordenId)
  if (!o) return { ok: false, codigo: 'orden-inexistente' }
  const proyectoId = o.PROYECTO_ID ?? ''
  const prUrl = o.PR_URL ?? ''
  const repo = REPOSITORIOS[proyectoId]
  if (!['PR_ABIERTO', 'REVISADA'].includes(o.ESTADO ?? '') || !repo || repoDeUrl(prUrl, 'pull') !== repo) return { ok: false, codigo: 'orden-sin-pr' }
  let plan: PlanLanzamiento | null
  try {
    const datos = await github.datosDictamen(proyectoId, prUrl)
    const ev = evaluarDictamen(datos, { id: cmd.ordenId, riesgo: o.RIESGO ?? null, criterios: o.CRITERIOS_ACEPTACION ?? null, sensible: o[ORDENES_SENSIBLE] ?? null }, { repo, numero: Number(/\/pull\/(\d+)$/.exec(prUrl)![1]) })
    if (ev.agotado) return { ok: false, codigo: 'correlativo-agotado' }
    plan = ev.plan
  } catch (error) {
    return fallo(error)
  }
  if (!plan || (plan.tipo === 'CORREGIR') !== (cmd.accion === 'corregir')) return { ok: false, codigo: 'sin-accion' }
  if (plan.headSha !== cmd.headEsperado) return { ok: false, codigo: 'head-cambio' }
  const rutina = plan.tipo === 'CORREGIR' ? rutinas.corregir : plan.tipo === 'SEGUNDO' ? rutinas.segundo : rutinas.revisar
  if (!rutina) return { ok: false, codigo: 'sin-rutina' }
  // Una sola sesión por paso, con cualquier requestId: reserva auditada antes de disparar; si no se puede, no se dispara.
  const clave = claveLanzamiento(cmd.ordenId, plan)
  let reserva
  try {
    reserva = await service.reservarLanzamiento(cmd.ordenId, clave, ctx)
  } catch (error) {
    if (error instanceof OperationError) return { ok: false, codigo: error.code }
    throw error
  }
  if (reserva.tipo === 'lanzada') return { ok: true, sessionUrl: reserva.sesion, nueva: false }
  if (reserva.tipo === 'reservada' || reserva.tipo === 'sesion-invalida') return { ok: false, codigo: 'resultado-incierto' }
  let sessionUrl: string
  try {
    const comun = { ordenId: cmd.ordenId, proyectoId, prUrl, headSha: plan.headSha, n: plan.n, ronda: plan.ronda, intento: plan.intento, desde: todayInMerida() }
    const texto = plan.tipo === 'CORREGIR'
      ? textoSupervision({ ...comun, hallazgosUrl: `${prUrl}#issuecomment-${plan.comentarioId}` })
      : textoSupervision({ ...comun, rol: plan.tipo })
    sessionUrl = (await rutina.lanzar(texto)).sessionUrl
  } catch (error) {
    // 4xx: la rutina rechazó la petición y no lanzó nada; se libera el paso. Con 5xx, red o tiempo la reserva sigue.
    if (error instanceof RoutineError && typeof error.status === 'number' && error.status >= 400 && error.status < 500) {
      await service.liberarLanzamiento(cmd.ordenId, clave, ctx).catch(() => console.warn('[project-os] reserva sin liberar'))
    }
    return fallo(error)
  }
  try {
    await service.registrarLanzamiento(op, cmd.requestId, hash, cmd.ordenId, sessionUrl, ctx, clave)
  } catch (error) {
    // La sesión ya corre: no se pierde el enlace, pero tampoco se finge que quedó auditada.
    console.warn(`[project-os] lanzamiento sin auditoría: ${error instanceof OperationError ? error.code : 'desconocido'}`)
    return { ok: true, sessionUrl, nueva: true, codigo: 'auditoria-pendiente' }
  }
  return { ok: true, sessionUrl, nueva: true }
}

function fallo(error: unknown): SupervisionInfo {
  if (error instanceof RoutineError || error instanceof GitHubError) {
    const codigo = typeof error.status === 'number' ? `http-${error.status}` : error.status
    console.warn(`[project-os] lanzamiento de revisión o corrección fallido: ${codigo}`)
    return { ok: false, codigo }
  }
  throw error
}
