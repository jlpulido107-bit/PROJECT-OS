import { describe, expect, it } from 'vitest'
import { addCivilDays, isCivilDate, isoMonday, isoWeekday, isoWeekId } from '@/lib/planning/calendar'
import { planWeek } from '@/lib/planning/engine'
import { acceptedDrafts, buildExport, EXPORT_SCHEMA, reviewKey } from '@/lib/planning/export'
import { referenceDateFor } from '@/lib/planning/reference'
import { compareIds, normalizeTaskPriority } from '@/lib/planning/rules'
import { DEFAULT_SCENARIO, isDefaultScenario, normalizeScenario, ScenarioError, scenarioFromSearchParams } from '@/lib/planning/scenario'
import type { PlanningInput, PlanResult, Scenario } from '@/lib/planning/types'
import { baseInput, deepFreeze, dep, emptyInput, project, task, week } from './helpers/planning-data'

const MON = '2026-10-05'
const plan = (input: PlanningInput, scenario: Partial<Record<keyof Scenario, unknown>> = {}, referenceDate = MON) =>
  planWeek(input, normalizeScenario(scenario), { referenceDate })
const t = (r: PlanResult, id: string) => r.tareas.find((x) => x.id === id)!
const items = (r: PlanResult) => r.dias.flatMap((d) => d.items.map((i) => ({ ...i, fecha: d.fecha })))
const codes = (issues: Array<{ codigo: string }>) => issues.map((i) => i.codigo)

describe('calendario ISO y zona horaria', () => {
  it('identifica semanas ISO, también en el cambio de año', () => {
    expect(isoWeekId('2026-10-08')).toBe('2026-W41')
    expect(isoWeekId('2026-12-31')).toBe('2026-W53')
    expect(isoWeekId('2027-01-01')).toBe('2026-W53')
    expect(isoWeekId('2027-01-04')).toBe('2027-W01')
    expect(isoWeekId('2024-12-30')).toBe('2025-W01')
    expect(isoMonday('2026-10-11')).toBe('2026-10-05')
    expect(isoWeekday('2026-10-11')).toBe(7)
    expect(addCivilDays('2028-02-28', 1)).toBe('2028-02-29')
  })

  it('valida fechas civiles sin desbordes', () => {
    expect(isCivilDate('2026-02-30')).toBe(false)
    expect(isCivilDate('2028-02-29')).toBe(true)
    expect(isCivilDate('2026-10-5')).toBe(false)
    expect(() => planWeek(baseInput(), DEFAULT_SCENARIO, { referenceDate: '2026-13-01' })).toThrow()
  })

  it('la fecha de referencia se calcula en America/Merida, no en UTC', () => {
    // Domingo 11 a las 23:30 en Mérida = lunes 12 a las 05:30 UTC.
    const instant = Date.UTC(2026, 9, 12, 5, 30)
    expect(referenceDateFor(instant)).toBe('2026-10-11')
    expect(referenceDateFor(instant, 'UTC')).toBe('2026-10-12')
    const r = plan(baseInput(), {}, referenceDateFor(instant))
    expect(r.referencia.semanaIso).toBe('2026-W41')
    expect(r.referencia.zona).toBe('America/Merida')
  })
})

