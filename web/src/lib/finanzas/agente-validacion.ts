import { addDays } from '../dates'
import { OperationError } from '../operations/errors'
import { cleanText } from '../operations/sanitize'
import { conceptoProhibido, decimalEscalado } from './escritura-validacion'
import { MONEDAS, PROYECTOS, sumarMeses, ultimoDiaDelMes, type Moneda, type Proyecto } from './finanzas'

/**
 * Validación de los cuerpos del agente de finanzas (ORD-POS-092, docs/diseno-finanzas-v3.md §3 y §4). Pura: no lee la
 * hoja. Lo que depende de la hoja o del reloj (corte cerrado y en plazo, fecha de la fuente, suscripción) lo revisa el
 * servicio. Montos en centavos de dólar y tipo de cambio en diezmilésimas, como la escritura del propietario.
 */

/** Tope por fila de DEC-POS-018 (§4.4), en centavos de USD. Constante del código: subirlo exige otra orden. */
export const TOPE_USD_CENTAVOS = 300_000

export interface Corte {
  /** `AAAA-MM-Q1` | `AAAA-MM-Q2`. */
  id: string
  mes: string
  quincena: 1 | 2
  /** `AAAA-MM-DD`, día 1 o 16. */
  inicio: string
  /** `AAAA-MM-DD`, día 15 o el último del mes. */
  fin: string
}

export interface RendimientoCommand {
  requestId: string
  corte: string
  reporte: string
  costoEquivCentavos: number
  sesiones: number
  sesionesSinDato: number
  /** null = sin dato (celda vacía), nunca 0 inventado. */
  tokensEntrada: number | null
  tokensSalida: number | null
}

export interface CargoExtraCommand {
  requestId: string
  corte: string
  reporte: string
  /** `T` de §5: total facturado por Anthropic en el corte, según el propietario, en centavos de `moneda`. */
  facturaTotalCentavos: number
  /** Moneda de `T` (ORD-POS-133); debe ser la de `REC-CLAUDE-AAAA-MM`: nunca se convierte para restar. */
  moneda: Moneda
  /** `<corte> «<cita>» AAAA-MM-DD`, ya limpia. */
  fuente: string
  /** Fecha del dato, sacada de `fuente` (el servicio la compara con hoy). */
  fuenteFecha: string
  proyecto: Proyecto
  /** Solo en USD; en MXN, null. */
  tipoCambioDiezmil: number | null
}

const REQUEST_ID = /^[0-9a-f-]{36}$/
const CORTE = /^(\d{4})-(0[1-9]|1[0-2])-Q([12])$/
const REPORTE = /^session_[A-Za-z0-9]{10,40}$/
const ENTERO = /^\d{1,13}$/
const FUENTE = /^(\d{4}-(?:0[1-9]|1[0-2])-Q[12]) «([^«»]+)» (\d{4}-\d{2}-\d{2})$/
export const FUENTE_MAX = 200
/** Total de factura hasta 99,999,999.99 en su moneda (el tope de la fila se aplica al cargo extra, §4.4). */
const MAX_CENTAVOS = 9_999_999_999
const MAX_DIEZMIL = 9_999_999

type Fields = Record<string, string>

/** `CLAUDE-EXTRA-AAAA-MM-Qn` y `REND-CLAUDE-AAAA-MM-Qn` (§3.2): se derivan solo del corte. */
export const idCargoExtra = (corte: string) => `CLAUDE-EXTRA-${corte}`
export const idRendimiento = (corte: string) => `REND-CLAUDE-${corte}`

export function parseCorte(raw: unknown): Corte | null {
  const m = typeof raw === 'string' ? CORTE.exec(raw.trim()) : null
  if (!m) return null
  const mes = `${m[1]}-${m[2]}`
  const quincena = m[3] === '1' ? 1 : 2
  return {
    id: `${mes}-Q${quincena}`, mes, quincena,
    inicio: `${mes}-${quincena === 1 ? '01' : '16'}`,
    fin: `${mes}-${quincena === 1 ? '15' : String(ultimoDiaDelMes(mes))}`,
  }
}

