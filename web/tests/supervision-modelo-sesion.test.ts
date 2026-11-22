import { describe, expect, it } from 'vitest'
import { extraerCriterios } from '@/lib/supervision/criterios'
import {
  dictamenSuficiente, evaluarDictamen, MARCA_DICTAMEN, REGISTRO_VACIO,
  type ModeloRegistrado, type OpcionesDictamen, type RegistroModelos,
} from '@/lib/supervision/dictamen'
import { FAMILIA_IMPLEMENTADOR } from '@/lib/supervision/politica'

/**
 * ORD-POS-165 (DEC-POS-039): con SUPERVISION_MODELO_SESION encendida (opción `modelosSesion` presente), el modelo del
 * revisor y la familia del implementador salen del registro de cada sesión enlazada, no del campo `modelo` del dictamen
 * ni de FAMILIA_IMPLEMENTADOR. Funciones puras: sin red ni hoja.
 */

const ORDEN = 'ORD-POS-902'
const HEAD = 'a'.repeat(40)
const OTRO_HEAD = 'c'.repeat(40)
const CRITERIOS = '1. Uno\n2. Dos'
const crit = extraerCriterios(CRITERIOS)
if (!crit.ok) throw new Error('criterios de prueba inválidos')

const FABLE = 'claude-fable-5-2'
const OPUS = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-5-5'
const HAIKU = 'claude-haiku-5-5'

/** Dictamen v2 CONFORME de `REV-<orden>-<n>`; sin `modelo` si no se pasa. */
const reporte = (rol: string, n: number, modelo?: string, extra: Record<string, unknown> = {}) => ({
  versionContrato: '2', rol, ...(modelo ? { modelo } : {}), versionPolitica: 'DEC-POS-039', ordenId: ORDEN, tareaId: 'DEMO-002',
  proyectoId: 'POS', repo: 'jlpulido107-bit/PROJECT-OS', issue: 49, pr: 50, headSha: HEAD, baseSha: 'b'.repeat(40), hashCriterios: crit.hashCriterios,
  revisionId: `REV-${ORDEN}-${n}`, ejecucionId: `EJE-${ORDEN}-${n}`, intento: 1, ronda: 0,
  autorizacion: { otorgadaPor: 'propietario', orden: ORDEN, desde: '2026-11-22' }, limiteConsumo: { presupuesto: '1 USD', tiempoMaximo: '30 min' },
  criterios: [{ id: '1', resultado: 'CUMPLE', evidencia: 'ok' }, { id: '2', resultado: 'CUMPLE', evidencia: 'ok' }],
  evidencia: { propias: [{ comando: 'npm test', sha: HEAD, codigoSalida: 0 }], ci: { estado: 'EXITO', ejecucion: 'r1', sha: HEAD }, autor: [] },
  hallazgos: [], veredicto: 'CONFORME', ...extra,
})
const gemini = (n: number, modelo?: string) => reporte('SEGUNDO', n, modelo, {
  origenSegundo: 'gemini-supervisado', modeloHallazgos: 'gemini-2.5-pro', hallazgosGemini: [{ id: 'G1', veredicto: 'DESCARTADO', evidencia: 'npm test pasa en el head' }],
})

const sesion = (nombre: string) => `https://claude.ai/code/session_${nombre}`
const implementa = (configurado: string, servido = configurado, head = HEAD): ModeloRegistrado =>
  ({ papel: 'IMPLEMENTACION', sesion: sesion('impl'), head, configurado, servido })
const corrige = (configurado: string, servido = configurado, nombre = 'corr'): ModeloRegistrado =>
  ({ papel: 'CORRECCION', sesion: sesion(nombre), head: HEAD, configurado, servido })
const revisa = (n: number, configurado: string, servido = configurado, head = HEAD): ModeloRegistrado =>
  ({ papel: 'REVISION', sesion: sesion(`rev${n}`), head, n, configurado, servido })
const registro = (registros: ModeloRegistrado[], correcciones: string[] = []): RegistroModelos => ({ registros, correcciones })

function evaluar(reportes: unknown[], opciones: OpcionesDictamen = {}, riesgo = 'MEDIO', sensible: string | null = null) {
  const comentarios = reportes.map((r, i) => ({ id: i + 1, body: `${MARCA_DICTAMEN}\n\n\`\`\`json\n${JSON.stringify(r)}\n\`\`\`` }))
  return evaluarDictamen({ headSha: HEAD, comentarios }, { id: ORDEN, riesgo, criterios: CRITERIOS, sensible }, { repo: 'jlpulido107-bit/PROJECT-OS', numero: 50 }, opciones)
}
const paso = (reportes: unknown[], modelosSesion?: RegistroModelos, extra: OpcionesDictamen = {}) =>
  evaluar(reportes, { ...extra, ...(modelosSesion ? { modelosSesion } : {}) }).siguiente

