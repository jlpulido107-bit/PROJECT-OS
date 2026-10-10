import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildCommand, dedicatedBuildAccount, defaultSourceBucket, renderBuildConfig, validateConfigPath } from '../deploy/build-command.mjs'

/**
 * Compilación en Cloud Build con identidad dedicada (Misión 011). Todo es estático o local: nada contacta a
 * Google Cloud. Impide que un build use por accidente la cuenta predeterminada (Compute / Cloud Build heredada),
 * que puede tener rol Editor, o el proyecto activo de gcloud en lugar de PROJECT_ID.
 *
 * El metadata server está SIMULADO (un `curl` falso): la verificación real queda para el primer build autorizado
 * (checklist A8).
 */
const WEB = path.resolve(__dirname, '..')
const ROOT = path.resolve(WEB, '..')
const template = readFileSync(path.join(WEB, 'deploy', 'cloudbuild.template.yaml'), 'utf8')
const lifecycle = JSON.parse(readFileSync(path.join(WEB, 'deploy', 'cloudbuild-source-lifecycle.json'), 'utf8'))
const runbook = readFileSync(path.join(ROOT, 'docs', 'despliegue-privado-v1-3.md'), 'utf8')
const prep = readFileSync(path.join(ROOT, 'docs', 'despliegue-v1-6-preparacion.md'), 'utf8')
const checklist = readFileSync(path.join(ROOT, 'docs', 'despliegue-v1-6-aceptacion.md'), 'utf8')
const withoutComments = (yaml: string) => yaml.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n')

const PROJECT = 'demo-proyecto-123'
const ENV = {
  PROJECT_ID: PROJECT,
  REGION: 'northamerica-south1',
  IMAGE_TAG: `northamerica-south1-docker.pkg.dev/${PROJECT}/project-os/dashboard:abc1234`,
}
const ACCOUNT = `project-os-build@${PROJECT}.iam.gserviceaccount.com`
// Se captura el error para que una plantilla rota falle como prueba con nombre, no al importar el archivo.
let renderError: unknown = null
let rendered = ''
try {
  rendered = withoutComments(renderBuildConfig(template, ENV))
} catch (error) {
  renderError = error
}

/** Script del paso de verificación de la configuración generada, con el escape de Cloud Build aplicado ($$ → $). */
function guardScript(): string {
  const lines = rendered.split('\n')
  const start = lines.findIndex((l) => l.trim() === '- |')
  expect(start).toBeGreaterThan(-1)
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('        ')) break
    body.push(line.slice(8))
  }
  return body.join('\n').replaceAll('$$', '$')
}

const stubDir = mkdtempSync(path.join(tmpdir(), 'cb-guard-'))
writeFileSync(path.join(stubDir, 'curl'), '#!/bin/sh\n[ -n "$FAKE_FAIL" ] && exit 22\nprintf %s "$FAKE_EMAIL"\n')
chmodSync(path.join(stubDir, 'curl'), 0o755)
afterAll(() => rmSync(stubDir, { recursive: true, force: true }))

function runGuard(email: string, fail = false) {
  return spawnSync('bash', ['-c', guardScript()], {
    env: { PATH: `${stubDir}:/usr/bin:/bin`, FAKE_EMAIL: email, ...(fail ? { FAKE_FAIL: '1' } : {}) } as unknown as NodeJS.ProcessEnv,
    encoding: 'utf8',
  })
}

