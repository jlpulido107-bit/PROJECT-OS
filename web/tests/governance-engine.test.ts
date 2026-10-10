import { describe, expect, it } from 'vitest'
import { buildGovernanceReport } from '@/lib/governance/engine'
import { applyFilters, FilterError, parseControlParams } from '@/lib/governance/filters'
import { governanceInputFromDataset, governanceLabels } from '@/lib/governance/input'
import type { GovernanceInput, GovernanceReport } from '@/lib/governance/types'
import { addDays, daysBetween, isCivilDate, isoMonday } from '@/lib/governance/util'
import { buildFixtureTabs } from '@/lib/fixtures'
import { buildDataset } from '@/lib/table'
import { deepFreeze, gTask, govInput } from './helpers/governance-data'

const REF = '2026-10-09' // viernes; semana ISO 2026-10-05 a 2026-10-11
const run = (input: GovernanceInput, referenceDate = REF) => buildGovernanceReport(input, { referenceDate })
const rules = (r: GovernanceReport) => r.alertas.map((a) => a.regla)
const find = (r: GovernanceReport, regla: string, id?: string) =>
  r.alertas.find((a) => a.regla === regla && (!id || a.entidades.some((e) => e.id === id)))

describe('fechas', () => {
  it('fechas civiles y semana ISO sin desfases', () => {
    expect(isCivilDate('2026-02-29')).toBe(false)
    expect(isCivilDate('2028-02-29')).toBe(true)
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(daysBetween('2026-10-01', REF)).toBe(8)
    expect(isoMonday('2026-10-11')).toBe('2026-10-05')
    expect(() => run(govInput(), '2026-13-01')).toThrow()
    expect(run(govInput()).referencia.semana).toEqual({ lunes: '2026-10-05', domingo: '2026-10-11' })
  })
})

describe('decisiones', () => {
  it('pendiente: media; alta con ≥ 14 días; separa hechos, inferencias y acción sugerida', () => {
    const r = run(govInput({ decisiones: [
      { id: 'DEC-1', proyectoId: 'POS', fecha: '2026-10-05', estado: 'PENDIENTE' },
      { id: 'DEC-2', proyectoId: 'POS', fecha: '2026-09-20', estado: 'EN_REVISION' },
      { id: 'DEC-3', proyectoId: 'POS', fecha: null, estado: 'PROPUESTA' },
    ] }))
    const a = find(r, 'decision-pendiente', 'DEC-1')!
    expect(a.severidad).toBe('media')
    expect(a.hechos).toEqual(['DECISIONES.ESTADO = PENDIENTE.', 'DECISIONES.FECHA = 2026-10-05.'])
    expect(a.inferencias).toEqual(['Pendiente desde hace 4 días.'])
    expect(a.acciones[0]).toMatch(/no autoriza merges, despliegues, escrituras ni gasto/)
    expect(find(r, 'decision-pendiente', 'DEC-2')!.severidad).toBe('alta')
    expect(find(r, 'decision-pendiente', 'DEC-2')!.hipotesis.length).toBe(1)
    expect(find(r, 'decision-pendiente', 'DEC-3')!.inferencias[0]).toMatch(/desconocida/)
  })

  it('resueltas no generan alertas; desconocidas y vacías se marcan con seguridad', () => {
    const r = run(govInput({ decisiones: [
      { id: 'DEC-1', proyectoId: 'POS', fecha: REF, estado: 'APROBADA' },
      { id: 'DEC-2', proyectoId: 'POS', fecha: REF, estado: 'EN_ESPERA_DE_FIRMA' },
      { id: 'DEC-3', proyectoId: 'POS', fecha: REF, estado: null },
    ] }))
    expect(find(r, 'decision-pendiente', 'DEC-1')).toBeUndefined()
    expect(find(r, 'decision-estado-desconocido', 'DEC-2')).toMatchObject({ tipo: 'revision', severidad: 'baja', confianza: 'media' })
    expect(find(r, 'decision-sin-estado', 'DEC-3')).toMatchObject({ tipo: 'diagnostico' })
  })

  it('decisión pendiente en proyecto inactivo o inexistente ⇒ discrepancia', () => {
    const r = run(govInput({
      proyectos: [{ id: 'POS', estado: 'PAUSADO' }],
      decisiones: [{ id: 'DEC-1', proyectoId: 'POS', fecha: REF, estado: 'PENDIENTE' }, { id: 'DEC-2', proyectoId: 'ZZZ', fecha: REF, estado: 'APROBADA' }],
    }))
    expect(find(r, 'decision-proyecto-inactivo', 'DEC-1')).toMatchObject({ tipo: 'discrepancia', severidad: 'alta' })
    expect(find(r, 'decision-proyecto-inexistente', 'DEC-2')).toBeDefined()
  })
})

