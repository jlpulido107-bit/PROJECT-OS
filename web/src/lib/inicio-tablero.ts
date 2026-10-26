import { proyectoDeOrden, type Indicador, type ProyectoAgentes } from './agentes'
import { addDays, civilDateInZone, civilHourInZone, parseTimestamp } from './dates'
import { formatoMoneda, sumarMeses, type FinanzasVista, type Rendimiento } from './finanzas/finanzas'
import type { HitoInicio, ProyectoInicio } from './inicio'
import type { EventosOrden } from './metricas'
import type { PrFusion } from './operations/github'
import { parseAudit } from './operations/service'
import { cell, type TableView } from './operations/table-store'
import { ESTADOS_ORDEN } from './ordenes'
import type { Dataset, Orden } from './types'

/**
 * Tablero de operación de Inicio v2 (ORD-POS-096, docs/diseno-inicio-v2.md §7 I-1): tarjetas T1 a T6 y gráficas G1 y
 * G2; T6 desde ORD-POS-101 (§7 I-2). Funciones puras sobre lo que la página ya leyó (la hoja, AUDITORIA, las listas de PRs de GitHub y FINANZAS): no
 * leen ni escriben y no llaman a GitHub. Tres estados (§2.1): `ok`, `sin-datos` (se leyó pero no alcanza) y `apagada`
 * (la fuente no existe en este despliegue o para esta sesión). Solo `ok` lleva números: nunca un 0 por falta de datos.
 */

export type Estado<T> = Indicador<T> | { estado: 'apagada'; motivo: string }

const sinDatos = (motivo: string) => ({ estado: 'sin-datos', motivo }) as const
const apagada = (motivo: string) => ({ estado: 'apagada', motivo }) as const

/** Diferencia contra el periodo anterior (§2.2); `etiqueta` dice contra qué se compara. */
export interface Tendencia {
  anterior: number
  diferencia: number
  etiqueta: string
}

export interface ValorTarjeta {
  valor: number
  /** Detalle corto bajo el valor (p. ej. «3 vencidos · 2 próximos»). */
  detalle: string | null
  /** Avisos de la fuente (lista parcial, proyectos sin datos, límites conocidos). */
  notas: string[]
  tendencia: Estado<Tendencia>
}

export type Formato = 'numero' | 'pct' | 'mxn' | 'veces'

export interface TarjetaTablero {
  id: 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6'
  titulo: string
  formato: Formato
  fuente: string
  href: string
  estado: Estado<ValorTarjeta>
}

/** Fuente AUDITORIA tal como la entrega lib/auditoria.ts (vista leída o el motivo de que no la haya). */
export type FuenteAuditoria = Estado<TableView>

export interface FuenteGithub {
  /** PRs de órdenes por proyecto con repositorio; null en el proyecto cuyo GitHub falló. */
  prs: Record<string, Map<string, PrFusion> | null>
  truncados: string[]
}

export type FuenteFinanzas =
  | { estado: 'no-configurado' }
  | { estado: 'error'; motivo: string }
  | { estado: 'ok'; vista: FinanzasVista }

const MOTIVO_SIN_TOKEN = 'Sin token de GitHub en este servidor: lo enciende el propietario.'
const MOTIVO_SIN_FINANZAS = 'FINANZAS no está configurado en este despliegue (FINANZAS_SHEET_ID ausente o no válido): lo enciende el propietario.'

/** Días de la gráfica G1. */
export const DIAS_G1 = 28

/** «Esta semana»: últimos 7 días civiles con hoy (§2.2); «anterior»: los 7 previos. */
export function ventanas(hoy: string): { actual: [string, string]; anterior: [string, string] } {
  return { actual: [addDays(hoy, -6), hoy], anterior: [addDays(hoy, -13), addDays(hoy, -7)] }
}

