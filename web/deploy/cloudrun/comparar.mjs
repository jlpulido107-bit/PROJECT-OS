#!/usr/bin/env node
/**
 * Compara el YAML renderizado con la revisión activa (JSON de `gcloud run services describe`) para
 * `deploy.sh --solo-imagen` (ORD-POS-162): imprime, uno por línea, el NOMBRE de cada campo o variable que cambiaría,
 * fuera de la imagen y de DEPLOY_COMMIT_SHA. Nunca imprime valores. No contacta a Google Cloud.
 *
 *   node deploy/cloudrun/comparar.mjs service.yaml activa.json
 *
 * Falla cerrado: sale 1 si el YAML usa sintaxis que este lector no entiende o si la activa no es JSON, y cuenta como
 * diferencia todo campo de la activa que el YAML no trae y que no está en la lista corta de lo que Cloud Run agrega solo.
 */
import { readFileSync } from 'node:fs'

const CLAVE = /^([A-Za-z0-9_./-]+):(?: +(.*))?$/
const PLANO = /^[A-Za-z0-9_./:@+=-]+$/

function escalar(texto, n) {
  const comillas = /^'([^']*)'$/.exec(texto) ?? /^"([^"\\]*)"$/.exec(texto)
  if (comillas) return comillas[1]
  if (!PLANO.test(texto) || texto.endsWith(':')) throw new Error(`línea ${n}: valor con sintaxis no admitida`)
  return texto
}

/**
 * Lector del subconjunto de YAML que produce render.mjs: mapas y listas de mapas en bloque, con escalares planos o
 * entre comillas. Todo escalar se devuelve como texto. Cualquier otra sintaxis lanza un error (solo con el número de línea).
 */
