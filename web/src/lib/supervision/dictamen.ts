import { extraerCriterios } from './criterios'
import { politicaDeRepo, repoSinCi } from './politica'
import { validarReporte, type ReporteRevision } from './report'
import type { Veredicto } from './types'

/**
 * Dictamen vigente de un PR para /ordenes (DEC-POS-009: el dictamen vive solo en el PR). Funciones PURAS: reciben los
 * comentarios ya filtrados por autor y nunca lanzan. Todo texto del comentario es texto plano; solo se muestran campos
 * validados del reporte, nunca el contenido del comentario.
 */

export const MARCA_DICTAMEN = '<!-- project-os:dictamen-revisor -->'
const BLOQUE_JSON = /```json\r?\n([\s\S]*?)\r?\n```/
const RONDAS_MAX = 2
/** REV-/EJE-<orden>-<n> llega hasta 999 (textoSupervision rechaza más). */
const N_MAX = 999
export const CORRELATIVO_AGOTADO = 'Correlativo de revisión agotado (máximo 999)'
export const LISTO_PARA_DECISION = 'Listo para tu decisión'

export interface DatosPr { headSha: string; comentarios: Array<{ id: number; body: string }> }

export interface DictamenVigente {
  veredicto: Veredicto
  ronda: number
  bloquean: number
  noBloquean: number
  sha: string
  comentarioId: number
  /** Repositorio sin CI (politica.ts) con CI_AUSENTE y al menos una prueba propia con código 0 (ORD-POS-052). */
  sinCi?: true
}

export type EstadoDictamen =
  | { tipo: 'vigente'; dictamen: DictamenVigente }
  | { tipo: 'anterior' | 'invalido' | 'ninguno' }

/** Lanzamiento que toca ahora (ORD-POS-037), con datos derivados solo de los dictámenes válidos del PR. */
export interface PlanLanzamiento {
  tipo: 'PRIMERO' | 'DELTA' | 'SEGUNDO' | 'CORREGIR'
  headSha: string
  /** Correlativo de REV-/EJE-<orden>-<n>. */
  n: number
  ronda: number
  intento: number
  /** Solo CORREGIR: comentario del dictamen CAMBIOS vigente (HALLAZGOS). */
  comentarioId?: number
}

export interface EvaluacionDictamen {
  estado: EstadoDictamen; siguiente: string; plan: PlanLanzamiento | null; agotado?: true
  /** Repo de REPOS_SIN_CI con un dictamen del head que sería válido con CI EXITO: hay que sacarlo de la lista (ORD-POS-052). */
  ciDetectada?: true
}

export interface OrdenDictamen { id: string; riesgo: string | null; criterios: string | null }
export interface PrDictamen { repo: string; numero: number }

interface Valido { indice: number; id: number; reporte: ReporteRevision }

const tieneMarca = (body: string) => body.split('\n', 1)[0]!.replace(/\r$/, '') === MARCA_DICTAMEN

function leer(body: string, orden: OrdenDictamen, pr: PrDictamen, ciRequerida = !repoSinCi(pr.repo)): ReporteRevision | null {
  const extraidos = extraerCriterios(orden.criterios ?? '')
  const json = BLOQUE_JSON.exec(body)?.[1]
  if (!extraidos.ok || json === undefined) return null
  try {
    const r = validarReporte(JSON.parse(json), { ...politicaDeRepo(pr.repo, extraidos.criteriosEsperados), ciRequerida })
    if (!r.ok) return null
    const { reporte } = r
    // El dictamen debe ser de esta orden y de este PR: uno copiado de otro PR no cuenta.
    const mismo = reporte.ordenId === orden.id && reporte.pr === pr.numero && reporte.repo.toLowerCase() === pr.repo.toLowerCase()
    return mismo && reporte.hashCriterios === extraidos.hashCriterios ? reporte : null
  } catch {
    return null
  }
}

function siguientePaso(vigentes: Valido[], riesgo: string | null): { elegido: Valido | null; texto: string } {
  const ultimo = (v: Veredicto) => vigentes.filter((x) => x.reporte.veredicto === v).at(-1) ?? null
  const cambios = ultimo('CAMBIOS')
  if (cambios) {
    const ronda = cambios.reporte.ronda
    return { elegido: cambios, texto: ronda < RONDAS_MAX ? `Corregir (ronda ${ronda + 1} de ${RONDAS_MAX})` : 'Escala al propietario' }
  }
  const inconcluso = ultimo('INCONCLUSO')
  if (inconcluso) return { elegido: inconcluso, texto: 'Revisar entradas del dictamen' }
  const conforme = ultimo('CONFORME')
  if (!conforme) return { elegido: null, texto: 'Lanzar revisión' }
  if (riesgo === 'ALTO') return { elegido: conforme, texto: 'Escala al propietario' }
  // MEDIO (y todo riesgo no reconocido, por prudencia): un CONFORME PRIMERO o DELTA y otro SEGUNDO de otro modelo,
  // ambos de contrato v2 sobre el mismo head. Los de v1 (sin rol ni modelo) no cuentan como segundo revisor.
  const conformes = vigentes.filter((x) => x.reporte.veredicto === 'CONFORME')
  const modelo = (x: Valido) => x.reporte.modelo?.toLowerCase()
  const dobleRevision = conformes.some((p) =>
    (p.reporte.rol === 'PRIMERO' || p.reporte.rol === 'DELTA') &&
    conformes.some((s) => s.reporte.rol === 'SEGUNDO' && modelo(s) !== undefined && modelo(s) !== modelo(p)))
  return { elegido: conforme, texto: riesgo === 'BAJO' || dobleRevision ? LISTO_PARA_DECISION : 'Falta segundo revisor' }
}

