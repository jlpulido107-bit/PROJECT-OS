import { parseCivilDate } from '../dates'
import { OperationError } from '../operations/errors'
import { cleanText, neutralizeFormula } from '../operations/sanitize'
import { ETAPAS, type Etapa } from './pipeline'
import type { Celda } from './pipeline-escritura-store'

/**
 * Validación de los cuerpos de escritura del pipeline (ORD-POS-102, docs/diseno-eco-pipeline.md §3 y §4.3). Pura: no
 * lee la hoja; lo que depende de ella (referencias, unicidad, transiciones, fechas contra otras columnas) lo revisa el
 * servicio. Cada operación tiene su lista cerrada de campos: uno desconocido es 400 `campo-no-permitido`, nunca se
 * ignora. Las claves del cuerpo van en camelCase y cada una corresponde a una columna de §3.
 */

export const CANALES = ['ALIBABA', '1688', 'MADE_IN_CHINA', 'NACIONAL', 'OTRO'] as const
export const ESTADOS_PROVEEDOR = ['ACTIVO', 'INACTIVO'] as const
export const ESTADOS_COTIZACION = ['SOLICITADA', 'RECIBIDA', 'ELEGIDA', 'RECHAZADA'] as const
export const MONEDAS = ['USD', 'CNY', 'MXN'] as const
export const INCOTERMS = ['EXW', 'FOB', 'CIF', 'DDP', 'OTRO'] as const
export const ESTADOS_MUESTRA = ['NO_PEDIDA', 'PEDIDA', 'RECIBIDA', 'APROBADA', 'RECHAZADA'] as const
export const ESTADOS_EMBARQUE = ['PLANEADO', 'PAGADO', 'EN_TRANSITO', 'RECIBIDO_FBA', 'CANCELADO'] as const

type Tipo =
  | { k: 'texto'; max: number; multilinea?: boolean }
  | { k: 'contacto' }
  | { k: 'asin' }
  | { k: 'idea' }
  | { k: 'fecha' }
  | { k: 'numero' }
  | { k: 'entero'; min: number }
  | { k: 'lista'; valores: readonly string[] }
  | { k: 'id'; prefijo: 'PRD' | 'PRV' | 'COT' | 'EMB' }
  | { k: 'pais' }

interface Campo {
  clave: string
  columna: string
  tipo: Tipo
  /** Obligatorio en el alta y no se puede vaciar al editar. */
  obligatorio?: boolean
}

const texto = (clave: string, columna: string, max: number, obligatorio = false, multilinea = false): Campo => ({ clave, columna, tipo: { k: 'texto', max, multilinea }, obligatorio })
const fecha = (clave: string, columna: string): Campo => ({ clave, columna, tipo: { k: 'fecha' } })
const numero = (clave: string, columna: string): Campo => ({ clave, columna, tipo: { k: 'numero' } })
const entero = (clave: string, columna: string, min: number, obligatorio = false): Campo => ({ clave, columna, tipo: { k: 'entero', min }, obligatorio })
const lista = (clave: string, columna: string, valores: readonly string[], obligatorio = false): Campo => ({ clave, columna, tipo: { k: 'lista', valores }, obligatorio })
const id = (clave: string, columna: string, prefijo: 'PRD' | 'PRV' | 'COT' | 'EMB', obligatorio = false): Campo => ({ clave, columna, tipo: { k: 'id', prefijo }, obligatorio })
const notas = texto('notas', 'NOTAS', 1000, false, true)

const K = ['K1', 'K2', 'K3', 'K4', 'K5', 'K6'].map((c) => texto(c.toLowerCase(), c, 40))

/** §3.1: editables del producto (nunca `ETAPA`, `ORIGEN` ni la foto de Keepa). */
const PRODUCTO_EDITABLES: Campo[] = [
  texto('nombre', 'NOMBRE', 120, true),
  { clave: 'asin', columna: 'ASIN', tipo: { k: 'asin' } },
  { clave: 'ideaId', columna: 'IDEA_ID', tipo: { k: 'idea' } },
  numero('costoMaxMxn', 'COSTO_MAX_MXN'),
  ...K,
  id('proveedorElegidoId', 'PROVEEDOR_ELEGIDO_ID', 'PRV'),
  notas,
]
/** La foto de Keepa solo entra en el alta (§3.1). */
const KEEPA: Campo[] = [
  fecha('keepaFecha', 'KEEPA_FECHA'),
  numero('keepaPrecioMxnAvg90', 'KEEPA_PRECIO_MXN_AVG90'),
  entero('keepaBsrAvg90', 'KEEPA_BSR_AVG90', 0),
  entero('keepaVentasMes', 'KEEPA_VENTAS_MES', 0),
  entero('keepaOfertas', 'KEEPA_OFERTAS', 0),
]

