import { createHash } from 'node:crypto'
import { addDays, parseCivilDate } from '../dates'
import { parseSafeUrl } from '../parse'
import {
  CLOSING_TASK_STATES, LIMITS, ORDER_RISKS, TASK_PRIORITIES, WRITABLE_TASK_STATES,
} from './constants'
import { OperationError } from './errors'
import { urlGitHubPermitida } from './github'
import { safeCellText } from './sanitize'

/**
 * Validación estricta de comandos de escritura (contrato §3). Rechaza claves desconocidas (sin asignación masiva),
 * tipos incorrectos y valores fuera de rango. Devuelve comandos normalizados listos para escribir.
 */

export interface CreateTaskCommand {
  requestId: string
  proyectoId: string
  hitoId: string | null
  titulo: string
  descripcion: string | null
  tipo: string
  prioridad: string
  responsable: string | null
  fechaPlan: string | null
  fechaLimite: string | null
  horasEstimadas: string | null
  criterioTerminado: string
  bloqueo: string | null
}

export type TaskChanges = Partial<{
  hitoId: string | null
  titulo: string
  descripcion: string | null
  tipo: string
  estado: string
  prioridad: string
  responsable: string | null
  fechaPlan: string | null
  fechaLimite: string | null
  horasEstimadas: string | null
  criterioTerminado: string
  bloqueo: string | null
}>

export interface UpdateTaskCommand {
  requestId: string
  tareaId: string
  expectedVersion: number
  changes: TaskChanges
}

export interface LogTimeCommand {
  requestId: string
  tareaId: string
  fecha: string
  responsable: string
  minutos: string
  tipoTrabajo: string
  notas: string | null
}

export interface CreateDecisionCommand {
  requestId: string
  proyectoId: string
  fecha: string
  asunto: string
  decision: string
  justificacion: string
  responsable: string
  evidenciaUrl: string | null
}

export interface CreateOrderCommand {
  requestId: string
  proyectoId: string
  tareaId: string
  titulo: string
  objetivo: string
  contexto: string | null
  criterios: string
  fueraDeAlcance: string
  comoProbar: string
  riesgo: string
}

export type OrderAction = 'aprobar' | 'cancelar' | 'enviar' | 'registrar_pr' | 'revisar' | 'cerrar'

export interface OrderTransitionCommand {
  requestId: string
  ordenId: string
  accion: OrderAction
  /** Estado que el propietario vio al decidir (control de concurrencia: ORDENES_CODEX no tiene VERSION). */
  expectedEstado: string
  motivo: string | null
  /** ISSUE_URL (enviar) o PR_URL (registrar_pr): solo de los repositorios permitidos. */
  url: string | null
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const PROJECT_ID = /^[A-Z][A-Z0-9]{1,9}$/
const ENTITY_ID = /^[A-Z][A-Z0-9]{0,9}(-[A-Z0-9]{1,12}){1,3}$/
const CODE = /^[A-Z][A-Z0-9_]{1,29}$/
const HOURS = /^\d{1,4}(\.\d{1,2})?$/

/** Acumula errores por campo y produce un único OperationError('validacion'). */
class Checker {
  readonly errors: Record<string, string> = {}

  constructor(private readonly input: Record<string, unknown>, allowed: readonly string[], prefix = '') {
    for (const key of Object.keys(input)) {
      if (!allowed.includes(key)) this.errors[prefix + key] = 'Campo no permitido'
    }
    this.prefix = prefix
  }

  private readonly prefix: string

  private fail(key: string, message: string): null {
    this.errors[this.prefix + key] = message
    return null
  }

  has(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.input, key)
  }

  private raw(key: string, required: boolean): string | null {
    const value = this.input[key]
    if (value === undefined || value === null || value === '') {
      return required ? this.fail(key, 'Requerido') : null
    }
    if (typeof value !== 'string') return this.fail(key, 'Debe ser texto')
    return value
  }

  text(key: string, opts: { required: boolean; min?: number; max: number; multiline?: boolean }): string | null {
    const raw = this.raw(key, opts.required)
    if (raw === null) return null
    const clean = safeCellText(raw, opts.multiline ?? false)
    if (!clean) return opts.required ? this.fail(key, 'Requerido') : null
    if (clean.length < (opts.min ?? 1)) return this.fail(key, `Mínimo ${opts.min} caracteres`)
    if (clean.length > opts.max) return this.fail(key, `Máximo ${opts.max} caracteres`)
    return clean
  }

