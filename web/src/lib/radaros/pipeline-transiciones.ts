import type { Etapa } from './pipeline'

/**
 * Tabla de transiciones de `eco.producto.mover` (docs/diseno-eco-pipeline.md §5.1). Pura y sin dependencias: la usan
 * el servicio (que la hace cumplir) y el tablero del navegador (que solo ofrece estas etapas en «Mover a…»).
 * Saltar etapas hacia adelante no se permite; los requisitos de cada destino los revisa el servicio.
 */
export const TRANSICIONES: Readonly<Record<Etapa, readonly Etapa[]>> = {
  SUGERIDO: ['EVALUANDO', 'DESCARTADO'],
  EVALUANDO: ['COTIZANDO', 'SUGERIDO', 'DESCARTADO'],
  COTIZANDO: ['MUESTRA', 'EVALUANDO', 'DESCARTADO'],
  MUESTRA: ['EN_VENTA', 'COTIZANDO', 'DESCARTADO'],
  EN_VENTA: ['MUESTRA', 'DESCARTADO'],
  DESCARTADO: ['SUGERIDO', 'EVALUANDO'],
}

export function transicionPermitida(desde: Etapa, a: Etapa): boolean {
  return TRANSICIONES[desde].includes(a)
}

/** Motivo obligatorio: descartar, reabrir (desde `DESCARTADO`) y volver de `EN_VENTA` a `MUESTRA`. */
export function requiereMotivo(desde: Etapa, a: Etapa): boolean {
  return a === 'DESCARTADO' || desde === 'DESCARTADO' || (desde === 'EN_VENTA' && a === 'MUESTRA')
}
