import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { render } from '../deploy/cloudrun/render.mjs'
import { finanzasConfig as finanzasConfigEnv, finanzasSheetId as finanzasSheetIdEnv } from '@/lib/config'
import { createEcoLoader } from '@/lib/radaros/data'
import { createFinanzasLoader } from '@/lib/finanzas/data'
import {
  alertaCapital, capitalUsado, construirFinanzas, costoHerramientas, FINANZAS_TABS, formatoMxn, gastoMensual,
  leerMovimientos, leerParametros, mesDeTexto, pylPorProducto, ventanaMeses, type Movimiento,
} from '@/lib/finanzas/finanzas'
import { MAX_DATA_ROWS } from '@/lib/schema'

const finanzasConfig = (env: Record<string, string>) => finanzasConfigEnv(env as unknown as NodeJS.ProcessEnv)
const finanzasSheetId = (env: Record<string, string>) => finanzasSheetIdEnv(env as unknown as NodeJS.ProcessEnv)

/** /finanzas (ORD-POS-074, docs/diseno-finanzas.md): solo dobles de fetch y de token, nunca red real. Montos inventados. */

const PROPIA = '16UXe7fm90fOTTVJhI_RZ8__I876u2buvjeLGr5cJ-Ic'
const RADAROS = 'LIBRO_RADAROS_SINTETICO_0123456789'
const FINANZAS = 'LIBRO_FINANZAS_SINTETICO_0123456789'
const NOW = Date.UTC(2026, 9, 23, 18, 0, 0) // 2026-10-23 en Mérida

const ENCABEZADO = ['MOV_ID', 'FECHA', 'PROYECTO', 'TIPO', 'CATEGORIA', 'CONCEPTO', 'PRODUCTO_ID', 'MONTO_MXN', 'MONEDA_ORIG', 'MONTO_ORIG', 'TIPO_CAMBIO', 'IVA_MXN', 'FUENTE', 'COMPROBANTE']
const fila = (id: string, fecha: string, proyecto: string, tipo: string, categoria: string, concepto: string, producto: string, monto: unknown, fuente: string, comprobante = 'sí') =>
  [id, fecha, proyecto, tipo, categoria, concepto, producto, monto, '', '', '', '', fuente, comprobante]

const MOVIMIENTOS: unknown[][] = [
  ENCABEZADO,
  fila('MAN-0001', '2026-08-05', 'POS', 'Gasto', 'Herramientas', 'Suscripción Claude', '', 400, 'manual'),
  fila('MAN-0002', '2026-09-05', 'POS', 'Gasto', 'Herramientas', 'Suscripción Claude', '', 400, 'manual'),
  fila('MAN-0003', '2026-09-10', 'ECO', 'Gasto', 'Herramientas', 'Keepa', '', 250.5, 'manual'),
  fila('MAN-0004', '2026-10-02', 'ECO', 'Inversión', 'Producto', 'Inventario', 'EC-004', 3000, 'manual'),
  fila('MAN-0005', '2026-10-03', 'ECO', 'Gasto', 'Producto', 'Muestras', 'EC-004', '120,25', 'manual', 'no'),
  fila('SPAPI-evt_001', '2026-10-15', 'ECO', 'Ingreso', 'Ventas', 'Ventas', 'EC-004', 1500, 'sp-api'),
  fila('CLAUDE-2026-10', '2026-10-01', 'POS', 'Gasto', 'Herramientas', 'Suscripción Claude', '', 400, 'anthropic'),
  fila('MAN-0006', '2026-06-01', 'ECO', 'Gasto', 'Legal y marca', 'IMPI', '', 2000, 'manual'), // antes de MES_INICIO
  fila('MAN-0007', '2026-10-04', 'ECO', 'Gasto', 'Marketing', 'Fotos', '', 0.1, 'manual'),
  fila('MAN-0008', '2026-10-04', 'ECO', 'Gasto', 'Marketing', 'Fotos', '', 0.2, 'manual'),
  [],
]
const PARAMETROS: unknown[][] = [
  ['PARAMETRO', 'VALOR'],
  ['CAPITAL_TOPE_MXN', 8000],
  ['ALERTA_PCT', ''],
  ['TIPO_CAMBIO_DEFECTO', 18.5],
  ['MES_INICIO', '2026-07'],
]

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** Doble de Sheets API: metadatos con las pestañas dadas y batchGet en el orden pedido. */
function fakeSheets(tabs: Record<string, unknown[][]>, opts: { status?: number } = {}) {
  const urls: string[] = []
  const methods: string[] = []
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    urls.push(url.toString())
    methods.push(init?.method ?? 'GET')
    if (opts.status) return jsonResponse({}, opts.status)
    if (url.pathname.endsWith('values:batchGet')) {
      const ranges = url.searchParams.getAll('ranges').map((r) => /^'(.+)'!/.exec(r)![1]!.replace(/''/g, "'"))
      return jsonResponse({ valueRanges: ranges.map((t) => ({ values: tabs[t] })) })
    }
    return jsonResponse({ sheets: Object.keys(tabs).map((title) => ({ properties: { title } })) })
  }) as unknown as typeof fetch
  return { fetchImpl, urls, methods }
}

