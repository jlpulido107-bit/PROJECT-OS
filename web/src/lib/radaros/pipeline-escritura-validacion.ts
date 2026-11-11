import { parseCivilDate } from '../dates'
import { OperationError } from '../operations/errors'
import { cleanText, safeCellText } from '../operations/sanitize'
import { COLUMNAS_MIGRACION_PROVEEDORES, ESTADOS_COTIZACION, ETAPAS, type Etapa } from './pipeline'
import { pareceContacto } from './pipeline-formularios'
import { COLUMNAS_MIGRACION_COTIZACIONES, PRECIOS_POR } from './pipeline-tabulador'
import type { Celda } from './pipeline-escritura-store'

/**
 * Validación de los cuerpos de escritura del pipeline (ORD-POS-102, docs/diseno-eco-pipeline.md §3 y §4.3). Pura: no
 * lee la hoja; lo que depende de ella (referencias, unicidad, transiciones, fechas contra otras columnas) lo revisa el
 * servicio. Cada operación tiene su lista cerrada de campos: uno desconocido es 400 `campo-no-permitido`, nunca se
 * ignora. Las claves del cuerpo van en camelCase y cada una corresponde a una columna de §3.
 */

export const CANALES = ['ALIBABA', '1688', 'MADE_IN_CHINA', 'NACIONAL', 'OTRO'] as const
export const ESTADOS_PROVEEDOR = ['ACTIVO', 'INACTIVO'] as const
/** ORD-POS-146 (criterio 4): una sola lista, definida en pipeline.ts y compartida con el tabulador. */
export { ESTADOS_COTIZACION }
/** Estados con los que puede nacer una cotización (ORD-POS-146): `ELEGIDA` solo por edición, con sus requisitos. */
export const ESTADOS_ALTA_COTIZACION = ['SOLICITADA', 'RECIBIDA', 'RECHAZADA'] as const
export const MONEDAS = ['USD', 'CNY', 'MXN'] as const
/** ORD-POS-146: los del tabulador (§14.3) más `OTRO`, que el tabulador deja «Por confirmar». */
export const INCOTERMS = ['EXW', 'FCA', 'FOB', 'CIF', 'DAP', 'DDP', 'OTRO'] as const
export const SI_NO = ['SI', 'NO'] as const
export const ESTADOS_MUESTRA = ['NO_PEDIDA', 'PEDIDA', 'RECIBIDA', 'APROBADA', 'RECHAZADA'] as const
export const ESTADOS_EMBARQUE = ['PLANEADO', 'PAGADO', 'EN_TRANSITO', 'RECIBIDO_FBA', 'CANCELADO'] as const

type Tipo =
  | { k: 'texto'; max: number; multilinea?: boolean; sinContacto?: boolean }
  | { k: 'contacto' }
  | { k: 'asin' }
  | { k: 'idea' }
  | { k: 'fecha' }
  | { k: 'numero'; decimales: 2 | 4 }
  | { k: 'entero'; min: number }
  | { k: 'lista'; valores: readonly string[] }
  | { k: 'id'; prefijo: 'PRD' | 'PRV' | 'COT' | 'EMB' }
  | { k: 'pais' }
  | { k: 'pct' }
  | { k: 'url' }

interface Campo {
  clave: string
  columna: string
  tipo: Tipo
  /** Obligatorio en el alta y no se puede vaciar al editar. */
  obligatorio?: boolean
  /** Texto del formulario en lugar del nombre de la columna (ORD-POS-147). */
  etiqueta?: string
}

const texto = (clave: string, columna: string, max: number, obligatorio = false, multilinea = false): Campo => ({ clave, columna, tipo: { k: 'texto', max, multilinea }, obligatorio })
const fecha = (clave: string, columna: string): Campo => ({ clave, columna, tipo: { k: 'fecha' } })
const numero = (clave: string, columna: string, decimales: 2 | 4 = 2): Campo => ({ clave, columna, tipo: { k: 'numero', decimales } })
/** ORD-POS-104 (H1): los montos por unidad o totales admiten hasta 4 decimales (p. ej. un precio unitario de 0.125). */
const monto = (clave: string, columna: string): Campo => numero(clave, columna, 4)
const entero = (clave: string, columna: string, min: number, obligatorio = false): Campo => ({ clave, columna, tipo: { k: 'entero', min }, obligatorio })
const lista = (clave: string, columna: string, valores: readonly string[], obligatorio = false): Campo => ({ clave, columna, tipo: { k: 'lista', valores }, obligatorio })
const id = (clave: string, columna: string, prefijo: 'PRD' | 'PRV' | 'COT' | 'EMB', obligatorio = false): Campo => ({ clave, columna, tipo: { k: 'id', prefijo }, obligatorio })
const notas = texto('notas', 'NOTAS', 1000, false, true)
/** ORD-POS-146 (criterio 1): en el alta rápida de proveedores no entran correos ni teléfonos de personas. */
const sinContacto = (c: Campo): Campo => (c.tipo.k === 'texto' ? { ...c, tipo: { ...c.tipo, sinContacto: true } } : c)
const pct = (clave: string, columna: string): Campo => ({ clave, columna, tipo: { k: 'pct' } })

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