  pattern(key: string, re: RegExp, required: boolean, message: string, transform = (s: string) => s.trim()): string | null {
    const raw = this.raw(key, required)
    if (raw === null) return null
    const value = transform(raw)
    return re.test(value) ? value : this.fail(key, message)
  }

  oneOf(key: string, values: readonly string[], required: boolean): string | null {
    const raw = this.raw(key, required)
    if (raw === null) return null
    const value = raw.trim().toUpperCase()
    return values.includes(value) ? value : this.fail(key, `Valor no permitido (${values.join(', ')})`)
  }

  date(key: string, required: boolean): string | null {
    const raw = this.raw(key, required)
    if (raw === null) return null
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return this.fail(key, 'Fecha AAAA-MM-DD')
    const parsed = parseCivilDate(raw.trim())
    return parsed.value ?? this.fail(key, 'Fecha no válida')
  }

  /** Número decimal como texto canónico (punto decimal). */
  decimal(key: string, opts: { required: boolean; max: number }): string | null {
    const value = this.input[key]
    if (value === undefined || value === null || value === '') return opts.required ? this.fail(key, 'Requerido') : null
    const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim().replace(',', '.') : null
    if (text === null || !HOURS.test(text)) return this.fail(key, 'Número con hasta 2 decimales')
    const n = Number(text)
    if (!(n > 0) || n > opts.max) return this.fail(key, `Debe ser mayor que 0 y como máximo ${opts.max}`)
    return String(n)
  }

  integer(key: string, opts: { min: number; max: number }): string | null {
    const value = this.input[key]
    const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN
    if (!Number.isInteger(n)) return this.fail(key, 'Número entero requerido')
    if (n < opts.min || n > opts.max) return this.fail(key, `Entre ${opts.min} y ${opts.max}`)
    return String(n)
  }

  url(key: string): string | null {
    const raw = this.raw(key, false)
    if (raw === null) return null
    const trimmed = raw.trim()
    if (trimmed.length > LIMITS.url) return this.fail(key, `Máximo ${LIMITS.url} caracteres`)
    const parsed = parseSafeUrl(trimmed)
    if (!parsed.value || !parsed.value.startsWith('https://')) return this.fail(key, 'URL https:// sin credenciales')
    return parsed.value
  }

  requestId(): string {
    const raw = this.input.requestId
    if (typeof raw !== 'string' || !UUID_V4.test(raw)) {
      this.errors.requestId = 'Identificador de solicitud inválido'
      return ''
    }
    return raw
  }

  setError(key: string, message: string) {
    this.errors[this.prefix + key] = message
  }

  done() {
    if (Object.keys(this.errors).length > 0) throw new OperationError('validacion', { fields: this.errors })
  }
}

function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OperationError('json-invalido')
  return body as Record<string, unknown>
}

function checkDateOrder(c: Checker, plan: string | null, limite: string | null) {
  if (plan && limite && limite < plan) c.setError('fechaLimite', 'Debe ser igual o posterior a la fecha plan')
}

const CREATE_TASK_KEYS = [
  'requestId', 'proyectoId', 'hitoId', 'titulo', 'descripcion', 'tipo', 'prioridad', 'responsable', 'fechaPlan',
  'fechaLimite', 'horasEstimadas', 'criterioTerminado', 'bloqueo',
] as const

export function parseCreateTask(body: unknown): CreateTaskCommand {
  const input = asObject(body)
  const c = new Checker(input, CREATE_TASK_KEYS)
  if (c.has('estado')) c.setError('estado', 'Las tareas nuevas se crean en PENDIENTE')
  const cmd: CreateTaskCommand = {
    requestId: c.requestId(),
    proyectoId: c.pattern('proyectoId', PROJECT_ID, true, 'ID de proyecto no válido', (s) => s.trim().toUpperCase()) ?? '',
    hitoId: c.pattern('hitoId', ENTITY_ID, false, 'ID de hito no válido', (s) => s.trim().toUpperCase()),
    titulo: c.text('titulo', { required: true, min: 3, max: LIMITS.titulo }) ?? '',
    descripcion: c.text('descripcion', { required: false, max: LIMITS.descripcion, multiline: true }),
    tipo: c.pattern('tipo', CODE, true, 'Código en MAYÚSCULAS (p. ej. DESARROLLO)', (s) => s.trim().toUpperCase()) ?? '',
    prioridad: c.oneOf('prioridad', TASK_PRIORITIES, true) ?? '',
    responsable: c.text('responsable', { required: false, max: LIMITS.responsable }),
    fechaPlan: c.date('fechaPlan', false),
    fechaLimite: c.date('fechaLimite', false),
    horasEstimadas: c.decimal('horasEstimadas', { required: false, max: LIMITS.horasMax }),
    criterioTerminado: c.text('criterioTerminado', { required: true, min: 3, max: LIMITS.criterio, multiline: true }) ?? '',
    bloqueo: c.text('bloqueo', { required: false, max: LIMITS.bloqueo, multiline: true }),
  }
  checkDateOrder(c, cmd.fechaPlan, cmd.fechaLimite)
  c.done()
  return cmd
}

