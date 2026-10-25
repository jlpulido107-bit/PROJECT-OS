import { civilDateInZone, parseCivilDate } from '../dates'
import { cellText, parseNumber } from '../parse'
import { MAX_DATA_ROWS } from '../schema'

/**
 * Vista de solo lectura del libro FINANZAS (/finanzas, ORD-POS-074; esquema v2 y recurrentes, ORD-POS-076). Funciones puras sobre las filas que el lector ya
 * trajo con `UNFORMATTED_VALUE` (montos como número, fechas como texto): no leen, no escriben y no corrigen nada
 * (docs/diseno-finanzas.md §2 y §4). Las columnas se buscan por nombre de encabezado (fila 1), nunca por posición.
 * Los montos se suman en centavos enteros para no acumular error de punto flotante.
 */

/**
 * Pestañas que lee /finanzas (§3), en un solo batchGet. RESUMEN no se lee: es una vista derivada en la hoja (§2.5).
 * RECURRENTES es del esquema v2 (docs/diseno-finanzas-v2.md §4.1).
 */
export const FINANZAS_TABS = ['MOVIMIENTOS', 'PARAMETROS', 'RECURRENTES'] as const
export type FinanzasTab = (typeof FINANZAS_TABS)[number]
export type FinanzasRaw = Partial<Record<FinanzasTab, unknown[][]>>

/** Columnas obligatorias de MOVIMIENTOS (§2.1). Las opcionales son informativas y la vista no las usa. */
export const COLUMNAS_OBLIGATORIAS = [
  'MOV_ID', 'FECHA', 'PROYECTO', 'TIPO', 'CATEGORIA', 'CONCEPTO', 'MONTO_MXN', 'FUENTE', 'COMPROBANTE',
] as const
/** `AJUSTE_DE` es opcional (v2 §8): una hoja v1 sin la columna sigue válida. */
const COLUMNAS_LEIDAS = [...COLUMNAS_OBLIGATORIAS, 'PRODUCTO_ID', 'AJUSTE_DE'] as const

export const PROYECTOS = ['ECO', 'POS'] as const
export type Proyecto = (typeof PROYECTOS)[number]
export const TIPOS = ['Gasto', 'Ingreso', 'Inversión'] as const
export type Tipo = (typeof TIPOS)[number]
/** §2.3, lista cerrada. Una categoría fuera de la lista hace la fila «con problema» (§2.1). */
export const CATEGORIAS = ['Herramientas', 'Marketplace', 'Producto', 'Marketing', 'Legal y marca', 'Ventas'] as const
export type Categoria = (typeof CATEGORIAS)[number]
export const FUENTES = ['manual', 'sp-api', 'anthropic', 'recurrente', 'agente-finanzas'] as const
export type Fuente = (typeof FUENTES)[number]

/** `ID` de RECURRENTES (v2 §4.1): forma parte del `MOV_ID` `REC-<ID>-AAAA-MM`. */
export const RECURRENTE_ID = /^[A-Z0-9]{2,12}$/

/**
 * §2.2 con la resolución (a) del PM: solo MAN- con `manual`, SPAPI- con `sp-api`, CLAUDE- con `anthropic` y, desde v2
 * §8, REC-<ID>-AAAA-MM con `recurrente` y, desde v3 §7 (ORD-POS-092), CLAUDE-EXTRA-AAAA-MM-Q1/Q2 con `agente-finanzas`;
 * cualquier otro prefijo, o uno que no cuadra con su FUENTE, es fila con problema.
 */
const PREFIJOS: Record<Fuente, RegExp> = {
  manual: /^MAN-\d{4}$/,
  'sp-api': /^SPAPI-[A-Za-z0-9_.:-]+$/,
  anthropic: /^CLAUDE-\d{4}-(0[1-9]|1[0-2])$/,
  recurrente: /^REC-[A-Z0-9]{2,12}-\d{4}-(0[1-9]|1[0-2])$/,
  'agente-finanzas': /^CLAUDE-EXTRA-\d{4}-(0[1-9]|1[0-2])-Q[12]$/,
}

