import { describe, expect, it } from 'vitest'
import { buildGovernanceReport } from '@/lib/governance/engine'
import { governanceInputFromDataset } from '@/lib/governance/input'
import { CATEGORY_TABS } from '@/lib/governance/rules'
import type { GovernanceInput, GovernanceReport } from '@/lib/governance/types'
import { addDays } from '@/lib/governance/util'
import { TAB_HEADERS, type TabName } from '@/lib/schema'
import { buildDataset } from '@/lib/table'
import type { RawTabs } from '@/lib/types'
import { deepFreeze, rng } from './helpers/governance-data'

/**
 * Propiedades sobre 300 conjuntos de datos aleatorios (semilla fija ⇒ reproducibles) que pasan por el lector real
 * (`buildDataset`) y la proyección: determinismo, IDs únicos, ninguna acción ejecutada, ninguna fuga de texto libre
 * y ningún "verde" con datos insuficientes.
 */
const CASES = 300
const REF = '2026-10-09'
const SECRET = 'SECRETO-'

function randomTabs(seed: number): { raw: RawTabs; ref: string } {
  const r = rng(seed)
  const day = () => addDays(REF, r.int(-40, 30))
  const maybe = <T,>(v: T, p = 0.8) => (r.chance(p) ? v : '')
  const secret = (label: string) => `${SECRET}${label}-${seed} correo${seed}@example.com`
  const projects = ['POS', 'SIG', 'ECO', 'ZZZ'].slice(0, r.int(1, 4))
  const tasks = Array.from({ length: r.int(0, 18) }, (_, i) => `T-${r.int(1, i + 3)}`) // IDs repetidos a propósito
  const hitos = Array.from({ length: r.int(0, 4) }, (_, i) => `H-${i + 1}`)
  const plans = Array.from({ length: r.int(0, 4) }, (_, i) => `P-${i + 1}`)
  const row = (tab: TabName, values: Record<string, unknown>) => TAB_HEADERS[tab].map((h) => String(values[h] ?? ''))
  const tab = (name: TabName, rows: Array<Record<string, unknown>>) => [[...TAB_HEADERS[name]], ...rows.map((v) => row(name, v))]
  const raw: RawTabs = {
    PROYECTOS: tab('PROYECTOS', projects.map((id) => ({ PROYECTO_ID: id, NOMBRE: secret('nombre'), OBJETIVO: secret('objetivo'), ESTADO: r.pick(['EN_PROGRESO', 'PAUSADO', 'CERRADO', '', 'RARO']), PRIORIDAD: 'ALTA', NOTAS: secret('notas'), RESPONSABLE: secret('responsable') }))),
    HITOS: tab('HITOS', hitos.map((id) => ({ HITO_ID: id, PROYECTO_ID: r.pick([...projects, 'NOPE', '']), NOMBRE: secret('hito'), ESTADO: r.pick(['EN_PROGRESO', 'COMPLETADO', 'CANCELADO', '']), FECHA_OBJETIVO: maybe(day()), CRITERIO_ACEPTACION: secret('criterio') }))),
    TAREAS: tab('TAREAS', tasks.map((id) => ({
      TAREA_ID: id, PROYECTO_ID: r.pick([...projects, 'NOPE', '']), HITO_ID: r.chance(0.4) ? r.pick([...hitos, 'H-99']) : '', TITULO: secret('titulo'), DESCRIPCION: secret('descripcion'),
      ESTADO: r.pick(['PENDIENTE', 'EN_PROGRESO', 'BLOQUEADO', 'COMPLETADO', 'CANCELADO', '']), PRIORIDAD: 'MEDIA', RESPONSABLE: secret('resp'),
      FECHA_LIMITE: maybe(day(), 0.6), HORAS_ESTIMADAS: r.pick(['1', 'abc', '']), CRITERIO_TERMINADO: secret('criterio'), BLOQUEO: r.chance(0.2) ? secret('bloqueo') : '',
    }))),
    DEPENDENCIAS: tab('DEPENDENCIAS', Array.from({ length: tasks.length ? r.int(0, 8) : 0 }, (_, i) => ({ DEPENDENCIA_ID: `D-${i}`, TAREA_ID: r.pick(tasks), DEPENDE_DE_TAREA_ID: r.chance(0.1) ? 'T-404' : r.pick(tasks), TIPO: 'TECNICA', ESTADO: r.pick(['ACTIVA', 'INACTIVA', '']) }))),
    EVIDENCIAS: tab('EVIDENCIAS', Array.from({ length: r.int(0, 5) }, (_, i) => ({ EVIDENCIA_ID: `E-${i}`, TAREA_ID: tasks.length && r.chance(0.8) ? r.pick([...tasks, 'T-404']) : '', PROYECTO_ID: 'POS', TIPO: 'PR', FUENTE: secret('fuente'), REFERENCIA_URL: 'https://example.com', FECHA: day(), VERIFICACION: r.pick(['CONFIRMADO', 'PENDIENTE']), DESCRIPCION: secret('desc') }))),
    DECISIONES: tab('DECISIONES', Array.from({ length: r.int(0, 5) }, (_, i) => ({ DECISION_ID: `DEC-${i}`, PROYECTO_ID: r.pick([...projects, 'NOPE', '']), FECHA: maybe(day()), ASUNTO: secret('asunto'), DECISION: secret('decision'), JUSTIFICACION: secret('justificacion'), RESPONSABLE: secret('resp'), ESTADO: r.pick(['PENDIENTE', 'APROBADA', 'EN_ESPERA', '']) }))),
    TIEMPOS: tab('TIEMPOS', Array.from({ length: r.int(0, 5) }, (_, i) => ({ SESION_ID: `S-${i}`, TAREA_ID: tasks.length ? r.pick([...tasks, 'T-404']) : 'T-404', FECHA: day(), RESPONSABLE: secret('resp'), MINUTOS_REALES: '30', NOTAS: secret('notas') }))),
    PLAN_DIARIO: tab('PLAN_DIARIO', plans.map((id) => ({ PLAN_ID: id, FECHA: addDays(REF, r.int(-6, 4)), ESTADO: r.pick(['PLANIFICADO', 'CERRADO', 'CANCELADO', '']), HORAS_OBJETIVO: '2', NOTAS: secret('notas') }))),
    PLAN_ITEMS: tab('PLAN_ITEMS', plans.flatMap((p, i) => Array.from({ length: r.int(0, 3) }, (_, j) => ({ PLAN_ITEM_ID: `PI-${i}-${j}`, PLAN_ID: p, TAREA_ID: tasks.length ? r.pick([...tasks, 'T-404']) : '', ORDEN: String(j + 1), MINUTOS_PLAN: r.pick(['30', '240', '600', '']), RESULTADO_ESPERADO: secret('resultado') })))),
    CAPACIDAD_SEMANAL: tab('CAPACIDAD_SEMANAL', r.chance(0.7) ? [{ SEMANA_ID: 'S41', FECHA_INICIO: '2026-10-05', HORAS_DISPONIBLES: r.pick(['', '2', '20']), RESERVA_PCT: r.pick(['', '0.15', '50%']), ESTADO: 'APROBADA', NOTAS: secret('notas') }] : []),
    ASIGNACIONES: tab('ASIGNACIONES', r.chance(0.5) ? [{ ASIGNACION_ID: 'A-1', SEMANA_ID: 'S41', PROYECTO_ID: 'POS', HORAS_OBJETIVO: r.pick(['1', '30']), PRIORIDAD: 'ALTA' }] : []),
    SYNC_RUNS: tab('SYNC_RUNS', []),
  }
  // Pestañas ausentes o con encabezados rotos al azar.
  for (const name of ['EVIDENCIAS', 'DEPENDENCIAS', 'CAPACIDAD_SEMANAL', 'PROYECTOS'] as TabName[]) {
    if (r.chance(0.07)) delete raw[name]
    else if (r.chance(0.04)) raw[name] = [['COLUMNA_RARA']]
  }
  return { raw, ref: addDays(REF, r.int(-3, 3)) }
}

