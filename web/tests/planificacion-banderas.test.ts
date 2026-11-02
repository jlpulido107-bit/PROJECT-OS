import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BloqueEsperando } from '@/components/inicio/esperando'
import { FlujoView } from '@/components/planning/flujo'
import {
  BANDERAS, estadoBandera, fuenteBanderas, MOTIVO_BANDERAS_NO_PROPIETARIO, MOTIVO_SIN_COLUMNA_BANDERA, type FuenteBanderas,
} from '@/lib/banderas'
import { banderasSinEncender, esperandoPorTi, MOTIVO_FUSION_SIN_DATOS, type FuentesEsperando } from '@/lib/esperando'
import type { PrFusion } from '@/lib/operations/github'
import { capaFlujo, lineaFlujo, MOTIVO_SIN_BANDERA, type GitHubFlujo, type LineaFlujo } from '@/lib/planificacion-flujo'
import { ORDENES_BANDERA, TAB_HEADERS } from '@/lib/schema'
import { buildDataset } from '@/lib/table'
import type { Orden } from '@/lib/types'

/**
 * Planificación v2 F5b (ORD-POS-125, POS-041; diseño §4.1, §6.4 y §9, DEC-POS-028 punto 3): columna BANDERA de
 * ORDENES_CODEX, paso Activada del Flujo y grupo «Banderas sin encender». Datos y entornos sintéticos.
 */

const REPO = 'jlpulido107-bit/PROJECT-OS'
const NOW = Date.UTC(2026, 10, 2, 18, 0, 0)
const id = (n: number) => `ORD-POS-${String(n).padStart(3, '0')}`
const prUrl = (n: number) => `https://github.com/${REPO}/pull/${n}`
const orden = (n: number, estado: string, extra: Partial<Orden> = {}): Orden => ({
  id: id(n), proyectoId: 'POS', tareaId: 'POS-041', titulo: `Orden ${n}`, objetivo: null, contexto: null, criterios: '1. Uno',
  fueraDeAlcance: null, comoProbar: null, riesgo: 'BAJO', sensible: null, estado,
  issueUrl: `https://github.com/${REPO}/issues/${n}`, prUrl: prUrl(n), notas: null, actualizadoEn: null, ...extra,
})

/** Entorno sintético: TIEMPOS_AGENTE encendida; PM_PUEDE_REGISTRAR_PR apagada; un correo que nunca debe salir. */
const ENV = {
  TIEMPOS_AGENTE: 'true', PM_PUEDE_REGISTRAR_PR: 'false', TAREAS_CIERRE_PROPIETARIO_EMAIL: 'alguien@example.com',
} as unknown as NodeJS.ProcessEnv
const OK: FuenteBanderas = { estado: 'ok', env: ENV }

/** PRs de POS: el número = n de la orden; `fusionados` con merged_at. */
const prs = (nums: number[], fusionados: number[] = []) => ({
  POS: new Map<string, PrFusion>(nums.map((n) => [id(n), { url: prUrl(n), number: n, fusionMs: fusionados.includes(n) ? NOW : null }])),
  SIG: new Map<string, PrFusion>(), ECO: new Map<string, PrFusion>(),
})
const gh = (nums: number[], fusionados: number[] = []): GitHubFlujo => ({
  prs: prs(nums, fusionados), truncados: [], dictamenes: { evaluaciones: new Map(), vencido: false },
})
const activada = (l: LineaFlujo) => l.pasos.find((p) => p.paso === 'Activada')!

/* ------------------------------------- Criterio 1 y 2: columna ------------------------------------- */

