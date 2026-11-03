/**
 * Enlace del calendario ICS (ORD-POS-142). Sin entorno ni secretos: lo importa también el panel del navegador.
 */

/** Única ruta del calendario; el proxy la deja pasar sin sesión solo con GET y esta ruta exacta. */
export const CALENDARIO_ICS_RUTA = '/api/planificacion/calendario.ics'

/* ------------------------------ Enlace para la vista (criterio 5) ------------------------------ */

/** Lo que el propietario pega como secreto: caracteres seguros en una URL, de 16 a 512. */
export const SECRETO_ENLACE = /^[A-Za-z0-9._~-]{16,512}$/

const sinBarraFinal = (origen: string) => origen.trim().replace(/\/+$/, '')

/** El enlace tal como se muestra: el secreto siempre oculto. */
export const enlaceOculto = (origen: string): string => `${sinBarraFinal(origen)}${CALENDARIO_ICS_RUTA}?token=••••••••`

/** El enlace completo que se copia, o null si el secreto no tiene el formato esperado. */
export function enlaceCalendario(origen: string, secreto: string): string | null {
  const s = secreto.trim()
  if (!SECRETO_ENLACE.test(s)) return null
  return `${sinBarraFinal(origen)}${CALENDARIO_ICS_RUTA}?token=${encodeURIComponent(s)}`
}
