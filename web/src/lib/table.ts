import { parseCivilDate, parseTimestamp, type Parsed, type Timestamp } from './dates'
import { cellText, normalizeCode, parseFraction, parseNonNegative, parseSafeUrl } from './parse'
import { isOptionalTab, MAX_DATA_ROWS, ORDENES_BANDERA, ORDENES_SENSIBLE, TAB_HEADERS, TAREAS_INSTRUCCIONES, type TabName } from './schema'
import type { DataIssue, DataSource, Dataset, RawTabs, TabStatus } from './types'

const MAX_ISSUES = 200

/** Acceso a una fila por nombre de columna exacto. */
export interface Row {
  /** Número de fila en la hoja (encabezados = 1). */
  sheetRow: number
  get(column: string): string | null
}

export interface ParsedTable {
  status: TabStatus
  rows: Row[]
}

/**
 * Valida encabezados por nombre exacto y devuelve las filas con contenido.
 * Columnas adicionales se ignoran; el orden puede variar. Faltantes o duplicadas → pestaña no válida.
 */
export function parseTable(tab: TabName, values: unknown[][] | undefined): ParsedTable {
  const base: TabStatus = {
    tab, ok: false, problem: null, missingColumns: [], rows: 0, truncated: false, rowsWithoutId: 0, duplicateIds: [],
  }
  if (values === undefined) return { status: { ...base, problem: 'pestana-ausente' }, rows: [] }
  const header = (values[0] ?? []).map((cell) => cellText(cell) ?? '')
  if (header.every((h) => h === '')) return { status: { ...base, problem: 'sin-encabezados' }, rows: [] }

  const expected = TAB_HEADERS[tab] as readonly string[]
  const index = new Map<string, number>()
  const duplicated = new Set<string>()
  header.forEach((name, i) => {
    if (!name) return
    if (index.has(name)) duplicated.add(name)
    else index.set(name, i)
  })
  const missing = expected.filter((col) => !index.has(col))
  if (missing.length > 0) {
    return { status: { ...base, problem: 'encabezados-faltantes', missingColumns: missing }, rows: [] }
  }
  const dupExpected = expected.filter((col) => duplicated.has(col))
  if (dupExpected.length > 0) {
    return { status: { ...base, problem: 'encabezados-duplicados', missingColumns: dupExpected }, rows: [] }
  }

  const idColumn = expected[0] as string
  const dataRows = values.slice(1)
  const truncated = dataRows.length > MAX_DATA_ROWS
  const rows: Row[] = []
  const seen = new Set<string>()
  const duplicateIds = new Set<string>()
  let rowsWithoutId = 0

  dataRows.slice(0, MAX_DATA_ROWS).forEach((cells, i) => {
    const sheetRow = i + 2
    const get = (column: string) => {
      const at = index.get(column)
      return at === undefined ? null : cellText(cells?.[at])
    }
    const hasContent = expected.some((col) => get(col) !== null)
    if (!hasContent) return
    const id = get(idColumn)
    if (id === null) {
      rowsWithoutId += 1
      return
    }
    if (seen.has(id)) {
      // IDs estables: un ID duplicado es un error de datos; se conserva solo la primera fila.
      duplicateIds.add(id)
      return
    }
    seen.add(id)
    rows.push({ sheetRow, get })
  })

  return {
    status: {
      ...base,
      ok: true,
      rows: rows.length,
      truncated,
      rowsWithoutId,
      duplicateIds: [...duplicateIds],
    },
    rows,
  }
}

class IssueLog {
  issues: DataIssue[] = []
  truncated = false
  add(issue: DataIssue) {
    if (this.issues.length >= MAX_ISSUES) this.truncated = true
    else this.issues.push(issue)
  }
}

