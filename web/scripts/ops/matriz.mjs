#!/usr/bin/env node
/**
 * Reglas de la MATRIZ DE ACEPTACIÓN de la V1.6 (docs/operacion-v1-6/matriz-aceptacion.md). Offline: solo lee archivos.
 *
 *   node scripts/ops/matriz.mjs [--root <repo>] [--json]
 *
 * Convierte en reglas comprobables lo que la Misión 014 exige a la matriz («cero falsos aprobados»):
 * - los 29 controles originales, en orden, con un estado del vocabulario (VERIFICADO, PARCIAL, PENDIENTE, NO_APLICA);
 * - el resumen coincide con las filas;
 * - VERIFICADO exige evidencia REAL del propietario (P, con su EV-xx del registro de la línea base, que allí también es P)
 *   o, solo para los controles de código (D3), CI; nunca solo un reporte (R), una simulación (S), un requisito de tiempo
 *   (T) o una decisión pendiente (DEC);
 * - PARCIAL exige evidencia real (P o R) y lo que falta; PENDIENTE no tiene evidencia real; NO_APLICA solo donde está
 *   justificado (G2) y con la condición que lo hace aplicable;
 * - H no puede aprobarse con controles sin evidencia salvo excepción explícita del propietario;
 * - la identidad (commit, revisión y digest) coincide con la línea base: si cambia, hay que revalidar;
 * - el ejemplo sintético nunca se cita.
 * Código de salida: 0 sin violaciones · 1 con violaciones · 2 uso incorrecto o archivo ausente.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { PRODUCCION } from './produccion-v1-6.mjs'

export const IDS = Object.freeze(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'B1', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'D1', 'D2', 'D3', 'E1', 'E2', 'F1', 'F2', 'F3', 'G1', 'G2', 'G3', 'H'])
export const ESTADOS_MATRIZ = Object.freeze(['VERIFICADO', 'PARCIAL', 'PENDIENTE', 'NO_APLICA'])
/** Etiquetas de evidencia: P real con salida o resultado concreto · R reporte real sin salida · CI prueba automatizada ·
 *  S simulación con fixtures · T depende del paso del tiempo · DEC decisión de riesgo pendiente del propietario. */
export const ETIQUETAS = Object.freeze(['P', 'R', 'CI', 'S', 'T', 'DEC'])
/** Único NO_APLICA justificado hoy, y por qué: no se crea una revisión solo para cerrar el control. */
export const NO_APLICA_PERMITIDO = Object.freeze({ G2: 'una sola revisión' })
/** Únicos controles que la CI puede verificar sin evidencia real («VERIFICADO (código)»): D3 es una propiedad del código
 *  (solo GET y alcance de lectura); su prueba real son D1 y D2. En cualquier otro control, «(código)» no sustituye a P. */
export const VERIFICABLE_POR_CODIGO = Object.freeze(['D3'])
/** Límites que el estado debe reflejar mientras el control no esté VERIFICADO (Misión 014, §5 y §9). */
export const ETIQUETA_OBLIGATORIA = Object.freeze({ E1: 'T', F3: 'T', C3: 'DEC', G1: 'DEC' })
/** Lo que la evidencia real debe nombrar para que el control pueda pasar a VERIFICADO (condiciones de cierre).
 *  C2 (R3-2): una cuenta ELEGIBLE para el login de Google y el rechazo DE LA APP; un rechazo de Google no prueba la lista. */
export const CONDICION_DE_CIERRE = Object.freeze({
  A2: /callback/i, C1: /12\/12|12 pestañas/i, C2: /^(?=[\s\S]*\belegible\b)(?=[\s\S]*rechazo de la app)/i, C3: /403/, D1: /historial/i, D2: /Compartir|Lector/i,
  E1: /caduc|30 días/i, F1: /presupuesto/i, F2: /gasto|costo/i, F3: /imágenes/i, G1: /ensayo/i, G3: /runbook|procedimiento/i,
  H: /aprobación del propietario/i,
})

