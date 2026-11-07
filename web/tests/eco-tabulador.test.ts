import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EcoResult } from '@/lib/radaros/data'
import { construirEco } from '@/lib/radaros/eco'
import { COLUMNAS_COTIZACIONES } from '@/lib/radaros/pipeline'
import {
  COLUMNAS_MIGRACION_COTIZACIONES, construirTabulador, costoAterrizado, costoMaximo, datosAmazon, ecoTabuladorHabilitado,
  formatoMxn, fraccionDePuntos, leerParametros, migracionCotizaciones, veredicto,
} from '@/lib/radaros/pipeline-tabulador'
import type { Fila } from '@/lib/radaros/tabla'

/** Tabulador de cotizaciones (ORD-POS-145, DEC-ECO-008, docs/diseno-eco-pipeline.md §14): datos sintéticos, sin red. */

const NOW = Date.UTC(2026, 10, 4, 16, 0, 0)

const PARAMETROS = [
  ['CLAVE', 'VALOR'],
  ['TIPO_CAMBIO_USD_MXN', '18'], ['TIPO_CAMBIO_USD_MXN_FECHA', '2026-11-04'],
  ['IGI_PCT_CN', '20'], ['IGI_PCT_OTRO', '15%'], ['DTA_PCT', '0.8'], ['AGENTE_ADUANAL_REF', '3000'], ['FLETE_CEDIS_REF', '1000'],
]
const p = () => leerParametros(PARAMETROS)

/** Cotización sintética: solo las columnas que se pasan; las demás, vacías (null). */
const cot = (valores: Record<string, string>): Fila => {
  const f: Fila = {}
  for (const c of [...COLUMNAS_COTIZACIONES, ...COLUMNAS_MIGRACION_COTIZACIONES]) f[c] = valores[c] ?? null
  return f
}
const BASE_USD = {
  COTIZACION_ID: 'COT-0001', PRODUCTO_ID: 'PRD-0001', PROVEEDOR_ID: 'PRV-0001', ESTADO: 'RECIBIDA', MONEDA: 'USD',
  PRECIO_UNIT: '1', CANTIDAD_COTIZADA: '600', UNIDADES_POR_SET: '6', TIPO_CAMBIO: '20', TIPO_CAMBIO_FECHA: '2026-11-03',
  FLETE_LOCAL_EXPORT: '50', FLETE_INTERNACIONAL: '100', SEGURO: '10', PAIS_ORIGEN: 'CN', CERTIFICADO_ORIGEN: 'NO',
  AGENTE_ADUANAL: '2000', FLETE_CEDIS: '500', PRECIO_POR: 'PIEZA',
}
const mxn = (c: ReturnType<typeof costoAterrizado>, etiqueta: string) => c.componentes.find((x) => x.etiqueta === etiqueta)?.mxn