const PROVEEDOR: Campo[] = [
  texto('nombre', 'NOMBRE', 120, true),
  lista('canal', 'CANAL', CANALES, true),
  { clave: 'pais', columna: 'PAIS', tipo: { k: 'pais' }, obligatorio: true },
  { clave: 'contacto', columna: 'CONTACTO', tipo: { k: 'contacto' } },
  notas,
]

const COTIZACION_COMUNES: Campo[] = [
  fecha('fechaSolicitud', 'FECHA_SOLICITUD'),
  fecha('fechaRespuestaEsperada', 'FECHA_RESPUESTA_ESPERADA'),
  numero('precioUnit', 'PRECIO_UNIT'),
  lista('moneda', 'MONEDA', MONEDAS),
  entero('moq', 'MOQ', 1),
  entero('plazoProduccionDias', 'PLAZO_PRODUCCION_DIAS', 0),
  lista('incoterm', 'INCOTERM', INCOTERMS),
  numero('costoAterrizadoMxn', 'COSTO_ATERRIZADO_MXN'),
  lista('muestraEstado', 'MUESTRA_ESTADO', ESTADOS_MUESTRA),
  fecha('muestraFechaPedido', 'MUESTRA_FECHA_PEDIDO'),
  fecha('muestraFechaEsperada', 'MUESTRA_FECHA_ESPERADA'),
  numero('muestraCosto', 'MUESTRA_COSTO'),
  lista('muestraMoneda', 'MUESTRA_MONEDA', MONEDAS),
  notas,
]

const EMBARQUE_COMUNES: Campo[] = [
  entero('unidades', 'UNIDADES', 1, true),
  fecha('fechaPago', 'FECHA_PAGO'),
  fecha('fechaSalida', 'FECHA_SALIDA'),
  fecha('fechaLlegadaEsperada', 'FECHA_LLEGADA_ESPERADA'),
  numero('costoTotal', 'COSTO_TOTAL'),
  lista('moneda', 'MONEDA', MONEDAS),
  notas,
]

/** Campos de cada operación de alta o edición (§4.1). */
export const CAMPOS = {
  'eco.producto.crear': [...PRODUCTO_EDITABLES, ...KEEPA],
  'eco.producto.editar': PRODUCTO_EDITABLES,
  'eco.proveedor.crear': PROVEEDOR,
  'eco.proveedor.editar': [...PROVEEDOR, lista('estado', 'ESTADO', ESTADOS_PROVEEDOR, true)],
  'eco.cotizacion.crear': [id('productoId', 'PRODUCTO_ID', 'PRD', true), id('proveedorId', 'PROVEEDOR_ID', 'PRV', true), ...COTIZACION_COMUNES],
  'eco.cotizacion.editar': [
    lista('estado', 'ESTADO', ESTADOS_COTIZACION, true), fecha('fechaRecibida', 'FECHA_RECIBIDA'),
    fecha('muestraFechaRecibida', 'MUESTRA_FECHA_RECIBIDA'), ...COTIZACION_COMUNES,
  ],
  'eco.embarque.crear': [id('productoId', 'PRODUCTO_ID', 'PRD', true), id('cotizacionId', 'COTIZACION_ID', 'COT', true), ...EMBARQUE_COMUNES],
  'eco.embarque.editar': [lista('estado', 'ESTADO', ESTADOS_EMBARQUE, true), fecha('fechaLlegada', 'FECHA_LLEGADA'), ...EMBARQUE_COMUNES],
} as const satisfies Record<string, readonly Campo[]>

export type EcoCampoOperacion = keyof typeof CAMPOS

/** Columnas que se escriben como número (el resto, texto en RAW). */
export const COLUMNAS_NUMERICAS: ReadonlySet<string> = new Set(
  [...Object.values(CAMPOS).flat().filter((c) => c.tipo.k === 'numero' || c.tipo.k === 'entero').map((c) => c.columna), 'VERSION'],
)

