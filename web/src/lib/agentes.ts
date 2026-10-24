import { civilHourInZone, parseCivilDate, parseTimestamp } from './dates'
import type { Bloque, GastoClaudeMes } from './finanzas/finanzas'
import { percentil, riesgoDe, RIESGOS, type EventosOrden, type Riesgo } from './metricas'
import type { PrFusion } from './operations/github'
import { parseAudit } from './operations/service'
import { cell, type TableView } from './operations/table-store'
import { ESTADOS_ORDEN } from './ordenes'
import type { Veredicto } from './supervision/types'
import type { Orden } from './types'

/**
 * Indicadores de /agentes (ORD-POS-078, POS-029): cómo trabaja el sistema de agentes, solo con datos que ya existen
 * (ORDENES_CODEX, AUDITORIA, FINANZAS y PRs de GitHub). Funciones puras: no leen ni escriben. Los eventos de cada orden
 * (alta, envío, rondas) salen de eventosOrdenes de /metricas; aquí no se vuelven a calcular. Si falta una fuente, el
 * indicador es «sin datos» con su motivo: nunca se rellena con ceros.
 */

export const PROYECTOS_AGENTES = ['POS', 'SIG', 'ECO', 'DEV', 'ALI'] as const
export type ProyectoAgentes = (typeof PROYECTOS_AGENTES)[number]

export interface FiltroAgentes {
  proyecto: ProyectoAgentes | null
  /** Fechas civiles (YYYY-MM-DD, hora de Mérida), ambas incluidas. */
  desde: string | null
  hasta: string | null
}

export type Indicador<T> = { estado: 'sin-datos'; motivo: string } | { estado: 'ok'; datos: T }

const DIA_MS = 86_400_000
const sinDatos = (motivo: string) => ({ estado: 'sin-datos', motivo }) as const
const redondea = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10)
const conRango = (f: FiltroAgentes) => f.desde !== null || f.hasta !== null

/** Filtro desde la URL (`?proyecto=POS&desde=2026-10-01&hasta=2026-10-31`); un valor no válido se ignora. */
export function parseFiltroAgentes(params: Record<string, string | string[] | undefined>): FiltroAgentes {
  const uno = (k: string) => {
    const v = params[k]
    return typeof v === 'string' ? v.trim() : null
  }
  const proyecto = (PROYECTOS_AGENTES as readonly string[]).find((p) => p === uno('proyecto')?.toUpperCase()) as ProyectoAgentes | undefined
  const fecha = (k: string) => {
    const v = uno(k)
    return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? parseCivilDate(v).value : null
  }
  let desde = fecha('desde')
  let hasta = fecha('hasta')
  if (desde && hasta && desde > hasta) [desde, hasta] = [hasta, desde]
  return { proyecto: proyecto ?? null, desde, hasta }
}

export function enRango(fecha: string, f: FiltroAgentes): boolean {
  return (f.desde === null || fecha >= f.desde) && (f.hasta === null || fecha <= f.hasta)
}

/** Proyecto de la orden: PROYECTO_ID de la hoja o, sin él, el prefijo de su ID (ORD-POS-… → POS). */
export function proyectoDeOrden(o: Pick<Orden, 'id' | 'proyectoId'>): string | null {
  return o.proyectoId ?? /^ORD-([A-Z]{3})-\d{3}$/.exec(o.id)?.[1] ?? null
}

const fechaMs = (ms: number) => civilHourInZone(ms).date

/**
 * Órdenes del filtro: las del proyecto y, con rango, las de alta (`orden.crear` en AUDITORIA) dentro del rango. Sin
 * AUDITORIA no se puede fechar el alta: con rango es «sin datos»; sin rango cuentan todas.
 */
