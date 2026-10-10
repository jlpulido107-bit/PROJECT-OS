#!/usr/bin/env node
/**
 * Prepara una compilación de PROJECT-OS en Cloud Build para revisión humana. NO contacta a Google Cloud ni
 * ejecuta nada (docs/despliegue-privado-v1-3.md §5.5):
 *
 *   PROJECT_ID=… REGION=… IMAGE_TAG=… node web/deploy/build-command.mjs [--config-out=/tmp/project-os-cloudbuild.yaml]
 *
 * 1. Convierte cloudbuild.template.yaml en un YAML LITERAL para ese proyecto: `serviceAccount` de la cuenta dedicada,
 *    cuenta esperada por el paso `verificar-identidad` e imagen. No quedan interpolaciones de Cloud Build (solo el
 *    escape documentado `$$`), así que nada depende de cómo sustituya Cloud Build cada campo.
 * 2. Imprime el comando `gcloud builds submit` con --project explícito (no depende del proyecto activo de gcloud) y
 *    --service-account con la misma cuenta dedicada.
 *
 * Falla si falta una variable, si un valor no tiene el formato esperado o si se pide otra identidad (en especial las
 * cuentas predeterminadas de Compute, la heredada de Cloud Build o App Engine, que pueden tener rol Editor, o la
 * cuenta runtime del servicio). Solo nombra variables en los errores, nunca imprime sus valores.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const BUILD_SA_NAME = 'project-os-build'
export const RUNTIME_SA_NAME = 'project-os-dashboard-run'
export const DEFAULT_CONFIG_OUT = '/tmp/project-os-cloudbuild.yaml'

const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/
const REGION = /^[a-z]+-[a-z]+\d$/
const BUCKET = /^[a-z0-9][a-z0-9_.-]{1,61}[a-z0-9]$/
const DEFAULT_ACCOUNTS = [
  { pattern: /-compute@developer\.gserviceaccount\.com$/, name: 'la cuenta predeterminada de Compute Engine' },
  { pattern: /@cloudbuild\.gserviceaccount\.com$/, name: 'la cuenta heredada de Cloud Build' },
  { pattern: /@appspot\.gserviceaccount\.com$/, name: 'la cuenta predeterminada de App Engine' },
]
const PLACEHOLDERS = ['__PROJECT_ID__', '__BUILD_SERVICE_ACCOUNT__', '__IMAGE_TAG__']

export const dedicatedBuildAccount = (projectId) => `${BUILD_SA_NAME}@${projectId}.iam.gserviceaccount.com`
export const defaultSourceBucket = (projectId) => `${projectId}-project-os-build-src`

/** Valida las variables y devuelve los valores normalizados (lanza con la lista de problemas). */
function resolve(env) {
  const value = (name) => env[name]?.trim() ?? ''
  const problems = []
  const projectId = value('PROJECT_ID')
  const region = value('REGION')
  const buildRegion = value('BUILD_REGION') || region
  const imageTag = value('IMAGE_TAG')

  if (!projectId) problems.push('falta PROJECT_ID')
  else if (!PROJECT_ID.test(projectId)) problems.push('PROJECT_ID no tiene el formato esperado')
  if (!region) problems.push('falta REGION')
  else if (!REGION.test(region)) problems.push('REGION no tiene el formato esperado')
  if (buildRegion && !REGION.test(buildRegion)) problems.push('BUILD_REGION no tiene el formato esperado')
  if (!imageTag) problems.push('falta IMAGE_TAG')
  if (problems.length) throw new Error(problems.join('; '))

  // La imagen va al repositorio de Artifact Registry del proyecto y de la región del servicio, con etiqueta (no digest).
  const image = /^([a-z0-9-]+)-docker\.pkg\.dev\/([a-z0-9-]+)\/([a-z0-9-]+)\/dashboard:([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})$/.exec(imageTag)
  if (!image) problems.push('IMAGE_TAG no tiene el formato REGION-docker.pkg.dev/PROJECT_ID/REPO/dashboard:ETIQUETA')
  else {
    if (image[1] !== region) problems.push('IMAGE_TAG debe usar la región REGION')
    if (image[2] !== projectId) problems.push('IMAGE_TAG debe pertenecer a PROJECT_ID')
  }

  const account = dedicatedBuildAccount(projectId)
  const requested = value('BUILD_SA').toLowerCase()
  if (requested && requested !== account) {
    const known = DEFAULT_ACCOUNTS.find((a) => a.pattern.test(requested))
    if (known) problems.push(`BUILD_SA no puede ser ${known.name}`)
    else if (requested.startsWith(`${RUNTIME_SA_NAME}@`)) problems.push('BUILD_SA no puede ser la cuenta runtime del servicio')
    else problems.push(`BUILD_SA debe ser la cuenta dedicada ${BUILD_SA_NAME} de PROJECT_ID`)
  }

  const bucket = value('BUILD_BUCKET') || defaultSourceBucket(projectId)
  if (!BUCKET.test(bucket) || bucket.includes('..')) problems.push('BUILD_BUCKET no tiene el formato de un bucket')
  else if (bucket === `${projectId}_cloudbuild`) problems.push('BUILD_BUCKET no puede ser el bucket predeterminado de Cloud Build')
  if (problems.length) throw new Error(problems.join('; '))

  return { projectId, buildRegion, imageTag, account, bucket }
}

/** Configuración literal de Cloud Build para el proyecto, a partir de la plantilla. */
export function renderBuildConfig(template, env) {
  const { projectId, imageTag, account } = resolve(env)
  for (const marker of PLACEHOLDERS) {
    if (!template.includes(marker)) throw new Error(`la plantilla no contiene ${marker}`)
  }
  const output = template
    .replaceAll('__PROJECT_ID__', projectId)
    .replaceAll('__BUILD_SERVICE_ACCOUNT__', account)
    .replaceAll('__IMAGE_TAG__', imageTag)
  // Ninguna sustitución de Cloud Build en la salida: solo el escape `$$` del script de verificación.
  if (/__[A-Z_]+__/.test(output) || /(^|[^$])\$(\{|[A-Za-z_])/.test(output.replaceAll('$$', ''))) {
    throw new Error('la configuración generada conserva marcadores o sustituciones')
  }
  return output
}

/** Comando `gcloud builds submit` para la configuración generada en `configPath`. */
export function buildCommand(env, configPath = DEFAULT_CONFIG_OUT) {
  const { projectId, buildRegion, account, bucket } = resolve(env)
  if (!path.isAbsolute(configPath) || /\s/.test(configPath)) throw new Error('la ruta de la configuración debe ser absoluta y sin espacios')
  return [
    'gcloud builds submit web',
    `--project=${projectId}`,
    `--config=${configPath}`,
    `--region=${buildRegion}`,
    `--service-account=projects/${projectId}/serviceAccounts/${account}`,
    `--gcs-source-staging-dir=gs://${bucket}/source`,
  ].join(' \\\n  ')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const flag = process.argv.slice(2).find((a) => a.startsWith('--config-out='))
    const configPath = flag ? flag.slice('--config-out='.length) : DEFAULT_CONFIG_OUT
    const template = readFileSync(path.join(import.meta.dirname, 'cloudbuild.template.yaml'), 'utf8')
    const command = buildCommand(process.env, configPath)
    writeFileSync(configPath, renderBuildConfig(template, process.env), { mode: 0o600 })
    console.error(`Configuración de Cloud Build generada en ${configPath}: revísala antes de ejecutar el comando.`)
    process.stdout.write(`${command}\n`)
  } catch (error) {
    console.error(`No se generó la compilación: ${error.message}`)
    process.exit(1)
  }
}
