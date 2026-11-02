import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { FlujoView } from '@/components/planning/flujo'
import { limpiarCacheAgentes, LLAMADAS_AGENTES } from '@/lib/agentes-data'
import { MOTIVO_SIN_COLUMNA_BANDERA } from '@/lib/banderas'
import { MOTIVO_F5 } from '@/lib/esperando'
import { limpiarCacheDictamenes } from '@/lib/operations/dictamenes'
import { createGitHubClient, type PrFusion } from '@/lib/operations/github'
import {
  capaFlujo, githubDeFlujo, lineaFlujo, MOTIVO_SIN_GITHUB_FLUJO, PASOS, type GitHubFlujo, type LineaFlujo,
} from '@/lib/planificacion-flujo'
import { extraerCriterios } from '@/lib/supervision/criterios'
import { LISTO_PARA_DECISION, MARCA_DICTAMEN, type EvaluacionDictamen } from '@/lib/supervision/dictamen'
import type { Orden } from '@/lib/types'

/** Capa Flujo de /planificacion (ORD-POS-123, diseño de Planificación v2 §4, §4.1 y §7). Datos sintéticos; GitHub simulado. */

const ME = 'jlpulido107-bit'
const REPO = 'jlpulido107-bit/PROJECT-OS'
const HEAD = 'a'.repeat(40)
const CRITERIOS = '1. Uno\n2. Dos'
const NOW = Date.UTC(2026, 10, 1, 18, 0, 0)
const crit = extraerCriterios(CRITERIOS)
if (!crit.ok) throw new Error('criterios de prueba inválidos')

const id = (n: number) => `ORD-POS-${String(n).padStart(3, '0')}`
const prUrl = (n: number) => `https://github.com/${REPO}/pull/${n}`
const orden = (n: number, estado: string, extra: Partial<Orden> = {}): Orden => ({
  id: id(n), proyectoId: 'POS', tareaId: 'POS-041', titulo: `Orden ${n}`, objetivo: null, contexto: null, criterios: CRITERIOS,
  fueraDeAlcance: null, comoProbar: null, riesgo: 'BAJO', sensible: null, estado,
  issueUrl: ['BORRADOR', 'APROBADA'].includes(estado) ? null : `https://github.com/${REPO}/issues/${n}`,
  prUrl: ['PR_ABIERTO', 'REVISADA'].includes(estado) ? prUrl(n) : null, notas: null, actualizadoEn: null, ...extra,
})

/* ------------------------------------- Evaluaciones simuladas ------------------------------------- */

const vigente = (veredicto: 'CONFORME' | 'CAMBIOS', siguiente: string): EvaluacionDictamen => ({
  estado: { tipo: 'vigente', dictamen: { veredicto, ronda: 0, bloquean: 0, noBloquean: 0, sha: 'aaaaaaa', comentarioId: 1 } },
  siguiente, plan: null,
})
const ninguno: EvaluacionDictamen = { estado: { tipo: 'ninguno' }, siguiente: 'Lanzar revisión', plan: null }

/** GitHub ya leído: PRs de POS (número = n de la orden; `fusionados` con merged_at) y evaluaciones por orden. */
function gh(nums: number[], evaluaciones: Record<number, EvaluacionDictamen | null> = {}, fusionados: number[] = []): GitHubFlujo {
  const lista = new Map<string, PrFusion>(nums.map((n) => [id(n), { url: prUrl(n), number: n, fusionMs: fusionados.includes(n) ? NOW : null }]))
  return {
    prs: { POS: lista, SIG: new Map(), ECO: new Map() },
    truncados: [],
    dictamenes: { evaluaciones: new Map(Object.entries(evaluaciones).map(([n, ev]) => [id(Number(n)), ev])), vencido: false },
  }
}

const estados = (l: LineaFlujo) => Object.fromEntries(l.pasos.map((p) => [p.paso, p.estado]))

/* ---------------------------------------- GitHub simulado ---------------------------------------- */

