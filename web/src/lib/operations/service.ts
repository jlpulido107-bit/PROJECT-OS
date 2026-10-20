import { randomBytes, randomUUID } from 'node:crypto'
import { todayInMerida } from '../dates'
import { CLOSED_TASK_STATES } from '../schema'
import {
  INITIAL_DECISION_STATE, INITIAL_ORDER_STATE, INITIAL_TASK_STATE, ORDER_RISKS, ORDER_TERMINAL_STATES, ORIGIN_PREFIX,
  WRITE_HEADERS, type EntityTab, type OperationName,
} from './constants'
import { OperationError } from './errors'
import { esSesionClaude, REPOSITORIOS, repoDeUrl } from './github'
import {
  cell, findById, readView, toRecord, toRow, type TableStore, type TableView,
} from './table-store'
import { meridaCompactDate, meridaIsoTimestamp } from './time'
import {
  derivedRequestId, payloadHash, type CreateDecisionCommand, type CreateOrderCommand, type CreateTaskCommand, type LogTimeCommand,
  type OrderTransitionCommand, type TaskChanges, type UpdateTaskCommand,
} from './validation'

/**
 * Servicio de aplicación V1.4 (contrato: docs/v1-4-write-contract.md).
 * Orden de cada mutación: referencias/versiones → idempotencia → AUDITORÍA → entidad → verificación.
 * No promete atomicidad: la auditoría primero hace la operación fail-closed y la conciliación detecta divergencias.
 */

export interface OperationContext {
  /** Correo del escritor autenticado (solo se escribe en AUDITORIA; nunca en logs). */
  actor: string
  /** Petición del agente PM (token propio): la auditoría añade `;agente=pm` a ORIGEN. */
  agent?: boolean
}

export interface OperationResult {
  operacion: OperationName
  entidad: EntityTab
  id: string
  version?: number
  /** La solicitud ya se había aplicado (idempotencia) o se completó una intención auditada (roll-forward). */
  repetida: boolean
}

export interface ReconcileItem {
  requestId: string
  operacion: string
  entidad: string
  id: string
  motivo: 'sin-efecto' | 'divergente' | 'auditoria-parcial' | 'auditoria-inconsistente' | 'actualizacion-perdida'
}

export interface ReconcileReport {
  operaciones: number
  pendientes: ReconcileItem[]
}

export interface ServiceOptions {
  mode: 'mock' | 'sheets'
  clock?: () => Date
  randomHex?: (bytes: number) => string
}

const TASK_FIELD_COLUMNS: Record<keyof TaskChanges, string> = {
  hitoId: 'HITO_ID',
  titulo: 'TITULO',
  descripcion: 'DESCRIPCION',
  tipo: 'TIPO',
  estado: 'ESTADO',
  prioridad: 'PRIORIDAD',
  responsable: 'RESPONSABLE',
  fechaPlan: 'FECHA_PLAN',
  fechaLimite: 'FECHA_LIMITE',
  horasEstimadas: 'HORAS_ESTIMADAS',
  criterioTerminado: 'CRITERIO_TERMINADO',
  bloqueo: 'BLOQUEO',
}

const ID_COLUMN: Record<EntityTab, string> = {
  TAREAS: 'TAREA_ID', TIEMPOS: 'SESION_ID', DECISIONES: 'DECISION_ID', ORDENES_CODEX: 'ORDEN_ID',
}

/** Transiciones de orden permitidas desde el dashboard (docs/migracion-ordenes-codex.md). */
const ORDER_TRANSITIONS: Record<OrderTransitionCommand['accion'], { from: readonly string[]; to: string; op: OperationName }> = {
  aprobar: { from: ['BORRADOR'], to: 'APROBADA', op: 'orden.aprobar' },
  cancelar: { from: ['BORRADOR', 'APROBADA', 'ENVIADA', 'PR_ABIERTO', 'REVISADA'], to: 'CANCELADA', op: 'orden.cancelar' },
  enviar: { from: ['APROBADA'], to: 'ENVIADA', op: 'orden.enviar' },
  registrar_pr: { from: ['ENVIADA'], to: 'PR_ABIERTO', op: 'orden.registrar_pr' },
  revisar: { from: ['PR_ABIERTO'], to: 'REVISADA', op: 'orden.revisar' },
  cerrar: { from: ['REVISADA'], to: 'CERRADA', op: 'orden.cerrar' },
  /** Cierre asistido (ORD-POS-046): solo tras confirmar en GitHub que el PR de la orden está fusionado (dispatch.ts). */
  cerrar_fusionado: { from: ['ENVIADA', 'PR_ABIERTO', 'REVISADA'], to: 'CERRADA', op: 'orden.cerrar_fusionado' },
}

interface AuditedOperation {
  requestId: string
  operacion: string
  hash: string
  entidad: string
  id: string
  /** CAMPO → { antes, despues } */
  fields: Map<string, { antes: string; despues: string }>
  order: number
  /** completa | parcial (faltan filas o campos obligatorios) | inconsistente (filas contradictorias). */
  integridad: 'completa' | 'parcial' | 'inconsistente'
}

const ORIGIN_PATTERN = /^dashboard-v1\.4;modo=(mock|sheets);op=([a-z._]+);req=([0-9a-f-]{36});h=([0-9a-f]{16})(?:;agente=pm)?$/

export class OperationsService {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly clock: () => Date
  private readonly randomHex: (bytes: number) => string

  constructor(private readonly store: TableStore, private readonly options: ServiceOptions) {
    this.clock = options.clock ?? (() => new Date())
    this.randomHex = options.randomHex ?? ((n) => randomBytes(n).toString('hex'))
  }

  /** Serializa las escrituras de ESTE proceso. No coordina entre instancias (contrato §6). */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  /* --------------------------------- Operaciones --------------------------------- */

