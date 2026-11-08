import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { EcoResult } from '@/lib/radaros/data'
import { construirEco, type EcoRaw } from '@/lib/radaros/eco'
import {
  CORRIDAS_EXTRAS, CORRIDAS_VISIBLES, TENDENCIAS_EXTRAS, TENDENCIAS_VISIBLES, UNIT_EXTRAS, UNIT_VISIBLES,
} from '@/lib/radaros/eco-columnas'
import { COL_EXTRA, guardarEleccion, leerEleccion, PREFIJO_CLAVE } from '@/components/mas-columnas'

/** ORD-POS-152: /eco con tablas cortas, motor en una línea y lo secundario plegado abajo. Sin red. */
const estado = vi.hoisted(() => ({ result: null as unknown }))
vi.mock('@/lib/page-data', () => ({ privateEco: async () => ({ user: { email: 'lector@example.com' }, result: estado.result }) }))
vi.mock('@/components/operations/write-access', () => ({ writeAccess: () => ({ allowed: false }) }))

const { default: EcoPage } = await import('@/app/(private)/eco/page')

const NOW = Date.UTC(2026, 10, 2, 15)

async function render(raw: EcoRaw, search: Record<string, string> = {}) {
  estado.result = { estado: 'ok', vista: construirEco(raw, NOW), fetchedAt: NOW } satisfies EcoResult
  return renderToStaticMarkup(await EcoPage({ searchParams: Promise.resolve(search) }))
}

const CORRIDAS = [
  ['CORRIDA_ID', 'SEMANA', 'MARKETPLACE', 'INICIO', 'FIN', 'ESTADO', 'IDEAS', 'ASINS_OK', 'ASINS_FALTAN', 'KEEPA_TOKENS_CONSUMIDOS', 'KEEPA_TOKENS_RESTANTES', 'SPAPI_LLAMADAS', 'MENSAJE'],
  ['2026-W45|MX|1', '2026-W45', 'MX', '2026-11-02 06:00:00', '2026-11-02 06:04:00', 'OK', '3', '9', '0', '42', '1180', '12', ''],
]
const UNIT = [
  ['IDEA_ID', 'AMZ_ASIN_REF', 'AMZ_PRECIO_MXN', 'AMZ_PRECIO_MXN_AVG90', 'AMZ_COMISION_MXN', 'AMZ_COMISION_PCT', 'AMZ_FBA_MXN', 'AMZ_OTRAS_TARIFAS_MXN', 'AMZ_TARIFAS_FECHA'],
  ['EC-006', 'B0SINTETICO', '329', '341', '49.35', '0.15', '71.2', '0', '2026-11-01'],
]
const TRENDS = [
  ['KEYWORD', 'SEMANAS_DISTINTAS', 'PRIMERA_SEMANA', 'ULTIMA_SEMANA', 'ESTADO', 'ETIQUETA_PRELIMINAR', 'POSICION_ULTIMA'],
  ['termo', '3', '2026-W40', '2026-W45', 'RECURRENTE', 'A', '4'],
  ['vaso', '1', '2026-W45', '2026-W45', 'UNA_SEMANA', 'B', '9'],
]
const RAW: EcoRaw = { AMZ_CORRIDAS: CORRIDAS, UNIT_ECONOMICS: UNIT, ML_TRENDS_ANALISIS_AUTO: TRENDS }

/** Encabezados de una tabla por su aria-label: [visibles, ocultos hasta «Más columnas»]. */
function encabezados(h: string, label: string): [number, number] {
  const tabla = h.slice(h.indexOf(`aria-label="${label}"`))
  const thead = tabla.slice(0, tabla.indexOf('</thead>'))
  const total = thead.split('<th ').length - 1
  const extras = thead.split(`<th scope="col" class="${COL_EXTRA}">`).length - 1
  return [total - extras, extras]
}

/** Sección de la página entre su id y el siguiente id dado. */
function entre(h: string, desde: string, hasta: string) {
  return h.slice(h.indexOf(`id="${desde}"`), h.indexOf(`id="${hasta}"`))
}

