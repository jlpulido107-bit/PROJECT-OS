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
  /** V1.7: órdenes a Codex aprobadas por el propietario (docs/migracion-ordenes-codex.md). */
  ORDENES_CODEX: [
    'ORDEN_ID', 'PROYECTO_ID', 'TAREA_ID', 'TITULO', 'OBJETIVO', 'CONTEXTO', 'CRITERIOS_ACEPTACION',
    'FUERA_DE_ALCANCE', 'COMO_PROBAR', 'RIESGO', 'ESTADO', 'ISSUE_URL', 'PR_URL', 'NOTAS', 'ACTUALIZADO_EN',
  ],
  // SENSIBLE (DEC-POS-019) va aparte, en ORDENES_SENSIBLE: es opcional para no invalidar la pestaña antes de la migración.
  /**
   * V1.9 (opcional): estado de supervisión de PRs (docs/migracion-supervision.md, contrato §3.1/§4/§5).
   * Solo lectura por ahora; no está en WRITE_HEADERS.
   */
  SUPERVISION: [
    'SUPERVISION_ID', 'ORDEN_ID', 'PROYECTO_ID', 'TAREA_ID', 'REPO', 'ISSUE', 'PR', 'HEAD_SHA', 'BASE_SHA',
    'HASH_CRITERIOS', 'VERSION_CONTRATO', 'VERSION_POLITICA', 'CLAVE', 'REVISION_ID', 'EJECUCION_ID', 'INTENTO',
    'RONDA', 'ESTADO', 'VEREDICTO', 'ORIGEN', 'REPORTE_REF', 'MOTIVO', 'VERSION', 'ACTUALIZADO_EN',
  ],
  /**
   * ORD-POS-141 (opcional, DEC-POS-029 d): escenarios de simulación guardados por el propietario. Pestaña nueva al final
   * del libro, la crea solo el propietario (docs/escritura-v1-8.md §11.2). A–E son de ORD-POS-138; HUELLA, ESTADO y
   * VERSION (F–H) los añade ORD-POS-141 para la huella de entrada, archivar y la versión de la fila.
   */
  ESCENARIOS: ['ESCENARIO_ID', 'NOMBRE', 'SEMANA_ID', 'PARAMETROS', 'CREADO_EN', 'HUELLA', 'ESTADO', 'VERSION'],
} as const

/**
 * Columna opcional de ORDENES_CODEX (DEC-POS-019, docs/migracion-ordenes-codex.md): `SI` o `NO`. Se lee si existe y no
 * se exige en los encabezados; vacía o ausente = sensible. No está en el contrato de escritura: la llena el propietario.
 */
export const ORDENES_SENSIBLE = 'SENSIBLE'

/**
 * Columna opcional de ORDENES_CODEX (ORD-POS-125, DEC-POS-028 punto 3; docs/migracion-ordenes-codex.md): el nombre de la
 * bandera que la orden deja inerte (p. ej. `TIEMPOS_AGENTE`) o vacía si no deja ninguna. Va al final, la añade y la llena
 * solo el propietario a mano; no está en el contrato de escritura. Sin ella, Activada y «Banderas sin encender» quedan
 * apagadas.
 */
export const ORDENES_BANDERA = 'BANDERA'

/**
 * Columna opcional de TAREAS (ORD-POS-105, docs/escritura-v1-8.md §6): instrucciones paso a paso, hasta 4000 caracteres.
 * Va al final y solo la añade el propietario (docs/migracion-instrucciones.md). Se lee si existe; sin ella, la tarea se lee
 * y se escribe igual que antes y las instrucciones se rechazan.
 */
export const TAREAS_INSTRUCCIONES = 'INSTRUCCIONES'

export type TabName = keyof typeof TAB_HEADERS
export type TabColumn<T extends TabName> = (typeof TAB_HEADERS)[T][number]

/**
 * Pestañas que pueden no existir en la hoja real. Si faltan, el dashboard lee el resto igual, sin error ni aviso.
 * Si existen, se validan como las demás (encabezados incorrectos se reportan).
 */
export const OPTIONAL_TABS = ['SUPERVISION', 'ESCENARIOS'] as const satisfies readonly TabName[]
export type OptionalTabName = (typeof OPTIONAL_TABS)[number]
export function isOptionalTab(tab: TabName): tab is OptionalTabName {
  return (OPTIONAL_TABS as readonly string[]).includes(tab)
}

/** Pestañas que lee el dashboard. AUDITORIA, REGISTROS y DASHBOARD no se leen (mínimo necesario). */
export const TABS_READ = Object.keys(TAB_HEADERS) as TabName[]

/** Máximo de filas de datos leídas por pestaña; si se supera se marca la pestaña como truncada. */
export const MAX_DATA_ROWS = 5000

/** Última columna que se lee de cada pestaña (52 columnas, A–AZ; ORD-POS-114). Solo aquí. */
export const ULTIMA_COLUMNA = 'AZ'

/**
 * Estados de tarea que se consideran cerrados. Cualquier otro estado no vacío es "abierta".
 * COMPLETADO es el estado registrado manualmente en Sheets; el dashboard no lo infiere.
 */
export const CLOSED_TASK_STATES = new Set(['COMPLETADO', 'CANCELADO'])
export const COMPLETED_STATE = 'COMPLETADO'
export const BLOCKED_TASK_STATE = 'BLOQUEADO'
/** Estados de dependencia que dejan de exigir el prerrequisito. */
export const INACTIVE_DEPENDENCY_STATES = new Set(['RESUELTA', 'INACTIVA', 'CANCELADA'])
