import { TAB_HEADERS } from '../schema'

/**
 * Contrato de escritura V1.4 (docs/v1-4-write-contract.md). Encabezados exactos; no se crean columnas.
 * AUDITORIA no la lee el dashboard V1.2, por eso su encabezado vive aquí y no en `schema.ts`.
 */
export const WRITE_HEADERS = {
  TAREAS: TAB_HEADERS.TAREAS,
  TIEMPOS: TAB_HEADERS.TIEMPOS,
  DECISIONES: TAB_HEADERS.DECISIONES,
  PROYECTOS: TAB_HEADERS.PROYECTOS,
  HITOS: TAB_HEADERS.HITOS,
  ORDENES_CODEX: TAB_HEADERS.ORDENES_CODEX,
  AUDITORIA: [
    'AUDIT_ID', 'FECHA_HORA', 'ACTOR', 'ENTIDAD', 'REGISTRO_ID', 'CAMPO', 'VALOR_ANTES', 'VALOR_DESPUES', 'ORIGEN',
  ],
} as const

export type WriteTab = keyof typeof WRITE_HEADERS
export type EntityTab = 'TAREAS' | 'TIEMPOS' | 'DECISIONES' | 'ORDENES_CODEX'

/** Estados de tarea que el dashboard puede asignar. COMPLETADO/CANCELADO requieren aprobación humana (bloqueados). */
export const WRITABLE_TASK_STATES = ['PENDIENTE', 'EN_PROGRESO', 'BLOQUEADO'] as const
export const CLOSING_TASK_STATES = ['COMPLETADO', 'CANCELADO'] as const
export const INITIAL_TASK_STATE = 'PENDIENTE'
export const TASK_PRIORITIES = ['ALTA', 'MEDIA', 'BAJA'] as const
export const INITIAL_DECISION_STATE = 'PENDIENTE'

/** Sugerencias de TIPO observadas en la hoja real (la validación acepta cualquier código con el patrón). */
export const KNOWN_TASK_TYPES = ['TECNICO', 'SEGURIDAD', 'REVISION', 'DESARROLLO', 'AUTOMATIZACION', 'INTEGRACION']
export const KNOWN_WORK_TYPES = ['DESARROLLO', 'REVISION', 'INVESTIGACION', 'DOCUMENTACION', 'REUNION', 'OPERACION']

export const LIMITS = {
  bodyBytes: 16 * 1024,
  titulo: 160,
  descripcion: 2000,
  criterio: 1000,
  bloqueo: 500,
  responsable: 80,
  notas: 1000,
  asunto: 200,
  decision: 2000,
  justificacion: 2000,
  url: 500,
  horasMax: 1000,
  minutosMax: 960,
  diasAtras: 365,
  ordenTexto: 2000,
  motivo: 500,
} as const

export const ORIGIN_PREFIX = 'dashboard-v1.4'

export type OperationName =
  | 'tarea.crear' | 'tarea.editar' | 'tiempo.registrar' | 'decision.crear'
  | 'orden.crear' | 'orden.aprobar' | 'orden.cancelar' | 'orden.enviar' | 'orden.registrar_pr' | 'orden.revisar' | 'orden.cerrar'
  /** No escribe en la hoja: lanza la rutina de Claude (F5a). */
  | 'orden.ejecutar'
  /** No escriben en la entidad: lanzan una rutina de revisión o de corrección y dejan constancia en AUDITORIA (ORD-POS-037). */
  | 'orden.revisar_lanzar' | 'orden.corregir_lanzar'

/** Órdenes (V1.8 F3, docs/migracion-ordenes-codex.md). Desde el dashboard no se crean órdenes de riesgo ALTO. */
export const ORDER_RISKS = ['BAJO', 'MEDIO'] as const
export const INITIAL_ORDER_STATE = 'BORRADOR'
export const ORDER_TERMINAL_STATES = ['CERRADA', 'CANCELADA'] as const

/** Acceso del agente PM (DEC-POS-005, docs/escritura-v1-8.md): solo estas operaciones y solo estos campos de tarea. */
export const AGENT_ACTOR = 'agente-pm'
export const AGENT_OPERATIONS: readonly OperationName[] = ['tarea.crear', 'tarea.editar', 'decision.crear', 'orden.crear']
export const AGENT_EDITABLE_TASK_FIELDS = [
  'titulo', 'descripcion', 'prioridad', 'hitoId', 'fechaPlan', 'fechaLimite', 'horasEstimadas', 'criterioTerminado',
] as const
