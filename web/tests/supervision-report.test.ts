import { describe, expect, it } from 'vitest'
import type { Criterio } from '@/lib/supervision/key'
import { claveIdempotente, hashCriterios, normalizarTexto } from '@/lib/supervision/key'
import { LIMITES, clasificarVigencia, procesarReporte, validarReporte } from '@/lib/supervision/report'
import type { PoliticaReporte } from '@/lib/supervision/report'

const H = 'a'.repeat(40)
const B = 'b'.repeat(40)
const HASH = 'c'.repeat(64)
const POL: PoliticaReporte = { ciRequerida: true, criteriosEsperados: ['1', '2'] }

type Rep = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const base = (): Rep => ({
  versionContrato: '1', versionPolitica: 'p1', ordenId: 'ORD-POS-012', tareaId: 'POS-013', proyectoId: 'POS',
  repo: 'jlpulido107-bit/PROJECT-OS', issue: 61, pr: 62, headSha: H, baseSha: B, hashCriterios: HASH,
  revisionId: 'REV-1', ejecucionId: 'EJE-1', intento: 1, ronda: 0,
  autorizacion: { otorgadaPor: 'propietario', orden: 'ORD-POS-012', desde: '2026-10-16' },
  limiteConsumo: { presupuesto: '1 USD', tiempoMaximo: '30 min' },
  criterios: [{ id: '1', resultado: 'CUMPLE', evidencia: 'ok' }, { id: '2', resultado: 'CUMPLE', evidencia: 'ok' }],
  evidencia: {
    propias: [{ comando: 'npm test', sha: H, codigoSalida: 0 }],
    ci: { estado: 'EXITO', ejecucion: 'run-1', sha: H },
    autor: ['dice que pasa'],
  },
  hallazgos: [],
  veredicto: 'CONFORME',
})
const conforme = base
const cambios = () => ({
  ...base(), veredicto: 'CAMBIOS',
  hallazgos: [{ id: 'H1', severidad: 'ALTA', ubicacion: 'a.ts:1', condicion: 'c', impacto: 'i', bloquea: true, justificacion: 'rompe' }],
})
const inconcluso = () => ({ ...base(), veredicto: 'INCONCLUSO', criterios: [{ id: '1', resultado: 'NO_VERIFICADO', evidencia: 'no pude' }, { id: '2', resultado: 'CUMPLE', evidencia: 'ok' }] })
const errores = (x: unknown, p = POL) => {
  const r = validarReporte(x, p)
  expect(r.ok).toBe(false)
  return r.ok ? [] : r.errores
}
const con = (mut: (r: Rep) => void) => { const r = base(); mut(r); return r }

describe('reporte válido de cada veredicto', () => {
  it.each([['CONFORME', conforme], ['CAMBIOS', cambios], ['INCONCLUSO', inconcluso]])('%s', (v, f) => {
    const r = validarReporte(f(), POL)
    expect(r.ok && r.reporte.veredicto).toBe(v)
  })
  it('CAMBIOS también por criterio NO_CUMPLE sin hallazgos', () => {
    expect(validarReporte({ ...base(), veredicto: 'CAMBIOS', criterios: [{ id: '1', resultado: 'NO_CUMPLE', evidencia: 'x' }, { id: '2', resultado: 'CUMPLE', evidencia: 'ok' }] }, POL).ok).toBe(true)
  })
  it('hallazgo no bloqueante no impide CONFORME y no exige justificación', () => {
    const h = { id: 'H2', severidad: 'BAJA', ubicacion: 'x', condicion: 'c', impacto: 'i', bloquea: false, justificacion: '' }
    expect(validarReporte({ ...base(), hallazgos: [h] }, POL).ok).toBe(true)
  })
})

