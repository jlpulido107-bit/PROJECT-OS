import type { CambioVigencia, Veredicto } from './types'

/**
 * Validación del reporte de revisión y de su vigencia (contrato §3.1, §3.2, §4).
 * Funciones PURAS: reciben un dato desconocido (por ejemplo, JSON pegado), nunca lanzan excepciones y no hacen E/S.
 * La autenticación del origen la hace el transporte y no se decide aquí.
 */

/** Límites de tamaño documentados: protegen al coordinador de entradas desmesuradas. */
export const LIMITES = {
  /** Identificadores, versiones, comandos, ubicaciones y otros campos cortos. */
  campoCorto: 200,
  /** Evidencias, condiciones, impactos y justificaciones. */
  textoLargo: 2000,
  criterios: 50,
  hallazgos: 100,
  /** Entradas de cada bloque de evidencia (propias y del autor). */
  entradasEvidencia: 50,
} as const

export type ResultadoCriterio = 'CUMPLE' | 'NO_CUMPLE' | 'NO_VERIFICADO'
export type EstadoCi = 'EXITO' | 'FALLO' | 'PENDIENTE' | 'CI_AUSENTE'
export type Severidad = 'CRITICA' | 'ALTA' | 'MEDIA' | 'BAJA'
/** Papel del revisor (contrato v2): revisión completa, delta tras corrección o segundo revisor de MEDIO. */
export type RolRevisor = 'PRIMERO' | 'DELTA' | 'SEGUNDO'
/**
 * Origen del SEGUNDO (DEC-POS-022): revisión propia de Claude (por defecto) o hallazgos de Gemini que una sesión de
 * Claude supervisa y firma, uno por uno.
 */
export type OrigenSegundo = 'claude' | 'gemini-supervisado'
export type VeredictoSupervisor = 'CONFIRMADO' | 'DESCARTADO'
/** Veredicto del supervisor sobre un hallazgo de Gemini, con su evidencia. */
export interface HallazgoGemini { id: string; veredicto: VeredictoSupervisor; evidencia: string }

export interface CriterioReporte { id: string; resultado: ResultadoCriterio; evidencia: string }
export interface PruebaPropia { comando: string; sha: string; codigoSalida: number }
export interface ResultadoCi { estado: EstadoCi; ejecucion?: string; sha?: string }
export interface Hallazgo {
  id: string
  severidad: Severidad
  ubicacion: string
  condicion: string
  impacto: string
  bloquea: boolean
  justificacion: string
}

export interface ReporteRevision {
  versionContrato: string
  /** Solo en la versión 2 del contrato (obligatorios allí); en la 1 quedan sin definir. */
  rol?: RolRevisor
  /** Modelo de la sesión que firma el dictamen. */
  modelo?: string
  /** Solo con rol SEGUNDO (contrato v2). Sin él, el SEGUNDO es de origen `claude`. */
  origenSegundo?: OrigenSegundo
  /** Solo con origen `gemini-supervisado` (obligatorio allí): modelo que produjo los hallazgos. */
  modeloHallazgos?: string
  /** Solo con origen `gemini-supervisado` (obligatorio allí): veredicto del supervisor por hallazgo de Gemini. */
  hallazgosGemini?: HallazgoGemini[]
  versionPolitica: string
  ordenId: string
  tareaId: string
  proyectoId: string
  repo: string
  issue: number
  pr: number
  headSha: string
  baseSha: string
  hashCriterios: string
  revisionId: string
  ejecucionId: string
  intento: number
  /** 0 = revisión inicial; 1 y 2 = correcciones. */
  ronda: number
  autorizacion: { otorgadaPor: string; orden: string; desde: string }
  limiteConsumo: { presupuesto: string; tiempoMaximo: string }
  criterios: CriterioReporte[]
  /** Tres bloques separados (§3.2): una afirmación del autor no sustituye a `propias` ni a `ci`. */
  evidencia: { propias: PruebaPropia[]; ci: ResultadoCi; autor: string[] }
  hallazgos: Hallazgo[]
  veredicto: Veredicto
}

