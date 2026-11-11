import { randomBytes } from 'node:crypto'
import { addDays, civilDateInZone, parseCivilDate } from '../dates'
import { MAX_DATA_ROWS } from '../schema'
import { OperationError } from '../operations/errors'
import { meridaIsoTimestamp } from '../operations/time'
import { safeCellText } from '../operations/sanitize'
import { derivedRequestId, payloadHash } from '../operations/validation'
import { COLUMNAS_COTIZACIONES, COLUMNAS_EMBARQUES, COLUMNAS_PRODUCTOS, COLUMNAS_PROVEEDORES, ETAPAS, nombreClave, type Etapa } from './pipeline'
import {
  COLUMNAS_BANDEJA, COLUMNAS_BANDEJA_ESCRIBIBLES, ESTADOS_BANDEJA, TIPOS_BANDEJA, celdaConContacto, esFormula, notasRechazo, RESULTADO,
} from './pipeline-bandeja-gemini'
import { ECO_BANDEJA_TAB, ECO_WRITE_TABS, type Celda, type EcoPipelineStore, type EcoStoreTab, type EcoWriteTab } from './pipeline-escritura-store'
import { COLUMNAS_NUMERICAS, COLUMNAS_OPCIONALES, idValido, type BandejaConfirmar, type EcoComando, type MoverComando } from './pipeline-escritura-validacion'
import { requiereMotivo, transicionPermitida } from './pipeline-transiciones'

/**
 * Servicio de escritura del pipeline de /eco (ORD-POS-102, docs/diseno-eco-pipeline.md §4 a §6). No es la API de
 * operaciones ni la de finanzas: su almacén está ligado solo al libro de RADAROS y su auditoría vive en PIPE_AUDITORIA
 * de ese libro. Orden de cada escritura (§6.1): pestañas y encabezados → idempotencia por requestId → validación contra
 * la hoja → AUDITORÍA → entidad (fila nueva o celdas guardadas por ID y VERSION) → verificación. Sin borrado.
 */

/** Operaciones del pipeline. Tipo propio: nunca forman parte de `OperationName` ni de `AGENT_OPERATIONS`. */
export const ECO_OPERATIONS = [
  'eco.producto.crear', 'eco.producto.editar', 'eco.producto.mover', 'eco.proveedor.crear', 'eco.proveedor.editar',
  'eco.cotizacion.crear', 'eco.cotizacion.editar', 'eco.cotizacion.pedir', 'eco.embarque.crear', 'eco.embarque.editar',
  // ORD-POS-155 (§18.3): bandeja de Gemini; en PIPE_BANDEJA_GEMINI solo escriben ESTADO_BANDEJA, RESULTADO_ID y NOTAS.
  'eco.bandeja.confirmar', 'eco.bandeja.rechazar',
] as const
export type EcoOperationName = (typeof ECO_OPERATIONS)[number]

export type Entidad = 'producto' | 'proveedor' | 'cotizacion' | 'embarque'

/**
 * §3: pestaña, columna de ID, prefijo y columnas que exige la escritura (todas las del diseño). `opcionales` son las de
 * las migraciones (§14.1 y §15.1, ORD-POS-146): no se exigen, y escribirlas sin que existan es 409
 * `eco-migracion-pendiente`.
 */
export const ENTIDADES: Record<Entidad, { tab: EcoWriteTab; idCol: string; prefijo: string; columnas: readonly string[]; opcionales: readonly string[] }> = {
  producto: { tab: 'PIPE_PRODUCTOS', idCol: 'PRODUCTO_ID', prefijo: 'PRD', columnas: COLUMNAS_PRODUCTOS, opcionales: [] },
  proveedor: { tab: 'PIPE_PROVEEDORES', idCol: 'PROVEEDOR_ID', prefijo: 'PRV', columnas: COLUMNAS_PROVEEDORES, opcionales: COLUMNAS_OPCIONALES.PIPE_PROVEEDORES },
  cotizacion: { tab: 'PIPE_COTIZACIONES', idCol: 'COTIZACION_ID', prefijo: 'COT', columnas: COLUMNAS_COTIZACIONES, opcionales: COLUMNAS_OPCIONALES.PIPE_COTIZACIONES },
  embarque: { tab: 'PIPE_EMBARQUES', idCol: 'EMBARQUE_ID', prefijo: 'EMB', columnas: COLUMNAS_EMBARQUES, opcionales: [] },
}

/** ORD-POS-146: una columna que la operación quiere escribir y que la fila 1 no tiene (migración pendiente). */
function conMigracion(libro: Libro, e: Entidad, valores: Registro) {
  const { tab } = ENTIDADES[e]
  // Un campo vacío no escribe nada: solo cuentan las columnas con valor.
  const faltan = Object.entries(valores).filter(([c, v]) => v !== '' && !libro[tab].indice.has(c)).map(([c]) => c)
  if (faltan.length) throw new OperationError('eco-migracion-pendiente', { detail: { pestana: tab, columnas: faltan.join(',') } })
}

/** Las mismas columnas que la AUDITORIA de PROJECT-OS (§3.5). */
export const COLUMNAS_AUDITORIA = ['AUDIT_ID', 'FECHA_HORA', 'ACTOR', 'ENTIDAD', 'REGISTRO_ID', 'CAMPO', 'VALOR_ANTES', 'VALOR_DESPUES', 'ORIGEN'] as const

const ORIGIN_PREFIX = 'dashboard-eco;modo=sheets'
const ORIGIN = /^dashboard-eco;modo=sheets;req=([0-9a-f-]{36});hash=([0-9a-f]{16})$/
const AUDIT_ID = /^(AUD-\d{14}-[0-9A-F]+)-(\d{2})-(\d{2})$/
/** Fila de auditoría del motivo de un movimiento que no es descarte (no es columna de PIPE_PRODUCTOS). */
const CAMPO_MOTIVO = 'MOTIVO'

export interface EcoContext {
  /** Correo del único escritor del pipeline (solo se escribe en PIPE_AUDITORIA de RADAROS; nunca en logs). */
  actor: string
}

export interface EcoResultado {
  operacion: EcoOperationName
  id: string
  version: number
  repetida: boolean
  /** ORD-POS-104 (H2): una PIPE_* pasa del 80 % de MAX_DATA_ROWS; el tablero lo muestra al escritor. */
  aviso?: string
}

export interface EcoServiceOptions {
  clock?: () => Date
  randomHex?: (bytes: number) => string
}

type Registro = Record<string, Celda>
/** Comprobación extra dentro de `exclusive`, tras el replay y antes de auditar (la bandeja: fila aún PENDIENTE). */
type Guarda = () => Promise<void>

interface Tabla {
  header: string[]
  indice: Map<string, number>
  filas: unknown[][]
}

type Libro = Record<EcoWriteTab, Tabla>

/** Fila de una entidad releída: la tabla de esa relectura y el número de fila (1 = encabezado). */
interface Destino {
  t: Tabla
  n: number
}

interface Cambio {
  entidad: Entidad
  id: string
  /** Solo las columnas que cambian (en un alta, la fila entera). En un alta, `antes` está vacío. */
  antes: Registro
  despues: Registro
  /** Filas de auditoría que no son columnas de la entidad (el motivo de un movimiento). */
  extra: Array<[campo: string, despues: string]>
}

interface Auditada {
  requestId: string
  hash: string
  entidad: string
  id: string
  campos: Map<string, { antes: string; despues: string }>
  integridad: 'completa' | 'parcial' | 'inconsistente'
}

/** Texto de una celda leída con UNFORMATTED_VALUE. */
function celdaTexto(v: unknown): string {
  if (v === null || v === undefined) return ''
  return typeof v === 'string' ? v.trim() : String(v)
}

function iguales(guardado: unknown, esperado: Celda): boolean {
  if (typeof esperado === 'number') {
    const n = typeof guardado === 'number' ? guardado : Number(celdaTexto(guardado))
    return celdaTexto(guardado) !== '' && Number.isFinite(n) && Math.abs(n - esperado) < 1e-9
  }
  return celdaTexto(guardado) === esperado
}

/**
 * Encabezados por nombre (fila 1): las columnas que el propietario agregue al final se aceptan y nunca se escriben. Una
 * requerida que falta o un encabezado repetido es 400 `eco-esquema-invalido` y el detalle los nombra (ORD-POS-155,
 * criterio 5).
 */
