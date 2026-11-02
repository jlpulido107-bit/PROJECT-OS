import { proyectoDeOrden } from './agentes'
import { estadoBandera, MOTIVO_SIN_COLUMNA_BANDERA, motivoDesconocida, type EstadoBandera, type FuenteBanderas } from './banderas'
import { githubDeAgentes, LIMITE_GLOBAL_MS, type GitHubAgentes } from './agentes-data'
import {
  leerDesplegadas, MOTIVO_NO_LEIDO_DESPLIEGUE, MOTIVO_SIN_COMMIT, MOTIVO_SOLO_POS, PROYECTO_DESPLEGADO, type FusionDeOrden,
} from './despliegue'
import { leerDictamenes, type LecturaListos, type OpcionesLectura } from './esperando'
import type { GitHubClient, PrFusion } from './operations/github'
import { estadoOrden, SIGUIENTE_PASO, type EstadoOrden } from './ordenes'
import { etiqueta, type Etiqueta } from './planificacion-v2'
import { CORRELATIVO_AGOTADO, dictamenSuficiente, LISTO_PARA_DECISION, type EvaluacionDictamen } from './supervision/dictamen'
import { ordenSensible } from './supervision/politica'
import type { Orden } from './types'

/**
 * Planificación v2, fase F4 (ORD-POS-123, POS-041; docs/diseno-planificacion-v2.md §4, §4.1 y §7): capa Flujo. En qué paso
 * va cada orden abierta y a quién espera, de Borrador a Fusionada. Solo lectura: ORDENES_CODEX, las listas de PRs de la
 * caché de /agentes (githubDeAgentes) y los dictámenes con dictamenDeOrden y su caché (la de /ordenes), con el cliente de
 * tope LLAMADAS_AGENTES y el tiempo LIMITE_GLOBAL_MS.
 *
 * Desplegada (ORD-POS-124, fase F5a): hecha si el commit de fusión del PR es ancestro del commit desplegado
 * (DEPLOY_COMMIT_SHA, lib/despliegue.ts) o igual, según la API de comparación de GitHub, con caché y dentro del mismo tope.
 * Sin el commit, apagada con MOTIVO_SIN_COMMIT; en SIGSAH y RADAROS, apagada con MOTIVO_SOLO_POS.
 *
 * Fase F5b (ORD-POS-125, §4.1 y §9, DEC-POS-028 punto 3): Activada sale de la columna opcional BANDERA de ORDENES_CODEX y
 * del estado de esa bandera en el servidor (lib/banderas.ts), solo para la sesión del propietario. Sin la columna, o para
 * otro lector, queda apagada con su motivo; una bandera desconocida queda sin datos.
 */

export const PASOS = ['Borrador', 'Enviada', 'PR', 'PRIMERO', 'SEGUNDO', 'Revisada', 'Fusionada', 'Desplegada', 'Activada'] as const
export type NombrePaso = (typeof PASOS)[number]

/** `actual` = el primero no hecho que aplica; `pendiente` = después del actual. */
export type EstadoPaso = 'hecho' | 'actual' | 'pendiente' | 'no-aplica' | 'sin-datos' | 'apagada'

export interface Paso { paso: NombrePaso; estado: EstadoPaso; motivo?: string }

export type Quien = 'propietario' | 'claude' | 'revisor'

export interface LineaFlujo {
  ordenId: string
  etiqueta: Etiqueta
  riesgo: string | null
  /** DEC-POS-019: solo SENSIBLE = NO es no sensible. */
  sensible: boolean
  pasos: Paso[]
  /** El paso actual, o null si antes de llegar a uno hay un paso sin datos o apagado (no se infiere nada). */
  actual: NombrePaso | null
  /** A quién espera el paso actual y qué hace falta; sin `quien` si no hay paso actual. */
  espera: { quien: Quien | null; texto: string }
  pr: { url: string; numero: number } | null
  /** La bandera de Activada por su nombre en palabras y solo encendida o apagada; null si no hay o no se ve. */
  bandera: { nombre: string; estado: 'encendida' | 'apagada' } | null
}