describe('criterios 1 y 2: columna opcional BANDERA al final de ORDENES_CODEX, solo lectura', () => {
  const fila = ['ORD-POS-001', 'POS', 'POS-041', 'T', 'O', '', '1. Uno', '', '', 'BAJO', 'PR_ABIERTO', '', '', '', '']
  const tabs = (headers: string[], filas: string[][]) => ({ ORDENES_CODEX: [headers, ...filas] })

  it('sin la columna: la pestaña sigue válida, ordenesConBandera=false y bandera null', () => {
    const ds = buildDataset(tabs([...TAB_HEADERS.ORDENES_CODEX], [fila]), { source: 'fixtures', fetchedAt: NOW })
    expect(ds.tabs.ORDENES_CODEX.ok).toBe(true)
    expect(ds.ordenesConBandera).toBe(false)
    expect(ds.ordenes[0]!.bandera).toBeNull()
  })

  it('con la columna al final: se lee el nombre o null si está vacía', () => {
    const headers = [...TAB_HEADERS.ORDENES_CODEX, ORDENES_BANDERA]
    const ds = buildDataset(tabs(headers, [[...fila, ' tiempos_agente '], ['ORD-POS-002', ...fila.slice(1), '']]), { source: 'fixtures', fetchedAt: NOW })
    expect(ds.ordenesConBandera).toBe(true)
    expect(ds.ordenes.map((o) => o.bandera)).toEqual(['tiempos_agente', null])
  })

  it('con la pestaña inválida no cuenta como columna presente', () => {
    const ds = buildDataset(tabs(['ORDEN_ID', ORDENES_BANDERA], [['ORD-POS-001', 'X']]), { source: 'fixtures', fetchedAt: NOW })
    expect(ds.ordenesConBandera).toBe(false)
  })

  it('no entra en el contrato de escritura (la API de altas no cambia)', async () => {
    const { WRITE_HEADERS } = await import('@/lib/operations/constants')
    expect(Object.values(WRITE_HEADERS).flat()).not.toContain(ORDENES_BANDERA)
  })
})

/* ------------------------------- Criterio 3 y 4: estado de cada bandera ------------------------------- */

describe('criterio 3: estado de las banderas con los *Habilitado existentes', () => {
  it('encendida, apagada, desconocida y vacía', () => {
    expect(estadoBandera('TIEMPOS_AGENTE', ENV)).toEqual({ tipo: 'encendida', clave: 'TIEMPOS_AGENTE', nombre: BANDERAS.TIEMPOS_AGENTE!.nombre })
    expect(estadoBandera('pm_puede_registrar_pr', ENV)?.tipo).toBe('apagada')
    expect(estadoBandera('TAREAS_CIERRE_PROPIETARIO', ENV)?.tipo).toBe('apagada')
    expect(estadoBandera('OTRA_BANDERA', ENV)).toEqual({ tipo: 'desconocida', clave: 'OTRA_BANDERA', nombre: '«OTRA_BANDERA»' })
    expect(estadoBandera('texto libre; con <b>', ENV)?.nombre).toBe('(nombre no válido)')
    expect(estadoBandera('toString', ENV)?.tipo).toBe('desconocida')
    expect(estadoBandera('  ', ENV)).toBeNull()
    expect(estadoBandera(null, ENV)).toBeNull()
  })

  it('las seis banderas existentes, todas apagadas con el entorno vacío', () => {
    expect(Object.keys(BANDERAS).sort()).toEqual([
      'ECO_PIPELINE_WRITE_MODE', 'FINANZAS_AGENTE_MODE', 'PM_PUEDE_REGISTRAR_PR', 'SEGUNDO_GEMINI_SUPERVISADO', 'TAREAS_CIERRE_PROPIETARIO', 'TIEMPOS_AGENTE',
    ])
    for (const clave of Object.keys(BANDERAS)) expect(estadoBandera(clave, {} as NodeJS.ProcessEnv)?.tipo).toBe('apagada')
  })

  it('fuenteBanderas: sin columna o sin ser propietario, apagada con su motivo', () => {
    expect(fuenteBanderas(false, true, ENV)).toEqual({ estado: 'apagada', motivo: MOTIVO_SIN_COLUMNA_BANDERA })
    expect(fuenteBanderas(true, false, ENV)).toEqual({ estado: 'apagada', motivo: MOTIVO_BANDERAS_NO_PROPIETARIO })
    expect(fuenteBanderas(true, true, ENV)).toEqual({ estado: 'ok', env: ENV })
    expect(MOTIVO_SIN_COLUMNA_BANDERA.toLowerCase()).toContain('falta la columna bandera')
  })
})

