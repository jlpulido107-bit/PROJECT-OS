import { cellText } from '../parse'
import { MAX_DATA_ROWS } from '../schema'
import { nombreClave, pareceContacto } from './pipeline-formularios'
import { parsearFilasGemini, type Borrador, type ContextoPegado, type FilaCruda } from './pipeline-pegado'

/**
 * Bandeja de Gemini (ORD-POS-155, POS-056; DEC-POS-031, enmienda de DEC-POS-030; docs/diseno-eco-pipeline.md §18).
 * Gemini propone proveedores y cotizaciones en la pestaña PIPE_BANDEJA_GEMINI del libro de RADAROS; solo el propietario
 * las confirma o las rechaza en Compras > Bandeja. Este módulo es puro y sin red: lee las filas, marca las que no se
 * pueden confirmar (datos personales o fórmulas) y arma los borradores con el mismo intérprete de «Recibir varias». La
 * escritura va por el servicio del pipeline (pipeline-escritura-service.ts), que en esta pestaña solo escribe
 * ESTADO_BANDEJA, RESULTADO_ID y NOTAS y nunca agrega ni borra filas.
 */

/** Bandera del propietario: solo `ECO_BANDEJA_GEMINI=true` exacto, que pone únicamente el propietario con deploy.sh. */
export function ecoBandejaGeminiHabilitada(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ECO_BANDEJA_GEMINI === 'true'
}

export const PESTANA_BANDEJA = 'PIPE_BANDEJA_GEMINI' as const

/** Control de la fila: ID, cuándo se capturó, tipo de propuesta, producto y proveedor (empresa). */
export const COLUMNAS_BANDEJA_CONTROL = ['BANDEJA_ID', 'FECHA_CAPTURA', 'TIPO', 'PRODUCTO_ID', 'PROVEEDOR'] as const
/**
 * Las columnas de la tabla B del Gem 3 (pipeline-pegado.ts, `COLUMNAS_TABLA_B`) en el orden de PIPE_COTIZACIONES (§3.3 y
 * §14.1). No van `COTIZACION_ID` (el ID lo pone la hoja), `PRD / EC` ni `PROVEEDOR (empresa)` (son `PRODUCTO_ID` y
 * `PROVEEDOR` del control) ni `NOTAS` (es la del estado, al final).
 */
export const COLUMNAS_BANDEJA_TABLA_B = [
  'ESTADO', 'FECHA_RECIBIDA', 'PRECIO_UNIT', 'MONEDA', 'MOQ', 'PLAZO_PRODUCCION_DIAS', 'INCOTERM', 'COSTO_ATERRIZADO_MXN',
  'MUESTRA_COSTO', 'MUESTRA_MONEDA', 'PAIS_ORIGEN', 'CERTIFICADO_ORIGEN', 'UNIDADES_POR_SET', 'FLETE_INTERNACIONAL', 'IGI_PCT',
] as const
/** Trazabilidad: versión del Gem que produjo la fila (texto) y la liga de Drive con la evidencia. */
export const COLUMNAS_BANDEJA_TRAZA = ['VERSION', 'EVIDENCIA_URL'] as const
/** Estado: las únicas tres columnas que escribe el dashboard. */
export const COLUMNAS_BANDEJA_ESTADO = ['ESTADO_BANDEJA', 'RESULTADO_ID', 'NOTAS'] as const

/** Encabezado completo de la migración (§18.1), en este orden. */
export const COLUMNAS_BANDEJA = [
  ...COLUMNAS_BANDEJA_CONTROL, ...COLUMNAS_BANDEJA_TABLA_B, ...COLUMNAS_BANDEJA_TRAZA, ...COLUMNAS_BANDEJA_ESTADO,
] as const

/** Criterio 3: lo único que el dashboard escribe en la bandeja. Cualquier otra columna es un error de programación. */
export const COLUMNAS_BANDEJA_ESCRIBIBLES: readonly string[] = COLUMNAS_BANDEJA_ESTADO

export const TIPOS_BANDEJA = ['PROVEEDOR', 'COTIZACION'] as const
export type TipoBandeja = (typeof TIPOS_BANDEJA)[number]
export const ESTADOS_BANDEJA = ['PENDIENTE', 'CONFIRMADA', 'RECHAZADA'] as const
export type EstadoBandeja = (typeof ESTADOS_BANDEJA)[number]

/** ID estable de la fila, lo pone quien la captura (Gemini o el propietario): `BAN-NNNN`, único en la pestaña. */
export const BANDEJA_ID = /^BAN-\d{4,}$/
export const RESULTADO = /^(PRV|COT)-\d{4,}$/

