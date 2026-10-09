import { randomBytes } from 'node:crypto'
import { todayInMerida } from '../dates'
import { CLOSED_TASK_STATES } from '../schema'
import {
  INITIAL_DECISION_STATE, INITIAL_TASK_STATE, ORIGIN_PREFIX, WRITE_HEADERS, type EntityTab, type OperationName,
} from './constants'
import { OperationError } from './errors'
import {
  cell, findById, readView, toRecord, toRow, type TableStore, type TableView,
} from './table-store'
import { meridaCompactDate, meridaIsoTimestamp } from './time'
import {
  payloadHash, type CreateDecisionCommand, type CreateTaskCommand, type LogTimeCommand, type TaskChanges,
  type UpdateTaskCommand,
} from './validation'

/**
 * Servicio de aplicación V1.4 (contrato: docs/v1-4-write-contract.md).
 * Orden de cada mutación: referencias/versiones → idempotencia → AUDITORÍA → entidad → verificación.
 * No promete atomicidad: la auditoría primero hace la operación fail-closed y la conciliación detecta divergencias.
 */

export interface OperationContext {
  /** Correo del escritor autenticado (solo se escribe en AUDITORIA; nunca en logs). */
  actor: string
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
  motivo: 'sin-efecto' | 'divergente'
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

const ID_COLUMN: Record<EntityTab, string> = { TAREAS: 'TAREA_ID', TIEMPOS: 'SESION_ID', DECISIONES: 'DECISION_ID' }

interface AuditedOperation {
  requestId: string
  operacion: string
  hash: string
  entidad: string
  id: string
  /** CAMPO → { antes, despues } */
  fields: Map<string, { antes: string; despues: string }>
  order: number
}

const ORIGIN_PATTERN = /^dashboard-v1\.4;modo=(mock|sheets);op=([a-z.]+);req=([0-9a-f-]{36});h=([0-9a-f]{16})$/

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
      await this.writeGuarded(tareas, row.sheetRow, row.cells, cmd.tareaId, current.VERSION ?? '', next)
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