describe('criterio 3: paso Activada del Flujo', () => {
  it('columna ausente: apagada con «falta la columna BANDERA»', () => {
    const l = lineaFlujo(orden(1, 'PR_ABIERTO', { bandera: 'TIEMPOS_AGENTE' }), gh([1], [1]), { banderas: fuenteBanderas(false, true, ENV) })
    expect(activada(l)).toEqual({ paso: 'Activada', estado: 'apagada', motivo: MOTIVO_SIN_COLUMNA_BANDERA })
    expect(l.bandera).toBeNull()
  })

  it('bandera encendida: hecho', () => {
    const l = lineaFlujo(orden(1, 'PR_ABIERTO', { bandera: 'TIEMPOS_AGENTE' }), gh([1], [1]), { banderas: OK })
    expect(activada(l).estado).toBe('hecho')
    expect(l.bandera).toEqual({ nombre: BANDERAS.TIEMPOS_AGENTE!.nombre, estado: 'encendida' })
  })

  it('bandera apagada: pendiente, con su nombre en palabras', () => {
    const l = lineaFlujo(orden(1, 'PR_ABIERTO', { bandera: 'PM_PUEDE_REGISTRAR_PR' }), gh([1], [1]), { banderas: OK })
    expect(activada(l).estado).toBe('pendiente')
    expect(l.bandera).toEqual({ nombre: BANDERAS.PM_PUEDE_REGISTRAR_PR!.nombre, estado: 'apagada' })
  })

  it('bandera desconocida: sin datos, con su nombre', () => {
    const l = lineaFlujo(orden(1, 'PR_ABIERTO', { bandera: 'OTRA_BANDERA' }), gh([1], [1]), { banderas: OK })
    expect(activada(l)).toMatchObject({ estado: 'sin-datos', motivo: expect.stringContaining('«OTRA_BANDERA»') })
    expect(l.bandera).toBeNull()
  })

  it('BANDERA vacía: no aplica (la orden no deja nada inerte)', () => {
    const l = lineaFlujo(orden(1, 'PR_ABIERTO', { bandera: null }), gh([1], [1]), { banderas: OK })
    expect(activada(l)).toEqual({ paso: 'Activada', estado: 'no-aplica', motivo: MOTIVO_SIN_BANDERA })
  })

  it('otra sesión: apagada, sin el estado de la bandera', () => {
    const c = capaFlujo([orden(1, 'PR_ABIERTO', { bandera: 'TIEMPOS_AGENTE' })], true, gh([1], [1]), fuenteBanderas(true, false, ENV))
    if (c.estado !== 'ok') throw new Error('debía estar ok')
    expect(activada(c.lineas[0]!)).toEqual({ paso: 'Activada', estado: 'apagada', motivo: MOTIVO_BANDERAS_NO_PROPIETARIO })
    const html = renderToStaticMarkup(createElement(FlujoView, { capa: c }))
    expect(html).not.toContain(BANDERAS.TIEMPOS_AGENTE!.nombre)
  })

  it('criterio 4: el Flujo muestra el nombre en palabras y encendida/apagada, nunca la variable, su valor ni un correo', () => {
    const c = capaFlujo([
      orden(1, 'PR_ABIERTO', { bandera: 'TIEMPOS_AGENTE' }), orden(2, 'PR_ABIERTO', { bandera: 'PM_PUEDE_REGISTRAR_PR' }),
    ], true, gh([1, 2], [1, 2]), OK)
    const html = renderToStaticMarkup(createElement(FlujoView, { capa: c }))
    expect(html).toContain(`Bandera: ${BANDERAS.TIEMPOS_AGENTE!.nombre} (encendida)`)
    expect(html).toContain(`Bandera: ${BANDERAS.PM_PUEDE_REGISTRAR_PR!.nombre} (apagada)`)
    expect(html).not.toMatch(/TIEMPOS_AGENTE|PM_PUEDE_REGISTRAR_PR|>true<|=true|@/)
  })
})

/* ------------------------------------- Criterio 3: grupo 6.4 ------------------------------------- */

