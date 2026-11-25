import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/** Colector con Workload Identity Federation (ORD-POS-174): fuente del workflow, script de identidad y guía. Sin red ni Google Cloud. */
const ROOT = path.resolve(__dirname, '..', '..')
const leer = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8')
const WORKFLOW = leer('web/deploy/github/manual-github-evidence.yml')
const ANTERIOR = leer('web/deploy/github/manual-github-evidence.anterior.yml')
const WIF = path.join(ROOT, 'web/deploy/infra/wif-colector.sh')
const GUIA = leer('docs/colector-wif.md')
const CUENTA = 'project-os-colector@project-os-511102.iam.gserviceaccount.com'

/** Bloques de cada job: de «  nombre:» hasta el siguiente job de dos espacios. */
function jobs(texto: string): Record<string, string> {
  const cuerpo = texto.slice(texto.indexOf('\njobs:\n') + 7)
  const out: Record<string, string> = {}
  let actual = ''
  for (const linea of cuerpo.split('\n')) {
    const m = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(linea)
    if (m) actual = m[1] ?? ''
    else if (actual) out[actual] = (out[actual] ?? '') + linea + '\n'
  }
  return out
}
/** Los pasos de un job, cada uno con todas sus líneas terminadas en salto. */
const pasos = (job: string) => job.slice(job.indexOf('    steps:\n') + 11).split(/\n(?= {6}- name:)/).map((p) => `${p.trimEnd()}\n`)
const paso = (job: string, nombre: string) => pasos(job).find((p) => p.startsWith(`      - name: ${nombre}`)) ?? ''
/** El bloque `run: |` de un paso, sin la sangría del YAML. */
const script = (p: string) => p.slice(p.indexOf('        run: |\n') + 15).split('\n').map((l) => l.slice(10)).join('\n')

