import { proyectoDeOrden, type ProyectoAgentes } from './agentes'
import { githubDeAgentes, LIMITE_GLOBAL_MS, type GitHubAgentes } from './agentes-data'
import type { Pendientes, TareaPendiente } from './inicio'
import { dictamenDeOrden } from './operations/dictamenes'
import { codigoFalloGitHub, type GitHubClient } from './operations/github'
import { dictamenSuficiente, type EvaluacionDictamen } from './supervision/dictamen'
import type { Decision, Orden } from './types'

/**
 * Bloque «Esperando por ti» de Inicio (ORD-POS-122, POS-040; docs/diseno-planificacion-v2.md §6, fase F3, DEC-POS-028):
 * lo que solo el propietario puede destrabar. Solo lectura. 6.3 y 6.5 salen de misPendientes sin llamadas nuevas; 6.1
 * suma a las REVISADA las PR_ABIERTO cuyo dictamen del head actual basta para REVISADA (dictamenSuficiente), leído con
 * dictamenDeOrden y su caché (la de /ordenes), con el cliente de tope LLAMADAS_AGENTES y el tiempo LIMITE_GLOBAL_MS de
 * Inicio: lo que no cupo queda «sin datos» y se lee en la carga siguiente. 6.2 y 6.4 quedan apagadas hasta la fase F5.
 */

export type Grupo<T> =
  | { estado: 'ok'; datos: T }
  | { estado: 'sin-datos'; motivo: string }
  /** Falta una fuente o una configuración; el motivo dice quién la añade. */
  | { estado: 'apagada'; motivo: string }

export const MOTIVO_F5 = 'Falta la fuente; la añade la fase F5.'
export const MOTIVO_NO_PROPIETARIO = 'Solo lo ve la sesión del propietario.'
export const MOTIVO_SIN_GITHUB = 'Sin token de GitHub en este servidor: no se leen los dictámenes de las órdenes con PR abierto.'
export const MOTIVO_NO_LEIDO = 'No se pudo leer su dictamen en GitHub en esta carga (tope de llamadas, tiempo o fallo): se intenta en la siguiente.'

/** Lecturas en paralelo como máximo (como /agentes). */
const PARALELO = 6

/** Dictámenes leídos de las PR_ABIERTO; falta la orden que no se leyó a tiempo. null en la orden cuyo GitHub falló. */
export interface LecturaListos {
  evaluaciones: Map<string, EvaluacionDictamen | null>
  vencido: boolean
}

/** PR_ABIERTO con PR registrado: las únicas que piden dictamen a GitHub. */
export const conPrAbierto = (ordenes: Orden[]): Orden[] =>
  ordenes.filter((o) => o.estado === 'PR_ABIERTO' && o.prUrl).sort((a, b) => b.id.localeCompare(a.id))

/**
 * Dictámenes de las órdenes PR_ABIERTO con el tiempo máximo `limiteMs` (lo que queda de LIMITE_GLOBAL_MS en la carga).
 * El tope de llamadas lo pone el cliente (`maxLlamadas`): sin presupuesto, dictamenDeOrden devuelve null sin llamar ni
 * guardar el fallo. Nunca rechaza.
 */
export async function leerListos(
  client: GitHubClient, ordenes: Orden[],
  { ahora = Date.now(), limiteMs = LIMITE_GLOBAL_MS, leer = dictamenDeOrden }: {
    ahora?: number; limiteMs?: number; leer?: typeof dictamenDeOrden
  } = {},
): Promise<LecturaListos> {
  const pendientes = conPrAbierto(ordenes)
  const evaluaciones = new Map<string, EvaluacionDictamen | null>()
  let vencido = limiteMs <= 0
  let reloj: ReturnType<typeof setTimeout> | undefined
  const vence = new Promise<void>((resolver) => {
    reloj = setTimeout(() => { vencido = true; resolver() }, Math.max(0, limiteMs))
    reloj.unref?.()
  })
  let i = 0
  const trabajador = async () => {
    while (i < pendientes.length && !vencido) {
      const o = pendientes[i++]!
      const ev = await leer(client, o, ahora).catch((error: unknown) => {
        console.warn(`[project-os] Inicio: lectura del dictamen fallida: ${codigoFalloGitHub(error)}`)
        return null
      })
      if (!vencido) evaluaciones.set(o.id, ev)
    }
  }
  if (!vencido) await Promise.race([Promise.all(Array.from({ length: Math.min(PARALELO, pendientes.length) }, trabajador)), vence])
  clearTimeout(reloj)
  return { evaluaciones: new Map(evaluaciones), vencido }
}

/**
 * Lecturas de GitHub de Inicio con un solo cliente (el de tope LLAMADAS_AGENTES): las listas de PRs (githubDeAgentes sin
 * órdenes) y, solo para el propietario, los dictámenes de sus PR_ABIERTO con lo que queda de LIMITE_GLOBAL_MS.
 */
