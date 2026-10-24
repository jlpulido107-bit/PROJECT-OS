import { parseCivilDate } from '../dates'
import { OperationError } from '../operations/errors'
import { cleanText, safeCellText } from '../operations/sanitize'
import { CATEGORIAS, MONEDAS, PROYECTOS, RECURRENTE_ID, TIPOS, type Categoria, type Moneda, type Proyecto, type Tipo } from './finanzas'

/**
 * Validación de los cuerpos de escritura de finanzas (ORD-POS-077, docs/diseno-finanzas-v2.md §3.1 y §4.3). Pura:
 * no lee la hoja. Lo que depende de la hoja (MES_INICIO, `AJUSTE_DE` existente, recurrente vigente) lo revisa el
 * servicio. Los montos se manejan en centavos enteros y el tipo de cambio en diezmilésimas.
 */

export interface MovimientoCommand {
  requestId: string
  fecha: string
  proyecto: Proyecto
  tipo: Tipo
  categoria: Categoria
  concepto: string
  productoId: string | null
  moneda: Moneda
  /** Solo en USD: centavos de dólar. */
  montoOrigCentavos: number | null
  /** Solo en USD: tipo de cambio en diezmilésimas. */
  tipoCambioDiezmil: number | null
  /** En MXN, el capturado; en USD, el calculado (`round(MONTO_ORIG × TIPO_CAMBIO, 2)`). Negativo solo en un ajuste. */
  montoMxnCentavos: number
  ivaMxnCentavos: number | null
  comprobante: 'sí' | 'no'
  ajusteDe: string | null
}

export interface ConfirmarCommand {
  requestId: string
  recurrenteId: string
  mes: string
  /** Centavos en la moneda del recurrente (la valida el servicio). */
  montoCentavos: number
  tipoCambioDiezmil: number | null
  fecha: string
  comprobante: 'sí' | 'no'
}

const REQUEST_ID = /^[0-9a-f-]{36}$/
const PRODUCTO_ID = /^EC-\d{3,4}$/
const MOV_ID = /^[A-Za-z0-9_.:-]{1,60}$/
const MES = /^\d{4}-(0[1-9]|1[0-2])$/
/** Montos hasta 99,999,999.99 y tipo de cambio por debajo de 1000: el producto cabe holgado en BigInt. */
const MAX_CENTAVOS = 9_999_999_999
const MAX_DIEZMIL = 9_999_999

type Fields = Record<string, string>

function str(body: Record<string, unknown>, key: string): string | null {
  const v = body[key]
  if (v === undefined || v === null) return null
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t === '' ? null : t
}

/** Decimal exacto con hasta `decimales` cifras, como entero escalado; null si no es un número así. */
export function decimalEscalado(raw: string | null, decimales: number, negativo = false): number | null {
  if (raw === null) return null
  const m = new RegExp(`^(-)?(\\d{1,10})(?:\\.(\\d{1,${decimales}}))?$`).exec(raw)
  if (!m || (m[1] && !negativo)) return null
  const entero = Number(m[2]) * 10 ** decimales + Number((m[3] ?? '').padEnd(decimales, '0') || '0')
  return m[1] ? -entero : entero
}

/** `round(centavos × diezmil / 10000)` con redondeo a la mitad lejos de cero, sin punto flotante. */
export function convertirCentavos(centavos: number, diezmil: number): number {
  const p = BigInt(Math.abs(centavos)) * BigInt(diezmil)
  const q = (p + 5000n) / 10000n
  return Number(q) * Math.sign(centavos)
}

function canonico<T extends string>(raw: string | null, valores: readonly T[]): T | null {
  if (raw === null) return null
  const v = raw.toLocaleLowerCase('es')
  return valores.find((x) => x.toLocaleLowerCase('es') === v) ?? null
}

function comprobante(raw: string | null): 'sí' | 'no' | null {
  if (raw === null) return null
  const v = raw.toLowerCase()
  return v === 'sí' || v === 'si' ? 'sí' : v === 'no' ? 'no' : null
}