const reporte = (n: number, extra: Record<string, unknown> = {}) => ({
  versionContrato: '1', versionPolitica: 'DEC-POS-008', ordenId: id(n), tareaId: 'POS-041', proyectoId: 'POS',
  repo: REPO, issue: n, pr: n, headSha: HEAD, baseSha: 'b'.repeat(40), hashCriterios: crit.hashCriterios,
  revisionId: `REV-${id(n)}-1`, ejecucionId: `EJE-${id(n)}-1`, intento: 1, ronda: 0,
  autorizacion: { otorgadaPor: 'propietario', orden: id(n), desde: '2026-10-17' },
  limiteConsumo: { presupuesto: '1 USD', tiempoMaximo: '30 min' },
  criterios: [{ id: '1', resultado: 'CUMPLE', evidencia: 'ok' }, { id: '2', resultado: 'CUMPLE', evidencia: 'ok' }],
  evidencia: { propias: [{ comando: 'npm test', sha: HEAD, codigoSalida: 0 }], ci: { estado: 'EXITO', ejecucion: 'r1', sha: HEAD }, autor: [] },
  hallazgos: [], veredicto: 'CONFORME', ...extra,
})
const comentario = (r: unknown) => ({ id: 1, body: `${MARCA_DICTAMEN}\n\n\`\`\`json\n${JSON.stringify(r)}\n\`\`\``, user: { login: ME } })

