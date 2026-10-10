import { civilDateInZone, MERIDA_TZ } from '../dates'

/**
 * Fecha civil de referencia ("hoy") de un instante en la zona indicada. Vive fuera del motor: quien llama
 * decide el instante (el reloj del servidor en la página, un valor fijo en las pruebas).
 */
export function referenceDateFor(epochMs: number, timeZone: string = MERIDA_TZ): string {
  return civilDateInZone(epochMs, timeZone)
}
