/**
 * Tipos del centro de control V1.6. El motor NO recibe texto libre (títulos, notas, bloqueos, texto de decisiones):
 * solo IDs, códigos de estado, fechas civiles `YYYY-MM-DD` y números.
 */

export interface TabState {
  ok: boolean
  truncated: boolean
  duplicateIds: string[]
  invalidCells: number
}

export interface GovernanceInput {
  proyectos: Array<{ id: string; estado: string | null }>
  hitos: Array<{ id: string; proyectoId: string | null; estado: string | null; fechaObjetivo: string | null }>
  tareas: Array<{
    id: string
    proyectoId: string | null
    hitoId: string | null
    estado: string | null
    /** BLOQUEO no vacío (el texto no llega al motor). */
    tieneBloqueo: boolean
    fechaLimite: string | null
  }>
  dependencias: Array<{ id: string; tareaId: string | null; dependeDeTareaId: string | null; estado: string | null }>
  evidencias: Array<{ id: string; tareaId: string | null; verificacion: string | null }>
  decisiones: Array<{ id: string; proyectoId: string | null; fecha: string | null; estado: string | null }>
  tiempos: Array<{ id: string; tareaId: string | null }>
  planes: Array<{ id: string; fecha: string | null; estado: string | null }>
  planItems: Array<{ id: string; planId: string | null; tareaId: string | null; minutosPlan: number | null }>
  capacidad: Array<{ id: string; fechaInicio: string | null; horasDisponibles: number | null; reservaPct: number | null }>
  asignaciones: Array<{ id: string; semanaId: string | null; horasObjetivo: number | null }>
  /** Estado de lectura por pestaña. Una pestaña ausente de este mapa se considera NO disponible. */
  pestanas: Partial<Record<TabName, TabState>>
  /** Señales opcionales del planificador V1.5 (misma forma que PlanResult.conflictos, sin importar su código). */
  planificacion?: PlannerSignals
}

export interface PlannerSignals {
  semanaIso: string
  conflictos: Array<{ codigo: string; refs: string[] }>
}

export type TabName =
  | 'PROYECTOS' | 'HITOS' | 'TAREAS' | 'DEPENDENCIAS' | 'EVIDENCIAS' | 'DECISIONES' | 'TIEMPOS'
  | 'PLAN_DIARIO' | 'PLAN_ITEMS' | 'CAPACIDAD_SEMANAL' | 'ASIGNACIONES'

export type Category = 'decisiones' | 'bloqueos' | 'dependencias' | 'vencimientos' | 'evidencias' | 'discrepancias' | 'capacidad' | 'datos'
export type AlertType = 'incumplimiento' | 'discrepancia' | 'bloqueo' | 'pendiente' | 'riesgo' | 'revision' | 'diagnostico'
export type Severity = 'critica' | 'alta' | 'media' | 'baja' | 'info'
export type Confidence = 'alta' | 'media' | 'baja'
export type EntityType = 'tarea' | 'hito' | 'decision' | 'proyecto' | 'dependencia' | 'evidencia' | 'plan' | 'plan-item' | 'semana' | 'sesion' | 'pestana'

export interface Entity {
  tipo: EntityType
  id: string
}

export interface Alert {
  id: string
  regla: string
  categoria: Category
  tipo: AlertType
  severidad: Severity
  confianza: Confidence
  proyectoId: string | null
  entidades: Entity[]
  /** Valores registrados tal cual. */
  hechos: string[]
  /** Derivaciones deterministas a partir de los hechos. */
  inferencias: string[]
  /** Riesgos posibles: nunca afirmados como hechos. */
  hipotesis: string[]
  /** Acciones sugeridas a una persona. NUNCA se ejecutan. */
  acciones: string[]
  diasVencido: number | null
  fechaClave: string | null
}

export type CoverageState = 'con-alertas' | 'sin-alertas-detectadas' | 'sin-datos'
export type GlobalState = 'critico' | 'requiere-atencion' | 'datos-incompletos' | 'revisiones-sugeridas' | 'sin-alertas-detectadas'

export interface GovernanceReport {
  version: 'control-v1.6'
  referencia: { fecha: string; zona: string; semana: { lunes: string; domingo: string } }
  estadoGlobal: GlobalState
  resumen: {
    total: number
    porSeveridad: Record<Severity, number>
    porCategoria: Record<Category, number>
    porTipo: Record<AlertType, number>
  }
  cobertura: Array<{ categoria: Category; estado: CoverageState; alertas: number; pestanasFaltantes: TabName[] }>
  proyectos: Array<{ id: string; registrado: boolean; activo: boolean | null; total: number; porSeveridad: Record<Severity, number>; maxSeveridad: Severity | null }>
  alertas: Alert[]
  huella: string
}
