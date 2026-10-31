import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { BloqueEsperando } from '@/components/inicio/esperando'
import { VistaInicio, type DatosInicio } from '@/components/inicio/inicio'
import { limpiarCacheAgentes, LLAMADAS_AGENTES } from '@/lib/agentes-data'
import {
  esperandoPorTi, githubDeInicio, leerListos, MOTIVO_F5, MOTIVO_NO_LEIDO, MOTIVO_NO_PROPIETARIO, MOTIVO_SIN_GITHUB, type FuentesEsperando,
} from '@/lib/esperando'
import { misPendientes } from '@/lib/inicio'
import { limpiarCacheDictamenes } from '@/lib/operations/dictamenes'
import { createGitHubClient } from '@/lib/operations/github'
import { TAB_HEADERS, type TabName } from '@/lib/schema'
import { extraerCriterios } from '@/lib/supervision/criterios'
import { MARCA_DICTAMEN } from '@/lib/supervision/dictamen'
import { buildDataset } from '@/lib/table'
import type { Orden, RawTabs } from '@/lib/types'

/** «Esperando por ti» de Inicio (ORD-POS-122, diseño de Planificación v2 §6 y §7). Datos sintéticos; GitHub simulado. */

const ME = 'jlpulido107-bit'
const REPO = 'jlpulido107-bit/PROJECT-OS'
const HEAD = 'a'.repeat(40)
const CRITERIOS = '1. Uno\n2. Dos'
const HOY = '2026-10-31'
const NOW = Date.UTC(2026, 9, 31, 18, 0, 0)
const crit = extraerCriterios(CRITERIOS)
if (!crit.ok) throw new Error('criterios de prueba inválidos')

const orden = (id: string, estado: string, pr: number | null = null, extra: Partial<Orden> = {}): Orden => ({
  id, proyectoId: id.slice(4, 7), tareaId: 'POS-040', titulo: `Orden ${id}`, objetivo: null, contexto: null, criterios: CRITERIOS,
  fueraDeAlcance: null, comoProbar: null, riesgo: 'BAJO', sensible: null, estado, issueUrl: null,
  prUrl: pr === null ? null : `https://github.com/${REPO}/pull/${pr}`, notas: null, actualizadoEn: null, ...extra,
})

/** Dictamen v1 (como en agentes.test.ts): en BAJO, un CONFORME del head actual basta para REVISADA. */
const reporte = (ordenId: string, pr: number, extra: Record<string, unknown> = {}) => ({
  versionContrato: '1', versionPolitica: 'DEC-POS-008', ordenId, tareaId: 'POS-040', proyectoId: 'POS',
  repo: REPO, issue: 9, pr, headSha: HEAD, baseSha: 'b'.repeat(40), hashCriterios: crit.hashCriterios,
  revisionId: `REV-${ordenId}-1`, ejecucionId: `EJE-${ordenId}-1`, intento: 1, ronda: 0,
  autorizacion: { otorgadaPor: 'propietario', orden: ordenId, desde: '2026-10-17' },
  limiteConsumo: { presupuesto: '1 USD', tiempoMaximo: '30 min' },
  criterios: [{ id: '1', resultado: 'CUMPLE', evidencia: 'ok' }, { id: '2', resultado: 'CUMPLE', evidencia: 'ok' }],
  evidencia: { propias: [{ comando: 'npm test', sha: HEAD, codigoSalida: 0 }], ci: { estado: 'EXITO', ejecucion: 'r1', sha: HEAD }, autor: [] },
  hallazgos: [], veredicto: 'CONFORME', ...extra,
})
const comentario = (r: unknown) => ({ id: 1, body: `${MARCA_DICTAMEN}\n\n\`\`\`json\n${JSON.stringify(r)}\n\`\`\``, user: { login: ME } })

/**
 * GitHub simulado: `listas` PRs [ORD-POS-n] en la lista del repositorio (n = 1..listas); los comentarios del PR n salen
 * de `comentarios`. `cuelga` deja sin responder las rutas que casan.
 */