const dentro = (fecha: string, [desde, hasta]: [string, string]) => fecha >= desde && fecha <= hasta
const tendencia = (valor: number, anterior: number, etiqueta: string): Estado<Tendencia> =>
  ({ estado: 'ok', datos: { anterior, diferencia: valor - anterior, etiqueta } })

const ABIERTOS: readonly string[] = ESTADOS_ORDEN.filter((e) => e !== 'CERRADA' && e !== 'CANCELADA')

/**
 * Órdenes abiertas en el instante `t` (§3.1). Sin alta en AUDITORIA se creó antes de ella; CERRADA o CANCELADA sin el
 * evento auditado se cerró antes de ella. Un alta en `t` o después no estaba abierta.
 */
export function abiertasEn(eventos: EventosOrden[], ordenes: Orden[], t: number): number {
  const ev = new Map(eventos.map((e) => [e.id, e]))
  return ordenes.filter((o) => {
    const e = ev.get(o.id)
    if (e?.creadaMs != null && e.creadaMs >= t) return false
    if (ABIERTOS.includes(o.estado ?? '')) return true
    const fin = o.estado === 'CERRADA' ? e?.cierre?.epochMs ?? null : o.estado === 'CANCELADA' ? e?.canceladaMs ?? null : null
    return fin !== null && fin >= t
  }).length
}

const DIA_MS = 86_400_000
const delFiltro = (ordenes: Orden[], filtro: ProyectoAgentes | null) =>
  ordenes.filter((o) => filtro === null || proyectoDeOrden(o) === filtro)

/** Eventos de AUDITORIA de la página (eventosOrdenes), o el estado de la fuente. */
export type FuenteEventos = Estado<EventosOrden[]>

/** T1: órdenes abiertas; tendencia, el valor reconstruido a ahora − 7 días con AUDITORIA. */
export function tarjetaAbiertas(ds: Dataset, eventos: FuenteEventos, filtro: ProyectoAgentes | null, now: number): Estado<ValorTarjeta> {
  if (!ds.tabs.ORDENES_CODEX.ok) return sinDatos('La pestaña ORDENES_CODEX no está disponible.')
  const ordenes = delFiltro(ds.ordenes, filtro)
  const valor = ordenes.filter((o) => ABIERTOS.includes(o.estado ?? '')).length
  const t: Estado<Tendencia> = eventos.estado !== 'ok' ? eventos
    : tendencia(valor, abiertasEn(eventos.datos, ordenes, now - 7 * DIA_MS), 'vs hace 7 días')
  return { estado: 'ok', datos: { valor, detalle: null, notas: [], tendencia: t } }
}

/** T2: PRs de órdenes fusionados esta semana (GitHub, las listas que Inicio ya lee). */
export function tarjetaFusionadas(gh: FuenteGithub | null, filtro: ProyectoAgentes | null, hoy: string): Estado<ValorTarjeta> {
  if (gh === null) return apagada(MOTIVO_SIN_TOKEN)
  const proyectos = filtro ? [filtro] : Object.keys(gh.prs)
  if (filtro && !(filtro in gh.prs)) return sinDatos(`${filtro} no tiene repositorio en GitHub.`)
  const leidos = proyectos.filter((p) => gh.prs[p])
  if (leidos.length === 0) return sinDatos('GitHub no respondió: no se sabe qué PRs se fusionaron.')
  const v = ventanas(hoy)
  const cuenta = (ventana: [string, string]) => leidos.reduce((s, p) => s + [...gh.prs[p]!.values()]
    .filter((pr) => pr.fusionMs !== null && dentro(civilDateInZone(pr.fusionMs), ventana)).length, 0)
  const valor = cuenta(v.actual)
  const notas = [
    ...proyectos.filter((p) => !gh.prs[p]).map((p) => `Sin datos de ${p}: GitHub no respondió.`),
    ...gh.truncados.filter((p) => leidos.includes(p)).map((p) => `Lista de ${p} parcial (límite de paginación).`),
  ]
  return { estado: 'ok', datos: { valor, detalle: null, notas, tendencia: tendencia(valor, cuenta(v.anterior), 'vs semana anterior') } }
}