describe('capacidad neta', () => {
  it('neta = horas × (1 − reserva), en minutos enteros', () => {
    const r = plan(baseInput({ capacidad: [week('S41', MON, 20, 0.15)] }))
    expect(r.capacidad.netaMin).toBe(1020)
    expect(r.capacidad.reservaPct).toBe(15)
    expect(r.capacidad.origen).toBe('dato')
  })

  it('reserva del 100 % ⇒ capacidad 0, nada propuesto y conflicto explícito', () => {
    const r = plan(baseInput({ tareas: [task('POS-1', 'POS', 2)] }), { reservaPct: 100 })
    expect(r.capacidad.netaMin).toBe(0)
    expect(r.capacidad.propuestoMin).toBe(0)
    expect(codes(r.conflictos)).toContain('capacidad-cero')
    expect(t(r, 'POS-1').categoria).toBe('sin-capacidad')
  })

  it('0 horas disponibles ⇒ nada propuesto', () => {
    const r = plan(baseInput({ capacidad: [week('S41', MON, 0)], tareas: [task('POS-1', 'POS', 2)] }))
    expect(r.capacidad.propuestoMin).toBe(0)
    expect(r.estado).toBe('propuesta')
  })

  it('sin horas registradas ⇒ datos insuficientes y pregunta concreta, sin plan ficticio', () => {
    const r = plan(baseInput({ capacidad: [week('S41', MON, null)], tareas: [task('POS-1', 'POS', 2)] }))
    expect(r.estado).toBe('datos-insuficientes')
    expect(codes(r.preguntas)).toContain('capacidad-faltante')
    expect(r.capacidad.propuestoMin).toBe(0)
    expect(r.preguntas[0]!.mensaje).toMatch(/HORAS_DISPONIBLES/)
  })

  it('sin fila de semana ⇒ insuficiente; el escenario "capacidad no registrada" lo marca como supuesto', () => {
    const input = baseInput({ capacidad: [], tareas: [task('POS-1', 'POS', 2)] })
    expect(plan(input).estado).toBe('datos-insuficientes')
    const r = plan(input, { horasSiFaltan: 10 })
    expect(r.estado).toBe('propuesta')
    expect(r.capacidad.origen).toBe('supuesto')
    expect(r.supuestos.join(' ')).toMatch(/no es un dato/)
    expect(t(r, 'POS-1').propuestoMin).toBe(120)
  })

  it('dos filas para la misma semana ⇒ ambigua, pregunta y nada propuesto', () => {
    const r = plan(baseInput({ capacidad: [week('A', MON, 10), week('B', '2026-10-07', 12)], tareas: [task('POS-1', 'POS', 2)] }), { horasSiFaltan: 5 })
    expect(r.capacidad.origen).toBe('ambigua')
    expect(r.estado).toBe('datos-insuficientes')
    expect(codes(r.preguntas)).toContain('capacidad-ambigua')
  })

  it('FECHA_INICIO que no es lunes se asocia a su semana ISO con aviso', () => {
    const r = plan(baseInput({ capacidad: [week('S41', '2026-10-06', 10)] }))
    expect(r.capacidad.origen).toBe('dato')
    expect(codes(r.conflictos)).toContain('semana-no-inicia-lunes')
  })

  it('ajuste de horas que deja negativo ⇒ 0, con conflicto', () => {
    const r = plan(baseInput({ capacidad: [week('S41', MON, 5)] }), { ajusteHoras: -10 })
    expect(r.capacidad.horasDisponibles).toBe(0)
    expect(codes(r.conflictos)).toContain('horas-negativas')
  })

  it('la capacidad de días pasados no se traslada a los días restantes', () => {
    // Jueves: 20 h / 5 días = 4 h por día. Quedan jueves y viernes: máximo 8 h nuevas aunque no se usara nada.
    const r = plan(baseInput({ tareas: [task('POS-1', 'POS', 40)] }), {}, '2026-10-08')
    expect(r.dias.find((d) => d.fecha === '2026-10-08')!.capacidadMin).toBe(240)
    expect(r.capacidad.propuestoMin).toBe(480)
  })
})