describe('tareas, bloqueos y vencimientos', () => {
  it('bloqueada: media; alta si vence en ≤ 7 días o está vencida; el texto del bloqueo no entra al motor', () => {
    const r = run(govInput({ tareas: [
      gTask('POS-1', { estado: 'BLOQUEADO' }),
      gTask('POS-2', { tieneBloqueo: true, fechaLimite: '2026-10-14' }),
      gTask('POS-3', { tieneBloqueo: true, estado: 'COMPLETADO' }),
    ] }))
    expect(find(r, 'tarea-bloqueada', 'POS-1')!.severidad).toBe('media')
    expect(find(r, 'tarea-bloqueada', 'POS-2')!.severidad).toBe('alta')
    expect(find(r, 'tarea-bloqueada', 'POS-2')!.hechos).toContain('TAREAS.BLOQUEO registrado (texto en Sheets).')
    expect(find(r, 'tarea-bloqueada', 'POS-3')).toBeUndefined()
  })

  it('vencida (incumplimiento) frente a vence pronto (riesgo); cerradas no cuentan', () => {
    const r = run(govInput({ tareas: [
      gTask('POS-1', { fechaLimite: '2026-10-01' }),
      gTask('POS-2', { fechaLimite: '2026-10-12' }),
      gTask('POS-3', { fechaLimite: '2026-10-20' }),
      gTask('POS-4', { fechaLimite: '2026-10-01', estado: 'COMPLETADO' }),
    ] }))
    expect(find(r, 'tarea-vencida', 'POS-1')).toMatchObject({ tipo: 'incumplimiento', severidad: 'alta', diasVencido: 8 })
    expect(find(r, 'tarea-vence-pronto', 'POS-2')).toMatchObject({ tipo: 'riesgo', confianza: 'media' })
    expect(find(r, 'tarea-vence-pronto', 'POS-2')!.hipotesis).toEqual(['Riesgo de no terminar a tiempo.'])
    expect(rules(r).filter((x) => x.startsWith('tarea-ven'))).toHaveLength(2)
  })

  it('sin estado y referencias rotas (solo si la pestaña referida está disponible)', () => {
    const input = govInput({ tareas: [gTask('POS-1', { estado: null }), gTask('X-1', { proyectoId: 'ZZZ', hitoId: 'H-9' })] })
    const r = run(input)
    expect(find(r, 'tarea-sin-estado', 'POS-1')).toBeDefined()
    expect(find(r, 'tarea-referencia-rota', 'X-1')!.hechos).toHaveLength(2)
    // Sin PROYECTOS ni HITOS legibles, no se acusa referencia rota (evita falsos positivos).
    const degraded = run({ ...input, pestanas: { ...input.pestanas, PROYECTOS: undefined, HITOS: { ok: false, truncated: false, duplicateIds: [], invalidCells: 0 } } })
    expect(find(degraded, 'tarea-referencia-rota')).toBeUndefined()
    expect(find(degraded, 'pestana-no-disponible', 'PROYECTOS')!.severidad).toBe('critica')
    expect(find(degraded, 'pestana-no-disponible', 'HITOS')!.severidad).toBe('alta')
  })

  it('completada sin evidencia: solo revisión de confianza baja, nunca incumplimiento', () => {
    const r = run(govInput({
      tareas: [gTask('POS-1', { estado: 'COMPLETADO' }), gTask('POS-2', { estado: 'COMPLETADO' }), gTask('POS-3', { estado: 'COMPLETADO' })],
      evidencias: [{ id: 'E-1', tareaId: 'POS-2', verificacion: 'CONFIRMADO' }, { id: 'E-2', tareaId: 'POS-3', verificacion: 'PENDIENTE' }],
    }))
    const a = find(r, 'tarea-completada-sin-evidencia', 'POS-1')!
    expect(a).toMatchObject({ tipo: 'revision', severidad: 'baja', confianza: 'baja' })
    expect(a.hipotesis[0]).toMatch(/no un incumplimiento/)
    expect(a.acciones[0]).toMatch(/no se modifica/)
    expect(find(r, 'tarea-completada-sin-evidencia', 'POS-2')).toBeUndefined()
    expect(find(r, 'tarea-completada-sin-evidencia', 'POS-3')!.hechos[1]).toMatch(/ninguna con VERIFICACION = CONFIRMADO/)
    // Sin EVIDENCIAS legible, no se sugiere nada.
    const input = govInput({ tareas: [gTask('POS-1', { estado: 'COMPLETADO' })] })
    expect(find(run({ ...input, pestanas: { ...input.pestanas, EVIDENCIAS: undefined } }), 'tarea-completada-sin-evidencia')).toBeUndefined()
  })
})

