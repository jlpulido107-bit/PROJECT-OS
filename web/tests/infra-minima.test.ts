import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * Controles de seguridad del script de infraestructura mínima (Puerta B, V2). Todo es estático o local:
 * se lee el texto del script, se cargan sus funciones con `source` (no ejecuta `main`) y se corre `--plan`
 * con un `gcloud` falso que deja una marca si alguien lo invoca. Nunca se simula `--apply`.
 */
const SCRIPT = path.resolve(__dirname, '..', 'deploy', 'infra', 'project-os-infra-minima-v1-6.sh')
const text = readFileSync(SCRIPT, 'utf8')
const BUILD_SA = 'project-os-build@project-os-511102.iam.gserviceaccount.com'
const RUNTIME_SA = 'project-os-dashboard-run@project-os-511102.iam.gserviceaccount.com'

/** Líneas lógicas (con continuaciones `\` unidas), sin comentarios ni el heredoc del plan o del ayudante Python. */
const code = (() => {
  const lines = text.replace(/\\\n\s*/g, ' ').split('\n')
  const out: Array<{ n: number; line: string }> = []
  let heredoc: string | null = null
  lines.forEach((line, n) => {
    if (heredoc) {
      if (line.trim() === heredoc) heredoc = null
      return
    }
    const start = /<<'?([A-Z]+)'?/.exec(line)
    if (start?.[1]) heredoc = start[1]
    if (!line.trim().startsWith('#')) out.push({ n, line })
  })
  return out
})()
/** Invocaciones de gcloud con su posición en el script. */
const gcloud = code.flatMap(({ n, line }) => [...line.matchAll(/gcloud (?:auth|projects|services|iam|artifacts|storage|builds|run|secrets|config) [^|)]*/g)].map((m) => ({ n, cmd: m[0].trim() })))
const MUTATING = /^gcloud (services enable|.*\bcreate\b|.*\bupdate\b|.*\bdelete\b|.*add-iam-policy-binding|.*remove-iam-policy-binding|.*set-iam-policy|builds |run )/
const ackLine = code.find(({ line }) => /read -r -p .*ACK_TEXT/.test(line))?.n ?? -1

function bash(script: string, input = '') {
  return spawnSync('bash', ['-c', `source "${SCRIPT}"; ${script}`], { input, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } as unknown as NodeJS.ProcessEnv })
}

