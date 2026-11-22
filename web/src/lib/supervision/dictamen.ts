import { extraerCriterios } from './criterios'
import { esFamiliaClaude, FAMILIA_IMPLEMENTADOR, familiaModelo, ordenSensible, politicaDeRepo, repoSinCi } from './politica'
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

export interface OrdenDictamen {
  id: string; riesgo: string | null; criterios: string | null
  /** Columna SENSIBLE de ORDENES_CODEX (DEC-POS-019). Ausente o vacía = sensible (ordenSensible). */
  sensible?: string | null
}
export interface PrDictamen { repo: string; numero: number }
/**
 * Bandera del propietario (DEC-POS-014): sin `geminiSupervisado`, un SEGUNDO de origen gemini-supervisado no cuenta
 * (como si no hubiera SEGUNDO). Los llamadores la toman de segundoGeminiSupervisado (operations/config.ts).
 */
export interface OpcionesDictamen {
  geminiSupervisado?: boolean
  /**
   * Registro de modelos de las sesiones de la orden (ORD-POS-165, DEC-POS-039). Ausente = bandera
   * SUPERVISION_MODELO_SESION apagada: todo sigue como antes (campo `modelo` del dictamen y FAMILIA_IMPLEMENTADOR).
   * Presente = encendida: el modelo del revisor y la familia del implementador salen solo de aquí; lo que falte no cuenta.
   */
  modelosSesion?: RegistroModelos
}

export type PapelSesion = 'IMPLEMENTACION' | 'CORRECCION' | 'REVISION'

/** Alta del PM (`orden.modelo_sesion`) de una sesión enlazada a la orden: los dos datos de `get_session` en un head. */
export interface ModeloRegistrado {
  papel: PapelSesion
  sesion: string
  /** Head del PR al registrar. Solo cuentan los registros del head que se evalúa. */
  head: string
  /** Solo REVISION: correlativo de `REV-<orden>-<n>`, tomado del lanzamiento del dashboard (nunca del dictamen ni del PM). */
  n?: number
  configurado: string
  servido: string
}

export interface RegistroModelos {
  registros: readonly ModeloRegistrado[]
  /** Sesiones de corrección que el dashboard lanzó para la orden: cada una necesita su registro en el head. */
  correcciones: readonly string[]
}

/** Registro vacío: con la bandera encendida y sin poder leer AUDITORIA, nada es verificable (falla cerrado). */
export const REGISTRO_VACIO: RegistroModelos = Object.freeze({ registros: [], correcciones: [] })

/**
 * Familias de los modelos registrados (configurado y servido de cada registro). null = no verificable: sin registros o
 * con algún modelo no reconocido, que nunca cuenta.
 */
function familiasDe(registros: readonly ModeloRegistrado[]): string[] | null {
  if (registros.length === 0) return null
  const familias = registros.flatMap((r) => [familiaModelo(r.configurado), familiaModelo(r.servido)])
  return familias.every((f): f is string => f !== null) ? [...new Set(familias)] : null
}

/** Registros de la sesión lanzada para el dictamen `r`: mismo head y mismo correlativo de `REV-<orden>-<n>`. */
function registrosDeRevision(registro: RegistroModelos, ordenId: string, r: Pick<ReporteRevision, 'revisionId' | 'headSha'>): ModeloRegistrado[] {
  const n = new RegExp(`^REV-${ordenId}-(\\d{1,3})$`).exec(r.revisionId)?.[1]
  return n === undefined ? [] : registro.registros.filter((x) => x.papel === 'REVISION' && x.head === r.headSha && x.n === Number(n))
}

/**
 * Familias de quienes escribieron el código del head (DEC-POS-039, punto 4): la sesión que implementó y cada sesión de
 * corrección lanzada. null si falta el registro de alguna en ese head o un modelo no se reconoce.
 */
function familiasImplementador(registro: RegistroModelos, head: string): string[] | null {
  const delHead = registro.registros.filter((x) => x.head === head)
  const implementacion = delHead.filter((x) => x.papel === 'IMPLEMENTACION')
  if (implementacion.length === 0) return null
  const correcciones = delHead.filter((x) => x.papel === 'CORRECCION')
  if (registro.correcciones.some((sesion) => !correcciones.some((x) => x.sesion === sesion))) return null
  return familiasDe([...implementacion, ...correcciones])
}

interface Valido { indice: number; id: number; reporte: ReporteRevision }

const tieneMarca = (body: string) => body.split('\n', 1)[0]!.replace(/\r$/, '') === MARCA_DICTAMEN

