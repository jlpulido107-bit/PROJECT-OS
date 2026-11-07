import { readFileSync } from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OperationError } from '@/lib/operations/errors'
import type { EcoResult } from '@/lib/radaros/data'
import { construirEco } from '@/lib/radaros/eco'
import { COLUMNAS_COTIZACIONES } from '@/lib/radaros/pipeline'
import { CAMPOS, COLUMNAS_OPCIONALES, parseEco } from '@/lib/radaros/pipeline-escritura-validacion'
import { CASILLA_ENTREGA_CEDIS, etiquetaCampo, reglaEntregaCedis } from '@/lib/radaros/pipeline-formularios'
import { COLUMNAS_TABLA_B, confirmable, parsearTablaGemini, revisarBorrador, type ContextoPegado } from '@/lib/radaros/pipeline-pegado'
import {
  COLUMNAS_MIGRACION_COTIZACIONES, construirTabulador, costoAterrizado, leerParametros, migracionCotizaciones, PRECIOS_POR,
  TOPE_CAPITAL_MXN,
} from '@/lib/radaros/pipeline-tabulador'
import type { Fila } from '@/lib/radaros/tabla'

/**
 * ORD-POS-147 (POS-050; docs/diseno-eco-pipeline.md §14.7): precio por pieza o por set, DDP con entrega en el CEDIS y
 * capital del primer lote con la cantidad cotizada. Datos sintéticos (el «Sandes» del issue reproducido con números
 * inventados del mismo orden), sin red.
 */

const NOW = Date.UTC(2026, 10, 5, 16, 0, 0)
const SIN_PARAMETROS = leerParametros([['CLAVE', 'VALOR']])
const CON_REF = leerParametros([['CLAVE', 'VALOR'], ['FLETE_CEDIS_REF', '1500']])
const COLS = [...COLUMNAS_COTIZACIONES, ...COLUMNAS_MIGRACION_COTIZACIONES]
const cot = (v: Record<string, string>): Fila => Object.fromEntries(COLS.map((c) => [c, v[c] ?? null]))

/** Sandes: 12.76 USD por set, 500 sets cotizados, DDP con entrega incluida, MOQ de 10 sets. TC 15.44 → ~197 MXN por set. */
const SANDES = {
  COTIZACION_ID: 'COT-0004', PRODUCTO_ID: 'PRD-0003', PROVEEDOR_ID: 'PRV-0001', ESTADO: 'RECIBIDA', MONEDA: 'USD', INCOTERM: 'DDP',
  PRECIO_UNIT: '12.76', PRECIO_POR: 'SET', CANTIDAD_COTIZADA: '500', MOQ: '10', TIPO_CAMBIO: '15.44', FLETE_CEDIS: '0', UNIDADES_POR_SET: '6',
}
const POR_SET = 12.76 * 15.44

