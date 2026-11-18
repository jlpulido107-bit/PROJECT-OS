import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { render } from '../deploy/cloudrun/render.mjs'
import { decide } from '@/lib/authz'
import { estadoBandera } from '@/lib/banderas'
import { AGENT_OPERATIONS, WRITE_HEADERS, type OperationName } from '@/lib/operations/constants'
import { OperationError } from '@/lib/operations/errors'
import { evaluateWriteRequest } from '@/lib/operations/guard'
import { RateLimiter } from '@/lib/operations/rate-limit'
import { OperationsService, parseAudit } from '@/lib/operations/service'
import { InMemoryTableStore, readView } from '@/lib/operations/table-store'
import { IdeaRapida } from '@/components/eco/idea-rapida'
import { asinDeEnlaceAmazon, tarjetaIdeaRapida } from '@/lib/radaros/idea-amazon'
import {
  ecoIdeasAltaHabilitada, IDEAS_TABS, parseAltaIdea, PRODUCTS_HEADERS, SCORING_HEADERS, type IdeasTab,
} from '@/lib/radaros/ideas-alta'
import { IdeasSheetsStore, InMemoryIdeasStore } from '@/lib/radaros/ideas-alta-store'

/** Alta de ideas en RADAROS por el PM (ORD-POS-131, DEC-ECO-007), con dobles de Sheets: ninguna prueba sale a la red. */

