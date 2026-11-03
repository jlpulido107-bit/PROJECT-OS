'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { Badge, Empty, humanize, Section, StateBadge } from '@/components/ui'
import { planWeek, SUPUESTO_RESERVA_VACIA } from '@/lib/planning/engine'
import { buildExport, reviewKey, type ReviewDecision, type ReviewState } from '@/lib/planning/export'
import { DEFAULT_SCENARIO, isDefaultScenario, movimientos, normalizeScenario, ScenarioError, SCENARIO_LIMITS } from '@/lib/planning/scenario'
import type { PlanningInput, PlanResult, ProjectPriority, Scenario, TaskCategory, TaskPlan } from '@/lib/planning/types'
import { diasSemana, type Bloque } from '@/lib/planificacion-semana'
import type { HitoSemana } from '@/lib/planificacion-semana-hitos'
import { tarjetasSemana, type EdicionSemana } from '@/lib/planificacion-edicion'
import { capacidadSemana } from '@/lib/planificacion-capacidad'
import { formularioDeEscenario, huellaDatos, type EscenarioCargable } from '@/lib/planificacion-escenarios'
import { fijadasRestantes } from '@/lib/planificacion-plan-dia'
import { AplicarPlan } from './aplicar-plan'
import { CapaSemana } from './capa-semana'
import { EscenariosGuardados } from './escenarios-guardados'
import styles from './planning.module.css'

/* ---------------------------------------------------------------------------------------------
 * Vista de planificación V1.5. Todo ocurre en memoria del navegador:
 * - el escenario y la revisión (aceptar / rechazar / ajustar) NO se guardan solos; el propietario puede guardar el
 *   escenario con nombre en ESCENARIOS (ORD-POS-141) y cargarlo después, lo que solo re-simula aquí;
 * - recargar la página o "Restablecer escenario" vuelve a los datos registrados;
 * - la exportación descarga un JSON local; nada se aplica a Google Sheets.
 * ------------------------------------------------------------------------------------------- */

type FormState = Record<'semana' | 'ajusteHoras' | 'reservaPct' | 'horasSiFaltan' | 'horasSiSinEstimacion' | 'sobrecargaPct', string> & {
  descontarRegistrado: boolean
  diasLaborables: number[]
  prioridadProyecto: Record<string, ProjectPriority | ''>
}

const EMPTY_FORM: FormState = {
  semana: 'actual', ajusteHoras: '0', reservaPct: '', horasSiFaltan: '', horasSiSinEstimacion: '', sobrecargaPct: '0',
  descontarRegistrado: false, diasLaborables: [...DEFAULT_SCENARIO.diasLaborables], prioridadProyecto: {},
}

