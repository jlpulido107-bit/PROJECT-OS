import { randomBytes } from 'node:crypto'
import { addDays, civilDateInZone } from '../dates'
import { MAX_DATA_ROWS } from '../schema'
import { OperationError } from '../operations/errors'
import { meridaIsoTimestamp } from '../operations/time'
import { payloadHash } from '../operations/validation'
import type { Celda, FinanzasStore, FinanzasWriteTab } from './escritura-store'
import { aNumero, conceptoFinal, convertirCentavos, type ConfirmarCommand, type MovimientoCommand } from './escritura-validacion'
import { leerParametros, leerRecurrentes, movIdRecurrente, sumarMeses, vigenteEn } from './finanzas'

/**
 * Servicio de escritura de finanzas (ORD-POS-077, docs/diseno-finanzas-v2.md §3 a §5). No es la API de operaciones:
 * su almacén está ligado solo al libro FINANZAS y su auditoría vive en la pestaña AUDITORIA de ese libro.
 * Orden de cada alta: pestañas y encabezados → idempotencia por requestId → validación contra la hoja → AUDITORÍA →
 * fila en MOVIMIENTOS → verificación. Solo altas: no hay edición ni borrado.
 */

/** Operaciones de finanzas. Tipo propio: nunca forman parte de `OperationName` ni de `AGENT_OPERATIONS`. */
export const FINANZAS_OPERATIONS = ['finanzas.movimiento.crear', 'finanzas.recurrente.confirmar'] as const
export type FinanzasOperationName = (typeof FINANZAS_OPERATIONS)[number]

/** MOVIMIENTOS completa para escribir: las 14 columnas de v1 más `AJUSTE_DE` (v2 §8). */
export const COLUMNAS_MOVIMIENTOS_ESCRITURA = [
  'MOV_ID', 'FECHA', 'PROYECTO', 'TIPO', 'CATEGORIA', 'CONCEPTO', 'PRODUCTO_ID', 'MONTO_MXN', 'MONEDA_ORIG', 'MONTO_ORIG',
  'TIPO_CAMBIO', 'IVA_MXN', 'FUENTE', 'COMPROBANTE', 'AJUSTE_DE',
] as const
/** Las mismas columnas que la AUDITORIA de PROJECT-OS (v2 §5, paso 3). */
export const COLUMNAS_AUDITORIA = ['AUDIT_ID', 'FECHA_HORA', 'ACTOR', 'ENTIDAD', 'REGISTRO_ID', 'CAMPO', 'VALOR_ANTES', 'VALOR_DESPUES', 'ORIGEN'] as const
/** Pestañas sin las cuales no se escribe nada (400). PARAMETROS es opcional. */
export const PESTANAS_OBLIGATORIAS = ['MOVIMIENTOS', 'RECURRENTES', 'AUDITORIA'] as const

const NUMERICAS = new Set(['MONTO_MXN', 'MONTO_ORIG', 'TIPO_CAMBIO', 'IVA_MXN'])
const ORIGIN_PREFIX = 'dashboard-finanzas;modo=sheets'
const ORIGIN = /^dashboard-finanzas;modo=sheets;op=(finanzas\.[a-z.]+);req=([0-9a-f-]{36});hash=([0-9a-f]{16})$/
const AUDIT_ID = /^(AUD-\d{14}-[0-9A-F]+)-(\d{2})-(\d{2})$/
const MAN = /^MAN-(\d{4})$/
const MAN_MAX = 9999

export interface FinanzasContext {
  /** Correo del único escritor de finanzas (solo se escribe en la AUDITORIA de FINANZAS; nunca en logs). */
  actor: string
}

export interface FinanzasResultado {
  operacion: FinanzasOperationName
  id: string
  repetida: boolean
}

export interface FinanzasServiceOptions {
  clock?: () => Date
  randomHex?: (bytes: number) => string
}

type Registro = Record<string, Celda>

interface Tabla {
  header: string[]
  indice: Map<string, number>
  filas: unknown[][]
}

interface Libro {
  movimientos: Tabla
  auditoria: Tabla
  recurrentes: unknown[][]
  parametros: unknown[][] | undefined
}

interface Auditada {
  requestId: string
  operacion: string
  hash: string
  id: string
  campos: Map<string, string>
  integridad: 'completa' | 'parcial' | 'inconsistente'
}

/** Texto de una celda leída con UNFORMATTED_VALUE. */
export function celdaTexto(v: unknown): string {
  if (v === null || v === undefined) return ''
  return typeof v === 'string' ? v.trim() : String(v)
}