/** T3: % de las órdenes cerradas con fusión confirmada en la semana sin ninguna ronda de corrección (§3.2). */
export function tarjetaConforme(ds: Dataset, eventos: FuenteEventos, filtro: ProyectoAgentes | null, hoy: string): Estado<ValorTarjeta> {
  if (eventos.estado !== 'ok') return eventos
  const ids = new Set(delFiltro(ds.ordenes, filtro).map((o) => o.id))
  const cerradas = eventos.datos.filter((e) => ids.has(e.id) && e.cierre?.fusion === 'confirmada')
  const pct = (ventana: [string, string]) => {
    const es = cerradas.filter((e) => dentro(civilDateInZone(e.cierre!.epochMs), ventana))
    return es.length === 0 ? null : { n: es.length, valor: Math.round((100 * es.filter((e) => e.rondas === 0).length) / es.length) }
  }
  const v = ventanas(hoy)
  const actual = pct(v.actual)
  if (!actual) return sinDatos('Ninguna orden del filtro se cerró con fusión confirmada esta semana.')
  const anterior = pct(v.anterior)
  return {
    estado: 'ok',
    datos: {
      valor: actual.valor, detalle: `de ${actual.n} ${actual.n === 1 ? 'cerrada' : 'cerradas'}`,
      notas: ['Una corrección hecha fuera del dashboard no deja ronda en AUDITORIA y cuenta como «a la primera».'],
      tendencia: anterior ? tendencia(actual.valor, anterior.valor, 'vs semana anterior')
        : sinDatos('Ninguna orden se cerró con fusión confirmada la semana anterior.'),
    },
  }
}

/** T4: hitos abiertos vencidos o que vencen en 7 días; sin tendencia en la v1 (§3.3). */
export function tarjetaHitos(proyectos: Indicador<ProyectoInicio[]>): Estado<ValorTarjeta> {
  if (proyectos.estado !== 'ok') return proyectos
  const hitos: HitoInicio[] = proyectos.datos.flatMap((p) => p.hitos)
  const vencidos = hitos.filter((h) => h.marca === 'vencido').length
  const proximos = hitos.filter((h) => h.marca === 'proximo').length
  return {
    estado: 'ok',
    datos: {
      valor: vencidos + proximos, detalle: `${vencidos} ${vencidos === 1 ? 'vencido' : 'vencidos'} · ${proximos} ${proximos === 1 ? 'próximo' : 'próximos'}`,
      notas: [],
      tendencia: sinDatos('HITOS no guarda cuándo se completó cada hito: no se puede reconstruir el valor de hace 7 días.'),
    },
  }
}

/** T5: gasto de Claude del mes en curso; tendencia, el acumulado del mes de hoy − 7 hasta esa fecha (§3.4). */
export function tarjetaGastoClaude(fin: FuenteFinanzas, filtro: ProyectoAgentes | null, hoy: string): Estado<ValorTarjeta> {
  if (fin.estado === 'no-configurado') return apagada(MOTIVO_SIN_FINANZAS)
  if (fin.estado === 'error') return sinDatos(fin.motivo)
  if (filtro !== null && filtro !== 'ECO' && filtro !== 'POS') return sinDatos('FINANZAS solo registra ECO y POS.')
  const diario = fin.vista.claudeDiario
  if (diario.estado === 'no-disponible') return sinDatos(diario.mensaje)
  const dias = (diario.estado === 'ok' ? diario.datos : [])
    .map((d) => ({ fecha: d.fecha, centavos: filtro ? d.gasto[filtro] : d.gasto.ECO + d.gasto.POS }))
    // Un día con gasto solo del otro proyecto no es un registro de este.
    .filter((d) => filtro === null || d.centavos !== 0)
  const mes = hoy.slice(0, 7)
  const delMes = dias.filter((d) => d.fecha.slice(0, 7) === mes)
  if (delMes.length === 0) return sinDatos(`Sin gasto de Claude registrado en ${mes}.`)
  const valor = delMes.reduce((s, d) => s + d.centavos, 0)
  const t = addDays(hoy, -7)
  const mesT = t.slice(0, 7)
  const anterior = dias.filter((d) => d.fecha.slice(0, 7) === mesT && d.fecha <= t).reduce((s, d) => s + d.centavos, 0)
  return {
    estado: 'ok',
    datos: {
      valor, detalle: mes, notas: [],
      tendencia: tendencia(valor, anterior, `vs ${mesT} al ${t}`),
    },
  }
}