/** §3.1: el corte ya cerró (Q1 desde el día 16, Q2 desde el día 1 del mes siguiente) y es del mes actual o del anterior. */
export function revisarCorte(corte: Corte, hoy: string): void {
  if (hoy <= corte.fin) throw new OperationError('corte-no-cerrado')
  if (corte.mes < sumarMeses(hoy.slice(0, 7), -1)) throw new OperationError('corte-fuera-de-plazo')
}

/** La fecha de la fuente es la del dato: hoy en Mérida, con 1 día de margen (§4.3). */
export function fuenteVigente(fecha: string, hoy: string): boolean {
  return fecha >= addDays(hoy, -1) && fecha <= addDays(hoy, 1)
}

function str(body: Record<string, unknown>, key: string): string | null {
  const v = body[key]
  if (v === undefined || v === null) return null
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t === '' ? null : t
}

function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OperationError('validacion', { fields: { cuerpo: 'Se esperaba un objeto JSON.' } })
  return body as Record<string, unknown>
}

function comunes(body: Record<string, unknown>, fields: Fields): { requestId: string; corte: string; reporte: string } {
  const requestId = typeof body.requestId === 'string' ? body.requestId : ''
  if (!REQUEST_ID.test(requestId)) fields.requestId = 'requestId no válido.'
  const corte = parseCorte(body.corte)
  if (!corte) fields.corte = 'AAAA-MM-Q1 o AAAA-MM-Q2.'
  const reporte = str(body, 'reporte') ?? ''
  if (!REPORTE.test(reporte)) fields.reporte = 'ID de sesión de reporte-consumo (session_…).'
  return { requestId, corte: corte?.id ?? '', reporte }
}

function entero(raw: string | null, fields: Fields, key: string, opcional: boolean): number | null {
  if (raw === null && opcional) return null
  if (raw === null || !ENTERO.test(raw)) {
    fields[key] = opcional ? 'Entero ≥ 0, o vacío si no hay dato.' : 'Entero ≥ 0.'
    return null
  }
  return Number(raw)
}

/** Números que aparecen en un texto, en centavos (acepta `1,234.50` y `20`). */
function numerosEnCentavos(texto: string): number[] {
  return [...texto.matchAll(/\d[\d,]*(?:\.\d{1,2})?/g)].flatMap((m) => {
    const limpio = m[0].replace(/,(?=\d{3}(?:\D|$))/g, '')
    const n = decimalEscalado(limpio, 2)
    return n === null ? [] : [n]
  })
}

