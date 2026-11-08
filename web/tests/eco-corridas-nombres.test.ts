import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { EcoResult } from '@/lib/radaros/data'
import { construirEco, nombresIdeas, normalizarEncabezado, type EcoRaw } from '@/lib/radaros/eco'
import { estadoCorrida, formatearInstante } from '@/lib/radaros/eco-columnas'

/** ORD-POS-135: nombre de cada idea con los encabezados reales de PRODUCTS y tabla «Últimas corridas» legible. Sin red. */
const estado = vi.hoisted(() => ({ result: null as unknown }))
vi.mock('@/lib/page-data', () => ({ privateEco: async () => ({ user: { email: 'lector@example.com' }, result: estado.result }) }))
vi.mock('@/components/operations/write-access', () => ({ writeAccess: () => ({ allowed: false }) }))

const { default: EcoPage } = await import('@/app/(private)/eco/page')
const { default: PipelinePage } = await import('@/app/(private)/eco/pipeline/page')

// Lunes 2026-11-02 09:00 en Mérida (UTC-6).
const NOW = Date.UTC(2026, 10, 2, 15)

async function render(page: typeof EcoPage, raw: EcoRaw, search: Record<string, string> = {}) {
  estado.result = { estado: 'ok', vista: construirEco(raw, NOW), fetchedAt: NOW } satisfies EcoResult
  return renderToStaticMarkup(await page({ searchParams: Promise.resolve(search) }))
}

/** Encabezados del libro real de RADAROS (leídos por el PM el 2026-11-02); los nombres son sintéticos. */
const PRODUCTS_REAL = [
  ['PRODUCT_ID', 'Producto / Idea', 'Otra'],
  ['EC-006', 'Idea sintética seis', 'x'],
  ['EC-012', 'Idea sintética doce', 'y'],
  ['EC-013', 'Idea sintética trece', 'z'],
]

describe('nombresIdeas (criterio 1)', () => {
  it('encabezados reales: PRODUCT_ID y «Producto / Idea»', () => {
    expect(nombresIdeas(PRODUCTS_REAL)).toEqual(new Map([
      ['EC-006', 'Idea sintética seis'], ['EC-012', 'Idea sintética doce'], ['EC-013', 'Idea sintética trece'],
    ]))
  })

  it('la comparación ignora signos, acentos y mayúsculas', () => {
    for (const h of ['Producto / Idea', 'producto-idea', ' PRODUCTO_IDEA ', 'Prodúcto  /  Idea', 'producto idea']) {
      expect(normalizarEncabezado(h)).toBe('PRODUCTO_IDEA')
    }
    expect(normalizarEncabezado('Product-ID')).toBe('PRODUCT_ID')
    expect(nombresIdeas([['product id', 'producto-idea'], ['EC-006', 'Sintética']])).toEqual(new Map([['EC-006', 'Sintética']]))
  })

  it('encabezados anteriores siguen funcionando', () => {
    expect(nombresIdeas([['ID', 'Producto'], ['EC-004', 'Termo']])).toEqual(new Map([['EC-004', 'Termo']]))
    expect(nombresIdeas([['IDEA_ID', 'Nombre'], ['EC-005', 'Vaso']])).toEqual(new Map([['EC-005', 'Vaso']]))
    expect(nombresIdeas([['ID', 'Descripción'], ['EC-007', 'Lámpara']])).toEqual(new Map([['EC-007', 'Lámpara']]))
  })

  it('sin columna de nombre: mapa vacío', () => {
    expect(nombresIdeas([['PRODUCT_ID', 'COLOR'], ['EC-006', 'rojo']]).size).toBe(0)
  })
})

describe('ID · nombre en /eco y /eco/pipeline (criterio 2)', () => {
  const SCORING = [['IDEA_ID', 'PUNTUACION_FINAL', 'AMZ_DEMANDA_BSR_AVG90'], ['EC-006', '80', '100'], ['EC-099', '10', '']]
  const UNIT = [['IDEA_ID', 'AMZ_ASIN_REF'], ['EC-012', 'B000000001']]

  it('/eco: ranking con «nombre · ID» (ORD-POS-151) y unit economics con «ID · nombre»; sin nombre, solo el ID', async () => {
    const h = await render(EcoPage, { SCORING, UNIT_ECONOMICS: UNIT, PRODUCTS: PRODUCTS_REAL })
    expect(h).toContain('<strong>Idea sintética seis</strong> · <span class="small mono">EC-006</span>')
    expect(h).toContain('EC-012 · Idea sintética doce')
    expect(h).toContain('<strong>EC-099</strong>')
    expect(h).not.toContain('EC-099 ·')
  })

  it('/eco/pipeline: la ficha muestra la idea con su nombre; sin nombre, solo el ID', async () => {
    const PIPE_PRODUCTOS = [
      ['PRODUCTO_ID', 'NOMBRE', 'IDEA_ID', 'ETAPA', 'ETAPA_DESDE', 'VERSION'],
      ['PRD-0003', 'Producto sintético', 'EC-006', 'COTIZANDO', '2026-10-20T09:00:00-06:00', '1'],
      ['PRD-0004', 'Otro sintético', 'EC-099', 'SUGERIDO', '2026-10-20T09:00:00-06:00', '1'],
    ]
    const con = await render(PipelinePage, { PIPE_PRODUCTOS, PRODUCTS: PRODUCTS_REAL }, { producto: 'PRD-0003' })
    expect(con).toContain('<dt>Idea</dt><dd>EC-006 · Idea sintética seis</dd>')
    const sin = await render(PipelinePage, { PIPE_PRODUCTOS, PRODUCTS: PRODUCTS_REAL }, { producto: 'PRD-0004' })
    expect(sin).toContain('<dt>Idea</dt><dd>EC-099</dd>')
  })
})

