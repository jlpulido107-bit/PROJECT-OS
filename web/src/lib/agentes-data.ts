import 'server-only'

import { leeDictamen, proyectoDeOrden, type DictamenesPr } from './agentes'
import { cacheSeconds } from './config'
import { datosDePr } from './operations/dictamenes'
import { codigoFalloGitHub, REPOSITORIOS, type GitHubClient, type PrFusion, type PrsDeOrdenes } from './operations/github'
import { dictamenesValidos } from './supervision/dictamen'
import type { Orden } from './types'

/**
 * Lecturas de GitHub para /agentes (ORD-POS-078, ORD-POS-080). Solo lectura con el cliente existente (GET). Los PRs de
 * cada repositorio se guardan DASHBOARD_CACHE_SECONDS; un fallo se guarda FALLO_MS y deja ese proyecto «sin datos». Los
 * comentarios de cada PR usan la caché de dictamenes.ts (la misma que /ordenes).
 *
 * El límite de GitHub (5000/h) es compartido con /ordenes y el despacho (ORD-POS-080): la página usa un cliente con tope
 * de LLAMADAS_AGENTES llamadas por carga, solo lee dictámenes de órdenes que no están CERRADA ni CANCELADA (las más
 * recientes primero) y tiene un tiempo máximo global, LIMITE_GLOBAL_MS: lo que no terminó a tiempo sale «sin datos».
 * Lo que no cupo en el tope se lee en las cargas siguientes, porque lo ya leído sale de la caché sin llamar.
 */

/** Tope de llamadas a GitHub por carga de /agentes (cliente con `maxLlamadas`). */
export const LLAMADAS_AGENTES = 40
/** Tiempo máximo global de las lecturas de GitHub de /agentes. */
export const LIMITE_GLOBAL_MS = 15_000

const LIMITE_MS = 20_000
const FALLO_MS = 60_000
/** Lecturas de PR en paralelo como máximo, para no ráfagas contra la API de GitHub. */
const PARALELO = 6
const cache = new Map<string, { hasta: number; lista: PrsDeOrdenes | null }>()

export function limpiarCacheAgentes(): void { cache.clear() }

const conLimite = <T,>(p: Promise<T>) => Promise.race([
  p,
  new Promise<never>((_, rechazar) => setTimeout(() => rechazar(new Error('tiempo')), LIMITE_MS).unref?.()),
])

async function prsDeProyecto(client: GitHubClient, p: string, ahora: number): Promise<PrsDeOrdenes | null> {
  let entrada = cache.get(p)
  if (!entrada || entrada.hasta <= ahora) {
    try {
      entrada = { hasta: ahora + cacheSeconds() * 1000, lista: await conLimite(client.prsDeOrdenes(p)) }
    } catch (error) {
      const fallo = codigoFalloGitHub(error)
      // Sin presupuesto no se llamó a GitHub: «sin datos» en esta carga, sin guardarlo como fallo.
      if (fallo === 'presupuesto') return null
      console.warn(`[project-os] /agentes: lectura de PRs fallida: ${fallo}`)
      entrada = { hasta: ahora + FALLO_MS, lista: null }
    }
    cache.set(p, entrada)
  }
  return entrada.lista
}

export interface GitHubAgentes {
  /** PRs de órdenes por proyecto con repositorio; null en el proyecto cuyo GitHub falló o no terminó a tiempo. */
  prs: Record<string, Map<string, PrFusion> | null>
  /** Proyectos cuya lista de PRs llegó al límite de paginación. */
  truncados: string[]
  /**
   * Dictámenes válidos del PR de cada orden leída (null si no se pudo leer); falta la orden que no se leyó (CERRADA,
   * CANCELADA o sin terminar a tiempo). null entero si el tiempo venció antes de tener las listas de PRs.
   */
  dictamenes: Map<string, DictamenesPr> | null
  /** El tiempo máximo global venció antes de terminar. */
  vencido: boolean
}

/**
 * Todas las lecturas de GitHub de /agentes con el tiempo máximo global. `ordenes`: las del filtro (null si el filtro no
 * tiene órdenes); solo se leen dictámenes de las que pasan leeDictamen. Nunca rechaza.
 */
export async function githubDeAgentes(
  client: GitHubClient, proyecto: string | null, ordenes: Orden[] | null,
  { ahora = Date.now(), limiteMs = LIMITE_GLOBAL_MS }: { ahora?: number; limiteMs?: number } = {},
): Promise<GitHubAgentes> {
  const proyectos = Object.keys(REPOSITORIOS).filter((p) => proyecto === null || p === proyecto)
  const prs: GitHubAgentes['prs'] = Object.fromEntries(proyectos.map((p) => [p, null]))
  const truncados = new Set<string>()
  const dictamenes = new Map<string, DictamenesPr>()
  let conListas = false
  let vencido = false
  let reloj: ReturnType<typeof setTimeout> | undefined
  const vence = new Promise<void>((resolver) => {
    reloj = setTimeout(() => { vencido = true; resolver() }, limiteMs)
    reloj.unref?.()
  })

  const trabajo = (async () => {
    await Promise.all(proyectos.map(async (p) => {
      const lista = await prsDeProyecto(client, p, ahora)
      if (vencido || !lista) return
      prs[p] = lista.prs
      if (lista.truncado) truncados.add(p)
    }))
    if (vencido) return
    conListas = true
    const pendientes = (ordenes ?? []).filter(leeDictamen).flatMap((o) => {
      const proyectoId = proyectoDeOrden(o)
      const pr = proyectoId ? prs[proyectoId]?.get(o.id) : undefined
      return pr && proyectoId ? [{ o, proyectoId, pr }] : []
    }).sort((a, b) => b.o.id.localeCompare(a.o.id))
    let i = 0
    const trabajador = async () => {
      while (i < pendientes.length && !vencido) {
        const { o, proyectoId, pr } = pendientes[i++]!
        const orden = { id: o.id, proyectoId, prUrl: pr.url, riesgo: o.riesgo, criterios: o.criterios, sensible: o.sensible }
        const leido = await datosDePr(client, orden, ahora)
        if (!vencido) dictamenes.set(o.id, leido && dictamenesValidos(leido.datos, orden, leido.pr))
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALELO, pendientes.length) }, trabajador))
  })().catch((error: unknown) => {
    console.warn(`[project-os] /agentes: lectura de GitHub fallida: ${codigoFalloGitHub(error)}`)
  })

  await Promise.race([trabajo, vence])
  clearTimeout(reloj)
  // Copias: lo que termine después del vencimiento ya no cambia lo devuelto (sí llena la caché para la próxima carga).
  return { prs: { ...prs }, truncados: [...truncados], dictamenes: conListas ? new Map(dictamenes) : null, vencido }
}
