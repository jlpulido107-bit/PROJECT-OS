#!/usr/bin/env node
/**
 * Valida y evalúa un archivo de EVIDENCIA SANEADA de la V1.6 (docs/operacion-v1-6/evidencia.md).
 *
 *   node scripts/ops/evidencia.mjs <archivo.json> [--json]
 *
 * - Offline: solo lee el archivo indicado. No invoca gcloud ni la red.
 * - Primero RECHAZA (código 4) la evidencia con correos de personas, tokens, claves, IDs de facturación, valores de
 *   variables o contenido de logs. Nunca imprime el valor encontrado: solo la ruta JSON y el tipo.
 * - Después evalúa cada control con reglas explícitas: OK / FALLO / NO_VERIFICADO. Un campo vacío, un error de
 *   permisos o un control sin regla es NO_VERIFICADO, nunca OK.
 * - Código de salida: 0 todo OK · 1 algún FALLO · 3 sin fallos pero con NO_VERIFICADO · 4 evidencia rechazada ·
 *   2 uso incorrecto o archivo ilegible.
 */
import { readFileSync } from 'node:fs'
import { codigoDeSalida, linea, PRODUCCION as P } from './produccion-v1-6.mjs'

// ---- Saneamiento: lo que nunca debe aparecer en una evidencia ----
const CLAVES_DE_LOG = new Set(['textPayload', 'jsonPayload', 'protoPayload', 'httpRequest'])
const CUENTA_DEL_PROYECTO = new RegExp(`^[a-z][a-z0-9-]*@${P.proyecto}\\.iam\\.gserviceaccount\\.com$`)
const DETECTORES = [
  ['clave privada', /-----BEGIN [A-Z ]*PRIVATE KEY-----|"private_key"/],
  ['token OAuth', /ya29\.[0-9A-Za-z_-]{10,}/],
  ['cabecera Bearer', /\bBearer\s+[A-Za-z0-9._-]{8,}/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['clave de API de Google', /AIza[0-9A-Za-z_-]{20,}/],
  ['secreto de cliente OAuth', /GOCSPX-/],
  ['ID de cuenta de facturación', /\b[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}\b/],
  ['valor de variable de entorno', /\b[A-Z][A-Z0-9_]{2,}=\S/],
  ['contenido de log', /"(textPayload|jsonPayload|protoPayload|httpRequest)"/],
]
const CORREO = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

function correoPermitido(c) {
  const sinPrefijo = c.replace(/^(serviceAccount|user|group):/, '')
  // Cuentas de servicio (del proyecto o gestionadas por Google): no son datos personales.
  return CUENTA_DEL_PROYECTO.test(sinPrefijo) || /@([a-z0-9-]+\.)*gserviceaccount\.com$/.test(sinPrefijo)
    || /@example\.(com|org)$/i.test(sinPrefijo)
}

/** Recorre todas las cadenas (y claves) del JSON; devuelve [ruta, tipo] por hallazgo, sin el valor. */
export function hallazgosSensibles(dato, ruta = '$') {
  const out = []
  const revisar = (texto, donde) => {
    for (const [tipo, re] of DETECTORES) if (re.test(texto)) out.push([donde, tipo])
    for (const c of texto.match(CORREO) ?? []) if (!correoPermitido(c)) out.push([donde, 'correo de persona'])
  }
  if (typeof dato === 'string') revisar(dato, ruta)
  else if (Array.isArray(dato)) dato.forEach((v, i) => out.push(...hallazgosSensibles(v, `${ruta}[${i}]`)))
  else if (dato && typeof dato === 'object') {
    for (const [k, v] of Object.entries(dato)) {
      revisar(k, `${ruta}.<clave>`)
      if (CLAVES_DE_LOG.has(k)) out.push([`${ruta}.${k}`, 'contenido de log'])
      out.push(...hallazgosSensibles(v, `${ruta}.${k}`))
    }
  }
  return out
}

// ---- Evaluación por control ----
const vacio = (v) => v === undefined || v === null || v === ''
const lista = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[,;\s]+/)).map((x) => String(x).trim()).filter(Boolean)
const r = (id, estado, motivo) => ({ id, estado, motivo })

