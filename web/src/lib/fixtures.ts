import { addDays } from './dates'
import { mondayOf } from './aggregate'
import type { RawTabs } from './types'

/**
 * Datos SINTÉTICOS para desarrollo local, demos y pruebas.
 * No son una copia de la hoja real: los textos son inventados y marcados como demostración.
 * Los IDs de proyecto (SIG, ECO, DEV, POS) y sus nombres provienen de config/projects.json.
 * Incluyen casos borde deliberados: filas en blanco, celdas faltantes, números inválidos,
 * tareas sin estado, bloqueos, dependencias pendientes y evidencias sin tarea.
 */
export function buildFixtureTabs(today: string): RawTabs {
  const d = (offset: number) => addDays(today, offset)
  const week = mondayOf(today)
  const prevWeek = addDays(week, -7)
  const weekId = (monday: string) => `DEMO-${monday}`

  return {
    PROYECTOS: [
      ['PROYECTO_ID', 'NOMBRE', 'OBJETIVO', 'FASE', 'ESTADO', 'PRIORIDAD', 'FECHA_INICIO', 'FECHA_OBJETIVO', 'REPOSITORIO_URL', 'RESPONSABLE', 'NOTAS', 'ACTUALIZADO_EN'],
      ['SIG', 'SIGSAH', 'Objetivo de demostración A', 'POR_VERIFICAR', 'POR_DIAGNOSTICAR', 'ALTA', '', '', 'https://github.com/jlpulido107-bit/SIGSAH', 'Persona demo', 'Nota sintética', ''],
      ['ECO', 'E-commerce', 'Objetivo de demostración B', 'DESCUBRIMIENTO', 'POR_DIAGNOSTICAR', 'ALTA'],
      ['DEV', 'Desarrolladora IA', 'Objetivo de demostración C', 'METODOLOGIA', 'POR_DIAGNOSTICAR', 'MEDIA', '', '', '', 'Persona demo'],
      [],
      ['POS', 'PROJECT-OS', 'Objetivo de demostración D', 'V1', 'EN_PROGRESO', 'ALTA', d(-10), d(30), 'https://github.com/jlpulido107-bit/PROJECT-OS', 'Persona demo', '', `${d(-1)} 18:30`],
    ],
    HITOS: [
      ['HITO_ID', 'PROYECTO_ID', 'NOMBRE', 'RESULTADO_ESPERADO', 'FECHA_OBJETIVO', 'ESTADO', 'CRITERIO_ACEPTACION', 'ACTUALIZADO_EN'],
      ['DEMO-H1', 'POS', 'Hito demo: lectura segura', 'Panel de solo lectura', d(14), 'EN_PROGRESO', 'Criterio demo verificable', ''],
      ['DEMO-H2', 'POS', 'Hito demo: sincronización', 'Evidencias sin duplicados', d(-3), 'COMPLETADO', 'Dos ejecuciones sin duplicados', ''],
    ],
    TAREAS: [
      ['TAREA_ID', 'PROYECTO_ID', 'HITO_ID', 'TITULO', 'DESCRIPCION', 'TIPO', 'ESTADO', 'PRIORIDAD', 'RESPONSABLE', 'FECHA_PLAN', 'FECHA_LIMITE', 'HORAS_ESTIMADAS', 'CRITERIO_TERMINADO', 'BLOQUEO', 'VERSION', 'ACTUALIZADO_EN'],
      ['DEMO-001', 'POS', 'DEMO-H2', 'Tarea demo completada', 'Descripción sintética', 'INTEGRACION', 'COMPLETADO', 'ALTA', 'Persona demo', d(-5), d(-3), '3', 'Criterio de terminado demo', '', '1', d(-3)],
      ['DEMO-002', 'POS', 'DEMO-H1', 'Tarea demo en curso', 'Descripción sintética', 'DESARROLLO', 'EN_PROGRESO', 'ALTA', 'Persona demo', d(0), d(4), '6,5', 'Panel accesible en móvil y escritorio', '', '2', d(0)],
      ['DEMO-003', 'POS', '', 'Tarea demo bloqueada', 'Espera una aprobación', 'AUTOMATIZACION', 'PENDIENTE', 'MEDIA', 'Otra persona demo', '', d(10), 'abc', 'Aprobación registrada', 'Falta aprobación (demo)', '1', ''],
      ['DEMO-004', 'SIG', '', 'Tarea demo sin estado', '', 'REVISION', '', 'BAJA', '', '', '', '', 'Revisión documentada'],
      ['DEMO-005', 'ECO', '', 'Tarea demo pendiente', 'Depende de otra tarea', 'INVESTIGACION', 'PENDIENTE', 'MEDIA', 'Persona demo', d(2), d(9), '', 'Informe breve'],
      ['', 'POS', '', 'Fila sin ID (se ignora)', '', '', 'PENDIENTE'],
      [' ', ' ', ''],
    ],
    CAPACIDAD_SEMANAL: [
      ['SEMANA_ID', 'FECHA_INICIO', 'HORAS_DISPONIBLES', 'RESERVA_PCT', 'ESTADO', 'NOTAS', 'ACTUALIZADO_EN'],
      [weekId(week), week, '', '0.15', 'BORRADOR', 'Horas aún sin aprobar (demo)', ''],
      [weekId(prevWeek), prevWeek, '20', '15%', 'APROBADA', 'Semana demo anterior', ''],
    ],
    ASIGNACIONES: [
      ['ASIGNACION_ID', 'SEMANA_ID', 'PROYECTO_ID', 'HORAS_OBJETIVO', 'PRIORIDAD', 'ACTUALIZADO_EN'],
      ['DEMO-A1', weekId(prevWeek), 'POS', '10', 'ALTA', ''],
      ['DEMO-A2', weekId(prevWeek), 'SIG', '5', 'MEDIA', ''],
    ],
    PLAN_DIARIO: [
      ['PLAN_ID', 'FECHA', 'SEMANA_ID', 'ESTADO', 'HORAS_OBJETIVO', 'NOTAS', 'ACTUALIZADO_EN'],
      ['DEMO-P1', today, weekId(week), 'EN_CURSO', '3', 'Plan demo de hoy', ''],
      ['DEMO-P0', d(-1), weekId(week), 'CERRADO', '2', '', ''],
    ],
    PLAN_ITEMS: [
      ['PLAN_ITEM_ID', 'PLAN_ID', 'TAREA_ID', 'ORDEN', 'MINUTOS_PLAN', 'RESULTADO_ESPERADO', 'ACTUALIZADO_EN'],
      ['DEMO-PI2', 'DEMO-P1', 'DEMO-003', '2', '30', 'Solicitar aprobación', ''],
      ['DEMO-PI1', 'DEMO-P1', 'DEMO-002', '1', '120', 'Vista de tareas filtrable', ''],
      ['DEMO-PI3', 'DEMO-P0', 'DEMO-001', '1', '', 'Sin minutos planeados', ''],
    ],
    TIEMPOS: [
      ['SESION_ID', 'TAREA_ID', 'FECHA', 'RESPONSABLE', 'MINUTOS_REALES', 'TIPO_TRABAJO', 'NOTAS', 'CREADO_EN'],
      ['DEMO-S1', 'DEMO-001', d(-1), 'Persona demo', '90', 'DESARROLLO', '', `${d(-1)}T20:00:00-06:00`],
      ['DEMO-S2', 'DEMO-002', today, 'Persona demo', '45', 'DESARROLLO', '', ''],
      ['DEMO-S3', 'DEMO-002', today, 'Persona demo', 'n/d', 'REVISION', 'Minutos inválidos a propósito', ''],
      ['DEMO-S4', 'DEMO-005', addDays(prevWeek, 2), 'Persona demo', '60', 'INVESTIGACION', '', ''],
    ],
    EVIDENCIAS: [
      ['EVIDENCIA_ID', 'TAREA_ID', 'PROYECTO_ID', 'TIPO', 'FUENTE', 'REFERENCIA_URL', 'REFERENCIA_EXTERNA_ID', 'FECHA', 'VERIFICACION', 'DESCRIPCION'],
      ['DEMO-E1', 'DEMO-001', 'POS', 'PR', 'GitHub', 'https://github.com/jlpulido107-bit/PROJECT-OS/pull/2', '2', d(-3), 'CONFIRMADO', 'PR demo vinculado a una tarea completada'],
      ['DEMO-E2', '', 'SIG', 'COMMIT', 'GitHub', 'https://github.com/jlpulido107-bit/SIGSAH/commits', 'github:demo:COMMIT:1', d(-2), 'CONFIRMADO', 'Actividad observada (demo) | Sin validación de cierre'],
      ['DEMO-E3', 'DEMO-002', 'POS', 'CI', 'GitHub Actions', 'https://github.com/jlpulido107-bit/PROJECT-OS/actions', '', d(0), 'CONFIRMADO', 'Ejecución demo vinculada a tarea en curso'],
      ['DEMO-E4', 'DEMO-999', 'POS', 'DOC', 'Manual', 'javascript:alert(1)', '', d(-1), 'PENDIENTE', 'Vínculo a tarea inexistente y URL insegura (demo)'],
    ],
    DEPENDENCIAS: [
      ['DEPENDENCIA_ID', 'TAREA_ID', 'DEPENDE_DE_TAREA_ID', 'TIPO', 'ESTADO'],
      ['DEMO-D1', 'DEMO-002', 'DEMO-001', 'TECNICA', 'ACTIVA'],
      ['DEMO-D2', 'DEMO-005', 'DEMO-003', 'APROBACION', 'ACTIVA'],
    ],
    DECISIONES: [
      ['DECISION_ID', 'PROYECTO_ID', 'FECHA', 'ASUNTO', 'DECISION', 'JUSTIFICACION', 'RESPONSABLE', 'ESTADO', 'EVIDENCIA_URL'],
      ['DEMO-DEC1', 'POS', d(-2), 'Asunto demo', 'Decisión demo', 'Justificación demo', 'Persona demo', 'APROBADA', ''],
    ],
    SYNC_RUNS: [
      ['RUN_ID', 'FUENTE', 'INICIO', 'FIN', 'ESTADO', 'REGISTROS_PROCESADOS', 'ERROR_RESUMEN'],
      ['DEMO-RUN-2', 'GitHub Actions', `${d(-1)}T03:23:39+00:00`, `${d(-1)}T03:23:41+00:00`, 'EXITOSA', '0', ''],
      ['DEMO-RUN-1', 'GitHub Actions', `${d(-1)}T03:21:25+00:00`, `${d(-1)}T03:21:27+00:00`, 'EXITOSA', '7', ''],
    ],
    ORDENES_CODEX: [
      ['ORDEN_ID', 'PROYECTO_ID', 'TAREA_ID', 'TITULO', 'OBJETIVO', 'CONTEXTO', 'CRITERIOS_ACEPTACION', 'FUERA_DE_ALCANCE', 'COMO_PROBAR', 'RIESGO', 'ESTADO', 'ISSUE_URL', 'PR_URL', 'NOTAS', 'ACTUALIZADO_EN'],
      ['ORD-POS-901', 'POS', 'DEMO-002', 'Orden demo por aprobar', 'Objetivo demo', 'Contexto demo', 'Criterio demo', 'Fuera demo', 'npm test', 'BAJO', 'BORRADOR', '', '', '', d(0)],
      ['ORD-POS-902', 'POS', 'DEMO-002', 'Orden demo con PR', 'Objetivo demo', 'Contexto demo', 'Criterio demo', 'Fuera demo', 'npm test', 'BAJO', 'PR_ABIERTO', 'https://github.com/example/demo/issues/1', 'https://github.com/example/demo/pull/2', '', d(-1)],
      ['ORD-ECO-901', 'ECO', 'DEMO-005', 'Orden demo cerrada', 'Objetivo demo', 'Contexto demo', 'Criterio demo', 'Fuera demo', 'npm test', 'MEDIO', 'CERRADA', 'https://github.com/example/demo/issues/3', '', '', d(-3)],
    ],
  }
}
