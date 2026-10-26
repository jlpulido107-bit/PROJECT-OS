import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VistaInicio, type DatosInicio } from '@/components/inicio/inicio'
import { TableroInicio } from '@/components/inicio/tablero'
import { conteoOrdenes, ordenesDelFiltro } from '@/lib/agentes'
import { githubDeAgentes, LLAMADAS_AGENTES, limpiarCacheAgentes } from '@/lib/agentes-data'
import {
  accesoAuditoria, auditoriaCompartida, limpiarCacheAuditoria, MOTIVO_ESCRITURA_INACTIVA, MOTIVO_FALLO, MOTIVO_NO_ESCRITOR,
} from '@/lib/auditoria'
import { construirFinanzas, gastoClaudeDiario, leerMovimientos } from '@/lib/finanzas/finanzas'
import { finanzasInicio, misPendientes, proyectosInicio } from '@/lib/inicio'
import {
  abiertasEn, actividadPorDia, MOTIVO_G2, MOTIVO_T6_AGENTE, MOTIVO_T6_PESTANA, tablero, tarjetaAbiertas, tarjetaConforme, tarjetaFusionadas, tarjetaGastoClaude,
  tarjetaHitos, ventanas, type FuenteAuditoria, type FuenteEventos, type FuenteFinanzas, type FuentesTablero,
} from '@/lib/inicio-tablero'
import { eventosOrdenes } from '@/lib/metricas'
import { WRITE_HEADERS } from '@/lib/operations/constants'
import { createGitHubClient, REPOSITORIOS, type PrFusion } from '@/lib/operations/github'
import { InMemoryTableStore, readView } from '@/lib/operations/table-store'
import { TAB_HEADERS, type TabName } from '@/lib/schema'
import { buildDataset } from '@/lib/table'
import type { RawTabs } from '@/lib/types'

/** Tablero de Inicio v2 (ORD-POS-096): datos sintéticos, AUDITORIA en memoria y GitHub simulado, sin red. */

const NOW = Date.UTC(2026, 9, 25, 18, 0, 0) // domingo 25, 12:00 en Mérida
const HOY = '2026-10-25'

type Row = Record<string, string>

function tabs(rows: Partial<Record<TabName, Row[]>>, sin: TabName[] = []): RawTabs {
  const raw: RawTabs = {}
  for (const tab of Object.keys(TAB_HEADERS) as TabName[]) {
    if (sin.includes(tab)) continue
    const headers = TAB_HEADERS[tab] as readonly string[]
    raw[tab] = [[...headers], ...(rows[tab] ?? []).map((r) => headers.map((h) => r[h] ?? ''))]
  }
  return raw
}

const orden = (id: string, estado: string): Row => ({
  ORDEN_ID: id, PROYECTO_ID: id.slice(4, 7), TAREA_ID: 'POS-031', TITULO: `Orden ${id}`, RIESGO: 'BAJO', ESTADO: estado,
})

