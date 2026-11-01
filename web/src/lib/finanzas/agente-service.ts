import { randomBytes } from 'node:crypto'
import { civilDateInZone, parseCivilDate } from '../dates'
import { OperationError } from '../operations/errors'
import { meridaIsoTimestamp } from '../operations/time'
import { payloadHash } from '../operations/validation'
import { FINANZAS_AGENTE_ACTOR } from './agente-guard'
import {
  fuenteVigente, idCargoExtra, idRendimiento, parseCorte, revisarCorte, TOPE_USD_CENTAVOS,
  type CargoExtraCommand, type Corte, type RendimientoCommand,
} from './agente-validacion'
import { celdaTexto, COLUMNAS_AUDITORIA, COLUMNAS_MOVIMIENTOS_ESCRITURA, iguales, tabla, type FinanzasServiceOptions, type Tabla } from './escritura-service'
import type { Celda, FinanzasStore, FinanzasWriteTab } from './escritura-store'
import { aNumero, convertirCentavos, decimalEscalado } from './escritura-validacion'
import { fechaCobro, leerRecurrentes, MONEDAS, movIdRecurrente, numeroCelda, tipoCambioDefecto, vigenteEn, type Moneda } from './finanzas'

/**
 * Servicio del agente de finanzas (ORD-POS-092, docs/diseno-finanzas-v3.md §3 a §6). Mismo libro FINANZAS que la
 * escritura del propietario, pero otra clase, otra cuenta y otro ORIGEN en la AUDITORIA, con su propio analizador: un
 * cambio en uno no abre ni rompe el otro. Orden de cada alta: pestañas y encabezados → idempotencia por requestId →
 * corte y regla de §5 → AUDITORIA → fila → verificación. Solo altas: ni edición ni borrado.
 */

export const FINANZAS_AGENTE_OPERATIONS = ['finanzas.agente.rendimiento', 'finanzas.agente.cargo-extra'] as const
export type FinanzasAgenteOperationName = (typeof FINANZAS_AGENTE_OPERATIONS)[number]

/** RENDIMIENTO_CLAUDE (§4.2): no es dinero, ninguna suma de gasto ni de capital la lee. */
export const COLUMNAS_RENDIMIENTO = [
  'REND_ID', 'CORTE_INICIO', 'CORTE_FIN', 'COSTO_EQUIV_USD', 'SESIONES', 'SESIONES_SIN_DATO', 'TOKENS_ENTRADA',
  'TOKENS_SALIDA', 'REPORTE', 'FECHA_REGISTRO',
] as const

export const FUENTE_AGENTE = 'agente-finanzas'
/** Valor del cierre «sin cargo» de un corte en la AUDITORIA (§6). */
export const SIN_CARGO = 'sin-cargo'

const NUMERICAS = new Set(['MONTO_MXN', 'MONTO_ORIG', 'TIPO_CAMBIO', 'IVA_MXN', 'COSTO_EQUIV_USD', 'SESIONES', 'SESIONES_SIN_DATO', 'TOKENS_ENTRADA', 'TOKENS_SALIDA'])
const ORIGIN_PREFIX = `${FINANZAS_AGENTE_ACTOR};modo=sheets`
/**
 * Analizador propio del ORIGEN del agente; `fuente` va codificada y nunca trae `;` ni `=` (criterio 4). `moneda=` va solo
 * en el cargo extra (ORD-POS-133): la del total de factura.
 */
const ORIGIN = /^agente-finanzas;modo=sheets;req=([0-9a-f-]{36});hash=([0-9a-f]{16});reporte=(session_[A-Za-z0-9]{10,40})(?:;moneda=(USD|MXN))?;fuente=([^;=]*)$/
const AUDIT_ID = /^(AUD-\d{14}-[0-9A-F]+)-(\d{2})-(\d{2})$/

type Entidad = 'MOVIMIENTOS' | 'RENDIMIENTO_CLAUDE'
type Registro = Record<string, Celda>

export interface FinanzasAgenteResultado {
  operacion: FinanzasAgenteOperationName
  id: string
  repetida: boolean
  /** Solo en cargo-extra: el corte se cerró sin fila en MOVIMIENTOS (extra = 0). */
  sinCargo?: boolean
}

interface Destino {
  entidad: Entidad
  columnas: readonly string[]
  idCol: 'MOV_ID' | 'REND_ID'
}
const A_MOVIMIENTOS: Destino = { entidad: 'MOVIMIENTOS', columnas: COLUMNAS_MOVIMIENTOS_ESCRITURA, idCol: 'MOV_ID' }
const A_RENDIMIENTO: Destino = { entidad: 'RENDIMIENTO_CLAUDE', columnas: COLUMNAS_RENDIMIENTO, idCol: 'REND_ID' }