function tabla(rows: unknown[][], columnas: readonly string[], pestana: string): Tabla {
  const header = (rows[0] ?? []).map(celdaTexto)
  const indice = new Map<string, number>()
  for (const [i, name] of header.entries()) {
    if (!name) continue
    if (indice.has(name)) throw new OperationError('finanzas-esquema-invalido', { detail: { pestana } })
    indice.set(name, i)
  }
  if (columnas.some((c) => !indice.has(c))) throw new OperationError('finanzas-esquema-invalido', { detail: { pestana } })
  if (rows.length > MAX_DATA_ROWS + 1) throw new OperationError('lectura-fallida', { detail: { motivo: 'limite-filas' } })
  return { header, indice, filas: rows.slice(1) }
}

const valor = (t: Tabla, fila: unknown[], columna: string): unknown => fila[t.indice.get(columna) ?? -1]
const texto = (t: Tabla, fila: unknown[], columna: string): string => celdaTexto(valor(t, fila, columna))

/** Agrupa la AUDITORIA de FINANZAS por solicitud y revisa su integridad (lote, índices, MOV_ID). */
export function auditoriaFinanzas(t: Tabla): Auditada[] {
  const ops = new Map<string, Auditada & { lote: string | null; total: number | null; indices: number[] }>()
  for (const fila of t.filas) {
    const m = ORIGIN.exec(texto(t, fila, 'ORIGEN'))
    if (!m) continue
    const [, operacion, requestId, hash] = m as unknown as [string, string, string, string]
    const id = texto(t, fila, 'REGISTRO_ID')
    const a = AUDIT_ID.exec(texto(t, fila, 'AUDIT_ID'))
    const lote = a?.[1] ?? null
    let op = ops.get(requestId)
    if (!op) {
      op = { requestId, operacion, hash, id, campos: new Map(), integridad: 'completa', lote, total: a ? Number(a[3]) : null, indices: [] }
      ops.set(requestId, op)
    } else if (op.operacion !== operacion || op.hash !== hash || op.id !== id || op.lote !== lote) {
      op.integridad = 'inconsistente'
    }
    if (texto(t, fila, 'ENTIDAD') !== 'MOVIMIENTOS') op.integridad = 'inconsistente'
    if (a) {
      const i = Number(a[2])
      if (op.indices.includes(i)) op.integridad = 'inconsistente'
      op.indices.push(i)
    } else {
      op.integridad = 'inconsistente'
    }
    const campo = texto(t, fila, 'CAMPO')
    const despues = texto(t, fila, 'VALOR_DESPUES')
    if (op.campos.has(campo) && op.campos.get(campo) !== despues) op.integridad = 'inconsistente'
    op.campos.set(campo, despues)
  }
  return [...ops.values()].map(({ lote, total, indices, ...op }) => {
    void lote
    if (op.integridad === 'completa') {
      if (op.campos.has('MOV_ID') && op.campos.get('MOV_ID') !== op.id) op.integridad = 'inconsistente'
      else if (!op.campos.has('MOV_ID') || total === null || indices.length !== total || indices.some((i) => i < 1 || i > total)) op.integridad = 'parcial'
    }
    return op
  })
}

function iguales(guardado: unknown, esperado: Celda): boolean {
  if (typeof esperado === 'number') {
    const n = typeof guardado === 'number' ? guardado : Number(celdaTexto(guardado))
    return celdaTexto(guardado) !== '' && Number.isFinite(n) && Math.abs(n - esperado) < 1e-9
  }
  return celdaTexto(guardado) === esperado
}

export class FinanzasWriteService {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly clock: () => Date
  private readonly randomHex: (bytes: number) => string

  constructor(private readonly store: FinanzasStore, options: FinanzasServiceOptions = {}) {
    this.clock = options.clock ?? (() => new Date())
    this.randomHex = options.randomHex ?? ((n) => randomBytes(n).toString('hex'))
  }

  /** Libro al que escribe este servicio (pruebas cruzadas). */
  get libro(): string {
    return this.store.libro
  }