describe('fuente del colector con WIF (ORD-POS-174, criterio 1)', () => {
  const j = jobs(WORKFLOW)
  const sync = j.sync ?? ''
  const report = j.report ?? ''

  it('solo corre con el horario de DEC-POS-044 o a mano; la opción de sincronizar sigue apagada por defecto', () => {
    expect(WORKFLOW).toMatch(/^on:\n {2}# [^\n]*\n {2}schedule:\n {4}- cron: '0 5 \* \* \*'\n {2}workflow_dispatch:\n/m)
    expect(WORKFLOW).not.toMatch(/^\s+(push|pull_request|pull_request_target|workflow_run|repository_dispatch):/m)
    expect(WORKFLOW).toMatch(/^ {6}sync_to_sheets:\n(?: {8}.*\n)*? {8}type: boolean\n {8}default: false\n/m)
  })

  it('id-token: write solo en el job que entra a Google', () => {
    expect(Object.keys(j)).toEqual(['report', 'sync'])
    expect(WORKFLOW.match(/id-token/g)).toHaveLength(2) // el comentario de cabecera y el permiso del job
    expect(WORKFLOW.match(/^\s*id-token\s*:/gm)).toHaveLength(1)
    expect(sync).toMatch(/^ {4}permissions:\n {6}contents: read\n {6}id-token: write\n/m)
    // Ni el workflow ni «report» lo tienen: «report» hereda los permisos de solo lectura del workflow.
    expect(WORKFLOW.slice(0, WORKFLOW.indexOf('\njobs:\n')).endsWith('\npermissions:\n  contents: read\n  pull-requests: read\n  issues: read\n')).toBe(true)
    expect(report).not.toMatch(/permissions:|id-token|google-github-actions|vars\.|SHEETS_|sync_sheets/)
  })

  it('«sync» solo corre tras «report», y solo con el horario o la opción explícita', () => {
    expect(sync).toMatch(/^ {4}needs: report\n {4}if: \$\{\{ inputs\.sync_to_sheets \|\| github\.event_name == 'schedule' \}\}\n/m)
    expect(sync).toMatch(/^ {4}timeout-minutes: \d+$/m)
  })

  it('autentica con google-github-actions/auth por WIF: sin clave, sin secretos, con las acciones fijadas por SHA', () => {
    const auth = paso(sync, 'Authenticate to Google Cloud')
    expect(auth).toMatch(/uses: google-github-actions\/auth@[0-9a-f]{40} # v3\.0\.0\n/)
    expect(auth).toContain('          workload_identity_provider: ${{ vars.COLECTOR_WIF_PROVIDER }}\n')
    expect(WORKFLOW).not.toMatch(/credentials_json|GOOGLE_APPLICATION_CREDENTIALS|PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_JSON/)
    expect(sync).not.toMatch(/secrets/i)
    const usos = [...sync.matchAll(/^\s*uses:\s*(\S+)/gm)].map((m) => m[1] ?? '')
    expect(usos).toHaveLength(4)
    for (const u of usos) expect(u, u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)
    // El archivo de credenciales vive en el workspace: el checkout va antes y no deja el token de GitHub en .git.
    const nombres = pasos(sync).map((p) => /- name: (.*)/.exec(p)?.[1] ?? '')
    expect(nombres.indexOf('Checkout project')).toBeLessThan(nombres.findIndex((n) => n.startsWith('Authenticate to Google Cloud')))
    expect(nombres.at(-1)).toBe('Sync verified evidence to Google Sheets (explicit opt-in)')
    expect(paso(sync, 'Checkout project')).toContain('          persist-credentials: false\n')
  })

  it('usa la cuenta propia del colector, la misma que exige el sincronizador; nunca la del despliegue', () => {
    expect(paso(sync, 'Authenticate to Google Cloud')).toContain(`          service_account: ${CUENTA}\n`)
    const sincronizar = paso(sync, 'Sync verified evidence to Google Sheets')
    expect(sincronizar).toContain(`        env:\n          SHEETS_CREDENTIALS: adc\n          SHEETS_EXPECTED_SERVICE_ACCOUNT: ${CUENTA}\n`)
    const cuentas = new Set(WORKFLOW.match(/[\w.+-]+@[\w-]+\.iam\.gserviceaccount\.com/g))
    expect([...cuentas]).toEqual([CUENTA])
    // Nada del botón de despliegue: ni su cuenta, ni sus variables, ni su environment.
    const boton = leer('web/deploy/github/desplegar-dashboard.yml')
    expect(boton).toContain('vars.WIF_SERVICE_ACCOUNT')
    expect(WORKFLOW).not.toMatch(/project-os-despliegue|vars\.WIF_|environment:/)
    expect(leer('web/deploy/infra/wif-despliegue.sh')).toContain("CUENTA_NOMBRE='project-os-despliegue'")
    expect(readFileSync(WIF, 'utf8')).toContain("CUENTA_NOMBRE='project-os-colector'")
  })

  it('el único secreto del workflow es el token de lectura de GitHub, y solo lo ve «report»', () => {
    expect(WORKFLOW.match(/\bsecrets\b/gi)).toHaveLength(1)
    expect(paso(report, 'Collect read-only evidence')).toContain('          GH_READ_TOKEN: ${{ secrets.PROJECT_OS_GH_READ_TOKEN }}\n')
  })

  it('«report» es la recolección de la fuente anterior, sin los dos pasos de Google; «sync» recibe su informe', () => {
    const anterior = jobs(ANTERIOR).report ?? ''
    const sinGoogle = pasos(anterior).filter((p) => !/Install Sheets auth dependency|Sync verified evidence/.test(p)).join('')
    const subir = "          # «sync» descarga este artefacto: al repetir la corrida completa se reemplaza en vez de fallar por nombre repetido.\n          overwrite: true\n"
    expect(report).toContain(subir)
    expect(pasos(report.replace(subir, '')).join('')).toBe(sinGoogle)
    expect(paso(report, 'Upload report as build artifact')).toContain('          name: github-evidence-${{ github.run_id }}\n          path: reports/\n')
    expect(paso(sync, 'Download the report collected by the report job')).toContain('          name: github-evidence-${{ github.run_id }}\n          path: reports/\n')
  })

  describe('los bloques de shell de «sync», ejecutados tal cual', () => {
    let dir: string
    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), 'colector-'))
      // python falso: anota sus argumentos y las variables de credenciales que recibe.
      writeFileSync(path.join(dir, 'python'), '#!/usr/bin/env bash\necho "$* | ${SHEETS_CREDENTIALS-} | ${SHEETS_EXPECTED_SERVICE_ACCOUNT-}" >> "$PYTHON_LOG"\n')
      chmodSync(path.join(dir, 'python'), 0o755)
      writeFileSync(path.join(dir, 'python.log'), '')
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))
    const correr = (bloque: string, env: Record<string, string>) => {
      const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', bloque], {
        cwd: dir, encoding: 'utf8', env: { PATH: `${dir}:${process.env.PATH}`, PYTHON_LOG: path.join(dir, 'python.log'), ...env } as unknown as NodeJS.ProcessEnv,
      })
      return { code: r.status, out: r.stdout, log: readFileSync(path.join(dir, 'python.log'), 'utf8') }
    }
    const informe = (rel: string) => {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
      writeFileSync(path.join(dir, rel), '{}')
    }

    it.each([['vacía', ''], ['sin definir', undefined]])('sin la variable COLECTOR_WIF_PROVIDER (%s) se detiene antes de cualquier otro paso', (_n, valor) => {
      const primero = pasos(sync)[0] ?? ''
      expect(primero).toContain('          PROVIDER: ${{ vars.COLECTOR_WIF_PROVIDER }}\n')
      const r = correr(script(primero), valor === undefined ? {} : { PROVIDER: valor })
      expect(r.code).toBe(1)
      expect(r.out).toMatch(/::error::Missing repository variable COLECTOR_WIF_PROVIDER; no sync attempted/)
      expect(correr(script(primero), { PROVIDER: 'projects/1/locations/global/workloadIdentityPools/p/providers/q' }).code).toBe(0)
    })

    it('con un solo informe lo sincroniza por ADC como la cuenta del colector', () => {
      informe('reports/2026-11/2026-11-25.json')
      writeFileSync(path.join(dir, 'reports/2026-11/2026-11-25.md'), '# informe')
      const r = correr(script(paso(sync, 'Sync verified evidence to Google Sheets')), { SHEETS_CREDENTIALS: 'adc', SHEETS_EXPECTED_SERVICE_ACCOUNT: CUENTA })
      expect(r.code).toBe(0)
      expect(r.log).toBe(`src/sync_sheets.py --report reports/2026-11/2026-11-25.json | adc | ${CUENTA}\n`)
    })

    it.each([
      ['sin informe', []],
      ['con dos informes', ['reports/2026-11/2026-11-24.json', 'reports/2026-11/2026-11-25.json']],
    ])('%s no sincroniza nada', (_n, informes) => {
      informes.forEach(informe)
      const r = correr(script(paso(sync, 'Sync verified evidence to Google Sheets')), {})
      expect(r.code).toBe(1)
      expect(r.out).toMatch(new RegExp(`::error::Expected exactly one report from the report job; found ${informes.length}\\. No sync attempted`))
      expect(r.log).toBe('')
    })
  })
})

