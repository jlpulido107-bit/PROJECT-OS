import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VistaInicio, type DatosInicio } from '@/components/inicio/inicio'
import { conteoOrdenes, ordenesDelFiltro } from '@/lib/agentes'
import { githubDeAgentes, limpiarCacheAgentes } from '@/lib/agentes-data'
import { construirFinanzas } from '@/lib/finanzas/finanzas'
import {
  esDelPropietario, finanzasInicio, marcaDe, misPendientes, parseFiltroInicio, proyectosInicio, recurrentesSinConfirmar,
  type FuentesPendientes,
} from '@/lib/inicio'
import type { GitHubClient, PrFusion } from '@/lib/operations/github'
import { TAB_HEADERS, type TabName } from '@/lib/schema'
import { buildDataset } from '@/lib/table'
import type { RawTabs } from '@/lib/types'

/** Inicio del dashboard (ORD-POS-090): cálculos con datos sintéticos; GitHub simulado, sin red. */

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

const tarea = (id: string, proyecto: string, hito: string, estado: string, extra: Row = {}): Row => ({
  TAREA_ID: id, PROYECTO_ID: proyecto, HITO_ID: hito, TITULO: `Tarea ${id}`, ESTADO: estado, RESPONSABLE: 'Usuario', ...extra,
})
const orden = (id: string, estado: string, extra: Row = {}): Row => ({
  ORDEN_ID: id, PROYECTO_ID: id.slice(4, 7), TAREA_ID: 'POS-026', TITULO: `Orden ${id}`, RIESGO: 'BAJO', ESTADO: estado, ...extra,
})

const FILAS: Partial<Record<TabName, Row[]>> = {
  PROYECTOS: [{ PROYECTO_ID: 'POS', NOMBRE: 'Sistema A' }, { PROYECTO_ID: 'SIG', NOMBRE: 'Sistema B' }],
  HITOS: [
    { HITO_ID: 'POS-H1', PROYECTO_ID: 'POS', NOMBRE: 'Meta próxima', FECHA_OBJETIVO: '2026-10-31', ESTADO: 'PENDIENTE' },
    { HITO_ID: 'POS-H2', PROYECTO_ID: 'POS', NOMBRE: 'Meta lejana', FECHA_OBJETIVO: '2026-11-14', ESTADO: 'PENDIENTE' },
    { HITO_ID: 'POS-H0', PROYECTO_ID: 'POS', NOMBRE: 'Meta vencida', FECHA_OBJETIVO: '2026-10-20', ESTADO: 'EN_PROGRESO' },
    { HITO_ID: 'POS-HC', PROYECTO_ID: 'POS', NOMBRE: 'Meta hecha', FECHA_OBJETIVO: '2026-10-01', ESTADO: 'COMPLETADO' },
    { HITO_ID: 'SIG-H1', PROYECTO_ID: 'SIG', NOMBRE: 'Sin fecha', FECHA_OBJETIVO: '', ESTADO: 'PENDIENTE' },
  ],
  TAREAS: [
    tarea('POS-001', 'POS', 'POS-H1', 'COMPLETADO'),
    tarea('POS-002', 'POS', 'POS-H1', 'PENDIENTE'),
    tarea('POS-003', 'POS', 'POS-H1', 'CANCELADO'),
    tarea('POS-004', 'POS', '', 'PENDIENTE', { FECHA_LIMITE: '2026-10-20' }),
    tarea('POS-005', 'POS', '', 'PENDIENTE', { FECHA_LIMITE: '2026-10-28', RESPONSABLE: 'Claude' }),
    tarea('POS-006', 'POS', '', 'PENDIENTE', { FECHA_LIMITE: '2026-11-30' }),
    tarea('POS-007', 'POS', '', 'COMPLETADO', { FECHA_LIMITE: '2026-10-01' }),
    tarea('SIG-001', 'SIG', '', 'EN_PROGRESO', { FECHA_LIMITE: '2026-10-30', RESPONSABLE: '' }),
  ],
  ORDENES_CODEX: [
    orden('ORD-POS-001', 'REVISADA', { ISSUE_URL: 'https://github.com/jlpulido107-bit/PROJECT-OS/issues/1', PR_URL: 'https://github.com/jlpulido107-bit/PROJECT-OS/pull/2' }),
    orden('ORD-POS-002', 'ENVIADA'),
    orden('ORD-POS-003', 'ENVIADA'),
    orden('ORD-SIG-001', 'ENVIADA'),
    orden('ORD-POS-004', 'PR_ABIERTO'),
  ],
  DECISIONES: [
    { DECISION_ID: 'DEC-POS-1', PROYECTO_ID: 'POS', ASUNTO: 'Asunto uno', ESTADO: 'PENDIENTE' },
    { DECISION_ID: 'DEC-POS-2', PROYECTO_ID: 'POS', ASUNTO: 'Asunto dos', ESTADO: 'APROBADA' },
    { DECISION_ID: 'DEC-SIG-1', PROYECTO_ID: 'SIG', ASUNTO: 'Asunto tres', ESTADO: 'PENDIENTE' },
  ],
}

