/**
 * Tipos del motor de planificación V1.5 (propuestas, nunca compromisos).
 *
 * Unidades: todas las duraciones internas son MINUTOS ENTEROS. Las horas solo aparecen en la entrada
 * (columnas HORAS_* de Sheets) y en la presentación. Las fechas son fechas civiles `YYYY-MM-DD` en la zona
 * de referencia (por defecto America/Merida); el motor nunca convierte por UTC.
 */

/** Proyección mínima de las pestañas que usa el planificador (sin responsables, notas ni descripciones). */
export interface PlanningInput {
  proyectos: Array<{ id: string; nombre: string | null; estado: string | null; prioridad: string | null }>
  hitos: Array<{ id: string; proyectoId: string | null; estado: string | null }>
  tareas: Array<{
    id: string
    proyectoId: string | null
    hitoId: string | null
    titulo: string | null
    estado: string | null
    prioridad: string | null
    fechaPlan: string | null
    fechaLimite: string | null
    horasEstimadas: number | null
    bloqueo: string | null
  }>
  dependencias: Array<{ id: string; tareaId: string | null; dependeDeTareaId: string | null; estado: string | null }>
  capacidad: Array<{ id: string; fechaInicio: string | null; horasDisponibles: number | null; reservaPct: number | null; estado: string | null }>
  asignaciones: Array<{ id: string; semanaId: string | null; proyectoId: string | null; horasObjetivo: number | null }>
  planes: Array<{ id: string; fecha: string | null; semanaId: string | null; estado: string | null; horasObjetivo: number | null }>
  planItems: Array<{ id: string; planId: string | null; tareaId: string | null; orden: number | null; minutosPlan: number | null }>
  tiempos: Array<{ id: string; tareaId: string | null; fecha: string | null; minutosReales: number | null }>
  /** Pestañas que no se pudieron leer completas (ausentes, encabezados inválidos o truncadas). */
  pestanasNoDisponibles: string[]
  /** IDs duplicados detectados por pestaña (se conservó solo la primera fila). */
  idsDuplicados: { TAREAS: string[]; PROYECTOS: string[]; DEPENDENCIAS: string[] }
}

export type WeekChoice = 'actual' | 'siguiente'
export type ProjectPriority = 'ALTA' | 'MEDIA' | 'BAJA'

/** Parámetros de simulación. Nunca modifican los datos base: se aplican sobre una copia lógica. */
export interface Scenario {
  semana: WeekChoice
  /** Ajuste (± horas) sobre HORAS_DISPONIBLES registradas. */
  ajusteHoras: number
  /** Reserva en PORCENTAJE (0–100) que sustituye a RESERVA_PCT; `null` = usar el dato. */
  reservaPct: number | null
  /** Horas supuestas si la semana no tiene HORAS_DISPONIBLES; `null` = no suponer (diagnóstico). */
  horasSiFaltan: number | null
  /** Días laborables (1 = lunes … 7 = domingo, ISO). */
  diasLaborables: number[]
  /** Prioridad simulada por proyecto (sustituye a PROYECTOS.PRIORIDAD solo en el escenario). */
  prioridadProyecto: Record<string, ProjectPriority>
  /** Horas supuestas para tareas sin estimación; `null` = no planificarlas (requieren estimación manual). */
  horasSiSinEstimacion: number | null
  /** Sobrecarga: incremento porcentual de todas las estimaciones (0–300). */
  sobrecargaPct: number
  /** Supuesto: descontar el tiempo registrado de la estimación. No implica avance. */
  descontarRegistrado: boolean
}

export type Reason =
  | 'cerrada'
  | 'sin-estado'
  | 'bloqueada'
  | 'dependencia-pendiente'
  | 'dependencia-inexistente'
  | 'ciclo-dependencias'
  | 'id-duplicado'
  | 'sin-proyecto'
  | 'proyecto-inexistente'
  | 'proyecto-inactivo'
  | 'programada-despues'
  | 'sin-estimacion'
  | 'estimacion-agotada'
  | 'ya-planificada'