interface Libro {
  auditoria: Tabla
  movimientos?: Tabla
  rendimiento?: Tabla
  recurrentes?: unknown[][]
  parametros?: unknown[][]
}

export interface AuditadaAgente {
  requestId: string
  hash: string
  reporte: string
  /** Moneda del total en el cargo extra; null en el rendimiento. */
  moneda: Moneda | null
  fuente: string
  entidad: string
  id: string
  campos: Map<string, string>
  sinCargo: boolean
  integridad: 'completa' | 'parcial' | 'inconsistente'
}

/** `%`, `;` y `=` codificados: la fuente no puede cerrar su campo ni fingir un `req=` o un `hash=`. */
export function codificarFuente(fuente: string): string {
  return fuente.replace(/%/g, '%25').replace(/;/g, '%3B').replace(/=/g, '%3D')
}

export function origenAgente(requestId: string, hash: string, reporte: string, fuente: string, moneda: Moneda | null = null): string {
  return `${ORIGIN_PREFIX};req=${requestId};hash=${hash};reporte=${reporte}${moneda ? `;moneda=${moneda}` : ''};fuente=${codificarFuente(fuente)}`
}

export function leerOrigenAgente(origen: string): { requestId: string; hash: string; reporte: string; moneda: Moneda | null; fuente: string } | null {
  const m = ORIGIN.exec(origen)
  if (!m) return null
  try {
    return { requestId: m[1]!, hash: m[2]!, reporte: m[3]!, moneda: (m[4] as Moneda | undefined) ?? null, fuente: decodeURIComponent(m[5]!) }
  } catch {
    return null
  }
}

const valor = (t: Tabla, fila: unknown[], columna: string): unknown => fila[t.indice.get(columna) ?? -1]
const texto = (t: Tabla, fila: unknown[], columna: string): string => celdaTexto(valor(t, fila, columna))

/** Agrupa las filas del agente en la AUDITORIA de FINANZAS por solicitud y revisa su integridad. */
export function auditoriaAgente(t: Tabla): AuditadaAgente[] {
  const ops = new Map<string, AuditadaAgente & { lote: string | null; total: number | null; indices: number[] }>()
  for (const fila of t.filas) {
    const o = leerOrigenAgente(texto(t, fila, 'ORIGEN'))
    if (!o) continue
    const entidad = texto(t, fila, 'ENTIDAD')
    const id = texto(t, fila, 'REGISTRO_ID')
    const a = AUDIT_ID.exec(texto(t, fila, 'AUDIT_ID'))
    const lote = a?.[1] ?? null
    let op = ops.get(o.requestId)
    if (!op) {
      op = { ...o, entidad, id, campos: new Map(), sinCargo: false, integridad: 'completa', lote, total: a ? Number(a[3]) : null, indices: [] }
      ops.set(o.requestId, op)
    } else if (op.hash !== o.hash || op.reporte !== o.reporte || op.moneda !== o.moneda || op.fuente !== o.fuente || op.entidad !== entidad || op.id !== id || op.lote !== lote) {
      op.integridad = 'inconsistente'
    }
    if ((entidad !== 'MOVIMIENTOS' && entidad !== 'RENDIMIENTO_CLAUDE') || texto(t, fila, 'ACTOR') !== FINANZAS_AGENTE_ACTOR) op.integridad = 'inconsistente'
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
    const idCol = op.entidad === 'RENDIMIENTO_CLAUDE' ? 'REND_ID' : 'MOV_ID'
    // Cierre «sin cargo»: una sola fila ESTADO = sin-cargo sobre un CLAUDE-EXTRA-… (§6).
    op.sinCargo = op.entidad === 'MOVIMIENTOS' && op.campos.size === 1 && op.campos.get('ESTADO') === SIN_CARGO
    if (op.integridad === 'completa') {
      if (op.campos.has(idCol) && op.campos.get(idCol) !== op.id) op.integridad = 'inconsistente'
      else if (op.campos.has('ESTADO') && !op.sinCargo) op.integridad = 'inconsistente'
      else if ((!op.sinCargo && !op.campos.has(idCol)) || total === null || indices.length !== total || indices.some((i) => i < 1 || i > total)) op.integridad = 'parcial'
    }
    return op
  })
}