/** `MOV_ID` de la confirmación de un recurrente en un mes (v2 §4.3). */
export function movIdRecurrente(id: string, mes: string): string {
  return `REC-${id}-${mes}`
}

export const ALERTA_PCT_DEFECTO = 80
/** Ventana de la tabla mensual y del costo de herramientas (resolución (c) del PM). */
export const MESES_VENTANA = 12
const MESES_PROMEDIO = 3

export interface Movimiento {
  movId: string
  /** FECHA de la fila (AAAA-MM-DD), para acumulados «hasta el día X» (ORD-POS-096); no cambia el esquema de la hoja. */
  fecha: string
  mes: string // AAAA-MM
  proyecto: Proyecto
  tipo: Tipo
  categoria: Categoria
  concepto: string
  productoId: string | null
  /** Con signo: negativo solo en un ajuste (v2 §8). */
  centavos: number
  /** `MOV_ID` que corrige (v2 §3.4), o null si no es un ajuste. */
  ajusteDe: string | null
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
  recurrentes: Bloque<RecurrentesMes>
  /** Gasto mensual en Claude (ORD-POS-078, /agentes). */
  claude: Bloque<GastoClaudeMes[]>
  /** El mismo gasto en Claude por FECHA, para la tendencia de Inicio (ORD-POS-096, T5). */
  claudeDiario: Bloque<GastoClaudeDia[]>
  problemas: FilaProblema[]
  movimientosValidos: number
  /** Movimientos originales (no ajustes) que «Ajustar» puede referir (v2 §3.4, ORD-POS-077). */
  ajustables: Ajustable[]
  /** `TIPO_CAMBIO_DEFECTO` de PARAMETROS para precargar los formularios en USD, o null. */
  tipoCambioDefecto: string | null
}