describe('wif-colector.sh (ORD-POS-174)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'wif-colector-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  /** gcloud falso: anota cada llamada, devuelve el número del proyecto y, si `existe` es falso, falla en los demás `describe`. */
  function correr(args: string[], input = '', existe = true) {
    const log = path.join(dir, 'gcloud.log')
    writeFileSync(log, '')
    writeFileSync(path.join(dir, 'gcloud'), `#!/usr/bin/env bash\necho "$*" >> "$GCLOUD_LOG"\ncase "$*" in\n  "projects describe"*) echo 123456789012 ;;\n  *" describe "*) exit ${existe ? 0 : 1} ;;\nesac\n`)
    chmodSync(path.join(dir, 'gcloud'), 0o755)
    const r = spawnSync('bash', [WIF, ...args], {
      env: { PATH: `${dir}:${process.env.PATH}`, GCLOUD_LOG: log } as unknown as NodeJS.ProcessEnv, input, encoding: 'utf8',
    })
    return { code: r.status, out: r.stdout, err: r.stderr, log: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) }
  }
  const POOL = 'projects/123456789012/locations/global/workloadIdentityPools/github-colector'

  it('sin --apply no llama a gcloud e imprime el plan: pool propio, solo este repositorio, main y el workflow del colector', () => {
    const r = correr([])
    expect(r.code).toBe(0)
    expect(r.log).toEqual([])
    expect(r.out).toMatch(/SIMULACIÓN/)
    expect(r.out).toMatch(/workload-identity-pools create github-colector /)
    expect(r.out).toMatch(/providers create-oidc github-actions .*--workload-identity-pool github-colector /)
    expect(r.out).toContain("assertion.repository==\\'jlpulido107-bit/PROJECT-OS\\'")
    expect(r.out).toContain("assertion.ref==\\'refs/heads/main\\'")
    expect(r.out).toContain("assertion.workflow_ref==\\'jlpulido107-bit/PROJECT-OS/.github/workflows/manual-github-evidence.yml@refs/heads/main\\'")
    expect(r.out).toContain('COLECTOR_WIF_PROVIDER=projects/$NUMERO_PROYECTO/locations/global/workloadIdentityPools/github-colector/providers/github-actions')
    expect(r.out).toContain(`  ${CUENTA}\n`)
  })

  it('mínimo privilegio: el único rol es workloadIdentityUser sobre la propia cuenta; ningún rol de proyecto ni de recurso, ninguna clave', () => {
    const texto = readFileSync(WIF, 'utf8')
    expect([...new Set(texto.match(/roles\/[\w.]+/g))]).toEqual(['roles/iam.workloadIdentityUser'])
    expect(texto.match(/add-iam-policy-binding/g)).toHaveLength(1)
    expect(texto).toMatch(/paso gcloud iam service-accounts add-iam-policy-binding "\$CUENTA" /)
    expect(texto).not.toMatch(/keys create|projects add-iam-policy-binding|set-iam-policy|roles\/(owner|editor)/)
    // No toca nada del despliegue: otro pool y otra cuenta.
    expect(texto).toContain("readonly POOL='github-colector'")
    expect(texto).not.toMatch(/project-os-despliegue|POOL='github'/)
    for (const c of texto.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? []) expect(c).toMatch(/\.iam\.gserviceaccount\.com$/)
  })

  it.each([['--plan'], ['--apply', 'extra'], ['apply']])('argumentos no válidos %j: uso, sin gcloud', (...args) => {
    const r = correr(args)
    expect(r.code).toBe(2)
    expect(r.log).toEqual([])
  })

  it('--apply sin «AUTORIZO WIF COLECTOR» solo lee el número del proyecto y no cambia nada', () => {
    for (const respuesta of ['si\n', 'AUTORIZO WIF\n', '']) {
      const r = correr(['--apply'], respuesta)
      expect(r.code).toBe(1)
      expect(r.log).toEqual(['projects describe project-os-511102 --format=value(projectNumber)'])
    }
  })

  it('--apply con la frase crea lo que falta y concede un solo permiso, a la identidad del colector en main', () => {
    const r = correr(['--apply'], 'AUTORIZO WIF COLECTOR\n', false)
    expect(r.code).toBe(0)
    const cambios = r.log.filter((l) => !/ describe /.test(l))
    expect(cambios).toEqual([
      'iam workload-identity-pools create github-colector --project project-os-511102 --location global --display-name GitHub Actions colector',
      "iam workload-identity-pools providers create-oidc github-actions --project project-os-511102 --location global --workload-identity-pool github-colector --display-name PROJECT-OS main colector --issuer-uri https://token.actions.githubusercontent.com --attribute-mapping google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref --attribute-condition assertion.repository=='jlpulido107-bit/PROJECT-OS' && assertion.ref=='refs/heads/main' && assertion.workflow_ref=='jlpulido107-bit/PROJECT-OS/.github/workflows/manual-github-evidence.yml@refs/heads/main'",
      'iam service-accounts create project-os-colector --project project-os-511102 --display-name Colector de evidencias desde GitHub (WIF)',
      `iam service-accounts add-iam-policy-binding ${CUENTA} --project project-os-511102 --role roles/iam.workloadIdentityUser --member principal://iam.googleapis.com/${POOL}/subject/repo:jlpulido107-bit/PROJECT-OS:ref:refs/heads/main`,
    ])
    expect(r.out).toContain(`COLECTOR_WIF_PROVIDER=${POOL}/providers/github-actions`)
  })

  it('--apply sobre lo que ya existe no lo vuelve a crear', () => {
    const r = correr(['--apply'], 'AUTORIZO WIF COLECTOR\n', true)
    expect(r.code).toBe(0)
    expect(r.out.match(/Ya existe: /g)).toHaveLength(3)
    expect(r.log.filter((l) => / create/.test(l))).toEqual([])
    expect(r.log.filter((l) => /add-iam-policy-binding/.test(l))).toHaveLength(1)
  })
})

