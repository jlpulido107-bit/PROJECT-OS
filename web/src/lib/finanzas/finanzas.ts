import { civilDateInZone, parseCivilDate } from '../dates'
import { cellText, parseNumber } from '../parse'
import { MAX_DATA_ROWS } from '../schema'

/**
 * Vista de solo lectura del libro FINANZAS (/finanzas, ORD-POS-074). Funciones puras sobre las filas que el lector ya
 * trajo con `UNFORMATTED_VALUE` (montos como número, fechas como texto): no leen, no escriben y no corrigen nada
 * (docs/diseno-finanzas.md §2 y §4). Las columnas se buscan por nombre de encabezado (fila 1), nunca por posición.
 * Los montos se suman en centavos enteros para no acumular error de punto flotante.
 */

/** Pestañas que lee /finanzas (§3). RESUMEN no se lee: es una vista derivada en la hoja (§2.5). */
export const FINANZAS_TABS = ['MOVIMIENTOS', 'PARAMETROS'] as const
export type FinanzasTab = (typeof FINANZAS_TABS)[number]
export type FinanzasRaw = Partial<Record<FinanzasTab, unknown[][]>>

/** Columnas obligatorias de MOVIMIENTOS (§2.1). Las opcionales son informativas y la vista no las usa. */
export const COLUMNAS_OBLIGATORIAS = [
  'MOV_ID', 'FECHA', 'PROYECTO', 'TIPO', 'CATEGORIA', 'CONCEPTO', 'MONTO_MXN', 'FUENTE', 'COMPROBANTE',
] as const
const COLUMNAS_LEIDAS = [...COLUMNAS_OBLIGATORIAS, 'PRODUCTO_ID'] as const

export const PROYECTOS = ['ECO', 'POS'] as const
export type Proyecto = (typeof PROYECTOS)[number]
export const TIPOS = ['Gasto', 'Ingreso', 'Inversión'] as const
export type Tipo = (typeof TIPOS)[number]
/** §2.3, lista cerrada. Una categoría fuera de la lista hace la fila «con problema» (§2.1). */
export const CATEGORIAS = ['Herramientas', 'Marketplace', 'Producto', 'Marketing', 'Legal y marca', 'Ventas'] as const
export type Categoria = (typeof CATEGORIAS)[number]
export const FUENTES = ['manual', 'sp-api', 'anthropic'] as const
export type Fuente = (typeof FUENTES)[number]

/**
 * §2.2 con la resolución (a) del PM: solo MAN- con `manual`, SPAPI- con `sp-api` y CLAUDE- con `anthropic`; cualquier
 * otro prefijo, o uno que no cuadra con su FUENTE, es fila con problema.
 */
const PREFIJOS: Record<Fuente, RegExp> = {
  manual: /^MAN-\d{4}$/,
  'sp-api': /^SPAPI-[A-Za-z0-9_.:-]+$/,
  anthropic: /^CLAUDE-\d{4}-(0[1-9]|1[0-2])$/,
}

export const ALERTA_PCT_DEFECTO = 80
/** Ventana de la tabla mensual y del costo de herramientas (resolución (c) del PM). */
export const MESES_VENTANA = 12
const MESES_PROMEDIO = 3

export interface Movimiento {
  movId: string
  mes: string // AAAA-MM
  proyecto: Proyecto
  tipo: Tipo
  categoria: Categoria
  concepto: string
  productoId: string | null
  centavos: number
}

/** Fila no sumada (§2.1 y §4.5): solo la referencia y las columnas que fallan, nunca el monto. */
export interface FilaProblema {
  ref: string
  columnas: string[]
}

export interface Parametros {
  topeCentavos: number | null
  alertaPct: number
  mesInicio: string | null
  avisos: string[]
}

export type Bloque<T> =
  | { estado: 'no-disponible'; mensaje: string }
  | { estado: 'vacio'; mensaje: string }
  | { estado: 'ok'; datos: T }

export interface Capital {
  usadoCentavos: number
  porProyecto: Record<Proyecto, number>
  topeCentavos: number | null
  /** Porcentaje usado del tope, sin redondear; null sin tope válido. */
  pct: number | null
  restanteCentavos: number | null
  alerta: null | 'aviso' | 'superado'
  alertaPct: number
  avisos: string[]
}

export interface MesGasto {
  mes: string
  gasto: Record<Proyecto, number>
  ingresoCentavos: number
  /** Gasto + Inversión por categoría y proyecto, solo las categorías con movimientos. */
  categorias: Array<{ categoria: Categoria; gasto: Record<Proyecto, number> }>
}

