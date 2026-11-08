import { readFileSync } from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EcoResult } from '@/lib/radaros/data'
import { construirEco, type EcoRaw } from '@/lib/radaros/eco'
import { formatearValor } from '@/lib/radaros/eco-columnas'
import {
  anclaIdea, coincideK4, enlaceFichaCompras, etapaDeProducto, filtrarIdeas, hrefFiltros, parseFiltroK4, productosPorIdea,
} from '@/lib/radaros/eco-ideas'
import { COLUMNAS_COTIZACIONES, COLUMNAS_MIGRACION_PROVEEDORES, COLUMNAS_PRODUCTOS, COLUMNAS_PROVEEDORES, type Tarjeta } from '@/lib/radaros/pipeline'
import { mejorCotizacion } from '@/lib/radaros/pipeline-compras'
import { COLUMNAS_MIGRACION_COTIZACIONES, construirTabulador, formatoMxn } from '@/lib/radaros/pipeline-tabulador'
import { detallesDelHash } from '@/components/eco/abrir-idea'
import { siguiente } from '@/components/eco/pestanas-idea'

/**
 * ORD-POS-151 (POS-053): ranking de /eco en un renglón por idea y su detalle al abrirla. Solo presentación: la página
 * no lee nada nuevo ni escribe. Ideas, productos, proveedores y precios inventados; nunca lee Sheets.
 */
const estado = vi.hoisted(() => ({ result: null as unknown }))
vi.mock('@/lib/page-data', () => ({ privateEco: async () => ({ user: { email: 'lector@example.com' }, result: estado.result }) }))
vi.mock('@/components/operations/write-access', () => ({ writeAccess: () => ({ allowed: false }) }))

const { default: EcoPage } = await import('@/app/(private)/eco/page')

// 2026-11-07 12:00 en Mérida.
const NOW = Date.UTC(2026, 10, 7, 18)

type Celda = string | number
const fila = (cols: readonly string[], r: Record<string, Celda>): Celda[] => cols.map((c) => r[c] ?? '')
const PRV = [...COLUMNAS_PROVEEDORES, ...COLUMNAS_MIGRACION_PROVEEDORES]
const COT = [...COLUMNAS_COTIZACIONES, ...COLUMNAS_MIGRACION_COTIZACIONES]

/** SCORING con «Decisión» (con acento, como en el libro real) y las columnas de Trends (K4). */
const SCORING_COLS = ['IDEA_ID', 'PUNTUACION_FINAL', 'AMZ_SEMANA', 'AMZ_ESTADO', 'AMZ_DEMANDA_VENTAS_MES', 'AMZ_COMPETENCIA_RATING',
  'AMZ_TENDENCIA_VENTAS_DELTA90', 'Decisión', 'KW_RAIZ_TRENDS', 'TREND_INTERANUAL', 'K4_MACRO_STATUS', 'TREND_FECHA']
const SCORING = [
  SCORING_COLS,
  ['EC-005', '81', '2026-W45', 'OK', '120', '4.1', '12%', 'RESEARCH', 'termo', '0.9', 'VETO: interanual 0.9 → propuesta KILL', '2026-11-06'],
  ['EC-006', '55', '2026-W45', 'OK', '1500', '4.35', '25%', 'VALIDATE', 'tocadiscos', '1.323', 'APROBADO', '2026-11-06'],
  ['EC-007', '40', '', '', '', '', '', 'KILL', 'lampara', '', 'SIN_DATOS: sin resultados en Trends', '2026-11-06'],
  ['EC-008', '30', '', '', '', '', '', '', 'pino', '1.1', 'ESTACIONAL: pico en nov, dic', '2026-09-01'],
  ['EC-009', '20', '', '', '', '', '', 'RESEARCH', '', '', '', ''],
]

