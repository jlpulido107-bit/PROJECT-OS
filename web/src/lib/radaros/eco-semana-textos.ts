/**
 * Tabla de textos ÚNICA de «ECO esta semana» (ORD-POS-159, criterio 2): aquí, y solo aquí, cada código de RADAROS
 * (veredictos, K1 a K6, avisos, etapas, modos y estados de la bitácora) se traduce a palabras. La página nunca pinta
 * un código: lo que no está en esta tabla sale con su texto genérico, no con el código. Los ID (EC, PRD, ASIN) solo van
 * en gris pequeño.
 */

/** VEREDICTO de AMZ_DICTAMEN y AMZ_CANDIDATOS (RADAROS docs/dictamen.md §4 y §12). */
export const TEXTO_VEREDICTO: Readonly<Record<string, string>> = {
  LISTO_PARA_RFQ: 'Pasó el filtro',
  INVESTIGAR: 'Falta un dato',
  KILL: 'No pasó el filtro',
  FUERA_DE_LISTA: 'Ya no está en la lista',
}
export const VEREDICTO_DESCONOCIDO = 'Resultado sin traducir'

export const CRITERIOS = ['K1', 'K2', 'K3', 'K4', 'K5', 'K6'] as const
export type Criterio = (typeof CRITERIOS)[number]

/** Por qué se descartó (criterio en `FALLA`). K1 solo avisa: nunca descarta. */
export const TEXTO_FALLA: Readonly<Record<Criterio, string>> = {
  K1: 'El precio de venta es muy bajo para el costo',
  K2: 'No deja el 25 % de ganancia',
  K3: 'No hay espacio: los más vendidos ya tienen muchas reseñas',
  K4: 'Sus ventas son muy inestables',
  K5: 'El pedido mínimo no cabe en tu capital',
  K6: 'Categoría que no vendemos',
}

/** Qué falta medir (criterio en `SIN_DATO`). */
export const TEXTO_FALTA: Readonly<Record<Criterio, string>> = {
  K1: 'Falta el precio de venta o el costo',
  K2: 'Falta el costo por pieza puesta en México',
  K3: 'Falta saber cómo lo buscaría un cliente, para medir la competencia',
  K4: 'Falta historial de ventas',
  K5: 'Falta el costo o el pedido mínimo del proveedor',
  K6: 'Falta el título o la categoría del producto',
}
export const TEXTO_FALTA_ASIN = 'Falta el enlace de Amazon de un producto parecido'
export const TEXTO_FALTA_GENERICO = 'Falta un dato para medirlo'
export const TEXTO_FALLA_GENERICO = 'No pasó el filtro'

/** K1 en `AVISO`: no descarta, pero se dice. */
export const TEXTO_AVISO_PRECIO = 'Margen muy justo: el precio de venta apenas alcanza. Cualquier sobrecosto lo vuelve pérdida.'

/** «¿Hay espacio?» (K3) de un producto que pasó el filtro. */
export const TEXTO_ESPACIO: Readonly<Record<string, string>> = { OK: 'Sí', FALLA: 'No', SIN_DATO: 'Sin medir todavía' }

/** TIPO de AMZ_AVISOS (RADAROS docs/dictamen.md §11): qué pasa y qué hacer, sin copiar MENSAJE ni ACCION (traen códigos). */
export const TEXTO_AVISO: Readonly<Record<string, { que: string; hacer: string }>> = {
  CORRIDA: { que: 'Una revisión del sistema terminó con problemas', hacer: 'Revisa la bitácora del buscador y vuelve a correrla.' },
  SIN_CORRIDA: { que: 'Esta semana no hay una revisión completa de tus ideas', hacer: 'Corre la revisión semanal.' },
  LISTO: { que: 'Un producto nuevo pasó el filtro', hacer: 'Pide cotizaciones por debajo de lo máximo que puedes pagar.' },
  CAMBIO: { que: 'Un producto cambió de resultado respecto a la semana anterior', hacer: 'Revisa por qué cambió.' },
  FALTA_PALABRA_CLAVE: { que: 'Hay ideas sin medir su competencia', hacer: 'Dime cómo buscaría un cliente cada una.' },
  FALTA_COSTO: { que: 'Hay ideas sin costo', hacer: 'Captura el costo por pieza o registra una cotización.' },
  FALTA_ASIN: { que: 'Hay ideas sin producto de Amazon con que compararlas', hacer: 'Manda el enlace de Amazon de un producto parecido a cada una.' },
}
export const AVISO_DESCONOCIDO = { que: 'Hay un aviso del sistema', hacer: 'Revísalo en el libro de RADAROS.' }
/** Avisos que hablan de la salud del buscador (bloque 6); los demás van en «Falta medir» (bloque 4). */
export const AVISOS_DE_SALUD: readonly string[] = ['CORRIDA', 'SIN_CORRIDA']
/** Avisos que ya cuentan los bloques 2 y 1: no se repiten como pendiente. */
export const AVISOS_YA_CONTADOS: readonly string[] = ['LISTO', 'CAMBIO']

/** ETAPA de PIPE_PRODUCTOS cuando la hoja todavía no tiene FASE ni SIGUIENTE_PASO (antes de la ORD-ECO-053). */
export const TEXTO_ETAPA: Readonly<Record<string, { fase: string; siguiente: string }>> = {
  SUGERIDO: { fase: 'Idea', siguiente: 'Decide si se evalúa.' },
  EVALUANDO: { fase: 'Evaluando', siguiente: 'Espera el resultado de la semana.' },
  COTIZANDO: { fase: 'Cotizando', siguiente: 'Da seguimiento a los proveedores.' },
  MUESTRA: { fase: 'Muestra', siguiente: 'Revisa la muestra y decide la compra.' },
  EN_VENTA: { fase: 'En venta', siguiente: 'Vigila ventas y reposición.' },
}
export const ETAPA_DESCONOCIDA = { fase: 'En proceso', siguiente: 'Revisa su ficha en Compras.' }
export const ETAPA_DESCARTADO = 'DESCARTADO'

/** MODO de AMZ_BITACORA (RADAROS src/79_BitacoraAmz.js). */
export const TEXTO_MODO: Readonly<Record<string, string>> = {
  EVALUAR: 'la revisión de tus ideas',
  DESCUBRIR: 'la búsqueda de productos nuevos',
  NICHO: 'la medición de la competencia',
  DICTAMEN: 'el filtro semanal',
  BARRIDO: 'el recorrido de Amazon',
  NICHOS: 'la revisión de categorías',
}
export const MODO_DESCONOCIDO = 'una tarea del buscador'

/** ESTADO de AMZ_BITACORA que cuenta como problema, en palabras. Los demás estados no se mencionan. */
export const TEXTO_ESTADO_PROBLEMA: Readonly<Record<string, string>> = {
  ERROR: 'terminó con un error',
  PARCIAL: 'quedó a medias',
  NEEDS_REAUTH: 'necesita que vuelvas a autorizar la conexión con Amazon',
}

/**
 * Patrón de «código visible» para la prueba del criterio 2: palabras en MAYÚSCULAS con guion bajo, K1 a K6 y los
 * veredictos de una sola palabra. Los ID (EC-004, PRD-0003, ASIN) no entran: van en gris pequeño.
 */
export const PATRON_CODIGO = /\b(?:[A-Z][A-Z0-9]*_[A-Z0-9_]+|K[1-6]|KILL|INVESTIGAR|RFQ|SIN_DATO|FALLA|DESCUBRIR|SCORING|BARRIDO|DICTAMEN|COTIZANDO|EVALUANDO|SUGERIDO)\b/
