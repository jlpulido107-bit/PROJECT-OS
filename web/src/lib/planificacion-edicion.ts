import type { EdicionCapacidad } from './planificacion-capacidad'
import type { EdicionEscenarios } from './planificacion-escenarios'
import type { PlanningInput, PlanResult } from './planning/types'

/**
 * Edición en línea desde la capa Semana (ORD-POS-136, DEC-POS-029 b y f). Funciones puras, sin red ni Next: qué tarjetas
 * se muestran, qué cuerpo se manda a PATCH /api/operaciones/tareas/{id} y cómo se lee la respuesta. Solo FECHA_PLAN,
 * HORAS_ESTIMADAS e HITO_ID; ESTADO, BLOQUEO y cualquier otro campo nunca entran al cuerpo, aunque vengan en lo escrito.
 */

export const CAMPOS_EDICION = ['fechaPlan', 'horasEstimadas', 'hitoId'] as const
export type CampoEdicion = (typeof CAMPOS_EDICION)[number]

/** Valores tal como se muestran en el formulario; '' = vacío (nunca 0). */
export type ValoresEdicion = Record<CampoEdicion, string>

export const ETIQUETA_CAMPO: Record<CampoEdicion, string> = {
  fechaPlan: 'Fecha plan (no antes de)',
  horasEstimadas: 'Horas estimadas',
  hitoId: 'Hito',
}

export interface OpcionHito {
  value: string
  label: string
}

/** Lo que el servidor manda al navegador solo con la edición encendida para la sesión del propietario. */
export type EdicionSemana =
  | { encendida: false }
  | {
    encendida: true; versiones: Record<string, number>; hitosPorProyecto: Record<string, OpcionHito[]>
    /** Panel «Capacidad de la semana» (ORD-POS-139); sin él, el panel no muestra el formulario. */
    capacidad?: EdicionCapacidad
    /** Escenarios guardados (ORD-POS-141); sin él, no se muestran Guardar ni Archivar. */
    escenarios?: EdicionEscenarios
  }

export interface TarjetaSemana {
  id: string
  titulo: string | null
  proyectoId: string | null
  valores: ValoresEdicion
}

/** Valores del formulario de una tarea de la entrada del motor: horas vacías se quedan vacías. */
export function valoresDeTarea(t: PlanningInput['tareas'][number]): ValoresEdicion {
  return { fechaPlan: t.fechaPlan ?? '', horasEstimadas: t.horasEstimadas === null ? '' : String(t.horasEstimadas), hitoId: t.hitoId ?? '' }
}

/**
 * Tarjetas de la capa Semana: tareas abiertas que el plan coloca esta semana, que ya tienen PLAN_ITEMS en ella o cuya
 * FECHA_PLAN cae entre el lunes y el domingo. Ordenadas por la posición del motor y luego por ID.
 */
export function tarjetasSemana(plan: PlanResult, input: PlanningInput): TarjetaSemana[] {
  const porId = new Map(input.tareas.map((t) => [t.id, t]))
  const { lunes, domingo } = plan.referencia
  return plan.tareas
    .filter((t) => {
      const fecha = porId.get(t.id)?.fechaPlan ?? null
      return t.propuestoMin > 0 || t.yaPlanificadoMin > 0 || (fecha !== null && fecha >= lunes && fecha <= domingo)
    })
    .sort((a, b) => (a.rango ?? Infinity) - (b.rango ?? Infinity) || a.id.localeCompare(b.id))
    .map((t) => {
      const fuente = porId.get(t.id)
      return {
        id: t.id,
        titulo: t.titulo,
        proyectoId: t.proyectoId,
        valores: fuente ? valoresDeTarea(fuente) : { fechaPlan: '', horasEstimadas: '', hitoId: '' },
      }
    })
}

/**
 * Cambios contra el valor actual, solo de los 3 campos. Vacío se manda como null (la celda queda vacía); HORAS vacía
 * nunca se convierte en 0. Cualquier otra clave de `escrito` (estado, bloqueo…) se ignora.
 */
export function cambiosEdicion(actual: ValoresEdicion, escrito: Readonly<Record<string, unknown>>): Partial<Record<CampoEdicion, string | null>> {
  const cambios: Partial<Record<CampoEdicion, string | null>> = {}
  for (const campo of CAMPOS_EDICION) {
    const raw = escrito[campo]
    const valor = typeof raw === 'string' ? raw.trim() : ''
    if (valor !== actual[campo]) cambios[campo] = valor === '' ? null : valor
  }
  return cambios
}

/** Cuerpo de PATCH /api/operaciones/tareas/{id} (sin requestId, que pone el envío), o null si no hay nada que guardar. */
export function cuerpoEdicion(version: number, actual: ValoresEdicion, escrito: Readonly<Record<string, unknown>>):
  { expectedVersion: number; changes: Partial<Record<CampoEdicion, string | null>> } | null {
  const changes = cambiosEdicion(actual, escrito)
  return Object.keys(changes).length === 0 ? null : { expectedVersion: version, changes }
}

/** Estado de un guardado, para el componente reutilizable EstadoGuardado. */
export type EstadoGuardado =
  | { tipo: 'inactivo' }
  | { tipo: 'guardando' }
  | { tipo: 'guardado'; version: number | null; repetida: boolean }
  | { tipo: 'conflicto'; versionActual: number | null; mensaje: string }
  | { tipo: 'error'; mensaje: string; campos: Record<string, string> }

/** Forma del estado de envío de forms.tsx (useOperation), sin importarlo para que esto siga siendo puro. */
export type EnvioOperacion =
  | { status: 'idle' }
  | { status: 'sending' }
  | { status: 'done'; result: { version?: number; repetida: boolean } }
  | { status: 'error'; error: { codigo: string; mensaje: string; campos?: Record<string, string>; detalle?: Record<string, unknown> } }

export function estadoGuardado(envio: EnvioOperacion): EstadoGuardado {
  switch (envio.status) {
    case 'idle': return { tipo: 'inactivo' }
    case 'sending': return { tipo: 'guardando' }
    case 'done': return { tipo: 'guardado', version: typeof envio.result.version === 'number' ? envio.result.version : null, repetida: envio.result.repetida }
    case 'error': {
      if (envio.error.codigo === 'conflicto-version') {
        const v = envio.error.detalle?.versionActual
        const versionActual = typeof v === 'number' && Number.isInteger(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null
        return { tipo: 'conflicto', versionActual, mensaje: envio.error.mensaje }
      }
      return { tipo: 'error', mensaje: envio.error.mensaje, campos: envio.error.campos ?? {} }
    }
  }
}

/** Mensaje de un campo devuelto por el servidor (`horasEstimadas` o `changes.horasEstimadas`). */
export const errorDeCampo = (estado: EstadoGuardado, campo: CampoEdicion): string | undefined =>
  estado.tipo === 'error' ? estado.campos[campo] ?? estado.campos[`changes.${campo}`] : undefined

/** «Guardar el mío sobre el actual» solo cuando la vista ya trae la versión que causó el conflicto. */
export const actualCargado = (estado: EstadoGuardado, versionVista: number): boolean =>
  estado.tipo === 'conflicto' && (estado.versionActual === null || versionVista >= estado.versionActual)