/** Además de lo que rechaza CONCEPTO, nada que parezca un número de factura o de folio (§4.3 y §10). */
export function fuenteProhibida(cita: string): boolean {
  if (conceptoProhibido(cita)) return true
  if (/#|\b(n[uú]m(ero)?|no)\.?\s*[:#]?\s*[A-Z0-9-]*\d/i.test(cita)) return true
  if (/\b(factura|invoice|folio|recibo|receipt)\s*[:#]?\s*(?=[A-Z0-9-]*[A-Z])(?=[A-Z0-9-]*\d)[A-Z0-9-]{4,}/i.test(cita)) return true
  // Códigos con guion que mezclan letras y dígitos (p. ej. «INV-0001»).
  return /\b(?=[A-Z0-9]*[A-Z])[A-Z0-9]*\d[A-Z0-9]*-[A-Z0-9-]+\b|\b[A-Z]+-\d{3,}\b/i.test(cita)
}

/** Cuerpo de `POST /api/finanzas/agente/rendimiento` (§4.2). */
export function parseRendimiento(input: unknown): RendimientoCommand {
  const body = asObject(input)
  const fields: Fields = {}
  const base = comunes(body, fields)
  const costo = decimalEscalado(str(body, 'costoEquivUsd'), 2)
  if (costo === null) fields.costoEquivUsd = 'Número ≥ 0, hasta 2 decimales.'
  const sesiones = entero(str(body, 'sesiones'), fields, 'sesiones', false)
  const sinDato = entero(str(body, 'sesionesSinDato'), fields, 'sesionesSinDato', false)
  const tokensEntrada = entero(str(body, 'tokensEntrada'), fields, 'tokensEntrada', true)
  const tokensSalida = entero(str(body, 'tokensSalida'), fields, 'tokensSalida', true)
  if (Object.keys(fields).length) throw new OperationError('validacion', { fields })
  if (costo! > TOPE_USD_CENTAVOS) throw new OperationError('monto-excede-tope')
  return { ...base, costoEquivCentavos: costo!, sesiones: sesiones!, sesionesSinDato: sinDato!, tokensEntrada, tokensSalida }
}

/** Cuerpo de `POST /api/finanzas/agente/cargo-extra` (§4.3). Nunca estima: sin total de factura, 400. */
export function parseCargoExtra(input: unknown): CargoExtraCommand {
  const body = asObject(input)
  const fields: Fields = {}
  const base = comunes(body, fields)
  // `moneda` opcional (USD por defecto) y `facturaTotal` en esa moneda; `facturaTotalUsd` es el mismo dato en USD
  // (compatibilidad): los dos cuerpos dan el mismo comando y el mismo hash.
  const monedaRaw = str(body, 'moneda')
  const moneda = monedaRaw === null ? 'USD' : (MONEDAS.find((m) => m === monedaRaw.toUpperCase()) ?? null)
  if (moneda === null) fields.moneda = 'USD o MXN, la del total que dio el propietario.'
  const totalRaw = str(body, 'facturaTotal')
  const totalUsdRaw = str(body, 'facturaTotalUsd')
  let campoTotal = 'facturaTotal'
  if (totalRaw !== null && totalUsdRaw !== null) fields.facturaTotal = 'facturaTotal o facturaTotalUsd, no los dos.'
  else if (totalUsdRaw !== null) {
    campoTotal = 'facturaTotalUsd'
    if (moneda === 'MXN') fields.facturaTotalUsd = 'facturaTotalUsd es en USD: con moneda MXN usa facturaTotal.'
  }
  const total = decimalEscalado(totalRaw ?? totalUsdRaw, 2)
  if (!fields.facturaTotal && !fields.facturaTotalUsd && (total === null || total > MAX_CENTAVOS)) {
    fields[campoTotal] = 'Número ≥ 0, hasta 2 decimales: el total que dio el propietario, en su moneda.'
  }
  const proyecto = PROYECTOS.find((p) => p === str(body, 'proyecto')?.toUpperCase()) ?? null
  if (proyecto === null) fields.proyecto = 'POS o ECO, el que dio el propietario con el dato.'
  const tcRaw = str(body, 'tipoCambio')
  const tipoCambio = decimalEscalado(tcRaw, 4)
  if (tcRaw !== null && moneda === 'MXN') fields.tipoCambio = 'Solo con USD.'
  else if (tcRaw !== null && (tipoCambio === null || tipoCambio <= 0 || tipoCambio > MAX_DIEZMIL)) fields.tipoCambio = 'Número mayor que 0 y menor que 1000, hasta 4 decimales.'

  const fuente = cleanText(typeof body.fuente === 'string' ? body.fuente : '', false)
  const m = FUENTE.exec(fuente)
  let fecha = ''
  if (fuente.length > FUENTE_MAX || !m) fields.fuente = `<corte> «<cita literal del propietario>» AAAA-MM-DD, hasta ${FUENTE_MAX} caracteres.`
  else {
    const [, corteFuente, cita, dia] = m as unknown as [string, string, string, string]
    fecha = dia
    if (corteFuente !== base.corte) fields.fuente = 'El corte de la fuente debe ser el del cuerpo.'
    else if (fuenteProhibida(cita)) fields.fuente = 'Sin correos, cuentas, tarjetas, RFC, URL ni números de factura.'
    else if (total !== null && !numerosEnCentavos(cita).includes(total)) fields.fuente = 'La cita debe traer el total de factura.'
  }
  if (Object.keys(fields).length) throw new OperationError('validacion', { fields })
  return {
    ...base, facturaTotalCentavos: total!, moneda: moneda!, fuente, fuenteFecha: fecha, proyecto: proyecto!,
    tipoCambioDiezmil: tcRaw === null ? null : tipoCambio,
  }
}