describe('dependencias', () => {
  it('pendiente, satisfecha, inactiva, inexistente, prerrequisito cancelado y dependiente cerrada', () => {
    const r = run(govInput({
      tareas: [
        gTask('POS-1'), gTask('POS-2', { fechaLimite: '2026-10-12' }), gTask('POS-3', { estado: 'COMPLETADO' }), gTask('POS-4'),
        gTask('POS-5', { estado: 'CANCELADO' }), gTask('POS-6'), gTask('POS-7', { estado: 'COMPLETADO' }),
      ],
      dependencias: [
        { id: 'D1', tareaId: 'POS-2', dependeDeTareaId: 'POS-1', estado: 'ACTIVA' },
        { id: 'D2', tareaId: 'POS-4', dependeDeTareaId: 'POS-3', estado: 'ACTIVA' },
        { id: 'D3', tareaId: 'POS-4', dependeDeTareaId: 'POS-1', estado: 'RESUELTA' },
        { id: 'D4', tareaId: 'POS-6', dependeDeTareaId: 'POS-99', estado: null },
        { id: 'D5', tareaId: 'POS-6', dependeDeTareaId: 'POS-5', estado: 'ACTIVA' },
        { id: 'D6', tareaId: 'POS-7', dependeDeTareaId: 'POS-1', estado: 'ACTIVA' },
        { id: 'D7', tareaId: 'POS-2', dependeDeTareaId: 'POS-1', estado: 'ACTIVA' },
      ],
    }))
    const pending = r.alertas.filter((a) => a.regla === 'dependencia-pendiente')
    expect(pending).toHaveLength(1) // D7 duplica D1; D6 tiene la dependiente cerrada
    expect(pending[0]!.severidad).toBe('alta')
    expect(find(r, 'dependencia-inexistente', 'D4')).toMatchObject({ severidad: 'alta' })
    expect(find(r, 'dependencia-prerrequisito-cancelado', 'D5')).toBeDefined()
    expect(rules(r)).not.toContain('dependencia-circular')
  })

  it('un ciclo (y una autodependencia) generan UNA alerta crítica por ciclo', () => {
    const r = run(govInput({
      tareas: [gTask('POS-1'), gTask('POS-2'), gTask('POS-3'), gTask('POS-4')],
      dependencias: [
        { id: 'D1', tareaId: 'POS-1', dependeDeTareaId: 'POS-2', estado: 'ACTIVA' },
        { id: 'D2', tareaId: 'POS-2', dependeDeTareaId: 'POS-3', estado: 'ACTIVA' },
        { id: 'D3', tareaId: 'POS-3', dependeDeTareaId: 'POS-1', estado: 'ACTIVA' },
        { id: 'D4', tareaId: 'POS-4', dependeDeTareaId: 'POS-4', estado: 'ACTIVA' },
      ],
    }))
    const cycles = r.alertas.filter((a) => a.regla === 'dependencia-circular')
    expect(cycles.map((c) => c.entidades.map((e) => e.id))).toEqual([['POS-1', 'POS-2', 'POS-3'], ['POS-4']])
    expect(cycles.every((c) => c.severidad === 'critica')).toBe(true)
    expect(r.estadoGlobal).toBe('critico')
    expect(r.alertas[0]!.regla).toBe('dependencia-circular')
  })
})