describe('planes y tiempos existentes (sin doble descuento)', () => {
  const input = () => baseInput({
    tareas: [task('POS-1', 'POS', 10), task('POS-2', 'POS', 1)],
    planes: [{ id: 'P1', fecha: '2026-10-07', semanaId: 'S41', estado: 'EN_CURSO', horasObjetivo: 3 }],
    planItems: [{ id: 'I1', planId: 'P1', tareaId: 'POS-1', orden: 1, minutosPlan: 120 }],
    tiempos: [
      { id: 'T1', tareaId: 'POS-1', fecha: '2026-10-07', minutosReales: 45 },
      { id: 'T0', tareaId: 'POS-2', fecha: '2026-10-05', minutosReales: 60 },
    ],
  })

  it('el mismo día cuenta máx(plan, real), no la suma; días pasados cuentan el tiempo real', () => {
    const r = plan(input(), {}, '2026-10-07')
    const wed = r.dias.find((d) => d.fecha === '2026-10-07')!
    expect(wed.planExistenteMin).toBe(120)
    expect(wed.realMin).toBe(45)
    expect(wed.usadoMin).toBe(120)
    expect(wed.capacidadMin).toBe(180) // HORAS_OBJETIVO del plan registrado
    expect(wed.libreMin).toBe(60)
    expect(r.dias.find((d) => d.fecha === '2026-10-05')!.usadoMin).toBe(60)
    expect(r.capacidad.usadoMin).toBe(180)
    expect(r.capacidad.libreMin).toBe(1200 - 180)
  })

  it('lo ya planificado de una tarea se descuenta de su necesidad, y no se alteran los planes', () => {
    const data = deepFreeze(input())
    const r = plan(data, {}, '2026-10-07')
    expect(t(r, 'POS-1').yaPlanificadoMin).toBe(120)
    expect(t(r, 'POS-1').necesidadMin).toBe(600 - 120)
    expect(data.planItems).toEqual([{ id: 'I1', planId: 'P1', tareaId: 'POS-1', orden: 1, minutosPlan: 120 }])
  })

  it('una tarea totalmente cubierta por planes registrados no se vuelve a proponer', () => {
    const r = plan(baseInput({
      tareas: [task('POS-1', 'POS', 2)],
      planes: [{ id: 'P1', fecha: MON, semanaId: 'S41', estado: 'PLANIFICADO', horasObjetivo: null }],
      planItems: [{ id: 'I1', planId: 'P1', tareaId: 'POS-1', orden: 1, minutosPlan: 120 }],
    }))
    expect(t(r, 'POS-1').motivos).toEqual(['ya-planificada'])
    expect(r.capacidad.propuestoMin).toBe(0)
  })

  it('el tiempo registrado no se descuenta por defecto (no equivale a avance); el escenario sí lo hace', () => {
    const data = baseInput({ tareas: [task('POS-1', 'POS', 2)], tiempos: [{ id: 'T1', tareaId: 'POS-1', fecha: '2026-09-30', minutosReales: 90 }] })
    const def = plan(data)
    expect(t(def, 'POS-1').necesidadMin).toBe(120)
    expect(t(def, 'POS-1').explicacion.join(' ')).toMatch(/no se descuenta/)
    const sim = plan(data, { descontarRegistrado: true })
    expect(t(sim, 'POS-1').necesidadMin).toBe(30)
    expect(sim.supuestos.join(' ')).toMatch(/No significa que la tarea haya avanzado/)
  })

  it('registrado ≥ estimación: pregunta de re-estimación; con descuento queda excluida', () => {
    const data = baseInput({ tareas: [task('POS-1', 'POS', 1)], tiempos: [{ id: 'T1', tareaId: 'POS-1', fecha: '2026-09-30', minutosReales: 90 }] })
    expect(codes(plan(data).preguntas)).toContain('estimacion-excedida')
    expect(t(plan(data, { descontarRegistrado: true }), 'POS-1').motivos).toContain('estimacion-agotada')
  })

  it('días con plan registrado sobreasignado y planes que exceden la capacidad generan conflictos', () => {
    const r = plan(baseInput({
      capacidad: [week('S41', MON, 4)],
      planes: [{ id: 'P1', fecha: MON, semanaId: 'S41', estado: 'PLANIFICADO', horasObjetivo: 5 }],
      planItems: [{ id: 'I1', planId: 'P1', tareaId: null, orden: 1, minutosPlan: 360 }],
    }))
    expect(codes(r.conflictos)).toEqual(expect.arrayContaining(['planes-exceden-capacidad', 'dia-sobreasignado', 'sobrecarga']))
    expect(r.capacidad.libreMin).toBe(0)
  })
})