const DAY_NAMES = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo']
const DAY_FORMAT = new Intl.DateTimeFormat('es-MX', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' })

function dayLabel(civil: string): string {
  const [y, m, d] = civil.split('-').map(Number) as [number, number, number]
  const text = DAY_FORMAT.format(new Date(Date.UTC(y, m - 1, d)))
  return text.charAt(0).toLocaleUpperCase('es') + text.slice(1)
}

function fmtMin(min: number | null): string {
  if (min === null) return '—'
  const h = Math.floor(min / 60)
  const m = min % 60
  if (h === 0) return `${m} min`
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

function toScenario(form: FormState, fijadas: Record<string, string>): Scenario {
  const priorities = Object.fromEntries(Object.entries(form.prioridadProyecto).filter(([, v]) => v !== '')) as Record<string, ProjectPriority>
  return normalizeScenario({
    semana: form.semana,
    ajusteHoras: form.ajusteHoras.trim() === '' ? 0 : form.ajusteHoras,
    reservaPct: form.reservaPct,
    horasSiFaltan: form.horasSiFaltan,
    horasSiSinEstimacion: form.horasSiSinEstimacion,
    sobrecargaPct: form.sobrecargaPct.trim() === '' ? 0 : form.sobrecargaPct,
    descontarRegistrado: form.descontarRegistrado,
    diasLaborables: form.diasLaborables,
    prioridadProyecto: priorities,
    fijadas,
  })
}

const CATEGORY_LABEL: Record<TaskCategory, string> = {
  propuesta: 'Propuesta completa',
  parcial: 'Propuesta parcial',
  'sin-capacidad': 'Sin capacidad',
  excluida: 'No ejecutable',
}
const CATEGORY_TONE: Record<TaskCategory, 'ok' | 'info' | 'warn' | 'muted'> = {
  propuesta: 'ok', parcial: 'info', 'sin-capacidad': 'warn', excluida: 'muted',
}
const DECISION_LABEL: Record<ReviewDecision, string> = { pendiente: 'Pendiente', aceptado: 'Aceptado', rechazado: 'Rechazado', ajustado: 'Ajustado' }

export function PlanningView({ input, referenceDate, timeZone, hitosSemana, edicion = { encendida: false }, guardados = [] }: {
  input: PlanningInput
  referenceDate: string
  timeZone: string
  hitosSemana: Bloque<HitoSemana[]>
  /** ORD-POS-136: edición en línea de la capa Semana; apagada si no se pasa. */
  edicion?: EdicionSemana
  /** ORD-POS-141: escenarios ACTIVO de ESCENARIOS, ya validados; vacío si no hay o falta la pestaña. */
  guardados?: EscenarioCargable[]
}) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [scenario, setScenario] = useState<Scenario>(() => normalizeScenario({}))
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null)
  const [review, setReview] = useState<ReviewState>({})
  const [filter, setFilter] = useState<TaskCategory | 'todas'>('todas')
  /** Movimientos simulados (ORD-POS-137): tarea → día. Solo viven en esta pestaña; nunca se guardan. */
  const [fijadas, setFijadas] = useState<Record<string, string>>({})

  const plan = useMemo(() => planWeek(input, scenario, { referenceDate, timeZone }), [input, scenario, referenceDate, timeZone])
  const simulated = !isDefaultScenario(scenario)
  const reviewed = Object.values(review).filter((r) => r.decision !== 'pendiente').length
  const moved = movimientos(scenario)
  const huellaActual = useMemo(() => huellaDatos(input), [input])

  function update(next: FormState) {
    setForm(next)
    try {
      setScenario(toScenario(next, fijadas))
      setFieldError(null)
      setReview({}) // La revisión se refiere a una propuesta concreta: cambiar el escenario la invalida.
    } catch (error) {
      if (error instanceof ScenarioError) setFieldError({ field: error.field, message: error.message })
      else throw error
    }
  }

  /** Fija los movimientos sobre el último escenario válido y recalcula al instante. */
  function applyMoves(next: Record<string, string>) {
    setFijadas(next)
    setScenario(normalizeScenario({ ...scenario, fijadas: next }))
    setReview({}) // La revisión se refiere a una propuesta concreta: mover tareas la invalida.
  }

  function move(tareaId: string, fecha: string) {
    if (fijadas[tareaId] === fecha) return
    const dias = plan.dias.filter((d) => d.items.some((i) => i.tareaId === tareaId)).map((d) => d.fecha)
    if (fijadas[tareaId] === undefined && dias.length === 1 && dias[0] === fecha) return // ya está solo en ese día
    applyMoves({ ...fijadas, [tareaId]: fecha })
  }

  /** Carga un escenario guardado (ORD-POS-141): formulario, movimientos y propuesta se re-simulan aquí; nada se escribe. */
  function cargar(s: Scenario) {
    setForm(formularioDeEscenario(s))
    setFijadas(s.fijadas ? { ...s.fijadas } : {})
    setScenario(s)
    setFieldError(null)
    setReview({}) // La revisión se refiere a una propuesta concreta: cargar otro escenario la invalida.
  }

  function reset() {
    setForm(EMPTY_FORM)
    setFijadas({})
    setScenario(normalizeScenario({}))
    setFieldError(null)
    setReview({})
    setFilter('todas')
  }

  function download() {
    const data = buildExport(plan, scenario, review)
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `propuesta-${plan.referencia.semanaIso}-${plan.huella.slice(0, 8)}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  const err = (field: string) => (fieldError?.field === field ? fieldError.message : undefined)
  const projectIds = input.proyectos.map((p) => p.id).sort()

  return (
    <div className={styles.root}>
      <div className={styles.simBanner} role="status" aria-live="polite">
        <p>
          <strong>Simulación — sin cambios guardados.</strong>{' '}
          {simulated ? 'Hay un escenario activo: los resultados no son datos registrados.' : 'Propuesta calculada con los datos registrados, sin supuestos de escenario.'}
          {moved > 0 ? <> <strong>{moved === 1 ? '1 movimiento sin guardar.' : `${moved} movimientos sin guardar.`}</strong></> : null}
          {' '}Nada se escribe en Google Sheets ni se aplica automáticamente.
        </p>
        <button type="button" className="button" onClick={reset} disabled={!simulated && reviewed === 0 && filter === 'todas'}>
          Restablecer escenario
        </button>
      </div>

      <p className="muted small">
        Semana <span className="mono">{plan.referencia.semanaIso}</span> ({plan.referencia.lunes} a {plan.referencia.domingo}) · referencia {plan.referencia.fecha} ({plan.referencia.zona})
        {plan.referencia.desde !== plan.referencia.fecha ? ` · se planifica desde ${plan.referencia.desde}` : ''}
      </p>

      <CapaSemana
        dias={diasSemana(plan, input.pestanasNoDisponibles)} hitos={hitosSemana} tarjetas={tarjetasSemana(plan, input)} edicion={edicion}
        capacidad={capacidadSemana(input, plan.referencia.lunes, plan.referencia.domingo)}
      />

      <details className="diagnostics">
        <summary>Detalle del plan</summary>

      {plan.estado === 'datos-insuficientes' ? (
        <section className="alert alert-warn" aria-labelledby="diag-titulo">
          <h2 id="diag-titulo">Faltan datos para proponer un plan</h2>
          <p>No se genera un plan ficticio. Responde estas preguntas en Google Sheets o prueba un escenario explícito:</p>
          <ul>{plan.preguntas.filter((q) => ['capacidad-faltante', 'capacidad-ambigua', 'pestana-no-disponible'].includes(q.codigo)).map((q, i) => <li key={i}>{q.mensaje}</li>)}</ul>
          {plan.capacidad.origen === 'faltante' ? (
            <p className={styles.quick}>
              <button type="button" className="button" onClick={() => update({ ...form, horasSiFaltan: '20' })}>Simular con 20 h disponibles</button>
              <span className="small">Queda marcado como supuesto de escenario, no como dato.</span>
            </p>
          ) : null}
        </section>
      ) : null}

      <CapacityStats plan={plan} />

      <details className={styles.scenario} open={simulated}>
        <summary>Escenario de simulación {simulated ? <Badge tone="warn">Activo</Badge> : <Badge tone="muted">Datos registrados</Badge>}</summary>
        <form className={styles.form} onSubmit={(e) => e.preventDefault()} noValidate aria-describedby="escenario-ayuda">
          <p id="escenario-ayuda" className="muted small">Los cambios recalculan la propuesta al instante y no modifican los datos base.</p>
          <Field label="Semana" error={err('semana')}>
            {(p) => (
              <select {...p} value={form.semana} onChange={(e) => update({ ...form, semana: e.target.value })}>
                <option value="actual">Semana actual (desde hoy)</option>
                <option value="siguiente">Semana siguiente</option>
              </select>
            )}
          </Field>
          <Field label="Ajuste de horas disponibles (±)" hint={`Entre ${SCENARIO_LIMITS.ajusteHoras.min} y ${SCENARIO_LIMITS.ajusteHoras.max} h`} error={err('ajusteHoras')}>
            {(p) => <input {...p} inputMode="decimal" value={form.ajusteHoras} onChange={(e) => update({ ...form, ajusteHoras: e.target.value })} />}
          </Field>
          <Field label="Reserva (%)" hint="Vacío = RESERVA_PCT registrada" error={err('reservaPct')}>
            {(p) => <input {...p} inputMode="numeric" value={form.reservaPct} placeholder="dato" onChange={(e) => update({ ...form, reservaPct: e.target.value })} />}
          </Field>
          <Field label="Horas si falta la capacidad" hint="Supuesto; vacío = no suponer" error={err('horasSiFaltan')}>
            {(p) => <input {...p} inputMode="decimal" value={form.horasSiFaltan} placeholder="no suponer" onChange={(e) => update({ ...form, horasSiFaltan: e.target.value })} />}
          </Field>
          <Field label="Horas para tareas sin estimación" hint="Supuesto; vacío = requieren estimación" error={err('horasSiSinEstimacion')}>
            {(p) => <input {...p} inputMode="decimal" value={form.horasSiSinEstimacion} placeholder="no suponer" onChange={(e) => update({ ...form, horasSiSinEstimacion: e.target.value })} />}
          </Field>
          <Field label="Sobrecarga: estimaciones + %" hint="0 a 300" error={err('sobrecargaPct')}>
            {(p) => <input {...p} inputMode="numeric" value={form.sobrecargaPct} onChange={(e) => update({ ...form, sobrecargaPct: e.target.value })} />}
          </Field>
          <fieldset className={styles.fieldset}>
            <legend>Días laborables</legend>
            <div className={styles.days}>
              {DAY_NAMES.map((name, i) => (
                <label key={name} className={styles.check}>
                  <input
                    type="checkbox"
                    checked={form.diasLaborables.includes(i + 1)}
                    onChange={(e) => update({ ...form, diasLaborables: e.target.checked ? [...form.diasLaborables, i + 1] : form.diasLaborables.filter((d) => d !== i + 1) })}
                  />
                  {name}
                </label>
              ))}
            </div>
          </fieldset>
          <label className={styles.check}>
            <input type="checkbox" checked={form.descontarRegistrado} onChange={(e) => update({ ...form, descontarRegistrado: e.target.checked })} />
            Descontar el tiempo registrado de la estimación (supuesto: no implica avance)
          </label>
          {projectIds.length ? (
            <fieldset className={styles.fieldset}>
              <legend>Prioridad simulada por proyecto</legend>
              <div className={styles.projects}>
                {projectIds.map((id) => (
                  <Field key={id} label={id} error={undefined}>
                    {(p) => (
                      <select {...p} value={form.prioridadProyecto[id] ?? ''} onChange={(e) => update({ ...form, prioridadProyecto: { ...form.prioridadProyecto, [id]: e.target.value as ProjectPriority | '' } })}>
                        <option value="">Dato registrado</option>
                        <option value="ALTA">Alta</option>
                        <option value="MEDIA">Media</option>
                        <option value="BAJA">Baja</option>
                      </select>
                    )}
                  </Field>
                ))}
              </div>
            </fieldset>
          ) : null}
          {fieldError ? <p className={styles.error} role="alert">Escenario no aplicado: {fieldError.message}. Se mantiene el último escenario válido.</p> : null}
        </form>
      </details>

      <EscenariosGuardados
        guardados={guardados} edicion={edicion} escenario={scenario} semanaId={plan.referencia.semanaIso} huellaActual={huellaActual} onCargar={cargar}
      />

      {plan.supuestos.length ? (
        <div className="alert alert-info" role="note">
          <strong>Supuestos de esta propuesta</strong>
          <ul>{plan.supuestos.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </div>
      ) : null}

      <Section
        title="Propuesta por día"
        id="propuesta"
        actions={
          <button type="button" className="button" onClick={download} disabled={plan.capacidad.propuestoMin === 0}>
            Exportar propuesta (JSON)
          </button>
        }
      >
        <p className="muted small">
          Recomendación, no compromiso. Acepta, rechaza o ajusta cada bloque: la revisión solo vive en esta pestaña
          {reviewed ? ` (${reviewed} revisado${reviewed === 1 ? '' : 's'})` : ''} y se incluye en la exportación.
        </p>
        <p className="muted small">
          Arrastra un bloque a otro día o usa «Mover a…» (teclado y celular): la capacidad de cada día se recalcula al instante.
        </p>
        <DayList plan={plan} input={input} review={review} setReview={setReview} fijadas={fijadas} onMove={move} />
        <p className={styles.quick}>
          <button type="button" className="button" onClick={() => applyMoves({})} disabled={moved === 0}>Descartar movimientos</button>
        </p>
        {/* ORD-POS-140: guardar los movimientos en el plan registrado, solo para el propietario con la edición encendida. */}
        {edicion.encendida && edicion.planDia && moved > 0
          ? <AplicarPlan plan={plan} input={input} edicion={edicion.planDia} onGuardados={(r) => applyMoves(fijadasRestantes(fijadas, r))} />
          : null}
      </Section>

      <Section title="Reparto por proyecto" id="proyectos">
        <ProjectTable plan={plan} />
      </Section>

      <Section title="Tareas candidatas y excluidas" id="tareas">
        <div className={styles.filterRow} role="group" aria-label="Filtrar tareas por categoría">
          {(['todas', 'propuesta', 'parcial', 'sin-capacidad', 'excluida'] as const).map((c) => {
            const count = c === 'todas' ? plan.tareas.length : plan.tareas.filter((t) => t.categoria === c).length
            return (
              <button key={c} type="button" className={`button${filter === c ? ' button-primary' : ''}`} aria-pressed={filter === c} onClick={() => setFilter(c)}>
                {c === 'todas' ? 'Todas' : CATEGORY_LABEL[c]} ({count})
              </button>
            )
          })}
        </div>
        <TaskList tasks={plan.tareas.filter((t) => filter === 'todas' || t.categoria === filter)} />
        {plan.resumen.cerradasOmitidas ? <p className="muted small">{plan.resumen.cerradasOmitidas === 1 ? '1 tarea cerrada (COMPLETADO o CANCELADO) no se lista.' : `${plan.resumen.cerradasOmitidas} tareas cerradas (COMPLETADO o CANCELADO) no se listan.`}</p> : null}
      </Section>

      <Section title="Preguntas y conflictos" id="conflictos">
        <IssueList title="Preguntas (necesitan una decisión humana)" items={plan.preguntas} empty="Sin preguntas pendientes." />
        <IssueList title="Conflictos y avisos" items={plan.conflictos} empty="Sin conflictos." />
      </Section>

      <p className="muted small">
        Motor determinista {plan.version} · huella de entrada <span className="mono">{plan.huella}</span>. La misma huella con el mismo escenario produce siempre la misma propuesta.
      </p>
      </details>
    </div>
  )
}

function Field({ label, hint, error, children }: {
  label: string
  hint?: string
  error: string | undefined
  children: (props: { id: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }) => ReactNode
}) {
  const id = `esc-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  const describedBy = [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children({ id, ...(error ? { 'aria-invalid': true } : {}), 'aria-describedby': describedBy })}
      {hint ? <span id={`${id}-hint`} className="small">{hint}</span> : null}
      {error ? <span id={`${id}-error`} className={styles.error}>{error}</span> : null}
    </div>
  )
}

