import 'server-only'

import { pmPuedeRegistrarPr, segundoGeminiSupervisado, tareasCierrePropietario } from './operations/config'
import { finanzasAgenteMode } from './finanzas/agente-config'
import { ecoPipelineWriteMode } from './radaros/pipeline-escritura-config'
import { tiemposAgenteHabilitado } from './tiempos-agente'

/**
 * Banderas del propietario que una orden puede dejar inerte (ORD-POS-125, POS-041; docs/diseno-planificacion-v2.md §4.1,
 * §6.4 y §9, DEC-POS-028). Solo lectura: cada una se lee con su función *Habilitado existente y se expone solo como
 * encendida o apagada, con su nombre en palabras; nunca el valor, el correo ni el hash de un token. La clave es el nombre
 * de la variable que el propietario pone con deploy.sh y que escribe en la columna BANDERA de ORDENES_CODEX.
 */

export interface Bandera {
  /** Nombre en palabras (regla de lenguaje, §2). */
  nombre: string
  encendida: (env: NodeJS.ProcessEnv) => boolean
}

export const BANDERAS: Readonly<Record<string, Bandera>> = {
  PM_PUEDE_REGISTRAR_PR: { nombre: 'Registro de PR por el PM', encendida: pmPuedeRegistrarPr },
  SEGUNDO_GEMINI_SUPERVISADO: { nombre: 'Segundo revisor Gemini supervisado', encendida: segundoGeminiSupervisado },
  TAREAS_CIERRE_PROPIETARIO: { nombre: 'Cierre de tareas por el propietario', encendida: (env) => tareasCierrePropietario(env) !== null },
  TIEMPOS_AGENTE: { nombre: 'Agente de Tiempos (lectura de /api/planificacion)', encendida: tiemposAgenteHabilitado },
  FINANZAS_AGENTE_MODE: { nombre: 'Agente de finanzas (registro de cortes)', encendida: (env) => finanzasAgenteMode(env) === 'sheets' },
  ECO_PIPELINE_WRITE_MODE: { nombre: 'Escritura del pipeline de /eco', encendida: (env) => ecoPipelineWriteMode(env) === 'sheets' },
}

/** Clave de la celda BANDERA: sin espacios y en mayúsculas; null si está vacía. */
export const claveBandera = (celda: string | null | undefined): string | null => celda?.trim().toUpperCase() || null

/**
 * Cómo se muestra una clave que no está en BANDERAS: tal cual solo si parece el nombre de una variable (letras, dígitos y
 * guion bajo, hasta 64), para no pintar texto libre de la hoja.
 */
export const nombreDesconocida = (clave: string): string =>
  /^[A-Z][A-Z0-9_]{0,63}$/.test(clave) ? `«${clave}»` : '(nombre no válido)'

export type EstadoBandera =
  | { tipo: 'encendida' | 'apagada'; clave: string; nombre: string }
  | { tipo: 'desconocida'; clave: string; nombre: string }

/** Estado de la bandera de la celda BANDERA; null si la celda está vacía (la orden no deja nada inerte). */
export function estadoBandera(celda: string | null | undefined, env: NodeJS.ProcessEnv = process.env): EstadoBandera | null {
  const clave = claveBandera(celda)
  if (clave === null) return null
  const b = Object.hasOwn(BANDERAS, clave) ? BANDERAS[clave]! : null
  if (!b) return { tipo: 'desconocida', clave, nombre: nombreDesconocida(clave) }
  return { tipo: b.encendida(env) ? 'encendida' : 'apagada', clave, nombre: b.nombre }
}

export const MOTIVO_SIN_COLUMNA_BANDERA = 'Falta la columna BANDERA en ORDENES_CODEX (la añade el propietario con la migración).'
export const motivoDesconocida = (nombre: string) => `Bandera ${nombre} no reconocida: no se sabe si está encendida.`

export const MOTIVO_BANDERAS_NO_PROPIETARIO = 'El estado de las banderas solo lo ve la sesión del propietario.'

/**
 * De dónde sale Activada: `ok` con el entorno del servidor (solo para la sesión del propietario y con la columna BANDERA);
 * si no, `apagada` con su motivo. Sin esta fuente, Activada queda apagada por falta de la columna.
 */
export type FuenteBanderas = { estado: 'ok'; env: NodeJS.ProcessEnv } | { estado: 'apagada'; motivo: string }

/** La fuente de Activada para esta carga (diseño §6, regla «solo para la sesión del propietario»). */
export const fuenteBanderas = (columna: boolean, propietario: boolean, env: NodeJS.ProcessEnv = process.env): FuenteBanderas =>
  !columna ? { estado: 'apagada', motivo: MOTIVO_SIN_COLUMNA_BANDERA }
    : !propietario ? { estado: 'apagada', motivo: MOTIVO_BANDERAS_NO_PROPIETARIO }
      : { estado: 'ok', env }