/** T6 (ORD-POS-101): apagada sin el agente de finanzas activo o sin la pestaña, que no crea ninguna orden. */
export const MOTIVO_T6_AGENTE = 'El agente de finanzas no está activo en este despliegue (FINANZAS_AGENTE_MODE): lo enciende el propietario.'
export const MOTIVO_T6_PESTANA = 'La pestaña RENDIMIENTO_CLAUDE no existe en FINANZAS: la crea el propietario en la activación del agente de finanzas.'

const usd = (centavos: number) => formatoMoneda(centavos, 'USD')
const completo = (r: Rendimiento, mes: string) => ['Q1', 'Q2'].every((q) => r.cortes.some((c) => c.mes === mes && c.quincena === q))
const redondeo = (n: number) => Math.round(n * 100) / 100

/** Cociente de v3 §4.2 de un mes con sus dos cortes: consumo equivalente ÷ lo pagado, o por qué no se puede. */
function cocienteMes(r: Rendimiento, mes: string): { valor: number; equiv: number; pagado: number } | { motivo: string } {
  if (!completo(r, mes)) return { motivo: `${mes} no tiene sus dos cortes (Q1 y Q2) registrados` }
  const pago = r.pagado[mes]!
  if (pago.usdCentavos === null) return { motivo: `en ${mes} ${pago.motivo}` }
  const equiv = r.cortes.filter((c) => c.mes === mes).reduce((s, c) => s + c.equivCentavos, 0)
  return { valor: redondeo(equiv / pago.usdCentavos), equiv, pagado: pago.usdCentavos }
}

/**
 * T6: rendimiento en tokens del último mes completo (§3.5): suma de COSTO_EQUIV_USD de sus dos cortes ÷ (suscripción +
 * cargos extra del mes, en USD); tendencia contra el mes anterior, también completo. Un mes con un solo corte nunca se
 * divide entre el costo del mes; el último corte cerrado va al lado, sin dividir. El consumo equivalente no es gasto.
 */