/* ------------------------------------------ Migración ------------------------------------------ */

export interface MigracionBandeja {
  /** La pestaña no existe: se crea con el encabezado completo. */
  crearPestana: boolean
  /** Columnas que faltan, en el orden en que se agregan al final. Vacía = migración aplicada. */
  faltan: string[]
  /** Encabezado resultante: el actual más las que faltan, al final. */
  encabezado: string[]
  /** Encabezados repetidos: la migración no se aplica sobre una fila 1 así (se corrige a mano primero). */
  repetidos: string[]
}

/**
 * Plan de la migración explícita de PIPE_BANDEJA_GEMINI (criterio 1, §18.1). Idempotente: aplicada sobre su propio
 * resultado no agrega nada. Sin pestaña (`null`), el encabezado completo; con ella, solo agrega al final las que faltan,
 * nunca reordena, renombra ni borra. La aplica el propietario a mano; ningún agente ni el dashboard crean la pestaña.
 */
export function migracionBandeja(encabezado: readonly (string | null)[] | null): MigracionBandeja {
  if (encabezado === null) return { crearPestana: true, faltan: [...COLUMNAS_BANDEJA], encabezado: [...COLUMNAS_BANDEJA], repetidos: [] }
  const actual = encabezado.map((h) => (h ?? '').trim())
  const vistos = new Set<string>()
  const repetidos = new Set<string>()
  for (const h of actual) {
    if (!h) continue
    if (vistos.has(h)) repetidos.add(h)
    vistos.add(h)
  }
  const faltan = COLUMNAS_BANDEJA.filter((c) => !vistos.has(c))
  let fin = actual.length
  while (fin > 0 && !actual[fin - 1]) fin--
  return { crearPestana: false, faltan, encabezado: [...actual.slice(0, fin), ...faltan], repetidos: [...repetidos] }
}

/* ------------------------------------- Celdas bloqueadas ------------------------------------- */