const LISTO = 'Listo para tu decisión'
const FALTA = 'Falta segundo revisor'
/** PRIMERO de Sonnet con `modelo` declarado y SEGUNDO sin `modelo`: el caso de ORD-POS-162 y 163. */
const PAR = [reporte('PRIMERO', 1, SONNET), reporte('SEGUNDO', 2)]
const base = (segundo: ModeloRegistrado = revisa(2, HAIKU), implementador: ModeloRegistrado = implementa(FABLE)) =>
  registro([implementador, revisa(1, SONNET), segundo])

describe('bandera apagada: todo sigue como antes', () => {
  it('un SEGUNDO sin `modelo` no es un dictamen válido y falta segundo revisor', () => {
    const ev = evaluar(PAR)
    expect(ev.siguiente).toBe(FALTA)
    expect(dictamenSuficiente(ev)).toBe(false)
  })

  it('un PRIMERO sin `modelo` es inválido: hay que lanzar la revisión', () => {
    expect(evaluar([reporte('PRIMERO', 1)])).toMatchObject({ estado: { tipo: 'invalido' }, siguiente: 'Lanzar revisión' })
  })

  it('con `modelo` declarado manda el texto del dictamen y la constante FAMILIA_IMPLEMENTADOR', () => {
    expect(paso([reporte('PRIMERO', 1, SONNET), reporte('SEGUNDO', 2, HAIKU)])).toBe(LISTO)
    expect(paso([reporte('PRIMERO', 1, SONNET), reporte('SEGUNDO', 2, `claude-${FAMILIA_IMPLEMENTADOR}-5-2`)])).toBe(FALTA)
    expect(paso([reporte('PRIMERO', 1, SONNET), reporte('SEGUNDO', 2, SONNET)])).toBe(FALTA)
  })
})

describe('criterio 1: un SEGUNDO sin `modelo` cuenta por su sesión enlazada', () => {
  it('Haiku registrado, distinto del implementador (Fable) y del PRIMERO (Sonnet): listo y suficiente para REVISADA', () => {
    const ev = evaluar(PAR, { modelosSesion: base() })
    expect(ev.siguiente).toBe(LISTO)
    expect(ev.plan).toBeNull()
    expect(dictamenSuficiente(ev)).toBe(true)
  })

  it('también el PRIMERO puede venir sin `modelo` si su sesión está registrada', () => {
    expect(paso([reporte('PRIMERO', 1), reporte('SEGUNDO', 2)], base())).toBe(LISTO)
    expect(paso([reporte('DELTA', 1), reporte('SEGUNDO', 2)], base())).toBe(LISTO)
  })

  it('de la familia del PRIMERO o de la del implementador no cuenta', () => {
    expect(paso(PAR, base(revisa(2, SONNET)))).toBe(FALTA)
    expect(paso(PAR, base(revisa(2, FABLE)))).toBe(FALTA)
    expect(paso(PAR, base(revisa(2, 'claude-sonnet-5-5[1m]')))).toBe(FALTA)
  })

  it('el campo `modelo` del texto se ignora: manda el registro de la sesión', () => {
    // Declara Haiku pero su sesión corrió con Sonnet, el modelo del PRIMERO.
    expect(paso([reporte('PRIMERO', 1, SONNET), reporte('SEGUNDO', 2, HAIKU)], base(revisa(2, SONNET)))).toBe(FALTA)
    // Declara el modelo del PRIMERO pero su sesión corrió con Haiku.
    expect(paso([reporte('PRIMERO', 1, SONNET), reporte('SEGUNDO', 2, SONNET)], base())).toBe(LISTO)
    // El PRIMERO declara Sonnet pero su sesión corrió con Haiku, como el SEGUNDO.
    expect(paso(PAR, registro([implementa(FABLE), revisa(1, HAIKU), revisa(2, HAIKU)]))).toBe(FALTA)
  })
})

describe('criterio 2: la familia del implementador sale del registro de cada orden, no de una constante', () => {
  it('orden implementada por Opus: un SEGUNDO de Opus no cuenta y uno de la familia de la constante sí', () => {
    expect(paso(PAR, base(revisa(2, OPUS), implementa(OPUS)))).toBe(FALTA)
    expect(paso(PAR, base(revisa(2, `claude-${FAMILIA_IMPLEMENTADOR}-5-2`), implementa(OPUS)))).toBe(LISTO)
  })

  it('una corrección lanzada cuenta como implementador: necesita registro y su familia tampoco firma el SEGUNDO', () => {
    const conCorreccion = (corr: ModeloRegistrado[]) => registro([implementa(FABLE), revisa(1, SONNET), revisa(2, HAIKU), ...corr], [sesion('corr')])
    expect(paso(PAR, conCorreccion([]))).toBe(FALTA)
    expect(paso(PAR, conCorreccion([corrige(HAIKU)]))).toBe(FALTA)
    expect(paso(PAR, conCorreccion([corrige(OPUS, OPUS, 'otra')]))).toBe(FALTA)
    expect(paso(PAR, conCorreccion([corrige(OPUS)]))).toBe(LISTO)
  })
})