describe('columnas visibles por omisión (criterios 1 a 3)', () => {
  it('constantes: 5 de corridas, 4 de unit economics y 4 de tendencias', () => {
    expect(CORRIDAS_VISIBLES).toEqual(['SEMANA', 'INICIO', 'ESTADO', 'IDEAS', 'MENSAJE'])
    expect(UNIT_VISIBLES).toEqual(['IDEA_ID', 'AMZ_PRECIO_MXN', 'AMZ_COMISION_MXN', 'AMZ_FBA_MXN'])
    expect(TENDENCIAS_VISIBLES).toEqual(['KEYWORD', 'SEMANAS_DISTINTAS', 'ESTADO', 'ETIQUETA_PRELIMINAR'])
  })

  it('cada tabla marca como extra solo lo que va tras «Más columnas»; ninguna columna se pierde', async () => {
    const h = await render(RAW)
    expect(encabezados(h, 'Últimas corridas')).toEqual([CORRIDAS_VISIBLES.length, CORRIDAS_EXTRAS.length])
    expect(encabezados(h, 'Unit economics por idea')).toEqual([UNIT_VISIBLES.length, UNIT_EXTRAS.length])
    expect(encabezados(h, 'Tendencias de Mercado Libre')).toEqual([TENDENCIAS_VISIBLES.length, TENDENCIAS_EXTRAS.length])
    // Las celdas extra de cada fila también llevan la clase (si no, la tabla se descuadra al ocultarlas).
    const fila = h.slice(h.indexOf('title="Corrida 2026-W45|MX|1"'))
    expect(fila.slice(0, fila.indexOf('</tr>')).split(`class="${COL_EXTRA}"`).length - 1).toBe(CORRIDAS_EXTRAS.length)
    expect(h).toContain('B0SINTETICO')
  })

  it('sin JavaScript se ven todas: sin data-cortas ni botón en el HTML del servidor', async () => {
    const h = await render(RAW)
    expect(h.split('class="mas-columnas"').length - 1).toBe(3)
    expect(h).not.toContain('data-cortas')
    expect(h).not.toContain('Más columnas (')
  })
})

describe('motor en una línea y lo secundario plegado (criterios 1, 3 y 4)', () => {
  it('estado, semana, inicio, tokens restantes; corridas plegadas abajo', async () => {
    const h = await render(RAW)
    const motor = entre(h, 'motor', 'ranking')
    expect(motor).toContain('class="motor-linea"')
    expect(motor).toMatch(/badge badge-ok[^>]*>completa</)
    expect(motor).toContain('Semana 2026-W45')
    expect(motor).toContain('Keepa: 1180 tokens restantes')
    expect(motor).not.toContain('<table')
    expect(h.indexOf('id="corridas"')).toBeGreaterThan(h.indexOf('id="tendencias"'))
    expect(h).toMatch(/<details class="section plegable-seccion" id="corridas"><summary><h2>Últimas corridas<\/h2>/)
  })

  it('tendencias plegada sin filtro y abierta con filtro; filtros conservan su botón; candidatos en una línea', async () => {
    const cerrada = await render(RAW)
    expect(cerrada).toMatch(/<details class="section plegable-seccion" id="tendencias"><summary>/)
    const abierta = await render(RAW, { estado: 'UNA_SEMANA' })
    expect(abierta).toMatch(/<details class="section plegable-seccion" id="tendencias" open=""><summary>/)
    expect(abierta).toContain('data-filtro-auto')
    expect(entre(abierta, 'tendencias', 'corridas')).toContain('<button type="submit">Filtrar</button>')
    expect(cerrada).toMatch(/<p class="small muted" id="candidatos"><strong>Candidatos:<\/strong> AMZ_CANDIDATOS: pendiente de V1\.3/)
    expect(cerrada).not.toContain('id="candidatos-titulo"')
  })

  it('unit economics conserva el aviso de estimaciones', async () => {
    const h = await render(RAW)
    expect(entre(h, 'unit-economics', 'candidatos')).toContain('Las tarifas de SP-API son estimaciones no garantizadas.')
  })
})

describe('memoria de «Más columnas» solo en la sesión (criterio 5)', () => {
  function almacen() {
    const m = new Map<string, string>()
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, removeItem: (k: string) => { m.delete(k) }, m }
  }

  it('guarda y lee por tabla; sin elección, columnas cortas', () => {
    const s = almacen()
    expect(leerEleccion(s, 'eco-unit')).toBe(false)
    expect(guardarEleccion(s, 'eco-unit', true)).toBe(true)
    expect(s.m.get(`${PREFIJO_CLAVE}eco-unit`)).toBe('1')
    expect(leerEleccion(s, 'eco-unit')).toBe(true)
    expect(leerEleccion(s, 'eco-tendencias')).toBe(false)
    guardarEleccion(s, 'eco-unit', false)
    expect(leerEleccion(s, 'eco-unit')).toBe(false)
  })

  it('almacenamiento bloqueado o ausente: no lanza', () => {
    const roto = { getItem: () => { throw new Error('bloqueado') }, setItem: () => { throw new Error('bloqueado') }, removeItem: () => { throw new Error('bloqueado') } }
    expect(leerEleccion(roto, 'x')).toBe(false)
    expect(guardarEleccion(roto, 'x', true)).toBe(false)
    expect(leerEleccion(null, 'x')).toBe(false)
    expect(guardarEleccion(null, 'x', true)).toBe(false)
  })
})
