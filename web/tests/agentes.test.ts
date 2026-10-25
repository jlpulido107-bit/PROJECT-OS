import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { VistaAgentes, type IndicadoresAgentes } from '@/components/agentes/agentes'
import {
  conteoOrdenes, dictamenesPorOrden, gastoClaude, mapaLanzamientos, ordenesDelFiltro, parseFiltroAgentes, tiempoAFusion,
  type FiltroAgentes, type FuenteClaude,
} from '@/lib/agentes'
import { githubDeAgentes, limpiarCacheAgentes, LLAMADAS_AGENTES } from '@/lib/agentes-data'
import { civilHourInZone } from '@/lib/dates'
import { construirFinanzas, gastoClaudeMensual, type Movimiento } from '@/lib/finanzas/finanzas'
import { eventosOrdenes } from '@/lib/metricas'
import { WRITE_HEADERS } from '@/lib/operations/constants'
import { limpiarCacheDictamenes } from '@/lib/operations/dictamenes'
import { createGitHubClient, MAX_PRS_LISTA, type PrFusion } from '@/lib/operations/github'
import { InMemoryTableStore, readView } from '@/lib/operations/table-store'
import { extraerCriterios } from '@/lib/supervision/criterios'
import { dictamenesValidos, MARCA_DICTAMEN } from '@/lib/supervision/dictamen'
import type { Orden } from '@/lib/types'

/** /agentes (ORD-POS-078): cálculo de cada indicador con fixtures; GitHub simulado, sin red. */

const TODO: FiltroAgentes = { proyecto: null, desde: null, hasta: null }
const ME = 'jlpulido107-bit'
const CRITERIOS = '1. Uno\n2. Dos'

const orden = (id: string, estado: string, riesgo = 'BAJO', proyectoId: string | null = id.slice(4, 7)): Orden => ({
  id, proyectoId, tareaId: 'POS-029', titulo: 't', objetivo: null, contexto: null, criterios: CRITERIOS, fueraDeAlcance: null,
  comoProbar: null, riesgo, estado, issueUrl: null, prUrl: null, notas: null, actualizadoEn: null,
})

let req = 0
/** Filas de AUDITORIA de una operación del dashboard (mismo formato que en metricas.test.ts). */
function op(operacion: string, id: string, fecha: string, campos: Record<string, [string, string]>): string[][] {
  req++
  const requestId = `00000000-0000-4000-8000-${String(req).padStart(12, '0')}`
  const origen = `dashboard-v1.4;modo=sheets;op=${operacion};req=${requestId};h=${'a'.repeat(16)}`
  const entries = Object.entries(campos)
  const total = String(entries.length).padStart(2, '0')
  return entries.map(([campo, [antes, despues]], i) => [
    `AUD-20261019100000-${req.toString(16).toUpperCase().padStart(4, '0')}-${String(i + 1).padStart(2, '0')}-${total}`,
    fecha, 'actor', 'ORDENES_CODEX', id, campo, antes, despues, origen,
  ])
}
const crear = (id: string, fecha: string) => op('orden.crear', id, fecha, { ORDEN_ID: ['', id], ESTADO: ['', 'BORRADOR'] })
const enviar = (id: string, fecha: string) => op('orden.enviar', id, fecha, { ESTADO: ['APROBADA', 'ENVIADA'] })
const lanzar = (accion: 'revisar' | 'corregir', id: string, fecha: string, clave: string, sesion = 'https://claude.ai/code/session_x') =>
  op(`orden.${accion}_lanzar`, id, fecha, { SESION: ['', sesion], CLAVE: ['', clave] })
const vista = (filas: string[][][]) => readView(new InMemoryTableStore({ AUDITORIA: [[...WRITE_HEADERS.AUDITORIA], ...filas.flat()] }), 'AUDITORIA')

/** Indicadores con todas las fuentes vacías (para pintar una sola tarjeta llena). */
const vaciasInd = (): IndicadoresAgentes => ({
  ordenes: conteoOrdenes(ordenesDelFiltro([], null, TODO)),
  fusion: tiempoAFusion([], null, null, TODO),
  dictamenes: dictamenesPorOrden(ordenesDelFiltro([], null, TODO), null, null, null),
  lanzamientos: mapaLanzamientos(null, [], TODO),
  claude: gastoClaude({ estado: 'sin-fuente', mensaje: 'FINANZAS no está configurado en este despliegue.' }, TODO),
})

const pr = (n: number, fusion: string | null): PrFusion => ({ url: `https://github.com/jlpulido107-bit/PROJECT-OS/pull/${n}`, number: n, fusionMs: fusion ? Date.parse(fusion) : null })