/** Rechaza en CONCEPTO lo que parezca correo, CLABE, tarjeta, RFC o URL (§3.1 y §11). */
export function conceptoProhibido(texto: string): boolean {
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(texto)) return true
  if (/https?:\/\/|www\./i.test(texto)) return true
  if (/\b[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}\b/i.test(texto)) return true
  // 13 a 19 dígitos (tarjeta) o 18 (CLABE), aunque vengan separados por espacios o guiones.
  for (const m of texto.matchAll(/\d[\d -]{11,}\d/g)) {
    const digitos = m[0].replace(/\D/g, '').length
    if (digitos >= 13 && digitos <= 19) return true
  }
  return false
}

function concepto(raw: string | null, fields: Fields, key = 'concepto'): string {
  const limpio = raw === null ? '' : cleanText(raw, false)
  if (limpio.length < 3 || limpio.length > 80) fields[key] = 'Entre 3 y 80 caracteres.'
  else if (conceptoProhibido(limpio)) fields[key] = 'Sin correos, cuentas, tarjetas, RFC ni URL.'
  return limpio
}

function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OperationError('validacion', { fields: { cuerpo: 'Se esperaba un objeto JSON.' } })
  return body as Record<string, unknown>
}

function requestId(body: Record<string, unknown>, fields: Fields): string {
  const id = typeof body.requestId === 'string' ? body.requestId : ''
  if (!REQUEST_ID.test(id)) fields.requestId = 'requestId no válido; recarga el formulario.'
  return id
}

function fechaValida(raw: string | null): string | null {
  return raw !== null && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? parseCivilDate(raw).value : null
}

/** Cuerpo de «Nuevo movimiento» y de «Ajustar» (§3.1 y §3.4). */
export function parseMovimiento(input: unknown): MovimientoCommand {
  const body = asObject(input)
  const fields: Fields = {}
  const id = requestId(body, fields)
  const fecha = fechaValida(str(body, 'fecha'))
  if (fecha === null) fields.fecha = 'Fecha AAAA-MM-DD válida.'
  const proyecto = canonico(str(body, 'proyecto'), PROYECTOS)
  if (proyecto === null) fields.proyecto = 'ECO o POS.'
  const tipo = canonico(str(body, 'tipo'), TIPOS)
  if (tipo === null) fields.tipo = 'Gasto, Ingreso o Inversión.'
  const categoria = canonico(str(body, 'categoria'), CATEGORIAS)
  if (categoria === null) fields.categoria = 'Categoría de la lista.'
  const ajusteRaw = str(body, 'ajusteDe')
  if (ajusteRaw !== null && !MOV_ID.test(ajusteRaw)) fields.ajusteDe = 'MOV_ID no válido.'
  const ajusteDe = ajusteRaw !== null && MOV_ID.test(ajusteRaw) ? ajusteRaw : null
  const textoConcepto = concepto(str(body, 'concepto'), fields)
  const productoRaw = str(body, 'productoId')
  if (productoRaw !== null && !PRODUCTO_ID.test(productoRaw)) fields.productoId = 'Vacío o EC-NNN.'
  const moneda = canonico(str(body, 'moneda') ?? 'MXN', MONEDAS)
  if (moneda === null) fields.moneda = 'MXN o USD.'
  const ajuste = ajusteDe !== null

  let montoOrig: number | null = null
  let tipoCambio: number | null = null
  let montoMxn: number | null = decimalEscalado(str(body, 'montoMxn'), 2, ajuste)
  if (moneda === 'USD') {
    montoOrig = decimalEscalado(str(body, 'montoOrig'), 2, ajuste)
    tipoCambio = decimalEscalado(str(body, 'tipoCambio'), 4)
    if (montoOrig === null || montoOrig === 0 || Math.abs(montoOrig) > MAX_CENTAVOS) fields.montoOrig = ajuste ? 'Número distinto de 0, hasta 2 decimales.' : 'Número mayor que 0, hasta 2 decimales.'
    if (tipoCambio === null || tipoCambio <= 0 || tipoCambio > MAX_DIEZMIL) fields.tipoCambio = 'Número mayor que 0 y menor que 1000, hasta 4 decimales.'
    if (!fields.montoOrig && !fields.tipoCambio) {
      const calculado = convertirCentavos(montoOrig!, tipoCambio!)
      if (str(body, 'montoMxn') !== null && montoMxn !== calculado) throw new OperationError('monto-no-cuadra')
      montoMxn = calculado
      if (montoMxn === 0) fields.montoOrig = 'El monto en MXN redondeado no puede ser 0.'
    }
  } else if (moneda === 'MXN') {
    if (str(body, 'montoOrig') !== null) fields.montoOrig = 'Solo con USD.'
    if (str(body, 'tipoCambio') !== null) fields.tipoCambio = 'Solo con USD.'
    if (montoMxn === null || montoMxn === 0 || Math.abs(montoMxn) > MAX_CENTAVOS) fields.montoMxn = ajuste ? 'Número distinto de 0, hasta 2 decimales.' : 'Número mayor que 0, hasta 2 decimales.'
  }

  const ivaRaw = str(body, 'ivaMxn')
  const iva = decimalEscalado(ivaRaw, 2)
  if (ivaRaw !== null && (iva === null || (montoMxn !== null && montoMxn > 0 && iva > montoMxn) || (montoMxn !== null && montoMxn < 0))) {
    fields.ivaMxn = montoMxn !== null && montoMxn < 0 ? 'Sin IVA en un ajuste negativo.' : 'Entre 0 y MONTO_MXN.'
  }
  const comp = comprobante(str(body, 'comprobante'))
  if (comp === null) fields.comprobante = 'sí o no.'
  if (Object.keys(fields).length) throw new OperationError('validacion', { fields })

  return {
    requestId: id, fecha: fecha!, proyecto: proyecto!, tipo: tipo!, categoria: categoria!, concepto: textoConcepto,
    productoId: productoRaw, moneda: moneda!, montoOrigCentavos: montoOrig, tipoCambioDiezmil: tipoCambio,
    montoMxnCentavos: montoMxn!, ivaMxnCentavos: ivaRaw === null ? null : iva, comprobante: comp!, ajusteDe,
  }
}

