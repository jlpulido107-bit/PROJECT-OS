import { formatInstant, parseTimestamp } from '../dates'
import { normalizeCode } from '../parse'
import {
  AVISO_DESCONOCIDO, AVISOS_DE_SALUD, AVISOS_YA_CONTADOS, CRITERIOS, ETAPA_DESCARTADO, ETAPA_DESCONOCIDA, MODO_DESCONOCIDO,
  TEXTO_AVISO, TEXTO_AVISO_PRECIO, TEXTO_ESPACIO, TEXTO_ESTADO_PROBLEMA, TEXTO_ETAPA, TEXTO_FALLA, TEXTO_FALLA_GENERICO,
  TEXTO_FALTA, TEXTO_FALTA_ASIN, TEXTO_FALTA_GENERICO, TEXTO_MODO,
} from './eco-semana-textos'
import { leerTabla, mapear, type Bloque, type Fila } from './tabla'

/**
 * «ECO esta semana» (/eco/semana, ORD-POS-159, POS-061): qué pasó esta semana en RADAROS y qué sigue, con palabras.
 * Funciones puras sobre filas ya leídas: no leen, no escriben y no reimplementan el dictamen (toman `COSTO_MAX_MXN` y
 * `PRECIO_MXN` de AMZ_DICTAMEN tal cual). Columnas por encabezado (fila 1), nunca por posición.
 */

/**
 * Pestañas propias de esta vista, que el lector de /eco pide en su mismo batchGet (solo las que existen). De PIPE_* solo
 * usa PIPE_PRODUCTOS; no toma nada de PIPE_PROVEEDORES ni de PIPE_AUDITORIA.
 */
export const SEMANA_TABS = ['AMZ_DICTAMEN', 'AMZ_CANDIDATOS', 'AMZ_AVISOS', 'AMZ_BITACORA', 'CFG_MARCAS'] as const
export type SemanaTab = (typeof SEMANA_TABS)[number]
export type SemanaRaw = Partial<Record<SemanaTab, unknown[][]>>

/**
 * ❓ Meta de ECO: la maqueta aprobada dice «primer producto en Amazon el 31 de enero». No está en ninguna pestaña que
 * esta orden lea, así que vive aquí; si cambia, se cambia en este lugar (o se mueve a la hoja con otra orden).
 */
export const META_ECO = { texto: 'primer producto en Amazon', fecha: '2027-01-31', fechaTexto: '31 de enero' } as const

/** Ganancia por pieza al costo máximo: el 25 % del precio (DEC-ECO-008 y DEC-ECO-012). */
export const GANANCIA_PCT = 0.25
/** Criterio 5: sin corrida en este tiempo, la salud va en rojo. */
export const HORAS_SIN_CORRER = 3
export const TOP_BUSCADOR = 10
const MARCAS_EJEMPLO = 3
const SEMANA_ISO = /^\d{4}-W\d{2}$/

const COLUMNAS_DICTAMEN = [
  'ID', 'NOMBRE', 'ASIN', 'PRECIO_MXN', ...CRITERIOS.map((k) => `${k}_ESTADO`), 'K3_DETALLE', 'COSTO_MAX_MXN', 'MOQ_MAX', 'VEREDICTO',
  'SEMANA', 'ORIGEN',
] as const
const COLUMNAS_CANDIDATOS = ['ASIN', 'TITULO', 'MARCA', 'PRECIO_MXN', 'PUNTAJE', 'COSTO_MAX_MXN', 'VEREDICTO', 'SEMANA', 'DECISION_HUMANA'] as const
const COLUMNAS_AVISOS = ['SEMANA', 'TIPO', 'SEVERIDAD', 'ID'] as const
const COLUMNAS_BITACORA = ['FECHA_HORA', 'MODO', 'ESTADO', 'TOKENS_RESTANTES'] as const
const COLUMNAS_PIPE = ['PRODUCTO_ID', 'NOMBRE', 'IDEA_ID', 'ETAPA', 'FASE', 'SIGUIENTE_PASO'] as const