const REGLAS = {
  A1: (o) => (vacio(o.imagen) ? ['NO_VERIFICADO', 'falta la imagen observada']
    : o.imagen === `${P.imagenBase}@${P.digest}` ? ['OK', 'la revisión sirve el digest desplegado']
      : ['FALLO', 'la imagen observada no es el digest desplegado']),
  A2: (o) => (o.urls == null || lista(o.urls).length === 0 ? ['NO_VERIFICADO', 'faltan las URLs observadas']
    : lista(o.urls).includes(P.url) ? ['OK', 'Cloud Run publica la URL de NextAuth y OAuth']
      : ['FALLO', 'la URL de NextAuth/OAuth no está entre las publicadas']),
  A4: (o) => {
    const v = lista(o.variables)
    // Una revisión real siempre tiene variables: una lista vacía es un campo sin rellenar, no un OK.
    if (v.length === 0) return ['NO_VERIFICADO', 'faltan los nombres de variables']
    const escritura = P.variablesEscritura.filter((x) => v.includes(x))
    return escritura.length ? ['FALLO', `variables de escritura presentes: ${escritura.join(', ')}`] : ['OK', 'sin variables de escritura']
  },
  A5: (o) => {
    if (vacio(o.cuenta) || o.roles_proyecto == null) return ['NO_VERIFICADO', 'faltan la cuenta o los roles']
    if (o.cuenta !== P.cuentaRuntime) return ['FALLO', 'el servicio no corre con la cuenta runtime']
    return lista(o.roles_proyecto).length ? ['FALLO', 'la cuenta runtime tiene roles de proyecto'] : ['OK', 'cuenta runtime sin roles de proyecto']
  },
  A6: (o) => {
    if (!P.secretos.includes(o.secreto)) return ['NO_VERIFICADO', 'secreto no reconocido']
    if (o.miembros == null || lista(o.miembros).length === 0) return ['NO_VERIFICADO', `faltan los miembros de ${o.secreto}`]
    const esperado = `roles/secretmanager.secretAccessor serviceAccount:${P.cuentaRuntime}`
    const filas = (Array.isArray(o.miembros) ? o.miembros : [o.miembros]).map((x) => String(x).replace(/\s+/g, ' ').trim())
    if (filas.length !== 1 || filas[0] !== esperado) return ['FALLO', `${o.secreto}: acceso distinto de una sola fila para la cuenta runtime`]
    const habilitadas = (o.versiones ?? []).map(String).filter((x) => /ENABLED/.test(x))
    if (o.versiones != null && habilitadas.length > 1) return ['FALLO', `${o.secreto}: más de una versión habilitada (facturación y rotación)`]
    return ['OK', `${o.secreto}: solo la cuenta runtime lo lee`]
  },
  A7: (o) => {
    if ('instancias_max_30d' in o) {
      if (vacio(o.instancias_max_30d)) return ['NO_VERIFICADO', 'falta el máximo de instancias observado']
      return Number(o.instancias_max_30d) <= 1 ? ['OK', 'nunca hubo más de 1 instancia en 30 días']
        : ['FALLO', `se observaron ${Number(o.instancias_max_30d)} instancias: el tope efectivo no es 1 (D-1)`]
    }
    if ([o.revision_minScale, o.revision_maxScale, o.cpu_throttling].some(vacio)) return ['NO_VERIFICADO', 'faltan anotaciones de revisión']
    if (String(o.revision_minScale) !== '0' || String(o.revision_maxScale) !== '1' || String(o.cpu_throttling) !== 'true') {
      return ['FALLO', 'la revisión no tiene minScale 0, maxScale 1 y cpu-throttling true']
    }
    if (o.servicio_maxScale === undefined || o.servicio_maxScale === '') return ['NO_VERIFICADO', 'falta el maxScale de servicio (anotar "ninguno" si no existe)']
    const s = String(o.servicio_maxScale).trim().toLowerCase()
    if (s === 'ninguno' || s === '1') return ['OK', 'límites de revisión y servicio coherentes (tope 1)']
    return ['NO_VERIFICADO', `maxScale de servicio ${s} frente a revisión 1: tope efectivo ambiguo (D-1); nunca se da por bueno`]
  },
  A8: (o) => (vacio(o.cuenta_build) ? ['NO_VERIFICADO', 'falta la cuenta del build']
    : o.cuenta_build === `projects/${P.proyecto}/serviceAccounts/${P.cuentaBuild}` || o.cuenta_build === P.cuentaBuild
      ? ['OK', 'el build usó la cuenta dedicada'] : ['FALLO', 'el build no usó la cuenta dedicada']),
  A9: (o) => {
    if (vacio(o.digest_produccion)) return ['NO_VERIFICADO', 'falta el digest de la etiqueta produccion']
    if (/NOT_FOUND|no existe/i.test(o.digest_produccion)) return ['FALLO', 'la etiqueta produccion no existe: la imagen desplegada no tiene protección explícita']
    return o.digest_produccion === P.digest ? ['OK', 'produccion apunta al digest desplegado']
      : ['FALLO', 'produccion apunta a otro digest']
  },
  F3: (o) => {
    if ('check' in o) {
      if (vacio(o.check)) return ['NO_VERIFICADO', 'falta el resultado de --check']
      return o.check === 'PERMITIDO' ? ['OK', 'política de limpieza activa'] : ['FALLO', `--check: ${o.check === 'BLOQUEADO' ? 'BLOQUEADO' : 'resultado inesperado'}`]
    }
    if (vacio(o.imagenes) || vacio(o.mayores_30_dias_no_protegidas)) return ['NO_VERIFICADO', 'faltan los conteos de imágenes']
    if (Number(o.imagenes) < 5) return ['NO_VERIFICADO', 'menos de 5 imágenes: el efecto de la limpieza aún no es observable']
    return Number(o.mayores_30_dias_no_protegidas) === 0 ? ['OK', 'no quedan imágenes no protegidas de más de 30 días']
      : ['FALLO', 'hay imágenes no protegidas de más de 30 días: la limpieza no actúa como se espera']
  },
  E1: (o) => (vacio(o.coincidencias) ? ['NO_VERIFICADO', `falta el conteo de «${o.patron ?? '?'}»`]
    : Number(o.coincidencias) === 0 ? ['OK', `0 coincidencias de ${o.patron}`]
      : ['FALLO', `${Number(o.coincidencias)} coincidencias de ${o.patron}: seguir el runbook operativo §5 sin copiar líneas`]),
  G2: (o) => {
    if (o.revisiones == null || lista(o.revisiones).length === 0) return ['NO_VERIFICADO', 'faltan las revisiones']
    return lista(o.revisiones).filter((x) => x.startsWith(`${P.servicio}-`)).length >= 2
      ? ['OK', 'existe al menos una revisión anterior (comprobar su imagen con A9)']
      : ['NO_VERIFICADO', 'una sola revisión: rollback NO_APLICA']
  },
}
/** Controles que solo puede comprobar una persona: el propietario anota OK o FALLO, sin datos. */
const MANUALES = new Set(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'D1', 'D2', 'E2', 'F1', 'F2', 'G1', 'G3'])