export function leerYaml(texto) {
  const lineas = []
  texto.split('\n').forEach((cruda, i) => {
    if (/^\s*(#.*)?$/.test(cruda)) return
    const sangria = /^ */.exec(cruda)[0].length
    if (cruda[sangria] === '\t') throw new Error(`línea ${i + 1}: tabulador en la sangría`)
    lineas.push({ n: i + 1, sangria, texto: cruda.slice(sangria).trimEnd() })
  })
  let pos = 0
  const bloque = (sangria) => (lineas[pos].texto.startsWith('- ') ? lista(sangria) : mapa(sangria))
  function mapa(sangria) {
    const salida = {}
    while (pos < lineas.length && lineas[pos].sangria === sangria && !lineas[pos].texto.startsWith('- ')) {
      const { n, texto: linea } = lineas[pos]
      const m = CLAVE.exec(linea)
      if (!m) throw new Error(`línea ${n}: sintaxis no admitida`)
      if (Object.hasOwn(salida, m[1])) throw new Error(`línea ${n}: clave repetida`)
      pos += 1
      if (m[2] !== undefined) salida[m[1]] = escalar(m[2], n)
      else {
        if (pos >= lineas.length || lineas[pos].sangria <= sangria) throw new Error(`línea ${n}: clave sin valor`)
        salida[m[1]] = bloque(lineas[pos].sangria)
      }
    }
    if (pos < lineas.length && lineas[pos].sangria > sangria) throw new Error(`línea ${lineas[pos].n}: sangría inesperada`)
    return salida
  }
  function lista(sangria) {
    const salida = []
    while (pos < lineas.length && lineas[pos].sangria === sangria && lineas[pos].texto.startsWith('- ')) {
      // «- clave: valor» abre un mapa cuya sangría es la de la clave.
      const resto = lineas[pos].texto.slice(2)
      const extra = /^ */.exec(resto)[0].length
      lineas[pos] = { n: lineas[pos].n, sangria: sangria + 2 + extra, texto: resto.slice(extra) }
      salida.push(mapa(sangria + 2 + extra))
    }
    if (pos < lineas.length && lineas[pos].sangria > sangria) throw new Error(`línea ${lineas[pos].n}: sangría inesperada`)
    return salida
  }
  if (!lineas.length) throw new Error('YAML vacío')
  const raiz = bloque(lineas[0].sangria)
  if (pos < lineas.length) throw new Error(`línea ${lineas[pos].n}: sangría inesperada`)
  return raiz
}

// Lo que cambia siempre en este modo: la imagen y la variable DEPLOY_COMMIT_SHA.
const CONTENEDOR = 'spec.template.spec.containers[0]'
const PERMITIDO = new Set([`${CONTENEDOR}.image`, `${CONTENEDOR}.env[DEPLOY_COMMIT_SHA]`])
// Lo que Cloud Run agrega por su cuenta a un servicio aplicado con `replace`: estado, identificadores, quién y con qué
// cliente lo modificó, el nombre de la revisión y del contenedor. Lista corta a propósito: lo que no esté aquí detiene.
const DEL_SISTEMA = [
  /^status(\.|$)/,
  /^metadata\.(namespace|selfLink|uid|resourceVersion|generation|creationTimestamp)$/,
  /^spec\.template\.metadata\.name$/,
  /^(metadata|spec\.template\.metadata)\.annotations\.(serving\.knative\.dev\/(creator|lastModifier)|run\.googleapis\.com\/(client-name|client-version|operation-id|ingress-status|urls))$/,
  /^(metadata|spec\.template\.metadata)\.labels\.(cloud\.googleapis\.com\/location|client\.knative\.dev\/nonce|run\.googleapis\.com\/startupProbeType)$/,
  /^spec\.template\.spec\.containers\[0\]\.name$/,
]
const esMapa = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const conNombre = (lista) => lista.every((e) => esMapa(e) && typeof e.name === 'string' && /^[A-Za-z0-9_.-]+$/.test(e.name))
const sinRepetir = (lista) => new Set(lista.map((e) => e.name)).size === lista.length
/** Nombre que se imprime: las variables de entorno por su nombre; lo demás, por su ruta. */
const nombre = (ruta) => (ruta.startsWith(`${CONTENEDOR}.env[`) ? ruta.slice(`${CONTENEDOR}.env[`.length).replace(/\].*$/, '') : ruta)

/**
 * Nombres (nunca valores) de lo que el YAML nuevo cambiaría respecto de la activa, fuera de la imagen y de
 * DEPLOY_COMMIT_SHA: valores distintos, campos que la activa no tiene y campos de la activa que el YAML no trae.
 */
export function diferencias(nuevo, activa) {
  const salida = new Set()
  const sistema = (ruta) => PERMITIDO.has(ruta) || DEL_SISTEMA.some((r) => r.test(ruta))
  // Todo lo que hay bajo un campo de la activa que el YAML no trae cuenta, salvo lo del sistema.
  function sobrante(b, ruta) {
    if (sistema(ruta)) return
    if (esMapa(b)) for (const [k, v] of Object.entries(b)) sobrante(v, `${ruta}.${k}`)
    else if (Array.isArray(b) && b.length) b.forEach((v, i) => sobrante(v, `${ruta}[${esMapa(v) && typeof v.name === 'string' ? v.name : i}]`))
    else if (!Array.isArray(b)) salida.add(nombre(ruta))
  }
  function comparar(a, b, ruta) {
    if (PERMITIDO.has(ruta)) return
    if (esMapa(a)) {
      if (!esMapa(b)) return void salida.add(nombre(ruta))
      for (const [k, v] of Object.entries(a)) comparar(v, b[k], ruta ? `${ruta}.${k}` : k)
      for (const [k, v] of Object.entries(b)) if (!Object.hasOwn(a, k)) sobrante(v, ruta ? `${ruta}.${k}` : k)
    } else if (Array.isArray(a)) {
      if (!Array.isArray(b)) return void salida.add(nombre(ruta))
      if (conNombre(a) && conNombre(b) && sinRepetir(a) && sinRepetir(b)) {
        for (const e of a) comparar(e, b.find((x) => x.name === e.name), `${ruta}[${e.name}]`)
        for (const e of b) if (!a.some((x) => x.name === e.name)) sobrante(e, `${ruta}[${e.name}]`)
      } else if (a.length !== b.length) salida.add(nombre(ruta))
      else a.forEach((e, i) => comparar(e, b[i], `${ruta}[${i}]`))
    } else if (!['string', 'number', 'boolean'].includes(typeof b) || String(b) !== a) salida.add(nombre(ruta))
  }
  comparar(nuevo, activa, '')
  return [...salida].sort()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const nuevo = leerYaml(readFileSync(process.argv[2], 'utf8'))
    let activa
    try { activa = JSON.parse(readFileSync(process.argv[3], 'utf8')) } catch { throw new Error('la revisión activa no es JSON válido') }
    if (!esMapa(activa) || nuevo.spec?.template?.spec?.containers?.length !== 1 || activa.spec?.template?.spec?.containers?.length !== 1) {
      throw new Error('se espera exactamente un contenedor en el YAML y en la revisión activa')
    }
    const lista = diferencias(nuevo, activa)
    if (lista.length) console.log(lista.join('\n'))
  } catch (error) {
    console.error(`No se pudo comparar: ${error.message}`)
    process.exit(1)
  }
}