/** Lector tipado de una fila que registra incidencias sin exponer el valor original. */
function reader(tab: TabName, row: Row, log: IssueLog) {
  const track = <T>(column: string, parsed: Parsed<T>, message: string): T | null => {
    if (parsed.invalid) log.add({ tab, row: row.sheetRow, column, message })
    return parsed.value
  }
  return {
    text: (column: string) => row.get(column),
    code: (column: string) => normalizeCode(row.get(column)),
    date: (column: string) =>
      track(column, parseCivilDate(row.get(column)), 'Fecha no reconocida (se espera AAAA-MM-DD)'),
    timestamp: (column: string): Timestamp | null =>
      track(column, parseTimestamp(row.get(column)), 'Fecha/hora no reconocida (se espera ISO 8601)'),
    amount: (column: string) =>
      track(column, parseNonNegative(row.get(column)), 'Número no válido o negativo'),
    fraction: (column: string) =>
      track(column, parseFraction(row.get(column)), 'Porcentaje no válido (use 15% o 0.15)'),
    url: (column: string) =>
      track(column, parseSafeUrl(row.get(column)), 'URL no válida o no segura (solo http/https)'),
  }
}

function mapTab<T>(
  tab: TabName,
  raw: RawTabs,
  tabs: Partial<Record<TabName, TabStatus>>,
  log: IssueLog,
  map: (r: ReturnType<typeof reader>, id: string) => T,
): T[] {
  // Pestaña opcional ausente: sin estado ni aviso. Presente: se valida como las demás.
  if (isOptionalTab(tab) && raw[tab] === undefined) return []
  const parsed = parseTable(tab, raw[tab])
  tabs[tab] = parsed.status
  const idColumn = TAB_HEADERS[tab][0]
  return parsed.rows.map((row) => map(reader(tab, row, log), row.get(idColumn) as string))
}

/** La fila de encabezados de la pestaña tiene la columna `column` (nombre exacto, como parseTable). */
const tieneColumna = (values: unknown[][] | undefined, column: string): boolean =>
  (values?.[0] ?? []).some((cell) => cellText(cell) === column)