const FECHA = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/
const LIGA_DRIVE = /^https:\/\/(drive|docs)\.google\.com\/[^\s"'<>@]{1,270}$/

/** Una celda leída con valueRenderOption=FORMULA es fórmula si su texto empieza por «=». */
export function esFormula(v: unknown): boolean {
  return typeof v === 'string' && v.trim().startsWith('=')
}

/**
 * Criterio 4: correo electrónico o teléfono (10 dígitos o más, `pareceContacto`) en la celda. Una fecha o una liga de
 * Drive no cuentan como teléfono por sus dígitos; un correo dentro de una liga sí cuenta.
 */
export function celdaConContacto(v: unknown): boolean {
  const t = cellText(v)
  if (t === null) return false
  if (FECHA.test(t)) return false
  if (LIGA_DRIVE.test(t)) return false
  return pareceContacto(t)
}

/* ------------------------------------------ Lectura ------------------------------------------ */

export interface FilaBandeja {
  /** Fila de la hoja (1 = encabezado). */
  fila: number
  id: string | null
  tipo: TipoBandeja | null
  tipoTexto: string | null
  estado: EstadoBandeja | null
  estadoTexto: string | null
  /** Valores por columna, como texto; una celda bloqueada (fórmula o contacto) se deja vacía y nunca se muestra. */
  celdas: Record<string, string>
  /** EVIDENCIA_URL solo si es una liga https de Drive o Docs (se pinta como enlace); si no, null. */
  evidencia: string | null
  /** Motivos por los que la fila no se puede confirmar (se muestran; nunca llevan el valor de la celda). */
  bloqueos: string[]
}

export type BandejaVista =
  | { estado: 'apagada' }
  | { estado: 'ausente'; mensaje: string }
  | { estado: 'error'; mensaje: string }
  | { estado: 'columnas-faltantes'; faltan: string[]; repetidas: string[] }
  | { estado: 'ok'; filas: FilaBandeja[]; truncado: boolean; extra: string[] }

/** Columnas requeridas que faltan y encabezados repetidos de la fila 1 (los nombra el dashboard, criterio 5). */
export function revisarEncabezado(header: readonly (string | null)[], requeridas: readonly string[]): { faltan: string[]; repetidas: string[]; indice: Map<string, number> } {
  const indice = new Map<string, number>()
  const repetidas = new Set<string>()
  header.forEach((h, i) => {
    const t = (h ?? '').trim()
    if (!t) return
    if (indice.has(t)) repetidas.add(t)
    else indice.set(t, i)
  })
  return { faltan: requeridas.filter((c) => !indice.has(c)), repetidas: [...repetidas].filter((c) => requeridas.includes(c)), indice }
}

/**
 * Lee la pestaña (leída con valueRenderOption=FORMULA, para ver las fórmulas). `undefined`: la pestaña no existe. Columnas
 * por nombre; las que el propietario agregue al final se aceptan (no se interpretan, pero sí se revisan por fórmulas y
 * datos personales). Marca: ID ausente, no válido o repetido; TIPO o ESTADO_BANDEJA fuera de su lista; celdas con fórmula
 * o con correo o teléfono.
 */
export function leerBandeja(rows: unknown[][] | undefined): BandejaVista {
  if (rows === undefined) {
    return { estado: 'ausente', mensaje: `${PESTANA_BANDEJA}: pestaña sin crear (la crea el propietario con la migración, diseño /eco pipeline §18.1).` }
  }
  const header = (rows[0] ?? []).map((h) => cellText(h))
  const { faltan, repetidas, indice } = revisarEncabezado(header, COLUMNAS_BANDEJA)
  if (faltan.length || repetidas.length) return { estado: 'columnas-faltantes', faltan, repetidas }
  const extra = header.flatMap((h) => (h && !(COLUMNAS_BANDEJA as readonly string[]).includes(h) ? [h] : []))
  const truncado = rows.length > MAX_DATA_ROWS + 1
  const filas: FilaBandeja[] = []
  const ids = new Map<string, number>()
  rows.slice(1, MAX_DATA_ROWS + 1).forEach((row, i) => {
    if (!row.some((v) => cellText(v) !== null)) return
    const celdas: Record<string, string> = {}
    const bloqueos: string[] = []
    row.forEach((v, j) => {
      const col = header[j] || `columna ${j + 1}`
      if (esFormula(v)) bloqueos.push(`${col}: fórmula (solo valores escritos)`)
      else if (celdaConContacto(v)) bloqueos.push(`${col}: parece correo o teléfono (sin datos personales)`)
    })
    for (const c of COLUMNAS_BANDEJA) {
      const v = row[indice.get(c)!]
      celdas[c] = esFormula(v) || celdaConContacto(v) ? '' : cellText(v) ?? ''
    }
    const id = celdas.BANDEJA_ID || null
    if (!id) bloqueos.push('BANDEJA_ID vacío')
    else if (!BANDEJA_ID.test(id)) bloqueos.push('BANDEJA_ID no es BAN-NNNN')
    const tipoTexto = celdas.TIPO || null
    const tipo = TIPOS_BANDEJA.find((t) => t === (tipoTexto ?? '').toUpperCase()) ?? null
    if (!tipo) bloqueos.push('TIPO debe ser PROVEEDOR o COTIZACION')
    const estadoTexto = celdas.ESTADO_BANDEJA || null
    const estado = ESTADOS_BANDEJA.find((e) => e === (estadoTexto ?? '').toUpperCase()) ?? null
    const evidencia = LIGA_DRIVE.test(celdas.EVIDENCIA_URL ?? '') ? celdas.EVIDENCIA_URL! : null
    filas.push({ fila: i + 2, id, tipo, tipoTexto, estado, estadoTexto, celdas, evidencia, bloqueos })
    if (id) ids.set(id, (ids.get(id) ?? 0) + 1)
  })
  for (const f of filas) if (f.id && (ids.get(f.id) ?? 0) > 1) f.bloqueos.push('BANDEJA_ID repetido en la pestaña')
  return { estado: 'ok', filas, truncado, extra }
}

/* ------------------------------------------ Borradores ------------------------------------------ */

/** Encabezado de la tabla B que entiende el intérprete del pegado, con sus columnas de la bandeja. */
const ENCABEZADO_TABLA_B: ReadonlyArray<[columna: string, encabezado: string]> = [
  ['PRODUCTO_ID', 'PRD / EC'], ['PROVEEDOR', 'PROVEEDOR (empresa)'],
  ...COLUMNAS_BANDEJA_TABLA_B.map((c): [string, string] => [c, c]),
  ['EVIDENCIA_URL', 'EVIDENCIA_URL'], ['NOTAS', 'NOTAS'],
]

export interface PropuestaProveedor {
  /** Nombre comercial propuesto (columna PROVEEDOR). */
  nombre: string
  /** PAIS_ORIGEN de la fila si es un código de 2 letras. */
  pais: string
  notas: string
  /** Proveedor que ya existe con ese nombre (misma comparación de §15.1): confirmar lo liga, no lo duplica. */
  existente: string | null
  errores: Record<string, string>
}

export type PropuestaBandeja =
  | { tipo: 'COTIZACION'; fila: FilaBandeja; borrador: Borrador }
  | { tipo: 'PROVEEDOR'; fila: FilaBandeja; proveedor: PropuestaProveedor }
  | { tipo: null; fila: FilaBandeja }

export interface BandejaPropuestas {
  pendientes: PropuestaBandeja[]
  /** Conteo de las que ya no se muestran. */
  confirmadas: number
  rechazadas: number
  /** ESTADO_BANDEJA vacío o fuera de la lista: no se muestran ni se confirman. */
  otras: number
}

/**
 * Las filas PENDIENTE con su borrador. Las COTIZACION pasan por `parsearFilasGemini`, el mismo intérprete y los mismos
 * chequeos de «Recibir varias» (producto y proveedor de la hoja, listas y formatos, requisitos de RECIBIDA, correos o
 * teléfonos y duplicados contra la hoja y contra las filas anteriores de la bandeja).
 */
export function propuestasBandeja(vista: Extract<BandejaVista, { estado: 'ok' }>, ctx: ContextoPegado): BandejaPropuestas {
  const pendientes = vista.filas.filter((f) => f.estado === 'PENDIENTE')
  const cotizaciones = pendientes.filter((f) => f.tipo === 'COTIZACION')
  const crudas: FilaCruda[] = cotizaciones.map((f) => ({
    linea: f.fila,
    crudo: `Fila ${f.fila} de ${PESTANA_BANDEJA}`,
    celdas: ENCABEZADO_TABLA_B.map(([c]) => f.celdas[c] ?? ''),
  }))
  const r = parsearFilasGemini(ENCABEZADO_TABLA_B.map(([, h]) => h), crudas, ctx)
  const porFila = new Map(r.borradores.map((b) => [b.linea, b]))
  const out: PropuestaBandeja[] = pendientes.map((f) => {
    if (f.tipo === 'COTIZACION') {
      const borrador = porFila.get(f.fila)
      return borrador ? { tipo: 'COTIZACION', fila: f, borrador } : { tipo: null, fila: f }
    }
    if (f.tipo === 'PROVEEDOR') return { tipo: 'PROVEEDOR', fila: f, proveedor: propuestaProveedor(f, ctx) }
    return { tipo: null, fila: f }
  })
  return {
    pendientes: out,
    confirmadas: vista.filas.filter((f) => f.estado === 'CONFIRMADA').length,
    rechazadas: vista.filas.filter((f) => f.estado === 'RECHAZADA').length,
    otras: vista.filas.filter((f) => f.estado === null).length,
  }
}

function propuestaProveedor(f: FilaBandeja, ctx: ContextoPegado): PropuestaProveedor {
  const nombre = f.celdas.PROVEEDOR ?? ''
  const pais = (f.celdas.PAIS_ORIGEN ?? '').toUpperCase()
  const errores: Record<string, string> = {}
  if (!nombre) errores.nombre = 'PROVEEDOR vacío: la fila no dice qué empresa es.'
  else if (nombre.length > 120) errores.nombre = 'Hasta 120 caracteres.'
  else if (/^[=+\-@]/.test(nombre)) errores.nombre = 'No puede empezar por =, +, - ni @.'
  const clave = nombreClave(nombre)
  const existente = clave ? ctx.proveedores.find((p) => nombreClave(p.nombre) === clave)?.id ?? null : null
  return { nombre, pais: /^[A-Z]{2}$/.test(pais) ? pais : '', notas: f.celdas.NOTAS ?? '', existente, errores }
}

/** Una propuesta se puede confirmar si su fila no tiene bloqueos y su borrador no tiene errores ni es duplicada. */
export function confirmableBandeja(p: PropuestaBandeja): boolean {
  if (p.tipo === null || p.fila.bloqueos.length || !p.fila.id) return false
  if (p.tipo === 'PROVEEDOR') return Object.keys(p.proveedor.errores).length === 0
  return p.borrador.reconocida && p.borrador.duplicada === null && Object.keys(p.borrador.errores).length === 0
}

/** NOTAS de la bandeja con el motivo del rechazo al final (una línea; nunca borra lo que ya había). */
export function notasRechazo(previas: string, motivo: string): string {
  const linea = `Rechazada: ${motivo.replace(/\s+/g, ' ').trim()}`
  return previas.trim() ? `${previas.trim()}\n${linea}` : linea
}
