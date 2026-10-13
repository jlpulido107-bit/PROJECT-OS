#!/usr/bin/env node
/**
 * Preflight de aceptación OFFLINE de la V1.6 (docs/operacion-v1-6/README.md).
 *
 *   node scripts/ops/preflight-aceptacion.mjs [--root <repo>] [--json]
 *
 * - Solo lee archivos del repositorio y, si está disponible, `git` local. No invoca gcloud, curl ni la red, y nunca
 *   lee secretos ni variables de entorno de credenciales.
 * - Comprueba la PLANTILLA y el código, no la configuración real de GCP: para eso está plan-inspeccion.mjs.
 * - Resultado por control: OK / FALLO / NO_VERIFICADO. NO_VERIFICADO nunca cuenta como OK.
 * - Código de salida: 0 todo OK · 1 algún FALLO · 3 sin fallos pero con NO_VERIFICADO · 2 uso incorrecto.
 * - También es un módulo: preflightAceptacion(root) devuelve los resultados (lo reutiliza preflight-cierre.mjs).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { codigoDeSalida, DESPLEGADO, linea, PRODUCCION, RUTAS_DE_LA_IMAGEN } from './produccion-v1-6.mjs'

/**
 * Workflow MANUAL del colector V1.1 (Python), anterior al dashboard: solo con la opción explícita `sync_to_sheets` añade
 * filas a la hoja con la clave de cuenta de servicio PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_JSON. Es la única excepción
 * tolerada, y solo si se ejecuta exclusivamente a mano (workflow_dispatch) y cada paso con acceso a Google depende de esa
 * opción. P15 la declara como deuda de credenciales pendiente de decisión del propietario: nunca cuenta como OK.
 * Un workflow AUTOMÁTICO (PR, push o cualquier otro evento) ejecuta código que puede venir de un PR: nunca recibe
 * credenciales de Google, otros secretos ni acceso a la API de Google. Si vuelve a tenerlos, P12 da FALLO (R3-1, PR #24).
 */