function CapacityStats({ plan }: { plan: PlanResult }) {
  const c = plan.capacidad
  const origin = { dato: 'Dato registrado', supuesto: 'Supuesto de escenario', faltante: 'No registrada', ambigua: 'Ambigua' }[c.origen]
  return (
    <div className="stats" aria-label="Capacidad de la semana">
      <div className="stat"><span className="stat-label">Horas disponibles</span><span className="stat-value">{c.horasDisponibles === null ? 'Sin capacidad registrada' : `${c.horasDisponibles} h`}</span><span className="stat-hint">{origin}{c.semanaId ? ` · ${c.semanaId}` : ''}{c.estadoSemana ? ` · ${humanize(c.estadoSemana)}` : ''}</span></div>
      <div className="stat"><span className="stat-label">Reserva</span><span className="stat-value">{c.reservaPct === null ? 'Sin datos' : plan.supuestos.includes(SUPUESTO_RESERVA_VACIA) ? 'Sin reserva registrada' : `${c.reservaPct} %`}</span></div>
      <div className="stat"><span className="stat-label">Capacidad neta</span><span className="stat-value">{c.netaMin === null ? 'No calculable' : fmtMin(c.netaMin)}</span><span className="stat-hint">horas × (1 − reserva)</span></div>
      <div className="stat"><span className="stat-label">Ya usado o planificado</span><span className="stat-value">{fmtMin(c.usadoMin)}</span><span className="stat-hint">tiempo real y planes registrados</span></div>
      <div className="stat"><span className="stat-label">Saldo semanal</span><span className="stat-value">{fmtMin(c.libreMin)}</span><span className="stat-hint">teórico: incluye cuotas de días pasados</span></div>
      <div className="stat"><span className="stat-label">Colocable</span><span className="stat-value">{fmtMin(c.colocableMin)}</span><span className="stat-hint">hueco real en los días restantes</span></div>
      <div className="stat"><span className="stat-label">Propuesto</span><span className={`stat-value${c.propuestoMin > 0 ? ' stat-ok' : ''}`}>{fmtMin(c.propuestoMin)}</span><span className="stat-hint">{plan.resumen.propuestas + plan.resumen.parciales === 1 ? '1 tarea' : `${plan.resumen.propuestas + plan.resumen.parciales} tareas`}</span></div>
    </div>
  )
}

