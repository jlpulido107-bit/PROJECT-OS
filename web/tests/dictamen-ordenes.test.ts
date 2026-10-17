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
  it('sin dictamen: Lanzar revisión', async () => {
    expect(await evaluar([])).toEqual({ estado: { tipo: 'ninguno' }, siguiente: 'Lanzar revisión' })
  })

  it('BAJO con CONFORME: listo, con datos y enlace al comentario', async () => {
    const ev = await evaluar([comentario(reporte())])
    expect(ev).toMatchObject({ siguiente: 'Listo para tu decisión', estado: { tipo: 'vigente', dictamen: { veredicto: 'CONFORME', ronda: 0, bloquean: 0, noBloquean: 0, sha: 'aaaaaaa' } } })
    expect(urlComentario(PR_URL, 1)).toBe(`${PR_URL}#issuecomment-1`)
    expect(urlComentario('https://evil.example/pull/1', 1)).toBeNull()
  })

  it('CAMBIOS: corrige hasta la ronda 2 y luego escala; cuenta hallazgos', async () => {
    expect(await evaluar([comentario(cambios())])).toMatchObject({ siguiente: 'Corregir (ronda 1 de 2)', estado: { dictamen: { bloquean: 1, noBloquean: 1 } } })
    limpiarCacheDictamenes()
    expect((await evaluar([comentario(cambios({ ronda: 1 }))]))?.siguiente).toBe('Corregir (ronda 2 de 2)')
    limpiarCacheDictamenes()
    expect((await evaluar([comentario(cambios({ ronda: 2 }))]))?.siguiente).toBe('Escala al propietario')
  })

  it('INCONCLUSO: revisar las entradas', async () => {
    const r = reporte({ criterios: [{ id: '1', resultado: 'NO_VERIFICADO', evidencia: 'x' }, { id: '2', resultado: 'CUMPLE', evidencia: 'ok' }], veredicto: 'INCONCLUSO' })
    expect((await evaluar([comentario(r)]))?.siguiente).toBe('Revisar entradas del dictamen')
  })

  it('MEDIO: un CONFORME falta el segundo; dos revisionId distintos, listo; el mismo revisionId no suma', async () => {
    expect((await evaluar([comentario(reporte())], 'MEDIO'))?.siguiente).toBe('Falta segundo revisor')
    limpiarCacheDictamenes()
    expect((await evaluar([comentario(reporte()), comentario(reporte())], 'MEDIO'))?.siguiente).toBe('Falta segundo revisor')
    limpiarCacheDictamenes()
    expect((await evaluar([comentario(reporte()), comentario(reporte({ revisionId: 'REV-2' }))], 'MEDIO'))?.siguiente).toBe('Listo para tu decisión')
  })

  it('ignora la marca falsa, el autor ajeno y el dictamen de otra orden', async () => {
    for (const c of [comentario(reporte(), ME, 'Dictamen sin marca'), comentario(reporte(), 'intruso'), comentario(reporte({ ordenId: 'ORD-POS-100' }))]) {
      limpiarCacheDictamenes()
      expect((await evaluar([c]))?.siguiente).toBe('Lanzar revisión')
    }
    limpiarCacheDictamenes()
    expect((await evaluar([comentario(reporte(), 'intruso')]))?.estado).toEqual({ tipo: 'ninguno' })
  })

  it('JSON inválido: «no válido», sin mostrar su contenido', async () => {
    const mal = await evaluar([comentario('{no es json <script>alert(1)</script>')])
    expect(mal).toEqual({ estado: { tipo: 'invalido' }, siguiente: 'Lanzar revisión' })
    limpiarCacheDictamenes()
    expect((await evaluar([comentario(reporte({ veredicto: 'CONFORME', hashCriterios: 'x' }))]))?.estado).toEqual({ tipo: 'invalido' })
  })

  it('dictamen de otro head: head anterior', async () => {
    expect(await evaluar([comentario(reporte())], 'BAJO', { head: 'c'.repeat(40) })).toEqual({ estado: { tipo: 'anterior' }, siguiente: 'Lanzar revisión' })
  })

  it('si GitHub falla, null (Sin datos de GitHub) y no se rompe', async () => {
    expect(await evaluar([comentario(reporte())], 'BAJO', { fallo: true })).toBeNull()
  })

  it('guarda en caché lo leído de GitHub', async () => {
    let llamadas = 0
    const base = cliente([comentario(reporte())])
    const c = { ...base, datosDictamen: (...a: Parameters<typeof base.datosDictamen>) => { llamadas++; return base.datosDictamen(...a) } }
    await dictamenDeOrden(c, orden())
    await dictamenDeOrden(c, orden())
    expect(llamadas).toBe(1)
  })
})