  createTask(cmd: CreateTaskCommand, ctx: OperationContext): Promise<OperationResult> {
    return this.exclusive(async () => {
      const op: OperationName = 'tarea.crear'
      const hash = payloadHash(op, cmd)
      const [proyectos, hitos, tareas, audit] = await this.views('PROYECTOS', 'HITOS', 'TAREAS', 'AUDITORIA')
      const replay = await this.replayCreate(op, hash, cmd.requestId, audit, tareas)
      if (replay) return replay

      if (findById(proyectos, 'PROYECTO_ID', cmd.proyectoId).length === 0) throw new OperationError('proyecto-inexistente')
      this.checkHito(hitos, cmd.hitoId, cmd.proyectoId)

      const id = this.nextSequentialId(tareas, 'TAREA_ID', `${cmd.proyectoId}-`)
      const now = this.clock()
      const record: Record<string, string> = {
        TAREA_ID: id,
        PROYECTO_ID: cmd.proyectoId,
        HITO_ID: cmd.hitoId ?? '',
        TITULO: cmd.titulo,
        DESCRIPCION: cmd.descripcion ?? '',
        TIPO: cmd.tipo,
        ESTADO: INITIAL_TASK_STATE,
        PRIORIDAD: cmd.prioridad,
        RESPONSABLE: cmd.responsable ?? '',
        FECHA_PLAN: cmd.fechaPlan ?? '',
        FECHA_LIMITE: cmd.fechaLimite ?? '',
        HORAS_ESTIMADAS: cmd.horasEstimadas ?? '',
        CRITERIO_TERMINADO: cmd.criterioTerminado,
        BLOQUEO: cmd.bloqueo ?? '',
        VERSION: '1',
        ACTUALIZADO_EN: meridaIsoTimestamp(now),
      }
      await this.auditFirst(op, hash, cmd.requestId, ctx, 'TAREAS', id, creationDiff(record), now, audit)
      await this.appendEntity('TAREAS', tareas, record)
      await this.verifyCreated('TAREAS', id, record)
      return { operacion: op, entidad: 'TAREAS', id, version: 1, repetida: false }
    })
  }

  updateTask(cmd: UpdateTaskCommand, ctx: OperationContext): Promise<OperationResult> {
    return this.exclusive(async () => {
      const op: OperationName = 'tarea.editar'
      const hash = payloadHash(op, cmd)
      const [hitos, tareas, audit] = await this.views('HITOS', 'TAREAS', 'AUDITORIA')
      const matches = findById(tareas, 'TAREA_ID', cmd.tareaId)
      if (matches.length === 0) throw new OperationError('tarea-inexistente')
      if (matches.length > 1) throw new OperationError('conflicto-concurrente')
      const row = matches[0]!
      const current = toRecord(tareas, row.cells)

      const replay = await this.replayUpdate(op, hash, cmd.requestId, audit, tareas, row.sheetRow, current)
      if (replay) return replay

      if (CLOSED_TASK_STATES.has(current.ESTADO!.toUpperCase())) throw new OperationError('tarea-cerrada')
      const currentVersion = parseVersion(current.VERSION!)
      if (currentVersion !== cmd.expectedVersion) {
        throw new OperationError('conflicto-version', { detail: { versionActual: currentVersion } })
      }

      const next: Record<string, string> = { ...current }
      for (const [key, value] of Object.entries(cmd.changes) as Array<[keyof TaskChanges, string | null | undefined]>) {
        if (value === undefined) continue
        next[TASK_FIELD_COLUMNS[key]] = value ?? ''
      }
      if (next.HITO_ID !== current.HITO_ID) this.checkHito(hitos, next.HITO_ID || null, current.PROYECTO_ID!)
      if (next.ESTADO === 'BLOQUEADO' && !next.BLOQUEO) {
        throw new OperationError('validacion', { fields: { 'changes.bloqueo': 'Requerido cuando el estado es BLOQUEADO' } })
      }
      if (next.FECHA_PLAN && next.FECHA_LIMITE && next.FECHA_LIMITE < next.FECHA_PLAN) {
        throw new OperationError('validacion', { fields: { 'changes.fechaLimite': 'Debe ser igual o posterior a la fecha plan' } })
      }

      const diff = new Map<string, { antes: string; despues: string }>()
      for (const column of Object.values(TASK_FIELD_COLUMNS)) {
        if ((next[column] ?? '') !== (current[column] ?? '')) diff.set(column, { antes: current[column] ?? '', despues: next[column] ?? '' })
      }
      if (diff.size === 0) throw new OperationError('sin-cambios')

      const now = this.clock()
      const newVersion = currentVersion + 1
      next.VERSION = String(newVersion)
      next.ACTUALIZADO_EN = meridaIsoTimestamp(now)
      diff.set('VERSION', { antes: current.VERSION ?? '', despues: next.VERSION })
      diff.set('ACTUALIZADO_EN', { antes: current.ACTUALIZADO_EN ?? '', despues: next.ACTUALIZADO_EN })

      await this.auditFirst(op, hash, cmd.requestId, ctx, 'TAREAS', cmd.tareaId, diff, now, audit)
      await this.writeGuarded(tareas, row.sheetRow, row.cells, { column: 'TAREA_ID', value: cmd.tareaId }, { column: 'VERSION', value: current.VERSION ?? '' }, next)
      await this.verifyUpdated(cmd.tareaId, next)
      return { operacion: op, entidad: 'TAREAS', id: cmd.tareaId, version: newVersion, repetida: false }
    })
  }