/** §15.1 (ORD-POS-146): columnas de la migración de PIPE_PROVEEDORES. */
const PROVEEDOR_AUDITORIA: Campo[] = [
  entero('anosPlataforma', 'ANOS_PLATAFORMA', 0),
  lista('verifiedSupplier', 'VERIFIED_SUPPLIER', SI_NO),
  lista('tradeAssurance', 'TRADE_ASSURANCE', SI_NO),
]
/** Alta (ORD-POS-146, criterio 1): sin `CONTACTO` y sin correos ni teléfonos en el nombre o las notas. */
const PROVEEDOR_ALTA: Campo[] = [
  sinContacto(texto('nombre', 'NOMBRE', 120, true)),
  lista('canal', 'CANAL', CANALES, true),
  { clave: 'pais', columna: 'PAIS', tipo: { k: 'pais' }, obligatorio: true },
  ...PROVEEDOR_AUDITORIA,
  sinContacto(notas),
]
/** Edición: la de ORD-POS-110 (con `CONTACTO` comercial, §6.4) más las columnas de la migración. */
const PROVEEDOR_EDICION: Campo[] = [
  sinContacto(texto('nombre', 'NOMBRE', 120, true)),
  lista('canal', 'CANAL', CANALES, true),
  { clave: 'pais', columna: 'PAIS', tipo: { k: 'pais' }, obligatorio: true },
  { clave: 'contacto', columna: 'CONTACTO', tipo: { k: 'contacto' } },
  ...PROVEEDOR_AUDITORIA,
  notas,
]

const COTIZACION_COMUNES: Campo[] = [
  fecha('fechaSolicitud', 'FECHA_SOLICITUD'),
  fecha('fechaRespuestaEsperada', 'FECHA_RESPUESTA_ESPERADA'),
  monto('precioUnit', 'PRECIO_UNIT'),
  lista('moneda', 'MONEDA', MONEDAS),
  entero('moq', 'MOQ', 1),
  entero('plazoProduccionDias', 'PLAZO_PRODUCCION_DIAS', 0),
  lista('incoterm', 'INCOTERM', INCOTERMS),
  monto('costoAterrizadoMxn', 'COSTO_ATERRIZADO_MXN'),
  lista('muestraEstado', 'MUESTRA_ESTADO', ESTADOS_MUESTRA),
  fecha('muestraFechaPedido', 'MUESTRA_FECHA_PEDIDO'),
  fecha('muestraFechaEsperada', 'MUESTRA_FECHA_ESPERADA'),
  monto('muestraCosto', 'MUESTRA_COSTO'),
  lista('muestraMoneda', 'MUESTRA_MONEDA', MONEDAS),
  notas,
]

/**
 * ORD-POS-146 (criterio 2): las columnas del tabulador (§14.1) en el alta, en el orden en que se capturan. No incluye
 * `COSTO_ATERRIZADO_CALC_MXN`: el dashboard nunca la escribe. La edición de cotizaciones no cambia (fuera de alcance).
 */
/** ORD-POS-147 (criterio 1): obligatorio en el alta; `PRECIO_UNIT`, `MOQ` y `CANTIDAD_COTIZADA` se leen en esa unidad. */
const PRECIO_POR_CAMPO: Campo = { ...lista('precioPor', 'PRECIO_POR', PRECIOS_POR, true), etiqueta: 'El precio es por' }

