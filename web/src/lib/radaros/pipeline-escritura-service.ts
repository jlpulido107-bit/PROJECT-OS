import { randomBytes } from 'node:crypto'
import { civilDateInZone, parseCivilDate } from '../dates'
import { MAX_DATA_ROWS } from '../schema'
import { OperationError } from '../operations/errors'
import { meridaIsoTimestamp } from '../operations/time'
import { payloadHash } from '../operations/validation'
import { COLUMNAS_COTIZACIONES, COLUMNAS_EMBARQUES, COLUMNAS_PRODUCTOS, COLUMNAS_PROVEEDORES, ETAPAS, type Etapa } from './pipeline'
import { ECO_WRITE_TABS, type Celda, type EcoPipelineStore, type EcoWriteTab } from './pipeline-escritura-store'
import { COLUMNAS_NUMERICAS, type EcoComando, type MoverComando } from './pipeline-escritura-validacion'
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
  'eco.cotizacion.crear', 'eco.cotizacion.editar', 'eco.embarque.crear', 'eco.embarque.editar',
] as const
export type EcoOperationName = (typeof ECO_OPERATIONS)[number]

export type Entidad = 'producto' | 'proveedor' | 'cotizacion' | 'embarque'

/** §3: pestaña, columna de ID, prefijo y columnas que exige la escritura (todas las del diseño). */
export const ENTIDADES: Record<Entidad, { tab: EcoWriteTab; idCol: string; prefijo: string; columnas: readonly string[] }> = {
  producto: { tab: 'PIPE_PRODUCTOS', idCol: 'PRODUCTO_ID', prefijo: 'PRD', columnas: COLUMNAS_PRODUCTOS },
  proveedor: { tab: 'PIPE_PROVEEDORES', idCol: 'PROVEEDOR_ID', prefijo: 'PRV', columnas: COLUMNAS_PROVEEDORES },
  cotizacion: { tab: 'PIPE_COTIZACIONES', idCol: 'COTIZACION_ID', prefijo: 'COT', columnas: COLUMNAS_COTIZACIONES },
  embarque: { tab: 'PIPE_EMBARQUES', idCol: 'EMBARQUE_ID', prefijo: 'EMB', columnas: COLUMNAS_EMBARQUES },
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

function tabla(rows: unknown[][], columnas: readonly string[], pestana: string): Tabla {
  const header = (rows[0] ?? []).map(celdaTexto)
  const indice = new Map<string, number>()
  for (const [i, name] of header.entries()) {
    if (!name) continue
    if (indice.has(name)) throw new OperationError('eco-esquema-invalido', { detail: { pestana } })
    indice.set(name, i)
  }
  if (columnas.some((c) => !indice.has(c))) throw new OperationError('eco-esquema-invalido', { detail: { pestana } })
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

function columnasDe(tab: EcoWriteTab): readonly string[] {
  return tab === 'PIPE_AUDITORIA' ? COLUMNAS_AUDITORIA : Object.values(ENTIDADES).find((e) => e.tab === tab)!.columnas
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

  crearProveedor(cmd: EcoComando, ctx: EcoContext): Promise<EcoResultado> {
    return this.crear('eco.proveedor.crear', 'proveedor', cmd, ctx, (_libro, r) => ({ ...r, ESTADO: 'ACTIVO' }))
  }

  editarProveedor(id: string, cmd: EcoComando, ctx: EcoContext): Promise<EcoResultado> {
    return this.editar('eco.proveedor.editar', 'proveedor', id, cmd, ctx, () => undefined)
  }

  /* -------------------------------------- Cotizaciones -------------------------------------- */

  crearCotizacion(cmd: EcoComando, ctx: EcoContext): Promise<EcoResultado> {
    return this.crear('eco.cotizacion.crear', 'cotizacion', cmd, ctx, (libro, r) => {
      this.productoAbierto(libro, String(r.PRODUCTO_ID))
      if (!this.filas(libro, 'proveedor').some((f) => texto(libro.PIPE_PROVEEDORES, f, 'PROVEEDOR_ID') === r.PROVEEDOR_ID)) {
        throw new OperationError('referencia-inexistente', { fields: { proveedorId: 'No existe.' } })
      }
      const registro = { ...r, ESTADO: 'SOLICITADA', MUESTRA_ESTADO: r.MUESTRA_ESTADO || 'NO_PEDIDA' }
      this.fechas('cotizacion', registro)
      return registro
    })
  }

  editarCotizacion(id: string, cmd: EcoComando, ctx: EcoContext): Promise<EcoResultado> {
    return this.editar('eco.cotizacion.editar', 'cotizacion', id, cmd, ctx, (libro, merged, actual) => {
      this.productoAbierto(libro, celdaTexto(actual.PRODUCTO_ID))
      const desde = celdaTexto(actual.ESTADO)
      const a = celdaTexto(merged.ESTADO)
      if (a !== desde && !(TRANSICIONES_COTIZACION[desde] ?? []).includes(a)) throw new OperationError('transicion-no-permitida', { detail: { desde, a } })
      if (a === 'RECIBIDA' || a === 'ELEGIDA') {
        const faltan = ['PRECIO_UNIT', 'MONEDA', 'MOQ', 'PLAZO_PRODUCCION_DIAS', 'INCOTERM'].filter((col) => celdaTexto(merged[col]) === '')
        if (faltan.length) throw new OperationError('requisito-faltante', { detail: { requisito: faltan.join(',') } })
      }
      if (a === 'ELEGIDA' && desde !== 'ELEGIDA') {
        const c = libro.PIPE_COTIZACIONES
        const otra = c.filas.some((f) => texto(c, f, 'COTIZACION_ID') !== id && texto(c, f, 'PRODUCTO_ID') === celdaTexto(actual.PRODUCTO_ID) && texto(c, f, 'ESTADO') === 'ELEGIDA')
        if (otra) throw new OperationError('elegida-duplicada')
      }
      this.fechas('cotizacion', merged)
    })
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
    const { tab, idCol, columnas } = ENTIDADES[e]
    const t = libro[tab]
    const indices = t.filas.flatMap((f, i) => (texto(t, f, idCol) === id ? [i] : []))
    if (indices.length === 0) throw new OperationError('registro-inexistente')
    if (indices.length > 1) throw new OperationError('conflicto-concurrente')
    const fila = t.filas[indices[0]!]!
    const actual: Registro = {}
    for (const c of columnas) {
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
  ): Promise<EcoResultado> {
    return this.exclusive(async () => {
      const hash = payloadHash(op, cmd)
      const libro = await this.leer()
      const repetida = await this.replay(op, hash, cmd.requestId, libro)
      if (repetida) return repetida
      conCupo(libro)
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
    validar: (libro: Libro, merged: Registro, actual: Registro) => void,
  ): Promise<EcoResultado> {
    return this.exclusive(async () => {
      const hash = payloadHash(op, { ...cmd, id })
      const libro = await this.leer()
      const repetida = await this.replay(op, hash, cmd.requestId, libro)
      if (repetida) return repetida
      conCupo(libro)
      const { actual } = this.unica(libro, e, id)
      const version = this.versionDe(actual)
      if (version !== cmd.expectedVersion) throw new OperationError('conflicto-version', { detail: { version } })
      const despues: Registro = Object.fromEntries(Object.entries(cmd.valores).filter(([c, v]) => !iguales(actual[c], v) && !(v === '' && celdaTexto(actual[c]) === '')))
      if (!Object.keys(despues).length) throw new OperationError('sin-cambios')
      validar(libro, { ...actual, ...cmd.valores }, actual)
      return this.escribirEdicion(hash, cmd.requestId, ctx, op, e, id, actual, despues, libro, [])
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

  private async releer(tab: EcoWriteTab, error: 'lectura-fallida' | 'escritura-fallida' | 'verificacion-fallida'): Promise<Tabla> {
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
    const { tab, idCol, columnas } = ENTIDADES[e]
    const antes: Registro = {}
    const despues: Registro = {}
    for (const [campo, v] of a.campos) {
      if (!columnas.includes(campo)) continue
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
    const stamp = this.stamp()
    const compact = stamp.slice(0, 19).replace(/[-:T]/g, '')
    const lote = this.randomHex(4).toUpperCase()
    const alta = Object.keys(cambio.antes).length === 0
    const campos: Array<[string, string, string]> = [
      ...Object.entries(cambio.despues)
        .filter(([, v]) => !(alta && v === ''))
        .map(([c, v]): [string, string, string] => [c, celdaTexto(cambio.antes[c] ?? ''), String(v)]),
      ...cambio.extra.map(([c, v]): [string, string, string] => [c, '', v]),
    ]
    const total = String(campos.length).padStart(2, '0')
    const origen = `${ORIGIN_PREFIX};req=${requestId};hash=${hash}`
    const rows = campos.map(([campo, antes, despues], i) => libro.PIPE_AUDITORIA.header.map((h) => ({
      AUDIT_ID: `AUD-${compact}-${lote}-${String(i + 1).padStart(2, '0')}-${total}`,
      FECHA_HORA: stamp,
      ACTOR: ctx.actor,
      ENTIDAD: ENTIDADES[cambio.entidad].tab,
      REGISTRO_ID: cambio.id,
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