const ds = (sin: TabName[] = []) => buildDataset(tabs(FILAS, sin), { source: 'fixtures', fetchedAt: NOW })

const ENC = ['MOV_ID', 'FECHA', 'PROYECTO', 'TIPO', 'CATEGORIA', 'CONCEPTO', 'PRODUCTO_ID', 'MONTO_MXN', 'MONEDA_ORIG', 'MONTO_ORIG', 'TIPO_CAMBIO', 'IVA_MXN', 'FUENTE', 'COMPROBANTE', 'AJUSTE_DE']
const mov = (id: string, fecha: string, proyecto: string, tipo: string, categoria: string, concepto: string, monto: number, fuente: string) =>
  [id, fecha, proyecto, tipo, categoria, concepto, '', monto, '', '', '', '', fuente, 'sí', '']
const RAW_FINANZAS = {
  MOVIMIENTOS: [
    ENC,
    mov('MAN-0001', '2026-10-05', 'POS', 'Gasto', 'Marketing', 'Anuncio', 100, 'manual'),
    mov('MAN-0002', '2026-10-06', 'ECO', 'Gasto', 'Herramientas', 'Keepa', 250, 'manual'),
    mov('MAN-0003', '2026-10-07', 'ECO', 'Ingreso', 'Ventas', 'Venta', 999, 'manual'),
    mov('REC-CLAUDE-2026-09', '2026-09-01', 'POS', 'Gasto', 'Herramientas', 'Suscripción Claude', 370, 'recurrente'),
  ],
  PARAMETROS: [['PARAMETRO', 'VALOR'], ['CAPITAL_TOPE_MXN', 8000], ['MES_INICIO', '2026-07']],
  RECURRENTES: [
    ['ID', 'CONCEPTO', 'PROYECTO', 'CATEGORIA', 'MONTO', 'MONEDA', 'DIA_COBRO', 'DESDE', 'HASTA'],
    ['CLAUDE', 'Suscripción Claude', 'POS', 'Herramientas', 20, 'USD', 1, '2026-09', ''],
  ],
}
const VISTA = construirFinanzas(RAW_FINANZAS, NOW)
const MOTIVO = 'FINANZAS no está configurado en este despliegue (sin FINANZAS_SHEET_ID).'

const pr = (n: number): PrFusion => ({ url: `https://github.com/jlpulido107-bit/PROJECT-OS/pull/${n}`, number: n, fusionMs: null })
const FUENTES: FuentesPendientes = {
  prs: { POS: new Map([['ORD-POS-002', pr(10)], ['ORD-POS-004', pr(11)]]), SIG: null, ECO: new Map() },
  recurrentes: recurrentesSinConfirmar(VISTA, MOTIVO),
}