export async function githubDeInicio(
  client: GitHubClient, filtro: ProyectoAgentes | null, ordenes: Orden[], propietario: boolean,
): Promise<{ gh: GitHubAgentes; listos: LecturaListos | null }> {
  const inicio = Date.now()
  const gh = await githubDeAgentes(client, filtro, null)
  if (!propietario) return { gh, listos: null }
  const delFiltro = ordenes.filter((o) => filtro === null || proyectoDeOrden(o) === filtro)
  return { gh, listos: await leerListos(client, delFiltro, { limiteMs: LIMITE_GLOBAL_MS - (Date.now() - inicio) }) }
}

export interface ListoParaFusionar {
  orden: Orden
  /** REVISADA en la hoja, o PR_ABIERTO con dictamen suficiente en el head actual (aún sin marcar REVISADA). */
  via: 'revisada' | 'conforme'
}

export interface Listos {
  lista: ListoParaFusionar[]
  /** PR_ABIERTO cuyo dictamen no se pudo leer en esta carga: ni dentro ni fuera, «sin datos». */
  sinDatos: Orden[]
  /** Motivo de `sinDatos` (sin token, o tope/tiempo/fallo). */
  motivoSinDatos: string | null
}

export interface Esperando {
  listos: Grupo<Listos>
  fusionadoSinDesplegar: Grupo<never>
  decisiones: Grupo<Decision[]>
  banderas: Grupo<never>
  vencenHoy: Grupo<TareaPendiente[]>
  /** Suma de elementos de los grupos `ok`; un grupo sin datos o apagado no cuenta como 0, no cuenta. */
  contador: number
  /** Grupos que no están `ok` (para decir que el contador es parcial). */
  sinContar: number
}

export interface FuentesEsperando {
  /** Sesión del propietario (escritor). Si no, el bloque es `apagada` y no se lee nada de GitHub. */
  propietario: boolean
  ordenes: Orden[]
  ordenesOk: boolean
  filtro: ProyectoAgentes | null
  pendientes: Pendientes
  /** Dictámenes de las PR_ABIERTO; null si no hay token de GitHub en el servidor. */
  listos: LecturaListos | null
}

/** Grupos del bloque, puros sobre misPendientes y los dictámenes ya leídos. */
export function esperandoPorTi(f: FuentesEsperando): Grupo<Esperando> {
  if (!f.propietario) return { estado: 'apagada', motivo: MOTIVO_NO_PROPIETARIO }
  const delFiltro = f.ordenes.filter((o) => f.filtro === null || proyectoDeOrden(o) === f.filtro)

  let listos: Grupo<Listos>
  if (!f.ordenesOk) listos = { estado: 'sin-datos', motivo: 'La pestaña ORDENES_CODEX no está disponible.' }
  else {
    const lista: ListoParaFusionar[] = delFiltro.filter((o) => o.estado === 'REVISADA').map((orden) => ({ orden, via: 'revisada' }))
    const sinDatos: Orden[] = []
    for (const o of conPrAbierto(delFiltro)) {
      const ev = f.listos?.evaluaciones.get(o.id)
      if (!ev) sinDatos.push(o)
      else if (dictamenSuficiente(ev)) lista.push({ orden: o, via: 'conforme' })
    }
    lista.sort((a, b) => a.orden.id.localeCompare(b.orden.id))
    sinDatos.sort((a, b) => a.id.localeCompare(b.id))
    listos = { estado: 'ok', datos: { lista, sinDatos, motivoSinDatos: sinDatos.length === 0 ? null : f.listos === null ? MOTIVO_SIN_GITHUB : MOTIVO_NO_LEIDO } }
  }

  const t = f.pendientes.tareas
  const vencenHoy: Grupo<TareaPendiente[]> = t.estado === 'ok' ? { estado: 'ok', datos: t.datos.filter((x) => x.dias <= 0) } : t
  const decisiones: Grupo<Decision[]> = f.pendientes.decisiones
  const fusionadoSinDesplegar: Grupo<never> = { estado: 'apagada', motivo: MOTIVO_F5 }
  const banderas: Grupo<never> = { estado: 'apagada', motivo: MOTIVO_F5 }

  const grupos = [
    listos.estado === 'ok' ? listos.datos.lista.length : null,
    null, // 6.2 apagada
    decisiones.estado === 'ok' ? decisiones.datos.length : null,
    null, // 6.4 apagada
    vencenHoy.estado === 'ok' ? vencenHoy.datos.length : null,
  ]
  return {
    estado: 'ok',
    datos: {
      listos, fusionadoSinDesplegar, decisiones, banderas, vencenHoy,
      contador: grupos.reduce<number>((s, n) => s + (n ?? 0), 0),
      sinContar: grupos.filter((n) => n === null).length,
    },
  }
}
