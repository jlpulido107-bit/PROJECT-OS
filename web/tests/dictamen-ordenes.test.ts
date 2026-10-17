import { beforeEach, describe, expect, it } from 'vitest'
import { dictamenDeOrden, limpiarCacheDictamenes, urlComentario } from '@/lib/operations/dictamenes'
import { createGitHubClient } from '@/lib/operations/github'
import { extraerCriterios } from '@/lib/supervision/criterios'
import { MARCA_DICTAMEN } from '@/lib/supervision/dictamen'

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

const orden = (riesgo: string | null = 'BAJO') => ({ id: 'ORD-POS-099', proyectoId: 'POS', prUrl: PR_URL, riesgo, criterios: CRITERIOS })
const evaluar = (comentarios: Parameters<typeof cliente>[0], riesgo?: string | null, opts?: Parameters<typeof cliente>[1]) =>
  dictamenDeOrden(cliente(comentarios, opts), orden(riesgo))

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
    ['PRIMERO y SEGUNDO de otro modelo', [v2('PRIMERO', 'claude-sonnet-5-5', 'R1'), v2('SEGUNDO', 'claude-fable-5-1', 'R2')], 'Listo para tu decisión'],
    ['DELTA y SEGUNDO de otro modelo', [v2('DELTA', 'claude-sonnet-5-5', 'R1'), v2('SEGUNDO', 'claude-fable-5-1', 'R2')], 'Listo para tu decisión'],
    ['PRIMERO v2 y segundo de v1', [v2('PRIMERO', 'claude-sonnet-5-5', 'R1'), reporte({ revisionId: 'R2' })], 'Falta segundo revisor'],
    ['dos PRIMERO de modelos distintos', [v2('PRIMERO', 'claude-sonnet-5-5', 'R1'), v2('PRIMERO', 'claude-fable-5-1', 'R2')], 'Falta segundo revisor'],
  ])('MEDIO con %s: %s', async (_, reportes, paso) => {
    expect((await evaluar(reportes.map((r) => comentario(r)), 'MEDIO'))?.siguiente).toBe(paso)
  })

  it.each([
    ['sin dictamen', null, 'ninguno'], ['otro head (head anterior)', comentario(reporte()), 'anterior', 'c'.repeat(40)], ['marca falsa', comentario(reporte(), ME, 'Dictamen sin marca'), 'ninguno'], ['autor ajeno', comentario(reporte(), 'intruso'), 'ninguno'],
    ['otra orden', comentario(reporte({ ordenId: 'ORD-POS-100' })), 'invalido'], ['otro PR', comentario(reporte({ pr: 51 })), 'invalido'],
    ['otro repo', comentario(reporte({ repo: 'jlpulido107-bit/SIGSAH' })), 'invalido'], ['otro hash', comentario(reporte({ hashCriterios: 'x' })), 'invalido'],
    ['JSON inválido, sin mostrar su contenido', comentario('{no es json <script>alert(1)</script>'), 'invalido'],
  ])('Lanzar revisión: %s', async (_, c, tipo, head?: string) => {
    expect(await evaluar(c ? [c] : [], 'BAJO', { head })).toEqual({ estado: { tipo }, siguiente: 'Lanzar revisión' })
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