export function tarjetaRendimiento(fin: FuenteFinanzas, agenteActivo: boolean, filtro: ProyectoAgentes | null): Estado<ValorTarjeta> {
  if (fin.estado === 'no-configurado') return apagada(MOTIVO_SIN_FINANZAS)
  if (!agenteActivo) return apagada(MOTIVO_T6_AGENTE)
  if (fin.estado === 'error') return sinDatos(fin.motivo)
  const b = fin.vista.rendimiento
  if (b.estado === 'sin-pestana') return apagada(MOTIVO_T6_PESTANA)
  if (b.estado !== 'ok') return sinDatos(b.mensaje)
  const r = b.datos
  const ultimo = r.cortes.at(-1)
  const contexto = ultimo ? `Último corte cerrado ${ultimo.corte}: ${usd(ultimo.equivCentavos)} equivalentes, sin dividir.` : null
  const meses = [...new Set(r.cortes.map((c) => c.mes))].filter((m) => completo(r, m)).sort()
  const notasFila = r.problemas.length ? [`${r.problemas.length} ${r.problemas.length === 1 ? 'fila' : 'filas'} de RENDIMIENTO_CLAUDE con problema no cuentan.`] : []
  const mes = meses.at(-1)
  if (!mes) return sinDatos(['Ningún mes tiene sus dos cortes (Q1 y Q2) registrados.', contexto, ...notasFila].filter(Boolean).join(' '))
  const actual = cocienteMes(r, mes)
  if ('motivo' in actual) return sinDatos([`El último mes completo no se puede dividir: ${actual.motivo}.`, contexto, ...notasFila].filter(Boolean).join(' '))
  const anteriorMes = sumarMeses(mes, -1)
  const anterior = cocienteMes(r, anteriorMes)
  return {
    estado: 'ok',
    datos: {
      valor: actual.valor,
      detalle: `${mes}: ${usd(actual.equiv)} equivalentes ÷ ${usd(actual.pagado)} pagados`,
      notas: [
        ...(contexto ? [contexto] : []),
        'El consumo equivalente no es gasto: no suma a T5.',
        ...(filtro ? ['Toda la cuenta de Claude: no se reparte por proyecto.'] : []),
        ...notasFila,
      ],
      tendencia: 'motivo' in anterior ? sinDatos(`${anterior.motivo[0]!.toUpperCase()}${anterior.motivo.slice(1)}.`)
        : { estado: 'ok', datos: { anterior: anterior.valor, diferencia: redondeo(actual.valor - anterior.valor), etiqueta: `vs ${anteriorMes}` } },
    },
  }
}

export const MOTIVO_G2 = 'La pestaña RENDIMIENTO_CLAUDE_ROL no existe: requiere que el propietario registre la ampliación de DEC-POS-018 (orden I-3).'

export interface FuentesTablero {
  ds: Dataset
  hoy: string
  now: number
  filtro: ProyectoAgentes | null
  proyectos: Indicador<ProyectoInicio[]>
  eventos: FuenteEventos
  gh: FuenteGithub | null
  finanzas: FuenteFinanzas
  /** Agente de finanzas activo (`finanzasAgenteMode() === 'sheets'`, ORD-POS-092): sin él, T6 apagada. */
  agenteFinanzas: boolean
}

export function tarjetasTablero(f: FuentesTablero): TarjetaTablero[] {
  return [
    { id: 'T1', titulo: 'Órdenes abiertas', formato: 'numero', fuente: 'ORDENES_CODEX; tendencia con AUDITORIA', href: '/ordenes', estado: tarjetaAbiertas(f.ds, f.eventos, f.filtro, f.now) },
    { id: 'T2', titulo: 'Fusionadas en la semana', formato: 'numero', fuente: 'PRs de órdenes en GitHub', href: '/agentes', estado: tarjetaFusionadas(f.gh, f.filtro, f.hoy) },
    { id: 'T3', titulo: 'CONFORME a la primera', formato: 'pct', fuente: 'AUDITORIA: cierres con fusión confirmada y rondas', href: '/metricas', estado: tarjetaConforme(f.ds, f.eventos, f.filtro, f.hoy) },
    { id: 'T4', titulo: 'Hitos en riesgo', formato: 'numero', fuente: 'HITOS y TAREAS', href: '/estado', estado: tarjetaHitos(f.proyectos) },
    { id: 'T5', titulo: 'Gasto de Claude del mes', formato: 'mxn', fuente: 'FINANZAS: MOVIMIENTOS de Claude', href: '/finanzas#herramientas', estado: tarjetaGastoClaude(f.finanzas, f.filtro, f.hoy) },
    { id: 'T6', titulo: 'Rendimiento en tokens', formato: 'veces', fuente: 'FINANZAS: RENDIMIENTO_CLAUDE', href: '/finanzas', estado: tarjetaRendimiento(f.finanzas, f.agenteFinanzas, f.filtro) },
  ]
}

