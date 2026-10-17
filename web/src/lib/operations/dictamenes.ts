import { cacheSeconds } from '../config'
import { evaluarDictamen, type EvaluacionDictamen, type DatosPr } from '../supervision/dictamen'
import { REPOSITORIOS, repoDeUrl, type GitHubClient } from './github'

/**
 * Dictamen vigente de las órdenes con PR (DEC-POS-009), leído de GitHub con el cliente existente. Solo lectura. Los datos
 * de GitHub se guardan en memoria DASHBOARD_CACHE_SECONDS; si GitHub falla o tarda, devuelve null («Sin datos de GitHub») y
 * guarda el fallo FALLO_MS por PR para no esperar en cada carga.
 */

const LIMITE_MS = 20_000
const FALLO_MS = 60_000
const cache = new Map<string, { hasta: number; datos: DatosPr | null }>()

export interface OrdenConPr { id: string; proyectoId: string | null; prUrl: string | null; riesgo: string | null; criterios: string | null }

export function limpiarCacheDictamenes(): void { cache.clear() }

/** URL del comentario, armada con la del PR (nunca la que devuelve la API). */
export const urlComentario = (prUrl: string, id: number): string | null =>
  repoDeUrl(prUrl, 'pull') ? `${prUrl}#issuecomment-${id}` : null

export async function dictamenDeOrden(client: GitHubClient, o: OrdenConPr, ahora = Date.now()): Promise<EvaluacionDictamen | null> {
  const repo = o.proyectoId ? REPOSITORIOS[o.proyectoId] : undefined
  if (!repo || !o.prUrl || repoDeUrl(o.prUrl, 'pull') !== repo) return null
  const prUrl = o.prUrl
  let entrada = cache.get(prUrl)
  if (!entrada || entrada.hasta <= ahora) {
    try {
      const leidos = await Promise.race([
        client.datosDictamen(o.proyectoId!, prUrl),
        new Promise<never>((_, rechazar) => setTimeout(() => rechazar(new Error('tiempo')), LIMITE_MS).unref?.()),
      ])
      entrada = { hasta: ahora + cacheSeconds() * 1000, datos: leidos }
    } catch {
      entrada = { hasta: ahora + FALLO_MS, datos: null }
    }
    cache.set(prUrl, entrada)
  }
  return entrada.datos && evaluarDictamen(entrada.datos, o, { repo, numero: Number(/\/pull\/(\d+)$/.exec(prUrl)![1]) })
}