function tabla(rows: unknown[][], columnas: readonly string[], pestana: string): Tabla {
  const header = (rows[0] ?? []).map(celdaTexto)
  const indice = new Map<string, number>()
  for (const [i, name] of header.entries()) {
    if (!name) continue
    if (indice.has(name)) throw new OperationError('eco-esquema-invalido', { detail: { pestana, repetida: name.slice(0, 60) } })
    indice.set(name, i)
  }
  const faltan = columnas.filter((c) => !indice.has(c))
  if (faltan.length) throw new OperationError('eco-esquema-invalido', { detail: { pestana, columnas: faltan.join(',') } })
  if (rows.length > MAX_DATA_ROWS + 1) throw llena(pestana)
  return { header, indice, filas: rows.slice(1) }
}

/** ORD-POS-104 (H2): al 100 % de MAX_DATA_ROWS se falla cerrado nombrando la pestaña; se archiva a mano (§7.2). */
const llena = (pestana: string) => new OperationError('eco-pestana-llena', { detail: { pestana, limite: MAX_DATA_ROWS } })

/** ORD-POS-109 (H2): el tope se mira tras replay(); un reintento ya aplicado responde «repetida» aun en el tope. */
function conCupo(libro: Libro) {
  const tope = ECO_WRITE_TABS.find((tab) => libro[tab].filas.length >= MAX_DATA_ROWS)
  if (tope) throw llena(tope)
}

/** Al 80 % o más de MAX_DATA_ROWS, la respuesta ok lleva el aviso (casi siempre por PIPE_AUDITORIA). */
function conAviso(libro: Libro, r: EcoResultado): EcoResultado {
  const casi = ECO_WRITE_TABS.filter((tab) => libro[tab].filas.length >= MAX_DATA_ROWS * 0.8)
  if (!casi.length) return r
  return { ...r, aviso: `${casi.join(', ')} pasa del 80 % del límite de ${MAX_DATA_ROWS} filas: archívala (diseño /eco pipeline §7.2) antes de que se bloquee la escritura.` }
}

const valor = (t: Tabla, fila: unknown[], columna: string): unknown => fila[t.indice.get(columna) ?? -1]
const texto = (t: Tabla, fila: unknown[], columna: string): string => celdaTexto(valor(t, fila, columna))

function columnasDe(tab: EcoStoreTab): readonly string[] {
  if (tab === 'PIPE_AUDITORIA') return COLUMNAS_AUDITORIA
  if (tab === ECO_BANDEJA_TAB) return COLUMNAS_BANDEJA
  return Object.values(ENTIDADES).find((e) => e.tab === tab)!.columnas
}

/** Agrupa PIPE_AUDITORIA por solicitud y revisa su integridad (lote, índices, una sola entidad y un solo ID). */
function auditoriaEco(t: Tabla): Auditada[] {
  const ops = new Map<string, Auditada & { lote: string | null; total: number | null; indices: number[] }>()
  for (const fila of t.filas) {
    const m = ORIGIN.exec(texto(t, fila, 'ORIGEN'))
    if (!m) continue
    const [, requestId, hash] = m as unknown as [string, string, string]
    const entidad = texto(t, fila, 'ENTIDAD')
    const id = texto(t, fila, 'REGISTRO_ID')
    const a = AUDIT_ID.exec(texto(t, fila, 'AUDIT_ID'))
    const lote = a?.[1] ?? null
    let op = ops.get(requestId)
    if (!op) {
      op = { requestId, hash, entidad, id, campos: new Map(), integridad: 'completa', lote, total: a ? Number(a[3]) : null, indices: [] }
      ops.set(requestId, op)
    } else if (op.hash !== hash || op.id !== id || op.entidad !== entidad || op.lote !== lote) {
      op.integridad = 'inconsistente'
    }
    if (a) {
      const i = Number(a[2])
      if (op.indices.includes(i)) op.integridad = 'inconsistente'
      op.indices.push(i)
    } else {
      op.integridad = 'inconsistente'
    }
    const campo = texto(t, fila, 'CAMPO')
    if (op.campos.has(campo)) op.integridad = 'inconsistente'
    op.campos.set(campo, { antes: texto(t, fila, 'VALOR_ANTES'), despues: texto(t, fila, 'VALOR_DESPUES') })
  }
  return [...ops.values()].map(({ lote, total, indices, ...op }) => {
    void lote
    if (op.integridad === 'completa' && (total === null || indices.length !== total || indices.some((i) => i < 1 || i > total))) op.integridad = 'parcial'
    return op
  })
}

/**
 * ORD-POS-156 (SEGUNDO H3): el REGISTRO_ID de una escritura auditada desde la bandeja, solo si la entidad es un proveedor
 * o una cotización y el ID tiene su patrón (PRV-NNNN o COT-NNNN); si no, null y nunca llega a un mensaje.
 */
function idDeBandeja(o: { entidad: string; id: string }): string | null {
  const e = o.entidad === 'PIPE_PROVEEDORES' ? 'proveedor' : o.entidad === 'PIPE_COTIZACIONES' ? 'cotizacion' : null
  return e && new RegExp(`^${ENTIDADES[e].prefijo}-\\d{4,}$`).test(o.id) ? o.id : null
}

/** 409 «desde esta fila ya se escribió X»; sin `id` si el auditado no tenía el patrón de su entidad. */
const escritaError = (e: { id?: string }) =>
  new OperationError('bandeja-no-pendiente', { detail: e.id ? { estado: 'PENDIENTE', id: e.id } : {} })

/**
 * ORD-POS-157 (SEGUNDO H3 de #348): un PROVEEDOR_ID o COTIZACION_ID leído de la hoja (el proveedor ligado por nombre o
 * la SOLICITADA que se edita) solo se usa con su patrón; si no, 422 sin repetir el valor de la celda.
 */
function idDeHoja(prefijo: 'PRV' | 'COT', valor: string): string {
  if (idValido(prefijo, valor)) return valor
  const [campo, columna] = prefijo === 'PRV' ? ['proveedor', 'PROVEEDOR_ID'] : ['cotizacion', 'COTIZACION_ID']
  throw new OperationError('validacion', {
    fields: { [campo]: `El ${columna} de la fila que se usaría en ${prefijo === 'PRV' ? 'PIPE_PROVEEDORES' : 'PIPE_COTIZACIONES'} no tiene el patrón ${prefijo}-NNNN: corrígelo en la hoja. No se escribió nada.` },
  })
}

/** Campos de una edición auditada que no son de control (VERSION y ACTUALIZADO los pone el servidor). */
const CONTROL_EDICION = new Set(['VERSION', 'ACTUALIZADO'])

const celdaDeTexto = (columna: string, v: string): Celda => (COLUMNAS_NUMERICAS.has(columna) && v !== '' ? Number(v) : v)

export class EcoPipelineWriteService {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly clock: () => Date
  private readonly randomHex: (bytes: number) => string

  constructor(private readonly store: EcoPipelineStore, options: EcoServiceOptions = {}) {
    this.clock = options.clock ?? (() => new Date())
    this.randomHex = options.randomHex ?? ((n) => randomBytes(n).toString('hex'))
  }

  /** Libro al que escribe este servicio (pruebas cruzadas). */
  get libro(): string {
    return this.store.libro
  }

  /** Serializa las escrituras del pipeline de ESTE proceso (supone una instancia, `maxScale: 1`, §6.3). */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  /* --------------------------------------- Productos --------------------------------------- */

  crearProducto(cmd: EcoComando, ctx: EcoContext): Promise<EcoResultado> {
    return this.crear('eco.producto.crear', 'producto', cmd, ctx, (libro, r) => {
      if (r.ASIN && this.filas(libro, 'producto').some((f) => texto(libro.PIPE_PRODUCTOS, f, 'ASIN') === r.ASIN)) throw new OperationError('asin-duplicado')
      if (r.PROVEEDOR_ELEGIDO_ID) this.proveedorActivo(libro, String(r.PROVEEDOR_ELEGIDO_ID), 'proveedorElegidoId')
      const stamp = this.stamp()
      return { ...r, ORIGEN: 'MANUAL', ETAPA: 'SUGERIDO', ETAPA_DESDE: stamp }
    })
  }

  editarProducto(id: string, cmd: EcoComando, ctx: EcoContext): Promise<EcoResultado> {
    return this.editar('eco.producto.editar', 'producto', id, cmd, ctx, (libro, merged, actual) => {
      const asin = celdaTexto(merged.ASIN)
      if (asin && asin !== celdaTexto(actual.ASIN)) this.asinLibre(libro, asin, id)
      const prv = celdaTexto(merged.PROVEEDOR_ELEGIDO_ID)
      if (prv && prv !== celdaTexto(actual.PROVEEDOR_ELEGIDO_ID)) this.proveedorActivo(libro, prv, 'proveedorElegidoId')
    })
  }