export const ENTIDADES_G1 = ['ORDENES_CODEX', 'TAREAS', 'DECISIONES', 'TIEMPOS'] as const
export type EntidadG1 = (typeof ENTIDADES_G1)[number]

export interface DiaActividad {
  fecha: string
  porEntidad: Record<EntidadG1, number>
  total: number
}

export interface Actividad {
  dias: DiaActividad[]
  total: number
  max: number
}

/** Proyecto de una fila auditada: el de la hoja si se conoce o, sin él, el prefijo del ID (ORD-POS-…, DEC-POS-…, POS-…). */
function proyectoDeEntidad(ds: Dataset): (entidad: string, id: string) => string | null {
  const ordenes = new Map(ds.ordenes.map((o) => [o.id, proyectoDeOrden(o)]))
  const tareas = new Map(ds.tareas.map((t) => [t.id, t.proyectoId]))
  const decisiones = new Map(ds.decisiones.map((d) => [d.id, d.proyectoId]))
  const prefijo = (id: string) => /^(?:ORD-|DEC-)?([A-Z]{3})-/.exec(id)?.[1] ?? null
  return (entidad, id) => {
    const mapa = entidad === 'ORDENES_CODEX' ? ordenes : entidad === 'TAREAS' ? tareas : entidad === 'DECISIONES' ? decisiones : null
    return mapa?.get(id) ?? prefijo(id)
  }
}

/**
 * G1: operaciones del dashboard con integridad completa en AUDITORIA por día civil de Mérida, los últimos 28 días con
 * hoy, apiladas por entidad. Solo conteos: los correos de AUDITORIA no salen de aquí. Dentro de una AUDITORIA leída, un
 * día sin operaciones es un 0 real.
 */
export function actividadPorDia(audit: FuenteAuditoria, ds: Dataset, filtro: ProyectoAgentes | null, hoy: string): Estado<Actividad> {
  if (audit.estado !== 'ok') return audit
  const vista = audit.datos
  const fechas = Array.from({ length: DIAS_G1 }, (_, i) => addDays(hoy, i - (DIAS_G1 - 1)))
  const porFecha = new Map(fechas.map((fecha): [string, DiaActividad] => [fecha, {
    fecha, porEntidad: Object.fromEntries(ENTIDADES_G1.map((e) => [e, 0])) as Record<EntidadG1, number>, total: 0,
  }]))
  const proyecto = proyectoDeEntidad(ds)
  let total = 0
  for (const op of parseAudit(vista)) {
    if (op.integridad !== 'completa' || !(ENTIDADES_G1 as readonly string[]).includes(op.entidad)) continue
    if (filtro && proyecto(op.entidad, op.id) !== filtro) continue
    const row = vista.rows[op.order]
    const t = row ? parseTimestamp(cell(vista, row.cells, 'FECHA_HORA')).value : null
    if (!t) continue
    const dia = porFecha.get(t.hasTime ? civilHourInZone(t.epochMs).date : t.date)
    if (!dia) continue
    dia.porEntidad[op.entidad as EntidadG1]++
    dia.total++
    total++
  }
  if (total === 0) return sinDatos(`Sin operaciones del dashboard en AUDITORIA en los últimos ${DIAS_G1} días${filtro ? ` para ${filtro}` : ''}.`)
  const dias = [...porFecha.values()]
  return { estado: 'ok', datos: { dias, total, max: Math.max(...dias.map((d) => d.total)) } }
}

export interface DatosTablero {
  tarjetas: TarjetaTablero[]
  actividad: Estado<Actividad>
  /** G2 en la v1: siempre apagada (§7 I-1). */
  costoPorRol: Estado<never>
}

export function tablero(f: FuentesTablero & { audit: FuenteAuditoria }): DatosTablero {
  return { tarjetas: tarjetasTablero(f), actividad: actividadPorDia(f.audit, f.ds, f.filtro, f.hoy), costoPorRol: apagada(MOTIVO_G2) }
}
