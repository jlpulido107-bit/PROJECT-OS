import type { Alert, AlertType, Category, Confidence, CoverageState, Entity, GlobalState, Severity } from '@/lib/governance/types'

/** Textos y enlaces del centro de control. Los enlaces son internos y solo llevan IDs (nunca texto libre). */

export const RULE_LABEL: Record<string, string> = {
  'decision-pendiente': 'Decisión pendiente',
  'decision-sin-estado': 'Decisión sin estado',
  'decision-estado-desconocido': 'Decisión con estado no documentado',
  'decision-proyecto-inactivo': 'Decisión pendiente en proyecto inactivo',
  'decision-proyecto-inexistente': 'Decisión con proyecto inexistente',
  'tarea-bloqueada': 'Tarea bloqueada',
  'tarea-vencida': 'Tarea vencida',
  'tarea-vence-pronto': 'Tarea que vence pronto',
  'tarea-sin-estado': 'Tarea sin estado',
  'tarea-referencia-rota': 'Tarea con referencias rotas',
  'tarea-completada-sin-evidencia': 'Tarea completada sin evidencia confirmada',
  'dependencia-pendiente': 'Dependencia sin resolver',
  'dependencia-inexistente': 'Dependencia de una tarea inexistente',
  'dependencia-prerrequisito-cancelado': 'Prerrequisito cancelado',
  'dependencia-circular': 'Dependencia circular',
  'hito-vencido': 'Hito vencido',
  'hito-en-riesgo': 'Hito en riesgo',
  'hito-completado-con-tareas-abiertas': 'Hito completado con tareas abiertas',
  'hito-proyecto-inexistente': 'Hito con proyecto inexistente',
  'proyecto-inactivo-con-trabajo-abierto': 'Proyecto inactivo con trabajo abierto',
  'evidencia-vinculo-roto': 'Evidencia con tarea inexistente',
  'tiempo-tarea-inexistente': 'Tiempo registrado en tarea inexistente',
  'compromiso-excede-capacidad': 'Compromisos por encima de la capacidad',
  'asignaciones-exceden-capacidad': 'Asignaciones por encima de la capacidad',
  'capacidad-no-verificable': 'Capacidad no verificable',
  'plan-con-tarea-no-ejecutable': 'Plan con tarea no ejecutable',
  'plan-diario-sin-cerrar': 'Plan diario sin cerrar',
  'pestana-no-disponible': 'Pestaña no disponible',
  'ids-duplicados': 'IDs duplicados',
  'celdas-invalidas': 'Celdas con formato inválido',
}

export function ruleLabel(regla: string): string {
  if (RULE_LABEL[regla]) return RULE_LABEL[regla]
  if (regla.startsWith('planificacion-')) return `Señal del planificador: ${regla.slice('planificacion-'.length).replace(/-/g, ' ')}`
  return regla
}

export const SEVERITY_LABEL: Record<Severity, string> = { critica: 'Crítica', alta: 'Alta', media: 'Media', baja: 'Baja', info: 'Info' }
export const SEVERITY_TONE: Record<Severity, 'danger' | 'warn' | 'info' | 'muted' | 'neutral'> = { critica: 'danger', alta: 'danger', media: 'warn', baja: 'info', info: 'muted' }
export const TYPE_LABEL: Record<AlertType, string> = {
  incumplimiento: 'Incumplimiento', discrepancia: 'Discrepancia', bloqueo: 'Bloqueo', pendiente: 'Pendiente', riesgo: 'Riesgo', revision: 'Revisión', diagnostico: 'Diagnóstico',
}
export const CONFIDENCE_LABEL: Record<Confidence, string> = { alta: 'Confianza alta', media: 'Confianza media', baja: 'Confianza baja' }
export const CATEGORY_LABEL: Record<Category, string> = {
  decisiones: 'Decisiones', bloqueos: 'Bloqueos', dependencias: 'Dependencias', vencimientos: 'Vencimientos',
  evidencias: 'Evidencias', discrepancias: 'Discrepancias', capacidad: 'Capacidad y compromisos', datos: 'Calidad de datos',
}
export const COVERAGE_LABEL: Record<CoverageState, string> = { 'con-alertas': 'Con alertas', 'sin-alertas-detectadas': 'Sin alertas detectadas', 'sin-datos': 'Sin datos suficientes' }
export const GLOBAL_TEXT: Record<GlobalState, { titulo: string; detalle: string; tone: 'danger' | 'warn' | 'info' }> = {
  critico: { titulo: 'Crítico', detalle: 'Hay alertas que impiden operar o verificar.', tone: 'danger' },
  'requiere-atencion': { titulo: 'Requiere atención', detalle: 'Hay pendientes, bloqueos o discrepancias que conviene atender.', tone: 'warn' },
  'datos-incompletos': { titulo: 'Datos incompletos', detalle: 'Faltan pestañas: no se puede afirmar que no haya alertas.', tone: 'warn' },
  'revisiones-sugeridas': { titulo: 'Revisiones sugeridas', detalle: 'Solo hay revisiones de severidad baja.', tone: 'info' },
  'sin-alertas-detectadas': { titulo: 'Sin alertas detectadas', detalle: 'Con los datos disponibles no se detectaron alertas. No significa "todo bien".', tone: 'info' },
}

const ENTITY_LABEL: Record<Entity['tipo'], string> = {
  tarea: 'Tarea', hito: 'Hito', decision: 'Decisión', proyecto: 'Proyecto', dependencia: 'Dependencia', evidencia: 'Evidencia',
  plan: 'Plan', 'plan-item': 'Elemento de plan', semana: 'Semana', sesion: 'Sesión', pestana: 'Pestaña',
}
export function entityLabel(tipo: Entity['tipo']): string {
  return ENTITY_LABEL[tipo]
}

/** Enlace interno seguro a la vista existente de la entidad (o null si no hay vista). */
export function entityHref(e: Entity, alert: Pick<Alert, 'proyectoId'>): string | null {
  const id = encodeURIComponent(e.id)
  const project = alert.proyectoId ? `/proyectos/${encodeURIComponent(alert.proyectoId)}` : null
  switch (e.tipo) {
    case 'tarea': return `/tareas?q=${id}`
    case 'proyecto': return `/proyectos/${id}`
    case 'hito': return project ? `${project}#hitos` : null
    case 'decision': return project ? `${project}#decisiones` : null
    case 'evidencia': return project ? `${project}#evidencias` : '/actividad'
    case 'plan': case 'plan-item': return '/capacidad#plan'
    case 'semana': return '/capacidad#capacidad'
    case 'sesion': return '/capacidad'
    default: return null
  }
}
