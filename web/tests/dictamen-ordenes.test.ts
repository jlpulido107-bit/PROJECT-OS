import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dictamenDeOrden, limpiarCacheDictamenes, urlComentario } from '@/lib/operations/dictamenes'
import { createGitHubClient } from '@/lib/operations/github'
import { extraerCriterios } from '@/lib/supervision/criterios'
import { MARCA_DICTAMEN } from '@/lib/supervision/dictamen'
import { FAMILIA_IMPLEMENTADOR, familiaModelo } from '@/lib/supervision/politica'

/** Dictamen vigente en /ordenes (ORD-POS-035) con un GitHub simulado: sin red. */

const ME = 'jlpulido107-bit'
const PR_URL = 'https://github.com/jlpulido107-bit/PROJECT-OS/pull/50'
const HEAD = 'a'.repeat(40)
const CRITERIOS = '1. Uno\n2. Dos'
const crit = extraerCriterios(CRITERIOS)
if (!crit.ok) throw new Error('criterios de prueba inválidos')

const reporte = (extra: Record<string, unknown> = {}) => ({
  versionContrato: '1', versionPolitica: 'DEC-POS-008', ordenId: 'ORD-POS-099', tareaId: 'POS-001', proyectoId: 'POS',
  repo: 'jlpulido107-bit/PROJECT-OS', issue: 49, pr: 50, headSha: HEAD, baseSha: 'b'.repeat(40), hashCriterios: crit.hashCriterios,
  revisionId: 'REV-1', ejecucionId: 'EJE-1', intento: 1, ronda: 0,
  autorizacion: { otorgadaPor: 'propietario', orden: 'ORD-POS-099', desde: '2026-10-17' },
  limiteConsumo: { presupuesto: '1 USD', tiempoMaximo: '30 min' },
  criterios: [{ id: '1', resultado: 'CUMPLE', evidencia: 'ok' }, { id: '2', resultado: 'CUMPLE', evidencia: 'ok' }],
  evidencia: { propias: [{ comando: 'npm test', sha: HEAD, codigoSalida: 0 }], ci: { estado: 'EXITO', ejecucion: 'r1', sha: HEAD }, autor: [] },
  hallazgos: [], veredicto: 'CONFORME', ...extra,
})
const comentario = (r: unknown, login = ME, marca = MARCA_DICTAMEN) =>
  ({ id: 1, login, body: `${marca}\n**Dictamen**\n\n\`\`\`json\n${typeof r === 'string' ? r : JSON.stringify(r)}\n\`\`\`` })
const bloqueante = { id: 'H1', severidad: 'ALTA', ubicacion: 'a.ts:1', condicion: 'c', impacto: 'i', bloquea: true, justificacion: 'j' }
const cambios = (extra: Record<string, unknown> = {}) =>
  reporte({ criterios: [{ id: '1', resultado: 'NO_CUMPLE', evidencia: 'x' }, { id: '2', resultado: 'CUMPLE', evidencia: 'ok' }], hallazgos: [bloqueante, { ...bloqueante, id: 'H2', bloquea: false }], veredicto: 'CAMBIOS', ...extra })

function cliente(comentarios: Array<{ id: number; login: string; body: string }>, opts: { head?: string; fallo?: boolean } = {}) {
  const fetchImpl = (async (url: string) => {
    const u = new URL(url)
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
    if (opts.fallo) return json(502, {})
    if (u.pathname === '/user') return json(200, { login: ME })
    if (u.pathname === '/repos/jlpulido107-bit/PROJECT-OS/pulls/50') return json(200, { head: { sha: opts.head ?? HEAD } })
    if (u.pathname === '/repos/jlpulido107-bit/PROJECT-OS/issues/50/comments') {
      return json(200, comentarios.map((c, i) => ({ id: c.id + i, body: c.body, user: { login: c.login } })))
    }
    return json(404, {})
  }) as unknown as typeof fetch
  return createGitHubClient('token-falso', fetchImpl)
}

const orden = (riesgo: string | null = 'BAJO', sensible?: string | null) => ({ id: 'ORD-POS-099', proyectoId: 'POS', prUrl: PR_URL, riesgo, criterios: CRITERIOS, sensible })
const evaluar = (comentarios: Parameters<typeof cliente>[0], riesgo?: string | null, opts?: Parameters<typeof cliente>[1] & { sensible?: string | null }) =>
  dictamenDeOrden(cliente(comentarios, opts), orden(riesgo, opts?.sensible))

beforeEach(() => limpiarCacheDictamenes())