export type CapaFlujo =
  | { estado: 'sin-datos'; motivo: string }
  | {
    estado: 'ok'; lineas: LineaFlujo[]; encabezado: Record<Quien, number>; github: 'ok' | 'sin-token' | 'parcial'
    /** Si el despliegue informa su commit (DEPLOY_COMMIT_SHA). */
    commit: boolean
  }

export const MOTIVO_SIN_GITHUB_FLUJO = 'No se pudo leer GitHub.'
export const MOTIVO_NO_LEIDO_FLUJO = 'No se pudo leer el dictamen en GitHub en esta carga (tope de llamadas, tiempo o fallo): se intenta en la siguiente.'
export const MOTIVO_SOLO_DOCS = 'BAJO de solo documentación: sin revisor automático (DEC-POS-008).'
export const MOTIVO_SIN_SHA_FUSION = 'GitHub no dio el commit de fusión del PR: no se sabe si está desplegado.'
export const MOTIVO_SIN_SEGUNDO = 'Sin segundo revisor en BAJO ni en MEDIO no sensible (DEC-POS-019).'
export const MOTIVO_SIN_BANDERA = 'La orden no deja ninguna bandera por encender (BANDERA vacía).'
const SIN_COLUMNA: FuenteBanderas = { estado: 'apagada', motivo: MOTIVO_SIN_COLUMNA_BANDERA }

/** Paso Activada (§4.1): hecho con la bandera encendida; no aplica sin bandera; sin datos si no se reconoce. */
function pasoActivada(o: Orden, fuente: FuenteBanderas): { paso: Omit<Paso, 'paso'>; bandera: EstadoBandera | null } {
  if (fuente.estado === 'apagada') return { paso: { estado: 'apagada', motivo: fuente.motivo }, bandera: null }
  const b = estadoBandera(o.bandera, fuente.env)
  if (b === null) return { paso: { estado: 'no-aplica', motivo: MOTIVO_SIN_BANDERA }, bandera: null }
  if (b.tipo === 'desconocida') return { paso: { estado: 'sin-datos', motivo: motivoDesconocida(b.nombre) }, bandera: b }
  return { paso: { estado: b.tipo === 'encendida' ? 'hecho' : 'pendiente', motivo: `${b.nombre}: ${b.tipo}.` }, bandera: b }
}

/** Estados de una orden que siguen en el Flujo; CERRADA y CANCELADA quedan solo en /ordenes. */
const ABIERTOS: readonly EstadoOrden[] = ['BORRADOR', 'APROBADA', 'ENVIADA', 'PR_ABIERTO', 'REVISADA']
const ENVIADOS: readonly EstadoOrden[] = ['ENVIADA', 'PR_ABIERTO', 'REVISADA']

export const ordenesDelFlujo = (ordenes: Orden[]): Orden[] =>
  ordenes.filter((o) => { const e = estadoOrden(o.estado); return e !== null && ABIERTOS.includes(e) })
    .sort((a, b) => b.id.localeCompare(a.id))

/** Lecturas de GitHub de la capa; null si el servidor no tiene token de GitHub. */
export interface GitHubFlujo {
  /** Listas de PRs de órdenes por proyecto (la caché de /agentes); null en el proyecto cuya lista no se pudo leer. */
  prs: GitHubAgentes['prs']
  truncados: string[]
  dictamenes: LecturaListos
  /**
   * Desplegada de las órdenes fusionadas de PROJECT-OS (ORD-POS-124): true si el commit de fusión está en el desplegado;
   * null si GitHub falló; falta la que no se leyó. Ausente si no hay commit desplegado.
   */
  desplegadas?: Map<string, boolean | null>
}

/** PR de la orden: el registrado en ORDENES_CODEX o, sin él, el detectado por título en la lista de su repositorio. */
function prDe(
  o: Orden, prs: GitHubAgentes['prs'] | null, truncados: string[],
): { url: string; numero: number; fusion: PrFusion | null } | null | 'sin-datos' {
  const proyecto = proyectoDeOrden(o)
  const lista = prs && proyecto ? prs[proyecto] ?? null : null
  const detectado = lista?.get(o.id) ?? null
  const numero = (url: string) => Number(/\/pull\/(\d+)$/.exec(url)?.[1] ?? 0)
  if (o.prUrl) return { url: o.prUrl, numero: numero(o.prUrl), fusion: detectado && detectado.url === o.prUrl ? detectado : null }
  if (detectado) return { url: detectado.url, numero: detectado.number, fusion: detectado }
  // Sin la lista (sin GitHub, o falló) o con la lista truncada, no se sabe si hay PR.
  return lista && !truncados.includes(proyecto!) ? null : 'sin-datos'
}