describe('costo aterrizado por incoterm (criterios 3 y 7)', () => {
  it('EXW: flete local, flete internacional, seguro, IGI y DTA sobre el valor en aduana, agente y flete al CEDIS', () => {
    const c = costoAterrizado(cot({ ...BASE_USD, INCOTERM: 'EXW' }), p())
    expect(c.base).toBe('EXW')
    // Mercancía 1 × 600 × 20 = 12 000; local 1 000; internacional 2 000; seguro 200 → valor en aduana 15 200.
    expect(c.valorAduanaMxn).toBeCloseTo(15_200)
    expect(mxn(c, 'IGI')).toBeCloseTo(3_040) // 20 % de CN, de PIPE_PARAMETROS
    expect(mxn(c, 'DTA')).toBeCloseTo(121.6) // 0.8 %
    expect(c.totalMxn).toBeCloseTo(20_861.6)
    expect(c.sets).toBe(100)
    expect(c.porSetMxn).toBeCloseTo(208.616)
    expect(c.porConfirmar).toEqual([])
    expect(c.supuestos.sort()).toEqual(['DTA', 'IGI'])
  })

  it('FOB (y FCA, que se trata como FOB): sin flete local', () => {
    const fob = costoAterrizado(cot({ ...BASE_USD, INCOTERM: 'FOB' }), p())
    expect(fob.valorAduanaMxn).toBeCloseTo(14_200)
    expect(fob.totalMxn).toBeCloseTo(14_200 + 2_840 + 113.6 + 2_000 + 500)
    expect(fob.componentes.some((x) => x.clave === 'FLETE_LOCAL_EXPORT')).toBe(false)
    const fca = costoAterrizado(cot({ ...BASE_USD, INCOTERM: 'fca' }), p())
    expect(fca.base).toBe('FOB')
    expect(fca.totalMxn).toBeCloseTo(fob.totalMxn!)
  })

  it('CIF (y DAP, que se trata como CIF más impuestos): IGI, DTA, agente y flete al CEDIS sobre la mercancía', () => {
    const valores = { ...BASE_USD, MONEDA: 'MXN', PRECIO_UNIT: '30', TIPO_CAMBIO: '', CERTIFICADO_ORIGEN: 'NO', PAIS_ORIGEN: 'VN', IGI_PCT: '10', DTA: '', AGENTE_ADUANAL: '' }
    const cif = costoAterrizado(cot({ ...valores, INCOTERM: 'CIF' }), p())
    expect(cif.valorAduanaMxn).toBeCloseTo(18_000)
    expect(mxn(cif, 'IGI')).toBeCloseTo(1_800) // IGI_PCT de la cotización prevalece
    expect(mxn(cif, 'DTA')).toBeCloseTo(144)
    expect(mxn(cif, 'Agente aduanal')).toBe(3_000) // AGENTE_ADUANAL_REF
    expect(cif.totalMxn).toBeCloseTo(18_000 + 1_800 + 144 + 3_000 + 500)
    expect(cif.porSetMxn).toBeCloseTo(234.44)
    const dap = costoAterrizado(cot({ ...valores, INCOTERM: 'DAP' }), p())
    expect(dap.base).toBe('CIF')
    expect(dap.totalMxn).toBeCloseTo(cif.totalMxn!)
  })

  it('DDP: solo el flete al CEDIS, y 0 cuando la cotización ya lo incluye', () => {
    const ddp = costoAterrizado(cot({ ...BASE_USD, MONEDA: 'MXN', PRECIO_UNIT: '40', INCOTERM: 'DDP', FLETE_CEDIS: '0' }), p())
    expect(ddp.componentes.map((x) => x.etiqueta)).toEqual(['Mercancía', 'Flete al CEDIS'])
    expect(ddp.totalMxn).toBe(24_000)
    expect(ddp.porSetMxn).toBe(240)
    const sinCedis = costoAterrizado(cot({ ...BASE_USD, MONEDA: 'MXN', PRECIO_UNIT: '40', INCOTERM: 'DDP', FLETE_CEDIS: '' }), p())
    expect(mxn(sinCedis, 'Flete al CEDIS')).toBe(1_000)
    expect(sinCedis.supuestos).toEqual(['Flete al CEDIS'])
  })

  it('certificado de origen SI → IGI 0, aunque el país tenga IGI', () => {
    const c = costoAterrizado(cot({ ...BASE_USD, INCOTERM: 'FOB', CERTIFICADO_ORIGEN: 'SI', IGI_PCT: '20' }), p())
    expect(mxn(c, 'IGI')).toBe(0)
    expect(c.componentes.find((x) => x.etiqueta === 'IGI')!.origen).toBe('COTIZACION')
  })

  it('parámetro vacío en la cotización → se usa PIPE_PARAMETROS y se marca SUPUESTO', () => {
    const c = costoAterrizado(cot({ ...BASE_USD, INCOTERM: 'FOB', TIPO_CAMBIO: '', AGENTE_ADUANAL: '' }), p())
    expect(c.tipoCambio).toEqual({ valor: 18, fecha: '2026-11-04', origen: 'SUPUESTO' })
    expect(c.supuestos).toEqual(expect.arrayContaining(['Tipo de cambio', 'Agente aduanal']))
    expect(c.componentes.find((x) => x.etiqueta === 'Mercancía')!.origen).toBe('SUPUESTO')
    expect(c.componentes.find((x) => x.etiqueta === 'Agente aduanal')).toMatchObject({ mxn: 3_000, origen: 'SUPUESTO' })
    // Certificado vacío: se supone NO (paga IGI) y se marca.
    const sinCert = costoAterrizado(cot({ ...BASE_USD, INCOTERM: 'FOB', CERTIFICADO_ORIGEN: '' }), p())
    expect(sinCert.supuestos).toContain('Certificado de origen (se supone NO)')
    expect(mxn(sinCert, 'IGI')).toBeCloseTo(2_840)
  })

  it('un componente faltante nunca vale 0: el total queda «Por confirmar» (criterio 6)', () => {
    const sinParametros = leerParametros(undefined)
    const c = costoAterrizado(cot({ ...BASE_USD, INCOTERM: 'FOB', SEGURO: '', AGENTE_ADUANAL: '' }), sinParametros)
    expect(c.totalMxn).toBeNull()
    expect(c.porSetMxn).toBeNull()
    expect(c.componentes.find((x) => x.etiqueta === 'Seguro')).toMatchObject({ mxn: null, origen: 'POR_CONFIRMAR' })
    expect(c.porConfirmar.join(' ')).toContain('AGENTE_ADUANAL vacío y sin AGENTE_ADUANAL_REF')
    expect(formatoMxn(c.totalMxn)).toBe('Por confirmar')
    expect(costoAterrizado(cot({ ...BASE_USD, INCOTERM: 'FOB', UNIDADES_POR_SET: '' }), p()).porSetMxn).toBeNull()
    expect(costoAterrizado(cot({ ...BASE_USD, INCOTERM: 'OTRO' }), p()).porConfirmar).toContain('INCOTERM «OTRO» no es EXW, FCA, FOB, CIF, DAP ni DDP')
    expect(costoAterrizado(cot({ ...BASE_USD, INCOTERM: 'FOB', MONEDA: 'EUR' }), p()).totalMxn).toBeNull()
    const texto = costoAterrizado(cot({ ...BASE_USD, INCOTERM: 'FOB', SEGURO: '1,000.50' }), p())
    expect(texto.totalMxn).toBeNull()
    expect(texto.avisos.join(' ')).toContain('SEGURO no es un número')
  })

  it('porcentajes en puntos, con o sin %; fuera de 0..100 o texto, vacío', () => {
    expect(fraccionDePuntos('25')).toBe(0.25)
    expect(fraccionDePuntos('0.8 %')).toBeCloseTo(0.008)
    expect(fraccionDePuntos('0,8')).toBeCloseTo(0.008)
    expect(fraccionDePuntos('120')).toBeNull()
    expect(fraccionDePuntos('x')).toBeNull()
    expect(fraccionDePuntos(null)).toBeNull()
  })
})

