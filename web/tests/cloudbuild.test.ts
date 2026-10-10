import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildCommand, dedicatedBuildAccount, defaultSourceBucket } from '../deploy/build-command.mjs'

/**
 * Compilación en Cloud Build con identidad dedicada (Misión 011). Todo es estático o local: nada contacta a
 * Google Cloud. Impide que un build use por accidente la cuenta predeterminada (Compute / Cloud Build heredada),
 * que puede tener rol Editor.
 */
const WEB = path.resolve(__dirname, '..')
const ROOT = path.resolve(WEB, '..')
const config = readFileSync(path.join(WEB, 'deploy', 'cloudbuild.yaml'), 'utf8')
const lifecycle = JSON.parse(readFileSync(path.join(WEB, 'deploy', 'cloudbuild-source-lifecycle.json'), 'utf8'))
const runbook = readFileSync(path.join(ROOT, 'docs', 'despliegue-privado-v1-3.md'), 'utf8')
const prep = readFileSync(path.join(ROOT, 'docs', 'despliegue-v1-6-preparacion.md'), 'utf8')
const code = config.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n')

const PROJECT = 'demo-proyecto-123'
const ENV = {
  PROJECT_ID: PROJECT,
  REGION: 'northamerica-south1',
  IMAGE_TAG: `northamerica-south1-docker.pkg.dev/${PROJECT}/project-os/dashboard:abc1234`,
}

/** Script del paso de verificación con las sustituciones de Cloud Build aplicadas ($$ → $, $PROJECT_ID → proyecto). */
function guardScript(project: string): string {
  const lines = config.split('\n')
  const start = lines.findIndex((l) => l.trim() === '- |')
  expect(start).toBeGreaterThan(-1)
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('        ')) break
    body.push(line.slice(8))
  }
  return body.join('\n').replace(/\$\$|\$PROJECT_ID|\$\{PROJECT_ID\}/g, (m) => (m === '$$' ? '$' : project))
}

const stubDir = mkdtempSync(path.join(tmpdir(), 'cb-guard-'))
writeFileSync(path.join(stubDir, 'curl'), '#!/bin/sh\n[ -n "$FAKE_FAIL" ] && exit 22\nprintf %s "$FAKE_EMAIL"\n')
chmodSync(path.join(stubDir, 'curl'), 0o755)
afterAll(() => rmSync(stubDir, { recursive: true, force: true }))

function runGuard(email: string, fail = false) {
  return spawnSync('bash', ['-c', guardScript(PROJECT)], {
    env: { PATH: `${stubDir}:/usr/bin:/bin`, FAKE_EMAIL: email, ...(fail ? { FAKE_FAIL: '1' } : {}) } as unknown as NodeJS.ProcessEnv,
    encoding: 'utf8',
  })
}

describe('cloudbuild.yaml', () => {
  it('el primer paso verifica la identidad antes de construir y subir', () => {
    const ids = [...code.matchAll(/^\s+- id: (\S+)$/gm)].map((m) => m[1])
    expect(ids).toEqual(['verificar-identidad', 'construir-imagen'])
    expect(code).not.toMatch(/waitFor/) // sin paralelismo: la construcción espera a la verificación
    expect(code).toContain('computeMetadata/v1/instance/service-accounts/default/email')
  })

  it.each([
    ['cuenta dedicada del proyecto', `project-os-build@${PROJECT}.iam.gserviceaccount.com`, 0],
    ['predeterminada de Compute', '123456789012-compute@developer.gserviceaccount.com', 1],
    ['heredada de Cloud Build', '123456789012@cloudbuild.gserviceaccount.com', 1],
    ['runtime del servicio', `project-os-dashboard-run@${PROJECT}.iam.gserviceaccount.com`, 1],
    ['dedicada de OTRO proyecto', 'project-os-build@otro-proyecto-9.iam.gserviceaccount.com', 1],
    ['respuesta vacía', '', 1],
  ])('verificación de identidad: %s → código %i', (_label, email, status) => {
    const result = runGuard(email)
    expect(result.status).toBe(status)
    if (status) expect(result.stderr).toContain('Build abortado')
    // Nunca imprime la identidad real.
    expect(result.stdout + result.stderr).not.toContain('@')
  })

  it('si el metadata server no responde, el build falla (falla cerrada)', () => {
    expect(runGuard(dedicatedBuildAccount(PROJECT), true).status).not.toBe(0)
  })

  it('logs solo en Cloud Logging (obligatorio con cuenta propia), sin bucket de logs ni secretos', () => {
    expect(code).toMatch(/^options:\n\s+logging: CLOUD_LOGGING_ONLY$/m)
    expect(code).not.toMatch(/logsBucket|availableSecrets|secretEnv|serviceAccount:/)
  })

  it('solo construye y sube la imagen: no despliega ni toca IAM', () => {
    expect(code).not.toMatch(/gcloud (run|iam|projects|secrets|services)|deploy|kubectl/)
    expect(code).toMatch(/args: \['build', '--platform', 'linux\/amd64', '-t', '\$\{_IMAGE_TAG\}', '\.'\]/)
    expect(code).toMatch(/^images:\n\s+- '\$\{_IMAGE_TAG\}'$/m)
  })

  it('solo usa las sustituciones PROJECT_ID y _IMAGE_TAG', () => {
    const vars = new Set([...code.replace(/\$\$/g, '').matchAll(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g)].map((m) => m[1]))
    expect([...vars].sort()).toEqual(['PROJECT_ID', '_IMAGE_TAG'])
  })

  it('el bucket de origen borra lo subido a los 7 días', () => {
    expect(lifecycle).toEqual({ rule: [{ action: { type: 'Delete' }, condition: { age: 7 } }] })
  })
})