/** Política de la orden que decide qué comprobaciones exige. */
export interface PoliticaReporte {
  /** Si es false (repositorio sin CI, `politica.ts`), CONFORME exige `CI_AUSENTE` y pruebas propias (nunca éxito implícito). */
  ciRequerida: boolean
  /** IDs de los criterios de aceptación de la orden: el reporte debe traer exactamente uno por cada ID. */
  criteriosEsperados: readonly string[]
}

export type ResultadoValidacion =
  | { ok: true; reporte: ReporteRevision }
  | { ok: false; errores: string[] }

export interface ContextoVigencia {
  headSha: string
  baseSha: string
  hashCriterios: string
  versionPolitica: string
}

export type Vigencia = { vigente: true } | { vigente: false; cambios: CambioVigencia[] }

export type ResultadoProcesamiento =
  | { ok: true; reporte: ReporteRevision; vigencia: Vigencia }
  | { ok: false; errores: string[] }

const SHA = /^[0-9a-f]{40}$/
const HASH = /^[0-9a-f]{64}$/
const ORDEN = /^ORD-(POS|SIG|ECO)-\d{3,}$/
const TAREA = /^[A-Z]{2,5}-\d{1,6}$/
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const MODELO = /^[a-z0-9][a-z0-9._-]{2,63}$/
const ROLES: readonly string[] = ['PRIMERO', 'DELTA', 'SEGUNDO']
const ORIGENES: readonly string[] = ['claude', 'gemini-supervisado']
const VEREDICTOS_SUPERVISOR: readonly string[] = ['CONFIRMADO', 'DESCARTADO']
const RESULTADOS: readonly string[] = ['CUMPLE', 'NO_CUMPLE', 'NO_VERIFICADO']
const ESTADOS_CI: readonly string[] = ['EXITO', 'FALLO', 'PENDIENTE', 'CI_AUSENTE']
const SEVERIDADES: readonly string[] = ['CRITICA', 'ALTA', 'MEDIA', 'BAJA']
const VEREDICTOS: readonly string[] = ['CONFORME', 'CAMBIOS', 'INCONCLUSO']

type Obj = Record<string, unknown>
const esObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const entero = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)

class Lector {
  readonly errores: string[] = []
  err(ruta: string, msg: string) { this.errores.push(`${ruta}: ${msg}`) }

  obj(o: Obj, k: string, ruta: string): Obj | null {
    const v = o[k]
    if (esObj(v)) return v
    this.err(`${ruta}${k}`, v === undefined ? 'ausente' : 'debe ser un objeto')
    return null
  }
  texto(o: Obj, k: string, ruta: string, max: number = LIMITES.campoCorto, patron?: RegExp, vacio = false): string {
    const v = o[k]
    if (v === undefined) { this.err(`${ruta}${k}`, 'ausente'); return '' }
    if (typeof v !== 'string') { this.err(`${ruta}${k}`, 'debe ser texto'); return '' }
    if (!vacio && v.trim() === '') { this.err(`${ruta}${k}`, 'vacío'); return '' }
    if (v.length > max) { this.err(`${ruta}${k}`, `supera el límite de ${max} caracteres`); return '' }
    if (patron && !patron.test(v)) { this.err(`${ruta}${k}`, 'formato inválido'); return '' }
    return v
  }
  enteroEn(o: Obj, k: string, ruta: string, min: number, max: number): number {
    const v = o[k]
    if (v === undefined) { this.err(`${ruta}${k}`, 'ausente'); return 0 }
    if (!entero(v) || v < min || v > max) { this.err(`${ruta}${k}`, `debe ser un entero entre ${min} y ${max}`); return 0 }
    return v
  }
  opcion<T extends string>(o: Obj, k: string, ruta: string, validas: readonly string[]): T {
    const v = o[k]
    if (v === undefined) { this.err(`${ruta}${k}`, 'ausente'); return '' as T }
    if (typeof v !== 'string' || !validas.includes(v)) { this.err(`${ruta}${k}`, `debe ser uno de ${validas.join(', ')}`); return '' as T }
    return v as T
  }
  lista(o: Obj, k: string, ruta: string, max: number, minimo = 0): unknown[] {
    const v = o[k]
    if (v === undefined) { this.err(`${ruta}${k}`, 'ausente'); return [] }
    if (!Array.isArray(v)) { this.err(`${ruta}${k}`, 'debe ser una lista'); return [] }
    if (v.length > max) { this.err(`${ruta}${k}`, `supera el límite de ${max} entradas`); return [] }
    if (v.length < minimo) { this.err(`${ruta}${k}`, `requiere al menos ${minimo} entrada(s)`); return [] }
    return v
  }
}

