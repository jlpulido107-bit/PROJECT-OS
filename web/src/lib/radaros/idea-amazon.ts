/**
 * Enlace de Amazon México → ASIN y tarjeta de texto del alta rápida de una idea (ORD-POS-160, DEC-ECO-017). Lógica pura
 * y sin dependencias: la usan el servidor (`idea.alta`, ideas-alta.ts) y el formulario del navegador
 * (components/eco/idea-rapida.tsx), que NO escribe ni llama a ninguna ruta: solo arma el texto para POS · Ideas.
 */

export const NOMBRE_MAX = 160
export const PALABRA_MAX = 200
export const ENLACE_MAX = 2000

/** ASIN como lo valida RADAROS (`esAsin`, src/70_Puro.js): 10 caracteres, mayúsculas y dígitos. */
export const ASIN = /^[A-Z0-9]{10}$/
const HOSTS_AMAZON_MX = new Set(['amazon.com.mx', 'www.amazon.com.mx'])

/**
 * ASIN de un enlace de producto de Amazon México, o null. Solo `https://` (o `http://`) con host `amazon.com.mx` o
 * `www.amazon.com.mx`, sin usuario ni puerto, y ruta con `/dp/<ASIN>` o `/gp/product/<ASIN>`. Otro dominio (amazon.com,
 * enlaces cortos), otra forma o dos ASIN distintos en la ruta dan null: nunca se adivina.
 */
export function asinDeEnlaceAmazon(enlace: string): string | null {
  let url: URL
  try {
    url = new URL(enlace.trim())
  } catch {
    return null
  }
  if (!['https:', 'http:'].includes(url.protocol) || !HOSTS_AMAZON_MX.has(url.hostname) || url.port || url.username || url.password) return null
  const asins = new Set([...url.pathname.matchAll(/\/(?:dp|gp\/product)\/([^/]+)(?=\/|$)/g)].map((m) => m[1]!))
  const [asin] = asins
  return asins.size === 1 && asin && ASIN.test(asin) ? asin : null
}

export const ERROR_ENLACE = 'Debe ser un enlace de producto de amazon.com.mx con /dp/ o /gp/product/ y un ASIN de 10 caracteres (mayúsculas y dígitos)'

export interface IdeaRapida {
  nombre: string
  enlace: string
  palabra: string
}

export type TarjetaIdeaRapida =
  | { ok: true; asin: string; texto: string }
  | { ok: false; errores: Partial<Record<keyof IdeaRapida, string>> }

/** Una línea: sin saltos ni espacios repetidos. */
const linea = (v: string) => v.replace(/\s+/g, ' ').trim()

/**
 * Tarjeta de texto para pegar en POS · Ideas, con los nombres de campo de `idea.alta`. No autoriza nada: la idea solo se
 * da de alta cuando POS · Ideas la pone en un paquete, el propietario responde «sí PAQ» y el PM lo verifica.
 */
export function tarjetaIdeaRapida(idea: IdeaRapida): TarjetaIdeaRapida {
  const nombre = linea(idea.nombre)
  const enlace = idea.enlace.trim()
  const palabra = linea(idea.palabra)
  const errores: Partial<Record<keyof IdeaRapida, string>> = {}
  if (!nombre) errores.nombre = 'Requerido'
  else if (nombre.length > NOMBRE_MAX) errores.nombre = `Máximo ${NOMBRE_MAX} caracteres`
  const asin = enlace.length <= ENLACE_MAX ? asinDeEnlaceAmazon(enlace) : null
  if (!enlace) errores.enlace = 'Requerido'
  else if (!asin) errores.enlace = ERROR_ENLACE
  if (!palabra) errores.palabra = 'Requerido'
  else if (palabra.length > PALABRA_MAX) errores.palabra = `Máximo ${PALABRA_MAX} caracteres`
  if (!asin || Object.keys(errores).length) return { ok: false, errores }
  const texto = [
    'Idea nueva para RADAROS (alta rápida, idea.alta, DEC-ECO-017)',
    `- producto: ${nombre}`,
    `- enlaceAmazon: ${enlace}`,
    `- ASIN que saldrá del enlace: ${asin}`,
    `- palabraClave: ${palabra}`,
    'Inclúyela en un paquete PAQ para el PM. No se da de alta sin el «sí PAQ» del propietario.',
  ].join('\n')
  return { ok: true, asin, texto }
}
