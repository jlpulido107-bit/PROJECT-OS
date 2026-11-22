import { cacheSeconds } from '../config'
import { evaluarDictamen, REGISTRO_VACIO, type EvaluacionDictamen, type DatosPr, type PrDictamen, type RegistroModelos } from '../supervision/dictamen'
import { segundoGeminiSupervisado, supervisionModeloSesion } from './config'
import { operationsService, writeGeneration } from './runtime'
import type { OperationsService } from './service'
import { REPOSITORIOS, codigoFalloGitHub, repoDeUrl, type GitHubClient } from './github'

/**
 * Dictamen vigente de las órdenes con PR (DEC-POS-009), leído de GitHub con el cliente existente. Solo lectura. Los datos
 * de GitHub se guardan en memoria DASHBOARD_CACHE_SECONDS; si GitHub falla o tarda, devuelve null («Sin datos de GitHub») y
 * guarda el fallo FALLO_MS por PR, con su código (falloDictamen), para no esperar en cada carga.
 */

const LIMITE_MS = 20_000
const FALLO_MS = 60_000
const cache = new Map<string, { hasta: number; datos: DatosPr | null; fallo?: string }>()

export interface OrdenConPr { id: string; proyectoId: string | null; prUrl: string | null; riesgo: string | null; criterios: string | null; sensible?: string | null }

export function limpiarCacheDictamenes(): void { cache.clear(); registros = null }

/** Código del último fallo de lectura guardado para el PR (http-NNN, tiempo, …) o null si no falló. */
export const falloDictamen = (prUrl: string): string | null => cache.get(prUrl)?.fallo ?? null

/** URL del comentario, armada con la del PR (nunca la que devuelve la API). */
export const urlComentario = (prUrl: string, id: number): string | null =>
  repoDeUrl(prUrl, 'pull') ? `${prUrl}#issuecomment-${id}` : null

export async function dictamenDeOrden(client: GitHubClient, o: OrdenConPr, ahora = Date.now()): Promise<EvaluacionDictamen | null> {
  const leido = await datosDePr(client, o, ahora)
  return leido && evaluarDictamen(leido.datos, o, leido.pr, { geminiSupervisado: segundoGeminiSupervisado(), ...await modelosSesionEnCache(o.id, ahora) })
}

/**
 * Opción `modelosSesion` de evaluarDictamen para una orden (ORD-POS-165, DEC-POS-039): ausente con la bandera
 * SUPERVISION_MODELO_SESION apagada (comportamiento de siempre); encendida, el registro leído ahora de AUDITORIA, o vacío
 * si no se puede leer (nada verificable: falla cerrado). Para las escrituras (REVISADA, lanzar revisión).
 */
export async function modelosSesionDe(service: OperationsService | null, ordenId: string): Promise<{ modelosSesion?: RegistroModelos }> {
  if (!supervisionModeloSesion()) return {}
  return { modelosSesion: await service?.modelosDeOrden(ordenId).catch(() => REGISTRO_VACIO) ?? REGISTRO_VACIO }
}

let registros: { hasta: number; generacion: number; leer: Promise<(ordenId: string) => RegistroModelos> } | null = null

/** Lo mismo para las páginas: una sola lectura de AUDITORIA por DASHBOARD_CACHE_SECONDS, que una escritura invalida. */
async function modelosSesionEnCache(ordenId: string, ahora: number): Promise<{ modelosSesion?: RegistroModelos }> {
  if (!supervisionModeloSesion()) return {}
  if (!registros || registros.hasta <= ahora || registros.generacion !== writeGeneration()) {
    const vacio = () => REGISTRO_VACIO
    registros = {
      hasta: ahora + cacheSeconds() * 1000, generacion: writeGeneration(),
      leer: operationsService()?.modelosRegistrados().catch(() => vacio) ?? Promise.resolve(vacio),
    }
  }
  return { modelosSesion: (await registros.leer)(ordenId) }
}

/**
 * Datos del PR registrado de la orden (head y comentarios propios) con la misma caché que dictamenDeOrden; null si la
 * URL no es de su repositorio o GitHub falla. También lo usa /agentes (ORD-POS-078) para contar dictámenes.
 */
export async function datosDePr(client: GitHubClient, o: OrdenConPr, ahora = Date.now()): Promise<{ datos: DatosPr; pr: PrDictamen } | null> {
  const repo = o.proyectoId ? REPOSITORIOS[o.proyectoId] : undefined
  if (!repo || !o.prUrl || repoDeUrl(o.prUrl, 'pull') !== repo) return null
  const prUrl = o.prUrl
  let entrada = cache.get(prUrl)
  if (!entrada || entrada.hasta <= ahora) {
    try {
      const leidos = await Promise.race([
        client.datosDictamen(o.proyectoId!, prUrl),
        new Promise<never>((_, rechazar) => setTimeout(() => rechazar(new Error('tiempo')), LIMITE_MS).unref?.()),
      ])
      entrada = { hasta: ahora + cacheSeconds() * 1000, datos: leidos }
    } catch (error) {
      const fallo = codigoFalloGitHub(error)
      // Sin presupuesto de llamadas (/agentes, ORD-POS-080) no se llamó a GitHub: no se guarda como fallo.
      if (fallo === 'presupuesto') return null
      console.warn(`[project-os] lectura del dictamen fallida: ${fallo}`)
      entrada = { hasta: ahora + FALLO_MS, datos: null, fallo }
    }
    cache.set(prUrl, entrada)
  }
  return entrada.datos && { datos: entrada.datos, pr: { repo, numero: Number(/\/pull\/(\d+)$/.exec(prUrl)![1]) } }
}