export function ordenesDelFiltro(ordenes: Orden[], eventos: EventosOrden[] | null, f: FiltroAgentes): Indicador<{ ordenes: Orden[]; sinFecha: number }> {
  if (ordenes.length === 0) return sinDatos('No hay órdenes en ORDENES_CODEX.')
  const delProyecto = ordenes.filter((o) => f.proyecto === null || proyectoDeOrden(o) === f.proyecto)
  if (!conRango(f)) return { estado: 'ok', datos: { ordenes: delProyecto, sinFecha: 0 } }
  if (!eventos) return sinDatos('Con rango de fechas hace falta AUDITORIA para fechar el alta de cada orden.')
  const alta = new Map(eventos.map((e) => [e.id, e.creadaMs]))
  let sinFecha = 0
  const dentro = delProyecto.filter((o) => {
    const ms = alta.get(o.id) ?? null
    if (ms === null) sinFecha++
    return ms !== null && enRango(fechaMs(ms), f)
  })
  return { estado: 'ok', datos: { ordenes: dentro, sinFecha } }
}

export interface ConteoOrdenes {
  total: number
  porEstado: Array<[string, number]>
  porProyecto: Array<[string, number]>
  porRiesgo: Array<[Riesgo, number]>
  /** Con rango: órdenes del proyecto sin alta en AUDITORIA (fuera del conteo). */
  sinFecha: number
}

const ordenado = (mapa: Map<string, number>, orden: readonly string[]) =>
  [...mapa].sort(([a], [b]) => {
    const ia = orden.indexOf(a)
    const ib = orden.indexOf(b)
    return (ia === -1 ? orden.length : ia) - (ib === -1 ? orden.length : ib) || a.localeCompare(b)
  })

/** Indicador 1: órdenes por estado, por proyecto y por riesgo (ORDENES_CODEX). */
export function conteoOrdenes(base: Indicador<{ ordenes: Orden[]; sinFecha: number }>): Indicador<ConteoOrdenes> {
  if (base.estado !== 'ok') return base
  const { ordenes, sinFecha } = base.datos
  const cuenta = (clave: (o: Orden) => string) => {
    const m = new Map<string, number>()
    for (const o of ordenes) m.set(clave(o), (m.get(clave(o)) ?? 0) + 1)
    return m
  }
  return {
    estado: 'ok',
    datos: {
      total: ordenes.length,
      porEstado: ordenado(cuenta((o) => o.estado ?? 'SIN_ESTADO'), ESTADOS_ORDEN),
      porProyecto: ordenado(cuenta((o) => proyectoDeOrden(o) ?? 'SIN_PROYECTO'), PROYECTOS_AGENTES),
      porRiesgo: ordenado(cuenta((o) => riesgoDe(o.riesgo)), [...RIESGOS, 'SIN_RIESGO']) as Array<[Riesgo, number]>,
      sinFecha,
    },
  }
}

export type FusionProyecto =
  | { proyecto: string; estado: 'sin-datos'; motivo: string }
  /** `truncado`: la lista de PRs llegó al límite de paginación; la mediana solo usa los PRs leídos (ORD-POS-080). */
  | { proyecto: string; estado: 'ok'; n: number; medianaDias: number | null; truncado: boolean }

/**
 * Indicador 2: mediana de días desde ENVIADA (`orden.enviar` en AUDITORIA) hasta la fusión del PR (GitHub), por
 * proyecto. El rango filtra por la fecha de envío. `prs` por proyecto: null si GitHub falló o no hay repositorio.
 * `truncados`: proyectos cuya lista de PRs llegó al límite de paginación.
 */
export function tiempoAFusion(
  ordenes: Orden[], eventos: EventosOrden[] | null, prs: Partial<Record<string, Map<string, PrFusion> | null>> | null, f: FiltroAgentes,
  truncados: readonly string[] = [],
): Indicador<FusionProyecto[]> {
  if (!eventos) return sinDatos('Falta AUDITORIA: sin ella no se sabe cuándo se envió cada orden.')
  if (!prs) return sinDatos('Sin datos de GitHub: no se sabe cuándo se fusionó cada PR.')
  const envio = new Map(eventos.map((e) => [e.id, e.enviadaMs]))
  const proyectos = f.proyecto ? [f.proyecto] : PROYECTOS_AGENTES.filter((p) => p in prs || ordenes.some((o) => proyectoDeOrden(o) === p))
  return {
    estado: 'ok',
    datos: proyectos.map((proyecto): FusionProyecto => {
      const delRepo = prs[proyecto]
      if (!delRepo) return { proyecto, estado: 'sin-datos', motivo: proyecto in prs ? 'GitHub no respondió.' : 'Sin repositorio en GitHub.' }
      const dias = ordenes.filter((o) => proyectoDeOrden(o) === proyecto).flatMap((o) => {
        const env = envio.get(o.id) ?? null
        const fusion = delRepo.get(o.id)?.fusionMs ?? null
        if (env === null || fusion === null || fusion < env || !enRango(fechaMs(env), f)) return []
        return [(fusion - env) / DIA_MS]
      })
      return { proyecto, estado: 'ok', n: dias.length, medianaDias: redondea(percentil(dias, 50)), truncado: truncados.includes(proyecto) }
    }),
  }
}