describe('elegibilidad', () => {
  it('excluye cerradas, sin estado, bloqueadas y explica el motivo', () => {
    const r = plan(baseInput({
      tareas: [
        task('POS-1', 'POS', 2, { estado: 'COMPLETADO' }),
        task('POS-2', 'POS', 2, { estado: null }),
        task('POS-3', 'POS', 2, { estado: 'BLOQUEADO' }),
        task('POS-4', 'POS', 2, { bloqueo: 'Falta acceso' }),
        task('POS-5', 'POS', 2),
      ],
    }))
    expect(r.tareas.map((x) => x.id)).not.toContain('POS-1')
    expect(r.resumen.cerradasOmitidas).toBe(1)
    expect(t(r, 'POS-2').motivos).toContain('sin-estado')
    expect(t(r, 'POS-3').motivos).toContain('bloqueada')
    expect(t(r, 'POS-4').explicacion.join(' ')).toMatch(/Falta acceso/)
    expect(t(r, 'POS-5').categoria).toBe('propuesta')
    expect(items(r).map((i) => i.tareaId)).toEqual(['POS-5'])
  })

  it('dependencias: pendiente, satisfecha, inactiva, inexistente y de tarea cerrada', () => {
    const r = plan(baseInput({
      tareas: [
        task('POS-1', 'POS', 1), task('POS-2', 'POS', 1), task('POS-3', 'POS', 1, { estado: 'COMPLETADO' }),
        task('POS-4', 'POS', 1), task('POS-5', 'POS', 1), task('POS-6', 'POS', 1, { estado: 'CANCELADO' }),
      ],
      dependencias: [
        dep('D1', 'POS-2', 'POS-1'), // pendiente
        dep('D2', 'POS-4', 'POS-3'), // satisfecha
        dep('D3', 'POS-5', 'POS-1', 'INACTIVA'), // no exige
        dep('D4', 'POS-1', 'POS-99'), // inexistente
        dep('D5', 'POS-6', 'POS-1'), // dependiente cerrada: no cuenta
      ],
    }))
    expect(t(r, 'POS-2').motivos).toEqual(['dependencia-pendiente'])
    expect(t(r, 'POS-2').explicacion.join(' ')).toMatch(/POS-1 \(PENDIENTE\)/)
    expect(t(r, 'POS-4').categoria).toBe('propuesta')
    expect(t(r, 'POS-5').categoria).toBe('propuesta')
    expect(t(r, 'POS-1').motivos).toEqual(['dependencia-inexistente'])
    expect(t(r, 'POS-1').desbloquea).toBe(1)
    expect(codes(r.preguntas)).toContain('dependencia-inexistente')
  })

  it('un prerrequisito CANCELADO sigue bloqueando y genera una pregunta', () => {
    const r = plan(baseInput({
      tareas: [task('POS-1', 'POS', 1, { estado: 'CANCELADO' }), task('POS-2', 'POS', 1)],
      dependencias: [dep('D1', 'POS-2', 'POS-1')],
    }))
    expect(t(r, 'POS-2').motivos).toEqual(['dependencia-pendiente'])
    expect(r.preguntas.find((q) => q.codigo === 'prerrequisito-cancelado')?.refs).toEqual(['POS-2'])
  })

  it('ciclos (incluida la autodependencia) excluyen a sus miembros y generan una pregunta', () => {
    const r = plan(baseInput({
      tareas: [task('POS-1', 'POS', 1), task('POS-2', 'POS', 1), task('POS-3', 'POS', 1), task('POS-4', 'POS', 1)],
      dependencias: [dep('D1', 'POS-1', 'POS-2'), dep('D2', 'POS-2', 'POS-3'), dep('D3', 'POS-3', 'POS-1'), dep('D4', 'POS-4', 'POS-4')],
    }))
    for (const id of ['POS-1', 'POS-2', 'POS-3', 'POS-4']) expect(t(r, id).motivos).toContain('ciclo-dependencias')
    const cycles = r.preguntas.filter((p) => p.codigo === 'ciclo-dependencias').map((p) => p.refs)
    expect(cycles).toEqual([['POS-1', 'POS-2', 'POS-3'], ['POS-4']])
    expect(r.capacidad.propuestoMin).toBe(0)
  })

  it('dependencias duplicadas o incompletas se informan y cuentan una vez', () => {
    const r = plan(baseInput({
      tareas: [task('POS-1', 'POS', 1), task('POS-2', 'POS', 1)],
      dependencias: [dep('D1', 'POS-2', 'POS-1'), dep('D2', 'POS-2', 'POS-1'), dep('D3', null, 'POS-1')],
    }))
    expect(t(r, 'POS-1').desbloquea).toBe(1)
    expect(codes(r.conflictos)).toEqual(expect.arrayContaining(['dependencia-duplicada', 'dependencia-incompleta']))
  })

  it('IDs duplicados, proyecto ausente, inexistente o inactivo', () => {
    const r = plan(baseInput({
      proyectos: [project('POS', 'ALTA'), project('OLD', 'ALTA', 'PAUSADO')],
      tareas: [task('POS-1', 'POS', 1), task('X-1', null, 1), task('ZZZ-1', 'ZZZ', 1), task('OLD-1', 'OLD', 1)],
      idsDuplicados: { TAREAS: ['POS-1'], PROYECTOS: [], DEPENDENCIAS: [] },
    }))
    expect(t(r, 'POS-1').motivos).toContain('id-duplicado')
    expect(t(r, 'X-1').motivos).toContain('sin-proyecto')
    expect(t(r, 'ZZZ-1').motivos).toContain('proyecto-inexistente')
    expect(t(r, 'OLD-1').motivos).toContain('proyecto-inactivo')
    expect(r.capacidad.propuestoMin).toBe(0)
  })

  it('sin estimación: nunca se inventan horas; el escenario las supone y lo marca', () => {
    const data = baseInput({ tareas: [task('POS-1', 'POS', null)] })
    const r = plan(data)
    expect(t(r, 'POS-1').motivos).toEqual(['sin-estimacion'])
    expect(codes(r.preguntas)).toContain('sin-estimacion')
    const s = plan(data, { horasSiSinEstimacion: 1.5 })
    expect(t(s, 'POS-1').estimacionSupuesta).toBe(true)
    expect(t(s, 'POS-1').propuestoMin).toBe(90)
    expect(t(s, 'POS-1').explicacion.join(' ')).toMatch(/SUPUESTA/)
  })

  it('FECHA_PLAN: no se propone antes de esa fecha; si es posterior a la semana, se excluye', () => {
    const r = plan(baseInput({ tareas: [task('POS-1', 'POS', 2, { fechaPlan: '2026-10-08' }), task('POS-2', 'POS', 2, { fechaPlan: '2026-10-20' })] }))
    expect(items(r).filter((i) => i.tareaId === 'POS-1').every((i) => i.fecha >= '2026-10-08')).toBe(true)
    expect(t(r, 'POS-1').propuestoMin).toBe(120)
    expect(t(r, 'POS-2').motivos).toEqual(['programada-despues'])
  })

  it('pestañas no disponibles ⇒ datos insuficientes', () => {
    const r = plan(baseInput({ tareas: [task('POS-1', 'POS', 1)], pestanasNoDisponibles: ['DEPENDENCIAS'] }))
    expect(r.estado).toBe('datos-insuficientes')
    expect(codes(r.preguntas)).toContain('pestana-no-disponible')
    expect(r.capacidad.propuestoMin).toBe(0)
  })
})