const REQUEST_ID = /^[0-9a-f-]{36}$/
const ASIN = /^[A-Z0-9]{10}$/
// atajo: §3.1 pide que IDEA_ID exista en PRODUCTS, pero el servicio de escritura no lee pestañas fuera de PIPE_* (§6.2)
// y la columna de PRODUCTS es ❓; aquí solo se valida el formato de las ideas de RADAROS (EC-004). Mejorarlo cuando la
// activación confirme la columna: pasar la lista de ideas desde la lectura de /eco.
const IDEA = /^[A-Z]{2,4}-\d{3,4}$/
const PAIS = /^[A-Z]{2}$/
const DECIMAL = /^\d{1,10}(\.\d{1,2})?$/
const ENTERO = /^\d{1,9}$/
/** §4.3: texto que empieza por = + - @ se rechaza (se escribiría en una hoja con fórmulas). */
const FORMULA_START = /^[=+\-@]/

export function idValido(prefijo: string, valor: string): boolean {
  return new RegExp(`^${prefijo}-\\d{4,}$`).test(valor)
}

export interface EcoComando {
  requestId: string
  /** Solo en edición y en `mover`. */
  expectedVersion: number | null
  /** Columna → valor; `''` vacía la celda. En edición, solo las columnas que vinieron. */
  valores: Record<string, Celda>
}

export interface MoverComando {
  requestId: string
  expectedVersion: number
  expectedEtapa: Etapa
  etapa: Etapa
  motivo: string | null
}

type Fields = Record<string, string>

function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OperationError('validacion', { fields: { cuerpo: 'Se esperaba un objeto JSON.' } })
  return body as Record<string, unknown>
}

function permitidos(body: Record<string, unknown>, claves: readonly string[]) {
  const sobran = Object.keys(body).filter((k) => !claves.includes(k))
  if (sobran.length) throw new OperationError('campo-no-permitido', { fields: Object.fromEntries(sobran.slice(0, 20).map((k) => [k.slice(0, 40), 'Campo no admitido.'])) })
}

function requestId(body: Record<string, unknown>, fields: Fields): string {
  const v = typeof body.requestId === 'string' ? body.requestId : ''
  if (!REQUEST_ID.test(v)) fields.requestId = 'requestId no válido; recarga el formulario.'
  return v
}

function version(body: Record<string, unknown>, fields: Fields): number {
  const v = body.expectedVersion
  const n = typeof v === 'number' ? v : typeof v === 'string' && ENTERO.test(v.trim()) ? Number(v) : NaN
  if (!Number.isInteger(n) || n < 1) fields.expectedVersion = 'expectedVersion entero ≥ 1.'
  return n
}

/** Texto limpio de una línea (o multilínea en NOTAS), sin inicio de fórmula. */
function textoLimpio(raw: string, max: number, multilinea: boolean, fields: Fields, clave: string): string {
  const t = cleanText(raw, multilinea)
  if (t.length > max) fields[clave] = `Hasta ${max} caracteres.`
  else if (FORMULA_START.test(t)) fields[clave] = 'No puede empezar por =, +, - ni @.'
  return t
}