const celdas = (l) => l.split('|').slice(1, -1).map((c) => c.trim())
const sinMarcas = (t) => t.replace(/\*\*/g, '')
const etiquetas = (t) => [...String(t).matchAll(/\*\*(P|R|CI|S|T|DEC|H|O)(?: \+ CI)?:\*\*/g)].map((m) => m[1])
const vacia = (t) => ['', '—', '-'].includes(sinMarcas(String(t ?? '')).trim())

/** Extrae identidad, filas, resumen y excepciones del texto de la matriz. */
export function leerMatriz(texto) {
  const desde = texto.indexOf('## 2. Matriz')
  const hasta = texto.indexOf('**Resumen', desde)
  const tabla = desde > -1 ? texto.slice(desde, hasta > -1 ? hasta : undefined) : ''
  const filas = tabla.split('\n').filter((l) => /^\| [A-H]\d? \|/.test(l)).map((l) => {
    const c = celdas(l)
    const estadoTexto = sinMarcas(c[2] ?? '').trim()
    return {
      id: c[0], columnas: c.length, control: c[1] ?? '', estadoTexto,
      estado: estadoTexto.split(/[\s(—]/)[0] ?? '', calificador: /\(([^)]*)\)/.exec(estadoTexto)?.[1] ?? '',
      real: c[3] ?? '', tecnica: c[4] ?? '', tiempo: c[5] ?? '', falta: c[6] ?? '', siguiente: c[7] ?? '',
    }
  })
  const resumen = {}
  const bloqueResumen = hasta > -1 ? texto.slice(hasta, texto.indexOf('\n## ', hasta) > -1 ? texto.indexOf('\n## ', hasta) : undefined) : ''
  for (const m of bloqueResumen.matchAll(/^\| (VERIFICADO|PARCIAL|PENDIENTE|NO_APLICA) \((\d+)\) \| ([^|]*) \|/gm)) {
    resumen[m[1]] = { n: Number(m[2]), ids: m[3].replace(/\s*\([^)]*\)/g, '').split(',').map((s) => s.trim()).filter(Boolean) }
  }
  const excepciones = []
  const ie = texto.search(/^## (\d+\. )?Excepciones aceptadas por el propietario/m)
  if (ie > -1) {
    const bloque = texto.slice(ie, texto.indexOf('\n## ', ie + 3) > -1 ? texto.indexOf('\n## ', ie + 3) : undefined)
    for (const l of bloque.split('\n').filter((x) => /^\| [A-H]\d? \|/.test(x))) {
      const c = celdas(l)
      excepciones.push({ id: c[0], excepcion: c[1] ?? '', fecha: c[2] ?? '', referencia: c[3] ?? '' })
    }
  }
  const cabecera = desde > -1 ? texto.slice(0, desde) : texto
  return { filas, resumen, excepciones, cabecera }
}

/**
 * Valida la matriz. `lineaBase` (texto de linea-base-v1-6.md) permite comprobar que cada EV-xx citado existe;
 * `produccion` permite simular un cambio de identidad en las pruebas.
 */
