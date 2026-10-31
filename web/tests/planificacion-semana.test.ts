import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CapaSemana } from '@/components/planning/capa-semana'
import { planWeek } from '@/lib/planning/engine'
import { normalizeScenario } from '@/lib/planning/scenario'
import type { PlanningInput, Scenario } from '@/lib/planning/types'
import { diasSemana, fechaCorta, minutosTexto, textoDia, textoDias, type Bloque, type DiasSemana } from '@/lib/planificacion-semana'
import { hitosSemana, type HitoSemana } from '@/lib/planificacion-semana-hitos'
import { etiqueta } from '@/lib/planificacion-v2'
import type { Dataset } from '@/lib/types'
import { baseInput, task, week } from './helpers/planning-data'

/** Capa Semana de Planificación v2 (ORD-POS-121, POS-040; docs/diseno-planificacion-v2.md §5). Datos sintéticos. */

// Semana del lunes 5 al domingo 11 de octubre de 2026; referencia el miércoles 7.
const MIE = '2026-10-07'
const plan = (input: PlanningInput, scenario: Partial<Record<keyof Scenario, unknown>> = {}, referenceDate = MIE) =>
  planWeek(input, normalizeScenario(scenario), { referenceDate })

function conPlanes(): PlanningInput {
  return baseInput({
    tareas: [task('POS-1', 'POS', 30)],
    planes: [
      { id: 'PD-1', fecha: '2026-10-05', semanaId: 'S41', estado: 'APROBADO', horasObjetivo: null },
      { id: 'PD-2', fecha: '2026-10-08', semanaId: 'S41', estado: 'APROBADO', horasObjetivo: null },
    ],
    planItems: [
      { id: 'PI-1', planId: 'PD-1', tareaId: 'POS-1', orden: 1, minutosPlan: 120 },
      { id: 'PI-2', planId: 'PD-2', tareaId: 'POS-1', orden: 1, minutosPlan: 300 },
    ],
    tiempos: [
      { id: 'T-1', tareaId: 'POS-1', fecha: '2026-10-05', minutosReales: 100 },
      { id: 'T-2', tareaId: 'POS-1', fecha: '2026-10-09', minutosReales: 50 },
    ],
  })
}

const ok = <T>(b: Bloque<T>): T => {
  if (b.estado !== 'ok') throw new Error(`se esperaba ok: ${b.motivo}`)
  return b.datos
}

describe('capa Semana: días (planWeek, CAPACIDAD_SEMANAL, TIEMPOS)', () => {
  it('planeadas = plan registrado + propuesto, contra la capacidad del día, con el real solo hasta hoy', () => {
    const r = plan(conPlanes())
    const s = ok(diasSemana(r, []))
    expect(s.dias).toHaveLength(7)
    expect(s.origen).toBe('dato')
    expect(s.semanaId).toBe('S41')
    for (const [i, d] of s.dias.entries()) {
      const motor = r.dias[i]!
      expect(d.planeadoMin).toBe(motor.planExistenteMin + motor.propuestoMin)
      expect(d.disponibleMin).toBe(motor.laborable ? motor.capacidadMin : null)
    }
    const lun = s.dias[0]!
    expect(lun.realMin).toBe(100)
    expect(lun.esPasado).toBe(true)
    expect(lun.disponibleMin).toBeNull()
    // El viernes 9 aún no llega: su TIEMPOS no se muestra como real.
    expect(s.dias[4]!.realMin).toBeNull()
    expect(s.dias[2]!.esHoy).toBe(true)
    expect(s.planeadoMin).toBe(s.dias.reduce((a, d) => a + d.planeadoMin, 0))
  })

  it('pasarse de la capacidad se dice con texto, no solo con color', () => {
    const s = ok(diasSemana(plan(conPlanes()), []))
    const jue = s.dias[3]!
    // 20 h en 5 días = 4 h por día; el jueves tiene 5 h registradas en PLAN_ITEMS.
    expect(jue.disponibleMin).toBe(240)
    expect(jue.excesoMin).toBe(60)
    expect(textoDia(jue)).toContain('5 h de 4 h · 1 h por encima de la capacidad')
    // Un día pasado no tiene cuota en el motor: se dice, sin inventarla.
    expect(textoDia(s.dias[0]!)).toBe('2 h planeadas (día pasado) · real 1 h 40 min')
    expect(textoDia(s.dias[5]!)).toBe('(no laborable)')
  })

  it('el origen de la capacidad se ve: «supuesto» cuando el escenario la supone', () => {
    const s = ok(diasSemana(plan(baseInput({ capacidad: [] }), { horasSiFaltan: 10 }), []))
    expect(s.origen).toBe('supuesto')
    const html = renderToStaticMarkup(createElement(CapaSemana, { dias: { estado: 'ok', datos: s }, hitos: { estado: 'ok', datos: [] } }))
    expect(html).toContain('data-origen="supuesto"')
    expect(html).toContain('Capacidad supuesta')
    expect(html).toContain('supuesto, no es un dato')
  })

  it('sin capacidad, con capacidad ambigua o sin pestañas legibles, la capa queda sin-datos (nunca un 0)', () => {
    const faltante = diasSemana(plan(baseInput({ capacidad: [] })), [])
    expect(faltante).toEqual({ estado: 'sin-datos', motivo: expect.stringContaining('CAPACIDAD_SEMANAL') })
    const ambigua = diasSemana(plan(baseInput({ capacidad: [week('A', '2026-10-05', 20), week('B', '2026-10-06', 10)] })), [])
    expect(ambigua.estado).toBe('sin-datos')
    for (const tab of ['CAPACIDAD_SEMANAL', 'PLAN_ITEMS', 'TIEMPOS']) {
      const input = { ...conPlanes(), pestanasNoDisponibles: [tab] }
      expect(diasSemana(plan(input), input.pestanasNoDisponibles)).toEqual({ estado: 'sin-datos', motivo: expect.stringContaining(tab) })
    }
    const html = renderToStaticMarkup(createElement(CapaSemana, { dias: faltante, hitos: { estado: 'ok', datos: [] } }))
    expect(html).toContain('data-estado="sin-datos"')
    expect(html).not.toMatch(/0 min de/)
  })

  it('la reserva se muestra en porcentaje', () => {
    const s = ok(diasSemana(plan(baseInput({ capacidad: [week('S41', '2026-10-05', 20, 0.15)] })), []))
    expect(s.reservaPct).toBe(15)
    expect(s.netaMin).toBe(1020)
  })
})

