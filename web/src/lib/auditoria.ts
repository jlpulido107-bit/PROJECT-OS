import 'server-only'

import { cacheSeconds } from './config'
import { WRITE_HEADERS } from './operations/constants'
import { canWrite, isWriter } from './operations/config'
import { auditTable, writeGeneration } from './operations/runtime'
import { InMemoryTableStore, readView, type TableView } from './operations/table-store'

/**
 * AUDITORIA para Inicio, /metricas y /agentes (ORD-POS-096, diseño de Inicio v2 §5). Sus filas llevan correos de actores:
 * solo se leen para escritores con la escritura activa, y esa comprobación va ANTES de tocar la caché, así que un lector
 * no escritor nunca dispara la lectura ni recibe datos guardados. La caché vive en el proceso DASHBOARD_CACHE_SECONDS y
 * se descarta con cada escritura (writeGeneration); un fallo no se guarda. /operaciones sigue leyendo sin caché.
 */

export type LecturaAuditoria =
  /** La fuente no existe para esta sesión, por configuración: lector no escritor o escritura no activa. */
  | { estado: 'apagada'; motivo: string }
  | { estado: 'sin-datos'; motivo: string }
  | { estado: 'ok'; datos: TableView }

export const MOTIVO_NO_ESCRITOR = 'AUDITORIA solo se lee para escritores (sus filas llevan correos).'
export const MOTIVO_ESCRITURA_INACTIVA = 'La escritura no está activa: AUDITORIA no se puede leer.'
export const MOTIVO_FALLO = 'No se pudo leer AUDITORIA con la cuenta de escritura. Revisa sus permisos (docs/escritura-v1-8.md).'

interface Entrada { hasta: number; generacion: number; vista: TableView }
const KEY = Symbol.for('project-os.auditoria-cache.v1')

/** Caché por proceso en globalThis: Next empaqueta cada página por separado (como operations/runtime.ts). */
function cache(): { entrada: Entrada | null } {
  const g = globalThis as unknown as Record<symbol, { entrada: Entrada | null } | undefined>
  g[KEY] ??= { entrada: null }
  return g[KEY]
}

export function limpiarCacheAuditoria(): void { cache().entrada = null }

export interface AccesoAuditoria {
  /** Escritor con la escritura activa (canWrite). */
  permitido: boolean
  /** Motivo de `apagada` cuando no está permitido. */
  motivo: string
}

export interface DepsAuditoria {
  leer: () => Promise<string[][] | null>
  ahora: number
  ttlMs: number
  generacion: number
}

/** Núcleo con dependencias inyectadas (pruebas). Nunca lanza. */
export async function auditoriaCompartida(acceso: AccesoAuditoria, deps: DepsAuditoria): Promise<LecturaAuditoria> {
  // Primero el permiso: sin él no se mira la caché ni se lee nada.
  if (!acceso.permitido) return { estado: 'apagada', motivo: acceso.motivo }
  const c = cache()
  const e = c.entrada
  if (e && e.hasta > deps.ahora && e.generacion === deps.generacion) return { estado: 'ok', datos: e.vista }
  try {
    const rows = await deps.leer()
    if (!rows) return { estado: 'apagada', motivo: MOTIVO_ESCRITURA_INACTIVA }
    const vista = await readView(new InMemoryTableStore({ AUDITORIA: rows.length ? rows : [[...WRITE_HEADERS.AUDITORIA]] }), 'AUDITORIA')
    c.entrada = { hasta: deps.ahora + deps.ttlMs, generacion: deps.generacion, vista }
    return { estado: 'ok', datos: vista }
  } catch {
    return { estado: 'sin-datos', motivo: MOTIVO_FALLO }
  }
}

/** Acceso de la sesión a AUDITORIA. */
export function accesoAuditoria(email: string, env: NodeJS.ProcessEnv = process.env): AccesoAuditoria {
  if (canWrite(email, env)) return { permitido: true, motivo: '' }
  return { permitido: false, motivo: isWriter(email, env) ? MOTIVO_ESCRITURA_INACTIVA : MOTIVO_NO_ESCRITOR }
}

/** AUDITORIA de la sesión con la caché compartida. */
export function leerAuditoria(email: string): Promise<LecturaAuditoria> {
  return auditoriaCompartida(accesoAuditoria(email), {
    leer: auditTable, ahora: Date.now(), ttlMs: cacheSeconds() * 1000, generacion: writeGeneration(),
  })
}