describe('criterio 1: el precio es por pieza o por set', () => {
  it('migración explícita: PRECIO_POR va al final de PIPE_COTIZACIONES y la escritura solo la admite si la fila 1 la tiene', () => {
    // PRECIO_POR va justo después de COSTO_ATERRIZADO_CALC_MXN; ORD-POS-149 agrega EVIDENCIA_URL y PRECIO_HISTORIAL detrás.
    expect(COLUMNAS_MIGRACION_COTIZACIONES[14]).toBe('PRECIO_POR')
    expect(COLUMNAS_OPCIONALES.PIPE_COTIZACIONES).toContain('PRECIO_POR')
    const aplicada145 = [...COLUMNAS_COTIZACIONES, ...COLUMNAS_MIGRACION_COTIZACIONES.slice(0, 14)]
    expect(migracionCotizaciones(aplicada145)).toMatchObject({ faltan: ['PRECIO_POR', 'EVIDENCIA_URL', 'PRECIO_HISTORIAL'], encabezado: [...aplicada145, 'PRECIO_POR', 'EVIDENCIA_URL', 'PRECIO_HISTORIAL'] })
    expect(migracionCotizaciones([...aplicada145, 'PRECIO_POR', 'EVIDENCIA_URL', 'PRECIO_HISTORIAL']).faltan).toEqual([])
  })

  it('con «set», 12.76 USD × 500 sets da 12.76 × TC por set, sin tocar UNIDADES_POR_SET', () => {
    for (const ups of ['6', '1', '']) {
      const c = costoAterrizado(cot({ ...SANDES, UNIDADES_POR_SET: ups }), SIN_PARAMETROS)
      expect(c.unidad, ups).toBe('SET')
      expect(c.sets, ups).toBe(500)
      expect(c.porSetMxn, ups).toBeCloseTo(POR_SET)
      expect(c.porUnidadPrecioMxn, ups).toBeCloseTo(POR_SET)
      expect(c.porConfirmar, ups).toEqual([])
      expect(c.componentes[0]!.detalle, ups).toBe('12.76 USD × 500 sets × 15.44')
    }
    // Por pieza, con 6 piezas por set: el costo por set es 6 veces el de la pieza (lo que antes salía por error).
    const pieza = costoAterrizado(cot({ ...SANDES, PRECIO_POR: 'PIEZA' }), SIN_PARAMETROS)
    expect(pieza.porSetMxn).toBeCloseTo(POR_SET * 6)
    expect(pieza.porUnidadMxn).toBeCloseTo(POR_SET)
    // En minúsculas también vale; otro texto deja el costo por set «Por confirmar» y lo dice.
    expect(costoAterrizado(cot({ ...SANDES, PRECIO_POR: ' set ' }), SIN_PARAMETROS).porSetMxn).toBeCloseTo(POR_SET)
    const raro = costoAterrizado(cot({ ...SANDES, PRECIO_POR: 'CAJA' }), SIN_PARAMETROS)
    expect(raro.porSetMxn).toBeNull()
    expect(raro.porConfirmar).toContain('PRECIO_POR «CAJA» no es PIEZA ni SET')
  })

  it('una fila anterior sin PRECIO_POR se lee por pieza, como antes, y se marca SUPUESTO (no se reescribe)', () => {
    const vieja = costoAterrizado(cot({ ...SANDES, PRECIO_POR: '', UNIDADES_POR_SET: '1' }), SIN_PARAMETROS)
    expect(vieja.unidad).toBe('PIEZA')
    expect(vieja.supuestos).toContain('Precio por pieza (PRECIO_POR vacío)')
    expect(vieja.porSetMxn).toBeCloseTo(POR_SET) // el arreglo manual (UNIDADES_POR_SET = 1) sigue dando lo mismo
  })

  it('el formulario lo pide como obligatorio («El precio es por»), solo PIEZA o SET; el servidor lo repite', () => {
    const campo = CAMPOS['eco.cotizacion.crear'].find((c) => c.clave === 'precioPor')!
    expect(campo).toMatchObject({ columna: 'PRECIO_POR', obligatorio: true, etiqueta: 'El precio es por', tipo: { k: 'lista', valores: PRECIOS_POR } })
    expect([...PRECIOS_POR]).toEqual(['PIEZA', 'SET'])
    const base = { requestId: crypto.randomUUID(), productoId: 'PRD-0003', proveedorId: 'PRV-0001' }
    const error = (body: Record<string, unknown>) => {
      try {
        parseEco('eco.cotizacion.crear', body)
      } catch (e) {
        return (e as OperationError).fields
      }
      return null
    }
    expect(error(base)).toMatchObject({ precioPor: 'Obligatorio.' })
    expect(error({ ...base, precioPor: 'CAJA' })).toMatchObject({ precioPor: 'Uno de: PIEZA, SET.' })
    expect(parseEco('eco.cotizacion.crear', { ...base, precioPor: 'SET' }).valores.PRECIO_POR).toBe('SET')
  })
})