const FILAS: Partial<Record<TabName, Row[]>> = {
  PROYECTOS: [{ PROYECTO_ID: 'POS', NOMBRE: 'Sistema A' }],
  HITOS: [
    { HITO_ID: 'POS-H0', PROYECTO_ID: 'POS', NOMBRE: 'Vencido', FECHA_OBJETIVO: '2026-10-20', ESTADO: 'EN_PROGRESO' },
    { HITO_ID: 'POS-H1', PROYECTO_ID: 'POS', NOMBRE: 'Próximo', FECHA_OBJETIVO: '2026-10-31', ESTADO: 'PENDIENTE' },
    { HITO_ID: 'POS-H2', PROYECTO_ID: 'POS', NOMBRE: 'Lejano', FECHA_OBJETIVO: '2026-11-14', ESTADO: 'PENDIENTE' },
  ],
  TAREAS: [{ TAREA_ID: 'POS-001', PROYECTO_ID: 'POS', HITO_ID: 'POS-H1', TITULO: 't', ESTADO: 'PENDIENTE', RESPONSABLE: 'Usuario' }],
  ORDENES_CODEX: [
    orden('ORD-POS-001', 'ENVIADA'), // creada antes de AUDITORIA: abierta hace 7 días
    orden('ORD-POS-002', 'BORRADOR'), // alta hace 2 días: no estaba abierta
    orden('ORD-POS-003', 'CERRADA'), // cerrada hace 3 días: estaba abierta
    orden('ORD-POS-004', 'CANCELADA'), // cancelada hace 2 días: estaba abierta
    orden('ORD-POS-005', 'CERRADA'), // cerrada sin AUDITORIA: ya cerrada
    orden('ORD-POS-006', 'CERRADA'), // cerrada hace 10 días con una ronda
    orden('ORD-SIG-001', 'REVISADA'),
  ],
  DECISIONES: [{ DECISION_ID: 'DEC-POS-1', PROYECTO_ID: 'POS', ASUNTO: 'a', ESTADO: 'PENDIENTE' }],
}
const ds = (sin: TabName[] = []) => buildDataset(tabs(FILAS, sin), { source: 'fixtures', fetchedAt: NOW })

let req = 0
/** Filas de AUDITORIA de una operación del dashboard (mismo formato que OperationsService.auditFirst). */
function op(operacion: string, entidad: string, id: string, fecha: string, campos: Record<string, [string, string]>): string[][] {
  req++
  const requestId = `00000000-0000-4000-8000-${String(req).padStart(12, '0')}`
  const origen = `dashboard-v1.4;modo=sheets;op=${operacion};req=${requestId};h=${'a'.repeat(16)}`
  const entries = Object.entries(campos)
  const total = String(entries.length).padStart(2, '0')
  return entries.map(([campo, [antes, despues]], i) => [
    `AUD-20261019100000-${req.toString(16).toUpperCase().padStart(4, '0')}-${String(i + 1).padStart(2, '0')}-${total}`,
    fecha, 'actor@example.com', entidad, id, campo, antes, despues, origen,
  ])
}
const crear = (id: string, fecha: string) => op('orden.crear', 'ORDENES_CODEX', id, fecha, { ORDEN_ID: ['', id], ESTADO: ['', 'BORRADOR'] })
const cerrar = (id: string, fecha: string) => op('orden.cerrar_fusionado', 'ORDENES_CODEX', id, fecha, { ESTADO: ['REVISADA', 'CERRADA'] })
const cancelar = (id: string, fecha: string) => op('orden.cancelar', 'ORDENES_CODEX', id, fecha, { ESTADO: ['ENVIADA', 'CANCELADA'] })
const corregir = (id: string, fecha: string, clave: string) =>
  op('orden.corregir_lanzar', 'ORDENES_CODEX', id, fecha, { SESION: ['', 'https://claude.ai/code/session_x'], CLAVE: ['', clave] })
const tareaOp = (id: string, fecha: string) => op('tarea.editar', 'TAREAS', id, fecha, { ESTADO: ['PENDIENTE', 'EN_PROGRESO'], VERSION: ['1', '2'] })

const filasAudit = () => [
  crear('ORD-POS-002', '2026-10-23T10:00:00-06:00'),
  crear('ORD-POS-003', '2026-10-01T10:00:00-06:00'), cerrar('ORD-POS-003', '2026-10-22T10:00:00-06:00'),
  crear('ORD-POS-004', '2026-10-02T10:00:00-06:00'), cancelar('ORD-POS-004', '2026-10-23T09:00:00-06:00'),
  crear('ORD-POS-006', '2026-10-03T10:00:00-06:00'), corregir('ORD-POS-006', '2026-10-10T10:00:00-06:00', 'k1'),
  cerrar('ORD-POS-006', '2026-10-15T10:00:00-06:00'),
  tareaOp('POS-001', '2026-10-24T08:00:00-06:00'),
  tareaOp('POS-001', '2026-09-01T08:00:00-06:00'), // fuera de los 28 días
]
const vista = (filas: string[][][]) => readView(new InMemoryTableStore({ AUDITORIA: [[...WRITE_HEADERS.AUDITORIA], ...filas.flat()] }), 'AUDITORIA')