export interface Ajustable {
  movId: string
  proyecto: Proyecto
  tipo: Tipo
  categoria: Categoria
  concepto: string
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
  | { estado: 'ok'; movimientos: Movimiento[]; problemas: FilaProblema[]; ids: Set<string> }

/**
 * MOVIMIENTOS (§2.1 y §2.2, con los cambios de v2 §8): valida cada fila; las que fallan no se suman y se listan sin
 * monto. `ids` son todos los `MOV_ID` presentes, también los de filas con problema: un `REC-…` ya escrito cuenta como
 * confirmado aunque su fila tenga un error (v2 §4.3, paso 3).
 */
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
    const ajusteDe = texto(celda('AJUSTE_DE'))
    if (movId === null || (fuente !== null && !PREFIJOS[fuente].test(movId)) || (fuente === null && !Object.values(PREFIJOS).some((r) => r.test(movId)))) {
      columnas.push('MOV_ID')
    }
    if (fecha === null) columnas.push('FECHA')
    if (proyecto === null) columnas.push('PROYECTO')
    // Un recurrente y un cargo extra del agente siempre son Gasto (v2 §4.1 y v3 §7).
    if (tipo === null || ((fuente === 'recurrente' || fuente === 'agente-finanzas') && tipo !== 'Gasto')) columnas.push('TIPO')
    if (categoria === null) columnas.push('CATEGORIA')
    if (concepto === null) columnas.push('CONCEPTO')
    // > 0 siempre; en un ajuste, distinto de 0 y con signo (v2 §8).
    if (monto === null || (ajusteDe === null ? monto <= 0 : monto === 0)) columnas.push('MONTO_MXN')
    if (fuente === null) columnas.push('FUENTE')
    if (comprobante === null) columnas.push('COMPROBANTE')
    // Un ajuste lleva su propio MAN-NNNN (v2 §3.4) y no se refiere a sí mismo; que el referido exista se revisa abajo.
    if (ajusteDe !== null && (fuente !== 'manual' || ajusteDe === movId)) columnas.push('AJUSTE_DE')
    const mov = columnas.length === 0
      ? {
          fecha: fecha!, mes: fecha!.slice(0, 7), proyecto: proyecto!, tipo: tipo!, categoria: categoria!, concepto: concepto!,
          productoId: texto(celda('PRODUCTO_ID')), centavos: Math.round(monto! * 100), ajusteDe,
        }
      : null
    // Número de fila en la hoja: encabezado en la fila 1.
    candidatas.push({ fila: i + 2, movId, mov, columnas })
  })

  // MOV_ID duplicado: ninguna de sus filas se suma, porque no se sabe cuál es la buena (§2.1).
  const cuenta = new Map<string, number>()
  for (const c of candidatas) if (c.movId !== null) cuenta.set(c.movId, (cuenta.get(c.movId) ?? 0) + 1)
  for (const c of candidatas) {
    if (c.movId === null || (cuenta.get(c.movId) ?? 0) <= 1) continue
    c.columnas = c.columnas.includes('MOV_ID') ? c.columnas.map((x) => (x === 'MOV_ID' ? 'MOV_ID (duplicado)' : x)) : ['MOV_ID (duplicado)', ...c.columnas]
  }
  // AJUSTE_DE debe llevar, directo o por una cadena de ajustes, a una fila que sí se suma y no es ajuste (v2 §3.1 y
  // §3.4): un ajuste de una fila inexistente o con problema, o un ciclo de ajustes, restaría sin su original.
  const aceptados = new Set(candidatas.filter((c) => c.columnas.length === 0 && c.mov?.ajusteDe === null).map((c) => c.movId!))
  const ajustes = candidatas.filter((c) => c.columnas.length === 0 && c.mov?.ajusteDe != null)
  for (let crece = true; crece;) {
    crece = false
    for (const c of ajustes) {
      if (!aceptados.has(c.movId!) && aceptados.has(c.mov!.ajusteDe!)) {
        aceptados.add(c.movId!)
        crece = true
      }
    }
  }
  for (const c of ajustes) if (!aceptados.has(c.movId!)) c.columnas.push('AJUSTE_DE')

  const movimientos: Movimiento[] = []
  const problemas: FilaProblema[] = []
  for (const c of candidatas) {
    if (c.columnas.length === 0 && c.mov) movimientos.push({ movId: c.movId!, ...c.mov })
    else problemas.push({ ref: c.movId !== null && /^[A-Za-z0-9_.:-]{1,40}$/.test(c.movId) ? `${c.movId} (fila ${c.fila})` : `fila ${c.fila}`, columnas: c.columnas })
  }
  const ids = new Set(candidatas.flatMap((c) => (c.movId === null ? [] : [c.movId])))
  return { estado: 'ok', movimientos, problemas, ids }
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

/** Un ajuste («Ajuste de MAN-…: …») cuenta con el concepto de su original, en el mes de su propia FECHA. */
function originalDe(movimientos: Movimiento[]): (m: Movimiento) => Movimiento {
  const porId = new Map(movimientos.map((m) => [m.movId, m]))
  return (m) => {
    const vistos = new Set<string>()
    let actual = m
    while (actual.ajusteDe !== null && !vistos.has(actual.movId) && porId.has(actual.ajusteDe)) {
      vistos.add(actual.movId)
      actual = porId.get(actual.ajusteDe)!
    }
    return actual
  }
}

/** Línea única de Claude en Herramientas: suscripción (`REC-CLAUDE-…`), `CLAUDE-…` y cargos extra (v3, ORD-POS-092). */
export const CONCEPTO_CLAUDE = 'Claude'
const MOV_ID_CLAUDE = /^(REC-)?CLAUDE-/
/** Original de Claude: `MOV_ID` `CLAUDE-…`/`REC-CLAUDE-…` (incluye `CLAUDE-EXTRA-…`) o CONCEPTO con «Claude». */
const esDeClaude = (o: Movimiento) => /\bclaude\b/i.test(o.concepto) || MOV_ID_CLAUDE.test(o.movId)

