import { taskState } from './aggregate'
import { proyectoDeOrden, PROYECTOS_AGENTES, type Indicador, type ProyectoAgentes } from './agentes'
import { civilDateInZone, daysBetween } from './dates'
import { urlGithub } from './estado'
import type { FinanzasVista, Pendiente } from './finanzas/finanzas'
import type { PrFusion } from './operations/github'
import { COMPLETED_STATE } from './schema'
import type { Dataset, Decision, Orden, Tarea } from './types'

/**
 * Inicio del dashboard (ORD-POS-090, POS-026): progreso, pendientes y finanzas en una sola vista. Funciones puras sobre
 * lo que ya leen /estado, /ordenes, /agentes y /finanzas: no leen ni escriben. Si falta una fuente, su bloque es
 * «sin datos» con el motivo; nunca se rellena con ceros.
 */

/** Días hacia adelante en que un hito o una tarea «vence pronto». */
export const DIAS_PROXIMO = 7

export type Marca = 'vencido' | 'proximo' | null

const sinDatos = (motivo: string) => ({ estado: 'sin-datos', motivo }) as const

/** Filtro desde la URL (`?proyecto=POS`); un valor no válido se ignora (todos). */
export function parseFiltroInicio(params: Record<string, string | string[] | undefined>): ProyectoAgentes | null {
  const v = typeof params.proyecto === 'string' ? params.proyecto.trim().toUpperCase() : ''
  return (PROYECTOS_AGENTES as readonly string[]).includes(v) ? (v as ProyectoAgentes) : null
}

export function marcaDe(dias: number): Marca {
  return dias < 0 ? 'vencido' : dias <= DIAS_PROXIMO ? 'proximo' : null
}

export interface HitoInicio {
  id: string
  nombre: string | null
  fecha: string
  dias: number
  completadas: number
  /** Tareas del hito sin contar las CANCELADO. */
  total: number
  marca: Marca
}

export interface ProyectoInicio {
  proyecto: ProyectoAgentes
  nombre: string | null
  hitos: HitoInicio[]
}

/**
 * Bloque Proyectos: por proyecto, sus hitos abiertos (no COMPLETADO) con fecha, con el avance en tareas completadas de
 * total, primero el que vence antes. Sin HITOS o TAREAS legibles, «sin datos».
 */
export function proyectosInicio(ds: Dataset, hoy: string, filtro: ProyectoAgentes | null): Indicador<ProyectoInicio[]> {
  if (!ds.tabs.HITOS.ok) return sinDatos('La pestaña HITOS no está disponible.')
  if (!ds.tabs.TAREAS.ok) return sinDatos('La pestaña TAREAS no está disponible: sin avance de los hitos.')
  const proyectos = PROYECTOS_AGENTES.filter((p) => filtro === null || p === filtro)
  return {
    estado: 'ok',
    datos: proyectos.map((proyecto) => ({
      proyecto,
      nombre: ds.proyectos.find((p) => p.id === proyecto)?.nombre ?? null,
      hitos: ds.hitos
        .filter((h) => h.proyectoId === proyecto && h.fechaObjetivo !== null && h.estado !== COMPLETED_STATE)
        .map((h): HitoInicio => {
          const tareas = ds.tareas.filter((t) => t.hitoId === h.id && t.estado !== 'CANCELADO')
          const dias = daysBetween(hoy, h.fechaObjetivo!)
          return {
            id: h.id, nombre: h.nombre, fecha: h.fechaObjetivo!, dias, marca: marcaDe(dias),
            completadas: tareas.filter((t) => t.estado === COMPLETED_STATE).length, total: tareas.length,
          }
        })
        .sort((a, b) => a.fecha.localeCompare(b.fecha) || a.id.localeCompare(b.id)),
    })),
  }
}

/**
 * atajo: la hoja no registra quién es el propietario (un solo usuario, docs/v1-5-planning-contract.md); se toman como
 * suyas las tareas cuyo RESPONSABLE no nombra a un agente (Claude o Codex). Mejorarlo si TAREAS distingue al propietario.
 */
export function esDelPropietario(t: Pick<Tarea, 'responsable'>): boolean {
  return !/\b(claude|codex)\b/i.test(t.responsable ?? '')
}

export interface TareaPendiente {
  tarea: Tarea
  dias: number
  marca: Exclude<Marca, null>
}