const ENC = ['MOV_ID', 'FECHA', 'PROYECTO', 'TIPO', 'CATEGORIA', 'CONCEPTO', 'PRODUCTO_ID', 'MONTO_MXN', 'MONEDA_ORIG', 'MONTO_ORIG', 'TIPO_CAMBIO', 'IVA_MXN', 'FUENTE', 'COMPROBANTE', 'AJUSTE_DE']
const mov = (id: string, fecha: string, proyecto: string, concepto: string, monto: number, fuente = 'manual', ajusteDe = '') =>
  [id, fecha, proyecto, 'Gasto', 'Herramientas', concepto, '', monto, '', '', '', '', fuente, 'sí', ajusteDe]
const RAW_FINANZAS = {
  MOVIMIENTOS: [
    ENC,
    mov('REC-CLAUDE-2026-10', '2026-10-01', 'POS', 'Suscripción Claude', 380, 'recurrente'),
    mov('MAN-0001', '2026-10-22', 'ECO', 'Claude API', 50),
    mov('MAN-0002', '2026-10-23', 'POS', 'Keepa', 900),
  ],
  PARAMETROS: [['PARAMETRO', 'VALOR'], ['CAPITAL_TOPE_MXN', 8000], ['MES_INICIO', '2026-07']],
}
const FINANZAS: FuenteFinanzas = { estado: 'ok', vista: construirFinanzas(RAW_FINANZAS, NOW) }

const pr = (n: number, fusion: string | null): PrFusion => ({ url: `https://github.com/jlpulido107-bit/PROJECT-OS/pull/${n}`, number: n, fusionMs: fusion ? Date.parse(fusion) : null })
const GH = {
  prs: {
    POS: new Map([['ORD-POS-003', pr(3, '2026-10-22T16:00:00Z')], ['ORD-POS-006', pr(6, '2026-10-15T16:00:00Z')], ['ORD-POS-001', pr(1, null)]]),
    SIG: null,
    ECO: new Map([['ORD-ECO-001', pr(9, '2026-10-24T16:00:00Z')]]),
  },
  truncados: ['ECO'],
}

async function fuentes(over: Partial<FuentesTablero & { audit: FuenteAuditoria }> = {}): Promise<FuentesTablero & { audit: FuenteAuditoria }> {
  const d = over.ds ?? ds()
  const audit: FuenteAuditoria = over.audit ?? { estado: 'ok', datos: await vista(filasAudit()) }
  const eventos: FuenteEventos = audit.estado === 'ok' ? { estado: 'ok', datos: eventosOrdenes(d.ordenes, audit.datos) } : audit
  return { ds: d, hoy: HOY, now: NOW, filtro: null, proyectos: proyectosInicio(d, HOY, null), eventos, gh: GH, finanzas: FINANZAS, agenteFinanzas: true, audit, ...over }
}