describe('criterio 3: si la sesión no se puede verificar, falta segundo revisor', () => {
  it.each([
    ['registro vacío (AUDITORIA ilegible)', REGISTRO_VACIO],
    ['sin registro del implementador', registro([revisa(1, SONNET), revisa(2, HAIKU)])],
    ['sin registro del PRIMERO', registro([implementa(FABLE), revisa(2, HAIKU)])],
    ['registro del implementador de otro head', registro([implementa(FABLE, FABLE, OTRO_HEAD), revisa(1, SONNET), revisa(2, HAIKU)])],
    ['registro del PRIMERO de otro head', registro([implementa(FABLE), revisa(1, SONNET, SONNET, OTRO_HEAD), revisa(2, HAIKU)])],
  ])('%s', (_, modelos) => {
    const ev = evaluar([reporte('PRIMERO', 1, SONNET), reporte('SEGUNDO', 2, HAIKU)], { modelosSesion: modelos })
    expect(ev.siguiente).toBe(FALTA)
    expect(ev.plan?.tipo).toBe('SEGUNDO')
    expect(dictamenSuficiente(ev)).toBe(false)
  })

  it.each([
    ['sin registro de su sesión', registro([implementa(FABLE), revisa(1, SONNET)])],
    ['con el registro de otra revisión', registro([implementa(FABLE), revisa(1, SONNET), revisa(3, HAIKU)])],
    ['con su registro en otro head', registro([implementa(FABLE), revisa(1, SONNET), revisa(2, HAIKU, HAIKU, OTRO_HEAD)])],
  ])('un SEGUNDO sin `modelo` y %s no es válido', (_, modelos) => {
    expect(paso(PAR, modelos)).toBe(FALTA)
  })

  it('un PRIMERO sin `modelo` y sin registro es inválido, con la bandera encendida también', () => {
    expect(evaluar([reporte('PRIMERO', 1)], { modelosSesion: registro([implementa(FABLE)]) })).toMatchObject({ estado: { tipo: 'invalido' }, siguiente: 'Lanzar revisión' })
  })

  it('un dictamen con otro revisionId no hereda el registro de una sesión ajena', () => {
    const ajeno = reporte('SEGUNDO', 2, undefined, { revisionId: 'REV-ORD-POS-999-2' })
    expect(paso([reporte('PRIMERO', 1, SONNET), ajeno], base())).toBe(FALTA)
  })
})

describe('criterio 4: un modelo no reconocido nunca cuenta', () => {
  it.each([
    ['SEGUNDO con un alias', base(revisa(2, 'opus'))],
    ['SEGUNDO con un nombre inventado', base(revisa(2, 'revisor-falso'))],
    ['SEGUNDO reconocido en configurado y no en servido', base(revisa(2, HAIKU, 'haiku'))],
    ['SEGUNDO con un sufijo que no es [1m]', base(revisa(2, 'claude-haiku-5-5[2m]'))],
    ['SEGUNDO de Gemini como firmante', base(revisa(2, 'gemini-2.5-pro'))],
    ['PRIMERO no reconocido', registro([implementa(FABLE), revisa(1, 'sonnet'), revisa(2, HAIKU)])],
    ['PRIMERO de Gemini', registro([implementa(FABLE), revisa(1, 'gemini-2.5-pro'), revisa(2, HAIKU)])],
    ['implementador no reconocido', base(revisa(2, HAIKU), implementa('fable'))],
    ['implementador reconocido en configurado y no en servido', base(revisa(2, HAIKU), implementa(FABLE, 'modelo-nuevo'))],
  ])('%s', (_, modelos) => {
    expect(paso(PAR, modelos)).toBe(FALTA)
  })
})

