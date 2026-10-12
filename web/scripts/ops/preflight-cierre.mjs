#!/usr/bin/env node
/**
 * Preflight de CIERRE de la V1.6 (Misión 014): una sola tabla «CONTROL | ESTADO | EVIDENCIA | ACCIÓN PENDIENTE» con
 * todo lo que se puede comprobar OFFLINE desde el repositorio y, aparte, lo que exige producción, personas, facturación,
 * tiempo o decisiones del propietario, que queda SIEMPRE en NO_VERIFICADO (nunca OK).
 *
 *   node scripts/ops/preflight-cierre.mjs [--root <repo>] [--json] [--solo-repositorio]
 *
 * - Reutiliza, sin duplicarlas, las herramientas existentes: preflightAceptacion() (plantilla, código, workflows e
 *   identidad del código), comandosInseguros() del plan de inspección, el evaluador de evidencia y las reglas de la
 *   matriz. No invoca gcloud, curl ni la red; solo `git` local a través del preflight de aceptación.
 * - --solo-repositorio: solo los controles K1–K10 (lo que depende del repositorio).
 * - Código de salida: 0 todo OK · 1 algún FALLO · 3 sin fallos pero con NO_VERIFICADO · 2 uso incorrecto.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { evaluar, hallazgosSensibles } from './evidencia.mjs'
import { validarMatriz } from './matriz.mjs'
import { comandosInseguros, PASOS } from './plan-inspeccion.mjs'
import { preflightAceptacion } from './preflight-aceptacion.mjs'
import { codigoDeSalida, PRODUCCION as P } from './produccion-v1-6.mjs'

/** Documentos y herramientas que la aceptación necesita (K5). */
export const ARCHIVOS_DE_CIERRE = Object.freeze([
  'docs/estado-produccion-v1-6-2026-10-11.md',
  'docs/operacion-v1-6/linea-base-v1-6.md', 'docs/operacion-v1-6/matriz-aceptacion.md',
  'docs/operacion-v1-6/acta-cierre-v1-6.md', 'docs/operacion-v1-6/hoja-propietario.md',
  'docs/operacion-v1-6/runbook-operativo.md', 'docs/operacion-v1-6/evidencia.md',
  'docs/operacion-v1-6/auditoria-seguridad.md', 'docs/operacion-v1-6/mantenimiento-dependencias.md',
  'docs/operacion-v1-6/remediacion-2026-10-11.md', 'docs/operacion-v1-6/propuesta-arquitectura-v1-7.md',
  'web/scripts/ops/plan-inspeccion.mjs', 'web/scripts/ops/evidencia.mjs', 'web/scripts/ops/matriz.mjs',
  'web/scripts/ops/preflight-aceptacion.mjs', 'web/scripts/smoke-remote.mjs', 'web/deploy/infra/remediacion-v1-6.sh',
])
/** Documentos que deben citar la identidad completa de la línea base (K1). */
const CON_IDENTIDAD = ['docs/estado-produccion-v1-6-2026-10-11.md', 'docs/operacion-v1-6/linea-base-v1-6.md', 'docs/operacion-v1-6/matriz-aceptacion.md', 'docs/operacion-v1-6/acta-cierre-v1-6.md']
/** Comandos que nunca deben pedirse al propietario como parte de la verificación (K9). */
const MUTACIONES = /tags add|services (update|delete|replace)|add-iam|remove-iam|set-iam|versions (access|destroy|disable|enable|add)|--apply|sinks update|update-traffic|deshabilitar-sobrantes|destruir-version|alinear-max-servicio|excluir-callback-en-logs/
const COLUMNAS_HOJA = '| Control | Dónde entrar | Acción | Resultado correcto | Qué reportar | Qué hacer si falla |'

