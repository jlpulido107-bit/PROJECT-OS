/**
 * Formularios de alta y edición del pipeline (ORD-POS-110, docs/diseno-eco-pipeline.md §3 y §4.3). Pura y sin Next: arma
 * el cuerpo y clasifica la respuesta de las rutas que ya existen; el servidor repite todas las validaciones. Los campos
 * llegan del servidor (la lista cerrada `CAMPOS` de la validación), así el formulario no puede pedir uno que la ruta
 * rechace.
 */

export type TipoCampo =
  | { k: 'texto'; max: number; multilinea?: boolean; sinContacto?: boolean }
  | { k: 'contacto' } | { k: 'asin' } | { k: 'idea' } | { k: 'fecha' } | { k: 'pais' } | { k: 'pct' }
  | { k: 'numero'; decimales: 2 | 4 }
  | { k: 'entero'; min: number }
  | { k: 'lista'; valores: readonly string[] }
  | { k: 'id'; prefijo: 'PRD' | 'PRV' | 'COT' | 'EMB' }

export interface CampoForm { clave: string; columna: string; tipo: TipoCampo; obligatorio?: boolean; etiqueta?: string }

export type Resultado =
  | { tipo: 'ok'; id: string; repetida: boolean; aviso: string | null }
  | { tipo: 'validacion'; mensaje: string; campos: Record<string, string> }
  | { tipo: 'conflicto'; mensaje: string; versionActual: number | null }
  | { tipo: 'error'; mensaje: string }

/**
 * Cuerpo del envío, con un requestId nuevo cada vez. En el alta van los campos con valor; en la edición, solo los que
 * cambiaron respecto de la hoja (`''` vacía la celda) y `expectedVersion`: lo que no se tocó no se reenvía, así una
 * celda con fórmula o escrita a mano no se pisa.
 */
export function cuerpo(
  campos: readonly CampoForm[], valores: Record<string, string>, nuevoId: () => string,
  edicion?: { version: number; iniciales: Record<string, string | null> },
): Record<string, unknown> {
  const out: Record<string, unknown> = { requestId: nuevoId() }
  if (edicion) out.expectedVersion = edicion.version
  for (const c of campos) {
    const v = (valores[c.clave] ?? '').trim()
    if (edicion ? v !== (edicion.iniciales[c.columna] ?? '').trim() : v !== '') out[c.clave] = v
  }
  return out
}

interface Respuesta { ok?: boolean; id?: string; repetida?: boolean; aviso?: string; error?: { codigo?: string; mensaje?: string; campos?: Record<string, string>; detalle?: { version?: unknown } } }