const CHANGE_KEYS = [
  'hitoId', 'titulo', 'descripcion', 'tipo', 'estado', 'prioridad', 'responsable', 'fechaPlan', 'fechaLimite',
  'horasEstimadas', 'criterioTerminado', 'bloqueo',
] as const

export function parseUpdateTask(tareaId: string, body: unknown): UpdateTaskCommand {
  const input = asObject(body)
  const top = new Checker(input, ['requestId', 'expectedVersion', 'changes'])
  const requestId = top.requestId()
  const id = tareaId.trim().toUpperCase()
  if (!ENTITY_ID.test(id)) top.setError('tareaId', 'ID de tarea no válido')
  const version = input.expectedVersion
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    top.setError('expectedVersion', 'Versión esperada requerida')
  }
  const rawChanges = input.changes
  if (!rawChanges || typeof rawChanges !== 'object' || Array.isArray(rawChanges)) {
    top.setError('changes', 'Cambios requeridos')
    top.done()
  }
  const changesInput = rawChanges as Record<string, unknown>
  const c = new Checker(changesInput, CHANGE_KEYS, 'changes.')
  const changes: TaskChanges = {}
  if (c.has('estado')) {
    const raw = changesInput.estado
    const value = typeof raw === 'string' ? raw.trim().toUpperCase() : ''
    if ((CLOSING_TASK_STATES as readonly string[]).includes(value)) {
      throw new OperationError('cierre-no-permitido')
    }
    const estado = c.oneOf('estado', WRITABLE_TASK_STATES, true)
    if (estado) changes.estado = estado
  }
  if (c.has('hitoId')) changes.hitoId = c.pattern('hitoId', ENTITY_ID, false, 'ID de hito no válido', (s) => s.trim().toUpperCase())
  if (c.has('titulo')) changes.titulo = c.text('titulo', { required: true, min: 3, max: LIMITS.titulo }) ?? undefined
  if (c.has('descripcion')) changes.descripcion = c.text('descripcion', { required: false, max: LIMITS.descripcion, multiline: true })
  if (c.has('tipo')) changes.tipo = c.pattern('tipo', CODE, true, 'Código en MAYÚSCULAS', (s) => s.trim().toUpperCase()) ?? undefined
  if (c.has('prioridad')) changes.prioridad = c.oneOf('prioridad', TASK_PRIORITIES, true) ?? undefined
  if (c.has('responsable')) changes.responsable = c.text('responsable', { required: false, max: LIMITS.responsable })
  if (c.has('fechaPlan')) changes.fechaPlan = c.date('fechaPlan', false)
  if (c.has('fechaLimite')) changes.fechaLimite = c.date('fechaLimite', false)
  if (c.has('horasEstimadas')) changes.horasEstimadas = c.decimal('horasEstimadas', { required: false, max: LIMITS.horasMax })
  if (c.has('criterioTerminado')) {
    changes.criterioTerminado = c.text('criterioTerminado', { required: true, min: 3, max: LIMITS.criterio, multiline: true }) ?? undefined
  }
  if (c.has('bloqueo')) changes.bloqueo = c.text('bloqueo', { required: false, max: LIMITS.bloqueo, multiline: true })
  if (Object.keys(changesInput).length === 0) c.setError('changes', 'Sin cambios')
  for (const [key, message] of Object.entries(c.errors)) top.setError(key, message)
  top.done()
  return { requestId, tareaId: id, expectedVersion: version as number, changes }
}