export function preflightCierre(ROOT, { soloRepositorio = false } = {}) {
  const res = []
  const add = (id, control, estado, evidencia, accion = '—') => res.push({ id, control, estado, evidencia, accion })
  const leer = (rel) => (existsSync(path.join(ROOT, rel)) ? readFileSync(path.join(ROOT, rel), 'utf8') : null)

  // K1 — identidad coherente (commit, digest y revisión completos) en los documentos que la fijan.
  const sinIdentidad = CON_IDENTIDAD.filter((rel) => {
    const t = leer(rel)
    return t === null || ![P.commit, P.digest, P.revision].every((x) => t.includes(x))
  })
  if (sinIdentidad.length) add('K1', 'Identidad de la línea base', 'FALLO', `sin commit, digest o revisión completos: ${sinIdentidad.join(', ')}`, 'Revalidar la línea base y la matriz (produccion-v1-6.mjs)')
  else add('K1', 'Identidad de la línea base', 'OK', `commit ${P.commit.slice(0, 7)}, digest ${P.digest.slice(7, 15)}… y revisión ${P.revision} en ${CON_IDENTIDAD.length} documentos`)

  // K2–K4 — preflight de aceptación (reutilizado).
  const pa = Object.fromEntries(preflightAceptacion(ROOT).map((r) => [r.id, r]))
  const p14 = pa.P14 ?? { estado: 'NO_VERIFICADO', motivo: 'sin resultado' }
  add('K2', 'Código de la imagen = código desplegado', p14.estado, `P14: ${p14.motivo}`, p14.estado === 'OK' ? '—' : 'Ejecutar con el historial de git completo (git fetch --unshallow)')
  const plantilla = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10', 'P13'].map((id) => pa[id] ?? { id, estado: 'NO_VERIFICADO' })
  const malos = plantilla.filter((r) => r.estado !== 'OK').map((r) => `${r.id ?? '?'}:${r.estado}`)
  add('K3', 'Plantilla, limpieza y contrato de seguridad', plantilla.some((r) => r.estado === 'FALLO') ? 'FALLO' : malos.length ? 'NO_VERIFICADO' : 'OK',
    malos.length ? `preflight de aceptación: ${malos.join(', ')}` : 'P1–P10 y P13 OK (preflight-aceptacion.mjs)', malos.length ? 'Ver preflight-aceptacion.mjs' : '—')
  // P15 NO_VERIFICADO (deuda de credenciales del colector manual) es una decisión del propietario (K16); su FALLO cuenta aquí.
  const wf = ['P11', 'P12', 'P15'].map((id) => pa[id] ?? { id, estado: 'NO_VERIFICADO' })
  add('K4', 'Workflows sin horarios; la CI automática sin credenciales de Google ni secretos', wf.some((r) => r.estado === 'FALLO') ? 'FALLO' : wf.slice(0, 2).every((r) => r.estado === 'OK') ? 'OK' : 'NO_VERIFICADO',
    `P11 ${wf[0].estado}, P12 ${wf[1].estado}, P15 ${wf[2].estado}${wf[2].estado === 'NO_VERIFICADO' ? ' (colector manual con opción explícita: decisión X-8, K16)' : ''}`)

  // K5 — documentos y herramientas de cierre.
  const faltan = ARCHIVOS_DE_CIERRE.filter((rel) => !existsSync(path.join(ROOT, rel)))
  add('K5', 'Documentos y herramientas de cierre', faltan.length ? 'FALLO' : 'OK', faltan.length ? `faltan: ${faltan.join(', ')}` : `${ARCHIVOS_DE_CIERRE.length} archivos presentes`, faltan.length ? 'Restaurar los archivos' : '—')

  // K6 — las herramientas que el propietario ejecuta solo leen.
  const k6 = []
  const inseguros = comandosInseguros(PASOS)
  if (inseguros.length) k6.push(`plan de inspección con ${inseguros.length} comandos fuera de la lista de lectura`)
  const smoke = leer('web/scripts/smoke-remote.mjs') ?? ''
  if (!smoke || /method:/.test(smoke)) k6.push('smoke:remote no es solo GET')
  const rem = leer('web/deploy/infra/remediacion-v1-6.sh') ?? ''
  const diag = /^diagnostico\(\) \{\n([\s\S]*?)^\}/m.exec(rem)?.[1] ?? ''
  if (!diag || /versions (disable|destroy)|services update|sinks update/.test(diag)) k6.push('el modo diagnostico de la remediación no es de solo lectura')
  add('K6', 'Lecturas del propietario sin mutaciones', k6.length ? 'FALLO' : 'OK', k6.length ? k6.join('; ') : `plan (${PASOS.length} pasos), smoke:remote (solo GET) y diagnostico: solo lectura`)

  // K7 — la evidencia saneada falla cerrado (autoprueba con valores inventados; nunca se imprimen).
  const k7 = []
  const canarios = { correo: 'persona.canario@correo-falso.test', token: `ya29.${'c'.repeat(30)}`, url: `${P.url}/api/auth/callback/google?code=CANARIO`, ip: '203.0.113.9' }
  for (const [tipo, valor] of Object.entries(canarios)) if (hallazgosSensibles({ nota: valor }).length === 0) k7.push(`no detecta ${tipo}`)
  const ejemplo = leer('docs/operacion-v1-6/evidencia-ejemplo.json')
  try {
    const e = ejemplo === null ? null : JSON.parse(ejemplo)
    if (e === null || e.ejemplo_sintetico !== true) k7.push('el ejemplo no se declara sintético')
    else if (evaluar(e).controles.some((c) => c.estado === 'OK')) k7.push('el ejemplo sintético aprueba algún control')
  } catch {
    k7.push('ejemplo ilegible')
  }
  const otraRevision = evaluar({ version: 1, fecha: P.fechaDespliegue, commit_desplegado: P.commit, revision: 'otra', controles: [{ id: 'A9', observado: { digest_produccion: P.digest } }] }, { parcial: true })
  if (otraRevision.controles.some((c) => c.estado === 'OK')) k7.push('otra revisión aprueba controles')
  add('K7', 'La evidencia saneada falla cerrado', k7.length ? 'FALLO' : 'OK', k7.length ? k7.join('; ') : 'autoprueba: detecta PII, tokens, URL con código e IP; el ejemplo sintético y otra revisión no aprueban nada')

  // K8 — la matriz no tiene falsos aprobados.
  const matriz = leer('docs/operacion-v1-6/matriz-aceptacion.md')
  const base = leer('docs/operacion-v1-6/linea-base-v1-6.md')
  const violaciones = matriz === null ? ['matriz ausente'] : validarMatriz(matriz, { lineaBase: base ?? '' })
  add('K8', 'Matriz sin falsos aprobados', violaciones.length ? 'FALLO' : 'OK', violaciones.length ? `${violaciones.length} violaciones: ${violaciones.slice(0, 3).join(' | ')}` : 'reglas de matriz.mjs: 0 violaciones (estados, resumen, EV-xx, identidad, H)', violaciones.length ? 'node web/scripts/ops/matriz.mjs' : '—')

  // K9 — la hoja del propietario: 5 bloques, columnas pedidas, sin mutaciones ni datos sensibles.
  const hoja = leer('docs/operacion-v1-6/hoja-propietario.md') ?? ''
  const k9 = []
  for (let b = 1; b <= 5; b += 1) if (!new RegExp(`^## Bloque ${b}\\b`, 'm').test(hoja)) k9.push(`falta el bloque ${b}`)
  if ((hoja.split(COLUMNAS_HOJA).length - 1) < 5) k9.push('cada bloque necesita la tabla Control | Dónde entrar | Acción | Resultado correcto | Qué reportar | Qué hacer si falla')
  if (MUTACIONES.test(hoja)) k9.push('pide un comando de mutación')
  if (!/OK \/ FALLO \/ NO_VERIFICADO/.test(hoja)) k9.push('no fija el vocabulario OK / FALLO / NO_VERIFICADO')
  add('K9', 'Hoja del propietario completa y segura', k9.length ? 'FALLO' : 'OK', k9.length ? k9.join('; ') : '5 bloques con las 6 columnas; solo lecturas; respuestas OK / FALLO / NO_VERIFICADO')

  // K10 — el script reutilizable de remediación conserva sus salvaguardas (las prueba remediacion-v1-6.test.ts).
  const salvaguardas = { 'revisión única': 'servicio_comprobable "$svc"', revalidación: 'revalidar_servicio "$huella"', etag: '--etag="$etag"', 'lector único': 'lector_unico "$s" "$cuenta"', 'verificación posterior': '(verificado)', 'lecturas fallidas': 'LECTURA_FALLIDA (no es un 0' }
  const sinSalvaguarda = Object.entries(salvaguardas).filter(([, marca]) => !rem.includes(marca)).map(([n]) => n)
  add('K10', 'Remediación reutilizable: falla cerrado', sinSalvaguarda.length ? 'FALLO' : 'OK', sinSalvaguarda.length ? `faltan salvaguardas: ${sinSalvaguarda.join(', ')}` : 'comprobación estática: siguen en el script la revisión única, la revalidación, el etag, el lector único, la verificación posterior y las lecturas fallidas. Su comportamiento lo prueba remediacion-v1-6.test.ts con gcloud falso')

  if (!soloRepositorio) {
    // Lo que NO puede verificarse offline: siempre NO_VERIFICADO, con su acción humana.
    add('K11', 'CI del HEAD del PR', 'NO_VERIFICADO', 'offline no se consulta GitHub', 'Revisar los checks del último SHA en el PR #24')
    add('K12', 'Configuración real en GCP (A1–A9, E1, F3, G2)', 'NO_VERIFICADO', 'evidencia real: EV-01…EV-12 (2026-10-11); offline no se lee GCP', 'Hoja del propietario, bloque 5 (diagnóstico); repetir tras cualquier cambio de la línea base §7')
    add('K13', 'Personas y datos (A2, C1–C7, D1, D2)', 'NO_VERIFICADO', 'requiere identidad humana, OAuth real y la hoja real', 'Hoja del propietario, bloques 1–3')
    add('K14', 'Costos (F1, F2) y métrica de instancias (A7)', 'NO_VERIFICADO', 'requiere la consola de facturación', 'Hoja del propietario, bloque 4')
    add('K15', 'Plazos (E1 y F3)', 'NO_VERIFICADO', `E1: entrada «code=» fuera de la ventana el 2026-11-11; F3: ≥ 5 imágenes y alguna de > 30 días`, 'Repetir E1 a partir del 2026-11-11 y F3 cuando se cumpla la condición')
    add('K16', 'Decisiones del propietario (C3, G1, X-2, X-8, excepciones)', 'NO_VERIFICADO', 'sin decisión registrada en la matriz §5', 'Acta de cierre: aceptar o rechazar cada excepción')
  }
  return res
}