const UE = [
  ['IDEA_ID', 'AMZ_PRECIO_MXN', 'AMZ_COMISION_MXN', 'AMZ_FBA_MXN', 'AMZ_TARIFAS_FECHA'],
  ['EC-006', '249.99', '37.5', '50', '2026-10-30'],
  ['EC-015', '', '', '', ''],
]
const RESUMEN = [
  ['SEMANA', 'IDEA_ID', 'ESTADO', 'PRECIO_MXN', 'COMISION_PCT', 'FBA_MXN', 'TARIFAS_FECHA'],
  ['2026-W43', 'EC-015', 'OK', '300', '0.15', '60', '2026-10-20'],
  ['2026-W44', 'EC-015', 'OK', '329', '0.15', '62', '2026-10-27'],
  ['2026-W45', 'EC-015', 'ERROR', '1', '0.15', '1', '2026-11-03'],
]

describe('COSTO_MAX_MXN (criterio 4)', () => {
  it('precio − comisión − FBA − 15 % − 8 % − 25 % del mismo precio, con la fecha de sus datos', () => {
    const m = costoMaximo('EC-006', datosAmazon({ UNIT_ECONOMICS: UE }), leerParametros(undefined))
    expect(m.mxn).toBeCloseTo(249.99 - 37.5 - 50 - 0.48 * 249.99)
    expect(m.precio).toEqual({ mxn: 249.99, fuente: 'UNIT_ECONOMICS' })
    expect(m.fecha).toBe('2026-10-30')
    expect(m.porcentajes).toEqual({ ppc: 0.15, devoluciones: 0.08, margenK2: 0.25 })
  })

  it('sin precio en UNIT_ECONOMICS: el de AMZ_RESUMEN de la última semana OK, con su fecha y la comisión en porcentaje', () => {
    const m = costoMaximo('EC-015', datosAmazon({ UNIT_ECONOMICS: UE, AMZ_RESUMEN: RESUMEN }), leerParametros([['CLAVE', 'VALOR'], ['MARGEN_K2_PCT', '30']]))
    expect(m.precio).toEqual({ mxn: 329, fuente: 'AMZ_RESUMEN' })
    expect(m.fecha).toBe('2026-10-27')
    expect(m.comisionMxn).toBeCloseTo(49.35)
    expect(m.mxn).toBeCloseTo(329 - 49.35 - 62 - (0.15 + 0.08 + 0.3) * 329)
  })

  it('sin precio, sin idea o sin tarifas: «Por confirmar», nunca 0', () => {
    expect(costoMaximo(null, datosAmazon({}), p()).mxn).toBeNull()
    const sin = costoMaximo('EC-015', datosAmazon({ UNIT_ECONOMICS: UE }), p())
    expect(sin.mxn).toBeNull()
    expect(sin.fecha).toBe('sin fecha')
    expect(sin.porConfirmar[0]).toContain('Sin precio de venta de EC-015')
    const sinFecha = costoMaximo('EC-006', datosAmazon({ UNIT_ECONOMICS: [['IDEA_ID', 'AMZ_PRECIO_MXN', 'AMZ_COMISION_MXN', 'AMZ_FBA_MXN'], ['EC-006', '100', '10', '10']] }), p())
    expect(sinFecha.fecha).toBe('sin fecha')
    expect(veredicto(null)).toBe('Por confirmar')
  })
})

