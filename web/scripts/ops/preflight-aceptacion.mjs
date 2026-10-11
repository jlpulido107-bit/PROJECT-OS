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
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { codigoDeSalida, linea, PRODUCCION, RUTAS_DE_LA_IMAGEN } from './produccion-v1-6.mjs'

const args = process.argv.slice(2)
const rootArg = args.indexOf('--root')
if (args.some((a, i) => !['--root', '--json'].includes(a) && args[i - 1] !== '--root') || (rootArg > -1 && !args[rootArg + 1])) {
  console.error('Uso: node scripts/ops/preflight-aceptacion.mjs [--root <repo>] [--json]')
  process.exit(2)
}
const ROOT = path.resolve(rootArg > -1 ? args[rootArg + 1] : path.join(import.meta.dirname, '..', '..', '..'))
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

// ---- Workflows: sin horarios ni credenciales de Google Cloud ----
const wfDir = path.join(ROOT, '.github', 'workflows')
if (!existsSync(wfDir)) {
  noVerificado('P11', 'sin .github/workflows')
} else {
  const textos = readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)).map((f) => [f, readFileSync(path.join(wfDir, f), 'utf8')])
  const conHorario = textos.filter(([, t]) => /^\s*schedule\s*:/m.test(t)).map(([f]) => f)
  const conGcp = textos.filter(([, t]) => /google-github-actions\/auth|\bgcloud\b|GOOGLE_APPLICATION_CREDENTIALS/.test(t)).map(([f]) => f)
  if (conHorario.length) fallo('P11', `workflows con schedule: ${conHorario.join(', ')}`)
  else ok('P11', 'workflows sin schedule')
  if (conGcp.length) fallo('P12', `workflows con acceso a Google Cloud: ${conGcp.join(', ')}`)
  else ok('P12', 'workflows sin credenciales ni comandos de Google Cloud')
}

// ---- Identidad de la versión: ¿el código de la imagen es el desplegado? ----
const registro = leer('docs/estado-produccion-v1-6-2026-10-11.md')
if (registro === null) noVerificado('P13', 'registro de producción ausente')
else if (registro.includes(PRODUCCION.commit) && registro.includes(PRODUCCION.digest) && registro.includes(PRODUCCION.revision)) ok('P13', 'registro de producción coincide con commit, digest y revisión esperados')
else fallo('P13', 'el registro de producción no coincide con el estado esperado (produccion-v1-6.mjs)')

try {
  execFileSync('git', ['-C', ROOT, 'cat-file', '-e', `${PRODUCCION.commit}^{commit}`], { stdio: 'ignore' })
  try {
    execFileSync('git', ['-C', ROOT, 'diff', '--quiet', PRODUCCION.commit, 'HEAD', '--', ...RUTAS_DE_LA_IMAGEN], { stdio: 'ignore' })
    ok('P14', `el código que entra en la imagen es idéntico al desplegado (${PRODUCCION.commit.slice(0, 7)})`)
  } catch {
    fallo('P14', `el código de la imagen difiere de ${PRODUCCION.commit.slice(0, 7)}: este árbol NO es lo desplegado`)
  }
} catch {
  noVerificado('P14', `git o el commit ${PRODUCCION.commit.slice(0, 7)} no disponibles (p. ej. clon superficial)`)
}

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