export function validarMatriz(texto, { lineaBase = null, produccion = PRODUCCION } = {}) {
  const v = []
  const { filas, resumen, excepciones, cabecera } = leerMatriz(texto)
  const ids = filas.map((f) => f.id)
  if (JSON.stringify(ids) !== JSON.stringify(IDS)) v.push(`controles: se esperan ${IDS.length} filas A1…H en orden; hay ${ids.join(',') || 'ninguna'}`)
  // Identidad: un cambio de commit, revisión o digest invalida la matriz hasta revalidarla.
  for (const [campo, valor] of [['commit', produccion.commit], ['revisión', produccion.revision], ['digest', produccion.digest]]) {
    if (!cabecera.includes(valor)) v.push(`identidad: la cabecera no cita el ${campo} de la línea base (${String(valor).slice(0, 19)}…): revalidar la matriz`)
    if (lineaBase !== null && !lineaBase.includes(valor)) v.push(`identidad: la línea base no cita el ${campo} vigente: revalidar`)
  }
  if (/evidencia-ejemplo/.test(texto)) v.push('sintético: la matriz cita el ejemplo sintético como evidencia')
  // Registro de la línea base: EV-xx → tipo (columna «Tipo»: P con salida, R reporte sin salida).
  const registro = new Map(lineaBase === null ? [] : lineaBase.split('\n').filter((l) => /^\| EV-\d{2} \|/.test(l)).map((l) => [celdas(l)[0], celdas(l)[4]]))
  for (const [ev, tipo] of registro) if (!['P', 'R'].includes(tipo)) v.push(`registro: ${ev} sin tipo P o R en la línea base`)

  for (const f of filas) {
    const tag = (t) => etiquetas(`${f.real} ${f.tecnica} ${f.tiempo}`).includes(t)
    if (f.columnas !== 8) v.push(`${f.id}: se esperan 8 columnas, hay ${f.columnas}`)
    if (!ESTADOS_MATRIZ.includes(f.estado)) { v.push(`${f.id}: estado «${f.estado}» fuera del vocabulario`); continue }
    for (const t of etiquetas(`${f.real} ${f.tecnica} ${f.tiempo}`)) if (!ETIQUETAS.includes(t)) v.push(`${f.id}: etiqueta de evidencia desconocida ${t}`)
    // Cada etiqueta en su columna: real (P, R), técnica (CI, S), tiempo o decisión (T, DEC).
    const fuera = [...etiquetas(f.real).filter((t) => !['P', 'R'].includes(t)), ...etiquetas(f.tecnica).filter((t) => !['CI', 'S'].includes(t)), ...etiquetas(f.tiempo).filter((t) => !['T', 'DEC'].includes(t))]
    if (fuera.length) v.push(`${f.id}: etiquetas en la columna equivocada (${fuera.join(', ')})`)
    const evs = [...f.real.matchAll(/EV-\d{2}/g)].map((m) => m[0])
    if (etiquetas(f.real).includes('P') && evs.length === 0) v.push(`${f.id}: evidencia P sin referencia EV-xx al registro de la línea base`)
    if (lineaBase !== null) for (const ev of evs) if (!registro.has(ev)) v.push(`${f.id}: cita ${ev}, que no está en el registro de la línea base`)
    // Lo citado como P debe ser P en el registro: un reporte sin salida (R) no se presenta como resultado concreto.
    const evsP = f.real.split(/(?=\*\*(?:P|R)(?: \+ CI)?:\*\*)/).filter((s) => /^\*\*P(?: \+ CI)?:\*\*/.test(s)).flatMap((s) => [...s.matchAll(/EV-\d{2}/g)].map((m) => m[0]))
    for (const ev of new Set(evsP)) if (registro.get(ev) === 'R') v.push(`${f.id}: cita ${ev} como P, pero el registro de la línea base lo clasifica como R (reporte sin salida)`)
    const real = tag('P') || tag('R')
    if (f.estado === 'VERIFICADO') {
      const deCodigo = VERIFICABLE_POR_CODIGO.includes(f.id) && /código/i.test(f.calificador)
      if (!(tag('P') || (deCodigo && tag('CI')))) v.push(`${f.id}: VERIFICADO sin evidencia real del propietario (P)${deCodigo ? ' ni CI' : ''}: un reporte, una simulación o una plantilla no bastan`)
      if (!vacia(f.tiempo)) v.push(`${f.id}: VERIFICADO con un requisito de tiempo o una decisión pendiente`)
      if (!vacia(f.falta)) v.push(`${f.id}: VERIFICADO con evidencia faltante`)
      if (CONDICION_DE_CIERRE[f.id] && !CONDICION_DE_CIERRE[f.id].test(f.real)) v.push(`${f.id}: VERIFICADO sin la evidencia real que exige su condición de cierre`)
    } else {
      if (vacia(f.falta)) v.push(`${f.id}: ${f.estado} sin indicar qué falta`)
      if (ETIQUETA_OBLIGATORIA[f.id] && !tag(ETIQUETA_OBLIGATORIA[f.id])) v.push(`${f.id}: debe reflejar su límite con la etiqueta ${ETIQUETA_OBLIGATORIA[f.id]}`)
    }
    if (f.estado === 'PARCIAL' && !real) v.push(`${f.id}: PARCIAL sin evidencia real (P o R): debería ser PENDIENTE`)
    if (f.estado === 'PENDIENTE' && real) v.push(`${f.id}: PENDIENTE con evidencia real: debería ser PARCIAL`)
    if (f.estado === 'NO_APLICA') {
      if (!(f.id in NO_APLICA_PERMITIDO)) v.push(`${f.id}: NO_APLICA no justificado (no sustituye a una prueba pendiente)`)
      if (!/hasta/i.test(`${f.estadoTexto} ${f.falta} ${f.siguiente}`)) v.push(`${f.id}: NO_APLICA sin la condición que lo hará aplicable («hasta …»)`)
    }
  }
  // Resumen = filas.
  for (const e of ESTADOS_MATRIZ) {
    const deFilas = filas.filter((f) => f.estado === e).map((f) => f.id)
    const r = resumen[e]
    if (!r) { if (deFilas.length) v.push(`resumen: falta la fila ${e}`); continue }
    if (r.n !== deFilas.length || JSON.stringify(r.ids) !== JSON.stringify(deFilas)) v.push(`resumen: ${e} dice ${r.n} (${r.ids.join(', ')}), las filas dan ${deFilas.length} (${deFilas.join(', ')})`)
  }
  // H: no se aprueba con controles sin evidencia salvo excepción explícita del propietario (con fecha y referencia).
  for (const x of excepciones) {
    if (!IDS.includes(x.id) || x.id === 'H') v.push(`excepciones: control desconocido ${x.id}`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(x.fecha) || vacia(x.referencia)) v.push(`excepciones: ${x.id} sin fecha o sin referencia a la aprobación del propietario`)
  }
  const h = filas.find((f) => f.id === 'H')
  if (h?.estado === 'VERIFICADO') {
    const aceptadas = new Set(excepciones.map((x) => x.id))
    const bloquean = filas.filter((f) => f.id !== 'H' && !['VERIFICADO', 'NO_APLICA'].includes(f.estado) && !aceptadas.has(f.id)).map((f) => f.id)
    if (bloquean.length) v.push(`H: ${h.estado} con controles sin evidencia ni excepción del propietario: ${bloquean.join(', ')}`)
  }
  return v
}