  /** Serializa las escrituras de finanzas de ESTE proceso (supone una instancia, `maxScale: 1`). */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  crearMovimiento(cmd: MovimientoCommand, ctx: FinanzasContext): Promise<FinanzasResultado> {
    return this.exclusive(async () => {
      const op: FinanzasOperationName = 'finanzas.movimiento.crear'
      const hash = payloadHash(op, cmd)
      const libro = await this.leer()
      const repetida = await this.replay(op, hash, cmd.requestId, libro)
      if (repetida) return repetida

      const hoy = civilDateInZone(this.clock().getTime())
      const fields: Record<string, string> = {}
      if (cmd.fecha > addDays(hoy, 1)) fields.fecha = 'La fecha no puede ser futura.'
      const mesInicio = libro.parametros === undefined ? null : leerParametros(libro.parametros).mesInicio
      if (mesInicio !== null && cmd.fecha.slice(0, 7) < mesInicio) fields.fecha = `No puede ser anterior a MES_INICIO (${mesInicio}).`
      if (Object.keys(fields).length) throw new OperationError('validacion', { fields })
      if (cmd.ajusteDe !== null) this.revisarAjuste(cmd, libro.movimientos)

      const id = this.siguienteMan(libro)
      const registro: Registro = {
        MOV_ID: id,
        FECHA: cmd.fecha,
        PROYECTO: cmd.proyecto,
        TIPO: cmd.tipo,
        CATEGORIA: cmd.categoria,
        CONCEPTO: conceptoFinal(cmd),
        PRODUCTO_ID: cmd.productoId ?? '',
        MONTO_MXN: aNumero(cmd.montoMxnCentavos, 2),
        MONEDA_ORIG: cmd.moneda,
        MONTO_ORIG: cmd.montoOrigCentavos === null ? '' : aNumero(cmd.montoOrigCentavos, 2),
        TIPO_CAMBIO: cmd.tipoCambioDiezmil === null ? '' : aNumero(cmd.tipoCambioDiezmil, 4),
        IVA_MXN: cmd.ivaMxnCentavos === null ? '' : aNumero(cmd.ivaMxnCentavos, 2),
        FUENTE: 'manual',
        COMPROBANTE: cmd.comprobante,
        AJUSTE_DE: cmd.ajusteDe ?? '',
      }
      await this.escribir(op, hash, cmd.requestId, ctx, registro, libro)
      return { operacion: op, id, repetida: false }
    })
  }

  confirmarRecurrente(cmd: ConfirmarCommand, ctx: FinanzasContext): Promise<FinanzasResultado> {
    return this.exclusive(async () => {
      const op: FinanzasOperationName = 'finanzas.recurrente.confirmar'
      const hash = payloadHash(op, cmd)
      const libro = await this.leer()
      const repetida = await this.replay(op, hash, cmd.requestId, libro)
      if (repetida) return repetida

      const lectura = leerRecurrentes(libro.recurrentes)
      if (lectura.estado === 'no-disponible') throw new OperationError('finanzas-esquema-invalido', { detail: { pestana: 'RECURRENTES' } })
      const rec = lectura.recurrentes.find((r) => r.id === cmd.recurrenteId)
      const actual = civilDateInZone(this.clock().getTime()).slice(0, 7)
      if (cmd.mes !== actual && cmd.mes !== sumarMeses(actual, -1)) throw new OperationError('validacion', { fields: { mes: 'Solo el mes actual o el anterior.' } })
      if (!rec || !vigenteEn(rec, cmd.mes)) throw new OperationError('recurrente-inexistente')
      if (rec.moneda === 'USD' && cmd.tipoCambioDiezmil === null) throw new OperationError('validacion', { fields: { tipoCambio: 'Obligatorio en USD.' } })
      if (rec.moneda === 'MXN' && cmd.tipoCambioDiezmil !== null) throw new OperationError('validacion', { fields: { tipoCambio: 'Solo con USD.' } })

      const id = movIdRecurrente(rec.id, cmd.mes)
      // Nunca se duplica: la fila ya escrita, por la vía que sea, gana; una auditada sin fila se completa (§4.3).
      if (libro.movimientos.filas.some((f) => texto(libro.movimientos, f, 'MOV_ID') === id)) throw new OperationError('recurrente-ya-confirmado')
      const previa = auditoriaFinanzas(libro.auditoria).find((o) => o.id === id)
      if (previa) {
        if (previa.integridad !== 'completa') throw new OperationError('auditoria-inconsistente')
        const registro = this.registroAuditado(previa)
        await this.anexar(registro, libro)
        await this.verificar(id, registro)
        return { operacion: op, id, repetida: true }
      }

      const montoMxn = rec.moneda === 'USD' ? convertirCentavos(cmd.montoCentavos, cmd.tipoCambioDiezmil!) : cmd.montoCentavos
      if (montoMxn <= 0) throw new OperationError('validacion', { fields: { monto: 'El monto en MXN redondeado no puede ser 0.' } })
      const registro: Registro = {
        MOV_ID: id,
        FECHA: cmd.fecha,
        PROYECTO: rec.proyecto,
        TIPO: 'Gasto',
        CATEGORIA: rec.categoria,
        CONCEPTO: conceptoFinal({ concepto: rec.concepto, ajusteDe: null }),
        PRODUCTO_ID: '',
        MONTO_MXN: aNumero(montoMxn, 2),
        MONEDA_ORIG: rec.moneda,
        MONTO_ORIG: rec.moneda === 'USD' ? aNumero(cmd.montoCentavos, 2) : '',
        TIPO_CAMBIO: rec.moneda === 'USD' ? aNumero(cmd.tipoCambioDiezmil!, 4) : '',
        IVA_MXN: '',
        FUENTE: 'recurrente',
        COMPROBANTE: cmd.comprobante,
        AJUSTE_DE: '',
      }
      await this.escribir(op, hash, cmd.requestId, ctx, registro, libro)
      return { operacion: op, id, repetida: false }
    })
  }