describe('criterio 2: DDP con entrega en el CEDIS de Amazon', () => {
  it('con la casilla marcada guarda FLETE_CEDIS = 0; sin ella pide el monto o usa FLETE_CEDIS_REF', () => {
    const ddp = { incoterm: 'DDP', fleteCedis: '' }
    expect(reglaEntregaCedis({ ...ddp, [CASILLA_ENTREGA_CEDIS]: 'SI' }, null)).toEqual({ valores: { incoterm: 'DDP', fleteCedis: '0' }, errores: {} })
    expect(reglaEntregaCedis({ ...ddp, fleteCedis: '0', [CASILLA_ENTREGA_CEDIS]: 'SI' }, null).errores).toEqual({})
    expect(reglaEntregaCedis({ ...ddp, fleteCedis: '800', [CASILLA_ENTREGA_CEDIS]: 'SI' }, null).errores.fleteCedis).toMatch(/FLETE_CEDIS es 0/)
    expect(reglaEntregaCedis(ddp, null).errores.fleteCedis).toMatch(/escribe el flete al CEDIS.*o marca «Incluye entrega en CEDIS Amazon»/)
    expect(reglaEntregaCedis(ddp, 1500)).toEqual({ valores: ddp, errores: {} }) // el tabulador usará FLETE_CEDIS_REF (SUPUESTO)
    expect(reglaEntregaCedis({ ...ddp, fleteCedis: '800' }, null)).toEqual({ valores: { ...ddp, fleteCedis: '800' }, errores: {} })
    // Fuera de DDP la casilla no se adivina; sin DDP no cambia nada.
    expect(reglaEntregaCedis({ incoterm: 'FOB', [CASILLA_ENTREGA_CEDIS]: 'SI' }, null).errores[CASILLA_ENTREGA_CEDIS]).toBe('Solo con INCOTERM DDP.')
    expect(reglaEntregaCedis({ incoterm: 'FOB', fleteCedis: '' }, null).errores).toEqual({})
    // La casilla nunca va al cuerpo: no es columna.
    expect(CAMPOS['eco.cotizacion.crear'].some((c) => c.clave === CASILLA_ENTREGA_CEDIS)).toBe(false)
  })

  it('DDP con la casilla marcada no queda «Por confirmar» por el flete, aunque no haya FLETE_CEDIS_REF', () => {
    const { valores } = reglaEntregaCedis({ incoterm: 'DDP', fleteCedis: '', [CASILLA_ENTREGA_CEDIS]: 'SI' }, null)
    const c = costoAterrizado(cot({ ...SANDES, FLETE_CEDIS: valores.fleteCedis! }), SIN_PARAMETROS)
    expect(c.componentes.find((x) => x.etiqueta === 'Flete al CEDIS')).toMatchObject({ mxn: 0, origen: 'COTIZACION' })
    expect(c.totalMxn).not.toBeNull()
    expect(c.porConfirmar).toEqual([])
    // Sin la casilla ni el monto ni el parámetro, sí queda «Por confirmar» (por eso el formulario lo pide).
    expect(costoAterrizado(cot({ ...SANDES, FLETE_CEDIS: '' }), SIN_PARAMETROS).totalMxn).toBeNull()
    expect(costoAterrizado(cot({ ...SANDES, FLETE_CEDIS: '' }), CON_REF).totalMxn).toBeCloseTo(POR_SET * 500 + 1500)
  })

  it('aplica también al pegado de la tabla de Gemini (con columnas opcionales PRECIO_POR e INCLUYE_ENTREGA_CEDIS)', () => {
    const ctx = (fleteCedisRef: number | null): ContextoPegado => ({
      campos: CAMPOS['eco.cotizacion.crear'], fleteCedisRef,
      productos: [{ id: 'PRD-0003', ideaId: 'EC-006', etapa: 'COTIZANDO' }],
      proveedores: [{ id: 'PRV-0001', nombre: 'Sandes Sintético' }],
      cotizaciones: [],
    })
    const enc = [...COLUMNAS_TABLA_B, 'PRECIO_POR', 'CANTIDAD_COTIZADA', 'INCLUYE_ENTREGA_CEDIS']
    const fila = (incoterm: string, precioPor: string, incluye: string) => {
      const v: Record<string, string> = {
        'PRD / EC': 'PRD-0003', 'PROVEEDOR (empresa)': 'Sandes Sintético', ESTADO: 'RECIBIDA', FECHA_RECIBIDA: '2026-11-04', PRECIO_UNIT: '12.76',
        MONEDA: 'USD', MOQ: '10', PLAZO_PRODUCCION_DIAS: '15', INCOTERM: incoterm, PRECIO_POR: precioPor, CANTIDAD_COTIZADA: '500',
        INCLUYE_ENTREGA_CEDIS: incluye,
      }
      return `| ${enc.map((c) => v[c] ?? '').join(' | ')} |`
    }
    const texto = [`| ${enc.join(' | ')} |`, fila('DDP', 'por set', 'Sí'), fila('DDP', 'pcs', ''), fila('FOB', 'Set', 'SI')].join('\n')
    const [incluida, sinCasilla, fob] = parsearTablaGemini(texto, ctx(null)).borradores
    expect(incluida!.valores).toMatchObject({ precioPor: 'SET', cantidadCotizada: '500', [CASILLA_ENTREGA_CEDIS]: 'SI' })
    expect(incluida!.errores).toEqual({})
    expect(confirmable(incluida!)).toBe(true)
    expect(reglaEntregaCedis(incluida!.valores, null).valores.fleteCedis).toBe('0') // lo que se envía al confirmar
    expect(sinCasilla!.valores.precioPor).toBe('PIEZA')
    expect(sinCasilla!.errores.fleteCedis).toMatch(/Incluye entrega en CEDIS Amazon/)
    expect(fob!.errores[CASILLA_ENTREGA_CEDIS]).toBe('Solo con INCOTERM DDP.')
    // Con FLETE_CEDIS_REF, la fila DDP sin casilla ya se puede confirmar (SUPUESTO en el tabulador).
    expect(revisarBorrador(sinCasilla!.valores, ctx(1500)).errores).toEqual({})
    // La pantalla del pegado envía lo que devuelve la regla, no la casilla.
    const src = readFileSync(path.join(__dirname, '..', 'src', 'components', 'eco', 'pegar-gemini.tsx'), 'utf8')
    expect(src).toMatch(/const aEnviar = reglaEntregaCedis\(valores, contexto\.fleteCedisRef \?\? null\)\.valores\n\s+const res = await enviar\('\/api\/eco\/pipeline\/cotizaciones', 'POST', cuerpo\(contexto\.campos, aEnviar/)
  })
})

describe('criterio 3: capital del primer lote = CANTIDAD_COTIZADA × costo aterrizado', () => {
  const raw = (filas: Record<string, string>[]) => ({
    PIPE_PRODUCTOS: [['PRODUCTO_ID', 'NOMBRE', 'IDEA_ID', 'ETAPA', 'ETAPA_DESDE', 'VERSION'], ['PRD-0003', 'Soporte sintético', 'EC-006', 'COTIZANDO', '2026-11-01T09:00:00-06:00', '1']],
    PIPE_PROVEEDORES: [['PROVEEDOR_ID', 'NOMBRE', 'PAIS', 'ESTADO'], ['PRV-0001', 'Sandes Sintético', 'CN', 'ACTIVO']],
    PIPE_COTIZACIONES: [COLS, ...filas.map((v) => COLS.map((c) => v[c] ?? ''))],
    PIPE_PARAMETROS: [['CLAVE', 'VALOR']],
  })

  it('Sandes: 500 sets × ~197 MXN excede el tope; el MOQ solo da el «mínimo del proveedor»; y los sets que caben', () => {
    const [f] = construirTabulador(raw([SANDES])).comparar('PRD-0003', null).filas
    expect(f!.costo.porSetMxn).toBeCloseTo(197.01, 2)
    expect(f!.capitalPrimerLoteMxn).toBeCloseTo(500 * POR_SET) // ~98 506 MXN
    expect(f!.capitalPrimerLoteMxn!).toBeGreaterThan(TOPE_CAPITAL_MXN)
    expect(f!.minimoProveedorMxn).toBeCloseTo(10 * POR_SET) // ~1 970 MXN: lo que antes se mostraba como capital
    expect(f!.setsEnTope).toBe(Math.floor(TOPE_CAPITAL_MXN / POR_SET)) // 152
  })

  it('cantidad vacía: capital «Por confirmar»; nunca usa el MOQ en su lugar', () => {
    const [f] = construirTabulador(raw([{ ...SANDES, CANTIDAD_COTIZADA: '' }])).comparar('PRD-0003', null).filas
    expect(f!.capitalPrimerLoteMxn).toBeNull()
    expect(f!.costo.porSetMxn).toBeNull()
    expect(f!.minimoProveedorMxn).toBeNull()
  })

  it('por pieza: capital = piezas cotizadas × costo por pieza (el total del lote), mínimo = MOQ en piezas × costo por pieza', () => {
    const [f] = construirTabulador(raw([{ ...SANDES, PRECIO_UNIT: '2', PRECIO_POR: 'PIEZA', CANTIDAD_COTIZADA: '3000', MOQ: '600' }])).comparar('PRD-0003', null).filas
    expect(f!.capitalPrimerLoteMxn).toBeCloseTo(3000 * 2 * 15.44)
    expect(f!.minimoProveedorMxn).toBeCloseTo(600 * 2 * 15.44)
    expect(f!.costo.porSetMxn).toBeCloseTo(6 * 2 * 15.44)
    expect(f!.setsEnTope).toBe(Math.floor(TOPE_CAPITAL_MXN / (12 * 15.44)))
  })
})

describe('criterio 4: MOQ y cantidad en la unidad elegida, con su etiqueta', () => {
  it('la etiqueta del formulario sigue a «El precio es por»', () => {
    const campo = (col: string) => CAMPOS['eco.cotizacion.crear'].find((c) => c.columna === col)!
    expect(etiquetaCampo(campo('MOQ'), 'SET')).toBe('MOQ (sets)')
    expect(etiquetaCampo(campo('CANTIDAD_COTIZADA'), 'PIEZA')).toBe('CANTIDAD_COTIZADA (piezas)')
    expect(etiquetaCampo(campo('MOQ'), '')).toBe('MOQ (en la unidad de «El precio es por»)')
    expect(etiquetaCampo(campo('PRECIO_POR'), 'SET')).toBe('El precio es por (PRECIO_POR)')
    expect(etiquetaCampo(campo('PRECIO_UNIT'), 'SET')).toBe('PRECIO_UNIT')
  })
})

const estado = vi.hoisted(() => ({ result: null as unknown }))
vi.mock('@/lib/page-data', () => ({ privateEco: async () => ({ user: { email: 'lector@example.com' }, result: estado.result }) }))
vi.mock('@/components/operations/write-access', () => ({ writeAccess: () => ({ allowed: false }) }))
const { default: PipelinePage } = await import('@/app/(private)/eco/pipeline/page')

describe('pantalla «Comparar» (criterios 3 y 4)', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('muestra «Excede», el mínimo del proveedor, los sets que caben y MOQ y cantidad en sets', async () => {
    vi.stubEnv('ECO_TABULADOR', 'true')
    const libro = {
      PIPE_PRODUCTOS: [['PRODUCTO_ID', 'NOMBRE', 'IDEA_ID', 'ETAPA', 'ETAPA_DESDE', 'VERSION'], ['PRD-0003', 'Soporte sintético', 'EC-006', 'COTIZANDO', '2026-11-01T09:00:00-06:00', '1']],
      PIPE_PROVEEDORES: [['PROVEEDOR_ID', 'NOMBRE', 'PAIS', 'ESTADO'], ['PRV-0001', 'Sandes Sintético', 'CN', 'ACTIVO']],
      PIPE_COTIZACIONES: [COLS, COLS.map((c) => (SANDES as Record<string, string>)[c] ?? '')],
      PIPE_PARAMETROS: [['CLAVE', 'VALOR']],
    }
    estado.result = { estado: 'ok', vista: construirEco(libro as unknown as Parameters<typeof construirEco>[0], NOW), fetchedAt: NOW } satisfies EcoResult
    const h = renderToStaticMarkup(await PipelinePage({ searchParams: Promise.resolve({ comparar: 'PRD-0003' }) }))
    for (const t of ['Mínimo del proveedor (MXN)', 'Sets que caben en el tope', 'Precio por', '10 sets', '500 sets', 'Excede por', '152']) expect(h, t).toContain(t)
    expect(h).not.toContain('Dentro del tope')
  })
})
