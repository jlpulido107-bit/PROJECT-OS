import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { render } from '../deploy/cloudrun/render.mjs'

/** Revisión estática (dry-run) de los artefactos de despliegue: nada se aplica a Google Cloud. */

const root = path.join(__dirname, '..')
const template = readFileSync(path.join(root, 'deploy', 'cloudrun', 'service.template.yaml'), 'utf8')
const dockerfile = readFileSync(path.join(root, 'Dockerfile'), 'utf8')
const dockerignore = readFileSync(path.join(root, '.dockerignore'), 'utf8')
const cleanup = JSON.parse(readFileSync(path.join(root, 'deploy', 'cloudrun', 'artifact-cleanup-policy.json'), 'utf8'))

/** Valor YAML de una clave simple (`clave: valor`) sin comillas. */
function yamlValue(key: string): string | undefined {
  const match = new RegExp(`^\\s*${key.replace(/[./]/g, '\\$&')}:\\s*(.+)$`, 'm').exec(template)
  return match?.[1]?.trim().replace(/^'(.*)'$/, '$1')
}

/** Nombres de variables de entorno y si vienen de Secret Manager. */
function envEntries() {
  const entries: Array<{ name: string; secret: boolean; value?: string }> = []
  const lines = template.split('\n')
  lines.forEach((line, i) => {
    const name = /^\s*- name: ([A-Z_]+)\s*$/.exec(line)?.[1]
    if (!name) return
    const next = lines[i + 1] ?? ''
    entries.push({ name, secret: /valueFrom:/.test(next), value: /value: (.+)$/.exec(next)?.[1]?.trim() })
  })
  return entries
}