describe('dictamen vigente por orden', () => {
  it('BAJO con CONFORME: listo, con datos y enlace al comentario', async () => {
    const ev = await evaluar([comentario(reporte())])
    expect(ev).toMatchObject({ siguiente: 'Listo para tu decisión', estado: { tipo: 'vigente', dictamen: { veredicto: 'CONFORME', ronda: 0, bloquean: 0, noBloquean: 0, sha: 'aaaaaaa' } } })
    expect(urlComentario(PR_URL, 1)).toBe(`${PR_URL}#issuecomment-1`)
    expect(urlComentario('https://evil.example/pull/1', 1)).toBeNull()
  })

  it.each([
    [{}, 'Corregir (ronda 1 de 2)'], [{ ronda: 1 }, 'Corregir (ronda 2 de 2)'], [{ ronda: 2 }, 'Escala al propietario'],
  ])('CAMBIOS %j: %s; cuenta hallazgos', async (extra, paso) => {
    expect(await evaluar([comentario(cambios(extra))])).toMatchObject({ siguiente: paso, estado: { dictamen: { bloquean: 1, noBloquean: 1 } } })
  })

  it('INCONCLUSO: revisar las entradas', async () => {
    const r = reporte({ criterios: [{ id: '1', resultado: 'NO_VERIFICADO', evidencia: 'x' }, { id: '2', resultado: 'CUMPLE', evidencia: 'ok' }], veredicto: 'INCONCLUSO' })
    expect((await evaluar([comentario(r)]))?.siguiente).toBe('Revisar entradas del dictamen')
  })

  const v2 = (rol: string, modelo: string, revisionId: string) => reporte({ versionContrato: '2', rol, modelo, revisionId })
  it.each([
    ['un CONFORME', [reporte()], 'Falta segundo revisor'], ['el mismo revisionId dos veces', [reporte(), reporte()], 'Falta segundo revisor'],
    ['dos de v1 (sin rol ni modelo)', [reporte(), reporte({ revisionId: 'REV-2' })], 'Falta segundo revisor'],
    ['PRIMERO y SEGUNDO del mismo modelo', [v2('PRIMERO', 'claude-sonnet-5-5', 'R1'), v2('SEGUNDO', 'claude-sonnet-5-5', 'R2')], 'Falta segundo revisor'],
    ['PRIMERO y SEGUNDO de otro modelo', [v2('PRIMERO', 'claude-sonnet-5-5', 'R1'), v2('SEGUNDO', 'claude-opus-5-5', 'R2')], 'Listo para tu decisión'],
    ['DELTA y SEGUNDO de otro modelo', [v2('DELTA', 'claude-sonnet-5-5', 'R1'), v2('SEGUNDO', 'claude-opus-5-5', 'R2')], 'Listo para tu decisión'],
    ['PRIMERO v2 y segundo de v1', [v2('PRIMERO', 'claude-sonnet-5-5', 'R1'), reporte({ revisionId: 'R2' })], 'Falta segundo revisor'],
    ['dos PRIMERO de modelos distintos', [v2('PRIMERO', 'claude-sonnet-5-5', 'R1'), v2('PRIMERO', 'claude-opus-5-5', 'R2')], 'Falta segundo revisor'],
  ])('MEDIO con %s: %s', async (_, reportes, paso) => {
    expect((await evaluar(reportes.map((r) => comentario(r)), 'MEDIO'))?.siguiente).toBe(paso)
  })

  // ORD-POS-100 (DEC-POS-022): SEGUNDO gemini-supervisado; la comparación de «otro modelo» usa modeloHallazgos.
  const gemini = (firmante: string, modeloHallazgos = 'gemini-2.5-pro', revisionId = 'R2') => reporte({
    versionContrato: '2', rol: 'SEGUNDO', modelo: firmante, revisionId, origenSegundo: 'gemini-supervisado', modeloHallazgos,
    hallazgosGemini: [{ id: 'G1', veredicto: 'DESCARTADO', evidencia: 'npm test pasa en el head' }],
  })
  const sonnet = v2('PRIMERO', 'claude-sonnet-5-5', 'R1')
  it.each([
    ['Sonnet + Sonnet sin origen', [sonnet, v2('SEGUNDO', 'claude-sonnet-5-5', 'R2')], 'Falta segundo revisor'],
    ['Sonnet + Sonnet con otro sufijo (mismo modelo)', [sonnet, v2('SEGUNDO', 'claude-sonnet-5-5-20261001', 'R2')], 'Falta segundo revisor'],
    ['SEGUNDO con modelo inventado', [sonnet, v2('SEGUNDO', 'gemini-supervisado', 'R2')], 'Falta segundo revisor'],
    ['SEGUNDO firmado con un modelo que no es de Claude', [sonnet, v2('SEGUNDO', 'gemini-2.5-pro', 'R2')], 'Falta segundo revisor'],
    ['PRIMERO con modelo inventado', [v2('PRIMERO', 'revisor-falso', 'R1'), v2('SEGUNDO', 'claude-opus-5-5', 'R2')], 'Falta segundo revisor'],
    ['gemini-supervisado firmado por Sonnet (distinto del implementador)', [sonnet, gemini('claude-sonnet-5-5')], 'Listo para tu decisión'],
    ['gemini-supervisado firmado por Opus (otra familia de Claude)', [sonnet, gemini('claude-opus-5-5')], 'Listo para tu decisión'],
    ['gemini-supervisado firmado por Haiku (otra familia de Claude)', [sonnet, gemini('claude-haiku-5-5')], 'Listo para tu decisión'],
    ['gemini-supervisado firmado por el implementador (Fable 5.2)', [sonnet, gemini('claude-fable-5-2')], 'Falta segundo revisor'],
    ['gemini-supervisado firmado por otra versión de la familia del implementador', [sonnet, gemini('claude-fable-5-1')], 'Falta segundo revisor'],
    ['gemini-supervisado firmado por FAMILIA_IMPLEMENTADOR', [sonnet, gemini(`claude-${FAMILIA_IMPLEMENTADOR}-9`)], 'Falta segundo revisor'],
    ['gemini-supervisado con modeloHallazgos de Claude', [sonnet, gemini('claude-opus-5-5', 'claude-haiku-5-5')], 'Falta segundo revisor'],
    ['gemini-supervisado con modeloHallazgos inventado', [sonnet, gemini('claude-opus-5-5', 'gemini-supervisado')], 'Falta segundo revisor'],
    ['PRIMERO de Gemini y SEGUNDO de Claude', [v2('PRIMERO', 'gemini-2.5-pro', 'R1'), v2('SEGUNDO', 'claude-sonnet-5-5', 'R2')], 'Falta segundo revisor'],
    ['gemini-supervisado sobre un PRIMERO de Gemini', [v2('PRIMERO', 'gemini-2.5-pro', 'R1'), gemini('claude-opus-5-5', 'gemini-3-pro')], 'Falta segundo revisor'],
  ])('MEDIO sensible con %s: %s (criterios 2 y 5, bandera encendida)', async (_, reportes, paso) => {
    vi.stubEnv('SEGUNDO_GEMINI_SUPERVISADO', 'on')
    expect((await evaluar(reportes.map((r) => comentario(r)), 'MEDIO'))?.siguiente).toBe(paso)
  })

  // ORD-POS-158 y ORD-POS-161 (DEC-POS-035): la familia del implementador vive en FAMILIA_IMPLEMENTADOR y no firma el
  // SEGUNDO de ningún origen.
  it('FAMILIA_IMPLEMENTADOR es una familia de Claude que familiaModelo reconoce', () => {
    expect(familiaModelo(`claude-${FAMILIA_IMPLEMENTADOR}-5-2`)).toBe(FAMILIA_IMPLEMENTADOR)
  })
  const implementador = `claude-${FAMILIA_IMPLEMENTADOR}-5-2`
  const claude = (modelo: string) => reporte({ versionContrato: '2', rol: 'SEGUNDO', modelo, revisionId: 'R2', origenSegundo: 'claude' })
  it.each([
    ['la familia del implementador', [sonnet, v2('SEGUNDO', implementador, 'R2')], 'Falta segundo revisor'],
    ['otra versión de la familia del implementador', [sonnet, v2('SEGUNDO', `claude-${FAMILIA_IMPLEMENTADOR}-5-1`, 'R2')], 'Falta segundo revisor'],
    ['la familia del implementador y origen claude explícito', [sonnet, claude(implementador)], 'Falta segundo revisor'],
    ['la familia del implementador con sufijo [1m]', [sonnet, v2('SEGUNDO', `${implementador}[1m]`, 'R2')], 'Falta segundo revisor'],
    ['la familia del implementador sobre un DELTA', [v2('DELTA', 'claude-sonnet-5-5', 'R1'), v2('SEGUNDO', implementador, 'R2')], 'Falta segundo revisor'],
    ['Opus', [sonnet, v2('SEGUNDO', 'claude-opus-5-5', 'R2')], 'Listo para tu decisión'],
    ['Haiku', [sonnet, v2('SEGUNDO', 'claude-haiku-5-5', 'R2')], 'Listo para tu decisión'],
    ['Opus y origen claude explícito', [sonnet, claude('claude-opus-5-5')], 'Listo para tu decisión'],
    ['Opus con sufijo [1m]', [sonnet, v2('SEGUNDO', 'claude-opus-5-5[1m]', 'R2')], 'Listo para tu decisión'],
    ['la familia del PRIMERO', [v2('PRIMERO', 'claude-opus-5-5', 'R1'), v2('SEGUNDO', 'claude-opus-5-1', 'R2')], 'Falta segundo revisor'],
    ['la familia del PRIMERO con sufijo [1m]', [sonnet, v2('SEGUNDO', 'claude-sonnet-5-5[1m]', 'R2')], 'Falta segundo revisor'],
  ])('vía claude con SEGUNDO de %s: %s, con la bandera apagada o encendida (criterios 1 y 2)', async (_, reportes, paso) => {
    expect((await evaluar(reportes.map((r) => comentario(r)), 'MEDIO'))?.siguiente).toBe(paso)
    vi.stubEnv('SEGUNDO_GEMINI_SUPERVISADO', 'on')
    expect((await evaluar(reportes.map((r) => comentario(r)), 'MEDIO'))?.siguiente).toBe(paso)
  })

  // ORD-POS-161, criterio 3: el sufijo [1m] es el mismo modelo; cualquier otro texto raro falla cerrado.
  it.each([
    ['claude-opus-5-5[1m]', 'opus'], ['claude-opus-5[1m]', 'opus'], ['claude-fable-5-2[1m]', 'fable'], ['Claude-Sonnet-5-5[1M]', 'sonnet'],
    ['claude-haiku-5-5-20261001[1m]', 'haiku'],
  ])('familiaModelo(%j) = %s', (modelo, familia) => { expect(familiaModelo(modelo)).toBe(familia) })
  it.each([
    'claude-opus-5-5[2m]', 'claude-opus-5-5[1m][1m]', 'claude-opus-5-5[1m]x', 'claude-opus-5-5 [1m]', 'claude-opus-5-5[1m', 'claude-opus-5-5[]',
    'claude-opus[1m]', '[1m]', 'claude-opus-5-5(1m)', 'claude-opus-[1m]5-5', 'gemini-2.5-pro[1m]', 'gemini-supervisado', 'Fable 5.2', 'opus', '', undefined,
  ])('familiaModelo(%j) = null', (modelo) => { expect(familiaModelo(modelo)).toBeNull() })
  it.each(['claude-opus-5-5[2m]', 'claude-opus-5-5[1m][1m]', 'claude-opus-5-5 [1m]', 'Claude-Opus-5-5[1m]'])(
    'un SEGUNDO firmado con %j no es un dictamen válido', async (modelo) => {
      expect((await evaluar([comentario(sonnet), comentario(v2('SEGUNDO', modelo, 'R2'))], 'MEDIO'))?.siguiente).toBe('Falta segundo revisor')
    })

  // Hallazgo H1 del PRIMERO (DEC-POS-014): sin SEGUNDO_GEMINI_SUPERVISADO=on, un SEGUNDO gemini-supervisado no cuenta.
  it.each([undefined, '', 'true', 'ON', '1', ' on'])('con SEGUNDO_GEMINI_SUPERVISADO=%j el gemini-supervisado no cuenta', async (valor) => {
    if (valor !== undefined) vi.stubEnv('SEGUNDO_GEMINI_SUPERVISADO', valor)
    const ev = await evaluar([comentario(sonnet), comentario(gemini('claude-sonnet-5-5'))], 'MEDIO')
    expect(ev?.siguiente).toBe('Falta segundo revisor')
    expect(ev?.plan?.tipo).toBe('SEGUNDO')
  })
  it('apagada no afecta al SEGUNDO de origen claude', async () => {
    expect((await evaluar([comentario(sonnet), comentario(v2('SEGUNDO', 'claude-opus-5-5', 'R2'))], 'MEDIO'))?.siguiente).toBe('Listo para tu decisión')
  })
  // ORD-POS-165 (DEC-POS-039): con SUPERVISION_MODELO_SESION=true y sin poder leer AUDITORIA (aquí, escritura
  // deshabilitada), nada es verificable: el `modelo` declarado ya no basta y falta segundo revisor.
  it('con SUPERVISION_MODELO_SESION=true y sin registro legible, falla cerrado', async () => {
    const par = [comentario(sonnet), comentario(v2('SEGUNDO', 'claude-opus-5-5', 'R2'))]
    expect((await evaluar(par, 'MEDIO'))?.siguiente).toBe('Listo para tu decisión')
    limpiarCacheDictamenes()
    vi.stubEnv('SUPERVISION_MODELO_SESION', 'true')
    expect((await evaluar(par, 'MEDIO'))?.siguiente).toBe('Falta segundo revisor')
    expect((await evaluar([comentario(reporte())], 'BAJO'))?.siguiente).toBe('Listo para tu decisión')
  })
  it.each(['on', 'TRUE', '1'])('SUPERVISION_MODELO_SESION=%j no enciende nada', async (valor) => {
    vi.stubEnv('SUPERVISION_MODELO_SESION', valor)
    expect((await evaluar([comentario(sonnet), comentario(v2('SEGUNDO', 'claude-opus-5-5', 'R2'))], 'MEDIO'))?.siguiente).toBe('Listo para tu decisión')
  })
  afterEach(() => { vi.unstubAllEnvs() })

  // DEC-POS-019: MEDIO no sensible (SENSIBLE = NO) queda listo con PRIMERO o DELTA CONFORME; vacía o ausente = sensible.
  it.each([
    ['NO, con PRIMERO CONFORME', 'NO', [sonnet], 'Listo para tu decisión'],
    ['no (minúsculas), con DELTA CONFORME', ' no ', [v2('DELTA', 'claude-sonnet-5-5', 'R1')], 'Listo para tu decisión'],
    ['NO, con un CONFORME de v1 (sin rol)', 'NO', [reporte()], 'Falta segundo revisor'],
    ['SI, sin SEGUNDO', 'SI', [sonnet], 'Falta segundo revisor'],
    ['vacía, sin SEGUNDO', '', [sonnet], 'Falta segundo revisor'],
    ['ausente (sin migrar), sin SEGUNDO', undefined, [sonnet], 'Falta segundo revisor'],
    ['valor desconocido, sin SEGUNDO', 'TAL VEZ', [sonnet], 'Falta segundo revisor'],
  ])('MEDIO con SENSIBLE %s: %s (criterios 3 y 5)', async (_, sensible, reportes, paso) => {
    const ev = await evaluar(reportes.map((r) => comentario(r)), 'MEDIO', { sensible })
    expect(ev?.siguiente).toBe(paso)
    if (paso !== 'Falta segundo revisor') expect(ev?.plan).toBeNull()
  })

  it('SENSIBLE = NO no relaja otro riesgo: ALTO escala y uno no reconocido pide SEGUNDO', async () => {
    expect((await evaluar([comentario(sonnet)], 'ALTO', { sensible: 'NO' }))?.siguiente).toBe('Escala al propietario')
    expect((await evaluar([comentario(sonnet)], 'MEDIANO', { sensible: 'NO' }))?.siguiente).toBe('Falta segundo revisor')
  })

  it.each([
    ['sin dictamen', null, 'ninguno'], ['otro head (head anterior)', comentario(reporte()), 'anterior', 'c'.repeat(40)], ['marca falsa', comentario(reporte(), ME, 'Dictamen sin marca'), 'ninguno'], ['autor ajeno', comentario(reporte(), 'intruso'), 'ninguno'],
    ['otra orden', comentario(reporte({ ordenId: 'ORD-POS-100' })), 'invalido'], ['otro PR', comentario(reporte({ pr: 51 })), 'invalido'],
    ['otro repo', comentario(reporte({ repo: 'jlpulido107-bit/SIGSAH' })), 'invalido'], ['otro hash', comentario(reporte({ hashCriterios: 'x' })), 'invalido'],
    ['JSON inválido, sin mostrar su contenido', comentario('{no es json <script>alert(1)</script>'), 'invalido'],
  ])('Lanzar revisión: %s', async (_, c, tipo, head?: string) => {
    expect(await evaluar(c ? [c] : [], 'BAJO', { head })).toMatchObject({ estado: { tipo }, siguiente: 'Lanzar revisión' })
  })

  it.each([
    ['lo leído de GitHub', false, 0, 1], ['el fallo de GitHub (null) unos 60 s', true, 59_000, 1], ['y reintenta pasados 60 s', true, 60_000, 2],
  ])('guarda en caché %s', async (_, fallo, despues, esperadas) => {
    let llamadas = 0
    const base = cliente([comentario(reporte())], { fallo })
    const c = { ...base, datosDictamen: (...a: Parameters<typeof base.datosDictamen>) => { llamadas++; return base.datosDictamen(...a) } }
    const primera = await dictamenDeOrden(c, orden(), 1_000)
    const segunda = await dictamenDeOrden(c, orden(), 1_000 + despues)
    expect([fallo ? primera : null, fallo ? segunda : null, llamadas]).toEqual([null, null, esperadas])
  })
})