describe('configured_model y last_served_model de familias distintas (DEC-POS-039, punto 3)', () => {
  it('si alguna coincide con la del implementador o la del PRIMERO, falta segundo revisor', () => {
    expect(paso(PAR, base(revisa(2, HAIKU, SONNET)))).toBe(FALTA)
    expect(paso(PAR, base(revisa(2, SONNET, HAIKU)))).toBe(FALTA)
    expect(paso(PAR, base(revisa(2, HAIKU, FABLE)))).toBe(FALTA)
    expect(paso(PAR, base(revisa(2, FABLE, HAIKU)))).toBe(FALTA)
  })

  it('si ninguna coincide, cuenta', () => {
    expect(paso(PAR, base(revisa(2, HAIKU, OPUS)))).toBe(LISTO)
  })

  it('vale igual para el implementador y para el PRIMERO: cuentan sus dos familias', () => {
    // La orden se configuró con Fable y la sirvió Opus (el caso de ORD-POS-163).
    expect(paso(PAR, base(revisa(2, OPUS), implementa(FABLE, OPUS)))).toBe(FALTA)
    expect(paso(PAR, base(revisa(2, FABLE), implementa(FABLE, OPUS)))).toBe(FALTA)
    expect(paso(PAR, base(revisa(2, HAIKU), implementa(FABLE, OPUS)))).toBe(LISTO)
    expect(paso(PAR, registro([implementa(FABLE), revisa(1, SONNET, HAIKU), revisa(2, HAIKU)]))).toBe(FALTA)
  })

  it('dos registros de la misma sesión cuentan los dos (el PM nunca edita: solo da de alta)', () => {
    expect(paso(PAR, registro([implementa(FABLE), revisa(1, SONNET), revisa(2, HAIKU), revisa(2, SONNET)]))).toBe(FALTA)
    expect(paso(PAR, registro([implementa(FABLE), implementa(HAIKU), revisa(1, SONNET), revisa(2, HAIKU)]))).toBe(FALTA)
  })
})

describe('criterio 5: se conserva la regla «otro modelo» (DEC-POS-011, 019, 022 y 035)', () => {
  it('BAJO queda listo con un CONFORME, con o sin registro', () => {
    expect(evaluar([reporte('PRIMERO', 1, SONNET)], { modelosSesion: REGISTRO_VACIO }, 'BAJO').siguiente).toBe(LISTO)
  })

  it('MEDIO no sensible queda listo con PRIMERO o DELTA; MEDIO sensible y un riesgo no reconocido piden SEGUNDO', () => {
    const solo = [reporte('PRIMERO', 1, SONNET)]
    expect(evaluar(solo, { modelosSesion: base() }, 'MEDIO', 'NO').siguiente).toBe(LISTO)
    expect(evaluar(solo, { modelosSesion: base() }, 'MEDIO', '').siguiente).toBe(FALTA)
    expect(evaluar(solo, { modelosSesion: base() }, 'RARO', 'NO').siguiente).toBe(FALTA)
  })

  it('ALTO escala al propietario aunque haya doble revisión registrada', () => {
    expect(evaluar(PAR, { modelosSesion: base() }, 'ALTO').siguiente).toBe('Escala al propietario')
  })

  it('dos SEGUNDO no bastan: hace falta un PRIMERO o DELTA', () => {
    expect(paso([reporte('SEGUNDO', 1), reporte('SEGUNDO', 2)], base())).toBe(FALTA)
  })

  it('gemini-supervisado: solo con su bandera, firmado por una sesión de Claude que no es del implementador', () => {
    const par = [reporte('PRIMERO', 1, SONNET), gemini(2)]
    // El firmante puede ser de la familia del PRIMERO: lo que se compara con él es Gemini (DEC-POS-022).
    expect(paso(par, base(revisa(2, SONNET)), { geminiSupervisado: true })).toBe(LISTO)
    expect(paso(par, base(revisa(2, SONNET)))).toBe(FALTA)
    expect(paso(par, base(revisa(2, SONNET)), { geminiSupervisado: false })).toBe(FALTA)
    expect(paso(par, base(revisa(2, FABLE)), { geminiSupervisado: true })).toBe(FALTA)
    expect(paso(par, base(revisa(2, HAIKU, FABLE)), { geminiSupervisado: true })).toBe(FALTA)
    expect(paso(par, base(revisa(2, 'gemini-2.5-pro')), { geminiSupervisado: true })).toBe(FALTA)
    expect(paso(par, registro([implementa(FABLE), revisa(1, SONNET)]), { geminiSupervisado: true })).toBe(FALTA)
  })

  it('un CAMBIOS vigente sigue mandando sobre el CONFORME', () => {
    const cambios = reporte('SEGUNDO', 2, undefined, {
      criterios: [{ id: '1', resultado: 'NO_CUMPLE', evidencia: 'x' }, { id: '2', resultado: 'CUMPLE', evidencia: 'ok' }],
      hallazgos: [{ id: 'H1', severidad: 'ALTA', ubicacion: 'a.ts:1', condicion: 'c', impacto: 'i', bloquea: true, justificacion: 'j' }], veredicto: 'CAMBIOS',
    })
    expect(paso([reporte('PRIMERO', 1, SONNET), cambios], base())).toBe('Corregir (ronda 1 de 2)')
  })
})