/** Valor de un campo; `''` = vacío. Devuelve null y marca el error si no vale. */
function valorCampo(c: Campo, raw: unknown, fields: Fields): Celda | null {
  if (raw === null || raw === undefined) return ''
  if (typeof raw === 'number' && !Number.isFinite(raw)) {
    fields[c.clave] = 'Número no válido.'
    return null
  }
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    fields[c.clave] = 'Se esperaba texto o número.'
    return null
  }
  const s = String(raw).trim()
  if (s === '') return ''
  const t = c.tipo
  const antes = Object.keys(fields).length
  let out: Celda = s
  switch (t.k) {
    case 'texto':
      out = textoLimpio(s, t.max, t.multilinea ?? false, fields, c.clave)
      break
    case 'contacto': {
      // ORD-POS-102 (hallazgo de revisión): un teléfono como «+52 …» es válido. Se acepta un «+» inicial y se
      // neutraliza con apóstrofo (además de escribir en RAW); =, - y @ iniciales siguen rechazados.
      const limpio = cleanText(s, false)
      if (limpio.length > 200) fields[c.clave] = 'Hasta 200 caracteres.'
      else if (/^[=\-@]/.test(limpio)) fields[c.clave] = 'No puede empezar por =, - ni @.'
      out = neutralizeFormula(limpio)
      break
    }
    case 'asin':
      if (!ASIN.test(s)) fields[c.clave] = '10 caracteres A-Z y 0-9.'
      break
    case 'idea':
      if (!IDEA.test(s)) fields[c.clave] = 'ID de idea de RADAROS (p. ej. EC-004).'
      break
    case 'pais':
      if (!PAIS.test(s)) fields[c.clave] = 'Código ISO 3166-1 alfa-2 en mayúsculas (p. ej. CN).'
      break
    case 'fecha':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || parseCivilDate(s).value === null) fields[c.clave] = 'Fecha AAAA-MM-DD válida.'
      break
    case 'numero':
      if (!DECIMAL.test(s)) fields[c.clave] = 'Número ≥ 0 con hasta 2 decimales.'
      else out = Number(s)
      break
    case 'entero':
      if (!ENTERO.test(s) || Number(s) < t.min) fields[c.clave] = `Entero ≥ ${t.min}.`
      else out = Number(s)
      break
    case 'lista':
      if (!t.valores.includes(s)) fields[c.clave] = `Uno de: ${t.valores.join(', ')}.`
      break
    case 'id':
      if (!idValido(t.prefijo, s)) fields[c.clave] = `${t.prefijo}-NNNN.`
      break
  }
  return Object.keys(fields).length > antes ? null : out
}

/** Cuerpo de un alta (`crear`) o de una edición (`editar`) con su lista cerrada de campos. */
export function parseEco(op: EcoCampoOperacion, input: unknown): EcoComando {
  const body = asObject(input)
  const campos: readonly Campo[] = CAMPOS[op]
  const editar = op.endsWith('.editar')
  permitidos(body, ['requestId', ...(editar ? ['expectedVersion'] : []), ...campos.map((c) => c.clave)])
  const fields: Fields = {}
  const rid = requestId(body, fields)
  const expectedVersion = editar ? version(body, fields) : null
  const valores: Record<string, Celda> = {}
  for (const c of campos) {
    if (editar && !(c.clave in body)) continue
    const v = valorCampo(c, body[c.clave], fields)
    if (v === null) continue
    if (v === '' && c.obligatorio) {
      fields[c.clave] = editar ? 'No se puede vaciar.' : 'Obligatorio.'
      continue
    }
    valores[c.columna] = v
  }
  if (editar && !Object.keys(valores).length && !Object.keys(fields).length) throw new OperationError('sin-cambios')
  if (Object.keys(fields).length) throw new OperationError('validacion', { fields })
  return { requestId: rid, expectedVersion, valores }
}

/** Cuerpo de `eco.producto.mover` (§5.1). */
export function parseMover(input: unknown): MoverComando {
  const body = asObject(input)
  permitidos(body, ['requestId', 'expectedVersion', 'expectedEtapa', 'etapa', 'motivo'])
  const fields: Fields = {}
  const rid = requestId(body, fields)
  const expectedVersion = version(body, fields)
  const etapa = (k: 'etapa' | 'expectedEtapa'): Etapa => {
    const v = body[k]
    const e = ETAPAS.find((x) => x === v)
    if (!e) fields[k] = `Una de: ${ETAPAS.join(', ')}.`
    return e as Etapa
  }
  const expectedEtapa = etapa('expectedEtapa')
  const destino = etapa('etapa')
  let motivo: string | null = null
  if (body.motivo !== undefined && body.motivo !== null) {
    if (typeof body.motivo !== 'string') fields.motivo = 'Se esperaba texto.'
    else {
      const t = textoLimpio(body.motivo, 300, false, fields, 'motivo')
      motivo = t === '' ? null : t
    }
  }
  if (Object.keys(fields).length) throw new OperationError('validacion', { fields })
  return { requestId: rid, expectedVersion, expectedEtapa, etapa: destino, motivo }
}

/** ID de la ruta (`/productos/<PRODUCTO_ID>`); uno mal formado es 404, como uno inexistente. */
export function parseIdRuta(prefijo: 'PRD' | 'PRV' | 'COT' | 'EMB', raw: string): string {
  let v: string
  try {
    v = decodeURIComponent(raw)
  } catch {
    throw new OperationError('registro-inexistente')
  }
  if (!idValido(prefijo, v)) throw new OperationError('registro-inexistente')
  return v
}