describe('migración de PIPE_COTIZACIONES (criterios 1 y 7)', () => {
  const ACTUAL = [...COLUMNAS_COTIZACIONES]

  it('agrega las 17 columnas al final (PRECIO_POR de ORD-POS-147 y luego EVIDENCIA_URL y PRECIO_HISTORIAL de ORD-POS-149), después de VERSION, sin tocar las existentes', () => {
    const m = migracionCotizaciones(ACTUAL)
    expect(m.faltan).toEqual([...COLUMNAS_MIGRACION_COTIZACIONES])
    expect(m.encabezado.slice(0, ACTUAL.length)).toEqual(ACTUAL)
    expect(m.encabezado[ACTUAL.length - 1]).toBe('VERSION')
    expect(m.encabezado).toHaveLength(ACTUAL.length + 17)
    expect(m.encabezado.slice(-3)).toEqual(['PRECIO_POR', 'EVIDENCIA_URL', 'PRECIO_HISTORIAL'])
    // Con la migración de ORD-POS-145 ya aplicada, solo faltan PRECIO_POR y las de ORD-POS-149, al final.
    const de145 = migracionCotizaciones([...ACTUAL, ...COLUMNAS_MIGRACION_COTIZACIONES.slice(0, 14)])
    expect(de145.faltan).toEqual(['PRECIO_POR', 'EVIDENCIA_URL', 'PRECIO_HISTORIAL'])
    expect(m.sinVersion).toBe(false)
  })

  it('idempotente: aplicada sobre su resultado no agrega nada, ni con celdas vacías de cola', () => {
    const una = migracionCotizaciones(ACTUAL)
    const dos = migracionCotizaciones(una.encabezado)
    expect(dos.faltan).toEqual([])
    expect(dos.encabezado).toEqual(una.encabezado)
    expect(migracionCotizaciones([...una.encabezado, '', null]).encabezado).toEqual(una.encabezado)
  })

  it('parcial: solo agrega las que faltan; avisa encabezados repetidos y falta de VERSION', () => {
    const m = migracionCotizaciones([...ACTUAL, 'PAIS_ORIGEN', 'SEGURO'])
    expect(m.faltan).not.toContain('PAIS_ORIGEN')
    expect(m.faltan).toHaveLength(15)
    expect(migracionCotizaciones(['COTIZACION_ID', 'ESTADO', 'ESTADO']).repetidos).toEqual(['ESTADO'])
    expect(migracionCotizaciones(['COTIZACION_ID']).sinVersion).toBe(true)
  })

  it('antes de la migración la lectura sigue: las columnas nuevas quedan vacías y el total «Por confirmar»', () => {
    const tab = construirTabulador({ PIPE_COTIZACIONES: [ACTUAL, ['COT-0001', 'PRD-0001', 'PRV-0001', 'SOLICITADA']] })
    expect(tab.migracion?.faltan).toHaveLength(17)
    const cmp = tab.comparar('PRD-0001', null)
    expect(cmp.filas[0]!.costo.totalMxn).toBeNull()
  })
})

