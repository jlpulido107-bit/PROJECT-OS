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
  it('conserva la imagen de producción y las 3 versiones más recientes, y borra las mayores de 30 días', () => {
    expect(cleanup).toEqual([
      expect.objectContaining({ name: 'conservar-produccion', action: { type: 'Keep' }, condition: { tagState: 'TAGGED', tagPrefixes: ['produccion'] } }),
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

  it('DEPLOY_COMMIT_SHA (ORD-POS-124): literal entre comillas, opcional y solo un SHA completo', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567'
    expect(render(template, { ...VARS, DEPLOY_COMMIT_SHA: sha })).toContain(`- name: DEPLOY_COMMIT_SHA\n              value: '${sha}'\n`)
    // Un SHA solo de dígitos no debe leerse como número.
    expect(render(template, { ...VARS, DEPLOY_COMMIT_SHA: '1'.repeat(40) })).toContain(`value: '${'1'.repeat(40)}'`)
    expect(render(template, VARS)).not.toContain('DEPLOY_COMMIT_SHA')
    for (const malo of ['abc1234', sha.toUpperCase(), `${sha}0`, 'main']) {
      expect(() => render(template, { ...VARS, DEPLOY_COMMIT_SHA: malo })).toThrow('DEPLOY_COMMIT_SHA debe ser un SHA completo')
    }
  })

  it('sin WRITE_MODE la salida es de solo lectura (igual que V1.6)', () => {
    const out = render(template, VARS)
    expect(out).not.toMatch(/PROJECT_OS_WRITE_MODE|AUTH_WRITER_EMAILS|__ESCRITURA__/)
  })

  it('con WRITE_MODE=sheets agrega la cuenta de escritura y el secreto de escritores por versión fijada', () => {
    const WRITE = { WRITE_MODE: 'sheets', WRITE_SERVICE_ACCOUNT: 'project-os-writer@proyecto-ejemplo.iam.gserviceaccount.com', SECRET_VERSION_WRITERS: '1' }
    const out = render(template, { ...VARS, ...WRITE })
    expect(out).toMatch(/- name: PROJECT_OS_WRITE_MODE\n\s+value: sheets/)
    expect(out).toContain('value: project-os-writer@proyecto-ejemplo.iam.gserviceaccount.com')
    expect(out).toMatch(/name: project-os-writer-emails\n\s+key: '1'/)
    expect(out).toMatch(/maxScale: '1'/)
    for (const [k, v, msg] of ([
      ['WRITE_MODE', 'mock', 'WRITE_MODE'],
      ['WRITE_SERVICE_ACCOUNT', VARS.RUNTIME_SA, 'cuenta runtime'],
      ['WRITE_SERVICE_ACCOUNT', 'project-os-writer@otro-proyecto.iam.gserviceaccount.com', 'PROJECT_ID'],
      ['SECRET_VERSION_WRITERS', 'latest', 'SECRET_VERSION_WRITERS'],
    ] as Array<[string, string, string]>)) expect(() => render(template, { ...VARS, ...WRITE, [k]: v }), `${k}=${v}`).toThrow(msg)
    // F4: token de GitHub opcional, solo por versión fijada.
    expect(out).not.toContain('GITHUB_DISPATCH_TOKEN')
    const withGithub = render(template, { ...VARS, ...WRITE, SECRET_VERSION_GITHUB: '1' })
    expect(withGithub).toMatch(/- name: GITHUB_DISPATCH_TOKEN\n\s+valueFrom:\n\s+secretKeyRef:\n\s+name: project-os-github-token\n\s+key: '1'/)
    expect(() => render(template, { ...VARS, ...WRITE, SECRET_VERSION_GITHUB: 'latest' })).toThrow('SECRET_VERSION_GITHUB')
    // F5a: rutina de Claude opcional; ID y versión del token van juntos y exigen el token de GitHub.
    expect(withGithub).not.toContain('CLAUDE_ROUTINE')
    const RUTINA = { SECRET_VERSION_GITHUB: '1', CLAUDE_ROUTINE_ID: 'trig_01ABCdef234', SECRET_VERSION_CLAUDE_ROUTINE: '2' }
    const withRoutine = render(template, { ...VARS, ...WRITE, ...RUTINA })
    expect(withRoutine).toMatch(/- name: CLAUDE_ROUTINE_ID\n\s+value: trig_01ABCdef234/)
    expect(withRoutine).toMatch(/- name: CLAUDE_ROUTINE_TOKEN\n\s+valueFrom:\n\s+secretKeyRef:\n\s+name: project-os-claude-routine-token\n\s+key: '2'/)
    expect(() => render(template, { ...VARS, ...WRITE, ...RUTINA, SECRET_VERSION_CLAUDE_ROUTINE: '' })).toThrow('van juntos')
    expect(() => render(template, { ...VARS, ...WRITE, ...RUTINA, SECRET_VERSION_GITHUB: '' })).toThrow('exige SECRET_VERSION_GITHUB')
    expect(() => render(template, { ...VARS, ...WRITE, ...RUTINA, CLAUDE_ROUTINE_ID: '../x y' })).toThrow('CLAUDE_ROUTINE_ID')
    expect(() => render(template, { ...VARS, ...WRITE, ...RUTINA, SECRET_VERSION_CLAUDE_ROUTINE: 'latest' })).toThrow('SECRET_VERSION_CLAUDE_ROUTINE')
    // Sin escritura real no se inyecta nada de la rutina (va dentro del bloque de escritura).
    expect(render(template, { ...VARS, ...RUTINA })).not.toContain('CLAUDE_ROUTINE')
    // ORD-POS-037: rutinas de revisión, segundo revisor y corrección, opcionales y por parejas.
    for (const n of ['REVISAR', 'SEGUNDO', 'CORREGIR']) {
      const par = { SECRET_VERSION_GITHUB: '1', [`CLAUDE_ROUTINE_${n}_ID`]: 'trig_01ABCdef234', [`SECRET_VERSION_CLAUDE_ROUTINE_${n}`]: '3' }
      expect(render(template, { ...VARS, ...WRITE, ...par })).toMatch(new RegExp(`- name: CLAUDE_ROUTINE_${n}_ID\\n\\s+value: trig_01ABCdef234\\n\\s+- name: CLAUDE_ROUTINE_${n}_TOKEN\\n\\s+valueFrom:\\n\\s+secretKeyRef:\\n\\s+name: project-os-claude-routine-${n.toLowerCase()}-token\\n\\s+key: '3'`))
      expect(() => render(template, { ...VARS, ...WRITE, ...par, [`SECRET_VERSION_CLAUDE_ROUTINE_${n}`]: '' })).toThrow('van juntos')
      expect(() => render(template, { ...VARS, ...WRITE, ...par, SECRET_VERSION_GITHUB: '' })).toThrow('exige SECRET_VERSION_GITHUB')
      expect(() => render(template, { ...VARS, ...WRITE, ...par, [`CLAUDE_ROUTINE_${n}_ID`]: '../x y' })).toThrow('no tiene el formato')
    }
    expect(render(template, { ...VARS, ...WRITE, SECRET_VERSION_GITHUB: '1' })).not.toMatch(/CLAUDE_ROUTINE_(REVISAR|SEGUNDO|CORREGIR)/)
    // ORD-POS-028: acceso del agente PM opcional, solo por versión fijada del secreto del hash.
    expect(out).not.toContain('PM_AGENT_TOKEN_SHA256')
    const withPm = render(template, { ...VARS, ...WRITE, SECRET_VERSION_PM_AGENT: '4' })
    expect(withPm).toMatch(/- name: PM_AGENT_TOKEN_SHA256\n\s+valueFrom:\n\s+secretKeyRef:\n\s+name: project-os-pm-agent-token-sha256\n\s+key: '4'/)
    expect(withPm).not.toMatch(/PM_AGENT_TOKEN_SHA256\n\s+value:/)
    expect(render(template, { ...VARS, ...WRITE, SECRET_VERSION_PM_AGENT: ' ' })).toBe(out)
    for (const bad of ['latest', '0', '04', '-1', 'a'.repeat(64)]) {
      expect(() => render(template, { ...VARS, ...WRITE, SECRET_VERSION_PM_AGENT: bad }), bad).toThrow('SECRET_VERSION_PM_AGENT')
    }
    expect(() => render(template, { ...VARS, SECRET_VERSION_PM_AGENT: '4' })).toThrow('exige WRITE_MODE=sheets')
    expect(() => render(template, { ...VARS, WRITE_MODE: 'disabled', SECRET_VERSION_PM_AGENT: '4' })).toThrow('exige WRITE_MODE=sheets')
    // ORD-POS-063: PM_PUEDE_REGISTRAR_PR apagada por defecto; solo `true`, con el acceso del PM y el token de GitHub.
    expect(withPm).not.toContain('PM_PUEDE_REGISTRAR_PR')
    const conPmYGithub = { ...VARS, ...WRITE, SECRET_VERSION_PM_AGENT: '4', SECRET_VERSION_GITHUB: '1' }
    expect(render(template, { ...conPmYGithub, PM_PUEDE_REGISTRAR_PR: 'true' })).toMatch(/- name: PM_PUEDE_REGISTRAR_PR\n\s+value: 'true'\n/)
    for (const bad of ['false', 'TRUE', '1']) {
      expect(() => render(template, { ...conPmYGithub, PM_PUEDE_REGISTRAR_PR: bad }), bad).toThrow('PM_PUEDE_REGISTRAR_PR solo admite true')
    }
    expect(() => render(template, { ...VARS, ...WRITE, SECRET_VERSION_GITHUB: '1', PM_PUEDE_REGISTRAR_PR: 'true' })).toThrow('exige SECRET_VERSION_PM_AGENT')
    expect(() => render(template, { ...VARS, ...WRITE, SECRET_VERSION_PM_AGENT: '4', PM_PUEDE_REGISTRAR_PR: 'true' })).toThrow('exige SECRET_VERSION_PM_AGENT')
    // ORD-POS-100 (DEC-POS-022, DEC-POS-014): SEGUNDO_GEMINI_SUPERVISADO apagada por defecto; solo `on`, independiente de WRITE_MODE.
    expect(out).not.toContain('SEGUNDO_GEMINI_SUPERVISADO')
    expect(render(template, VARS)).not.toContain('SEGUNDO_GEMINI_SUPERVISADO')
    expect(render(template, { ...VARS, SEGUNDO_GEMINI_SUPERVISADO: ' ' })).toBe(render(template, VARS))
    expect(render(template, { ...VARS, SEGUNDO_GEMINI_SUPERVISADO: 'on' })).toMatch(/- name: SEGUNDO_GEMINI_SUPERVISADO\n\s+value: 'on'\n/)
    for (const bad of ['true', 'ON', '1', 'off']) {
      expect(() => render(template, { ...VARS, SEGUNDO_GEMINI_SUPERVISADO: bad }), bad).toThrow('SEGUNDO_GEMINI_SUPERVISADO solo admite on')
    }
    // Sin el marcador en la plantilla no se pierde la escritura en silencio: el render falla.
    expect(() => render(template.replace(/^ *# __ESCRITURA__.*\n/m, ''), { ...VARS, ...WRITE })).toThrow('__ESCRITURA__')
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
