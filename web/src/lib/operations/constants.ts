import { TAB_HEADERS, TAREAS_INSTRUCCIONES } from '../schema'

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
  /** ORD-POS-139 (DEC-POS-029 c): solo `capacidad.registrar` del propietario; VERSION es la migración de §11.2. */
  CAPACIDAD_SEMANAL: TAB_HEADERS.CAPACIDAD_SEMANAL,
  AUDITORIA: [
    'AUDIT_ID', 'FECHA_HORA', 'ACTOR', 'ENTIDAD', 'REGISTRO_ID', 'CAMPO', 'VALOR_ANTES', 'VALOR_DESPUES', 'ORIGEN',
  ],
} as const

export type WriteTab = keyof typeof WRITE_HEADERS

/**
 * Columnas opcionales del contrato (ORD-POS-105): no se exigen en los encabezados; si la hoja las tiene se leen, se
 * escriben y se verifican como las demás. Sin ellas, la pestaña se lee y se escribe igual que antes.
 */
export const OPTIONAL_WRITE_COLUMNS: Partial<Record<WriteTab, readonly string[]>> = {
  TAREAS: [TAREAS_INSTRUCCIONES],
  /**
   * ORD-POS-139: VERSION de CAPACIDAD_SEMANAL (migración de docs/escritura-v1-8.md §11.2, la aplica el propietario). Sin
   * ella la pestaña se lee igual y `capacidad.registrar` responde 422 `migracion-pendiente` sin escribir nada.
   */
  CAPACIDAD_SEMANAL: ['VERSION'],
}
export type EntityTab = 'TAREAS' | 'TIEMPOS' | 'DECISIONES' | 'ORDENES_CODEX' | 'CAPACIDAD_SEMANAL'

/**
 * Estados de tarea que la edición puede asignar. COMPLETADO/CANCELADO no se asignan editando: COMPLETADO solo con la
 * operación 'tarea.completar' del propietario (DEC-POS-023, inerte sin TAREAS_CIERRE_PROPIETARIO); CANCELADO nunca.
 */
export const WRITABLE_TASK_STATES = ['PENDIENTE', 'EN_PROGRESO', 'BLOQUEADO'] as const
export const CLOSING_TASK_STATES = ['COMPLETADO', 'CANCELADO'] as const
export const COMPLETED_TASK_STATE = 'COMPLETADO'
/** Campo de AUDITORIA sin columna en TAREAS: la nota opcional del cierre del propietario (ORD-POS-106). */
export const AUDIT_NOTA_CIERRE = 'NOTA_CIERRE'
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
  instrucciones: 4000,
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
  notaCierre: 500,
  /** ORD-POS-139: HORAS_DISPONIBLES de una semana (0–168) y RESERVA_PCT (0–100). */
  horasSemanaMax: 168,
  reservaPctMax: 100,
} as const

export const ORIGIN_PREFIX = 'dashboard-v1.4'

export type OperationName =
  | 'tarea.crear' | 'tarea.editar' | 'tiempo.registrar' | 'decision.crear'
  /** Alta de una fila de TIEMPOS por el agente PM (ORD-POS-112, DEC-POS-025), solo con TIEMPOS_AGENTE=true. */
  | 'tiempo.crear'
  /** Alta de una idea en PRODUCTS y SCORING de RADAROS por el agente PM (ORD-POS-131, DEC-ECO-007), solo con ECO_IDEAS_ALTA=true. */
  | 'idea.alta'
  /** Cierre de una tarea a COMPLETADO por el propietario (ORD-POS-106, DEC-POS-023). Nunca del agente PM. */
  | 'tarea.completar'
  /**
   * Alta o edición de la fila de una semana en CAPACIDAD_SEMANAL por el propietario (ORD-POS-139, DEC-POS-029 c). Solo
   * con PLANIFICACION_EDICION_PROPIETARIO y su correo; nunca un token (PM, Tiempos, finanzas). No está en AGENT_OPERATIONS.
   */
  | 'capacidad.registrar'
  | 'orden.crear' | 'orden.aprobar' | 'orden.cancelar' | 'orden.enviar' | 'orden.registrar_pr' | 'orden.revisar' | 'orden.cerrar'
  /** Cierre asistido de una orden cuyo PR ya se fusionó (ORD-POS-046). */
  | 'orden.cerrar_fusionado'
  /** No escribe en la hoja: lanza la rutina de Claude (F5a). */
  | 'orden.ejecutar'
  /** No escriben en la entidad: lanzan una rutina de revisión o de corrección y dejan constancia en AUDITORIA (ORD-POS-037). */
  | 'orden.revisar_lanzar' | 'orden.corregir_lanzar'
  /** Reserva auditada antes de lanzar una revisión o corrección (ORD-POS-039) y su liberación si la rutina la rechaza (ORD-POS-045); tampoco cambian la orden. */
  | 'orden.supervision_reservar' | 'orden.supervision_liberar'

/** Órdenes (V1.8 F3, docs/migracion-ordenes-codex.md). Desde el dashboard no se crean órdenes de riesgo ALTO. */
export const ORDER_RISKS = ['BAJO', 'MEDIO'] as const
export const INITIAL_ORDER_STATE = 'BORRADOR'
export const ORDER_TERMINAL_STATES = ['CERRADA', 'CANCELADA'] as const

/** Acceso del agente PM (DEC-POS-005, docs/escritura-v1-8.md): solo estas operaciones y solo estos campos de tarea. */
export const AGENT_ACTOR = 'agente-pm'
export const AGENT_OPERATIONS: readonly OperationName[] = ['tarea.crear', 'tarea.editar', 'decision.crear', 'orden.crear', 'orden.aprobar']
/** DEC-POS-011: en PATCH de una orden (operación 'orden.aprobar') el PM solo usa estas acciones; el resto es del propietario. */
/** ORD-POS-112: operación del PM fuera de AGENT_OPERATIONS que solo se permite con TIEMPOS_AGENTE=true (guard.ts). */
export const AGENT_TIEMPOS_OPERATION: OperationName = 'tiempo.crear'
/** ORD-POS-131 (DEC-ECO-007): operación SOLO del PM, fuera de AGENT_OPERATIONS; el guard la permite con ECO_IDEAS_ALTA=true. */
export const AGENT_IDEAS_OPERATION: OperationName = 'idea.alta'
/** Operaciones solo del propietario con su sesión (DEC-POS-029 a): con cualquier Authorization, 403 sin leer el cuerpo. */
export const OWNER_PLANNING_OPERATIONS: readonly OperationName[] = ['capacidad.registrar']
export const AGENT_ORDER_ACTIONS: readonly string[] = ['APROBAR', 'ENVIAR', 'REVISAR']
export const AGENT_EDITABLE_TASK_FIELDS = [
  'titulo', 'descripcion', 'prioridad', 'hitoId', 'fechaPlan', 'fechaLimite', 'horasEstimadas', 'criterioTerminado',
] as const