describe('criterio 3: canceladaMs en eventosOrdenes y fecha en Movimiento', () => {
  it('canceladaMs: la última cancelación auditada, solo si la orden sigue CANCELADA', async () => {
    const audit = await vista(filasAudit())
    const ev = new Map(eventosOrdenes(ds().ordenes, audit).map((e) => [e.id, e]))
    expect(ev.get('ORD-POS-004')!.canceladaMs).toBe(Date.parse('2026-10-23T09:00:00-06:00'))
    expect(ev.get('ORD-POS-003')!.canceladaMs).toBeNull()
    const reabierta = buildDataset(tabs({ ORDENES_CODEX: [orden('ORD-POS-004', 'ENVIADA')] }), { source: 'fixtures', fetchedAt: NOW })
    expect(eventosOrdenes(reabierta.ordenes, audit)[0]!.canceladaMs).toBeNull()
  })

  it('Movimiento lleva la FECHA de la fila; el gasto de Claude por día cuenta el ajuste en su propia fecha', () => {
    const l = leerMovimientos([...RAW_FINANZAS.MOVIMIENTOS, mov('MAN-0003', '2026-10-24', 'ECO', 'Ajuste de MAN-0001', -10, 'manual', 'MAN-0001')])
    expect(l.estado).toBe('ok')
    if (l.estado !== 'ok') return
    expect(l.movimientos.map((m) => [m.movId, m.fecha, m.mes])).toEqual([
      ['REC-CLAUDE-2026-10', '2026-10-01', '2026-10'], ['MAN-0001', '2026-10-22', '2026-10'], ['MAN-0002', '2026-10-23', '2026-10'], ['MAN-0003', '2026-10-24', '2026-10'],
    ])
    expect(gastoClaudeDiario(l.movimientos)).toEqual([
      { fecha: '2026-10-01', gasto: { ECO: 0, POS: 38000 } },
      { fecha: '2026-10-22', gasto: { ECO: 5000, POS: 0 } },
      { fecha: '2026-10-24', gasto: { ECO: -1000, POS: 0 } },
    ])
  })
})