function leerReporte(entrada: unknown, L: Lector): ReporteRevision | null {
  if (!esObj(entrada)) { L.err('reporte', 'debe ser un objeto'); return null }
  const o = entrada
  // §3.1 comunes
  const versionContrato = L.texto(o, 'versionContrato', '', 64)
  const versionPolitica = L.texto(o, 'versionPolitica', '', 64)
  const v2 = versionContrato === '2'
  const rol = v2 ? L.opcion<RolRevisor>(o, 'rol', '', ROLES) : undefined
  const modelo = v2 ? L.texto(o, 'modelo', '', 64, MODELO) : undefined
  const segundo = leerSegundo(o, L, rol)
  const ordenId = L.texto(o, 'ordenId', '', 64, ORDEN)
  const tareaId = L.texto(o, 'tareaId', '', 64, TAREA)
  const proyectoId = L.texto(o, 'proyectoId', '', 8, /^(POS|SIG|ECO)$/)
  const repo = L.texto(o, 'repo', '', LIMITES.campoCorto, REPO)
  const issue = L.enteroEn(o, 'issue', '', 1, 1e9)
  const pr = L.enteroEn(o, 'pr', '', 1, 1e9)
  const headSha = L.texto(o, 'headSha', '', 40, SHA)
  const baseSha = L.texto(o, 'baseSha', '', 40, SHA)
  const hashCriterios = L.texto(o, 'hashCriterios', '', 64, HASH)
  const revisionId = L.texto(o, 'revisionId', '')
  const ejecucionId = L.texto(o, 'ejecucionId', '')
  const intento = L.enteroEn(o, 'intento', '', 1, 1000)
  const ronda = L.enteroEn(o, 'ronda', '', 0, 2)
  const aut = L.obj(o, 'autorizacion', '')
  const autorizacion = {
    otorgadaPor: aut ? L.texto(aut, 'otorgadaPor', 'autorizacion.') : '',
    orden: aut ? L.texto(aut, 'orden', 'autorizacion.') : '',
    desde: aut ? L.texto(aut, 'desde', 'autorizacion.') : '',
  }
  const lim = L.obj(o, 'limiteConsumo', '')
  const limiteConsumo = {
    presupuesto: lim ? L.texto(lim, 'presupuesto', 'limiteConsumo.') : '',
    tiempoMaximo: lim ? L.texto(lim, 'tiempoMaximo', 'limiteConsumo.') : '',
  }

  // Criterios con resultado y evidencia
  const criterios: CriterioReporte[] = []
  L.lista(o, 'criterios', '', LIMITES.criterios, 1).forEach((c, i) => {
    const r = `criterios[${i}].`
    if (!esObj(c)) { L.err(`criterios[${i}]`, 'debe ser un objeto'); return }
    criterios.push({
      id: L.texto(c, 'id', r),
      resultado: L.opcion<ResultadoCriterio>(c, 'resultado', r, RESULTADOS),
      evidencia: L.texto(c, 'evidencia', r, LIMITES.textoLargo),
    })
  })

  // Evidencia en tres bloques separados (§3.2)
  const ev = L.obj(o, 'evidencia', '')
  const propias: PruebaPropia[] = []
  const autor: string[] = []
  let ci: ResultadoCi = { estado: 'CI_AUSENTE' }
  if (ev) {
    L.lista(ev, 'propias', 'evidencia.', LIMITES.entradasEvidencia).forEach((p, i) => {
      const r = `evidencia.propias[${i}].`
      if (!esObj(p)) { L.err(`evidencia.propias[${i}]`, 'debe ser un objeto'); return }
      const codigoSalida = p.codigoSalida
      if (!entero(codigoSalida)) L.err(`${r}codigoSalida`, codigoSalida === undefined ? 'ausente' : 'debe ser un entero')
      propias.push({ comando: L.texto(p, 'comando', r), sha: L.texto(p, 'sha', r, 40, SHA), codigoSalida: entero(codigoSalida) ? codigoSalida : -1 })
    })
    const c = L.obj(ev, 'ci', 'evidencia.')
    if (c) {
      ci = { estado: L.opcion<EstadoCi>(c, 'estado', 'evidencia.ci.', ESTADOS_CI) }
      if (c.ejecucion !== undefined) ci.ejecucion = L.texto(c, 'ejecucion', 'evidencia.ci.')
      if (c.sha !== undefined) ci.sha = L.texto(c, 'sha', 'evidencia.ci.', 40, SHA)
    }
    L.lista(ev, 'autor', 'evidencia.', LIMITES.entradasEvidencia).forEach((t, i) => {
      if (typeof t !== 'string' || t.length > LIMITES.textoLargo) L.err(`evidencia.autor[${i}]`, `debe ser texto de hasta ${LIMITES.textoLargo} caracteres`)
      else autor.push(t)
    })
  }

  // Hallazgos
  const hallazgos: Hallazgo[] = []
  L.lista(o, 'hallazgos', '', LIMITES.hallazgos).forEach((h, i) => {
    const r = `hallazgos[${i}].`
    if (!esObj(h)) { L.err(`hallazgos[${i}]`, 'debe ser un objeto'); return }
    if (typeof h.bloquea !== 'boolean') L.err(`${r}bloquea`, h.bloquea === undefined ? 'ausente' : 'debe ser booleano')
    const bloquea = h.bloquea === true
    hallazgos.push({
      id: L.texto(h, 'id', r),
      severidad: L.opcion<Severidad>(h, 'severidad', r, SEVERIDADES),
      ubicacion: L.texto(h, 'ubicacion', r),
      condicion: L.texto(h, 'condicion', r, LIMITES.textoLargo),
      impacto: L.texto(h, 'impacto', r, LIMITES.textoLargo),
      bloquea,
      // La justificación es obligatoria solo cuando el hallazgo bloquea (§3.2).
      justificacion: L.texto(h, 'justificacion', r, LIMITES.textoLargo, undefined, !bloquea),
    })
  })

  const veredicto = L.opcion<Veredicto>(o, 'veredicto', '', VEREDICTOS)
  if (L.errores.length > 0) return null
  return {
    versionContrato, ...(v2 ? { rol, modelo } : {}), ...segundo, versionPolitica, ordenId, tareaId, proyectoId, repo, issue, pr, headSha, baseSha, hashCriterios,
    revisionId, ejecucionId, intento, ronda, autorizacion, limiteConsumo, criterios,
    evidencia: { propias, ci, autor }, hallazgos, veredicto,
  }
}