/** Conteo por estado calculado desde las filas (para el acta y el preflight de cierre). */
export function resumenCalculado(texto) {
  const { filas } = leerMatriz(texto)
  return Object.fromEntries(ESTADOS_MATRIZ.map((e) => [e, filas.filter((f) => f.estado === e).map((f) => f.id)]))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const ri = args.indexOf('--root')
  if (args.some((a, i) => !['--root', '--json'].includes(a) && args[i - 1] !== '--root') || (ri > -1 && !args[ri + 1])) {
    console.error('Uso: node scripts/ops/matriz.mjs [--root <repo>] [--json]')
    process.exit(2)
  }
  const root = path.resolve(ri > -1 ? args[ri + 1] : path.join(import.meta.dirname, '..', '..', '..'))
  const rel = (n) => path.join(root, 'docs', 'operacion-v1-6', n)
  if (!existsSync(rel('matriz-aceptacion.md'))) {
    console.error('No se encuentra docs/operacion-v1-6/matriz-aceptacion.md')
    process.exit(2)
  }
  const texto = readFileSync(rel('matriz-aceptacion.md'), 'utf8')
  const lineaBase = existsSync(rel('linea-base-v1-6.md')) ? readFileSync(rel('linea-base-v1-6.md'), 'utf8') : ''
  const violaciones = validarMatriz(texto, { lineaBase })
  const resumen = resumenCalculado(texto)
  if (args.includes('--json')) console.log(JSON.stringify({ version: 1, violaciones, resumen }, null, 2))
  else {
    console.log('PROJECT-OS V1.6 — reglas de la matriz de aceptación (offline)')
    for (const e of ESTADOS_MATRIZ) console.log(`  ${e.padEnd(11)} ${String(resumen[e].length).padStart(2)}  ${resumen[e].join(', ')}`)
    console.log(violaciones.length ? `\n${violaciones.length} violación(es):\n${violaciones.map((x) => `  - ${x}`).join('\n')}` : '\nSin violaciones: ningún falso aprobado según las reglas.')
  }
  process.exit(violaciones.length ? 1 : 0)
}