  moverProducto(id: string, cmd: MoverComando, ctx: EcoContext): Promise<EcoResultado> {
    const op: EcoOperationName = 'eco.producto.mover'
    return this.exclusive(async () => {
      const hash = payloadHash(op, { ...cmd, id })
      const libro = await this.leer()
      const repetida = await this.replay(op, hash, cmd.requestId, libro)
      if (repetida) return repetida
      conCupo(libro)

      const { actual } = this.unica(libro, 'producto', id)
      const etapaTexto = celdaTexto(actual.ETAPA).toUpperCase()
      const desde = ETAPAS.find((e) => e === etapaTexto)
      const version = this.versionDe(actual)
      if (desde !== cmd.expectedEtapa || version !== cmd.expectedVersion) {
        throw new OperationError('conflicto-version', { detail: { etapa: etapaTexto, version } })
      }
      if (!transicionPermitida(desde, cmd.etapa)) throw new OperationError('transicion-no-permitida', { detail: { desde, a: cmd.etapa } })
      if (requiereMotivo(desde, cmd.etapa) && !cmd.motivo) throw new OperationError('validacion', { fields: { motivo: 'Obligatorio para este cambio.' } })
      this.requisitos(libro, id, actual, desde, cmd.etapa)

      const stamp = this.stamp()
      const despues: Registro = { ETAPA: cmd.etapa, ETAPA_DESDE: stamp }
      const extra: Cambio['extra'] = []
      if (cmd.etapa === 'DESCARTADO') despues.MOTIVO_DESCARTE = cmd.motivo!
      else if (cmd.motivo) extra.push([CAMPO_MOTIVO, cmd.motivo])
      return this.escribirEdicion(hash, cmd.requestId, ctx, op, 'producto', id, actual, despues, libro, extra)
    })
  }

  /** §5.1: requisitos de integridad de cada destino (si falta, 409 `requisito-faltante`, sin escribir). */
  private requisitos(libro: Libro, id: string, actual: Registro, desde: Etapa, a: Etapa) {
    const c = libro.PIPE_COTIZACIONES
    const cots = c.filas.filter((f) => texto(c, f, 'PRODUCTO_ID') === id)
    const falta = (requisito: string) => new OperationError('requisito-faltante', { detail: { requisito } })
    if (desde === 'EVALUANDO' && a === 'COTIZANDO' && celdaTexto(actual.COSTO_MAX_MXN) === '') throw falta('COSTO_MAX_MXN')
    if (desde === 'COTIZANDO' && a === 'MUESTRA' && !cots.some((f) => ['RECIBIDA', 'ELEGIDA'].includes(texto(c, f, 'ESTADO')))) {
      throw falta('cotizacion-recibida')
    }
    if (desde === 'MUESTRA' && a === 'EN_VENTA') {
      const elegido = celdaTexto(actual.PROVEEDOR_ELEGIDO_ID)
      const ok = cots.some((f) => texto(c, f, 'ESTADO') === 'ELEGIDA' && texto(c, f, 'MUESTRA_ESTADO') === 'APROBADA'
        && elegido !== '' && texto(c, f, 'PROVEEDOR_ID') === elegido)
      if (!ok) throw falta('cotizacion-elegida-con-muestra-aprobada')
    }
    if (desde === 'DESCARTADO') {
      const asin = celdaTexto(actual.ASIN)
      if (asin) this.asinLibre(libro, asin, id)
    }
  }

  /* --------------------------------------- Proveedores --------------------------------------- */

  crearProveedor(cmd: EcoComando, ctx: EcoContext, guarda?: Guarda): Promise<EcoResultado> {
    return this.crear('eco.proveedor.crear', 'proveedor', cmd, ctx, (libro, r) => {
      this.nombreLibre(libro, celdaTexto(r.NOMBRE), null)
      return { ...r, ESTADO: 'ACTIVO' }
    }, guarda)
  }

  editarProveedor(id: string, cmd: EcoComando, ctx: EcoContext): Promise<EcoResultado> {
    return this.editar('eco.proveedor.editar', 'proveedor', id, cmd, ctx, (libro, merged, actual) => {
      const nombre = celdaTexto(merged.NOMBRE)
      if (nombreClave(nombre) !== nombreClave(celdaTexto(actual.NOMBRE))) this.nombreLibre(libro, nombre, id)
    })
  }

  /** ORD-POS-146 (criterio 1): un proveedor con el mismo nombre (sin acentos, mayúsculas ni signos) no se duplica. */
  private nombreLibre(libro: Libro, nombre: string, propio: string | null) {
    const t = libro.PIPE_PROVEEDORES
    const clave = nombreClave(nombre)
    const otro = t.filas.find((f) => texto(t, f, 'PROVEEDOR_ID') !== propio && clave !== '' && nombreClave(texto(t, f, 'NOMBRE')) === clave)
    if (otro) throw new OperationError('proveedor-duplicado', { detail: { id: texto(t, otro, 'PROVEEDOR_ID') } })
  }

  /* -------------------------------------- Cotizaciones -------------------------------------- */

  crearCotizacion(cmd: EcoComando, ctx: EcoContext, guarda?: Guarda): Promise<EcoResultado> {
    return this.crear('eco.cotizacion.crear', 'cotizacion', cmd, ctx, (libro, r) => {
      this.productoAbierto(libro, String(r.PRODUCTO_ID))
      if (!this.filas(libro, 'proveedor').some((f) => texto(libro.PIPE_PROVEEDORES, f, 'PROVEEDOR_ID') === r.PROVEEDOR_ID)) {
        throw new OperationError('referencia-inexistente', { fields: { proveedorId: 'No existe.' } })
      }
      // ORD-POS-146: puede nacer RECIBIDA (con los cinco datos de §3.3) o RECHAZADA; sin estado, SOLICITADA.
      const estado = celdaTexto(r.ESTADO) || 'SOLICITADA'
      if (estado === 'RECIBIDA') {
        // El alta con RECIBIDA (formulario completo y pegado) sigue pidiendo los cinco datos de §3.3.
        const faltan = ['PRECIO_UNIT', 'MONEDA', 'MOQ', 'PLAZO_PRODUCCION_DIAS', 'INCOTERM'].filter((col) => celdaTexto(r[col]) === '')
        if (faltan.length) throw new OperationError('requisito-faltante', { detail: { requisito: faltan.join(',') } })
      }
      const registro = { ...r, ESTADO: estado, MUESTRA_ESTADO: r.MUESTRA_ESTADO || 'NO_PEDIDA' }
      this.fechas('cotizacion', registro)
      return registro
    }, guarda)
  }

  /**
   * ORD-POS-149 (criterio 3, §16.2): «Pedir» crea la cotización `SOLICITADA` con `FECHA_SOLICITUD` = hoy (Mérida) y
   * `FECHA_RESPUESTA_ESPERADA` = hoy + 7. Solo producto abierto y proveedor `ACTIVO`.
   */
  pedirCotizacion(cmd: EcoComando, ctx: EcoContext): Promise<EcoResultado> {
    return this.crear('eco.cotizacion.pedir', 'cotizacion', cmd, ctx, (libro, r) => {
      this.productoAbierto(libro, String(r.PRODUCTO_ID))
      this.proveedorActivo(libro, String(r.PROVEEDOR_ID), 'proveedorId')
      const hoy = civilDateInZone(this.clock().getTime())
      return { ...r, ESTADO: 'SOLICITADA', FECHA_SOLICITUD: hoy, FECHA_RESPUESTA_ESPERADA: addDays(hoy, DIAS_RESPUESTA), MUESTRA_ESTADO: 'NO_PEDIDA' }
    })
  }