/**
 * Campos del SEGUNDO (DEC-POS-022): `origenSegundo`, `modeloHallazgos` y `hallazgosGemini` solo valen con rol SEGUNDO;
 * los dos últimos, solo con origen `gemini-supervisado`, que los exige.
 */
function leerSegundo(o: Obj, L: Lector, rol: RolRevisor | undefined): Pick<ReporteRevision, 'origenSegundo' | 'modeloHallazgos' | 'hallazgosGemini'> {
  const campos = ['origenSegundo', 'modeloHallazgos', 'hallazgosGemini'] as const
  if (rol !== 'SEGUNDO') {
    for (const k of campos) if (o[k] !== undefined) L.err(k, 'solo vale con rol SEGUNDO (contrato v2)')
    return {}
  }
  if (o.origenSegundo === undefined) {
    for (const k of campos.slice(1)) if (o[k] !== undefined) L.err(k, 'solo vale con origenSegundo gemini-supervisado')
    return {}
  }
  const origenSegundo = L.opcion<OrigenSegundo>(o, 'origenSegundo', '', ORIGENES)
  if (origenSegundo !== 'gemini-supervisado') {
    for (const k of campos.slice(1)) if (o[k] !== undefined) L.err(k, 'solo vale con origenSegundo gemini-supervisado')
    return { origenSegundo }
  }
  const modeloHallazgos = L.texto(o, 'modeloHallazgos', '', 64, MODELO)
  const hallazgosGemini: HallazgoGemini[] = []
  L.lista(o, 'hallazgosGemini', '', LIMITES.hallazgos, 1).forEach((h, i) => {
    const r = `hallazgosGemini[${i}].`
    if (!esObj(h)) { L.err(`hallazgosGemini[${i}]`, 'debe ser un objeto'); return }
    hallazgosGemini.push({
      id: L.texto(h, 'id', r),
      veredicto: L.opcion<VeredictoSupervisor>(h, 'veredicto', r, VEREDICTOS_SUPERVISOR),
      evidencia: L.texto(h, 'evidencia', r, LIMITES.textoLargo),
    })
  })
  return { origenSegundo, modeloHallazgos, hallazgosGemini }
}