function ds(hitos: Array<Partial<Dataset['hitos'][number]> & { id: string }>, tareas: Array<{ id: string; hitoId: string | null; estado: string }>, tabs: { HITOS?: boolean; TAREAS?: boolean } = {}) {
  const tab = (ok: boolean) => ({ ok, truncated: false })
  return {
    tabs: { HITOS: tab(tabs.HITOS ?? true), TAREAS: tab(tabs.TAREAS ?? true) },
    hitos: hitos.map((h) => ({ proyectoId: 'POS', nombre: null, resultadoEsperado: null, fechaObjetivo: null, estado: 'EN_PROGRESO', criterioAceptacion: null, actualizadoEn: null, ...h })),
    tareas: tareas.map((t) => ({ ...t, proyectoId: 'POS', titulo: t.id })),
  } as unknown as Dataset
}

describe('capa Semana: hitos (HITOS, TAREAS)', () => {
  const datos = ds(
    [
      { id: 'POS-H2', nombre: 'Dashboard usable a diario', fechaObjetivo: '2026-10-21' },
      { id: 'POS-H1', nombre: 'Rol Tiempos', fechaObjetivo: '2026-10-07' },
      { id: 'POS-H3', nombre: null, fechaObjetivo: '2026-10-01' },
      { id: 'POS-H4', nombre: 'Sin fecha' },
      { id: 'POS-H0', nombre: 'Cerrado', fechaObjetivo: '2026-10-08', estado: 'COMPLETADO' },
    ],
    [
      { id: 'T1', hitoId: 'POS-H2', estado: 'COMPLETADO' },
      { id: 'T2', hitoId: 'POS-H2', estado: 'EN_PROGRESO' },
      { id: 'T3', hitoId: 'POS-H2', estado: 'CANCELADO' },
      { id: 'T4', hitoId: 'POS-H1', estado: 'COMPLETADO' },
    ],
  )

  it('hitos abiertos con días restantes y avance, primero el que vence antes', () => {
    const h = ok(hitosSemana(datos, MIE))
    expect(h.map((x) => x.id)).toEqual(['POS-H3', 'POS-H1', 'POS-H2', 'POS-H4'])
    const h2 = h.find((x) => x.id === 'POS-H2')!
    expect(h2).toMatchObject({ dias: 14, completadas: 1, total: 2, avance: 'avance 1 de 2 tareas', marca: null })
    expect(h.find((x) => x.id === 'POS-H1')).toMatchObject({ dias: 0, marca: 'proximo', avance: 'avance 1 de 1 tareas' })
    expect(h.find((x) => x.id === 'POS-H3')).toMatchObject({ dias: -6, marca: 'vencido' })
    expect(textoDias(14)).toBe('vence en 14 días')
    expect(textoDias(0)).toBe('vence hoy')
    expect(textoDias(-6)).toBe('vencido hace 6 días')
    expect(textoDias(null)).toBe('sin fecha objetivo')
  })

  it('un hito sin tareas dice «avance no medible»', () => {
    const h = ok(hitosSemana(datos, MIE))
    expect(h.find((x) => x.id === 'POS-H4')!.avance).toBe('avance no medible')
    expect(h.find((x) => x.id === 'POS-H3')!.avance).toBe('avance no medible')
  })

  it('regla de lenguaje (F1 sin fusionar): el nombre va junto al ID, primero el nombre', () => {
    expect(etiqueta({ tipo: 'hito', id: 'POS-H2', nombre: 'Dashboard usable a diario' }).texto).toBe('Dashboard usable a diario · POS-H2')
    expect(etiqueta({ tipo: 'hito', id: 'POS-H3', nombre: '  ' }).texto).toBe('(hito sin nombre) · POS-H3')
    const h = ok(hitosSemana(datos, MIE))
    const html = renderToStaticMarkup(createElement(CapaSemana, { dias: { estado: 'sin-datos', motivo: 'x' }, hitos: { estado: 'ok', datos: h } }))
    for (const x of h) {
      // Cada aparición del ID va precedida de su nombre (o del marcador «sin nombre»).
      const apariciones = html.split(x.id).length - 1
      expect(apariciones).toBeGreaterThan(0)
      expect(html.split(`${x.texto.slice(0, -x.id.length)}${x.id}`).length - 1).toBe(apariciones)
    }
    expect(html).toContain('Dashboard usable a diario · POS-H2')
  })

  it('sin HITOS o TAREAS legibles, sin-datos', () => {
    expect(hitosSemana(ds([], [], { HITOS: false }), MIE)).toEqual({ estado: 'sin-datos', motivo: expect.stringContaining('HITOS') })
    expect(hitosSemana(ds([], [], { TAREAS: false }), MIE)).toEqual({ estado: 'sin-datos', motivo: expect.stringContaining('TAREAS') })
  })
})

