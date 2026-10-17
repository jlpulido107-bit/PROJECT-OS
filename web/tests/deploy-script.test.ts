import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/** deploy.sh con un gcloud simulado en PATH: ninguna prueba contacta a Google Cloud. */
const SCRIPT = path.join(__dirname, '..', 'deploy', 'cloudrun', 'deploy.sh')
const IMAGE = `us-docker.pkg.dev/proj-os-1/repo/dash@sha256:${'a'.repeat(64)}`
const RENDER_ENV = {
  SERVICE_NAME: 'project-os-dashboard', PROJECT_ID: 'project-os-511102', REGION: 'northamerica-south1', IMAGE,
  RUNTIME_SA: 'runtime@project-os-511102.iam.gserviceaccount.com', SERVICE_URL: 'https://dash.example.com',
  OAUTH_CLIENT_ID: '123-abc.apps.googleusercontent.com', SECRET_VERSION_NEXTAUTH: '1', SECRET_VERSION_OAUTH: '1',
  SECRET_VERSION_ALLOWLIST: '1', WRITE_MODE: 'sheets', WRITE_SERVICE_ACCOUNT: 'writer@project-os-511102.iam.gserviceaccount.com',
  SECRET_VERSION_WRITERS: '1', SECRET_VERSION_PM_AGENT: '7',
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'deploy-sh-'))
  writeFileSync(path.join(dir, 'gcloud'), `#!/usr/bin/env bash
echo "$*" >> "$GCLOUD_LOG"
case "$*" in
  *"services describe"*) cat "$GCLOUD_ACTIVA" ;;
esac
`)
  chmodSync(path.join(dir, 'gcloud'), 0o755)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function activa(names: string[], secrets: Record<string, string> = {}) {
  const file = path.join(dir, 'activa.json')
  writeFileSync(file, JSON.stringify({ spec: { template: { spec: { containers: [{ image: 'imagen-vieja', env: names.map((name) => secrets[name]
    ? { name, valueFrom: { secretKeyRef: { name: secrets[name].split(':')[0], key: secrets[name].split(':')[1] } } }
    : { name, value: 'SECRETO-NO-IMPRIMIR' }) }] } } } }))
  return file
}

function run(args: string[], opts: { env?: Record<string, string>; names?: string[]; secrets?: Record<string, string>; input?: string; raw?: string } = {}) {
  const log = path.join(dir, 'gcloud.log')
  writeFileSync(log, '')
  const activaFile = opts.raw === undefined ? activa(opts.names ?? ['NEXTAUTH_URL', 'PM_AGENT_TOKEN_SHA256'], opts.secrets) : path.join(dir, 'cruda.json')
  if (opts.raw !== undefined) writeFileSync(activaFile, opts.raw)
  const result = spawnSync('bash', [SCRIPT, ...args], {
    cwd: dir, input: opts.input ?? '', encoding: 'utf8',
    env: { PATH: `${dir}:${process.env.PATH}`, GCLOUD_LOG: log, GCLOUD_ACTIVA: activaFile, ...(opts.env ?? RENDER_ENV) } as unknown as NodeJS.ProcessEnv,
  })
  return { code: result.status, out: `${result.stdout}${result.stderr}`, calls: readFileSync(log, 'utf8') }
}