describe('prioridad, urgencia y desempates', () => {
  it('normaliza categorías y trata las desconocidas con seguridad (después de BAJA)', () => {
    expect(normalizeTaskPriority('alta')).toMatchObject({ categoria: 'ALTA', desconocida: false })
    expect(normalizeTaskPriority('URGENTE')).toMatchObject({ categoria: 'CRITICA' })
    expect(normalizeTaskPriority('P1')).toMatchObject({ categoria: 'P1', desconocida: true, rango: 4 })
    expect(normalizeTaskPriority(null)).toMatchObject({ categoria: 'SIN_PRIORIDAD', desconocida: true })
    const r = plan(baseInput({ tareas: [task('POS-1', 'POS', 1, { prioridad: 'P1' }), task('POS-2', 'POS', 1, { prioridad: 'BAJA' })] }))
    expect(t(r, 'POS-2').rango).toBe(1)
    expect(t(r, 'POS-1').rango).toBe(2)
    expect(codes(r.conflictos)).toContain('prioridad-desconocida')
  })

  it('vencidas primero, luego las que vencen en la semana, luego prioridad', () => {
    const r = plan(baseInput({
      tareas: [
        task('POS-1', 'POS', 1, { prioridad: 'CRITICA' }),
        task('POS-2', 'POS', 1, { prioridad: 'BAJA', fechaLimite: '2026-10-09' }),
        task('POS-3', 'POS', 1, { prioridad: 'BAJA', fechaLimite: '2026-10-01' }),
      ],
    }))
    expect(['POS-3', 'POS-2', 'POS-1'].map((id) => t(r, id).rango)).toEqual([1, 2, 3])
    expect(t(r, 'POS-3').vencida).toBe(true)
    expect(t(r, 'POS-3').explicacion[0]).toMatch(/Vencida desde 2026-10-01 \(4 días\)/)
    expect(codes(r.conflictos)).toContain('tareas-vencidas')
  })

  it('con igual prioridad: desbloquea más, luego en curso, luego límite, luego ID natural', () => {
    const r = plan(baseInput({
      tareas: [
        task('POS-10', 'POS', 1), task('POS-2', 'POS', 1), task('POS-3', 'POS', 1, { estado: 'EN_PROGRESO' }),
        task('POS-4', 'POS', 1, { fechaLimite: '2026-12-01' }), task('POS-5', 'POS', 1), task('POS-6', 'POS', 1),
      ],
      dependencias: [dep('D1', 'POS-6', 'POS-5')],
    }))
    const order = r.tareas.filter((x) => x.rango !== null).map((x) => x.id)
    expect(order).toEqual(['POS-5', 'POS-3', 'POS-4', 'POS-2', 'POS-10'])
    expect(compareIds('POS-2', 'POS-10')).toBeLessThan(0)
  })

  it('una tarea con límite en la semana que no cabe genera conflicto', () => {
    const r = plan(baseInput({ capacidad: [week('S41', MON, 2)], tareas: [task('POS-1', 'POS', 6, { fechaLimite: '2026-10-07' })] }))
    expect(t(r, 'POS-1').categoria).toBe('parcial')
    expect(codes(r.conflictos)).toContain('no-cabe-antes-del-limite')
  })
})