  logTime(cmd: LogTimeCommand, ctx: OperationContext): Promise<OperationResult> {
    return this.exclusive(async () => {
      const op: OperationName = 'tiempo.registrar'
      const hash = payloadHash(op, cmd)
      const [tareas, tiempos, audit] = await this.views('TAREAS', 'TIEMPOS', 'AUDITORIA')
      const replay = await this.replayCreate(op, hash, cmd.requestId, audit, tiempos)
      if (replay) return replay
      if (findById(tareas, 'TAREA_ID', cmd.tareaId).length === 0) throw new OperationError('tarea-inexistente')

      const now = this.clock()
      let id = ''
      for (let i = 0; i < 5 && (!id || findById(tiempos, 'SESION_ID', id).length > 0); i++) {
        id = `SES-${meridaCompactDate(now)}-${this.randomHex(4).toUpperCase()}`
      }
      if (findById(tiempos, 'SESION_ID', id).length > 0) throw new OperationError('conflicto-concurrente')
      const record: Record<string, string> = {
        SESION_ID: id,
        TAREA_ID: cmd.tareaId,
        FECHA: cmd.fecha,
        RESPONSABLE: cmd.responsable,
        MINUTOS_REALES: cmd.minutos,
        TIPO_TRABAJO: cmd.tipoTrabajo,
        NOTAS: cmd.notas ?? '',
        CREADO_EN: meridaIsoTimestamp(now),
      }
      await this.auditFirst(op, hash, cmd.requestId, ctx, 'TIEMPOS', id, creationDiff(record), now, audit)
      await this.appendEntity('TIEMPOS', tiempos, record)
      await this.verifyCreated('TIEMPOS', id, record)
      return { operacion: op, entidad: 'TIEMPOS', id, repetida: false }
    })
  }

  createDecision(cmd: CreateDecisionCommand, ctx: OperationContext): Promise<OperationResult> {
    return this.exclusive(async () => {
      const op: OperationName = 'decision.crear'
      const hash = payloadHash(op, cmd)
      const [proyectos, decisiones, audit] = await this.views('PROYECTOS', 'DECISIONES', 'AUDITORIA')
      const replay = await this.replayCreate(op, hash, cmd.requestId, audit, decisiones)
      if (replay) return replay
      if (findById(proyectos, 'PROYECTO_ID', cmd.proyectoId).length === 0) throw new OperationError('proyecto-inexistente')

      const id = this.nextSequentialId(decisiones, 'DECISION_ID', `DEC-${cmd.proyectoId}-`)
      const now = this.clock()
      const record: Record<string, string> = {
        DECISION_ID: id,
        PROYECTO_ID: cmd.proyectoId,
        FECHA: cmd.fecha,
        ASUNTO: cmd.asunto,
        DECISION: cmd.decision,
        JUSTIFICACION: cmd.justificacion,
        RESPONSABLE: cmd.responsable,
        ESTADO: INITIAL_DECISION_STATE,
        EVIDENCIA_URL: cmd.evidenciaUrl ?? '',
      }
      await this.auditFirst(op, hash, cmd.requestId, ctx, 'DECISIONES', id, creationDiff(record), now, audit)
      await this.appendEntity('DECISIONES', decisiones, record)
      await this.verifyCreated('DECISIONES', id, record)
      return { operacion: op, entidad: 'DECISIONES', id, repetida: false }
    })
  }

  /** Crea una orden en BORRADOR (V1.8 F3). Solo el propietario la aprueba después. */
  createOrder(cmd: CreateOrderCommand, ctx: OperationContext): Promise<OperationResult> {
    return this.exclusive(async () => {
      const op: OperationName = 'orden.crear'
      const hash = payloadHash(op, cmd)
      const [proyectos, tareas, ordenes, audit] = await this.views('PROYECTOS', 'TAREAS', 'ORDENES_CODEX', 'AUDITORIA')
      const replay = await this.replayCreate(op, hash, cmd.requestId, audit, ordenes)
      if (replay) return replay
      if (findById(proyectos, 'PROYECTO_ID', cmd.proyectoId).length === 0) throw new OperationError('proyecto-inexistente')
      const tarea = findById(tareas, 'TAREA_ID', cmd.tareaId)
      if (tarea.length !== 1 || cell(tareas, tarea[0]!.cells, 'PROYECTO_ID') !== cmd.proyectoId) throw new OperationError('tarea-inexistente')

      const id = this.nextSequentialId(ordenes, 'ORDEN_ID', `ORD-${cmd.proyectoId}-`)
      const now = this.clock()
      const record: Record<string, string> = {
        ORDEN_ID: id,
        PROYECTO_ID: cmd.proyectoId,
        TAREA_ID: cmd.tareaId,
        TITULO: cmd.titulo,
        OBJETIVO: cmd.objetivo,
        CONTEXTO: cmd.contexto ?? '',
        CRITERIOS_ACEPTACION: cmd.criterios,
        FUERA_DE_ALCANCE: cmd.fueraDeAlcance,
        COMO_PROBAR: cmd.comoProbar,
        RIESGO: cmd.riesgo,
        ESTADO: INITIAL_ORDER_STATE,
        ISSUE_URL: '',
        PR_URL: '',
        NOTAS: '',
        ACTUALIZADO_EN: todayInMerida(now),
      }
      await this.auditFirst(op, hash, cmd.requestId, ctx, 'ORDENES_CODEX', id, creationDiff(record), now, audit)
      await this.appendEntity('ORDENES_CODEX', ordenes, record)
      await this.verifyCreated('ORDENES_CODEX', id, record)
      return { operacion: op, entidad: 'ORDENES_CODEX', id, repetida: false }
    })
  }

