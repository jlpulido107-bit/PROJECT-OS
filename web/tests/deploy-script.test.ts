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

  it('--quitar de una variable que el YAML aún trae: se detiene y la nombra', () => {
    const r = run(['--quitar', 'PM_AGENT_TOKEN_SHA256'], { input: 'desplegar\n' })
    expect(r.code).toBe(1)
    expect(r.out).toContain('DETENTE: se pidió --quitar PM_AGENT_TOKEN_SHA256')
    expect(r.calls).toBe('')
  })

  it('render que sale 0 con YAML vacío: se detiene sin llamar a gcloud', () => {
    writeFileSync(path.join(dir, 'node'), `#!/usr/bin/env bash\ncase "$1" in *render.mjs) exit 0 ;; esac\nexec "${process.execPath}" "$@"\n`)
    chmodSync(path.join(dir, 'node'), 0o755)
    const r = run([], { input: 'desplegar\n' })
    expect(r.code).toBe(1)
    expect(r.out).toContain('DETENTE: el YAML renderizado está vacío')
    expect(r.calls).toBe('')
  })

  it('cambios valor↔secreto: lista los nombres sin valores', () => {
    const r = run(['--dry-run'], { names: ['NEXTAUTH_URL', 'PM_AGENT_TOKEN_SHA256', 'GOOGLE_CLIENT_ID'], secrets: { GOOGLE_CLIENT_ID: 's:1' } })
    expect(r.out).toContain('Cambios valor↔secreto:')
    expect(r.out).toContain('GOOGLE_CLIENT_ID: secreto → literal')
    expect(r.out).not.toContain('SECRETO-NO-IMPRIMIR')
    const igual = run(['--dry-run'], { secrets: { PM_AGENT_TOKEN_SHA256: 'p:7' } })
    expect(igual.out).toMatch(/Cambios valor↔secreto:\n  \(ninguno\)/)
  })

  describe('DEPLOY_COMMIT_SHA (ORD-POS-124)', () => {
    const SHA = '0123456789abcdef0123456789abcdef01234567'
    const head = spawnSync('git', ['-C', path.dirname(SCRIPT), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()

    it('sin exportarla sale de git rev-parse HEAD; la prueba en seco la muestra y el YAML la trae como variable nueva', () => {
      expect(head).toMatch(/^[0-9a-f]{40}$/)
      const r = run(['--dry-run'], { names: ['NEXTAUTH_URL', 'PM_AGENT_TOKEN_SHA256'] })
      expect(r.code).toBe(0)
      expect(r.out).toContain(`Commit desplegado (DEPLOY_COMMIT_SHA): ${head}\n`)
      expect(r.out).toMatch(/Variables nuevas:\n(  \+ [A-Z_0-9]+\n)*  \+ DEPLOY_COMMIT_SHA\n/)
      expect(r.calls).not.toContain('replace')
    })

    it('exportada prevalece sobre git; con un valor inválido el render falla sin aplicar', () => {
      const r = run(['--dry-run'], { env: { ...RENDER_ENV, DEPLOY_COMMIT_SHA: SHA } })
      expect(r.code).toBe(0)
      expect(r.out).toContain(`Commit desplegado (DEPLOY_COMMIT_SHA): ${SHA}\n`)
      const mala = run([], { env: { ...RENDER_ENV, DEPLOY_COMMIT_SHA: 'abc1234' }, input: 'desplegar\n' })
      expect(mala.code).toBe(1)
      expect(mala.out).toContain('DEPLOY_COMMIT_SHA debe ser un SHA completo')
      expect(mala.calls).toBe('')
    })

    it('sin exportarla y sin git: se detiene sin llamar a gcloud', () => {
      writeFileSync(path.join(dir, 'git'), '#!/usr/bin/env bash\nexit 128\n')
      chmodSync(path.join(dir, 'git'), 0o755)
      const r = run([], { input: 'desplegar\n' })
      expect(r.code).toBe(1)
      expect(r.out).toContain('DETENTE: no se pudo leer el commit con git rev-parse HEAD; exporta DEPLOY_COMMIT_SHA')
      expect(r.calls).toBe('')
    })
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

    const min = { PROJECT_ID: 'project-os-511102', REGION: 'northamerica-south1', SERVICE_NAME: 'project-os-dashboard' }
    const SHA_NUEVO = 'c'.repeat(40)

    it('--quitar PM_AGENT_TOKEN_SHA256: no se toma de la activa, el YAML no la trae y se lista como quitada', () => {
      const r = run(['--desde-activa', '--quitar', 'PM_AGENT_TOKEN_SHA256', '--dry-run'], { raw: full, env: min })
      expect(r.code).toBe(0)
      expect(r.out).toMatch(/Variables quitadas:\n  - PM_AGENT_TOKEN_SHA256\n/)
      expect(r.calls).not.toContain('replace')
    })

    it('exportada vacía: prevalece y se lista como sobrescrita; sin --quitar, la faltante detiene', () => {
      const env = { ...min, SECRET_VERSION_PM_AGENT: '' }
      const r = run(['--desde-activa', '--quitar', 'PM_AGENT_TOKEN_SHA256', '--dry-run'], { raw: full, env })
      expect(r.code).toBe(0)
      expect(r.out).toMatch(/sobrescritas[^\n]*\n  ! SECRET_VERSION_PM_AGENT\n/)
      const sin = run(['--desde-activa'], { raw: full, env, input: 'desplegar\n' })
      expect(sin.code).toBe(1)
      expect(sin.out).toMatch(/DETENTE: la revisión activa tiene variables que el YAML no trae:\n  - PM_AGENT_TOKEN_SHA256/)
      expect(sin.calls).not.toContain('replace')
    })

    it('PM_PUEDE_REGISTRAR_PR (ORD-POS-063): se conserva de la activa y se apaga con --quitar', () => {
      const activa = JSON.parse(full)
      activa.spec.template.spec.containers[0].env.push(
        { name: 'GITHUB_DISPATCH_TOKEN', valueFrom: { secretKeyRef: { name: 'g', key: '1' } } }, { name: 'PM_PUEDE_REGISTRAR_PR', value: 'true' })
      const raw = JSON.stringify(activa)
      const sigue = run(['--desde-activa', '--dry-run'], { raw, env: min })
      expect(sigue.code).toBe(0)
      expect(sigue.out).not.toContain('PM_PUEDE_REGISTRAR_PR')
      const apagada = run(['--desde-activa', '--quitar', 'PM_PUEDE_REGISTRAR_PR', '--dry-run'], { raw, env: min })
      expect(apagada.code).toBe(0)
      expect(apagada.out).toMatch(/Variables quitadas:\n  - PM_PUEDE_REGISTRAR_PR\n/)
    })

    it('SEGUNDO_GEMINI_SUPERVISADO (ORD-POS-100): se conserva de la activa y se apaga con --quitar', () => {
      const activa = JSON.parse(full)
      activa.spec.template.spec.containers[0].env.push({ name: 'SEGUNDO_GEMINI_SUPERVISADO', value: 'on' })
      const raw = JSON.stringify(activa)
      const sigue = run(['--desde-activa', '--dry-run'], { raw, env: min })
      expect(sigue.code).toBe(0)
      expect(sigue.out).not.toContain('SEGUNDO_GEMINI_SUPERVISADO')
      const apagada = run(['--desde-activa', '--quitar', 'SEGUNDO_GEMINI_SUPERVISADO', '--dry-run'], { raw, env: min })
      expect(apagada.code).toBe(0)
      expect(apagada.out).toMatch(/Variables quitadas:\n  - SEGUNDO_GEMINI_SUPERVISADO\n/)
    })

    it('TAREAS_CIERRE_PROPIETARIO (ORD-POS-106): se conserva de la activa sin imprimir el correo y --quitar retira las dos', () => {
      const correo = 'dueno-sintetico@example.com'
      const activa = JSON.parse(full)
      activa.spec.template.spec.containers[0].env.push(
        { name: 'TAREAS_CIERRE_PROPIETARIO', value: 'true' }, { name: 'TAREAS_CIERRE_PROPIETARIO_EMAIL', value: correo })
      const raw = JSON.stringify(activa)
      const sigue = run(['--desde-activa', '--dry-run'], { raw, env: min })
      expect(sigue.code).toBe(0)
      expect(sigue.out).not.toContain('TAREAS_CIERRE_PROPIETARIO')
      expect(sigue.out).not.toContain(correo)
      for (const nombre of ['TAREAS_CIERRE_PROPIETARIO', 'TAREAS_CIERRE_PROPIETARIO_EMAIL']) {
        const apagada = run(['--desde-activa', '--quitar', nombre, '--dry-run'], { raw, env: min })
        expect(apagada.code).toBe(0)
        expect(apagada.out).toMatch(/Variables quitadas:\n  - TAREAS_CIERRE_PROPIETARIO\n  - TAREAS_CIERRE_PROPIETARIO_EMAIL\n/)
      }
      const nueva = run(['--desde-activa', '--dry-run'], { raw: full, env: { ...min, TAREAS_CIERRE_PROPIETARIO: 'true', TAREAS_CIERRE_PROPIETARIO_EMAIL: correo } })
      expect(nueva.code).toBe(0)
      for (const nombre of ['TAREAS_CIERRE_PROPIETARIO', 'TAREAS_CIERRE_PROPIETARIO_EMAIL']) expect(nueva.out).toContain(`  + ${nombre}\n`)
      expect(nueva.out).not.toContain(correo)
      const mala = run(['--desde-activa'], { raw, env: { ...min, TAREAS_CIERRE_PROPIETARIO: 'TRUE' }, input: 'desplegar\n' })
      expect(mala.code).toBe(1)
      expect(mala.calls).not.toContain('replace')
    })

    it('TIEMPOS_AGENTE (ORD-POS-112): se conserva de la activa con su secreto y --quitar retira las dos', () => {
      const activa = JSON.parse(full)
      activa.spec.template.spec.containers[0].env.push({ name: 'TIEMPOS_AGENTE', value: 'true' },
        { name: 'TIEMPOS_AGENTE_TOKEN_SHA256', valueFrom: { secretKeyRef: { name: 'project-os-tiempos-agente-token-sha256', key: '4' } } })
      const raw = JSON.stringify(activa)
      const sigue = run(['--desde-activa', '--dry-run'], { raw, env: min })
      expect(sigue.code).toBe(0)
      expect(sigue.out).not.toContain('TIEMPOS_AGENTE')
      for (const nombre of ['TIEMPOS_AGENTE', 'TIEMPOS_AGENTE_TOKEN_SHA256']) {
        const apagada = run(['--desde-activa', '--quitar', nombre, '--dry-run'], { raw, env: min })
        expect(apagada.code).toBe(0)
        expect(apagada.out).toMatch(/Variables quitadas:\n  - TIEMPOS_AGENTE\n  - TIEMPOS_AGENTE_TOKEN_SHA256\n/)
      }
      const nueva = run(['--desde-activa', '--dry-run'], { raw: full, env: { ...min, TIEMPOS_AGENTE: 'true', SECRET_VERSION_TIEMPOS_AGENTE: '4' } })
      expect(nueva.code).toBe(0)
      for (const nombre of ['TIEMPOS_AGENTE', 'TIEMPOS_AGENTE_TOKEN_SHA256']) expect(nueva.out).toContain(`  + ${nombre}\n`)
      const mala = run(['--desde-activa'], { raw, env: { ...min, TIEMPOS_AGENTE: 'TRUE' }, input: 'desplegar\n' })
      expect(mala.code).toBe(1)
      expect(mala.calls).not.toContain('replace')
    })

    it('RADAROS_SHEET_ID (ORD-POS-067): se conserva de la activa como literal, sin imprimir el valor, y se quita con --quitar', () => {
      const activa = JSON.parse(full)
      const id = 'LIBRO_RADAROS_SINTETICO_0123456789'
      activa.spec.template.spec.containers[0].env.push({ name: 'RADAROS_SHEET_ID', value: id })
      const raw = JSON.stringify(activa)
      const sigue = run(['--desde-activa', '--dry-run'], { raw, env: min })
      expect(sigue.code).toBe(0)
      expect(sigue.out).not.toContain('RADAROS_SHEET_ID')
      expect(sigue.out).not.toContain(id)
      const apagada = run(['--desde-activa', '--quitar', 'RADAROS_SHEET_ID', '--dry-run'], { raw, env: min })
      expect(apagada.code).toBe(0)
      expect(apagada.out).toMatch(/Variables quitadas:\n  - RADAROS_SHEET_ID\n/)
      const nueva = run(['--desde-activa', '--dry-run'], { raw: full, env: { ...min, RADAROS_SHEET_ID: id } })
      expect(nueva.code).toBe(0)
      expect(nueva.out).toMatch(/Variables nuevas:\n(  \+ [A-Z_]+\n)*  \+ RADAROS_SHEET_ID\n/)
      expect(nueva.out).not.toContain(id)
      const mala = run(['--desde-activa'], { raw: full, env: { ...min, RADAROS_SHEET_ID: '16UXe7fm90fOTTVJhI_RZ8__I876u2buvjeLGr5cJ-Ic' }, input: 'desplegar\n' })
      expect(mala.code).toBe(1)
      expect(mala.out).toContain('RADAROS_SHEET_ID no puede ser la hoja de PROJECT-OS')
      expect(mala.calls).not.toContain('replace')
    })

    it('FINANZAS_SHEET_ID (ORD-POS-074): se conserva de la activa como literal, sin imprimir el valor, y se quita con --quitar', () => {
      const activa = JSON.parse(full)
      const id = 'LIBRO_FINANZAS_SINTETICO_0123456789'
      activa.spec.template.spec.containers[0].env.push({ name: 'FINANZAS_SHEET_ID', value: id })
      const raw = JSON.stringify(activa)
      const sigue = run(['--desde-activa', '--dry-run'], { raw, env: min })
      expect(sigue.code).toBe(0)
      expect(sigue.out).not.toContain('FINANZAS_SHEET_ID')
      expect(sigue.out).not.toContain(id)
      const apagada = run(['--desde-activa', '--quitar', 'FINANZAS_SHEET_ID', '--dry-run'], { raw, env: min })
      expect(apagada.code).toBe(0)
      expect(apagada.out).toMatch(/Variables quitadas:\n  - FINANZAS_SHEET_ID\n/)
      const nueva = run(['--desde-activa', '--dry-run'], { raw: full, env: { ...min, FINANZAS_SHEET_ID: id } })
      expect(nueva.code).toBe(0)
      expect(nueva.out).toMatch(/Variables nuevas:\n(  \+ [A-Z_]+\n)*  \+ FINANZAS_SHEET_ID\n/)
      expect(nueva.out).not.toContain(id)
      const mala = run(['--desde-activa'], { raw: full, env: { ...min, FINANZAS_SHEET_ID: '16UXe7fm90fOTTVJhI_RZ8__I876u2buvjeLGr5cJ-Ic' }, input: 'desplegar\n' })
      expect(mala.code).toBe(1)
      expect(mala.out).toContain('FINANZAS_SHEET_ID no puede ser la hoja de PROJECT-OS')
      expect(mala.calls).not.toContain('replace')
    })

    it('escritura de finanzas (ORD-POS-077): se conserva de la activa sin imprimir valores y --quitar retira las tres', () => {
      const activa = JSON.parse(full)
      const cuenta = 'project-os-finanzas@project-os-511102.iam.gserviceaccount.com'
      const correo = 'dueno-sintetico@example.com'
      const id = 'LIBRO_FINANZAS_SINTETICO_0123456789'
      activa.spec.template.spec.containers[0].env.push(
        { name: 'FINANZAS_SHEET_ID', value: id }, { name: 'FINANZAS_WRITE_MODE', value: 'sheets' },
        { name: 'FINANZAS_WRITE_SERVICE_ACCOUNT', value: cuenta }, { name: 'FINANZAS_WRITER_EMAIL', value: correo })
      const raw = JSON.stringify(activa)
      const sigue = run(['--desde-activa', '--dry-run'], { raw, env: min })
      expect(sigue.code).toBe(0)
      expect(sigue.out).not.toMatch(/FINANZAS_WRITE|FINANZAS_WRITER_EMAIL/)
      for (const v of [cuenta, correo, id]) expect(sigue.out).not.toContain(v)
      for (const nombre of ['FINANZAS_WRITE_MODE', 'FINANZAS_WRITER_EMAIL']) {
        const apagada = run(['--desde-activa', '--quitar', nombre, '--dry-run'], { raw, env: min })
        expect(apagada.code).toBe(0)
        expect(apagada.out).toMatch(/Variables quitadas:\n(  - [A-Z_]+\n)*  - FINANZAS_WRITER_EMAIL\n/)
        expect(apagada.out).toContain('  - FINANZAS_WRITE_MODE\n')
        expect(apagada.out).toContain('  - FINANZAS_WRITE_SERVICE_ACCOUNT\n')
        expect(apagada.out).not.toContain('  - FINANZAS_SHEET_ID')
      }
      const nueva = run(['--desde-activa', '--dry-run'], { raw: full, env: { ...min, FINANZAS_SHEET_ID: id, FINANZAS_WRITE_MODE: 'sheets', FINANZAS_WRITE_SERVICE_ACCOUNT: cuenta, FINANZAS_WRITER_EMAIL: correo } })
      expect(nueva.code).toBe(0)
      expect(nueva.out).toContain('  + FINANZAS_WRITE_MODE\n')
      for (const v of [cuenta, correo]) expect(nueva.out).not.toContain(v)
      const mala = run(['--desde-activa'], { raw, env: { ...min, FINANZAS_WRITE_SERVICE_ACCOUNT: RENDER_ENV.WRITE_SERVICE_ACCOUNT }, input: 'desplegar\n' })
      expect(mala.code).toBe(1)
      expect(mala.out).toContain('no puede ser la cuenta de escritura de PROJECT-OS')
      expect(mala.calls).not.toContain('replace')
    })

    it('escritura del pipeline de /eco (ORD-POS-102): se conserva de la activa sin imprimir valores y --quitar retira las tres', () => {
      const activa = JSON.parse(full)
      const cuenta = 'project-os-eco@project-os-511102.iam.gserviceaccount.com'
      const correo = 'dueno-sintetico@example.com'
      const id = 'LIBRO_RADAROS_SINTETICO_0123456789'
      activa.spec.template.spec.containers[0].env.push(
        { name: 'RADAROS_SHEET_ID', value: id }, { name: 'ECO_PIPELINE_WRITE_MODE', value: 'sheets' },
        { name: 'ECO_PIPELINE_WRITE_SERVICE_ACCOUNT', value: cuenta }, { name: 'ECO_PIPELINE_WRITER_EMAIL', value: correo })
      const raw = JSON.stringify(activa)
      const sigue = run(['--desde-activa', '--dry-run'], { raw, env: min })
      expect(sigue.code).toBe(0)
      expect(sigue.out).not.toMatch(/ECO_PIPELINE/)
      for (const v of [cuenta, correo, id]) expect(sigue.out).not.toContain(v)
      for (const nombre of ['ECO_PIPELINE_WRITE_MODE', 'ECO_PIPELINE_WRITE_SERVICE_ACCOUNT', 'ECO_PIPELINE_WRITER_EMAIL']) {
        const apagada = run(['--desde-activa', '--quitar', nombre, '--dry-run'], { raw, env: min })
        expect(apagada.code).toBe(0)
        for (const otra of ['ECO_PIPELINE_WRITE_MODE', 'ECO_PIPELINE_WRITE_SERVICE_ACCOUNT', 'ECO_PIPELINE_WRITER_EMAIL']) expect(apagada.out).toContain(`  - ${otra}\n`)
        expect(apagada.out).not.toContain('  - RADAROS_SHEET_ID')
      }
      const nueva = run(['--desde-activa', '--dry-run'], { raw: full, env: { ...min, RADAROS_SHEET_ID: id, ECO_PIPELINE_WRITE_MODE: 'sheets', ECO_PIPELINE_WRITE_SERVICE_ACCOUNT: cuenta, ECO_PIPELINE_WRITER_EMAIL: correo } })
      expect(nueva.code).toBe(0)
      for (const nombre of ['ECO_PIPELINE_WRITE_MODE', 'ECO_PIPELINE_WRITE_SERVICE_ACCOUNT', 'ECO_PIPELINE_WRITER_EMAIL']) expect(nueva.out).toContain(`  + ${nombre}\n`)
      for (const v of [cuenta, correo]) expect(nueva.out).not.toContain(v)
      const mala = run(['--desde-activa'], { raw, env: { ...min, ECO_PIPELINE_WRITE_SERVICE_ACCOUNT: RENDER_ENV.WRITE_SERVICE_ACCOUNT }, input: 'desplegar\n' })
      expect(mala.code).toBe(1)
      expect(mala.out).toContain('no puede ser la cuenta de escritura de PROJECT-OS')
      expect(mala.calls).not.toContain('replace')
    })

    it('ECO_IDEAS_ALTA (ORD-POS-131): se conserva de la activa, --quitar la retira y exige la escritura del pipeline', () => {
      const activa = JSON.parse(full)
      const cuenta = 'project-os-eco@project-os-511102.iam.gserviceaccount.com'
      const correo = 'dueno-sintetico@example.com'
      const id = 'LIBRO_RADAROS_SINTETICO_0123456789'
      activa.spec.template.spec.containers[0].env.push(
        { name: 'RADAROS_SHEET_ID', value: id }, { name: 'ECO_PIPELINE_WRITE_MODE', value: 'sheets' },
        { name: 'ECO_PIPELINE_WRITE_SERVICE_ACCOUNT', value: cuenta }, { name: 'ECO_PIPELINE_WRITER_EMAIL', value: correo },
        { name: 'ECO_IDEAS_ALTA', value: 'true' })
      const raw = JSON.stringify(activa)
      const sigue = run(['--desde-activa', '--dry-run'], { raw, env: min })
      expect(sigue.code).toBe(0)
      expect(sigue.out).not.toContain('ECO_IDEAS_ALTA')
      const apagada = run(['--desde-activa', '--quitar', 'ECO_IDEAS_ALTA', '--dry-run'], { raw, env: min })
      expect(apagada.code).toBe(0)
      expect(apagada.out).toContain('  - ECO_IDEAS_ALTA\n')
      expect(apagada.out).not.toContain('  - ECO_PIPELINE_WRITE_MODE')
      // Sin la escritura del pipeline (su cuenta), la bandera no se despliega.
      const sinPipeline = run(['--desde-activa', '--quitar', 'ECO_PIPELINE_WRITE_MODE'], { raw, env: min, input: 'desplegar\n' })
      expect(sinPipeline.code).toBe(1)
      expect(sinPipeline.out).toContain('ECO_IDEAS_ALTA exige ECO_PIPELINE_WRITE_MODE=sheets')
      expect(sinPipeline.calls).not.toContain('replace')
      const mala = run(['--desde-activa'], { raw, env: { ...min, ECO_IDEAS_ALTA: 'TRUE' }, input: 'desplegar\n' })
      expect(mala.code).toBe(1)
      expect(mala.out).toContain('ECO_IDEAS_ALTA solo admite true')
      expect(mala.calls).not.toContain('replace')
    })

    it('DEPLOY_COMMIT_SHA (ORD-POS-124): si la activa no la tiene, es «variable nueva» y no falla; nunca se toma de la activa', () => {
      const nueva = run(['--desde-activa', '--dry-run'], { raw: full, env: { ...min, DEPLOY_COMMIT_SHA: SHA_NUEVO } })
      expect(nueva.code).toBe(0)
      expect(nueva.out).toMatch(/Variables nuevas:\n(  \+ [A-Z_]+\n)*  \+ DEPLOY_COMMIT_SHA\n/)
      expect(nueva.out).toContain(`Commit desplegado (DEPLOY_COMMIT_SHA): ${SHA_NUEVO}\n`)
      const activa = JSON.parse(full)
      activa.spec.template.spec.containers[0].env.push({ name: 'DEPLOY_COMMIT_SHA', value: 'e'.repeat(40) })
      const sigue = run(['--desde-activa', '--dry-run'], { raw: JSON.stringify(activa), env: { ...min, DEPLOY_COMMIT_SHA: SHA_NUEVO } })
      expect(sigue.code).toBe(0)
      expect(sigue.out).not.toContain('+ DEPLOY_COMMIT_SHA')
      expect(sigue.out).not.toContain('e'.repeat(40))
      expect(sigue.out).toContain(`Commit desplegado (DEPLOY_COMMIT_SHA): ${SHA_NUEVO}\n`)
      expect(sigue.out).toMatch(/Variables sobrescritas[^\n]*\n  \(ninguna\)/)
    })

    it('IMAGE exportada vacía: el render falla sin aplicar', () => {
      const r = run(['--desde-activa'], { raw: full, env: { ...min, IMAGE: '' }, input: 'desplegar\n' })
      expect(r.code).toBe(1)
      expect(r.out).toContain('el render falló')
      expect(r.calls).not.toContain('replace')
    })

    it('JSON inválido, vacío o sin contenedor: se detiene sin aplicar', () => {
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