export type TaskCategory =
  /** Toda la necesidad de la semana cabe en la propuesta. */
  | 'propuesta'
  /** Solo una parte cabe en la propuesta. */
  | 'parcial'
  /** Elegible, pero sin capacidad libre o sin hueco diario. */
  | 'sin-capacidad'
  /** No se puede recomendar como ejecutable (ver motivos). */
  | 'excluida'

export interface TaskPlan {
  id: string
  proyectoId: string | null
  titulo: string | null
  estado: string | null
  prioridad: string
  /** La prioridad registrada no es una categoría documentada. */
  prioridadDesconocida: boolean
  fechaLimite: string | null
  vencida: boolean
  venceEnSemana: boolean
  categoria: TaskCategory
  motivos: Reason[]
  /** Minutos estimados (dato o supuesto de escenario); `null` sin estimación. */
  estimacionMin: number | null
  estimacionSupuesta: boolean
  registradoMin: number
  /** Minutos ya planificados en PLAN_ITEMS existentes desde la fecha de referencia hasta el domingo. */
  yaPlanificadoMin: number
  /** Minutos que la tarea necesitaría esta semana según las reglas (0 si está excluida). */
  necesidadMin: number
  propuestoMin: number
  /** Posición en el orden de prioridad (1 = primero); `null` si excluida. */
  rango: number | null
  /** Tareas abiertas que dependen de esta. */
  desbloquea: number
  explicacion: string[]
}

export interface DayPlan {
  fecha: string
  laborable: boolean
  esPasado: boolean
  /** Capacidad del día (minutos); `null` si el día no es laborable o no hay capacidad. */
  capacidadMin: number | null
  planExistenteMin: number
  realMin: number
  usadoMin: number
  libreMin: number
  propuestoMin: number
  /** El día tiene PLAN_DIARIO registrado (se respeta, no se altera). */
  planRegistrado: string | null
  items: Array<{ tareaId: string; proyectoId: string | null; minutos: number; orden: number; motivo: string }>
}

export interface ProjectPlan {
  id: string
  nombre: string | null
  prioridad: ProjectPriority | 'SIN_PRIORIDAD'
  prioridadSimulada: boolean
  peso: number
  /** HORAS_OBJETIVO de ASIGNACIONES para la semana, en minutos; `null` si no hay asignación. */
  asignadoMin: number | null
  usadoMin: number
  demandaMin: number
  presupuestoMin: number
  propuestoMin: number
  tareasPropuestas: number
}

export interface Issue {
  codigo: string
  mensaje: string
  refs: string[]
}

export interface PlanResult {
  version: 'planificacion-v1.5'
  estado: 'propuesta' | 'datos-insuficientes'
  referencia: {
    fecha: string
    zona: string
    semanaIso: string
    lunes: string
    domingo: string
    /** Primer día planificable (la fecha de referencia o el lunes de la semana siguiente). */
    desde: string
  }
  capacidad: {
    origen: 'dato' | 'supuesto' | 'faltante' | 'ambigua'
    semanaId: string | null
    estadoSemana: string | null
    horasDisponibles: number | null
    reservaPct: number | null
    netaMin: number | null
    usadoMin: number
    /** Saldo semanal teórico: neta − uso de la semana (incluye cuotas de días pasados que ya no se pueden usar). */
    libreMin: number
    /** Hueco realmente colocable en los días restantes (Σ huecos diarios, acotado por el saldo semanal). */
    colocableMin: number
    propuestoMin: number
  }
  proyectos: ProjectPlan[]
  tareas: TaskPlan[]
  dias: DayPlan[]
  resumen: {
    elegibles: number
    propuestas: number
    parciales: number
    sinCapacidad: number
    excluidas: number
    /** Tareas COMPLETADO/CANCELADO: no se listan. */
    cerradasOmitidas: number
  }
  conflictos: Issue[]
  preguntas: Issue[]
  supuestos: string[]
  /** Huella determinista de la entrada efectiva (datos + escenario + referencia). */
  huella: string
}
