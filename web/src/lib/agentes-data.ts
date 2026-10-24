import 'server-only'

import { proyectoDeOrden, type DictamenesPr } from './agentes'
import { cacheSeconds } from './config'
import { datosDePr } from './operations/dictamenes'
import { codigoFalloGitHub, REPOSITORIOS, type GitHubClient, type PrFusion } from './operations/github'
import { dictamenesValidos } from './supervision/dictamen'
import type { Orden } from './types'

/**
 * Lecturas de GitHub para /agentes (ORD-POS-078). Solo lectura con el cliente existente (GET). Los PRs de cada
 * repositorio se guardan DASHBOARD_CACHE_SECONDS; un fallo se guarda FALLO_MS y deja ese proyecto «sin datos». Los
 * comentarios de cada PR usan la caché de dictamenes.ts (la misma que /ordenes).
 */

const LIMITE_MS = 20_000
const FALLO_MS = 60_000
/** Lecturas de PR en paralelo como máximo, para no ráfagas contra la API de GitHub. */
const PARALELO = 6
const cache = new Map<string, { hasta: number; prs: Map<string, PrFusion> | null }>()

export function limpiarCacheAgentes(): void { cache.clear() }

const conLimite = <T,>(p: Promise<T>) => Promise.race([
  p,
  new Promise<never>((_, rechazar) => setTimeout(() => rechazar(new Error('tiempo')), LIMITE_MS).unref?.()),
])

/** PRs de órdenes por proyecto con repositorio; null en el proyecto cuyo GitHub falló. */
export async function prsPorProyecto(client: GitHubClient, proyecto: string | null, ahora = Date.now()): Promise<Record<string, Map<string, PrFusion> | null>> {
  const proyectos = Object.keys(REPOSITORIOS).filter((p) => proyecto === null || p === proyecto)
  const salida: Record<string, Map<string, PrFusion> | null> = {}
  await Promise.all(proyectos.map(async (p) => {
    let entrada = cache.get(p)
    if (!entrada || entrada.hasta <= ahora) {
      try {
        entrada = { hasta: ahora + cacheSeconds() * 1000, prs: await conLimite(client.prsDeOrdenes(p)) }
      } catch (error) {
        console.warn(`[project-os] /agentes: lectura de PRs fallida: ${codigoFalloGitHub(error)}`)
        entrada = { hasta: ahora + FALLO_MS, prs: null }
      }
      cache.set(p, entrada)
    }
    salida[p] = entrada.prs
  }))
  return salida
}

/** Dictámenes válidos del PR detectado de cada orden (null si no se pudo leer). */
export async function dictamenesDeOrdenes(
  client: GitHubClient, ordenes: Orden[], prs: Record<string, Map<string, PrFusion> | null>,
): Promise<Map<string, DictamenesPr>> {
  const pendientes = ordenes.flatMap((o) => {
    const proyectoId = proyectoDeOrden(o)
    const pr = proyectoId ? prs[proyectoId]?.get(o.id) : undefined
    return pr && proyectoId ? [{ o, proyectoId, pr }] : []
  })
  const salida = new Map<string, DictamenesPr>()
  let i = 0
  const trabajador = async () => {
    while (i < pendientes.length) {
      const { o, proyectoId, pr } = pendientes[i++]!
      const orden = { id: o.id, proyectoId, prUrl: pr.url, riesgo: o.riesgo, criterios: o.criterios }
      const leido = await datosDePr(client, orden)
      salida.set(o.id, leido && dictamenesValidos(leido.datos, orden, leido.pr))
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALELO, pendientes.length) }, trabajador))
  return salida
}