const COTIZACION_TABULADOR: Campo[] = [
  { clave: 'paisOrigen', columna: 'PAIS_ORIGEN', tipo: { k: 'pais' } },
  lista('certificadoOrigen', 'CERTIFICADO_ORIGEN', SI_NO),
  entero('unidadesPorSet', 'UNIDADES_POR_SET', 1),
  entero('cantidadCotizada', 'CANTIDAD_COTIZADA', 1),
  monto('tipoCambio', 'TIPO_CAMBIO'),
  fecha('tipoCambioFecha', 'TIPO_CAMBIO_FECHA'),
  monto('fleteLocalExport', 'FLETE_LOCAL_EXPORT'),
  monto('fleteInternacional', 'FLETE_INTERNACIONAL'),
  monto('seguro', 'SEGURO'),
  pct('igiPct', 'IGI_PCT'),
  pct('dta', 'DTA'),
  monto('agenteAduanal', 'AGENTE_ADUANAL'),
  monto('fleteCedis', 'FLETE_CEDIS'),
]

/**
 * ORD-POS-149 (criterio 7): liga de Drive con la evidencia de la cotización (no un correo ni un teléfono). Solo
 * `https://drive.google.com/…` o `https://docs.google.com/…`.
 */
const EVIDENCIA_URL: Campo = { clave: 'evidenciaUrl', columna: 'EVIDENCIA_URL', tipo: { k: 'url' }, etiqueta: 'Liga de Drive con la evidencia' }
/** ORD-POS-149: en la edición (paso «Recibir»), `PRECIO_POR` se puede fijar pero no es obligatorio (filas anteriores). */
const PRECIO_POR_EDICION: Campo = { ...PRECIO_POR_CAMPO, obligatorio: false }

const EMBARQUE_COMUNES: Campo[] = [
  entero('unidades', 'UNIDADES', 1, true),
  fecha('fechaPago', 'FECHA_PAGO'),
  fecha('fechaSalida', 'FECHA_SALIDA'),
  fecha('fechaLlegadaEsperada', 'FECHA_LLEGADA_ESPERADA'),
  monto('costoTotal', 'COSTO_TOTAL'),
  lista('moneda', 'MONEDA', MONEDAS),
  notas,
]

/** Campos de cada operación de alta o edición (§4.1). */
export const CAMPOS = {
  'eco.producto.crear': [...PRODUCTO_EDITABLES, ...KEEPA],
  'eco.producto.editar': PRODUCTO_EDITABLES,
  'eco.proveedor.crear': PROVEEDOR_ALTA,
  'eco.proveedor.editar': [...PROVEEDOR_EDICION, lista('estado', 'ESTADO', ESTADOS_PROVEEDOR, true)],
  'eco.cotizacion.crear': [
    id('productoId', 'PRODUCTO_ID', 'PRD', true), id('proveedorId', 'PROVEEDOR_ID', 'PRV', true),
    lista('estado', 'ESTADO', ESTADOS_ALTA_COTIZACION), fecha('fechaRecibida', 'FECHA_RECIBIDA'),
    PRECIO_POR_CAMPO, ...COTIZACION_COMUNES.slice(0, -1), ...COTIZACION_TABULADOR, notas,
  ],
  'eco.cotizacion.editar': [
    lista('estado', 'ESTADO', ESTADOS_COTIZACION, true), fecha('fechaRecibida', 'FECHA_RECIBIDA'),
    fecha('muestraFechaRecibida', 'MUESTRA_FECHA_RECIBIDA'), ...COTIZACION_COMUNES,
    // ORD-POS-149 (criterio 4): «Recibir» edita la misma fila con las columnas del tabulador y la evidencia.
    PRECIO_POR_EDICION, ...COTIZACION_TABULADOR, EVIDENCIA_URL,
  ],
  /** ORD-POS-149 (criterio 3): «Pedir» solo lleva producto y proveedor; estado y fechas los pone el servidor. */
  'eco.cotizacion.pedir': [id('productoId', 'PRODUCTO_ID', 'PRD', true), id('proveedorId', 'PROVEEDOR_ID', 'PRV', true)],
  'eco.embarque.crear': [id('productoId', 'PRODUCTO_ID', 'PRD', true), id('cotizacionId', 'COTIZACION_ID', 'COT', true), ...EMBARQUE_COMUNES],
  'eco.embarque.editar': [lista('estado', 'ESTADO', ESTADOS_EMBARQUE, true), fecha('fechaLlegada', 'FECHA_LLEGADA'), ...EMBARQUE_COMUNES],
  /**
   * ORD-POS-155 (§18.3): «Confirmar» de la bandeja de Gemini. Una fila COTIZACION lleva los campos del alta de cotización
   * más la evidencia; una fila PROVEEDOR, los del alta de proveedor. El servicio escribe con las mismas operaciones.
   */
  'eco.bandeja.cotizacion': [
    id('productoId', 'PRODUCTO_ID', 'PRD', true), id('proveedorId', 'PROVEEDOR_ID', 'PRV', true),
    lista('estado', 'ESTADO', ESTADOS_ALTA_COTIZACION), fecha('fechaRecibida', 'FECHA_RECIBIDA'),
    PRECIO_POR_CAMPO, ...COTIZACION_COMUNES.slice(0, -1), ...COTIZACION_TABULADOR, EVIDENCIA_URL, notas,
  ],
  'eco.bandeja.proveedor': PROVEEDOR_ALTA,
} as const satisfies Record<string, readonly Campo[]>

