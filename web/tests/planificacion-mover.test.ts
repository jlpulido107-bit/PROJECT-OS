import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DayList, PlanningView } from '@/components/planning/planning-view'
import { planWeek } from '@/lib/planning/engine'
import { buildExport, EXPORT_SCHEMA, EXPORT_SCHEMA_V2 } from '@/lib/planning/export'
import { DEFAULT_SCENARIO, isDefaultScenario, MAX_FIJADAS, movimientos, normalizeScenario, ScenarioError } from '@/lib/planning/scenario'
import type { PlanningInput, PlanResult, Scenario } from '@/lib/planning/types'
import { baseInput, rng, task } from './helpers/planning-data'

/** ORD-POS-137 (POS-045): mover tareas entre días en la simulación. Datos sintéticos; nada se guarda. */
const MON = '2026-10-05'
const plan = (input: PlanningInput, scenario: Partial<Record<keyof Scenario, unknown>> = {}, referenceDate = MON) =>
  planWeek(input, normalizeScenario(scenario), { referenceDate })
const dayOf = (r: PlanResult, id: string) => r.dias.filter((d) => d.items.some((i) => i.tareaId === id)).map((d) => d.fecha)
const minutesOn = (r: PlanResult, fecha: string) => r.dias.find((d) => d.fecha === fecha)!.propuestoMin
const codes = (r: PlanResult) => r.conflictos.map((c) => c.codigo)

// 20 h, 5 días ⇒ 4 h por día. POS-1 (3 h) y POS-2 (2 h) caen el lunes; SIG-1 (6 h) reparte lunes y martes.
const data = () => baseInput({
  tareas: [
    task('POS-1', 'POS', 3, { prioridad: 'ALTA' }),
    task('POS-2', 'POS', 2),
    task('SIG-1', 'SIG', 6),
    task('SIG-2', 'SIG', 1, { fechaPlan: '2026-10-08' }),
  ],
})

describe('criterio 1: campo fijadas en Scenario, validado en scenario.ts', () => {
  it('acepta tarea → fecha civil y las ordena; vacío no agrega el campo', () => {
    expect(normalizeScenario({ fijadas: { 'SIG-1': '2026-10-07', 'POS-1': '2026-10-06' } }).fijadas).toEqual({ 'POS-1': '2026-10-06', 'SIG-1': '2026-10-07' })
    expect(Object.hasOwn(normalizeScenario({ fijadas: {} }), 'fijadas')).toBe(false)
    expect(Object.hasOwn(normalizeScenario({}), 'fijadas')).toBe(false)
    expect(movimientos(normalizeScenario({ fijadas: { 'POS-1': '2026-10-06' } }))).toBe(1)
  })

  it('rechaza sin corregir en silencio: no objeto, ID o fecha inválidos y demasiados movimientos', () => {
    expect(() => normalizeScenario({ fijadas: ['POS-1'] })).toThrow(ScenarioError)
    expect(() => normalizeScenario({ fijadas: 'POS-1=2026-10-06' })).toThrow(ScenarioError)
    expect(() => normalizeScenario({ fijadas: { 'POS 1': '2026-10-06' } })).toThrow(/ID de tarea/)
    expect(() => normalizeScenario({ fijadas: { 'POS-1': '2026-02-30' } })).toThrow(/fecha/)
    expect(() => normalizeScenario({ fijadas: { 'POS-1': 20261006 } })).toThrow(/fecha/)
    const many = Object.fromEntries(Array.from({ length: MAX_FIJADAS + 1 }, (_, i) => [`T-${i}`, MON]))
    expect(() => normalizeScenario({ fijadas: many })).toThrow(/Demasiados/)
  })

  it('con movimientos el escenario deja de ser el de los datos registrados', () => {
    expect(isDefaultScenario(normalizeScenario({ fijadas: {} }))).toBe(true)
    expect(isDefaultScenario(normalizeScenario({ fijadas: { 'POS-1': '2026-10-06' } }))).toBe(false)
  })
})