export const WORKFLOW_COLECTOR_MANUAL = 'manual-github-evidence.yml'
const OPCION_COLECTOR = 'sync_to_sheets'
/** Acceso real a Google: credenciales, gcloud, la API de Google (Sheets incluida) o el sincronizador real. */
const ACCESO_GOOGLE = /google-github-actions\/auth|\bgcloud\b|GOOGLE_APPLICATION_CREDENTIALS|PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_JSON|googleapis\.com|\bsync_sheets\b|secrets\.[A-Z0-9_]*(GOOGLE|GCP|SERVICE_ACCOUNT)[A-Z0-9_]*/
/** Cualquier secreto del repositorio salvo el token efímero de GitHub: `secrets.X`, `secrets[…]`, `toJSON(secrets)`, `secrets: inherit`. */
const SECRETO_DEL_REPOSITORIO = /\bsecrets\s*(?:\.(?!GITHUB_TOKEN\b)|\[|\)|\}|:\s*inherit\b)/
/** Otras vías de un workflow automático hacia credenciales o hacia el colector (revisión final del PR #24). */
const OTRAS_VIAS = [
  [/\bid-token\s*:\s*write\b/, 'identidad OIDC (id-token: write)'],
  [/\bvars\s*(?:\.|\[)/, 'variables del repositorio (vars)'],
  [/\bactions\s*:\s*write\b/, 'puede lanzar otros workflows (actions: write)'],
  [/manual-github-evidence|workflow\s+run\b/, 'invoca el colector manual u otro workflow'],
  [/\bpull_request_target\b/, 'pull_request_target (recibe secretos del repositorio base)'],
]

/** Eventos del bloque `on:` de un workflow, o null si no se pueden leer (entonces cuenta como automático: falla cerrado). */
export function eventosDe(texto) {
  const lineas = texto.split('\n')
  const i = lineas.findIndex((l) => /^["']?on["']?\s*:/.test(l))
  if (i < 0) return null
  const enLinea = lineas[i].replace(/^["']?on["']?\s*:/, '').replace(/\s+#.*$/, '').trim()
  if (enLinea) {
    const lista = enLinea.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    return lista.length ? lista : null
  }
  const eventos = []
  let sangria = null
  for (const l of lineas.slice(i + 1)) {
    if (!l.trim() || /^\s*#/.test(l)) continue
    if (!/^\s/.test(l)) break // la siguiente clave de primer nivel cierra el bloque
    const m = /^(\s+)(?:-\s+)?["']?([A-Za-z_][\w-]*)["']?/.exec(l)
    if (!m) continue
    sangria ??= m[1].length
    if (m[1].length === sangria) eventos.push(m[2])
  }
  return eventos.length ? eventos : null
}

/** Opción explícita del colector manual: entrada booleana con `default: false` y cada fragmento con acceso a Google
 *  condicionado a ella con un `if:` que no la debilite (sin `||`). Un acceso fuera de un paso (p. ej. el `env` del job)
 *  no está condicionado y falla. */
function conOpcionExplicita(texto) {
  const entrada = new RegExp(`^(\\s+)${OPCION_COLECTOR}:\\s*\\n((?:\\1\\s+.*\\n?)+)`, 'm').exec(texto)
  if (!entrada || !/^\s+type:\s*boolean\s*$/m.test(entrada[2]) || !/^\s+default:\s*false\s*$/m.test(entrada[2])) return false
  const condicion = new RegExp(`^\\s*if:\\s*(?:\\$\\{\\{\\s*)?(?:github\\.event\\.)?inputs\\.${OPCION_COLECTOR}(?:\\s*==\\s*(?:true|'true'))?\\s*(?:\\}\\})?\\s*$`, 'm')
  // Trozos: cada elemento de lista y cada clave con sangría ≤ 4 (jobs y su env); así el env de un job nunca hereda el if de un paso.
  return texto.split(/\n(?=\s*-\s|\s{0,4}[A-Za-z_][\w-]*\s*:)/).filter((trozo) => ACCESO_GOOGLE.test(trozo)).every((trozo) => condicion.test(trozo))
}

export function preflightAceptacion(ROOT) {
  const resultados = []
  const ok = (id, motivo) => resultados.push({ id, estado: 'OK', motivo })
  const fallo = (id, motivo) => resultados.push({ id, estado: 'FALLO', motivo })
  const noVerificado = (id, motivo) => resultados.push({ id, estado: 'NO_VERIFICADO', motivo })

  function leer(rel) {
    const full = path.join(ROOT, rel)
    return existsSync(full) ? readFileSync(full, 'utf8') : null
  }

  // ---- Plantilla de Cloud Run (no es la configuración real) ----
  const plantilla = leer('web/deploy/cloudrun/service.template.yaml')
  if (plantilla === null) {
    noVerificado('P1', 'plantilla service.template.yaml ausente')
  } else {
    const valor = (clave) => new RegExp(`^\\s*${clave.replace(/[./]/g, '\\$&')}:\\s*'?([^'\\n]*)'?\\s*$`, 'm').exec(plantilla)?.[1]
    const esperado = [
      ['autoscaling.knative.dev/minScale', '0'], ['autoscaling.knative.dev/maxScale', '1'],
      ['run.googleapis.com/cpu-throttling', 'true'], ['run.googleapis.com/ingress', 'all'],
    ]
    const malos = esperado.filter(([k, v]) => valor(k) !== v).map(([k]) => k)
    if (malos.length) fallo('P1', `plantilla: valores inesperados en ${malos.join(', ')}`)
    else ok('P1', 'plantilla: minScale 0, maxScale 1 de revisión, CPU por solicitud, ingress all')

    if (/run\.googleapis\.com\/maxScale/.test(plantilla)) fallo('P2', 'plantilla: define un maxScale de SERVICIO; revisar D-1 antes de desplegar')
    else ok('P2', 'plantilla: sin maxScale de servicio (el real de producción se lee con plan-inspeccion, A7)')

    const escritura = PRODUCCION.variablesEscritura.filter((v) => plantilla.includes(v))
    if (escritura.length) fallo('P3', `plantilla: define variables de escritura (${escritura.join(', ')})`)
    else ok('P3', 'plantilla: sin variables de escritura de V1.4')

    const refs = [...plantilla.matchAll(/name:\s*(project-os-[a-z-]+)\n\s*key:\s*'?([^'\n]+)'?/g)]
    const nombres = refs.map((m) => m[1]).sort()
    const latest = refs.some((m) => /latest/i.test(m[2] ?? ''))
    if (latest) fallo('P4', 'plantilla: algún secreto usa la versión latest')
    else if (JSON.stringify(nombres) !== JSON.stringify([...PRODUCCION.secretos].sort())) fallo('P4', 'plantilla: los secretos referenciados no son los 3 esperados')
    else ok('P4', 'plantilla: 3 secretos por versión fijada, nunca latest')

    if (!/SHEETS_CREDENTIALS\n\s*value:\s*adc/.test(plantilla) || !/SHEETS_EXPECTED_SERVICE_ACCOUNT/.test(plantilla)) fallo('P5', 'plantilla: no exige ADC con cuenta esperada')
    else ok('P5', 'plantilla: ADC con cuenta de servicio esperada, sin clave JSON')
  }

  // ---- Política de limpieza (archivo revisado) ----
  const politicaTexto = leer('web/deploy/cloudrun/artifact-cleanup-policy.json')
  if (politicaTexto === null) {
    noVerificado('P6', 'política de limpieza ausente')
  } else {
    try {
      const politica = JSON.parse(politicaTexto)
      const porNombre = Object.fromEntries(politica.map((p) => [p.name, p]))
      const prod = porNombre['conservar-produccion']
      const recientes = porNombre['conservar-3-recientes']
      const borrar = porNombre['borrar-mayores-30-dias']
      const correcta = politica.length === 3
        && prod?.action?.type === 'Keep' && prod?.condition?.tagState === 'TAGGED' && JSON.stringify(prod?.condition?.tagPrefixes) === '["produccion"]'
        && recientes?.action?.type === 'Keep' && recientes?.mostRecentVersions?.keepCount === 3
        && borrar?.action?.type === 'Delete' && borrar?.condition?.olderThan === '2592000s'
      if (correcta) ok('P6', 'política de limpieza: Keep produccion*, Keep 3 recientes, Delete > 30 días')
      else fallo('P6', 'política de limpieza distinta de la revisada')
    } catch {
      fallo('P6', 'política de limpieza: JSON no válido')
    }
  }

  // ---- Contrato de seguridad en el código ----
  const checks = [
    ['P7', 'web/src/proxy.ts', (t) => /matcher:\s*\[/.test(t) && /respond\(await decide\(request\)/.test(t), 'proxy aplica decide/respond a todas las rutas salvo estáticos'],
    ['P8', 'web/src/app/(private)/layout.tsx', (t) => /await requireUser\(\)/.test(t), 'layout privado exige requireUser()'],
    ['P9', 'web/src/lib/auth.ts', (t) => /email_verified === true && isEmailAllowed/.test(t) && /scope: 'openid email profile'/.test(t), 'OAuth: correo verificado + lista; alcances openid email profile'],
    ['P10', 'web/src/lib/authz.ts', (t) => /status: 403/.test(t) && /status: 401/.test(t), 'APIs privadas: 401 sin sesión, 403 sin permiso'],
  ]
  for (const [id, rel, prueba, texto] of checks) {
    const t = leer(rel)
    if (t === null) noVerificado(id, `${rel} ausente`)
    else if (prueba(t)) ok(id, texto)
    else fallo(id, `no se encontró el control esperado en ${rel}`)
  }

  // ---- Workflows: sin horarios; la CI automática sin credenciales (P12); el colector manual, solo con opción (P15) ----
  const wfDir = path.join(ROOT, '.github', 'workflows')
  if (!existsSync(wfDir)) {
    noVerificado('P11', 'sin .github/workflows')
  } else {
    const textos = readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)).map((f) => [f, readFileSync(path.join(wfDir, f), 'utf8')])
    const conHorario = textos.filter(([, t]) => /^\s*schedule\s*:/m.test(t)).map(([f]) => f)
    if (conHorario.length) fallo('P11', `workflows con schedule: ${conHorario.join(', ')}`)
    else ok('P11', 'workflows sin schedule')
    const automaticos = [], manualesMal = []
    let colectorManual = false
    for (const [f, t] of textos) {
      const eventos = eventosDe(t)
      if (eventos === null || eventos.some((e) => e !== 'workflow_dispatch')) {
        const motivos = [ACCESO_GOOGLE.test(t) && 'credenciales o API de Google', SECRETO_DEL_REPOSITORIO.test(t) && 'secretos del repositorio',
          ...OTRAS_VIAS.filter(([re]) => re.test(t)).map(([, m]) => m)].filter(Boolean)
        if (motivos.length) automaticos.push(`${f} (${eventos ? eventos.join(', ') : 'eventos ilegibles'}: ${motivos.join(' y ')})`)
      } else if (ACCESO_GOOGLE.test(t)) {
        if (f !== WORKFLOW_COLECTOR_MANUAL) manualesMal.push(`${f}: credenciales de Google en un workflow manual distinto del colector`)
        else if (!conOpcionExplicita(t)) manualesMal.push(`${f}: acceso a Google sin depender de la opción explícita ${OPCION_COLECTOR} (booleana, desactivada por defecto)`)
        else colectorManual = true
      }
    }
    if (automaticos.length) fallo('P12', `workflows automáticos con acceso a Google o a secretos (la CI de un PR nunca los recibe): ${automaticos.join('; ')}`)
    else ok('P12', 'ningún workflow automático (PR, push u otro evento) recibe credenciales de Google, secretos del repositorio ni la API de Google; la CI de los PR valida Sheets con una hoja en memoria')
    if (manualesMal.length) fallo('P15', manualesMal.join('; '))
    else if (colectorManual) noVerificado('P15', `deuda de credenciales del colector V1.1: ${WORKFLOW_COLECTOR_MANUAL} usa una clave JSON de cuenta de servicio de Google (Editor de la hoja según su guía; sin verificar). Solo se ejecuta a mano y con la opción ${OPCION_COLECTOR}: pendiente de decisión del propietario (X-8), no del dashboard`)
    else ok('P15', 'ningún workflow usa credenciales de Google')
  }

  // ---- Identidad de la versión: ¿el código de la imagen es el desplegado? ----
  const registro = leer(DESPLEGADO.registro)
  if (registro === null) noVerificado('P13', 'registro de producción ausente')
  else if (registro.includes(DESPLEGADO.commit) && registro.includes(DESPLEGADO.digest) && registro.includes(DESPLEGADO.revision)) ok('P13', 'registro de producción coincide con commit, digest y revisión esperados')
  else fallo('P13', 'el registro de producción no coincide con el estado esperado (DESPLEGADO en produccion-v1-6.mjs)')

  try {
    execFileSync('git', ['-C', ROOT, 'cat-file', '-e', `${DESPLEGADO.commit}^{commit}`], { stdio: 'ignore' })
    try {
      execFileSync('git', ['-C', ROOT, 'diff', '--quiet', DESPLEGADO.commit, 'HEAD', '--', ...RUTAS_DE_LA_IMAGEN], { stdio: 'ignore' })
      ok('P14', `el código que entra en la imagen es idéntico al desplegado (${DESPLEGADO.commit.slice(0, 7)})`)
    } catch {
      fallo('P14', `el código de la imagen difiere de ${DESPLEGADO.commit.slice(0, 7)}: este árbol NO es lo desplegado`)
    }
  } catch {
    noVerificado('P14', `git o el commit ${DESPLEGADO.commit.slice(0, 7)} no disponibles (p. ej. clon superficial)`)
  }
  return resultados
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const rootArg = args.indexOf('--root')
  if (args.some((a, i) => !['--root', '--json'].includes(a) && args[i - 1] !== '--root') || (rootArg > -1 && !args[rootArg + 1])) {
    console.error('Uso: node scripts/ops/preflight-aceptacion.mjs [--root <repo>] [--json]')
    process.exit(2)
  }
  const ROOT = path.resolve(rootArg > -1 ? args[rootArg + 1] : path.join(import.meta.dirname, '..', '..', '..'))
  const resultados = preflightAceptacion(ROOT)
  const codigo = codigoDeSalida(resultados)
  if (args.includes('--json')) {
    console.log(JSON.stringify({ version: 1, alcance: 'offline', resultados, codigo }, null, 2))
  } else {
    console.log('PROJECT-OS V1.6 — preflight de aceptación OFFLINE (plantilla y código; no es la configuración real de GCP)')
    for (const r of resultados) console.log(linea(r))
    const n = (e) => resultados.filter((r) => r.estado === e).length
    console.log(`\nOK ${n('OK')} · FALLO ${n('FALLO')} · NO_VERIFICADO ${n('NO_VERIFICADO')} (no cuenta como OK)`)
    console.log('Fuera del alcance offline: A1–A9, C, D, E, F y G reales → node scripts/ops/plan-inspeccion.mjs')
  }
  process.exit(codigo)
}
