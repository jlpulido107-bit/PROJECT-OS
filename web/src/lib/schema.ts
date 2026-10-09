/**
 * Diccionario de datos de la Google Sheet operativa (PROJECT-OS V1).
 *
 * Los encabezados son EXACTOS y se validan por nombre contra la fila 1 de cada
 * pestaña. Nunca renombrar una columna aquí sin una migración aprobada en Sheets.
 * Encabezados confirmados contra la hoja real el 2026-10-09 (lectura, sin escritura).
 */

export const TAB_HEADERS = {
  PROYECTOS: [
    'PROYECTO_ID', 'NOMBRE', 'OBJETIVO', 'FASE', 'ESTADO', 'PRIORIDAD', 'FECHA_INICIO',
    'FECHA_OBJETIVO', 'REPOSITORIO_URL', 'RESPONSABLE', 'NOTAS', 'ACTUALIZADO_EN',
  ],
  HITOS: [
    'HITO_ID', 'PROYECTO_ID', 'NOMBRE', 'RESULTADO_ESPERADO', 'FECHA_OBJETIVO', 'ESTADO',
    'CRITERIO_ACEPTACION', 'ACTUALIZADO_EN',
  ],
  TAREAS: [
    'TAREA_ID', 'PROYECTO_ID', 'HITO_ID', 'TITULO', 'DESCRIPCION', 'TIPO', 'ESTADO', 'PRIORIDAD',
    'RESPONSABLE', 'FECHA_PLAN', 'FECHA_LIMITE', 'HORAS_ESTIMADAS', 'CRITERIO_TERMINADO', 'BLOQUEO',
    'VERSION', 'ACTUALIZADO_EN',
  ],
  CAPACIDAD_SEMANAL: [
    'SEMANA_ID', 'FECHA_INICIO', 'HORAS_DISPONIBLES', 'RESERVA_PCT', 'ESTADO', 'NOTAS',
    'ACTUALIZADO_EN',
  ],
  ASIGNACIONES: [
    'ASIGNACION_ID', 'SEMANA_ID', 'PROYECTO_ID', 'HORAS_OBJETIVO', 'PRIORIDAD', 'ACTUALIZADO_EN',
  ],
  PLAN_DIARIO: ['PLAN_ID', 'FECHA', 'SEMANA_ID', 'ESTADO', 'HORAS_OBJETIVO', 'NOTAS', 'ACTUALIZADO_EN'],
  PLAN_ITEMS: [
    'PLAN_ITEM_ID', 'PLAN_ID', 'TAREA_ID', 'ORDEN', 'MINUTOS_PLAN', 'RESULTADO_ESPERADO',
    'ACTUALIZADO_EN',
  ],
  TIEMPOS: [
    'SESION_ID', 'TAREA_ID', 'FECHA', 'RESPONSABLE', 'MINUTOS_REALES', 'TIPO_TRABAJO', 'NOTAS',
    'CREADO_EN',
  ],
  EVIDENCIAS: [
    'EVIDENCIA_ID', 'TAREA_ID', 'PROYECTO_ID', 'TIPO', 'FUENTE', 'REFERENCIA_URL',
    'REFERENCIA_EXTERNA_ID', 'FECHA', 'VERIFICACION', 'DESCRIPCION',
  ],
  DEPENDENCIAS: ['DEPENDENCIA_ID', 'TAREA_ID', 'DEPENDE_DE_TAREA_ID', 'TIPO', 'ESTADO'],
  DECISIONES: [
    'DECISION_ID', 'PROYECTO_ID', 'FECHA', 'ASUNTO', 'DECISION', 'JUSTIFICACION', 'RESPONSABLE',
    'ESTADO', 'EVIDENCIA_URL',
  ],
  SYNC_RUNS: [
    'RUN_ID', 'FUENTE', 'INICIO', 'FIN', 'ESTADO', 'REGISTROS_PROCESADOS', 'ERROR_RESUMEN',
  ],
} as const

export type TabName = keyof typeof TAB_HEADERS
export type TabColumn<T extends TabName> = (typeof TAB_HEADERS)[T][number]

/** Pestañas que lee el dashboard. AUDITORIA, REGISTROS y DASHBOARD no se leen (mínimo necesario). */
export const TABS_READ = Object.keys(TAB_HEADERS) as TabName[]

/** Máximo de filas de datos leídas por pestaña; si se supera se marca la pestaña como truncada. */
export const MAX_DATA_ROWS = 5000

/**
 * Estados de tarea que se consideran cerrados. Cualquier otro estado no vacío es "abierta".
 * COMPLETADO es el estado registrado manualmente en Sheets; el dashboard no lo infiere.
 */
export const CLOSED_TASK_STATES = new Set(['COMPLETADO', 'CANCELADO'])
export const COMPLETED_STATE = 'COMPLETADO'
export const BLOCKED_TASK_STATE = 'BLOQUEADO'
/** Estados de dependencia que dejan de exigir el prerrequisito. */
export const INACTIVE_DEPENDENCY_STATES = new Set(['RESUELTA', 'INACTIVA', 'CANCELADA'])