function leer(body: string, orden: OrdenDictamen, pr: PrDictamen, opciones: OpcionesDictamen, ciRequerida = !repoSinCi(pr.repo)): ReporteRevision | null {
  const extraidos = extraerCriterios(orden.criterios ?? '')
  const json = BLOQUE_JSON.exec(body)?.[1]
  if (!extraidos.ok || json === undefined) return null
  try {
    const registro = opciones.modelosSesion
    const r = validarReporte(JSON.parse(json), { ...politicaDeRepo(pr.repo, extraidos.criteriosEsperados), ciRequerida, modeloOpcional: registro !== undefined })
    if (!r.ok) return null
    const { reporte } = r
    // Contrato v2 sin `modelo` (ORD-POS-165): solo vale con la bandera encendida y un registro de su sesión enlazada.
    if (reporte.rol !== undefined && reporte.modelo === undefined && (!registro || registrosDeRevision(registro, orden.id, reporte).length === 0)) return null
    // El dictamen debe ser de esta orden y de este PR: uno copiado de otro PR no cuenta.
    const mismo = reporte.ordenId === orden.id && reporte.pr === pr.numero && reporte.repo.toLowerCase() === pr.repo.toLowerCase()
    return mismo && reporte.hashCriterios === extraidos.hashCriterios ? reporte : null
  } catch {
    return null
  }
}

/**
 * SEGUNDO que cuenta como otro modelo frente al PRIMERO o DELTA `p` (DEC-POS-022). Se compara por familia de modelo
 * (familiaModelo); el firmante siempre es un modelo de Claude reconocido y, venga de donde venga el SEGUNDO, nunca de
 * la familia del implementador (DEC-POS-035, ORD-POS-161).
 * - Origen `claude` (o sin origen): la familia del firmante distinta de la de `p`.
 * - Origen `gemini-supervisado`: solo con la bandera del propietario; la de `modeloHallazgos` (Gemini) distinta de la
 *   de `p`.
 * El PRIMERO o DELTA `p` también tiene que ser de una familia de Claude reconocida.
 */
function segundoDeOtroModelo(s: ReporteRevision, p: ReporteRevision, opciones: OpcionesDictamen, ordenId: string): boolean {
  if (s.rol !== 'SEGUNDO') return false
  if (opciones.modelosSesion) return segundoPorRegistro(s, p, opciones, opciones.modelosSesion, ordenId)
  const firmante = familiaModelo(s.modelo)
  const revisor = familiaModelo(p.modelo)
  if (!esFamiliaClaude(firmante) || !esFamiliaClaude(revisor) || firmante === FAMILIA_IMPLEMENTADOR) return false
  if (s.origenSegundo === 'gemini-supervisado') {
    if (opciones.geminiSupervisado !== true) return false
    const hallazgos = familiaModelo(s.modeloHallazgos)
    return hallazgos === 'gemini' && hallazgos !== revisor
  }
  return firmante !== revisor
}

/**
 * La misma regla con SUPERVISION_MODELO_SESION encendida (ORD-POS-165, DEC-POS-039): las familias salen del registro de
 * cada sesión enlazada y no del campo `modelo`, que se ignora. Cada sesión aporta la familia de su modelo configurado y
 * la del servido; si difieren, ninguna puede coincidir. Sin registro del firmante, del PRIMERO o DELTA, o de quien
 * implementó o corrigió, o con un modelo no reconocido, no cuenta («Falta segundo revisor»).
 */
function segundoPorRegistro(s: ReporteRevision, p: ReporteRevision, opciones: OpcionesDictamen, registro: RegistroModelos, ordenId: string): boolean {
  const firmante = familiasDe(registrosDeRevision(registro, ordenId, s))
  const revisor = familiasDe(registrosDeRevision(registro, ordenId, p))
  const implementador = familiasImplementador(registro, s.headSha)
  if (!firmante || !revisor || !implementador) return false
  if (![...firmante, ...revisor].every(esFamiliaClaude) || firmante.some((f) => implementador.includes(f))) return false
  if (s.origenSegundo === 'gemini-supervisado') {
    return opciones.geminiSupervisado === true && familiaModelo(s.modeloHallazgos) === 'gemini'
  }
  return !firmante.some((f) => revisor.includes(f))
}