describe('build-command.mjs', () => {
  it('genera el comando con la cuenta dedicada, la región y el bucket de origen propio', () => {
    const cmd = buildCommand(ENV)
    expect(cmd.startsWith('gcloud builds submit web')).toBe(true)
    expect(cmd).toContain(`--service-account=projects/${PROJECT}/serviceAccounts/project-os-build@${PROJECT}.iam.gserviceaccount.com`)
    expect(cmd).toContain('--region=northamerica-south1')
    expect(cmd).toContain(`--gcs-source-staging-dir=gs://${defaultSourceBucket(PROJECT)}/source`)
    expect(cmd).toContain('--config=web/deploy/cloudbuild.yaml')
    expect(cmd).toContain(`--substitutions=_IMAGE_TAG=${ENV.IMAGE_TAG}`)
  })

  it('permite compilar en otra región sin cambiar la del repositorio', () => {
    expect(buildCommand({ ...ENV, BUILD_REGION: 'us-central1' })).toContain('--region=us-central1')
  })

  it.each([
    ['123456789012-compute@developer.gserviceaccount.com', 'predeterminada de Compute'],
    ['123456789012@cloudbuild.gserviceaccount.com', 'heredada de Cloud Build'],
    [`${PROJECT}@appspot.gserviceaccount.com`, 'App Engine'],
    [`project-os-dashboard-run@${PROJECT}.iam.gserviceaccount.com`, 'runtime'],
    ['project-os-build@otro-proyecto-9.iam.gserviceaccount.com', 'cuenta dedicada'],
  ])('rechaza BUILD_SA=%s', (account, message) => {
    expect(() => buildCommand({ ...ENV, BUILD_SA: account })).toThrow(message)
  })

  it('acepta BUILD_SA solo si es la cuenta dedicada', () => {
    expect(buildCommand({ ...ENV, BUILD_SA: dedicatedBuildAccount(PROJECT) })).toContain(dedicatedBuildAccount(PROJECT))
  })

  it.each([
    [{ PROJECT_ID: '' }, 'falta PROJECT_ID'],
    [{ REGION: '' }, 'falta REGION'],
    [{ IMAGE_TAG: '' }, 'falta IMAGE_TAG'],
    [{ IMAGE_TAG: `us-central1-docker.pkg.dev/${PROJECT}/project-os/dashboard:abc` }, 'región REGION'],
    [{ IMAGE_TAG: 'northamerica-south1-docker.pkg.dev/otro-proyecto-9/project-os/dashboard:abc' }, 'pertenecer a PROJECT_ID'],
    [{ IMAGE_TAG: `gcr.io/${PROJECT}/dashboard:abc` }, 'formato'],
    [{ BUILD_BUCKET: `${PROJECT}_cloudbuild` }, 'predeterminado'],
    [{ BUILD_BUCKET: 'A' }, 'formato'],
  ])('valida %o', (override, message) => {
    expect(() => buildCommand({ ...ENV, ...override })).toThrow(message)
  })

  it('los errores nombran variables, nunca imprimen valores', () => {
    try {
      buildCommand({ ...ENV, BUILD_SA: '123456789012-compute@developer.gserviceaccount.com' })
    } catch (error) {
      expect(String(error)).not.toContain('123456789012')
    }
  })
})

describe('documentación de la compilación', () => {
  const blocks = (text: string) => [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => (m[1] ?? '').replace(/\\\n\s*/g, ' '))

  it('todo `gcloud builds submit` documentado lleva --service-account con la cuenta dedicada', () => {
    const commands = blocks(runbook).flatMap((b) => b.split('\n')).filter((l) => /^\s*gcloud builds submit/.test(l))
    expect(commands.length).toBeGreaterThan(0)
    for (const c of commands) expect(c).toMatch(/--service-account="?projects\/\$\{?PROJECT_ID\}?\/serviceAccounts\/\$\{?BUILD_SA\}?/)
    expect(runbook).toContain('node web/deploy/build-command.mjs')
  })

  it('la cuenta dedicada y sus roles coinciden con la configuración', () => {
    expect(runbook).toContain('BUILD_SA="project-os-build@${PROJECT_ID}.iam.gserviceaccount.com"')
    for (const role of ['roles/logging.logWriter', 'roles/artifactregistry.writer', 'roles/storage.objectViewer', 'roles/iam.serviceAccountUser']) {
      expect(runbook, role).toContain(role)
    }
    expect(runbook).toContain('--lifecycle-file=web/deploy/cloudbuild-source-lifecycle.json')
  })

  it.each([['runbook', runbook], ['preparación', prep]])('%s: nunca concede Editor ni Propietario a una cuenta', (_name, text) => {
    for (const block of blocks(text)) expect(block).not.toMatch(/--role[= ]roles\/(editor|owner)\b/)
  })
})