export interface GastoClaudeMes {
  mes: string
  gasto: Record<Proyecto, number>
}

/**
 * Gasto mensual en Claude (/agentes, ORD-POS-078): Gasto + Inversión de `Herramientas` cuyo original es de Claude
 * (CONCEPTO con «Claude», o `MOV_ID` `CLAUDE-…` o `REC-CLAUDE-…`, §2.3 y v2 §4.4), por mes y proyecto, de todos los meses.
 */
export function gastoClaudeMensual(movimientos: Movimiento[]): GastoClaudeMes[] {
  return gastoClaudePor(movimientos, (m) => m.mes).map(([mes, gasto]) => ({ mes, gasto }))
}

export interface GastoClaudeDia {
  fecha: string
  gasto: Record<Proyecto, number>
}

/** Lo mismo que `gastoClaudeMensual`, por FECHA de cada fila (ORD-POS-096): un ajuste cuenta en su propia fecha. */
export function gastoClaudeDiario(movimientos: Movimiento[]): GastoClaudeDia[] {
  return gastoClaudePor(movimientos, (m) => m.fecha).map(([fecha, gasto]) => ({ fecha, gasto }))
}

function gastoClaudePor(movimientos: Movimiento[], clave: (m: Movimiento) => string): Array<[string, Record<Proyecto, number>]> {
  const original = originalDe(movimientos)
  const grupos = new Map<string, Record<Proyecto, number>>()
  for (const m of movimientos) {
    const o = original(m)
    if (m.categoria !== 'Herramientas' || !esGasto(m)) continue
    if (!esDeClaude(o)) continue
    const g = grupos.get(clave(m)) ?? cero()
    g[m.proyecto] += m.centavos
    grupos.set(clave(m), g)
  }
  return [...grupos.keys()].sort().map((k) => [k, grupos.get(k)!])
}

/**
 * §4.3: Herramientas por CONCEPTO y mes, total mensual, promedio de 3 meses y meses «sin registrar». Lo de Claude
 * (mismo criterio que `gastoClaudeMensual`) va en una sola línea, aunque el recurrente y el cargo extra tengan CONCEPTO
 * distinto.
 */