export class FinanzasAgenteService {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly clock: () => Date
  private readonly randomHex: (bytes: number) => string

  constructor(private readonly store: FinanzasStore, options: FinanzasServiceOptions = {}) {
    this.clock = options.clock ?? (() => new Date())
    this.randomHex = options.randomHex ?? ((n) => randomBytes(n).toString('hex'))
  }

  get libro(): string {
    return this.store.libro
  }

  /** Serializa las altas del agente en ESTE proceso (supone una instancia, `maxScale: 1`). */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  private hoy(): string {
    return civilDateInZone(this.clock().getTime())
  }

  registrarRendimiento(cmd: RendimientoCommand): Promise<FinanzasAgenteResultado> {
    return this.exclusive(async () => {
      const op: FinanzasAgenteOperationName = 'finanzas.agente.rendimiento'
      const hash = payloadHash(op, cmd)
      const libro = await this.leer(['RENDIMIENTO_CLAUDE', 'AUDITORIA'])
      const repetida = await this.replay(op, hash, cmd.requestId, libro, A_RENDIMIENTO)
      if (repetida) return repetida

      const hoy = this.hoy()
      const corte = parseCorte(cmd.corte)!
      revisarCorte(corte, hoy)
      const id = idRendimiento(corte.id)
      this.revisarNoRegistrado(id, libro, A_RENDIMIENTO)
      const registro: Registro = {
        REND_ID: id,
        CORTE_INICIO: corte.inicio,
        CORTE_FIN: corte.fin,
        COSTO_EQUIV_USD: aNumero(cmd.costoEquivCentavos, 2),
        SESIONES: cmd.sesiones,
        SESIONES_SIN_DATO: cmd.sesionesSinDato,
        TOKENS_ENTRADA: cmd.tokensEntrada ?? '',
        TOKENS_SALIDA: cmd.tokensSalida ?? '',
        REPORTE: cmd.reporte,
        FECHA_REGISTRO: hoy,
      }
      await this.auditar(hash, cmd.requestId, cmd.reporte, 'reporte-consumo', A_RENDIMIENTO.entidad, id, registro, libro)
      await this.anexar(registro, libro, A_RENDIMIENTO)
      await this.verificar(id, registro, A_RENDIMIENTO)
      return { operacion: op, id, repetida: false }
    })
  }

  registrarCargoExtra(cmd: CargoExtraCommand): Promise<FinanzasAgenteResultado> {
    return this.exclusive(async () => {
      const op: FinanzasAgenteOperationName = 'finanzas.agente.cargo-extra'
      const hash = payloadHash(op, cmd)
      const libro = await this.leer(['MOVIMIENTOS', 'RECURRENTES', 'AUDITORIA'])
      const repetida = await this.replay(op, hash, cmd.requestId, libro, A_MOVIMIENTOS)
      if (repetida) return repetida

      const hoy = this.hoy()
      const corte = parseCorte(cmd.corte)!
      revisarCorte(corte, hoy)
      if (!fuenteVigente(cmd.fuenteFecha, hoy)) throw new OperationError('validacion', { fields: { fuente: 'La fecha de la fuente debe ser la de hoy, con 1 día de margen.' } })
      const id = idCargoExtra(corte.id)
      this.revisarNoRegistrado(id, libro, A_MOVIMIENTOS)

      // §5: cargo extra = T − S en la moneda de REC-CLAUDE del mes (ORD-POS-133), con S anclada a su FECHA. T y S
      // nunca se convierten para restarlos: otra moneda es 409 sin escribir.
      const s = this.suscripcionDelCorte(corte, libro)
      if (s.moneda !== null && s.moneda !== cmd.moneda) throw new OperationError('factura-no-cuadra', { detail: { motivo: 'moneda-distinta' } })
      const extra = cmd.facturaTotalCentavos - s.centavos
      if (extra < 0) throw new OperationError('factura-no-cuadra')
      if (cmd.moneda === 'USD' && extra > TOPE_USD_CENTAVOS) throw new OperationError('monto-excede-tope')
      if (extra === 0) {
        await this.auditar(hash, cmd.requestId, cmd.reporte, cmd.fuente, 'MOVIMIENTOS', id, { ESTADO: SIN_CARGO }, libro, cmd.moneda)
        await this.verificarSinCargo(cmd.requestId, id)
        return { operacion: op, id, repetida: false, sinCargo: true }
      }
      if (cmd.moneda === 'MXN') return this.cargoMxn(cmd, corte, id, extra, hash, libro)

      const tc = cmd.tipoCambioDiezmil ?? decimalEscalado(tipoCambioDefecto(libro.parametros), 4)
      if (tc === null) throw new OperationError('validacion', { fields: { tipoCambio: 'Sin TIPO_CAMBIO_DEFECTO en PARAMETROS: hace falta el tipo de cambio.' } })
      const montoMxn = convertirCentavos(extra, tc)
      if (montoMxn <= 0) throw new OperationError('validacion', { fields: { tipoCambio: 'El monto en MXN redondeado no puede ser 0.' } })
      const registro: Registro = { ...this.registroCargo(cmd, corte, id), MONTO_MXN: aNumero(montoMxn, 2), MONEDA_ORIG: 'USD', MONTO_ORIG: aNumero(extra, 2), TIPO_CAMBIO: aNumero(tc, 4) }
      await this.auditar(hash, cmd.requestId, cmd.reporte, cmd.fuente, A_MOVIMIENTOS.entidad, id, registro, libro, cmd.moneda)
      await this.anexar(registro, libro, A_MOVIMIENTOS)
      await this.verificar(id, registro, A_MOVIMIENTOS)
      return { operacion: op, id, repetida: false, sinCargo: false }
    })
  }