describe('filtro y marcas', () => {
  it('filtro por proyecto: solo los cinco proyectos; lo demás es «todos»', () => {
    expect(parseFiltroInicio({ proyecto: 'pos' })).toBe('POS')
    expect(parseFiltroInicio({ proyecto: 'ALI' })).toBe('ALI')
    expect(parseFiltroInicio({ proyecto: 'XYZ' })).toBeNull()
    expect(parseFiltroInicio({ proyecto: ['POS', 'SIG'] })).toBeNull()
    expect(parseFiltroInicio({})).toBeNull()
  })

  it('vencido antes de hoy; próximo de hoy a 7 días; después, sin marca', () => {
    expect([marcaDe(-1), marcaDe(0), marcaDe(7), marcaDe(8)]).toEqual(['vencido', 'proximo', 'proximo', null])
  })
})

describe('bloque Proyectos (criterio 2)', () => {
  it('hitos abiertos con fecha y avance completadas/total, sin canceladas, del que vence antes al último', () => {
    const r = proyectosInicio(ds(), HOY, null)
    expect(r.estado).toBe('ok')
    if (r.estado !== 'ok') return
    expect(r.datos.map((p) => p.proyecto)).toEqual(['POS', 'SIG', 'ECO', 'DEV', 'ALI'])
    const pos = r.datos[0]!
    expect(pos.nombre).toBe('Sistema A')
    expect(pos.hitos.map((h) => [h.id, h.marca, h.dias])).toEqual([['POS-H0', 'vencido', -5], ['POS-H1', 'proximo', 6], ['POS-H2', null, 20]])
    expect(pos.hitos[1]).toMatchObject({ completadas: 1, total: 2 })
    expect(r.datos[1]!.hitos).toEqual([]) // SIG-H1 no tiene fecha
  })

  it('con filtro, solo ese proyecto; sin HITOS o sin TAREAS, «sin datos»', () => {
    const r = proyectosInicio(ds(), HOY, 'SIG')
    expect(r.estado === 'ok' && r.datos.map((p) => p.proyecto)).toEqual(['SIG'])
    expect(proyectosInicio(ds(['HITOS']), HOY, null)).toEqual({ estado: 'sin-datos', motivo: 'La pestaña HITOS no está disponible.' })
    expect(proyectosInicio(ds(['TAREAS']), HOY, null).estado).toBe('sin-datos')
  })
})

describe('bloque Mis pendientes (criterio 3)', () => {
  it('tareas del propietario vencidas o que vencen en 7 días; las de un agente, cerradas o lejanas no', () => {
    const p = misPendientes(ds(), HOY, null, FUENTES)
    expect(p.tareas.estado === 'ok' && p.tareas.datos.map((t) => [t.tarea.id, t.marca])).toEqual([['POS-004', 'vencido'], ['SIG-001', 'proximo']])
    expect(esDelPropietario({ responsable: 'Claude Code' })).toBe(false)
    expect(esDelPropietario({ responsable: null })).toBe(true)
  })

  it('órdenes REVISADA, ENVIADA con PR detectado sin registrar y decisiones PENDIENTE', () => {
    const p = misPendientes(ds(), HOY, null, FUENTES)
    expect(p.revisadas.estado === 'ok' && p.revisadas.datos.map((o) => o.id)).toEqual(['ORD-POS-001'])
    expect(p.prSinRegistrar).toEqual({
      estado: 'ok',
      datos: { lista: [{ orden: expect.objectContaining({ id: 'ORD-POS-002' }), prUrl: pr(10).url }], sinDatos: ['SIG'] },
    })
    expect(p.decisiones.estado === 'ok' && p.decisiones.datos.map((d) => d.id)).toEqual(['DEC-POS-1', 'DEC-SIG-1'])
  })

  it('recurrentes del mes sin confirmar de FINANZAS', () => {
    const p = misPendientes(ds(), HOY, null, FUENTES)
    expect(p.recurrentes.estado === 'ok' && p.recurrentes.datos.map((r) => r.movId)).toEqual(['REC-CLAUDE-2026-10'])
  })

  it('el filtro por proyecto se aplica a cada lista', () => {
    const p = misPendientes(ds(), HOY, 'SIG', FUENTES)
    expect(p.tareas.estado === 'ok' && p.tareas.datos.map((t) => t.tarea.id)).toEqual(['SIG-001'])
    expect(p.revisadas).toEqual({ estado: 'ok', datos: [] })
    expect(p.decisiones.estado === 'ok' && p.decisiones.datos.map((d) => d.id)).toEqual(['DEC-SIG-1'])
    // La única ENVIADA de SIG no tiene GitHub legible: no se sabe, no es «ninguna».
    expect(p.prSinRegistrar.estado).toBe('sin-datos')
    expect(p.recurrentes).toEqual({ estado: 'sin-datos', motivo: 'FINANZAS solo registra ECO y POS.' })
  })

  it('sin fuente, cada lista dice «sin datos» y no inventa ceros (criterio 7)', () => {
    const p = misPendientes(ds(['TAREAS', 'ORDENES_CODEX', 'DECISIONES']), HOY, null, { prs: null, recurrentes: recurrentesSinConfirmar(null, MOTIVO) })
    for (const lista of [p.tareas, p.revisadas, p.prSinRegistrar, p.decisiones, p.recurrentes]) expect(lista.estado).toBe('sin-datos')
    expect(p.recurrentes).toEqual({ estado: 'sin-datos', motivo: MOTIVO })
    const sinToken = misPendientes(ds(), HOY, null, { ...FUENTES, prs: null })
    expect(sinToken.prSinRegistrar).toEqual({ estado: 'sin-datos', motivo: 'Sin token de GitHub en este servidor: no se detectan PRs.' })
  })
})

