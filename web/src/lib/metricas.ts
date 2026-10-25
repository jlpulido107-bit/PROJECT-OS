import { addDays, parseTimestamp } from './dates'
import { parseAudit } from './operations/service'
import { cell, type TableView } from './operations/table-store'
import type { Orden } from './types'

/**
 * Métricas de entrega del sistema (/metricas, ORD-POS-072, POS-021). Cálculo puro sobre ORDENES_CODEX y AUDITORIA:
 * no escribe ni infiere estados. Solo cuentan las operaciones del dashboard con integridad completa en AUDITORIA.
 * - Fusionada: cierre con `orden.cerrar_fusionado` (el servidor comprobó en GitHub el PR fusionado). Un cierre manual
 *   (`orden.cerrar`, «PR fusionado o cerrado con decisión») se cuenta aparte: la hoja no dice si hubo fusión.
 * - Ciclo: de `orden.crear` (BORRADOR) al cierre (CERRADA), en días. Sin alta en AUDITORIA no hay ciclo.
 * - Rondas de corrección: lanzamientos de `orden.corregir_lanzar` con sesión, uno por CLAVE (paso).
 * Cada semana (lunes, hora de Mérida) agrupa las órdenes cerradas en ella.
 */

export const RIESGOS = ['BAJO', 'MEDIO', 'ALTO'] as const
export type Riesgo = (typeof RIESGOS)[number] | 'SIN_RIESGO'

export interface Cierre {
  epochMs: number
  fecha: string
  fusion: 'confirmada' | 'sin-confirmar'
}

export interface EventosOrden {
  id: string
  riesgo: Riesgo
  creadaMs: number | null
  /** Primer envío (`orden.enviar` → ENVIADA) en AUDITORIA, o null (ORD-POS-078). */
  enviadaMs: number | null
  cierre: Cierre | null
  /** Última cancelación (`orden.cancelar` → CANCELADA) si la orden sigue CANCELADA en la hoja, o null (ORD-POS-096). */
  canceladaMs: number | null
  rondas: number
}

export interface Ciclo {
  n: number
  medianaDias: number | null
  p90Dias: number | null
}

export interface MetricaSemana {
  /** Lunes de la semana (YYYY-MM-DD). */
  semana: string
  fusionadas: number
  cerradasSinConfirmar: number
  ciclo: Ciclo
  rondas: { total: number; promedio: number | null }
  porRiesgo: Record<Riesgo, number>
}

export interface Metricas {
  semanas: MetricaSemana[]
  /** CERRADA en ORDENES_CODEX sin cierre auditado (p. ej. cerradas antes de AUDITORIA o a mano en la hoja). */
  cerradasSinAuditoria: string[]
  /** Cerradas con cierre auditado pero sin alta en AUDITORIA: no tienen ciclo. */
  sinAlta: string[]
  eventos: EventosOrden[]
}

const DIA_MS = 86_400_000

export function riesgoDe(raw: string | null): Riesgo {
  return (RIESGOS as readonly string[]).includes(raw ?? '') ? (raw as Riesgo) : 'SIN_RIESGO'
}

/** Lunes de la semana de una fecha civil. */
export function lunesDe(fecha: string): string {
  const [y, m, d] = fecha.split('-').map(Number) as [number, number, number]
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return addDays(fecha, -((dow + 6) % 7))
}

/** Mediana y p90 (rango más cercano) de una lista de valores; null si está vacía. */
export function percentil(valores: number[], p: number): number | null {
  if (valores.length === 0) return null
  const orden = [...valores].sort((a, b) => a - b)
  if (p === 50 && orden.length % 2 === 0) return (orden[orden.length / 2 - 1]! + orden[orden.length / 2]!) / 2
  return orden[Math.max(0, Math.ceil((p / 100) * orden.length) - 1)]!
}

const redondea = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10)