describe('hitos y proyectos', () => {
  it('hito vencido, en riesgo, completado con tareas abiertas y sin proyecto', () => {
    const r = run(govInput({
      hitos: [
        { id: 'H-1', proyectoId: 'POS', estado: 'EN_PROGRESO', fechaObjetivo: '2026-10-01' },
        { id: 'H-2', proyectoId: 'POS', estado: 'EN_PROGRESO', fechaObjetivo: '2026-10-14' },
        { id: 'H-3', proyectoId: 'POS', estado: 'COMPLETADO', fechaObjetivo: '2026-09-01' },
        { id: 'H-4', proyectoId: 'ZZZ', estado: 'CANCELADO', fechaObjetivo: null },
      ],
      tareas: [gTask('POS-1', { hitoId: 'H-2' }), gTask('POS-2', { hitoId: 'H-3' }), gTask('POS-3', { hitoId: 'H-3', estado: 'COMPLETADO' })],
    }))
    expect(find(r, 'hito-vencido', 'H-1')).toMatchObject({ tipo: 'incumplimiento', diasVencido: 8 })
    expect(find(r, 'hito-en-riesgo', 'H-2')).toMatchObject({ tipo: 'riesgo', confianza: 'baja' })
    expect(find(r, 'hito-completado-con-tareas-abiertas', 'H-3')!.entidades.map((e) => e.id)).toEqual(['H-3', 'POS-2'])
    expect(find(r, 'hito-proyecto-inexistente', 'H-4')).toBeDefined()
    expect(find(r, 'hito-vencido', 'H-3')).toBeUndefined()
  })

  it('proyecto inactivo con trabajo abierto ⇒ revisión', () => {
    const r = run(govInput({ proyectos: [{ id: 'POS', estado: 'CERRADO' }], tareas: [gTask('POS-1')] }))
    expect(find(r, 'proyecto-inactivo-con-trabajo-abierto', 'POS')).toMatchObject({ tipo: 'revision', severidad: 'media' })
    expect(r.proyectos.find((p) => p.id === 'POS')!.activo).toBe(false)
  })

  it('evidencias y tiempos con tareas inexistentes', () => {
    const r = run(govInput({
      evidencias: [{ id: 'E-1', tareaId: 'POS-404', verificacion: 'CONFIRMADO' }],
      tiempos: [{ id: 'S-1', tareaId: 'POS-404' }, { id: 'S-2', tareaId: 'POS-404' }],
    }))
    expect(find(r, 'evidencia-vinculo-roto', 'E-1')).toBeDefined()
    expect(find(r, 'tiempo-tarea-inexistente')!.entidades.map((e) => e.id)).toEqual(['S-1', 'S-2'])
  })
})