export function evaluar(evidencia) {
  const errores = []
  if (evidencia?.version !== 1) errores.push('version debe ser 1')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(evidencia?.fecha ?? ''))) errores.push('fecha debe ser AAAA-MM-DD')
  if (!Array.isArray(evidencia?.controles) || evidencia.controles.length === 0) errores.push('controles debe ser una lista no vacía')
  if (errores.length) return { errores, resultados: [] }

  const resultados = []
  if (evidencia.commit_desplegado !== P.commit) {
    resultados.push(r('VER', 'FALLO', 'la evidencia corresponde a otro commit desplegado: no se evalúa contra esta versión'))
    return { errores, resultados }
  }
  if (evidencia.revision !== undefined && evidencia.revision !== P.revision) {
    resultados.push(r('VER', 'NO_VERIFICADO', 'revisión distinta de la registrada: revisar si hubo un despliegue posterior'))
  }
  for (const c of evidencia.controles) {
    const id = String(c?.id ?? '?')
    const o = c?.observado ?? {}
    if (typeof o.error === 'string' && o.error) {
      resultados.push(r(id, 'NO_VERIFICADO', /PERMISSION_DENIED|403|denegad/i.test(o.error) ? 'permiso denegado al leer' : 'la lectura falló'))
    } else if (REGLAS[id]) {
      const [estado, motivo] = REGLAS[id](o)
      resultados.push(r(id, estado, motivo))
    } else if (MANUALES.has(id)) {
      const v = String(o.resultado ?? '').toUpperCase()
      resultados.push(r(id, v === 'OK' ? 'OK' : v === 'FALLO' ? 'FALLO' : 'NO_VERIFICADO',
        v === 'OK' || v === 'FALLO' ? `comprobación humana: ${v}` : 'falta el resultado (OK o FALLO) de la comprobación humana'))
    } else {
      resultados.push(r(id, 'NO_VERIFICADO', 'control sin regla de evaluación'))
    }
  }
  return { errores, resultados }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const archivo = args.find((a) => !a.startsWith('--'))
  if (!archivo || args.some((a) => a.startsWith('--') && a !== '--json')) {
    console.error('Uso: node scripts/ops/evidencia.mjs <archivo.json> [--json]')
    process.exit(2)
  }
  let evidencia
  try {
    evidencia = JSON.parse(readFileSync(archivo, 'utf8'))
  } catch {
    console.error('No se pudo leer el archivo como JSON.')
    process.exit(2)
  }
  const sensibles = hallazgosSensibles(evidencia)
  if (sensibles.length) {
    console.error('EVIDENCIA RECHAZADA: contiene datos que no deben registrarse (no se muestran los valores):')
    for (const [ruta, tipo] of sensibles) console.error(` - ${ruta}: ${tipo}`)
    process.exit(4)
  }
  const { errores, resultados } = evaluar(evidencia)
  if (errores.length) {
    console.error(`EVIDENCIA RECHAZADA: formato no válido (${errores.join('; ')})`)
    process.exit(4)
  }
  const codigo = codigoDeSalida(resultados)
  if (args.includes('--json')) console.log(JSON.stringify({ version: 1, resultados, codigo }, null, 2))
  else {
    console.log(`PROJECT-OS V1.6 — evaluación de evidencia (${evidencia.fecha}, commit ${String(evidencia.commit_desplegado).slice(0, 7)})`)
    if (evidencia.ejemplo_sintetico === true) console.log('EJEMPLO SINTÉTICO: los valores son inventados; esto NO es evidencia de producción.')
    for (const x of resultados) console.log(linea(x))
    const n = (e) => resultados.filter((x) => x.estado === e).length
    console.log(`\nOK ${n('OK')} · FALLO ${n('FALLO')} · NO_VERIFICADO ${n('NO_VERIFICADO')} (no cuenta como OK)`)
  }
  process.exit(codigo)
}