/** Valida que `fecha` no sea futura ni anterior al límite, respecto a `today` (Mérida). */
function checkPastDate(c: Checker, key: string, fecha: string | null, today: string) {
  if (!fecha) return
  if (fecha > today) c.setError(key, 'No puede ser futura')
  else if (fecha < addDays(today, -LIMITS.diasAtras)) c.setError(key, `No puede ser anterior a ${LIMITS.diasAtras} días`)
}

export function parseLogTime(body: unknown, today: string): LogTimeCommand {
  const input = asObject(body)
  const c = new Checker(input, ['requestId', 'tareaId', 'fecha', 'responsable', 'minutos', 'tipoTrabajo', 'notas'])
  const cmd: LogTimeCommand = {
    requestId: c.requestId(),
    tareaId: c.pattern('tareaId', ENTITY_ID, true, 'ID de tarea no válido', (s) => s.trim().toUpperCase()) ?? '',
    fecha: c.date('fecha', true) ?? '',
    responsable: c.text('responsable', { required: true, max: LIMITS.responsable }) ?? '',
    minutos: c.integer('minutos', { min: 1, max: LIMITS.minutosMax }) ?? '',
    tipoTrabajo: c.pattern('tipoTrabajo', CODE, true, 'Código en MAYÚSCULAS', (s) => s.trim().toUpperCase()) ?? '',
    notas: c.text('notas', { required: false, max: LIMITS.notas, multiline: true }),
  }
  checkPastDate(c, 'fecha', cmd.fecha || null, today)
  c.done()
  return cmd
}

export function parseCreateDecision(body: unknown, today: string): CreateDecisionCommand {
  const input = asObject(body)
  const c = new Checker(input, [
    'requestId', 'proyectoId', 'fecha', 'asunto', 'decision', 'justificacion', 'responsable', 'evidenciaUrl',
  ])
  if (c.has('estado')) c.setError('estado', 'Las decisiones se crean en PENDIENTE')
  const cmd: CreateDecisionCommand = {
    requestId: c.requestId(),
    proyectoId: c.pattern('proyectoId', PROJECT_ID, true, 'ID de proyecto no válido', (s) => s.trim().toUpperCase()) ?? '',
    fecha: c.date('fecha', false) ?? today,
    asunto: c.text('asunto', { required: true, min: 3, max: LIMITS.asunto }) ?? '',
    decision: c.text('decision', { required: true, min: 3, max: LIMITS.decision, multiline: true }) ?? '',
    justificacion: c.text('justificacion', { required: true, min: 3, max: LIMITS.justificacion, multiline: true }) ?? '',
    responsable: c.text('responsable', { required: true, max: LIMITS.responsable }) ?? '',
    evidenciaUrl: c.url('evidenciaUrl'),
  }
  checkPastDate(c, 'fecha', cmd.fecha, today)
  c.done()
  return cmd
}

const ORDER_ID = /^ORD-[A-Z][A-Z0-9]{1,9}-\d{3,6}$/
const ORDER_STATES = ['BORRADOR', 'APROBADA', 'ENVIADA', 'PR_ABIERTO', 'REVISADA', 'CERRADA', 'CANCELADA'] as const

export function parseCreateOrder(body: unknown): CreateOrderCommand {
  const input = asObject(body)
  const c = new Checker(input, [
    'requestId', 'proyectoId', 'tareaId', 'titulo', 'objetivo', 'contexto', 'criterios', 'fueraDeAlcance', 'comoProbar', 'riesgo',
  ])
  if (c.has('estado')) c.setError('estado', 'Las órdenes se crean en BORRADOR')
  const long = { required: true, min: 3, max: LIMITS.ordenTexto, multiline: true }
  const cmd: CreateOrderCommand = {
    requestId: c.requestId(),
    proyectoId: c.pattern('proyectoId', PROJECT_ID, true, 'ID de proyecto no válido', (s) => s.trim().toUpperCase()) ?? '',
    tareaId: c.pattern('tareaId', ENTITY_ID, true, 'ID de tarea no válido', (s) => s.trim().toUpperCase()) ?? '',
    titulo: c.text('titulo', { required: true, min: 3, max: LIMITS.titulo }) ?? '',
    objetivo: c.text('objetivo', long) ?? '',
    contexto: c.text('contexto', { required: false, max: LIMITS.ordenTexto, multiline: true }),
    criterios: c.text('criterios', long) ?? '',
    fueraDeAlcance: c.text('fueraDeAlcance', long) ?? '',
    comoProbar: c.text('comoProbar', long) ?? '',
    riesgo: c.oneOf('riesgo', ORDER_RISKS, true) ?? '',
  }
  c.done()
  return cmd
}

