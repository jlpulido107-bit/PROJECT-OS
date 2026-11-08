import { readFileSync } from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { EcoResult } from '@/lib/radaros/data'
import { construirEco, type Ranking } from '@/lib/radaros/eco'
import { etiquetaK4 } from '@/lib/radaros/eco-columnas'

/**
 * Validación macro de Trends (K4) en /eco (ORD-POS-148): columnas de ORD-ECO-024 al final de SCORING, solo lectura.
 * Datos sintéticos; nunca lee Sheets ni llama a SerpApi.
 */
const estado = vi.hoisted(() => ({ result: null as unknown }))
vi.mock('@/lib/page-data', () => ({ privateEco: async () => ({ user: { email: 'revisor@example.com' }, result: estado.result }) }))

const { default: EcoPage } = await import('@/app/(private)/eco/page')

const NOW = Date.UTC(2026, 10, 7, 18) // 2026-11-07 en Mérida

async function html(raw: Parameters<typeof construirEco>[0]) {
  estado.result = { estado: 'ok', vista: construirEco(raw, NOW), fetchedAt: NOW } satisfies EcoResult
  return renderToStaticMarkup(await EcoPage({ searchParams: Promise.resolve({}) }))
}

const BASE = ['IDEA_ID', 'PUNTUACION_FINAL', 'AMZ_SEMANA', 'AMZ_ESTADO']
const TRENDS = ['KW_RAIZ_TRENDS', 'TREND_INTERANUAL', 'TREND_PENDIENTE_52S', 'TREND_CV_52S', 'K4_MACRO_STATUS', 'TREND_FECHA']
// Las columnas de Trends van al final y separadas por otras, como AL:AQ en el libro real: se leen por encabezado.
const RELLENO = ['OTRA_1', 'OTRA_2']
const SCORING_CON = [
  [...BASE, ...RELLENO, ...TRENDS],
  ['EC-005', '81', '2026-W44', 'OK', 'x', 'y', 'termo', '0.9', '-3.2', '0.4', 'VETO: interanual 0.9 y pendiente −3.2 → propuesta KILL', '2026-11-06'],
  ['EC-006', '55', '2026-W44', 'OK', 'x', 'y', 'tocadiscos', '1.323', '-1.11', '0.189', 'APROBADO', '2026-11-06'],
  ['EC-007', '40', '', '', '', '', 'lampara', '', '', '', 'SIN_DATOS: sin resultados en Trends', '2026-11-06'],
  ['EC-008', '30', '', '', '', '', 'pino', '1.1', '2', '0.9', 'ESTACIONAL: pico en nov, dic', '2026-09-01'],
  ['EC-012', '10', '', '', '', '', '', '', '', '', '', ''],
]
const SCORING_SIN = [BASE, ['EC-005', '81', '2026-W44', 'OK'], ['EC-006', '55', '2026-W44', 'OK']]

function ranking(scoring: unknown[][]): Ranking {
  const r = construirEco({ SCORING: scoring }, NOW).ranking
  if (r.estado !== 'ok') throw new Error(r.estado)
  return r.datos
}

describe('etiquetaK4', () => {
  it('APROBADO, ESTACIONAL con sus meses, VETO con propuesta KILL y SIN_DATOS con su motivo', () => {
    expect(etiquetaK4('APROBADO', '2026-11-06', NOW)).toMatchObject({ tipo: 'APROBADO', texto: 'K4 aprobado', tono: 'ok', vencida: false })
    expect(etiquetaK4('ESTACIONAL: pico en nov, dic', null, NOW)?.texto).toBe('K4 estacional: pico en nov, dic')
    const veto = etiquetaK4('VETO: interanual 0.7 → propuesta KILL', '2026-11-06', NOW)
    expect(veto).toMatchObject({ tipo: 'VETO', texto: 'K4 veto: propuesta KILL: decide el propietario', tono: 'danger' })
    expect(veto?.ayuda).toContain('interanual 0.7')
    expect(etiquetaK4('SIN_DATOS: keyword sin volumen', null, NOW)?.texto).toBe('K4 sin datos: keyword sin volumen')
  })

  it('sin valor no hay etiqueta; un prefijo desconocido se muestra tal cual', () => {
    expect(etiquetaK4(null, '2026-11-06', NOW)).toBeNull()
    expect(etiquetaK4('   ', null, NOW)).toBeNull()
    expect(etiquetaK4('APROBADOX', null, NOW)).toMatchObject({ tipo: 'OTRO', texto: 'K4: APROBADOX' })
  })

  it('consulta vencida: más de 30 días en America/Merida; 30 exactos, fecha ilegible o vacía, no', () => {
    // 2026-11-08 02:00 UTC sigue siendo 2026-11-07 en Mérida.
    const tarde = Date.UTC(2026, 10, 8, 2)
    expect(etiquetaK4('APROBADO', '2026-10-08', tarde)?.vencida).toBe(false) // 30 días
    expect(etiquetaK4('APROBADO', '2026-10-07', tarde)).toMatchObject({ vencida: true, texto: 'K4 aprobado · consulta vencida' })
    expect(etiquetaK4('APROBADO', '7/10/2026', NOW)?.vencida).toBe(true) // D/M/AAAA (es-MX)
    expect(etiquetaK4('APROBADO', '46302', NOW)?.vencida).toBe(true) // serie de Sheets = 2026-10-07
    expect(etiquetaK4('APROBADO', '2026-10-07 09:15:00', NOW)?.vencida).toBe(true)
    expect(etiquetaK4('APROBADO', 'ayer', NOW)?.vencida).toBe(false)
    expect(etiquetaK4('APROBADO', null, NOW)?.vencida).toBe(false)
    expect(etiquetaK4('VETO: x → propuesta KILL', '2026-09-01', NOW)?.texto).toBe('K4 veto: propuesta KILL: decide el propietario · consulta vencida')
  })
})