/** Cuerpo de «Confirmar» un recurrente (§4.3). La moneda la pone el recurrente: el servicio revisa el tipo de cambio. */
export function parseConfirmar(input: unknown): ConfirmarCommand {
  const body = asObject(input)
  const fields: Fields = {}
  const id = requestId(body, fields)
  const recurrenteId = str(body, 'recurrenteId')
  if (recurrenteId === null || !RECURRENTE_ID.test(recurrenteId)) fields.recurrenteId = 'ID de recurrente no válido.'
  const mes = str(body, 'mes')
  if (mes === null || !MES.test(mes)) fields.mes = 'Mes AAAA-MM.'
  const monto = decimalEscalado(str(body, 'monto'), 2)
  if (monto === null || monto <= 0 || monto > MAX_CENTAVOS) fields.monto = 'Número mayor que 0, hasta 2 decimales.'
  const tcRaw = str(body, 'tipoCambio')
  const tipoCambio = decimalEscalado(tcRaw, 4)
  if (tcRaw !== null && (tipoCambio === null || tipoCambio <= 0 || tipoCambio > MAX_DIEZMIL)) fields.tipoCambio = 'Número mayor que 0 y menor que 1000, hasta 4 decimales.'
  const fecha = fechaValida(str(body, 'fecha'))
  if (fecha === null) fields.fecha = 'Fecha AAAA-MM-DD válida.'
  else if (mes !== null && MES.test(mes) && !fecha.startsWith(`${mes}-`)) fields.fecha = 'La fecha debe caer en el mes que se confirma.'
  const comp = comprobante(str(body, 'comprobante') ?? 'no')
  if (comp === null) fields.comprobante = 'sí o no.'
  if (Object.keys(fields).length) throw new OperationError('validacion', { fields })
  return { requestId: id, recurrenteId: recurrenteId!, mes: mes!, montoCentavos: monto!, tipoCambioDiezmil: tcRaw === null ? null : tipoCambio, fecha: fecha!, comprobante: comp! }
}

/** Texto final de CONCEPTO: el de un ajuste empieza por «Ajuste de <MOV_ID>: »; neutralizado contra fórmulas. */
export function conceptoFinal(cmd: Pick<MovimientoCommand, 'concepto' | 'ajusteDe'>): string {
  const prefijo = cmd.ajusteDe ? `Ajuste de ${cmd.ajusteDe}: ` : ''
  const texto = prefijo && cmd.concepto.startsWith(prefijo) ? cmd.concepto : prefijo + cmd.concepto
  return safeCellText(texto)
}

/** Centavos → número con 2 decimales para la celda (p. ej. 12345 → 123.45). */
export function aNumero(escalado: number, decimales: number): number {
  return Number((escalado / 10 ** decimales).toFixed(decimales))
}