  /**
   * Conciliación verificable (contrato §7): la última operación auditada de cada registro debe reflejarse en la
   * entidad. Lista intenciones sin efecto (p. ej. escritura fallida tras auditoría) o divergentes.
   */
  async reconcile(): Promise<ReconcileReport> {
    const [audit, tareas, tiempos, decisiones] = await this.views('AUDITORIA', 'TAREAS', 'TIEMPOS', 'DECISIONES')
    const views: Record<EntityTab, TableView> = { TAREAS: tareas, TIEMPOS: tiempos, DECISIONES: decisiones }
    const ops = parseAudit(audit)
    const latest = new Map<string, AuditedOperation>()
    for (const op of ops) {
      const key = `${op.entidad}|${op.id}`
      const prev = latest.get(key)
      if (!prev || op.order > prev.order) latest.set(key, op)
    }
    const pendientes: ReconcileItem[] = []
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
        const versionBefore = op.fields.get('VERSION')?.antes
        const noEffect = versionBefore !== undefined && record.VERSION === versionBefore
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

  private origin(op: OperationName, requestId: string, hash: string) {
    return `${ORIGIN_PREFIX};modo=${this.options.mode};op=${op};req=${requestId};h=${hash}`
  }

  /** Escribe la auditoría ANTES que la entidad. Si falla, no se escribe nada (fail-closed). */
  private async auditFirst(
    op: OperationName, hash: string, requestId: string, ctx: OperationContext, entidad: EntityTab, id: string,
    diff: Map<string, { antes: string; despues: string }>, now: Date, auditView: TableView,
  ) {
    const stamp = meridaIsoTimestamp(now)
    const compact = stamp.slice(0, 19).replace(/[-:T]/g, '')
    const batch = this.randomHex(4).toUpperCase()
    const origin = this.origin(op, requestId, hash)
    const rows = [...diff.entries()].map(([campo, { antes, despues }], i) =>
      toRow(auditView, {
        AUDIT_ID: `AUD-${compact}-${batch}-${String(i + 1).padStart(2, '0')}`,
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
    view: TableView, sheetRow: number, originalCells: string[], id: string, expectedVersion: string,
    next: Record<string, string>,
  ) {
    const fresh = await readView(this.store, view.tab)
    const row = fresh.rows.find((r) => r.sheetRow === sheetRow)
    if (!row || cell(fresh, row.cells, 'TAREA_ID') !== id || cell(fresh, row.cells, 'VERSION') !== expectedVersion) {
      throw new OperationError('conflicto-concurrente')
    }
    const cells = fresh.header.map((name, i) => (WRITE_HEADERS.TAREAS as readonly string[]).includes(name) ? next[name] ?? '' : row.cells[i] ?? originalCells[i] ?? '')
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

  private findAudited(audit: TableView, requestId: string): AuditedOperation | null {
    return parseAudit(audit).find((op) => op.requestId === requestId) ?? null
  }

  /** Idempotencia de altas: repetir (entidad presente) o completar la intención auditada (entidad ausente). */
  private async replayCreate(
    op: OperationName, hash: string, requestId: string, audit: TableView, view: TableView,
  ): Promise<OperationResult | null> {
    const audited = this.findAudited(audit, requestId)
    if (!audited) return null
    if (audited.operacion !== op || audited.hash !== hash) throw new OperationError('conflicto-idempotencia')
    const tab = audited.entidad as EntityTab
    const record = Object.fromEntries([...audited.fields.entries()].map(([column, { despues }]) => [column, despues]))
    if (findById(view, ID_COLUMN[tab], audited.id).length === 0) {
      // Roll-forward: la auditoría registró la intención pero la entidad no llegó a escribirse.
      await this.appendEntity(tab, view, record)
      await this.verifyCreated(tab, audited.id, record)
    }
    const version = tab === 'TAREAS' ? Number(record.VERSION ?? '1') : undefined
    return { operacion: op, entidad: tab, id: audited.id, version, repetida: true }
  }

  /** Idempotencia de ediciones: repetir si ya se aplicó, completar si la versión sigue siendo la anterior. */
  private async replayUpdate(
    op: OperationName, hash: string, requestId: string, audit: TableView, tareas: TableView, sheetRow: number,
    current: Record<string, string>,
  ): Promise<OperationResult | null> {
    const audited = this.findAudited(audit, requestId)
    if (!audited) return null
    if (audited.operacion !== op || audited.hash !== hash || audited.id !== current.TAREA_ID) {
      throw new OperationError('conflicto-idempotencia')
    }
    const versionChange = audited.fields.get('VERSION')
    if (!versionChange) throw new OperationError('conflicto-idempotencia')
    const applied = [...audited.fields.entries()].every(([column, { despues }]) => (current[column] ?? '') === despues)
    if (!applied) {
      if (current.VERSION !== versionChange.antes) throw new OperationError('conflicto-version')
      const next = { ...current }
      for (const [column, { despues }] of audited.fields) next[column] = despues
      const row = tareas.rows.find((r) => r.sheetRow === sheetRow)!
      await this.writeGuarded(tareas, sheetRow, row.cells, audited.id, versionChange.antes, next)
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

function parseVersion(raw: string): number {
  const n = Number(raw.trim() || '0')
  return Number.isInteger(n) && n >= 0 ? n : 0
}

/** Agrupa filas de AUDITORIA del dashboard V1.4 por solicitud (ORIGEN con req/hash). */
export function parseAudit(audit: TableView): AuditedOperation[] {
  const ops = new Map<string, AuditedOperation>()
  audit.rows.forEach((row, order) => {
    const origin = cell(audit, row.cells, 'ORIGEN')
    const match = ORIGIN_PATTERN.exec(origin)
    if (!match) return
    const [, , operacion, requestId, hash] = match as unknown as [string, string, string, string, string]
    let op = ops.get(requestId)
    if (!op) {
      op = {
        requestId, operacion, hash, order,
        entidad: cell(audit, row.cells, 'ENTIDAD'),
        id: cell(audit, row.cells, 'REGISTRO_ID'),
        fields: new Map(),
      }
      ops.set(requestId, op)
    }
    op.fields.set(cell(audit, row.cells, 'CAMPO'), {
      antes: cell(audit, row.cells, 'VALOR_ANTES'),
      despues: cell(audit, row.cells, 'VALOR_DESPUES'),
    })
  })
  return [...ops.values()]
}

export function todayForCommands(now: Date = new Date()): string {
  return todayInMerida(now)
}
