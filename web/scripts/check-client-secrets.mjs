#!/usr/bin/env node
/**
 * Revisión de secretos en los assets enviados al navegador (.next/static).
 * Ejecutar DESPUÉS de `npm run build`, idealmente con las variables reales o de prueba cargadas,
 * para comprobar que ninguno de sus valores terminó en el JavaScript/CSS de cliente.
 * Nunca imprime el valor encontrado, solo el archivo y el tipo de hallazgo.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

// Opciones (para la autoprueba y la CI): --dir <ruta> revisa otro directorio en lugar de .next/static;
// --min-values=N falla (código 3) si se comparan menos de N valores del entorno, para que una ejecución sin
// valores no pase por buena en silencio.
const args = process.argv.slice(2)
const dirArg = args.indexOf('--dir')
const minArg = args.find((a) => a.startsWith('--min-values='))
const minValues = minArg ? Number(minArg.split('=')[1]) : 0
if (!Number.isInteger(minValues) || minValues < 0 || (dirArg > -1 && !args[dirArg + 1])) {
  console.error('Uso: node scripts/check-client-secrets.mjs [--dir <ruta>] [--min-values=N]')
  process.exit(2)
}
const root = dirArg > -1 ? path.resolve(args[dirArg + 1]) : path.resolve(import.meta.dirname, '..', '.next', 'static')
const shown = dirArg > -1 ? args[dirArg + 1] : '.next/static'

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

let files
try {
  files = walk(root).filter((f) => /\.(js|css|json|txt|html|map)$/.test(f))
} catch {
  console.error(`No existe ${shown}: ejecuta \`npm run build\` primero.`)
  process.exit(2)
}

const patterns = [
  ['clave privada PEM', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['JSON de cuenta de servicio', /"type"\s*:\s*"service_account"|"private_key"\s*:/],
  ['correo de cuenta de servicio', /[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com/i],
  ['token OAuth de Google', /ya29\.[0-9A-Za-z_-]{20,}/],
  ['nombre de variable secreta', /NEXTAUTH_SECRET|GOOGLE_CLIENT_SECRET|PROJECT_OS_GOOGLE_SERVICE_ACCOUNT|AUTH_ALLOWED_EMAILS/],
  ['dirección de correo', /[A-Za-z0-9._%+-]+@(?!example\.(?:com|org))[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/],
]

// Valores reales de configuración presentes en el entorno: no deben aparecer literalmente.
const envValues = []
// FINANZAS_SHEET_ID (ORD-POS-074): el ID del libro FINANZAS solo vive en el servidor.
for (const name of ['NEXTAUTH_SECRET', 'GOOGLE_CLIENT_SECRET', 'SHEETS_SPREADSHEET_ID', 'FINANZAS_SHEET_ID']) {
  const value = process.env[name]?.trim()
  if (value && value.length >= 8) envValues.push([name, value])
}
for (const email of (process.env.AUTH_ALLOWED_EMAILS ?? '').split(/[,\s;]+/).filter((e) => e.includes('@'))) {
  envValues.push(['AUTH_ALLOWED_EMAILS', email.trim()])
}
const sa = process.env.PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_JSON
if (sa) {
  try {
    const info = JSON.parse(sa)
    if (info.client_email) envValues.push(['client_email', info.client_email])
    if (info.private_key) envValues.push(['private_key', String(info.private_key).replace(/-----[^-]+-----|\s/g, '').slice(0, 40)])
  } catch {
    // JSON inválido: no se puede comparar, pero tampoco se imprime.
  }
}

const findings = []
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const rel = path.relative(path.resolve(import.meta.dirname, '..'), file)
  for (const [label, re] of patterns) if (re.test(text)) findings.push(`${rel}: ${label}`)
  for (const [name, value] of envValues) if (text.includes(value)) findings.push(`${rel}: valor de ${name}`)
}

console.log(`Archivos de cliente revisados: ${files.length}. Valores de entorno comparados: ${envValues.length}.`)
if (findings.length > 0) {
  console.error('Posibles secretos en assets de cliente:')
  for (const f of findings) console.error(' - ' + f)
  process.exit(1)
}
if (envValues.length < minValues) {
  console.error(`NO_VERIFICADO: se exigían al menos ${minValues} valores de entorno y se compararon ${envValues.length}.`)
  process.exit(3)
}
console.log(`OK: sin claves, tokens, correos ni valores secretos en ${shown}.`)
