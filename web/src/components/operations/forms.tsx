'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react'

/* --------------------------------------------------------------------------------------------
 * Envío de operaciones (V1.4). La autorización real ocurre en el servidor; esto solo es la UI.
 * requestId: nuevo en cada envío, salvo reintentar el MISMO payload tras un fallo de escritura o de red
 * (idempotencia: el servidor completa la operación auditada sin duplicarla).
 * ------------------------------------------------------------------------------------------ */

interface OpSuccess {
  ok: true
  id: string
  version?: number
  repetida: boolean
  operacion: string
}
interface OpFailure {
  ok: false
  error: { codigo: string; mensaje: string; campos?: Record<string, string>; detalle?: Record<string, unknown> }
}
type OpState = { status: 'idle' } | { status: 'sending' } | { status: 'done'; result: OpSuccess } | { status: 'error'; error: OpFailure['error'] }

const RETRY_SAME_REQUEST = new Set(['escritura-fallida', 'red'])

function useOperation(endpoint: string, method: 'POST' | 'PATCH') {
  const router = useRouter()
  const [state, setState] = useState<OpState>({ status: 'idle' })
  const last = useRef<{ requestId: string; payload: string; code?: string } | null>(null)

  async function submit(payload: Record<string, unknown>): Promise<OpSuccess | null> {
    const serialized = JSON.stringify(payload)
    const reuse = last.current && last.current.payload === serialized && RETRY_SAME_REQUEST.has(last.current.code ?? '')
    const requestId = reuse ? last.current!.requestId : crypto.randomUUID()
    const attempt: { requestId: string; payload: string; code?: string } = { requestId, payload: serialized }
    last.current = attempt
    setState({ status: 'sending' })
    try {
      const response = await fetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Project-OS-CSRF': '1' },
        body: JSON.stringify({ ...payload, requestId }),
        credentials: 'same-origin',
      })
      const json = (await response.json().catch(() => null)) as OpSuccess | OpFailure | null
      if (json && json.ok) {
        last.current = null
        setState({ status: 'done', result: json })
        router.refresh()
        return json
      }
      const error = json && !json.ok ? json.error : { codigo: 'error', mensaje: 'No se pudo completar la operación.' }
      attempt.code = error.codigo
      setState({ status: 'error', error })
    } catch {
      attempt.code = 'red'
      setState({ status: 'error', error: { codigo: 'red', mensaje: 'Sin conexión con el servidor. Puedes reintentar sin duplicar.' } })
    }
    return null
  }

  return { state, submit, reset: () => setState({ status: 'idle' }) }
}

function fieldError(state: OpState, name: string): string | undefined {
  if (state.status !== 'error') return undefined
  return state.error.campos?.[name] ?? state.error.campos?.[`changes.${name}`]
}

/* ------------------------------------- Campos ------------------------------------- */

interface FieldProps {
  name: string
  label: string
  state: OpState
  hint?: string
  wide?: boolean
  children: (props: { id: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }) => ReactNode
}

