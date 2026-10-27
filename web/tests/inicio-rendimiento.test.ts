import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TableroInicio } from '@/components/inicio/tablero'
import { construirFinanzas, type FinanzasRaw } from '@/lib/finanzas/finanzas'
import {
  MOTIVO_G2, MOTIVO_T6_AGENTE, MOTIVO_T6_PESTANA, tablero, tarjetaRendimiento, type DatosTablero, type FuenteFinanzas,
} from '@/lib/inicio-tablero'
import { buildDataset } from '@/lib/table'
import type { RawTabs } from '@/lib/types'

/**
 * ORD-POS-101 (docs/diseno-inicio-v2.md §3.5 y §7 I-2): T6 desde RENDIMIENTO_CLAUDE. Cifras sintéticas de
 * docs/diseno-finanzas-v3.md §5 (suscripción de 50.00 USD, cargo extra de 20.00 USD en 2027-02-Q2), no del propietario.
 */

const NOW = Date.UTC(2027, 2, 20, 18, 0, 0) // 2027-03-20, 12:00 en Mérida
const ENC = ['MOV_ID', 'FECHA', 'PROYECTO', 'TIPO', 'CATEGORIA', 'CONCEPTO', 'PRODUCTO_ID', 'MONTO_MXN', 'MONEDA_ORIG', 'MONTO_ORIG', 'TIPO_CAMBIO', 'IVA_MXN', 'FUENTE', 'COMPROBANTE', 'AJUSTE_DE']
const mov = (id: string, fecha: string, mxn: number, moneda: string, orig: number | '', fuente: string, concepto = 'Suscripción Claude') =>
  [id, fecha, 'POS', 'Gasto', 'Herramientas', concepto, '', mxn, moneda, orig, moneda === 'USD' ? 18 : '', '', fuente, 'sí', '']
const MOVIMIENTOS = [
  ENC,
  mov('REC-CLAUDE-2027-01', '2027-01-10', 900, 'USD', 50, 'recurrente'),
  mov('REC-CLAUDE-2027-02', '2027-02-10', 900, 'USD', 50, 'recurrente'),
  mov('CLAUDE-EXTRA-2027-02-Q2', '2027-02-28', 360, 'USD', 20, 'agente-finanzas', 'Claude: cargo adicional 2027-02-Q2'),
  mov('REC-CLAUDE-2027-03', '2027-03-10', 900, 'USD', 50, 'recurrente'),
  mov('MAN-0001', '2027-02-15', 1200, 'MXN', '', 'manual', 'Keepa'),
]
const PARAMETROS = [['PARAMETRO', 'VALOR'], ['CAPITAL_TOPE_MXN', 80000], ['MES_INICIO', '2027-01']]
const ENC_REND = ['REND_ID', 'CORTE_INICIO', 'CORTE_FIN', 'COSTO_EQUIV_USD', 'SESIONES', 'SESIONES_SIN_DATO', 'TOKENS_ENTRADA', 'TOKENS_SALIDA', 'REPORTE', 'FECHA_REGISTRO']
const rend = (corte: string, costo: number | string) => [`REND-CLAUDE-${corte}`, '', '', costo, 10, 0, '', '', 'session_abcdefghij', '']
const REND = [ENC_REND, rend('2027-01-Q1', 300), rend('2027-01-Q2', 280), rend('2027-02-Q1', 310), rend('2027-02-Q2', 450), rend('2027-03-Q1', 200)]

const fuente = (raw: FinanzasRaw): FuenteFinanzas => ({ estado: 'ok', vista: construirFinanzas(raw, NOW) })
/** Intl separa «USD» del monto con un espacio duro; las pruebas comparan con espacio normal. */
const espacios = <T>(x: T): T => JSON.parse(JSON.stringify(x).replace(/\u00a0/g, ' ')) as T
const t6 = (raw: FinanzasRaw, agente = true) => espacios(tarjetaRendimiento(fuente(raw), agente, null))
const BASE: FinanzasRaw = { MOVIMIENTOS, PARAMETROS, RENDIMIENTO_CLAUDE: REND }

