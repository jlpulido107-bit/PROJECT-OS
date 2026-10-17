import { describe, expect, it } from 'vitest'
import { ordenesEnCurso, revisionEstado, urlGithub } from '@/lib/estado'
import { TAB_HEADERS, type TabName } from '@/lib/schema'
import { buildDataset } from '@/lib/table'
import type { RawTabs } from '@/lib/types'

const NOW = new Date('2026-10-14T18:00:00Z') // miércoles 14, 12:00 en Mérida

type Row = Record<string, string>

function tabs(rows: Partial<Record<TabName, Row[]>>): RawTabs {
  const raw: RawTabs = {}
  for (const tab of Object.keys(TAB_HEADERS) as TabName[]) {
    const headers = TAB_HEADERS[tab] as readonly string[]
    raw[tab] = [[...headers], ...(rows[tab] ?? []).map((r) => headers.map((h) => r[h] ?? ''))]
  }
  return raw
}

const tarea = (id: string, proyecto: string, hito: string, estado: string, horas: string, extra: Row = {}): Row => ({
  TAREA_ID: id, PROYECTO_ID: proyecto, HITO_ID: hito, TITULO: `Tarea ${id}`, ESTADO: estado, HORAS_ESTIMADAS: horas, ...extra,
})

const base = {
  PROYECTOS: [
    { PROYECTO_ID: 'SIG', NOMBRE: 'Sistema A', ESTADO: 'EN_PROGRESO' },
    { PROYECTO_ID: 'ECO', NOMBRE: 'Sistema B', ESTADO: 'DESCUBRIMIENTO' },
    { PROYECTO_ID: 'DEV', NOMBRE: 'Sistema C', ESTADO: 'POR_DIAGNOSTICAR' },
  ],
  HITOS: [
    { HITO_ID: 'SIG-H1', PROYECTO_ID: 'SIG', NOMBRE: 'Meta corta', FECHA_OBJETIVO: '2026-10-16', ESTADO: 'PENDIENTE' },
    { HITO_ID: 'SIG-H2', PROYECTO_ID: 'SIG', NOMBRE: 'Meta larga', FECHA_OBJETIVO: '2026-10-31', ESTADO: 'PENDIENTE' },
    { HITO_ID: 'SIG-H0', PROYECTO_ID: 'SIG', NOMBRE: 'Meta vieja', FECHA_OBJETIVO: '2026-10-10', ESTADO: 'PENDIENTE' },
    { HITO_ID: 'ECO-H1', PROYECTO_ID: 'ECO', NOMBRE: 'Meta grande', FECHA_OBJETIVO: '2026-10-20', ESTADO: 'PENDIENTE' },
    { HITO_ID: 'ECO-H2', PROYECTO_ID: 'ECO', NOMBRE: 'Meta hecha', FECHA_OBJETIVO: '2026-10-01', ESTADO: 'COMPLETADO' },
    { HITO_ID: 'ECO-H3', PROYECTO_ID: 'ECO', NOMBRE: 'Meta vacía', FECHA_OBJETIVO: '2026-11-15', ESTADO: 'PENDIENTE' },
  ],
  TAREAS: [
    tarea('SIG-001', 'SIG', 'SIG-H1', 'PENDIENTE', '3'),
    tarea('SIG-002', 'SIG', 'SIG-H1', 'COMPLETADO', '2'),
    tarea('SIG-003', 'SIG', 'SIG-H2', 'EN_PROGRESO', '', { FECHA_LIMITE: '2026-10-12' }),
    tarea('SIG-004', 'SIG', '', 'BLOQUEADO', '1'),
    tarea('ECO-001', 'ECO', 'ECO-H1', 'PENDIENTE', '10'),
    tarea('ECO-002', 'ECO', 'ECO-H1', 'PENDIENTE', '4'),
  ],
  CAPACIDAD_SEMANAL: [
    { SEMANA_ID: '2026-W41', FECHA_INICIO: '2026-10-05', HORAS_DISPONIBLES: '10', RESERVA_PCT: '0.15', ESTADO: 'APROBADA' },
    { SEMANA_ID: '2026-W42', FECHA_INICIO: '2026-10-12', HORAS_DISPONIBLES: '20', RESERVA_PCT: '0.15', ESTADO: 'APROBADA' },
  ],
  ASIGNACIONES: [
    { ASIGNACION_ID: 'A-SIG', SEMANA_ID: '2026-W42', PROYECTO_ID: 'SIG', HORAS_OBJETIVO: '8' },
    { ASIGNACION_ID: 'A-ECO', SEMANA_ID: '2026-W42', PROYECTO_ID: 'ECO', HORAS_OBJETIVO: '3' },
    { ASIGNACION_ID: 'A-OLD', SEMANA_ID: '2026-W41', PROYECTO_ID: 'SIG', HORAS_OBJETIVO: '9' },
  ],
  TIEMPOS: [
    { SESION_ID: 'T1', TAREA_ID: 'SIG-001', FECHA: '2026-10-13', MINUTOS_REALES: '90' },
    { SESION_ID: 'T2', TAREA_ID: 'SIG-003', FECHA: '2026-10-14', MINUTOS_REALES: '30' },
    { SESION_ID: 'T3', TAREA_ID: 'SIG-001', FECHA: '2026-10-09', MINUTOS_REALES: '600' },
    { SESION_ID: 'T4', TAREA_ID: 'NO-EXISTE', FECHA: '2026-10-13', MINUTOS_REALES: '15' },
  ],
  EVIDENCIAS: [
    { EVIDENCIA_ID: 'E1', PROYECTO_ID: 'SIG', FECHA: '2026-10-13', TIPO: 'COMMIT' },
    { EVIDENCIA_ID: 'E2', PROYECTO_ID: 'SIG', FECHA: '2026-10-01', TIPO: 'COMMIT' },
    { EVIDENCIA_ID: 'E3', PROYECTO_ID: 'ECO', FECHA: '2026-10-02', TIPO: 'PR' },
  ],
} satisfies Partial<Record<TabName, Row[]>>