/** Envía a una ruta existente con la cabecera CSRF; nada se da por guardado sin `ok` del servidor. */
export async function enviar(url: string, metodo: 'POST' | 'PATCH', body: Record<string, unknown>, f: typeof fetch = fetch): Promise<Resultado> {
  let json: Respuesta | null
  let status: number
  try {
    const r = await f(url, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', 'X-Project-OS-CSRF': '1' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    })
    status = r.status
    json = (await r.json().catch(() => null)) as Respuesta | null
  } catch {
    return { tipo: 'error', mensaje: 'Sin conexión con el servidor; no se guardó nada.' }
  }
  if (json?.ok && typeof json.id === 'string') return { tipo: 'ok', id: json.id, repetida: json.repetida === true, aviso: json.aviso ?? null }
  const e = json?.error
  const mensaje = e?.mensaje ?? 'No se pudo guardar.'
  // 400 (campo no admitido) o 422 (validación, referencia inexistente): el servidor nombra el campo y el motivo.
  if ((status === 400 || status === 422) && e?.campos) return { tipo: 'validacion', mensaje, campos: e.campos }
  if (status === 409) {
    const v = e?.detalle?.version
    return { tipo: 'conflicto', mensaje, versionActual: typeof v === 'number' && Number.isInteger(v) ? v : null }
  }
  return { tipo: 'error', mensaje }
}

/** VERSION entera ≥ 1, o null: una fila sin VERSION (escrita a mano) no se edita desde el dashboard. */
export function versionDeFila(raw: string | null | undefined): number | null {
  const n = Number(raw ?? '')
  return raw && Number.isInteger(n) && n >= 1 ? n : null
}

/** ORD-POS-146 (criterio 1): un correo o un teléfono (10 dígitos o más, con o sin separadores). La usan el servidor y la
 * pantalla. */
const CORREO = /[^\s@]+@[^\s@]+\.[^\s@]+/
const TELEFONO = /\+?\d(?:[\s().-]*\d){9,}/
export function pareceContacto(texto: string): boolean {
  return CORREO.test(texto) || TELEFONO.test(texto)
}

/**
 * Revisión en pantalla de un valor (ORD-POS-146, borradores del pegado): el motivo si no vale, o null. Es un espejo de
 * `valorCampo` del servidor para avisar antes de enviar; el servidor repite todas las reglas y es el que decide.
 */
export function validarCampo(c: CampoForm, raw: string): string | null {
  const s = raw.trim()
  if (s === '') return c.obligatorio ? 'Obligatorio.' : null
  const t = c.tipo
  switch (t.k) {
    case 'texto':
      if (s.length > t.max) return `Hasta ${t.max} caracteres.`
      if (/^[=+\-@]/.test(s)) return 'No puede empezar por =, +, - ni @.'
      if (t.sinContacto && pareceContacto(s)) return 'Sin correos ni teléfonos de personas.'
      return null
    case 'contacto':
      return s.length > 200 ? 'Hasta 200 caracteres.' : /^[=\-@]/.test(s) ? 'No puede empezar por =, - ni @.' : null
    case 'asin':
      return /^[A-Z0-9]{10}$/.test(s) ? null : '10 caracteres A-Z y 0-9.'
    case 'idea':
      return /^[A-Z]{2,4}-\d{3,4}$/.test(s) ? null : 'ID de idea de RADAROS (p. ej. EC-004).'
    case 'pais':
      return /^[A-Z]{2}$/.test(s) ? null : 'Código ISO 3166-1 alfa-2 en mayúsculas (p. ej. CN).'
    case 'fecha': {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
      const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null
      return d && d.toISOString().slice(0, 10) === s ? null : 'Fecha AAAA-MM-DD válida.'
    }
    case 'numero':
      return (t.decimales === 2 ? /^\d{1,10}(\.\d{1,2})?$/ : /^\d{1,10}(\.\d{1,4})?$/).test(s) ? null : `Número ≥ 0 con hasta ${t.decimales} decimales.`
    case 'pct':
      return /^\d{1,3}(\.\d{1,4})?$/.test(s) && Number(s) <= 100 ? null : 'Porcentaje en puntos de 0 a 100 (20 = 20 %), hasta 4 decimales.'
    case 'entero':
      return /^\d{1,9}$/.test(s) && Number(s) >= t.min ? null : `Entero ≥ ${t.min}.`
    case 'lista':
      return t.valores.includes(s) ? null : `Uno de: ${t.valores.join(', ')}.`
    case 'id':
      return new RegExp(`^${t.prefijo}-\\d{4,}$`).test(s) ? null : `${t.prefijo}-NNNN.`
  }
}

/**
 * Clave de comparación de nombres de proveedor (ORD-POS-146, criterio 1): sin acentos, sin mayúsculas, sin signos ni
 * espacios. «Fábrica  Uno, S.A.» y «fabrica uno sa» son el mismo proveedor.
 */
export function nombreClave(nombre: string | null | undefined): string {
  return (nombre ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/**
 * ORD-POS-147 (criterio 4): texto de la etiqueta de un campo. `MOQ` y `CANTIDAD_COTIZADA` muestran la unidad elegida en
 * «El precio es por» (`PRECIO_POR`): sets o piezas; sin elegir, lo dicen.
 */
export function etiquetaCampo(c: CampoForm, precioPor: string | null | undefined): string {
  const base = c.etiqueta ? `${c.etiqueta} (${c.columna})` : c.columna
  if (c.columna !== 'MOQ' && c.columna !== 'CANTIDAD_COTIZADA') return base
  const u = (precioPor ?? '').trim().toUpperCase()
  return `${base} (${u === 'SET' ? 'sets' : u === 'PIEZA' ? 'piezas' : 'en la unidad de «El precio es por»'})`
}

/** ORD-POS-147 (criterio 2): nombre de la casilla «Incluye entrega en CEDIS Amazon»; no es columna y nunca se envía. */
export const CASILLA_ENTREGA_CEDIS = 'incluyeEntregaCedis'

/**
 * Regla de la casilla «Incluye entrega en CEDIS Amazon» (ORD-POS-147, criterio 2; §14.7). La aplican el formulario de alta
 * y el pegado antes de enviar. Con `INCOTERM` DDP y la casilla marcada, `FLETE_CEDIS` = 0 (incluido). Sin la casilla, en
 * DDP se pide el monto, salvo que haya `FLETE_CEDIS_REF` en PIPE_PARAMETROS (el tabulador lo usará como SUPUESTO). La
 * casilla fuera de DDP es un error: no se adivina qué quiso decir.
 */
export function reglaEntregaCedis(
  valores: Record<string, string>, fleteCedisRef: number | null,
): { valores: Record<string, string>; errores: Record<string, string> } {
  const errores: Record<string, string> = {}
  const marcada = (valores[CASILLA_ENTREGA_CEDIS] ?? '').trim() === 'SI'
  const ddp = (valores.incoterm ?? '').trim().toUpperCase() === 'DDP'
  const flete = (valores.fleteCedis ?? '').trim()
  const out = { ...valores }
  delete out[CASILLA_ENTREGA_CEDIS]
  if (marcada && !ddp) errores[CASILLA_ENTREGA_CEDIS] = 'Solo con INCOTERM DDP.'
  else if (marcada) {
    if (flete !== '' && Number(flete) !== 0) errores.fleteCedis = 'Con «Incluye entrega en CEDIS Amazon» marcada, FLETE_CEDIS es 0: vacíalo o desmarca la casilla.'
    else out.fleteCedis = '0'
  } else if (ddp && flete === '' && fleteCedisRef === null) {
    errores.fleteCedis = 'En DDP: escribe el flete al CEDIS (MXN) o marca «Incluye entrega en CEDIS Amazon». No hay FLETE_CEDIS_REF en PIPE_PARAMETROS.'
  }
  return { valores: out, errores }
}