describe('docs/colector-wif.md (ORD-POS-174, criterio 4)', () => {
  const bloques = [...GUIA.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1] ?? '')

  it('trae, en orden, los pasos del propietario: cuenta y binding, hoja, variable, copia, noche buena y retiro del secreto', () => {
    const titulos = [...GUIA.matchAll(/^### (\d+)\. (.*)$/gm)].map((m) => `${m[1]}. ${m[2]}`)
    expect(titulos).toEqual([
      '1. Variables de shell',
      '2. Simular la identidad',
      '3. Crear la cuenta de servicio y el binding WIF',
      '4. Compartir la hoja maestra',
      '5. Variable en GitHub',
      '6. Copiar el workflow',
      '7. Probar a mano y esperar una noche buena',
      '8. Retirar el secreto JSON y la clave',
    ])
    expect(GUIA).toContain(`\`${CUENTA}\``)
    expect(GUIA).toMatch(/\*\*Editor\*\*/)
    expect(GUIA).toContain('`COLECTOR_WIF_PROVIDER`')
    expect(GUIA).toContain('`PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_JSON`')
  })

  it('copia la fuente entera y comprueba que quedó idéntica; para volver atrás, la fuente anterior', () => {
    const todo = bloques.join('\n')
    expect(todo).toContain('cp web/deploy/github/manual-github-evidence.yml .github/workflows/manual-github-evidence.yml\n')
    expect(todo).toContain('cmp web/deploy/github/manual-github-evidence.yml .github/workflows/manual-github-evidence.yml && echo IDENTICOS\n')
    expect(todo).toContain('cp web/deploy/github/manual-github-evidence.anterior.yml .github/workflows/manual-github-evidence.yml\n')
    expect(existsSync(path.join(ROOT, 'web/deploy/github/manual-github-evidence.anterior.yml'))).toBe(true)
  })

  it('el secreto no se retira antes de una noche buena, y retirarlo incluye borrar la clave en Google', () => {
    const retiro = GUIA.slice(GUIA.indexOf('### 8. Retirar el secreto JSON y la clave'))
    expect(GUIA.indexOf('### 7. Probar a mano y esperar una noche buena')).toBeLessThan(GUIA.indexOf('### 8.'))
    expect(retiro).toMatch(/Solo después de una noche buena/)
    expect(retiro).toMatch(/gcloud iam service-accounts keys list/)
    expect(retiro).toMatch(/gcloud iam service-accounts keys delete/)
    expect(GUIA).toMatch(/Mientras exista el secreto/)
  })

  it('sin marcadores para pegar literalmente, y toda variable de shell que usa está definida en ella', () => {
    expect(GUIA).not.toMatch(/<[^>\n]*>/)
    expect(GUIA).not.toMatch(/\b(TU_|XXX|PLACEHOLDER|CAMBIAR)/i)
    expect(bloques.length).toBeGreaterThanOrEqual(5)
    // Se define con «VAR=» o, para lo que solo tú sabes, con «read -r -p "…" VAR».
    const definidas = new Set(bloques.flatMap((b) => [...b.matchAll(/^\s*(?:([A-Z_][A-Z0-9_]*)=|read -r -p "[^"]*" ([A-Z_][A-Z0-9_]*)$)/gm)].map((m) => m[1] ?? m[2] ?? '')))
    const usadas = new Set(bloques.flatMap((b) => [...b.matchAll(/\$\{?([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1] ?? '')))
    expect([...usadas].filter((v) => !definidas.has(v))).toEqual([])
    for (const v of ['PROJECT_ID', 'NUMERO_PROYECTO', 'CUENTA_COLECTOR', 'COLECTOR_WIF_PROVIDER']) expect(definidas.has(v), v).toBe(true)
  })

  it('ningún agente hace los pasos: ni la copia, ni --apply, ni la variable, ni el secreto', () => {
    expect(GUIA).toMatch(/Ningún agente/)
    expect(GUIA).toMatch(/variables?, no secrets?/)
    expect(GUIA).toContain('web/deploy/infra/wif-colector.sh')
  })
})
