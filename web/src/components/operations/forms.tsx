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

/* ------------------------------ Órdenes (V1.8 F3; las ejecuta Claude desde 2026-10-14) ------------------------------ */

export function OrderForm({ projects, tasks, defaultProject }: {
  projects: Option[]
  /** Tareas abiertas con su proyecto (value = TAREA_ID). */
  tasks: Array<Option & { proyectoId: string }>
  defaultProject?: string
}) {
  const op = useOperation('/api/operaciones/ordenes', 'POST')
  const [project, setProject] = useState(defaultProject ?? projects[0]?.value ?? '')
  const projectTasks = tasks.filter((t) => t.proyectoId === project)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await op.submit(compact(formValues(event.currentTarget), ['contexto']))
  }

  return (
    <form className="op-form" onSubmit={onSubmit} noValidate>
      <div className="form-grid">
        <Field name="proyectoId" label="Proyecto" state={op.state}>
          {(p) => (
            <select {...p} name="proyectoId" value={project} onChange={(e) => setProject(e.target.value)} required>
              {projects.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          )}
        </Field>
        <Field name="tareaId" label="Tarea que avanza" state={op.state} hint={projectTasks.length ? undefined : 'Este proyecto no tiene tareas abiertas'}>
          {(p) => (
            <select {...p} name="tareaId" key={project} defaultValue={projectTasks[0]?.value} required>
              {projectTasks.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          )}
        </Field>
        <Field name="titulo" label="Título" state={op.state} wide>
          {(p) => <input {...p} name="titulo" required maxLength={160} />}
        </Field>
        <Field name="objetivo" label="Objetivo" state={op.state} wide hint="Qué debe quedar hecho, en una o dos frases.">
          {(p) => <textarea {...p} name="objetivo" required rows={2} maxLength={2000} />}
        </Field>
        <Field name="contexto" label="Contexto y archivos (opcional)" state={op.state} wide>
          {(p) => <textarea {...p} name="contexto" rows={2} maxLength={2000} />}
        </Field>
        <Field name="criterios" label="Criterios de aceptación" state={op.state} wide hint="Verificables con una prueba o un comando.">
          {(p) => <textarea {...p} name="criterios" required rows={3} maxLength={2000} />}
        </Field>
        <Field name="fueraDeAlcance" label="Fuera de alcance" state={op.state} wide>
          {(p) => <textarea {...p} name="fueraDeAlcance" required rows={2} maxLength={2000} defaultValue="No desplegar, no fusionar, no cambiar workflows, secretos ni permisos, no escribir en Google Sheets." />}
        </Field>
        <Field name="comoProbar" label="Cómo probar" state={op.state} wide>
          {(p) => <textarea {...p} name="comoProbar" required rows={2} maxLength={2000} />}
        </Field>
        <Field name="riesgo" label="Riesgo" state={op.state} hint="El riesgo ALTO no se delega.">
          {(p) => (
            <select {...p} name="riesgo" defaultValue="BAJO" required>
              <option value="BAJO">Bajo</option>
              <option value="MEDIO">Medio (con supervisión)</option>
            </select>
          )}
        </Field>
      </div>
      <p className="muted small">La orden se crea en <strong>Borrador</strong>. Después la apruebas en Órdenes; nada se ejecuta sin tu aprobación.</p>
      <div className="form-actions">
        <Submit state={op.state} label="Crear orden" />
        <Link href="/ordenes" className="button button-ghost">Cancelar</Link>
      </div>
      <Status state={op.state}>
        {op.state.status === 'done' ? <p className="small"><Link href="/ordenes">Ver órdenes</Link></p> : null}
      </Status>
    </form>
  )
}

const ENVIO_TEXTO: Record<string, string> = {
  'sin-token': 'El envío automático a GitHub no está configurado: la orden quedó aprobada. Envíala a mano o configura el token.',
  'repo-no-permitido': 'Este proyecto no tiene repositorio permitido para órdenes.',
  red: 'No hubo conexión con GitHub. La orden quedó aprobada: pulsa «Crear el issue» para reintentar sin duplicar.',
}

interface EjecucionResult { ok: boolean; sessionUrl?: string; nueva?: boolean; codigo?: string }

const EJECUCION_TEXTO: Record<string, string> = {
  'sin-rutina': 'La ejecución automática con Claude no está configurada (docs/rutina-claude.md).',
  'sin-token': 'Falta el token de GitHub del dashboard: no se puede comprobar ni registrar la ejecución.',
  'orden-no-enviada': 'La orden debe estar Enviada, con su issue, para ejecutarla.',
  'http-429': 'Se alcanzó el límite de ejecuciones de la rutina. Espera unos minutos y vuelve a intentarlo.',
  red: 'No hubo conexión con Claude. Puedes volver a intentarlo.',
}

/** Resultado de lanzar a Claude (F5a). */
export function EjecucionStatus({ ejecucion }: { ejecucion?: EjecucionResult }) {
  if (!ejecucion) return null
  if (ejecucion.ok && ejecucion.sessionUrl) {
    return (
      <p className="small">
        {ejecucion.nueva ? 'Claude está ejecutando la orden: ' : 'Claude ya estaba ejecutando esta orden: '}
        <a href={ejecucion.sessionUrl} target="_blank" rel="noopener noreferrer nofollow">ver la sesión</a>. El PR aparecerá aquí cuando lo abra.
      </p>
    )
  }
  const texto = EJECUCION_TEXTO[ejecucion.codigo ?? ''] ?? `No se pudo lanzar a Claude (${ejecucion.codigo ?? 'error'}). Puedes volver a intentarlo.`
  return <p className="small"><strong>Atención:</strong> {texto}</p>
}

function EnvioStatus({ result }: { result: OpSuccess & { envio?: { ok: boolean; issueUrl?: string; creado?: boolean; codigo?: string }; ejecucion?: EjecucionResult } }) {
  const envio = result.envio
  if (!envio) return null
  if (envio.ok && envio.issueUrl) {
    return (
      <>
        <p className="small">
          {envio.creado ? 'Issue creado: ' : 'El issue ya existía: '}
          <a href={envio.issueUrl} target="_blank" rel="noopener noreferrer nofollow">ver el issue</a>.
          {result.ejecucion ? null : ' Recarga la página y usa «Ejecutar con Claude» o «Copiar para Claude».'}
        </p>
        <EjecucionStatus ejecucion={result.ejecucion} />
      </>
    )
  }
  const texto = ENVIO_TEXTO[envio.codigo ?? ''] ?? `No se pudo enviar a GitHub (${envio.codigo ?? 'error'}). La orden quedó aprobada: pulsa «Crear el issue» para reintentar sin duplicar.`
  return <p className="small"><strong>Atención:</strong> {texto}</p>
}

/**
 * Copia al portapapeles el texto con el que el propietario pide a Claude (sesión del repositorio en claude.ai/code) que
 * ejecute la orden. Si el navegador
 * no permite copiar, el texto queda visible para seleccionarlo a mano.
 */
export function CopiarParaClaude({ ordenId, texto }: { ordenId: string; texto: string }) {
  const [estado, setEstado] = useState<'idle' | 'copiado' | 'manual'>('idle')
  const id = useId()
  async function copiar() {
    try {
      await navigator.clipboard.writeText(texto)
      setEstado('copiado')
    } catch {
      setEstado('manual')
    }
  }
  return (
    <div className="card-actions orden-copy">
      <button type="button" className="button button-primary" onClick={copiar} aria-describedby={`${id}-ayuda`}>
        {estado === 'copiado' ? 'Copiado ✓' : 'Copiar para Claude'}
      </button>
      <a className="button" href="https://claude.ai/code" target="_blank" rel="noopener noreferrer">Abrir Claude</a>
      <p id={`${id}-ayuda`} className="muted small" role="status">
        {estado === 'copiado'
          ? `Pega el texto en la sesión de Claude del repositorio. Cuando Claude abra el PR [${ordenId}], aparecerá aquí.`
          : estado === 'manual'
            ? 'No se pudo copiar automáticamente: selecciona el texto de abajo y cópialo.'
            : 'Copia la orden y pégala en la sesión de Claude del repositorio: Claude la ejecuta y abre el PR.'}
      </p>
      <details open={estado === 'manual'}>
        <summary>Ver el texto para Claude</summary>
        <textarea readOnly value={texto} rows={12} aria-label={`Texto para Claude de ${ordenId}`} onFocus={(e) => e.currentTarget.select()} />
      </details>
    </div>
  )
}

const SUPERVISION_TEXTO: Record<string, string> = {
  'sin-rutina': 'Esta rutina no está configurada (docs/rutina-claude.md).',
  'head-cambio': 'El PR cambió desde que cargaste la página. Recárgala antes de lanzar.',
  'sin-accion': 'Ya no toca este paso. Recarga la página.',
  'correlativo-agotado': 'Correlativo de revisión agotado (máximo 999).',
  'orden-sin-pr': 'La orden no tiene un PR válido.',
  'http-429': 'Se alcanzó el límite de ejecuciones de la rutina. Espera unos minutos.',
  'resultado-incierto': 'Ya hay un lanzamiento reservado para este paso sin sesión registrada. Espera o revisa AUDITORIA (caduca a las 2 horas).',
  'auditoria-fallida': 'No se pudo registrar la reserva en AUDITORIA: no se lanzó nada.',
  'auditoria-pendiente': 'La sesión corre, pero no quedó la fila de AUDITORIA: avisa al propietario de la hoja.',
  red: 'No hubo conexión con Claude. Puedes volver a intentarlo.',
}

/** Resultado de lanzar una revisión o una corrección (ORD-POS-037). */
function SupervisionStatus({ supervision }: { supervision?: EjecucionResult }) {
  if (supervision?.ok && supervision.sessionUrl) {
    return (
      <p className="small">
        {supervision.nueva ? 'Sesión lanzada: ' : 'Esta sesión ya estaba lanzada: '}
        <a href={supervision.sessionUrl} target="_blank" rel="noopener noreferrer nofollow">ver la sesión</a>.
        {supervision.codigo ? ` ${SUPERVISION_TEXTO[supervision.codigo] ?? ''}` : ' El dictamen aparecerá aquí cuando termine.'}
      </p>
    )
  }
  const codigo = supervision?.codigo ?? 'error'
  return <p className="small"><strong>Atención:</strong> {SUPERVISION_TEXTO[codigo] ?? `No se pudo lanzar (${codigo}).`}</p>
}

/** Acciones sobre una orden. El servidor exige el estado que se vio (si cambió, pide recargar). */
export function OrderActions({ ordenId, estado, canApprove, prDetectado, claude, supervision, prFusionado }: {
  /** Revisión o corrección que toca (ORD-POS-037) y el head del PR que se vio al cargar. */
  supervision?: { accion: 'revisar' | 'corregir'; etiqueta: string; headSha: string; sesion?: string; incierto?: boolean }
  ordenId: string
  estado: string
  canApprove: boolean
  /** Ejecución automática (F5a): si la rutina está configurada y la sesión ya lanzada para el issue, si existe. */
  claude?: { configurada: boolean; sesion?: string | null }
  /** URL del PR de la orden detectado en GitHub (solo en ENVIADA). */
  prDetectado?: string
  /** El PR de la orden ya está fusionado (ORD-POS-046): un solo botón cierra; el servidor lo vuelve a comprobar. */
  prFusionado?: boolean
}) {
  const op = useOperation(`/api/operaciones/ordenes/${encodeURIComponent(ordenId)}`, 'PATCH')
  const run = useOperation(`/api/operaciones/ordenes/${encodeURIComponent(ordenId)}/ejecutar`, 'POST')
  const sup = useOperation(`/api/operaciones/ordenes/${encodeURIComponent(ordenId)}/supervision`, 'POST')
  const [mode, setMode] = useState<'idle' | 'cancel' | 'pr'>('idle')

  const send = (accion: string, extra: Record<string, string> = {}) => op.submit({ accion, expectedEstado: estado, ...extra })
  async function cancel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await send('CANCELAR', { motivo: formValues(event.currentTarget).motivo ?? '' })
  }
  async function registerPr(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await send('REGISTRAR_PR', { url: formValues(event.currentTarget).url ?? '' })
  }

  if (op.state.status === 'done') {
    return <Status state={op.state}><EnvioStatus result={op.state.result} /></Status>
  }
  if (run.state.status === 'done') {
    return <div className="card-actions"><EjecucionStatus ejecucion={(run.state.result as OpSuccess & { ejecucion?: EjecucionResult }).ejecucion} /></div>
  }
  if (sup.state.status === 'done') {
    return <div className="card-actions"><SupervisionStatus supervision={(sup.state.result as OpSuccess & { supervision?: EjecucionResult }).supervision} /></div>
  }
  function relanzar() {
    if (window.confirm('Claude ya tiene una sesión para esta orden. ¿Lanzar otra ejecución?')) void run.submit({ forzar: 'SI' })
  }
  const sending = op.state.status === 'sending' || run.state.status === 'sending' || sup.state.status === 'sending'
  const primary = (label: string, busy: string, onClick: () => void) => (
    <button type="button" className="button button-primary" onClick={onClick} disabled={sending} aria-busy={sending}>
      {sending ? busy : label}
    </button>
  )
  if (prFusionado && ['ENVIADA', 'PR_ABIERTO', 'REVISADA'].includes(estado)) {
    return <div className="card-actions">{primary('Cerrar (PR fusionado)', 'Cerrando…', () => send('CERRAR_FUSIONADO'))}<Status state={op.state} /></div>
  }
  return (
    <div className="card-actions">
      {mode === 'idle' ? (
        <>
          {estado === 'BORRADOR' && canApprove ? primary('Aprobar y crear el issue', 'Aprobando…', () => send('APROBAR')) : null}
          {estado === 'APROBADA' ? primary('Crear el issue', 'Creando…', () => send('ENVIAR')) : null}
          {estado === 'ENVIADA' && !prDetectado && claude?.configurada ? (
            claude.sesion
              ? <>
                  <a className="button" href={claude.sesion} target="_blank" rel="noopener noreferrer nofollow">Claude trabajando: ver sesión</a>
                  <button type="button" className="button" onClick={relanzar} disabled={sending}>Volver a lanzar…</button>
                </>
              : primary('Ejecutar con Claude', 'Lanzando…', () => void run.submit({}))
          ) : null}
          {estado === 'ENVIADA' ? (
            prDetectado
              ? primary('Registrar el PR detectado', 'Guardando…', () => send('REGISTRAR_PR', { url: prDetectado }))
              : <button type="button" className="button" onClick={() => setMode('pr')} disabled={sending}>Registrar PR…</button>
          ) : null}
          {supervision && (estado === 'PR_ABIERTO' || estado === 'REVISADA')
            ? supervision.sesion
              ? <a className="button" href={supervision.sesion} target="_blank" rel="noopener noreferrer nofollow">{supervision.accion === 'corregir' ? 'Corrección en curso' : 'Revisión en curso'}: ver sesión</a>
              : supervision.incierto ? <span className="small"><strong>Resultado incierto</strong> (reserva sin sesión registrada; caduca a las 2 horas)</span>
              : primary(supervision.etiqueta, 'Lanzando…', () => void sup.submit({ accion: supervision.accion.toUpperCase(), headEsperado: supervision.headSha }))
            : null}
          {estado === 'PR_ABIERTO' ? primary('Marcar revisada', 'Guardando…', () => send('REVISAR')) : null}
          {estado === 'REVISADA' ? primary('Cerrar orden', 'Guardando…', () => send('CERRAR')) : null}
          <button type="button" className="button" onClick={() => setMode('cancel')} disabled={sending}>Cancelar…</button>
        </>
      ) : null}
      {mode === 'cancel' ? (
        <form className="op-form" onSubmit={cancel} noValidate>
          <Field name="motivo" label="Motivo de la cancelación" state={op.state} wide>
            {(p) => <input {...p} name="motivo" required minLength={3} maxLength={500} />}
          </Field>
          <div className="form-actions">
            <Submit state={op.state} label="Cancelar orden" />
            <button type="button" className="button button-ghost" onClick={() => { setMode('idle'); op.reset() }}>Volver</button>
          </div>
        </form>
      ) : null}
      {mode === 'pr' ? (
        <form className="op-form" onSubmit={registerPr} noValidate>
          <Field name="url" label="URL del PR de la orden" state={op.state} wide hint="https://github.com/…/pull/N">
            {(p) => <input {...p} name="url" type="url" inputMode="url" required maxLength={500} placeholder="https://github.com/" />}
          </Field>
          <div className="form-actions">
            <Submit state={op.state} label="Registrar PR" />
            <button type="button" className="button button-ghost" onClick={() => { setMode('idle'); op.reset() }}>Volver</button>
          </div>
        </form>
      ) : null}
      <Status state={op.state} />
      <Status state={run.state} />
    </div>
  )
}
