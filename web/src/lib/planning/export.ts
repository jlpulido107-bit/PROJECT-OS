import { movimientos, sinFijadasVacias } from './scenario'
import type { PlanResult, Scenario } from './types'

/**
 * Exportación local de una propuesta revisada (archivo JSON en el dispositivo del usuario).
 * - Esquema versionado y campos minimizados: IDs, fechas y minutos. Sin títulos, nombres, correos ni notas.
 * - Es una PROPUESTA: nada la aplica automáticamente. Una fase futura autorizada podría convertir los
 *   elementos aceptados en filas de PLAN_DIARIO / PLAN_ITEMS (ver docs/planificacion-v1-5.md §6).
 */
export const EXPORT_SCHEMA = 'project-os.planificacion.propuesta/v1'
/**
 * v2 (ORD-POS-137) = v1 + movimientos simulados: `escenario.fijadas` (tarea → fecha) y `fijada: true` en cada elemento
 * de una tarea movida. Solo se usa cuando hay movimientos; sin ellos la exportación sigue siendo v1, idéntica.
 */
export const EXPORT_SCHEMA_V2 = 'project-os.planificacion.propuesta/v2'

export type ReviewDecision = 'pendiente' | 'aceptado' | 'rechazado' | 'ajustado'

export interface ReviewState {
  /** Clave `${fecha}|${tareaId}` → decisión y minutos ajustados (si aplica). */
  [key: string]: { decision: ReviewDecision; minutos?: number }
}

export interface ProposalExport {
  esquema: typeof EXPORT_SCHEMA | typeof EXPORT_SCHEMA_V2
  aviso: string
  semanaIso: string
  fechaReferencia: string
  zona: string
  huellaEntrada: string
  escenario: Scenario
  supuestos: string[]
  capacidad: { origen: string; netaMin: number | null; libreMin: number }
  elementos: Array<{
    fecha: string
    tareaId: string
    proyectoId: string | null
    orden: number
    minutosPropuestos: number
    decision: ReviewDecision
    minutosRevisados: number | null
    /** Solo en v2: la tarea se movió a este día en la simulación. */
    fijada?: true
  }>
}

export function reviewKey(fecha: string, tareaId: string): string {
  return `${fecha}|${tareaId}`
}

export function buildExport(plan: PlanResult, scenario: Scenario, review: ReviewState): ProposalExport {
  const v2 = movimientos(scenario) > 0
  return {
    esquema: v2 ? EXPORT_SCHEMA_V2 : EXPORT_SCHEMA,
    aviso: 'Propuesta simulada: no se guardó ni se aplicó en Google Sheets.',
    semanaIso: plan.referencia.semanaIso,
    fechaReferencia: plan.referencia.fecha,
    zona: plan.referencia.zona,
    huellaEntrada: plan.huella,
    escenario: sinFijadasVacias(scenario),
    supuestos: plan.supuestos,
    capacidad: { origen: plan.capacidad.origen, netaMin: plan.capacidad.netaMin, libreMin: plan.capacidad.libreMin },
    elementos: plan.dias.flatMap((d) => d.items.map((i) => {
      const r = review[reviewKey(d.fecha, i.tareaId)]
      const decision = r?.decision ?? 'pendiente'
      return {
        fecha: d.fecha,
        tareaId: i.tareaId,
        proyectoId: i.proyectoId,
        orden: i.orden,
        minutosPropuestos: i.minutos,
        decision,
        minutosRevisados: decision === 'ajustado' ? r?.minutos ?? null : decision === 'aceptado' ? i.minutos : decision === 'rechazado' ? 0 : null,
        ...(v2 && i.fijada ? { fijada: true as const } : {}),
      }
    })),
  }
}

/**
 * Punto de extensión para V1.4 (operaciones): borradores con la forma de PLAN_ITEMS a partir de los elementos
 * aceptados o ajustados (> 0 min). NO escribe, NO asigna IDs y NO se usa en la app: una fase futura autorizada
 * los pasaría por el servicio de operaciones (auditoría, validación, idempotencia) tras aprobación humana.
 */
export interface PlanItemDraft {
  fecha: string
  tareaId: string
  orden: number
  minutosPlan: number
}

export function acceptedDrafts(proposal: ProposalExport): PlanItemDraft[] {
  const drafts: PlanItemDraft[] = []
  const byDay = new Map<string, number>()
  for (const e of proposal.elementos) {
    if ((e.decision !== 'aceptado' && e.decision !== 'ajustado') || !e.minutosRevisados) continue
    const orden = (byDay.get(e.fecha) ?? 0) + 1
    byDay.set(e.fecha, orden)
    drafts.push({ fecha: e.fecha, tareaId: e.tareaId, orden, minutosPlan: e.minutosRevisados })
  }
  return drafts
}