describe('rechazos de forma (criterio 1)', () => {
  it.each([null, 'texto', 42, [], undefined])('entrada no objeto: %s', (x) => {
    expect(errores(x)[0]).toMatch(/^reporte/)
  })
  it('nunca lanza con entrada hostil', () => {
    const hostil = new Proxy({}, { get() { throw new Error('boom') }, ownKeys() { throw new Error('boom') } })
    expect(() => validarReporte(hostil, POL)).not.toThrow()
    expect(validarReporte(hostil, POL).ok).toBe(false)
  })
  it('contrato v1 sin rol ni modelo es válido; v2 los exige y los valida', () => {
    expect(validarReporte(base(), POL).ok).toBe(true)
    const v2 = (mut: (r: Rep) => void = () => {}) => con((r) => { r.versionContrato = '2'; r.rol = 'SEGUNDO'; r.modelo = 'claude-sonnet-5-5'; mut(r) })
    expect(validarReporte(v2(), POL).ok).toBe(true)
    expect(errores(v2((r) => { delete r.rol })).some((e) => e.startsWith('rol:'))).toBe(true)
    expect(errores(v2((r) => { delete r.modelo })).some((e) => e.startsWith('modelo:'))).toBe(true)
    expect(errores(v2((r) => { r.rol = 'TERCERO' })).some((e) => e.startsWith('rol:'))).toBe(true)
    for (const m of ['', 'Claude Sonnet', 'a', 42]) expect(errores(v2((r) => { r.modelo = m })).some((e) => e.startsWith('modelo:'))).toBe(true)
  })
  it.each(['versionContrato', 'versionPolitica', 'ordenId', 'tareaId', 'proyectoId', 'repo', 'issue', 'pr', 'headSha', 'baseSha',
    'hashCriterios', 'revisionId', 'ejecucionId', 'intento', 'ronda', 'autorizacion', 'limiteConsumo', 'criterios', 'evidencia', 'hallazgos', 'veredicto',
  ])('campo ausente: %s', (campo) => {
    const r = base(); delete r[campo]
    expect(errores(r).some((e) => e.startsWith(`${campo}:`) && e.includes('ausente'))).toBe(true)
  })
  it.each([['headSha', 'a'.repeat(39)], ['headSha', 'g'.repeat(40)], ['headSha', 'A'.repeat(40)], ['baseSha', 'abc'],
    ['hashCriterios', 'z'], ['ordenId', 'ORD-XXX-001'], ['repo', 'sin-barra'], ['issue', 0], ['pr', 1.5], ['pr', '62'],
    ['proyectoId', 'otro'], ['veredicto', 'APROBADO'],
  ])('mal formado: %s=%s', (campo, valor) => {
    expect(errores(con((r) => { r[campo] = valor })).some((e) => e.startsWith(`${campo}:`))).toBe(true)
  })
  it.each([-1, 3, 1.5, '1'])('ronda fuera de 0 a 2: %s', (v) => {
    expect(errores(con((r) => { r.ronda = v })).some((e) => e.startsWith('ronda:'))).toBe(true)
  })
  it.each([0, 1, 2])('ronda %s válida', (v) => {
    expect(validarReporte(con((r) => { r.ronda = v }), POL).ok).toBe(true)
  })
  it('criterios: resultado inválido, vacío o evidencia ausente', () => {
    expect(errores(con((r) => { r.criterios[0].resultado = 'OK' })).some((e) => e.startsWith('criterios[0].resultado'))).toBe(true)
    expect(errores(con((r) => { r.criterios = [] })).some((e) => e.startsWith('criterios:'))).toBe(true)
    expect(errores(con((r) => { delete r.criterios[1].evidencia })).some((e) => e.startsWith('criterios[1].evidencia'))).toBe(true)
  })
  it('evidencia sin alguno de los tres bloques', () => {
    for (const bloque of ['propias', 'ci', 'autor']) {
      const e = errores(con((r) => { delete r.evidencia[bloque] }))
      expect(e.some((m) => m.startsWith(`evidencia.${bloque}`))).toBe(true)
    }
  })
  it('evidencia con bloques mal tipados o prueba propia incompleta', () => {
    expect(errores(con((r) => { r.evidencia.propias = 'npm test' })).some((e) => e.startsWith('evidencia.propias'))).toBe(true)
    expect(errores(con((r) => { delete r.evidencia.propias[0].codigoSalida })).some((e) => e.includes('codigoSalida'))).toBe(true)
    expect(errores(con((r) => { r.evidencia.ci.estado = 'VERDE' })).some((e) => e.startsWith('evidencia.ci.estado'))).toBe(true)
  })
  it('hallazgo bloqueante exige justificación; bloquea debe ser booleano', () => {
    const h = { id: 'H', severidad: 'ALTA', ubicacion: 'u', condicion: 'c', impacto: 'i', bloquea: true, justificacion: ' ' }
    expect(errores({ ...cambios(), hallazgos: [h] }).some((e) => e.includes('justificacion'))).toBe(true)
    expect(errores({ ...cambios(), hallazgos: [{ ...h, bloquea: 'si', justificacion: 'x' }] }).some((e) => e.includes('bloquea'))).toBe(true)
  })
  it('límites de tamaño', () => {
    expect(LIMITES.criterios).toBeGreaterThan(0)
    expect(errores(con((r) => { r.criterios[0].evidencia = 'x'.repeat(LIMITES.textoLargo + 1) })).some((e) => e.includes('límite'))).toBe(true)
    expect(errores(con((r) => { r.revisionId = 'x'.repeat(LIMITES.campoCorto + 1) })).some((e) => e.includes('límite'))).toBe(true)
    expect(errores(con((r) => { r.criterios = Array.from({ length: LIMITES.criterios + 1 }, (_, i) => ({ id: String(i), resultado: 'CUMPLE', evidencia: 'e' })) })).some((e) => e.includes('límite'))).toBe(true)
    expect(errores(con((r) => { r.hallazgos = Array.from({ length: LIMITES.hallazgos + 1 }, () => ({})) })).some((e) => e.startsWith('hallazgos:'))).toBe(true)
    expect(errores(con((r) => { r.evidencia.autor = Array.from({ length: LIMITES.entradasEvidencia + 1 }, () => 'a') })).some((e) => e.startsWith('evidencia.autor'))).toBe(true)
    expect(errores(con((r) => { r.evidencia.autor = ['x'.repeat(LIMITES.textoLargo + 1)] })).some((e) => e.startsWith('evidencia.autor[0]'))).toBe(true)
  })
})