  editarCotizacion(id: string, cmd: EcoComando, ctx: EcoContext, guarda?: Guarda): Promise<EcoResultado> {
    return this.editar('eco.cotizacion.editar', 'cotizacion', id, cmd, ctx, (libro, merged, actual) => {
      this.productoAbierto(libro, celdaTexto(actual.PRODUCTO_ID))
      const desde = celdaTexto(actual.ESTADO)
      const a = celdaTexto(merged.ESTADO)
      if (a !== desde && !(TRANSICIONES_COTIZACION[desde] ?? []).includes(a)) throw new OperationError('transicion-no-permitida', { detail: { desde, a } })
      // ORD-POS-149 (§16.3): RECIBIDA pide precio, moneda, MOQ e incoterm; el plazo se exige al elegir.
      if (a === 'RECIBIDA' || a === 'ELEGIDA') {
        const faltan = (a === 'ELEGIDA' ? REQUISITOS_ELEGIDA : REQUISITOS_RECIBIDA).filter((col) => celdaTexto(merged[col]) === '')
        if (faltan.length) throw new OperationError('requisito-faltante', { detail: { requisito: faltan.join(',') } })
      }
      const t = libro.PIPE_COTIZACIONES
      const extra: Registro = {}
      if (a === 'RECIBIDA' && desde === 'SOLICITADA') {
        // Con la migración de §14.7, una respuesta nueva dice si el precio es por pieza o por set.
        if (t.indice.has('PRECIO_POR') && celdaTexto(merged.PRECIO_POR) === '') throw new OperationError('requisito-faltante', { detail: { requisito: 'PRECIO_POR' } })
        if (celdaTexto(merged.FECHA_RECIBIDA) === '') extra.FECHA_RECIBIDA = civilDateInZone(this.clock().getTime())
      }
      // ORD-POS-149 (criterio 5, §16.3): contraoferta. Un precio que cambia conserva el anterior en PRECIO_HISTORIAL.
      const previo = celdaTexto(actual.PRECIO_UNIT)
      if ('PRECIO_UNIT' in cmd.valores && previo !== '' && !iguales(actual.PRECIO_UNIT, cmd.valores.PRECIO_UNIT!)) {
        if (!t.indice.has('PRECIO_HISTORIAL')) throw new OperationError('eco-migracion-pendiente', { detail: { pestana: 'PIPE_COTIZACIONES', columnas: 'PRECIO_HISTORIAL' } })
        extra.PRECIO_HISTORIAL = entradaHistorial(celdaTexto(actual.PRECIO_HISTORIAL), civilDateInZone(this.clock().getTime()), actual)
      }
      if (a === 'ELEGIDA' && desde !== 'ELEGIDA') {
        const c = libro.PIPE_COTIZACIONES
        const otra = c.filas.some((f) => texto(c, f, 'COTIZACION_ID') !== id && texto(c, f, 'PRODUCTO_ID') === celdaTexto(actual.PRODUCTO_ID) && texto(c, f, 'ESTADO') === 'ELEGIDA')
        if (otra) throw new OperationError('elegida-duplicada')
      }
      this.fechas('cotizacion', { ...merged, ...extra })
      return extra
    }, guarda)
  }

  /* --------------------------------------- Embarques --------------------------------------- */

  crearEmbarque(cmd: EcoComando, ctx: EcoContext): Promise<EcoResultado> {
    return this.crear('eco.embarque.crear', 'embarque', cmd, ctx, (libro, r) => {
      if (!this.filas(libro, 'producto').some((f) => texto(libro.PIPE_PRODUCTOS, f, 'PRODUCTO_ID') === r.PRODUCTO_ID)) {
        throw new OperationError('referencia-inexistente', { fields: { productoId: 'No existe.' } })
      }
      const c = libro.PIPE_COTIZACIONES
      const cot = c.filas.find((f) => texto(c, f, 'COTIZACION_ID') === r.COTIZACION_ID)
      if (!cot) throw new OperationError('referencia-inexistente', { fields: { cotizacionId: 'No existe.' } })
      if (texto(c, cot, 'PRODUCTO_ID') !== r.PRODUCTO_ID) throw new OperationError('referencia-inexistente', { fields: { cotizacionId: 'Es de otro producto.' } })
      if (texto(c, cot, 'ESTADO') !== 'ELEGIDA') throw new OperationError('requisito-faltante', { detail: { requisito: 'cotizacion-elegida' } })
      const registro = { ...r, ESTADO: 'PLANEADO' }
      this.fechas('embarque', registro)
      return registro
    })
  }

  editarEmbarque(id: string, cmd: EcoComando, ctx: EcoContext): Promise<EcoResultado> {
    return this.editar('eco.embarque.editar', 'embarque', id, cmd, ctx, (_libro, merged, actual) => {
      const desde = celdaTexto(actual.ESTADO)
      const a = celdaTexto(merged.ESTADO)
      if (a !== desde && !(TRANSICIONES_EMBARQUE[desde] ?? []).includes(a)) throw new OperationError('transicion-no-permitida', { detail: { desde, a } })
      this.fechas('embarque', merged)
    })
  }

  /* --------------------------------- Bandeja de Gemini (ORD-POS-155) --------------------------------- */

  /**
   * §18.3 «Confirmar»: crea o actualiza con las operaciones de siempre (mismo guard, misma validación, safeCellText,
   * rechazo de fórmulas, auditoría en PIPE_AUDITORIA) y luego marca la fila CONFIRMADA con el ID resultante. La escritura
   * de la entidad usa un requestId derivado del BANDEJA_ID: reintentar (con el mismo requestId o con otro) nunca crea dos
   * proveedores ni dos cotizaciones desde la misma fila. Si esa escritura ya está auditada (la marca falló antes), se
   * completa desde la auditoría, sin volver a crear ni editar y sin mirar el cuerpo, y se termina la marca CONFIRMADA
   * con el ID auditado (CORRECCIÓN 1, SEGUNDO H1).
   */
  async confirmarBandeja(id: string, b: BandejaConfirmar, ctx: EcoContext): Promise<EcoResultado> {
    const op: EcoOperationName = 'eco.bandeja.confirmar'
    const { t, n, fila } = await this.filaBandeja(id)
    const estado = texto(t, fila, 'ESTADO_BANDEJA').toUpperCase()
    const previo = texto(t, fila, 'RESULTADO_ID')
    if (estado === 'CONFIRMADA' && RESULTADO.test(previo)) return { operacion: op, id: previo, version: 0, repetida: true }
    // CORRECCIÓN 1 (PRIMERO H1, SEGUNDO H3): el valor de la celda solo se devuelve si es de la lista cerrada.
    if (estado !== 'PENDIENTE') throw new OperationError('bandeja-no-pendiente', { detail: (ESTADOS_BANDEJA as readonly string[]).includes(estado) ? { estado } : {} })
    const tipo = texto(t, fila, 'TIPO').toUpperCase()
    if (tipo !== b.tipo) {
      const deTipo = (TIPOS_BANDEJA as readonly string[]).includes(tipo) ? `de tipo ${tipo}` : 'de un tipo no válido'
      throw new OperationError('validacion', { fields: { tipo: `La fila ${id} es ${deTipo}.` } })
    }
    // Criterio 4: ninguna celda de la fila con fórmula, correo o teléfono.
    await this.sinBloqueos(t, n, fila, null)
    const requestId = derivedRequestId(id, b.tipo === 'PROVEEDOR' ? 'bandeja-proveedor' : 'bandeja-cotizacion')
    // La entidad solo se escribe si la fila sigue PENDIENTE dentro del mismo `exclusive` (CORRECCIÓN 1, SEGUNDO H2).
    const guarda: Guarda = async () => {
      const { t: tb, fila: f } = await this.filaBandeja(id)
      if (texto(tb, f, 'ESTADO_BANDEJA').toUpperCase() !== 'PENDIENTE') throw new OperationError('bandeja-no-pendiente')
    }
    const resultadoId = (await this.auditada(requestId))
      ? await this.completarAuditada(requestId)
      : b.tipo === 'PROVEEDOR' ? await this.proveedorDesdeBandeja(requestId, b.cmd, ctx, guarda) : await this.cotizacionDesdeBandeja(requestId, b.cmd, ctx, guarda)
    const r = await this.marcarBandeja(op, id, b.cmd.requestId, { resultadoId }, { ESTADO_BANDEJA: 'CONFIRMADA', RESULTADO_ID: resultadoId }, ctx)
    return { ...r, id: resultadoId }
  }

  /** §18.3 «Rechazar»: marca RECHAZADA y agrega «Rechazada: <motivo>» al final de NOTAS, sin borrar lo que había. */
  async rechazarBandeja(id: string, cmd: { requestId: string; motivo: string }, ctx: EcoContext): Promise<EcoResultado> {
    const op: EcoOperationName = 'eco.bandeja.rechazar'
    const { t, n, fila } = await this.filaBandeja(id)
    const estado = texto(t, fila, 'ESTADO_BANDEJA').toUpperCase()
    if (estado === 'PENDIENTE') {
      // Si ya se escribió un proveedor o una cotización desde esta fila (confirmación a medias), no se rechaza: se termina
      // de confirmar. `marcarBandeja` lo repite dentro de `exclusive` (SEGUNDO H2).
      const previa = this.escritaDesde(id, auditoriaEco(await this.releer('PIPE_AUDITORIA', 'lectura-fallida')))
      if (previa) throw escritaError(previa)
      // Las celdas que se escriben no pueden tener fórmula ni datos personales (no se copian a la auditoría).
      await this.sinBloqueos(t, n, fila, COLUMNAS_BANDEJA_ESCRIBIBLES)
    }
    const notas = safeCellText(notasRechazo(texto(t, fila, 'NOTAS'), cmd.motivo), true)
    return this.marcarBandeja(op, id, cmd.requestId, { motivo: cmd.motivo }, { ESTADO_BANDEJA: 'RECHAZADA', NOTAS: notas }, ctx)
  }