  /**
   * Aprobar (BORRADOR → APROBADA) o cancelar una orden. ORDENES_CODEX no tiene VERSION: la concurrencia se controla
   * con el ESTADO que vio el propietario (`expectedEstado`) y se relee justo antes de escribir.
   */
  transitionOrder(cmd: OrderTransitionCommand, ctx: OperationContext): Promise<OperationResult> {
    return this.exclusive(async () => {
      const rule = ORDER_TRANSITIONS[cmd.accion]
      const op = rule.op
      if ((cmd.accion === 'enviar' || cmd.accion === 'registrar_pr' || cmd.accion === 'cerrar_fusionado') && !cmd.url) {
        throw new OperationError('validacion', { fields: { url: 'Requerido' } })
      }
      const hash = payloadHash(op, cmd)
      const [tareas, ordenes, audit] = await this.views('TAREAS', 'ORDENES_CODEX', 'AUDITORIA')
      const matches = findById(ordenes, 'ORDEN_ID', cmd.ordenId)
      if (matches.length === 0) throw new OperationError('orden-inexistente')
      if (matches.length > 1) throw new OperationError('conflicto-concurrente')
      const row = matches[0]!
      const current = toRecord(ordenes, row.cells)
      const estado = (current.ESTADO ?? '').toUpperCase()

      // Idempotencia: la misma solicitud ya auditada se repite o se completa, nunca se duplica.
      const found = this.findAudited(audit, cmd.requestId)
      if (found) {
        const audited = found.op
        if (audited.operacion !== op || audited.hash !== hash || audited.id !== cmd.ordenId) throw new OperationError('conflicto-idempotencia')
        const change = audited.fields.get('ESTADO')
        if (!change) throw new OperationError('conflicto-idempotencia')
        if (estado === change.despues || found.later.length > 0) {
          return { operacion: op, entidad: 'ORDENES_CODEX', id: cmd.ordenId, repetida: true }
        }
        if (estado !== change.antes) throw new OperationError('estado-divergente')
        const next = { ...current }
        for (const [column, { despues }] of audited.fields) next[column] = despues
        await this.writeGuarded(ordenes, row.sheetRow, row.cells, { column: 'ORDEN_ID', value: cmd.ordenId }, { column: 'ESTADO', value: current.ESTADO ?? '' }, next)
        await this.verifyCreated('ORDENES_CODEX', cmd.ordenId, pick(next, [...audited.fields.keys()]))
        return { operacion: op, entidad: 'ORDENES_CODEX', id: cmd.ordenId, repetida: true }
      }

      if ((ORDER_TERMINAL_STATES as readonly string[]).includes(estado)) throw new OperationError('orden-cerrada')
      if (estado !== cmd.expectedEstado) {
        throw new OperationError('conflicto-version', { detail: { estadoActual: estado || 'SIN ESTADO' } })
      }
      if (!rule.from.includes(estado)) throw new OperationError('transicion-no-permitida')
      if (cmd.accion === 'aprobar') {
        const tarea = findById(tareas, 'TAREA_ID', current.TAREA_ID ?? '')
        const complete = ['TITULO', 'OBJETIVO', 'CRITERIOS_ACEPTACION', 'FUERA_DE_ALCANCE', 'COMO_PROBAR'].every((c) => (current[c] ?? '').trim() !== '')
        const prefix = /^ORD-([A-Z0-9]+)-/.exec(cmd.ordenId)?.[1]
        if (
          !complete || tarea.length !== 1 || cell(tareas, tarea[0]!.cells, 'PROYECTO_ID') !== current.PROYECTO_ID ||
          prefix !== current.PROYECTO_ID || !(ORDER_RISKS as readonly string[]).includes((current.RIESGO ?? '').toUpperCase())
        ) {
          throw new OperationError('orden-incompleta')
        }
      }

      const now = this.clock()
      const next: Record<string, string> = { ...current, ESTADO: rule.to, ACTUALIZADO_EN: todayInMerida(now) }
      if (cmd.url) {
        // La URL debe ser del repositorio del proyecto de la orden, no de otro de los permitidos.
        const repo = repoDeUrl(cmd.url, cmd.accion === 'enviar' ? 'issues' : 'pull')
        if (!repo || repo !== REPOSITORIOS[current.PROYECTO_ID ?? '']) {
          throw new OperationError('validacion', { fields: { url: 'Debe ser del repositorio del proyecto de la orden' } })
        }
      }
      if (cmd.accion === 'enviar' && cmd.url) next.ISSUE_URL = cmd.url
      if ((cmd.accion === 'registrar_pr' || cmd.accion === 'cerrar_fusionado') && cmd.url) next.PR_URL = cmd.url
      if (cmd.accion === 'cancelar' && cmd.motivo) {
        const nota = `Cancelada: ${cmd.motivo}`
        next.NOTAS = current.NOTAS ? `${current.NOTAS} | ${nota}` : nota
      }
      const diff = new Map<string, { antes: string; despues: string }>()
      for (const column of ['ESTADO', 'ISSUE_URL', 'PR_URL', 'NOTAS', 'ACTUALIZADO_EN']) {
        if ((next[column] ?? '') !== (current[column] ?? '')) diff.set(column, { antes: current[column] ?? '', despues: next[column] ?? '' })
      }
      await this.auditFirst(op, hash, cmd.requestId, ctx, 'ORDENES_CODEX', cmd.ordenId, diff, now, audit)
      await this.writeGuarded(ordenes, row.sheetRow, row.cells, { column: 'ORDEN_ID', value: cmd.ordenId }, { column: 'ESTADO', value: current.ESTADO ?? '' }, next)
      await this.verifyCreated('ORDENES_CODEX', cmd.ordenId, pick(next, [...diff.keys()]))
      return { operacion: op, entidad: 'ORDENES_CODEX', id: cmd.ordenId, repetida: false }
    })
  }

  /**
   * PR_URL de un cierre asistido ya auditado con este requestId, o null (ORD-POS-050): el reintento repite la transición
   * sin releer GitHub. Sin PR_URL en el diff, la URL no cambió y es la de la fila.
   */
  async prUrlCierreAuditado(requestId: string, ordenId: string): Promise<string | null> {
    const found = this.findAudited(await readView(this.store, 'AUDITORIA'), requestId)
    if (!found || found.op.operacion !== 'orden.cerrar_fusionado' || found.op.id !== ordenId) return null
    return found.op.fields.get('PR_URL')?.despues ?? (await this.readOrder(ordenId))?.PR_URL ?? null
  }

  /** Fila actual de una orden (para enviarla a GitHub), o null si no existe. */
  async readOrder(ordenId: string): Promise<Record<string, string> | null> {
    const view = await readView(this.store, 'ORDENES_CODEX')
    const rows = findById(view, 'ORDEN_ID', ordenId)
    return rows.length === 1 ? toRecord(view, rows[0]!.cells) : null
  }