const encabezado = [...COLUMNAS_COTIZACIONES, ...COLUMNAS_MIGRACION_COTIZACIONES]
const fila = (v: Record<string, string>) => encabezado.map((c) => v[c] ?? '')
const RAW = {
  PIPE_PRODUCTOS: [
    ['PRODUCTO_ID', 'NOMBRE', 'IDEA_ID', 'ETAPA', 'ETAPA_DESDE', 'COSTO_MAX_MXN', 'VERSION'],
    ['PRD-0001', 'Set sintético', 'EC-006', 'COTIZANDO', '2026-11-01T09:00:00-06:00', '60', '1'],
  ],
  PIPE_PROVEEDORES: [['PROVEEDOR_ID', 'NOMBRE', 'PAIS', 'ESTADO'], ['PRV-0001', 'Proveedor sintético', 'CN', 'ACTIVO']],
  PIPE_COTIZACIONES: [
    encabezado,
    fila({ ...BASE_USD, COTIZACION_ID: 'COT-0001', INCOTERM: 'EXW', MOQ: '600' }),
    fila({ ...BASE_USD, COTIZACION_ID: 'COT-0002', INCOTERM: 'DDP', MONEDA: 'MXN', PRECIO_UNIT: '5', FLETE_CEDIS: '0', MOQ: '6000', ESTADO: 'RECIBIDA', NOTAS: 'parcial' }),
    fila({ ...BASE_USD, COTIZACION_ID: 'COT-0003', INCOTERM: 'FOB', SEGURO: '', ESTADO: 'ELEGIDA' }),
    fila({ ...BASE_USD, COTIZACION_ID: 'COT-0004', INCOTERM: 'DDP', MONEDA: 'MXN', PRECIO_UNIT: '1', FLETE_CEDIS: '0', ESTADO: 'RECHAZADA' }),
    fila({ ...BASE_USD, COTIZACION_ID: 'COT-0005', INCOTERM: 'DDP', MONEDA: 'MXN', PRECIO_UNIT: '2', FLETE_CEDIS: '0', ESTADO: 'DESCARTADA' }),
  ],
  PIPE_PARAMETROS: PARAMETROS,
  UNIT_ECONOMICS: UE,
}