describe('reparto entre proyectos y asignaciones', () => {
  it('sobrecarga: nunca se propone más que la capacidad libre', () => {
    const r = plan(baseInput({ capacidad: [week('S41', MON, 5)], tareas: [task('POS-1', 'POS', 10), task('SIG-1', 'SIG', 10)] }))
    // 300 min libres; el resto que no forma un bloque de 30 min en un día ya ocupado queda libre (12 min).
    expect(r.capacidad.propuestoMin).toBe(288)
    expect(r.capacidad.propuestoMin).toBeLessThanOrEqual(r.capacidad.libreMin)
  })

  it('el escenario de sobrecarga infla estimaciones sin tocar los datos', () => {
    const data = deepFreeze(baseInput({ tareas: [task('POS-1', 'POS', 2)] }))
    const r = plan(data, { sobrecargaPct: 50 })
    expect(t(r, 'POS-1').estimacionMin).toBe(180)
    expect(data.tareas[0]!.horasEstimadas).toBe(2)
  })

  it('anti-inanición: un proyecto de prioridad baja recibe su piso aunque otro tenga más peso', () => {
    const r = plan(baseInput({
      proyectos: [project('POS', 'ALTA'), project('SIG', 'BAJA')],
      capacidad: [week('S41', MON, 4)],
      tareas: [task('POS-1', 'POS', 20), task('SIG-1', 'SIG', 20)],
    }))
    const sig = r.proyectos.find((p) => p.id === 'SIG')!
    const pos = r.proyectos.find((p) => p.id === 'POS')!
    expect(sig.presupuestoMin).toBeGreaterThanOrEqual(60)
    expect(pos.presupuestoMin).toBeGreaterThan(sig.presupuestoMin)
    expect(pos.presupuestoMin + sig.presupuestoMin).toBe(240)
  })

  it('reparto proporcional al peso (ALTA 3 : MEDIA 2) y prioridad simulada por proyecto', () => {
    const data = baseInput({ capacidad: [week('S41', MON, 10)], tareas: [task('POS-1', 'POS', 40), task('SIG-1', 'SIG', 40)] })
    const r = plan(data)
    // 600 min: piso de 60 a cada uno y el resto (480) en proporción 3:2 ⇒ 60 + 288 y 60 + 192.
    expect(r.proyectos.find((p) => p.id === 'POS')!.presupuestoMin).toBe(348)
    expect(r.proyectos.find((p) => p.id === 'SIG')!.presupuestoMin).toBe(252)
    const s = plan(data, { prioridadProyecto: { SIG: 'ALTA', POS: 'BAJA' } })
    expect(s.proyectos.find((p) => p.id === 'SIG')!.prioridadSimulada).toBe(true)
    expect(s.proyectos.find((p) => p.id === 'SIG')!.presupuestoMin).toBeGreaterThan(s.proyectos.find((p) => p.id === 'POS')!.presupuestoMin)
  })

  it('respeta ASIGNACIONES: no supera las horas objetivo del proyecto (descontando lo usado)', () => {
    const r = plan(baseInput({
      tareas: [task('POS-1', 'POS', 10), task('SIG-1', 'SIG', 10)],
      asignaciones: [{ id: 'A1', semanaId: 'S41', proyectoId: 'POS', horasObjetivo: 2 }],
      tiempos: [{ id: 'T1', tareaId: 'POS-1', fecha: MON, minutosReales: 30 }],
    }), {}, '2026-10-06')
    const pos = r.proyectos.find((p) => p.id === 'POS')!
    expect(pos.asignadoMin).toBe(120)
    expect(pos.propuestoMin).toBe(90)
    expect(t(r, 'POS-1').explicacion.join(' ')).toMatch(/asignación/)
  })

  it('asignaciones que exceden la capacidad: conflicto y sin sobreasignar; duplicadas: pregunta', () => {
    const r = plan(baseInput({
      capacidad: [week('S41', MON, 3)],
      tareas: [task('POS-1', 'POS', 10), task('SIG-1', 'SIG', 10)],
      asignaciones: [
        { id: 'A1', semanaId: 'S41', proyectoId: 'POS', horasObjetivo: 5 },
        { id: 'A2', semanaId: 'S41', proyectoId: 'SIG', horasObjetivo: 1 },
        { id: 'A3', semanaId: 'S41', proyectoId: 'SIG', horasObjetivo: 2 },
      ],
    }))
    expect(codes(r.conflictos)).toContain('asignaciones-exceden-capacidad')
    expect(codes(r.preguntas)).toContain('asignacion-duplicada')
    expect(r.capacidad.propuestoMin).toBeLessThanOrEqual(180)
  })
})