/** Número de una celda con formato («$1,473.50», «832 MXN»); vacío o no numérico, null (nunca 0 inventado). */
export function numeroCelda(raw: string | null | undefined): number | null {
  if (raw == null) return null
  let t = raw.replace(/MXN|[$\s]/gi, '')
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '')
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null
  return Number(t)
}

export interface Pasado {
  id: string
  nombre: string
  asin: string | null
  precio: number | null
  /** «Puedes pagar hasta»: COSTO_MAX_MXN del dictamen, tal cual. */
  costoMax: number | null
  /** 25 % del precio; null sin precio. */
  ganancia: number | null
  /** «¿Hay espacio?» en palabras. */
  espacio: string
  moqMax: number | null
  /** Texto del aviso de precio justo, o null. */
  aviso: string | null
}
export interface PorMedir { id: string; nombre: string; faltas: string[] }
export interface Descartado { id: string; nombre: string; motivos: string[] }
export interface Dictamen {
  /** Semana más reciente con filas (criterio 3); solo de ella salen las tres listas. */
  semana: string
  pasaron: Pasado[]
  porMedir: PorMedir[]
  descartados: Descartado[]
}
export interface EnProceso { id: string; nombre: string; ideaId: string | null; fase: string; siguiente: string }
export interface Pendiente { que: string; hacer: string; ids: string | null }
export interface Hallazgo { asin: string; titulo: string; precio: number | null; costoMax: number | null }
export type Marcas =
  | { estado: 'ok'; total: number; quitados: number; ejemplos: string[] }
  /** Criterio 4: sin lista de marcas (la pestaña no existe, está vacía o sin su columna), el top va sin filtrar. */
  | { estado: 'sin-lista' }
export interface Buscador { hallazgos: Hallazgo[]; marcas: Marcas }
export interface Salud { tono: 'ok' | 'warn' | 'danger'; frases: string[] }

export interface SemanaVista {
  frase: string
  meta: { texto: string; fechaTexto: string; semanasFaltan: number }
  dictamen: Bloque<Dictamen>
  proceso: Bloque<EnProceso[]>
  pendientes: Pendiente[]
  buscador: Bloque<Buscador>
  salud: Salud
}

const SIN_NOMBRE = 'Producto sin nombre'
const codigo = (v: string | null | undefined) => normalizeCode(v ?? null)

/** «3 del top 10 con < 100 reseñas …» → «3 de los 10 más vendidos tienen pocas reseñas»; otro formato, solo el estado. */
function espacio(f: Fila): string {
  const base = TEXTO_ESPACIO[codigo(f.K3_ESTADO) ?? ''] ?? TEXTO_ESPACIO.SIN_DATO!
  const m = /^(\d+) del top (\d+)\b/.exec(f.K3_DETALLE ?? '')
  return m ? `${base} · ${m[1]} de los ${m[2]} más vendidos tienen pocas reseñas` : base
}