const build = (rows: Partial<Record<TabName, Row[]>> = base) =>
  buildDataset(tabs(rows), { source: 'fixtures', fetchedAt: NOW.getTime() })

const r = revisionEstado(build(), NOW)
const sig = r.proyectos.find((p) => p.proyecto.id === 'SIG')!
const eco = r.proyectos.find((p) => p.proyecto.id === 'ECO')!
const dev = r.proyectos.find((p) => p.proyecto.id === 'DEV')!
const textos = (p: { alertas: Array<{ texto: string }> }) => p.alertas.map((a) => a.texto)

describe('revisión de estado: semana en curso', () => {
  it('elige la fila de CAPACIDAD_SEMANAL que contiene hoy (hora Mérida)', () => {
    expect(r.hoy).toBe('2026-10-14')
    expect(r.semana).toMatchObject({ semanaId: '2026-W42', desde: '2026-10-12', hasta: '2026-10-18', horasDisponibles: 20, horasAsignadas: 11 })
    expect(r.semana.horasNetas).toBeCloseTo(17)
  })

  it('suma solo tiempos de la semana y aparta las sesiones sin tarea válida', () => {
    expect(r.semana.minutosReales).toMatchObject({ minutos: 135, sesiones: 3 })
    expect(r.semana.sesionesSinProyecto).toBe(1)
    expect(r.alertasGenerales.map((a) => a.texto)).toContain('1 sesión de TIEMPOS sin tarea válida: no cuentan para ningún proyecto.')
  })

  it('sin fila de capacidad no inventa horas y lo dice', () => {
    const sinCapacidad = revisionEstado(build({ ...base, CAPACIDAD_SEMANAL: [] }), NOW)
    expect(sinCapacidad.semana).toMatchObject({ semanaId: null, desde: '2026-10-12', horasNetas: null, horasAsignadas: null })
    expect(sinCapacidad.proyectos.every((p) => p.horasAsignadas === null)).toBe(true)
    expect(sinCapacidad.alertasGenerales[0]).toEqual({ nivel: 'alta', texto: 'No hay fila en CAPACIDAD_SEMANAL para la semana del 2026-10-12.' })
  })

  it('avisa si se asignan más horas que las netas o la capacidad no está aprobada', () => {
    const sobre = revisionEstado(build({
      ...base,
      CAPACIDAD_SEMANAL: [{ SEMANA_ID: '2026-W42', FECHA_INICIO: '2026-10-12', HORAS_DISPONIBLES: '10', RESERVA_PCT: '0.15', ESTADO: 'BORRADOR' }],
    }), NOW)
    expect(sobre.alertasGenerales.map((a) => a.texto)).toEqual(expect.arrayContaining([
      'Asignaste 11 h y solo hay 8.5 h netas.',
      'La capacidad de 2026-W42 no está APROBADA.',
    ]))
  })
})