  /**
   * Idempotencia de los lanzamientos de revisión o corrección: la sesión ya auditada con este requestId, o null.
   * El mismo requestId con otra orden, operación o payload es un conflicto.
   */
  sesionLanzada(op: OperationName, requestId: string, hash: string, ordenId: string): Promise<string | null> {
    return this.exclusive(async () => {
      const found = this.findAudited(await readView(this.store, 'AUDITORIA'), requestId)
      if (!found) return null
      if (found.op.operacion !== op || found.op.hash !== hash || found.op.id !== ordenId) throw new OperationError('conflicto-idempotencia')
      return found.op.fields.get('SESION')?.despues ?? null
    })
  }

  /** Constancia del lanzamiento (URL de la sesión y clave del paso) en AUDITORIA. No toca ORDENES_CODEX. */
  registrarLanzamiento(op: OperationName, requestId: string, hash: string, ordenId: string, sessionUrl: string, ctx: OperationContext, clave = ''): Promise<void> {
    return this.exclusive(async () => {
      const audit = await readView(this.store, 'AUDITORIA')
      const diff = new Map([['SESION', { antes: '', despues: sessionUrl }], ...(clave ? [['CLAVE', { antes: '', despues: clave }] as const] : [])])
      await this.auditFirst(op, hash, requestId, ctx, 'ORDENES_CODEX', ordenId, diff, this.clock(), audit)
    })
  }

  /** Lanzamiento o reserva vigente de cada clave (orden|acción|head|n), con cualquier requestId (ORD-POS-039). */
  async lanzamientosPorClave(claves: string[]): Promise<Map<string, EstadoLanzamiento>> {
    const ops = parseAudit(await readView(this.store, 'AUDITORIA'))
    return new Map(claves.map((c) => [c, estadoLanzamiento(ops, c, this.clock())]))
  }

  /**
   * Reserva auditada antes de disparar una rutina (ORD-POS-039): si la clave ya tiene lanzamiento o una reserva vigente,
   * no reserva. Si la escritura falla, lanza OperationError y no se dispara nada. Serializa solo este proceso (contrato §6).
   */
  reservarLanzamiento(ordenId: string, clave: string, ctx: OperationContext): Promise<EstadoLanzamiento> {
    return this.exclusive(async () => {
      const audit = await readView(this.store, 'AUDITORIA')
      const now = this.clock()
      const previo = estadoLanzamiento(parseAudit(audit), clave, now)
      if (previo.tipo !== 'libre') return previo
      const diff = new Map([['CLAVE', { antes: '', despues: clave }], ['RESERVA', { antes: '', despues: now.toISOString() }]])
      await this.auditFirst('orden.supervision_reservar', payloadHash('orden.supervision_reservar', { clave }), randomUUID(), ctx, 'ORDENES_CODEX', ordenId, diff, now, audit)
      return { tipo: 'libre' }
    })
  }

  /**
   * Libera la reserva de la clave cuando la rutina rechazó la petición (4xx) y no se lanzó nada (ORD-POS-045). El
   * requestId se deriva de la clave y de la reserva que libera: repetirla no añade filas en AUDITORIA (ORD-POS-052).
   */
  liberarLanzamiento(ordenId: string, clave: string, ctx: OperationContext): Promise<void> {
    return this.exclusive(async () => {
      const audit = await readView(this.store, 'AUDITORIA')
      const now = this.clock()
      const ultima = parseAudit(audit).filter((o) => o.integridad === 'completa' && o.fields.get('CLAVE')?.despues === clave && /^orden\.supervision_(reservar|liberar)$/.test(o.operacion)).at(-1)
      if (ultima?.operacion !== 'orden.supervision_reservar') return
      const diff = new Map([['CLAVE', { antes: '', despues: clave }], ['LIBERA', { antes: '', despues: now.toISOString() }]])
      await this.auditFirst('orden.supervision_liberar', payloadHash('orden.supervision_liberar', { clave }), derivedRequestId(ultima.requestId, `liberar:${clave}`), ctx, 'ORDENES_CODEX', ordenId, diff, now, audit)
    })
  }