  /**
   * Cargo extra en MXN (ORD-POS-133): MONTO_ORIG = MONTO_MXN = extra, sin TIPO_CAMBIO. El tope sigue en USD: se compara
   * extra ÷ TIPO_CAMBIO_DEFECTO de PARAMETROS; sin él, 409 sin escribir (no se adivina el tipo de cambio).
   */
  private async cargoMxn(cmd: CargoExtraCommand, corte: Corte, id: string, extra: number, hash: string, libro: Libro): Promise<FinanzasAgenteResultado> {
    const tc = decimalEscalado(tipoCambioDefecto(libro.parametros), 4)
    if (tc === null || tc <= 0) throw new OperationError('tipo-cambio-sin-dato')
    // extra (centavos MXN) ÷ (tc / 10⁴) > tope (centavos USD), en enteros: sin redondeo en el límite.
    if (extra * 10_000 > TOPE_USD_CENTAVOS * tc) throw new OperationError('monto-excede-tope')
    const registro = { ...this.registroCargo(cmd, corte, id), MONTO_MXN: aNumero(extra, 2), MONEDA_ORIG: 'MXN', MONTO_ORIG: aNumero(extra, 2), TIPO_CAMBIO: '' }
    await this.auditar(hash, cmd.requestId, cmd.reporte, cmd.fuente, A_MOVIMIENTOS.entidad, id, registro, libro, cmd.moneda)
    await this.anexar(registro, libro, A_MOVIMIENTOS)
    await this.verificar(id, registro, A_MOVIMIENTOS)
    return { operacion: 'finanzas.agente.cargo-extra', id, repetida: false, sinCargo: false }
  }

  /** Columnas del cargo extra que no dependen de la moneda (§4.3). */
  private registroCargo(cmd: CargoExtraCommand, corte: Corte, id: string): Registro {
    return {
      MOV_ID: id,
      FECHA: corte.fin,
      PROYECTO: cmd.proyecto,
      TIPO: 'Gasto',
      CATEGORIA: 'Herramientas',
      CONCEPTO: `Claude: cargo adicional ${corte.id}`,
      PRODUCTO_ID: '',
      IVA_MXN: '',
      FUENTE: FUENTE_AGENTE,
      COMPROBANTE: 'sí',
      AJUSTE_DE: '',
    }
  }

  /* ------------------------------------ Lectura ------------------------------------ */

  /** Pestañas obligatorias de la operación y encabezados antes de nada; PARAMETROS es opcional. */
  private async leer(obligatorias: FinanzasWriteTab[]): Promise<Libro> {
    let titulos: string[]
    let datos: Partial<Record<FinanzasWriteTab, unknown[][]>>
    try {
      titulos = await this.store.tabs()
    } catch {
      throw new OperationError('lectura-fallida')
    }
    const falta = obligatorias.find((p) => !titulos.includes(p))
    if (falta) throw new OperationError('finanzas-esquema-invalido', { detail: { pestana: falta } })
    const pedir: FinanzasWriteTab[] = [...obligatorias, ...(obligatorias.includes('MOVIMIENTOS') && titulos.includes('PARAMETROS') ? ['PARAMETROS' as const] : [])]
    try {
      datos = await this.store.read(pedir)
    } catch {
      throw new OperationError('lectura-fallida')
    }
    return {
      auditoria: tabla(datos.AUDITORIA ?? [], COLUMNAS_AUDITORIA, 'AUDITORIA'),
      movimientos: obligatorias.includes('MOVIMIENTOS') ? tabla(datos.MOVIMIENTOS ?? [], COLUMNAS_MOVIMIENTOS_ESCRITURA, 'MOVIMIENTOS') : undefined,
      rendimiento: obligatorias.includes('RENDIMIENTO_CLAUDE') ? tabla(datos.RENDIMIENTO_CLAUDE ?? [], COLUMNAS_RENDIMIENTO, 'RENDIMIENTO_CLAUDE') : undefined,
      recurrentes: datos.RECURRENTES,
      parametros: datos.PARAMETROS,
    }
  }