export function costoHerramientas(movimientos: Movimiento[], meses: string[]): Omit<Herramientas, 'avisos'> {
  const enVentana = new Set(meses)
  const original = originalDe(movimientos)
  const conceptoDe = (m: Movimiento): string => {
    const o = original(m)
    return esDeClaude(o) ? CONCEPTO_CLAUDE : o.concepto
  }
  const porConcepto = new Map<string, Map<string, number>>()
  for (const m of movimientos) {
    if (m.categoria !== 'Herramientas' || !esGasto(m) || !enVentana.has(m.mes)) continue
    const concepto = conceptoDe(m)
    const porMes = porConcepto.get(concepto) ?? new Map<string, number>()
    porMes.set(m.mes, (porMes.get(m.mes) ?? 0) + m.centavos)
    porConcepto.set(concepto, porMes)
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


/** Columnas de RECURRENTES (v2 §4.1). `HASTA` es opcional: sin la columna, todos los recurrentes siguen vigentes. */
export const COLUMNAS_RECURRENTES = ['ID', 'CONCEPTO', 'PROYECTO', 'CATEGORIA', 'MONTO', 'MONEDA', 'DIA_COBRO', 'DESDE'] as const
export const MONEDAS = ['MXN', 'USD'] as const
export type Moneda = (typeof MONEDAS)[number]

export interface Recurrente {
  id: string
  concepto: string
  proyecto: Proyecto
  categoria: Categoria
  /** Monto esperado en `moneda`, en centavos. */
  centavos: number
  moneda: Moneda
  diaCobro: number
  desde: string
  hasta: string | null
}

export type LecturaRecurrentes =
  | { estado: 'no-disponible'; mensaje: string }
  | { estado: 'ok'; recurrentes: Recurrente[]; problemas: FilaProblema[] }

/** Número con hasta 2 decimales (centavos exactos). */
function conDosDecimales(n: number): boolean {
  return Math.abs(n * 100 - Math.round(n * 100)) < 1e-6
}

/**
 * RECURRENTES (v2 §4.1): valida cada fila. Una fila con `ID` vacío, duplicado o fuera de formato, o con otra columna
 * fuera de regla, no genera pendientes y se lista con su `ID` (o número de fila) y la columna, nunca con el monto.
 */
export function leerRecurrentes(rows: unknown[][] | undefined): LecturaRecurrentes {
  if (rows === undefined) return { estado: 'no-disponible', mensaje: 'La pestaña RECURRENTES todavía no existe.' }
  const header = (rows[0] ?? []).map(texto)
  const indice = new Map<string, number>()
  header.forEach((h, i) => {
    if (h !== null && !indice.has(h)) indice.set(h, i)
  })
  const faltan = COLUMNAS_RECURRENTES.filter((c) => !indice.has(c))
  if (faltan.length) {
    return {
      estado: 'no-disponible',
      mensaje: `${faltan.length === 1 ? 'Falta la columna' : 'Faltan las columnas'} ${faltan.join(', ')} en RECURRENTES; no se calculan pendientes.`,
    }
  }
  if (rows.length > MAX_DATA_ROWS + 1) {
    return { estado: 'no-disponible', mensaje: `RECURRENTES está truncada (más de ${MAX_DATA_ROWS} filas): no se calculan pendientes.` }
  }

  type Candidata = { fila: number; id: string | null; rec: Recurrente | null; columnas: string[] }
  const leidas = [...COLUMNAS_RECURRENTES, 'HASTA'] as const
  const candidatas: Candidata[] = []
  rows.slice(1).forEach((row, i) => {
    const celda = (c: (typeof leidas)[number]) => row[indice.get(c) ?? -1]
    if (leidas.every((c) => texto(celda(c)) === null)) return
    const columnas: string[] = []
    const id = texto(celda('ID'))
    const concepto = texto(celda('CONCEPTO'))
    const proyecto = canonico(texto(celda('PROYECTO')), PROYECTOS)
    const categoria = canonico(texto(celda('CATEGORIA')), CATEGORIAS)
    const monto = numeroCelda(celda('MONTO'))
    const moneda = canonico(texto(celda('MONEDA')), MONEDAS)
    const dia = numeroCelda(celda('DIA_COBRO'))
    const desde = mesDeTexto(texto(celda('DESDE')))
    const hastaTexto = texto(celda('HASTA'))
    const hasta = mesDeTexto(hastaTexto)
    if (id === null || !RECURRENTE_ID.test(id)) columnas.push('ID')
    if (concepto === null) columnas.push('CONCEPTO')
    if (proyecto === null) columnas.push('PROYECTO')
    if (categoria === null) columnas.push('CATEGORIA')
    if (monto === null || monto <= 0 || !conDosDecimales(monto)) columnas.push('MONTO')
    if (moneda === null) columnas.push('MONEDA')
    if (dia === null || !Number.isInteger(dia) || dia < 1 || dia > 31) columnas.push('DIA_COBRO')
    if (desde === null) columnas.push('DESDE')
    if (hastaTexto !== null && (hasta === null || (desde !== null && hasta < desde))) columnas.push('HASTA')
    const rec = columnas.length === 0
      ? {
          id: id!, concepto: concepto!, proyecto: proyecto!, categoria: categoria!, centavos: Math.round(monto! * 100),
          moneda: moneda!, diaCobro: dia!, desde: desde!, hasta,
        }
      : null
    candidatas.push({ fila: i + 2, id, rec, columnas })
  })

  // ID duplicado: ninguna de sus filas genera pendientes (el MOV_ID REC-<ID>-AAAA-MM sería ambiguo).
  const cuenta = new Map<string, number>()
  for (const c of candidatas) if (c.id !== null) cuenta.set(c.id, (cuenta.get(c.id) ?? 0) + 1)
  const recurrentes: Recurrente[] = []
  const problemas: FilaProblema[] = []
  for (const c of candidatas) {
    if (c.id !== null && (cuenta.get(c.id) ?? 0) > 1) {
      c.columnas = c.columnas.includes('ID') ? c.columnas.map((x) => (x === 'ID' ? 'ID (duplicado)' : x)) : ['ID (duplicado)', ...c.columnas]
    }
    if (c.columnas.length === 0 && c.rec) recurrentes.push(c.rec)
    else problemas.push({ ref: c.id !== null && /^[A-Za-z0-9_.:-]{1,40}$/.test(c.id) ? `${c.id} (fila ${c.fila})` : `fila ${c.fila}`, columnas: c.columnas })
  }
  return { estado: 'ok', recurrentes, problemas }
}

/** Último día del mes `AAAA-MM` (28 a 31). */
export function ultimoDiaDelMes(mes: string): number {
  const [y, m] = mes.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** Fecha de cobro en `mes`: `DIA_COBRO`, o el último día si el mes es más corto (v2 §4.1). */
export function fechaCobro(diaCobro: number, mes: string): string {
  return `${mes}-${String(Math.min(diaCobro, ultimoDiaDelMes(mes))).padStart(2, '0')}`
}

/** Vigente en `mes`: `DESDE` ≤ mes y `HASTA` vacío o ≥ mes (v2 §4.2). */
export function vigenteEn(r: Recurrente, mes: string): boolean {
  return r.desde <= mes && (r.hasta === null || r.hasta >= mes)
}

export interface Pendiente {
  recurrente: Recurrente
  mes: string
  /** `MOV_ID` que tendrá al confirmarse. */
  movId: string
  fechaCobro: string
  /** Del mes anterior y sin confirmar. */
  atrasado: boolean
  /** Del mes actual y hoy es anterior a la fecha de cobro. */
  aunNoVence: boolean
}

/**
 * Pendientes del mes actual M (en Mérida) y, como «atrasado», del mes anterior (v2 §4.2): vigentes en ese mes y sin
 * `REC-<ID>-AAAA-MM` en MOVIMIENTOS. Meses más viejos no se listan. Primero los atrasados; luego por fecha de cobro.
 */
export function pendientesRecurrentes(recurrentes: Recurrente[], movIds: ReadonlySet<string>, now: number): Pendiente[] {
  const hoy = civilDateInZone(now)
  const actual = hoy.slice(0, 7)
  const anterior = sumarMeses(actual, -1)
  const pendientes: Pendiente[] = []
  for (const mes of [anterior, actual]) {
    for (const r of recurrentes) {
      const movId = movIdRecurrente(r.id, mes)
      if (!vigenteEn(r, mes) || movIds.has(movId)) continue
      const fecha = fechaCobro(r.diaCobro, mes)
      pendientes.push({ recurrente: r, mes, movId, fechaCobro: fecha, atrasado: mes === anterior, aunNoVence: mes === actual && hoy < fecha })
    }
  }
  return pendientes.sort((a, b) => a.mes.localeCompare(b.mes) || a.fechaCobro.localeCompare(b.fechaCobro) || a.recurrente.id.localeCompare(b.recurrente.id))
}

export interface RecurrentesMes {
  mes: string
  mesAnterior: string
  pendientes: Pendiente[]
  problemas: FilaProblema[]
  vigentes: number
}

/** Bloque «Recurrentes del mes»: sin pestaña o sin MOVIMIENTOS legible, no disponible; sin filas, vacío. */
export function recurrentesDelMes(raw: unknown[][] | undefined, movimientos: Lectura, now: number): Bloque<RecurrentesMes> {
  const lectura = leerRecurrentes(raw)
  if (lectura.estado === 'no-disponible') return lectura
  if (movimientos.estado === 'no-disponible') {
    return { estado: 'no-disponible', mensaje: 'Sin MOVIMIENTOS legible no se sabe qué recurrentes ya están confirmados.' }
  }
  if (lectura.recurrentes.length === 0 && lectura.problemas.length === 0) return { estado: 'vacio', mensaje: 'Sin recurrentes registrados en RECURRENTES.' }
  const mes = civilDateInZone(now).slice(0, 7)
  return {
    estado: 'ok',
    datos: {
      mes, mesAnterior: sumarMeses(mes, -1), pendientes: pendientesRecurrentes(lectura.recurrentes, movimientos.ids, now),
      problemas: lectura.problemas, vigentes: lectura.recurrentes.filter((r) => vigenteEn(r, mes)).length,
    },
  }
}

const SIN_MOVIMIENTOS = 'Sin movimientos todavía.'

/** `TIPO_CAMBIO_DEFECTO` de PARAMETROS (v1 §2.4): número mayor que 0 con hasta 4 decimales, como texto; si no, null. */
export function tipoCambioDefecto(rows: unknown[][] | undefined): string | null {
  if (rows === undefined) return null
  const header = (rows[0] ?? []).map(texto)
  const iClave = header.indexOf('PARAMETRO')
  const iValor = header.indexOf('VALOR')
  if (iClave === -1 || iValor === -1) return null
  const fila = rows.slice(1, MAX_DATA_ROWS + 1).find((row) => texto(row[iClave]) === 'TIPO_CAMBIO_DEFECTO')
  const n = fila ? numeroCelda(fila[iValor]) : null
  if (n === null || n <= 0 || n >= 1000) return null
  const t = String(Number(n.toFixed(4)))
  return /^\d+(\.\d{1,4})?$/.test(t) ? t : null
}

function ajustablesDe(movimientos: Movimiento[]): Ajustable[] {
  return movimientos.filter((m) => m.ajusteDe === null && m.centavos > 0)
    .map(({ movId, proyecto, tipo, categoria, concepto }) => ({ movId, proyecto, tipo, categoria, concepto }))
    .sort((a, b) => b.movId.localeCompare(a.movId, 'es'))
}

/** Arma los bloques de §4 con los estados de §5. Nunca lanza: cada bloque resuelve su estado. */
export function construirFinanzas(raw: FinanzasRaw, now: number): FinanzasVista {
  const lectura = leerMovimientos(raw.MOVIMIENTOS)
  const recurrentes = recurrentesDelMes(raw.RECURRENTES, lectura, now)
  if (lectura.estado === 'no-disponible') {
    const b = { estado: 'no-disponible', mensaje: lectura.mensaje } as const
    return {
      capital: b, mensual: b, herramientas: b, pyl: b, recurrentes, claude: b, claudeDiario: b, problemas: [], movimientosValidos: 0, ajustables: [],
      tipoCambioDefecto: tipoCambioDefecto(raw.PARAMETROS),
    }
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
  const claudeMeses = gastoClaudeMensual(movimientos)
  const claude: Bloque<GastoClaudeMes[]> = vacio ? vacioBloque
    : claudeMeses.length === 0 ? { estado: 'vacio', mensaje: 'Sin filas de Claude en Herramientas.' }
    : { estado: 'ok', datos: claudeMeses }
  const claudeDiario: Bloque<GastoClaudeDia[]> = claude.estado === 'ok' ? { estado: 'ok', datos: gastoClaudeDiario(movimientos) } : claude
  return {
    capital, mensual, herramientas, pyl, recurrentes, claude, claudeDiario, problemas, movimientosValidos: movimientos.length,
    ajustables: ajustablesDe(movimientos), tipoCambioDefecto: tipoCambioDefecto(raw.PARAMETROS),
  }
}

const MXN = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 })

const USD = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Centavos enteros → «$1,234.50». */
export function formatoMxn(centavos: number): string {
  return MXN.format(centavos / 100)
}

/** Centavos enteros en la moneda del recurrente → «$1,234.50» o «USD 1,234.50». */
export function formatoMoneda(centavos: number, moneda: Moneda): string {
  return moneda === 'USD' ? USD.format(centavos / 100) : formatoMxn(centavos)
}