describe('/eco: columnas de Trends en SCORING', () => {
  it('presentes: se leen por encabezado y el orden del ranking no cambia', () => {
    const r = ranking(SCORING_CON)
    expect(r.conColumnasTrends).toBe(true)
    expect(r.ideas.map((i) => i.id)).toEqual(['EC-005', 'EC-006', 'EC-007', 'EC-008', 'EC-012'])
    const ec6 = r.ideas.find((i) => i.id === 'EC-006')!
    expect(ec6.campos).toMatchObject({ KW_RAIZ_TRENDS: 'tocadiscos', TREND_INTERANUAL: '1.323', TREND_PENDIENTE_52S: '-1.11', TREND_CV_52S: '0.189' })
    expect(ec6.k4?.tipo).toBe('APROBADO')
    expect(r.ideas.find((i) => i.id === 'EC-012')!.k4).toBeNull()
    // Sin las columnas, el mismo orden.
    expect(ranking(SCORING_SIN).ideas.map((i) => i.id)).toEqual(['EC-005', 'EC-006'])
  })

  it('render con columnas: etiquetas K4 en el ranking y pestaña «Macro (Trends)» con sus métricas', async () => {
    const h = await html({ SCORING: SCORING_CON })
    expect(h).toContain('Validación macro (K4)')
    expect(h).toContain('K4 aprobado')
    expect(h).toContain('K4 veto: propuesta KILL: decide el propietario')
    expect(h).toContain('K4 sin datos: sin resultados en Trends')
    expect(h).toContain('K4 estacional: pico en nov, dic · consulta vencida')
    expect(h).toContain('<h4>Macro (Trends)</h4>')
    for (const t of ['tocadiscos', '1.32', '-1.11 %', '0.19', '2026-11-06', 'Pendiente de 52 semanas (% al mes)']) expect(h).toContain(t)
    // EC-012 sin K4_MACRO_STATUS: su fila del ranking no lleva etiqueta.
    const ec12 = h.slice(h.indexOf('id="idea-EC-012"'))
    expect(ec12.slice(0, ec12.indexOf('</summary>'))).not.toContain('K4')
    // Regla de RADAROS (REGLAS.RECIENTES = 13): promedio de las últimas 13 semanas ÷ las mismas 13 de hace un año.
    expect(h).toContain('Interanual (últimas 13 semanas ÷ las mismas 13 de hace un año)')
    expect(h).not.toContain('12 semanas')
  })

  it('SIN_DATOS con métricas vacías: «—», nunca 0', async () => {
    const h = await html({ SCORING: SCORING_CON })
    const ec7 = h.slice(h.indexOf('id="idea-EC-007"'))
    const macro = ec7.slice(ec7.indexOf('<h4>Macro (Trends)</h4>'), ec7.indexOf('<h4>Unit economics</h4>'))
    expect(macro).toContain('lampara')
    expect(macro.match(/sin dato/g)?.length).toBeGreaterThanOrEqual(3)
    expect(macro).not.toMatch(/>0(?:[ .,]|<)/)
  })

  it('ausentes: /eco se ve igual que antes, sin etiqueta, grupo ni aviso nuevos', async () => {
    const r = ranking(SCORING_SIN)
    expect(r.conColumnasTrends).toBe(false)
    expect(r.ideas.every((i) => i.k4 === null)).toBe(true)
    const h = await html({ SCORING: SCORING_SIN })
    for (const t of ['K4', 'Macro (Trends)', 'Validación macro', 'consulta vencida']) expect(h).not.toContain(t)
  })

  it('solo lectura: la página no tiene formulario ni enlace a SerpApi y no escribe en SCORING', () => {
    const fuentes = ['src/app/(private)/eco/page.tsx', 'src/lib/radaros/eco.ts', 'src/lib/radaros/eco-columnas.ts']
      .map((f) => readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n')
    expect(fuentes).not.toMatch(/serpapi\.com|SERPAPI_KEY/i)
    expect(fuentes).not.toMatch(/method=["']post["']|fetch\(/i)
  })
})