/** `listas` PRs [ORD-POS-n] (n = 1..listas), `fusionados` con merged_at; comentarios del PR n, de `comentarios`. */
function github({ listas = 0, fusionados = [] as number[], comentarios = {} as Record<number, unknown[]> } = {}) {
  const llamadas: string[] = []
  const fetchImpl = (async (url: string) => {
    const u = new URL(url)
    llamadas.push(u.pathname)
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
    if (u.pathname === '/user') return json({ login: ME })
    if (u.pathname === `/repos/${REPO}/pulls`) {
      return json(Number(u.searchParams.get('page')) > 1 ? [] : Array.from({ length: listas }, (_, i) => ({
        number: i + 1, title: `[${id(i + 1)}][POS-041] t`, html_url: prUrl(i + 1),
        merged_at: fusionados.includes(i + 1) ? '2026-11-01T10:00:00Z' : null, user: { login: ME }, head: { repo: { full_name: REPO } },
      })))
    }
    if (/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(u.pathname)) return json({ head: { sha: HEAD } })
    const com = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/.exec(u.pathname)
    if (com) return json(comentarios[Number(com[1])] ?? [])
    if (/^\/repos\/jlpulido107-bit\/(SIGSAH|RADAROS)\/pulls$/.test(u.pathname)) return json([])
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
  return { cliente: () => createGitHubClient('token-falso', fetchImpl, { maxLlamadas: LLAMADAS_AGENTES }), llamadas }
}

beforeEach(() => { limpiarCacheDictamenes(); limpiarCacheAgentes() })

describe('criterio 1: una línea de pasos por orden abierta, solo lectura', () => {
  it('los nueve pasos en orden; CERRADA, CANCELADA y estados inválidos salen del Flujo', () => {
    const ordenes = [orden(1, 'BORRADOR'), orden(2, 'CERRADA'), orden(3, 'CANCELADA'), orden(4, 'RARO'), orden(5, 'ENVIADA')]
    const c = capaFlujo(ordenes, true, gh([]))
    expect(c.estado === 'ok' && c.lineas.map((l) => l.ordenId)).toEqual([id(5), id(1)])
    expect(c.estado === 'ok' && c.lineas[0]!.pasos.map((p) => p.paso)).toEqual([...PASOS])
  })

  it('BORRADOR espera tu aprobación; ENVIADA sin PR espera a Claude', () => {
    const b = lineaFlujo(orden(1, 'BORRADOR'), gh([]))
    expect(b.actual).toBe('Enviada')
    expect(b.espera).toEqual({ quien: 'propietario', texto: 'Revisar y aprobar' })
    const e = lineaFlujo(orden(2, 'ENVIADA'), gh([]))
    expect(estados(e)).toMatchObject({ Borrador: 'hecho', Enviada: 'hecho', PR: 'actual', PRIMERO: 'pendiente' })
    expect(e.espera.quien).toBe('claude')
  })

  it('PR detectado por título sin PR_URL cuenta como PR; el texto de PRIMERO sale de EvaluacionDictamen.siguiente', () => {
    const l = lineaFlujo(orden(3, 'ENVIADA'), gh([3], { 3: ninguno }))
    expect(estados(l)).toMatchObject({ PR: 'hecho', PRIMERO: 'actual' })
    expect(l.espera).toEqual({ quien: 'revisor', texto: 'Lanzar revisión' })
    expect(l.pr).toEqual({ url: prUrl(3), numero: 3 })
  })

  it('CAMBIOS espera al corrector (Claude) con el texto del dictamen', () => {
    const l = lineaFlujo(orden(1, 'PR_ABIERTO', { riesgo: 'MEDIO' }), gh([1], { 1: vigente('CAMBIOS', 'Corregir (ronda 1 de 2)') }))
    expect(l.actual).toBe('PRIMERO')
    expect(l.espera).toEqual({ quien: 'claude', texto: 'Corregir (ronda 1 de 2)' })
  })

  it('MEDIO sensible con PRIMERO CONFORME espera al segundo revisor; con los dos, tu decisión', () => {
    const falta = lineaFlujo(orden(1, 'PR_ABIERTO', { riesgo: 'MEDIO', sensible: 'SI' }), gh([1], { 1: vigente('CONFORME', 'Falta segundo revisor') }))
    expect(estados(falta)).toMatchObject({ PRIMERO: 'hecho', SEGUNDO: 'actual', Revisada: 'pendiente' })
    expect(falta.espera).toEqual({ quien: 'revisor', texto: 'Falta segundo revisor' })
    const listo = lineaFlujo(orden(1, 'PR_ABIERTO', { riesgo: 'MEDIO', sensible: null }), gh([1], { 1: vigente('CONFORME', LISTO_PARA_DECISION) }))
    expect(estados(listo)).toMatchObject({ PRIMERO: 'hecho', SEGUNDO: 'hecho', Revisada: 'actual' })
    expect(listo.espera).toEqual({ quien: 'propietario', texto: LISTO_PARA_DECISION })
  })

  it('REVISADA espera la fusión; fusionada sin cerrar sigue hasta Desplegada', () => {
    const r = lineaFlujo(orden(1, 'REVISADA'), gh([1], { 1: vigente('CONFORME', LISTO_PARA_DECISION) }))
    expect(r.actual).toBe('Fusionada')
    expect(r.espera).toEqual({ quien: 'propietario', texto: 'Fusionar o cerrar el PR' })
    const f = lineaFlujo(orden(1, 'REVISADA'), gh([1], { 1: vigente('CONFORME', LISTO_PARA_DECISION) }, [1]))
    expect(estados(f)).toMatchObject({ Fusionada: 'hecho', Desplegada: 'apagada', Activada: 'apagada' })
    expect(f.actual).toBeNull()
    expect(f.espera.quien).toBeNull()
  })
})

describe('criterio 2: «no aplica» según DEC-POS-008 y DEC-POS-019', () => {
  it('BAJO de solo docs: PRIMERO y SEGUNDO no aplican y nunca se pintan hechos; el paso actual es Revisada', () => {
    const l = lineaFlujo(orden(1, 'PR_ABIERTO'), gh([1], { 1: ninguno }), { soloDocs: true })
    expect(estados(l)).toMatchObject({ PRIMERO: 'no-aplica', SEGUNDO: 'no-aplica', Revisada: 'actual' })
    expect(l.espera.quien).toBe('propietario')
  })

  it('BAJO (de código) y MEDIO no sensible: SEGUNDO no aplica; PRIMERO sí', () => {
    const bajo = lineaFlujo(orden(1, 'PR_ABIERTO'), gh([1], { 1: ninguno }))
    expect(estados(bajo)).toMatchObject({ PRIMERO: 'actual', SEGUNDO: 'no-aplica' })
    const medio = lineaFlujo(orden(1, 'PR_ABIERTO', { riesgo: 'MEDIO', sensible: 'NO' }), gh([1], { 1: vigente('CONFORME', LISTO_PARA_DECISION) }))
    expect(estados(medio)).toMatchObject({ PRIMERO: 'hecho', SEGUNDO: 'no-aplica', Revisada: 'actual' })
  })

  it('MEDIO con SENSIBLE vacía es sensible: SEGUNDO aplica', () => {
    const l = lineaFlujo(orden(1, 'PR_ABIERTO', { riesgo: 'MEDIO', sensible: null }), gh([1], { 1: ninguno }))
    expect(estados(l)).toMatchObject({ PRIMERO: 'actual', SEGUNDO: 'pendiente' })
  })

  it('sin saber si es de solo docs (ninguna fuente de §4.1 lo dice), PRIMERO aplica: nunca «no aplica» por suposición', () => {
    const l = lineaFlujo(orden(1, 'PR_ABIERTO'), gh([1], { 1: ninguno }))
    expect(estados(l).PRIMERO).toBe('actual')
  })
})

describe('criterio 3: Desplegada y Activada apagadas; sin GitHub, sin datos', () => {
  it('Desplegada «apagada» con el motivo de F5; Activada, sin la columna BANDERA (ORD-POS-125)', () => {
    for (const o of [orden(1, 'BORRADOR'), orden(2, 'PR_ABIERTO'), orden(3, 'REVISADA')]) {
      const l = lineaFlujo(o, gh([2, 3]))
      expect(l.pasos.slice(-2)).toEqual([
        { paso: 'Desplegada', estado: 'apagada', motivo: MOTIVO_F5 }, { paso: 'Activada', estado: 'apagada', motivo: MOTIVO_SIN_COLUMNA_BANDERA },
      ])
    }
    expect(MOTIVO_F5.toLowerCase()).toBe('falta la fuente; la añade la fase f5.')
  })

  it('sin GitHub: PR, PRIMERO, SEGUNDO y Fusionada quedan «sin datos», nunca pendientes, y la orden no cuenta', () => {
    const l = lineaFlujo(orden(1, 'ENVIADA', { riesgo: 'MEDIO' }), null)
    expect(estados(l)).toMatchObject({ PR: 'sin-datos', PRIMERO: 'sin-datos', SEGUNDO: 'sin-datos', Fusionada: 'sin-datos' })
    expect(l.pasos.find((p) => p.paso === 'PR')!.motivo).toBe(MOTIVO_SIN_GITHUB_FLUJO)
    expect(l.actual).toBeNull()
    const c = capaFlujo([orden(1, 'ENVIADA', { riesgo: 'MEDIO' }), orden(2, 'PR_ABIERTO', { riesgo: 'MEDIO' })], true, null)
    expect(c.estado === 'ok' && c.github).toBe('sin-token')
    expect(c.estado === 'ok' && c.lineas.flatMap((x) => x.pasos).filter((p) => ['PRIMERO', 'SEGUNDO', 'Fusionada'].includes(p.paso)).map((p) => p.estado))
      .not.toContain('pendiente')
    expect(c.estado === 'ok' && c.encabezado).toEqual({ propietario: 0, claude: 0, revisor: 0 })
  })

  it('con GitHub pero sin dictamen leído en esta carga: PRIMERO «sin datos», no pendiente', () => {
    const l = lineaFlujo(orden(1, 'PR_ABIERTO'), gh([1]))
    expect(estados(l).PRIMERO).toBe('sin-datos')
    expect(l.actual).toBeNull()
  })

  it('sin ORDENES_CODEX la capa es «sin datos»', () => {
    expect(capaFlujo([orden(1, 'BORRADOR')], false, null).estado).toBe('sin-datos')
  })
})

describe('criterio 4: encabezado, etiqueta y tope de llamadas', () => {
  it('encabezado «Esperan por ti · por Claude · por revisor» y el nombre antes del ID', () => {
    const ordenes = [orden(1, 'BORRADOR'), orden(2, 'ENVIADA'), orden(3, 'PR_ABIERTO'), orden(4, 'REVISADA', { titulo: '' })]
    const c = capaFlujo(ordenes, true, gh([3, 4], { 3: ninguno, 4: vigente('CONFORME', LISTO_PARA_DECISION) }))
    expect(c.estado === 'ok' && c.encabezado).toEqual({ propietario: 2, claude: 1, revisor: 1 })
    const html = renderToStaticMarkup(createElement(FlujoView, { capa: c }))
    expect(html).toContain('Esperan por ti: 2 · por Claude: 1 · por revisor: 1')
    expect(html).toContain(`Orden 1 · <a class="mono small" href="/ordenes#orden-${id(1)}">${id(1)}</a>`)
    expect(html).toContain(`(orden sin título) · <a class="mono small" href="/ordenes#orden-${id(4)}">`)
    expect(html).toContain(MOTIVO_F5)
  })

  it('lee el dictamen con dictamenDeOrden: un CONFORME del head actual en BAJO deja la orden en tu decisión', async () => {
    const g = github({ listas: 1, comentarios: { 1: [comentario(reporte(1))] } })
    const ordenes = [orden(1, 'PR_ABIERTO'), orden(2, 'BORRADOR')]
    const lectura = await githubDeFlujo(g.cliente(), ordenes, { ahora: NOW })
    // Solo se pide el dictamen de la orden con PR.
    expect(g.llamadas.some((p) => /\/(pulls|issues)\/2\b/.test(p))).toBe(false)
    const c = capaFlujo(ordenes, true, lectura)
    const l = c.estado === 'ok' ? c.lineas.find((x) => x.ordenId === id(1))! : null
    expect(estados(l!)).toMatchObject({ PRIMERO: 'hecho', SEGUNDO: 'no-aplica', Revisada: 'actual' })
    expect(l!.espera).toEqual({ quien: 'propietario', texto: LISTO_PARA_DECISION })
  })

  it('con caché fría no pasa del tope LLAMADAS_AGENTES; lo que no cupo queda «sin datos» y se lee en las cargas siguientes', async () => {
    const g = github({ listas: 60 })
    const ordenes = Array.from({ length: 60 }, (_, i) => orden(i + 1, 'PR_ABIERTO'))
    const carga = () => githubDeFlujo(g.cliente(), ordenes, { ahora: NOW })
    const r1 = await carga()
    expect(g.llamadas.length).toBeLessThanOrEqual(LLAMADAS_AGENTES)
    const c1 = capaFlujo(ordenes, true, r1)
    expect(c1.estado === 'ok' && c1.github).toBe('parcial')
    expect(c1.estado === 'ok' && c1.lineas.filter((l) => estados(l).PRIMERO === 'sin-datos').length).toBeGreaterThan(0)
    let r = r1
    for (let i = 0; i < 10 && [...r.dictamenes.evaluaciones.values()].filter(Boolean).length < 60; i++) {
      const antes = g.llamadas.length
      r = await carga()
      expect(g.llamadas.length - antes).toBeLessThanOrEqual(LLAMADAS_AGENTES)
    }
    expect([...r.dictamenes.evaluaciones.values()].filter(Boolean)).toHaveLength(60)
  })

  it('con caché caliente, cero llamadas', async () => {
    const g = github({ listas: 5, fusionados: [5] })
    const ordenes = Array.from({ length: 5 }, (_, i) => orden(i + 1, 'PR_ABIERTO'))
    await githubDeFlujo(g.cliente(), ordenes, { ahora: NOW })
    expect(g.llamadas.length).toBeGreaterThan(0)
    expect(g.llamadas.length).toBeLessThanOrEqual(LLAMADAS_AGENTES)
    const antes = g.llamadas.length
    const caliente = await githubDeFlujo(g.cliente(), ordenes, { ahora: NOW })
    expect(g.llamadas.length - antes).toBe(0)
    expect([...caliente.dictamenes.evaluaciones.values()].filter(Boolean)).toHaveLength(5)
    const c = capaFlujo(ordenes, true, caliente)
    expect(c.estado === 'ok' && estados(c.lineas.find((l) => l.ordenId === id(5))!).Fusionada).toBe('hecho')
  })
})