function Field({ name, label, state, hint, wide, children }: FieldProps) {
  const id = `${useId()}-${name}`
  const error = fieldError(state, name)
  const describedBy = [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined
  return (
    <div className={`field${wide ? ' field-wide' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {children({ id, ...(error ? { 'aria-invalid': true } : {}), 'aria-describedby': describedBy })}
      {hint ? <span id={`${id}-hint`} className="field-hint">{hint}</span> : null}
      {error ? <span id={`${id}-error`} className="field-error">{error}</span> : null}
    </div>
  )
}

function Status({ state, children }: { state: OpState; children?: ReactNode }) {
  if (state.status === 'error') {
    const campos = state.error.campos ? Object.keys(state.error.campos).length : 0
    return (
      <div className="alert alert-danger" role="alert">
        <p><strong>No se guardó.</strong> {state.error.mensaje}</p>
        {campos ? <p className="small">Revisa {campos === 1 ? 'el campo marcado' : `los ${campos} campos marcados`}.</p> : null}
        {state.error.codigo === 'escritura-fallida' || state.error.codigo === 'red' ? (
          <p className="small">Al reintentar se reutiliza la misma solicitud: no se duplicará.</p>
        ) : null}
      </div>
    )
  }
  if (state.status === 'done') {
    return (
      <div className="alert alert-ok" role="status">
        <p>
          <strong>{state.result.repetida ? 'Ya estaba registrado.' : 'Guardado.'}</strong>{' '}
          <span className="mono">{state.result.id}</span>
          {state.result.version ? ` · versión ${state.result.version}` : ''}
        </p>
        {children}
      </div>
    )
  }
  return <div aria-live="polite" className="visually-hidden">{state.status === 'sending' ? 'Guardando…' : ''}</div>
}

function Submit({ state, label }: { state: OpState; label: string }) {
  const sending = state.status === 'sending'
  return (
    <button type="submit" className="button button-primary" disabled={sending} aria-busy={sending}>
      {sending ? 'Guardando…' : label}
    </button>
  )
}

function formValues(form: HTMLFormElement): Record<string, string> {
  const data = new FormData(form)
  const values: Record<string, string> = {}
  for (const [key, value] of data.entries()) if (typeof value === 'string') values[key] = value.trim()
  return values
}

/** Quita opcionales vacíos (alta). */
function compact(values: Record<string, string>, optional: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...values }
  for (const key of optional) if (!out[key]) delete out[key]
  return out
}

export interface Option {
  value: string
  label: string
}

const PRIORIDADES: Option[] = [
  { value: 'ALTA', label: 'Alta' },
  { value: 'MEDIA', label: 'Media' },
  { value: 'BAJA', label: 'Baja' },
]

/* ----------------------------------- Nueva tarea ----------------------------------- */

export function NewTaskForm({ projects, milestones, defaultProject, taskTypes }: {
  projects: Option[]
  milestones: Array<Option & { project: string }>
  defaultProject?: string
  taskTypes: string[]
}) {
  const op = useOperation('/api/operaciones/tareas', 'POST')
  const [project, setProject] = useState(defaultProject ?? projects[0]?.value ?? '')
  const formRef = useRef<HTMLFormElement>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = formValues(event.currentTarget)
    await op.submit(compact(values, ['hitoId', 'descripcion', 'responsable', 'fechaPlan', 'fechaLimite', 'horasEstimadas', 'bloqueo']))
  }

  const projectMilestones = milestones.filter((m) => m.project === project)
  return (
    <form ref={formRef} className="op-form" onSubmit={onSubmit} noValidate>
      <div className="form-grid">
        <Field name="proyectoId" label="Proyecto" state={op.state}>
          {(p) => (
            <select {...p} name="proyectoId" value={project} onChange={(e) => setProject(e.target.value)} required>
              {projects.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          )}
        </Field>
        <Field name="hitoId" label="Hito (opcional)" state={op.state}>
          {(p) => (
            <select {...p} name="hitoId" defaultValue="" key={project}>
              <option value="">Sin hito</option>
              {projectMilestones.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          )}
        </Field>
        <Field name="titulo" label="Título" state={op.state} wide>
          {(p) => <input {...p} name="titulo" required minLength={3} maxLength={160} autoComplete="off" />}
        </Field>
        <Field name="tipo" label="Tipo" state={op.state} hint="Código en mayúsculas">
          {(p) => (
            <>
              <input {...p} name="tipo" required list={`${p.id}-tipos`} maxLength={30} autoCapitalize="characters" />
              <datalist id={`${p.id}-tipos`}>{taskTypes.map((t) => <option key={t} value={t} />)}</datalist>
            </>
          )}
        </Field>
        <Field name="prioridad" label="Prioridad" state={op.state}>
          {(p) => (
            <select {...p} name="prioridad" defaultValue="MEDIA" required>
              {PRIORIDADES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          )}
        </Field>
        <Field name="responsable" label="Responsable (opcional)" state={op.state}>
          {(p) => <input {...p} name="responsable" maxLength={80} autoComplete="off" />}
        </Field>
        <Field name="horasEstimadas" label="Horas estimadas (opcional)" state={op.state}>
          {(p) => <input {...p} name="horasEstimadas" inputMode="decimal" maxLength={7} />}
        </Field>
        <Field name="fechaPlan" label="Fecha plan (opcional)" state={op.state}>
          {(p) => <input {...p} name="fechaPlan" type="date" />}
        </Field>
        <Field name="fechaLimite" label="Fecha límite (opcional)" state={op.state}>
          {(p) => <input {...p} name="fechaLimite" type="date" />}
        </Field>
        <Field name="criterioTerminado" label="Criterio de terminado" state={op.state} wide hint="Cómo se verificará que la tarea está terminada">
          {(p) => <textarea {...p} name="criterioTerminado" required rows={2} maxLength={1000} />}
        </Field>
        <Field name="descripcion" label="Descripción (opcional)" state={op.state} wide>
          {(p) => <textarea {...p} name="descripcion" rows={3} maxLength={2000} />}
        </Field>
      </div>
      <p className="muted small">La tarea se crea en estado <strong>Pendiente</strong>, versión 1.</p>
      <div className="form-actions">
        <Submit state={op.state} label="Crear tarea" />
        <Link href="/tareas" className="button button-ghost">Cancelar</Link>
      </div>
      <Status state={op.state}>
        {op.state.status === 'done' ? (
          <p className="small">
            <Link href={`/tareas?q=${encodeURIComponent(op.state.result.id)}`}>Ver tarea</Link>{' · '}
            <button type="button" className="link-button" onClick={() => { formRef.current?.reset(); op.reset() }}>Crear otra</button>
          </p>
        ) : null}
      </Status>
    </form>
  )
}

/* ----------------------------------- Editar tarea ----------------------------------- */

export interface EditableTask {
  id: string
  version: number
  hitoId: string
  titulo: string
  descripcion: string
  tipo: string
  estado: string
  prioridad: string
  responsable: string
  fechaPlan: string
  fechaLimite: string
  horasEstimadas: string
  criterioTerminado: string
  bloqueo: string
}

const ESTADOS: Option[] = [
  { value: 'PENDIENTE', label: 'Pendiente' },
  { value: 'EN_PROGRESO', label: 'En progreso' },
  { value: 'BLOQUEADO', label: 'Bloqueado' },
]
const OPTIONAL_EDIT = new Set(['hitoId', 'descripcion', 'responsable', 'fechaPlan', 'fechaLimite', 'horasEstimadas', 'bloqueo'])

export function EditTaskForm({ task, milestones, taskTypes }: { task: EditableTask; milestones: Option[]; taskTypes: string[] }) {
  const op = useOperation(`/api/operaciones/tareas/${encodeURIComponent(task.id)}`, 'PATCH')
  const router = useRouter()
  const estados = ESTADOS.some((e) => e.value === task.estado) ? ESTADOS : [{ value: task.estado, label: task.estado }, ...ESTADOS]

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = formValues(event.currentTarget)
    const changes: Record<string, string | null> = {}
    for (const [key, value] of Object.entries(values)) {
      const original = (task as unknown as Record<string, string | number>)[key]
      if (String(original ?? '') !== value) changes[key] = value === '' && OPTIONAL_EDIT.has(key) ? null : value
    }
    await op.submit({ expectedVersion: task.version, changes })
  }

  const conflict = op.state.status === 'error' && op.state.error.codigo.startsWith('conflicto')
  return (
    <form className="op-form" onSubmit={onSubmit} noValidate>
      <div className="form-grid">
        <Field name="estado" label="Estado" state={op.state} hint="Completar o cancelar requiere aprobación humana">
          {(p) => (
            <select {...p} name="estado" defaultValue={task.estado}>
              {estados.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          )}
        </Field>
        <Field name="prioridad" label="Prioridad" state={op.state}>
          {(p) => (
            <select {...p} name="prioridad" defaultValue={task.prioridad || 'MEDIA'}>
              {PRIORIDADES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          )}
        </Field>
        <Field name="bloqueo" label="Bloqueo" state={op.state} wide hint="Obligatorio si el estado es Bloqueado">
          {(p) => <textarea {...p} name="bloqueo" rows={2} maxLength={500} defaultValue={task.bloqueo} />}
        </Field>
        <Field name="titulo" label="Título" state={op.state} wide>
          {(p) => <input {...p} name="titulo" required maxLength={160} defaultValue={task.titulo} />}
        </Field>
        <Field name="tipo" label="Tipo" state={op.state}>
          {(p) => (
            <>
              <input {...p} name="tipo" required list={`${p.id}-tipos`} maxLength={30} defaultValue={task.tipo} />
              <datalist id={`${p.id}-tipos`}>{taskTypes.map((t) => <option key={t} value={t} />)}</datalist>
            </>
          )}
        </Field>
        <Field name="hitoId" label="Hito" state={op.state}>
          {(p) => (
            <select {...p} name="hitoId" defaultValue={task.hitoId}>
              <option value="">Sin hito</option>
              {milestones.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          )}
        </Field>
        <Field name="responsable" label="Responsable" state={op.state}>
          {(p) => <input {...p} name="responsable" maxLength={80} defaultValue={task.responsable} />}
        </Field>
        <Field name="horasEstimadas" label="Horas estimadas" state={op.state}>
          {(p) => <input {...p} name="horasEstimadas" inputMode="decimal" maxLength={7} defaultValue={task.horasEstimadas} />}
        </Field>
        <Field name="fechaPlan" label="Fecha plan" state={op.state}>
          {(p) => <input {...p} name="fechaPlan" type="date" defaultValue={task.fechaPlan} />}
        </Field>
        <Field name="fechaLimite" label="Fecha límite" state={op.state}>
          {(p) => <input {...p} name="fechaLimite" type="date" defaultValue={task.fechaLimite} />}
        </Field>
        <Field name="criterioTerminado" label="Criterio de terminado" state={op.state} wide>
          {(p) => <textarea {...p} name="criterioTerminado" required rows={2} maxLength={1000} defaultValue={task.criterioTerminado} />}
        </Field>
        <Field name="descripcion" label="Descripción" state={op.state} wide>
          {(p) => <textarea {...p} name="descripcion" rows={3} maxLength={2000} defaultValue={task.descripcion} />}
        </Field>
      </div>
      <p className="muted small">Editando la versión <strong>{task.version}</strong>. Si alguien la cambia antes de guardar, se te pedirá recargar.</p>
      <div className="form-actions">
        <Submit state={op.state} label="Guardar cambios" />
        <Link href={`/tareas?q=${encodeURIComponent(task.id)}`} className="button button-ghost">Volver</Link>
      </div>
      <Status state={op.state}>
        <p className="small"><Link href={`/tareas?q=${encodeURIComponent(task.id)}`}>Ver tarea</Link></p>
      </Status>
      {conflict ? (
        <button type="button" className="button" onClick={() => { op.reset(); router.refresh() }}>Recargar la versión actual</button>
      ) : null}
    </form>
  )
}

/* --------------------------------- Registrar tiempo --------------------------------- */

export function TimeForm({ tasks, defaultTask, today, workTypes }: { tasks: Option[]; defaultTask?: string; today: string; workTypes: string[] }) {
  const op = useOperation('/api/operaciones/tiempos', 'POST')
  const formRef = useRef<HTMLFormElement>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = formValues(event.currentTarget)
    await op.submit(compact({ ...values }, ['notas']))
  }

  return (
    <form ref={formRef} className="op-form" onSubmit={onSubmit} noValidate>
      <div className="form-grid">
        <Field name="tareaId" label="Tarea" state={op.state} wide>
          {(p) => (
            <select {...p} name="tareaId" defaultValue={defaultTask ?? tasks[0]?.value} required>
              {tasks.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          )}
        </Field>
        <Field name="fecha" label="Fecha" state={op.state}>
          {(p) => <input {...p} name="fecha" type="date" defaultValue={today} max={today} required />}
        </Field>
        <Field name="minutos" label="Minutos" state={op.state} hint="Entre 1 y 960">
          {(p) => <input {...p} name="minutos" type="number" min={1} max={960} step={1} inputMode="numeric" required />}
        </Field>
        <Field name="responsable" label="Responsable" state={op.state}>
          {(p) => <input {...p} name="responsable" maxLength={80} defaultValue="Usuario" required />}
        </Field>
        <Field name="tipoTrabajo" label="Tipo de trabajo" state={op.state}>
          {(p) => (
            <>
              <input {...p} name="tipoTrabajo" list={`${p.id}-tipos`} maxLength={30} defaultValue="DESARROLLO" required />
              <datalist id={`${p.id}-tipos`}>{workTypes.map((t) => <option key={t} value={t} />)}</datalist>
            </>
          )}
        </Field>
        <Field name="notas" label="Notas (opcional)" state={op.state} wide>
          {(p) => <textarea {...p} name="notas" rows={2} maxLength={1000} />}
        </Field>
      </div>
      <div className="form-actions">
        <Submit state={op.state} label="Registrar tiempo" />
        <Link href="/capacidad" className="button button-ghost">Cancelar</Link>
      </div>
      <Status state={op.state}>
        {op.state.status === 'done' ? (
          <p className="small">
            <Link href="/capacidad">Ver capacidad y tiempos</Link>{' · '}
            <button type="button" className="link-button" onClick={() => { formRef.current?.reset(); op.reset() }}>Registrar otra sesión</button>
          </p>
        ) : null}
      </Status>
    </form>
  )
}

/* -------------------------------- Registrar decisión -------------------------------- */

export function DecisionForm({ projects, defaultProject, today }: { projects: Option[]; defaultProject?: string; today: string }) {
  const op = useOperation('/api/operaciones/decisiones', 'POST')

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await op.submit(compact(formValues(event.currentTarget), ['evidenciaUrl']))
  }

  return (
    <form className="op-form" onSubmit={onSubmit} noValidate>
      <div className="form-grid">
        <Field name="proyectoId" label="Proyecto" state={op.state}>
          {(p) => (
            <select {...p} name="proyectoId" defaultValue={defaultProject ?? projects[0]?.value} required>
              {projects.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          )}
        </Field>
        <Field name="fecha" label="Fecha" state={op.state}>
          {(p) => <input {...p} name="fecha" type="date" defaultValue={today} max={today} required />}
        </Field>
        <Field name="asunto" label="Asunto" state={op.state} wide>
          {(p) => <input {...p} name="asunto" required maxLength={200} />}
        </Field>
        <Field name="decision" label="Decisión" state={op.state} wide>
          {(p) => <textarea {...p} name="decision" required rows={3} maxLength={2000} />}
        </Field>
        <Field name="justificacion" label="Justificación" state={op.state} wide>
          {(p) => <textarea {...p} name="justificacion" required rows={3} maxLength={2000} />}
        </Field>
        <Field name="responsable" label="Responsable" state={op.state}>
          {(p) => <input {...p} name="responsable" maxLength={80} defaultValue="Usuario" required />}
        </Field>
        <Field name="evidenciaUrl" label="URL de evidencia (opcional)" state={op.state} hint="Solo https://">
          {(p) => <input {...p} name="evidenciaUrl" type="url" inputMode="url" maxLength={500} placeholder="https://" />}
        </Field>
      </div>
      <p className="muted small">La decisión se registra en estado <strong>Pendiente</strong>; aprobarla queda fuera de esta versión.</p>
      <div className="form-actions">
        <Submit state={op.state} label="Registrar decisión" />
        <Link href="/proyectos" className="button button-ghost">Cancelar</Link>
      </div>
      <Status state={op.state}>
        {op.state.status === 'done' ? (
          <p className="small"><Link href="/proyectos">Ver proyectos</Link></p>
        ) : null}
      </Status>
    </form>
  )
}