export type EcoCampoOperacion = keyof typeof CAMPOS

/**
 * Columnas de las migraciones (§14.1 y §15.1) que la escritura admite solo si la fila 1 ya las tiene: sin la migración
 * responde 409 `eco-migracion-pendiente` y no escribe nada. `COSTO_ATERRIZADO_CALC_MXN` no se escribe nunca.
 */
export const COLUMNAS_OPCIONALES = {
  PIPE_PROVEEDORES: [...COLUMNAS_MIGRACION_PROVEEDORES],
  PIPE_COTIZACIONES: COLUMNAS_MIGRACION_COTIZACIONES.filter((c) => c !== 'COSTO_ATERRIZADO_CALC_MXN'),
} as const

/** Columnas que se escriben como número (el resto, texto en RAW). */
export const COLUMNAS_NUMERICAS: ReadonlySet<string> = new Set(
  [...Object.values(CAMPOS).flat().filter((c) => c.tipo.k === 'numero' || c.tipo.k === 'entero' || c.tipo.k === 'pct').map((c) => c.columna), 'VERSION'],
)

const REQUEST_ID = /^[0-9a-f-]{36}$/
const ASIN = /^[A-Z0-9]{10}$/
// atajo: §3.1 pide que IDEA_ID exista en PRODUCTS, pero el servicio de escritura no lee pestañas fuera de PIPE_* (§6.2)
// y la columna de PRODUCTS es ❓; aquí solo se valida el formato de las ideas de RADAROS (EC-004). Mejorarlo cuando la
// activación confirme la columna: pasar la lista de ideas desde la lectura de /eco.
const IDEA = /^[A-Z]{2,4}-\d{3,4}$/
const PAIS = /^[A-Z]{2}$/
const DECIMAL = { 2: /^\d{1,10}(\.\d{1,2})?$/, 4: /^\d{1,10}(\.\d{1,4})?$/ } as const
const ENTERO = /^\d{1,9}$/
/** §4.3: texto que empieza por = + - @ se rechaza (se escribiría en una hoja con fórmulas). */
const FORMULA_START = /^[=+\-@]/
const PCT_PUNTOS = /^\d{1,3}(\.\d{1,4})?$/
/** ORD-POS-149: liga de Drive o Docs de Google, sin espacios, comillas ni «@» (nunca un correo); hasta 300 caracteres. */
export const MENSAJE_URL = 'Liga https://drive.google.com/… o https://docs.google.com/… (hasta 300 caracteres, sin correos).'
export const DRIVE_URL = /^https:\/\/(drive|docs)\.google\.com\/[^\s"'<>@]{1,270}$/

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

/**
 * Texto limpio de una línea (o multilínea en NOTAS), sin inicio de fórmula. Un inicio de fórmula se sigue rechazando
 * (sin cambio de política); lo que se escribe pasa además por safeCellText (SEC-01, ORD-POS-154), así un cambio futuro
 * del rechazo no deja pasar una fórmula: se neutraliza como en la API de operaciones.
 */
function textoLimpio(raw: string, max: number, multilinea: boolean, fields: Fields, clave: string): string {
  const t = cleanText(raw, multilinea)
  if (t.length > max) fields[clave] = `Hasta ${max} caracteres.`
  else if (FORMULA_START.test(t)) fields[clave] = 'No puede empezar por =, +, - ni @.'
  return safeCellText(raw, multilinea)
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
      if (!fields[c.clave] && t.sinContacto && pareceContacto(String(out))) fields[c.clave] = 'Sin correos ni teléfonos de personas.'
      break
    case 'pct':
      if (!PCT_PUNTOS.test(s) || Number(s) > 100) fields[c.clave] = 'Porcentaje en puntos de 0 a 100 (20 = 20 %), hasta 4 decimales.'
      else out = Number(s)
      break
    case 'contacto': {
      // ORD-POS-102 (hallazgo de revisión): un teléfono como «+52 …» es válido. Se acepta un «+» inicial tal cual:
      // RAW nunca lo evalúa y un apóstrofo quedaría visible (ORD-POS-104, H4); =, - y @ iniciales siguen rechazados.
      const limpio = cleanText(s, false)
      if (limpio.length > 200) fields[c.clave] = 'Hasta 200 caracteres.'
      else if (/^[=\-@]/.test(limpio)) fields[c.clave] = 'No puede empezar por =, - ni @.'
      out = limpio
      break
    }
    case 'asin':
      if (!ASIN.test(s)) fields[c.clave] = '10 caracteres A-Z y 0-9.'
      break
    case 'idea':
      if (!IDEA.test(s)) fields[c.clave] = 'ID de idea de RADAROS (p. ej. EC-004).'
      break
    case 'url':
      if (!DRIVE_URL.test(s)) fields[c.clave] = MENSAJE_URL
      break
    case 'pais':
      if (!PAIS.test(s)) fields[c.clave] = 'Código ISO 3166-1 alfa-2 en mayúsculas (p. ej. CN).'
      break
    case 'fecha':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || parseCivilDate(s).value === null) fields[c.clave] = 'Fecha AAAA-MM-DD válida.'
      break
    case 'numero':
      if (!DECIMAL[t.decimales].test(s)) fields[c.clave] = `Número ≥ 0 con hasta ${t.decimales} decimales.`
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

/** ORD-POS-155 (§18.3): cuerpo de «Confirmar» de la bandeja; `tipo` dice con qué campos se lee el resto. */
export interface BandejaConfirmar {
  tipo: 'PROVEEDOR' | 'COTIZACION'
  cmd: EcoComando
}

export function parseBandejaConfirmar(input: unknown): BandejaConfirmar {
  const body = asObject(input)
  const tipo = body.tipo
  if (tipo !== 'PROVEEDOR' && tipo !== 'COTIZACION') throw new OperationError('validacion', { fields: { tipo: 'Uno de: PROVEEDOR, COTIZACION.' } })
  const resto = { ...body }
  delete resto.tipo
  const cmd = parseEco(tipo === 'PROVEEDOR' ? 'eco.bandeja.proveedor' : 'eco.bandeja.cotizacion', resto)
  // Criterio 4: ningún texto confirmado lleva correos ni teléfonos (NOTAS de la cotización incluida).
  const fields: Fields = {}
  for (const c of CAMPOS[tipo === 'PROVEEDOR' ? 'eco.bandeja.proveedor' : 'eco.bandeja.cotizacion']) {
    const v = cmd.valores[c.columna]
    if (c.tipo.k === 'texto' && typeof v === 'string' && pareceContacto(v)) fields[c.clave] = 'Sin correos ni teléfonos de personas.'
  }
  if (Object.keys(fields).length) throw new OperationError('validacion', { fields })
  return { tipo, cmd }
}

/** ORD-POS-155 (§18.3): «Rechazar» pide un motivo de una línea (1 a 300 caracteres, sin correos ni teléfonos). */
export function parseBandejaRechazar(input: unknown): { requestId: string; motivo: string } {
  const body = asObject(input)
  permitidos(body, ['requestId', 'motivo'])
  const fields: Fields = {}
  const rid = requestId(body, fields)
  let motivo = ''
  if (typeof body.motivo !== 'string' || cleanText(body.motivo, false) === '') fields.motivo = 'Obligatorio: una línea con el motivo.'
  else {
    motivo = textoLimpio(body.motivo, 300, false, fields, 'motivo')
    if (!fields.motivo && pareceContacto(motivo)) fields.motivo = 'Sin correos ni teléfonos de personas.'
  }
  if (Object.keys(fields).length) throw new OperationError('validacion', { fields })
  return { requestId: rid, motivo }
}

/** ID de la ruta (`/productos/<PRODUCTO_ID>`); uno mal formado es 404, como uno inexistente. */
export function parseIdRuta(prefijo: 'PRD' | 'PRV' | 'COT' | 'EMB' | 'BAN', raw: string): string {
  let v: string
  try {
    v = decodeURIComponent(raw)
  } catch {
    throw new OperationError('registro-inexistente')
  }
  if (!idValido(prefijo, v)) throw new OperationError('registro-inexistente')
  return v
}