const AUT = 'PAQ-2026-11-01-01 «sí PAQ-2026-11-01-01» 2026-11-01'
let seq = 0
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`
const PM_CTX = { actor: 'agente-pm', agent: true } as const

const productsRow = (n: number) => [`EC-${String(n).padStart(3, '0')}`, `Idea ${n}`, 'Hogar', 'B1', 'Cliente', 'Problema', 'Amazon', 'N1', 'IDEA', 'Media', 250, 3000, 'No', 'Precio', 'Cotizar', 'PM']
const scoringRow = (n: number) => [`EC-${String(n).padStart(3, '0')}`, `Idea ${n}`, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3]

/** Libro sintético: 8 ideas (filas 2 a 9) y fórmulas M a P copiadas hasta la fila 12, como en la hoja real. */
function libro(opts: { formulasHasta?: number; products?: unknown[][]; scoring?: unknown[][] } = {}) {
  const products = opts.products ?? [[...PRODUCTS_HEADERS], ...Array.from({ length: 8 }, (_, i) => productsRow(i + 1))]
  const scoring = opts.scoring ?? [[...SCORING_HEADERS, 'Score', 'Total', 'Rank', 'Nota', 'IDEA_ID'], ...Array.from({ length: 8 }, (_, i) => scoringRow(i + 1))]
  const store = new InMemoryIdeasStore('LIBRO_RADAROS_SINTETICO', { PRODUCTS: products, SCORING: scoring })
  for (let fila = 2; fila <= (opts.formulasHasta ?? 12); fila++) {
    for (const col of [12, 13, 14, 15]) store.formulasHoja.set(`SCORING!${fila}!${col}`, `=IF(A${fila}="","",SUM(C${fila}:L${fila}))`)
  }
  return store
}

function servicio() {
  const store = new InMemoryTableStore({ AUDITORIA: [[...WRITE_HEADERS.AUDITORIA]] })
  return { store, service: new OperationsService(store, { mode: 'sheets' }) }
}

const body = (extra: Record<string, unknown> = {}) => ({
  requestId: uuid(), autorizacion: AUT, producto: 'Organizador de cables', categoria: 'Hogar', precioObservadoMxn: 199.5,
  owner: 'PM', puntajes: { demanda: 4, competencia: 2, marca: 5 }, ...extra,
})

const codeOf = async (p: Promise<unknown>) => {
  const e = await p.then(() => undefined, (x: unknown) => x)
  return e instanceof OperationError ? e.code : e
}

describe('idea.alta: servicio y libro (criterios 1, 3, 4, 5 y 7)', () => {
  it('alta correcta: EC-009 al final de PRODUCTS (A:P) y en la primera fila de SCORING con fórmulas (A:L), auditada como agente-pm', async () => {
    const ideas = libro()
    const antes = ideas.snapshot()
    const { store, service } = servicio()
    const cmd = parseAltaIdea(body())
    const r = await service.altaIdea(cmd, PM_CTX, ideas)
    expect(r).toEqual({ operacion: 'idea.alta', entidad: 'PRODUCTS', id: 'EC-009', repetida: false })

    expect(ideas.escrituras.map((e) => [e.tab, e.fila, e.celdas.length])).toEqual([['PRODUCTS', 10, 16], ['SCORING', 10, 12]])
    const despues = ideas.snapshot()
    expect(despues.PRODUCTS![9]).toEqual(['EC-009', 'Organizador de cables', 'Hogar', '', '', '', '', '', '', '', 199.5, '', '', '', '', 'PM'])
    // SCORING B se copia de PRODUCTS B; los puntajes sin dato quedan vacíos; M a P no se escriben.
    expect(despues.SCORING![9]).toEqual(['EC-009', 'Organizador de cables', 4, 2, '', '', '', '', '', '', '', 5])
    expect((await ideas.formulas('SCORING'))[9]!.slice(12, 16).every((f) => String(f).startsWith('='))).toBe(true)
    expect((await ideas.values('SCORING'))[9]![12]).toBe('calc:EC-009')
    // Filas existentes intactas.
    expect(despues.PRODUCTS!.slice(0, 9)).toEqual(antes.PRODUCTS)
    expect(despues.SCORING!.slice(0, 9)).toEqual(antes.SCORING)

    const audit = await readView(store, 'AUDITORIA')
    const [op] = parseAudit(audit)
    expect(op).toMatchObject({ operacion: 'idea.alta', entidad: 'PRODUCTS', id: 'EC-009', integridad: 'completa' })
    expect(op!.fields.get('AUTORIZACION')?.despues).toBe(AUT)
    expect(op!.fields.get('PRODUCTS!Producto / Idea')?.despues).toBe('Organizador de cables')
    expect(op!.fields.get('SCORING!Marca')?.despues).toBe('5')
    expect(audit.rows.every((row) => row.cells[2] === 'agente-pm' && /;op=idea\.alta;.*;agente=pm$/.test(row.cells[8]!))).toBe(true)
  })

  it('el ID sigue al mayor EC-NNN de la columna A de PRODUCTS, aunque haya huecos', async () => {
    const products = [[...PRODUCTS_HEADERS], productsRow(1), productsRow(7), productsRow(3)]
    const ideas = libro({ products, scoring: [[...SCORING_HEADERS], scoringRow(1), scoringRow(7), scoringRow(3)] })
    const r = await servicio().service.altaIdea(parseAltaIdea(body()), PM_CTX, ideas)
    expect(r.id).toBe('EC-008')
  })

  it('encabezado distinto en PRODUCTS o SCORING: no escribe nada, ni la auditoría, y dice en qué columnas', async () => {
    for (const tab of ['PRODUCTS', 'SCORING'] as IdeasTab[]) {
      const products = [[...PRODUCTS_HEADERS], productsRow(1)]
      const scoring = [[...SCORING_HEADERS], scoringRow(1)]
      ;(tab === 'PRODUCTS' ? products : scoring)[0]![3] = 'Otra'
      const ideas = libro({ products, scoring })
      const { store, service } = servicio()
      const e = await service.altaIdea(parseAltaIdea(body()), PM_CTX, ideas).catch((x: unknown) => x)
      expect(e).toBeInstanceOf(OperationError)
      expect((e as OperationError).code).toBe('idea-encabezados-distintos')
      expect((e as OperationError).detail).toEqual({ [tab]: 'D' })
      expect(ideas.escrituras).toEqual([])
      expect((await store.readTable('AUDITORIA')).length).toBe(1)
    }
  })

  it('fórmulas que no cubren la fila nueva de SCORING: no escribe nada, tampoco en PRODUCTS', async () => {
    const ideas = libro({ formulasHasta: 9 })
    const { store, service } = servicio()
    expect(await codeOf(service.altaIdea(parseAltaIdea(body()), PM_CTX, ideas))).toBe('scoring-sin-formulas')
    expect(ideas.escrituras).toEqual([])
    expect((await store.readTable('AUDITORIA')).length).toBe(1)
    // Una sola fórmula que falte (P) también deja la fila sin cubrir.
    const parcial = libro()
    parcial.formulasHoja.delete('SCORING!10!15')
    expect(await codeOf(servicio().service.altaIdea(parseAltaIdea(body()), PM_CTX, parcial))).toBe('scoring-sin-formulas')
    expect(parcial.escrituras).toEqual([])
  })

  it('la primera fila con PRODUCT_ID vacío pero con otros datos no se pisa', async () => {
    const products = [[...PRODUCTS_HEADERS], productsRow(1), ['', 'nota suelta']]
    const ideas = libro({ products, scoring: [[...SCORING_HEADERS], scoringRow(1)] })
    expect(await codeOf(servicio().service.altaIdea(parseAltaIdea(body()), PM_CTX, ideas))).toBe('idea-fila-ocupada')
    expect(ideas.escrituras).toEqual([])
  })

  it('tras escribir, M sin valor se reporta (idea-sin-calculo)', async () => {
    const ideas = libro()
    ideas.calcular = () => ''
    expect(await codeOf(servicio().service.altaIdea(parseAltaIdea(body()), PM_CTX, ideas))).toBe('idea-sin-calculo')
  })

  it('un ID nuevo que ya está en SCORING (sin PRODUCTS) no se escribe', async () => {
    const ideas = libro({ scoring: [[...SCORING_HEADERS], ...Array.from({ length: 9 }, (_, i) => scoringRow(i + 1))] })
    expect(await codeOf(servicio().service.altaIdea(parseAltaIdea(body()), PM_CTX, ideas))).toBe('conflicto-concurrente')
    expect(ideas.escrituras).toEqual([])
  })

  it('mismo requestId: no duplica; con otros datos, conflicto', async () => {
    const ideas = libro()
    const { service } = servicio()
    const cmd = parseAltaIdea(body())
    await service.altaIdea(cmd, PM_CTX, ideas)
    const otra = await service.altaIdea(cmd, PM_CTX, ideas)
    expect(otra).toMatchObject({ id: 'EC-009', repetida: true })
    expect(ideas.escrituras.length).toBe(2)
    expect(ideas.snapshot().PRODUCTS!.filter((r) => r[0] === 'EC-009').length).toBe(1)
    expect(await codeOf(service.altaIdea({ ...cmd, products: ['Otro', ...cmd.products.slice(1)] }, PM_CTX, ideas))).toBe('conflicto-idempotencia')
  })

  it('escritura a medias (falla SCORING): el mismo requestId completa lo que falta con lo auditado', async () => {
    const ideas = libro()
    const write = ideas.writeRow.bind(ideas)
    let falla = true
    ideas.writeRow = async (tab, fila, celdas) => {
      if (tab === 'SCORING' && falla) { falla = false; throw new Error('HTTP 503') }
      return write(tab, fila, celdas)
    }
    const { service } = servicio()
    const cmd = parseAltaIdea(body())
    expect(await codeOf(service.altaIdea(cmd, PM_CTX, ideas))).toBe('escritura-fallida')
    const r = await service.altaIdea(cmd, PM_CTX, ideas)
    expect(r).toMatchObject({ id: 'EC-009', repetida: true })
    expect(ideas.escrituras.map((e) => [e.tab, e.fila])).toEqual([['PRODUCTS', 10], ['SCORING', 10]])
    expect(ideas.snapshot().SCORING![9]).toEqual(['EC-009', 'Organizador de cables', 4, 2, '', '', '', '', '', '', '', 5])
  })
})

/* ------------------------- ORD-POS-160 (DEC-ECO-017): enlace de Amazon y palabra de búsqueda ------------------------- */

const IDEA_ASIN_H = ['IDEA_ID', 'ASIN', 'ACTIVO', 'PRINCIPAL', 'ORIGEN', 'NOTA', 'ALTA_FECHA']
const NICHO_H = ['ID', 'PALABRA_CLAVE', 'ACTIVO']
const ENLACE = 'https://www.amazon.com.mx/Organizador-Cables-Escritorio/dp/B0ABCD1234/ref=sr_1_3?keywords=organizador'

/** Libro sintético con las dos pestañas AMZ_*: 2 filas del motor en AMZ_IDEA_ASIN y 1 en AMZ_NICHO. */
function libroAmz(opts: { ideaAsin?: unknown[][]; nicho?: unknown[][] } = {}) {
  const store = libro()
  const interno = store as unknown as { data: Map<string, unknown[][]> }
  interno.data.set('AMZ_IDEA_ASIN', opts.ideaAsin ?? [IDEA_ASIN_H, ['EC-001', 'B000000001', 'SI', 'SI', 'MANUAL', '', '2026-11-01'], ['EC-002', 'B000000002', '', '', 'PROPUESTO_KEEPA', '', '2026-11-02']])
  interno.data.set('AMZ_NICHO', opts.nicho ?? [NICHO_H, ['EC-001', 'termo acero', 'SI']])
  return store
}
const amz = (extra: Record<string, unknown> = {}) => body({ enlaceAmazon: ENLACE, palabraClave: 'organizador de cables', ...extra })

describe('idea.alta con enlace de Amazon y palabra de búsqueda (ORD-POS-160, DEC-ECO-017)', () => {
  it('asinDeEnlaceAmazon: solo amazon.com.mx con /dp/ o /gp/product/ y 10 caracteres', () => {
    for (const ok of [
      ENLACE, 'https://amazon.com.mx/dp/B0ABCD1234', 'http://www.amazon.com.mx/gp/product/B0ABCD1234/', ' https://www.amazon.com.mx/dp/B0ABCD1234?th=1 ',
      'https://www.amazon.com.mx/x/dp/B0ABCD1234/ref=a/dp/B0ABCD1234',
    ]) expect(asinDeEnlaceAmazon(ok), ok).toBe('B0ABCD1234')
    for (const mal of [
      'https://www.amazon.com/dp/B0ABCD1234', 'https://www.amazon.es/dp/B0ABCD1234', 'https://a.co/d/abc1234', 'https://amzn.to/3xYzAbC',
      'https://www.amazon.com.mx.evil.example/dp/B0ABCD1234', 'https://amazon.com.mx@evil.example/dp/B0ABCD1234', 'https://evil.example/www.amazon.com.mx/dp/B0ABCD1234',
      'https://www.amazon.com.mx:8443/dp/B0ABCD1234', 'ftp://www.amazon.com.mx/dp/B0ABCD1234', 'javascript:alert(1)//www.amazon.com.mx/dp/B0ABCD1234',
      'https://www.amazon.com.mx/s?k=organizador', 'https://www.amazon.com.mx/?url=/dp/B0ABCD1234', 'https://www.amazon.com.mx/dp/B0ABCD123', 'https://www.amazon.com.mx/dp/B0ABCD12345',
      'https://www.amazon.com.mx/dp/b0abcd1234', 'https://www.amazon.com.mx/dp/B0ABCD-234', 'https://www.amazon.com.mx/xdp/B0ABCD1234',
      'https://www.amazon.com.mx/dp/B0ABCD1234/x/dp/B0ZZZZ9999', 'B0ABCD1234', 'www.amazon.com.mx/dp/B0ABCD1234', '',
    ]) expect(asinDeEnlaceAmazon(mal), mal).toBeNull()
  })

  it('alta correcta: además de PRODUCTS y SCORING, una fila nueva al final de AMZ_IDEA_ASIN y de AMZ_NICHO, auditadas', async () => {
    const ideas = libroAmz()
    const antes = ideas.snapshot()
    const { store, service } = servicio()
    const cmd = parseAltaIdea(amz())
    expect(cmd.amazon).toEqual({ asin: 'B0ABCD1234', palabraClave: 'organizador de cables' })
    const r = await service.altaIdea(cmd, PM_CTX, ideas)
    expect(r).toEqual({ operacion: 'idea.alta', entidad: 'PRODUCTS', id: 'EC-009', repetida: false })

    expect(ideas.escrituras.map((e) => [e.tab, e.fila, e.celdas.length])).toEqual([['PRODUCTS', 10, 16], ['SCORING', 10, 12], ['AMZ_IDEA_ASIN', 4, 7], ['AMZ_NICHO', 3, 3]])
    const despues = ideas.snapshot()
    expect(despues.AMZ_IDEA_ASIN![3]).toEqual(['EC-009', 'B0ABCD1234', 'SI', 'SI', 'POS', '', ''])
    expect(despues.AMZ_NICHO![2]).toEqual(['EC-009', 'organizador de cables', 'SI'])
    // Filas existentes intactas en las cuatro pestañas.
    expect(despues.AMZ_IDEA_ASIN!.slice(0, 3)).toEqual(antes.AMZ_IDEA_ASIN)
    expect(despues.AMZ_NICHO!.slice(0, 2)).toEqual(antes.AMZ_NICHO)
    expect(despues.PRODUCTS!.slice(0, 9)).toEqual(antes.PRODUCTS)
    expect(despues.SCORING!.slice(0, 9)).toEqual(antes.SCORING)

    const [op] = parseAudit(await readView(store, 'AUDITORIA'))
    expect(op).toMatchObject({ operacion: 'idea.alta', entidad: 'PRODUCTS', id: 'EC-009', integridad: 'completa' })
    expect(Object.fromEntries([...op!.fields].filter(([k]) => k.startsWith('AMZ_')).map(([k, v]) => [k, v.despues]))).toEqual({
      'AMZ_IDEA_ASIN!IDEA_ID': 'EC-009', 'AMZ_IDEA_ASIN!ASIN': 'B0ABCD1234', 'AMZ_IDEA_ASIN!ACTIVO': 'SI', 'AMZ_IDEA_ASIN!PRINCIPAL': 'SI',
      'AMZ_IDEA_ASIN!ORIGEN': 'POS', 'AMZ_NICHO!ID': 'EC-009', 'AMZ_NICHO!PALABRA_CLAVE': 'organizador de cables', 'AMZ_NICHO!ACTIVO': 'SI',
    })
    expect(op!.fields.get('AUTORIZACION')?.despues).toBe(AUT)
  })

  it('con `asin` en vez de enlace escribe lo mismo; las columnas se ubican por encabezado aunque cambien de orden o haya otras', async () => {
    const ideas = libroAmz({
      ideaAsin: [['NOTA', 'ORIGEN', 'ASIN', 'IDEA_ID', 'PRINCIPAL', 'ACTIVO', 'ALTA_FECHA', 'EXTRA'], ['', 'MANUAL', 'B000000001', 'EC-001', 'SI', 'SI', '', 'x']],
      nicho: [['ID', 'NOTA', 'ACTIVO', 'PALABRA_CLAVE'], ['EC-001', 'una nota', 'SI', 'termo acero']],
    })
    await servicio().service.altaIdea(parseAltaIdea(body({ asin: 'B0ABCD1234', palabraClave: 'organizador de cables' })), PM_CTX, ideas)
    expect(ideas.snapshot().AMZ_IDEA_ASIN![2]).toEqual(['', 'POS', 'B0ABCD1234', 'EC-009', 'SI', 'SI', '', ''])
    expect(ideas.snapshot().AMZ_NICHO![2]).toEqual(['EC-009', '', 'SI', 'organizador de cables'])
  })

  it('sin enlace ni palabra: el alta de siempre, sin leer ni escribir AMZ_* y con el mismo hash de comando', async () => {
    const ideas = libro() // sin pestañas AMZ_*: leerlas daría error
    const cmd = parseAltaIdea(body())
    expect('amazon' in cmd).toBe(false)
    const { store, service } = servicio()
    await service.altaIdea(cmd, PM_CTX, ideas)
    expect(ideas.escrituras.map((e) => e.tab)).toEqual(['PRODUCTS', 'SCORING'])
    const [op] = parseAudit(await readView(store, 'AUDITORIA'))
    expect([...op!.fields.keys()].some((k) => k.startsWith('AMZ_'))).toBe(false)
  })

  it('enlace inválido o campos incompletos: 422 del validador, antes de leer o escribir nada (criterio 3)', () => {
    const campos = (b: unknown) => {
      try { parseAltaIdea(b); return null } catch (e) { return (e as OperationError).fields }
    }
    for (const enlaceAmazon of ['https://www.amazon.com/dp/B0ABCD1234', 'https://a.co/d/abc1234', 'https://www.amazon.com.mx/s?k=x', 'no es un enlace', 42, 'https://www.amazon.com.mx/dp/B0ABCD1234' + 'x'.repeat(2000)]) {
      expect(campos(amz({ enlaceAmazon })), String(enlaceAmazon).slice(0, 40)).toHaveProperty('enlaceAmazon')
    }
    expect(campos(amz({ palabraClave: undefined }))).toHaveProperty('palabraClave')
    expect(campos(amz({ palabraClave: 'x'.repeat(201) }))).toHaveProperty('palabraClave')
    expect(campos(body({ palabraClave: 'sola' }))).toHaveProperty('palabraClave')
    expect(campos(amz({ asin: 'B0ABCD1234' }))).toHaveProperty('asin')
    for (const asin of ['b0abcd1234', 'B0ABCD123', 'B0ABCD12345', 'B0ABCD-234', 1234567890]) expect(campos(body({ asin, palabraClave: 'x' })), String(asin)).toHaveProperty('asin')
    expect(parseAltaIdea(amz({ palabraClave: '=IMPORTXML("x")' })).amazon!.palabraClave).toBe('\'=IMPORTXML("x")')
  })

  it('el ASIN ya está en otra idea (activo o solo propuesto): rechaza sin escribir nada, ni la auditoría (criterio 2)', async () => {
    for (const asin of ['B000000001', 'B000000002']) {
      const ideas = libroAmz()
      const { store, service } = servicio()
      const e = await service.altaIdea(parseAltaIdea(body({ asin, palabraClave: 'x' })), PM_CTX, ideas).catch((x: unknown) => x)
      expect((e as OperationError).code).toBe('idea-asin-en-otra-idea')
      expect((e as OperationError).detail).toEqual({ fila: asin === 'B000000001' ? 2 : 3 })
      expect(ideas.escrituras).toEqual([])
      expect((await store.readTable('AUDITORIA')).length).toBe(1)
    }
  })

  it('falta una columna requerida, está repetida o la pestaña está vacía: no escribe nada y dice cuál', async () => {
    const casos: Array<[Parameters<typeof libroAmz>[0], Record<string, string>]> = [
      [{ ideaAsin: [['IDEA_ID', 'ASIN', 'ACTIVO', 'PRINCIPAL']] }, { AMZ_IDEA_ASIN: 'ORIGEN' }],
      [{ nicho: [['ID', 'PALABRA_CLAVE', 'ACTIVO', 'ACTIVO']] }, { AMZ_NICHO: 'ACTIVO' }],
      [{ ideaAsin: [], nicho: [] }, { AMZ_IDEA_ASIN: 'IDEA_ID,ASIN,ACTIVO,PRINCIPAL,ORIGEN', AMZ_NICHO: 'ID,PALABRA_CLAVE,ACTIVO' }],
    ]
    for (const [opts, detalle] of casos) {
      const ideas = libroAmz(opts)
      const { store, service } = servicio()
      const e = await service.altaIdea(parseAltaIdea(amz()), PM_CTX, ideas).catch((x: unknown) => x)
      expect((e as OperationError).code).toBe('idea-encabezados-distintos')
      expect((e as OperationError).detail).toEqual(detalle)
      expect(ideas.escrituras).toEqual([])
      expect((await store.readTable('AUDITORIA')).length).toBe(1)
    }
  })

  it('si falla una comprobación de PRODUCTS o SCORING, tampoco se escribe AMZ_*; y si AMZ_* no se puede leer, nada', async () => {
    const sinFormulas = libroAmz()
    for (const col of [12, 13, 14, 15]) sinFormulas.formulasHoja.delete(`SCORING!10!${col}`)
    expect(await codeOf(servicio().service.altaIdea(parseAltaIdea(amz()), PM_CTX, sinFormulas))).toBe('scoring-sin-formulas')
    expect(sinFormulas.escrituras).toEqual([])
    const sinPestanas = libro()
    expect(await codeOf(servicio().service.altaIdea(parseAltaIdea(amz()), PM_CTX, sinPestanas))).toBe('lectura-fallida')
    expect(sinPestanas.escrituras).toEqual([])
  })

  it('la fila nueva va después de la última con contenido, también si es una fórmula o una fila suelta', async () => {
    const ideas = libroAmz({ nicho: [NICHO_H, ['EC-001', 'termo acero', 'SI'], [], ['', 'nota suelta']] })
    ideas.formulasHoja.set('AMZ_IDEA_ASIN!6!6', '=TODAY()')
    await servicio().service.altaIdea(parseAltaIdea(amz()), PM_CTX, ideas)
    expect(ideas.escrituras.slice(2).map((e) => [e.tab, e.fila])).toEqual([['AMZ_IDEA_ASIN', 7], ['AMZ_NICHO', 5]])
  })

  it('pestaña AMZ_* en el límite de filas: pestana-llena sin escribir nada', async () => {
    const ideas = libroAmz({ nicho: [NICHO_H, ...Array.from({ length: 5000 }, (_, i) => [`X-${i}`, 'k', ''])] })
    const { store, service } = servicio()
    expect(await codeOf(service.altaIdea(parseAltaIdea(amz()), PM_CTX, ideas))).toBe('pestana-llena')
    expect(ideas.escrituras).toEqual([])
    expect((await store.readTable('AUDITORIA')).length).toBe(1)
  })

  it('mismo requestId: no duplica ninguna de las cuatro filas; con otro ASIN o palabra, conflicto de idempotencia (criterio 4)', async () => {
    const ideas = libroAmz()
    const { service } = servicio()
    const cmd = parseAltaIdea(amz())
    await service.altaIdea(cmd, PM_CTX, ideas)
    expect(await service.altaIdea(cmd, PM_CTX, ideas)).toMatchObject({ id: 'EC-009', repetida: true })
    expect(ideas.escrituras.length).toBe(4)
    expect(ideas.snapshot().AMZ_IDEA_ASIN!.filter((r) => r[0] === 'EC-009').length).toBe(1)
    expect(ideas.snapshot().AMZ_NICHO!.filter((r) => r[0] === 'EC-009').length).toBe(1)
    expect(await codeOf(service.altaIdea({ ...cmd, amazon: { ...cmd.amazon!, asin: 'B0ZZZZ9999' } }, PM_CTX, ideas))).toBe('conflicto-idempotencia')
    expect(await codeOf(service.altaIdea({ ...cmd, amazon: { ...cmd.amazon!, palabraClave: 'otra' } }, PM_CTX, ideas))).toBe('conflicto-idempotencia')
    const { amazon: _sin, ...sinAmazon } = cmd
    void _sin
    expect(await codeOf(service.altaIdea(sinAmazon, PM_CTX, ideas))).toBe('conflicto-idempotencia')
  })

  it('escritura a medias (falla AMZ_NICHO): el mismo requestId completa solo lo que falta, aunque el motor haya anexado filas', async () => {
    const ideas = libroAmz()
    const write = ideas.writeRow.bind(ideas)
    let falla = true
    ideas.writeRow = async (tab, fila, celdas) => {
      if (tab === 'AMZ_NICHO' && falla) { falla = false; throw new Error('HTTP 503') }
      return write(tab, fila, celdas)
    }
    const { service } = servicio()
    const cmd = parseAltaIdea(amz())
    expect(await codeOf(service.altaIdea(cmd, PM_CTX, ideas))).toBe('escritura-fallida')
    // Entre el fallo y el reintento el motor propone otro ASIN para la misma idea y alguien agrega otro nicho.
    await write('AMZ_IDEA_ASIN', 5, ['EC-009', 'B0PROPUEST', '', '', 'PROPUESTO_KEEPA', '', ''])
    await write('AMZ_NICHO', 3, ['B0CANDIDAT', 'otro nicho', 'SI'])
    const previas = ideas.escrituras.length
    expect(await service.altaIdea(cmd, PM_CTX, ideas)).toMatchObject({ id: 'EC-009', repetida: true })
    expect(ideas.escrituras.slice(previas).map((e) => [e.tab, e.fila, e.celdas])).toEqual([['AMZ_NICHO', 4, ['EC-009', 'organizador de cables', 'SI']]])
    expect(ideas.snapshot().AMZ_NICHO![2]).toEqual(['B0CANDIDAT', 'otro nicho', 'SI'])
  })

  it('una fila de la idea que ya existe distinta de lo planeado no se corrige: estado-divergente, sin tocarla', async () => {
    const ideas = libroAmz()
    const { service } = servicio()
    const cmd = parseAltaIdea(amz())
    const write = ideas.writeRow.bind(ideas)
    ideas.writeRow = async (tab, fila, celdas) => {
      if (tab === 'AMZ_IDEA_ASIN') throw new Error('HTTP 503')
      return write(tab, fila, celdas)
    }
    expect(await codeOf(service.altaIdea(cmd, PM_CTX, ideas))).toBe('escritura-fallida')
    ideas.writeRow = write
    await write('AMZ_IDEA_ASIN', 4, ['EC-009', 'B0ABCD1234', '', '', 'PROPUESTO_KEEPA', '', ''])
    const previas = ideas.escrituras.length
    expect(await codeOf(service.altaIdea(cmd, PM_CTX, ideas))).toBe('estado-divergente')
    expect(ideas.escrituras.length).toBe(previas)
    expect(ideas.snapshot().AMZ_IDEA_ASIN![3]).toEqual(['EC-009', 'B0ABCD1234', '', '', 'PROPUESTO_KEEPA', '', ''])
  })

  it('si otra escritura pisa la fila nueva entre escribir y verificar, se reporta (verificacion-fallida)', async () => {
    const ideas = libroAmz()
    const write = ideas.writeRow.bind(ideas)
    ideas.writeRow = async (tab, fila, celdas) => {
      await write(tab, fila, celdas)
      if (tab === 'AMZ_NICHO') await write(tab, fila, ['B0CANDIDAT', 'del motor', 'SI'])
    }
    expect(await codeOf(servicio().service.altaIdea(parseAltaIdea(amz()), PM_CTX, ideas))).toBe('verificacion-fallida')
  })

  it('criterio 5: la lista de pestañas es cerrada (sin PIPE_* ni otra AMZ_*) y SCORING nunca pasa de A:L', async () => {
    expect([...IDEAS_TABS]).toEqual(['PRODUCTS', 'SCORING', 'AMZ_IDEA_ASIN', 'AMZ_NICHO'])
    const ideas = libroAmz()
    await servicio().service.altaIdea(parseAltaIdea(amz()), PM_CTX, ideas)
    expect(ideas.escrituras.every((e) => (IDEAS_TABS as readonly string[]).includes(e.tab))).toBe(true)
    expect(ideas.escrituras.find((e) => e.tab === 'SCORING')!.celdas.length).toBe(12)
    for (const tab of ['PIPE_PRODUCTOS', 'PIPE_COTIZACIONES', 'AMZ_NICHO_TOP', 'AMZ_RESUMEN', 'AMZ_DICTAMEN', 'UNIT_ECONOMICS']) {
      await expect(ideas.writeRow(tab as IdeasTab, 10, ['a', 'b', 'c'])).rejects.toThrow('lista cerrada')
      await expect(ideas.values(tab as IdeasTab)).rejects.toThrow('lista cerrada')
    }
  })

  it('adaptador de Sheets: en AMZ_* un solo rango de una fila desde A, en RAW, con el ancho del encabezado', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : null })
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const store = new IdeasSheetsStore({ spreadsheetId: 'LIBRO', getWriteToken: async () => 't', fetchImpl })
    await store.writeRow('AMZ_IDEA_ASIN', 40, ['EC-009', 'B0ABCD1234', 'SI', 'SI', 'POS', '', ''])
    await store.writeRow('AMZ_NICHO', 12, ['EC-009', 'organizador', 'SI'])
    expect(calls.map((c) => (c.body as { data: Array<{ range: string; values: unknown[][] }> }).data.map((d) => [d.range, d.values.length]))).toEqual([
      [["'AMZ_IDEA_ASIN'!A40:G40", 1]], [["'AMZ_NICHO'!A12:C12", 1]],
    ])
    expect(calls.every((c) => c.url.endsWith('/values:batchUpdate') && (c.body as { valueInputOption: string }).valueInputOption === 'RAW')).toBe(true)
    await expect(store.writeRow('AMZ_NICHO', 12, ['EC-009', 'x'])).rejects.toThrow('ancho')
    await expect(store.writeRow('AMZ_IDEA_ASIN', 12, Array.from({ length: 53 }, () => ''))).rejects.toThrow('ancho')
    await expect(store.writeRow('AMZ_NICHO', 1, ['ID', 'PALABRA_CLAVE', 'ACTIVO'])).rejects.toThrow('fila')
    await expect(store.writeRow('AMZ_NICHO_TOP' as IdeasTab, 12, ['a', 'b', 'c'])).rejects.toThrow('lista cerrada')
    expect(calls.length).toBe(2)
  })

  it('bandera apagada: con los campos nuevos sigue inerte (operacion-no-permitida antes de leer el cuerpo) (criterio 1)', async () => {
    const PM = 'token-pm-sintetico-0123456789'
    const base = { PM_AGENT_TOKEN_SHA256: createHash('sha256').update(PM).digest('hex'), PROJECT_OS_WRITE_MODE: 'mock', DASHBOARD_DATA_SOURCE: 'fixtures' }
    for (const valor of [undefined, 'TRUE', 'on', '1', ' true']) {
      const req = new Request('http://127.0.0.1:3000/api/operaciones/ideas', {
        method: 'POST', body: JSON.stringify(amz()), headers: { 'content-type': 'application/json', authorization: `Bearer ${PM}` },
      })
      const ctx = { email: null, env: { ...base, ECO_IDEAS_ALTA: valor } as unknown as NodeJS.ProcessEnv, limiter: new RateLimiter(), agentLimiter: new RateLimiter(5, 60_000), operation: 'idea.alta' as OperationName }
      expect(await codeOf(evaluateWriteRequest(req, ctx)), String(valor)).toBe('operacion-no-permitida')
      expect(req.bodyUsed).toBe(false)
    }
  })
})

describe('Idea rápida: tarjeta para POS · Ideas (ORD-POS-160)', () => {
  it('con los tres campos válidos arma la tarjeta con los nombres de campo de idea.alta y el ASIN del enlace', () => {
    const t = tarjetaIdeaRapida({ nombre: '  Organizador   de cables ', enlace: ` ${ENLACE} `, palabra: 'organizador\tde cables' })
    expect(t).toMatchObject({ ok: true, asin: 'B0ABCD1234' })
    const texto = (t as { texto: string }).texto
    expect(texto.split('\n')).toEqual([
      'Idea nueva para RADAROS (alta rápida, idea.alta, DEC-ECO-017)', '- producto: Organizador de cables', `- enlaceAmazon: ${ENLACE}`,
      '- ASIN que saldrá del enlace: B0ABCD1234', '- palabraClave: organizador de cables',
      'Inclúyela en un paquete PAQ para el PM. No se da de alta sin el «sí PAQ» del propietario.',
    ])
    // Lo que dice la tarjeta es lo que acepta el servidor.
    expect(parseAltaIdea(body({ producto: 'Organizador de cables', enlaceAmazon: ENLACE, palabraClave: 'organizador de cables' })).amazon).toEqual({ asin: 'B0ABCD1234', palabraClave: 'organizador de cables' })
  })

  it('campos vacíos, largos o un enlace que no es de amazon.com.mx: errores por campo y ninguna tarjeta', () => {
    expect(tarjetaIdeaRapida({ nombre: '', enlace: '', palabra: ' ' })).toEqual({ ok: false, errores: { nombre: 'Requerido', enlace: 'Requerido', palabra: 'Requerido' } })
    const t = tarjetaIdeaRapida({ nombre: 'x'.repeat(161), enlace: 'https://www.amazon.com/dp/B0ABCD1234', palabra: 'x'.repeat(201) })
    expect(t.ok).toBe(false)
    expect(Object.keys((t as { errores: object }).errores)).toEqual(['nombre', 'enlace', 'palabra'])
  })

  it('el formulario tiene 3 campos con etiqueta y no escribe: ni fetch, ni rutas, ni acciones de servidor', () => {
    const html = renderToStaticMarkup(createElement(IdeaRapida))
    expect(html.match(/<input /g)?.length).toBe(3)
    for (const id of ['nombre', 'enlace', 'palabra']) expect(html).toContain(`<label for="idea-rapida-${id}">`)
    expect(html).not.toContain('<textarea')
    for (const archivo of ['src/components/eco/idea-rapida.tsx', 'src/lib/radaros/idea-amazon.ts']) {
      const fuente = readFileSync(path.join(__dirname, '..', archivo), 'utf8')
      expect(fuente).not.toMatch(/\bfetch\s*\(|\/api\/|use server|XMLHttpRequest|sendBeacon|from '(?!react'|@\/lib\/radaros\/idea-amazon')/)
    }
  })
})

describe('idea.alta: validación del comando (criterio 5)', () => {
  const campos = (b: unknown) => {
    try { parseAltaIdea(b); return null } catch (e) { return (e as OperationError).fields }
  }

  it('puntajes: enteros del 1 al 5 o vacíos', () => {
    for (const v of [0, 6, 2.5, '3', -1]) expect(campos(body({ puntajes: { demanda: v } }))).toHaveProperty('puntajes.demanda')
    expect(campos(body({ puntajes: { demanda: 1, riesgo: 5, marca: null, tendencia: '' } }))).toBeNull()
    expect(campos(body({ puntajes: { otro: 3 } }))).toHaveProperty('puntajes.otro')
  })

  it('autorización «sí PAQ», producto obligatorio y sin campos de más', () => {
    expect(campos(body({ autorizacion: undefined }))).toHaveProperty('autorizacion')
    expect(campos(body({ autorizacion: 'PAQ-2026-11-01-01 «ok» 2026-11-01' }))).toHaveProperty('autorizacion')
    expect(campos(body({ autorizacion: 'PAQ-2026-11-01-01 «sí PAQ-2026-11-01-02» 2026-11-01' }))).toHaveProperty('autorizacion')
    expect(campos(body({ autorizacion: 'PAQ-2026-11-01-01 «sí PAQ-2026-11-01-01» 2026-02-30' }))).toHaveProperty('autorizacion')
    expect(campos(body({ producto: '' }))).toHaveProperty('producto')
    expect(campos(body({ productId: 'EC-050' }))).toHaveProperty('productId')
    expect(campos(body({ precioObservadoMxn: 'mucho' }))).toHaveProperty('precioObservadoMxn')
  })

  it('texto que empieza por = se neutraliza (nunca una fórmula)', () => {
    expect(parseAltaIdea(body({ producto: '=IMPORTXML("x")' })).products[0]).toBe('\'=IMPORTXML("x")')
  })
})

describe('idea.alta: bandera, guard y proxy (criterios 1 y 6)', () => {
  const PM = 'token-pm-sintetico-0123456789'
  const ORIGIN = 'http://127.0.0.1:3000'
  const sha = (t: string) => createHash('sha256').update(t).digest('hex')
  const BASE = { PM_AGENT_TOKEN_SHA256: sha(PM), PROJECT_OS_WRITE_MODE: 'mock', DASHBOARD_DATA_SOURCE: 'fixtures', AUTH_ALLOWED_EMAILS: 'escritor@example.com', AUTH_WRITER_EMAILS: 'escritor@example.com' }
  const env = (extra: Record<string, string | undefined>) => ({ ...BASE, ...extra }) as unknown as NodeJS.ProcessEnv
  const ctx = (e: NodeJS.ProcessEnv, email: string | null = null, operation: OperationName = 'idea.alta') => ({
    email, env: e, limiter: new RateLimiter(), agentLimiter: new RateLimiter(5, 60_000), operation,
  })
  const alta = (headers: Record<string, string>) => new Request(`${ORIGIN}/api/operaciones/ideas`, {
    method: 'POST', body: JSON.stringify(body()), headers: { 'content-type': 'application/json', ...headers },
  })

  it('bandera apagada (o con otro valor): inerte, operacion-no-permitida antes de leer el cuerpo', async () => {
    for (const valor of [undefined, 'TRUE', 'on', '1']) {
      expect(await codeOf(evaluateWriteRequest(alta({ authorization: `Bearer ${PM}` }), ctx(env({ ECO_IDEAS_ALTA: valor })))), String(valor)).toBe('operacion-no-permitida')
    }
  })

  it('bandera encendida: solo el token del PM, como agente-pm; una sesión de navegador nunca', async () => {
    const r = await evaluateWriteRequest(alta({ authorization: `Bearer ${PM}` }), ctx(env({ ECO_IDEAS_ALTA: 'true' })))
    expect(r).toMatchObject({ actor: 'agente-pm', agent: true })
    expect(await codeOf(evaluateWriteRequest(alta({ authorization: 'Bearer otro-token-0123456789' }), ctx(env({ ECO_IDEAS_ALTA: 'true' }))))).toBe('no-autenticado')
    const sesion = alta({ origin: ORIGIN, 'x-project-os-csrf': '1' })
    expect(await codeOf(evaluateWriteRequest(sesion, ctx(env({ ECO_IDEAS_ALTA: 'true', NEXTAUTH_URL: ORIGIN }), 'escritor@example.com')))).toBe('operacion-no-permitida')
    expect(AGENT_OPERATIONS).not.toContain('idea.alta')
  })

  it('encendida de verdad solo con la escritura del pipeline activa (su cuenta y RADAROS_SHEET_ID)', () => {
    expect(ecoIdeasAltaHabilitada(env({ ECO_IDEAS_ALTA: 'true' }))).toBe(false)
    expect(estadoBandera('ECO_IDEAS_ALTA', env({ ECO_IDEAS_ALTA: 'true' }))).toMatchObject({ tipo: 'apagada' })
    const pipeline = {
      ECO_IDEAS_ALTA: 'true', ECO_PIPELINE_WRITE_MODE: 'sheets', RADAROS_SHEET_ID: 'LIBRO_RADAROS_SINTETICO_0123456789',
      SHEETS_SPREADSHEET_ID: 'HOJA_PROJECT_OS_SINTETICA_0123456789', SHEETS_EXPECTED_SERVICE_ACCOUNT: 'lector@project-os-511102.iam.gserviceaccount.com',
      ECO_PIPELINE_WRITE_SERVICE_ACCOUNT: 'project-os-eco@project-os-511102.iam.gserviceaccount.com', ECO_PIPELINE_WRITER_EMAIL: 'escritor@example.com',
    }
    expect(ecoIdeasAltaHabilitada(env(pipeline))).toBe(true)
    expect(ecoIdeasAltaHabilitada(env({ ...pipeline, ECO_IDEAS_ALTA: 'TRUE' }))).toBe(false)
  })

  it('el proxy deja pasar el token del PM a POST /api/operaciones/ideas y nada más', async () => {
    const e = env({})
    const req = (method: string) => new NextRequest(new URL('/api/operaciones/ideas', ORIGIN), { method, headers: { authorization: `Bearer ${PM}` } })
    const d = (r: NextRequest) => decide(r, { secret: 'secreto-de-prueba-0123456789abcdef', agentTokenSha256: e.PM_AGENT_TOKEN_SHA256 })
    expect((await d(req('POST'))).action).toBe('agent')
    expect((await d(req('PATCH'))).action).not.toBe('agent')
  })
})

describe('idea.alta: adaptador de Sheets (criterio 4)', () => {
  it('escribe un solo rango A:P o A:L en RAW y nunca otra pestaña ni otro ancho', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : null })
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const store = new IdeasSheetsStore({ spreadsheetId: 'LIBRO', getWriteToken: async () => 't', fetchImpl })
    await store.writeRow('PRODUCTS', 10, Array.from({ length: 16 }, () => ''))
    await store.writeRow('SCORING', 10, Array.from({ length: 12 }, () => ''))
    expect(calls.map((c) => (c.body as { data: Array<{ range: string }> }).data[0]!.range)).toEqual(["'PRODUCTS'!A10:P10", "'SCORING'!A10:L10"])
    expect(calls.every((c) => c.url.endsWith('/values:batchUpdate') && (c.body as { valueInputOption: string }).valueInputOption === 'RAW')).toBe(true)
    await expect(store.writeRow('SCORING', 10, Array.from({ length: 16 }, () => ''))).rejects.toThrow('ancho')
    await expect(store.writeRow('PIPE_PRODUCTOS' as IdeasTab, 10, [])).rejects.toThrow('lista cerrada')
    await expect(store.writeRow('PRODUCTS', 1, Array.from({ length: 16 }, () => ''))).rejects.toThrow('fila')
    expect(calls.length).toBe(2)
  })
})

describe('render.mjs (criterio 6)', () => {
  const template = readFileSync(path.join(__dirname, '..', 'deploy', 'cloudrun', 'service.template.yaml'), 'utf8')
  const BASE = {
    SERVICE_NAME: 'project-os-dashboard', PROJECT_ID: 'project-os-511102', REGION: 'northamerica-south1',
    IMAGE: `us-docker.pkg.dev/proj-os-1/repo/dash@sha256:${'a'.repeat(64)}`, RUNTIME_SA: 'runtime@project-os-511102.iam.gserviceaccount.com',
    SERVICE_URL: 'https://dash.example.com', OAUTH_CLIENT_ID: '123-abc.apps.googleusercontent.com', SECRET_VERSION_NEXTAUTH: '1',
    SECRET_VERSION_OAUTH: '1', SECRET_VERSION_ALLOWLIST: '1', WRITE_MODE: 'sheets', WRITE_SERVICE_ACCOUNT: 'writer@project-os-511102.iam.gserviceaccount.com',
    SECRET_VERSION_WRITERS: '1', SECRET_VERSION_PM_AGENT: '7',
  }
  const PIPE = {
    RADAROS_SHEET_ID: 'LIBRO_RADAROS_SINTETICO_0123456789', ECO_PIPELINE_WRITE_MODE: 'sheets',
    ECO_PIPELINE_WRITE_SERVICE_ACCOUNT: 'project-os-eco@project-os-511102.iam.gserviceaccount.com', ECO_PIPELINE_WRITER_EMAIL: 'dueno@example.com',
  }

  it('sin la bandera el YAML no la lleva; con true y la escritura del pipeline, sí', () => {
    expect(render(template, { ...BASE, ...PIPE })).not.toContain('ECO_IDEAS_ALTA')
    expect(render(template, { ...BASE, ...PIPE, ECO_IDEAS_ALTA: 'true' })).toContain("- name: ECO_IDEAS_ALTA\n              value: 'true'")
  })

  it('rechaza otro valor, o la bandera sin el pipeline o sin el token del PM', () => {
    expect(() => render(template, { ...BASE, ...PIPE, ECO_IDEAS_ALTA: 'on' })).toThrow('ECO_IDEAS_ALTA solo admite true')
    expect(() => render(template, { ...BASE, ECO_IDEAS_ALTA: 'true' })).toThrow('ECO_IDEAS_ALTA exige ECO_PIPELINE_WRITE_MODE=sheets')
    expect(() => render(template, { ...BASE, ...PIPE, SECRET_VERSION_PM_AGENT: '', ECO_IDEAS_ALTA: 'true' })).toThrow('SECRET_VERSION_PM_AGENT')
  })
})