describe('bloque Finanzas (criterio 4)', () => {
  it('gasto del mes (sin ingresos), capital contra el tope y Claude como su recurrente', () => {
    const f = finanzasInicio(VISTA, MOTIVO, NOW, null)
    expect(f.estado).toBe('ok')
    if (f.estado !== 'ok') return
    expect(f.datos.mes).toBe('2026-10')
    expect(f.datos.gastoMes).toEqual({ estado: 'ok', datos: 35000 })
    expect(f.datos.capital).toEqual({ estado: 'ok', datos: { usadoCentavos: 72000, topeCentavos: 800000, pct: 9, alerta: null } })
    expect(f.datos.claude).toEqual({ estado: 'ok', datos: { registradoCentavos: null, pendiente: expect.objectContaining({ movId: 'REC-CLAUDE-2026-10', atrasado: false }) } })
  })

  it('Claude registrado en el mes cuenta como registrado y ya no está pendiente', () => {
    const raw = { ...RAW_FINANZAS, MOVIMIENTOS: [...RAW_FINANZAS.MOVIMIENTOS, mov('REC-CLAUDE-2026-10', '2026-10-01', 'POS', 'Gasto', 'Herramientas', 'Suscripción Claude', 380, 'recurrente')] }
    const f = finanzasInicio(construirFinanzas(raw, NOW), MOTIVO, NOW, null)
    expect(f.estado === 'ok' && f.datos.claude).toEqual({ estado: 'ok', datos: { registradoCentavos: 38000, pendiente: null } })
  })

  it('con filtro: gasto de ese proyecto; fuera de ECO y POS, «sin datos»', () => {
    const pos = finanzasInicio(VISTA, MOTIVO, NOW, 'POS')
    expect(pos.estado === 'ok' && pos.datos.gastoMes).toEqual({ estado: 'ok', datos: 10000 })
    const eco = finanzasInicio(VISTA, MOTIVO, NOW, 'ECO')
    expect(eco.estado === 'ok' && eco.datos.claude.estado).toBe('sin-datos')
    expect(finanzasInicio(VISTA, MOTIVO, NOW, 'SIG')).toEqual({ estado: 'sin-datos', motivo: 'FINANZAS solo registra ECO y POS.' })
  })

  it('sin FINANZAS_SHEET_ID dice «sin datos» con el motivo; sin MOVIMIENTOS, cada dato también', () => {
    expect(finanzasInicio(null, MOTIVO, NOW, null)).toEqual({ estado: 'sin-datos', motivo: MOTIVO })
    const f = finanzasInicio(construirFinanzas({ PARAMETROS: RAW_FINANZAS.PARAMETROS }, NOW), MOTIVO, NOW, null)
    expect(f.estado === 'ok' && [f.datos.gastoMes.estado, f.datos.capital.estado, f.datos.claude.estado]).toEqual(['sin-datos', 'sin-datos', 'sin-datos'])
  })
})

