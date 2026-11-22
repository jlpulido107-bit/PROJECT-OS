import 'server-only'

import type { PapelSesion } from '../supervision/dictamen'
import { supervisionModeloSesion } from './config'
import { githubClient } from './dispatch'
import { OperationError } from './errors'
import { GitHubError, REPOSITORIOS, repoDeUrl, type GitHubClient } from './github'
import type { OperationContext, OperationResult, OperationsService } from './service'
import type { ModeloSesionCommand } from './validation'

/**
 * Registro del modelo real de una sesión (ORD-POS-165, DEC-POS-039). El dashboard no puede leer el modelo de una sesión:
 * lo lee el PM con `get_session` y lo da de alta aquí. El servidor no confía en el papel ni en el enlace que diga el PM:
 * - la orden tiene un PR abierto registrado y `head` es su head actual en GitHub;
 * - la sesión es una que el dashboard lanzó para la orden: la de revisión o corrección que quedó en AUDITORIA, o la de
 *   implementación del comentario de lanzamiento del issue. De ahí sale el papel. Otra sesión no se registra.
 * Solo alta: nunca edita ni borra, y no cambia la orden.
 */
export async function registrarModeloDeSesion(
  service: OperationsService, cmd: ModeloSesionCommand, ctx: OperationContext, github: GitHubClient | null = githubClient(),
): Promise<OperationResult> {
  // Segunda comprobación de la bandera, además del guard: apagada, nada se registra.
  if (!supervisionModeloSesion() || ctx.agent !== true) throw new OperationError('operacion-no-permitida')
  const o = await service.readOrder(cmd.ordenId)
  if (!o) throw new OperationError('orden-inexistente')
  const proyectoId = o.PROYECTO_ID ?? ''
  const prUrl = o.PR_URL ?? ''
  const repo = REPOSITORIOS[proyectoId]
  if (!['PR_ABIERTO', 'REVISADA'].includes(o.ESTADO ?? '') || !repo || repoDeUrl(prUrl, 'pull') !== repo) throw new OperationError('head-no-vigente')
  if (!github) throw new OperationError('github-no-disponible')
  let papel: PapelSesion | undefined = (await service.sesionesLanzadas(cmd.ordenId)).find((l) => l.sesion === cmd.sesion)?.papel
  try {
    if ((await github.datosDictamen(proyectoId, prUrl)).headSha !== cmd.head) throw new OperationError('head-no-vigente')
    const issueUrl = o.ISSUE_URL ?? ''
    if (!papel && repoDeUrl(issueUrl, 'issues') === repo && await github.lanzamientoPrevio(proyectoId, issueUrl) === cmd.sesion) papel = 'IMPLEMENTACION'
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error
    throw new OperationError('github-no-disponible')
  }
  if (!papel) throw new OperationError('sesion-no-enlazada')
  return service.registrarModeloSesion(cmd, papel, ctx)
}
