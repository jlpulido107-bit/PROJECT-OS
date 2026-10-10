#!/usr/bin/env node
/**
 * Genera el comando `gcloud builds submit` de PROJECT-OS y lo imprime por stdout para revisión humana.
 * NO contacta a Google Cloud ni ejecuta nada (docs/despliegue-privado-v1-3.md §5.5).
 *
 *   PROJECT_ID=… REGION=… IMAGE_TAG=… node web/deploy/build-command.mjs
 *
 * El comando siempre lleva --service-account con la cuenta dedicada de compilación. Falla si falta una variable,
 * si un valor no tiene el formato esperado o si se pide otra identidad (en especial las cuentas predeterminadas de
 * Compute, la heredada de Cloud Build o App Engine, que pueden tener rol Editor, o la cuenta runtime del servicio).
 * Solo nombra variables en los errores, nunca imprime sus valores.
 */

export const BUILD_SA_NAME = 'project-os-build'
export const RUNTIME_SA_NAME = 'project-os-dashboard-run'

const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/
const REGION = /^[a-z]+-[a-z]+\d$/
const BUCKET = /^[a-z0-9][a-z0-9_.-]{1,61}[a-z0-9]$/
const DEFAULT_ACCOUNTS = [
  { pattern: /-compute@developer\.gserviceaccount\.com$/, name: 'la cuenta predeterminada de Compute Engine' },
  { pattern: /@cloudbuild\.gserviceaccount\.com$/, name: 'la cuenta heredada de Cloud Build' },
  { pattern: /@appspot\.gserviceaccount\.com$/, name: 'la cuenta predeterminada de App Engine' },
]

export const dedicatedBuildAccount = (projectId) => `${BUILD_SA_NAME}@${projectId}.iam.gserviceaccount.com`
export const defaultSourceBucket = (projectId) => `${projectId}-project-os-build-src`

export function buildCommand(env) {
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

  const expected = dedicatedBuildAccount(projectId)
  const requested = value('BUILD_SA').toLowerCase()
  if (requested && requested !== expected) {
    const known = DEFAULT_ACCOUNTS.find((a) => a.pattern.test(requested))
    if (known) problems.push(`BUILD_SA no puede ser ${known.name}`)
    else if (requested.startsWith(`${RUNTIME_SA_NAME}@`)) problems.push('BUILD_SA no puede ser la cuenta runtime del servicio')
    else problems.push(`BUILD_SA debe ser la cuenta dedicada ${BUILD_SA_NAME} de PROJECT_ID`)
  }

  const bucket = value('BUILD_BUCKET') || defaultSourceBucket(projectId)
  if (!BUCKET.test(bucket) || bucket.includes('..')) problems.push('BUILD_BUCKET no tiene el formato de un bucket')
  else if (bucket === `${projectId}_cloudbuild`) problems.push('BUILD_BUCKET no puede ser el bucket predeterminado de Cloud Build')
  if (problems.length) throw new Error(problems.join('; '))

  return [
    'gcloud builds submit web',
    '--config=web/deploy/cloudbuild.yaml',
    `--region=${buildRegion}`,
    `--service-account=projects/${projectId}/serviceAccounts/${expected}`,
    `--gcs-source-staging-dir=gs://${bucket}/source`,
    `--substitutions=_IMAGE_TAG=${imageTag}`,
  ].join(' \\\n  ')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.stdout.write(`${buildCommand(process.env)}\n`)
  } catch (error) {
    console.error(`No se generó el comando: ${error.message}`)
    process.exit(1)
  }
}