function planDe(
  texto: string, validos: Valido[], vigentes: Valido[], elegido: Valido | null, headSha: string, orden: OrdenDictamen,
): PlanLanzamiento | null {
  if (orden.riesgo === 'ALTO') return null
  const numero = (v: Valido) => Number(new RegExp(`^REV-${orden.id}-(\\d{1,6})$`).exec(v.reporte.revisionId)?.[1] ?? 0)
  const base = { headSha, n: Math.max(0, ...validos.map(numero)) + 1 }
  const intento = (tipo: PlanLanzamiento['tipo']) => 1 + vigentes.filter((v) => v.reporte.rol === tipo).length
  if (texto.startsWith('Corregir')) return { ...base, tipo: 'CORREGIR', ronda: elegido!.reporte.ronda + 1, intento: 1, comentarioId: elegido!.id }
  if (texto === 'Falta segundo revisor') return { ...base, tipo: 'SEGUNDO', ronda: elegido!.reporte.ronda, intento: intento('SEGUNDO') }
  if (texto !== 'Lanzar revisión') return null
  // Tras un CAMBIOS en un head anterior y una corrección, toca el delta de la ronda siguiente.
  const previo = validos.at(-1)?.reporte
  const delta = previo?.veredicto === 'CAMBIOS'
  const ronda = (previo?.ronda ?? 0) + (delta ? 1 : 0)
  return ronda > RONDAS_MAX ? null : { ...base, tipo: delta ? 'DELTA' : 'PRIMERO', ronda, intento: 1 }
}

/**
 * DEC-POS-011: el dictamen basta para REVISADA solo si /ordenes lo da por listo: CONFORME de PRIMERO o DELTA del head
 * actual y, salvo en BAJO, un SEGUNDO CONFORME de otro modelo. CAMBIOS, INCONCLUSO o riesgo ALTO no bastan.
 */
export function dictamenSuficiente(ev: EvaluacionDictamen): boolean {
  return ev.estado.tipo === 'vigente' && ev.estado.dictamen.veredicto === 'CONFORME' && ev.siguiente === LISTO_PARA_DECISION
}

export function evaluarDictamen(datos: DatosPr, orden: OrdenDictamen, pr: PrDictamen): EvaluacionDictamen {
  const ev = evaluar(datos, orden, pr)
  return ev.plan && ev.plan.n > N_MAX ? { ...ev, siguiente: CORRELATIVO_AGOTADO, plan: null, agotado: true } : ev
}

function evaluar(datos: DatosPr, orden: OrdenDictamen, pr: PrDictamen): EvaluacionDictamen {
  const marcados = datos.comentarios.filter((c) => tieneMarca(c.body))
  const validos: Valido[] = []
  let ciDetectada = false
  marcados.forEach((c, indice) => {
    const reporte = leer(c.body, orden, pr)
    if (reporte) validos.push({ indice, id: c.id, reporte })
    else if (repoSinCi(pr.repo)) {
      const conCi = leer(c.body, orden, pr, true)
      ciDetectada ||= conCi?.headSha === datos.headSha && conCi.evidencia.ci.estado === 'EXITO'
    }
  })
  const ev = evaluarValidos(datos, orden, pr, marcados.length, validos)
  return ciDetectada ? { ...ev, ciDetectada: true } : ev
}

function evaluarValidos(datos: DatosPr, orden: OrdenDictamen, pr: PrDictamen, marcados: number, validos: Valido[]): EvaluacionDictamen {
  const delHead = validos.filter((v) => v.reporte.headSha === datos.headSha)
  // Del head actual, el último válido por revisionId.
  const porRevision = new Map<string, Valido>()
  for (const v of delHead) porRevision.set(v.reporte.revisionId, v)
  const vigentes = [...porRevision.values()].sort((a, b) => a.indice - b.indice)
  if (vigentes.length === 0) {
    const tipo = validos.length > 0 ? 'anterior' : marcados > 0 ? 'invalido' : 'ninguno'
    return { estado: { tipo }, siguiente: 'Lanzar revisión', plan: planDe('Lanzar revisión', validos, vigentes, null, datos.headSha, orden) }
  }
  const { elegido, texto } = siguientePaso(vigentes, orden.riesgo)
  const r = elegido!.reporte
  const bloquean = r.hallazgos.filter((h) => h.bloquea).length
  return {
    estado: { tipo: 'vigente', dictamen: { veredicto: r.veredicto, ronda: r.ronda, bloquean, noBloquean: r.hallazgos.length - bloquean, sha: r.headSha.slice(0, 7), comentarioId: elegido!.id, ...(repoSinCi(pr.repo) && r.evidencia.ci.estado === 'CI_AUSENTE' && r.evidencia.propias.some((t) => t.codigoSalida === 0) ? { sinCi: true as const } : {}) } },
    siguiente: texto,
    plan: planDe(texto, validos, vigentes, elegido, datos.headSha, orden),
  }
}