/** Veredicto que corresponde a los criterios y hallazgos, sin mirar las comprobaciones (§3.2). */
function veredictoPorEvidencia(r: ReporteRevision): Veredicto | null {
  const bloquea = r.hallazgos.some((h) => h.bloquea)
  const noCumple = r.criterios.some((c) => c.resultado === 'NO_CUMPLE')
  if (bloquea || noCumple) return 'CAMBIOS'
  if (r.criterios.some((c) => c.resultado === 'NO_VERIFICADO')) return 'INCONCLUSO'
  return null // todo CUMPLE y sin bloqueantes: solo falta que las comprobaciones sean válidas
}

/** Motivos por los que las comprobaciones requeridas no son válidas para el head revisado. Vacío = válidas. */
function problemasComprobaciones(r: ReporteRevision, politica: PoliticaReporte): string[] {
  const p: string[] = []
  const { propias, ci } = r.evidencia
  if (propias.length === 0) p.push('no hay pruebas propias del revisor')
  for (const [i, t] of propias.entries()) {
    if (t.sha !== r.headSha) p.push(`la prueba propia ${i} corresponde a otro head`)
    if (t.codigoSalida !== 0) p.push(`la prueba propia ${i} no terminó con código 0`)
  }
  switch (ci.estado) {
    case 'EXITO':
      if (!politica.ciRequerida) p.push('CI EXITO en un repositorio declarado sin CI')
      else if (ci.sha !== r.headSha) p.push('la CI exitosa no es del head revisado')
      break
    case 'CI_AUSENTE':
      if (politica.ciRequerida) p.push('CI_AUSENTE con CI requerida por la política')
      break
    case 'PENDIENTE': p.push('la CI está pendiente'); break
    case 'FALLO': p.push('la CI falló'); break
  }
  return p
}