describe('filtro', () => {
  it('lee proyecto y rango; ignora valores no válidos e invierte un rango al revés', () => {
    expect(parseFiltroAgentes({ proyecto: 'sig', desde: '2026-10-01', hasta: '2026-10-31' })).toEqual({ proyecto: 'SIG', desde: '2026-10-01', hasta: '2026-10-31' })
    expect(parseFiltroAgentes({ proyecto: 'XYZ', desde: '2026-13-01', hasta: ['2026-10-01'] })).toEqual(TODO)
    expect(parseFiltroAgentes({ desde: '2026-10-31', hasta: '2026-10-01' })).toEqual({ proyecto: null, desde: '2026-10-01', hasta: '2026-10-31' })
  })

  it('hora y día de la semana en Mérida', () => {
    // 2026-10-26T03:30Z = domingo 25 a las 21:30 en Mérida (UTC−6).
    expect(civilHourInZone(Date.parse('2026-10-26T03:30:00Z'))).toEqual({ date: '2026-10-25', hour: 21, weekday: 6 })
  })
})

describe('órdenes por estado, proyecto y riesgo', () => {
  const ordenes = [orden('ORD-POS-001', 'CERRADA'), orden('ORD-POS-002', 'ENVIADA', 'MEDIO'), orden('ORD-SIG-001', 'BORRADOR', 'RARO'), orden('ORD-ECO-001', 'CERRADA', 'BAJO', null)]

  it('sin filtro cuenta todas, en el orden de los estados', () => {
    const c = conteoOrdenes(ordenesDelFiltro(ordenes, null, TODO))
    expect(c).toEqual({ estado: 'ok', datos: {
      total: 4, sinFecha: 0,
      porEstado: [['BORRADOR', 1], ['ENVIADA', 1], ['CERRADA', 2]],
      porProyecto: [['POS', 2], ['SIG', 1], ['ECO', 1]],
      porRiesgo: [['BAJO', 2], ['MEDIO', 1], ['SIN_RIESGO', 1]],
    } })
  })

  it('por proyecto; con rango usa el alta de AUDITORIA y sin AUDITORIA es «sin datos»', async () => {
    expect(conteoOrdenes(ordenesDelFiltro(ordenes, null, { ...TODO, proyecto: 'POS' }))).toMatchObject({ datos: { total: 2 } })
    const rango = { proyecto: null, desde: '2026-10-19', hasta: '2026-10-25' }
    expect(conteoOrdenes(ordenesDelFiltro(ordenes, null, rango))).toEqual({ estado: 'sin-datos', motivo: expect.stringContaining('AUDITORIA') })
    const audit = await vista([crear('ORD-POS-001', '2026-10-19T10:00:00-06:00'), crear('ORD-POS-002', '2026-10-26T10:00:00-06:00')])
    const c = conteoOrdenes(ordenesDelFiltro(ordenes, eventosOrdenes(ordenes, audit), rango))
    expect(c).toMatchObject({ datos: { total: 1, sinFecha: 2, porEstado: [['CERRADA', 1]] } })
  })

  it('ORDENES_CODEX vacía: «sin datos», no un cero', () => {
    expect(conteoOrdenes(ordenesDelFiltro([], null, TODO))).toEqual({ estado: 'sin-datos', motivo: 'No hay órdenes en ORDENES_CODEX.' })
  })
})

describe('tiempo de ENVIADA a PR fusionado', () => {
  it('mediana por proyecto con envío de AUDITORIA y fusión de GitHub', async () => {
    const ordenes = [orden('ORD-POS-001', 'CERRADA'), orden('ORD-POS-002', 'CERRADA'), orden('ORD-POS-003', 'CERRADA'), orden('ORD-POS-004', 'PR_ABIERTO'), orden('ORD-SIG-001', 'CERRADA')]
    const audit = await vista([
      enviar('ORD-POS-001', '2026-10-19T10:00:00-06:00'), enviar('ORD-POS-002', '2026-10-19T10:00:00-06:00'),
      enviar('ORD-POS-003', '2026-10-20T10:00:00-06:00'), enviar('ORD-POS-004', '2026-10-20T10:00:00-06:00'),
    ])
    const eventos = eventosOrdenes(ordenes, audit)
    const prs = {
      POS: new Map([['ORD-POS-001', pr(1, '2026-10-20T16:00:00Z')], ['ORD-POS-002', pr(2, '2026-10-22T16:00:00Z')], ['ORD-POS-003', pr(3, '2026-10-24T16:00:00Z')], ['ORD-POS-004', pr(4, null)]]),
      SIG: null, ECO: new Map(),
    }
    expect(tiempoAFusion(ordenes, eventos, prs, TODO)).toEqual({ estado: 'ok', datos: [
      { proyecto: 'POS', estado: 'ok', n: 3, medianaDias: 3, truncado: false },
      { proyecto: 'SIG', estado: 'sin-datos', motivo: 'GitHub no respondió.' },
      { proyecto: 'ECO', estado: 'ok', n: 0, medianaDias: null, truncado: false },
    ] })
    // El rango filtra por la fecha de envío.
    expect(tiempoAFusion(ordenes, eventos, prs, { proyecto: 'POS', desde: '2026-10-20', hasta: null })).toEqual({ estado: 'ok', datos: [{ proyecto: 'POS', estado: 'ok', n: 1, medianaDias: 4, truncado: false }] })
    expect(tiempoAFusion(ordenes, eventos, {}, { ...TODO, proyecto: 'DEV' })).toMatchObject({ datos: [{ proyecto: 'DEV', estado: 'sin-datos', motivo: 'Sin repositorio en GitHub.' }] })
  })

  it('sin AUDITORIA o sin GitHub es «sin datos»', () => {
    expect(tiempoAFusion([], null, {}, TODO).estado).toBe('sin-datos')
    expect(tiempoAFusion([], [], null, TODO).estado).toBe('sin-datos')
  })
})