/** Órdenes del Flujo con PR (registrado o detectado), con `prUrl` puesto: las únicas que piden dictamen a GitHub. */
export function ordenesConPr(ordenes: Orden[], prs: GitHubAgentes['prs']): Orden[] {
  return ordenesDelFlujo(ordenes).flatMap((o) => {
    const pr = prDe(o, prs, [])
    return pr && pr !== 'sin-datos' ? [{ ...o, prUrl: pr.url }] : []
  })
}

/**
 * Lecturas de GitHub de la capa con un solo cliente (el de tope LLAMADAS_AGENTES): las listas de PRs (githubDeAgentes
 * sin órdenes, con su caché) y los dictámenes de las órdenes abiertas con PR con lo que queda de LIMITE_GLOBAL_MS.
 */
export async function githubDeFlujo(
  client: GitHubClient, ordenes: Orden[],
  { ahora = Date.now(), leer, commit = null }: { ahora?: number; leer?: OpcionesLectura['leer']; commit?: string | null } = {},
): Promise<GitHubFlujo> {
  const inicio = Date.now()
  const gh = await githubDeAgentes(client, null, null, { ahora })
  const dictamenes = await leerDictamenes(client, ordenesConPr(ordenes, gh.prs), {
    ahora, limiteMs: LIMITE_GLOBAL_MS - (Date.now() - inicio), ...(leer ? { leer } : {}),
  })
  if (!commit) return { prs: gh.prs, truncados: gh.truncados, dictamenes }
  const desplegadas = await leerDesplegadas(client, fusionesDelFlujo(ordenes, gh.prs, gh.truncados), commit, {
    ahora, limiteMs: LIMITE_GLOBAL_MS - (Date.now() - inicio),
  })
  return { prs: gh.prs, truncados: gh.truncados, dictamenes, desplegadas }
}

/** Órdenes abiertas de PROJECT-OS con PR fusionado y commit de fusión conocido: las únicas que piden comparación. */
export function fusionesDelFlujo(ordenes: Orden[], prs: GitHubAgentes['prs'], truncados: string[]): FusionDeOrden[] {
  return ordenesDelFlujo(ordenes).flatMap((o) => {
    if (proyectoDeOrden(o) !== PROYECTO_DESPLEGADO) return []
    const pr = prDe(o, prs, truncados)
    const sha = pr && pr !== 'sin-datos' && pr.fusion?.fusionMs != null ? pr.fusion.mergeSha : null
    return sha ? [{ ordenId: o.id, mergeSha: sha }] : []
  })
}

/** Quién atiende el texto de EvaluacionDictamen.siguiente (§4.1: CAMBIOS → corrector; falta → revisor). */
function quienDictamen(siguiente: string): Quien {
  if (siguiente.startsWith('Corregir')) return 'claude'
  if (siguiente === 'Escala al propietario' || siguiente === CORRELATIVO_AGOTADO || siguiente === LISTO_PARA_DECISION) return 'propietario'
  return 'revisor'
}

/**
 * PRIMERO hecho: el dictamen vigente del head actual es CONFORME (sin CAMBIOS ni INCONCLUSO vigentes).
 * atajo: EvaluacionDictamen no dice el rol del CONFORME; un SEGUNDO sin PRIMERO contaría aquí, pero el SEGUNDO solo se
 * lanza tras un PRIMERO CONFORME (/ordenes). Mejorarlo si evaluarDictamen llega a exponer los roles vigentes.
 */
const primeroHecho = (ev: EvaluacionDictamen) => ev.estado.tipo === 'vigente' && ev.estado.dictamen.veredicto === 'CONFORME'