  /**
   * Conciliación verificable (contrato §7): la última operación auditada de cada registro debe reflejarse en la
   * entidad. Lista intenciones sin efecto (p. ej. escritura fallida tras auditoría) o divergentes.
   */
  async reconcile(): Promise<ReconcileReport> {
    const [audit, tareas, tiempos, decisiones] = await this.views('AUDITORIA', 'TAREAS', 'TIEMPOS', 'DECISIONES')
    // ORDENES_CODEX es una pestaña añadida por migración (V1.7): si aún no existe, no hay órdenes que conciliar.
    const ordenes = await readView(this.store, 'ORDENES_CODEX').catch((error: unknown) => {
      if (error instanceof OperationError && error.code === 'esquema-invalido') return null
      throw error
    })
    const views: Partial<Record<EntityTab, TableView>> = { TAREAS: tareas, TIEMPOS: tiempos, DECISIONES: decisiones, ...(ordenes ? { ORDENES_CODEX: ordenes } : {}) }
    const ops = parseAudit(audit)
    const pendientes: ReconcileItem[] = []
    const item = (op: AuditedOperation, motivo: ReconcileItem['motivo']) =>
      pendientes.push({ requestId: op.requestId, operacion: op.operacion, entidad: op.entidad, id: op.id, motivo })
    // Auditorías incompletas o contradictorias: nunca se dan por conciliadas.
    for (const op of ops) if (op.integridad !== 'completa') item(op, op.integridad === 'parcial' ? 'auditoria-parcial' : 'auditoria-inconsistente')
    // Los lanzamientos de rutinas dejan constancia pero no cambian la orden: no hay efecto que conciliar.
    const complete = ops.filter((op) => op.integridad === 'completa' && !/^orden\.((revisar|corregir)_lanzar|supervision_(reservar|liberar))$/.test(op.operacion))
    // Actualización perdida: dos ediciones auditadas parten de la misma VERSION del mismo registro
    // (posible solo sin CAS entre instancias; contrato §6). La segunda pisó a la primera.
    const transitions = new Map<string, AuditedOperation[]>()
    for (const op of complete) {
      const before = op.operacion === 'tarea.editar' ? op.fields.get('VERSION')?.antes : undefined
      if (before === undefined) continue
      const key = `${op.entidad}|${op.id}|${before}`
      transitions.set(key, [...(transitions.get(key) ?? []), op])
    }
    for (const list of transitions.values()) if (list.length > 1) for (const op of list.slice(1)) item(op, 'actualizacion-perdida')
    const latest = new Map<string, AuditedOperation>()
    for (const op of complete) {
      const key = `${op.entidad}|${op.id}`
      const prev = latest.get(key)
      if (!prev || op.order > prev.order) latest.set(key, op)
    }
    for (const op of latest.values()) {
      const view = views[op.entidad as EntityTab]
      if (!view) continue
      const rows = findById(view, ID_COLUMN[op.entidad as EntityTab], op.id)
      if (rows.length === 0) {
        pendientes.push({ requestId: op.requestId, operacion: op.operacion, entidad: op.entidad, id: op.id, motivo: 'sin-efecto' })
        continue
      }
      const record = toRecord(view, rows[0]!.cells)
      const matches = [...op.fields.entries()].every(([column, { despues }]) => (record[column] ?? '') === despues)
      if (!matches) {
        const guardColumn = op.entidad === 'ORDENES_CODEX' ? 'ESTADO' : 'VERSION'
        const before = op.fields.get(guardColumn)?.antes
        const noEffect = before !== undefined && op.operacion !== 'orden.crear' && record[guardColumn] === before
        pendientes.push({
          requestId: op.requestId, operacion: op.operacion, entidad: op.entidad, id: op.id,
          motivo: noEffect ? 'sin-efecto' : 'divergente',
        })
      }
    }
    return { operaciones: ops.length, pendientes }
  }

  /* ---------------------------------- Internos ---------------------------------- */

  private views<const T extends readonly (keyof typeof WRITE_HEADERS)[]>(...tabs: T): Promise<{ [K in keyof T]: TableView }> {
    return Promise.all(tabs.map((tab) => readView(this.store, tab))) as Promise<{ [K in keyof T]: TableView }>
  }

  private checkHito(hitos: TableView, hitoId: string | null, proyectoId: string) {
    if (!hitoId) return
    const rows = findById(hitos, 'HITO_ID', hitoId)
    if (rows.length !== 1 || cell(hitos, rows[0]!.cells, 'PROYECTO_ID') !== proyectoId) {
      throw new OperationError('hito-inexistente')
    }
  }

  /** `PREFIJO-NNN` siguiente al máximo existente (convención real `POS-001`, `DEC-POS-001`). */
  private nextSequentialId(view: TableView, idColumn: string, prefix: string): string {
    let max = 0
    for (const row of view.rows) {
      const id = cell(view, row.cells, idColumn)
      if (!id.startsWith(prefix)) continue
      const n = Number(id.slice(prefix.length))
      if (Number.isInteger(n) && n > max) max = n
    }
    return `${prefix}${String(max + 1).padStart(3, '0')}`
  }

  private origin(op: OperationName, requestId: string, hash: string, agent = false) {
    return `${ORIGIN_PREFIX};modo=${this.options.mode};op=${op};req=${requestId};h=${hash}${agent ? ';agente=pm' : ''}`
  }

  /** Escribe la auditoría ANTES que la entidad. Si falla, no se escribe nada (fail-closed). */
  private async auditFirst(
    op: OperationName, hash: string, requestId: string, ctx: OperationContext, entidad: EntityTab, id: string,
    diff: Map<string, { antes: string; despues: string }>, now: Date, auditView: TableView,
  ) {
    const stamp = meridaIsoTimestamp(now)
    const compact = stamp.slice(0, 19).replace(/[-:T]/g, '')
    const batch = this.randomHex(4).toUpperCase()
    const origin = this.origin(op, requestId, hash, ctx.agent === true)
    const rows = [...diff.entries()].map(([campo, { antes, despues }], i) =>
      toRow(auditView, {
        AUDIT_ID: `AUD-${compact}-${batch}-${String(i + 1).padStart(2, '0')}-${String(diff.size).padStart(2, '0')}`,
        FECHA_HORA: stamp,
        ACTOR: ctx.actor,
        ENTIDAD: entidad,
        REGISTRO_ID: id,
        CAMPO: campo,
        VALOR_ANTES: antes,
        VALOR_DESPUES: despues,
        ORIGEN: origin,
      }),
    )
    try {
      await this.store.appendRows('AUDITORIA', rows)
    } catch {
      throw new OperationError('auditoria-fallida')
    }
  }

  private async appendEntity(tab: EntityTab, view: TableView, record: Record<string, string>) {
    try {
      await this.store.appendRows(tab, [toRow(view, record)])
    } catch {
      throw new OperationError('escritura-fallida')
    }
  }

  /**
   * Escribe la fila solo si, releída justo antes, conserva el mismo ID y VERSION (ventana mínima, no atómica).
   * Preserva columnas ajenas al contrato.
   */
  private async writeGuarded(
    view: TableView, sheetRow: number, originalCells: string[], id: { column: string; value: string },
    guard: { column: string; value: string }, next: Record<string, string>,
  ) {
    const fresh = await readView(this.store, view.tab)
    const row = fresh.rows.find((r) => r.sheetRow === sheetRow)
    if (!row || cell(fresh, row.cells, id.column) !== id.value || cell(fresh, row.cells, guard.column) !== guard.value) {
      throw new OperationError('conflicto-concurrente')
    }
    const contract = WRITE_HEADERS[view.tab] as readonly string[]
    const cells = fresh.header.map((name, i) => contract.includes(name) ? next[name] ?? '' : row.cells[i] ?? originalCells[i] ?? '')
    try {
      await this.store.writeRow(view.tab, sheetRow, cells)
    } catch (error) {
      if (error instanceof OperationError && error.code === 'conflicto-concurrente') throw error
      throw new OperationError('escritura-fallida')
    }
  }

