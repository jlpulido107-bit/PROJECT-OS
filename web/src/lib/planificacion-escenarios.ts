import { fingerprint } from './planning/fingerprint'
import { normalizeScenario, ScenarioError, sinFijadasVacias } from './planning/scenario'
import type { PlanningInput, ProjectPriority, Scenario } from './planning/types'
import type { EscenarioGuardado } from './types'

/**
 * Escenarios guardados de /planificacion (ORD-POS-141, DEC-POS-029 d; docs/escritura-v1-8.md §11.1). Funciones puras, sin
 * red ni Next: la huella de los datos, qué escenarios se pueden cargar, el aviso de datos cambiados, el cuerpo de
 * POST /api/operaciones/escenarios y el formulario de un escenario cargado. Guardar o cargar nunca cambia el plan:
 * cargar solo re-simula en el navegador.
 */

/** Lo que el servidor manda al navegador con la edición encendida para la sesión del propietario. */
export interface EdicionEscenarios {
  /** La hoja ya tiene la pestaña ESCENARIOS con sus encabezados (migración de §11.2). */
  migrada: boolean
}

/**
 * Huella de los datos de entrada del motor (PlanningInput), sin escenario ni fecha de referencia: cambia si cambian las
 * pestañas que lee el planificador (TAREAS, CAPACIDAD_SEMANAL, PLAN_ITEMS, TIEMPOS…), no por pasar el día. ESCENARIOS no
 * entra en la entrada del motor, así que guardar un escenario no cambia la huella.
 */
export function huellaDatos(input: PlanningInput): string {
  return fingerprint(input)
}

export const AVISO_DATOS_CAMBIADOS = 'Los datos cambiaron desde que lo guardaste'

/** Escenario guardado listo para la lista: `escenario` null si PARAMETROS no es un escenario válido (no se carga). */
export interface EscenarioCargable {
  id: string
  nombre: string
  semanaId: string | null
  creadoEn: string | null
  huella: string | null
  /** VERSION entera; null si falta (no se archiva hasta escribir 1). */
  version: number | null
  escenario: Scenario | null
  /** Por qué no se puede cargar (PARAMETROS dañado). */
  problema: string | null
}

/** Escenario de PARAMETROS (JSON) validado con normalizeScenario; nunca se confía en la hoja. */
export function escenarioDeParametros(parametros: string | null): { escenario: Scenario } | { problema: string } {
  if (!parametros) return { problema: 'PARAMETROS vacío' }
  let raw: unknown
  try {
    raw = JSON.parse(parametros)
  } catch {
    return { problema: 'PARAMETROS no es JSON válido' }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { problema: 'PARAMETROS no es un escenario' }
  try {
    return { escenario: normalizeScenario(raw as Partial<Record<keyof Scenario, unknown>>) }
  } catch (error) {
    if (error instanceof ScenarioError) return { problema: `PARAMETROS no válido (${error.field}: ${error.message})` }
    throw error
  }
}

/** Escenarios ACTIVO de la hoja, del más nuevo al más viejo; los ARCHIVADO (u otro estado) no se listan. */
export function escenariosActivos(filas: readonly EscenarioGuardado[]): EscenarioCargable[] {
  return filas
    .filter((f) => f.estado === 'ACTIVO')
    .map((f) => {
      const parsed = escenarioDeParametros(f.parametros)
      return {
        id: f.id,
        nombre: f.nombre ?? f.id,
        semanaId: f.semanaId,
        creadoEn: f.creadoEn?.date ?? null,
        huella: f.huella,
        version: /^\d+$/.test(f.version ?? '') ? Number(f.version) : null,
        escenario: 'escenario' in parsed ? parsed.escenario : null,
        problema: 'problema' in parsed ? parsed.problema : null,
      }
    })
    .sort((a, b) => b.id.localeCompare(a.id, 'es', { numeric: true }))
}

/** Aviso al cargar: la huella guardada no es la de los datos de ahora (o no hay huella). null si coinciden. */
export function avisoAlCargar(guardado: Pick<EscenarioCargable, 'huella'>, huellaActual: string): string | null {
  return guardado.huella === huellaActual ? null : AVISO_DATOS_CAMBIADOS
}

export interface CuerpoEscenario {
  nombre: string
  semanaId: string
  parametros: Scenario
  huella: string
}

/** Cuerpo de POST /api/operaciones/escenarios (sin requestId, que pone el envío), o el error del nombre. */
export function cuerpoEscenario(nombre: string, semanaId: string, escenario: Scenario, huella: string): CuerpoEscenario | { error: string } {
  const limpio = nombre.trim()
  if (limpio === '') return { error: 'Escribe un nombre para el escenario' }
  if (limpio.length > 80) return { error: 'Máximo 80 caracteres' }
  return { nombre: limpio, semanaId, parametros: sinFijadasVacias(escenario), huella }
}

/** Valores del formulario de escenario de la vista (strings, como los edita el usuario) para un escenario cargado. */
export interface FormularioEscenario {
  semana: string
  ajusteHoras: string
  reservaPct: string
  horasSiFaltan: string
  horasSiSinEstimacion: string
  sobrecargaPct: string
  descontarRegistrado: boolean
  diasLaborables: number[]
  prioridadProyecto: Record<string, ProjectPriority | ''>
}

const texto = (n: number | null) => (n === null ? '' : String(n))

export function formularioDeEscenario(s: Scenario): FormularioEscenario {
  return {
    semana: s.semana,
    ajusteHoras: String(s.ajusteHoras),
    reservaPct: texto(s.reservaPct),
    horasSiFaltan: texto(s.horasSiFaltan),
    horasSiSinEstimacion: texto(s.horasSiSinEstimacion),
    sobrecargaPct: String(s.sobrecargaPct),
    descontarRegistrado: s.descontarRegistrado,
    diasLaborables: [...s.diasLaborables],
    prioridadProyecto: { ...s.prioridadProyecto },
  }
}