describe('vista «Comparar» (criterios 5 y 6)', () => {
  it('ordenada por costo aterrizado; «Por confirmar» y RECHAZADA (o la antigua DESCARTADA) al final; cumple, no cumple y capital del primer lote', () => {
    const cmp = construirTabulador(RAW).comparar('PRD-0001', 'EC-006')
    expect(cmp.filas.map((f) => f.id)).toEqual(['COT-0002', 'COT-0001', 'COT-0003', 'COT-0004', 'COT-0005'])
    const [ddp, exw, fob] = cmp.filas
    expect(ddp!.costo.porSetMxn).toBe(30) // 5 × 6, flete incluido
    expect(veredicto(ddp!.diferenciaMxn)).toBe('Cumple')
    expect(veredicto(exw!.diferenciaMxn)).toMatch(/^No cumple por 1[\d,]+\.\d{2} MXN$/)
    // ORD-POS-147 (criterio 3): capital = CANTIDAD_COTIZADA × costo; el MOQ solo da el «mínimo del proveedor».
    expect(ddp!.capitalPrimerLoteMxn).toBe(3_000) // 600 piezas × 5
    expect(ddp!.minimoProveedorMxn).toBe(30_000) // MOQ 6 000 × 5 = tope exacto
    expect(ddp!.setsEnTope).toBe(1_000) // 30 000 ÷ 30 por set
    expect(exw!.capitalPrimerLoteMxn).toBeCloseTo(20_861.6)
    expect(fob!.costo.porSetMxn).toBeNull()
    expect(fob!.diferenciaMxn).toBeNull()
    expect(ddp!.estadoValido).toBe(true)
    // ORD-POS-146 (criterio 4): una sola lista; ELEGIDA y RECHAZADA son válidas y la antigua DESCARTADA no (no se reescribe).
    expect(fob!.estadoValido).toBe(true)
    expect(cmp.filas[3]!.estadoValido).toBe(true)
    expect(cmp.filas[4]!.estadoValido).toBe(false)
    expect(exw!.proveedor).toBe('Proveedor sintético')
  })

  it('COSTO_ATERRIZADO_MXN (manual) no se usa ni se toca; COSTO_ATERRIZADO_CALC_MXN de la hoja se compara', () => {
    const raw = { ...RAW, PIPE_COTIZACIONES: [encabezado, fila({ ...BASE_USD, INCOTERM: 'DDP', MONEDA: 'MXN', PRECIO_UNIT: '5', FLETE_CEDIS: '0', COSTO_ATERRIZADO_MXN: '999', COSTO_ATERRIZADO_CALC_MXN: '31' })] }
    const [f] = construirTabulador(raw).comparar('PRD-0001', 'EC-006').filas
    expect(f!.costo.porSetMxn).toBe(30)
    expect(f!.calcHoja).toEqual({ valor: '31', difiere: false })
  })
})

const estado = vi.hoisted(() => ({ result: null as unknown }))
vi.mock('@/lib/page-data', () => ({ privateEco: async () => ({ user: { email: 'lector@example.com' }, result: estado.result }) }))
vi.mock('@/components/operations/write-access', () => ({ writeAccess: () => ({ allowed: false }) }))

const { default: PipelinePage } = await import('@/app/(private)/eco/pipeline/page')

async function html(search: Record<string, string>) {
  estado.result = { estado: 'ok', vista: construirEco(RAW, NOW), fetchedAt: NOW } satisfies EcoResult
  return renderToStaticMarkup(await PipelinePage({ searchParams: Promise.resolve(search) }))
}

describe('bandera ECO_TABULADOR (criterio 7)', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('solo true exacto la enciende', () => {
    for (const v of [undefined, '', 'TRUE', '1', 'true ']) expect(ecoTabuladorHabilitado({ ECO_TABULADOR: v } as unknown as NodeJS.ProcessEnv)).toBe(false)
    expect(ecoTabuladorHabilitado({ ECO_TABULADOR: 'true' } as unknown as NodeJS.ProcessEnv)).toBe(true)
  })

  it('apagada: la vista «Comparar» y el desglose no se muestran, aunque llegue ?comparar=', async () => {
    vi.stubEnv('ECO_TABULADOR', '')
    const h = await html({ comparar: 'PRD-0001' })
    expect(h).toContain('Compras por producto')
    expect(h).not.toContain('Comparar cotizaciones')
    expect(h).not.toContain('Desglose de')
    expect(h).toContain('Tabulador apagado (ECO_TABULADOR): no calcula costos')
  })

  it('encendida: comparación del producto con costo máximo, fecha, veredicto y desglose', async () => {
    vi.stubEnv('ECO_TABULADOR', 'true')
    const h = await html({ comparar: 'PRD-0001' })
    expect(h).toContain('Comparar cotizaciones')
    expect(h).toContain('Fecha de sus datos')
    expect(h).toContain('2026-10-30')
    expect(h).toContain('Cumple')
    expect(h).toContain('No cumple por')
    expect(h).toContain('Desglose de COT-0001')
    expect(h).toContain('Por confirmar')
    expect(h).toContain('SUPUESTO')
    expect(h).toContain('Estado no válido')
    expect(h).toContain('IVA de importación no entra')
  })
})