  /* ------------------------------------ Lectura ------------------------------------ */

  /** Pestañas obligatorias y encabezados antes de nada; sin ellas, 400 y ninguna escritura (§5, paso 1). */
  private async leer(): Promise<Libro> {
    let titulos: string[]
    let datos: Partial<Record<FinanzasWriteTab, unknown[][]>>
    try {
      titulos = await this.store.tabs()
    } catch {
      throw new OperationError('lectura-fallida')
    }
    const falta = PESTANAS_OBLIGATORIAS.find((p) => !titulos.includes(p))
    if (falta) throw new OperationError('finanzas-esquema-invalido', { detail: { pestana: falta } })
    const pedir: FinanzasWriteTab[] = [...PESTANAS_OBLIGATORIAS, ...(titulos.includes('PARAMETROS') ? ['PARAMETROS' as const] : [])]
    try {
      datos = await this.store.read(pedir)
    } catch {
      throw new OperationError('lectura-fallida')
    }
    return {
      movimientos: tabla(datos.MOVIMIENTOS ?? [], COLUMNAS_MOVIMIENTOS_ESCRITURA, 'MOVIMIENTOS'),
      auditoria: tabla(datos.AUDITORIA ?? [], COLUMNAS_AUDITORIA, 'AUDITORIA'),
      recurrentes: datos.RECURRENTES ?? [],
      parametros: datos.PARAMETROS,
    }
  }

  /** `max(NNNN)` de los `MAN-` de MOVIMIENTOS y de la auditoría, más 1 (nunca reutiliza un ID borrado a mano). */
  private siguienteMan(libro: Libro): string {
    let max = 0
    const ver = (id: string) => {
      const m = MAN.exec(id)
      if (m) max = Math.max(max, Number(m[1]))
    }
    for (const f of libro.movimientos.filas) ver(texto(libro.movimientos, f, 'MOV_ID'))
    for (const f of libro.auditoria.filas) ver(texto(libro.auditoria, f, 'REGISTRO_ID'))
    if (max >= MAN_MAX) throw new OperationError('finanzas-ids-agotados')
    return `MAN-${String(max + 1).padStart(4, '0')}`
  }

  /** §3.4: el original existe, no es ajuste, comparte PROYECTO/TIPO/CATEGORIA y no queda por debajo de 0. */
  private revisarAjuste(cmd: MovimientoCommand, t: Tabla) {
    const originales = t.filas.filter((f) => texto(t, f, 'MOV_ID') === cmd.ajusteDe)
    if (originales.length !== 1 || texto(t, originales[0]!, 'AJUSTE_DE') !== '') throw new OperationError('movimiento-inexistente')
    const original = originales[0]!
    const fields: Record<string, string> = {}
    for (const [campo, columna] of [['proyecto', 'PROYECTO'], ['tipo', 'TIPO'], ['categoria', 'CATEGORIA']] as const) {
      if (texto(t, original, columna).toLocaleLowerCase('es') !== cmd[campo].toLocaleLowerCase('es')) fields[campo] = 'Debe ser igual al del movimiento original.'
    }
    if (Object.keys(fields).length) throw new OperationError('validacion', { fields })
    const centavos = (f: unknown[]) => {
      const n = Number(celdaTexto(valor(t, f, 'MONTO_MXN')))
      return Number.isFinite(n) ? Math.round(n * 100) : NaN
    }
    const base = centavos(original)
    if (!Number.isFinite(base) || base <= 0) throw new OperationError('movimiento-inexistente')
    const ajustes = t.filas.filter((f) => texto(t, f, 'AJUSTE_DE') === cmd.ajusteDe).map(centavos)
    if (ajustes.some((n) => !Number.isFinite(n))) throw new OperationError('movimiento-inexistente')
    if (base + ajustes.reduce((s, n) => s + n, 0) + cmd.montoMxnCentavos < 0) throw new OperationError('ajuste-excede-original')
  }

