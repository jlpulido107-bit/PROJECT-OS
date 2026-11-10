import { todayInMerida } from '../dates'
import { MAX_DATA_ROWS } from '../schema'
import type { WriteTab } from './constants'
import { OperationError } from './errors'
import type { TableStore } from './table-store'

/** Pestaña lógica de la auditoría y prefijo de sus pestañas físicas por periodo (ORD-POS-153). */
export const AUDITORIA = 'AUDITORIA'
const NOMBRE_FISICO = /^AUDITORIA(?:_(\d{4})_(\d{2})(?:_(\d+))?)?$/

/**
 * Acceso a las pestañas FÍSICAS de la auditoría (AUDITORIA y AUDITORIA_AAAA_MM[_N]), que implementan los dos adaptadores.
 * Solo lo usa AuditoriaPorPeriodo; el servicio sigue hablando de la pestaña lógica `AUDITORIA`.
 */
export interface PestanasAuditoria {
  /** Títulos de las pestañas de la hoja que son de auditoría (cualquier orden). */
  pestanasAuditoria(): Promise<string[]>
  leerPestanaAuditoria(nombre: string): Promise<string[][]>
  agregarAPestanaAuditoria(nombre: string, rows: string[][]): Promise<void>
  /**
   * Migración explícita de la rotación: crea la pestaña con `encabezado` en la fila 1. Idempotente: si ya existe con
   * ese encabezado no hace nada; si existe vacía pone el encabezado; con otro encabezado falla. Nunca toca otra pestaña.
   */
  crearPestanaAuditoria(nombre: string, encabezado: readonly string[]): Promise<void>
}

export function tienePestanasAuditoria(store: TableStore): store is TableStore & PestanasAuditoria {
  return typeof (store as Partial<PestanasAuditoria>).crearPestanaAuditoria === 'function'
}

export function esPestanaAuditoria(nombre: string): boolean {
  return NOMBRE_FISICO.test(nombre)
}

/** Clave de orden: AUDITORIA (base) primero, luego por año, mes y número de rotación dentro del mes. */
function clave(nombre: string): [number, number, number] {
  const m = NOMBRE_FISICO.exec(nombre)
  if (!m || m[1] === undefined) return [0, 0, 0]
  return [Number(m[1]), Number(m[2]), m[3] === undefined ? 1 : Number(m[3])]
}

/** Pestañas de auditoría de la más vieja a la vigente. */
export function ordenarPestanasAuditoria(nombres: string[]): string[] {
  return nombres.filter(esPestanaAuditoria).sort((a, b) => comparar(clave(a), clave(b)))
}

function comparar(x: [number, number, number], y: [number, number, number]): number {
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}

/**
 * Nombre de la pestaña siguiente: AUDITORIA_AAAA_MM del mes de `now` en Mérida; si ya existe (otra rotación en el mismo
 * mes), AUDITORIA_AAAA_MM_2, _3… Nunca repite un nombre existente ni va antes de la vigente.
 */
export function siguientePestanaAuditoria(existentes: string[], now: Date): string {
  const [anio, mes] = todayInMerida(now).split('-') as [string, string]
  const base = `${AUDITORIA}_${anio}_${mes}`
  const vigente = ordenarPestanasAuditoria(existentes).at(-1)
  const posterior = (nombre: string) => !vigente || comparar(clave(nombre), clave(vigente)) > 0
  let candidato = base
  // Un mes de la vigente posterior al reloj (desfase) agota los intentos: la rotación falla cerrada.
  for (let n = 2; existentes.includes(candidato) || !posterior(candidato); n += 1) {
    if (n > 999) throw new OperationError('auditoria-fallida')
    candidato = `${base}_${n}`
  }
  return candidato
}

interface Activa {
  nombre: string
  encabezado: string[]
  filas: number
  existentes: string[]
  /** Pestaña de periodo vacía (sin encabezado ni filas) de una rotación que no terminó: la siguiente rotación la reusa. */
  pendiente?: string
}

const vacia = (values: string[][]) => values.every((row) => row.every((c) => c.trim() === ''))

/**
 * AUDITORIA por periodo (ORD-POS-153, DIS-01). Envoltorio del almacén que hace de `AUDITORIA` una pestaña lógica:
 * - Lectura: la pestaña vigente (la más nueva) y la anterior, en orden, con un solo encabezado. Las dos deben tener el
 *   encabezado idéntico; si no, `esquema-invalido`. Así la idempotencia por requestId, la reconciliación, /agentes,
 *   Inicio y /metricas ven un requestId auditado justo antes del cambio de pestaña.
 * - Escritura: si las filas nuevas caben en la vigente (MAX_DATA_ROWS), van ahí. Si no, se crea la siguiente
 *   AUDITORIA_AAAA_MM con el encabezado de la vigente (migración idempotente), se relee y se escribe ahí. La anterior no
 *   se toca. Si no se puede crear o leer la nueva, 503 `pestana-llena` sin escribir nada (fallo cerrado, como antes).
 * Las demás pestañas pasan sin cambios.
 */
export class AuditoriaPorPeriodo implements TableStore {
  readonly kind: TableStore['kind']
  private activa: Activa | null = null
  private rotada: string | null = null
  private escrita: { nombre: string; filas: number } | null = null

  constructor(private readonly inner: TableStore & PestanasAuditoria, private readonly clock: () => Date = () => new Date()) {
    this.kind = inner.kind
  }