function libro(scoring: unknown[][] = SCORING): EcoRaw {
  return {
    SCORING: scoring,
    PRODUCTS: [['PRODUCT_ID', 'Producto / Idea'], ['EC-006', 'Portavasos sintético'], ['EC-005', 'Termo sintético']],
    UNIT_ECONOMICS: [['IDEA_ID', 'AMZ_PRECIO_MXN', 'AMZ_COMISION_MXN', 'AMZ_COMISION_PCT', 'AMZ_FBA_MXN', 'AMZ_TARIFAS_FECHA'], ['EC-006', '400', '60', '', '83', '2026-11-01']],
    PIPE_PRODUCTOS: [[...COLUMNAS_PRODUCTOS],
      fila(COLUMNAS_PRODUCTOS, { PRODUCTO_ID: 'PRD-0003', NOMBRE: 'Portavasos', IDEA_ID: 'EC-006', ORIGEN: 'MANUAL', ETAPA: 'COTIZANDO', ETAPA_DESDE: '2026-10-29T09:00:00-06:00', VERSION: 1 }),
      fila(COLUMNAS_PRODUCTOS, { PRODUCTO_ID: 'PRD-0004', NOMBRE: 'Pino', IDEA_ID: 'EC-009', ORIGEN: 'MANUAL', ETAPA: 'DESCARTADO', ETAPA_DESDE: '2026-11-06T09:00:00-06:00', VERSION: 2 })],
    PIPE_PROVEEDORES: [PRV, fila(PRV, { PROVEEDOR_ID: 'PRV-0002', NOMBRE: 'Sandes Sintético', CANAL: 'ALIBABA', PAIS: 'CN', ESTADO: 'ACTIVO', CONTACTO: 'contacto-sintetico', VERSION: 1 })],
    PIPE_COTIZACIONES: [COT, fila(COT, {
      COTIZACION_ID: 'COT-0002', PRODUCTO_ID: 'PRD-0003', PROVEEDOR_ID: 'PRV-0002', ESTADO: 'RECIBIDA', FECHA_SOLICITUD: '2026-10-25',
      FECHA_RECIBIDA: '2026-10-30', PRECIO_UNIT: 10.59, MONEDA: 'USD', MOQ: 10, PLAZO_PRODUCCION_DIAS: 15, INCOTERM: 'DDP', MUESTRA_ESTADO: 'NO_PEDIDA',
      PRECIO_POR: 'SET', UNIDADES_POR_SET: 6, CANTIDAD_COTIZADA: 500, TIPO_CAMBIO: 18.5, FLETE_CEDIS: 0, VERSION: 3,
    })],
    PIPE_PARAMETROS: [['CLAVE', 'VALOR'], ['TIPO_CAMBIO_USD_MXN', '18.5'], ['IGI_PCT_CN', '20'], ['DTA_PCT', '0.8'], ['AGENTE_ADUANAL_REF', '3500']],
  }
}

async function html(raw: EcoRaw, search: Record<string, string> = {}, tabulador = true) {
  vi.stubEnv('ECO_TABULADOR', tabulador ? 'true' : '')
  estado.result = { estado: 'ok', vista: construirEco(raw, NOW), fetchedAt: NOW } satisfies EcoResult
  return renderToStaticMarkup(await EcoPage({ searchParams: Promise.resolve(search) }))
}

/** Renglón (`<li>`) de una idea, del `<details>` hasta el cierre de su `<li>`. */
function renglon(h: string, id: string): string {
  const ini = h.lastIndexOf('<li', h.indexOf(`id="idea-${id}"`))
  return ini < 0 || !h.includes(`id="idea-${id}"`) ? '' : h.slice(ini, h.indexOf('</li>', h.indexOf('</details>', ini)) + 5)
}
const resumen = (r: string) => r.slice(r.indexOf('<summary>'), r.indexOf('</summary>'))
const ordenRenglones = (h: string) => [...h.matchAll(/<details id="idea-([^"]+)"/g)].map((m) => m[1])