function loader(env: Record<string, string | undefined>, tabs: Record<string, unknown[][]> = {}, opts: { status?: number } = {}) {
  const sheets = fakeSheets(tabs, opts)
  const getAccessToken = vi.fn(async () => 'ya29.token-de-prueba-no-real')
  const l = createFinanzasLoader({
    env: { SHEETS_SPREADSHEET_ID: PROPIA, ...env } as unknown as NodeJS.ProcessEnv, getAccessToken, fetchImpl: sheets.fetchImpl,
    sleep: async () => {}, now: () => NOW,
  })
  return { ...sheets, getAccessToken, load: l.load }
}

describe('finanzasConfig (criterio 1)', () => {
  it('null sin variable, vacía, con formato no válido o igual a SHEETS_SPREADSHEET_ID o a RADAROS_SHEET_ID', () => {
    const base = { SHEETS_SPREADSHEET_ID: PROPIA, RADAROS_SHEET_ID: RADAROS }
    expect(finanzasSheetId(base)).toBeNull()
    expect(finanzasConfig(base)).toEqual({ id: null, motivo: 'ausente' })
    for (const v of ['', '   ']) expect(finanzasConfig({ ...base, FINANZAS_SHEET_ID: v })).toEqual({ id: null, motivo: 'ausente' })
    for (const v of ['corto', 'con espacios en medio 0123456789', 'a/b/../0123456789abcdefgh', PROPIA, ` ${PROPIA} `, RADAROS, ` ${RADAROS}`]) {
      expect(finanzasConfig({ ...base, FINANZAS_SHEET_ID: v }), v).toEqual({ id: null, motivo: 'no-valido' })
    }
    expect(finanzasSheetId({ ...base, FINANZAS_SHEET_ID: ` ${FINANZAS} ` })).toBe(FINANZAS)
    expect(finanzasSheetId({ FINANZAS_SHEET_ID: FINANZAS })).toBe(FINANZAS)
  })

  it('nunca lanza ni incluye el valor en lo que devuelve', () => {
    const malo = 'VALOR-SECRETO no válido'
    expect(() => finanzasConfig({ FINANZAS_SHEET_ID: malo })).not.toThrow()
    expect(JSON.stringify(finanzasConfig({ FINANZAS_SHEET_ID: malo }))).not.toContain('VALOR-SECRETO')
    expect(JSON.stringify(finanzasConfig({ FINANZAS_SHEET_ID: RADAROS, RADAROS_SHEET_ID: RADAROS }))).not.toContain(RADAROS)
  })
})