  private async verifyCreated(tab: EntityTab, id: string, record: Record<string, string>) {
    const view = await readView(this.store, tab)
    const rows = findById(view, ID_COLUMN[tab], id)
    if (rows.length !== 1) throw new OperationError('verificacion-fallida')
    const stored = toRecord(view, rows[0]!.cells)
    for (const [column, value] of Object.entries(record)) {
      if ((stored[column] ?? '') !== value) throw new OperationError('verificacion-fallida')
    }
  }

  private async verifyUpdated(id: string, next: Record<string, string>) {
    await this.verifyCreated('TAREAS', id, Object.fromEntries((WRITE_HEADERS.TAREAS as readonly string[]).map((c) => [c, next[c] ?? ''])))
  }

  private findAudited(audit: TableView, requestId: string): { op: AuditedOperation; later: AuditedOperation[] } | null {
    const ops = parseAudit(audit)
    const op = ops.find((o) => o.requestId === requestId)
    if (!op) return null
    // Una auditoría parcial o contradictoria nunca se da por buena: queda para revisión manual.
    if (op.integridad !== 'completa') throw new OperationError('auditoria-inconsistente')
    const later = ops.filter((o) => o.integridad === 'completa' && o.entidad === op.entidad && o.id === op.id && o.order > op.order)
    return { op, later }
  }

  /** Idempotencia de altas: repetir (entidad presente) o completar la intención auditada (entidad ausente). */
  private async replayCreate(
    op: OperationName, hash: string, requestId: string, audit: TableView, view: TableView,
  ): Promise<OperationResult | null> {
    const found = this.findAudited(audit, requestId)
    if (!found) return null
    const audited = found.op
    if (audited.operacion !== op || audited.hash !== hash) throw new OperationError('conflicto-idempotencia')
    const tab = audited.entidad as EntityTab
    const record = Object.fromEntries([...audited.fields.entries()].map(([column, { despues }]) => [column, despues]))
    const existing = findById(view, ID_COLUMN[tab], audited.id)
    if (existing.length === 0) {
      // Roll-forward: la auditoría registró la intención pero la entidad no llegó a escribirse.
      await this.appendEntity(tab, view, record)
      await this.verifyCreated(tab, audited.id, record)
    } else {
      // La fila existe: es una repetición solo si coincide con lo auditado o si operaciones auditadas posteriores
      // explican el cambio. Una alteración sin operación auditada no se da por reconciliada.
      const stored = toRecord(view, existing[0]!.cells)
      const matches = Object.entries(record).every(([column, value]) => (stored[column] ?? '') === value)
      if (!matches && found.later.length === 0) throw new OperationError('estado-divergente')
    }
    const version = tab === 'TAREAS' ? Number(record.VERSION ?? '1') : undefined
    return { operacion: op, entidad: tab, id: audited.id, version, repetida: true }
  }

  /** Idempotencia de ediciones: repetir si ya se aplicó, completar si la versión sigue siendo la anterior. */
  private async replayUpdate(
    op: OperationName, hash: string, requestId: string, audit: TableView, tareas: TableView, sheetRow: number,
    current: Record<string, string>,
  ): Promise<OperationResult | null> {
    const found = this.findAudited(audit, requestId)
    if (!found) return null
    const audited = found.op
    if (audited.operacion !== op || audited.hash !== hash || audited.id !== current.TAREA_ID) {
      throw new OperationError('conflicto-idempotencia')
    }
    const versionChange = audited.fields.get('VERSION')
    if (!versionChange) throw new OperationError('conflicto-idempotencia')
    const applied = [...audited.fields.entries()].every(([column, { despues }]) => (current[column] ?? '') === despues)
    // Reintento legítimo: la operación se aplicó y después hubo ediciones AUDITADAS que la sustituyeron.
    const superseded = found.later.some((o) => o.fields.get('VERSION')?.antes === versionChange.despues)
    if (!applied && !superseded) {
      if (current.VERSION === versionChange.despues) throw new OperationError('estado-divergente')
      if (current.VERSION !== versionChange.antes) throw new OperationError('conflicto-version')
      const next = { ...current }
      for (const [column, { despues }] of audited.fields) next[column] = despues
      const row = tareas.rows.find((r) => r.sheetRow === sheetRow)!
      await this.writeGuarded(tareas, sheetRow, row.cells, { column: 'TAREA_ID', value: audited.id }, { column: 'VERSION', value: versionChange.antes }, next)
      await this.verifyUpdated(audited.id, next)
    }
    return { operacion: op, entidad: 'TAREAS', id: audited.id, version: Number(versionChange.despues), repetida: true }
  }
}

function creationDiff(record: Record<string, string>) {
  const diff = new Map<string, { antes: string; despues: string }>()
  for (const [column, value] of Object.entries(record)) if (value !== '') diff.set(column, { antes: '', despues: value })
  return diff
}

function pick(record: Record<string, string>, columns: string[]): Record<string, string> {
  return Object.fromEntries(columns.map((c) => [c, record[c] ?? '']))
}

function parseVersion(raw: string): number {
  const n = Number(raw.trim() || '0')
  return Number.isInteger(n) && n >= 0 ? n : 0
}