  /** La fila de la bandeja con ese BANDEJA_ID, releída: ninguna es 404 y dos o más, 409 (como `unica`). */
  private async filaBandeja(id: string): Promise<{ t: Tabla; n: number; fila: unknown[] }> {
    let titulos: string[]
    try {
      titulos = await this.store.tabs()
    } catch {
      throw new OperationError('lectura-fallida')
    }
    if (!titulos.includes(ECO_BANDEJA_TAB)) throw new OperationError('eco-esquema-invalido', { detail: { pestana: ECO_BANDEJA_TAB } })
    const t = await this.releer(ECO_BANDEJA_TAB, 'lectura-fallida')
    const indices = t.filas.flatMap((f, i) => (texto(t, f, 'BANDEJA_ID') === id ? [i] : []))
    if (indices.length === 0) throw new OperationError('registro-inexistente')
    if (indices.length > 1) throw new OperationError('conflicto-concurrente')
    return { t, n: indices[0]! + 2, fila: t.filas[indices[0]!]! }
  }

  /** Criterio 4: fórmula (leída con FORMULA) o correo o teléfono en las celdas de la fila (todas, o solo `columnas`). */
  private async sinBloqueos(t: Tabla, n: number, fila: unknown[], columnas: readonly string[] | null) {
    let formulas: unknown[]
    try {
      formulas = await this.store.formulas(ECO_BANDEJA_TAB, n)
    } catch {
      throw new OperationError('lectura-fallida')
    }
    const malas: string[] = []
    for (let j = 0; j < Math.max(fila.length, formulas.length, t.header.length); j++) {
      const col = t.header[j] || `columna ${j + 1}`
      if (columnas && !columnas.includes(col)) continue
      if (esFormula(formulas[j]) || celdaConContacto(fila[j])) malas.push(col.slice(0, 60))
    }
    if (malas.length) throw new OperationError('bandeja-bloqueada', { detail: { columnas: malas.join(',') } })
  }

  /** Solicitud ya auditada con ese requestId (su registro), o null. */
  private async auditada(requestId: string): Promise<{ id: string } | null> {
    const a = auditoriaEco(await this.releer('PIPE_AUDITORIA', 'lectura-fallida')).find((o) => o.requestId === requestId)
    return a ? { id: a.id } : null
  }

  /**
   * Escritura de un proveedor o una cotización ya auditada desde la fila `id` (requestId derivado del BANDEJA_ID), o
   * null. Su `id` solo viene si tiene el patrón de su entidad (ORD-POS-156, SEGUNDO H3): si no, se bloquea igual, pero
   * el mensaje no repite el REGISTRO_ID.
   */
  private escritaDesde(id: string, auditoria: ReturnType<typeof auditoriaEco>): { id?: string } | null {
    const derivados = [derivedRequestId(id, 'bandeja-proveedor'), derivedRequestId(id, 'bandeja-cotizacion')]
    const o = auditoria.find((x) => derivados.includes(x.requestId))
    if (!o) return null
    const valido = idDeBandeja(o)
    return valido ? { id: valido } : {}
  }

  /**
   * CORRECCIÓN 1 (SEGUNDO H1): la escritura de la entidad ya está auditada con el requestId derivado. Se completa con lo
   * auditado (como un reintento con el mismo cuerpo: repetida o roll-forward, sin crear ni editar de nuevo) y se devuelve
   * el ID auditado, aunque el cuerpo de este «Confirmar» sea otro.
   * ORD-POS-156 (SEGUNDO H2): si la entidad cambió después (otra VERSION), basta que exista una sola fila con el ID
   * auditado para terminar la marca; no se vuelve atrás ni se pisa la edición. El roll-forward queda para lo que nunca
   * llegó a la hoja (el alta cuyo append falló, o la edición que sigue igual que antes). El ID auditado se valida con el
   * patrón de su entidad antes de usarlo (SEGUNDO H3).
   * ORD-POS-157 (SEGUNDO H1 de #348): si lo auditado era una edición y ninguno de sus datos (salvo VERSION y
   * ACTUALIZADO) está en la fila, la edición nunca llegó aunque la VERSION haya cambiado después (p. ej. el propietario
   * editó NOTAS): no se marca CONFIRMADA y se responde estado-divergente con el ID, para recibirla o reintentar.
   */
  private completarAuditada(requestId: string): Promise<string> {
    return this.exclusive(async () => {
      const libro = await this.leer()
      const a = auditoriaEco(libro.PIPE_AUDITORIA).find((o) => o.requestId === requestId)
      const id = a ? idDeBandeja(a) : null
      if (!a || !id) throw new OperationError('auditoria-inconsistente')
      try {
        const r = await this.replay('eco.bandeja.confirmar', a.hash, requestId, libro)
        if (!r) throw new OperationError('auditoria-inconsistente')
        return id
      } catch (e) {
        if (!(e instanceof OperationError) || e.code !== 'estado-divergente') throw e
        const t = libro[a.entidad as EcoWriteTab]
        const idCol = ENTIDADES[a.entidad === 'PIPE_PROVEEDORES' ? 'proveedor' : 'cotizacion'].idCol
        const filas = t.filas.filter((f) => texto(t, f, idCol) === id)
        if (filas.length !== 1) throw e
        const edicion = (a.campos.get('VERSION')?.antes ?? '') !== ''
        const datos = [...a.campos].filter(([c, x]) => !CONTROL_EDICION.has(c) && x.antes !== x.despues && t.indice.has(c))
        if (edicion && !datos.some(([c, x]) => iguales(valor(t, filas[0]!, c), celdaDeTexto(c, x.despues)))) {
          throw new OperationError('estado-divergente', { detail: { id } })
        }
        return id
      }
    })
  }

  /** Fila PROVEEDOR: uno que ya existe con ese nombre (§15.1) se liga sin escribir; si no, alta con `crearProveedor`. */
  private async proveedorDesdeBandeja(requestId: string, cmd: EcoComando, ctx: EcoContext, guarda: Guarda): Promise<string> {
    const t = (await this.leer()).PIPE_PROVEEDORES
    const clave = nombreClave(celdaTexto(cmd.valores.NOMBRE))
    const otro = t.filas.find((f) => clave !== '' && nombreClave(texto(t, f, 'NOMBRE')) === clave)
    if (otro) return idDeHoja('PRV', texto(t, otro, 'PROVEEDOR_ID'))
    return (await this.crearProveedor({ ...cmd, requestId }, ctx, guarda)).id
  }

  /**
   * Fila COTIZACION: si el producto ya tiene una sola cotización SOLICITADA a ese proveedor, la actualiza (como
   * «Recibir», con `expectedVersion`, sin vaciar celdas); si no, la da de alta. Una igual (producto, proveedor, incoterm,
   * precio y moneda) es 409 `cotizacion-duplicada`. Un reintento sigue el camino que ya quedó auditado.
   */
  private async cotizacionDesdeBandeja(requestId: string, cmd: EcoComando, ctx: EcoContext, guarda: Guarda): Promise<string> {
    const edicion = (version: number): EcoComando => ({
      requestId, expectedVersion: version,
      valores: Object.fromEntries(Object.entries(cmd.valores).filter(([c, v]) => v !== '' && c !== 'PRODUCTO_ID' && c !== 'PROVEEDOR_ID')),
    })
    const c = (await this.leer()).PIPE_COTIZACIONES
    const v = cmd.valores
    const mismas = c.filas.filter((f) => texto(c, f, 'PRODUCTO_ID') === celdaTexto(v.PRODUCTO_ID) && texto(c, f, 'PROVEEDOR_ID') === celdaTexto(v.PROVEEDOR_ID))
    const precio = (x: unknown) => (celdaTexto(x) === '' ? '' : String(Number(celdaTexto(x))))
    const igual = mismas.find((f) => texto(c, f, 'INCOTERM').toUpperCase() === celdaTexto(v.INCOTERM).toUpperCase()
      && precio(valor(c, f, 'PRECIO_UNIT')) === precio(v.PRECIO_UNIT) && texto(c, f, 'MONEDA').toUpperCase() === celdaTexto(v.MONEDA).toUpperCase())
    if (igual) {
      // ORD-POS-157 (SEGUNDO H3): el ID de la igual solo se nombra si tiene su patrón.
      const dup = texto(c, igual, 'COTIZACION_ID')
      throw new OperationError('cotizacion-duplicada', idValido('COT', dup) ? { detail: { id: dup } } : {})
    }
    const solicitadas = mismas.filter((f) => texto(c, f, 'ESTADO') === 'SOLICITADA')
    if (solicitadas.length === 1) {
      const f = solicitadas[0]!
      return (await this.editarCotizacion(idDeHoja('COT', texto(c, f, 'COTIZACION_ID')), edicion(Number(texto(c, f, 'VERSION'))), ctx, guarda)).id
    }
    // Ninguna (o más de una: no se adivina cuál) → alta.
    return (await this.crearCotizacion({ ...cmd, requestId }, ctx, guarda)).id
  }