  private destinoDe(libro: Libro, d: Destino): Tabla {
    return (d.entidad === 'MOVIMIENTOS' ? libro.movimientos : libro.rendimiento)!
  }

  /**
   * `S` de §5 y su moneda, con una sola ancla: si existe `REC-CLAUDE-AAAA-MM`, su FECHA decide en qué corte cae y su
   * MONEDA_ORIG es la del corte (ORD-POS-133): en USD, `S` = MONTO_ORIG; en MXN, `S` = MONTO_MXN (la confirmación en MXN
   * deja MONTO_ORIG vacío). `DIA_COBRO` de RECURRENTES solo cuenta si ese REC todavía no existe, y entonces no se resta un
   * monto esperado: 409 `suscripcion-sin-confirmar`; sin REC, la moneda es la del recurrente `CLAUDE` vigente, si lo hay.
   */
  private suscripcionDelCorte(corte: Corte, libro: Libro): { centavos: number; moneda: Moneda | null } {
    const t = libro.movimientos!
    const recId = movIdRecurrente('CLAUDE', corte.mes)
    const recs = t.filas.filter((f) => texto(t, f, 'MOV_ID') === recId)
    if (recs.length > 1) throw new OperationError('factura-no-cuadra', { detail: { motivo: 'suscripcion-duplicada' } })
    if (recs.length === 1) {
      const fecha = parseCivilDate(texto(t, recs[0]!, 'FECHA')).value
      const moneda = MONEDAS.find((m) => m === texto(t, recs[0]!, 'MONEDA_ORIG').toUpperCase()) ?? null
      const monto = moneda === null ? null : numeroCelda(valor(t, recs[0]!, moneda === 'USD' ? 'MONTO_ORIG' : 'MONTO_MXN'))
      if (fecha === null || moneda === null || monto === null || monto <= 0) {
        throw new OperationError('factura-no-cuadra', { detail: { motivo: 'suscripcion-sin-monto' } })
      }
      return { centavos: fecha >= corte.inicio && fecha <= corte.fin ? Math.round(monto * 100) : 0, moneda }
    }
    const lectura = leerRecurrentes(libro.recurrentes)
    if (lectura.estado === 'no-disponible') throw new OperationError('finanzas-esquema-invalido', { detail: { pestana: 'RECURRENTES' } })
    // Un CLAUDE con problema no se puede descartar: podría caer en el corte.
    if (lectura.problemas.some((p) => p.ref.startsWith('CLAUDE '))) throw new OperationError('suscripcion-sin-confirmar')
    const rec = lectura.recurrentes.find((r) => r.id === 'CLAUDE')
    if (rec && vigenteEn(rec, corte.mes)) {
      const cobro = fechaCobro(rec.diaCobro, corte.mes)
      if (cobro >= corte.inicio && cobro <= corte.fin) throw new OperationError('suscripcion-sin-confirmar')
      return { centavos: 0, moneda: rec.moneda }
    }
    return { centavos: 0, moneda: null }
  }

  /** Otro requestId para el mismo corte: la fila, o cualquier auditoría con ese ID (incluido «sin cargo»), ya existe. */
  private revisarNoRegistrado(id: string, libro: Libro, d: Destino) {
    const t = this.destinoDe(libro, d)
    if (t.filas.some((f) => texto(t, f, d.idCol) === id) || libro.auditoria.filas.some((f) => texto(libro.auditoria, f, 'REGISTRO_ID') === id)) {
      throw new OperationError('corte-ya-registrado')
    }
  }

  /* ---------------------------- Idempotencia y escritura ---------------------------- */