describe('solo lectura y GitHub con la caché de /agentes (criterio 6)', () => {
  beforeEach(() => limpiarCacheAgentes())

  it('el inicio solo pide las listas de PRs (una por repositorio y en caché), nunca dictámenes', async () => {
    const prsDeOrdenes = vi.fn(async () => ({ prs: new Map<string, PrFusion>(), truncado: false }))
    const client = new Proxy({ prsDeOrdenes } as unknown as GitHubClient, {
      get: (t, k) => (k in t ? t[k as keyof GitHubClient] : () => { throw new Error(`llamada no esperada: ${String(k)}`) }),
    })
    await githubDeAgentes(client, null, null)
    await githubDeAgentes(client, null, null)
    expect(prsDeOrdenes).toHaveBeenCalledTimes(3)
  })

  it('la página no importa ninguna vía de escritura', () => {
    const src = readFileSync(path.join(__dirname, '..', 'src', 'app', '(private)', 'page.tsx'), 'utf8')
    // ORD-POS-122: las listas de PRs (sin órdenes) y los dictámenes del propietario van en githubDeInicio, con el mismo cliente.
    const esperando = readFileSync(path.join(__dirname, '..', 'src', 'lib', 'esperando.ts'), 'utf8')
    expect(src).toMatch(/githubDeInicio\(client, filtro, data\.ordenes, propietario\)/)
    expect(esperando).toMatch(/githubDeAgentes\(client, filtro, null\)/)
    expect(src).toMatch(/githubClient\(process\.env, \{ maxLlamadas: LLAMADAS_AGENTES \}\)/)
    for (const s of [src, esperando]) expect(s).not.toMatch(/operationsService|escritura|auditTable|'use server'|method: 'POST'/)
  })
})

describe('render del inicio (criterios 1, 5 y 7)', () => {
  const datos = (filtro: DatosInicio['filtro'], vista: typeof VISTA | null, sin: TabName[] = [], fuentes = FUENTES): DatosInicio => {
    const d = ds(sin)
    return {
      filtro,
      proyectos: proyectosInicio(d, HOY, filtro),
      pendientes: misPendientes(d, HOY, filtro, fuentes),
      finanzas: finanzasInicio(vista, MOTIVO, NOW, filtro),
      ordenes: conteoOrdenes(ordenesDelFiltro(d.ordenes, null, { proyecto: filtro, desde: null, hasta: null })),
    }
  }
  const html = (d: DatosInicio) => renderToStaticMarkup(createElement(VistaInicio, { d }))

  it('cuatro bloques con enlaces a cada vista y el filtro por proyecto', () => {
    const h = html(datos(null, VISTA))
    for (const t of ['Proyectos', 'Mis pendientes', 'Finanzas', 'Agentes']) expect(h).toContain(`>${t}</h2>`)
    for (const href of ['/estado#proyecto-POS', '/tareas?q=POS-004', '/ordenes#tu-turno', '/finanzas#recurrentes', '/agentes', '/proyectos/POS', 'https://github.com/jlpulido107-bit/PROJECT-OS/pull/10', 'https://github.com/jlpulido107-bit/PROJECT-OS/issues/1']) {
      expect(h).toContain(`href="${href.replace(/&/g, '&amp;')}"`)
    }
    expect(h).toContain('name="proyecto"')
    expect(h).toContain('Vencido')
    expect(h).toContain('1/2 tareas completadas')
    expect(h).toContain('$350.00')
    expect(html(datos('POS', VISTA))).toContain('href="/agentes?proyecto=POS"')
  })

  it('sin fuentes, cada bloque dice «Sin datos» y no pinta ceros', () => {
    const h = html(datos(null, null, ['HITOS', 'TAREAS', 'ORDENES_CODEX', 'DECISIONES'], { prs: null, recurrentes: recurrentesSinConfirmar(null, MOTIVO) }))
    expect(h.match(/Sin datos/g)?.length).toBeGreaterThanOrEqual(8)
    expect(h).toContain(MOTIVO)
    expect(h).not.toContain('$0.00')
  })
})