export function DayList({ plan, input, review, setReview, fijadas, onMove }: {
  plan: PlanResult
  input: PlanningInput
  review: ReviewState
  setReview: (r: ReviewState) => void
  fijadas: Record<string, string>
  onMove: (tareaId: string, fecha: string) => void
}) {
  const [over, setOver] = useState<string | null>(null)
  const titles = new Map(input.tareas.map((t) => [t.id, t.titulo]))
  const fechaPlan = new Map(input.tareas.map((t) => [t.id, t.fechaPlan]))
  const days = plan.dias.filter((d) => !d.esPasado)
  const targets = days.filter((d) => d.laborable || d.capacidadMin !== null)
  const beforePlan = (tareaId: string, fecha: string) => {
    const fp = fechaPlan.get(tareaId)
    return fp ? fecha < fp : false
  }
  if (plan.estado === 'datos-insuficientes') return <Empty>Sin propuesta hasta resolver los datos faltantes.</Empty>
  if (days.every((d) => d.items.length === 0)) {
    return <Empty>No hay nada que proponer: {plan.capacidad.libreMin === 0 ? 'no queda capacidad libre esta semana.' : 'no hay tareas elegibles con estimación.'}</Empty>
  }
  return (
    <ol className={styles.dayList}>
      {days.map((d) => (
        <li
          key={d.fecha}
          className={`card${d.fecha === plan.referencia.fecha ? ' card-today' : ''}`}
          aria-labelledby={`dia-${d.fecha}`}
          data-sobre={over === d.fecha || undefined}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes('text/plain')) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            if (over !== d.fecha) setOver(d.fecha)
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null)
          }}
          onDrop={(e) => {
            e.preventDefault()
            setOver(null)
            const tareaId = e.dataTransfer.getData('text/plain')
            if (tareaId) onMove(tareaId, d.fecha)
          }}
        >
          <header className="card-head">
            <h3 id={`dia-${d.fecha}`} className={styles.dayTitle}>{dayLabel(d.fecha)}</h3>
            <div className="badges">
              {d.fecha === plan.referencia.fecha ? <Badge tone="info">Hoy</Badge> : null}
              {!d.laborable ? <Badge tone="muted">No laborable</Badge> : null}
              {d.planRegistrado ? <Badge tone="neutral" title="PLAN_DIARIO registrado: se respeta">Plan {d.planRegistrado}</Badge> : null}
            </div>
          </header>
          <p className="small muted">
            Capacidad {fmtMin(d.capacidadMin)} · usado {fmtMin(d.usadoMin)} · libre {fmtMin(d.libreMin)} · propuesto <strong>{fmtMin(d.propuestoMin)}</strong>
          </p>
          {d.items.length === 0 ? (
            <p className="small muted">Sin bloques propuestos.</p>
          ) : (
            <ol className={styles.items}>
              {d.items.map((item) => {
                const key = reviewKey(d.fecha, item.tareaId)
                const r = review[key] ?? { decision: 'pendiente' as ReviewDecision }
                const set = (decision: ReviewDecision, minutos?: number) => setReview({ ...review, [key]: { decision, ...(minutos !== undefined ? { minutos } : {}) } })
                const pinned = item.fijada === true
                const current = fijadas[item.tareaId] ?? d.fecha
                return (
                  <li
                    key={key}
                    className={styles.item}
                    data-decision={r.decision}
                    data-simulada={pinned || undefined}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', item.tareaId)
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                  >
                    <div className={styles.itemHead}>
                      <span><span className="mono">{item.tareaId}</span> · {titles.get(item.tareaId) ?? 'Sin título'}</span>
                      <strong>{fmtMin(r.decision === 'ajustado' && r.minutos !== undefined ? r.minutos : item.minutos)}</strong>
                    </div>
                    {pinned ? (
                      <p className="badges">
                        <Badge tone="info">Simulado</Badge>
                        {beforePlan(item.tareaId, d.fecha) ? <Badge tone="warn">antes de su FECHA_PLAN</Badge> : null}
                      </p>
                    ) : null}
                    <p className="small muted">{item.proyectoId} · {item.motivo} · revisión: {DECISION_LABEL[r.decision]}</p>
                    <label className={styles.adjust}>
                      Mover a…
                      <select
                        value={current}
                        aria-label={`Mover ${item.tareaId} a otro día`}
                        onChange={(e) => onMove(item.tareaId, e.target.value)}
                      >
                        {targets.map((t) => (
                          <option key={t.fecha} value={t.fecha}>
                            {dayLabel(t.fecha)}{beforePlan(item.tareaId, t.fecha) ? ' (antes de su FECHA_PLAN)' : ''}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className={styles.review} role="group" aria-label={`Revisar ${item.tareaId} el ${d.fecha}`}>
                      <button type="button" className="button" aria-pressed={r.decision === 'aceptado'} onClick={() => set('aceptado')}>Aceptar</button>
                      <button type="button" className="button" aria-pressed={r.decision === 'rechazado'} onClick={() => set('rechazado')}>Rechazar</button>
                      <label className={styles.adjust}>
                        Ajustar (min)
                        <input
                          type="number"
                          min={0}
                          max={item.minutos}
                          step={5}
                          value={r.decision === 'ajustado' && r.minutos !== undefined ? r.minutos : ''}
                          placeholder={String(item.minutos)}
                          onChange={(e) => {
                            const v = Number(e.target.value)
                            if (e.target.value === '') set('pendiente')
                            else if (Number.isInteger(v) && v >= 0 && v <= item.minutos) set('ajustado', v)
                          }}
                        />
                      </label>
                    </div>
                  </li>
                )
              })}
            </ol>
          )}
        </li>
      ))}
    </ol>
  )
}