/** Dictámenes válidos de un PR (dictamenesValidos), o null si no se pudo leer. */
export type DictamenesPr = Array<{ revisionId: string; veredicto: Veredicto }> | null

/** Estados cuyas órdenes ya no cambian de dictamen: /agentes no los pide a GitHub (ORD-POS-080). */
export const ESTADOS_SIN_DICTAMEN: readonly string[] = ['CERRADA', 'CANCELADA']

/** ¿Se leen los dictámenes de la orden? No en CERRADA ni CANCELADA. */
export const leeDictamen = (o: Pick<Orden, 'estado'>): boolean => !ESTADOS_SIN_DICTAMEN.includes(o.estado ?? '')

export interface FilaDictamenes {
  ordenId: string
  prUrl: string
  /** Rondas de corrección lanzadas desde el dashboard (eventosOrdenes); null sin AUDITORIA. */
  rondas: number | null
  /** null si GitHub no respondió para este PR o no se leyó (`omitida`). */
  conforme: number | null
  cambios: number | null
  /** Orden CERRADA o CANCELADA: sus dictámenes no se piden a GitHub; fuera de los totales y de `sinLeer`. */
  omitida: boolean
}

export interface Dictamenes {
  filas: FilaDictamenes[]
  totalConforme: number
  totalCambios: number
  /** PRs cuyos comentarios no se pudieron leer: fuera de los totales. */
  sinLeer: number
  /** Órdenes CERRADA o CANCELADA con PR: no se leen. */
  omitidas: number
  rondasSinDatos: boolean
}

/**
 * Indicador 3: rondas de corrección por orden y dictámenes CONFORME y CAMBIOS de su PR (GitHub). Las órdenes CERRADA y
 * CANCELADA conservan su fila (rondas) pero sus dictámenes no se leen (ORD-POS-080).
 */
export function dictamenesPorOrden(
  base: Indicador<{ ordenes: Orden[]; sinFecha: number }>, eventos: EventosOrden[] | null,
  prs: Partial<Record<string, Map<string, PrFusion> | null>> | null, dictamenes: Map<string, DictamenesPr> | null,
): Indicador<Dictamenes> {
  if (base.estado !== 'ok') return base
  if (!prs || !dictamenes) return sinDatos('Sin datos de GitHub: los dictámenes viven en los PRs.')
  const rondas = eventos ? new Map(eventos.map((e) => [e.id, e.rondas])) : null
  const filas = base.datos.ordenes.flatMap((o): FilaDictamenes[] => {
    const pr = prs[proyectoDeOrden(o) ?? '']?.get(o.id)
    if (!pr) return []
    const omitida = !leeDictamen(o)
    const d = omitida ? null : dictamenes.get(o.id) ?? null
    const n = (v: Veredicto) => (d === null ? null : d.filter((x) => x.veredicto === v).length)
    return [{ ordenId: o.id, prUrl: pr.url, rondas: rondas ? rondas.get(o.id) ?? 0 : null, conforme: n('CONFORME'), cambios: n('CAMBIOS'), omitida }]
  }).sort((a, b) => b.ordenId.localeCompare(a.ordenId))
  if (filas.length === 0) return sinDatos('Ninguna orden del filtro tiene un PR detectado en GitHub.')
  return {
    estado: 'ok',
    datos: {
      filas,
      totalConforme: filas.reduce((s, x) => s + (x.conforme ?? 0), 0),
      totalCambios: filas.reduce((s, x) => s + (x.cambios ?? 0), 0),
      sinLeer: filas.filter((x) => !x.omitida && x.conforme === null).length,
      omitidas: filas.filter((x) => x.omitida).length,
      rondasSinDatos: rondas === null,
    },
  }
}