const ACCIONES = ['APROBAR', 'CANCELAR', 'ENVIAR', 'REGISTRAR_PR', 'REVISAR', 'CERRAR'] as const

export function parseOrderTransition(ordenId: string, body: unknown): OrderTransitionCommand {
  const input = asObject(body)
  const c = new Checker(input, ['requestId', 'accion', 'expectedEstado', 'motivo', 'url'])
  const id = ordenId.trim().toUpperCase()
  if (!ORDER_ID.test(id)) c.setError('ordenId', 'ID de orden no válido')
  const accion = c.oneOf('accion', ACCIONES, true)
  // ENVIAR sin URL: el servidor crea el issue en GitHub (F4). Con URL: registro manual de un issue existente.
  const needsUrl = accion === 'ENVIAR' || accion === 'REGISTRAR_PR'
  const rawUrl = c.has('url') ? c.url('url') : null
  if (accion === 'REGISTRAR_PR' && !rawUrl && !c.errors.url) c.setError('url', 'Requerido')
  if (rawUrl && !needsUrl) c.setError('url', 'Solo se usa al enviar o al registrar el PR')
  if (rawUrl && needsUrl && !urlGitHubPermitida(rawUrl, accion === 'ENVIAR' ? 'issues' : 'pull')) {
    c.setError('url', accion === 'ENVIAR' ? 'Debe ser un issue de PROJECT-OS, SIGSAH o RADAROS' : 'Debe ser un PR de PROJECT-OS, SIGSAH o RADAROS')
  }
  const cmd: OrderTransitionCommand = {
    requestId: c.requestId(),
    ordenId: id,
    accion: (accion?.toLowerCase() ?? 'aprobar') as OrderAction,
    expectedEstado: c.oneOf('expectedEstado', ORDER_STATES, true) ?? '',
    motivo: c.text('motivo', { required: accion === 'CANCELAR', min: 3, max: LIMITS.motivo }),
    url: needsUrl ? rawUrl : null,
  }
  if (accion !== 'CANCELAR' && cmd.motivo) c.setError('motivo', 'Solo se usa al cancelar')
  c.done()
  return cmd
}

/** «Ejecutar con Claude» (F5a): solo el ID de la orden y, para volver a lanzar, forzar = 'SI'. */
export function parseEjecutarOrden(ordenId: string, body: unknown): { ordenId: string; forzar: boolean } {
  const c = new Checker(asObject(body), ['requestId', 'forzar'])
  const id = ordenId.trim().toUpperCase()
  if (!ORDER_ID.test(id)) c.setError('ordenId', 'ID de orden no válido')
  c.requestId()
  const forzar = c.oneOf('forzar', ['SI', 'NO'], false) === 'SI'
  c.done()
  return { ordenId: id, forzar }
}

export interface LanzarSupervisionCommand { requestId: string; ordenId: string; accion: 'revisar' | 'corregir'; headEsperado: string }

/** «Lanzar revisión» / «Pedir corrección» (ORD-POS-037): solo el head que vio el propietario; el resto lo deriva el servidor. */
export function parseLanzarSupervision(ordenId: string, body: unknown): LanzarSupervisionCommand {
  const c = new Checker(asObject(body), ['requestId', 'accion', 'headEsperado'])
  const id = ordenId.trim().toUpperCase()
  if (!ORDER_ID.test(id)) c.setError('ordenId', 'ID de orden no válido')
  const requestId = c.requestId()
  const accion = c.oneOf('accion', ['REVISAR', 'CORREGIR'], true)
  const headEsperado = c.pattern('headEsperado', /^[0-9a-f]{40}$/, true, 'SHA de 40 caracteres hexadecimales')
  c.done()
  return { requestId, ordenId: id, accion: accion!.toLowerCase() as 'revisar' | 'corregir', headEsperado: headEsperado! }
}

/** Hash estable del comando validado (sin requestId) para detectar reutilización con otro payload. */
export function payloadHash(operation: string, command: object): string {
  const { requestId: _ignored, ...rest } = command as Record<string, unknown>
  void _ignored
  const canonical = JSON.stringify({ operation, ...(sortKeys(rest) as Record<string, unknown>) })
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as object).sort().map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]))
  }
  return value
}