describe('criterio 3: 6.4 «Banderas sin encender» lista las fusionadas con su bandera apagada', () => {
  const ordenes = [
    orden(1, 'REVISADA', { bandera: 'PM_PUEDE_REGISTRAR_PR' }), // fusionada, apagada → entra
    orden(2, 'CERRADA', { bandera: 'TIEMPOS_AGENTE' }), // fusionada, encendida → no
    orden(3, 'PR_ABIERTO', { bandera: 'PM_PUEDE_REGISTRAR_PR' }), // sin fusionar → no
    orden(4, 'CERRADA', { bandera: 'OTRA_BANDERA' }), // fusionada, desconocida → sin datos
    orden(5, 'CERRADA', { bandera: null }), // sin bandera → no
    orden(6, 'CANCELADA', { bandera: 'PM_PUEDE_REGISTRAR_PR' }), // cancelada → no
  ]

  it('columna ausente: apagada con su motivo', () => {
    expect(banderasSinEncender(ordenes, fuenteBanderas(false, true, ENV), prs([1, 2, 3, 4], [1, 2, 4]))).toEqual({
      estado: 'apagada', motivo: MOTIVO_SIN_COLUMNA_BANDERA,
    })
  })

  it('apagada entra; encendida, sin fusionar, sin bandera y cancelada no; desconocida aparte', () => {
    const g = banderasSinEncender(ordenes, OK, prs([1, 2, 3, 4, 6], [1, 2, 4, 6]))
    if (g.estado !== 'ok') throw new Error('debía estar ok')
    expect(g.datos.lista.map((x) => [x.orden.id, x.nombre])).toEqual([[id(1), BANDERAS.PM_PUEDE_REGISTRAR_PR!.nombre]])
    expect(g.datos.desconocidas.map((x) => [x.orden.id, x.nombre])).toEqual([[id(4), '«OTRA_BANDERA»']])
    expect(g.datos.sinDatos).toEqual([])
  })

  it('sin la lista de PRs (sin GitHub o truncada sin el PR): sin datos, nunca se infiere', () => {
    const sinGh = banderasSinEncender(ordenes, OK, null)
    expect(sinGh.estado === 'ok' && [sinGh.datos.lista, sinGh.datos.sinDatos.map((o) => o.id), sinGh.datos.motivoSinDatos])
      .toEqual([[], [id(1), id(3), id(4)], MOTIVO_FUSION_SIN_DATOS])
    const truncada = banderasSinEncender(ordenes, OK, prs([1], [1]), ['POS'])
    expect(truncada.estado === 'ok' && [truncada.datos.lista.map((x) => x.orden.id), truncada.datos.sinDatos.map((o) => o.id)])
      .toEqual([[id(1)], [id(3), id(4)]])
  })

  it('en Inicio: cuenta en el contador, respeta ?proyecto= y otra sesión no lo ve', () => {
    const base = (extra: Partial<FuentesEsperando> = {}): FuentesEsperando => ({
      propietario: true, ordenes, ordenesOk: true, filtro: null, listos: { evaluaciones: new Map(), vencido: false },
      pendientes: { tareas: { estado: 'ok', datos: [] }, decisiones: { estado: 'ok', datos: [] } } as unknown as FuentesEsperando['pendientes'],
      banderas: OK, prs: prs([1, 2, 3, 4], [1, 2, 4]), truncados: [], ...extra,
    })
    const e = esperandoPorTi(base())
    if (e.estado !== 'ok') throw new Error('debía estar ok')
    // 1 lista (la REVISADA 1) + 1 bandera apagada; 6.2 apagada no cuenta.
    expect([e.datos.contador, e.datos.sinContar]).toEqual([2, 1])
    const sig = esperandoPorTi(base({ filtro: 'SIG' }))
    expect(sig.estado === 'ok' && sig.datos.banderas.estado === 'ok' && sig.datos.banderas.datos.lista).toEqual([])
    const otro = esperandoPorTi(base({ propietario: false }))
    expect(otro.estado).toBe('apagada')
  })

  it('criterio 4: pinta el nombre en palabras y «apagada», sin variables, valores ni correos', () => {
    const e = esperandoPorTi({
      propietario: true, ordenes, ordenesOk: true, filtro: null, listos: { evaluaciones: new Map(), vencido: false },
      pendientes: { tareas: { estado: 'ok', datos: [] }, decisiones: { estado: 'ok', datos: [] } } as unknown as FuentesEsperando['pendientes'],
      banderas: OK, prs: prs([1, 2, 3, 4], [1, 2, 4]), truncados: [],
    })
    const h = renderToStaticMarkup(createElement(BloqueEsperando, { e, filtro: null }))
    expect(h).toContain(BANDERAS.PM_PUEDE_REGISTRAR_PR!.nombre)
    expect(h).toContain('apagada')
    expect(h).toContain('«OTRA_BANDERA»')
    expect(h).not.toContain(BANDERAS.TIEMPOS_AGENTE!.nombre)
    expect(h).not.toMatch(/PM_PUEDE_REGISTRAR_PR|TIEMPOS_AGENTE|TAREAS_CIERRE|>true<|=true|@/)
  })
})