const celda = (t) => String(t).replace(/\|/g, '\\|')

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const ri = args.indexOf('--root')
  if (args.some((a, i) => !['--root', '--json', '--solo-repositorio'].includes(a) && args[i - 1] !== '--root') || (ri > -1 && !args[ri + 1])) {
    console.error('Uso: node scripts/ops/preflight-cierre.mjs [--root <repo>] [--json] [--solo-repositorio]')
    process.exit(2)
  }
  const root = path.resolve(ri > -1 ? args[ri + 1] : path.join(import.meta.dirname, '..', '..', '..'))
  const resultados = preflightCierre(root, { soloRepositorio: args.includes('--solo-repositorio') })
  const codigo = codigoDeSalida(resultados)
  if (args.includes('--json')) console.log(JSON.stringify({ version: 1, alcance: 'offline', resultados, codigo }, null, 2))
  else {
    console.log('PROJECT-OS V1.6 — preflight de CIERRE (offline: el repositorio se comprueba; lo real queda NO_VERIFICADO)\n')
    console.log('| CONTROL | ESTADO | EVIDENCIA | ACCIÓN PENDIENTE |')
    console.log('| --- | --- | --- | --- |')
    for (const r of resultados) console.log(`| ${r.id} ${celda(r.control)} | ${r.estado} | ${celda(r.evidencia)} | ${celda(r.accion)} |`)
    const n = (e) => resultados.filter((r) => r.estado === e).length
    console.log(`\nOK ${n('OK')} · FALLO ${n('FALLO')} · NO_VERIFICADO ${n('NO_VERIFICADO')} (no cuenta como OK)`)
  }
  process.exit(codigo)
}