export interface GastoMensual {
  meses: MesGasto[]
  avisos: string[]
}

export interface Herramientas {
  meses: string[]
  conceptos: Array<{ concepto: string; porMes: Record<string, number | null>; sinRegistrar: string[] }>
  totalPorMes: Record<string, number>
  /** Promedio mensual de los últimos 3 meses de la ventana (incluye el mes en curso). */
  promedioCentavos: number
  mesesPromedio: string[]
  avisos: string[]
}

export interface ProductoPyl {
  productoId: string | null
  ingresoCentavos: number
  gastoCentavos: number
  inversionCentavos: number
  resultadoCentavos: number
}

export interface Pyl {
  productos: ProductoPyl[]
  sinProducto: ProductoPyl | null
}

export interface FinanzasVista {
  capital: Bloque<Capital>
  mensual: Bloque<GastoMensual>
  herramientas: Bloque<Herramientas>
  pyl: Bloque<Pyl>
  problemas: FilaProblema[]
  movimientosValidos: number
}

const cero = (): Record<Proyecto, number> => ({ ECO: 0, POS: 0 })

/** Número de una celda leída con UNFORMATTED_VALUE: número tal cual o texto decimal sin separadores de miles. */
export function numeroCelda(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw !== 'string') return null
  return parseNumber(cellText(raw)).value
}

/** Texto de una celda; un número se convierte sin formato (p. ej. 2026 → «2026»). */
function texto(raw: unknown): string | null {
  return typeof raw === 'boolean' ? null : cellText(raw)
}

/** Igual que alguno de los valores permitidos sin distinguir mayúsculas; devuelve la forma canónica. */
function canonico<T extends string>(raw: string | null, valores: readonly T[]): T | null {
  if (raw === null) return null
  const v = raw.toLocaleLowerCase('es')
  return valores.find((x) => x.toLocaleLowerCase('es') === v) ?? null
}

/** `AAAA-MM` o una fecha `AAAA-MM-DD` (Sheets puede convertir «2026-10» en fecha): el mes. */
export function mesDeTexto(raw: string | null): string | null {
  if (raw === null) return null
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) return raw
  const fecha = parseCivilDate(raw).value
  return fecha ? fecha.slice(0, 7) : null
}