function dictamen(rows: unknown[][] | undefined): Bloque<Dictamen> {
  const tabla = leerTabla('AMZ_DICTAMEN', rows, COLUMNAS_DICTAMEN, ['ID', 'VEREDICTO', 'SEMANA'],
    'Todavía no hay resultado de la semana en el libro de RADAROS.', 'El filtro semanal todavía no ha dejado resultados.')
  return mapear(tabla, ({ filas }) => {
    // `AAAA-Www` ordena como texto.
    const semana = filas.map((f) => f.SEMANA).filter((s): s is string => s != null && SEMANA_ISO.test(s)).sort().at(-1) ?? ''
    const deLaSemana = filas.filter((f) => f.ID && f.SEMANA === semana)
    const propias = deLaSemana.filter((f) => codigo(f.ORIGEN) !== 'DESCUBRIR')
    const en = (f: Fila, k: string, estado: string) => codigo(f[`${k}_ESTADO`]) === estado
    const base = (f: Fila) => ({ id: f.ID as string, nombre: f.NOMBRE ?? SIN_NOMBRE })
    return {
      semana,
      pasaron: propias.filter((f) => codigo(f.VEREDICTO) === 'LISTO_PARA_RFQ').map((f) => {
        const precio = numeroCelda(f.PRECIO_MXN)
        return {
          ...base(f), asin: f.ASIN ?? null, precio, costoMax: numeroCelda(f.COSTO_MAX_MXN),
          ganancia: precio === null ? null : Math.round(precio * GANANCIA_PCT * 100) / 100,
          espacio: espacio(f), moqMax: numeroCelda(f.MOQ_MAX), aviso: en(f, 'K1', 'AVISO') ? TEXTO_AVISO_PRECIO : null,
        }
      }),
      porMedir: propias.filter((f) => codigo(f.VEREDICTO) === 'INVESTIGAR').map((f) => {
        // K1 solo avisa y K5 sin dato repite «falta el costo» cuando K2 ya lo dice.
        const faltas = CRITERIOS.filter((k) => k !== 'K1' && en(f, k, 'SIN_DATO') && !(k === 'K5' && en(f, 'K2', 'SIN_DATO'))).map((k) => TEXTO_FALTA[k])
        if (!f.ASIN) faltas.unshift(TEXTO_FALTA_ASIN)
        return { ...base(f), faltas: faltas.length ? faltas : [TEXTO_FALTA_GENERICO] }
      }),
      descartados: deLaSemana.filter((f) => codigo(f.VEREDICTO) === 'KILL').map((f) => {
        const motivos = CRITERIOS.filter((k) => en(f, k, 'FALLA')).map((k) => TEXTO_FALLA[k])
        return { ...base(f), motivos: motivos.length ? motivos : [TEXTO_FALLA_GENERICO] }
      }),
    }
  })
}

/** Texto de una celda de fórmula: un error de Sheets (`#N/A`, `#REF!`…) cuenta como vacío. */
const textoFormula = (v: string | null | undefined) => (v && !v.startsWith('#') ? v : null)

function proceso(rows: unknown[][] | undefined): Bloque<EnProceso[]> {
  const tabla = leerTabla('PIPE_PRODUCTOS', rows, COLUMNAS_PIPE, ['PRODUCTO_ID', 'NOMBRE'],
    'Todavía no hay productos en proceso en el libro de RADAROS.', 'Ningún producto en proceso todavía.')
  return mapear(tabla, ({ filas }) => filas.filter((f) => f.PRODUCTO_ID && codigo(f.ETAPA) !== ETAPA_DESCARTADO).map((f) => {
    // FASE y SIGUIENTE_PASO existen tras la ORD-ECO-053; sin ellas (o vacías), el texto de la ETAPA.
    const deEtapa = TEXTO_ETAPA[codigo(f.ETAPA) ?? ''] ?? ETAPA_DESCONOCIDA
    return {
      id: f.PRODUCTO_ID as string, nombre: f.NOMBRE ?? SIN_NOMBRE, ideaId: f.IDEA_ID ?? null,
      fase: textoFormula(f.FASE) ?? deEtapa.fase, siguiente: textoFormula(f.SIGUIENTE_PASO) ?? deEtapa.siguiente,
    }
  }))
}

/** Avisos de la semana del dictamen, por tipo y ya en palabras. Sin la pestaña (está apagada por defecto), ninguno. */
function avisos(rows: unknown[][] | undefined, semana: string | null) {
  const tabla = leerTabla('AMZ_AVISOS', rows, COLUMNAS_AVISOS, ['SEMANA', 'TIPO'], '', '')
  const filas = tabla.estado === 'ok' ? tabla.datos.filas.filter((f) => f.TIPO && (!semana || f.SEMANA === semana)) : []
  const aTexto = (f: Fila, conIds: boolean): Pendiente => ({ ...(TEXTO_AVISO[codigo(f.TIPO) ?? ''] ?? AVISO_DESCONOCIDO), ids: conIds ? (f.ID ?? null) : null })
  const deSalud = (f: Fila) => AVISOS_DE_SALUD.includes(codigo(f.TIPO) ?? '')
  return {
    // El ID de un aviso de salud es un modo (un código): no se muestra.
    salud: filas.filter(deSalud).map((f) => aTexto(f, false)),
    pendientes: filas.filter((f) => !deSalud(f) && !AVISOS_YA_CONTADOS.includes(codigo(f.TIPO) ?? '')).map((f) => aTexto(f, true)),
  }
}