export interface PrSinRegistrar {
  orden: Orden
  prUrl: string | null
}

export interface Pendientes {
  tareas: Indicador<TareaPendiente[]>
  revisadas: Indicador<Orden[]>
  /** `sinDatos`: proyectos con órdenes ENVIADA cuyo GitHub no se pudo leer. */
  prSinRegistrar: Indicador<{ lista: PrSinRegistrar[]; sinDatos: string[] }>
  decisiones: Indicador<Decision[]>
  recurrentes: Indicador<Pendiente[]>
}

export interface FuentesPendientes {
  /** PRs de órdenes por proyecto (la caché de /agentes); null si no hay token de GitHub en el servidor. */
  prs: Record<string, Map<string, PrFusion> | null> | null
  /** Recurrentes del mes sin confirmar (FINANZAS), o el motivo de que no haya datos. */
  recurrentes: Pendiente[] | { motivo: string }
}

export function misPendientes(ds: Dataset, hoy: string, filtro: ProyectoAgentes | null, fuentes: FuentesPendientes): Pendientes {
  const delProyecto = (p: string | null) => filtro === null || p === filtro
  const ordenes = ds.ordenes.filter((o) => delProyecto(proyectoDeOrden(o)))
  const ordenesOk = ds.tabs.ORDENES_CODEX.ok

  const tareas: Pendientes['tareas'] = !ds.tabs.TAREAS.ok ? sinDatos('La pestaña TAREAS no está disponible.') : {
    estado: 'ok',
    datos: ds.tareas
      .filter((t) => delProyecto(t.proyectoId) && taskState(t) === 'abierta' && t.fechaLimite !== null && esDelPropietario(t))
      .map((t) => ({ tarea: t, dias: daysBetween(hoy, t.fechaLimite!) }))
      .flatMap(({ tarea, dias }) => {
        const marca = marcaDe(dias)
        return marca ? [{ tarea, dias, marca }] : []
      })
      .sort((a, b) => a.dias - b.dias || a.tarea.id.localeCompare(b.tarea.id)),
  }

  const revisadas: Pendientes['revisadas'] = !ordenesOk ? sinDatos('La pestaña ORDENES_CODEX no está disponible.')
    : { estado: 'ok', datos: ordenes.filter((o) => o.estado === 'REVISADA').sort((a, b) => a.id.localeCompare(b.id)) }

  let prSinRegistrar: Pendientes['prSinRegistrar']
  const enviadas = ordenes.filter((o) => o.estado === 'ENVIADA')
  if (!ordenesOk) prSinRegistrar = sinDatos('La pestaña ORDENES_CODEX no está disponible.')
  else if (fuentes.prs === null) prSinRegistrar = sinDatos('Sin token de GitHub en este servidor: no se detectan PRs.')
  else {
    const prs = fuentes.prs
    const sinDatosDe = new Set<string>()
    const lista: PrSinRegistrar[] = []
    for (const o of enviadas) {
      const p = proyectoDeOrden(o)
      const mapa = p ? prs[p] : undefined
      if (!mapa) {
        sinDatosDe.add(p ?? 'SIN_PROYECTO')
        continue
      }
      const pr = mapa.get(o.id)
      if (pr) lista.push({ orden: o, prUrl: urlGithub(pr.url) })
    }
    // Ninguna orden ENVIADA tenía su GitHub legible: no se sabe nada, no es «ninguno».
    prSinRegistrar = enviadas.length > 0 && enviadas.every((o) => sinDatosDe.has(proyectoDeOrden(o) ?? 'SIN_PROYECTO'))
      ? sinDatos(`No se pudieron leer los PRs de GitHub de ${[...sinDatosDe].sort().join(', ')}.`)
      : { estado: 'ok', datos: { lista: lista.sort((a, b) => a.orden.id.localeCompare(b.orden.id)), sinDatos: [...sinDatosDe].sort() } }
  }

  const decisiones: Pendientes['decisiones'] = !ds.tabs.DECISIONES.ok ? sinDatos('La pestaña DECISIONES no está disponible.') : {
    estado: 'ok',
    datos: ds.decisiones.filter((d) => d.estado === 'PENDIENTE' && delProyecto(d.proyectoId)).sort((a, b) => a.id.localeCompare(b.id)),
  }

  const recurrentes: Pendientes['recurrentes'] = !Array.isArray(fuentes.recurrentes) ? sinDatos(fuentes.recurrentes.motivo)
    : filtro !== null && filtro !== 'ECO' && filtro !== 'POS' ? sinDatos('FINANZAS solo registra ECO y POS.')
    : { estado: 'ok', datos: fuentes.recurrentes.filter((p) => delProyecto(p.recurrente.proyecto)) }

  return { tareas, revisadas, prSinRegistrar, decisiones, recurrentes }
}