/** Mes `AAAA-MM` desplazado `n` meses. */
export function sumarMeses(mes: string, n: number): string {
  const [y, m] = mes.split('-').map(Number) as [number, number]
  const total = y * 12 + (m - 1) + n
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`
}

/** Ventana móvil de los últimos 12 meses hasta el mes en curso en Mérida, sin ir antes de MES_INICIO (resolución (c)). */
export function ventanaMeses(now: number, mesInicio: string | null): string[] {
  const actual = civilDateInZone(now).slice(0, 7)
  const meses: string[] = []
  for (let i = MESES_VENTANA - 1; i >= 0; i--) {
    const mes = sumarMeses(actual, -i)
    if (mesInicio === null || mes >= mesInicio) meses.push(mes)
  }
  return meses
}

/** PARAMETROS (§2.4): solo las claves conocidas; un valor no válido se ignora con aviso. */
export function leerParametros(rows: unknown[][]): Parametros {
  const header = (rows[0] ?? []).map(texto)
  const iClave = header.indexOf('PARAMETRO')
  const iValor = header.indexOf('VALOR')
  const avisos: string[] = []
  const valores = new Map<string, unknown>()
  if (iClave === -1 || iValor === -1) {
    avisos.push('PARAMETROS no tiene las columnas PARAMETRO y VALOR.')
  } else {
    for (const row of rows.slice(1, MAX_DATA_ROWS + 1)) {
      const clave = texto(row[iClave])
      // La primera fila de cada clave gana; las repetidas se ignoran.
      if (clave !== null && !valores.has(clave)) valores.set(clave, row[iValor])
    }
  }

  let topeCentavos: number | null = null
  if (valores.has('CAPITAL_TOPE_MXN')) {
    const tope = numeroCelda(valores.get('CAPITAL_TOPE_MXN'))
    if (tope !== null && tope > 0) topeCentavos = Math.round(tope * 100)
    else if (texto(valores.get('CAPITAL_TOPE_MXN')) !== null) avisos.push('CAPITAL_TOPE_MXN no es un número mayor que 0.')
  }

  let alertaPct = ALERTA_PCT_DEFECTO
  if (texto(valores.get('ALERTA_PCT')) !== null) {
    const pct = numeroCelda(valores.get('ALERTA_PCT'))
    if (pct !== null && pct >= 1 && pct <= 100) alertaPct = pct
    else avisos.push(`ALERTA_PCT no está entre 1 y 100; se usa ${ALERTA_PCT_DEFECTO} %.`)
  }

  let mesInicio: string | null = null
  if (texto(valores.get('MES_INICIO')) !== null) {
    mesInicio = mesDeTexto(texto(valores.get('MES_INICIO')))
    if (mesInicio === null) avisos.push('MES_INICIO no tiene el formato AAAA-MM; se cuentan todos los meses.')
  } else {
    avisos.push('Falta MES_INICIO en PARAMETROS; se cuentan todos los meses.')
  }
  return { topeCentavos, alertaPct, mesInicio, avisos }
}

type Lectura =
  | { estado: 'no-disponible'; mensaje: string }
  | { estado: 'ok'; movimientos: Movimiento[]; problemas: FilaProblema[] }

/** MOVIMIENTOS (§2.1 y §2.2): valida cada fila; las que fallan no se suman y se listan sin monto. */
export function leerMovimientos(rows: unknown[][] | undefined): Lectura {
  if (rows === undefined) return { estado: 'no-disponible', mensaje: 'La pestaña MOVIMIENTOS todavía no existe.' }
  const header = (rows[0] ?? []).map(texto)
  const indice = new Map<string, number>()
  header.forEach((h, i) => {
    if (h !== null && !indice.has(h)) indice.set(h, i)
  })
  const faltan = COLUMNAS_OBLIGATORIAS.filter((c) => !indice.has(c))
  if (faltan.length) {
    return {
      estado: 'no-disponible',
      mensaje: `${faltan.length === 1 ? 'Falta la columna' : 'Faltan las columnas'} ${faltan.join(', ')} en MOVIMIENTOS; no se muestran totales.`,
    }
  }
  // El lector pide encabezado + MAX_DATA_ROWS + 1 fila centinela: con más filas los totales serían parciales (§3, regla 4).
  if (rows.length > MAX_DATA_ROWS + 1) {
    return { estado: 'no-disponible', mensaje: `MOVIMIENTOS está truncada (más de ${MAX_DATA_ROWS} filas): no se muestran totales.` }
  }

  type Candidata = { fila: number; movId: string | null; mov: Omit<Movimiento, 'movId'> | null; columnas: string[] }
  const candidatas: Candidata[] = []
  rows.slice(1).forEach((row, i) => {
    const celda = (c: (typeof COLUMNAS_LEIDAS)[number]) => row[indice.get(c) ?? -1]
    if (COLUMNAS_LEIDAS.every((c) => texto(celda(c)) === null)) return
    const columnas: string[] = []
    const movId = texto(celda('MOV_ID'))
    const fecha = parseCivilDate(texto(celda('FECHA'))).value
    const proyecto = canonico(texto(celda('PROYECTO')), PROYECTOS)
    const tipo = canonico(texto(celda('TIPO')), TIPOS)
    const categoria = canonico(texto(celda('CATEGORIA')), CATEGORIAS)
    const concepto = texto(celda('CONCEPTO'))
    const monto = numeroCelda(celda('MONTO_MXN'))
    const fuente = canonico(texto(celda('FUENTE')), FUENTES)
    const comprobante = canonico(texto(celda('COMPROBANTE'))?.replace(/^si$/i, 'sí') ?? null, ['sí', 'no'])
    if (movId === null || (fuente !== null && !PREFIJOS[fuente].test(movId)) || (fuente === null && !Object.values(PREFIJOS).some((r) => r.test(movId)))) {
      columnas.push('MOV_ID')
    }
    if (fecha === null) columnas.push('FECHA')
    if (proyecto === null) columnas.push('PROYECTO')
    if (tipo === null) columnas.push('TIPO')
    if (categoria === null) columnas.push('CATEGORIA')
    if (concepto === null) columnas.push('CONCEPTO')
    if (monto === null || monto <= 0) columnas.push('MONTO_MXN')
    if (fuente === null) columnas.push('FUENTE')
    if (comprobante === null) columnas.push('COMPROBANTE')
    const mov = columnas.length === 0
      ? {
          mes: fecha!.slice(0, 7), proyecto: proyecto!, tipo: tipo!, categoria: categoria!, concepto: concepto!,
          productoId: texto(celda('PRODUCTO_ID')), centavos: Math.round(monto! * 100),
        }
      : null
    // Número de fila en la hoja: encabezado en la fila 1.
    candidatas.push({ fila: i + 2, movId, mov, columnas })
  })

  // MOV_ID duplicado: ninguna de sus filas se suma, porque no se sabe cuál es la buena (§2.1).
  const cuenta = new Map<string, number>()
  for (const c of candidatas) if (c.movId !== null) cuenta.set(c.movId, (cuenta.get(c.movId) ?? 0) + 1)
  const movimientos: Movimiento[] = []
  const problemas: FilaProblema[] = []
  for (const c of candidatas) {
    const duplicado = c.movId !== null && (cuenta.get(c.movId) ?? 0) > 1
    const columnas = duplicado && !c.columnas.includes('MOV_ID') ? ['MOV_ID (duplicado)', ...c.columnas]
      : duplicado ? c.columnas.map((x) => (x === 'MOV_ID' ? 'MOV_ID (duplicado)' : x)) : c.columnas
    if (columnas.length === 0 && c.mov) movimientos.push({ movId: c.movId!, ...c.mov })
    else problemas.push({ ref: c.movId !== null && /^[A-Za-z0-9_.:-]{1,40}$/.test(c.movId) ? `${c.movId} (fila ${c.fila})` : `fila ${c.fila}`, columnas })
  }
  return { estado: 'ok', movimientos, problemas }
}

const esGasto = (m: Movimiento) => m.tipo === 'Gasto' || m.tipo === 'Inversión'

/** §2.4 y §4.1: Gasto + Inversión de ECO y POS desde MES_INICIO, sin restar ingresos. */
export function capitalUsado(movimientos: Movimiento[], parametros: Parametros): Capital {
  const porProyecto = cero()
  for (const m of movimientos) {
    if (esGasto(m) && (parametros.mesInicio === null || m.mes >= parametros.mesInicio)) porProyecto[m.proyecto] += m.centavos
  }
  const usadoCentavos = porProyecto.ECO + porProyecto.POS
  const tope = parametros.topeCentavos
  const pct = tope === null ? null : (usadoCentavos / tope) * 100
  const avisos = [...parametros.avisos]
  if (tope === null) avisos.unshift('Falta CAPITAL_TOPE_MXN en PARAMETROS: sin barra ni alerta.')
  return {
    usadoCentavos, porProyecto, topeCentavos: tope, pct, restanteCentavos: tope === null ? null : tope - usadoCentavos,
    alerta: alertaCapital(pct, parametros.alertaPct), alertaPct: parametros.alertaPct, avisos,
  }
}

/** Ámbar desde ALERTA_PCT (80 % por defecto) hasta antes del 100 %; rojo desde el 100 %. Solo informa. */
export function alertaCapital(pct: number | null, alertaPct: number = ALERTA_PCT_DEFECTO): Capital['alerta'] {
  if (pct === null) return null
  if (pct >= 100) return 'superado'
  return pct >= alertaPct ? 'aviso' : null
}

/** §4.2: Gasto + Inversión por mes y proyecto en la ventana; Ingreso aparte, nunca restado. */
export function gastoMensual(movimientos: Movimiento[], meses: string[]): MesGasto[] {
  return meses.map((mes) => {
    const gasto = cero()
    let ingresoCentavos = 0
    const porCategoria = new Map<Categoria, Record<Proyecto, number>>()
    for (const m of movimientos) {
      if (m.mes !== mes) continue
      if (m.tipo === 'Ingreso') {
        ingresoCentavos += m.centavos
        continue
      }
      gasto[m.proyecto] += m.centavos
      const c = porCategoria.get(m.categoria) ?? cero()
      c[m.proyecto] += m.centavos
      porCategoria.set(m.categoria, c)
    }
    const categorias = CATEGORIAS.filter((c) => porCategoria.has(c)).map((categoria) => ({ categoria, gasto: porCategoria.get(categoria)! }))
    return { mes, gasto, ingresoCentavos, categorias }
  })
}

/** §4.3: Herramientas por CONCEPTO y mes, total mensual, promedio de 3 meses y meses «sin registrar». */
export function costoHerramientas(movimientos: Movimiento[], meses: string[]): Omit<Herramientas, 'avisos'> {
  const enVentana = new Set(meses)
  const porConcepto = new Map<string, Map<string, number>>()
  for (const m of movimientos) {
    if (m.categoria !== 'Herramientas' || !esGasto(m) || !enVentana.has(m.mes)) continue
    const porMes = porConcepto.get(m.concepto) ?? new Map<string, number>()
    porMes.set(m.mes, (porMes.get(m.mes) ?? 0) + m.centavos)
    porConcepto.set(m.concepto, porMes)
  }
  const totalPorMes: Record<string, number> = Object.fromEntries(meses.map((mes) => [mes, 0]))
  const conceptos = [...porConcepto.keys()].sort((a, b) => a.localeCompare(b, 'es')).map((concepto) => {
    const porMesMapa = porConcepto.get(concepto)!
    const porMes: Record<string, number | null> = {}
    const sinRegistrar: string[] = []
    meses.forEach((mes, i) => {
      const v = porMesMapa.get(mes) ?? null
      porMes[mes] = v
      if (v !== null) totalPorMes[mes]! += v
      // Tuvo cargo el mes anterior y este no: posible captura olvidada (no se inventa el monto).
      if (v === null && i > 0 && porMesMapa.has(meses[i - 1]!)) sinRegistrar.push(mes)
    })
    return { concepto, porMes, sinRegistrar }
  })
  const mesesPromedio = meses.slice(-MESES_PROMEDIO)
  const suma = mesesPromedio.reduce((s, mes) => s + (totalPorMes[mes] ?? 0), 0)
  return { meses, conceptos, totalPorMes, promedioCentavos: mesesPromedio.length ? Math.round(suma / mesesPromedio.length) : 0, mesesPromedio }
}

/** §4.4: por PRODUCTO_ID, ingresos − (gastos + inversión); sin producto aparte, sin repartir. */
export function pylPorProducto(movimientos: Movimiento[]): Pyl {
  const mapa = new Map<string | null, ProductoPyl>()
  for (const m of movimientos) {
    const p = mapa.get(m.productoId) ?? { productoId: m.productoId, ingresoCentavos: 0, gastoCentavos: 0, inversionCentavos: 0, resultadoCentavos: 0 }
    if (m.tipo === 'Ingreso') p.ingresoCentavos += m.centavos
    else if (m.tipo === 'Gasto') p.gastoCentavos += m.centavos
    else p.inversionCentavos += m.centavos
    p.resultadoCentavos = p.ingresoCentavos - (p.gastoCentavos + p.inversionCentavos)
    mapa.set(m.productoId, p)
  }
  const productos = [...mapa.values()].filter((p) => p.productoId !== null)
    .sort((a, b) => a.productoId!.localeCompare(b.productoId!, 'es'))
  return { productos, sinProducto: mapa.get(null) ?? null }
}

const SIN_MOVIMIENTOS = 'Sin movimientos todavía.'

/** Arma los bloques de §4 con los estados de §5. Nunca lanza: cada bloque resuelve su estado. */
export function construirFinanzas(raw: FinanzasRaw, now: number): FinanzasVista {
  const lectura = leerMovimientos(raw.MOVIMIENTOS)
  if (lectura.estado === 'no-disponible') {
    const b = { estado: 'no-disponible', mensaje: lectura.mensaje } as const
    return { capital: b, mensual: b, herramientas: b, pyl: b, problemas: [], movimientosValidos: 0 }
  }
  const { movimientos, problemas } = lectura
  const parametros = raw.PARAMETROS === undefined ? null : leerParametros(raw.PARAMETROS)
  const avisosVentana = parametros === null ? ['La pestaña PARAMETROS todavía no existe; se cuentan todos los meses.'] : []
  const meses = ventanaMeses(now, parametros?.mesInicio ?? null)
  const vacio = movimientos.length === 0
  const vacioBloque = { estado: 'vacio', mensaje: problemas.length ? 'Sin movimientos sumables: revisa las filas con problema.' : SIN_MOVIMIENTOS } as const

  const capital: Bloque<Capital> = parametros === null
    ? { estado: 'no-disponible', mensaje: 'La pestaña PARAMETROS todavía no existe.' }
    : { estado: 'ok', datos: capitalUsado(movimientos, parametros) }
  const mensual: Bloque<GastoMensual> = vacio ? vacioBloque
    : { estado: 'ok', datos: { meses: gastoMensual(movimientos, meses), avisos: avisosVentana } }
  const herr = costoHerramientas(movimientos, meses)
  const herramientas: Bloque<Herramientas> = vacio ? vacioBloque
    : herr.conceptos.length === 0 ? { estado: 'vacio', mensaje: 'Sin filas de Herramientas en los últimos 12 meses.' }
    : { estado: 'ok', datos: { ...herr, avisos: avisosVentana } }
  const pyl: Bloque<Pyl> = vacio ? vacioBloque : { estado: 'ok', datos: pylPorProducto(movimientos) }
  return { capital, mensual, herramientas, pyl, problemas, movimientosValidos: movimientos.length }
}

const MXN = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Centavos enteros → «$1,234.50». */
export function formatoMxn(centavos: number): string {
  return MXN.format(centavos / 100)
}