describe('plantilla cloudbuild.template.yaml', () => {
  const code = withoutComments(template)

  it('declara serviceAccount con marcadores que no son una cuenta válida si se envía sin generar', () => {
    expect(code).toMatch(/^serviceAccount: 'projects\/__PROJECT_ID__\/serviceAccounts\/__BUILD_SERVICE_ACCOUNT__'$/m)
    expect(code).not.toMatch(/gserviceaccount\.com/)
  })

  it('no usa ninguna sustitución de Cloud Build (solo el escape $$)', () => {
    expect(code.replaceAll('$$', '')).not.toMatch(/\$(\{|[A-Za-z_])/)
  })

  it('logs solo en Cloud Logging (obligatorio con cuenta propia), sin bucket de logs ni secretos', () => {
    expect(code).toMatch(/^options:\n\s+logging: CLOUD_LOGGING_ONLY$/m)
    expect(code).not.toMatch(/logsBucket|availableSecrets|secretEnv/)
  })

  it('solo construye y sube la imagen: no despliega ni toca IAM', () => {
    expect(code).not.toMatch(/gcloud (run|iam|projects|secrets|services)|deploy|kubectl/)
  })

  it('el bucket de origen borra lo subido a los 7 días', () => {
    expect(lifecycle).toEqual({ rule: [{ action: { type: 'Delete' }, condition: { age: 7 } }] })
  })
})

describe('configuración generada (literal)', () => {
  it('la plantilla se convierte en configuración literal sin errores', () => {
    expect(renderError).toBeNull()
  })

  it('declara la cuenta dedicada del proyecto en serviceAccount', () => {
    expect(rendered).toMatch(new RegExp(`^serviceAccount: 'projects/${PROJECT}/serviceAccounts/${ACCOUNT.replaceAll('.', '\\.')}'$`, 'm'))
  })

  it('no conserva marcadores ni sustituciones de Cloud Build', () => {
    expect(rendered).not.toMatch(/__[A-Z_]+__/)
    expect(rendered.replaceAll('$$', '')).not.toMatch(/\$(\{|[A-Za-z_])/)
  })

  it('el primer paso verifica la identidad antes de construir y subir la imagen literal', () => {
    const ids = [...rendered.matchAll(/^\s+- id: (\S+)$/gm)].map((m) => m[1])
    expect(ids).toEqual(['verificar-identidad', 'construir-imagen'])
    expect(rendered).not.toMatch(/waitFor/) // sin paralelismo: la construcción espera a la verificación
    expect(rendered).toContain(`expected='${ACCOUNT}'`)
    expect(rendered).toContain(`args: ['build', '--platform', 'linux/amd64', '-t', '${ENV.IMAGE_TAG}', '.']`)
    expect(rendered).toMatch(new RegExp(`^images:\\n\\s+- '${ENV.IMAGE_TAG.replaceAll('.', '\\.')}'$`, 'm'))
  })

  it.each([
    ['cuenta dedicada del proyecto', ACCOUNT, 0],
    ['predeterminada de Compute', '123456789012-compute@developer.gserviceaccount.com', 1],
    ['heredada de Cloud Build', '123456789012@cloudbuild.gserviceaccount.com', 1],
    ['runtime del servicio', `project-os-dashboard-run@${PROJECT}.iam.gserviceaccount.com`, 1],
    ['dedicada de OTRO proyecto', 'project-os-build@otro-proyecto-9.iam.gserviceaccount.com', 1],
    ['respuesta vacía', '', 1],
  ])('verificación de identidad (metadata server SIMULADO): %s → código %i', (_label, email, status) => {
    const result = runGuard(email)
    expect(result.status).toBe(status)
    if (status) expect(result.stderr).toContain('Build abortado')
    // Nunca imprime la identidad real.
    expect(result.stdout + result.stderr).not.toContain('@')
  })

  it('si el metadata server no responde, el build falla (falla cerrada)', () => {
    expect(runGuard(ACCOUNT, true).status).not.toBe(0)
  })

  it('rechaza una plantilla sin alguno de los marcadores', () => {
    expect(() => renderBuildConfig(template.replace("serviceAccount: 'projects/__PROJECT_ID__/serviceAccounts/__BUILD_SERVICE_ACCOUNT__'", ''), ENV)).toThrow('__PROJECT_ID__')
  })
})

describe('build-command.mjs', () => {
  it('genera el comando con proyecto explícito, cuenta dedicada, región, configuración generada y bucket propio', () => {
    const cmd = buildCommand(ENV, '/tmp/pos-cb.yaml')
    expect(cmd.startsWith('gcloud builds submit web')).toBe(true)
    expect(cmd).toContain(`--project=${PROJECT}`)
    expect(cmd).toContain(`--service-account=projects/${PROJECT}/serviceAccounts/${ACCOUNT}`)
    expect(cmd).toContain('--region=northamerica-south1')
    expect(cmd).toContain(`--gcs-source-staging-dir=gs://${defaultSourceBucket(PROJECT)}/source`)
    expect(cmd).toContain('--config=/tmp/pos-cb.yaml')
    expect(cmd).not.toContain('--substitutions')
  })

  it('no depende del proyecto activo de gcloud: siempre --project=PROJECT_ID, una sola vez', () => {
    const cmd = buildCommand({ ...ENV, CLOUDSDK_CORE_PROJECT: 'proyecto-activo-9', GOOGLE_CLOUD_PROJECT: 'otro-activo-9' })
    expect(cmd.match(/--project=/g)).toHaveLength(1)
    expect(cmd).toContain(`--project=${PROJECT}`)
    expect(cmd).not.toMatch(/proyecto-activo-9|otro-activo-9/)
    expect(() => buildCommand({ ...ENV, PROJECT_ID: '', CLOUDSDK_CORE_PROJECT: PROJECT })).toThrow('falta PROJECT_ID')
  })

  it('el mismo proyecto aparece en --project, --service-account, la configuración y la imagen', () => {
    const text = `${buildCommand(ENV)}\n${rendered}`
    const found = [
      ...[...text.matchAll(/--project=([a-z0-9-]+)/g)],
      ...[...text.matchAll(/projects\/([a-z0-9-]+)\/serviceAccounts/g)],
      ...[...text.matchAll(/@([a-z0-9-]+)\.iam\.gserviceaccount\.com/g)],
      ...[...text.matchAll(/gs:\/\/([a-z0-9-]+)-project-os-build-src/g)],
      ...[...text.matchAll(/-docker\.pkg\.dev\/([a-z0-9-]+)\//g)],
    ].map((m) => m[1])
    expect(found.length).toBeGreaterThanOrEqual(8)
    expect(new Set(found)).toEqual(new Set([PROJECT]))
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
  ])('rechaza BUILD_SA=%s (comando y configuración)', (account, message) => {
    expect(() => buildCommand({ ...ENV, BUILD_SA: account })).toThrow(message)
    expect(() => renderBuildConfig(template, { ...ENV, BUILD_SA: account })).toThrow(message)
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

  it.each(['/tmp/project-os-cloudbuild.yaml', '/home/user/build/cb.v2.yml', '/tmp/a_b-c/x.yaml', '/tmp/-config.yaml'])(
    'acepta la ruta de configuración %s',
    (configPath) => {
      expect(validateConfigPath(configPath)).toBe(configPath)
      expect(buildCommand(ENV, configPath)).toContain(`--config=${configPath} \\\n`)
    },
  )

  it.each([
    ['/tmp/a;touch x.yaml', 'punto y coma'],
    ['/tmp/$(id).yaml', 'sustitución $( )'],
    ['/tmp/$HOME.yaml', 'variable $'],
    ['/tmp/`id`.yaml', 'backticks'],
    ["/tmp/a'b.yaml", 'comilla simple'],
    ['/tmp/a"b.yaml', 'comilla doble'],
    ['/tmp/a|b.yaml', 'tubería'],
    ['/tmp/a&b.yaml', 'ampersand'],
    ['/tmp/a>b.yaml', 'redirección >'],
    ['/tmp/a<b.yaml', 'redirección <'],
    ['/tmp/(a).yaml', 'paréntesis'],
    ['/tmp/*.yaml', 'comodín *'],
    ['/tmp/a?.yaml', 'comodín ?'],
    ['/tmp/a b.yaml', 'espacio'],
    ['/tmp/a\tb.yaml', 'tabulador'],
    ['/tmp/a\nb.yaml', 'salto de línea'],
    ['/tmp/a.yaml\n', 'salto de línea final'],
    ['/tmp/a\\b.yaml', 'barra invertida'],
    ['/tmp/a#b.yaml', 'almohadilla'],
    ['/tmp/a!b.yaml', 'exclamación'],
    ['/tmp/a{b,c}.yaml', 'llaves'],
    ['/tmp/ñ.yaml', 'carácter no ASCII'],
    ['~/cb.yaml', 'tilde'],
    ['relativa.yaml', 'ruta relativa'],
    ['/tmp/../etc/cb.yaml', 'segmento ..'],
    ['/tmp/./cb.yaml', 'segmento .'],
    ['//cb.yaml', 'segmento vacío'],
    ['/tmp/cb.json', 'extensión no YAML'],
    ['', 'vacía'],
  ])('rechaza la ruta de configuración con %s (%s)', (configPath) => {
    expect(() => validateConfigPath(configPath)).toThrow('ruta de la configuración')
    expect(() => buildCommand(ENV, configPath)).toThrow('ruta de la configuración')
  })

  it('el comando generado se interpreta en bash como argumentos literales, sin expansiones', () => {
    const cmd = buildCommand(ENV, '/tmp/project-os-cloudbuild.yaml')
    const result = spawnSync('bash', ['-c', `set -euo pipefail; gcloud() { printf '%s\\n' "$@"; }; ${cmd}`], {
      env: { PATH: '/usr/bin:/bin' } as unknown as NodeJS.ProcessEnv,
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    expect(result.stdout.trimEnd().split('\n')).toEqual([
      'builds', 'submit', 'web',
      `--project=${PROJECT}`,
      '--config=/tmp/project-os-cloudbuild.yaml',
      '--region=northamerica-south1',
      `--service-account=projects/${PROJECT}/serviceAccounts/${ACCOUNT}`,
      `--gcs-source-staging-dir=gs://${defaultSourceBucket(PROJECT)}/source`,
    ])
  })

  it('los errores nombran variables, nunca imprimen valores', () => {
    expect(() => buildCommand({ ...ENV, BUILD_SA: '123456789012-compute@developer.gserviceaccount.com' })).toThrow(/^(?!.*123456789012)/)
  })
})

describe('build-command.mjs como CLI (sin GCP)', () => {
  const script = path.join(WEB, 'deploy', 'build-command.mjs')
  const cli = (args: string[], cwd: string) =>
    spawnSync(process.execPath, [script, ...args], { cwd, env: { ...process.env, ...ENV, BUILD_SA: '' }, encoding: 'utf8' })

  it('con una ruta válida escribe la configuración (0600) e imprime el comando que la usa', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cb-cli-'))
    try {
      const out = path.join(dir, 'cb.yaml')
      const result = cli([`--config-out=${out}`], dir)
      expect(result.status).toBe(0)
      expect(result.stdout).toContain(`--config=${out} \\\n`)
      expect(statSync(out).mode & 0o777).toBe(0o600)
      expect(readFileSync(out, 'utf8')).toContain(`serviceAccount: 'projects/${PROJECT}/serviceAccounts/${ACCOUNT}'`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Sin espacios: con la validación anterior (solo ruta absoluta y sin espacios) estos nombres se aceptaban.
  it.each(['$(id).yaml', 'a;id.yaml', '`id`.yaml', "a'b.yaml"])(
    'con --config-out malicioso (%s) falla sin escribir nada ni ejecutar el contenido',
    (name) => {
      const dir = mkdtempSync(path.join(tmpdir(), 'cb-cli-'))
      try {
        const result = cli([`--config-out=${dir}/${name}`], dir)
        expect(result.status).toBe(1)
        expect(result.stdout).toBe('')
        expect(result.stderr).toContain('ruta de la configuración')
        expect(readdirSync(dir)).toEqual([])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
})

describe('documentación de la compilación', () => {
  const blocks = (text: string) => [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => (m[1] ?? '').replace(/\\\n\s*/g, ' '))
  const commands = (text: string, prefix: RegExp) => [
    ...blocks(text).flatMap((b) => b.split('\n')),
    ...[...text.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? ''),
  ].filter((l) => prefix.test(l))

  it('todo `gcloud builds submit` documentado lleva --project, la configuración generada y --service-account de la cuenta dedicada', () => {
    const submits = commands(runbook, /^\s*gcloud builds submit /)
    expect(submits.length).toBeGreaterThan(0)
    for (const c of submits) {
      expect(c).toMatch(/--project="?\$\{?PROJECT_ID\}?"?/)
      expect(c).toMatch(/--service-account="?projects\/\$\{?PROJECT_ID\}?\/serviceAccounts\/\$\{?BUILD_SA\}?/)
      expect(c).toMatch(/--config=\/tmp\/project-os-cloudbuild\.yaml/)
    }
    expect(runbook).toContain('node web/deploy/build-command.mjs --config-out=/tmp/project-os-cloudbuild.yaml')
  })

  it('todo comando `gcloud builds` documentado fija --project', () => {
    // Invocaciones con argumentos; una mención del nombre del comando en prosa no cuenta.
    const all = [...commands(runbook, /^\s*gcloud builds \S+ \S/), ...commands(checklist, /^\s*gcloud builds \S+ \S/)]
    expect(all.length).toBeGreaterThanOrEqual(4)
    for (const c of all) expect(c, c).toMatch(/--project[= ]"?\$\{?PROJECT_ID\}?"?/)
  })

  it('la cuenta dedicada y sus roles coinciden con la configuración', () => {
    expect(runbook).toContain('BUILD_SA="project-os-build@${PROJECT_ID}.iam.gserviceaccount.com"')
    for (const role of ['roles/logging.logWriter', 'roles/artifactregistry.writer', 'roles/storage.objectViewer', 'roles/iam.serviceAccountUser']) {
      expect(runbook, role).toContain(role)
    }
    expect(runbook).toContain('--lifecycle-file=web/deploy/cloudbuild-source-lifecycle.json')
  })

  it('declara que la verificación contra el metadata server solo está simulada', () => {
    for (const [name, text] of [['runbook', runbook], ['preparación', prep], ['checklist', checklist]]) {
      expect(text, name).toMatch(/metadata server[^.]*solo está simulad[oa]/i)
    }
  })

  it.each([['runbook', runbook], ['preparación', prep]])('%s: nunca concede Editor ni Propietario a una cuenta', (_name, text) => {
    for (const block of blocks(text)) expect(block).not.toMatch(/--role[= ]roles\/(editor|owner)\b/)
  })
})