function buscador(rows: unknown[][] | undefined, marcasRows: unknown[][] | undefined, semana: string | null): Bloque<Buscador> {
  const tabla = leerTabla('AMZ_CANDIDATOS', rows, COLUMNAS_CANDIDATOS, ['ASIN', 'VEREDICTO'],
    'El buscador todavía no ha dejado su lista en el libro de RADAROS.', 'El buscador no encontró candidatos todavía.')
  const lista = leerTabla('CFG_MARCAS', marcasRows, ['MARCA'], ['MARCA'], '', '')
  const clave = (m: string) => m.trim().toLowerCase()
  const marcas = lista.estado === 'ok' ? new Map(lista.datos.filas.filter((f) => f.MARCA).map((f) => [clave(f.MARCA as string), f.MARCA as string])) : null
  return mapear(tabla, ({ filas }) => {
    // Como el tablero del libro: sin descartados, sin los que ya salieron de la lista y sin decisión del propietario.
    const vivos = filas.filter((f) => f.ASIN && !['KILL', 'FUERA_DE_LISTA'].includes(codigo(f.VEREDICTO) ?? '') && !f.DECISION_HUMANA
      && (!semana || !f.SEMANA || f.SEMANA === semana))
    const deMarca = (f: Fila) => (marcas && f.MARCA ? marcas.get(clave(f.MARCA)) : undefined)
    const quitados = vivos.filter((f) => deMarca(f) !== undefined)
    const puntaje = (f: Fila) => numeroCelda(f.PUNTAJE)
    const hallazgos = vivos.filter((f) => deMarca(f) === undefined)
      .sort((a, b) => (puntaje(b) ?? -Infinity) - (puntaje(a) ?? -Infinity) || (a.ASIN as string).localeCompare(b.ASIN as string))
      .slice(0, TOP_BUSCADOR)
      .map((f) => ({ asin: f.ASIN as string, titulo: f.TITULO ?? SIN_NOMBRE, precio: numeroCelda(f.PRECIO_MXN), costoMax: numeroCelda(f.COSTO_MAX_MXN) }))
    return {
      hallazgos,
      marcas: marcas
        ? { estado: 'ok' as const, total: marcas.size, quitados: quitados.length, ejemplos: [...new Set(quitados.map((f) => deMarca(f) as string))].slice(0, MARCAS_EJEMPLO) }
        : { estado: 'sin-lista' as const },
    }
  })
}

const peor = (a: Salud['tono'], b: Salud['tono']): Salud['tono'] => (a === 'danger' || b === 'danger' ? 'danger' : a === 'warn' || b === 'warn' ? 'warn' : 'ok')

