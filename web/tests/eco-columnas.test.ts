import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { EcoResult } from '@/lib/radaros/data'
import { construirEco, ECO_TABS, GRUPOS_SCORING, nombresIdeas } from '@/lib/radaros/eco'
import { ayudaColumna, COLUMNAS_ECO, etiquetaIdea, formatearValor, tituloColumna } from '@/lib/radaros/eco-columnas'

/** /eco: nombres de idea, títulos en español, unidades y ayuda (ORD-POS-113). Nunca lee Sheets. */
const estado = vi.hoisted(() => ({ result: null as unknown }))
vi.mock('@/lib/page-data', () => ({ privateEco: async () => ({ user: { email: 'revisor@example.com' }, result: estado.result }) }))

const { default: EcoPage } = await import('@/app/(private)/eco/page')

const NOW = Date.UTC(2026, 9, 28, 15)

async function html(raw: Parameters<typeof construirEco>[0]) {
  estado.result = { estado: 'ok', vista: construirEco(raw, NOW), fetchedAt: NOW } satisfies EcoResult
  return renderToStaticMarkup(await EcoPage({ searchParams: Promise.resolve({}) }))
}

const SCORING = [
  ['IDEA_ID', 'PUNTUACION_FINAL', 'AMZ_DEMANDA_BSR_AVG90', 'AMZ_DEMANDA_VENTAS_MES', 'AMZ_COMPETENCIA_RATING', 'AMZ_TENDENCIA_VENTAS_DELTA90', 'AMZ_X_NUEVA'],
  ['EC-006', '80', '12,345', '1500', '4.35', '25%', 'crudo'],
  ['EC-004', '50', '', 'n/d', '', '', ''],
]
const PRODUCTS = [['ID', 'Producto'], ['EC-006', 'Soporte vinilo acrílico translúcido'], ['EC-004', '']]

describe('nombre de la idea (criterio 1)', () => {
  it('etiqueta «ID · nombre»; sin nombre, solo el ID', () => {
    expect(etiquetaIdea('EC-006', 'Soporte vinilo acrílico translúcido')).toBe('EC-006 · Soporte vinilo acrílico translúcido')
    expect(etiquetaIdea('EC-004', null)).toBe('EC-004')
    expect(etiquetaIdea('EC-004', '')).toBe('EC-004')
  })

  it('PRODUCTS por encabezado, sin distinguir mayúsculas ni acentos, en cualquier orden', () => {
    expect(nombresIdeas(PRODUCTS)).toEqual(new Map([['EC-006', 'Soporte vinilo acrílico translúcido']]))
    expect(nombresIdeas([['Nombre', 'otra', 'idea_id'], ['Termo', 'x', 'EC-009']])).toEqual(new Map([['EC-009', 'Termo']]))
    expect(nombresIdeas([['ID', 'Descripción'], ['EC-005', 'Lámpara']])).toEqual(new Map([['EC-005', 'Lámpara']]))
  })

  it('PRODUCTS entra en la lista fija de pestañas de solo lectura', () => {
    expect(ECO_TABS).toContain('PRODUCTS')
  })

  it('sin pestaña o sin columnas reconocidas: mapa vacío, nunca error', () => {
    expect(nombresIdeas(undefined).size).toBe(0)
    expect(nombresIdeas([]).size).toBe(0)
    expect(nombresIdeas([['ID', 'COLOR'], ['EC-004', 'rojo']]).size).toBe(0)
  })

  it('Ranking y tablas de Demanda, Competencia y Tendencia con nombre; sin nombre, solo el ID', async () => {
    const h = await html({ SCORING, PRODUCTS })
    const v = construirEco({ SCORING, PRODUCTS }, NOW)
    expect(v.ranking.estado === 'ok' && v.ranking.datos.ideas.map((i) => i.nombre)).toEqual(['Soporte vinilo acrílico translúcido', null])
    // Ranking + 3 tablas de insumos.
    expect(h.split('EC-006 · Soporte vinilo acrílico translúcido')).toHaveLength(1 + 1 + Object.keys(GRUPOS_SCORING).length)
    expect(h).not.toContain('EC-004 ·')
    expect(h).toContain('>EC-004</th>')
  })

  it('sin PRODUCTS: las tablas muestran solo el ID', async () => {
    const h = await html({ SCORING })
    expect(h).not.toContain(' · Soporte')
    expect(h).toContain('>EC-006</th>')
  })
})