describe('Últimas corridas (criterios 3 y 4)', () => {
  const CORRIDAS = [
    ['CORRIDA_ID', 'SEMANA', 'MARKETPLACE', 'INICIO', 'FIN', 'ESTADO', 'IDEAS', 'ASINS_OK', 'ASINS_FALTAN', 'KEEPA_TOKENS_CONSUMIDOS', 'KEEPA_TOKENS_RESTANTES', 'SPAPI_LLAMADAS', 'MENSAJE'],
    ['2026-W45|MX|1', '2026-W45', 'MX', '2026-11-02 06:00:00', '2026-11-02 06:04:00', 'OK', '3', '9', '0', '42', '18', '12', ''],
    ['2026-W45|MX|2', '2026-W45', 'MX', '2026-11-02 07:00:00', '2026-11-02 07:00:05', 'OMITIDA', '', '', '', '', '', '', ''],
    ['2026-W44|MX|1', '2026-W44', 'MX', '2026-10-26 06:00:00', '', 'PARCIAL', '3', '5', '4', '60', '0', '6', 'tope de tokens'],
  ]

  it('encabezados en palabras con ayuda, sin columna CORRIDA_ID; el ID va en la ayuda de la fila', async () => {
    const h = await render(EcoPage, { AMZ_CORRIDAS: CORRIDAS })
    const tabla = h.slice(h.indexOf('aria-label="Últimas corridas"'))
    const thead = tabla.slice(0, tabla.indexOf('</thead>'))
    for (const t of ['Semana', 'Inicio', 'Fin', 'Estado', 'Ideas', 'ASIN con datos', 'ASIN sin datos', 'Tokens de Keepa', 'Llamadas a SP-API', 'Mensaje']) {
      expect(thead).toContain(`<th scope="col">${t} <span title=`)
    }
    expect(thead).not.toContain('CORRIDA_ID')
    expect(thead).not.toContain('<code>')
    expect(tabla).toContain('title="Corrida 2026-W45|MX|1"')
  })

  it('Inicio y Fin en fecha y hora de Mérida', async () => {
    const h = await render(EcoPage, { AMZ_CORRIDAS: CORRIDAS })
    expect(h).toContain(`<td>${formatearInstante('2026-11-02 06:04:00')}</td>`)
    expect(formatearInstante('2026-11-02 06:04:00')).toMatch(/2 nov.* 2026.*06:04/)
    expect(formatearInstante('no es fecha')).toBe('no es fecha')
    expect(formatearInstante('')).toBeNull()
  })

  it('mensaje vacío: «—» sin «sin dato»', async () => {
    const h = await render(EcoPage, { AMZ_CORRIDAS: CORRIDAS })
    const fila = h.slice(h.indexOf('title="Corrida 2026-W45|MX|1"'))
    const celdas = fila.slice(0, fila.indexOf('</tr>')).split('<td>')
    expect(celdas.at(-1)).toBe('<span class="muted">—</span></td>')
    expect(h).toContain('tope de tokens')
  })

  it('estado en palabras, con color y explicación', async () => {
    const h = await render(EcoPage, { AMZ_CORRIDAS: CORRIDAS })
    expect(h).toMatch(/class="badge badge-ok" title="[^"]+">completa</)
    expect(h).toMatch(/class="badge badge-muted" title="[^"]+">omitida: ya hubo una completa esa semana</)
    expect(h).toMatch(/class="badge badge-warn" title="[^"]+">parcial</)
    expect(estadoCorrida('OK')?.texto).toBe('completa')
    expect(estadoCorrida('omitida')?.texto).toBe('omitida: ya hubo una completa esa semana')
    for (const e of ['PARCIAL', 'ERROR', 'ERROR_DATOS']) {
      const r = estadoCorrida(e)
      expect(r?.ayuda.length).toBeGreaterThan(20)
      expect(r?.texto).not.toBe(e)
    }
    expect(estadoCorrida('ERROR')?.tono).toBe('danger')
    expect(estadoCorrida('ERROR_DATOS')?.tono).toBe('danger')
    expect(estadoCorrida('RARO')).toMatchObject({ texto: 'RARO', tono: 'neutral' })
    expect(estadoCorrida(null)).toBeNull()
  })
})