/** Recurrentes sin confirmar desde la vista de FINANZAS, o el motivo de que no haya datos. */
export function recurrentesSinConfirmar(vista: FinanzasVista | null, motivo: string): FuentesPendientes['recurrentes'] {
  if (!vista) return { motivo }
  return vista.recurrentes.estado === 'ok' ? vista.recurrentes.datos.pendientes : { motivo: vista.recurrentes.mensaje }
}

export interface FinanzasInicio {
  mes: string
  /** Gasto + Inversión del mes en curso (del proyecto del filtro o de ECO + POS), en centavos. */
  gastoMes: Indicador<number>
  /** Capital del libro entero (el tope es uno para ECO y POS). */
  capital: Indicador<{ usadoCentavos: number; topeCentavos: number | null; pct: number | null; alerta: null | 'aviso' | 'superado' }>
  /** Claude como su recurrente (RECURRENTES ID CLAUDE): lo registrado en el mes y lo que falta confirmar. */
  claude: Indicador<{ registradoCentavos: number | null; pendiente: Pendiente | null }>
}

export const ID_RECURRENTE_CLAUDE = 'CLAUDE'

/** Bloque Finanzas: sin la vista de FINANZAS (no configurado o error), «sin datos» con el motivo. */
export function finanzasInicio(vista: FinanzasVista | null, motivo: string, now: number, filtro: ProyectoAgentes | null): Indicador<FinanzasInicio> {
  if (!vista) return sinDatos(motivo)
  if (filtro !== null && filtro !== 'ECO' && filtro !== 'POS') return sinDatos('FINANZAS solo registra ECO y POS.')
  const mes = civilDateInZone(now).slice(0, 7)
  const suma = (g: Record<'ECO' | 'POS', number>) => (filtro ? g[filtro] : g.ECO + g.POS)

  let gastoMes: FinanzasInicio['gastoMes']
  if (vista.mensual.estado !== 'ok') gastoMes = sinDatos(vista.mensual.mensaje)
  else {
    const fila = vista.mensual.datos.meses.find((m) => m.mes === mes)
    gastoMes = fila ? { estado: 'ok', datos: suma(fila.gasto) } : sinDatos(`El mes ${mes} está fuera de la ventana de FINANZAS.`)
  }

  const capital: FinanzasInicio['capital'] = vista.capital.estado !== 'ok' ? sinDatos(vista.capital.mensaje) : {
    estado: 'ok',
    datos: {
      usadoCentavos: vista.capital.datos.usadoCentavos, topeCentavos: vista.capital.datos.topeCentavos,
      pct: vista.capital.datos.pct, alerta: vista.capital.datos.alerta,
    },
  }

  const delMes = vista.claude.estado === 'ok' ? vista.claude.datos.find((m) => m.mes === mes) : undefined
  const registradoCentavos = delMes ? suma(delMes.gasto) : null
  const pendiente = vista.recurrentes.estado === 'ok'
    ? vista.recurrentes.datos.pendientes.find((p) => p.recurrente.id === ID_RECURRENTE_CLAUDE && (filtro === null || p.recurrente.proyecto === filtro)) ?? null
    : null
  const claude: FinanzasInicio['claude'] = registradoCentavos === null && pendiente === null
    ? sinDatos(vista.recurrentes.estado === 'ok' || vista.claude.estado === 'ok'
      ? `Sin gasto de Claude registrado en ${mes} ni recurrente ${ID_RECURRENTE_CLAUDE} pendiente.`
      : 'Sin MOVIMIENTOS ni RECURRENTES legibles.')
    : { estado: 'ok', datos: { registradoCentavos, pendiente } }

  return { estado: 'ok', datos: { mes, gastoMes, capital, claude } }
}