describe('secuencia diaria', () => {
  it('reparte por días laborables, sin bloques menores a 30 min salvo el resto, y nada en fin de semana', () => {
    const r = plan(baseInput({ tareas: [task('POS-1', 'POS', 5), task('POS-2', 'POS', 0.25)] }))
    for (const d of r.dias) {
      if (!d.laborable) expect(d.items).toEqual([])
      expect(d.propuestoMin).toBeLessThanOrEqual(d.libreMin)
    }
    expect(items(r).find((i) => i.tareaId === 'POS-2')!.minutos).toBe(15)
    expect(r.dias[0]!.items.map((i) => i.orden)).toEqual([1, 2])
  })

  it('máximo 180 min por tarea y día cuando hay alternativas; se amplía si no las hay', () => {
    const alone = plan(baseInput({ tareas: [task('POS-1', 'POS', 4)] }))
    expect(alone.dias[0]!.items).toEqual([expect.objectContaining({ tareaId: 'POS-1', minutos: 240 })])
    const two = plan(baseInput({ tareas: [task('POS-1', 'POS', 4), task('POS-2', 'POS', 4)] }))
    expect(two.dias[0]!.items.map((i) => [i.tareaId, i.minutos])).toEqual([['POS-1', 180], ['POS-2', 60]])
  })

  it('el escenario de días laborables incluye el sábado y la semana siguiente no tiene días pasados', () => {
    const r = plan(baseInput({ tareas: [task('POS-1', 'POS', 30)] }), { diasLaborables: [1, 2, 3, 4, 5, 6] })
    expect(r.dias[5]!.items.length).toBe(1)
    const next = plan(baseInput({ capacidad: [week('S42', '2026-10-12', 10)], tareas: [task('POS-1', 'POS', 2)] }), { semana: 'siguiente' }, '2026-10-08')
    expect(next.referencia.lunes).toBe('2026-10-12')
    expect(next.dias.every((d) => !d.esPasado)).toBe(true)
    expect(next.capacidad.propuestoMin).toBe(120)
  })
})

describe('reproducibilidad, escenarios y no mutación', () => {
  const data = () => baseInput({
    tareas: [task('POS-1', 'POS', 3, { prioridad: 'ALTA' }), task('POS-2', 'POS', 2), task('SIG-1', 'SIG', 5, { fechaLimite: '2026-10-08' })],
    dependencias: [dep('D1', 'POS-2', 'POS-9')],
  })

  it('misma entrada ⇒ misma salida, aunque cambie el orden de las filas', () => {
    const a = plan(data())
    const reversed = data()
    reversed.tareas.reverse()
    reversed.proyectos.reverse()
    const b = plan(reversed)
    expect(b).toEqual(a)
    expect(b.huella).toBe(a.huella)
    expect(plan(data(), { ajusteHoras: 1 }).huella).not.toBe(a.huella)
  })

  it('no muta la entrada (congelada en profundidad) y restablecer devuelve el resultado base', () => {
    const frozen = deepFreeze(data())
    const base = plan(frozen)
    plan(frozen, { ajusteHoras: -5, reservaPct: 30, sobrecargaPct: 100, descontarRegistrado: true, prioridadProyecto: { SIG: 'BAJA' } })
    expect(plan(frozen)).toEqual(base)
    expect(isDefaultScenario(normalizeScenario({}))).toBe(true)
    expect(isDefaultScenario(normalizeScenario({ ajusteHoras: 1 }))).toBe(false)
  })

  it('valida escenarios sin corregir en silencio', () => {
    expect(() => normalizeScenario({ reservaPct: 150 })).toThrow(ScenarioError)
    expect(() => normalizeScenario({ ajusteHoras: 'abc' })).toThrow(ScenarioError)
    expect(() => normalizeScenario({ ajusteHoras: 1.1 })).toThrow(/múltiplos/)
    expect(() => normalizeScenario({ diasLaborables: [0] })).toThrow(ScenarioError)
    expect(() => normalizeScenario({ semana: 'pasada' })).toThrow(ScenarioError)
    expect(() => normalizeScenario({ prioridadProyecto: { POS: 'ALTISIMA' } })).toThrow(ScenarioError)
    expect(normalizeScenario({ diasLaborables: '5,1,1' }).diasLaborables).toEqual([1, 5])
    expect(() => scenarioFromSearchParams(new URLSearchParams('foo=1'))).toThrow(/no reconocido/)
    expect(() => scenarioFromSearchParams(new URLSearchParams('reservaPct=1&reservaPct=2'))).toThrow(/repetido/)
    expect(scenarioFromSearchParams(new URLSearchParams('reservaPct=10&prioridad.SIG=ALTA&semana=siguiente'))).toMatchObject({
      reservaPct: 10, semana: 'siguiente', prioridadProyecto: { SIG: 'ALTA' },
    })
  })
})