describe('criterio 1: tarjetas T1 a T6', () => {
  it('ventanas: los últimos 7 días con hoy y los 7 previos', () => {
    expect(ventanas(HOY)).toEqual({ actual: ['2026-10-19', '2026-10-25'], anterior: ['2026-10-12', '2026-10-18'] })
  })

  it('abiertasEn reconstruye las abiertas de hace 7 días con las reglas de §3.1', async () => {
    const d = ds()
    const pos = d.ordenes.filter((o) => o.id.startsWith('ORD-POS'))
    const eventos = eventosOrdenes(pos, await vista(filasAudit()))
    // 001 (sin alta), 003 (cerrada después), 004 (cancelada después); no 002 (alta después), 005 (sin cierre auditado), 006 (cerrada antes).
    expect(abiertasEn(eventos, pos, NOW - 7 * 86_400_000)).toBe(3)
  })

  it('T1: valor de ORDENES_CODEX y tendencia con AUDITORIA; sin AUDITORIA, tendencia apagada', async () => {
    const f = await fuentes({ filtro: 'POS' })
    expect(tarjetaAbiertas(f.ds, f.eventos, 'POS', NOW)).toEqual({
      estado: 'ok', datos: { valor: 2, detalle: null, notas: [], tendencia: { estado: 'ok', datos: { anterior: 3, diferencia: -1, etiqueta: 'vs hace 7 días' } } },
    })
    const sin = tarjetaAbiertas(f.ds, { estado: 'apagada', motivo: MOTIVO_NO_ESCRITOR }, 'POS', NOW)
    expect(sin.estado === 'ok' && sin.datos.tendencia).toEqual({ estado: 'apagada', motivo: MOTIVO_NO_ESCRITOR })
    expect(tarjetaAbiertas(ds(['ORDENES_CODEX']), f.eventos, null, NOW).estado).toBe('sin-datos')
  })

  it('T2: fusionadas por semana de las listas de PRs; notas de proyecto sin datos y lista parcial; sin token, apagada', () => {
    const t = tarjetaFusionadas(GH, null, HOY)
    expect(t).toEqual({
      estado: 'ok',
      datos: {
        valor: 2, detalle: null, notas: ['Sin datos de SIG: GitHub no respondió.', 'Lista de ECO parcial (límite de paginación).'],
        tendencia: { estado: 'ok', datos: { anterior: 1, diferencia: 1, etiqueta: 'vs semana anterior' } },
      },
    })
    expect(tarjetaFusionadas(null, null, HOY).estado).toBe('apagada')
    expect(tarjetaFusionadas(GH, 'SIG', HOY).estado).toBe('sin-datos')
    expect(tarjetaFusionadas(GH, 'DEV', HOY)).toEqual({ estado: 'sin-datos', motivo: 'DEV no tiene repositorio en GitHub.' })
  })

  it('T3: % sin rondas de las cerradas con fusión confirmada; semana sin cierres, sin datos (ni 0 % ni 100 %)', async () => {
    const f = await fuentes()
    const t = tarjetaConforme(f.ds, f.eventos, null, HOY)
    expect(t.estado === 'ok' && [t.datos.valor, t.datos.detalle, t.datos.tendencia]).toEqual([
      100, 'de 1 cerrada', { estado: 'ok', datos: { anterior: 0, diferencia: 100, etiqueta: 'vs semana anterior' } },
    ])
    expect(tarjetaConforme(f.ds, f.eventos, null, '2026-11-20').estado).toBe('sin-datos')
    expect(tarjetaConforme(f.ds, { estado: 'apagada', motivo: MOTIVO_ESCRITURA_INACTIVA }, null, HOY).estado).toBe('apagada')
  })

  it('T4: vencidos y próximos; la tendencia es sin datos con su motivo', () => {
    const t = tarjetaHitos(proyectosInicio(ds(), HOY, null))
    expect(t.estado === 'ok' && [t.datos.valor, t.datos.detalle, t.datos.tendencia.estado]).toEqual([2, '1 vencido · 1 próximo', 'sin-datos'])
    expect(t.estado === 'ok' && t.datos.tendencia.estado !== 'ok' && t.datos.tendencia.motivo).toMatch(/HITOS no guarda/)
    expect(tarjetaHitos(proyectosInicio(ds(['HITOS']), HOY, null)).estado).toBe('sin-datos')
  })

  it('T5: gasto de Claude del mes con tendencia al mismo día; sin FINANZAS_SHEET_ID, apagada', () => {
    expect(tarjetaGastoClaude(FINANZAS, null, HOY)).toEqual({
      estado: 'ok', datos: { valor: 43000, detalle: '2026-10', notas: [], tendencia: { estado: 'ok', datos: { anterior: 38000, diferencia: 5000, etiqueta: 'vs 2026-10 al 2026-10-18' } } },
    })
    // Hoy − 7 en el mes anterior: compara con ese mes a esa fecha.
    const nov = tarjetaGastoClaude(FINANZAS, null, '2026-11-03')
    expect(nov).toEqual({ estado: 'sin-datos', motivo: 'Sin gasto de Claude registrado en 2026-11.' })
    const conNov: FuenteFinanzas = { estado: 'ok', vista: construirFinanzas({ ...RAW_FINANZAS, MOVIMIENTOS: [...RAW_FINANZAS.MOVIMIENTOS, mov('MAN-0004', '2026-11-02', 'POS', 'Claude', 10)] }, NOW) }
    const t = tarjetaGastoClaude(conNov, null, '2026-11-03')
    expect(t.estado === 'ok' && t.datos.tendencia).toEqual({ estado: 'ok', datos: { anterior: 43000, diferencia: -42000, etiqueta: 'vs 2026-10 al 2026-10-27' } })
    expect(tarjetaGastoClaude({ estado: 'no-configurado' }, null, HOY).estado).toBe('apagada')
    expect(tarjetaGastoClaude({ estado: 'error', motivo: 'No se pudo leer FINANZAS.' }, null, HOY)).toEqual({ estado: 'sin-datos', motivo: 'No se pudo leer FINANZAS.' })
    expect(tarjetaGastoClaude(FINANZAS, 'SIG', HOY).estado).toBe('sin-datos')
    const eco = tarjetaGastoClaude(FINANZAS, 'ECO', HOY)
    expect(eco.estado === 'ok' && eco.datos.valor).toBe(5000)
  })

  it('T6 apagada sin la pestaña RENDIMIENTO_CLAUDE o sin el agente activo; G2 sigue apagada', async () => {
    const t = tablero(await fuentes())
    expect(t.tarjetas.map((x) => x.id)).toEqual(['T1', 'T2', 'T3', 'T4', 'T5', 'T6'])
    expect(t.tarjetas[5]!.estado).toEqual({ estado: 'apagada', motivo: MOTIVO_T6_PESTANA })
    expect(tablero(await fuentes({ agenteFinanzas: false })).tarjetas[5]!.estado).toEqual({ estado: 'apagada', motivo: MOTIVO_T6_AGENTE })
    expect(t.costoPorRol).toEqual({ estado: 'apagada', motivo: MOTIVO_G2 })
  })
})