function shuffleInput(input: GovernanceInput, seed: number): GovernanceInput {
  const r = rng(seed)
  return {
    ...input,
    proyectos: r.shuffle(input.proyectos), hitos: r.shuffle(input.hitos), tareas: r.shuffle(input.tareas), dependencias: r.shuffle(input.dependencias),
    evidencias: r.shuffle(input.evidencias), decisiones: r.shuffle(input.decisiones), tiempos: r.shuffle(input.tiempos), planes: r.shuffle(input.planes),
    planItems: r.shuffle(input.planItems), capacidad: r.shuffle(input.capacidad), asignaciones: r.shuffle(input.asignaciones),
  }
}

const SEVERITY_RANK = { critica: 0, alta: 1, media: 2, baja: 3, info: 4 }
const ALERT_KEYS = ['acciones', 'categoria', 'confianza', 'diasVencido', 'entidades', 'fechaClave', 'hechos', 'hipotesis', 'id', 'inferencias', 'proyectoId', 'regla', 'severidad', 'tipo']

function check(report: GovernanceReport, input: GovernanceInput) {
  const json = JSON.stringify(report)
  // Sin fugas: ningún texto libre ni correo llega al informe.
  expect(json).not.toContain(SECRET)
  expect(json).not.toMatch(/@example\.com/)
  // IDs únicos y estables; estructura cerrada (sin campos de "ejecución").
  expect(new Set(report.alertas.map((a) => a.id)).size).toBe(report.alertas.length)
  for (const a of report.alertas) {
    expect(Object.keys(a).sort()).toEqual(ALERT_KEYS)
    expect(a.acciones.length).toBeGreaterThan(0)
    for (const text of a.acciones) expect(text).not.toMatch(/\b(se (aprobó|cerró|envió|ejecutó|guardó|desplegó)|aprobado automáticamente)\b/i)
    expect(a.id.startsWith(`${a.regla}-`)).toBe(true)
  }
  // Orden por severidad y resumen coherente.
  for (let i = 1; i < report.alertas.length; i++) {
    expect(SEVERITY_RANK[report.alertas[i - 1]!.severidad]).toBeLessThanOrEqual(SEVERITY_RANK[report.alertas[i]!.severidad])
  }
  expect(report.resumen.total).toBe(report.alertas.length)
  expect(Object.values(report.resumen.porSeveridad).reduce((x, y) => x + y, 0)).toBe(report.alertas.length)
  // Nunca "verde" si falta información.
  const missing = Object.entries(CATEGORY_TABS).filter(([, tabs]) => tabs.some((t) => { const s = input.pestanas[t]; return !s || !s.ok || s.truncated }))
  for (const [categoria] of missing) expect(report.cobertura.find((c) => c.categoria === categoria)!.estado).not.toBe('sin-alertas-detectadas')
  if (missing.length) expect(['critico', 'requiere-atencion', 'datos-incompletos']).toContain(report.estadoGlobal)
}