  /**
   * Escribe en la fila de la bandeja solo ESTADO_BANDEJA, RESULTADO_ID y NOTAS, con el mismo orden que las entidades
   * (§6.1): idempotencia por requestId → auditoría → celdas de esa fila, si sigue PENDIENTE → verificación. `firma` es lo
   * que identifica la solicitud (el ID resultante o el motivo): con ella se calcula el hash de la idempotencia.
   */
  private marcarBandeja(
    op: EcoOperationName, id: string, requestId: string, firma: Record<string, string>, cambios: Record<string, string>, ctx: EcoContext,
  ): Promise<EcoResultado> {
    // Criterio 3: error de programación si se intenta otra columna.
    if (Object.keys(cambios).some((c) => !COLUMNAS_BANDEJA_ESCRIBIBLES.includes(c))) throw new Error('columna fuera de las que el dashboard escribe en la bandeja')
    return this.exclusive(async () => {
      const hash = payloadHash(op, { id, ...firma })
      const libro = await this.leer()
      const { t, fila } = await this.filaBandeja(id)
      const a = auditoriaEco(libro.PIPE_AUDITORIA).find((o) => o.requestId === requestId)
      if (a) {
        if (a.integridad !== 'completa') throw new OperationError('auditoria-inconsistente')
        if (a.hash !== hash || a.entidad !== ECO_BANDEJA_TAB || a.id !== id) throw new OperationError('conflicto-idempotencia')
        const auditado = Object.fromEntries([...a.campos].map(([c, x]) => [c, x.despues]))
        if (Object.entries(auditado).every(([c, x]) => texto(t, fila, c) === x)) return conAviso(libro, { operacion: op, id, version: 0, repetida: true })
        if (texto(t, fila, 'ESTADO_BANDEJA').toUpperCase() !== 'PENDIENTE') throw new OperationError('estado-divergente')
        // ORD-POS-156 (SEGUNDO H1, DELTA H-B): el roll-forward de un rechazo tampoco marca RECHAZADA una fila desde la
        // que ya se escribió una entidad (la auditoría recién leída, dentro de `exclusive`).
        if (op === 'eco.bandeja.rechazar') {
          const escrita = this.escritaDesde(id, auditoriaEco(libro.PIPE_AUDITORIA))
          if (escrita) throw escritaError(escrita)
        }
        await this.aplicarBandeja(id, auditado)
        return conAviso(libro, { operacion: op, id, version: 0, repetida: true })
      }
      if (texto(t, fila, 'ESTADO_BANDEJA').toUpperCase() !== 'PENDIENTE') throw new OperationError('bandeja-no-pendiente')
      // CORRECCIÓN 1 (SEGUNDO H2): ya en `exclusive`, no se rechaza una fila desde la que ya se escribió una entidad.
      if (op === 'eco.bandeja.rechazar') {
        const escrita = this.escritaDesde(id, auditoriaEco(libro.PIPE_AUDITORIA))
        if (escrita) throw escritaError(escrita)
      }
      conCupo(libro)
      const campos = Object.entries(cambios).map(([c, x]): [string, string, string] => [c, texto(t, fila, c), x])
      await this.escribirAuditoria(hash, requestId, ctx, ECO_BANDEJA_TAB, id, campos, libro)
      await this.aplicarBandeja(id, cambios)
      return conAviso(libro, { operacion: op, id, version: 0, repetida: false })
    })
  }

  /** Relee la fila por BANDEJA_ID; solo escribe si sigue PENDIENTE (si no, 409 sin escribir) y verifica lo escrito. */
  private async aplicarBandeja(id: string, cambios: Record<string, string>) {
    const t = await this.releer(ECO_BANDEJA_TAB, 'escritura-fallida')
    const indices = t.filas.flatMap((f, i) => (texto(t, f, 'BANDEJA_ID') === id ? [i] : []))
    if (indices.length !== 1 || texto(t, t.filas[indices[0]!]!, 'ESTADO_BANDEJA').toUpperCase() !== 'PENDIENTE') throw new OperationError('conflicto-concurrente')
    try {
      await this.store.update(ECO_BANDEJA_TAB, indices[0]! + 2, Object.entries(cambios).map(([c, v]) => ({ columna: t.indice.get(c)!, valor: v })))
    } catch {
      throw new OperationError('escritura-fallida')
    }
    const v = await this.releer(ECO_BANDEJA_TAB, 'verificacion-fallida')
    const filas = v.filas.filter((f) => texto(v, f, 'BANDEJA_ID') === id)
    if (filas.length !== 1 || !Object.entries(cambios).every(([c, x]) => texto(v, filas[0]!, c) === x)) throw new OperationError('verificacion-fallida')
  }

  /* ------------------------------------- Reglas comunes ------------------------------------- */

  private filas(libro: Libro, e: Entidad): unknown[][] {
    return libro[ENTIDADES[e].tab].filas
  }

  private asinLibre(libro: Libro, asin: string, propio: string) {
    const t = libro.PIPE_PRODUCTOS
    const ocupado = t.filas.some((f) => texto(t, f, 'PRODUCTO_ID') !== propio && texto(t, f, 'ASIN') === asin && texto(t, f, 'ETAPA') !== 'DESCARTADO')
    if (ocupado) throw new OperationError('asin-duplicado')
  }

  private proveedorActivo(libro: Libro, id: string, campo: string) {
    const t = libro.PIPE_PROVEEDORES
    const f = t.filas.find((x) => texto(t, x, 'PROVEEDOR_ID') === id)
    if (!f || texto(t, f, 'ESTADO') !== 'ACTIVO') throw new OperationError('referencia-inexistente', { fields: { [campo]: 'Debe existir y estar ACTIVO.' } })
  }

  /** Cotizaciones solo de productos que existen y no están descartados (§3.3). */
  private productoAbierto(libro: Libro, id: string) {
    const t = libro.PIPE_PRODUCTOS
    const f = t.filas.find((x) => texto(t, x, 'PRODUCTO_ID') === id)
    if (!f || texto(t, f, 'ETAPA') === 'DESCARTADO') throw new OperationError('referencia-inexistente', { fields: { productoId: 'Debe existir y no estar descartado.' } })
  }

  /** §5.2: orden de las fechas cuando existen y ninguna «recibida» o «llegada» en el futuro. */
  private fechas(e: 'cotizacion' | 'embarque', r: Registro) {
    const hoy = civilDateInZone(this.clock().getTime())
    const f = (col: string) => parseCivilDate(celdaTexto(r[col])).value
    const fields: Record<string, string> = {}
    const orden = (antes: string, despues: string) => {
      const [a, d] = [f(antes), f(despues)]
      if (a !== null && d !== null && d < a) fields[despues] = `No puede ser anterior a ${antes}.`
    }
    const pasada = (col: string) => {
      const d = f(col)
      if (d !== null && d > hoy) fields[col] = 'No puede ser futura.'
    }
    if (e === 'cotizacion') {
      orden('FECHA_SOLICITUD', 'FECHA_RECIBIDA')
      orden('MUESTRA_FECHA_PEDIDO', 'MUESTRA_FECHA_RECIBIDA')
      pasada('FECHA_RECIBIDA')
      pasada('MUESTRA_FECHA_RECIBIDA')
    } else {
      orden('FECHA_PAGO', 'FECHA_SALIDA')
      orden('FECHA_SALIDA', 'FECHA_LLEGADA')
      orden('FECHA_PAGO', 'FECHA_LLEGADA')
      pasada('FECHA_LLEGADA')
    }
    if (Object.keys(fields).length) throw new OperationError('validacion', { fields })
  }

  private stamp(): string {
    return meridaIsoTimestamp(this.clock())
  }

  private versionDe(r: Registro): number {
    const n = Number(celdaTexto(r.VERSION))
    return Number.isInteger(n) && n >= 1 ? n : 0
  }