describe('criterio 2: G1, actividad por día de AUDITORIA', () => {
  it('28 días con hoy, por entidad, solo conteos y con filtro de proyecto', async () => {
    const a = actividadPorDia({ estado: 'ok', datos: await vista(filasAudit()) }, ds(), null, HOY)
    expect(a.estado).toBe('ok')
    if (a.estado !== 'ok') return
    expect(a.datos.dias).toHaveLength(28)
    expect([a.datos.dias[0]!.fecha, a.datos.dias.at(-1)!.fecha]).toEqual(['2026-09-28', HOY])
    expect(a.datos.total).toBe(9) // la operación del 1 de septiembre queda fuera
    expect(a.datos.dias.find((d) => d.fecha === '2026-10-24')!.porEntidad).toEqual({ ORDENES_CODEX: 0, TAREAS: 1, DECISIONES: 0, TIEMPOS: 0 })
    expect(a.datos.dias.find((d) => d.fecha === '2026-10-23')!.total).toBe(2)
    expect(JSON.stringify(a)).not.toMatch(/@/)
    expect(actividadPorDia({ estado: 'ok', datos: await vista(filasAudit()) }, ds(), 'SIG', HOY).estado).toBe('sin-datos')
  })

  it('apagada sin permiso o sin escritura; sin datos si no se leyó o no hay operaciones', async () => {
    expect(actividadPorDia({ estado: 'apagada', motivo: MOTIVO_NO_ESCRITOR }, ds(), null, HOY)).toEqual({ estado: 'apagada', motivo: MOTIVO_NO_ESCRITOR })
    expect(actividadPorDia({ estado: 'sin-datos', motivo: MOTIVO_FALLO }, ds(), null, HOY).estado).toBe('sin-datos')
    expect(actividadPorDia({ estado: 'ok', datos: await vista([]) }, ds(), null, HOY).estado).toBe('sin-datos')
  })
})