  /**
   * Mismo requestId: repetida (fila presente y coincide), roll-forward (sin fila) o conflicto (otro hash o destino).
   * El cierre «sin cargo» vive solo en la AUDITORIA: su repetición es `repetida` sin roll-forward.
   */
  private async replay(op: FinanzasAgenteOperationName, hash: string, requestId: string, libro: Libro, d: Destino): Promise<FinanzasAgenteResultado | null> {
    const a = auditoriaAgente(libro.auditoria).find((o) => o.requestId === requestId)
    if (!a) return null
    if (a.integridad !== 'completa') throw new OperationError('auditoria-inconsistente')
    if (a.hash !== hash || a.entidad !== d.entidad) throw new OperationError('conflicto-idempotencia')
    if (a.sinCargo) return { operacion: op, id: a.id, repetida: true, sinCargo: true }
    const registro = this.registroAuditado(a, d)
    const t = this.destinoDe(libro, d)
    const filas = t.filas.filter((f) => texto(t, f, d.idCol) === a.id)
    if (filas.length === 0) {
      await this.anexar(registro, libro, d)
      await this.verificar(a.id, registro, d)
    } else if (filas.length > 1) {
      throw new OperationError('conflicto-concurrente')
    } else if (!Object.entries(registro).every(([c, v]) => iguales(valor(t, filas[0]!, c), v))) {
      throw new OperationError('estado-divergente')
    }
    return { operacion: op, id: a.id, repetida: true, ...(d.entidad === 'MOVIMIENTOS' ? { sinCargo: false } : {}) }
  }

  private registroAuditado(a: AuditadaAgente, d: Destino): Registro {
    const registro: Registro = {}
    for (const c of d.columnas) {
      const v = a.campos.get(c) ?? ''
      registro[c] = NUMERICAS.has(c) && v !== '' ? Number(v) : v
    }
    return registro
  }

  /** AUDITORIA de FINANZAS primero, una fila por campo no vacío: si falla, no se escribe la fila (fail-closed). */
  private async auditar(hash: string, requestId: string, reporte: string, fuente: string, entidad: Entidad, id: string, registro: Registro, libro: Libro, moneda: Moneda | null = null) {
    const now = this.clock()
    const stamp = meridaIsoTimestamp(now)
    const compact = stamp.slice(0, 19).replace(/[-:T]/g, '')
    const lote = this.randomHex(4).toUpperCase()
    const campos = Object.entries(registro).filter(([, v]) => v !== '')
    const total = String(campos.length).padStart(2, '0')
    const origen = origenAgente(requestId, hash, reporte, fuente, moneda)
    const rows = campos.map(([campo, v], i) => libro.auditoria.header.map((h) => ({
      AUDIT_ID: `AUD-${compact}-${lote}-${String(i + 1).padStart(2, '0')}-${total}`,
      FECHA_HORA: stamp,
      ACTOR: FINANZAS_AGENTE_ACTOR,
      ENTIDAD: entidad,
      REGISTRO_ID: id,
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

  private async anexar(registro: Registro, libro: Libro, d: Destino) {
    try {
      await this.store.append(d.entidad, [this.destinoDe(libro, d).header.map((h) => registro[h] ?? '')])
    } catch {
      throw new OperationError('escritura-fallida')
    }
  }

  /** Relee la pestaña destino: exactamente una fila con el ID y con lo auditado. */
  private async verificar(id: string, registro: Registro, d: Destino) {
    let t: Tabla
    try {
      t = tabla((await this.store.read([d.entidad]))[d.entidad] ?? [], d.columnas, d.entidad)
    } catch {
      throw new OperationError('verificacion-fallida')
    }
    const filas = t.filas.filter((f) => texto(t, f, d.idCol) === id)
    if (filas.length > 1) throw new OperationError('conflicto-concurrente')
    if (filas.length !== 1 || !Object.entries(registro).every(([c, v]) => iguales(valor(t, filas[0]!, c), v))) {
      throw new OperationError('verificacion-fallida')
    }
  }

  /** El «sin cargo» no tiene fila: se verifica releyendo la AUDITORIA, nunca MOVIMIENTOS (criterio 3). */
  private async verificarSinCargo(requestId: string, id: string) {
    let t: Tabla
    try {
      t = tabla((await this.store.read(['AUDITORIA'])).AUDITORIA ?? [], COLUMNAS_AUDITORIA, 'AUDITORIA')
    } catch {
      throw new OperationError('verificacion-fallida')
    }
    const a = auditoriaAgente(t).find((o) => o.requestId === requestId)
    if (!a || a.integridad !== 'completa' || !a.sinCargo || a.id !== id) throw new OperationError('verificacion-fallida')
  }
}