  /* ---------------------------- Idempotencia y escritura ---------------------------- */

  /** Mismo requestId: repetida (fila presente y coincide), roll-forward (sin fila) o conflicto (otro hash). */
  private async replay(op: FinanzasOperationName, hash: string, requestId: string, libro: Libro): Promise<FinanzasResultado | null> {
    const auditada = auditoriaFinanzas(libro.auditoria).find((o) => o.requestId === requestId)
    if (!auditada) return null
    if (auditada.integridad !== 'completa') throw new OperationError('auditoria-inconsistente')
    if (auditada.operacion !== op || auditada.hash !== hash) throw new OperationError('conflicto-idempotencia')
    const registro = this.registroAuditado(auditada)
    const filas = libro.movimientos.filas.filter((f) => texto(libro.movimientos, f, 'MOV_ID') === auditada.id)
    if (filas.length === 0) {
      await this.anexar(registro, libro)
      await this.verificar(auditada.id, registro)
    } else if (filas.length > 1) {
      throw new OperationError('conflicto-concurrente')
    } else if (!Object.entries(registro).every(([c, v]) => iguales(valor(libro.movimientos, filas[0]!, c), v))) {
      throw new OperationError('estado-divergente')
    }
    return { operacion: op, id: auditada.id, repetida: true }
  }

  private registroAuditado(a: Auditada): Registro {
    const registro: Registro = {}
    for (const c of COLUMNAS_MOVIMIENTOS_ESCRITURA) {
      const v = a.campos.get(c) ?? ''
      registro[c] = NUMERICAS.has(c) && v !== '' ? Number(v) : v
    }
    return registro
  }

  private async escribir(op: FinanzasOperationName, hash: string, requestId: string, ctx: FinanzasContext, registro: Registro, libro: Libro) {
    await this.auditar(op, hash, requestId, ctx, registro, libro)
    await this.anexar(registro, libro)
    await this.verificar(String(registro.MOV_ID), registro)
  }

  /** AUDITORIA de FINANZAS primero: si falla, no se escribe la fila (fail-closed). */
  private async auditar(op: FinanzasOperationName, hash: string, requestId: string, ctx: FinanzasContext, registro: Registro, libro: Libro) {
    const now = this.clock()
    const stamp = meridaIsoTimestamp(now)
    const compact = stamp.slice(0, 19).replace(/[-:T]/g, '')
    const lote = this.randomHex(4).toUpperCase()
    const campos = Object.entries(registro).filter(([, v]) => v !== '')
    const total = String(campos.length).padStart(2, '0')
    const origen = `${ORIGIN_PREFIX};op=${op};req=${requestId};hash=${hash}`
    const rows = campos.map(([campo, v], i) => libro.auditoria.header.map((h) => ({
      AUDIT_ID: `AUD-${compact}-${lote}-${String(i + 1).padStart(2, '0')}-${total}`,
      FECHA_HORA: stamp,
      ACTOR: ctx.actor,
      ENTIDAD: 'MOVIMIENTOS',
      REGISTRO_ID: String(registro.MOV_ID),
      CAMPO: campo,
      VALOR_ANTES: '',
      VALOR_DESPUES: String(v),
      ORIGEN: origen,
    } as Record<string, string>)[h] ?? ''))
    try {
      await this.store.append('AUDITORIA', rows)
    } catch {
      throw new OperationError('auditoria-fallida')
    }
  }

  private async anexar(registro: Registro, libro: Libro) {
    try {
      await this.store.append('MOVIMIENTOS', [libro.movimientos.header.map((h) => registro[h] ?? '')])
    } catch {
      throw new OperationError('escritura-fallida')
    }
  }

  /** Relee MOVIMIENTOS: exactamente una fila con el MOV_ID y con lo auditado (§5, paso 5). */
  private async verificar(id: string, registro: Registro) {
    let t: Tabla
    try {
      t = tabla((await this.store.read(['MOVIMIENTOS'])).MOVIMIENTOS ?? [], COLUMNAS_MOVIMIENTOS_ESCRITURA, 'MOVIMIENTOS')
    } catch {
      throw new OperationError('verificacion-fallida')
    }
    const filas = t.filas.filter((f) => texto(t, f, 'MOV_ID') === id)
    if (filas.length > 1) throw new OperationError('conflicto-concurrente')
    if (filas.length !== 1 || !Object.entries(registro).every(([c, v]) => iguales(valor(t, filas[0]!, c), v))) {
      throw new OperationError('verificacion-fallida')
    }
  }
}