/** Criterios faltantes, sobrantes o repetidos respecto de los de la orden (§3.2: todos los criterios). */
function problemasCriterios(r: ReporteRevision, politica: PoliticaReporte): string[] {
  const esperados = new Set(politica.criteriosEsperados)
  const vistos = new Set<string>()
  const p: string[] = []
  for (const c of r.criterios) {
    if (vistos.has(c.id)) p.push(`criterios: el criterio ${c.id} está repetido`)
    else if (!esperados.has(c.id)) p.push(`criterios: el criterio ${c.id} no pertenece a la orden`)
    vistos.add(c.id)
  }
  for (const id of esperados) if (!vistos.has(id)) p.push(`criterios: falta el criterio ${id}`)
  return p
}

/**
 * Un hallazgo de Gemini CONFIRMADO por el supervisor (DEC-POS-022) tiene que estar en `hallazgos` con el mismo id; si
 * no, el veredicto no puede ser CONFORME.
 */
function problemasGemini(r: ReporteRevision): string[] {
  if (r.veredicto !== 'CONFORME') return []
  const propios = new Set(r.hallazgos.map((h) => h.id))
  return (r.hallazgosGemini ?? []).filter((h) => h.veredicto === 'CONFIRMADO' && !propios.has(h.id))
    .map((h) => `hallazgosGemini: ${h.id} CONFIRMADO sin hallazgo propio con el mismo id; el veredicto no puede ser CONFORME`)
}

/** Coherencia del veredicto con su evidencia (§3.2). Devuelve los errores; vacío = coherente. */
function coherencia(r: ReporteRevision, politica: PoliticaReporte): string[] {
  const faltas = [...problemasCriterios(r, politica), ...problemasGemini(r)]
  if (faltas.length > 0) return faltas
  const esperado = veredictoPorEvidencia(r)
  if (esperado !== null) {
    return r.veredicto === esperado ? [] : [`veredicto: ${r.veredicto} incoherente con la evidencia, corresponde ${esperado}`]
  }
  const problemas = problemasComprobaciones(r, politica)
  if (r.veredicto === 'CONFORME') return problemas.map((m) => `veredicto: CONFORME no válido, ${m}`)
  return [`veredicto: ${r.veredicto} incoherente con la evidencia (criterios CUMPLE y sin bloqueantes)`]
}

/** Valida un reporte desconocido y su coherencia con la política. No lanza excepciones. */
export function validarReporte(entrada: unknown, politica: PoliticaReporte): ResultadoValidacion {
  try {
    const L = new Lector()
    const reporte = leerReporte(entrada, L)
    if (!reporte) return { ok: false, errores: L.errores }
    const errores = coherencia(reporte, politica)
    return errores.length > 0 ? { ok: false, errores } : { ok: true, reporte }
  } catch {
    return { ok: false, errores: ['reporte: no se pudo leer'] }
  }
}

/** Vigente solo si head, base, hash de criterios y versión de política coinciden con el contexto (§4). */
export function clasificarVigencia(reporte: ReporteRevision, ctx: ContextoVigencia): Vigencia {
  const cambios: CambioVigencia[] = []
  if (reporte.headSha !== ctx.headSha) cambios.push('HEAD')
  if (reporte.baseSha !== ctx.baseSha) cambios.push('BASE')
  if (reporte.hashCriterios !== ctx.hashCriterios) cambios.push('CRITERIOS')
  if (reporte.versionPolitica !== ctx.versionPolitica) cambios.push('POLITICA')
  return cambios.length === 0 ? { vigente: true } : { vigente: false, cambios }
}

/** Valida y clasifica. Un reporte histórico se devuelve marcado y nunca como vigente. */
export function procesarReporte(entrada: unknown, politica: PoliticaReporte, ctx: ContextoVigencia): ResultadoProcesamiento {
  const v = validarReporte(entrada, politica)
  return v.ok ? { ok: true, reporte: v.reporte, vigencia: clasificarVigencia(v.reporte, ctx) } : v
}
