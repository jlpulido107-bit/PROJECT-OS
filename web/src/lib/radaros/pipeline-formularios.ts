/**
 * Formularios de alta y edición del pipeline (ORD-POS-110, docs/diseno-eco-pipeline.md §3 y §4.3). Pura y sin Next: arma
 * el cuerpo y clasifica la respuesta de las rutas que ya existen; el servidor repite todas las validaciones. Los campos
 * llegan del servidor (la lista cerrada `CAMPOS` de la validación), así el formulario no puede pedir uno que la ruta
 * rechace.
 */

export type TipoCampo =
  | { k: 'texto'; max: number; multilinea?: boolean }
  | { k: 'contacto' } | { k: 'asin' } | { k: 'idea' } | { k: 'fecha' } | { k: 'pais' }
  | { k: 'numero'; decimales: 2 | 4 }
  | { k: 'entero'; min: number }
  | { k: 'lista'; valores: readonly string[] }
  | { k: 'id'; prefijo: 'PRD' | 'PRV' | 'COT' | 'EMB' }

export interface CampoForm { clave: string; columna: string; tipo: TipoCampo; obligatorio?: boolean }

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