describe('coherencia del veredicto (criterio 2)', () => {
  it('CONFORME con un criterio NO_CUMPLE o NO_VERIFICADO es incoherente', () => {
    expect(errores(con((r) => { r.criterios[0].resultado = 'NO_CUMPLE' }))[0]).toMatch(/corresponde CAMBIOS/)
    expect(errores(con((r) => { r.criterios[0].resultado = 'NO_VERIFICADO' }))[0]).toMatch(/corresponde INCONCLUSO/)
  })
  it('CONFORME con hallazgo bloqueante corresponde CAMBIOS', () => {
    expect(errores({ ...cambios(), veredicto: 'CONFORME' })[0]).toMatch(/corresponde CAMBIOS/)
  })
  it('CAMBIOS sin bloqueante ni NO_CUMPLE es incoherente', () => {
    expect(errores({ ...base(), veredicto: 'CAMBIOS' })[0]).toMatch(/incoherente/)
  })
  it('INCONCLUSO con bloqueante corresponde CAMBIOS; sin NO_VERIFICADO es incoherente', () => {
    expect(errores({ ...cambios(), veredicto: 'INCONCLUSO' })[0]).toMatch(/corresponde CAMBIOS/)
    expect(errores({ ...base(), veredicto: 'INCONCLUSO' })[0]).toMatch(/incoherente/)
  })
  it('NO_CUMPLE junto a NO_VERIFICADO corresponde CAMBIOS, no INCONCLUSO', () => {
    const r = { ...inconcluso(), criterios: [{ id: '1', resultado: 'NO_CUMPLE', evidencia: 'x' }, { id: '2', resultado: 'NO_VERIFICADO', evidencia: 'y' }] }
    expect(errores(r)[0]).toMatch(/corresponde CAMBIOS/)
  })
  it('CONFORME exige pruebas propias válidas para ese head', () => {
    expect(errores(con((r) => { r.evidencia.propias = [] })).join()).toMatch(/pruebas propias/)
    expect(errores(con((r) => { r.evidencia.propias[0].sha = B })).join()).toMatch(/otro head/)
    expect(errores(con((r) => { r.evidencia.propias[0].codigoSalida = 1 })).join()).toMatch(/código 0/)
  })
  it('una afirmación del autor no sustituye pruebas propias ni CI', () => {
    expect(errores(con((r) => { r.evidencia.propias = []; r.evidencia.ci = { estado: 'CI_AUSENTE' } }), { ...POL, ciRequerida: false }).join()).toMatch(/pruebas propias/)
  })
  it('CI exitosa de otro head no cuenta', () => {
    expect(errores(con((r) => { r.evidencia.ci.sha = B })).join()).toMatch(/CI exitosa no es del head/)
    expect(errores(con((r) => { delete r.evidencia.ci.sha })).join()).toMatch(/CI exitosa no es del head/)
  })
  it('CI ausente: CONFORME solo si la política no la requiere', () => {
    const r = con((x) => { x.evidencia.ci = { estado: 'CI_AUSENTE' } })
    expect(validarReporte(r, { ...POL, ciRequerida: false }).ok).toBe(true)
    expect(errores(r, { ...POL, ciRequerida: true }).join()).toMatch(/CI_AUSENTE con CI requerida/)
  })
  it.each(['PENDIENTE', 'FALLO'])('CI %s nunca es CONFORME, ni con CI no requerida', (estado) => {
    const r = con((x) => { x.evidencia.ci = { estado, sha: H } })
    expect(errores(r, { ...POL, ciRequerida: true }).length).toBeGreaterThan(0)
    expect(errores(r, { ...POL, ciRequerida: false }).length).toBeGreaterThan(0)
  })
  it('CI fallida con NO_CUMPLE y veredicto CAMBIOS es válido (contrato §6, caso 8)', () => {
    const r = { ...base(), veredicto: 'CAMBIOS', criterios: [{ id: '1', resultado: 'NO_CUMPLE', evidencia: 'CI falló' }, { id: '2', resultado: 'CUMPLE', evidencia: 'ok' }], evidencia: { ...base().evidencia, ci: { estado: 'FALLO', sha: H } } }
    expect(validarReporte(r, POL).ok).toBe(true)
  })
})