describe('inercia (criterio 6)', () => {
  const casos = [
    ['sin variable', undefined], ['vacía', ''], ['no válida', 'no válida'], ['igual a PROJECT-OS', PROPIA], ['igual a RADAROS', RADAROS],
  ] as const
  for (const [caso, valor] of casos) {
    it(`${caso}: «no configurado» y cero llamadas al doble de fetch y al de token`, async () => {
      const l = loader({ RADAROS_SHEET_ID: RADAROS, FINANZAS_SHEET_ID: valor }, { MOVIMIENTOS, PARAMETROS })
      const r = await l.load()
      await l.load()
      expect(r.estado).toBe('no-configurado')
      expect(l.fetchImpl).not.toHaveBeenCalled()
      expect(l.getAccessToken).not.toHaveBeenCalled()
    })
  }

  it('la página resuelve la variable antes de leer y el enlace depende solo de ella', () => {
    const page = readFileSync(path.join(__dirname, '..', 'src', 'app', '(private)', 'finanzas', 'page.tsx'), 'utf8')
    expect(page).toContain('FINANZAS no está configurado en este despliegue')
    expect(page).toContain("privateFinanzas('/finanzas')")
    const layout = readFileSync(path.join(__dirname, '..', 'src', 'app', '(private)', 'layout.tsx'), 'utf8')
    expect(layout).toContain('showFinanzas={finanzasSheetId() !== null}')
    const nav = readFileSync(path.join(__dirname, '..', 'src', 'components', 'nav-links.tsx'), 'utf8')
    expect(nav).toMatch(/showFinanzas \? \[\{ href: '\/finanzas'/)
    expect(nav).toContain('showFinanzas = false')
  })
})

describe('lector de FINANZAS (criterio 3)', () => {
  it('solo GET a sheets.googleapis.com, máximo 2 lecturas, el libro FINANZAS y montos sin formato', async () => {
    const l = loader({ FINANZAS_SHEET_ID: FINANZAS, RADAROS_SHEET_ID: RADAROS }, { MOVIMIENTOS, PARAMETROS, RESUMEN: [['X']], OTRA: [['X']] })
    const r = await l.load()
    expect(r.estado).toBe('ok')
    expect(l.urls).toHaveLength(2)
    expect(new Set(l.methods)).toEqual(new Set(['GET']))
    for (const u of l.urls) expect(u.startsWith(`https://sheets.googleapis.com/v4/spreadsheets/${FINANZAS}`)).toBe(true)
    expect(l.urls.join(' ')).not.toContain(PROPIA)
    expect(l.urls.join(' ')).not.toContain(RADAROS)
    const batch = new URL(l.urls.find((u) => u.includes('values:batchGet'))!)
    expect(batch.searchParams.getAll('ranges').map((x) => /^'(.+)'!/.exec(x)![1])).toEqual(['MOVIMIENTOS', 'PARAMETROS'])
    expect(batch.searchParams.get('valueRenderOption')).toBe('UNFORMATTED_VALUE')
    expect(batch.searchParams.get('dateTimeRenderOption')).toBe('FORMATTED_STRING')
    expect(FINANZAS_TABS).toEqual(['MOVIMIENTOS', 'PARAMETROS'])
  })

  it('sin ninguna pestaña de la lista: solo metadatos, sin batchGet, y cada bloque dice que no existe', async () => {
    const l = loader({ FINANZAS_SHEET_ID: FINANZAS }, { RESUMEN: [['X']] })
    const r = await l.load()
    expect(l.urls).toHaveLength(1)
    expect(r.estado === 'ok' && r.vista.capital).toEqual({ estado: 'no-disponible', mensaje: 'La pestaña MOVIMIENTOS todavía no existe.' })
  })

  it('caché propia: una segunda carga no vuelve a leer', async () => {
    const l = loader({ FINANZAS_SHEET_ID: FINANZAS }, { MOVIMIENTOS })
    await l.load()
    await l.load()
    expect(l.urls).toHaveLength(2)
  })

  it('401/403/404: mensaje seguro del cliente, sin datos ni el ID; cuota o 5xx: «intenta en un minuto»', async () => {
    const r = await loader({ FINANZAS_SHEET_ID: FINANZAS }, {}, { status: 403 }).load()
    expect(r).toMatchObject({ estado: 'error', code: 'permission', reintentar: false })
    expect(JSON.stringify(r)).not.toContain(FINANZAS)
    expect(r.estado === 'error' && r.message).toContain('Compártela como Lector')
    for (const [status, code] of [[401, 'auth'], [404, 'not-found']] as const) {
      expect(await loader({ FINANZAS_SHEET_ID: FINANZAS }, {}, { status }).load()).toMatchObject({ estado: 'error', code, reintentar: false })
    }
    for (const status of [429, 503]) {
      expect(await loader({ FINANZAS_SHEET_ID: FINANZAS }, {}, { status }).load()).toMatchObject({ estado: 'error', reintentar: true })
    }
  })

  it('el lector es server-only, no escribe y no llama fuera de sheets.googleapis.com', () => {
    const src = readFileSync(path.join(__dirname, '..', 'src', 'lib', 'finanzas', 'data.ts'), 'utf8')
    expect(src.startsWith("import 'server-only'")).toBe(true)
    expect(src).toContain('createSheetsReader(')
    expect(src).not.toMatch(/operations|write-credentials|POST|PUT|sellingpartnerapi|anthropic\.com|https?:\/\//i)
    const puro = readFileSync(path.join(__dirname, '..', 'src', 'lib', 'finanzas', 'finanzas.ts'), 'utf8')
    expect(puro).not.toMatch(/fetch\(|https?:\/\/|server-only/)
  })
})

describe('readTabs: opción de render (criterio 2)', () => {
  it('/eco y el dashboard siguen pidiendo FORMATTED_VALUE; /finanzas pide UNFORMATTED_VALUE', async () => {
    const eco = fakeSheets({ SCORING: [['IDEA_ID'], ['EC-001']] })
    await createEcoLoader({
      env: { SHEETS_SPREADSHEET_ID: PROPIA, RADAROS_SHEET_ID: RADAROS } as unknown as NodeJS.ProcessEnv,
      getAccessToken: async () => 't', fetchImpl: eco.fetchImpl, sleep: async () => {}, now: () => NOW,
    }).load()
    expect(new URL(eco.urls[1]!).searchParams.get('valueRenderOption')).toBe('FORMATTED_VALUE')
    // El lector del dashboard (lib/data.ts) llama a readTabs sin opciones: valor por defecto.
    const data = readFileSync(path.join(__dirname, '..', 'src', 'lib', 'data.ts'), 'utf8')
    expect(data).toContain('reader.readTabs(TABS_READ)')
    const ecoSrc = readFileSync(path.join(__dirname, '..', 'src', 'lib', 'radaros', 'data.ts'), 'utf8')
    expect(ecoSrc).toContain('reader.readTabs(ECO_TABS)')
  })
})

describe('funciones puras de §2 y §4 (criterio 4)', () => {
  it('filas válidas, centavos exactos y filas vacías ignoradas', () => {
    const l = leerMovimientos(MOVIMIENTOS)
    expect(l.estado).toBe('ok')
    if (l.estado !== 'ok') return
    expect(l.problemas).toEqual([])
    expect(l.movimientos).toHaveLength(10)
    expect(l.movimientos.find((m) => m.movId === 'MAN-0005')).toMatchObject({ centavos: 12025, mes: '2026-10', productoId: 'EC-004' })
    expect(l.movimientos.find((m) => m.movId === 'MAN-0003')?.centavos).toBe(25050)
  })

  it('filas con problema: prefijo, FUENTE, listas cerradas, monto y fecha; sin montos en el reporte', () => {
    const l = leerMovimientos([
      ENCABEZADO,
      fila('MAN-0001', '2026-10-01', 'POS', 'Gasto', 'Herramientas', 'x', '', 10, 'sp-api'), // MAN- con sp-api
      fila('SPAPI-1', '2026-10-01', 'ECO', 'Ingreso', 'Ventas', 'x', '', 10, 'manual'), // SPAPI- con manual
      fila('CLAUDE-2026-13', '2026-10-01', 'POS', 'Gasto', 'Herramientas', 'x', '', 10, 'anthropic'), // mes inválido
      fila('OTRO-0001', '2026-10-01', 'POS', 'Gasto', 'Herramientas', 'x', '', 10, 'manual'), // prefijo desconocido
      fila('MAN-1', '2026-10-01', 'POS', 'Gasto', 'Herramientas', 'x', '', 10, 'manual'), // MAN- sin 4 dígitos
      fila('MAN-0010', '23/10/2026', 'SIG', 'Gasto', 'Viajes', '', '', '$1,234.00', 'banco', 'tal vez'),
      fila('MAN-0011', '2026-10-01', 'POS', 'Gasto', 'Herramientas', 'x', '', -5, 'manual'),
      fila('', '2026-10-01', 'POS', 'Gasto', 'Herramientas', 'x', '', 777777, 'manual'),
    ])
    expect(l.estado).toBe('ok')
    if (l.estado !== 'ok') return
    expect(l.movimientos).toEqual([])
    expect(l.problemas).toEqual([
      { ref: 'MAN-0001 (fila 2)', columnas: ['MOV_ID'] },
      { ref: 'SPAPI-1 (fila 3)', columnas: ['MOV_ID'] },
      { ref: 'CLAUDE-2026-13 (fila 4)', columnas: ['MOV_ID'] },
      { ref: 'OTRO-0001 (fila 5)', columnas: ['MOV_ID'] },
      { ref: 'MAN-1 (fila 6)', columnas: ['MOV_ID'] },
      { ref: 'MAN-0010 (fila 7)', columnas: ['FECHA', 'PROYECTO', 'CATEGORIA', 'CONCEPTO', 'MONTO_MXN', 'FUENTE', 'COMPROBANTE'] },
      { ref: 'MAN-0011 (fila 8)', columnas: ['MONTO_MXN'] },
      { ref: 'fila 9', columnas: ['MOV_ID'] },
    ])
    expect(JSON.stringify(l.problemas)).not.toMatch(/777777|1,234|-5/)
  })

  it('MOV_ID duplicado: ninguna de sus filas se suma y ambas se reportan', () => {
    const l = leerMovimientos([
      ENCABEZADO,
      fila('MAN-0001', '2026-10-01', 'POS', 'Gasto', 'Herramientas', 'Claude', '', 400, 'manual'),
      fila('MAN-0002', '2026-10-01', 'POS', 'Gasto', 'Herramientas', 'Keepa', '', 100, 'manual'),
      fila('MAN-0001', '2026-10-02', 'POS', 'Gasto', 'Herramientas', 'Claude', '', 400, 'manual'),
    ])
    expect(l.estado === 'ok' && l.movimientos.map((m) => m.movId)).toEqual(['MAN-0002'])
    expect(l.estado === 'ok' && l.problemas).toEqual([
      { ref: 'MAN-0001 (fila 2)', columnas: ['MOV_ID (duplicado)'] },
      { ref: 'MAN-0001 (fila 4)', columnas: ['MOV_ID (duplicado)'] },
    ])
  })

  it('columnas por nombre, mayúsculas indistintas y «si» sin acento', () => {
    const l = leerMovimientos([
      ['COMPROBANTE', 'FUENTE', 'MONTO_MXN', 'CONCEPTO', 'CATEGORIA', 'TIPO', 'PROYECTO', 'FECHA', 'MOV_ID'],
      ['si', 'Manual', 10, 'x', 'herramientas', 'inversión', 'eco', '2026/10/01', 'MAN-0001'],
    ])
    expect(l.estado === 'ok' && l.movimientos[0]).toMatchObject({ proyecto: 'ECO', tipo: 'Inversión', categoria: 'Herramientas', productoId: null })
  })

  it('falta una columna obligatoria o MOVIMIENTOS truncada: sin totales', () => {
    expect(leerMovimientos([ENCABEZADO.filter((c) => c !== 'FUENTE' && c !== 'FECHA')])).toEqual({
      estado: 'no-disponible', mensaje: 'Faltan las columnas FECHA, FUENTE en MOVIMIENTOS; no se muestran totales.',
    })
    expect(leerMovimientos([ENCABEZADO.filter((c) => c !== 'FUENTE')])).toMatchObject({ mensaje: 'Falta la columna FUENTE en MOVIMIENTOS; no se muestran totales.' })
    const filas = Array.from({ length: MAX_DATA_ROWS + 1 }, (_, i) => fila(`MAN-${String(i % 10000).padStart(4, '0')}`, '2026-10-01', 'POS', 'Gasto', 'Herramientas', 'x', '', 1, 'manual'))
    const v = construirFinanzas({ MOVIMIENTOS: [ENCABEZADO, ...filas], PARAMETROS }, NOW)
    for (const b of [v.capital, v.mensual, v.herramientas, v.pyl]) expect(b).toMatchObject({ estado: 'no-disponible', mensaje: expect.stringContaining('truncada') })
  })

  it('PARAMETROS: tope, alerta por defecto 80, MES_INICIO como texto o fecha, valores no válidos con aviso', () => {
    expect(leerParametros(PARAMETROS)).toEqual({ topeCentavos: 800000, alertaPct: 80, mesInicio: '2026-07', avisos: [] })
    expect(leerParametros([['PARAMETRO', 'VALOR'], ['MES_INICIO', '2026-07-01'], ['ALERTA_PCT', 90]])).toMatchObject({ mesInicio: '2026-07', alertaPct: 90, topeCentavos: null })
    const malo = leerParametros([['PARAMETRO', 'VALOR'], ['CAPITAL_TOPE_MXN', -1], ['ALERTA_PCT', 0.8], ['MES_INICIO', 'octubre']])
    expect(malo).toMatchObject({ topeCentavos: null, alertaPct: 80, mesInicio: null })
    expect(malo.avisos).toHaveLength(3)
    expect(leerParametros([['PARAMETRO', 'VALOR']]).avisos).toEqual(['Falta MES_INICIO en PARAMETROS; se cuentan todos los meses.'])
    expect(mesDeTexto('2026-13')).toBeNull()
  })

  it('capital usado: Gasto + Inversión desde MES_INICIO, sin restar ingresos, y desglose por proyecto', () => {
    const l = leerMovimientos(MOVIMIENTOS)
    if (l.estado !== 'ok') throw new Error('lectura')
    const c = capitalUsado(l.movimientos, leerParametros(PARAMETROS))
    // POS: 400 + 400 + 400; ECO: 250.50 + 3000 + 120.25 + 0.10 + 0.20 (MAN-0006 es de junio, antes de MES_INICIO).
    expect(c.porProyecto).toEqual({ POS: 120000, ECO: 337105 })
    expect(c.usadoCentavos).toBe(457105)
    expect(c.restanteCentavos).toBe(800000 - 457105)
    expect(c.pct).toBeCloseTo(57.138, 2)
    expect(c.alerta).toBeNull()
    const sinTope = capitalUsado(l.movimientos, { topeCentavos: null, alertaPct: 80, mesInicio: null, avisos: [] })
    expect(sinTope).toMatchObject({ usadoCentavos: 657105, pct: null, alerta: null, restanteCentavos: null })
    expect(sinTope.avisos[0]).toContain('Falta CAPITAL_TOPE_MXN')
  })

  it('alerta al ALERTA_PCT u 80 %: ámbar hasta antes del 100 %, rojo desde el 100 %', () => {
    expect(alertaCapital(79.99)).toBeNull()
    expect(alertaCapital(80)).toBe('aviso')
    expect(alertaCapital(99.99)).toBe('aviso')
    expect(alertaCapital(100)).toBe('superado')
    expect(alertaCapital(85, 90)).toBeNull()
    expect(alertaCapital(90, 90)).toBe('aviso')
    expect(alertaCapital(null)).toBeNull()
  })

  it('ventana móvil de 12 meses hasta el mes en curso, sin ir antes de MES_INICIO', () => {
    const doce = ventanaMeses(NOW, null)
    expect(doce).toHaveLength(12)
    expect(doce[0]).toBe('2025-11')
    expect(doce.at(-1)).toBe('2026-10')
    expect(ventanaMeses(NOW, '2026-07')).toEqual(['2026-07', '2026-08', '2026-09', '2026-10'])
    // 2026-11-01 04:00 UTC sigue siendo 31 de octubre en Mérida.
    expect(ventanaMeses(Date.UTC(2026, 10, 1, 4), null).at(-1)).toBe('2026-10')
  })

  it('gasto mensual: por proyecto y categoría, Ingreso aparte y nunca restado', () => {
    const l = leerMovimientos(MOVIMIENTOS)
    if (l.estado !== 'ok') throw new Error('lectura')
    const meses = gastoMensual(l.movimientos, ventanaMeses(NOW, '2026-07'))
    expect(meses.map((m) => m.mes)).toEqual(['2026-07', '2026-08', '2026-09', '2026-10'])
    const oct = meses.at(-1)!
    expect(oct.gasto).toEqual({ ECO: 312055, POS: 40000 })
    expect(oct.ingresoCentavos).toBe(150000)
    expect(oct.categorias).toEqual([
      { categoria: 'Herramientas', gasto: { ECO: 0, POS: 40000 } },
      { categoria: 'Producto', gasto: { ECO: 312025, POS: 0 } },
      { categoria: 'Marketing', gasto: { ECO: 30, POS: 0 } },
    ])
    expect(meses[0]!.gasto).toEqual({ ECO: 0, POS: 0 })
  })

  it('herramientas: por concepto y mes, total, promedio de 3 meses y «sin registrar»', () => {
    const l = leerMovimientos(MOVIMIENTOS)
    if (l.estado !== 'ok') throw new Error('lectura')
    const h = costoHerramientas(l.movimientos, ventanaMeses(NOW, '2026-07'))
    expect(h.conceptos.map((c) => c.concepto)).toEqual(['Keepa', 'Suscripción Claude'])
    const keepa = h.conceptos[0]!
    expect(keepa.porMes).toEqual({ '2026-07': null, '2026-08': null, '2026-09': 25050, '2026-10': null })
    expect(keepa.sinRegistrar).toEqual(['2026-10'])
    expect(h.conceptos[1]!.sinRegistrar).toEqual([])
    expect(h.totalPorMes).toEqual({ '2026-07': 0, '2026-08': 40000, '2026-09': 65050, '2026-10': 40000 })
    expect(h.mesesPromedio).toEqual(['2026-08', '2026-09', '2026-10'])
    expect(h.promedioCentavos).toBe(48350)
  })

  it('P&L por producto: ingresos − (gastos + inversión); sin producto al pie, sin repartir', () => {
    const l = leerMovimientos(MOVIMIENTOS)
    if (l.estado !== 'ok') throw new Error('lectura')
    const p = pylPorProducto(l.movimientos)
    expect(p.productos).toEqual([{ productoId: 'EC-004', ingresoCentavos: 150000, gastoCentavos: 12025, inversionCentavos: 300000, resultadoCentavos: -162025 }])
    expect(p.sinProducto).toMatchObject({ productoId: null, ingresoCentavos: 0, inversionCentavos: 0, gastoCentavos: 345080 })
    const soloProducto: Movimiento[] = [{ movId: 'MAN-0001', mes: '2026-10', proyecto: 'ECO', tipo: 'Ingreso', categoria: 'Ventas', concepto: 'x', productoId: 'EC-001', centavos: 100 }]
    expect(pylPorProducto(soloProducto).sinProducto).toBeNull()
  })

  it('formato MXN con 2 decimales', () => {
    expect(formatoMxn(123450)).toBe('$1,234.50')
    expect(formatoMxn(-5)).toBe('-$0.05')
  })
})

describe('estados de §5 (criterio 5)', () => {
  it('con datos: los 4 bloques y sin filas con problema', () => {
    const v = construirFinanzas({ MOVIMIENTOS, PARAMETROS }, NOW)
    for (const b of [v.capital, v.mensual, v.herramientas, v.pyl]) expect(b.estado).toBe('ok')
    expect(v.problemas).toEqual([])
    expect(v.movimientosValidos).toBe(10)
  })

  it('falta MOVIMIENTOS: cada bloque lo dice', () => {
    const v = construirFinanzas({ PARAMETROS }, NOW)
    for (const b of [v.capital, v.mensual, v.herramientas, v.pyl]) expect(b).toEqual({ estado: 'no-disponible', mensaje: 'La pestaña MOVIMIENTOS todavía no existe.' })
  })

  it('falta PARAMETROS: el capital lo dice; los demás siguen con aviso de ventana', () => {
    const v = construirFinanzas({ MOVIMIENTOS }, NOW)
    expect(v.capital).toEqual({ estado: 'no-disponible', mensaje: 'La pestaña PARAMETROS todavía no existe.' })
    expect(v.mensual.estado === 'ok' && v.mensual.datos.meses).toHaveLength(12)
    expect(v.mensual.estado === 'ok' && v.mensual.datos.avisos[0]).toContain('PARAMETROS todavía no existe')
    expect(v.pyl.estado).toBe('ok')
  })

  it('hoja vacía (solo encabezados): estados vacíos y capital 0 contra el tope', () => {
    const v = construirFinanzas({ MOVIMIENTOS: [ENCABEZADO], PARAMETROS }, NOW)
    expect(v.capital.estado === 'ok' && v.capital.datos).toMatchObject({ usadoCentavos: 0, topeCentavos: 800000, pct: 0 })
    for (const b of [v.mensual, v.herramientas, v.pyl]) expect(b).toEqual({ estado: 'vacio', mensaje: 'Sin movimientos todavía.' })
  })

  it('PARAMETROS sin CAPITAL_TOPE_MXN: el capital lo dice; los demás siguen', () => {
    const v = construirFinanzas({ MOVIMIENTOS, PARAMETROS: [['PARAMETRO', 'VALOR'], ['MES_INICIO', '2026-07']] }, NOW)
    expect(v.capital.estado === 'ok' && v.capital.datos.avisos[0]).toContain('Falta CAPITAL_TOPE_MXN')
    expect(v.mensual.estado).toBe('ok')
  })

  it('filas con problema: totales sin esas filas y bloque de problemas', () => {
    const v = construirFinanzas({ MOVIMIENTOS: [...MOVIMIENTOS, fila('MAN-0001', '2026-10-09', 'POS', 'Gasto', 'Herramientas', 'x', '', 99999, 'manual')], PARAMETROS }, NOW)
    expect(v.problemas.map((p) => p.ref)).toEqual(['MAN-0001 (fila 2)', 'MAN-0001 (fila 13)'])
    expect(v.capital.estado === 'ok' && v.capital.datos.porProyecto.POS).toBe(80000)
  })
})

describe('render.mjs y deploy.sh (criterio 7)', () => {
  const template = readFileSync(path.join(__dirname, '..', 'deploy', 'cloudrun', 'service.template.yaml'), 'utf8')
  const ACTUAL = {
    SERVICE_NAME: 'project-os-dashboard', PROJECT_ID: 'project-os-511102', REGION: 'northamerica-south1',
    IMAGE: `us-docker.pkg.dev/project-os-511102/repo/dash@sha256:${'a'.repeat(64)}`,
    RUNTIME_SA: 'runtime@project-os-511102.iam.gserviceaccount.com', SERVICE_URL: 'https://dash.example.com',
    OAUTH_CLIENT_ID: '123-abc.apps.googleusercontent.com', SECRET_VERSION_NEXTAUTH: '1', SECRET_VERSION_OAUTH: '1',
    SECRET_VERSION_ALLOWLIST: '1', WRITE_MODE: 'sheets', WRITE_SERVICE_ACCOUNT: 'writer@project-os-511102.iam.gserviceaccount.com',
    SECRET_VERSION_WRITERS: '1', SECRET_VERSION_GITHUB: '2', SECRET_VERSION_PM_AGENT: '3',
  }
  const LECTURA = { ...ACTUAL, WRITE_MODE: undefined, WRITE_SERVICE_ACCOUNT: undefined, SECRET_VERSION_WRITERS: undefined, SECRET_VERSION_GITHUB: undefined, SECRET_VERSION_PM_AGENT: undefined }
  const linea = `            - name: FINANZAS_SHEET_ID\n              value: '${FINANZAS}'\n`

  it('sin FINANZAS_SHEET_ID (o vacía) el YAML renderizado no cambia', () => {
    for (const base of [ACTUAL, LECTURA, { ...ACTUAL, RADAROS_SHEET_ID: RADAROS }]) {
      const sin = render(template, base)
      expect(sin).not.toContain('FINANZAS')
      expect(render(template, { ...base, FINANZAS_SHEET_ID: '' })).toBe(sin)
      expect(render(template, { ...base, FINANZAS_SHEET_ID: '  ' })).toBe(sin)
    }
  })

  it('con FINANZAS_SHEET_ID válida agrega solo esa variable literal, con o sin escritura y con RADAROS', () => {
    const sin = render(template, ACTUAL)
    expect(render(template, { ...ACTUAL, FINANZAS_SHEET_ID: FINANZAS }).replace(linea, '')).toBe(sin)
    expect(render(template, { ...LECTURA, FINANZAS_SHEET_ID: FINANZAS })).toContain(linea)
    const conEco = render(template, { ...ACTUAL, RADAROS_SHEET_ID: RADAROS })
    expect(render(template, { ...ACTUAL, RADAROS_SHEET_ID: RADAROS, FINANZAS_SHEET_ID: FINANZAS }).replace(linea, '')).toBe(conEco)
  })

  it('formato no válido o igual a la hoja de PROJECT-OS o a la de RADAROS: falla sin imprimir el valor', () => {
    const casos: Array<[Record<string, string>, string, string]> = [
      [{ FINANZAS_SHEET_ID: 'VALOR-SECRETO con espacios' }, 'FINANZAS_SHEET_ID no tiene el formato esperado', 'VALOR-SECRETO'],
      [{ FINANZAS_SHEET_ID: PROPIA }, 'FINANZAS_SHEET_ID no puede ser la hoja de PROJECT-OS', PROPIA],
      [{ FINANZAS_SHEET_ID: RADAROS, RADAROS_SHEET_ID: RADAROS }, 'FINANZAS_SHEET_ID no puede ser la hoja de RADAROS', RADAROS],
    ]
    for (const [extra, mensaje, valor] of casos) {
      let error = ''
      try {
        render(template, { ...ACTUAL, ...extra })
      } catch (e) {
        error = (e as Error).message
      }
      expect(error).toContain(mensaje)
      expect(error).not.toContain(valor)
    }
  })

  // deploy.sh --desde-activa la conserva y --quitar la retira: tests/deploy-script.test.ts (ORD-POS-074).
})