function github({ listas = 0, comentarios = {} as Record<number, unknown[]>, cuelga }: { listas?: number; comentarios?: Record<number, unknown[]>; cuelga?: RegExp } = {}) {
  const llamadas: string[] = []
  const fetchImpl = (async (url: string) => {
    const u = new URL(url)
    llamadas.push(u.pathname)
    if (cuelga?.test(u.pathname)) return new Promise<Response>(() => {})
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
    if (u.pathname === '/user') return json({ login: ME })
    if (u.pathname === `/repos/${REPO}/pulls`) {
      return json(Number(u.searchParams.get('page')) > 1 ? [] : Array.from({ length: listas }, (_, i) => ({
        number: i + 1, title: `[ORD-POS-${String(i + 1).padStart(3, '0')}][POS-040] t`, html_url: `https://github.com/${REPO}/pull/${i + 1}`,
        merged_at: null, user: { login: ME }, head: { repo: { full_name: REPO } },
      })))
    }
    const pr = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(u.pathname)
    if (pr) return json({ head: { sha: HEAD } })
    const com = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/.exec(u.pathname)
    if (com) return json(comentarios[Number(com[1])] ?? [])
    if (/^\/repos\/jlpulido107-bit\/(SIGSAH|RADAROS)\/pulls$/.test(u.pathname)) return json([])
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
  return { cliente: () => createGitHubClient('token-falso', fetchImpl, { maxLlamadas: LLAMADAS_AGENTES }), llamadas }
}

type Row = Record<string, string>
function dataset(rows: Partial<Record<TabName, Row[]>>) {
  const raw: RawTabs = {}
  for (const tab of Object.keys(TAB_HEADERS) as TabName[]) {
    const headers = TAB_HEADERS[tab] as readonly string[]
    raw[tab] = [[...headers], ...(rows[tab] ?? []).map((r) => headers.map((h) => r[h] ?? ''))]
  }
  return buildDataset(raw, { source: 'fixtures', fetchedAt: NOW })
}

const DS = dataset({
  TAREAS: [
    { TAREA_ID: 'POS-901', PROYECTO_ID: 'POS', TITULO: 'Renovar el token', ESTADO: 'PENDIENTE', RESPONSABLE: 'Usuario', FECHA_LIMITE: '2026-10-31' },
    { TAREA_ID: 'POS-902', PROYECTO_ID: 'POS', TITULO: 'Probar el corte', ESTADO: 'PENDIENTE', RESPONSABLE: 'Usuario', FECHA_LIMITE: '2026-10-28' },
    { TAREA_ID: 'POS-903', PROYECTO_ID: 'POS', TITULO: 'Revisar la semana', ESTADO: 'PENDIENTE', RESPONSABLE: 'Usuario', FECHA_LIMITE: '2026-11-04' },
    { TAREA_ID: 'SIG-901', PROYECTO_ID: 'SIG', TITULO: 'Tarea de SIGSAH', ESTADO: 'PENDIENTE', RESPONSABLE: 'Usuario', FECHA_LIMITE: '2026-10-30' },
  ],
  DECISIONES: [
    { DECISION_ID: 'DEC-POS-901', PROYECTO_ID: 'POS', ASUNTO: 'Fuente de Desplegada', ESTADO: 'PENDIENTE' },
    { DECISION_ID: 'DEC-SIG-901', PROYECTO_ID: 'SIG', ASUNTO: 'Texto pendiente', ESTADO: 'PENDIENTE' },
    { DECISION_ID: 'DEC-POS-902', PROYECTO_ID: 'POS', ASUNTO: 'Ya decidida', ESTADO: 'APROBADA' },
  ],
})

const fuentes = (ordenes: Orden[], extra: Partial<FuentesEsperando> = {}): FuentesEsperando => {
  const filtro = extra.filtro ?? null
  const ds = { ...DS, ordenes }
  return {
    propietario: true, ordenes, ordenesOk: true, filtro,
    pendientes: misPendientes(ds, HOY, filtro, { prs: null, recurrentes: [] }), listos: { evaluaciones: new Map(), vencido: false }, ...extra,
  }
}

beforeEach(() => { limpiarCacheDictamenes(); limpiarCacheAgentes() })

describe('criterio 1: «Listos para fusionar» con REVISADA y PR_ABIERTO con CONFORME en el head actual', () => {
  it('lee el dictamen con dictamenDeOrden: entra el CONFORME del head actual, no el de otro head ni el CAMBIOS', async () => {
    const gh = github({ comentarios: {
      1: [comentario(reporte('ORD-POS-001', 1))],
      2: [comentario(reporte('ORD-POS-002', 2, { headSha: 'c'.repeat(40) }))],
      3: [comentario(reporte('ORD-POS-003', 3, {
        criterios: [{ id: '1', resultado: 'NO_CUMPLE', evidencia: 'x' }, { id: '2', resultado: 'CUMPLE', evidencia: 'ok' }],
        hallazgos: [{ id: 'H1', severidad: 'ALTA', ubicacion: 'a.ts:1', condicion: 'c', impacto: 'i', bloquea: true, justificacion: 'j' }], veredicto: 'CAMBIOS',
      }))],
    } })
    const ordenes = [orden('ORD-POS-001', 'PR_ABIERTO', 1), orden('ORD-POS-002', 'PR_ABIERTO', 2), orden('ORD-POS-003', 'PR_ABIERTO', 3),
      orden('ORD-POS-004', 'REVISADA', 4), orden('ORD-POS-005', 'ENVIADA'), orden('ORD-POS-006', 'CERRADA', 6)]
    const listos = await leerListos(gh.cliente(), ordenes)
    // Solo se leen las PR_ABIERTO: la REVISADA no pide dictamen (DEC-POS-011 ya lo exigió).
    expect([...listos.evaluaciones.keys()].sort()).toEqual(['ORD-POS-001', 'ORD-POS-002', 'ORD-POS-003'])
    expect(gh.llamadas.some((p) => /\/(pulls|issues)\/[46]\b/.test(p))).toBe(false)
    const e = esperandoPorTi(fuentes(ordenes, { listos }))
    expect(e.estado === 'ok' && e.datos.listos).toEqual({ estado: 'ok', datos: {
      lista: [{ orden: ordenes[0], via: 'conforme' }, { orden: ordenes[3], via: 'revisada' }], sinDatos: [], motivoSinDatos: null,
    } })
  })

  it('MEDIO sensible con solo PRIMERO no está listo (falta segundo revisor)', async () => {
    const gh = github({ comentarios: { 1: [comentario(reporte('ORD-POS-001', 1))] } })
    const ordenes = [orden('ORD-POS-001', 'PR_ABIERTO', 1, { riesgo: 'MEDIO', sensible: null })]
    const e = esperandoPorTi(fuentes(ordenes, { listos: await leerListos(gh.cliente(), ordenes) }))
    expect(e.estado === 'ok' && e.datos.listos.estado === 'ok' && e.datos.listos.datos.lista).toEqual([])
  })

  it('con caché fría no pasa del tope LLAMADAS_AGENTES (listas de Inicio + dictámenes); con caché caliente, cero llamadas', async () => {
    const gh = github({ listas: 60 })
    const ordenes = Array.from({ length: 60 }, (_, i) => orden(`ORD-POS-${String(i + 1).padStart(3, '0')}`, 'PR_ABIERTO', i + 1))
    // Lo mismo que la página: un cliente con tope por carga para las listas de PRs y los dictámenes.
    const carga = async () => (await githubDeInicio(gh.cliente(), null, ordenes, true)).listos!
    const r1 = await carga()
    expect(gh.llamadas.length).toBeLessThanOrEqual(LLAMADAS_AGENTES)
    const e1 = esperandoPorTi(fuentes(ordenes, { listos: r1 }))
    // Lo que no cupo queda «sin datos», nunca «no listo».
    const l1 = e1.estado === 'ok' && e1.datos.listos.estado === 'ok' ? e1.datos.listos.datos : null
    expect(l1!.sinDatos.length).toBeGreaterThan(0)
    expect(l1!.motivoSinDatos).toBe(MOTIVO_NO_LEIDO)
    // Las cargas siguientes avanzan con la caché hasta leerlo todo.
    let r = r1
    for (let i = 0; i < 10 && [...r.evaluaciones.values()].filter(Boolean).length < 60; i++) r = await carga()
    expect([...r.evaluaciones.values()].filter(Boolean)).toHaveLength(60)
    const antes = gh.llamadas.length
    const caliente = await carga()
    expect(gh.llamadas.length - antes).toBe(0)
    expect([...caliente.evaluaciones.values()].filter(Boolean)).toHaveLength(60)
  })

  it('otra sesión no lee dictámenes: solo las listas de PRs que Inicio ya leía', async () => {
    const gh = github({ listas: 3 })
    const ordenes = [orden('ORD-POS-001', 'PR_ABIERTO', 1)]
    const { listos } = await githubDeInicio(gh.cliente(), null, ordenes, false)
    expect(listos).toBeNull()
    expect(gh.llamadas.filter((p) => /\/pulls\/\d+$|\/comments$/.test(p))).toEqual([])
  })

  it('respeta el tiempo máximo: lo que no terminó queda «sin datos»', async () => {
    const gh = github({ cuelga: /\/issues\/\d+\/comments$/ })
    const ordenes = [orden('ORD-POS-001', 'PR_ABIERTO', 1), orden('ORD-POS-002', 'REVISADA', 2)]
    const r = await leerListos(gh.cliente(), ordenes, { limiteMs: 30 })
    expect(r.vencido).toBe(true)
    const e = esperandoPorTi(fuentes(ordenes, { listos: r }))
    expect(e.estado === 'ok' && e.datos.listos.estado === 'ok' && e.datos.listos.datos).toMatchObject({
      lista: [{ orden: { id: 'ORD-POS-002' }, via: 'revisada' }], sinDatos: [{ id: 'ORD-POS-001' }], motivoSinDatos: MOTIVO_NO_LEIDO,
    })
    // Sin tiempo restante no se llama a GitHub.
    const otro = github()
    expect((await leerListos(otro.cliente(), ordenes, { limiteMs: 0 })).evaluaciones.size).toBe(0)
    expect(otro.llamadas).toEqual([])
  })

  it('sin token de GitHub: las PR_ABIERTO quedan «sin datos» con su motivo; sin ORDENES_CODEX, el grupo es «sin datos»', () => {
    const ordenes = [orden('ORD-POS-001', 'PR_ABIERTO', 1)]
    const e = esperandoPorTi(fuentes(ordenes, { listos: null }))
    expect(e.estado === 'ok' && e.datos.listos).toMatchObject({ estado: 'ok', datos: { lista: [], motivoSinDatos: MOTIVO_SIN_GITHUB } })
    const sin = esperandoPorTi(fuentes(ordenes, { ordenesOk: false }))
    expect(sin.estado === 'ok' && sin.datos.listos.estado).toBe('sin-datos')
  })
})

describe('criterios 2 y 3: decisiones, vencen hoy y grupos apagados', () => {
  it('6.3 y 6.5 salen de misPendientes; 6.5 solo lo que vence hoy o venció', () => {
    const e = esperandoPorTi(fuentes([]))
    if (e.estado !== 'ok') throw new Error('debía estar ok')
    expect(e.datos.decisiones.estado === 'ok' && e.datos.decisiones.datos.map((d) => d.id)).toEqual(['DEC-POS-901', 'DEC-SIG-901'])
    expect(e.datos.vencenHoy.estado === 'ok' && e.datos.vencenHoy.datos.map((t) => [t.tarea.id, t.dias])).toEqual([
      ['POS-902', -3], ['SIG-901', -1], ['POS-901', 0],
    ])
  })

  it('6.2 y 6.4 están apagadas con el motivo de F5', () => {
    const e = esperandoPorTi(fuentes([]))
    expect(e.estado === 'ok' && [e.datos.fusionadoSinDesplegar, e.datos.banderas]).toEqual([
      { estado: 'apagada', motivo: MOTIVO_F5 }, { estado: 'apagada', motivo: MOTIVO_F5 },
    ])
    expect(MOTIVO_F5).toBe('Falta la fuente; la añade la fase F5.')
  })
})

describe('criterio 4: propietario, contador, filtro y «Mis pendientes»', () => {
  it('otra sesión ve el bloque apagado con el motivo, sin datos', () => {
    const e = esperandoPorTi(fuentes([orden('ORD-POS-004', 'REVISADA', 4)], { propietario: false }))
    expect(e).toEqual({ estado: 'apagada', motivo: MOTIVO_NO_PROPIETARIO })
    const h = renderToStaticMarkup(createElement(BloqueEsperando, { e, filtro: null }))
    expect(h).toContain(MOTIVO_NO_PROPIETARIO)
    expect(h).not.toContain('ORD-POS-004')
  })

  it('el contador suma solo los grupos ok', () => {
    const ordenes = [orden('ORD-POS-004', 'REVISADA', 4)]
    const e = esperandoPorTi(fuentes(ordenes))
    // 1 lista + 2 decisiones + 3 vencen hoy; 6.2 y 6.4 apagadas no cuentan.
    expect(e.estado === 'ok' && [e.datos.contador, e.datos.sinContar]).toEqual([6, 2])
    const sinOrdenes = esperandoPorTi(fuentes(ordenes, { ordenesOk: false }))
    expect(sinOrdenes.estado === 'ok' && [sinOrdenes.datos.contador, sinOrdenes.datos.sinContar]).toEqual([5, 3])
  })

  it('respeta ?proyecto=', () => {
    const ordenes = [orden('ORD-POS-004', 'REVISADA', 4), orden('ORD-SIG-004', 'REVISADA')]
    const e = esperandoPorTi(fuentes(ordenes, { filtro: 'SIG' }))
    if (e.estado !== 'ok') throw new Error('debía estar ok')
    expect(e.datos.listos.estado === 'ok' && e.datos.listos.datos.lista.map((l) => l.orden.id)).toEqual(['ORD-SIG-004'])
    expect(e.datos.decisiones.estado === 'ok' && e.datos.decisiones.datos.map((d) => d.id)).toEqual(['DEC-SIG-901'])
    expect(e.datos.vencenHoy.estado === 'ok' && e.datos.vencenHoy.datos.map((t) => t.tarea.id)).toEqual(['SIG-901'])
    expect(e.datos.contador).toBe(3)
  })

  it('pinta nombre antes que ID, enlaces de acción y los apagados sin nombres de variables ni correos', () => {
    const e = esperandoPorTi(fuentes([orden('ORD-POS-004', 'REVISADA', 4)]))
    const h = renderToStaticMarkup(createElement(BloqueEsperando, { e, filtro: null }))
    expect(h).toContain('Esperando por ti (6)')
    expect(h.indexOf('Orden ORD-POS-004')).toBeLessThan(h.lastIndexOf('ORD-POS-004'))
    expect(h).toContain(`https://github.com/${REPO}/pull/4`)
    expect(h).toContain('Fuente de Desplegada')
    expect(h).toContain('Renovar el token')
    expect(h.match(/Falta la fuente; la añade la fase F5\./g)).toHaveLength(2)
    expect(h).not.toMatch(/TAREAS_CIERRE_PROPIETARIO|TIEMPOS_AGENTE|SEGUNDO_GEMINI|PM_PUEDE|FINANZAS_AGENTE|ECO_PIPELINE|@/)
  })

  it('reemplaza en «Mis pendientes» lo que ya cubre: quedan PRs sin registrar, recurrentes y tareas de 1 a 7 días', () => {
    const ordenes = [orden('ORD-POS-004', 'REVISADA', 4)]
    const f = fuentes(ordenes)
    const d = (cubierto: boolean): DatosInicio => ({
      filtro: null, proyectos: { estado: 'sin-datos', motivo: 'x' }, pendientes: f.pendientes, finanzas: { estado: 'sin-datos', motivo: 'x' },
      ordenes: { estado: 'sin-datos', motivo: 'x' }, cubiertoPorEsperando: cubierto,
    })
    const antes = renderToStaticMarkup(createElement(VistaInicio, { d: d(false) }))
    expect(antes).toContain('Órdenes REVISADA por cerrar')
    expect(antes).toContain('Decisiones PENDIENTE')
    const despues = renderToStaticMarkup(createElement(VistaInicio, { d: d(true) }))
    expect(despues).not.toContain('Órdenes REVISADA por cerrar')
    expect(despues).not.toContain('Decisiones PENDIENTE')
    expect(despues).toContain('Órdenes con PR sin registrar')
    expect(despues).toContain('Recurrentes del mes sin confirmar')
    expect(despues).toContain('Tareas que vencen en los próximos 7 días')
    expect(despues).toContain('POS-903')
    expect(despues).not.toContain('POS-902')
  })
})