describe('script de infraestructura mínima V2: controles estáticos', () => {
  it('no hay ninguna llamada mutante a gcloud antes de la confirmación AUTORIZO', () => {
    expect(ackLine).toBeGreaterThan(0)
    const before = gcloud.filter((g) => g.n < ackLine)
    expect(before.length).toBeGreaterThanOrEqual(7)
    for (const g of before) expect(g.cmd, g.cmd).not.toMatch(MUTATING)
  })

  it('orden de cambios: bucket primero (con ciclo de vida), repositorio, cuenta runtime y luego IAM mínimo', () => {
    const muts = gcloud.filter((g) => MUTATING.test(g.cmd)).map((g) => (g.cmd.split(' --')[0] ?? '').trim())
    expect(muts).toEqual([
      'gcloud storage buckets create "gs://${BUCKET}"',
      'gcloud artifacts repositories create "$REPO"',
      'gcloud iam service-accounts create "$RUNTIME_SA_NAME"',
      'gcloud projects add-iam-policy-binding "$PROJECT_ID"',
      'gcloud artifacts repositories add-iam-policy-binding "$REPO"',
      'gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}"',
    ])
  })

  it('el bucket se crea privado, sin borrado diferido y con el ciclo de vida incorporado; no hay `update` posterior', () => {
    const create = gcloud.find((g) => g.cmd.startsWith('gcloud storage buckets create'))?.cmd ?? ''
    for (const flag of ['--uniform-bucket-level-access', '--public-access-prevention', '--soft-delete-duration=0', '--lifecycle-file="$LIFECYCLE_FILE"', '--location="$REGION"']) {
      expect(create, flag).toContain(flag)
    }
    expect(text).not.toMatch(/buckets update/)
    expect(text).toContain(`readonly LIFECYCLE_JSON='{"rule":[{"action":{"type":"Delete"},"condition":{"age":7}}]}'`)
  })

  it('todo comando de gcloud (salvo `auth list`) lleva --project explícito', () => {
    for (const g of gcloud.filter((x) => !x.cmd.startsWith('gcloud auth list'))) {
      expect(g.cmd, g.cmd).toContain('--project="$PROJECT_ID"')
    }
  })

  it('IAM: solo los tres permisos mínimos para project-os-build, sin imprimir la política resultante', () => {
    const bindings = gcloud.filter((g) => /add-iam-policy-binding/.test(g.cmd))
    expect(bindings.map((b) => /--role=(\S+)/.exec(b.cmd)?.[1])).toEqual([
      'roles/logging.logWriter', 'roles/artifactregistry.writer', 'roles/storage.objectViewer',
    ])
    for (const b of bindings) {
      expect(b.cmd).toContain('--member="serviceAccount:${BUILD_SA}"')
      expect(b.cmd).toContain('--format=none')
    }
    expect(text).not.toMatch(/--role=roles\/(editor|owner)\b/)
    expect(text).not.toMatch(/--member="?serviceAccount:\$\{RUNTIME_SA\}/)
    expect(text).toContain('readonly ALLOWED_BUILD_PROJECT_ROLES=(roles/logging.logWriter)')
  })

  it('fuera de alcance: no habilita APIs, ni secretos, ni claves, ni builds, ni Cloud Run, ni set-iam-policy', () => {
    for (const forbidden of [/services enable/, /secretmanager/, /gcloud secrets/, /keys create/, /builds submit/, /gcloud run /, /set-iam-policy/]) {
      expect(code.map((c) => c.line).join('\n'), String(forbidden)).not.toMatch(forbidden)
    }
  })

  it('las políticas IAM se leen como JSON y se procesan sin imprimirse ni escribirse a disco', () => {
    for (const g of gcloud.filter((x) => /get-iam-policy/.test(x.cmd))) expect(g.cmd).toContain('--format=json')
    expect(text).not.toMatch(/get-iam-policy[^\n]*--format='?(yaml|table)/)
    const writes = code.filter(({ line }) => /[^2]>\s*"\$/.test(line)).map(({ line }) => line.trim())
    expect(writes).toEqual(['printf \'%s\\n\' "$LIFECYCLE_JSON" > "$LIFECYCLE_FILE"'])
    expect(text.match(/mktemp/g)).toHaveLength(1)
  })

  it('la cuenta activa solo se muestra enmascarada', () => {
    const prints = code.filter(({ line }) => /(echo|printf)[^\n]*active_account/.test(line))
    expect(prints.length).toBeGreaterThan(0)
    for (const { line } of prints) expect(line).toContain('$(mask_account "$active_account")')
  })

  it('la auditoría del bucket usa los nombres snake_case del SDK y verifica cada protección', () => {
    expect(text).toContain("--format='json(name,location,uniform_bucket_level_access,public_access_prevention,soft_delete_policy,lifecycle_config)'")
    expect(text).not.toMatch(/iamConfiguration|softDeletePolicy\b/)
  })

  it('las APIs se consultan una sola vez y un error de consulta se distingue de una API deshabilitada', () => {
    expect(gcloud.filter((g) => g.cmd.startsWith('gcloud services list'))).toHaveLength(1)
    expect(text).toMatch(/enabled_apis="\$\(gcloud services list[^\n]*\)" \\\n\s+\|\| die 'no se pudieron consultar las APIs/)
    expect(text).toContain('Este script no las habilita')
  })
})

describe('script de infraestructura mínima V2: funciones (cargadas con source, sin gcloud)', () => {
  it('cargar el script no ejecuta nada', () => {
    const r = bash('true')
    expect(r.status).toBe(0)
    expect(r.stdout + r.stderr).toBe('')
  })

  it.each([
    ['project-os', 0],
    ['projects/project-os-511102/locations/northamerica-south1/repositories/project-os', 0],
    ['otro\nproject-os', 0],
    ['my-project-os', 1],
    ['project-os-old', 1],
    ['projects/p/locations/r/repositories/project-os-2', 1],
    ['', 1],
  ])('repo_in_list(%j) → %i', (list, status) => {
    expect(bash(`repo_in_list "$(cat)"`, list).status).toBe(status)
  })

  it.each([
    ['project-os-511102-project-os-build-src', 0],
    ['gs://project-os-511102-project-os-build-src/', 0],
    ['project-os-511102-project-os-build-src-old', 1],
    ['', 1],
  ])('bucket_in_list(%j) → %i', (list, status) => {
    expect(bash(`bucket_in_list "$(cat)"`, list).status).toBe(status)
  })

  it('missing_apis lista solo las requeridas que faltan', () => {
    const all = 'cloudbuild.googleapis.com\nartifactregistry.googleapis.com\niam.googleapis.com\nstorage.googleapis.com\nrun.googleapis.com'
    expect(bash('missing_apis "$(cat)"', all).stdout).toBe('')
    expect(bash('missing_apis "$(cat)"', 'iam.googleapis.com\ncloudbuild.googleapis.comX').stdout.trim().split('\n')).toEqual([
      'cloudbuild.googleapis.com', 'artifactregistry.googleapis.com', 'storage.googleapis.com',
    ])
  })

  it('mask_account muestra solo el dominio', () => {
    expect(bash('mask_account persona.real@gmail.com').stdout).toBe('***@gmail.com')
  })

  const policy = (bindings: Array<[string, string[]]>) => JSON.stringify({ bindings: bindings.map(([role, members]) => ({ role, members })) })
  const sa = `serviceAccount:${BUILD_SA}`

  it.each([
    ['sin roles', 0, '', []],
    ['solo logWriter', 0, '', [['roles/logging.logWriter', [sa]]]],
    ['Editor', 3, 'roles/editor', [['roles/editor', [sa]]]],
    ['Owner', 3, 'roles/owner', [['roles/owner', [sa]]]],
    ['run.admin (no está en la lista)', 3, 'roles/run.admin', [['roles/logging.logWriter', [sa]], ['roles/run.admin', [sa]]]],
    ['Editor de OTRO miembro', 0, '', [['roles/editor', ['user:otra@example.com']]]],
  ] as Array<[string, number, string, Array<[string, string[]]>]>)('lista de roles permitidos — %s → código %i', (_l, status, out, bindings) => {
    const r = bash(`py unexpected "${sa}" "\${ALLOWED_BUILD_PROJECT_ROLES[@]}"`, policy(bindings))
    expect(r.status).toBe(status)
    expect(r.stdout.trim()).toBe(out)
    expect(r.stdout).not.toContain('@')
  })

  it('JSON de política no válido detiene la comprobación (código 2)', () => {
    expect(bash(`py unexpected "${sa}" roles/logging.logWriter`, 'no es json').status).toBe(2)
  })

  it('py has / py roles', () => {
    const p = policy([['roles/storage.objectViewer', [sa]]])
    expect(bash(`py has "${sa}" roles/storage.objectViewer`, p).status).toBe(0)
    expect(bash(`py has "${sa}" roles/storage.admin`, p).status).toBe(1)
    expect(bash(`py roles "serviceAccount:${RUNTIME_SA}"`, p).stdout.trim()).toBe('')
  })

  const good = {
    name: 'project-os-511102-project-os-build-src', location: 'NORTHAMERICA-SOUTH1', uniform_bucket_level_access: true,
    public_access_prevention: 'enforced', soft_delete_policy: { retentionDurationSeconds: '0' },
    lifecycle_config: { rule: [{ action: { type: 'Delete' }, condition: { age: 7 } }] },
  }

  it('verificación del bucket: todas las protecciones → OK', () => {
    const r = bash('py bucket northamerica-south1', JSON.stringify(good))
    expect(r.status).toBe(0)
    expect(r.stdout.match(/^OK /gm)).toHaveLength(5)
  })

  it.each([
    ['otra región', { location: 'US' }],
    ['sin acceso uniforme', { uniform_bucket_level_access: false }],
    ['acceso público heredado', { public_access_prevention: 'inherited' }],
    ['borrado diferido de 7 días', { soft_delete_policy: { retentionDurationSeconds: '604800' } }],
    ['sin política de borrado diferido', { soft_delete_policy: null }],
    ['sin ciclo de vida', { lifecycle_config: null }],
    ['ciclo de vida distinto', { lifecycle_config: { rule: [{ action: { type: 'Delete' }, condition: { age: 30 } }] } }],
    ['claves camelCase (formato --raw)', { uniform_bucket_level_access: undefined, iamConfiguration: { uniformBucketLevelAccess: { enabled: true } } }],
  ])('verificación del bucket: %s → FALLA', (_l, override) => {
    const r = bash('py bucket northamerica-south1', JSON.stringify({ ...good, ...override }))
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(/^FALLA /m)
  })
})

describe('script de infraestructura mínima V2: --plan', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'infra-plan-'))
  const marker = path.join(dir, 'gcloud-invocado')
  writeFileSync(path.join(dir, 'gcloud'), `#!/bin/sh\ntouch "${marker}"\nexit 99\n`)
  chmodSync(path.join(dir, 'gcloud'), 0o755)
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const run = (args: string[]) =>
    spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: `${dir}:/usr/bin:/bin` } as unknown as NodeJS.ProcessEnv })

  it('--plan (y sin argumentos) muestra requisitos, alcance y pendientes sin invocar gcloud', () => {
    for (const args of [['--plan'], []]) {
      const r = run(args)
      expect(r.status).toBe(0)
      expect(existsSync(marker)).toBe(false)
      for (const t of ['Requisitos previos', 'project-os-build@project-os-511102.iam.gserviceaccount.com ya existe',
        'cloudbuild.googleapis.com artifactregistry.googleapis.com iam.googleapis.com storage.googleapis.com',
        'incluida Secret Manager', 'PENDIENTE ANTES DEL PRIMER DESPLIEGUE: política de limpieza de imágenes',
        'Modo vista previa: no se llamó a gcloud.']) {
        expect(r.stdout, t).toContain(t)
      }
    }
  })

  it('argumentos inválidos → uso y código 2, sin invocar gcloud', () => {
    for (const args of [['--foo'], ['--plan', '--apply']]) {
      expect(run(args).status).toBe(2)
    }
    expect(existsSync(marker)).toBe(false)
  })
})