describe('rondas y dictámenes', () => {
  const crit = extraerCriterios(CRITERIOS)
  if (!crit.ok) throw new Error('criterios de prueba inválidos')
  const HEAD = 'a'.repeat(40)
  const reporte = (n: number, extra: Record<string, unknown> = {}) => ({
    versionContrato: '1', versionPolitica: 'DEC-POS-008', ordenId: 'ORD-POS-001', tareaId: 'POS-029', proyectoId: 'POS',
    repo: 'jlpulido107-bit/PROJECT-OS', issue: 9, pr: 1, headSha: HEAD, baseSha: 'b'.repeat(40), hashCriterios: crit.hashCriterios,
    revisionId: `REV-${n}`, ejecucionId: `EJE-${n}`, intento: 1, ronda: 0,
    autorizacion: { otorgadaPor: 'propietario', orden: 'ORD-POS-001', desde: '2026-10-17' },
    limiteConsumo: { presupuesto: '1 USD', tiempoMaximo: '30 min' },
    criterios: [{ id: '1', resultado: 'CUMPLE', evidencia: 'ok' }, { id: '2', resultado: 'CUMPLE', evidencia: 'ok' }],
    evidencia: { propias: [{ comando: 'npm test', sha: HEAD, codigoSalida: 0 }], ci: { estado: 'EXITO', ejecucion: 'r1', sha: HEAD }, autor: [] },
    hallazgos: [], veredicto: 'CONFORME', ...extra,
  })
  const cambios = (n: number) => reporte(n, {
    criterios: [{ id: '1', resultado: 'NO_CUMPLE', evidencia: 'x' }, { id: '2', resultado: 'CUMPLE', evidencia: 'ok' }],
    hallazgos: [{ id: 'H1', severidad: 'ALTA', ubicacion: 'a.ts:1', condicion: 'c', impacto: 'i', bloquea: true, justificacion: 'j' }], veredicto: 'CAMBIOS',
  })
  const comentario = (r: unknown, login = ME) => ({ id: 1, login, body: `${MARCA_DICTAMEN}\n\n\`\`\`json\n${JSON.stringify(r)}\n\`\`\`` })

  beforeEach(() => { limpiarCacheDictamenes(); limpiarCacheAgentes() })

  it('dictamenesValidos: solo los válidos de la orden, el último de cada revisionId', () => {
    const datos = { headSha: HEAD, comentarios: [comentario(cambios(1)), comentario(reporte(2)), comentario(reporte(2)), comentario({ basura: 1 }), { id: 9, body: 'sin marca' }] }
    const d = dictamenesValidos(datos, { id: 'ORD-POS-001', riesgo: 'BAJO', criterios: CRITERIOS }, { repo: 'jlpulido107-bit/PROJECT-OS', numero: 1 })
    expect(d.map((x) => [x.revisionId, x.veredicto])).toEqual([['REV-1', 'CAMBIOS'], ['REV-2', 'CONFORME']])
    // Otra orden u otro PR: nada.
    expect(dictamenesValidos(datos, { id: 'ORD-POS-002', riesgo: 'BAJO', criterios: CRITERIOS }, { repo: 'jlpulido107-bit/PROJECT-OS', numero: 1 })).toEqual([])
  })

  function github(opts: { fallaComentarios?: boolean; fallaPrs?: boolean } = {}) {
    const llamadas: string[] = []
    const fetchImpl = (async (url: string) => {
      const u = new URL(url)
      llamadas.push(u.pathname)
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
      if (u.pathname === '/user') return json(200, { login: ME })
      if (u.pathname === '/repos/jlpulido107-bit/PROJECT-OS/pulls') {
        if (opts.fallaPrs) return json(502, {})
        const head = { repo: { full_name: 'jlpulido107-bit/PROJECT-OS' } }
        return json(200, [
          { number: 3, title: '[ORD-POS-002][POS-1] b', html_url: 'https://github.com/jlpulido107-bit/PROJECT-OS/pull/3', merged_at: null, user: { login: ME }, head },
          { number: 1, title: '[ORD-POS-001][POS-1] nuevo', html_url: 'https://github.com/jlpulido107-bit/PROJECT-OS/pull/1', merged_at: '2026-10-21T10:00:00Z', user: { login: ME }, head },
          { number: 0, title: '[ORD-POS-001][POS-1] viejo', html_url: 'https://github.com/jlpulido107-bit/PROJECT-OS/pull/0', merged_at: null, user: { login: ME }, head },
          { number: 4, title: '[ORD-POS-003] ajeno', html_url: 'https://github.com/x', merged_at: null, user: { login: 'otro' }, head },
          { number: 5, title: '[ORD-POS-004] fork', html_url: 'https://github.com/x', merged_at: null, user: { login: ME }, head: { repo: { full_name: 'otro/PROJECT-OS' } } },
          { number: 6, title: 'sin orden', html_url: 'https://github.com/x', merged_at: null, user: { login: ME }, head },
        ])
      }
      if (u.pathname === '/repos/jlpulido107-bit/PROJECT-OS/pulls/1') return json(200, { head: { sha: HEAD } })
      if (u.pathname === '/repos/jlpulido107-bit/PROJECT-OS/pulls/3') return opts.fallaComentarios ? json(502, {}) : json(200, { head: { sha: HEAD } })
      if (u.pathname === '/repos/jlpulido107-bit/PROJECT-OS/issues/1/comments') {
        return json(200, [comentario(cambios(1)), comentario(reporte(2)), comentario(reporte(3), 'otro')].map((c, i) => ({ id: i + 1, body: c.body, user: { login: c.login } })))
      }
      if (u.pathname === '/repos/jlpulido107-bit/PROJECT-OS/issues/3/comments') return json(200, [])
      return json(404, {})
    }) as unknown as typeof fetch
    return { client: createGitHubClient('token-falso', fetchImpl), llamadas }
  }

  it('cuenta CONFORME y CAMBIOS del PR detectado y las rondas de AUDITORIA', async () => {
    const { client, llamadas } = github()
    const ordenes = [orden('ORD-POS-001', 'REVISADA'), orden('ORD-POS-002', 'PR_ABIERTO'), orden('ORD-POS-005', 'BORRADOR')]
    const gh = await githubDeAgentes(client, 'POS', ordenes)
    const { prs } = gh
    expect(gh.vencido).toBe(false)
    expect([...prs.POS!.entries()]).toEqual([
      ['ORD-POS-002', { url: 'https://github.com/jlpulido107-bit/PROJECT-OS/pull/3', number: 3, fusionMs: null }],
      ['ORD-POS-001', { url: 'https://github.com/jlpulido107-bit/PROJECT-OS/pull/1', number: 1, fusionMs: Date.parse('2026-10-21T10:00:00Z') }],
    ])
    // Caché: una segunda carga no vuelve a llamar a GitHub (ni la lista ni los dictámenes).
    const antes = llamadas.length
    await githubDeAgentes(client, 'POS', ordenes)
    expect(llamadas.length).toBe(antes)
    expect(llamadas.filter((p) => p.endsWith('/pulls'))).toHaveLength(1)

    const audit = await vista([lanzar('corregir', 'ORD-POS-001', '2026-10-20T10:00:00-06:00', 'k1')])
    const eventos = eventosOrdenes(ordenes, audit)
    const base = ordenesDelFiltro(ordenes, eventos, TODO)
    expect(dictamenesPorOrden(base, eventos, prs, gh.dictamenes)).toEqual({ estado: 'ok', datos: {
      filas: [
        { ordenId: 'ORD-POS-002', prUrl: 'https://github.com/jlpulido107-bit/PROJECT-OS/pull/3', rondas: 0, conforme: 0, cambios: 0, omitida: false },
        { ordenId: 'ORD-POS-001', prUrl: 'https://github.com/jlpulido107-bit/PROJECT-OS/pull/1', rondas: 1, conforme: 1, cambios: 1, omitida: false },
      ],
      totalConforme: 1, totalCambios: 1, sinLeer: 0, omitidas: 0, rondasSinDatos: false,
    } })
  })

  it('criterio 1: CERRADA y CANCELADA no piden dictámenes; conservan su fila, fuera de totales y de «sin leer»', async () => {
    const { client, llamadas } = github()
    const ordenes = [orden('ORD-POS-001', 'CERRADA'), orden('ORD-POS-002', 'CANCELADA')]
    const gh = await githubDeAgentes(client, 'POS', ordenes)
    expect(llamadas.filter((p) => /\/pulls\/\d+$|\/comments$/.test(p))).toEqual([])
    expect([...gh.dictamenes!.keys()]).toEqual([])
    const d = dictamenesPorOrden(ordenesDelFiltro(ordenes, null, TODO), null, gh.prs, gh.dictamenes)
    expect(d).toMatchObject({ estado: 'ok', datos: { totalConforme: 0, totalCambios: 0, sinLeer: 0, omitidas: 2 } })
    expect(d.estado === 'ok' && d.datos.filas.every((f) => f.omitida && f.conforme === null)).toBe(true)
    const h = renderToStaticMarkup(createElement(VistaAgentes, { filtro: TODO, ind: { ...vaciasInd(), dictamenes: d } }))
    expect(h).toContain('No se lee (CERRADA o CANCELADA)')
    expect(h).toContain('2 órdenes CERRADA o CANCELADA')
  })

  it('PR sin leer: «sin datos» en su fila y fuera de los totales; sin AUDITORIA, rondas sin datos', async () => {
    const { client } = github({ fallaComentarios: true })
    const ordenes = [orden('ORD-POS-001', 'REVISADA'), orden('ORD-POS-002', 'PR_ABIERTO')]
    const gh = await githubDeAgentes(client, null, ordenes)
    const base = ordenesDelFiltro(ordenes, null, TODO)
    const d = dictamenesPorOrden(base, null, gh.prs, gh.dictamenes)
    expect(d).toMatchObject({ datos: { totalConforme: 1, totalCambios: 1, sinLeer: 1, rondasSinDatos: true } })
    expect(d.estado === 'ok' && d.datos.filas[0]).toEqual({ ordenId: 'ORD-POS-002', prUrl: 'https://github.com/jlpulido107-bit/PROJECT-OS/pull/3', rondas: null, conforme: null, cambios: null, omitida: false })
  })

  it('GitHub caído o sin token: «sin datos»', async () => {
    const { client } = github({ fallaPrs: true })
    const { prs } = await githubDeAgentes(client, 'POS', null)
    expect(prs).toEqual({ POS: null })
    const base = ordenesDelFiltro([orden('ORD-POS-001', 'CERRADA')], null, TODO)
    expect(dictamenesPorOrden(base, null, prs, new Map())).toEqual({ estado: 'sin-datos', motivo: 'Ninguna orden del filtro tiene un PR detectado en GitHub.' })
    expect(dictamenesPorOrden(base, null, null, null)).toEqual({ estado: 'sin-datos', motivo: 'Sin datos de GitHub: los dictámenes viven en los PRs.' })
  })
})

