import { MAX_DATA_ROWS } from '../schema'
import type { WriteTab } from './constants'
import { OperationError } from './errors'
import type { TableStore } from './table-store'

/** Filas de datos desde las que la respuesta ok avisa (80 % de MAX_DATA_ROWS, ORD-POS-143). */
export const FILAS_AVISO = Math.ceil(MAX_DATA_ROWS * 0.8)

/**
 * Límite de filas de la hoja maestra (ORD-POS-143). El lector pide encabezado + MAX_DATA_ROWS + 1 fila centinela y
 * falla con `lectura-fallida`/`limite-filas` si una pestaña pasa de MAX_DATA_ROWS: una escritura que la llevara más
 * allá bloquearía todas las siguientes. Este envoltorio cuenta las filas de datos de cada pestaña leída o escrita en la
 * operación en curso y:
 * - antes de la primera escritura, falla cerrado (503 `pestana-llena`, sin escribir nada, ni AUDITORIA) si alguna
 *   pestaña leída ya está en el tope, y antes de cada alta si la pestaña lo pasaría;
 * - al terminar, `aviso()` nombra las pestañas escritas que quedaron en el 80 % o más, para la respuesta ok.
 * Las filas se archivan a mano, nunca por la API (docs/escritura-v1-8.md §12).
 *
 * AUDITORIA queda fuera de este tope desde ORD-POS-153: es una pestaña lógica (la vigente y la anterior) que, en el tope,
 * sigue en una pestaña nueva AUDITORIA_AAAA_MM (auditoria-periodo.ts), así que llena nunca bloquea las escrituras.
 */
export class ContadorFilas implements TableStore {
  readonly kind: TableStore['kind']
  private readonly filas = new Map<WriteTab, number>()
  private readonly escritas = new Set<WriteTab>()
  /** Ya se escribió algo en la operación (AUDITORIA incluida). */
  private escribio = false

  constructor(private readonly inner: TableStore) {
    this.kind = inner.kind
  }

  /** Empieza una operación: olvida lo contado en la anterior. */
  reiniciar() {
    this.filas.clear()
    this.escritas.clear()
    this.escribio = false
  }

  async readTable(tab: WriteTab): Promise<string[][]> {
    const values = await this.inner.readTable(tab)
    if (tab !== 'AUDITORIA') this.filas.set(tab, Math.max(values.length - 1, 0))
    return values
  }

  async appendRows(tab: WriteTab, rows: string[][]): Promise<void> {
    this.comprobarTope(tab, rows.length)
    await this.inner.appendRows(tab, rows)
    this.escribio = true
    if (tab === 'AUDITORIA') return
    this.escritas.add(tab)
    const antes = this.filas.get(tab)
    if (antes !== undefined) this.filas.set(tab, antes + rows.length)
  }

  async writeRow(tab: WriteTab, sheetRow: number, row: string[]): Promise<void> {
    this.comprobarTope(tab, 0)
    await this.inner.writeRow(tab, sheetRow, row)
    this.escribio = true
    this.escritas.add(tab)
  }

  /** Aviso para la respuesta ok, o undefined si ninguna pestaña escrita llegó al 80 %. */
  aviso(): string | undefined {
    const casi = [...this.escritas].filter((tab) => (this.filas.get(tab) ?? 0) >= FILAS_AVISO)
    if (casi.length === 0) return undefined
    return `${casi.join(', ')} ${casi.length === 1 ? 'pasa' : 'pasan'} del 80 % del límite de ${MAX_DATA_ROWS} filas: archívala a mano (docs/escritura-v1-8.md §12) antes de que se bloquee la escritura.`
  }

  private comprobarTope(tab: WriteTab, nuevas: number) {
    // Antes de la primera escritura (la de AUDITORIA, casi siempre) ninguna otra pestaña leída puede estar en el tope.
    if (!this.escribio) {
      for (const [leida, n] of this.filas) if (n >= MAX_DATA_ROWS) throw llena(leida)
    }
    // AUDITORIA no tiene tope propio aquí: rota por periodo (auditoria-periodo.ts).
    if (tab === 'AUDITORIA') return
    const actuales = this.filas.get(tab)
    if (actuales !== undefined && actuales + nuevas > MAX_DATA_ROWS) throw llena(tab)
  }
}

function llena(pestana: WriteTab) {
  return new OperationError('pestana-llena', { detail: { pestana, limite: MAX_DATA_ROWS } })
}