  /** Empieza una operación: olvida la pestaña vigente leída y lo escrito en la anterior. */
  reiniciar() {
    this.activa = null
    this.rotada = null
    this.escrita = null
  }

  /** Pestaña física donde escribió la operación en curso, con sus filas, y si la creó (rotó) en ella. */
  ultimaEscritura(): { pestana: string; filas: number; rotada: boolean } | null {
    return this.escrita ? { pestana: this.escrita.nombre, filas: this.escrita.filas, rotada: this.rotada === this.escrita.nombre } : null
  }

  private async listar(): Promise<string[]> {
    let nombres: string[]
    try {
      nombres = await this.inner.pestanasAuditoria()
    } catch {
      throw new OperationError('lectura-fallida')
    }
    return ordenarPestanasAuditoria(nombres)
  }

  /** La pestaña base AUDITORIA se lee y se escribe como siempre; las de periodo, por el puerto. */
  private leer(nombre: string): Promise<string[][]> {
    return nombre === AUDITORIA ? this.inner.readTable(AUDITORIA) : this.inner.leerPestanaAuditoria(nombre)
  }

  private agregar(nombre: string, rows: string[][]): Promise<void> {
    return nombre === AUDITORIA ? this.inner.appendRows(AUDITORIA, rows) : this.inner.agregarAPestanaAuditoria(nombre, rows)
  }

  async readTable(tab: WriteTab): Promise<string[][]> {
    if (tab !== AUDITORIA) return this.inner.readTable(tab)
    const existentes = await this.listar()
    let vigente = existentes.at(-1)
    // Sin ninguna pestaña de auditoría, el adaptador responde como siempre (esquema-invalido).
    if (!vigente) return this.inner.readTable(tab)
    let actual = await this.leer(vigente)
    let pendiente: string | undefined
    let previas = existentes.slice(0, -1)
    // Una rotación que creó la pestaña pero no le puso encabezado no bloquea: se lee la de antes y se reusa al rotar.
    if (vigente !== AUDITORIA && vacia(actual) && previas.length > 0) {
      pendiente = vigente
      vigente = previas.at(-1)!
      previas = previas.slice(0, -1)
      actual = await this.leer(vigente)
    }
    const encabezado = actual[0] ?? []
    this.activa = { nombre: vigente, encabezado, filas: Math.max(actual.length - 1, 0), existentes, ...(pendiente ? { pendiente } : {}) }
    const previa = previas.at(-1)
    if (!previa) return actual
    const anterior = await this.leer(previa)
    if (!mismoEncabezado(anterior[0] ?? [], encabezado)) throw new OperationError('esquema-invalido', { detail: { tab: AUDITORIA } })
    return [encabezado, ...anterior.slice(1), ...actual.slice(1)]
  }

  async appendRows(tab: WriteTab, rows: string[][]): Promise<void> {
    if (tab !== AUDITORIA) return this.inner.appendRows(tab, rows)
    if (!this.activa) await this.readTable(AUDITORIA)
    const activa = this.activa
    if (!activa) throw new OperationError('esquema-invalido')
    let destino = activa.nombre
    let filas = activa.filas
    if (filas + rows.length > MAX_DATA_ROWS) {
      if (rows.length > MAX_DATA_ROWS) throw llena(activa.nombre)
      destino = await this.rotar(activa)
      filas = 0
    }
    await this.agregar(destino, rows)
    filas += rows.length
    if (destino !== activa.nombre) {
      const existentes = activa.existentes.includes(destino) ? activa.existentes : [...activa.existentes, destino]
      this.activa = { nombre: destino, encabezado: activa.encabezado, filas, existentes }
    } else {
      activa.filas = filas
    }
    this.escrita = { nombre: destino, filas }
  }

  async writeRow(tab: WriteTab, sheetRow: number, row: string[]): Promise<void> {
    // La auditoría solo se agrega; nunca se sobrescribe una fila suya.
    if (tab === AUDITORIA) throw new OperationError('esquema-invalido')
    return this.inner.writeRow(tab, sheetRow, row)
  }

  /** Crea la pestaña siguiente con el encabezado de la vigente y comprueba que quedó vacía y con ese encabezado. */
  private async rotar(activa: Activa): Promise<string> {
    let nombre = ''
    try {
      nombre = activa.pendiente ?? siguientePestanaAuditoria(activa.existentes, this.clock())
      await this.inner.crearPestanaAuditoria(nombre, activa.encabezado)
      const nueva = await this.inner.leerPestanaAuditoria(nombre)
      if (!mismoEncabezado(nueva[0] ?? [], activa.encabezado) || nueva.length > 1) throw new Error('pestaña nueva no válida')
    } catch {
      // Sin pestaña nueva comprobada no se escribe nada: el mismo 503 de antes, con la pestaña llena.
      throw llena(activa.nombre, nombre || undefined)
    }
    this.rotada = nombre
    return nombre
  }
}

function mismoEncabezado(a: string[], b: string[]): boolean {
  const recortar = (r: string[]) => { const x = r.map((c) => c.trim()); while (x.length && x.at(-1) === '') x.pop(); return x }
  const [x, y] = [recortar(a), recortar(b)]
  return x.length === y.length && x.every((c, i) => c === y[i])
}

function llena(pestana: string, nueva?: string) {
  return new OperationError('pestana-llena', {
    detail: { pestana, limite: MAX_DATA_ROWS, ...(nueva ? { rotacion: 'fallida', pestanaNueva: nueva } : {}) },
  })
}
