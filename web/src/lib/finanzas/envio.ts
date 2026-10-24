/**
 * Reintentos de los formularios de escritura de /finanzas (ORD-POS-079, hallazgo H3 de ORD-POS-077;
 * docs/diseno-finanzas-v2.md §3.3). Puro y sin dependencias de servidor: lo usan forms.tsx y las pruebas.
 *
 * Tras una respuesta que puede haber dejado la auditoría escrita sin su fila (la fila falló, no se pudo verificar, la
 * auditoría dio error a medias o no hubo respuesta), el formulario queda CONGELADO: el siguiente envío reutiliza el
 * mismo requestId y el MISMO cuerpo que el envío original, aunque el formulario haya cambiado. Así el servidor completa
 * el mismo MAN (roll-forward) en vez de responder 409 `conflicto-idempotencia` y obligar a otro requestId, que dejaría
 * un MAN auditado sin fila y un hueco en la numeración. Lo que estuviera mal se corrige después con «Ajustar».
 *
 * Un error PERMANENTE (ORD-POS-080) descongela: ese cuerpo nunca va a entrar, así que el formulario vuelve a enviar lo
 * que muestra. Con `validacion` se conserva el requestId (si ya hubiera algo auditado con él, el servidor responde
 * `conflicto-idempotencia` y se renueva). Con `auditoria-inconsistente` o `estado-divergente` la auditoría de ESE requestId
 * queda para revisión manual y cualquier reenvío con él daría el mismo error: se renueva.
 */

export type Payload = Record<string, unknown>

export interface EnvioEstado {
  requestId: string
  /** Cuerpo del envío que pudo quedar auditado; mientras exista, se reenvía tal cual. */
  congelado: Payload | null
}

export type Respuesta = { ok: true } | { ok: false; codigo: string }

/** Códigos tras los que la solicitud pudo quedar auditada sin su fila. `red`: sin respuesta; `error`: respuesta
 * sin JSON (p. ej. un 502 del balanceador). */
export const CODIGOS_PENDIENTES: readonly string[] = ['escritura-fallida', 'verificacion-fallida', 'auditoria-fallida', 'conflicto-concurrente', 'error-interno', 'error', 'red']

/** Códigos con los que el cuerpo congelado no va a entrar nunca: descongelan para corregir (ORD-POS-080). */
export const CODIGOS_PERMANENTES: readonly string[] = ['validacion', 'auditoria-inconsistente', 'estado-divergente']
/** Permanentes ligados a la auditoría del requestId (replay del servidor): el requestId se renueva. */
const CODIGOS_REQUEST_ID_AGOTADO: readonly string[] = ['auditoria-inconsistente', 'estado-divergente']

export function estadoInicial(nuevoId: () => string): EnvioEstado {
  return { requestId: nuevoId(), congelado: null }
}

/** Cuerpo que se envía: el congelado si hay una solicitud pendiente; si no, el del formulario. Siempre con su requestId. */
export function cuerpoEnvio(estado: EnvioEstado, formulario: Payload): Payload {
  return { ...(estado.congelado ?? formulario), requestId: estado.requestId }
}

/** Estado tras la respuesta al `enviado` (lo que devolvió `cuerpoEnvio`). */
export function trasRespuesta(estado: EnvioEstado, enviado: Payload, respuesta: Respuesta, nuevoId: () => string): EnvioEstado {
  if (respuesta.ok) return estadoInicial(nuevoId)
  if (CODIGOS_REQUEST_ID_AGOTADO.includes(respuesta.codigo)) return estadoInicial(nuevoId)
  if (estado.congelado) return CODIGOS_PERMANENTES.includes(respuesta.codigo) ? { requestId: estado.requestId, congelado: null } : estado
  if (CODIGOS_PENDIENTES.includes(respuesta.codigo)) {
    const cuerpo = { ...enviado }
    delete cuerpo.requestId
    return { requestId: estado.requestId, congelado: cuerpo }
  }
  // Sin nada pendiente: el requestId ya usado con otros datos se renueva (el anterior quedó completo).
  if (respuesta.codigo === 'conflicto-idempotencia') return { requestId: nuevoId(), congelado: null }
  return estado
}

/**
 * Original de «Ajustar» que se muestra (ORD-POS-080): con un cuerpo congelado, el `ajusteDe` congelado y la lista
 * bloqueada, porque es el que se va a reenviar; sin congelar, el elegido. Así el ajusteDe enviado es siempre el mostrado.
 */
export function ajusteMostrado(estado: EnvioEstado | null, elegido: string): { movId: string; bloqueado: boolean } {
  const congelado = estado?.congelado?.ajusteDe
  return typeof congelado === 'string' ? { movId: congelado, bloqueado: true } : { movId: elegido, bloqueado: false }
}