describe('criterio 4: caché de AUDITORIA compartida', () => {
  beforeEach(() => limpiarCacheAuditoria())
  const filas = [[...WRITE_HEADERS.AUDITORIA], ...crear('ORD-POS-009', '2026-10-24T10:00:00-06:00')]
  const PERMITIDO = { permitido: true, motivo: '' }
  const deps = (leer: () => Promise<string[][] | null>, ahora = NOW, generacion = 0) => ({ leer, ahora, ttlMs: 60_000, generacion })

  it('lee una vez, sirve de la caché hasta que vence o cambia la generación de escrituras', async () => {
    const leer = vi.fn(async () => filas)
    const r1 = await auditoriaCompartida(PERMITIDO, deps(leer))
    expect(r1.estado === 'ok' && r1.datos.rows.length).toBe(2)
    await auditoriaCompartida(PERMITIDO, deps(leer, NOW + 59_999))
    expect(leer).toHaveBeenCalledTimes(1)
    await auditoriaCompartida(PERMITIDO, deps(leer, NOW + 60_000))
    expect(leer).toHaveBeenCalledTimes(2)
    await auditoriaCompartida(PERMITIDO, deps(leer, NOW + 60_001, 1))
    expect(leer).toHaveBeenCalledTimes(3)
  })

  it('un fallo no se guarda y es «sin datos»; sin escritura activa, apagada', async () => {
    const falla = vi.fn(async (): Promise<string[][]> => { throw new Error('403') })
    expect(await auditoriaCompartida(PERMITIDO, deps(falla))).toEqual({ estado: 'sin-datos', motivo: MOTIVO_FALLO })
    const leer = vi.fn(async () => filas)
    expect((await auditoriaCompartida(PERMITIDO, deps(leer))).estado).toBe('ok')
    expect(leer).toHaveBeenCalledTimes(1)
    limpiarCacheAuditoria()
    expect(await auditoriaCompartida(PERMITIDO, deps(async () => null))).toEqual({ estado: 'apagada', motivo: MOTIVO_ESCRITURA_INACTIVA })
  })

  it('prueba negativa (H2): un lector no escritor nunca dispara la lectura ni recibe datos de la caché caliente', async () => {
    const leer = vi.fn(async () => filas)
    expect((await auditoriaCompartida(PERMITIDO, deps(leer))).estado).toBe('ok')
    const delLector = vi.fn(async () => filas)
    const env = {
      PROJECT_OS_WRITE_MODE: 'mock', DASHBOARD_DATA_SOURCE: 'fixtures',
      AUTH_ALLOWED_EMAILS: 'escritor@example.com,lector@example.com', AUTH_WRITER_EMAILS: 'escritor@example.com',
    } as unknown as NodeJS.ProcessEnv
    expect(accesoAuditoria('escritor@example.com', env)).toEqual({ permitido: true, motivo: '' })
    expect(accesoAuditoria('escritor@example.com', { ...env, PROJECT_OS_WRITE_MODE: 'disabled' })).toEqual({ permitido: false, motivo: MOTIVO_ESCRITURA_INACTIVA })
    const acceso = accesoAuditoria('lector@example.com', env)
    expect(acceso).toEqual({ permitido: false, motivo: MOTIVO_NO_ESCRITOR })
    const r = await auditoriaCompartida(acceso, deps(delLector))
    expect(r).toEqual({ estado: 'apagada', motivo: MOTIVO_NO_ESCRITOR })
    expect('datos' in r).toBe(false)
    expect(delLector).not.toHaveBeenCalled()
    expect(leer).toHaveBeenCalledTimes(1)
  })
})

describe('criterio 5: llamadas a GitHub por carga de Inicio', () => {
  beforeEach(() => limpiarCacheAgentes())

  /** GitHub con 5 páginas llenas de PRs por repositorio: el peor caso de hoy (1 /user + 5 páginas × 3 repositorios). */
  function github() {
    const llamadas: string[] = []
    const fetchImpl = (async (url: string) => {
      const u = new URL(url)
      llamadas.push(u.pathname)
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
      if (u.pathname === '/user') return json({ login: 'yo' })
      const repo = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(u.pathname)?.[1]
      const p = Object.keys(REPOSITORIOS).find((k) => REPOSITORIOS[k] === repo)
      if (!p) return new Response('{}', { status: 404 })
      const page = Number(u.searchParams.get('page'))
      return json(Array.from({ length: 100 }, (_, i) => {
        const n = (page - 1) * 100 + i + 1
        return { number: n, title: `[ORD-${p}-${String(n).padStart(3, '0')}][X] t`, html_url: `https://github.com/${repo}/pull/${n}`, merged_at: '2026-10-24T16:00:00Z', user: { login: 'yo' }, head: { repo: { full_name: repo } } }
      }))
    }) as unknown as typeof fetch
    return { cliente: () => createGitHubClient('token-falso', fetchImpl, { maxLlamadas: LLAMADAS_AGENTES }), llamadas }
  }

  it('caché fría: no pasa de las de hoy (16) y el tablero no suma ninguna; caché caliente: cero', async () => {
    const gh = github()
    const carga = async () => {
      const r = await githubDeAgentes(gh.cliente(), null, null, { ahora: NOW })
      const antes = gh.llamadas.length
      const t = tablero(await fuentes({ gh: r }))
      expect(gh.llamadas.length).toBe(antes)
      return t
    }
    const t = await carga()
    expect(gh.llamadas.length).toBeLessThanOrEqual(1 + 5 * Object.keys(REPOSITORIOS).length)
    expect(gh.llamadas.filter((x) => !x.endsWith('/pulls') && x !== '/user')).toEqual([])
    expect(t.tarjetas[1]!.estado.estado).toBe('ok')
    const frias = gh.llamadas.length
    await carga()
    expect(gh.llamadas.length).toBe(frias)
  })
})