/**
 * Una línea del Flujo (§4.1). `soloDocs`: si la orden BAJO es de solo documentación; null si no se sabe (ninguna fuente
 * de §4.1 lo dice): entonces PRIMERO aplica, para no pintar como «no aplica» una revisión que quizá sí toca.
 */
export function lineaFlujo(
  o: Orden, gh: GitHubFlujo | null,
  { soloDocs = null, commit = null, banderas = SIN_COLUMNA }:
  { soloDocs?: boolean | null; commit?: string | null; banderas?: FuenteBanderas } = {},
): LineaFlujo {
  const estado = estadoOrden(o.estado)!
  const riesgo = o.riesgo?.trim().toUpperCase() || null
  const sensible = ordenSensible(o.sensible)
  const sinPrimero = riesgo === 'BAJO' && soloDocs === true
  const sinSegundo = sinPrimero || riesgo === 'BAJO' || (riesgo === 'MEDIO' && !sensible)
  const pr = prDe(o, gh?.prs ?? null, gh?.truncados ?? [])
  const conPr = pr !== null && pr !== 'sin-datos'
  const ev = conPr ? gh?.dictamenes.evaluaciones.get(o.id) ?? null : null
  const motivoDictamen = gh === null ? MOTIVO_SIN_GITHUB_FLUJO : MOTIVO_NO_LEIDO_FLUJO
  // Sin GitHub nada de GitHub se infiere: sin-datos (§4.1), nunca pendiente.
  const deGitHub = (hecho: boolean | null, motivo = MOTIVO_SIN_GITHUB_FLUJO): Omit<Paso, 'paso'> =>
    hecho === null ? { estado: 'sin-datos', motivo } : { estado: hecho ? 'hecho' : 'pendiente' }

  const activada = pasoActivada(o, banderas)
  const enviada = ENVIADOS.includes(estado) && Boolean(o.issueUrl)
  const fusionada: Omit<Paso, 'paso'> = gh === null ? deGitHub(null)
    : !conPr ? (pr === 'sin-datos' ? deGitHub(null) : { estado: 'pendiente' })
      : pr.fusion ? { estado: pr.fusion.fusionMs !== null ? 'hecho' : 'pendiente' }
        : deGitHub(null, 'El PR registrado no está en la lista de PRs de GitHub de esta carga.')
  // Desplegada (ORD-POS-124): solo con el commit desplegado y en PROJECT-OS; sin fusión no hay nada que desplegar aún.
  const desplegada: Omit<Paso, 'paso'> = !commit ? { estado: 'apagada', motivo: MOTIVO_SIN_COMMIT }
    : proyectoDeOrden(o) !== PROYECTO_DESPLEGADO ? { estado: 'apagada', motivo: MOTIVO_SOLO_POS }
      : fusionada.estado !== 'hecho' ? { ...fusionada }
        : conPr && !pr.fusion?.mergeSha ? deGitHub(null, MOTIVO_SIN_SHA_FUSION)
          : deGitHub(gh?.desplegadas?.get(o.id) ?? null, MOTIVO_NO_LEIDO_DESPLIEGUE)
  const crudos: Array<Omit<Paso, 'paso'>> = [
    { estado: 'hecho' },
    { estado: enviada ? 'hecho' : 'pendiente' },
    pr === 'sin-datos' ? { estado: 'sin-datos', motivo: MOTIVO_SIN_GITHUB_FLUJO } : { estado: pr ? 'hecho' : 'pendiente' },
    sinPrimero ? { estado: 'no-aplica', motivo: MOTIVO_SOLO_DOCS }
      : gh === null ? deGitHub(null)
        : !conPr ? { estado: 'pendiente' } : deGitHub(ev ? primeroHecho(ev) : null, motivoDictamen),
    sinSegundo ? { estado: 'no-aplica', motivo: sinPrimero ? MOTIVO_SOLO_DOCS : MOTIVO_SIN_SEGUNDO }
      : gh === null ? deGitHub(null)
        : !conPr ? { estado: 'pendiente' } : deGitHub(ev ? dictamenSuficiente(ev) : null, motivoDictamen),
    { estado: estado === 'REVISADA' ? 'hecho' : 'pendiente' },
    fusionada,
    desplegada,
    activada.paso,
  ]
  const pasos: Paso[] = crudos.map((c, i) => ({ paso: PASOS[i]!, ...c }))

  // El paso actual es el primero no hecho que aplica; un sin-datos o apagado antes de él lo deja sin determinar.
  let actual: NombrePaso | null = null
  let espera: LineaFlujo['espera'] = { quien: null, texto: 'Sin pasos pendientes.' }
  for (const p of pasos) {
    if (p.estado === 'hecho' || p.estado === 'no-aplica') continue
    if (p.estado === 'sin-datos' || p.estado === 'apagada') {
      espera = { quien: null, texto: `${p.paso}: ${p.motivo ?? ''}`.trim() }
      break
    }
    p.estado = 'actual'
    actual = p.paso
    espera = esperaDe(p.paso, estado, ev, sinPrimero, activada.bandera)
    break
  }
  return {
    ordenId: o.id,
    etiqueta: etiqueta({ tipo: 'orden', id: o.id, titulo: o.titulo }),
    riesgo,
    sensible,
    pasos,
    actual,
    espera,
    pr: conPr ? { url: pr.url, numero: pr.numero } : null,
    bandera: activada.bandera && activada.bandera.tipo !== 'desconocida'
      ? { nombre: activada.bandera.nombre, estado: activada.bandera.tipo } : null,
  }
}