/** Construye el conjunto de datos tipado a partir de las matrices de valores de cada pestaña. */
export function buildDataset(raw: RawTabs, meta: { source: DataSource; fetchedAt: number }): Dataset {
  const tabs: Partial<Record<TabName, TabStatus>> = {}
  const log = new IssueLog()

  const proyectos = mapTab('PROYECTOS', raw, tabs, log, (r, id) => ({
    id,
    nombre: r.text('NOMBRE'),
    objetivo: r.text('OBJETIVO'),
    fase: r.code('FASE'),
    estado: r.code('ESTADO'),
    prioridad: r.code('PRIORIDAD'),
    fechaInicio: r.date('FECHA_INICIO'),
    fechaObjetivo: r.date('FECHA_OBJETIVO'),
    repositorioUrl: r.url('REPOSITORIO_URL'),
    responsable: r.text('RESPONSABLE'),
    notas: r.text('NOTAS'),
    actualizadoEn: r.timestamp('ACTUALIZADO_EN'),
  }))

  const hitos = mapTab('HITOS', raw, tabs, log, (r, id) => ({
    id,
    proyectoId: r.text('PROYECTO_ID'),
    nombre: r.text('NOMBRE'),
    resultadoEsperado: r.text('RESULTADO_ESPERADO'),
    fechaObjetivo: r.date('FECHA_OBJETIVO'),
    estado: r.code('ESTADO'),
    criterioAceptacion: r.text('CRITERIO_ACEPTACION'),
    actualizadoEn: r.timestamp('ACTUALIZADO_EN'),
  }))

  const tareas = mapTab('TAREAS', raw, tabs, log, (r, id) => ({
    id,
    proyectoId: r.text('PROYECTO_ID'),
    hitoId: r.text('HITO_ID'),
    titulo: r.text('TITULO'),
    descripcion: r.text('DESCRIPCION'),
    tipo: r.code('TIPO'),
    estado: r.code('ESTADO'),
    prioridad: r.code('PRIORIDAD'),
    responsable: r.text('RESPONSABLE'),
    fechaPlan: r.date('FECHA_PLAN'),
    fechaLimite: r.date('FECHA_LIMITE'),
    horasEstimadas: r.amount('HORAS_ESTIMADAS'),
    criterioTerminado: r.text('CRITERIO_TERMINADO'),
    bloqueo: r.text('BLOQUEO'),
    version: r.text('VERSION'),
    actualizadoEn: r.timestamp('ACTUALIZADO_EN'),
    instrucciones: r.text(TAREAS_INSTRUCCIONES),
  }))

  const capacidad = mapTab('CAPACIDAD_SEMANAL', raw, tabs, log, (r, id) => ({
    id,
    fechaInicio: r.date('FECHA_INICIO'),
    horasDisponibles: r.amount('HORAS_DISPONIBLES'),
    reservaPct: r.fraction('RESERVA_PCT'),
    estado: r.code('ESTADO'),
    notas: r.text('NOTAS'),
    actualizadoEn: r.timestamp('ACTUALIZADO_EN'),
    // Columna de la migración de ORD-POS-139 (opcional): sin ella, null; capacidadConVersion dice si la hoja ya la tiene.
    version: r.text('VERSION'),
  }))

  const asignaciones = mapTab('ASIGNACIONES', raw, tabs, log, (r, id) => ({
    id,
    semanaId: r.text('SEMANA_ID'),
    proyectoId: r.text('PROYECTO_ID'),
    horasObjetivo: r.amount('HORAS_OBJETIVO'),
    prioridad: r.code('PRIORIDAD'),
    actualizadoEn: r.timestamp('ACTUALIZADO_EN'),
  }))

  const planes = mapTab('PLAN_DIARIO', raw, tabs, log, (r, id) => ({
    id,
    fecha: r.date('FECHA'),
    semanaId: r.text('SEMANA_ID'),
    estado: r.code('ESTADO'),
    horasObjetivo: r.amount('HORAS_OBJETIVO'),
    notas: r.text('NOTAS'),
    actualizadoEn: r.timestamp('ACTUALIZADO_EN'),
  }))

  const planItems = mapTab('PLAN_ITEMS', raw, tabs, log, (r, id) => ({
    id,
    planId: r.text('PLAN_ID'),
    tareaId: r.text('TAREA_ID'),
    orden: r.amount('ORDEN'),
    minutosPlan: r.amount('MINUTOS_PLAN'),
    resultadoEsperado: r.text('RESULTADO_ESPERADO'),
    actualizadoEn: r.timestamp('ACTUALIZADO_EN'),
  }))

  const tiempos = mapTab('TIEMPOS', raw, tabs, log, (r, id) => ({
    id,
    tareaId: r.text('TAREA_ID'),
    fecha: r.date('FECHA'),
    responsable: r.text('RESPONSABLE'),
    minutosReales: r.amount('MINUTOS_REALES'),
    tipoTrabajo: r.code('TIPO_TRABAJO'),
    notas: r.text('NOTAS'),
    creadoEn: r.timestamp('CREADO_EN'),
  }))

  const evidencias = mapTab('EVIDENCIAS', raw, tabs, log, (r, id) => ({
    id,
    tareaId: r.text('TAREA_ID'),
    proyectoId: r.text('PROYECTO_ID'),
    tipo: r.code('TIPO'),
    fuente: r.text('FUENTE'),
    referenciaUrl: r.url('REFERENCIA_URL'),
    referenciaExternaId: r.text('REFERENCIA_EXTERNA_ID'),
    fecha: r.date('FECHA'),
    verificacion: r.code('VERIFICACION'),
    descripcion: r.text('DESCRIPCION'),
  }))

  const dependencias = mapTab('DEPENDENCIAS', raw, tabs, log, (r, id) => ({
    id,
    tareaId: r.text('TAREA_ID'),
    dependeDeTareaId: r.text('DEPENDE_DE_TAREA_ID'),
    tipo: r.code('TIPO'),
    estado: r.code('ESTADO'),
  }))

  const decisiones = mapTab('DECISIONES', raw, tabs, log, (r, id) => ({
    id,
    proyectoId: r.text('PROYECTO_ID'),
    fecha: r.date('FECHA'),
    asunto: r.text('ASUNTO'),
    decision: r.text('DECISION'),
    justificacion: r.text('JUSTIFICACION'),
    responsable: r.text('RESPONSABLE'),
    estado: r.code('ESTADO'),
    evidenciaUrl: r.url('EVIDENCIA_URL'),
  }))

  const syncRuns = mapTab('SYNC_RUNS', raw, tabs, log, (r, id) => ({
    id,
    fuente: r.text('FUENTE'),
    inicio: r.timestamp('INICIO'),
    fin: r.timestamp('FIN'),
    estado: r.code('ESTADO'),
    registrosProcesados: r.amount('REGISTROS_PROCESADOS'),
    errorResumen: r.text('ERROR_RESUMEN'),
  }))

  const ordenes = mapTab('ORDENES_CODEX', raw, tabs, log, (r, id) => ({
    id,
    proyectoId: r.text('PROYECTO_ID'),
    tareaId: r.text('TAREA_ID'),
    titulo: r.text('TITULO'),
    objetivo: r.text('OBJETIVO'),
    contexto: r.text('CONTEXTO'),
    criterios: r.text('CRITERIOS_ACEPTACION'),
    fueraDeAlcance: r.text('FUERA_DE_ALCANCE'),
    comoProbar: r.text('COMO_PROBAR'),
    riesgo: r.code('RIESGO'),
    // Columna opcional (migración de DEC-POS-019): si la hoja aún no la tiene, null = sensible.
    sensible: r.code(ORDENES_SENSIBLE),
    // Columna opcional (ORD-POS-125): sin ella, null; ordenesConBandera dice si la hoja ya la tiene.
    bandera: r.text(ORDENES_BANDERA),
    estado: r.code('ESTADO'),
    issueUrl: r.url('ISSUE_URL'),
    prUrl: r.url('PR_URL'),
    notas: r.text('NOTAS'),
    actualizadoEn: r.date('ACTUALIZADO_EN'),
  }))

  const supervision = mapTab('SUPERVISION', raw, tabs, log, (r, id) => ({
    id,
    ordenId: r.text('ORDEN_ID'),
    proyectoId: r.text('PROYECTO_ID'),
    tareaId: r.text('TAREA_ID'),
    repo: r.text('REPO'),
    issue: r.text('ISSUE'),
    pr: r.text('PR'),
    headSha: r.text('HEAD_SHA'),
    baseSha: r.text('BASE_SHA'),
    hashCriterios: r.text('HASH_CRITERIOS'),
    versionContrato: r.text('VERSION_CONTRATO'),
    versionPolitica: r.text('VERSION_POLITICA'),
    clave: r.text('CLAVE'),
    revisionId: r.text('REVISION_ID'),
    ejecucionId: r.text('EJECUCION_ID'),
    intento: r.amount('INTENTO'),
    ronda: r.amount('RONDA'),
    estado: r.code('ESTADO'),
    veredicto: r.code('VEREDICTO'),
    origen: r.text('ORIGEN'),
    reporteRef: r.text('REPORTE_REF'),
    motivo: r.text('MOTIVO'),
    version: r.text('VERSION'),
    actualizadoEn: r.timestamp('ACTUALIZADO_EN'),
  }))

  // ORD-POS-141: escenarios guardados (pestaña opcional); PARAMETROS se valida al cargarlo en el navegador.
  const escenarios = mapTab('ESCENARIOS', raw, tabs, log, (r, id) => ({
    id,
    nombre: r.text('NOMBRE'),
    semanaId: r.text('SEMANA_ID'),
    parametros: r.text('PARAMETROS'),
    creadoEn: r.timestamp('CREADO_EN'),
    huella: r.text('HUELLA'),
    estado: r.code('ESTADO'),
    version: r.text('VERSION'),
  }))

  return {
    source: meta.source,
    fetchedAt: meta.fetchedAt,
    tabs: tabs as Dataset['tabs'],
    proyectos, hitos, tareas, capacidad, asignaciones, planes, planItems, tiempos,
    evidencias, dependencias, decisiones, syncRuns, ordenes, supervision,
    ordenesConBandera: tabs.ORDENES_CODEX?.ok === true && tieneColumna(raw.ORDENES_CODEX, ORDENES_BANDERA),
    capacidadConVersion: tabs.CAPACIDAD_SEMANAL?.ok === true && tieneColumna(raw.CAPACIDAD_SEMANAL, 'VERSION'),
    escenarios,
    issues: log.issues,
    issuesTruncated: log.truncated,
  }
}