describe(`propiedades del centro de control (${CASES} casos aleatorios reproducibles)`, () => {
  it('sin fugas, IDs únicos, sin acciones ejecutadas, orden y ningún verde con datos insuficientes', () => {
    let withAlerts = 0
    for (let seed = 1; seed <= CASES; seed++) {
      const { raw, ref } = randomTabs(seed)
      const input = governanceInputFromDataset(buildDataset(raw, { source: 'fixtures', fetchedAt: 0 }))
      const report = buildGovernanceReport(input, { referenceDate: ref })
      try {
        check(report, input)
      } catch (error) {
        throw new Error(`Semilla ${seed}: ${(error as Error).message}`)
      }
      if (report.alertas.length > 5) withAlerts += 1
    }
    expect(withAlerts).toBeGreaterThan(CASES / 2)
  })

  it('determinismo ante reordenamiento e inmutabilidad de la entrada', () => {
    for (let seed = 1; seed <= CASES / 3; seed++) {
      const { raw, ref } = randomTabs(seed)
      const input = governanceInputFromDataset(buildDataset(raw, { source: 'fixtures', fetchedAt: 0 }))
      const snapshot = structuredClone(input)
      const a = buildGovernanceReport(deepFreeze(structuredClone(input)), { referenceDate: ref })
      const b = buildGovernanceReport(shuffleInput(input, seed * 31), { referenceDate: ref })
      expect(b, `semilla ${seed}`).toEqual(a)
      expect(input).toEqual(snapshot)
    }
  })
})