describe('revisión de estado: plan vs real por proyecto', () => {
  it('compara asignación de la semana con tiempo real de las tareas del proyecto', () => {
    expect(sig.horasAsignadas).toBe(8)
    expect(sig.minutosReales).toMatchObject({ minutos: 120, sesiones: 2 })
    expect(eco.horasAsignadas).toBe(3)
    expect(eco.minutosReales.minutos).toBeNull()
    expect(textos(eco)).toContain('Esta semana tiene 3 h asignadas y ningún tiempo registrado.')
  })

  it('un proyecto sin asignación ni tiempos queda en null, no en 0', () => {
    expect(dev.horasAsignadas).toBeNull()
    expect(dev.minutosReales.minutos).toBeNull()
    expect(dev.alertas).toEqual([])
  })

  it('avisa cuando las horas reales superan las asignadas', () => {
    const mucho = revisionEstado(build({
      ...base,
      TIEMPOS: [{ SESION_ID: 'T9', TAREA_ID: 'ECO-001', FECHA: '2026-10-13', MINUTOS_REALES: '240' }],
    }), NOW)
    expect(textos(mucho.proyectos.find((p) => p.proyecto.id === 'ECO')!)).toContain('Las horas reales (4 h) ya superan las asignadas (3 h).')
  })
})

describe('revisión de estado: metas', () => {
  it('clasifica el riesgo de cada meta y ordena de más a menos urgente', () => {
    expect(sig.hitos.map((h) => [h.hito.id, h.riesgo])).toEqual([
      ['SIG-H0', 'vencido'],
      ['SIG-H1', 'en-riesgo'],
      ['SIG-H2', 'en-plazo'],
    ])
    expect(eco.hitos.map((h) => [h.hito.id, h.riesgo])).toEqual([
      ['ECO-H1', 'no-alcanza'],
      ['ECO-H3', 'sin-tareas'],
      ['ECO-H2', 'cerrado'],
    ])
  })

  it('«no alcanza» compara horas pendientes con la asignación semanal hasta la fecha', () => {
    const h = eco.hitos.find((x) => x.hito.id === 'ECO-H1')!
    // 6 días restantes → 1 semana × 3 h asignadas = 3 h; faltan 14 h.
    expect(h).toMatchObject({ diasRestantes: 6, horasPendientes: 14, horasAlcanzables: 3, tareasAbiertas: 2 })
    expect(textos(eco)[0]).toBe('La meta «Meta grande» pide 14 h y al ritmo asignado solo caben 3 h antes de la fecha.')
  })

  it('las horas pendientes ignoran tareas cerradas y cuentan las que no tienen estimación', () => {
    const h1 = sig.hitos.find((x) => x.hito.id === 'SIG-H1')!
    expect(h1).toMatchObject({ tareas: 2, tareasAbiertas: 1, horasPendientes: 3, tareasSinEstimacion: 0 })
    const h2 = sig.hitos.find((x) => x.hito.id === 'SIG-H2')!
    expect(h2).toMatchObject({ horasPendientes: null, tareasSinEstimacion: 1 })
  })

  it('el próximo hito es el abierto con la fecha más cercana, no uno vencido', () => {
    expect(sig.proximoHito?.hito.id).toBe('SIG-H1')
    expect(eco.proximoHito?.hito.id).toBe('ECO-H1')
    expect(dev.proximoHito).toBeNull()
  })
})

describe('revisión de estado: tareas y actividad', () => {
  it('cuenta abiertas, bloqueadas, vencidas, sin meta y sin estimación', () => {
    expect(sig.tareasAbiertas).toBe(3)
    expect(sig.tareasBloqueadas.map((t) => t.id)).toEqual(['SIG-004'])
    expect(sig.tareasVencidas.map((t) => t.id)).toEqual(['SIG-003'])
    expect(sig.tareasSinHito).toBe(1)
    expect(sig.tareasSinEstimacion).toBe(1)
    expect(textos(sig)).toEqual(expect.arrayContaining([
      '1 tarea abierta pasó su fecha límite.',
      '1 tarea bloqueada.',
      '1 tarea abierta sin HORAS_ESTIMADAS.',
      '1 tarea abierta sin meta (HITO_ID).',
    ]))
  })

  it('las alertas van de alta a baja', () => {
    const niveles = sig.alertas.map((a) => a.nivel)
    expect(niveles).toEqual([...niveles].sort((a, b) => ['alta', 'media', 'baja'].indexOf(a) - ['alta', 'media', 'baja'].indexOf(b)))
    expect(niveles[0]).toBe('alta')
  })

  it('cuenta evidencias de los últimos 7 días y la fecha de la última', () => {
    expect(sig.actividad).toEqual({ evidencias: 1, ultima: '2026-10-13' })
    expect(eco.actividad).toEqual({ evidencias: 0, ultima: '2026-10-02' })
    expect(dev.actividad).toEqual({ evidencias: 0, ultima: null })
  })

  it('no modifica el conjunto de datos', () => {
    const ds = build()
    const antes = JSON.stringify(ds)
    revisionEstado(ds, NOW)
    expect(JSON.stringify(ds)).toBe(antes)
  })
})