describe('criterio 1: RENDIMIENTO_CLAUDE en un bloque propio que ninguna suma usa', () => {
  it('los totales de gasto, capital, herramientas, P&L y Claude no cambian con filas de rendimiento', () => {
    const { rendimiento: sinFilas, ...sin } = construirFinanzas({ MOVIMIENTOS, PARAMETROS }, NOW)
    const { rendimiento, ...con } = construirFinanzas(BASE, NOW)
    expect(con).toEqual(sin)
    expect(sinFilas).toEqual({ estado: 'sin-pestana' })
    expect(rendimiento.estado === 'ok' && rendimiento.datos.cortes.map((c) => [c.corte, c.equivCentavos])).toEqual([
      ['2027-01-Q1', 30000], ['2027-01-Q2', 28000], ['2027-02-Q1', 31000], ['2027-02-Q2', 45000], ['2027-03-Q1', 20000],
    ])
    expect(con.capital.estado === 'ok' && con.capital.datos.usadoCentavos).toBe(426000)
  })

  it('encabezados por nombre, en cualquier orden y con columnas de más', () => {
    const otraOrden = [['NOTA', 'COSTO_EQUIV_USD', 'REND_ID'], ['x', 300, 'REND-CLAUDE-2027-01-Q1']]
    const r = construirFinanzas({ MOVIMIENTOS, RENDIMIENTO_CLAUDE: otraOrden }, NOW).rendimiento
    expect(r.estado === 'ok' && r.datos.cortes).toEqual([{ corte: '2027-01-Q1', mes: '2027-01', quincena: 'Q1', equivCentavos: 30000 }])
    expect(construirFinanzas({ MOVIMIENTOS, RENDIMIENTO_CLAUDE: [['REND_ID']] }, NOW).rendimiento)
      .toEqual({ estado: 'no-disponible', mensaje: 'Falta la columna COSTO_EQUIV_USD en RENDIMIENTO_CLAUDE.' })
  })

  it('una fila con REND_ID fuera de formato o repetido, o un costo inválido, no cuenta y se lista sin monto', () => {
    const r = construirFinanzas({ MOVIMIENTOS, RENDIMIENTO_CLAUDE: [ENC_REND, rend('2027-01-Q1', 300), rend('2027-01-Q2', 1), rend('2027-01-Q2', 2), rend('2027-02-Q3', 5), rend('2027-02-Q1', -1), rend('2027-02-Q2', 3000.01)] }, NOW).rendimiento
    expect(r.estado === 'ok' && r.datos.cortes.map((c) => c.corte)).toEqual(['2027-01-Q1'])
    expect(r.estado === 'ok' && r.datos.problemas).toEqual([
      { ref: 'REND-CLAUDE-2027-01-Q2 (fila 3)', columnas: ['REND_ID (duplicado)'] },
      { ref: 'REND-CLAUDE-2027-01-Q2 (fila 4)', columnas: ['REND_ID (duplicado)'] },
      { ref: 'REND-CLAUDE-2027-02-Q3 (fila 5)', columnas: ['REND_ID'] },
      { ref: 'REND-CLAUDE-2027-02-Q1 (fila 6)', columnas: ['COSTO_EQUIV_USD'] },
      { ref: 'REND-CLAUDE-2027-02-Q2 (fila 7)', columnas: ['COSTO_EQUIV_USD'] },
    ])
    // Con el Q2 de enero duplicado, enero no está completo.
    const t = tarjetaRendimiento({ estado: 'ok', vista: construirFinanzas({ MOVIMIENTOS, RENDIMIENTO_CLAUDE: [ENC_REND, rend('2027-01-Q1', 300), rend('2027-01-Q2', 1), rend('2027-01-Q2', 2)] }, NOW) }, true, null)
    expect(t.estado).toBe('sin-datos')
  })
})