describe('criterios de la orden (F1)', () => {
  const crit = (...ids: string[]) => ids.map((id) => ({ id, resultado: 'CUMPLE', evidencia: 'ok' }))
  const pol6 = { ...POL, criteriosEsperados: ['1', '2', '3', '4', '5', '6'] }
  it('rechaza criterios faltantes', () => {
    expect(errores(con((r) => { r.criterios = crit('1', '2') }), pol6).join()).toMatch(/falta el criterio 3/)
  })
  it('rechaza criterios sobrantes', () => {
    expect(errores(con((r) => { r.criterios = crit('1', '2', '9') })).join()).toMatch(/criterio 9 no pertenece/)
  })
  it('rechaza criterios duplicados (2 entradas iguales con 6 esperados)', () => {
    const e = errores(con((r) => { r.criterios = crit('1', '1') }), pol6).join()
    expect(e).toMatch(/criterio 1 está repetido/)
    expect(e).toMatch(/falta el criterio 2/)
  })
  it('también para CAMBIOS e INCONCLUSO', () => {
    expect(errores({ ...cambios(), criterios: crit('1') }).join()).toMatch(/falta el criterio 2/)
    expect(errores({ ...inconcluso(), criterios: crit('1', '1') }).join()).toMatch(/repetido/)
  })
  it('acepta la lista exacta en cualquier orden', () => {
    expect(validarReporte(con((r) => { r.criterios = crit('2', '1') }), POL).ok).toBe(true)
  })
  it('acepta ORD-POS-1000 (alineado con ordenes.ts)', () => {
    expect(validarReporte(con((r) => { r.ordenId = 'ORD-POS-1000'; r.autorizacion.orden = 'ORD-POS-1000' }), POL).ok).toBe(true)
  })
})

describe('vigencia (criterio 3)', () => {
  const ctx = { headSha: H, baseSha: B, hashCriterios: HASH, versionPolitica: 'p1' }
  const rep = () => { const r = validarReporte(conforme(), POL); if (!r.ok) throw new Error('inválido'); return r.reporte }
  it('vigente cuando todo coincide', () => {
    expect(clasificarVigencia(rep(), ctx)).toEqual({ vigente: true })
  })
  it.each([
    ['HEAD', { headSha: 'd'.repeat(40) }], ['BASE', { baseSha: 'd'.repeat(40) }],
    ['CRITERIOS', { hashCriterios: 'd'.repeat(64) }], ['POLITICA', { versionPolitica: 'p2' }],
  ])('histórico si cambia %s', (que, cambio) => {
    expect(clasificarVigencia(rep(), { ...ctx, ...cambio })).toEqual({ vigente: false, cambios: [que] })
  })
  it('procesarReporte: válido y vigente, válido pero histórico, e inválido', () => {
    const v = procesarReporte(conforme(), POL, ctx)
    expect(v.ok && v.vigencia).toEqual({ vigente: true })
    const h = procesarReporte(conforme(), POL, { ...ctx, headSha: 'd'.repeat(40) })
    expect(h.ok && h.vigencia.vigente).toBe(false)
    expect(procesarReporte({}, POL, ctx).ok).toBe(false)
  })
})