/** Eventos de cada orden de ORDENES_CODEX a partir de AUDITORIA. */
export function eventosOrdenes(ordenes: Orden[], audit: TableView): EventosOrden[] {
  const ops = parseAudit(audit).filter((o) => o.integridad === 'completa' && o.entidad === 'ORDENES_CODEX')
  const fecha = (order: number) => {
    const row = audit.rows[order]
    return row ? parseTimestamp(cell(audit, row.cells, 'FECHA_HORA')).value : null
  }
  return ordenes.map((o) => {
    const propias = ops.filter((op) => op.id === o.id)
    const alta = propias.find((op) => op.operacion === 'orden.crear' && op.fields.get('ESTADO')?.despues === 'BORRADOR')
    const envio = propias.find((op) => op.operacion === 'orden.enviar' && op.fields.get('ESTADO')?.despues === 'ENVIADA')
    const ultimoCierre = propias.filter((op) => /^orden\.cerrar(_fusionado)?$/.test(op.operacion) && op.fields.get('ESTADO')?.despues === 'CERRADA').at(-1)
    const tCierre = ultimoCierre ? fecha(ultimoCierre.order) : null
    // Solo cuenta el cierre si la orden sigue CERRADA en la hoja.
    const cierre: Cierre | null = tCierre && o.estado === 'CERRADA'
      ? { epochMs: tCierre.epochMs, fecha: tCierre.date, fusion: ultimoCierre!.operacion === 'orden.cerrar_fusionado' ? 'confirmada' : 'sin-confirmar' }
      : null
    const ultimaCancelacion = propias.filter((op) => op.operacion === 'orden.cancelar' && op.fields.get('ESTADO')?.despues === 'CANCELADA').at(-1)
    const canceladaMs = ultimaCancelacion && o.estado === 'CANCELADA' ? fecha(ultimaCancelacion.order)?.epochMs ?? null : null
    const claves = new Set(propias
      .filter((op) => op.operacion === 'orden.corregir_lanzar' && op.fields.get('SESION')?.despues)
      .map((op) => op.fields.get('CLAVE')?.despues || op.requestId))
    return { id: o.id, riesgo: riesgoDe(o.riesgo), creadaMs: alta ? fecha(alta.order)?.epochMs ?? null : null,
      enviadaMs: envio ? fecha(envio.order)?.epochMs ?? null : null, cierre, canceladaMs, rondas: claves.size }
  })
}

export function metricas(ordenes: Orden[], audit: TableView): Metricas {
  const eventos = eventosOrdenes(ordenes, audit)
  const cerradas = eventos.filter((e) => e.cierre)
  const porSemana = new Map<string, EventosOrden[]>()
  for (const e of cerradas) {
    const s = lunesDe(e.cierre!.fecha)
    porSemana.set(s, [...(porSemana.get(s) ?? []), e])
  }
  const semanas = [...porSemana.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([semana, es]): MetricaSemana => {
    const dias = es.flatMap((e) => (e.creadaMs !== null && e.cierre!.epochMs >= e.creadaMs ? [(e.cierre!.epochMs - e.creadaMs) / DIA_MS] : []))
    const total = es.reduce((s, e) => s + e.rondas, 0)
    const porRiesgo: Record<Riesgo, number> = { BAJO: 0, MEDIO: 0, ALTO: 0, SIN_RIESGO: 0 }
    for (const e of es) porRiesgo[e.riesgo]++
    return {
      semana,
      fusionadas: es.filter((e) => e.cierre!.fusion === 'confirmada').length,
      cerradasSinConfirmar: es.filter((e) => e.cierre!.fusion === 'sin-confirmar').length,
      ciclo: { n: dias.length, medianaDias: redondea(percentil(dias, 50)), p90Dias: redondea(percentil(dias, 90)) },
      rondas: { total, promedio: redondea(total / es.length) },
      porRiesgo,
    }
  })
  const conCierre = new Set(cerradas.map((e) => e.id))
  return {
    semanas,
    cerradasSinAuditoria: ordenes.filter((o) => o.estado === 'CERRADA' && !conCierre.has(o.id)).map((o) => o.id),
    sinAlta: cerradas.filter((e) => e.creadaMs === null).map((e) => e.id),
    eventos,
  }
}
