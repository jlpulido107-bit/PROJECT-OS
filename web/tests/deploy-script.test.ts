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

function activa(names: string[]) {
  const file = path.join(dir, 'activa.json')
  writeFileSync(file, JSON.stringify({ spec: { template: { spec: { containers: [{ image: 'imagen-vieja', env: names.map((name) => ({ name, value: 'SECRETO-NO-IMPRIMIR' })) }] } } } }))
  return file
}

function run(args: string[], opts: { env?: Record<string, string>; names?: string[]; input?: string } = {}) {
  const log = path.join(dir, 'gcloud.log')
  writeFileSync(log, '')
  const result = spawnSync('bash', [SCRIPT, ...args], {
    cwd: dir, input: opts.input ?? '', encoding: 'utf8',
    env: { PATH: `${dir}:${process.env.PATH}`, GCLOUD_LOG: log, GCLOUD_ACTIVA: activa(opts.names ?? ['NEXTAUTH_URL', 'PM_AGENT_TOKEN_SHA256']), ...(opts.env ?? RENDER_ENV) } as unknown as NodeJS.ProcessEnv,
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
})