function ranking(raw: EcoRaw = libro()) {
  const r = construirEco(raw, NOW).ranking
  if (r.estado !== 'ok') throw new Error(r.estado)
  return r.datos
}
function tarjetas(raw: EcoRaw = libro()): Tarjeta[] {
  const p = construirEco(raw, NOW).pipeline.productos
  return p.estado === 'ok' ? p.datos.tarjetas : []
}

afterEach(() => vi.unstubAllEnvs())

describe('funciones puras', () => {
  it('«Decisión» de SCORING por encabezado normalizado; sin la columna, null y aviso', () => {
    const r = ranking()
    expect(r.conColumnaDecision).toBe(true)
    expect(r.ideas.map((i) => [i.id, i.decision])).toEqual([['EC-005', 'RESEARCH'], ['EC-006', 'VALIDATE'], ['EC-007', 'KILL'], ['EC-008', null], ['EC-009', 'RESEARCH']])
    const sin = ranking(libro(SCORING.map((f) => f.filter((_, i) => i !== 7))))
    expect(sin.conColumnaDecision).toBe(false)
    expect(sin.ideas.every((i) => i.decision === null)).toBe(true)
  })

  it('filtro K4: valores válidos o null; «sin datos» incluye SIN_DATOS y sin valor', () => {
    expect(['aprobado', 'estacional', 'veto', 'sin-datos'].map(parseFiltroK4)).toEqual(['aprobado', 'estacional', 'veto', 'sin-datos'])
    for (const x of [undefined, '', 'APROBADO', 'otro', 'todos']) expect(parseFiltroK4(x)).toBeNull()
    const k4 = Object.fromEntries(ranking().ideas.map((i) => [i.id, i.k4]))
    expect(coincideK4(k4['EC-006']!, 'aprobado')).toBe(true)
    expect(coincideK4(k4['EC-006']!, 'veto')).toBe(false)
    expect(coincideK4(k4['EC-007']!, 'sin-datos')).toBe(true)
    expect(coincideK4(null, 'sin-datos')).toBe(true)
    expect(coincideK4(null, 'aprobado')).toBe(false)
    expect(coincideK4(null, null)).toBe(true)
  })

  it('producto por IDEA_ID: el primero no descartado; si todos lo están, el primero', () => {
    const base = tarjetas()
    const t = (id: string, etapa: Tarjeta['etapa']): Tarjeta => ({ ...base[0]!, id, etapa, fila: { ...base[0]!.fila, IDEA_ID: 'EC-001' } })
    expect(productosPorIdea([t('A', 'DESCARTADO'), t('B', 'COTIZANDO'), t('C', 'MUESTRA')]).get('EC-001')!.id).toBe('B')
    expect(productosPorIdea([t('A', 'DESCARTADO'), t('B', 'DESCARTADO')]).get('EC-001')!.id).toBe('A')
    expect([...productosPorIdea(base).keys()]).toEqual(['EC-006', 'EC-009'])
  })

  it('etapa con días, ancla, enlace a la ficha y query de filtros', () => {
    const p = productosPorIdea(tarjetas())
    expect(etapaDeProducto(p.get('EC-006')!)).toBe('Cotizando, 9 días')
    expect(etapaDeProducto(p.get('EC-009')!)).toBe('Descartado, 1 día')
    expect(etapaDeProducto({ ...p.get('EC-006')!, etapa: null, etapaTexto: 'RARA', dias: null })).toBe('Etapa: RARA, días: —')
    expect(anclaIdea('EC-006')).toBe('idea-EC-006')
    expect(enlaceFichaCompras('PRD-0003')).toBe('/eco/pipeline?producto=PRD-0003#ficha-producto')
    expect(hrefFiltros({ k4: null, conProducto: false })).toBe('/eco#ranking')
    expect(hrefFiltros({ k4: 'veto', conProducto: true }, { estado: 'RECURRENTE' })).toBe('/eco?estado=RECURRENTE&k4=veto&compras=1#ranking')
  })

  it('filtros conservan el orden del ranking', () => {
    const r = ranking()
    const p = productosPorIdea(tarjetas())
    expect(filtrarIdeas(r.ideas, { k4: null, conProducto: false }, p).map((i) => i.id)).toEqual(r.ideas.map((i) => i.id))
    expect(filtrarIdeas(r.ideas, { k4: 'sin-datos', conProducto: false }, p).map((i) => i.id)).toEqual(['EC-007', 'EC-009'])
    expect(filtrarIdeas(r.ideas, { k4: null, conProducto: true }, p).map((i) => i.id)).toEqual(['EC-006', 'EC-009'])
  })

  it('pestañas con teclado: flechas circulares, Inicio y Fin; otra tecla no mueve', () => {
    expect(siguiente(0, 5, 'ArrowRight')).toBe(1)
    expect(siguiente(4, 5, 'ArrowRight')).toBe(0)
    expect(siguiente(0, 5, 'ArrowLeft')).toBe(4)
    expect(siguiente(2, 5, 'Home')).toBe(0)
    expect(siguiente(2, 5, 'End')).toBe(4)
    expect(siguiente(2, 5, 'Enter')).toBeNull()
    expect(siguiente(0, 0, 'ArrowRight')).toBeNull()
  })

  it('#idea-<ID> abre solo un <details> de idea; otro hash o un hash mal codificado, nada', () => {
    const details = { tagName: 'DETAILS', id: 'idea-EC-006' }
    const doc = { getElementById: (id: string) => (id === 'idea-EC-006' ? details : id === 'idea-div' ? { tagName: 'DIV' } : null) } as unknown as Document
    expect(detallesDelHash('#idea-EC-006', doc)).toBe(details)
    expect(detallesDelHash('#idea-div', doc)).toBeNull()
    expect(detallesDelHash('#ranking', doc)).toBeNull()
    expect(detallesDelHash('#idea-%E0%A4%A', doc)).toBeNull()
  })
})