  /** La única fila con ese ID: ninguna es 404 y dos o más, 409 `conflicto-concurrente` (§6.3). */
  private unica(libro: Libro, e: Entidad, id: string): { indice: number; fila: unknown[]; actual: Registro } {
    const { tab, idCol, columnas, opcionales } = ENTIDADES[e]
    const t = libro[tab]
    const indices = t.filas.flatMap((f, i) => (texto(t, f, idCol) === id ? [i] : []))
    if (indices.length === 0) throw new OperationError('registro-inexistente')
    if (indices.length > 1) throw new OperationError('conflicto-concurrente')
    const fila = t.filas[indices[0]!]!
    const actual: Registro = {}
    for (const c of [...columnas, ...opcionales.filter((o) => t.indice.has(o))]) {
      const v = valor(t, fila, c)
      actual[c] = typeof v === 'number' ? v : celdaTexto(v)
    }
    return { indice: indices[0]!, fila, actual }
  }

  /** `max(NNNN)` del prefijo en la pestaña y en la auditoría, más 1: nunca reutiliza un ID borrado a mano (§3). */
  private siguienteId(libro: Libro, e: Entidad): string {
    const { tab, idCol, prefijo } = ENTIDADES[e]
    const re = new RegExp(`^${prefijo}-(\\d{4,})$`)
    let max = 0
    const ver = (id: string) => {
      const m = re.exec(id)
      if (m) max = Math.max(max, Number(m[1]))
    }
    for (const f of libro[tab].filas) ver(texto(libro[tab], f, idCol))
    for (const f of libro.PIPE_AUDITORIA.filas) ver(texto(libro.PIPE_AUDITORIA, f, 'REGISTRO_ID'))
    return `${prefijo}-${String(max + 1).padStart(4, '0')}`
  }

  private crear(
    op: EcoOperationName, e: Entidad, cmd: EcoComando, ctx: EcoContext, validar: (libro: Libro, r: Registro) => Registro,
    guarda?: Guarda,
  ): Promise<EcoResultado> {
    return this.exclusive(async () => {
      const hash = payloadHash(op, cmd)
      const libro = await this.leer()
      const repetida = await this.replay(op, hash, cmd.requestId, libro)
      if (repetida) return repetida
      if (guarda) await guarda()
      conCupo(libro)
      conMigracion(libro, e, cmd.valores)
      const registro = validar(libro, { ...cmd.valores })
      const id = this.siguienteId(libro, e)
      const stamp = this.stamp()
      const despues: Registro = { [ENTIDADES[e].idCol]: id, ...registro, CREADO: stamp, ACTUALIZADO: stamp, VERSION: 1 }
      const cambio: Cambio = { entidad: e, id, antes: {}, despues, extra: [] }
      await this.auditar(hash, cmd.requestId, ctx, cambio, libro)
      await this.aplicar(cambio, libro)
      await this.verificar(cambio)
      return conAviso(libro, { operacion: op, id, version: 1, repetida: false })
    })
  }

  private editar(
    op: EcoOperationName, e: Entidad, id: string, cmd: EcoComando, ctx: EcoContext,
    validar: (libro: Libro, merged: Registro, actual: Registro) => Registro | void, guarda?: Guarda,
  ): Promise<EcoResultado> {
    return this.exclusive(async () => {
      const hash = payloadHash(op, { ...cmd, id })
      const libro = await this.leer()
      const repetida = await this.replay(op, hash, cmd.requestId, libro)
      if (repetida) return repetida
      if (guarda) await guarda()
      conCupo(libro)
      conMigracion(libro, e, cmd.valores)
      const { actual } = this.unica(libro, e, id)
      const version = this.versionDe(actual)
      if (version !== cmd.expectedVersion) throw new OperationError('conflicto-version', { detail: { version } })
      const despues: Registro = Object.fromEntries(Object.entries(cmd.valores).filter(([c, v]) => !iguales(actual[c], v) && !(v === '' && celdaTexto(actual[c]) === '')))
      if (!Object.keys(despues).length) throw new OperationError('sin-cambios')
      // ORD-POS-149: la validación puede añadir columnas que pone el servidor (FECHA_RECIBIDA, PRECIO_HISTORIAL).
      const extra = validar(libro, { ...actual, ...cmd.valores }, actual) ?? {}
      return this.escribirEdicion(hash, cmd.requestId, ctx, op, e, id, actual, { ...despues, ...extra }, libro, [])
    })
  }

  /** Edición ya validada: relectura → fórmulas de esa fila → auditoría → relectura → celdas guardadas → verificación. */
  private async escribirEdicion(
    hash: string, requestId: string, ctx: EcoContext, op: EcoOperationName, e: Entidad, id: string, actual: Registro,
    cambios: Registro, libro: Libro, extra: Cambio['extra'],
  ): Promise<EcoResultado> {
    // ORD-POS-109 (SEGUNDO H1): sin auditoría todavía, un fallo de esta relectura es lectura-fallida.
    const destino = await this.ubicar(e, id, actual.VERSION!, 'lectura-fallida')
    await this.sinFormulas(e, destino, Object.keys(cambios))
    const version = this.versionDe(actual)
    const despues: Registro = { ...cambios, ACTUALIZADO: this.stamp(), VERSION: version + 1 }
    const antes: Registro = Object.fromEntries(Object.keys(despues).map((c) => [c, actual[c] ?? '']))
    const cambio: Cambio = { entidad: e, id, antes, despues, extra }
    await this.auditar(hash, requestId, ctx, cambio, libro)
    // ORD-POS-109 (H1): aplicar() vuelve a ubicar la fila por ID y VERSION después de auditar.
    await this.aplicar(cambio, libro)
    await this.verificar(cambio)
    return conAviso(libro, { operacion: op, id, version: version + 1, repetida: false })
  }

  /** ❓ §12: una celda que es fórmula de la hoja (p. ej. COSTO_MAX_MXN o COSTO_ATERRIZADO_MXN) no se pisa. */
  private async sinFormulas(e: Entidad, { t, n }: Destino, columnas: string[]) {
    let row: unknown[]
    try {
      row = await this.store.formulas(ENTIDADES[e].tab, n)
    } catch {
      throw new OperationError('lectura-fallida')
    }
    const formulas = columnas.filter((c) => {
      const v = row[t.indice.get(c) ?? -1]
      return typeof v === 'string' && v.startsWith('=')
    })
    if (formulas.length) throw new OperationError('campo-solo-lectura', { fields: Object.fromEntries(formulas.map((c) => [c, 'Fórmula de la hoja.'])) })
  }

  /* ------------------------------------ Lectura y escritura ------------------------------------ */

  /** Las cinco pestañas PIPE_* que escribe el servicio, con sus encabezados; sin ellas, 400 y nada se escribe. El tope de
   * filas lo mira `conCupo` después de replay(). */
  private async leer(): Promise<Libro> {
    let titulos: string[]
    let datos: Partial<Record<EcoWriteTab, unknown[][]>>
    try {
      titulos = await this.store.tabs()
    } catch {
      throw new OperationError('lectura-fallida')
    }
    const falta = ECO_WRITE_TABS.find((p) => !titulos.includes(p))
    if (falta) throw new OperationError('eco-esquema-invalido', { detail: { pestana: falta } })
    try {
      datos = await this.store.read(ECO_WRITE_TABS)
    } catch {
      throw new OperationError('lectura-fallida')
    }
    return Object.fromEntries(ECO_WRITE_TABS.map((tab) => [tab, tabla(datos[tab] ?? [], columnasDe(tab), tab)])) as Libro
  }

  private async releer(tab: EcoStoreTab, error: 'lectura-fallida' | 'escritura-fallida' | 'verificacion-fallida'): Promise<Tabla> {
    try {
      return tabla((await this.store.read([tab]))[tab] ?? [], columnasDe(tab), tab)
    } catch {
      throw new OperationError(error)
    }
  }