describe('criterio 2: cociente mensual de v3 §4.2 y tendencia contra el mes completo anterior', () => {
  it('último mes completo (2027-02): (310 + 450) ÷ (50 + 20); tendencia contra 2027-01: (300 + 280) ÷ 50', () => {
    const t = t6(BASE)
    expect(t).toEqual({
      estado: 'ok',
      datos: {
        valor: 10.86,
        detalle: '2027-02: USD 760.00 equivalentes ÷ USD 70.00 pagados',
        notas: ['Último corte cerrado 2027-03-Q1: USD 200.00 equivalentes, sin dividir.', 'El consumo equivalente no es gasto: no suma a T5.'],
        tendencia: { estado: 'ok', datos: { anterior: 11.6, diferencia: -0.74, etiqueta: 'vs 2027-01' } },
      },
    })
  })

  it('el mes anterior incompleto deja la tendencia sin datos, no la inventa', () => {
    const t = t6({ ...BASE, RENDIMIENTO_CLAUDE: REND.filter((r) => r[0] !== 'REND-CLAUDE-2027-01-Q1') })
    expect(t.estado === 'ok' && t.datos.tendencia).toEqual({ estado: 'sin-datos', motivo: '2027-01 no tiene sus dos cortes (Q1 y Q2) registrados.' })
  })

  it('con filtro de proyecto, el valor es el de toda la cuenta y lo dice', () => {
    const t = tarjetaRendimiento(fuente(BASE), true, 'ECO')
    expect(t.estado === 'ok' && t.datos.notas).toContain('Toda la cuenta de Claude: no se reparte por proyecto.')
  })
})

describe('criterio 3: un mes con solo Q1 no es completo ni se divide entre el costo del mes', () => {
  it('2027-03 con solo Q1 no se toma: el valor sigue siendo el de 2027-02', () => {
    const t = t6(BASE)
    expect(t.estado === 'ok' && t.datos.detalle).toMatch(/^2027-02:/)
    // 200 ÷ 50 = 4 sería dividir medio mes entre el costo del mes completo.
    expect(t.estado === 'ok' && t.datos.valor).not.toBe(4)
  })

  it('sin ningún mes completo: sin datos, con el consumo del último corte al lado y sin cociente', () => {
    const t = t6({ MOVIMIENTOS, RENDIMIENTO_CLAUDE: [ENC_REND, rend('2027-02-Q2', 450), rend('2027-03-Q1', 200)] })
    expect(t).toEqual({
      estado: 'sin-datos',
      motivo: 'Ningún mes tiene sus dos cortes (Q1 y Q2) registrados. Último corte cerrado 2027-03-Q1: USD 200.00 equivalentes, sin dividir.',
    })
  })
})