export interface MapaLanzamientos {
  /** 7 filas (lunes … domingo) × 24 horas, hora de Mérida. */
  celdas: number[][]
  total: number
  max: number
}

/**
 * Indicador 4: lanzamientos de rutinas de revisión y de corrección (`orden.revisar_lanzar` y `orden.corregir_lanzar`
 * con SESION, integridad completa) por día de la semana y hora de Mérida. La ejecución inicial no deja fila en
 * AUDITORIA (su constancia es el comentario del issue), así que no se cuenta.
 */
export function mapaLanzamientos(audit: TableView | null, ordenes: Orden[], f: FiltroAgentes): Indicador<MapaLanzamientos> {
  if (!audit) return sinDatos('Falta AUDITORIA: ahí quedan los lanzamientos de rutinas.')
  const proyecto = new Map(ordenes.map((o) => [o.id, proyectoDeOrden(o)]))
  const celdas = Array.from({ length: 7 }, () => Array<number>(24).fill(0))
  let total = 0
  for (const op of parseAudit(audit)) {
    if (op.integridad !== 'completa' || op.entidad !== 'ORDENES_CODEX') continue
    if (!/^orden\.(revisar|corregir)_lanzar$/.test(op.operacion) || !op.fields.get('SESION')?.despues) continue
    if (f.proyecto && (proyecto.get(op.id) ?? proyectoDeOrden({ id: op.id, proyectoId: null })) !== f.proyecto) continue
    const row = audit.rows[op.order]
    const t = row ? parseTimestamp(cell(audit, row.cells, 'FECHA_HORA')).value : null
    if (!t || !t.hasTime) continue
    const h = civilHourInZone(t.epochMs)
    if (!enRango(h.date, f)) continue
    celdas[h.weekday]![h.hour]!++
    total++
  }
  return { estado: 'ok', datos: { celdas, total, max: Math.max(0, ...celdas.flat()) } }
}

export interface GastoClaude {
  meses: Array<{ mes: string; centavos: number }>
  totalCentavos: number
}

export type FuenteClaude = Bloque<GastoClaudeMes[]> | { estado: 'sin-fuente'; mensaje: string }

/**
 * Indicador 5: gasto mensual en Claude (FINANZAS, Herramientas de Claude; gastoClaudeMensual). FINANZAS solo registra
 * ECO y POS: con otro proyecto es «sin datos». El rango filtra por mes (los meses que toca).
 */
export function gastoClaude(fuente: FuenteClaude, f: FiltroAgentes): Indicador<GastoClaude> {
  if (fuente.estado !== 'ok') return sinDatos(fuente.mensaje)
  if (f.proyecto && f.proyecto !== 'ECO' && f.proyecto !== 'POS') return sinDatos('FINANZAS solo registra ECO y POS.')
  const desde = f.desde?.slice(0, 7) ?? null
  const hasta = f.hasta?.slice(0, 7) ?? null
  const meses = fuente.datos
    .filter((m) => (desde === null || m.mes >= desde) && (hasta === null || m.mes <= hasta))
    .map((m) => ({ mes: m.mes, centavos: f.proyecto ? m.gasto[f.proyecto as 'ECO' | 'POS'] : m.gasto.ECO + m.gasto.POS }))
    // Un mes con gasto solo del otro proyecto no es un cero de este: no se muestra.
    .filter((m) => f.proyecto === null || m.centavos !== 0)
  if (meses.length === 0) return sinDatos('Sin gasto en Claude registrado en FINANZAS para el filtro.')
  return { estado: 'ok', datos: { meses, totalCentavos: meses.reduce((s, m) => s + m.centavos, 0) } }
}