describe('hash de criterios y clave (criterio 4)', () => {
  const crit: [Criterio, Criterio] = [{ numero: 1, texto: 'Valida el reporte' }, { numero: 2, texto: 'Calcula la clave' }]
  it('formato: SHA-256 en hex y determinista', () => {
    expect(hashCriterios(crit)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashCriterios(crit)).toBe(hashCriterios(crit.map((c) => ({ ...c }))))
  })
  it('no cambia con espacios finales, CRLF/LF ni espacios repetidos', () => {
    const h = hashCriterios(crit)
    expect(hashCriterios([{ numero: 1, texto: 'Valida el reporte   ' }, { numero: 2, texto: '  Calcula la clave\r\n' }])).toBe(h)
    expect(hashCriterios([{ numero: 1, texto: 'Valida   el\treporte' }, { numero: 2, texto: 'Calcula\r\nla clave' }])).toBe(h)
    expect(hashCriterios([{ numero: 1, texto: 'Valida\nel reporte' }, { numero: 2, texto: 'Calcula la clave' }])).toBe(h)
    expect(normalizarTexto('a \r\n  b ')).toBe('a b')
  })
  it('cambia si cambia el texto, el orden o el número', () => {
    const h = hashCriterios(crit)
    expect(hashCriterios([{ numero: 1, texto: 'Valida el reporte.' }, crit[1]])).not.toBe(h)
    expect(hashCriterios([crit[1], crit[0]])).not.toBe(h)
    expect(hashCriterios([{ numero: 3, texto: crit[0].texto }, crit[1]])).not.toBe(h)
    expect(hashCriterios([crit[0]])).not.toBe(h)
  })
})

describe('clave idempotente (criterio 4)', () => {
  const partes = { repo: 'o/r', pr: 7, headSha: H, baseSha: B, hashCriterios: HASH, versionContrato: '1', versionPolitica: 'p1' }
  it('formato REPO|PR|HEAD_SHA|BASE_SHA|HASH_CRITERIOS|VERSION_CONTRATO|VERSION_POLITICA', () => {
    expect(claveIdempotente(partes)).toBe(`o/r|7|${H}|${B}|${HASH}|1|p1`)
  })
  it('cambia con cualquiera de sus partes', () => {
    const k = claveIdempotente(partes)
    for (const [campo, valor] of Object.entries({ repo: 'o/x', pr: 8, headSha: 'd'.repeat(40), baseSha: 'd'.repeat(40), hashCriterios: 'd'.repeat(64), versionContrato: '2', versionPolitica: 'p2' })) {
      expect(claveIdempotente({ ...partes, [campo]: valor })).not.toBe(k)
    }
  })
})