function ProjectTable({ plan }: { plan: PlanResult }) {
  if (plan.proyectos.length === 0) return <Empty>No hay proyectos registrados.</Empty>
  return (
    <div className="table-wrap" role="region" aria-label="Reparto por proyecto" tabIndex={0}>
      <table>
        <thead>
          <tr>
            <th scope="col">Proyecto</th>
            <th scope="col">Prioridad (peso)</th>
            <th scope="col">Asignación</th>
            <th scope="col">Ya usado</th>
            <th scope="col">Demanda</th>
            <th scope="col">Propuesto</th>
          </tr>
        </thead>
        <tbody>
          {plan.proyectos.map((p) => (
            <tr key={p.id}>
              <th scope="row"><span className="mono">{p.id}</span>{p.nombre ? <><br /><span className="small">{p.nombre}</span></> : null}</th>
              <td>{humanize(p.prioridad)} ({p.peso}){p.prioridadSimulada ? <> <Badge tone="warn">Simulada</Badge></> : null}</td>
              <td>{p.asignadoMin === null ? <span className="muted">Sin asignación</span> : fmtMin(p.asignadoMin)}</td>
              <td>{fmtMin(p.usadoMin)}</td>
              <td>{fmtMin(p.demandaMin)}</td>
              <td><strong>{fmtMin(p.propuestoMin)}</strong></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function TaskList({ tasks }: { tasks: TaskPlan[] }) {
  if (tasks.length === 0) return <Empty>No hay tareas en esta categoría.</Empty>
  return (
    <ul className={styles.taskList}>
      {tasks.map((t) => (
        <li key={t.id} className="card">
          <details>
            <summary className={styles.taskSummary}>
              <span>
                {t.rango !== null ? <span className={styles.rank} aria-label={`Posición ${t.rango}`}>#{t.rango}</span> : null}
                <span className="mono">{t.id}</span> · {t.titulo ?? 'Sin título'}
              </span>
              <span className="badges">
                <Badge tone={CATEGORY_TONE[t.categoria]}>{CATEGORY_LABEL[t.categoria]}</Badge>
                {t.propuestoMin > 0 ? <Badge tone="ok">{fmtMin(t.propuestoMin)}</Badge> : null}
                {t.vencida ? <Badge tone="danger">Vencida</Badge> : t.venceEnSemana ? <Badge tone="warn">Vence esta semana</Badge> : null}
                {t.estimacionSupuesta ? <Badge tone="warn">Estimación supuesta</Badge> : null}
                <StateBadge code={t.estado} />
              </span>
            </summary>
            <ul className="list">{t.explicacion.map((line, i) => <li key={i}>{line}</li>)}</ul>
            <p className="small muted">
              Proyecto {t.proyectoId ?? '—'} · prioridad {t.prioridad} · estimación {t.estimacionMin === null ? 'sin dato' : fmtMin(t.estimacionMin)} · registrado {fmtMin(t.registradoMin)} · necesidad {fmtMin(t.necesidadMin)}
            </p>
          </details>
        </li>
      ))}
    </ul>
  )
}

function IssueList({ title, items, empty }: { title: string; items: PlanResult['conflictos']; empty: string }) {
  return (
    <>
      <h3>{title}</h3>
      {items.length === 0 ? <p className="muted small">{empty}</p> : (
        <ul className="list">
          {items.map((c, i) => (
            <li key={`${c.codigo}-${i}`}>
              {c.mensaje}
              {c.refs.length ? <span className="small muted"> ({c.refs.slice(0, 12).join(', ')}{c.refs.length > 12 ? `, +${c.refs.length - 12}` : ''})</span> : null}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
