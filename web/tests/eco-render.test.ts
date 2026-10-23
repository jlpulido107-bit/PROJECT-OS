import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { EcoResult } from '@/lib/radaros/data'
import { construirEco } from '@/lib/radaros/eco'

/** Render de /eco (ORD-POS-067) con el resultado del lector simulado: nunca lee Sheets. */
const estado = vi.hoisted(() => ({ result: null as unknown }))
vi.mock('@/lib/page-data', () => ({ privateEco: async () => ({ user: { email: 'revisor@example.com' }, result: estado.result }) }))

const { default: EcoPage } = await import('@/app/(private)/eco/page')

async function html(result: EcoResult, search: Record<string, string> = {}) {
  estado.result = result
  return renderToStaticMarkup(await EcoPage({ searchParams: Promise.resolve(search) }))
}

const NOW = Date.UTC(2026, 9, 21, 15)

describe('/eco: render', () => {
  it('no configurado: aviso y pasos de §6, sin bloques', async () => {
    const h = await html({ estado: 'no-configurado', motivo: 'no-valido' })
    expect(h).toContain('RADAROS no está configurado en este despliegue (valor no válido).')
    expect(h).not.toContain('Estado del motor')
  })

  it('error de permiso: mensaje seguro, sin datos', async () => {
    const h = await html({ estado: 'error', code: 'permission', message: 'La cuenta de servicio no tiene acceso a la hoja. Compártela como Lector con esa cuenta.', reintentar: false, at: NOW })
    expect(h).toContain('Compártela como Lector')
    expect(h).not.toContain('Intenta en un minuto')
  })

  it('con datos: los 5 bloques, estados por bloque y texto escapado', async () => {
    const vista = construirEco({
      AMZ_CORRIDAS: [['SEMANA', 'INICIO', 'ESTADO', 'MENSAJE'], ['2026-W43', '2026-10-19 06:00:00', 'OK', '<script>alert(1)</script>']],
      SCORING: [['NOMBRE'], ['x']],
      ML_TRENDS_ANALISIS_AUTO: [['KEYWORD', 'ESTADO', 'ETIQUETA_PRELIMINAR'], ['termo', 'RECURRENTE', 'A'], ['vaso', 'UNA_SEMANA', 'B']],
    }, NOW)
    const h = await html({ estado: 'ok', vista, fetchedAt: NOW }, { estado: 'UNA_SEMANA' })
    for (const t of ['Estado del motor', 'Ranking de ideas', 'Unit economics', 'Candidatos', 'Tendencias']) expect(h).toContain(t)
    expect(h).not.toContain('<script>alert(1)</script>')
    expect(h).toContain('&lt;script&gt;')
    expect(h).toContain('faltan columnas (IDEA_ID)')
    expect(h).toContain('UNIT_ECONOMICS no existe en la hoja de RADAROS.')
    expect(h).toContain('pendiente de V1.3')
    expect(h).toContain('vaso')
    expect(h).not.toContain('>termo<')
  })
})