function siguientePaso(vigentes: Valido[], orden: OrdenDictamen, opciones: OpcionesDictamen): { elegido: Valido | null; texto: string } {
  const { riesgo } = orden
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
  const conformes = vigentes.filter((x) => x.reporte.veredicto === 'CONFORME')
  const primeros = conformes.filter((p) => p.reporte.rol === 'PRIMERO' || p.reporte.rol === 'DELTA')
  // DEC-POS-019: MEDIO no sensible (SENSIBLE = NO) queda listo con un CONFORME PRIMERO o DELTA de contrato v2.
  if (riesgo === 'MEDIO' && !ordenSensible(orden.sensible) && primeros.length > 0) return { elegido: conforme, texto: LISTO_PARA_DECISION }
  // MEDIO sensible (y todo riesgo no reconocido, por prudencia): un CONFORME PRIMERO o DELTA y otro SEGUNDO de otro
  // modelo, ambos de contrato v2 sobre el mismo head. Los de v1 (sin rol ni modelo) no cuentan como segundo revisor.
  const dobleRevision = primeros.some((p) => conformes.some((s) => segundoDeOtroModelo(s.reporte, p.reporte, opciones, orden.id)))
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
 * actual y, en MEDIO sensible, un SEGUNDO CONFORME de otro modelo (DEC-POS-019 y DEC-POS-022). CAMBIOS, INCONCLUSO o
 * riesgo ALTO no bastan.
 */
export function dictamenSuficiente(ev: EvaluacionDictamen): boolean {
  return ev.estado.tipo === 'vigente' && ev.estado.dictamen.veredicto === 'CONFORME' && ev.siguiente === LISTO_PARA_DECISION
}

/**
 * Dictámenes válidos del PR para la orden (ORD-POS-078, /agentes): los mismos que cuenta /ordenes, de cualquier head,
 * el último de cada revisionId. Solo veredicto, rol y ronda; nunca el texto del comentario.
 */
export function dictamenesValidos(datos: DatosPr, orden: OrdenDictamen, pr: PrDictamen, opciones: OpcionesDictamen = {}): Array<Pick<ReporteRevision, 'revisionId' | 'veredicto' | 'ronda' | 'headSha'>> {
  const porRevision = new Map<string, ReporteRevision>()
  for (const c of datos.comentarios) {
    const r = tieneMarca(c.body) ? leer(c.body, orden, pr, opciones) : null
    if (r) porRevision.set(r.revisionId, r)
  }
  return [...porRevision.values()].map(({ revisionId, veredicto, ronda, headSha }) => ({ revisionId, veredicto, ronda, headSha }))
}

export function evaluarDictamen(datos: DatosPr, orden: OrdenDictamen, pr: PrDictamen, opciones: OpcionesDictamen = {}): EvaluacionDictamen {
  const ev = evaluar(datos, orden, pr, opciones)
  return ev.plan && ev.plan.n > N_MAX ? { ...ev, siguiente: CORRELATIVO_AGOTADO, plan: null, agotado: true } : ev
}

function evaluar(datos: DatosPr, orden: OrdenDictamen, pr: PrDictamen, opciones: OpcionesDictamen): EvaluacionDictamen {
  const marcados = datos.comentarios.filter((c) => tieneMarca(c.body))
  const validos: Valido[] = []
  let ciDetectada = false
  marcados.forEach((c, indice) => {
    const reporte = leer(c.body, orden, pr, opciones)
    if (reporte) validos.push({ indice, id: c.id, reporte })
    else if (repoSinCi(pr.repo)) {
      const conCi = leer(c.body, orden, pr, opciones, true)
      ciDetectada ||= conCi?.headSha === datos.headSha && conCi.evidencia.ci.estado === 'EXITO'
    }
  })
  const ev = evaluarValidos(datos, orden, pr, marcados.length, validos, opciones)
  return ciDetectada ? { ...ev, ciDetectada: true } : ev
}

function evaluarValidos(datos: DatosPr, orden: OrdenDictamen, pr: PrDictamen, marcados: number, validos: Valido[], opciones: OpcionesDictamen): EvaluacionDictamen {
  const delHead = validos.filter((v) => v.reporte.headSha === datos.headSha)
  // Del head actual, el último válido por revisionId.
  const porRevision = new Map<string, Valido>()
  for (const v of delHead) porRevision.set(v.reporte.revisionId, v)
  const vigentes = [...porRevision.values()].sort((a, b) => a.indice - b.indice)
  if (vigentes.length === 0) {
    const tipo = validos.length > 0 ? 'anterior' : marcados > 0 ? 'invalido' : 'ninguno'
    return { estado: { tipo }, siguiente: 'Lanzar revisión', plan: planDe('Lanzar revisión', validos, vigentes, null, datos.headSha, orden) }
  }
  const { elegido, texto } = siguientePaso(vigentes, orden, opciones)
  const r = elegido!.reporte
  const bloquean = r.hallazgos.filter((h) => h.bloquea).length
  return {
    estado: { tipo: 'vigente', dictamen: { veredicto: r.veredicto, ronda: r.ronda, bloquean, noBloquean: r.hallazgos.length - bloquean, sha: r.headSha.slice(0, 7), comentarioId: elegido!.id, ...(repoSinCi(pr.repo) && r.evidencia.ci.estado === 'CI_AUSENTE' && r.evidencia.propias.some((t) => t.codigoSalida === 0) ? { sinCi: true as const } : {}) } },
    siguiente: texto,
    plan: planDe(texto, validos, vigentes, elegido, datos.headSha, orden),
  }
}