describe('exportación local de la propuesta', () => {
  it('esquema versionado, campos minimizados y decisiones de revisión', () => {
    const r = plan(baseInput({ tareas: [task('POS-1', 'POS', 2, { titulo: 'Título privado' }), task('SIG-1', 'SIG', 1)] }))
    const first = r.dias[0]!.items[0]!
    const exported = buildExport(r, normalizeScenario({}), { [reviewKey(r.dias[0]!.fecha, first.tareaId)]: { decision: 'ajustado', minutos: 45 } })
    expect(exported.esquema).toBe(EXPORT_SCHEMA)
    expect(exported.aviso).toMatch(/no se guardó ni se aplicó/)
    const text = JSON.stringify(exported)
    expect(text).not.toContain('Título privado')
    expect(text).not.toMatch(/@|titulo|nombre|responsable/i)
    expect(exported.elementos[0]).toMatchObject({ tareaId: first.tareaId, decision: 'ajustado', minutosRevisados: 45 })
    expect(exported.elementos.slice(1).every((e) => e.decision === 'pendiente' && e.minutosRevisados === null)).toBe(true)
  })

  it('punto de extensión V1.4: solo aceptados/ajustados > 0 pasan a borradores de PLAN_ITEMS (sin escribir)', () => {
    const r = plan(baseInput({ tareas: [task('POS-1', 'POS', 1), task('SIG-1', 'SIG', 1), task('POS-2', 'POS', 1)] }))
    const day = r.dias[0]!
    const [a, b, c] = day.items
    const exported = buildExport(r, normalizeScenario({}), {
      [reviewKey(day.fecha, a!.tareaId)]: { decision: 'aceptado' },
      [reviewKey(day.fecha, b!.tareaId)]: { decision: 'rechazado' },
      [reviewKey(day.fecha, c!.tareaId)]: { decision: 'ajustado', minutos: 20 },
    })
    expect(acceptedDrafts(exported)).toEqual([
      { fecha: day.fecha, tareaId: a!.tareaId, orden: 1, minutosPlan: a!.minutos },
      { fecha: day.fecha, tareaId: c!.tareaId, orden: 2, minutosPlan: 20 },
    ])
  })
})

describe('entrada vacía', () => {
  it('sin tareas: propuesta vacía sin errores ni NaN', () => {
    const r = plan({ ...emptyInput(), capacidad: [week('S41', MON, 10)] })
    expect(r.estado).toBe('propuesta')
    expect(r.tareas).toEqual([])
    expect(JSON.stringify(r)).not.toMatch(/NaN|Infinity/)
  })
})

describe('revisión de integración (PR #10)', () => {
  it('la segunda pasada no amplía una tarea por encima de 180 min mientras otra tenga trabajo pendiente', () => {
    // Lunes con 10 h registradas en PLAN_DIARIO; dos tareas de 6 h del mismo proyecto (objetivo semanal 6 h cada una).
    const r = plan(baseInput({
      tareas: [task('POS-1', 'POS', 6), task('POS-2', 'POS', 6)],
      planes: [{ id: 'P1', fecha: MON, semanaId: 'S41', estado: 'PLANIFICADO', horasObjetivo: 10 }],
    }))
    const monday = r.dias[0]!.items.map((i) => [i.tareaId, i.minutos])
    // Antes: [['POS-1', 360], ['POS-2', 240]] (la primera acaparaba el hueco). Ahora se reparte por turnos.
    expect(monday).toEqual([['POS-1', 300], ['POS-2', 300]])
    expect(r.dias[0]!.propuestoMin).toBe(600)
    // Sin alternativas, la única tarea sí puede superar 180 min.
    const alone = plan(baseInput({ tareas: [task('POS-1', 'POS', 6)], planes: [{ id: 'P1', fecha: MON, semanaId: 'S41', estado: 'PLANIFICADO', horasObjetivo: 10 }] }))
    expect(alone.dias[0]!.items).toEqual([expect.objectContaining({ tareaId: 'POS-1', minutos: 360 })])
  })

  it('distingue saldo semanal teórico de hueco colocable (las cuotas de días pasados caducan)', () => {
    // Viernes sin actividad previa: saldo semanal 20 h, pero solo cabe la cuota del viernes (4 h).
    const r = plan(baseInput({ tareas: [task('POS-1', 'POS', 40)] }), {}, '2026-10-09')
    expect(r.capacidad.libreMin).toBe(1200)
    expect(r.capacidad.colocableMin).toBe(240)
    expect(r.capacidad.propuestoMin).toBe(240)
    expect(r.capacidad.propuestoMin).toBeLessThanOrEqual(r.capacidad.colocableMin)
  })
})