describe('compromisos y capacidad', () => {
  const week = { id: 'S41', fechaInicio: '2026-10-05', horasDisponibles: 2, reservaPct: 0.5 }

  it('lo comprometido en PLAN_ITEMS supera la capacidad neta ⇒ incumplimiento', () => {
    const r = run(govInput({
      capacidad: [week],
      planes: [{ id: 'P1', fecha: '2026-10-09', estado: 'PLANIFICADO' }, { id: 'P0', fecha: '2026-10-05', estado: 'CANCELADO' }],
      planItems: [{ id: 'I1', planId: 'P1', tareaId: null, minutosPlan: 90 }, { id: 'I0', planId: 'P0', tareaId: null, minutosPlan: 500 }],
    }))
    const a = find(r, 'compromiso-excede-capacidad')!
    expect(a.inferencias[0]).toBe('Capacidad neta 1 h 00 min < comprometido 1 h 30 min (exceso 0 h 30 min).')
  })

  it('asignaciones por encima de la capacidad ⇒ riesgo; sin horas ⇒ no verificable (sin falso verde)', () => {
    const r = run(govInput({ capacidad: [week], asignaciones: [{ id: 'A1', semanaId: 'S41', horasObjetivo: 3 }] }))
    expect(find(r, 'asignaciones-exceden-capacidad')).toMatchObject({ tipo: 'riesgo' })
    const nv = run(govInput({ capacidad: [{ ...week, horasDisponibles: null }], planes: [{ id: 'P1', fecha: REF, estado: null }], planItems: [{ id: 'I1', planId: 'P1', tareaId: null, minutosPlan: 30 }] }))
    expect(find(nv, 'capacidad-no-verificable')).toMatchObject({ tipo: 'diagnostico', severidad: 'media' })
    const ambiguous = run(govInput({ capacidad: [week, { ...week, id: 'S41b' }], planes: [{ id: 'P1', fecha: REF, estado: null }] }))
    expect(find(ambiguous, 'capacidad-no-verificable')!.hechos[0]).toMatch(/2 filas/)
  })

  it('planes de hoy o futuros con tareas no ejecutables; planes pasados sin cerrar', () => {
    const r = run(govInput({
      tareas: [gTask('POS-1', { estado: 'COMPLETADO' }), gTask('POS-2', { estado: 'BLOQUEADO' }), gTask('POS-3')],
      planes: [{ id: 'P1', fecha: REF, estado: 'PLANIFICADO' }, { id: 'P0', fecha: '2026-10-07', estado: 'EN_CURSO' }, { id: 'PX', fecha: '2026-10-06', estado: 'CERRADO' }],
      planItems: [
        { id: 'I1', planId: 'P1', tareaId: 'POS-1', minutosPlan: 30 }, { id: 'I2', planId: 'P1', tareaId: 'POS-2', minutosPlan: 30 },
        { id: 'I3', planId: 'P1', tareaId: 'POS-404', minutosPlan: 30 }, { id: 'I4', planId: 'P1', tareaId: 'POS-3', minutosPlan: 30 },
      ],
    }))
    const bad = r.alertas.filter((a) => a.regla === 'plan-con-tarea-no-ejecutable').map((a) => a.entidades.find((e) => e.tipo === 'plan-item')!.id)
    expect(bad).toEqual(['I1', 'I2', 'I3'])
    expect(find(r, 'plan-diario-sin-cerrar', 'P0')).toMatchObject({ tipo: 'revision', diasVencido: 2 })
    expect(find(r, 'plan-diario-sin-cerrar', 'PX')).toBeUndefined()
  })
})