describe('SEGUNDO de origen gemini-supervisado (ORD-POS-100, criterio 1)', () => {
  const hallazgo = { id: 'G1', veredicto: 'DESCARTADO', evidencia: 'a.ts:10, npm test pasa en el head' }
  const v2 = (rol: string, mut: (r: Rep) => void = () => {}) => con((r) => { r.versionContrato = '2'; r.rol = rol; r.modelo = 'claude-sonnet-5-5'; mut(r) })
  const gemini = (mut: (r: Rep) => void = () => {}) =>
    v2('SEGUNDO', (r) => { r.origenSegundo = 'gemini-supervisado'; r.modeloHallazgos = 'gemini-2.5-pro'; r.hallazgosGemini = [hallazgo]; mut(r) })

  it('acepta el origen gemini-supervisado con modeloHallazgos y el veredicto del supervisor por hallazgo', () => {
    const r = validarReporte(gemini(), POL)
    expect(r.ok && [r.reporte.origenSegundo, r.reporte.modeloHallazgos, r.reporte.hallazgosGemini]).toEqual(['gemini-supervisado', 'gemini-2.5-pro', [hallazgo]])
  })
  it('rechaza hallazgosGemini vacío con origen gemini-supervisado (hallazgo H2 del PRIMERO)', () => {
    expect(errores(gemini((r) => { r.hallazgosGemini = [] })).some((e) => e.startsWith('hallazgosGemini:'))).toBe(true)
  })
  // Hallazgo H1 del SEGUNDO: un hallazgo de Gemini CONFIRMADO sin hallazgo propio con el mismo id impide el CONFORME.
  const confirmado = { id: 'G1', veredicto: 'CONFIRMADO', evidencia: 'a.ts:10, npm test falla en el head' }
  const propio = (bloquea: boolean) => ({ id: 'G1', severidad: 'MEDIA', ubicacion: 'a.ts:10', condicion: 'c', impacto: 'i', bloquea, justificacion: 'j' })
  it('rechaza un CONFORME con un hallazgo de Gemini CONFIRMADO sin hallazgo propio', () => {
    expect(errores(gemini((r) => { r.hallazgosGemini = [confirmado] })).some((e) => e.startsWith('hallazgosGemini: G1 CONFIRMADO'))).toBe(true)
    expect(errores(gemini((r) => { r.hallazgosGemini = [confirmado]; r.hallazgos = [{ ...propio(false), id: 'H1' }] })).some((e) => e.startsWith('hallazgosGemini: G1'))).toBe(true)
  })
  it('acepta el CONFIRMADO con hallazgo propio del mismo id, o con un veredicto distinto de CONFORME', () => {
    expect(validarReporte(gemini((r) => { r.hallazgosGemini = [confirmado]; r.hallazgos = [propio(false)] }), POL).ok).toBe(true)
    const cambios = gemini((r) => { r.hallazgosGemini = [confirmado]; r.hallazgos = [propio(true)]; r.veredicto = 'CAMBIOS' })
    expect(validarReporte(cambios, POL).ok).toBe(true)
  })
  it('acepta origen claude sin los campos de Gemini, y un SEGUNDO sin origen', () => {
    expect(validarReporte(v2('SEGUNDO', (r) => { r.origenSegundo = 'claude' }), POL).ok).toBe(true)
    expect(validarReporte(v2('SEGUNDO'), POL).ok).toBe(true)
  })
  it.each([
    ['otro origen', (r: Rep) => { r.origenSegundo = 'gemini' }, 'origenSegundo:'],
    ['sin modeloHallazgos', (r: Rep) => { delete r.modeloHallazgos }, 'modeloHallazgos:'],
    ['modeloHallazgos con formato inválido', (r: Rep) => { r.modeloHallazgos = 'Gemini Pro' }, 'modeloHallazgos:'],
    ['sin hallazgosGemini', (r: Rep) => { delete r.hallazgosGemini }, 'hallazgosGemini:'],
    ['hallazgo sin veredicto del supervisor', (r: Rep) => { r.hallazgosGemini = [{ id: 'G1', evidencia: 'x' }] }, 'hallazgosGemini[0].veredicto:'],
    ['veredicto del supervisor desconocido', (r: Rep) => { r.hallazgosGemini = [{ ...hallazgo, veredicto: 'TAL VEZ' }] }, 'hallazgosGemini[0].veredicto:'],
    ['hallazgo sin evidencia', (r: Rep) => { r.hallazgosGemini = [{ ...hallazgo, evidencia: '' }] }, 'hallazgosGemini[0].evidencia:'],
  ])('rechaza %s', (_, mut, prefijo) => {
    expect(errores(gemini(mut)).some((e) => e.startsWith(prefijo))).toBe(true)
  })
  it.each(['PRIMERO', 'DELTA'])('rechaza los campos del SEGUNDO con rol %s', (rol) => {
    for (const campo of ['origenSegundo', 'modeloHallazgos', 'hallazgosGemini']) {
      const valor = { origenSegundo: 'claude', modeloHallazgos: 'gemini-2.5-pro', hallazgosGemini: [] }[campo]
      expect(errores(v2(rol, (r) => { r[campo] = valor })).some((e) => e.startsWith(`${campo}:`))).toBe(true)
    }
  })
  it('rechaza los campos del SEGUNDO en contrato v1 y los de Gemini con origen claude', () => {
    expect(errores(con((r) => { r.origenSegundo = 'claude' })).some((e) => e.startsWith('origenSegundo:'))).toBe(true)
    expect(errores(v2('SEGUNDO', (r) => { r.origenSegundo = 'claude'; r.modeloHallazgos = 'gemini-2.5-pro' })).some((e) => e.startsWith('modeloHallazgos:'))).toBe(true)
    expect(errores(v2('SEGUNDO', (r) => { r.hallazgosGemini = [] })).some((e) => e.startsWith('hallazgosGemini:'))).toBe(true)
  })
})