describe('criterio 1: el motor coloca primero las fijadas y recalcula el resto', () => {
  it('prueba de igualdad: con fijadas vacías (o ausentes) el resultado es idéntico al de hoy, huella incluida', () => {
    const inputs: PlanningInput[] = [data(), baseInput(), baseInput({ tareas: [task('POS-1', 'POS', null)] })]
    for (let seed = 1; seed <= 60; seed++) {
      const r = rng(seed)
      inputs.push(baseInput({
        tareas: Array.from({ length: r.int(0, 12) }, (_, i) => task(`T-${i}`, r.pick(['POS', 'SIG']), r.pick([null, 0, 0.5, 1, 2, 4, 9]), {
          prioridad: r.pick(['ALTA', 'MEDIA', 'BAJA']),
          fechaPlan: r.chance(0.3) ? `2026-10-0${r.int(5, 9)}` : null,
          fechaLimite: r.chance(0.3) ? `2026-10-0${r.int(1, 9)}` : null,
        })),
      }))
    }
    for (const [i, input] of inputs.entries()) {
      for (const ref of [MON, '2026-10-07']) {
        const today = planWeek(input, normalizeScenario({}), { referenceDate: ref })
        expect(planWeek(input, normalizeScenario({ fijadas: {} }), { referenceDate: ref }), `caso ${i}`).toEqual(today)
        expect(planWeek(input, { ...DEFAULT_SCENARIO, fijadas: {} }, { referenceDate: ref }), `caso ${i}`).toEqual(today)
      }
    }
  })

  it('la tarea fijada queda entera en su día, primero, marcada y la capacidad de cada día cambia al instante', () => {
    const base = plan(data())
    expect(dayOf(base, 'POS-1')).toEqual(['2026-10-05'])
    const moved = plan(data(), { fijadas: { 'POS-1': '2026-10-07' } })
    expect(dayOf(moved, 'POS-1')).toEqual(['2026-10-07'])
    const wed = moved.dias.find((d) => d.fecha === '2026-10-07')!
    expect(wed.items[0]).toEqual(expect.objectContaining({ tareaId: 'POS-1', minutos: 180, orden: 1, fijada: true }))
    expect(minutesOn(moved, '2026-10-07')).toBeGreaterThanOrEqual(180)
    // El hueco del lunes lo toman las demás: el resto se recalcula, sin perder minutos.
    expect(moved.capacidad.propuestoMin).toBe(base.capacidad.propuestoMin)
    expect(moved.dias.flatMap((d) => d.items).filter((i) => i.fijada).map((i) => i.tareaId)).toEqual(['POS-1'])
    expect(moved.supuestos.some((s) => s.includes('1 tarea movida'))).toBe(true)
    expect(moved.huella).not.toBe(base.huella)
  })

  it('una tarea repartida en varios días se junta en el día elegido', () => {
    const base = plan(data())
    expect(dayOf(base, 'SIG-1').length).toBeGreaterThan(1)
    const moved = plan(data(), { fijadas: { 'SIG-1': '2026-10-09' } })
    expect(dayOf(moved, 'SIG-1')).toEqual(['2026-10-09'])
  })

  it('si el movimiento pasa el hueco del día, lo dice con un conflicto (nunca recorta en silencio)', () => {
    const moved = plan(data(), { fijadas: { 'SIG-1': '2026-10-06', 'POS-1': '2026-10-06' } })
    expect(minutesOn(moved, '2026-10-06')).toBeGreaterThan(240)
    expect(codes(moved)).toContain('dia-excedido-por-movimiento')
  })

  it('antes de su FECHA_PLAN: se mueve, con explicación y conflicto', () => {
    const moved = plan(data(), { fijadas: { 'SIG-2': '2026-10-06' } })
    expect(dayOf(moved, 'SIG-2')).toEqual(['2026-10-06'])
    expect(codes(moved)).toContain('fijada-antes-de-fecha-plan')
    expect(moved.tareas.find((t) => t.id === 'SIG-2')!.explicacion.join(' ')).toContain('antes de su FECHA_PLAN')
  })

  it('fuera de la semana o sin tiempo propuesto: no se mueve y queda el aviso', () => {
    const out = plan(data(), { fijadas: { 'POS-1': '2026-10-20' } })
    expect(dayOf(out, 'POS-1')).toEqual(['2026-10-05'])
    expect(codes(out)).toContain('fijada-fuera-de-semana')
    const gone = plan(data(), { fijadas: { 'POS-99': '2026-10-06' } })
    expect(codes(gone)).toContain('fijada-sin-tiempo')
    // A un día pasado tampoco: la referencia es el miércoles.
    const past = plan(data(), { fijadas: { 'POS-2': MON } }, '2026-10-07')
    expect(dayOf(past, 'POS-2')).not.toContain(MON)
    expect(codes(past)).toContain('fijada-fuera-de-semana')
  })

  it('con datos insuficientes no se inventa un plan por mover tareas', () => {
    const r = plan(baseInput({ capacidad: [], tareas: [task('POS-1', 'POS', 2)] }), { fijadas: { 'POS-1': '2026-10-06' } })
    expect(r.estado).toBe('datos-insuficientes')
    expect(r.capacidad.propuestoMin).toBe(0)
  })
})