describe('capa Semana: render accesible y solo lectura', () => {
  const semana: DiasSemana = ok(diasSemana(plan(conPlanes()), []))
  const hitos: HitoSemana[] = ok(hitosSemana(ds([{ id: 'POS-H1', nombre: 'Rol Tiempos', fechaObjetivo: '2026-10-09' }], []), MIE))
  const html = renderToStaticMarkup(createElement(CapaSemana, { dias: { estado: 'ok', datos: semana }, hitos: { estado: 'ok', datos: hitos } }))

  it('cada gráfica de barras lleva su tabla accesible con encabezados', () => {
    expect(html.match(/<ul[^>]*aria-hidden="true"/g)).toHaveLength(2)
    expect(html.match(/<table/g)).toHaveLength(2)
    expect(html).toContain('<caption>Horas por día de la semana 2026-W41</caption>')
    expect(html).toContain('<caption>Hitos abiertos con días restantes y avance</caption>')
    expect(html).toContain('<th scope="row">mié 7 oct (hoy)</th>')
    expect(html).toContain('1 h por encima de la capacidad')
  })

  it('las barras no superan el 100 % y no tienen color de «bien» o «mal»', () => {
    for (const m of html.matchAll(/width:(\d+)%/g)) expect(Number(m[1])).toBeLessThanOrEqual(100)
    expect(html).not.toMatch(/danger|ok-fg|warn-fg/)
  })

  it('sin escritura: no hay formularios ni botones, y las funciones no llaman a la red', () => {
    expect(html).not.toMatch(/<form|<button/)
    for (const f of ['src/lib/planificacion-semana.ts', 'src/lib/planificacion-semana-hitos.ts', 'src/components/planning/capa-semana.tsx']) {
      expect(readFileSync(f, 'utf8')).not.toMatch(/fetch\(|operations|sheets-client|method:/)
    }
  })

  it('la parte del navegador no importa módulos de servidor', () => {
    expect(readFileSync('src/lib/planificacion-semana.ts', 'utf8')).not.toMatch(/from '\.\/(inicio|estado|types)'/)
    expect(readFileSync('src/components/planning/capa-semana.tsx', 'utf8')).toMatch(/import type \{ HitoSemana \}/)
  })

  it('formatos en palabras cortas', () => {
    expect(minutosTexto(45)).toBe('45 min')
    expect(minutosTexto(150)).toBe('2 h 30 min')
    expect(minutosTexto(120)).toBe('2 h')
    expect(fechaCorta('2026-10-31')).toBe('sáb 31 oct')
  })
})