describe('revisión de estado: órdenes en curso', () => {
  const orden = (id: string, estado: string, extra: Row = {}): Row => ({
    ORDEN_ID: id, PROYECTO_ID: 'SIG', TAREA_ID: 'SIG-001', TITULO: `Orden ${id}`, ESTADO: estado, ...extra,
  })
  const ISSUE = 'https://github.com/jlpulido107-bit/SIGSAH/issues/1'
  const PR = 'https://github.com/jlpulido107-bit/SIGSAH/pull/2'
  const conOrdenes = (rows: Row[]) =>
    revisionEstado(build({ ...base, ORDENES_CODEX: rows }), NOW).proyectos.find((p) => p.proyecto.id === 'SIG')!

  it('lista solo APROBADA, ENVIADA, PR_ABIERTO y REVISADA, con siguiente paso, quién y enlaces', () => {
    const p = conOrdenes([
      orden('ORD-SIG-001', 'BORRADOR'), orden('ORD-SIG-002', 'CERRADA'), orden('ORD-SIG-003', 'CANCELADA'),
      orden('ORD-SIG-004', 'REVISADA', { ISSUE_URL: ISSUE, PR_URL: PR }),
      orden('ORD-SIG-005', 'ENVIADA', { ISSUE_URL: ISSUE }),
      orden('ORD-SIG-006', 'APROBADA'), orden('ORD-SIG-007', 'PR_ABIERTO', { ISSUE_URL: ISSUE, PR_URL: PR }),
      { ...orden('ORD-ECO-001', 'ENVIADA'), PROYECTO_ID: 'ECO' },
    ])
    expect(p.ordenes.map((o) => o.orden.id)).toEqual(['ORD-SIG-006', 'ORD-SIG-005', 'ORD-SIG-007', 'ORD-SIG-004'])
    expect(p.ordenes[1]).toMatchObject({ estado: 'ENVIADA', siguiente: { quien: 'claude' }, issueUrl: ISSUE, prUrl: null })
    expect(p.ordenes[3]).toMatchObject({ siguiente: { quien: 'propietario' }, issueUrl: ISSUE, prUrl: PR })
  })

  it('sin órdenes en curso la lista queda vacía', () => {
    expect(conOrdenes([orden('ORD-SIG-001', 'CERRADA')]).ordenes).toEqual([])
    expect(dev.ordenes).toEqual([])
  })

  it('una orden con estado inválido se omite sin romper la revisión', () => {
    const p = conOrdenes([orden('ORD-SIG-001', 'INVENTADO'), orden('ORD-SIG-002', ''), orden('ORD-SIG-003', 'ENVIADA')])
    expect(p.ordenes.map((o) => o.orden.id)).toEqual(['ORD-SIG-003'])
  })

  it('alerta media por las órdenes REVISADAS y ninguna si no hay', () => {
    const con = conOrdenes([orden('ORD-SIG-001', 'REVISADA'), orden('ORD-SIG-002', 'REVISADA')])
    expect(con.alertas).toContainEqual({ nivel: 'media', texto: '2 órdenes revisadas esperan tu fusión o cierre.' })
    expect(textos(conOrdenes([orden('ORD-SIG-001', 'ENVIADA')])).join()).not.toContain('revisada')
  })

  it('un enlace que no es https de github.com no se conserva como enlace', () => {
    expect(urlGithub(PR)).toBe(PR)
    for (const mala of ['http://github.com/a/b/pull/1', 'https://evil.example/pull/1', 'https://github.com.evil.example/x',
      'https://user:pw@github.com/a/b', 'javascript:alert(1)', 'no es url', '', null]) {
      expect(urlGithub(mala)).toBeNull()
    }
    const p = conOrdenes([orden('ORD-SIG-001', 'PR_ABIERTO', { ISSUE_URL: 'https://evil.example/i/1', PR_URL: 'http://github.com/a/b/pull/1' })])
    expect(p.ordenes[0]).toMatchObject({ issueUrl: null, prUrl: null })
    expect(ordenesEnCurso(build({ ...base, ORDENES_CODEX: [] }), 'SIG')).toEqual([])
  })
})