describe('criterio 5: exportar propuesta', () => {
  it('sin fijadas el esquema v1 no cambia (mismo objeto que antes, sin campo fijadas)', () => {
    const r = plan(data())
    const v1 = buildExport(r, normalizeScenario({}), {})
    expect(v1.esquema).toBe(EXPORT_SCHEMA)
    expect(buildExport(r, { ...DEFAULT_SCENARIO, fijadas: {} }, {})).toEqual(v1)
    expect(Object.hasOwn(v1.escenario, 'fijadas')).toBe(false)
    expect(v1.elementos.every((e) => !Object.hasOwn(e, 'fijada'))).toBe(true)
  })

  it('con fijadas se exporta como v2: escenario.fijadas y fijada en los elementos movidos', () => {
    const s = normalizeScenario({ fijadas: { 'POS-1': '2026-10-07' } })
    const v2 = buildExport(planWeek(data(), s, { referenceDate: MON }), s, {})
    expect(v2.esquema).toBe(EXPORT_SCHEMA_V2)
    expect(v2.escenario.fijadas).toEqual({ 'POS-1': '2026-10-07' })
    expect(v2.elementos.filter((e) => e.fijada).map((e) => [e.tareaId, e.fecha])).toEqual([['POS-1', '2026-10-07']])
  })

  it('el esquema v2 está documentado', () => {
    const doc = readFileSync(path.join(import.meta.dirname, '..', '..', 'docs', 'planificacion-v1-5.md'), 'utf8')
    expect(doc).toContain(EXPORT_SCHEMA_V2)
    expect(doc).toContain('fijadas')
  })
})

describe('criterios 2 a 4: tarjetas, arrastre nativo y aviso', () => {
  const noop = () => {}
  const render = (fijadas: Record<string, string>) => {
    const s = normalizeScenario({ fijadas })
    return renderToStaticMarkup(createElement(DayList, { plan: planWeek(data(), s, { referenceDate: MON }), input: data(), review: {}, setReview: noop, fijadas, onMove: noop }))
  }

  it('cada bloque es arrastrable y trae su selector «Mover a…» con los días que quedan', () => {
    const html = render({})
    expect(html).toContain('draggable="true"')
    expect(html).toContain('Mover a…')
    expect(html).toContain('aria-label="Mover POS-1 a otro día"')
    expect(html).not.toContain('Simulado')
    expect(html).not.toContain('data-simulada')
  })

  it('la tarjeta movida lleva borde punteado (data-simulada) y la marca «Simulado»', () => {
    const html = render({ 'POS-1': '2026-10-07' })
    expect(html).toContain('data-simulada="true"')
    expect(html).toContain('Simulado')
    const css = readFileSync(path.join(import.meta.dirname, '..', 'src', 'components', 'planning', 'planning.module.css'), 'utf8')
    expect(css).toMatch(/\.item\[data-simulada\] \{[^}]*border-style: dashed/)
  })

  it('fijar antes de FECHA_PLAN muestra «antes de su FECHA_PLAN» en la tarjeta y en el selector', () => {
    expect(render({ 'SIG-2': '2026-10-06' })).toContain('>antes de su FECHA_PLAN<')
    expect(render({})).toContain('(antes de su FECHA_PLAN)')
  })

  it('sin movimientos el aviso no habla de movimientos y «Descartar movimientos» está desactivado', () => {
    const html = renderToStaticMarkup(createElement(PlanningView, {
      input: data(), referenceDate: MON, timeZone: 'America/Merida', hitosSemana: { estado: 'ok', datos: [] },
    }))
    expect(html).not.toContain('sin guardar.')
    expect(html).toMatch(/<button type="button" class="button" disabled="">Descartar movimientos<\/button>/)
    const view = readFileSync(path.join(import.meta.dirname, '..', 'src', 'components', 'planning', 'planning-view.tsx'), 'utf8')
    expect(view).toContain("moved > 0 ?")
    expect(view).toContain('movimientos sin guardar.')
    // Arrastre HTML nativo: sin dependencias nuevas.
    expect(view).toMatch(/onDragStart=/)
    expect(view).toMatch(/onDrop=/)
  })
})