/** Criterio 5: rojo si la bitácora no prueba una corrida en las últimas HORAS_SIN_CORRER horas, y lo dice con palabras. */
export function salud(rows: unknown[][] | undefined, avisosDeSalud: Pendiente[], now: number): Salud {
  const tabla = leerTabla('AMZ_BITACORA', rows, COLUMNAS_BITACORA, ['FECHA_HORA'], '', '')
  const extra = avisosDeSalud.map((a) => `${a.que}. ${a.hacer}`)
  const rojo = (frase: string): Salud => ({ tono: 'danger', frases: [frase, ...extra] })
  if (tabla.estado === 'ausente') return rojo('El buscador no tiene registro en el libro de RADAROS: no se puede saber si está corriendo.')
  if (tabla.estado === 'columnas-faltantes') return rojo('Al registro del buscador le falta la fecha de cada corrida: no se puede saber si está corriendo.')
  if (tabla.estado === 'sin-filas') return rojo('El buscador todavía no ha corrido.')
  // atajo: el lector trae las primeras MAX_DATA_ROWS filas y la bitácora crece al final; si se trunca, la última corrida
  // queda fuera. Mejorarlo (leer solo el final) cuando la bitácora se acerque a ese tamaño.
  if (tabla.truncado) return rojo('El registro del buscador es demasiado largo para leerlo completo: no se puede confirmar su última corrida.')
  const corridas = tabla.datos.filas.map((f) => ({ f, t: parseTimestamp(f.FECHA_HORA).value?.epochMs ?? null })).filter((c): c is { f: Fila; t: number } => c.t !== null)
  // La más reciente; en empate, la última de la hoja.
  const ultima = corridas.reduce<{ f: Fila; t: number } | null>((m, c) => (m === null || c.t >= m.t ? c : m), null)
  if (!ultima) return rojo('El registro del buscador no tiene fechas que se entiendan: no se puede saber si está corriendo.')
  const cuando = `${formatInstant(ultima.t)} (hora Mérida)`
  const horas = Math.floor((now - ultima.t) / 3_600_000)
  const frases: string[] = []
  let tono: Salud['tono'] = 'ok'
  if (now - ultima.t > HORAS_SIN_CORRER * 3_600_000) {
    tono = 'danger'
    frases.push(`El buscador no ha corrido en las últimas ${HORAS_SIN_CORRER} horas: su última corrida fue el ${cuando}, hace ${horas} horas.`)
  } else frases.push(`El buscador está corriendo: su última corrida fue el ${cuando}.`)
  const problema = TEXTO_ESTADO_PROBLEMA[codigo(ultima.f.ESTADO) ?? '']
  if (problema) {
    tono = peor(tono, 'warn')
    frases.push(`En esa corrida, ${TEXTO_MODO[codigo(ultima.f.MODO) ?? ''] ?? MODO_DESCONOCIDO} ${problema}.`)
  }
  const creditos = numeroCelda(ultima.f.TOKENS_RESTANTES)
  if (creditos !== null) frases.push(`Te quedan ${creditos.toLocaleString('es-MX')} créditos de Keepa.`)
  if (extra.length) tono = peor(tono, 'warn')
  return { tono, frases: [...frases, ...extra] }
}

const plural = (n: number, uno: string, varios: string) => (n === 1 ? uno : varios)

/** Bloque 1: la frase de la semana, solo con lo que dice el dictamen de la semana más reciente. */
export function fraseSemana(d: Bloque<Dictamen>): string {
  if (d.estado !== 'ok' || !d.datos.semana) return 'Todavía no hay resultado de esta semana.'
  const { pasaron, porMedir } = d.datos
  const primera = pasaron.length === 0 ? 'Esta semana ningún producto pasó el filtro.'
    : `Esta semana ${pasaron.length} ${plural(pasaron.length, 'producto pasó', 'productos pasaron')} el filtro.`
  const segunda = porMedir.length ? ` ${porMedir.length} ${plural(porMedir.length, 'idea espera', 'ideas esperan')} un dato para poder medirse.` : ''
  return primera + segunda
}

export function semanasHastaMeta(now: number): number {
  const meta = parseTimestamp(META_ECO.fecha).value?.epochMs ?? now
  return Math.max(0, Math.ceil((meta - now) / (7 * 86_400_000)))
}

/** Cada bloque resuelve su propio estado: uno con problema no impide pintar los demás. */
export function construirSemana(raw: SemanaRaw, pipeProductos: unknown[][] | undefined, now: number): SemanaVista {
  const d = dictamen(raw.AMZ_DICTAMEN)
  const semana = d.estado === 'ok' && d.datos.semana ? d.datos.semana : null
  const a = avisos(raw.AMZ_AVISOS, semana)
  return {
    frase: fraseSemana(d),
    meta: { texto: META_ECO.texto, fechaTexto: META_ECO.fechaTexto, semanasFaltan: semanasHastaMeta(now) },
    dictamen: d,
    proceso: proceso(pipeProductos),
    pendientes: a.pendientes,
    buscador: buscador(raw.AMZ_CANDIDATOS, raw.CFG_MARCAS, semana),
    salud: salud(raw.AMZ_BITACORA, a.salud, now),
  }
}