/** Campos que una auditoría completa debe incluir por operación (además de que el ID coincida con REGISTRO_ID). */
const REQUIRED_AUDIT_FIELDS: Record<string, string[]> = {
  'tarea.crear': ['TAREA_ID', 'VERSION'],
  'tarea.editar': ['VERSION'],
  'tiempo.registrar': ['SESION_ID'],
  'decision.crear': ['DECISION_ID'],
  'orden.crear': ['ORDEN_ID', 'ESTADO'],
  'orden.aprobar': ['ESTADO'],
  'orden.cancelar': ['ESTADO'],
  'orden.enviar': ['ESTADO'],
  'orden.registrar_pr': ['ESTADO'],
  'orden.revisar': ['ESTADO'],
  'orden.cerrar': ['ESTADO'],
  'orden.cerrar_fusionado': ['ESTADO'],
}
/** Operaciones que modifican un registro existente (no reescriben su ID). */
const TRANSITION_OPS = new Set(['tarea.editar', 'orden.aprobar', 'orden.cancelar', 'orden.enviar', 'orden.registrar_pr', 'orden.revisar', 'orden.cerrar', 'orden.cerrar_fusionado'])
const AUDIT_ID_PATTERN = /^(AUD-\d{14}-[0-9A-F]+)-(\d{2})(?:-(\d{2}))?$/

/**
 * Agrupa filas de AUDITORIA del dashboard V1.4 por solicitud (ORIGEN con req/hash) y verifica su integridad:
 * - inconsistente: filas de la misma solicitud con distinta operación, hash, entidad, registro, lote de AUDIT_ID,
 *   total declarado, índice repetido o el mismo CAMPO con valores distintos;
 * - parcial: faltan índices (AUDIT_ID …-NN-TT) o campos obligatorios de la operación.
 */
export function parseAudit(audit: TableView): AuditedOperation[] {
  const ops = new Map<string, AuditedOperation & { batch: string | null; total: number | null; indices: number[] }>()
  audit.rows.forEach((row, order) => {
    const origin = cell(audit, row.cells, 'ORIGEN')
    const match = ORIGIN_PATTERN.exec(origin)
    if (!match) return
    const [, , operacion, requestId, hash] = match as unknown as [string, string, string, string, string]
    const entidad = cell(audit, row.cells, 'ENTIDAD')
    const id = cell(audit, row.cells, 'REGISTRO_ID')
    const auditId = AUDIT_ID_PATTERN.exec(cell(audit, row.cells, 'AUDIT_ID'))
    const batch = auditId?.[1] ?? null
    const index = auditId ? Number(auditId[2]) : null
    const total = auditId?.[3] ? Number(auditId[3]) : null
    let op = ops.get(requestId)
    if (!op) {
      op = { requestId, operacion, hash, order, entidad, id, fields: new Map(), integridad: 'completa', batch, total, indices: [] }
      ops.set(requestId, op)
    } else if (op.operacion !== operacion || op.hash !== hash || op.entidad !== entidad || op.id !== id || op.batch !== batch || op.total !== total) {
      op.integridad = 'inconsistente'
    }
    if (index !== null) {
      if (op.indices.includes(index)) op.integridad = 'inconsistente'
      op.indices.push(index)
    }
    const campo = cell(audit, row.cells, 'CAMPO')
    const value = { antes: cell(audit, row.cells, 'VALOR_ANTES'), despues: cell(audit, row.cells, 'VALOR_DESPUES') }
    const prev = op.fields.get(campo)
    if (prev && (prev.antes !== value.antes || prev.despues !== value.despues)) op.integridad = 'inconsistente'
    op.fields.set(campo, value)
  })
  return [...ops.values()].map(({ batch, total, indices, ...op }) => {
    void batch
    if (op.integridad === 'completa') {
      const missingIndex = total !== null && (indices.length !== total || indices.some((i) => i < 1 || i > total))
      const required = REQUIRED_AUDIT_FIELDS[op.operacion] ?? []
      const missingField = required.some((f) => !op.fields.has(f))
      const idField = Object.entries(ID_COLUMN).find(([tab]) => tab === op.entidad)?.[1]
      const idMismatch = idField !== undefined && !TRANSITION_OPS.has(op.operacion) && op.fields.get(idField)?.despues !== op.id
      if (idMismatch && op.fields.has(idField)) op.integridad = 'inconsistente'
      else if (missingIndex || missingField) op.integridad = 'parcial'
    }
    return op
  })
}

export type EstadoLanzamiento = { tipo: 'lanzada'; sesion: string } | { tipo: 'reservada' } | { tipo: 'sesion-invalida' } | { tipo: 'libre' }
/** Una reserva sin lanzamiento caduca a las 2 horas (ORD-POS-039). */
export const RESERVA_MS = 2 * 60 * 60 * 1000
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/

function estadoLanzamiento(ops: AuditedOperation[], clave: string, now: Date): EstadoLanzamiento {
  const conClave = ops.filter((o) => o.integridad === 'completa' && o.fields.get('CLAVE')?.despues === clave)
  const lanzada = conClave.find((o) => /^orden\.(revisar|corregir)_lanzar$/.test(o.operacion) && o.fields.get('SESION')?.despues)
  // Una SESION que no es de claude.ai/code (p. ej. editada a mano en la hoja) no se enlaza, no caduca ni libera el paso (ORD-POS-041, 048).
  if (lanzada) return esSesionClaude(lanzada.fields.get('SESION')!.despues) ? { tipo: 'lanzada', sesion: lanzada.fields.get('SESION')!.despues } : { tipo: 'sesion-invalida' }
  // Manda la última reserva o liberación de la clave (ORD-POS-045).
  const ultima = conClave.filter((o) => /^orden\.supervision_(reservar|liberar)$/.test(o.operacion)).at(-1)
  if (!ultima || ultima.operacion === 'orden.supervision_liberar') return { tipo: 'libre' }
  // Una RESERVA que no es fecha ISO (p. ej. editada a mano) cuenta como reservada: no se sabe si caducó.
  const raw = ultima.fields.get('RESERVA')?.despues ?? ''
  const t = ISO_UTC.test(raw) ? Date.parse(raw) : NaN
  return !Number.isFinite(t) || now.getTime() - t < RESERVA_MS ? { tipo: 'reservada' } : { tipo: 'libre' }
}

export function todayForCommands(now: Date = new Date()): string {
  return todayInMerida(now)
}