describe('títulos en español (criterio 2)', () => {
  it('un solo mapa con todas las columnas de Demanda, Competencia y Tendencia', () => {
    for (const col of Object.values(GRUPOS_SCORING).flat()) expect(COLUMNAS_ECO[col]?.titulo, col).toBeTruthy()
    expect(tituloColumna('AMZ_DEMANDA_BSR_AVG90')).toBe('Ranking de ventas, promedio 90 días (menor = vende más)')
    expect(tituloColumna('AMZ_DEMANDA_CAIDAS_BSR_30D')).toBe('Ventas detectadas en 30 días (caídas del ranking)')
    expect(tituloColumna('AMZ_DEMANDA_VENTAS_MES')).toBe('Ventas al mes (unidades, estimado)')
    expect(tituloColumna('AMZ_DEMANDA_RANK_CATEGORIA')).toBe('Posición en su categoría')
  })

  it('un encabezado sin traducción se muestra tal cual', () => {
    expect(tituloColumna('AMZ_X_NUEVA')).toBe('AMZ_X_NUEVA')
    expect(ayudaColumna('AMZ_X_NUEVA')).toBeNull()
  })

  it('el render usa los títulos y no los encabezados AMZ_* traducidos', async () => {
    const h = await html({ SCORING, PRODUCTS })
    expect(h).toContain('Ranking de ventas, promedio 90 días (menor = vende más)')
    expect(h).toContain('Reseñas (número)')
    expect(h).toContain('Cambio de ventas contra 90 días (%)')
    expect(h).not.toContain('<code>AMZ_DEMANDA_BSR_AVG90</code>')
    expect(h).not.toContain('<code>AMZ_COMPETENCIA_RESENAS</code>')
  })
})

describe('formato (criterio 3)', () => {
  it('separador de miles', () => {
    expect(formatearValor('AMZ_DEMANDA_VENTAS_MES', '1500')).toBe('1,500')
    expect(formatearValor('AMZ_DEMANDA_BSR_AVG90', '12,345')).toBe('12,345')
    expect(formatearValor('AMZ_DEMANDA_BSR_AVG90', '1234567')).toBe('1,234,567')
  })

  it('MXN con su signo', () => {
    expect(formatearValor('AMZ_PRECIO_MXN', '$1,499.5')).toBe('$1,499.50')
    expect(formatearValor('AMZ_FBA_MXN', '87')).toBe('$87.00')
  })

  it('porcentaje con %, sin multiplicar', () => {
    expect(formatearValor('AMZ_TENDENCIA_VENTAS_DELTA90', '25%')).toBe('25 %')
    expect(formatearValor('AMZ_TENDENCIA_VENTAS_DELTA90', '-12.5')).toBe('-12.5 %')
  })

  it('decimales y texto', () => {
    expect(formatearValor('AMZ_COMPETENCIA_RATING', '4.35')).toBe('4.35')
    expect(formatearValor('AMZ_TENDENCIA_BSR_30_VS_90', '0,8')).toBe('0.8')
    expect(formatearValor('AMZ_COMPETENCIA_AMAZON_VENDE', 'SI')).toBe('SI')
    expect(formatearValor('AMZ_X_NUEVA', 'crudo')).toBe('crudo')
  })

  it('vacío, columna sin leer o no numérico: sin dato (null)', () => {
    expect(formatearValor('AMZ_DEMANDA_VENTAS_MES', null)).toBeNull()
    expect(formatearValor('AMZ_DEMANDA_VENTAS_MES', 'n/d')).toBeNull()
    expect(formatearValor('AMZ_PRECIO_MXN', '#N/A')).toBeNull()
    expect(formatearValor('AMZ_TENDENCIA_VENTAS_DELTA90', 'mucho%')).toBeNull()
  })

  it('el render pinta «—» con la leyenda «sin dato»', async () => {
    const h = await html({ SCORING, PRODUCTS })
    expect(h).toContain('<span aria-hidden="true">—</span><span class="visually-hidden">sin dato</span>')
    expect(h).toContain('«—» = sin dato.')
    expect(h).toContain('>12,345<')
    expect(h).toContain('>25 %<')
  })
})

describe('ayuda (criterio 4)', () => {
  it('una línea por columna del mapa', () => {
    for (const [col, c] of Object.entries(COLUMNAS_ECO)) {
      expect(c.ayuda, col).toBeTruthy()
      expect(c.ayuda, col).not.toMatch(/[\n<>]/)
    }
  })

  it('ⓘ accesible con title y aria-label, texto escapado', async () => {
    const h = await html({ SCORING, PRODUCTS })
    const ayuda = ayudaColumna('AMZ_DEMANDA_BSR_AVG90')!
    expect(h).toContain(`<span title="${ayuda}" role="img" aria-label="Ayuda: ${ayuda}">ⓘ</span>`)
  })
})
