import { daysBetween } from './dates'
import { marcaDe, type Marca } from './inicio'
import type { Bloque } from './planificacion-semana'
import { COMPLETED_STATE } from './schema'
import type { Dataset, Hito } from './types'

/**
 * Hitos de la capa Semana (ORD-POS-121, POS-040; docs/diseno-planificacion-v2.md §5). Se calculan en el servidor sobre
 * HITOS y TAREAS que /planificacion ya lee (solo lectura): no dependen del escenario de simulación. Sin HITOS o TAREAS
 * legibles, `sin-datos`; un hito sin tareas dice «avance no medible», nunca «0 de 0».
 */

export interface HitoSemana {
  id: string
  /** Nombre junto al ID (regla de lenguaje, §2): «Nombre · ID». */
  texto: string
  fecha: string | null
  /** Días hasta la fecha objetivo (negativo si ya pasó); `null` sin fecha. */
  dias: number | null
  marca: Marca
  completadas: number
  /** Tareas del hito sin contar las CANCELADO. */
  total: number
  /** «avance 6 de 9 tareas» o «avance no medible» si el hito no tiene tareas. */
  avance: string
}

/**
 * atajo: helper local hasta que F1 (ORD-POS-120) fusione `etiqueta` (§2); sustituirlo por `etiqueta` entonces. Nombre
 * primero y el ID después; sin nombre, el marcador de §2.
 */
export function textoHito(h: Pick<Hito, 'id' | 'nombre'>): string {
  const nombre = h.nombre?.trim()
  return `${nombre ? nombre : '(hito sin nombre)'} · ${h.id}`
}

const legible = (ds: Pick<Dataset, 'tabs'>, tab: 'HITOS' | 'TAREAS') => ds.tabs[tab]?.ok === true && !ds.tabs[tab]?.truncated

/** Hitos abiertos (ni COMPLETADO ni CANCELADO), con días restantes y avance, primero el que vence antes. */
export function hitosSemana(ds: Pick<Dataset, 'tabs' | 'hitos' | 'tareas'>, hoy: string): Bloque<HitoSemana[]> {
  if (!legible(ds, 'HITOS')) return { estado: 'sin-datos', motivo: 'La pestaña HITOS no se pudo leer completa.' }
  if (!legible(ds, 'TAREAS')) return { estado: 'sin-datos', motivo: 'La pestaña TAREAS no se pudo leer completa: sin avance de los hitos.' }
  return {
    estado: 'ok',
    datos: ds.hitos
      .filter((h) => h.estado !== COMPLETED_STATE && h.estado !== 'CANCELADO')
      .map((h): HitoSemana => {
        const deHito = ds.tareas.filter((t) => t.hitoId === h.id && t.estado !== 'CANCELADO')
        const completadas = deHito.filter((t) => t.estado === COMPLETED_STATE).length
        const dias = h.fechaObjetivo ? daysBetween(hoy, h.fechaObjetivo) : null
        return {
          id: h.id,
          texto: textoHito(h),
          fecha: h.fechaObjetivo,
          dias,
          marca: dias === null ? null : marcaDe(dias),
          completadas,
          total: deHito.length,
          avance: deHito.length === 0 ? 'avance no medible' : `avance ${completadas} de ${deHito.length} tareas`,
        }
      })
      .sort((a, b) => (a.fecha ?? '9999').localeCompare(b.fecha ?? '9999') || a.id.localeCompare(b.id)),
  }
}