describe('deploy.sh', () => {
  it('render fallido: se detiene sin llamar a gcloud', () => {
    const r = run([], { env: { PROJECT_ID: 'project-os-511102' } })
    expect(r.code).toBe(1)
    expect(r.out).toContain('el render falló')
    expect(r.calls).toBe('')
  })

  it('variable faltante (con dígitos): la nombra, se detiene y no imprime valores', () => {
    const r = run([], { names: ['NEXTAUTH_URL', 'PM_AGENT_TOKEN_SHA256', 'ANTIGUA_V2'], input: 'desplegar\n' })
    expect(r.code).toBe(1)
    expect(r.out).toContain('ANTIGUA_V2')
    expect(r.out).not.toContain('SECRETO-NO-IMPRIMIR')
    expect(r.calls).not.toContain('replace')
  })

  it('--dry-run: muestra el resumen y no aplica', () => {
    const r = run(['--dry-run'], { names: ['NEXTAUTH_URL'], input: 'desplegar\n' })
    expect(r.code).toBe(0)
    expect(r.out).toContain('+ PM_AGENT_TOKEN_SHA256')
    expect(r.out).toContain(IMAGE)
    expect(r.calls).not.toContain('replace')
  })

  it('secreto con versión distinta: lo lista en el resumen sin imprimir valores', () => {
    const r = run(['--dry-run'], { secrets: { PM_AGENT_TOKEN_SHA256: 'project-os-pm-agent-token-sha256:10' } })
    expect(r.code).toBe(0)
    expect(r.out).toContain('PM_AGENT_TOKEN_SHA256: project-os-pm-agent-token-sha256:10 → 7')
    expect(r.out).not.toContain('SECRETO-NO-IMPRIMIR')
    expect(r.calls).not.toContain('replace')
  })

  it('sin escribir «desplegar»: cancela sin aplicar', () => {
    const r = run([], { input: 'no\n' })
    expect(r.code).toBe(1)
    expect(r.calls).not.toContain('replace')
  })

  it('camino feliz: aplica con replace y lista 3 revisiones, con --project y --region en cada gcloud', () => {
    const r = run([], { input: 'desplegar\n' })
    expect(r.code).toBe(0)
    const calls = r.calls.trim().split('\n')
    expect(calls.some((c) => c.includes('services replace'))).toBe(true)
    expect(calls.at(-1)).toContain('revisions list')
    expect(calls.at(-1)).toContain('--limit 3')
    for (const call of calls) expect(call).toMatch(/--project project-os-511102 --region northamerica-south1/)
    expect(r.out).not.toContain('SECRETO-NO-IMPRIMIR')
  })

  it('--quitar: permite que falte la variable, la lista y sigue pidiendo «desplegar»', () => {
    const names = ['NEXTAUTH_URL', 'PM_AGENT_TOKEN_SHA256', 'ANTIGUA_V2']
    const sin = run(['--quitar', 'ANTIGUA_V2', '--dry-run'], { names })
    expect(sin.code).toBe(0)
    expect(sin.out).toMatch(/Variables quitadas:\n  - ANTIGUA_V2/)
    const nodesp = run(['--quitar', 'ANTIGUA_V2'], { names, input: 'no\n' })
    expect(nodesp.code).toBe(1)
    expect(nodesp.calls).not.toContain('replace')
    const ok = run(['--quitar', 'ANTIGUA_V2'], { names, input: 'desplegar\n' })
    expect(ok.calls).toContain('services replace')
    expect(run(['--quitar', 'minuscula']).code).toBe(2)
  })

  it('cambios valor↔secreto: lista los nombres sin valores', () => {
    const r = run(['--dry-run'], { names: ['NEXTAUTH_URL', 'PM_AGENT_TOKEN_SHA256', 'GOOGLE_CLIENT_ID'], secrets: { GOOGLE_CLIENT_ID: 's:1' } })
    expect(r.out).toContain('Cambios valor↔secreto:')
    expect(r.out).toContain('GOOGLE_CLIENT_ID: secreto → literal')
    expect(r.out).not.toContain('SECRETO-NO-IMPRIMIR')
    const igual = run(['--dry-run'], { secrets: { PM_AGENT_TOKEN_SHA256: 'p:7' } })
    expect(igual.out).toMatch(/Cambios valor↔secreto:\n  \(ninguno\)/)
  })

  describe('--desde-activa', () => {
    const { IMAGE: _i, RUNTIME_SA: _r, SERVICE_URL: _s, OAUTH_CLIENT_ID: _o, ...base } = RENDER_ENV
    void [_i, _r, _s, _o]
    const full = JSON.stringify({ spec: { template: { spec: { serviceAccountName: RENDER_ENV.RUNTIME_SA, containers: [{
      image: `us-docker.pkg.dev/proj-os-1/repo/dash@sha256:${'b'.repeat(64)}`,
      env: [
        { name: 'NEXTAUTH_URL', value: RENDER_ENV.SERVICE_URL }, { name: 'GOOGLE_CLIENT_ID', value: RENDER_ENV.OAUTH_CLIENT_ID },
        { name: 'NEXTAUTH_SECRET', valueFrom: { secretKeyRef: { name: 'n', key: '1' } } },
        { name: 'GOOGLE_CLIENT_SECRET', valueFrom: { secretKeyRef: { name: 'o', key: '1' } } },
        { name: 'AUTH_ALLOWED_EMAILS', valueFrom: { secretKeyRef: { name: 'a', key: '1' } } },
        { name: 'AUTH_WRITER_EMAILS', valueFrom: { secretKeyRef: { name: 'w', key: '1' } } },
        { name: 'PM_AGENT_TOKEN_SHA256', valueFrom: { secretKeyRef: { name: 'p', key: '7' } } },
        { name: 'PROJECT_OS_WRITE_MODE', value: 'sheets' },
        { name: 'PROJECT_OS_WRITE_SERVICE_ACCOUNT', value: RENDER_ENV.WRITE_SERVICE_ACCOUNT },
      ],
    }] } } } })


    it('sin exportar nada: toma todo de la activa y no imprime valores', () => {
      const r = run(['--desde-activa', '--dry-run'], { raw: full, env: { PROJECT_ID: 'project-os-511102', REGION: 'northamerica-south1', SERVICE_NAME: 'project-os-dashboard' } })
      expect(r.code).toBe(0)
      expect(r.out).toContain('Imagen nueva:  us-docker.pkg.dev/proj-os-1/repo/dash@sha256:' + 'b'.repeat(64))
      expect(r.out).toMatch(/Variables sobrescritas[^\n]*\n  \(ninguna\)/)
      for (const valor of [RENDER_ENV.SERVICE_URL, RENDER_ENV.OAUTH_CLIENT_ID, RENDER_ENV.RUNTIME_SA, RENDER_ENV.WRITE_SERVICE_ACCOUNT]) expect(r.out).not.toContain(valor)
      expect(r.calls).not.toContain('replace')
    })

    it('lo exportado prevalece y se lista como sobrescrita', () => {
      const r = run(['--desde-activa', '--dry-run'], { raw: full, env: { ...base, IMAGE } })
      expect(r.code).toBe(0)
      expect(r.out).toContain(`Imagen nueva:  ${IMAGE}`)
      expect(r.out).toMatch(/sobrescritas[^\n]*\n  ! IMAGE\n/)
    })

    it('JSON inválido, sin contenedor o YAML vacío: se detiene sin aplicar', () => {
      const env = { PROJECT_ID: 'project-os-511102', REGION: 'northamerica-south1', SERVICE_NAME: 'project-os-dashboard' }
      for (const raw of ['no es json', '{"spec":{"template":{"spec":{"containers":[]}}}}', '']) {
        const r = run(['--desde-activa'], { raw, env, input: 'desplegar\n' })
        expect(r.code).toBe(1)
        expect(r.out).toContain('DETENTE')
        expect(r.calls).not.toContain('replace')
      }
    })
  })
})