describe('/eco: un renglón por idea', () => {
  it('criterios 1 a 3, con producto y tabulador encendido: nombre · ID y semana, puntaje, K4, decisión con etapa, costo contra la mejor', async () => {
    const h = await html(libro())
    const r = renglon(h, 'EC-006')
    const s = resumen(r)
    expect(s).toContain('<strong>Portavasos sintético</strong> · <span class="small mono">EC-006</span>')
    expect(s).toContain('Semana 2026-W45')
    expect(s).toContain('Puntaje</span> 55')
    expect(s).toContain('K4 aprobado')
    expect(s).toContain('Decisión</span> VALIDATE · Cotizando, 9 días')
    // Mismo cálculo que la ficha de Compras: tabulador.comparar + mejorCotizacion.
    const cmp = construirTabulador(libro()).comparar('PRD-0003', 'EC-006')
    const mejor = mejorCotizacion(cmp)!
    expect(cmp.costoMaximo.mxn).toBe(65)
    expect(s).toContain('Máx. <span class="mono">65.00 MXN</span>')
    expect(s).toContain(`Mejor <span class="mono">${formatoMxn(mejor.costo.porSetMxn)} MXN</span>`)
    expect(s).toContain('No cumple por')
    // Enlace a la ficha en Compras, fuera del <summary>.
    expect(r).toContain('href="/eco/pipeline?producto=PRD-0003#ficha-producto"')
    expect(s).not.toContain('<a ')
  })

  it('sin producto: «Sin producto en compras» y costo «—»; un producto descartado sigue enlazado', async () => {
    const h = await html(libro())
    const s = resumen(renglon(h, 'EC-005'))
    expect(s).toContain('Decisión</span> RESEARCH · <span class="muted">Sin producto en compras</span>')
    expect(s).toContain('title="Sin producto en compras">—</span>')
    expect(s).not.toContain('Máx.')
    expect(renglon(h, 'EC-005')).not.toContain('/eco/pipeline?producto=')
    expect(resumen(renglon(h, 'EC-009'))).toContain('RESEARCH · Descartado, 1 día')
    expect(renglon(h, 'EC-009')).toContain('href="/eco/pipeline?producto=PRD-0004#ficha-producto"')
  })

  it('tabulador apagado: «Tabulador apagado» en cada renglón y ningún costo', async () => {
    const h = await html(libro(), {}, false)
    for (const id of ['EC-005', 'EC-006', 'EC-007', 'EC-008', 'EC-009']) expect(resumen(renglon(h, id))).toContain('Tabulador apagado')
    expect(h).not.toContain('Máx.')
    expect(h).not.toContain('65.00 MXN')
  })

  it('K4 en cada estado, con «consulta vencida» y el veto como propuesta; decisión vacía = «—», nunca 0', async () => {
    const h = await html(libro())
    expect(resumen(renglon(h, 'EC-005'))).toContain('K4 veto: propuesta KILL: decide el propietario')
    expect(resumen(renglon(h, 'EC-007'))).toContain('K4 sin datos: sin resultados en Trends')
    expect(resumen(renglon(h, 'EC-008'))).toContain('K4 estacional: pico en nov, dic · consulta vencida')
    expect(resumen(renglon(h, 'EC-009'))).not.toContain('K4')
    expect(resumen(renglon(h, 'EC-008'))).toMatch(/Decisión<\/span> <span class="muted" title="sin dato">/)
  })

  it('el orden de los renglones es el del ranking actual', async () => {
    const h = await html(libro())
    expect(ordenRenglones(h)).toEqual(ranking().ideas.map((i) => i.id))
    expect(ordenRenglones(h)).toEqual(['EC-005', 'EC-006', 'EC-007', 'EC-008', 'EC-009'])
  })

  it('criterio 4: al abrir, pares nombre–valor en Demanda, Competencia, Tendencia, Macro (Trends) y Unit economics; sin desplegables de todas las ideas', async () => {
    const h = await html(libro())
    const r = renglon(h, 'EC-006')
    const titulos = [...r.matchAll(/<h4>([^<]+)<\/h4>/g)].map((m) => m[1])
    expect(titulos).toEqual(['Demanda', 'Competencia', 'Tendencia', 'Macro (Trends)', 'Unit economics'])
    expect(r).toContain(`<dd>${formatearValor('AMZ_DEMANDA_VENTAS_MES', '1500')}</dd>`)
    expect(r).toContain(`<dd>${formatearValor('AMZ_TENDENCIA_VENTAS_DELTA90', '25%')}</dd>`)
    expect(r).toContain(`<dd>${formatearValor('AMZ_PRECIO_MXN', '400')}</dd>`)
    expect(r).toContain('Las tarifas de SP-API son estimaciones no garantizadas.')
    expect(renglon(h, 'EC-005')).toContain('Sin fila en <code>UNIT_ECONOMICS</code> para esta idea.')
    for (const g of ['Demanda', 'Competencia', 'Tendencia', 'Macro (Trends)']) {
      expect(h).not.toContain(`<summary>${g}</summary>`)
      expect(h).not.toContain(`Insumos de ${g}`)
    }
    // Sin columnas de Trends no hay pestaña Macro.
    const sinTrends = await html(libro(SCORING.map((f) => f.slice(0, 8))))
    expect([...renglon(sinTrends, 'EC-006').matchAll(/<h4>([^<]+)<\/h4>/g)].map((m) => m[1])).toEqual(['Demanda', 'Competencia', 'Tendencia', 'Unit economics'])
  })

  it('criterio 5: filtros K4 y «solo con producto en compras», con FiltroAuto, conservando el orden', async () => {
    const form = (h: string) => h.slice(h.indexOf('aria-label="Filtrar ideas"'), h.indexOf('</form>', h.indexOf('aria-label="Filtrar ideas"')))
    const h = await html(libro())
    expect(form(h)).toContain('data-filtro-auto')
    expect(form(h)).toMatch(/<select name="k4"><option value="" selected="">Todos<\/option><option value="aprobado">Aprobado<\/option><option value="estacional">Estacional<\/option><option value="veto">Veto<\/option><option value="sin-datos">Sin datos<\/option><\/select>/)
    expect(form(h)).toContain('<input type="checkbox" name="compras" value="1"/> Solo con producto en compras')
    expect(ordenRenglones(await html(libro(), { k4: 'veto' }))).toEqual(['EC-005'])
    expect(ordenRenglones(await html(libro(), { k4: 'aprobado' }))).toEqual(['EC-006'])
    expect(ordenRenglones(await html(libro(), { k4: 'estacional' }))).toEqual(['EC-008'])
    expect(ordenRenglones(await html(libro(), { k4: 'sin-datos' }))).toEqual(['EC-007', 'EC-009'])
    const con = await html(libro(), { compras: '1' })
    expect(ordenRenglones(con)).toEqual(['EC-006', 'EC-009'])
    expect(con).toContain('Se muestran 2 de 5 ideas.')
    expect(form(con)).toContain('checked=""')
    expect(con).toContain('href="/eco#ranking">Quitar filtros</a>')
    expect(await html(libro(), { k4: 'veto', compras: '1' })).toContain('Ninguna idea con esos filtros.')
    // Un valor inventado se ignora.
    expect(ordenRenglones(await html(libro(), { k4: 'otro' }))).toHaveLength(5)
    // Los filtros de Tendencias conservan los del ranking y al revés.
    const ambos = await html(libro(), { k4: 'veto', estado: 'RECURRENTE' })
    expect(form(ambos)).toContain('<input type="hidden" name="estado" value="RECURRENTE"/>')
  })

  it('cada idea abierta se enlaza con #idea-<ID>', async () => {
    const h = await html(libro())
    for (const id of ['EC-005', 'EC-006', 'EC-009']) expect(h).toContain(`<details id="idea-${id}">`)
  })

  it('teclado y 390 px: <summary> nativo sin controles anidados, enlace aparte, renglón en una columna en pantallas angostas', async () => {
    const h = await html(libro())
    for (const m of h.matchAll(/<summary>([\s\S]*?)<\/summary>/g)) expect(m[1]).not.toMatch(/<(a|button|input|select)\b/)
    expect(h).toMatch(/<a class="small idea-compras" href="[^"]+" aria-label="Ficha en Compras de EC-006 · Portavasos sintético \(PRD-0003\)">/)
    const css = readFileSync(path.join(__dirname, '..', 'src/app/globals.css'), 'utf8')
    const angosto = css.slice(css.indexOf('/* ORD-POS-151'), css.indexOf('@media (max-width: 900px) {\n  .compras-layout'))
    expect(angosto).toMatch(/@media \(max-width: 480px\) \{\s*\.idea-fila \{ grid-template-columns: minmax\(0, 1fr\); \}/)
    expect(angosto).toMatch(/\.idea-nombre \{[^}]*overflow-wrap: anywhere/)
    expect(angosto).toMatch(/min-height: 40px/)
  })

  it('un lector no recibe CONTACTO de proveedores y la página no escribe ni lee pestañas nuevas', async () => {
    const h = await html(libro())
    expect(h).not.toContain('contacto-sintetico')
    const fuentes = ['src/app/(private)/eco/page.tsx', 'src/lib/radaros/eco-ideas.ts', 'src/components/eco/pestanas-idea.tsx', 'src/components/eco/abrir-idea.tsx']
      .map((f) => readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n')
    expect(fuentes).not.toMatch(/method=["']post["']|fetch\(/i)
    expect(fuentes).not.toMatch(/readTabs|ECO_LECTURA/)
  })
})
