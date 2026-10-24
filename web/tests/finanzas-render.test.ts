import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { FinanzasResult } from '@/lib/finanzas/data'
import { construirFinanzas } from '@/lib/finanzas/finanzas'

/** Render de /finanzas (ORD-POS-074) con el resultado del lector simulado: nunca lee Sheets. Montos inventados. */
const estado = vi.hoisted(() => ({ result: null as unknown }))
vi.mock('@/lib/page-data', () => ({ privateFinanzas: async () => ({ user: { email: 'revisor@example.com' }, result: estado.result }) }))

const { default: FinanzasPage } = await import('@/app/(private)/finanzas/page')

async function html(result: FinanzasResult) {
  estado.result = result
  return renderToStaticMarkup(await FinanzasPage())
}

const NOW = Date.UTC(2026, 9, 23, 18)
const ENC = ['MOV_ID', 'FECHA', 'PROYECTO', 'TIPO', 'CATEGORIA', 'CONCEPTO', 'PRODUCTO_ID', 'MONTO_MXN', 'FUENTE', 'COMPROBANTE']
const PARAM = (tope: number) => [['PARAMETRO', 'VALOR'], ['CAPITAL_TOPE_MXN', tope], ['MES_INICIO', '2026-09']]
const MOV = [
  ENC,
  ['MAN-0001', '2026-09-05', 'POS', 'Gasto', 'Herramientas', 'Keepa', '', 100, 'manual', 'sí'],
  ['MAN-0002', '2026-10-05', 'ECO', 'Inversión', 'Producto', '<script>alert(1)</script>', 'EC-004', 800, 'manual', 'sí'],
  ['MAN-0003', '2026-10-06', 'ECO', 'Gasto', 'Viajes', 'x', '', 31337, 'manual', 'sí'],
]

describe('/finanzas: render', () => {
  it('no configurado: aviso y pasos de §6, sin bloques', async () => {
    const h = await html({ estado: 'no-configurado', motivo: 'no-valido' })
    expect(h).toContain('FINANZAS no está configurado en este despliegue (valor no válido).')
    expect(h).toContain('docs/diseno-finanzas.md §6')
    expect(h).not.toContain('Capital usado')
    expect(await html({ estado: 'no-configurado', motivo: 'ausente' })).not.toContain('valor no válido')
  })

  it('error de permiso: mensaje seguro, sin datos; cuota: «intenta en un minuto»', async () => {
    const h = await html({ estado: 'error', code: 'permission', message: 'La cuenta de servicio no tiene acceso a la hoja. Compártela como Lector con esa cuenta.', reintentar: false, at: NOW })
    expect(h).toContain('Compártela como Lector')
    expect(h).not.toContain('Intenta en un minuto')
    expect(await html({ estado: 'error', code: 'quota', message: 'Cuota.', reintentar: true, at: NOW })).toContain('Intenta en un minuto')
  })

  it('con datos: los 4 bloques, alerta ámbar, filas con problema sin monto y texto escapado', async () => {
    const vista = construirFinanzas({ MOVIMIENTOS: MOV, PARAMETROS: PARAM(1000) }, NOW)
    const h = await html({ estado: 'ok', vista, fetchedAt: NOW })
    for (const t of ['Capital usado contra el tope', 'Gasto mensual por proyecto y categoría', 'Costo de herramientas', 'P&amp;L por producto', 'Filas con problema']) expect(h).toContain(t)
    expect(h).toContain('Capital al 90 % del tope')
    expect(h).toContain('<progress')
    expect(h).toContain('MAN-0003 (fila 4)')
    expect(h).not.toContain('31,337')
    expect(h).toContain('Sin registrar')
    expect(h).toContain('Sin producto')
    expect(h).not.toContain('<script>alert(1)</script>')
  })

  it('tope superado: aviso rojo; sin tope: sin barra; hoja vacía: estados vacíos', async () => {
    const superado = await html({ estado: 'ok', vista: construirFinanzas({ MOVIMIENTOS: MOV, PARAMETROS: PARAM(900) }, NOW), fetchedAt: NOW })
    expect(superado).toContain('Tope de capital superado')
    const sinTope = await html({ estado: 'ok', vista: construirFinanzas({ MOVIMIENTOS: MOV, PARAMETROS: [['PARAMETRO', 'VALOR']] }, NOW), fetchedAt: NOW })
    expect(sinTope).toContain('Falta CAPITAL_TOPE_MXN')
    expect(sinTope).not.toContain('<progress')
    const vacia = await html({ estado: 'ok', vista: construirFinanzas({ MOVIMIENTOS: [ENC], PARAMETROS: PARAM(1000) }, NOW), fetchedAt: NOW })
    expect(vacia).toContain('Sin movimientos todavía.')
    expect(vacia).not.toContain('Filas con problema')
    const sinTab = await html({ estado: 'ok', vista: construirFinanzas({}, NOW), fetchedAt: NOW })
    expect(sinTab).toContain('La pestaña MOVIMIENTOS todavía no existe.')
  })

  it('recurrentes del mes (ORD-POS-076): sin botones, con «atrasado», «aún no vence», con problema sin monto y estados', async () => {
    const REC = [
      ['ID', 'CONCEPTO', 'PROYECTO', 'CATEGORIA', 'MONTO', 'MONEDA', 'DIA_COBRO', 'DESDE', 'HASTA'],
      ['CLAUDE', 'Suscripción Claude', 'POS', 'Herramientas', 20, 'USD', 1, '2026-09', ''],
      ['KEEPA', 'Keepa', 'ECO', 'Herramientas', 250.5, 'MXN', 28, '2026-10', ''],
      ['', 'Roto', 'POS', 'Herramientas', 54321, 'MXN', 1, '2026-10', ''],
    ]
    const h = await html({ estado: 'ok', vista: construirFinanzas({ MOVIMIENTOS: MOV, PARAMETROS: PARAM(1000), RECURRENTES: REC }, NOW), fetchedAt: NOW })
    expect(h).toContain('Recurrentes del mes')
    expect(h).toContain('REC-CLAUDE-2026-09')
    expect(h).toContain('Atrasado')
    expect(h).toContain('Aún no vence')
    expect(h).toContain('$250.50')
    expect(h).toContain('Recurrentes con problema')
    expect(h).toContain('fila 4')
    expect(h).not.toContain('54,321')
    expect(h).not.toMatch(/<button|<form|Confirmar/)
    const sinTab = await html({ estado: 'ok', vista: construirFinanzas({ MOVIMIENTOS: MOV, PARAMETROS: PARAM(1000) }, NOW), fetchedAt: NOW })
    expect(sinTab).toContain('La pestaña RECURRENTES todavía no existe.')
    const vacia = await html({ estado: 'ok', vista: construirFinanzas({ MOVIMIENTOS: MOV, PARAMETROS: PARAM(1000), RECURRENTES: [REC[0]!] }, NOW), fetchedAt: NOW })
    expect(vacia).toContain('Sin recurrentes registrados en RECURRENTES.')
  })
})