describe('criterio 6: ningún sin-datos o apagada muestra un 0; los bloques de siempre sin cambio', () => {
  const html = (t: Awaited<ReturnType<typeof tablero>>) => renderToStaticMarkup(createElement(TableroInicio, { t }))
  const tarjetaHtml = (h: string, id: string) => new RegExp(`<div[^>]*data-tarjeta="${id}"[^>]*>(.*?)Fuente:`).exec(h)?.[1] ?? ''

  it('fuentes apagadas o vacías: cada tarjeta y gráfica dice su estado y su motivo, sin números', async () => {
    const d = ds(['ORDENES_CODEX', 'HITOS'])
    const t = tablero(await fuentes({
      ds: d, proyectos: proyectosInicio(d, HOY, null), gh: null, finanzas: { estado: 'no-configurado' },
      audit: { estado: 'apagada', motivo: MOTIVO_NO_ESCRITOR }, eventos: { estado: 'apagada', motivo: MOTIVO_NO_ESCRITOR },
    }))
    expect(t.tarjetas.every((x) => x.estado.estado !== 'ok')).toBe(true)
    const h = html(t)
    for (const x of t.tarjetas) {
      const card = tarjetaHtml(h, x.id)
      expect(card, x.id).toMatch(/Sin datos|Fuente apagada/)
      expect(card, x.id).not.toMatch(/stat-value|>0<|>0 %|\$0/)
    }
    expect(h).toMatch(/data-grafica="G1" data-estado="apagada"/)
    expect(h).toMatch(/data-grafica="G2" data-estado="apagada"/)
    expect(h).not.toMatch(/<table/)
  })

  it('con datos: valores, tendencia con signo y la tabla accesible de G1', async () => {
    const h = html(tablero(await fuentes()))
    expect(tarjetaHtml(h, 'T2')).toMatch(/stat-value">2<.*\+1 vs semana anterior \(antes 1\)/)
    expect(tarjetaHtml(h, 'T4')).toMatch(/Tendencia: sin datos/)
    expect(tarjetaHtml(h, 'T5')).toMatch(/\+\$50\.00 vs 2026-10 al 2026-10-18/)
    expect(h).toMatch(/<table aria-label="Operaciones del dashboard por día, últimos 28 días">/)
    expect(h).not.toMatch(/@example\.com/)
  })

  it('VistaInicio con el tablero solo añade su sección: los bloques actuales no cambian', async () => {
    const d = ds()
    const datos: DatosInicio = {
      filtro: null,
      proyectos: proyectosInicio(d, HOY, null),
      pendientes: misPendientes(d, HOY, null, { prs: GH.prs, recurrentes: { motivo: 'x' } }),
      finanzas: finanzasInicio(null, 'x', NOW, null),
      ordenes: conteoOrdenes(ordenesDelFiltro(d.ordenes, null, { proyecto: null, desde: null, hasta: null })),
    }
    const sin = renderToStaticMarkup(createElement(VistaInicio, { d: datos }))
    const con = renderToStaticMarkup(createElement(VistaInicio, { d: datos, tablero: createElement(TableroInicio, { t: tablero(await fuentes()) }) }))
    expect(con).toContain('id="tablero"')
    expect(con.replace(/<section[^>]*id="tablero">.*?<\/section>/, '')).toBe(sin)
  })
})
