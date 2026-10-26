import type { Timestamp } from './dates'
import type { OptionalTabName, TabName } from './schema'

export interface Proyecto {
  id: string
  nombre: string | null
  objetivo: string | null
  fase: string | null
  estado: string | null
  prioridad: string | null
  fechaInicio: string | null
  fechaObjetivo: string | null
  repositorioUrl: string | null
  responsable: string | null
  notas: string | null
  actualizadoEn: Timestamp | null
}

export interface Hito {
  id: string
  proyectoId: string | null
  nombre: string | null
  resultadoEsperado: string | null
  fechaObjetivo: string | null
  estado: string | null
  criterioAceptacion: string | null
  actualizadoEn: Timestamp | null
}

export interface Tarea {
  id: string
  proyectoId: string | null
  hitoId: string | null
  titulo: string | null
  descripcion: string | null
  tipo: string | null
  estado: string | null
  prioridad: string | null
  responsable: string | null
  fechaPlan: string | null
  fechaLimite: string | null
  horasEstimadas: number | null
  criterioTerminado: string | null
  bloqueo: string | null
  version: string | null
  actualizadoEn: Timestamp | null
}

export interface Capacidad {
  id: string
  fechaInicio: string | null
  horasDisponibles: number | null
  reservaPct: number | null
  estado: string | null
  notas: string | null
  actualizadoEn: Timestamp | null
}

export interface Asignacion {
  id: string
  semanaId: string | null
  proyectoId: string | null
  horasObjetivo: number | null
  prioridad: string | null
  actualizadoEn: Timestamp | null
}

export interface PlanDiario {
  id: string
  fecha: string | null
  semanaId: string | null
  estado: string | null
  horasObjetivo: number | null
  notas: string | null
  actualizadoEn: Timestamp | null
}

export interface PlanItem {
  id: string
  planId: string | null
  tareaId: string | null
  orden: number | null
  minutosPlan: number | null
  resultadoEsperado: string | null
  actualizadoEn: Timestamp | null
}

export interface Tiempo {
  id: string
  tareaId: string | null
  fecha: string | null
  responsable: string | null
  minutosReales: number | null
  tipoTrabajo: string | null
  notas: string | null
  creadoEn: Timestamp | null
}

export interface Evidencia {
  id: string
  tareaId: string | null
  proyectoId: string | null
  tipo: string | null
  fuente: string | null
  referenciaUrl: string | null
  referenciaExternaId: string | null
  fecha: string | null
  verificacion: string | null
  descripcion: string | null
}

export interface Dependencia {
  id: string
  tareaId: string | null
  dependeDeTareaId: string | null
  tipo: string | null
  estado: string | null
}

export interface Decision {
  id: string
  proyectoId: string | null
  fecha: string | null
  asunto: string | null
  decision: string | null
  justificacion: string | null
  responsable: string | null
  estado: string | null
  evidenciaUrl: string | null
}

export interface SyncRun {
  id: string
  fuente: string | null
  inicio: Timestamp | null
  fin: Timestamp | null
  estado: string | null
  registrosProcesados: number | null
  errorResumen: string | null
}

export interface Orden {
  id: string
  proyectoId: string | null
  tareaId: string | null
  titulo: string | null
  objetivo: string | null
  contexto: string | null
  criterios: string | null
  fueraDeAlcance: string | null
  comoProbar: string | null
  riesgo: string | null
  /** Columna SENSIBLE (DEC-POS-019): `SI`, `NO` o null si está vacía o falta; solo `NO` es no sensible. */
  sensible: string | null
  estado: string | null
  issueUrl: string | null
  prUrl: string | null
  notas: string | null
  actualizadoEn: string | null
}

/** Fila de SUPERVISION (V1.9, opcional). Sin texto libre del reporte: solo veredicto, referencia y motivo corto. */
export interface Supervision {
  id: string
  ordenId: string | null
  proyectoId: string | null
  tareaId: string | null
  repo: string | null
  issue: string | null
  pr: string | null
  headSha: string | null
  baseSha: string | null
  hashCriterios: string | null
  versionContrato: string | null
  versionPolitica: string | null
  clave: string | null
  revisionId: string | null
  ejecucionId: string | null
  intento: number | null
  ronda: number | null
  estado: string | null
  veredicto: string | null
  origen: string | null
  reporteRef: string | null
  motivo: string | null
  version: string | null
  actualizadoEn: Timestamp | null
}

export type TabProblem = 'pestana-ausente' | 'encabezados-faltantes' | 'encabezados-duplicados' | 'sin-encabezados'

export interface TabStatus {
  tab: TabName
  ok: boolean
  problem: TabProblem | null
  missingColumns: string[]
  /** Filas de datos con ID leídas (después de omitir filas en blanco). */
  rows: number
  /** Se alcanzó el límite de filas: los totales de esta pestaña pueden estar incompletos. */
  truncated: boolean
  /** Filas con contenido pero sin ID primario: se excluyen de los cálculos. */
  rowsWithoutId: number
  duplicateIds: string[]
}

export interface DataIssue {
  tab: TabName
  /** Número de fila en la hoja (1 = encabezados). */
  row: number
  column: string
  message: string
}

export type DataSource = 'sheets' | 'fixtures'

export interface Dataset {
  source: DataSource
  /** Instante en que se leyeron los datos (epoch ms). */
  fetchedAt: number
  /** Las pestañas opcionales ausentes no tienen entrada (no son un problema). */
  tabs: Record<Exclude<TabName, OptionalTabName>, TabStatus> & Partial<Record<OptionalTabName, TabStatus>>
  proyectos: Proyecto[]
  hitos: Hito[]
  tareas: Tarea[]
  capacidad: Capacidad[]
  asignaciones: Asignacion[]
  planes: PlanDiario[]
  planItems: PlanItem[]
  tiempos: Tiempo[]
  evidencias: Evidencia[]
  dependencias: Dependencia[]
  decisiones: Decision[]
  syncRuns: SyncRun[]
  ordenes: Orden[]
  supervision: Supervision[]
  issues: DataIssue[]
  /** Hay más incidencias de las que se conservaron. */
  issuesTruncated: boolean
}

export type RawTabs = Partial<Record<TabName, unknown[][]>>