describe('datos faltantes, duplicados y cobertura (sin falsos verdes)', () => {
  it('entrada vacía con todo legible ⇒ "sin alertas detectadas", nunca "todo bien"', () => {
    const r = run(govInput())
    expect(r.estadoGlobal).toBe('sin-alertas-detectadas')
    expect(r.cobertura.every((c) => c.estado === 'sin-alertas-detectadas')).toBe(true)
  })

  it('pestañas ausentes ⇒ categorías sin datos y estado global nunca verde', () => {
    const input = govInput()
    const r = run({ ...input, pestanas: { ...input.pestanas, EVIDENCIAS: { ok: true, truncated: true, duplicateIds: [], invalidCells: 0 } } })
    expect(r.cobertura.find((c) => c.categoria === 'evidencias')!.estado).toBe('sin-datos')
    expect(find(r, 'pestana-no-disponible', 'EVIDENCIAS')!.hechos[0]).toMatch(/truncada/)
    expect(r.estadoGlobal).toBe('requiere-atencion')
    const none = run({ ...input, pestanas: {} })
    expect(none.estadoGlobal).toBe('critico')
    expect(none.cobertura.filter((c) => c.categoria !== 'datos').every((c) => c.estado !== 'sin-alertas-detectadas')).toBe(true)
  })

  it('IDs duplicados y celdas inválidas se informan', () => {
    const input = govInput()
    const r = run({ ...input, pestanas: { ...input.pestanas, TAREAS: { ok: true, truncated: false, duplicateIds: ['POS-2', 'POS-1'], invalidCells: 3 } } })
    expect(find(r, 'ids-duplicados', 'TAREAS')!.hechos[0]).toBe('TAREAS tiene IDs repetidos: POS-1, POS-2.')
    expect(find(r, 'celdas-invalidas', 'TAREAS')!.hechos[0]).toBe('TAREAS: 3 celdas con formato inválido.')
  })

  it('solo revisiones de severidad baja ⇒ "revisiones sugeridas"', () => {
    const r = run(govInput({ tareas: [gTask('POS-1', { estado: 'COMPLETADO' })] }))
    expect(r.estadoGlobal).toBe('revisiones-sugeridas')
  })
})

describe('orden, IDs estables, determinismo e inmutabilidad', () => {
  const sample = () => govInput({
    proyectos: [{ id: 'POS', estado: 'EN_PROGRESO' }, { id: 'SIG', estado: 'PAUSADO' }],
    tareas: [gTask('POS-10', { fechaLimite: '2026-09-01' }), gTask('POS-2', { fechaLimite: '2026-10-01' }), gTask('SIG-1', { proyectoId: 'SIG' }), gTask('POS-3', { estado: 'BLOQUEADO' })],
    decisiones: [{ id: 'DEC-1', proyectoId: 'SIG', fecha: '2026-10-01', estado: 'PENDIENTE' }],
  })

  it('orden: severidad → tipo → días vencido → proyecto → regla → id', () => {
    const r = run(sample())
    expect(r.alertas.map((a) => `${a.severidad}:${a.regla}:${a.entidades[0]!.id}`)).toEqual([
      'alta:tarea-vencida:POS-10',
      'alta:tarea-vencida:POS-2',
      'alta:decision-proyecto-inactivo:SIG',
      'media:tarea-bloqueada:POS-3',
      'media:decision-pendiente:SIG',
      'media:proyecto-inactivo-con-trabajo-abierto:SIG',
    ])
  })

  it('mismo informe con filas reordenadas; IDs únicos y estables; entrada inmutable', () => {
    const a = run(deepFreeze(sample()))
    const shuffled = sample()
    shuffled.tareas.reverse()
    shuffled.proyectos.reverse()
    const b = run(shuffled)
    expect(b).toEqual(a)
    expect(new Set(a.alertas.map((x) => x.id)).size).toBe(a.alertas.length)
    expect(a.alertas.every((x) => /^[a-z0-9-]+-[0-9a-f]{8}$/.test(x.id))).toBe(true)
    // Un cambio de fecha de referencia cambia la huella, pero no el ID de una alerta que persiste.
    const later = run(sample(), '2026-10-10')
    expect(later.huella).not.toBe(a.huella)
    expect(later.alertas.find((x) => x.regla === 'tarea-vencida')!.id).toBe(a.alertas.find((x) => x.regla === 'tarea-vencida')!.id)
  })
})

