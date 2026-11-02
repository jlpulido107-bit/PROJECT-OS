import { proyectoDeOrden, type ProyectoAgentes } from './agentes'
import { estadoBandera, MOTIVO_SIN_COLUMNA_BANDERA, type FuenteBanderas } from './banderas'
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
 * Inicio: lo que no cupo queda «sin datos» y se lee en la carga siguiente. 6.2 queda apagada hasta la fase F5.
 * 6.4 (ORD-POS-125, fase F5b): las órdenes con PR fusionado cuya bandera (columna BANDERA) sigue apagada, por su nombre en
 * palabras; sin la columna queda apagada. La fusión sale de las listas de PRs que Inicio ya lee: cero llamadas nuevas.
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
  client: GitHubClient, ordenes: Orden[], opciones: OpcionesLectura = {},
): Promise<LecturaListos> {
  return leerDictamenes(client, conPrAbierto(ordenes), opciones)
}

export interface OpcionesLectura { ahora?: number; limiteMs?: number; leer?: typeof dictamenDeOrden }

/**
 * Dictámenes de `pendientes` (órdenes con `prUrl`, en ese orden) con dictamenDeOrden y su caché, PARALELO a la vez y con
 * el tiempo máximo `limiteMs`. Lo comparten «Esperando por ti» (ORD-POS-122) y la capa Flujo (ORD-POS-123). Nunca rechaza.
 */
export async function leerDictamenes(
  client: GitHubClient, pendientes: Orden[],
  { ahora = Date.now(), limiteMs = LIMITE_GLOBAL_MS, leer = dictamenDeOrden }: OpcionesLectura = {},
): Promise<LecturaListos> {
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
        console.warn(`[project-os] lectura del dictamen fallida: ${codigoFalloGitHub(error)}`)
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

export interface BanderaSinEncender {
  orden: Orden
  /** Nombre en palabras de la bandera (o el de la celda, si no se reconoce); nunca su valor. */
  nombre: string
}

export interface BanderasSinEncender {
  /** Órdenes fusionadas cuya bandera está apagada. */
  lista: BanderaSinEncender[]
  /** Órdenes fusionadas cuya bandera no se reconoce: no se sabe si está encendida. */
  desconocidas: BanderaSinEncender[]
  /** Órdenes con bandera no encendida de las que no se sabe si están fusionadas (sin la lista de PRs de su repositorio). */
  sinDatos: Orden[]
  motivoSinDatos: string | null
}

export const MOTIVO_FUSION_SIN_DATOS = 'No se pudo leer la lista de PRs en GitHub: no se sabe si estas órdenes están fusionadas.'

export interface Esperando {
  listos: Grupo<Listos>
  fusionadoSinDesplegar: Grupo<never>
  decisiones: Grupo<Decision[]>
  banderas: Grupo<BanderasSinEncender>
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
  /** Fuente del estado de las banderas (6.4); sin ella, apagada por falta de la columna BANDERA. */
  banderas?: FuenteBanderas
  /** Listas de PRs de órdenes de GitHub (la caché de /agentes) para saber qué está fusionado; null sin token. */
  prs?: Record<string, Map<string, { fusionMs: number | null }> | null> | null
  /** Proyectos cuya lista de PRs llegó al límite de paginación. */
  truncados?: string[]
}

/** 6.4: fusionadas con su bandera apagada (o no reconocida); las encendidas no entran. Puro. */
export function banderasSinEncender(
  ordenes: Orden[], fuente: FuenteBanderas, prs: FuentesEsperando['prs'] = null, truncados: string[] = [],
): Grupo<BanderasSinEncender> {
  if (fuente.estado === 'apagada') return { estado: 'apagada', motivo: fuente.motivo }
  const datos: BanderasSinEncender = { lista: [], desconocidas: [], sinDatos: [], motivoSinDatos: null }
  for (const o of [...ordenes].sort((a, b) => a.id.localeCompare(b.id))) {
    if (o.estado === 'CANCELADA') continue
    const b = estadoBandera(o.bandera, fuente.env)
    if (b === null || b.tipo === 'encendida') continue
    const proyecto = proyectoDeOrden(o)
    const lista = prs && proyecto ? prs[proyecto] ?? null : null
    const pr = lista?.get(o.id)
    // Sin la lista, o sin el PR en una lista truncada, no se sabe si está fusionada: nunca se infiere.
    if (!lista || (!pr && truncados.includes(proyecto!))) { datos.sinDatos.push(o); continue }
    if (!pr || pr.fusionMs === null) continue
    ;(b.tipo === 'apagada' ? datos.lista : datos.desconocidas).push({ orden: o, nombre: b.nombre })
  }
  datos.motivoSinDatos = datos.sinDatos.length ? MOTIVO_FUSION_SIN_DATOS : null
  return { estado: 'ok', datos }
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
  const banderas = !f.ordenesOk ? { estado: 'sin-datos' as const, motivo: 'La pestaña ORDENES_CODEX no está disponible.' }
    : banderasSinEncender(delFiltro, f.banderas ?? { estado: 'apagada', motivo: MOTIVO_SIN_COLUMNA_BANDERA }, f.prs ?? null, f.truncados ?? [])

  const grupos = [
    listos.estado === 'ok' ? listos.datos.lista.length : null,
    null, // 6.2 apagada
    decisiones.estado === 'ok' ? decisiones.datos.length : null,
    banderas.estado === 'ok' ? banderas.datos.lista.length : null,
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