  /** Mismo requestId: repetida (fila con lo auditado), roll-forward (fila aún como antes) o conflicto (otro hash). */
  private async replay(op: EcoOperationName, hash: string, requestId: string, libro: Libro): Promise<EcoResultado | null> {
    const a = auditoriaEco(libro.PIPE_AUDITORIA).find((o) => o.requestId === requestId)
    if (!a) return null
    if (a.integridad !== 'completa') throw new OperationError('auditoria-inconsistente')
    if (a.hash !== hash) throw new OperationError('conflicto-idempotencia')
    const e = (Object.keys(ENTIDADES) as Entidad[]).find((k) => ENTIDADES[k].tab === a.entidad)
    if (!e) throw new OperationError('auditoria-inconsistente')
    const { tab, idCol, columnas, opcionales } = ENTIDADES[e]
    const antes: Registro = {}
    const despues: Registro = {}
    for (const [campo, v] of a.campos) {
      if (!columnas.includes(campo) && !opcionales.includes(campo)) continue
      antes[campo] = celdaDeTexto(campo, v.antes)
      despues[campo] = celdaDeTexto(campo, v.despues)
    }
    const alta = !('VERSION' in antes) || antes.VERSION === ''
    if (alta) for (const c of Object.keys(antes)) delete antes[c]
    const cambio: Cambio = { entidad: e, id: a.id, antes, despues, extra: [] }
    const t = libro[tab]
    const filas = t.filas.filter((f) => texto(t, f, idCol) === a.id)
    const version = Number(despues.VERSION)
    if (filas.length > 1) throw new OperationError('conflicto-concurrente')
    const coincide = (r: Registro) => filas.length === 1 && Object.entries(r).every(([c, v]) => iguales(valor(t, filas[0]!, c), v))
    if (coincide(despues)) return conAviso(libro, { operacion: op, id: a.id, version, repetida: true })
    if ((alta && filas.length === 0) || (!alta && coincide(antes))) {
      if (alta && t.filas.length >= MAX_DATA_ROWS) throw llena(tab)
      await this.aplicar(cambio, libro)
      await this.verificar(cambio)
      return conAviso(libro, { operacion: op, id: a.id, version, repetida: true })
    }
    throw new OperationError('estado-divergente')
  }

  /** PIPE_AUDITORIA primero, una fila por campo con antes y después: si falla, no se toca la entidad (§6.1). */
  private async auditar(hash: string, requestId: string, ctx: EcoContext, cambio: Cambio, libro: Libro) {
    const alta = Object.keys(cambio.antes).length === 0
    const campos: Array<[string, string, string]> = [
      ...Object.entries(cambio.despues)
        .filter(([, v]) => !(alta && v === ''))
        .map(([c, v]): [string, string, string] => [c, celdaTexto(cambio.antes[c] ?? ''), String(v)]),
      ...cambio.extra.map(([c, v]): [string, string, string] => [c, '', v]),
    ]
    await this.escribirAuditoria(hash, requestId, ctx, ENTIDADES[cambio.entidad].tab, cambio.id, campos, libro)
  }

  /** Filas de PIPE_AUDITORIA de una solicitud (una por campo, con antes y después); la usan las entidades y la bandeja. */
  private async escribirAuditoria(
    hash: string, requestId: string, ctx: EcoContext, entidad: EcoStoreTab, id: string, campos: Array<[string, string, string]>, libro: Libro,
  ) {
    const stamp = this.stamp()
    const compact = stamp.slice(0, 19).replace(/[-:T]/g, '')
    const lote = this.randomHex(4).toUpperCase()
    const total = String(campos.length).padStart(2, '0')
    const origen = `${ORIGIN_PREFIX};req=${requestId};hash=${hash}`
    const rows = campos.map(([campo, antes, despues], i) => libro.PIPE_AUDITORIA.header.map((h) => ({
      AUDIT_ID: `AUD-${compact}-${lote}-${String(i + 1).padStart(2, '0')}-${total}`,
      FECHA_HORA: stamp,
      ACTOR: ctx.actor,
      ENTIDAD: entidad,
      REGISTRO_ID: id,
      CAMPO: campo,
      VALOR_ANTES: antes,
      VALOR_DESPUES: despues,
      ORIGEN: origen,
    } as Record<string, string>)[h] ?? ''))
    try {
      await this.store.append('PIPE_AUDITORIA', rows)
    } catch {
      throw new OperationError('auditoria-fallida')
    }
  }

  /** Relee la pestaña y ubica la fila por ID; solo vale si conserva la VERSION de antes (como `writeGuarded`). Antes de
   * auditar, un fallo de la relectura es `lectura-fallida`; después, `escritura-fallida` (se completa al reintentar). */
  private async ubicar(e: Entidad, id: string, version: Celda, error: 'lectura-fallida' | 'escritura-fallida'): Promise<Destino> {
    const { tab, idCol } = ENTIDADES[e]
    const t = await this.releer(tab, error)
    const indices = t.filas.flatMap((f, i) => (texto(t, f, idCol) === id ? [i] : []))
    if (indices.length !== 1 || !iguales(valor(t, t.filas[indices[0]!]!, 'VERSION'), version)) throw new OperationError('conflicto-concurrente')
    return { t, n: indices[0]! + 2 }
  }

  /** Alta: fila al final. Edición: en la fila que `ubicar` encuentra en una relectura posterior a la auditoría; si la
   * fila se movió, se escribe en su nueva posición y, si cambió su VERSION o su ID, 409 sin escribir (ORD-POS-109, H1).
   * atajo: queda la ventana entre esta relectura y el update (Sheets no tiene escritura condicional); la cubre verificar(). */
  private async aplicar(cambio: Cambio, libro: Libro) {
    const { tab } = ENTIDADES[cambio.entidad]
    if (Object.keys(cambio.antes).length === 0) {
      try {
        await this.store.append(tab, [libro[tab].header.map((h) => cambio.despues[h] ?? '')])
      } catch {
        throw new OperationError('escritura-fallida')
      }
      return
    }
    const { t, n } = await this.ubicar(cambio.entidad, cambio.id, cambio.antes.VERSION!, 'escritura-fallida')
    try {
      await this.store.update(tab, n, Object.entries(cambio.despues).map(([c, v]) => ({ columna: t.indice.get(c)!, valor: v })))
    } catch {
      throw new OperationError('escritura-fallida')
    }
  }

  /** Relee la pestaña: exactamente una fila con el ID y con lo auditado (§6.1, paso 5). */
  private async verificar(cambio: Cambio) {
    const { tab, idCol } = ENTIDADES[cambio.entidad]
    const t = await this.releer(tab, 'verificacion-fallida')
    const filas = t.filas.filter((f) => texto(t, f, idCol) === cambio.id)
    if (filas.length > 1) throw new OperationError('conflicto-concurrente')
    if (filas.length !== 1 || !Object.entries(cambio.despues).every(([c, v]) => iguales(valor(t, filas[0]!, c), v))) {
      throw new OperationError('verificacion-fallida')
    }
  }
}

/** ORD-POS-149 (§16.3): datos para pasar a `RECIBIDA` (los visibles de «Recibir») y, además, el plazo para `ELEGIDA`. */
export const REQUISITOS_RECIBIDA = ['PRECIO_UNIT', 'MONEDA', 'MOQ', 'INCOTERM'] as const
export const REQUISITOS_ELEGIDA = [...REQUISITOS_RECIBIDA, 'PLAZO_PRODUCCION_DIAS'] as const
/** ORD-POS-149 (criterio 3): días entre la solicitud y la respuesta esperada. */
export const DIAS_RESPUESTA = 7
/** Separador de las entradas de `PRECIO_HISTORIAL` (una sola línea por celda). */
export const SEPARADOR_HISTORIAL = ' | '

/**
 * ORD-POS-149 (criterio 5): `PRECIO_HISTORIAL` + la entrada del precio que se reemplaza, con su fecha, moneda, unidad e
 * incoterm (p. ej. «2026-11-07: 10.59 USD por SET DDP»). Solo agrega al final; nunca borra entradas anteriores.
 */
export function entradaHistorial(previo: string, hoy: string, actual: Registro): string {
  const partes = [celdaTexto(actual.PRECIO_UNIT), celdaTexto(actual.MONEDA)]
  if (celdaTexto(actual.PRECIO_POR)) partes.push(`por ${celdaTexto(actual.PRECIO_POR)}`)
  if (celdaTexto(actual.INCOTERM)) partes.push(celdaTexto(actual.INCOTERM))
  const entrada = `${hoy}: ${partes.filter(Boolean).join(' ')}`
  return previo ? `${previo}${SEPARADOR_HISTORIAL}${entrada}` : entrada
}

/** §3.3: `SOLICITADA` → `RECIBIDA` → `ELEGIDA`, o `RECHAZADA` desde cualquiera. */
const TRANSICIONES_COTIZACION: Record<string, readonly string[]> = {
  SOLICITADA: ['RECIBIDA', 'RECHAZADA'],
  RECIBIDA: ['ELEGIDA', 'RECHAZADA'],
  ELEGIDA: ['RECHAZADA'],
}

/** §3.4: `PLANEADO` → `PAGADO` → `EN_TRANSITO` → `RECIBIDO_FBA`, o `CANCELADO` antes de recibir. */
const TRANSICIONES_EMBARQUE: Record<string, readonly string[]> = {
  PLANEADO: ['PAGADO', 'CANCELADO'],
  PAGADO: ['EN_TRANSITO', 'CANCELADO'],
  EN_TRANSITO: ['RECIBIDO_FBA', 'CANCELADO'],
}