describe('criterio 4: estados apagada y sin-datos, nunca un 0 inventado', () => {
  it('apagada sin FINANZAS, sin el agente de finanzas activo o sin la pestaña', () => {
    expect(tarjetaRendimiento({ estado: 'no-configurado' }, true, null).estado).toBe('apagada')
    expect(t6(BASE, false)).toEqual({ estado: 'apagada', motivo: MOTIVO_T6_AGENTE })
    expect(t6({ MOVIMIENTOS, PARAMETROS })).toEqual({ estado: 'apagada', motivo: MOTIVO_T6_PESTANA })
  })

  it('sin datos con FINANZAS ilegible, la pestaña vacía o sin lo pagado en USD del mes', () => {
    expect(tarjetaRendimiento({ estado: 'error', motivo: 'No se pudo leer FINANZAS.' }, true, null)).toEqual({ estado: 'sin-datos', motivo: 'No se pudo leer FINANZAS.' })
    expect(t6({ MOVIMIENTOS, RENDIMIENTO_CLAUDE: [ENC_REND] })).toEqual({ estado: 'sin-datos', motivo: 'RENDIMIENTO_CLAUDE no tiene cortes registrados.' })
    const sinRec = t6({ ...BASE, MOVIMIENTOS: MOVIMIENTOS.filter((m) => m[0] !== 'REC-CLAUDE-2027-02') })
    expect(sinRec.estado === 'sin-datos' && sinRec.motivo).toMatch(/^El último mes completo no se puede dividir: en 2027-02 falta la suscripción confirmada REC-CLAUDE-2027-02\./)
    const enMxn = t6({ ...BASE, MOVIMIENTOS: MOVIMIENTOS.map((m) => (m[0] === 'CLAUDE-EXTRA-2027-02-Q2' ? mov('CLAUDE-EXTRA-2027-02-Q2', '2027-02-28', 360, 'MXN', '', 'agente-finanzas') : m)) })
    expect(enMxn.estado === 'sin-datos' && enMxn.motivo).toContain('CLAUDE-EXTRA-2027-02-Q2 no tiene su monto en USD')
    const conProblema = t6({ ...BASE, MOVIMIENTOS: [...MOVIMIENTOS, mov('REC-CLAUDE-2027-02', '2027-02-10', 900, 'USD', 50, 'recurrente')] })
    expect(conProblema.estado === 'sin-datos' && conProblema.motivo).toContain('REC-CLAUDE-2027-02 es una fila con problema en MOVIMIENTOS')
  })

  it('apagada o sin datos, la tarjeta no pinta ningún número de valor', () => {
    const ds = buildDataset({} as RawTabs, { source: 'fixtures', fetchedAt: NOW })
    const base = { ds, hoy: '2027-03-20', now: NOW, filtro: null, proyectos: { estado: 'sin-datos', motivo: 'x' }, eventos: { estado: 'sin-datos', motivo: 'x' }, gh: null, audit: { estado: 'sin-datos', motivo: 'x' } } as const
    const card = (t: DatosTablero) => /data-tarjeta="T6"[^>]*>(.*?)Fuente:/.exec(renderToStaticMarkup(createElement(TableroInicio, { t })))?.[1] ?? ''
    for (const [finanzas, agenteFinanzas] of [[fuente(BASE), false], [fuente({ MOVIMIENTOS }), true], [fuente({ MOVIMIENTOS, RENDIMIENTO_CLAUDE: [ENC_REND] }), true]] as const) {
      const h = card(tablero({ ...base, finanzas, agenteFinanzas }))
      expect(h).toMatch(/Sin datos|Fuente apagada/)
      expect(h).not.toMatch(/stat-value|>0<|0 ×/)
    }
    const ok = card(tablero({ ...base, finanzas: fuente(BASE), agenteFinanzas: true }))
    expect(ok).toMatch(/stat-value">10\.86 ×</)
    expect(ok).toContain('−0.74 × vs 2027-01 (antes 11.6 ×)')
  })
})

describe('criterios 5 y 6: quién crea la pestaña y G2', () => {
  it('la tarjeta y el diseño dicen que la pestaña la crea el propietario en la activación, no la ORD-POS-092', () => {
    expect(MOTIVO_T6_PESTANA).toContain('la crea el propietario en la activación')
    expect(MOTIVO_T6_PESTANA).not.toContain('ORD-POS-092')
    const diseno = readFileSync(path.join(__dirname, '..', '..', 'docs', 'diseno-inicio-v2.md'), 'utf8')
    expect(diseno).not.toContain('ya construyó la ORD-POS-092')
    expect(diseno).toContain('la crea el propietario en la activación')
  })

  it('G2 sigue apagada', () => {
    const ds = buildDataset({} as RawTabs, { source: 'fixtures', fetchedAt: NOW })
    const t = tablero({
      ds, hoy: '2027-03-20', now: NOW, filtro: null, proyectos: { estado: 'sin-datos', motivo: 'x' }, eventos: { estado: 'sin-datos', motivo: 'x' },
      gh: null, audit: { estado: 'sin-datos', motivo: 'x' }, finanzas: fuente(BASE), agenteFinanzas: true,
    })
    expect(t.costoPorRol).toEqual({ estado: 'apagada', motivo: MOTIVO_G2 })
  })
})
