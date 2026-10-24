import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { VistaAgentes, type IndicadoresAgentes } from '@/components/agentes/agentes'
import {
  conteoOrdenes, dictamenesPorOrden, gastoClaude, mapaLanzamientos, ordenesDelFiltro, parseFiltroAgentes, tiempoAFusion,
  type FiltroAgentes, type FuenteClaude,
} from '@/lib/agentes'
import { dictamenesDeOrdenes, limpiarCacheAgentes, prsPorProyecto } from '@/lib/agentes-data'
import { civilHourInZone } from '@/lib/dates'
import { construirFinanzas, gastoClaudeMensual, type Movimiento } from '@/lib/finanzas/finanzas'
import { eventosOrdenes } from '@/lib/metricas'
import { WRITE_HEADERS } from '@/lib/operations/constants'
import { limpiarCacheDictamenes } from '@/lib/operations/dictamenes'
import { createGitHubClient, type PrFusion } from '@/lib/operations/github'
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
      { proyecto: 'POS', estado: 'ok', n: 3, medianaDias: 3 },
      { proyecto: 'SIG', estado: 'sin-datos', motivo: 'GitHub no respondió.' },
      { proyecto: 'ECO', estado: 'ok', n: 0, medianaDias: null },
    ] })
    // El rango filtra por la fecha de envío.
    expect(tiempoAFusion(ordenes, eventos, prs, { proyecto: 'POS', desde: '2026-10-20', hasta: null })).toEqual({ estado: 'ok', datos: [{ proyecto: 'POS', estado: 'ok', n: 1, medianaDias: 4 }] })
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
    const prs = await prsPorProyecto(client, 'POS')
    expect([...prs.POS!.entries()]).toEqual([
      ['ORD-POS-002', { url: 'https://github.com/jlpulido107-bit/PROJECT-OS/pull/3', number: 3, fusionMs: null }],
      ['ORD-POS-001', { url: 'https://github.com/jlpulido107-bit/PROJECT-OS/pull/1', number: 1, fusionMs: Date.parse('2026-10-21T10:00:00Z') }],
    ])
    // Caché: una segunda carga no vuelve a pedir la lista.
    await prsPorProyecto(client, 'POS')
    expect(llamadas.filter((p) => p.endsWith('/pulls'))).toHaveLength(1)

    const ordenes = [orden('ORD-POS-001', 'CERRADA'), orden('ORD-POS-002', 'PR_ABIERTO'), orden('ORD-POS-005', 'BORRADOR')]
    const audit = await vista([lanzar('corregir', 'ORD-POS-001', '2026-10-20T10:00:00-06:00', 'k1')])
    const eventos = eventosOrdenes(ordenes, audit)
    const base = ordenesDelFiltro(ordenes, eventos, TODO)
    const dictamenes = await dictamenesDeOrdenes(client, base.estado === 'ok' ? base.datos.ordenes : [], prs)
    expect(dictamenesPorOrden(base, eventos, prs, dictamenes)).toEqual({ estado: 'ok', datos: {
      filas: [
        { ordenId: 'ORD-POS-002', prUrl: 'https://github.com/jlpulido107-bit/PROJECT-OS/pull/3', rondas: 0, conforme: 0, cambios: 0 },
        { ordenId: 'ORD-POS-001', prUrl: 'https://github.com/jlpulido107-bit/PROJECT-OS/pull/1', rondas: 1, conforme: 1, cambios: 1 },
      ],
      totalConforme: 1, totalCambios: 1, sinLeer: 0, rondasSinDatos: false,
    } })
  })

  it('PR sin leer: «sin datos» en su fila y fuera de los totales; sin AUDITORIA, rondas sin datos', async () => {
    const { client } = github({ fallaComentarios: true })
    const prs = await prsPorProyecto(client, null)
    const ordenes = [orden('ORD-POS-001', 'CERRADA'), orden('ORD-POS-002', 'PR_ABIERTO')]
    const base = ordenesDelFiltro(ordenes, null, TODO)
    const d = dictamenesPorOrden(base, null, prs, await dictamenesDeOrdenes(client, ordenes, prs))
    expect(d).toMatchObject({ datos: { totalConforme: 1, totalCambios: 1, sinLeer: 1, rondasSinDatos: true } })
    expect(d.estado === 'ok' && d.datos.filas[0]).toEqual({ ordenId: 'ORD-POS-002', prUrl: 'https://github.com/jlpulido107-bit/PROJECT-OS/pull/3', rondas: null, conforme: null, cambios: null })
  })

  it('GitHub caído o sin token: «sin datos»', async () => {
    const { client } = github({ fallaPrs: true })
    const prs = await prsPorProyecto(client, 'POS')
    expect(prs).toEqual({ POS: null })
    const base = ordenesDelFiltro([orden('ORD-POS-001', 'CERRADA')], null, TODO)
    expect(dictamenesPorOrden(base, null, prs, new Map())).toEqual({ estado: 'sin-datos', motivo: 'Ninguna orden del filtro tiene un PR detectado en GitHub.' })
    expect(dictamenesPorOrden(base, null, null, null)).toEqual({ estado: 'sin-datos', motivo: 'Sin datos de GitHub: los dictámenes viven en los PRs.' })
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
    movId, mes, proyecto, tipo: 'Gasto', categoria: 'Herramientas', concepto, productoId: null, centavos: pesos * 100, ajusteDe: null, ...extra,
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
    const ordenes = [orden('ORD-POS-001', 'CERRADA', 'MEDIO')]
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
    expect(h).toContain('Cerrada: 1')
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