describe('plantilla de Cloud Run', () => {
  it('controla costos: escala a cero, máximo 1 instancia, CPU por solicitud, 512 MiB', () => {
    expect(yamlValue('autoscaling.knative.dev/minScale')).toBe('0')
    expect(yamlValue('autoscaling.knative.dev/maxScale')).toBe('1')
    expect(yamlValue('run.googleapis.com/cpu-throttling')).toBe('true')
    expect(yamlValue('memory')).toBe('512Mi')
    expect(yamlValue('cpu')).toBe('1')
  })

  it('usa identidad dedicada con ADC y verifica la cuenta esperada', () => {
    expect(yamlValue('serviceAccountName')).toBe('${RUNTIME_SA}')
    const env = envEntries()
    expect(env.find((e) => e.name === 'SHEETS_CREDENTIALS')?.value).toBe('adc')
    expect(env.find((e) => e.name === 'SHEETS_EXPECTED_SERVICE_ACCOUNT')?.value).toBe('${RUNTIME_SA}')
    expect(env.find((e) => e.name === 'DASHBOARD_DATA_SOURCE')?.value).toBe('sheets')
  })

  it('no contiene claves JSON ni rutas de credenciales', () => {
    expect(template).not.toMatch(/PROJECT_OS_GOOGLE_SERVICE_ACCOUNT|GOOGLE_APPLICATION_CREDENTIALS|private_key|BEGIN [A-Z ]*PRIVATE/)
  })

  it('los secretos y la lista de correos vienen de Secret Manager con versión fijada', () => {
    const env = envEntries()
    for (const name of ['NEXTAUTH_SECRET', 'GOOGLE_CLIENT_SECRET', 'AUTH_ALLOWED_EMAILS']) {
      expect(env.find((e) => e.name === name)?.secret, name).toBe(true)
    }
    expect(template).not.toMatch(/key: '?latest'?/)
    expect(template).not.toMatch(/@(gmail|hotmail|outlook|yahoo)\./i)
  })

  it('nunca habilita escritura: sin PROJECT_OS_WRITE_MODE (o solo "disabled") ni AUTH_WRITER_EMAILS', () => {
    // V1.4 añade escritura simulada; en producción debe quedar ausente o deshabilitada (revisión de V1.3).
    const env = envEntries()
    const mode = env.find((e) => e.name === 'PROJECT_OS_WRITE_MODE')
    expect(mode === undefined || (!mode.secret && mode.value?.replace(/^'(.*)'$/, '$1') === 'disabled'), 'PROJECT_OS_WRITE_MODE').toBe(true)
    expect(env.map((e) => e.name)).not.toContain('AUTH_WRITER_EMAILS')
    expect(template).not.toMatch(/auth\/spreadsheets['"\s]|auth\/drive/)
  })

  it('no fija PORT (lo inyecta Cloud Run) y la imagen va por digest', () => {
    expect(envEntries().map((e) => e.name)).not.toContain('PORT')
    expect(yamlValue('- image')).toBe('${IMAGE}')
    expect(template).toMatch(/IMAGE \(con @sha256:…\)/)
  })

  it('sonda de arranque en /api/health y entrada documentada', () => {
    expect(template).toMatch(/startupProbe:\s+httpGet:\s+path: \/api\/health/)
    expect(yamlValue('run.googleapis.com/ingress')).toBe('all')
  })
})

describe('Dockerfile y contexto de build', () => {
  it('imagen base Node 22 fijada por digest, usuario no root y npm ci', () => {
    expect(dockerfile).toMatch(/ARG NODE_IMAGE=docker\.io\/library\/node:22\.[\d.]+-bookworm-slim@sha256:[0-9a-f]{64}/)
    expect(dockerfile).toMatch(/^USER node$/m)
    expect(dockerfile).toMatch(/npm ci --ignore-scripts/)
    expect(dockerfile).toMatch(/NEXT_OUTPUT=standalone/)
    expect(dockerfile).not.toMatch(/^(ENV|ARG) .*(SECRET|PRIVATE|TOKEN|ALLOWED_EMAILS)/m)
  })

  it('el contexto excluye todo salvo lo necesario (lista de permitidos)', () => {
    const lines = dockerignore.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    expect(lines[0]).toBe('**')
    expect(lines.slice(1).sort()).toEqual(['!next.config.ts', '!package-lock.json', '!package.json', '!src/**', '!tsconfig.json'])
  })

  it('gcloud builds submit sube solo lo que necesita el Dockerfile (lista de permitidos)', () => {
    // Sin .gcloudignore, gcloud sube todo lo que no excluya .gitignore (p. ej. un `.env` o una clave JSON).
    const gcloudignore = readFileSync(path.join(root, '.gcloudignore'), 'utf8')
    const lines = gcloudignore.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    expect(lines[0]).toBe('/*')
    expect(lines.slice(1).sort()).toEqual([
      '!/.dockerignore', '!/Dockerfile', '!/next.config.ts', '!/package-lock.json', '!/package.json', '!/src/', '!/tsconfig.json',
    ])
  })
})

describe('limpieza de Artifact Registry', () => {
  it('conserva las 3 versiones más recientes y borra las mayores de 30 días', () => {
    expect(cleanup).toEqual([
      expect.objectContaining({ action: { type: 'Keep' }, mostRecentVersions: { keepCount: 3 } }),
      expect.objectContaining({ action: { type: 'Delete' }, condition: { tagState: 'ANY', olderThan: '2592000s' } }),
    ])
  })
})

describe('renderizado de la plantilla (sin contactar Google Cloud)', () => {
  const VARS = {
    SERVICE_NAME: 'project-os-dashboard',
    PROJECT_ID: 'proyecto-ejemplo',
    REGION: 'us-central1',
    IMAGE: `us-central1-docker.pkg.dev/proyecto-ejemplo/project-os/dashboard@sha256:${'a'.repeat(64)}`,
    RUNTIME_SA: 'project-os-dashboard-run@proyecto-ejemplo.iam.gserviceaccount.com',
    SERVICE_URL: 'https://project-os-dashboard-123456789.us-central1.run.app',
    OAUTH_CLIENT_ID: '123456789-abc.apps.googleusercontent.com',
    SECRET_VERSION_NEXTAUTH: '1',
    SECRET_VERSION_OAUTH: '2',
    SECRET_VERSION_ALLOWLIST: '1',
  }

  it('sustituye todas las variables', () => {
    const out = render(template, VARS)
    expect(out).not.toMatch(/\$\{[A-Z_]+\}/)
    expect(out).toContain(`serviceAccountName: ${VARS.RUNTIME_SA}`)
    expect(out).toContain(`value: ${VARS.SERVICE_URL}`)
    expect(out).toMatch(/name: project-os-google-client-secret\s+key: '2'/)
  })

  it.each([
    ['SERVICE_URL', 'http://inseguro.example'],
    ['IMAGE', 'us-central1-docker.pkg.dev/proyecto-ejemplo/project-os/dashboard:latest'],
    ['RUNTIME_SA', 'project-os-dashboard-run@otro-proyecto.iam.gserviceaccount.com'],
    ['SECRET_VERSION_OAUTH', 'latest'],
    ['OAUTH_CLIENT_ID', ''],
  ])('rechaza %s inseguro o ausente sin mostrar su valor', (name, value) => {
    let message = ''
    try {
      render(template, { ...VARS, [name]: value })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(name)
    if (value) expect(message).not.toContain(value)
  })
})