describe('ORD-POS-080: límite de GitHub, tiempo máximo global y paginación', () => {
  beforeEach(() => { limpiarCacheDictamenes(); limpiarCacheAgentes() })
  const HEAD = 'c'.repeat(40)
  const REPOS: Record<string, string> = { POS: 'jlpulido107-bit/PROJECT-OS', SIG: 'jlpulido107-bit/SIGSAH', ECO: 'jlpulido107-bit/RADAROS' }

  /**
   * GitHub simulado con `paginas` páginas de PRs por repositorio (100 por página, la última con `ultima` PRs); el PR n es
   * de la orden ORD-<P>-n. `cuelga` deja sin responder las rutas que casan.
   */
  function githubGrande({ paginas = 5, ultima = 100, cuelga }: { paginas?: number; ultima?: number; cuelga?: RegExp } = {}) {
    const llamadas: string[] = []
    const fetchImpl = (async (url: string) => {
      const u = new URL(url)
      llamadas.push(u.pathname)
      if (cuelga?.test(u.pathname)) return new Promise<Response>(() => {})
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
      if (u.pathname === '/user') return json({ login: ME })
      const [, repo, resto] = /^\/repos\/([^/]+\/[^/]+)(\/.*)$/.exec(u.pathname) ?? []
      const p = Object.keys(REPOS).find((k) => REPOS[k] === repo)
      if (!p) return new Response('{}', { status: 404 })
      if (resto === '/pulls') {
        const page = Number(u.searchParams.get('page'))
        const n = page > paginas ? 0 : page === paginas ? ultima : 100
        return json(Array.from({ length: n }, (_, i) => {
          const num = (page - 1) * 100 + i + 1
          return { number: num, title: `[ORD-${p}-${String(num).padStart(3, '0')}][X] t`, html_url: `https://github.com/${repo}/pull/${num}`, merged_at: null, user: { login: ME }, head: { repo: { full_name: repo } } }
        }))
      }
      if (/^\/pulls\/\d+$/.test(resto!)) return json({ head: { sha: HEAD } })
      if (/^\/issues\/\d+\/comments$/.test(resto!)) return json([])
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch
    return { cliente: () => createGitHubClient('token-falso', fetchImpl, { maxLlamadas: LLAMADAS_AGENTES }), llamadas }
  }

  /** 60 órdenes por proyecto con PR: la mitad CERRADA o CANCELADA. */
  const muchas = () => Object.keys(REPOS).flatMap((p) => Array.from({ length: 60 }, (_, i) =>
    orden(`ORD-${p}-${String(i + 1).padStart(3, '0')}`, ['CERRADA', 'PR_ABIERTO', 'CANCELADA', 'REVISADA'][i % 4]!)))

  it('criterio 1: una carga en frío hace como máximo 40 llamadas, nunca de CERRADA ni CANCELADA, y la caché avanza', async () => {
    const gh = githubGrande()
    const ordenes = muchas()
    const ahora = Date.now()
    const r1 = await githubDeAgentes(gh.cliente(), null, ordenes, { ahora })
    expect(LLAMADAS_AGENTES).toBe(40)
    expect(gh.llamadas.length).toBeLessThanOrEqual(40)
    // Sin esta orden: 1 /user + 15 páginas + 2 por dictamen ×(60/2)×3 = 196 llamadas.
    expect(gh.llamadas.filter((x) => x === '/user')).toHaveLength(1)
    const cerradas = new Set(ordenes.filter((o) => o.estado === 'CERRADA' || o.estado === 'CANCELADA').map((o) => `${REPOS[o.id.slice(4, 7)]}#${Number(o.id.slice(8))}`))
    const pedidos = gh.llamadas.flatMap((x) => {
      const m = /^\/repos\/([^/]+\/[^/]+)\/(?:pulls|issues)\/(\d+)/.exec(x)
      return m ? [`${m[1]}#${m[2]}`] : []
    })
    expect(pedidos.length).toBeGreaterThan(0)
    expect(pedidos.filter((x) => cerradas.has(x))).toEqual([])
    const leidas1 = [...r1.dictamenes!.values()].filter((d) => d !== null).length
    expect(leidas1).toBeGreaterThan(0)

    // Segunda carga (otro cliente, otro tope): lo ya leído sale de la caché; solo pide lo que faltaba, con el mismo tope.
    const antes = gh.llamadas.length
    const r2 = await githubDeAgentes(gh.cliente(), null, ordenes, { ahora })
    const segunda = gh.llamadas.slice(antes)
    expect(segunda.length).toBeLessThanOrEqual(40)
    expect(segunda.filter((x) => x.endsWith('/pulls'))).toEqual([])
    expect([...r2.dictamenes!.values()].filter((d) => d !== null).length).toBeGreaterThan(leidas1)
  })

  it('criterio 2: al vencer el tiempo global la página responde y lo que no terminó dice «sin datos»', async () => {
    // Los comentarios de PR no responden nunca: la lista llega, los dictámenes no.
    const gh = githubGrande({ paginas: 1, ultima: 3, cuelga: /\/comments$/ })
    const ordenes = [orden('ORD-POS-001', 'PR_ABIERTO'), orden('ORD-POS-002', 'REVISADA')]
    const t0 = Date.now()
    const r = await githubDeAgentes(gh.cliente(), 'POS', ordenes, { limiteMs: 50 })
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(r.vencido).toBe(true)
    expect(r.prs.POS!.size).toBe(3)
    const d = dictamenesPorOrden(ordenesDelFiltro(ordenes, null, TODO), null, r.prs, r.dictamenes)
    expect(d).toMatchObject({ estado: 'ok', datos: { sinLeer: 2, totalConforme: 0 } })
    const h = renderToStaticMarkup(createElement(VistaAgentes, { filtro: TODO, ind: { ...vaciasInd(), dictamenes: d } }))
    expect(h.match(/Sin datos/g)!.length).toBeGreaterThanOrEqual(4)

    // La lista de PRs tampoco responde: fusión «GitHub no respondió» y dictámenes «sin datos».
    limpiarCacheAgentes()
    const caido = githubGrande({ cuelga: /\/pulls$/ })
    const r2 = await githubDeAgentes(caido.cliente(), 'POS', ordenes, { limiteMs: 50 })
    expect(r2).toEqual({ prs: { POS: null }, truncados: [], dictamenes: null, vencido: true })
    expect(tiempoAFusion(ordenes, [], r2.prs, TODO)).toMatchObject({ datos: [{ proyecto: 'POS', estado: 'sin-datos', motivo: 'GitHub no respondió.' }] })
    expect(dictamenesPorOrden(ordenesDelFiltro(ordenes, null, TODO), null, r2.prs, r2.dictamenes)).toEqual({ estado: 'sin-datos', motivo: 'Sin datos de GitHub: los dictámenes viven en los PRs.' })
  })

  it('la página usa el cliente con tope y muestra el vencimiento', () => {
    const src = readFileSync(path.join(__dirname, '..', 'src', 'app', '(private)', 'agentes', 'page.tsx'), 'utf8')
    expect(src).toMatch(/githubClient\(process\.env, \{ maxLlamadas: LLAMADAS_AGENTES \}\)/)
    expect(src).toMatch(/gh\?\.vencido/)
  })

  it('criterio 3: con la lista en el límite de paginación, la tarjeta de tiempos lo avisa', async () => {
    const lleno = await githubGrande().cliente().prsDeOrdenes('POS')
    expect([lleno.prs.size, lleno.truncado]).toEqual([MAX_PRS_LISTA, true])
    const parcial = await githubGrande({ paginas: 5, ultima: 99 }).cliente().prsDeOrdenes('POS')
    expect([parcial.prs.size, parcial.truncado]).toEqual([499, false])

    const r = await githubDeAgentes(githubGrande().cliente(), 'POS', null)
    expect(r.truncados).toEqual(['POS'])
    const ordenes = [orden('ORD-POS-001', 'CERRADA')]
    const fusion = tiempoAFusion(ordenes, [], r.prs, { ...TODO, proyecto: 'POS' }, r.truncados)
    expect(fusion).toMatchObject({ datos: [{ proyecto: 'POS', estado: 'ok', truncado: true }] })
    const h = renderToStaticMarkup(createElement(VistaAgentes, { filtro: TODO, ind: { ...vaciasInd(), fusion } }))
    expect(h).toContain('Lista incompleta')
    expect(h).toContain(`llegó al límite de ${MAX_PRS_LISTA} PRs`)
    const sin = renderToStaticMarkup(createElement(VistaAgentes, { filtro: TODO, ind: { ...vaciasInd(), fusion: tiempoAFusion(ordenes, [], r.prs, { ...TODO, proyecto: 'POS' }) } }))
    expect(sin).not.toContain('Lista incompleta')
  })

  it('criterio 5: la regla del gasto de Claude está escrita en la página', () => {
    const h = renderToStaticMarkup(createElement(VistaAgentes, { filtro: TODO, ind: vaciasInd() }))
    expect(h).toContain('decisión del propietario del 2026-10-24')
    expect(h).toContain('categoría Herramientas')
  })
})

describe('mapa de lanzamientos', () => {
  it('cuenta revisiones y correcciones con sesión por día y hora de Mérida; filtra por proyecto y rango', async () => {
    const ordenes = [orden('ORD-POS-001', 'PR_ABIERTO'), orden('ORD-SIG-001', 'PR_ABIERTO')]
    const audit = await vista([
      lanzar('revisar', 'ORD-POS-001', '2026-10-19T09:15:00-06:00', 'k1'), // lunes 9 h
      lanzar('corregir', 'ORD-POS-001', '2026-10-19T09:45:00-06:00', 'k2'), // lunes 9 h
      lanzar('revisar', 'ORD-SIG-001', '2026-10-26T03:30:00Z', 'k3'), // domingo 25, 21 h en Mérida
      lanzar('revisar', 'ORD-POS-001', '2026-10-20T10:00:00-06:00', 'k4', ''), // sin sesión: no cuenta
      op('orden.supervision_reservar', 'ORD-POS-001', '2026-10-20T10:00:00-06:00', { CLAVE: ['', 'k5'] }),
    ])
    const m = mapaLanzamientos(audit, ordenes, TODO)
    expect(m.estado === 'ok' && { total: m.datos.total, max: m.datos.max, lun9: m.datos.celdas[0]![9], dom21: m.datos.celdas[6]![21] })
      .toEqual({ total: 3, max: 2, lun9: 2, dom21: 1 })
    expect(mapaLanzamientos(audit, ordenes, { ...TODO, proyecto: 'SIG' })).toMatchObject({ datos: { total: 1 } })
    expect(mapaLanzamientos(audit, ordenes, { proyecto: null, desde: '2026-10-25', hasta: '2026-10-25' })).toMatchObject({ datos: { total: 1 } })
    expect(mapaLanzamientos(null, ordenes, TODO).estado).toBe('sin-datos')
  })
})

describe('gasto mensual en Claude', () => {
  const mov = (movId: string, mes: string, proyecto: 'ECO' | 'POS', concepto: string, pesos: number, extra: Partial<Movimiento> = {}): Movimiento => ({
    movId, fecha: `${mes}-01`, mes, proyecto, tipo: 'Gasto', categoria: 'Herramientas', concepto, productoId: null, centavos: pesos * 100, ajusteDe: null, ...extra,
  })

  it('gastoClaudeMensual: Herramientas de Claude por concepto o MOV_ID, con ajustes, sin otras herramientas', () => {
    const meses = gastoClaudeMensual([
      mov('MAN-0001', '2026-09', 'POS', 'Suscripción Claude', 400),
      mov('REC-CLAUDE-2026-10', '2026-10', 'POS', 'Plan Max', 2000),
      mov('MAN-0002', '2026-10', 'ECO', 'Claude API', 100),
      mov('MAN-0003', '2026-10', 'POS', 'Ajuste de MAN-0001', -50, { ajusteDe: 'MAN-0001' }),
      mov('MAN-0004', '2026-10', 'POS', 'Keepa', 900),
      mov('MAN-0005', '2026-10', 'POS', 'Claude', 300, { categoria: 'Marketing' }),
      mov('MAN-0006', '2026-10', 'POS', 'Claudette', 300),
    ])
    expect(meses).toEqual([{ mes: '2026-09', gasto: { ECO: 0, POS: 40000 } }, { mes: '2026-10', gasto: { ECO: 10000, POS: 195000 } }])
  })

  it('filtra por proyecto y meses del rango; SIG, FINANZAS ausente o sin filas es «sin datos»', () => {
    const fuente: FuenteClaude = { estado: 'ok', datos: [{ mes: '2026-09', gasto: { ECO: 0, POS: 40000 } }, { mes: '2026-10', gasto: { ECO: 10000, POS: 195000 } }] }
    expect(gastoClaude(fuente, TODO)).toEqual({ estado: 'ok', datos: { meses: [{ mes: '2026-09', centavos: 40000 }, { mes: '2026-10', centavos: 205000 }], totalCentavos: 245000 } })
    // ECO no tuvo gasto en septiembre: ese mes no aparece como cero.
    expect(gastoClaude(fuente, { ...TODO, proyecto: 'ECO' })).toEqual({ estado: 'ok', datos: { meses: [{ mes: '2026-10', centavos: 10000 }], totalCentavos: 10000 } })
    expect(gastoClaude(fuente, { proyecto: null, desde: '2026-10-05', hasta: '2026-10-06' })).toMatchObject({ datos: { totalCentavos: 205000 } })
    expect(gastoClaude(fuente, { ...TODO, proyecto: 'SIG' })).toEqual({ estado: 'sin-datos', motivo: 'FINANZAS solo registra ECO y POS.' })
    expect(gastoClaude(fuente, { proyecto: null, desde: '2027-01-01', hasta: null }).estado).toBe('sin-datos')
    expect(gastoClaude({ estado: 'sin-fuente', mensaje: 'FINANZAS no está configurado en este despliegue.' }, TODO))
      .toEqual({ estado: 'sin-datos', motivo: 'FINANZAS no está configurado en este despliegue.' })
    expect(gastoClaude(construirFinanzas({}, Date.parse('2026-10-24T12:00:00Z')).claude, TODO).estado).toBe('sin-datos')
  })
})

describe('render', () => {
  it('fuentes llenas: las 5 tarjetas con sus valores; fuentes vacías: «Sin datos» y ningún cero inventado', async () => {
    const ordenes = [orden('ORD-POS-001', 'REVISADA', 'MEDIO')]
    const audit = await vista([enviar('ORD-POS-001', '2026-10-19T10:00:00-06:00'), lanzar('revisar', 'ORD-POS-001', '2026-10-19T09:15:00-06:00', 'k1')])
    const eventos = eventosOrdenes(ordenes, audit)
    const prs = { POS: new Map([['ORD-POS-001', pr(1, '2026-10-21T16:00:00Z')]]) }
    const base = ordenesDelFiltro(ordenes, eventos, TODO)
    const llenas: IndicadoresAgentes = {
      ordenes: conteoOrdenes(base),
      fusion: tiempoAFusion(ordenes, eventos, prs, TODO),
      dictamenes: dictamenesPorOrden(base, eventos, prs, new Map([['ORD-POS-001', [{ revisionId: 'R1', veredicto: 'CONFORME' as const }]]])),
      lanzamientos: mapaLanzamientos(audit, ordenes, TODO),
      claude: gastoClaude({ estado: 'ok', datos: [{ mes: '2026-10', gasto: { ECO: 0, POS: 200000 } }] }, TODO),
    }
    const h = renderToStaticMarkup(createElement(VistaAgentes, { filtro: { proyecto: 'POS', desde: '2026-10-01', hasta: null }, ind: llenas }))
    expect(h).toContain('action="/agentes"')
    expect(h).toContain('value="2026-10-01"')
    expect(h).toContain('Revisada: 1')
    expect(h).toContain('MEDIO: 1')
    expect(h).toContain('2 d')
    expect(h).toContain('CONFORME: 1')
    expect(h).toContain('1 lanzamientos')
    expect(h).toContain('oct 2026')
    expect(h).toContain('$2,000.00')
    expect(h).not.toContain('Sin datos')

    const vacias: IndicadoresAgentes = {
      ordenes: conteoOrdenes(ordenesDelFiltro([], null, TODO)),
      fusion: tiempoAFusion([], null, null, TODO),
      dictamenes: dictamenesPorOrden(ordenesDelFiltro([], null, TODO), null, null, null),
      lanzamientos: mapaLanzamientos(null, [], TODO),
      claude: gastoClaude({ estado: 'sin-fuente', mensaje: 'FINANZAS no está configurado en este despliegue.' }, TODO),
    }
    const v = renderToStaticMarkup(createElement(VistaAgentes, { filtro: TODO, ind: vacias }))
    expect(v.match(/Sin datos/g)).toHaveLength(5)
    expect(v).toContain('FINANZAS no está configurado')
    expect(v).not.toMatch(/>0</)
  })
})