describe('señales opcionales del planificador V1.5 (desacopladas)', () => {
  it('se convierten en alertas marcadas como simuladas y con referencias saneadas', () => {
    const r = run(govInput({
      tareas: [gTask('POS-1')],
      planificacion: { semanaIso: '2026-W41', conflictos: [{ codigo: 'sobrecarga', refs: [] }, { codigo: 'no-cabe-antes-del-limite', refs: ['POS-1', '<script>'] }] },
    }))
    expect(find(r, 'planificacion-sobrecarga')).toMatchObject({ severidad: 'alta', tipo: 'riesgo' })
    const b = find(r, 'planificacion-no-cabe-antes-del-limite')!
    expect(b.entidades).toEqual([{ tipo: 'tarea', id: 'POS-1' }])
    expect(b.hipotesis[0]).toMatch(/no es un dato registrado/)
  })

  it('la proyección descarta el texto libre de las señales (p. ej. `mensaje` del PlanResult)', () => {
    const ds = buildDataset(buildFixtureTabs(REF), { source: 'fixtures', fetchedAt: 0 })
    const signals = { semanaIso: '2026-W41', conflictos: [{ codigo: 'sobrecarga', mensaje: 'Texto libre privado', refs: ['DEMO-002'] }] }
    const input = governanceInputFromDataset(ds, signals)
    expect(JSON.stringify(input)).not.toContain('Texto libre privado')
    expect(input.planificacion!.conflictos).toEqual([{ codigo: 'sobrecarga', refs: ['DEMO-002'] }])
  })
})

describe('filtros (UI y API)', () => {
  it('valida parámetros y filtra', () => {
    expect(() => parseControlParams(new URLSearchParams('foo=1'))).toThrow(FilterError)
    expect(() => parseControlParams(new URLSearchParams('severidad=urgente'))).toThrow(/Usa/)
    expect(() => parseControlParams(new URLSearchParams('fecha=2026-02-30'))).toThrow(FilterError)
    expect(() => parseControlParams(new URLSearchParams('tipo=riesgo&tipo=bloqueo'))).toThrow(/repetido/)
    const { filters, fecha } = parseControlParams(new URLSearchParams('proyecto=POS&severidad=alta&fecha=2026-10-09'))
    expect(fecha).toBe(REF)
    const r = run(govInput({ tareas: [gTask('POS-1', { fechaLimite: '2026-10-01' }), gTask('SIG-1', { proyectoId: 'SIG', fechaLimite: '2026-10-01' })] }))
    expect(applyFilters(r.alertas, filters).map((a) => a.entidades[0]!.id)).toEqual(['POS-1'])
    expect(applyFilters(r.alertas, { proyecto: 'sin-proyecto' })).toEqual([])
  })
})

describe('integración con el conjunto de datos (fixtures)', () => {
  it('proyección sin texto libre y alertas esperadas de los datos sintéticos', () => {
    const ds = buildDataset(buildFixtureTabs(REF), { source: 'fixtures', fetchedAt: 0 })
    const input = governanceInputFromDataset(ds)
    const text = JSON.stringify(input)
    for (const freeText of ['Tarea demo', 'Falta aprobación', 'Descripción sintética', 'Persona demo', 'Decisión demo', 'Nota sintética']) expect(text).not.toContain(freeText)
    const r = run(input)
    expect(find(r, 'tarea-bloqueada', 'DEMO-003')).toBeDefined()
    expect(find(r, 'dependencia-pendiente', 'DEMO-D2')).toBeDefined()
    expect(find(r, 'tarea-sin-estado', 'DEMO-004')).toBeDefined()
    expect(find(r, 'evidencia-vinculo-roto', 'DEMO-E4')).toBeDefined()
    expect(find(r, 'capacidad-no-verificable')).toBeDefined()
    expect(find(r, 'plan-con-tarea-no-ejecutable', 'DEMO-003')).toBeDefined()
    expect(find(r, 'celdas-invalidas', 'TAREAS')).toBeDefined()
    expect(find(r, 'tarea-completada-sin-evidencia', 'DEMO-001')).toBeUndefined()
    const labels = governanceLabels(ds)
    expect(labels.tareas['DEMO-003']).toBe('Tarea demo bloqueada')
  })
})