function esperaDe(
  paso: NombrePaso, estado: EstadoOrden, ev: EvaluacionDictamen | null, sinRevisor: boolean, bandera: EstadoBandera | null,
): LineaFlujo['espera'] {
  switch (paso) {
    case 'Enviada':
      return { quien: 'propietario', texto: estado === 'BORRADOR' ? SIGUIENTE_PASO.BORRADOR.texto : SIGUIENTE_PASO.APROBADA.texto }
    case 'PR':
      return { quien: 'claude', texto: 'Implementar la orden y abrir el PR' }
    case 'PRIMERO':
    case 'SEGUNDO':
      return ev ? { quien: quienDictamen(ev.siguiente), texto: ev.siguiente }
        : { quien: 'revisor', texto: paso === 'PRIMERO' ? 'Lanzar revisión' : 'Falta segundo revisor' }
    case 'Revisada':
      return { quien: 'propietario', texto: sinRevisor ? 'Decidir con el PR (sin revisor, DEC-POS-008)' : ev?.siguiente === LISTO_PARA_DECISION ? LISTO_PARA_DECISION : 'Decidir y marcar REVISADA' }
    case 'Fusionada':
      return { quien: 'propietario', texto: SIGUIENTE_PASO.REVISADA.texto }
    case 'Activada':
      return { quien: 'propietario', texto: `Encender ${bandera?.nombre ?? 'la bandera'} con deploy.sh (DEC-POS-014)` }
    default:
      return { quien: 'propietario', texto: 'Desplegar (DEC-POS-017)' }
  }
}

/** La capa entera: una línea por orden abierta y el encabezado «Esperan por ti · por Claude · por revisor». */
export function capaFlujo(
  ordenes: Orden[], ordenesOk: boolean, gh: GitHubFlujo | null,
  { commit = null, banderas = SIN_COLUMNA }: { commit?: string | null; banderas?: FuenteBanderas } = {},
): CapaFlujo {
  if (!ordenesOk) return { estado: 'sin-datos', motivo: 'La pestaña ORDENES_CODEX no se pudo leer completa: no se sabe qué órdenes están abiertas.' }
  const lineas = ordenesDelFlujo(ordenes).map((o) => lineaFlujo(o, gh, { commit, banderas }))
  const encabezado: Record<Quien, number> = { propietario: 0, claude: 0, revisor: 0 }
  for (const l of lineas) if (l.espera.quien) encabezado[l.espera.quien]++
  const parcial = gh !== null && (gh.dictamenes.vencido || Object.values(gh.prs).some((p) => p === null) || lineas.some((l) => l.pasos.some((p) => p.estado === 'sin-datos')))
  return { estado: 'ok', lineas, encabezado, github: gh === null ? 'sin-token' : parcial ? 'parcial' : 'ok', commit: Boolean(commit) }
}
