import 'server-only'

import { cacheSeconds } from './config'
import { codigoFalloGitHub, type GitHubClient, type SinDesplegar } from './operations/github'

/**
 * Commit desplegado (ORD-POS-124, POS-041; docs/diseno-planificacion-v2.md §4.1, §6.2 y §9, DEC-POS-028 punto 2).
 * deploy.sh pasa al contenedor DEPLOY_COMMIT_SHA (literal, no secreto); el servidor la lee aquí en solo lectura. Sin ella
 * (o con un valor que no es un SHA completo), «Desplegada» y «Fusionado sin desplegar» quedan `apagada` con
 * MOTIVO_SIN_COMMIT: nunca se infiere de la fecha de fusión. Solo se conoce el commit del dashboard (PROJECT-OS).
 *
 * Las lecturas de GitHub usan el cliente con tope de la página (LLAMADAS_AGENTES): sin presupuesto, la lectura no se hace
 * ni se guarda como fallo («sin datos» en esta carga, se lee en la siguiente). Cachés en memoria:
 * - ancestro (commit de fusión, commit desplegado): no cambia nunca, se guarda sin vencimiento (hasta MAX_ANCESTROS);
 * - commits sin desplegar: dependen de `main`, se guardan DASHBOARD_CACHE_SECONDS.
 * Un fallo se guarda FALLO_MS.
 */

/** Proyecto cuyo commit se despliega: el dashboard es PROJECT-OS. */
export const PROYECTO_DESPLEGADO = 'POS'

export const MOTIVO_SIN_COMMIT = 'El despliegue no informa su commit.'
export const MOTIVO_SOLO_POS = 'Solo se conoce el commit desplegado del dashboard (PROJECT-OS).'
export const MOTIVO_NO_LEIDO_DESPLIEGUE = 'No se pudo comparar con el commit desplegado en esta carga (tope de llamadas, tiempo o fallo): se intenta en la siguiente.'

const SHA = /^[0-9a-f]{40}$/
const FALLO_MS = 60_000
const MAX_ANCESTROS = 1000
/** Comparaciones en paralelo como máximo (como /agentes). */
const PARALELO = 6

/** El commit desplegado (40 hex en minúsculas), o null si el despliegue no lo informa o no es un SHA completo. */
export function commitDesplegado(env: NodeJS.ProcessEnv = process.env): string | null {
  const valor = env.DEPLOY_COMMIT_SHA?.trim() ?? ''
  if (!valor) return null
  if (!SHA.test(valor)) {
    console.warn('[project-os] DEPLOY_COMMIT_SHA no es un SHA completo: «Desplegada» queda apagada')
    return null
  }
  return valor
}

const ancestros = new Map<string, { hasta: number; valor: boolean | null }>()
const sinDesplegarCache = new Map<string, { hasta: number; valor: SinDesplegar | null }>()

export function limpiarCacheDespliegue(): void {
  ancestros.clear()
  sinDesplegarCache.clear()
}

/** Promesa con tiempo máximo: null si vence (lo que termine después solo llena la caché). */
async function conTiempo<T>(p: Promise<T>, ms: number): Promise<T | null> {
  if (ms <= 0) return null
  let reloj: ReturnType<typeof setTimeout> | undefined
  const vence = new Promise<null>((resolver) => {
    reloj = setTimeout(() => resolver(null), ms)
    reloj.unref?.()
  })
  try {
    return await Promise.race([p, vence])
  } finally {
    clearTimeout(reloj)
  }
}

/**
 * ¿El commit de fusión es ancestro del desplegado o igual a él? true/false; null si GitHub falló (guardado FALLO_MS);
 * undefined si no hubo presupuesto (no se llamó ni se guarda).
 */
async function esAncestro(client: GitHubClient, mergeSha: string, commit: string, ahora: number): Promise<boolean | null | undefined> {
  if (mergeSha === commit) return true
  const clave = `${mergeSha}:${commit}`
  const guardado = ancestros.get(clave)
  if (guardado && guardado.hasta > ahora) return guardado.valor
  try {
    const valor = await client.esAncestro(PROYECTO_DESPLEGADO, mergeSha, commit)
    if (ancestros.size >= MAX_ANCESTROS) ancestros.delete(ancestros.keys().next().value!)
    ancestros.set(clave, { hasta: Infinity, valor })
    return valor
  } catch (error) {
    const fallo = codigoFalloGitHub(error)
    if (fallo === 'presupuesto') return undefined
    console.warn(`[project-os] comparación con el commit desplegado fallida: ${fallo}`)
    ancestros.set(clave, { hasta: ahora + FALLO_MS, valor: null })
    return null
  }
}

export interface FusionDeOrden { ordenId: string; mergeSha: string }

/**
 * «Desplegada» de cada orden fusionada de PROJECT-OS: true si su commit de fusión es ancestro del desplegado o igual,
 * false si no; null si GitHub falló. Falta la orden que no se leyó (tope de llamadas o tiempo `limiteMs`). Nunca rechaza.
 */
export async function leerDesplegadas(
  client: GitHubClient, fusiones: FusionDeOrden[], commit: string, { ahora = Date.now(), limiteMs }: { ahora?: number; limiteMs: number },
): Promise<Map<string, boolean | null>> {
  const salida = new Map<string, boolean | null>()
  let vencido = limiteMs <= 0
  let i = 0
  const trabajador = async () => {
    while (i < fusiones.length && !vencido) {
      const f = fusiones[i++]!
      const valor = await esAncestro(client, f.mergeSha, commit, ahora)
      if (!vencido && valor !== undefined) salida.set(f.ordenId, valor)
    }
  }
  const todo = Promise.all(Array.from({ length: Math.min(PARALELO, fusiones.length) }, trabajador)).then(() => true)
  if (!vencido && (await conTiempo(todo, limiteMs)) === null) vencido = true
  return new Map(salida)
}

/**
 * Commits de `main` de PROJECT-OS que no están en el commit desplegado (para «Fusionado sin desplegar»). null si GitHub
 * falló, no hubo presupuesto o venció `limiteMs`. Nunca rechaza.
 */
export async function leerSinDesplegar(
  client: GitHubClient, commit: string, { ahora = Date.now(), limiteMs }: { ahora?: number; limiteMs: number },
): Promise<SinDesplegar | null> {
  const guardado = sinDesplegarCache.get(commit)
  if (guardado && guardado.hasta > ahora) return guardado.valor
  const lectura = (async () => {
    try {
      const valor = await client.commitsSinDesplegar(PROYECTO_DESPLEGADO, commit)
      sinDesplegarCache.set(commit, { hasta: ahora + cacheSeconds() * 1000, valor })
      return valor
    } catch (error) {
      const fallo = codigoFalloGitHub(error)
      if (fallo === 'presupuesto') return null
      console.warn(`[project-os] lectura de commits sin desplegar fallida: ${fallo}`)
      sinDesplegarCache.set(commit, { hasta: ahora + FALLO_MS, valor: null })
      return null
    }
  })()
  return conTiempo(lectura, limiteMs)
}
