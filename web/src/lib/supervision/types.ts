/**
 * Tipos del motor de supervisión automática (contrato §2, §4, §5).
 * Solo describen estados, eventos y contexto: no hay efectos (fusionar, desplegar, cerrar tareas o cambiar
 * ORDENES_CODEX) en estos tipos. Contrato: docs/contrato-supervision-automatica.md.
 */

/** Los 8 estados de supervisión (docs/migracion-supervision.md). No sustituyen los estados de la orden. */
export const ESTADOS = [
  'PENDIENTE', 'EN_REVISION', 'CAMBIOS_SOLICITADOS', 'CORRIGIENDO',
  'APROBADO_TECNICAMENTE', 'DESACTUALIZADO', 'BLOQUEADO', 'ESCALADO',
] as const
export type Estado = (typeof ESTADOS)[number]

export type Veredicto = 'CONFORME' | 'CAMBIOS' | 'INCONCLUSO'

/** Qué cambió: head, base, hash de criterios o versión de política. */
export type CambioVigencia = 'HEAD' | 'BASE' | 'CRITERIOS' | 'POLITICA'

/** Estado de supervisión de un PR. `estado: null` = aún no registrado. */
export interface EstadoActual {
  estado: Estado | null
  /** Estado previo a `BLOQUEADO`, para volver tras reconciliar. */
  estadoAnterior: Estado | null
  /** El PR se fusionó: el ciclo terminó (el estado queda como histórico). */
  cicloTerminado: boolean
}

/** Eventos del contrato. El reporte llega ya validado (validarlo es otra orden). */
export type Evento =
  | { tipo: 'PR_REGISTRADO' }
  | { tipo: 'RESERVA_PERSISTIDA' }
  | { tipo: 'REPORTE'; veredicto: Veredicto; headSha: string }
  /** El coordinador pide enviar la solicitud de corrección (§3.3): aquí se evalúan las condiciones de salida. */
  | { tipo: 'CORRECCION_ENVIADA' }
  | { tipo: 'ENTREGA_CORRECCION'; headSha: string; mismoPrYRama: boolean }
  | { tipo: 'CAMBIO'; que: CambioVigencia; headSha?: string }
  /** Fallo técnico o lanzamiento desconocido (timeout ambiguo, fallo de registro): no consume ronda. */
  | { tipo: 'FALLO_TECNICO' }
  | { tipo: 'NUEVA_REVISION' }
  | { tipo: 'RECONCILIACION'; resultado: 'RECONCILIADA' | 'IMPOSIBLE' }
  | { tipo: 'ORDEN_CANCELADA' }
  | { tipo: 'PR_CERRADO_SIN_FUSION' }
  | { tipo: 'PR_FUSIONADO' }

export type TipoEvento = Evento['tipo']

/** Datos que necesitan las condiciones; los inyecta quien llama (el motor no lee nada). */
export interface Contexto {
  /** Ronda de corrección ya entregada: 0 = revisión inicial; 1 y 2 = correcciones. */
  ronda: number
  /** Head vigente registrado del PR. */
  headVigente: string
  autorizacionCorreccion: boolean
  presupuestoDisponible: boolean
  comprobacionesRequeridasTerminadas: boolean
  hallazgosDentroDeAlcance: boolean
  desacuerdoRepetido: boolean
}

export interface Resultado {
  estado: Estado | null
  estadoAnterior: Estado | null
  cicloTerminado: boolean
  ronda: number
  /** Motivo corto, legible. */
  motivo: string
  /** El evento solo se guarda como histórico: no cambió el estado de supervisión. */
  soloHistorico: boolean
}
