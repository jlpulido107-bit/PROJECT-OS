import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * Misión 013 — herramientas offline de operación de la V1.6 y documentos de docs/operacion-v1-6/.
 * Todo es local y sintético: ningún comando invoca gcloud, la red ni lee secretos reales.
 */
const ROOT = path.resolve(__dirname, '..', '..')
const WEB = path.join(ROOT, 'web')
const OPS = path.join(WEB, 'scripts', 'ops')
const PREFLIGHT = path.join(OPS, 'preflight-aceptacion.mjs')
const CHECK_SECRETS = path.join(WEB, 'scripts', 'check-client-secrets.mjs')
const DOCS = path.join(ROOT, 'docs', 'operacion-v1-6')
const read = (p: string) => readFileSync(p, 'utf8')
const temps: string[] = []
const tmp = (prefix: string) => {
  const d = mkdtempSync(path.join(tmpdir(), prefix))
  temps.push(d)
  return d
}
afterAll(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })))
const env = (extra: Record<string, string> = {}) => ({ PATH: '/usr/bin:/bin', ...extra }) as unknown as NodeJS.ProcessEnv
const node = (script: string, args: string[], extra: Record<string, string> = {}) =>
  spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: env(extra) })

/** Copia sintética del repositorio con solo lo que lee el preflight (sin .git: P14 queda NO_VERIFICADO). */
function fixtureRoot(mutate?: (root: string) => void) {
  const root = tmp('preflight-')
  for (const rel of [
    'web/deploy/cloudrun/service.template.yaml', 'web/deploy/cloudrun/artifact-cleanup-policy.json', 'web/src/proxy.ts',
    'web/src/app/(private)/layout.tsx', 'web/src/lib/auth.ts', 'web/src/lib/authz.ts', 'docs/estado-produccion-v1-6-2026-10-11.md',
    'docs/estado-produccion-v1-7-2026-10-13.md', 'docs/estado-produccion-v1-8-2026-10-14.md',
  ]) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    cpSync(path.join(ROOT, rel), path.join(root, rel))
  }
  cpSync(path.join(ROOT, '.github', 'workflows'), path.join(root, '.github', 'workflows'), { recursive: true })
  mutate?.(root)
  return root
}
const edit = (root: string, rel: string, fn: (t: string) => string) => writeFileSync(path.join(root, rel), fn(read(path.join(root, rel))))
const preflight = (root: string, json = false) => node(PREFLIGHT, ['--root', root, ...(json ? ['--json'] : [])])
const estados = (root: string) => {
  const r = preflight(root, true)
  const out = JSON.parse(r.stdout) as { resultados: Array<{ id: string; estado: string }>; codigo: number }
  return { status: r.status, por: Object.fromEntries(out.resultados.map((x) => [x.id, x.estado])), out }
}

describe('preflight de aceptación offline', () => {
  it('no usa red, gcloud ni curl; solo `git` local y lectura de archivos', () => {
    const src = read(PREFLIGHT)
    expect(src).not.toMatch(/fetch\(|https?:\/\/|process\.env\.|\bspawn|\bexecSync|(?<![.\w])exec\(/)
    // El único proceso externo es `git` (lectura local); nunca gcloud ni curl.
    expect([...src.matchAll(/execFileSync\(\s*'([^']+)'/g)].map((m) => m[1])).toEqual(['git', 'git', 'git'])
  })

  it('sobre el repositorio real nunca da FALLO (0, o 3 si el commit desplegado no está en un clon superficial)', () => {
    const r = node(PREFLIGHT, [])
    expect([0, 3], r.stdout).toContain(r.status)
    expect(r.stdout).not.toMatch(/^FALLO/m)
    expect(r.stdout).toContain('no es la configuración real de GCP')
  })

  it('sin git, P14 queda NO_VERIFICADO y el código de salida es 3: NO_VERIFICADO nunca cuenta como OK', () => {
    const { status, por, out } = estados(fixtureRoot())
    expect(por.P14).toBe('NO_VERIFICADO')
    // P15: el colector V1.1 usa una clave de cuenta de servicio de Google (riesgo pendiente de decisión).
    expect(por.P15).toBe('NO_VERIFICADO')
    expect(Object.entries(por).filter(([id]) => !['P14', 'P15'].includes(id)).every(([, e]) => e === 'OK')).toBe(true)
    expect(status).toBe(3)
    expect(out.codigo).toBe(3)
  })

  it('R3-1 · la CI de los PR no recibe la clave de Google; el colector manual con opción explícita queda en P15 (NO_VERIFICADO), nunca OK', () => {
    const { por, out } = estados(fixtureRoot())
    expect(por.P12).toBe('OK')
    expect(por.P15).toBe('NO_VERIFICADO')
    const p15 = out.resultados.find((r) => r.id === 'P15') as { motivo: string } | undefined
    expect(p15?.motivo).toMatch(/manual-github-evidence\.yml/)
    expect(p15?.motivo).toMatch(/sync_to_sheets/)
    expect(p15?.motivo).toMatch(/decisión del propietario/)
    expect(p15?.motivo).not.toMatch(/pr-validation/)
    // La CI de los PR valida la sincronización con la hoja EN MEMORIA, sin secretos ni el sincronizador real.
    const pr = read(path.join(ROOT, '.github/workflows/pr-validation.yml'))
    expect(pr).not.toMatch(/secrets|PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_JSON|sync_sheets\.py|requirements-sync/)
    expect(pr).toContain('python tests/sheets_fixture_dry_run.py')
    const sinColector = estados(fixtureRoot((r) => rmSync(path.join(r, '.github/workflows/manual-github-evidence.yml'))))
    expect(sinColector.por.P15).toBe('OK')
  })

  // El paso que la CI de los PR tenía antes de R3: clave de Google y dry-run con el código del propio PR.
  const PASO_ANTERIOR = '      - name: Verify Google Sheets credentials and schema (read-only)\n        env:\n          PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_JSON: ${{ secrets.PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_JSON }}\n        run: python src/sync_sheets.py --report r.json --dry-run\n'
  const enLaCiDePr = (paso: string) => (r: string) => edit(r, '.github/workflows/pr-validation.yml', (t) => t.replace('      - name: Preserve smoke report for review', `${paso}      - name: Preserve smoke report for review`))
  const enElColector = (fn: (t: string) => string) => (r: string) => edit(r, '.github/workflows/manual-github-evidence.yml', fn)
  it.each([
    ['la CI de PR vuelve a inyectar la clave y el dry-run real (el workflow anterior a R3)', 'P12', enLaCiDePr(PASO_ANTERIOR)],
    ['la CI de PR ejecuta el sincronizador real, aunque sea sin clave', 'P12', enLaCiDePr('      - run: python src/sync_sheets.py --report r.json --dry-run\n')],
    ['la CI de PR con otro secreto del repositorio', 'P12', enLaCiDePr('      - run: echo ok\n        env:\n          K: ${{ secrets.OTRA_CLAVE }}\n')],
    ['la CI de PR con secrets[…]', 'P12', enLaCiDePr("      - run: echo ok\n        env:\n          K: ${{ secrets['OTRA_CLAVE'] }}\n")],
    ['la CI de PR con toJSON(secrets)', 'P12', enLaCiDePr('      - run: echo ok\n        env:\n          K: ${{ toJSON(secrets) }}\n')],
    ['la CI de PR con google-github-actions/auth', 'P12', enLaCiDePr('      - uses: google-github-actions/auth@v2\n')],
    ['la CI de PR con la API de Sheets', 'P12', enLaCiDePr('      - run: curl -s https://sheets.googleapis.com/v4/spreadsheets/x\n')],
    ['el colector manual con un disparador automático', 'P12', enElColector((t) => t.replace('on:\n  workflow_dispatch:', 'on:\n  push:\n  workflow_dispatch:'))],
    ['un workflow con la clave y sin bloque on: legible', 'P12', (r: string) => writeFileSync(path.join(r, '.github/workflows/nuevo.yml'), 'env:\n  K: ${{ secrets.PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_JSON }}\n')],
    ['el colector manual sin la condición de la opción', 'P15', enElColector((t) => t.replaceAll('        if: ${{ inputs.sync_to_sheets }}\n', ''))],
    ['el colector manual con la opción activada por defecto', 'P15', enElColector((t) => t.replace(/(sync_to_sheets:[\s\S]*?default: )false/, '$1true'))],
    ['el colector manual con la condición debilitada', 'P15', enElColector((t) => t.replace('if: ${{ inputs.sync_to_sheets }}\n        env:\n          PROJECT_OS_GOOGLE', 'if: ${{ inputs.sync_to_sheets || true }}\n        env:\n          PROJECT_OS_GOOGLE'))],
    ['el colector manual con la clave en el env del job', 'P15', enElColector((t) => t.replace('    runs-on: ubuntu-latest', '    runs-on: ubuntu-latest\n    env:\n      K: ${{ secrets.PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_JSON }}'))],
    ['la CI de PR con identidad OIDC (sin secreto)', 'P12', (r: string) => edit(r, '.github/workflows/pr-validation.yml', (t) => t.replace('permissions:\n', 'permissions:\n  id-token: write\n'))],
    ['la CI de PR con vars.*', 'P12', enLaCiDePr('      - run: echo ok\n        env:\n          K: ${{ vars.GCP_SA_KEY }}\n')],
    ['un workflow con pull_request_target', 'P12', (r: string) => writeFileSync(path.join(r, '.github/workflows/prt.yml'), 'on:\n  pull_request_target:\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n')],
    ['un workflow automático que lanza el colector manual', 'P12', (r: string) => writeFileSync(path.join(r, '.github/workflows/lanza.yml'), 'on:\n  push:\npermissions:\n  actions: write\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: gh workflow run manual-github-evidence.yml -f sync_to_sheets=true\n')],
    ['el colector manual con un segundo job con la clave sin condición', 'P15', enElColector((t) => `${t}  otro:\n    runs-on: ubuntu-latest\n    env:\n      K: \${{ secrets.PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_JSON }}\n    steps:\n      - run: echo ok\n`)],
    ['otro workflow manual con credenciales de Google', 'P15', (r: string) => writeFileSync(path.join(r, '.github/workflows/otro.yml'), 'on:\n  workflow_dispatch:\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: google-github-actions/auth@v2\n')],
  ])('R3-1 · %s → FALLO en %s y código 1 (nunca un NO_VERIFICADO aceptable)', (_n, id, mutate) => {
    const { status, por } = estados(fixtureRoot(mutate))
    expect(por[id]).toBe('FALLO')
    expect(status).toBe(1)
  })

  it('R3-1 · el token efímero de GitHub sí puede usarse en la CI de PR', () => {
    expect(estados(fixtureRoot(enLaCiDePr('      - run: echo ok\n        env:\n          T: ${{ secrets.GITHUB_TOKEN }}\n')))).toMatchObject({ por: { P12: 'OK' } })
  })

  it.each([
    ['maxScale de revisión 3', 'P1', (t: string) => t.replace("autoscaling.knative.dev/maxScale: '1'", "autoscaling.knative.dev/maxScale: '3'")],
    ['maxScale de servicio en la plantilla', 'P2', (t: string) => t.replace('run.googleapis.com/ingress: all', "run.googleapis.com/ingress: all\n    run.googleapis.com/maxScale: '3'")],
    ['variable de escritura', 'P3', (t: string) => t.replace('- name: SHEETS_CREDENTIALS', "- name: PROJECT_OS_WRITE_MODE\n              value: mock\n            - name: SHEETS_CREDENTIALS")],
    ['secreto en latest', 'P4', (t: string) => t.replace("key: '${SECRET_VERSION_NEXTAUTH}'", "key: 'latest'")],
    ['sin ADC', 'P5', (t: string) => t.replace('value: adc', 'value: service-account-key')],
  ])('plantilla alterada (%s) → FALLO en %s y código 1', (_name, id, fn) => {
    const { status, por } = estados(fixtureRoot((r) => edit(r, 'web/deploy/cloudrun/service.template.yaml', fn)))
    expect(por[id]).toBe('FALLO')
    expect(status).toBe(1)
  })

  it('política de limpieza sin la regla de producción → FALLO', () => {
    const { status, por } = estados(fixtureRoot((r) => edit(r, 'web/deploy/cloudrun/artifact-cleanup-policy.json',
      (t) => JSON.stringify(JSON.parse(t).filter((p: { name: string }) => p.name !== 'conservar-produccion')))))
    expect(por.P6).toBe('FALLO')
    expect(status).toBe(1)
  })

  it('un archivo ausente da NO_VERIFICADO, no OK', () => {
    const { status, por } = estados(fixtureRoot((r) => rmSync(path.join(r, 'web/deploy/cloudrun/artifact-cleanup-policy.json'))))
    expect(por.P6).toBe('NO_VERIFICADO')
    expect(status).toBe(3)
  })

  it.each([
    ['schedule', 'P11', 'on:\n  schedule:\n    - cron: "0 0 * * *"\n'],
    ['credenciales de Google Cloud', 'P12', 'jobs:\n  x:\n    steps:\n      - uses: google-github-actions/auth@v2\n'],
  ])('un workflow con %s → FALLO en %s', (_name, id, yaml) => {
    const { status, por } = estados(fixtureRoot((r) => writeFileSync(path.join(r, '.github/workflows/nuevo.yml'), yaml)))
    expect(por[id]).toBe('FALLO')
    expect(status).toBe(1)
  })

  it('el layout privado sin requireUser → FALLO', () => {
    const { por } = estados(fixtureRoot((r) => edit(r, 'web/src/app/(private)/layout.tsx', (t) => t.replace('await requireUser()', 'null as never'))))
    expect(por.P8).toBe('FALLO')
  })

  it('un registro de producción con otro digest → FALLO', () => {
    const { por } = estados(fixtureRoot((r) => edit(r, 'docs/estado-produccion-v1-8-2026-10-14.md', (t) => t.replaceAll('7ef79fc0', '00000000'))))
    expect(por.P13).toBe('FALLO')
  })

  it('P13 y P14 siguen la versión desplegada (DESPLEGADO), no la línea base V1.6 congelada', async () => {
    const { DESPLEGADO, PRODUCCION } = (await import(path.join(OPS, 'produccion-v1-6.mjs'))) as { DESPLEGADO: Record<string, string>; PRODUCCION: Record<string, string> }
    expect(DESPLEGADO.commit).not.toBe(PRODUCCION.commit)
    const registro = read(path.join(ROOT, DESPLEGADO.registro ?? ''))
    for (const v of [DESPLEGADO.commit, DESPLEGADO.digest, DESPLEGADO.revision]) expect(registro).toContain(v)
    // Un registro que solo describe la V1.6 no basta: P13 lo rechaza.
    const { por } = estados(fixtureRoot((r) => edit(r, 'docs/estado-produccion-v1-8-2026-10-14.md', () => read(path.join(ROOT, 'docs/estado-produccion-v1-6-2026-10-11.md')))))
    expect(por.P13).toBe('FALLO')
  })

  it('uso incorrecto → código 2', () => {
    expect(node(PREFLIGHT, ['--borrar']).status).toBe(2)
    expect(node(PREFLIGHT, ['--root']).status).toBe(2)
  })
})

describe('preflight de CIERRE (Misión 014, D.1)', () => {
  const CIERRE = path.join(OPS, 'preflight-cierre.mjs')
  type Fila = { id: string; control: string; estado: string; evidencia: string; accion: string }
  const ejecutar = (root: string | null, ...flags: string[]) => {
    const r = node(CIERRE, [...(root ? ['--root', root] : []), '--json', ...flags])
    const out = JSON.parse(r.stdout) as { resultados: Fila[]; codigo: number }
    return { status: r.status, por: Object.fromEntries(out.resultados.map((x) => [x.id, x.estado])), out }
  }
  /** Copia del repositorio con lo que leen los preflights (sin .git: K2/P14 quedan NO_VERIFICADO). */
  function repo(mutate?: (root: string) => void) {
    const root = tmp('cierre-')
    for (const rel of ['docs', 'web/src', 'web/scripts', 'web/deploy', '.github/workflows']) cpSync(path.join(ROOT, rel), path.join(root, rel), { recursive: true })
    mutate?.(root)
    return root
  }

  it('es offline: solo importa las herramientas del repositorio; ni red, ni gcloud, ni procesos propios', () => {
    const src = read(CIERRE)
    expect(src).not.toMatch(/child_process|fetch\(|https?:\/\/|process\.env\./)
    expect([...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]).sort()).toEqual(['./evidencia.mjs', './matriz.mjs', './plan-inspeccion.mjs', './preflight-aceptacion.mjs', './produccion-v1-6.mjs', 'node:fs', 'node:path'])
  })

  it('sobre el repositorio real: K1–K10 sin FALLO; lo real (K11–K16) siempre NO_VERIFICADO, nunca OK', () => {
    const { status, por, out } = ejecutar(null)
    for (const id of ['K1', 'K3', 'K4', 'K5', 'K6', 'K7', 'K8', 'K9', 'K10']) expect(por[id], id).toBe('OK')
    expect(['OK', 'NO_VERIFICADO']).toContain(por.K2)
    for (const id of ['K11', 'K12', 'K13', 'K14', 'K15', 'K16']) expect(por[id], id).toBe('NO_VERIFICADO')
    expect(status).toBe(3)
    expect(out.resultados.filter((r) => r.estado === 'NO_VERIFICADO').every((r) => r.accion !== '—')).toBe(true)
    const solo = ejecutar(null, '--solo-repositorio')
    expect([0, 3]).toContain(solo.status)
    expect(Object.keys(solo.por)).toEqual(['K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7', 'K8', 'K9', 'K10'])
  })

  it('imprime la tabla CONTROL | ESTADO | EVIDENCIA | ACCIÓN PENDIENTE', () => {
    const r = node(CIERRE, [])
    expect(r.stdout).toContain('| CONTROL | ESTADO | EVIDENCIA | ACCIÓN PENDIENTE |')
    expect(r.stdout).toMatch(/^\| K12 Configuración real en GCP .* \| NO_VERIFICADO \|/m)
  })

  it.each([
    ['una matriz con un falso aprobado', 'K8', (r: string) => {
      const f = path.join(r, 'docs/operacion-v1-6/matriz-aceptacion.md')
      writeFileSync(f, read(f).replace(/^\| G1 \| (.*?) \| PENDIENTE \|/m, '| G1 | $1 | VERIFICADO |'))
    }],
    ['el acta ausente', 'K5', (r: string) => rmSync(path.join(r, 'docs/operacion-v1-6/acta-cierre-v1-6.md'))],
    ['el acta sin la identidad completa', 'K1', (r: string) => {
      const f = path.join(r, 'docs/operacion-v1-6/acta-cierre-v1-6.md')
      writeFileSync(f, read(f).replaceAll('7f44216bdf85a9832e014f45c27ac643e00ceff9', '7f44216'))
    }],
    ['la hoja con un comando de mutación', 'K9', (r: string) => {
      const f = path.join(r, 'docs/operacion-v1-6/hoja-propietario.md')
      writeFileSync(f, `${read(f)}\nEjecuta bash web/deploy/infra/remediacion-v1-6.sh destruir-version x 1\n`)
    }],
    ['la hoja sin el bloque 4', 'K9', (r: string) => {
      const f = path.join(r, 'docs/operacion-v1-6/hoja-propietario.md')
      writeFileSync(f, read(f).replace('## Bloque 4.', '## Costos.'))
    }],
    ['la remediación sin la compuerta de revisión única', 'K10', (r: string) => {
      const f = path.join(r, 'web/deploy/infra/remediacion-v1-6.sh')
      writeFileSync(f, read(f).replaceAll('servicio_comprobable "$svc"', 'true'))
    }],
    ['un diagnóstico que muta', 'K6', (r: string) => {
      const f = path.join(r, 'web/deploy/infra/remediacion-v1-6.sh')
      writeFileSync(f, read(f).replace("  echo \"== E1: coincidencias por ORIGEN", "  gcloud secrets versions disable 1 --secret=x --project=\"$PROJECT_ID\"\n  echo \"== E1: coincidencias por ORIGEN"))
    }],
    ['un ejemplo de evidencia que no se declara sintético', 'K7', (r: string) => {
      const f = path.join(r, 'docs/operacion-v1-6/evidencia-ejemplo.json')
      writeFileSync(f, read(f).replace('"ejemplo_sintetico": true', '"ejemplo_sintetico": false'))
    }],
    ['la CI de PR con la clave de Google (R3-1)', 'K4', (r: string) => {
      const f = path.join(r, '.github/workflows/pr-validation.yml')
      writeFileSync(f, read(f).replace('      - name: Preserve', '      - env:\n          K: ${{ secrets.PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_JSON }}\n        run: python src/sync_sheets.py --dry-run\n      - name: Preserve'))
    }],
    ['el colector manual sin la opción explícita (R3-1)', 'K4', (r: string) => {
      const f = path.join(r, '.github/workflows/manual-github-evidence.yml')
      writeFileSync(f, read(f).replaceAll('        if: ${{ inputs.sync_to_sheets }}\n', ''))
    }],
  ])('%s → FALLO en %s y código 1', (_n, id, mutate) => {
    const { status, por } = ejecutar(repo(mutate))
    expect(por[id]).toBe('FALLO')
    expect(status).toBe(1)
  })

  it('uso incorrecto → código 2', () => {
    expect(node(CIERRE, ['--borrar']).status).toBe(2)
    expect(node(CIERRE, ['--root']).status).toBe(2)
  })
})

describe('check:client-secrets: autoprueba con valores canario inventados', () => {
  // Valores inventados para la prueba: no son ni se parecen a secretos reales.
  const CANARIO = { NEXTAUTH_SECRET: 'canario-nextauth-0000-no-real', GOOGLE_CLIENT_SECRET: 'canario-cliente-0000-no-real', SHEETS_SPREADSHEET_ID: 'canario-hoja-0000-no-real', AUTH_ALLOWED_EMAILS: 'canario@example.com' }
  const assets = (contenido: string) => {
    const d = tmp('assets-')
    mkdirSync(path.join(d, 'chunks'))
    writeFileSync(path.join(d, 'chunks', 'app.js'), `console.log("hola");${contenido}`)
    return d
  }
  const check = (dir: string, extra: Record<string, string>, ...args: string[]) => node(CHECK_SECRETS, ['--dir', dir, ...args], extra)

  it('assets limpios con los 4 valores canario en el entorno → 0 y 4 valores comparados', () => {
    const r = check(assets(''), CANARIO, '--min-values=4')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Valores de entorno comparados: 4.')
  })

  it.each(Object.keys(CANARIO))('detecta la fuga del valor de %s sin imprimirlo', (name) => {
    const value = CANARIO[name as keyof typeof CANARIO]
    const r = check(assets(`var x="${value}";`), CANARIO)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(`valor de ${name}`)
    expect(r.stdout + r.stderr).not.toContain(value)
  })

  it('FINANZAS_SHEET_ID (ORD-POS-074): se compara si está en el entorno y su fuga se detecta sin imprimirla', () => {
    const value = 'canario-finanzas-0000-no-real'
    const limpio = check(assets(''), { ...CANARIO, FINANZAS_SHEET_ID: value })
    expect(limpio.stdout).toContain('Valores de entorno comparados: 5.')
    const r = check(assets(`var x="${value}";`), { FINANZAS_SHEET_ID: value })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('valor de FINANZAS_SHEET_ID')
    expect(r.stdout + r.stderr).not.toContain(value)
  })

  it('detecta un token y un correo de persona por patrón, sin imprimirlos', () => {
    const token = `ya29.${'a'.repeat(30)}`
    const r = check(assets(`var t="${token}";var m="persona.inventada@dominio-falso.test";`), {})
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('token OAuth de Google')
    expect(r.stderr).toContain('dirección de correo')
    expect(r.stdout + r.stderr).not.toContain(token)
    expect(r.stdout + r.stderr).not.toContain('persona.inventada')
  })

  it('sin valores en el entorno y --min-values=4 → código 3 (NO_VERIFICADO), no un falso OK', () => {
    const r = check(assets(''), {}, '--min-values=4')
    expect(r.status).toBe(3)
    expect(r.stderr).toContain('NO_VERIFICADO')
    expect(r.stdout).not.toContain('OK:')
  })

  it('sin --min-values conserva el comportamiento anterior y declara 0 valores comparados', () => {
    const r = check(assets(''), {})
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Valores de entorno comparados: 0.')
  })

  it('directorio inexistente o argumentos inválidos → código 2', () => {
    expect(check(path.join(tmpdir(), 'no-existe-xyz'), {}).status).toBe(2)
    expect(node(CHECK_SECRETS, ['--min-values=-1']).status).toBe(2)
  })

  it('la CI exige los 4 valores falsos del job', () => {
    const wf = read(path.join(ROOT, '.github', 'workflows', 'web-validation.yml'))
    expect(wf).toContain('npm run check:client-secrets -- --min-values=4')
    for (const name of ['NEXTAUTH_SECRET', 'GOOGLE_CLIENT_SECRET', 'SHEETS_SPREADSHEET_ID', 'AUTH_ALLOWED_EMAILS']) expect(wf).toMatch(new RegExp(`^\\s+${name}: `, 'm'))
  })
})

describe('matriz de aceptación (reglas de scripts/ops/matriz.mjs, Misión 014)', async () => {
  const { validarMatriz, leerMatriz, resumenCalculado, IDS } = (await import(path.join(OPS, 'matriz.mjs'))) as {
    validarMatriz: (t: string, o?: { lineaBase?: string | null; produccion?: Record<string, unknown> }) => string[]
    leerMatriz: (t: string) => { filas: Array<{ id: string; estado: string; real: string; tecnica: string; tiempo: string; falta: string; columnas: number }> }
    resumenCalculado: (t: string) => Record<string, string[]>
    IDS: string[]
  }
  const { PRODUCCION } = (await import(path.join(OPS, 'produccion-v1-6.mjs'))) as { PRODUCCION: Record<string, string> }
  const matriz = read(path.join(DOCS, 'matriz-aceptacion.md'))
  const base = read(path.join(DOCS, 'linea-base-v1-6.md'))
  const validar = (t: string, produccion = PRODUCCION) => validarMatriz(t, { lineaBase: base, produccion })
  /** Copia de la matriz con la fila `id` cambiada: columnas 0-7 (ID, control, estado, real, técnica, tiempo, falta, siguiente). */
  const conFila = (id: string, cambio: Partial<Record<number, string>>) => matriz.split('\n').map((l) => {
    if (!l.startsWith(`| ${id} |`)) return l
    const c = l.split('|').slice(1, -1).map((x) => x.trim())
    for (const [i, v] of Object.entries(cambio)) c[Number(i)] = v ?? ''
    return `| ${c.join(' | ')} |`
  }).join('\n')
  const por = Object.fromEntries(leerMatriz(matriz).filas.map((f) => [f.id, f.estado]))

  it('la matriz real cumple todas las reglas: ningún falso aprobado', () => {
    expect(validar(matriz)).toEqual([])
    const r = node(path.join(OPS, 'matriz.mjs'), [])
    expect(r.status, r.stdout).toBe(0)
    expect(r.stdout).toContain('Sin violaciones')
  })

  it('conserva los 29 controles originales A1–H, en orden, con 8 columnas, y el checklist los define', () => {
    const filas = leerMatriz(matriz).filas
    expect(filas.map((f) => f.id)).toEqual(IDS)
    for (const f of filas) expect(f.columnas, f.id).toBe(8)
    const checklist = read(path.join(ROOT, 'docs', 'despliegue-v1-6-aceptacion.md'))
    for (const id of IDS.filter((i) => i !== 'H')) expect(checklist, id).toContain(`| ${id} |`)
  })

  it('el resumen coincide con todas las filas (y una fila cambiada sin actualizarlo se detecta)', () => {
    const resumen = resumenCalculado(matriz)
    expect(resumen.VERIFICADO).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'B1', 'C1', 'C2', 'C4', 'C5', 'C6', 'C7', 'D1', 'D2', 'D3', 'E2', 'F1', 'F2', 'G3'])
    expect(resumen.NO_APLICA).toEqual(['G2'])
    expect(validar(conFila('C4', { 2: 'PENDIENTE', 3: '—' }))).toEqual(expect.arrayContaining([expect.stringMatching(/^resumen: VERIFICADO/)]))
  })

  it('lo que aún no tiene evidencia completa no figura como verificado (estado tras EV-13 y EV-14)', () => {
    for (const id of ['G1', 'H']) expect(por[id], id).toBe('PENDIENTE')
    for (const id of ['C3', 'E1', 'F3']) expect(por[id], id).toBe('PARCIAL')
    expect(por.G2).toBe('NO_APLICA')
  })

  it.each([
    ['solo un reporte (R)', 'C1', { 2: 'VERIFICADO', 3: '**R:** EV-04 (12/12 pestañas, dicho de palabra)', 6: '—' }],
    ['solo una simulación (S), aunque mencione el procedimiento', 'G3', { 2: 'VERIFICADO', 3: '—', 6: '—' }],
    ['solo CI sin ser un control de código', 'C5', { 2: 'VERIFICADO', 3: '—', 4: '**CI:** E2E de planificación', 6: '—' }],
    ['evidencia real pero con algo pendiente', 'A2', { 2: 'VERIFICADO', 6: 'Falta comparar el origen' }],
    ['un requisito de tiempo sin cumplir', 'E1', { 2: 'VERIFICADO', 6: '—' }],
    ['una decisión pendiente', 'C3', { 2: 'VERIFICADO', 6: '—' }],
    ['evidencia real que no menciona su condición de cierre', 'A2', { 2: 'VERIFICADO', 3: '**P:** EV-06 (URL estable)', 6: '—' }],
  ])('VERIFICADO con %s → violación (controles compuestos y evidencia incompleta no se aprueban)', (_n, id, cambio) => {
    expect(validar(conFila(id, cambio)).some((v) => v.startsWith(`${id}:`))).toBe(true)
  })

  it('la evidencia simulada nunca cuenta como producción: ni como VERIFICADO ni citando el ejemplo sintético', () => {
    expect(validar(conFila('A1', { 3: '—' })).join('\n')).toMatch(/A1: VERIFICADO sin evidencia real/)
    expect(validar(conFila('A1', { 3: '**P:** EV-06; ver evidencia-ejemplo.json' })).join('\n')).toMatch(/sintético/)
    // Una etiqueta en la columna equivocada (una simulación presentada como evidencia real) se rechaza.
    expect(validar(conFila('A1', { 3: '**S:** gcloud falso' })).join('\n')).toMatch(/columna equivocada/)
  })

  it('cada P cita un EV-xx que existe en el registro de la línea base (trazabilidad)', () => {
    expect(validar(conFila('A5', { 3: '**P:** auditoría propia' })).join('\n')).toMatch(/A5: evidencia P sin referencia EV-xx/)
    expect(validar(conFila('A5', { 3: '**P:** EV-99 (inventada)' })).join('\n')).toMatch(/A5: cita EV-99/)
  })

  it('lo citado como P es P en el registro: un reporte sin salida (R) no se presenta como resultado concreto', () => {
    expect(validar(conFila('A1', { 3: '**P:** EV-05 (consola, reportado)' })).join('\n')).toMatch(/A1: cita EV-05 como P, pero el registro de la línea base lo clasifica como R/)
    expect(validar(conFila('A3', { 3: '**P:** EV-03 y EV-04' })).join('\n')).toMatch(/A3: cita EV-04 como P/)
    // Un registro sin tipo deja la trazabilidad sin base.
    const sinTipo = base.replace(/(\| EV-03 \|.*\| )P( \|)/, '$1?$2')
    expect(validarMatriz(matriz, { lineaBase: sinTipo, produccion: PRODUCCION }).join('\n')).toMatch(/registro: EV-03 sin tipo P o R/)
  })

  it('«VERIFICADO (código)» solo vale para D3: en cualquier otro control la CI no sustituye a la evidencia real', () => {
    const c5 = validar(conFila('C5', { 2: 'VERIFICADO (código)', 3: '—', 4: '**CI:** pruebas unitarias', 5: '—', 6: '—' }))
    expect(c5.join('\n')).toMatch(/C5: VERIFICADO sin evidencia real del propietario \(P\)/)
    expect(validar(matriz).filter((x) => x.startsWith('D3:'))).toEqual([]) // D3 sigue siendo válido solo con CI
  })

  it.each([
    ['un rechazo de Google antes del callback', '**P:** EV-12 (Google bloqueó la cuenta no autorizada: «Acceso bloqueado»)'],
    ['un AccessDenied sin saber qué capa rechazó', '**P:** EV-12 (AccessDenied con una cuenta no autorizada)'],
    ['un rechazo de la app con una cuenta que no se sabe elegible', '**P:** EV-12 (rechazo de la app con otra cuenta)'],
  ])('R3-2 · C2 no se aprueba con %s', (_n, real) => {
    expect(validar(conFila('C2', { 2: 'VERIFICADO', 3: real, 6: '—' })).join('\n')).toMatch(/C2: VERIFICADO sin la evidencia real que exige su condición de cierre/)
  })

  it('R3-2 · C2 sí puede cerrarse con una cuenta elegible fuera de la lista y el rechazo de la app', () => {
    const real = '**P:** EV-12 (cuenta elegible para el login de Google, fuera de la lista: rechazo de la app en el callback, sin datos)'
    expect(validar(conFila('C2', { 2: 'VERIFICADO', 3: real, 6: '—' })).filter((x) => x.startsWith('C2:'))).toEqual([])
  })

  it.each([
    ['PARCIAL sin evidencia real', 'C3', { 3: '—' }, /C3: PARCIAL sin evidencia real/],
    ['PENDIENTE con evidencia real', 'G1', { 3: '**P:** EV-12' }, /G1: PENDIENTE con evidencia real/],
    ['PENDIENTE sin decir qué falta', 'G1', { 6: '—' }, /G1: PENDIENTE sin indicar qué falta/],
    ['NO_APLICA como sustituto de una prueba pendiente', 'G1', { 2: 'NO_APLICA hasta que haya ventana' }, /G1: NO_APLICA no justificado/],
    ['NO_APLICA sin la condición que lo hace aplicable', 'G2', { 2: 'NO_APLICA', 6: 'Revisión anterior', 7: 'Reevaluar' }, /G2: NO_APLICA sin la condición/],
    ['E1 sin su límite de tiempo (T)', 'E1', { 5: '—' }, /E1: debe reflejar su límite con la etiqueta T/],
    ['F3 sin su límite de tiempo (T)', 'F3', { 5: '—' }, /F3: debe reflejar su límite con la etiqueta T/],
    ['C3 sin su decisión pendiente (DEC)', 'C3', { 5: '—' }, /C3: debe reflejar su límite con la etiqueta DEC/],
    ['G1 sin su decisión pendiente (DEC)', 'G1', { 5: '—' }, /G1: debe reflejar su límite con la etiqueta DEC/],
    ['un estado fuera del vocabulario', 'A3', { 2: 'OK' }, /A3: estado «OK» fuera del vocabulario/],
  ])('PARCIAL, PENDIENTE y NO_APLICA se distinguen: %s → violación', (_n, id, cambio, error) => {
    expect(validar(conFila(id, cambio)).join('\n')).toMatch(error)
  })

  it('un cambio de SHA, revisión o digest exige revalidar la matriz y la línea base', () => {
    for (const [campo, valor] of [['commit', 'a'.repeat(40)], ['revision', 'project-os-dashboard-00002-abc'], ['digest', `sha256:${'1'.repeat(64)}`]] as const) {
      const v = validar(matriz, { ...PRODUCCION, [campo]: valor })
      expect(v.filter((x) => x.startsWith('identidad:')), campo).toHaveLength(2)
    }
  })

  it('H no puede aprobarse con bloqueadores; sí con evidencia o con excepciones expresas, fechadas y referenciadas', () => {
    // H aprobado exige además la aprobación real del propietario registrada como evidencia (acta firmada).
    // Sin las excepciones ya registradas (§5), para que los controles abiertos bloqueen H.
    const tabla = '| ID | Excepción | Fecha | Referencia |\n| --- | --- | --- | --- |\n'
    const sinExcepciones = matriz.replace(/(\| ID \| Excepción \| Fecha \| Referencia \|\n\| --- \| --- \| --- \| --- \|\n)(?:\|[^\n]*\n)*/, '$1')
    const hAprobado = sinExcepciones.split('\n').map((l) => (l.startsWith('| H |') ? conFila('H', { 2: 'VERIFICADO', 3: '**P:** EV-12 (aprobación del propietario en el acta)', 6: '—' }).split('\n').find((x) => x.startsWith('| H |')) : l)).join('\n')
    expect(validar(conFila('H', { 2: 'VERIFICADO', 6: '—' })).join('\n')).toMatch(/H: VERIFICADO sin evidencia real/)
    expect(validar(hAprobado).join('\n')).toMatch(/H: VERIFICADO con controles sin evidencia ni excepción del propietario: C3, E1, F3, G1/)
    const pendientes = leerMatriz(matriz).filas.filter((f) => !['VERIFICADO', 'NO_APLICA'].includes(f.estado) && f.id !== 'H').map((f) => f.id)
    const conExcepciones = (filas: string) => hAprobado.replace(`${tabla}`, `${tabla}${filas}`)
    const todas = pendientes.map((id) => `| ${id} | Aceptada | 2026-11-20 | https://github.com/jlpulido107-bit/PROJECT-OS/pull/24#issuecomment-1 |`).join('\n') + '\n'
    expect(validar(conExcepciones(todas)).filter((x) => x.startsWith('H:'))).toEqual([])
    // Una excepción sin fecha o sin referencia no cuenta.
    const sinFecha = todas.replace('| 2026-11-20 |', '| pronto |')
    expect(validar(conExcepciones(sinFecha)).join('\n')).toMatch(/excepciones: .* sin fecha o sin referencia/)
  })
})

describe('plan de inspección de solo lectura', () => {
  const PLAN = path.join(OPS, 'plan-inspeccion.mjs')
  type Paso = { control: string; tipo: string; comando: string }
  const plan = () => JSON.parse(node(PLAN, ['--json']).stdout) as { solo_lectura: boolean; pasos: Paso[] }

  it('solo imprime: no importa child_process ni usa la red', () => {
    const src = read(PLAN)
    expect(src).not.toMatch(/child_process|fetch\(|\bspawn|execFile|execSync/)
  })

  it('cada comando es de lectura, fija proyecto y servicio, y nunca lee valores de secretos', () => {
    const { solo_lectura, pasos } = plan()
    expect(solo_lectura).toBe(true)
    expect(pasos.length).toBeGreaterThanOrEqual(15)
    for (const p of pasos.filter((x) => x.tipo === 'gcloud')) {
      expect(p.comando, p.control).toContain('--project=project-os-511102')
      expect(p.comando, p.control).not.toMatch(/versions access|tags add|\supdate\s|\sdelete\s|\screate\s|--apply/)
    }
    expect(new Set(pasos.map((p) => p.control))).toEqual(new Set(['A1', 'A2', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'F3', 'E1', 'G2']))
  })

  it('A7 lee el maxScale de servicio Y el de revisión (D-1); A9 lee la etiqueta produccion', () => {
    const { pasos } = plan()
    const a7 = pasos.find((p) => p.control === 'A7' && p.tipo === 'gcloud')?.comando ?? ''
    expect(a7).toContain('metadata.annotations."run.googleapis.com/maxScale"')
    expect(a7).toContain('spec.template.metadata.annotations')
    expect(pasos.find((p) => p.control === 'A9')?.comando).toContain('/dashboard:produccion')
  })

  it('los comandos de logs solo cuentan coincidencias: nunca imprimen el contenido', () => {
    for (const p of plan().pasos.filter((x) => x.control === 'E1')) {
      expect(p.comando).toMatch(/--format='value\(timestamp\)' \| wc -l\) && echo "conteo=\$n"/)
      expect(p.comando).not.toMatch(/textPayload\)|jsonPayload\)|--format=json/)
      // R1-3: búsqueda en TODOS los campos (sin restringir a textPayload) y ventana de 30 días (retención de _Default).
      expect(p.comando).not.toMatch(/textPayload:|jsonPayload:|protoPayload:/)
      expect(p.comando).toContain('--freshness=30d')
      // Los registros de auditoría de Google (principalEmail del administrador) no cuentan como fuga de la app.
      expect(p.comando).toContain('AND NOT logName:"cloudaudit.googleapis.com"')
    }
  })

  // ---- R2-2: una lectura fallida nunca se convierte en «0» ----
  describe('R2-2 · los comandos de conteo propagan el fallo (gcloud FALSO, nunca GCP)', () => {
    const fake = tmp('gcloud-falso-')
    // FAKE_MODE: falla → error y código 1; vacio → sin salida; tres → 3 líneas; frase → log con la línea de identidad.
    writeFileSync(path.join(fake, 'gcloud'), [
      '#!/bin/sh',
      'case "$FAKE_MODE" in',
      '  falla) echo "ERROR: (gcloud) PERMISSION_DENIED" >&2; exit 1 ;;',
      '  vacio) exit 0 ;;',
      '  tres) printf "2026-10-01T00:00:00Z\\n2026-10-02T00:00:00Z\\n2026-10-03T00:00:00Z\\n" ;;',
      '  frase) printf "Paso 1\\nIdentidad de compilación verificada\\nPaso 2\\n" ;;',
      'esac',
    ].join('\n'))
    chmodSync(path.join(fake, 'gcloud'), 0o755)
    const ejecutar = (comando: string, modo: string) =>
      spawnSync('bash', ['-c', comando], { encoding: 'utf8', env: { PATH: `${fake}:/usr/bin:/bin`, FAKE_MODE: modo } as unknown as NodeJS.ProcessEnv }).stdout.trim()
    const comandos = (c: string) => plan().pasos.filter((p) => p.control === c && /conteo=/.test(p.comando)).map((p) => p.comando)

    it('E1: fallo → conteo=LECTURA_FALLIDA; vacío → conteo=0; tres líneas → conteo=3', () => {
      expect(comandos('E1')).toHaveLength(4)
      for (const c of comandos('E1')) {
        expect(ejecutar(c, 'falla')).toBe('conteo=LECTURA_FALLIDA')
        expect(ejecutar(c, 'vacio')).toBe('conteo=0')
        expect(ejecutar(c, 'tres')).toBe('conteo=3')
      }
    })

    it('A8: fallo → conteo=LECTURA_FALLIDA; log sin la línea → conteo=0; con la línea → conteo=1', () => {
      const [c] = comandos('A8')
      expect(c).toBeDefined()
      expect(ejecutar(c ?? '', 'falla')).toBe('conteo=LECTURA_FALLIDA')
      expect(ejecutar(c ?? '', 'vacio')).toBe('conteo=0')
      expect(ejecutar(c ?? '', 'frase')).toBe('conteo=1')
    })

    it('y el evaluador trata LECTURA_FALLIDA como NO_VERIFICADO, nunca como 0', () => {
      expect(read(PLAN)).toContain('set -o pipefail')
      // Cubierto en «R2-1 · E1 … LECTURA_FALLIDA» (evidencia); aquí solo se confirma que el plan lo indica.
      for (const p of plan().pasos.filter((x) => /conteo=/.test(x.comando))) expect((p as Paso & { esperado: string }).esperado).toContain('nunca 0')
    })
  })

  // ---- R3: A6 de extremo a extremo con un gcloud FALSO (salida simulada → campos → evaluador) ----
  describe('R3 · A6 de extremo a extremo (gcloud FALSO, nunca GCP)', () => {
    const RUNTIME_SA = 'project-os-dashboard-run@project-os-511102.iam.gserviceaccount.com'
    const EVID = path.join(OPS, 'evidencia.mjs')
    const BASE = { version: 1, fecha: '2026-10-12', commit_desplegado: '7f44216bdf85a9832e014f45c27ac643e00ceff9', revision: 'project-os-dashboard-00001-gsk' }
    type Res = { id: string; estado: string; motivo: string }
    const fake = tmp('gcloud-a6-')
    // FAKE_RUTA=1 → versiones como ruta completa; FAKE_KEY → versión fijada (p. ej. latest); FAKE_FALLA_DESCRIBE=1 → error.
    writeFileSync(path.join(fake, 'gcloud'), [
      '#!/bin/sh',
      'case "$1 $2 $3" in',
      '  "secrets get-iam-policy "*) printf "roles/secretmanager.secretAccessor\\tserviceAccount:%s\\n" "$RUNTIME_SA" ;;',
      '  "secrets versions list") if [ -n "$FAKE_RUTA" ]; then printf "projects/project-os-511102/secrets/%s/versions/1\\tENABLED\\n" "$4"; else printf "1\\tENABLED\\n"; fi ;;',
      '  "run services describe")',
      '    if [ -n "$FAKE_FALLA_DESCRIBE" ]; then echo "ERROR: PERMISSION_DENIED" >&2; exit 1; fi',
      '    K="${FAKE_KEY:-1}"',
      '    printf \'{"spec":{"template":{"spec":{"containers":[{"env":[{"name":"NEXTAUTH_URL","value":"VALOR-NO-DEBE-SALIR"},{"name":"NEXTAUTH_SECRET","valueFrom":{"secretKeyRef":{"key":"%s","name":"project-os-nextauth-secret"}}},{"name":"GOOGLE_CLIENT_SECRET","valueFrom":{"secretKeyRef":{"name":"project-os-google-client-secret","key":"1"}}},{"name":"AUTH_ALLOWED_EMAILS","valueFrom":{"secretKeyRef":{"key":"1","name":"project-os-allowed-emails"}}}]}]}}}}\\n\' "$K" ;;',
      '  *) echo "llamada no prevista: $*" >&2; exit 97 ;;',
      'esac',
    ].join('\n'))
    chmodSync(path.join(fake, 'gcloud'), 0o755)
    const ejecutar = (comando: string, extra: Record<string, string> = {}) =>
      spawnSync('bash', ['-c', comando], { encoding: 'utf8', env: { PATH: `${fake}:/usr/bin:/bin`, RUNTIME_SA, ...extra } as unknown as NodeJS.ProcessEnv }).stdout
    const flujo = async (extra: Record<string, string> = {}) => {
      const { observadoA6, evaluar } = (await import(EVID)) as {
        observadoA6: (s: string, o: { iam: string; versiones: string; referencias: string }) => Record<string, unknown>
        evaluar: (e: unknown) => { controles: Res[] }
      }
      const pasos = plan().pasos.filter((p) => p.control === 'A6')
      const referencias = ejecutar(pasos.find((p) => p.comando.includes('python3'))?.comando ?? '', extra)
      const controles = pasos.filter((p) => p.comando.startsWith('gcloud secrets')).map((p) => {
        const [iamCmd, versionesCmd] = p.comando.split(' && ')
        const secreto = /get-iam-policy (\S+)/.exec(p.comando)?.[1] ?? ''
        return { id: 'A6', observado: observadoA6(secreto, { iam: ejecutar(iamCmd ?? '', extra), versiones: ejecutar(versionesCmd ?? '', extra), referencias }) }
      })
      return { referencias, a6: evaluar({ ...BASE, controles }).controles.find((x) => x.id === 'A6') }
    }

    it('configuración correcta → A6 OK; la extracción no imprime valores de variables', async () => {
      const { referencias, a6 } = await flujo()
      expect(referencias.trim().split('\n')).toEqual(['NEXTAUTH_SECRET project-os-nextauth-secret 1', 'GOOGLE_CLIENT_SECRET project-os-google-client-secret 1', 'AUTH_ALLOWED_EMAILS project-os-allowed-emails 1'])
      expect(referencias).not.toContain('VALOR-NO-DEBE-SALIR')
      expect(a6?.estado).toBe('OK')
    })

    it('las versiones como ruta completa de Secret Manager también dan OK', async () => {
      expect((await flujo({ FAKE_RUTA: '1' })).a6?.estado).toBe('OK')
    })

    it('una revisión con la versión latest → FALLO', async () => {
      expect((await flujo({ FAKE_KEY: 'latest' })).a6?.estado).toBe('FALLO')
    })

    it('si la lectura de la revisión falla → LECTURA_FALLIDA y A6 NO_VERIFICADO (nunca OK)', async () => {
      const { referencias, a6 } = await flujo({ FAKE_FALLA_DESCRIBE: '1' })
      expect(referencias.trim()).toBe('LECTURA_FALLIDA')
      expect(a6?.estado).toBe('NO_VERIFICADO')
    })

    it('la lista de lectura solo acepta el fragmento de Python exacto', async () => {
      const { comandosInseguros, EXTRAER_VERSIONES } = (await import(PLAN)) as { comandosInseguros: (p: Paso[]) => string[]; EXTRAER_VERSIONES: string }
      const paso = plan().pasos.find((p) => p.comando.includes('python3')) as Paso
      expect(comandosInseguros([paso])).toEqual([])
      const alterado = paso.comando.replace(EXTRAER_VERSIONES, 'import os; os.system("gcloud run services delete x")')
      expect(comandosInseguros([{ ...paso, comando: alterado }])).toHaveLength(1)
    })
  })

  it('R1-4: A2, A6 y A8 piden todas sus partes; los conteos del log del build no imprimen contenido', () => {
    const { pasos } = plan()
    const de = (c: string) => pasos.filter((p) => p.control === c).map((p) => p.comando).join('\n')
    expect(de('A2')).toContain("grep -A1 'name: NEXTAUTH_URL$'")
    expect(de('A2')).toContain('URI de redireccionamiento autorizados')
    expect(de('A6')).toContain("python3 -c")
    expect(de('A6')).not.toContain('grep -B1')
    // Sin transformaciones de formato (en Cloud Shell, name.basename() dejó la salida vacía): ruta completa + estado.
    expect(de('A6')).toContain("--format='value(name,state)'")
    expect(de('A6')).not.toContain('basename')
    expect(de('A8')).toMatch(/gcloud builds log \S+ .*\| \{ grep -c 'Identidad de compilación verificada' \|\| true; \}\) && echo "conteo=\$n"/m)
    const plantilla = JSON.parse(node(PLAN, ['--plantilla-evidencia', '--control', 'A6']).stdout)
    expect(plantilla.controles).toHaveLength(3)
    for (const c of plantilla.controles) expect(c.observado).toEqual(expect.objectContaining({ version_fijada: '', versiones: null, miembros: null }))
  })

  it('la lista de lectura falla cerrado ante cualquier comando mutante o con redirección', async () => {
    const { comandosInseguros } = (await import(PLAN)) as { comandosInseguros: (p: Paso[]) => string[] }
    const malos = [
      'gcloud artifacts docker tags add IMG@sha256:x IMG:produccion --project=p',
      'gcloud secrets versions access 1 --secret=s --project=p',
      'gcloud run services update s --project=p --max-instances=1',
      'gcloud run services describe s --project=p > /tmp/salida',
      'gcloud run services describe s --project=p && gcloud run services delete s --project=p',
      'curl https://ejemplo.invalid',
      'bash web/deploy/infra/limpieza-artifact-v1-6.sh --apply',
    ]
    for (const comando of malos) expect(comandosInseguros([{ control: 'X', tipo: 'gcloud', comando }]), comando).toHaveLength(1)
    // La envoltura de conteo no blanquea una mutación ni un comando ajeno dentro de ella.
    const { contar } = (await import(PLAN)) as { contar: (t: string) => string }
    for (const interior of ['gcloud run services update s --project=p | wc -l', 'curl https://ejemplo.invalid | wc -l']) {
      expect(comandosInseguros([{ control: 'X', tipo: 'gcloud', comando: contar(interior) }]), interior).toHaveLength(1)
    }
    expect(comandosInseguros(plan().pasos)).toEqual([])
  })

  it('--plantilla-evidencia produce un JSON con el commit desplegado y campos vacíos', () => {
    const t = JSON.parse(node(PLAN, ['--plantilla-evidencia', '--control', 'A9']).stdout)
    expect(t.commit_desplegado).toBe('7f44216bdf85a9832e014f45c27ac643e00ceff9')
    expect(t.controles).toEqual([expect.objectContaining({ id: 'A9', fuente: 'propietario', observado: { digest_produccion: '' } })])
    const a5 = JSON.parse(node(PLAN, ['--plantilla-evidencia', '--control', 'A5']).stdout).controles[0].observado
    // "Ninguno" ([]) solo lo escribe quien lo comprobó: la plantilla usa null para no fabricar un OK.
    expect(a5).toEqual({ cuenta: '', roles_proyecto: null })
  })

  it('uso incorrecto o control desconocido → código 2', () => {
    expect(node(PLAN, ['--ejecutar']).status).toBe(2)
    expect(node(PLAN, ['--control', 'ZZ']).status).toBe(2)
    expect(node(PLAN, ['--control']).status).toBe(2)
  })
})

describe('evidencia saneada: validación y evaluación', () => {
  const EVID = path.join(OPS, 'evidencia.mjs')
  const BASE = { version: 1, fecha: '2026-10-12', commit_desplegado: '7f44216bdf85a9832e014f45c27ac643e00ceff9', revision: 'project-os-dashboard-00001-gsk' }
  const RUNTIME = 'project-os-dashboard-run@project-os-511102.iam.gserviceaccount.com'
  const DIGEST = 'sha256:f6e46596ef36522134096d97431f32036bb71298033f9694023137497d3d5c07'
  const URL = 'https://project-os-dashboard-235975889400.northamerica-south1.run.app'
  const IAM = [`roles/secretmanager.secretAccessor serviceAccount:${RUNTIME}`]
  const SECRETOS = ['project-os-nextauth-secret', 'project-os-google-client-secret', 'project-os-allowed-emails']
  const secretoOK = (secreto: string, extra: Record<string, unknown> = {}) => ({ id: 'A6', observado: { secreto, miembros: IAM, versiones: ['1 ENABLED'], version_fijada: '1', ...extra } })
  const A7_CONFIG = { revision_minScale: '0', revision_maxScale: '1', cpu_throttling: 'true', servicio_maxScale: '1' }
  const E1_OK = (patron: string, extra: Record<string, unknown> = {}) => ({ id: 'E1', observado: { patron, coincidencias: 0, alcance: 'todos-los-campos', ventana_dias: 30, ...extra } })
  type Res = { id: string; estado: string; motivo: string }
  const run = (controles: unknown[], extra: Record<string, unknown> = {}) => {
    const f = path.join(tmp('evidencia-'), 'e.json')
    writeFileSync(f, JSON.stringify({ ...BASE, ...extra, controles }))
    // Las pruebas de reglas evalúan subconjuntos a propósito: --parcial (la cobertura se prueba aparte).
    const r = node(EVID, [f, '--json', '--parcial'])
    const out = r.stdout ? (JSON.parse(r.stdout) as { controles: Res[]; lecturas: Res[] }) : { controles: [], lecturas: [] }
    const por = Object.fromEntries(out.controles.map((x) => [x.id, x.estado]))
    return { ...r, res: out.controles, lecturas: out.lecturas, por }
  }
  const uno = (id: string, observado: Record<string, unknown>) => run([{ id, fuente: 'propietario', observado }])

  it('es offline: no importa child_process ni usa la red', () => {
    expect(read(EVID)).not.toMatch(/child_process|fetch\(|https?:\/\//)
  })

  it('camino feliz con TODAS las partes de cada control compuesto → código 0', () => {
    const r = run([
      { id: 'A1', observado: { imagen: `northamerica-south1-docker.pkg.dev/project-os-511102/project-os/dashboard@${DIGEST}` } },
      { id: 'A2', observado: { urls: `${URL},https://project-os-dashboard-abc123-uc.a.run.app` } },
      { id: 'A2', observado: { nextauth_url: URL } },
      { id: 'A2', observado: { callback_oauth: `${URL}/api/auth/callback/google` } },
      ...SECRETOS.map((s) => secretoOK(s)),
      { id: 'A7', observado: A7_CONFIG },
      { id: 'A7', observado: { instancias_max_30d: 1 } },
      { id: 'A8', observado: { cuenta_build: 'projects/project-os-511102/serviceAccounts/project-os-build@project-os-511102.iam.gserviceaccount.com' } },
      { id: 'A8', observado: { lineas_identidad_verificada: 1 } },
      { id: 'A9', observado: { digest_produccion: DIGEST } },
      ...['correo', 'token', 'bearer', 'codigo_oauth'].map((p) => E1_OK(p)),
      { id: 'C2', observado: { resultado: 'OK', oauth_elegible: true, capa_rechazo: 'app' } },
    ])
    expect(r.res.map((x) => `${x.id}:${x.estado}`)).toEqual(['A1:OK', 'A2:OK', 'A6:OK', 'A7:OK', 'A8:OK', 'A9:OK', 'E1:OK', 'C2:OK'])
    expect(r.status).toBe(0)
  })

  // ---- R1-1: A6 ----
  it.each([
    ['versiones null', { versiones: null }, 'NO_VERIFICADO'],
    ['versiones []', { versiones: [] }, 'NO_VERIFICADO'],
    ['todas DISABLED', { versiones: ['2 DISABLED', '1 DISABLED'] }, 'FALLO'],
    ['dos ENABLED', { versiones: ['2 ENABLED', '1 ENABLED'] }, 'FALLO'],
    ['versión fijada no observada', { version_fijada: '' }, 'NO_VERIFICADO'],
    ['versión fijada latest', { version_fijada: 'latest' }, 'FALLO'],
    ['versión fijada distinta de la ENABLED', { versiones: ['2 ENABLED', '1 DISABLED'], version_fijada: '1' }, 'FALLO'],
    ['dos lectores', { miembros: [...IAM, 'roles/secretmanager.secretAccessor serviceAccount:otra@project-os-511102.iam.gserviceaccount.com'] }, 'FALLO'],
    ['miembros null', { miembros: null }, 'NO_VERIFICADO'],
  ])('R1-1 · A6 con %s → %s (los otros dos secretos, correctos)', (_n, cambio, esperado) => {
    const r = run([secretoOK(SECRETOS[0] ?? '', cambio), secretoOK(SECRETOS[1] ?? ''), secretoOK(SECRETOS[2] ?? '')])
    expect(r.por.A6).toBe(esperado)
  })

  // ---- R3: IDs de versión como número o ruta completa ----
  it.each([
    ['ruta completa del mismo secreto', { versiones: [`projects/project-os-511102/secrets/${SECRETOS[0]}/versions/1 ENABLED`] }, 'OK'],
    ['ruta completa con tabulador', { versiones: [`projects/project-os-511102/secrets/${SECRETOS[0]}/versions/1\tENABLED`] }, 'OK'],
    ['ruta de OTRO secreto', { versiones: [`projects/project-os-511102/secrets/${SECRETOS[1]}/versions/1 ENABLED`] }, 'NO_VERIFICADO'],
    ['fila ilegible', { versiones: ['versión uno activa'] }, 'NO_VERIFICADO'],
    ['ruta completa, fijada distinta de la ENABLED', { versiones: [`projects/project-os-511102/secrets/${SECRETOS[0]}/versions/2 ENABLED`, `projects/project-os-511102/secrets/${SECRETOS[0]}/versions/1 DESTROYED`] }, 'FALLO'],
  ])('R3 · A6 con %s → %s', (_n, cambio, esperado) => {
    expect(run([secretoOK(SECRETOS[0] ?? '', cambio), secretoOK(SECRETOS[1] ?? ''), secretoOK(SECRETOS[2] ?? '')]).por.A6).toBe(esperado)
  })

  it('R3 · versionId extrae el número solo de rutas del MISMO secreto', async () => {
    const { versionId } = (await import(EVID)) as { versionId: (t: string, s: string) => { id: string | null; otroSecreto: boolean } }
    expect(versionId('1', 'x')).toEqual({ id: '1', otroSecreto: false })
    expect(versionId('projects/p/secrets/x/versions/12', 'x')).toEqual({ id: '12', otroSecreto: false })
    expect(versionId('projects/p/secrets/y/versions/1', 'x')).toEqual({ id: null, otroSecreto: true })
    expect(versionId('latest', 'x')).toEqual({ id: null, otroSecreto: false })
  })

  it('R1-1 · un solo secreto correcto no da A6 completo: faltan los otros dos → NO_VERIFICADO', () => {
    const r = run([secretoOK(SECRETOS[0] ?? '')])
    expect(r.lecturas[0]?.estado).toBe('OK')
    expect(r.por.A6).toBe('NO_VERIFICADO')
    expect(r.res[0]?.motivo).toMatch(/faltan secretos/)
    expect(r.status).toBe(3)
  })

  // ---- R1-2: A7 ----
  it.each([
    ['solo la métrica (1)', [{ instancias_max_30d: 1 }], 'NO_VERIFICADO'],
    ['revisión 3 + métrica 1', [{ ...A7_CONFIG, revision_maxScale: '3', instancias_max_30d: 1 }], 'FALLO'],
    ['servicio 3 + métrica 1', [{ ...A7_CONFIG, servicio_maxScale: '3', instancias_max_30d: 1 }], 'NO_VERIFICADO'],
    ['servicio 3, en lecturas separadas', [{ ...A7_CONFIG, servicio_maxScale: '3' }, { instancias_max_30d: 1 }], 'NO_VERIFICADO'],
    ['servicio no anotado', [{ ...A7_CONFIG, servicio_maxScale: '' }], 'NO_VERIFICADO'],
    ['configuración correcta + métrica 2', [A7_CONFIG, { instancias_max_30d: 2 }], 'FALLO'],
    ['sin cpu-throttling', [{ ...A7_CONFIG, cpu_throttling: 'false' }], 'FALLO'],
    ['configuración correcta sin métrica', [A7_CONFIG], 'OK'],
  ])('R1-2 · A7 %s → %s', (_n, partes, esperado) => {
    expect(run(partes.map((observado) => ({ id: 'A7', observado }))).por.A7).toBe(esperado)
  })

  // ---- R1-3: E1 ----
  it.each([
    ['un único patrón con conteo 0', [E1_OK('correo')], 'NO_VERIFICADO'],
    ['4 patrones, pero solo textPayload', ['correo', 'token', 'bearer', 'codigo_oauth'].map((p) => E1_OK(p, { alcance: 'textPayload' })), 'NO_VERIFICADO'],
    ['4 patrones, pero 7 días', ['correo', 'token', 'bearer', 'codigo_oauth'].map((p) => E1_OK(p, { ventana_dias: 7 })), 'NO_VERIFICADO'],
    ['4 patrones sin alcance declarado', ['correo', 'token', 'bearer', 'codigo_oauth'].map((p) => ({ id: 'E1', observado: { patron: p, coincidencias: 0 } })), 'NO_VERIFICADO'],
    ['una coincidencia aunque el alcance sea parcial', [E1_OK('token', { coincidencias: 2, alcance: 'textPayload' })], 'FALLO'],
    ['4 patrones, todos los campos, 30 días', ['correo', 'token', 'bearer', 'codigo_oauth'].map((p) => E1_OK(p)), 'OK'],
  ])('R1-3 · E1 %s → %s', (_n, entradas, esperado) => {
    expect(run(entradas).por.E1).toBe(esperado)
  })

  // ---- R1-4: A2, A8 y G2 ----
  it.each([
    ['A2 solo con la URL publicada', 'A2', [{ urls: [URL] }], 'NO_VERIFICADO'],
    ['A2 URL publicada + NEXTAUTH_URL, sin callback', 'A2', [{ urls: [URL] }, { nextauth_url: URL }], 'NO_VERIFICADO'],
    ['A2 con callback distinto', 'A2', [{ urls: [URL] }, { nextauth_url: URL }, { callback_oauth: 'https://otra.example.com/api/auth/callback/google' }], 'FALLO'],
    ['A2 sin la URL estable entre las publicadas', 'A2', [{ urls: ['https://project-os-dashboard-abc123-uc.a.run.app'] }], 'FALLO'],
    ['A8 solo con la cuenta', 'A8', [{ cuenta_build: 'projects/project-os-511102/serviceAccounts/project-os-build@project-os-511102.iam.gserviceaccount.com' }], 'NO_VERIFICADO'],
    ['A8 con la línea de identidad ausente', 'A8', [{ cuenta_build: 'project-os-build@project-os-511102.iam.gserviceaccount.com', lineas_identidad_verificada: 0 }], 'FALLO'],
    ['A8 con otra cuenta', 'A8', [{ cuenta_build: 'projects/project-os-511102/serviceAccounts/123-compute@developer.gserviceaccount.com', lineas_identidad_verificada: 1 }], 'FALLO'],
    ['G2 con 2 revisiones y nada más', 'G2', [{ revisiones: ['project-os-dashboard-00001-gsk', 'project-os-dashboard-00002-abc'] }], 'NO_VERIFICADO'],
    ['G2 con imagen anterior disponible, sin ensayo', 'G2', [{ revisiones: ['project-os-dashboard-00001-gsk', 'project-os-dashboard-00002-abc'], imagen_anterior_digest: DIGEST }], 'NO_VERIFICADO'],
    ['G2 con imagen anterior borrada', 'G2', [{ revisiones: ['project-os-dashboard-00001-gsk', 'project-os-dashboard-00002-abc'], imagen_anterior_digest: 'NOT_FOUND' }], 'FALLO'],
    ['G2 con una sola revisión', 'G2', [{ revisiones: ['project-os-dashboard-00001-gsk'] }], 'NO_VERIFICADO'],
    ['G2 con ensayo autorizado OK', 'G2', [{ revisiones: ['project-os-dashboard-00001-gsk', 'project-os-dashboard-00002-abc'], imagen_anterior_digest: DIGEST, ensayo_rollback: 'OK' }], 'OK'],
  ])('R1-4 · %s → %s', (_n, id, partes, esperado) => {
    expect(run(partes.map((observado) => ({ id, observado }))).por[id]).toBe(esperado)
  })

  // ---- R2-1: conteos inválidos nunca son éxito ----
  const INVALIDOS: Array<[string, unknown]> = [['texto', 'NO_DISPONIBLE'], ['LECTURA_FALLIDA', 'LECTURA_FALLIDA'], ['negativo', -1], ['decimal', 0.5], ['decimal en texto', '0.5'], ['infinito', Infinity], ['NaN en texto', 'NaN'], ['booleano', false], ['lista', [0]]]
  it.each(INVALIDOS)('R2-1 · E1: los 4 patrones con coincidencias %s → NO_VERIFICADO y código ≠ 0', (_n, valor) => {
    const r = run(['correo', 'token', 'bearer', 'codigo_oauth'].map((p) => E1_OK(p, { coincidencias: valor })))
    expect(r.por.E1).toBe('NO_VERIFICADO')
    expect(r.status).not.toBe(0)
  })
  it.each(INVALIDOS)('R2-1 · E1: ventana_dias %s → NO_VERIFICADO', (_n, valor) => {
    expect(run(['correo', 'token', 'bearer', 'codigo_oauth'].map((p) => E1_OK(p, { ventana_dias: valor }))).por.E1).toBe('NO_VERIFICADO')
  })
  it.each(INVALIDOS)('R2-1 · A7: configuración correcta + instancias_max_30d %s → NO_VERIFICADO', (_n, valor) => {
    const r = run([{ id: 'A7', observado: { ...A7_CONFIG, instancias_max_30d: valor } }])
    expect(r.por.A7).toBe('NO_VERIFICADO')
    expect(r.status).not.toBe(0)
  })
  it.each(INVALIDOS)('R2-1 · F3: conteos de imágenes %s → NO_VERIFICADO', (_n, valor) => {
    const r = run([{ id: 'F3', observado: { check: 'PERMITIDO', imagenes: valor, mayores_30_dias_no_protegidas: valor } }])
    expect(r.por.F3).toBe('NO_VERIFICADO')
    expect(r.status).not.toBe(0)
  })
  it.each(INVALIDOS)('R2-1 · A8: lineas_identidad_verificada %s → NO_VERIFICADO', (_n, valor) => {
    const r = run([{ id: 'A8', observado: { cuenta_build: 'project-os-build@project-os-511102.iam.gserviceaccount.com', lineas_identidad_verificada: valor } }])
    expect(r.por.A8).toBe('NO_VERIFICADO')
  })
  it('R2-1 · los enteros válidos se aceptan como número o texto ("0", " 3 "); F3 incoherente → NO_VERIFICADO', async () => {
    const { conteo } = (await import(EVID)) as { conteo: (v: unknown) => number | null }
    expect([conteo(0), conteo('0'), conteo(' 3 '), conteo(12)]).toEqual([0, 0, 3, 12])
    expect(run([{ id: 'F3', observado: { imagenes: 5, mayores_30_dias_no_protegidas: 6 } }]).por.F3).toBe('NO_VERIFICADO')
    expect(run(['correo', 'token', 'bearer', 'codigo_oauth'].map((p) => E1_OK(p, { coincidencias: '0', ventana_dias: '30' }))).por.E1).toBe('OK')
  })

  it('dos lecturas contradictorias del mismo campo → NO_VERIFICADO, nunca la última gana', () => {
    expect(run([{ id: 'A9', observado: { digest_produccion: DIGEST } }, { id: 'A9', observado: { digest_produccion: 'NOT_FOUND' } }]).por.A9).toBe('NO_VERIFICADO')
  })

  it.each([
    ['A9 etiqueta ausente', 'A9', { digest_produccion: 'ERROR: NOT_FOUND' }, 'FALLO'],
    ['A9 otro digest', 'A9', { digest_produccion: `sha256:${'0'.repeat(64)}` }, 'FALLO'],
    ['A9 sin dato', 'A9', { digest_produccion: '' }, 'NO_VERIFICADO'],
    ['A9 permiso denegado', 'A9', { error: 'PERMISSION_DENIED' }, 'NO_VERIFICADO'],
    ['A1 imagen por etiqueta', 'A1', { imagen: 'northamerica-south1-docker.pkg.dev/project-os-511102/project-os/dashboard:7f44216' }, 'FALLO'],
    ['A4 variable de escritura', 'A4', { variables: ['NEXTAUTH_URL', 'PROJECT_OS_WRITE_MODE'] }, 'FALLO'],
    ['A5 runtime con roles', 'A5', { cuenta: RUNTIME, roles_proyecto: ['roles/editor'] }, 'FALLO'],
    ['A5 otra cuenta', 'A5', { cuenta: 'otra@project-os-511102.iam.gserviceaccount.com', roles_proyecto: [] }, 'FALLO'],
    ['F3 bloqueada', 'F3', { check: 'BLOQUEADO' }, 'FALLO'],
    ['F3 pocas imágenes', 'F3', { imagenes: 2, mayores_30_dias_no_protegidas: 0 }, 'NO_VERIFICADO'],
    ['F3 PERMITIDO pero imágenes no protegidas', 'F3', { check: 'PERMITIDO', imagenes: 6, mayores_30_dias_no_protegidas: 1 }, 'FALLO'],
    ['humano sin resultado', 'D1', { resultado: '' }, 'NO_VERIFICADO'],
    ['humano FALLO', 'C2', { resultado: 'fallo' }, 'FALLO'],
    ['A5 roles vacíos como texto', 'A5', { cuenta: RUNTIME, roles_proyecto: '' }, 'NO_VERIFICADO'],
    ['control sin regla', 'H', { algo: 1 }, 'NO_VERIFICADO'],
  ])('%s → %s', (_n, id, observado, esperado) => {
    const r = uno(id, observado)
    expect(r.por[id]).toBe(esperado)
    expect(r.status).toBe(esperado === 'FALLO' ? 1 : esperado === 'OK' ? 0 : 3)
  })

  // ---- R4-1: C2 solo con la capa de la app y una cuenta elegible ----
  it.each([
    ['solo resultado OK', { resultado: 'OK' }],
    ['rechazo de Google', { resultado: 'OK', oauth_elegible: true, capa_rechazo: 'google' }],
    ['cuenta no elegible', { resultado: 'OK', oauth_elegible: false, capa_rechazo: 'app' }],
    ['elegibilidad desconocida', { resultado: 'OK', oauth_elegible: null, capa_rechazo: 'app' }],
    ['elegibilidad como texto', { resultado: 'OK', oauth_elegible: 'true', capa_rechazo: 'app' }],
    ['AccessDenied sin capa', { resultado: 'OK', oauth_elegible: true, nota: 'AccessDenied' }],
    ['capa vacía', { resultado: 'OK', oauth_elegible: true, capa_rechazo: '' }],
  ])('R4-1 · C2 con %s → NO_VERIFICADO, nunca OK', (_n, observado) => {
    const r = uno('C2', observado)
    expect(r.por.C2).toBe('NO_VERIFICADO')
    expect(r.status).toBe(3)
  })

  it('R4-1 · C2 OK solo con una cuenta elegible rechazada por la app; FALLO si vio datos', () => {
    expect(uno('C2', { resultado: 'OK', oauth_elegible: true, capa_rechazo: 'app' })).toMatchObject({ por: { C2: 'OK' }, status: 0 })
    expect(uno('C2', { resultado: 'FALLO', oauth_elegible: true, capa_rechazo: 'app' })).toMatchObject({ por: { C2: 'FALLO' }, status: 1 })
  })

  it('evidencia de otro commit desplegado → FALLO y no se evalúa nada más', () => {
    const r = run([{ id: 'A9', observado: { digest_produccion: DIGEST } }], { commit_desplegado: 'a'.repeat(40) })
    expect(r.res).toEqual([expect.objectContaining({ id: 'VER', estado: 'FALLO' })])
    expect(r.status).toBe(1)
  })

  it.each([
    ['correo de persona', { resultado: 'OK', nota: 'probado por persona.ficticia@correo-falso.test' }],
    ['token', { error: `ya29.${'b'.repeat(40)}` }],
    ['cabecera Bearer', { nota: 'Authorization: Bearer abcdefghijklmnop' }],
    ['ID de facturación', { nota: '0A1B2C-3D4E5F-6A7B8C' }],
    ['valor de variable', { variables: ['AUTH_ALLOWED_EMAILS=alguien'] }],
    ['contenido de log', { linea: { textPayload: 'x' } }],
    ['clave privada', { nota: '-----BEGIN PRIVATE KEY-----' }],
    ['JWT', { nota: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc' }],
  ])('rechaza (código 4) evidencia con %s y no imprime el valor', (_n, observado) => {
    const f = path.join(tmp('evidencia-'), 'e.json')
    writeFileSync(f, JSON.stringify({ ...BASE, controles: [{ id: 'C2', observado }] }))
    const r = node(EVID, [f])
    expect(r.status).toBe(4)
    expect(r.stderr).toContain('EVIDENCIA RECHAZADA')
    for (const v of Object.values(observado)) {
      if (typeof v === 'string') expect(r.stdout + r.stderr).not.toContain(v)
    }
    expect(r.stdout + r.stderr).not.toMatch(/persona\.ficticia|ya29\.b|abcdefghijklmnop|0A1B2C/)
  })

  it('una plantilla rellenada a medias no produce un OK falso (null ≠ "ninguno")', () => {
    expect(uno('A5', { cuenta: RUNTIME, roles_proyecto: null }).por.A5).toBe('NO_VERIFICADO')
    expect(uno('A4', { variables: [] }).por.A4).toBe('NO_VERIFICADO')
  })

  it('acepta cuentas de servicio del proyecto y correos de example.com', () => {
    expect(uno('A5', { cuenta: RUNTIME, roles_proyecto: [], nota: 'contacto@example.com' }).status).toBe(0)
  })

  it('formato inválido o archivo ilegible → rechazo o uso incorrecto, nunca OK', () => {
    expect(run([], {}).status).toBe(4)
    expect(run([{ id: 'A9', observado: {} }], { fecha: 'ayer' }).status).toBe(4)
    expect(node(EVID, [path.join(tmpdir(), 'no-existe.json')]).status).toBe(2)
    expect(node(EVID, []).status).toBe(2)
  })

  it('la plantilla del plan de inspección pasa el saneamiento; con la fecha rellenada, todos los controles son NO_VERIFICADO (código 3)', () => {
    const plantilla = JSON.parse(node(path.join(OPS, 'plan-inspeccion.mjs'), ['--plantilla-evidencia']).stdout)
    plantilla.fecha = '2026-10-12'
    const f = path.join(tmp('evidencia-'), 'p.json')
    writeFileSync(f, JSON.stringify(plantilla))
    const r = node(EVID, [f, '--json'])
    expect(r.status).toBe(3)
    const res = JSON.parse(r.stdout).controles as Res[]
    expect(res.map((x) => x.id).sort()).toEqual(['A1', 'A2', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'E1', 'F3', 'G2'])
    expect(res.every((x) => x.estado === 'NO_VERIFICADO')).toBe(true)
  })

  it('el ejemplo del repositorio es sintético, se declara así y no se cita como evidencia en la matriz', () => {
    const ejemplo = path.join(DOCS, 'evidencia-ejemplo.json')
    const e = JSON.parse(read(ejemplo))
    expect(e.ejemplo_sintetico).toBe(true)
    expect(e.fecha).toBe('2000-01-01')
    const r = node(EVID, [ejemplo])
    expect(r.stdout).toContain('EJEMPLO SINTÉTICO')
    expect(r.stdout).toContain('NO cuentan por el límite')
    expect(r.status).toBe(3)
    // Los controles agregados (los que deciden) no tienen ningún OK.
    expect(r.stdout.slice(r.stdout.indexOf('Controles (peor'))).not.toMatch(/^\s+OK /m)
    expect(read(path.join(DOCS, 'matriz-aceptacion.md'))).not.toContain('evidencia-ejemplo')
  })

  // ---- Misión 014 (D.2 y C): la evidencia falla cerrado ----
  const COMPLETA = [
    { id: 'A1', observado: { imagen: `northamerica-south1-docker.pkg.dev/project-os-511102/project-os/dashboard@${DIGEST}` } },
    { id: 'A2', observado: { urls: [URL], nextauth_url: URL, callback_oauth: `${URL}/api/auth/callback/google` } },
    { id: 'A4', observado: { variables: ['NEXTAUTH_URL', 'SHEETS_CREDENTIALS'] } },
    { id: 'A5', observado: { cuenta: RUNTIME, roles_proyecto: [] } },
    ...SECRETOS.map((x) => secretoOK(x)),
    { id: 'A7', observado: A7_CONFIG },
    { id: 'A8', observado: { cuenta_build: 'project-os-build@project-os-511102.iam.gserviceaccount.com', lineas_identidad_verificada: 1 } },
    { id: 'A9', observado: { digest_produccion: DIGEST } },
    ...['correo', 'token', 'bearer', 'codigo_oauth'].map((x) => E1_OK(x)),
    { id: 'F3', observado: { check: 'PERMITIDO', imagenes: 6, mayores_30_dias_no_protegidas: 0 } },
    { id: 'G2', observado: { revisiones: ['project-os-dashboard-00001-gsk', 'project-os-dashboard-00002-abc'], imagen_anterior_digest: DIGEST, ensayo_rollback: 'OK' } },
  ]
  const evaluarArchivo = (contenido: unknown, ...flags: string[]) => {
    const f = path.join(tmp('evidencia-'), 'e.json')
    writeFileSync(f, JSON.stringify(contenido))
    const r = node(EVID, [f, '--json', ...flags])
    const out = r.stdout ? (JSON.parse(r.stdout) as { controles: Res[]; cobertura: { completa: boolean; faltan: string[] }; limite: string | null }) : null
    return { ...r, out, por: Object.fromEntries((out?.controles ?? []).map((x) => [x.id, x.estado])) }
  }

  it('M14 · CONTROLES_LECTURA coincide con los controles del plan de inspección', async () => {
    const { CONTROLES_LECTURA } = (await import(path.join(OPS, 'produccion-v1-6.mjs'))) as { CONTROLES_LECTURA: string[] }
    const pasos = JSON.parse(node(path.join(OPS, 'plan-inspeccion.mjs'), ['--json']).stdout).pasos as Array<{ control: string }>
    expect([...CONTROLES_LECTURA].sort()).toEqual([...new Set(pasos.map((p) => p.control))].sort())
  })

  it.each([
    ['fecha futura', { fecha: '2099-01-01' }],
    ['fecha ilegible', { fecha: 'ayer' }],
    ['sintético como texto', { ejemplo_sintetico: 'true' }],
    ['sintético como 1', { ejemplo_sintetico: 1 }],
  ])('revisión final · %s → ningún OK', (_n, cambio) => {
    const r = evaluarArchivo({ ...BASE, ...cambio, controles: COMPLETA })
    expect(r.status).not.toBe(0)
    expect(Object.values(r.por)).not.toContain('OK')
  })

  it('M14 · evidencia completa y correcta (con condiciones que hoy no existen: 2 revisiones, ensayo, 6 imágenes) → 0', () => {
    const r = evaluarArchivo({ ...BASE, controles: COMPLETA })
    expect(r.status, r.stdout).toBe(0)
    expect(r.out?.cobertura.completa).toBe(true)
  })

  it('M14 · sin TODOS los controles del plan nunca hay «todo OK» (cobertura); --parcial evalúa un subconjunto a propósito', () => {
    const solo = { ...BASE, controles: [{ id: 'A9', observado: { digest_produccion: DIGEST } }] }
    const r = evaluarArchivo(solo)
    expect(r.status).toBe(3)
    expect(r.por.A9).toBe('OK')
    expect(r.por.COB).toBe('NO_VERIFICADO')
    expect(r.out?.cobertura.faltan).toContain('A1')
    expect(evaluarArchivo(solo, '--parcial').status).toBe(0)
  })

  it('M14 · un ejemplo sintético nunca aprueba nada, aunque sus valores sean perfectos', () => {
    const r = evaluarArchivo({ ...BASE, ejemplo_sintetico: true, controles: COMPLETA })
    expect(r.status).toBe(3)
    expect(Object.entries(r.por).filter(([, e]) => e === 'OK')).toEqual([])
    expect(r.out?.limite).toMatch(/ejemplo sintético/)
  })

  it('M14 · una fecha anterior al despliegue (2026-10-11) no describe esta versión → ningún OK ni FALLO', () => {
    const r = evaluarArchivo({ ...BASE, fecha: '2026-10-10', controles: [...COMPLETA, { id: 'A9', observado: { digest_produccion: 'NOT_FOUND' } }] })
    expect(r.status).toBe(3)
    expect(Object.values(r.por).every((e) => e === 'NO_VERIFICADO')).toBe(true)
  })

  it.each([
    ['otra revisión', { revision: 'project-os-dashboard-00002-abc' }],
    ['revisión sin declarar', { revision: undefined }],
  ])('M14 · %s → requiere nueva validación: ningún OK; los FALLO se mantienen', (_n, extra) => {
    const r = evaluarArchivo({ ...BASE, ...extra, controles: [...COMPLETA.filter((c) => c.id !== 'A9'), { id: 'A9', observado: { digest_produccion: 'NOT_FOUND' } }] })
    expect(r.status).toBe(1)
    expect(r.por.A9).toBe('FALLO')
    expect(r.por.VER).toBe('NO_VERIFICADO')
    expect(Object.entries(r.por).filter(([, e]) => e === 'OK')).toEqual([])
  })

  it('M14 · la revisión sirve otro digest (A1 FALLO) → la línea base cambió: ningún otro control queda en OK', () => {
    const r = evaluarArchivo({ ...BASE, controles: [...COMPLETA.filter((c) => c.id !== 'A1'), { id: 'A1', observado: { imagen: `northamerica-south1-docker.pkg.dev/project-os-511102/project-os/dashboard@sha256:${'1'.repeat(64)}` } }] })
    expect(r.status).toBe(1)
    expect(r.por.A1).toBe('FALLO')
    expect(r.out?.limite).toMatch(/otro digest/)
    expect(Object.entries(r.por).filter(([, e]) => e === 'OK')).toEqual([])
  })

  it('M14 · F3 solo con --check (sin el conteo de imágenes) no se aprueba: falta el efecto real', () => {
    expect(uno('F3', { check: 'PERMITIDO' }).por.F3).toBe('NO_VERIFICADO')
  })

  it.each([
    ['URL con code= y state=', { nota: `${URL}/api/auth/callback/google?code=CODIGO-FALSO-123&state=xyz` }, 'CODIGO-FALSO-123'],
    ['parámetro token= suelto', { nota: 'callback &token=VALOR-FALSO-123' }, 'VALOR-FALSO-123'],
    ['código de autorización OAuth', { nota: `4/0A${'c'.repeat(40)}` }, `4/0A${'c'.repeat(40)}`],
    ['refresh token', { nota: `1//0${'d'.repeat(40)}` }, `1//0${'d'.repeat(40)}`],
    ['token de GitHub', { nota: `ghp_${'e'.repeat(36)}` }, `ghp_${'e'.repeat(36)}`],
    ['ID de cliente OAuth', { nota: `123456789012-${'f'.repeat(32)}.apps.googleusercontent.com` }, `123456789012-${'f'.repeat(32)}`],
    ['cookie de sesión', { nota: '__Secure-next-auth.session-token=VALOR-COOKIE' }, 'VALOR-COOKIE'],
    ['enlace a la hoja', { nota: 'https://docs.google.com/spreadsheets/d/ID-FALSO-DE-HOJA/edit' }, 'ID-FALSO-DE-HOJA'],
    ['dirección IP', { nota: 'visto desde 203.0.113.77' }, '203.0.113.77'],
    ['campo con nombre de secreto', { token: 'valor-inocuo-xyz' }, 'valor-inocuo-xyz'],
    ['clave que es un correo, con un valor sensible', { 'persona.fuga@correo-falso.test': `ya29.${'g'.repeat(30)}` }, 'persona.fuga'],
    ['línea de log con insertId', { linea: { insertId: 'abc123', severity: 'WARNING' } }, 'abc123'],
  ])('M14 · rechaza (código 4) evidencia con %s y nunca imprime el valor', (_n, observado, valor) => {
    const f = path.join(tmp('evidencia-'), 'e.json')
    writeFileSync(f, JSON.stringify({ ...BASE, controles: [{ id: 'C2', observado }] }))
    const r = node(EVID, [f])
    expect(r.status).toBe(4)
    expect(r.stdout + r.stderr).not.toContain(valor)
  })

  it('M14 · la evaluación nunca repite texto libre: ids, patrones y valores desconocidos se muestran como marcadores', () => {
    const r = evaluarArchivo({ ...BASE, controles: [
      { id: 'Control de Juan Pérez', observado: { resultado: 'OK' } },
      { id: 'E1', observado: { patron: 'Juan Pérez', coincidencias: 0, alcance: 'todos-los-campos', ventana_dias: 30 } },
      { id: 'A7', observado: { ...A7_CONFIG, servicio_maxScale: 'Juan Pérez' } },
    ] }, '--parcial')
    expect(r.stdout).not.toContain('Juan')
    expect(r.por['??']).toBe('NO_VERIFICADO')
    expect(r.por.E1).toBe('NO_VERIFICADO')
    expect(r.por.A7).toBe('NO_VERIFICADO')
  })
})

describe('documentos de operación (Entregas B y C)', () => {
  const doc = (n: string) => read(path.join(DOCS, n))

  it('R3-2 · la hoja separa las dos capas de C2: un rechazo de Google es NO_VERIFICADO, solo el rechazo de la app es OK', () => {
    const fila = doc('hoja-propietario.md').split('\n').find((l) => l.startsWith('| 1.3 · C2')) ?? ''
    expect(fila).toMatch(/elegible/)
    expect(fila).toMatch(/Google rechaza la cuenta[^|]*NO_VERIFICADO/)
    expect(fila).toMatch(/vuelves a la app en `\/login`[^|]*`OK`/)
    expect(fila).toMatch(/sin saber qué capa rechazó \*\*no\*\* es OK/)
    expect(fila).toMatch(/`C2: OK \/ FALLO \/ NO_VERIFICADO`/)
    expect(fila).toMatch(/\*\*No\*\* añadas usuarios de prueba/)
    expect(doc('matriz-aceptacion.md').split('\n').find((l) => l.startsWith('| C2 |'))).toMatch(/elegible[\s\S]*rechazo de la app/)
    expect(doc('acta-cierre-v1-6.md')).toMatch(/^\| C2 \| \*\*De capa\*\*/m)
  })

  it('R3-1 · la guía del colector y el riesgo X-8 distinguen la CI de los PR (hoja en memoria) del workflow manual con opción', () => {
    const guia = read(path.join(ROOT, 'docs', 'sheets-sync-setup.md'))
    expect(guia).toMatch(/\*\*nunca\*\* recibe `PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_JSON`/)
    expect(guia).toMatch(/hoja \*\*en memoria\*\*/)
    expect(guia).toMatch(/requiere autorización explícita del propietario/)
    expect(guia).toMatch(/\*\*de solo lectura\*\*/)
    const x8 = doc('linea-base-v1-6.md').split('\n').find((l) => l.startsWith('| X-8 |')) ?? ''
    expect(x8).toMatch(/manual-github-evidence\.yml/)
    expect(x8).toMatch(/ya \*\*no\*\* recibe esa clave/)
    expect(x8).toMatch(/P12 da \*\*FALLO\*\*/)
  })

  it('el índice enlaza todos los documentos de la carpeta', () => {
    const indice = doc('README.md')
    for (const n of ['matriz-aceptacion.md', 'auditoria-seguridad.md', 'runbook-operativo.md', 'evidencia.md', 'mantenimiento-dependencias.md', 'backlog-v1-7.md', 'hoja-propietario.md', 'remediacion-2026-10-11.md', 'linea-base-v1-6.md', 'acta-cierre-v1-6.md', 'propuesta-arquitectura-v1-7.md']) {
      expect(indice, n).toContain(`(${n})`)
    }
  })

  it('M14 · la hoja del propietario: 5 bloques ordenados, 6 columnas, solo lecturas y respuestas OK / FALLO / NO_VERIFICADO', () => {
    const hoja = doc('hoja-propietario.md')
    expect([...hoja.matchAll(/^## Bloque (\d)\./gm)].map((m) => Number(m[1]))).toEqual([1, 2, 3, 4, 5])
    const cabecera = '| Control | Dónde entrar | Acción | Resultado correcto | Qué reportar | Qué hacer si falla |'
    expect(hoja.split(cabecera).length - 1).toBe(5)
    const filas = [...hoja.matchAll(/^\| (\d)\.(\d) · ([A-Z]\d)/gm)].map((m) => `${m[1]}.${m[2]}`)
    expect(filas).toEqual(['1.1', '1.2', '1.3', '2.1', '2.2', '2.3', '2.4', '2.5', '2.6', '2.7', '3.1', '3.2', '4.1', '4.2', '4.3', '5.1', '5.2', '5.3', '5.4', '5.5'])
    for (const l of hoja.split('\n').filter((x) => /^\| \d\.\d · /.test(x))) expect(l.split('|').slice(1, -1), l.slice(0, 30)).toHaveLength(6)
    // Los controles humanos que la misión exige, en la hoja.
    for (const c of ['A2', 'C1', 'C2', 'C4', 'C5', 'C6', 'C7', 'D1', 'D2', 'F1', 'F2', 'A7', 'E1', 'E2', 'A6', 'G3']) expect(hoja, c).toContain(`· ${c} `)
    expect(hoja).toContain('OK / FALLO / NO_VERIFICADO')
    expect(hoja).toMatch(/70 minutos/)
    expect(hoja).toMatch(/Nunca compartas/)
    // Nunca pide pruebas que ya están en la CI ni comandos que cambien producción.
    expect(hoja).not.toMatch(/npm (test|run (lint|typecheck|build|test:e2e))/)
    expect(hoja).not.toMatch(/tags add|services update|add-iam-policy-binding|versions (access|destroy|disable)|--apply|sinks update|deshabilitar-sobrantes|destruir-version|alinear-max-servicio|excluir-callback-en-logs/)
    // La plantilla de entrega no tiene campos para correos, cuentas, IDs ni cifras de la hoja.
    const entrega = hoja.slice(hoja.indexOf('## Cómo entregar el resultado'), hoja.indexOf('## Decisiones que solo tú'))
    expect(entrega).not.toMatch(/correo|@|ID de|valor/i)
  })

  it('el runbook distingue instrucción de ejecución y marca las mutaciones', () => {
    const rb = doc('runbook-operativo.md')
    expect(rb).toMatch(/Instrucción no es ejecución/)
    expect((rb.match(/\[M\]/g) ?? []).length).toBeGreaterThanOrEqual(10)
    for (const t of ['401 inesperado', '403 de un usuario permitido', 'Callback OAuth', 'Lectura de Sheets 503', 'Fallo de sonda', 'Costo inesperado', 'Posible exposición de datos', 'Bloqueo de acceso', 'Errores 5xx del dashboard', 'Pérdida de acceso a la aplicación']) expect(rb, t).toContain(t)
    // M14 · el mapa de incidentes cubre las 10 situaciones exigidas, y cada una apunta a una fila o sección existente.
    const mapa = rb.slice(rb.indexOf('### 7.1 Mapa de incidentes'), rb.indexOf('## 8.'))
    expect(mapa.split('\n').filter((l) => /^\| [A-ZÁÉÍÓÚ]/.test(l) && !l.startsWith('| Situación'))).toHaveLength(10)
    // Cada referencia «…» del mapa existe también fuera del mapa (la fila o la sección que describe el procedimiento).
    for (const [, ref] of mapa.matchAll(/«([^»]+)»/g)) expect(rb.split(ref ?? '').length - 1, ref).toBeGreaterThanOrEqual(2)
    expect(rb).toMatch(/una sola revisión/i)
    expect(rb).toMatch(/alerta, no un límite/)
  })

  it('el backlog V1.7 son hipótesis no aprobadas y separa lo que exige autorización', () => {
    const b = doc('backlog-v1-7.md')
    expect(b).toMatch(/hipótesis, \*\*no aprobadas\*\*/)
    for (const s of ['Quick wins', 'Mejoras arquitectónicas', 'exigen autorización explícita']) expect(b).toContain(s)
    expect(b).toMatch(/X6 \| \*\*Escritura real en Sheets\*\*/)
  })

  it('M14 · la propuesta V1.7 no está aprobada, está separada del acta y cubre lo que la misión exige', () => {
    const v17 = doc('propuesta-arquitectura-v1-7.md')
    expect(v17).toMatch(/NO APROBADA/)
    expect(v17).toMatch(/separada\*\* del \[acta de cierre de la V1\.6\]/)
    for (const concepto of ['fuente operativa', 'IDs estables', 'validación del esquema', 'GitHub ↔ tareas', 'Auditoría', 'Idempotencia', 'concurrencia', 'Aprobación humana', 'Hechos ≠ inferencias ≠ propuestas', 'Reversión', 'Permisos mínimos', 'Fallas parciales']) {
      expect(v17.toLowerCase(), concepto).toContain(concepto.toLowerCase())
    }
    expect(v17).toMatch(/No crea workflows, `schedule`/)
    // El acta no aprueba la V1.7 ni la incluye en su alcance.
    expect(doc('acta-cierre-v1-6.md')).toMatch(/no aprueba ninguna funcionalidad de la V1\.7/)
  })

  it('M14 · la línea base: identidad completa, registro EV-01…EV-14 fechado y las condiciones de reapertura', async () => {
    const base = doc('linea-base-v1-6.md')
    const { PRODUCCION } = (await import(path.join(OPS, 'produccion-v1-6.mjs'))) as { PRODUCCION: Record<string, string> }
    for (const v of [PRODUCCION.commit, PRODUCCION.digest, PRODUCCION.revision, PRODUCCION.url]) expect(base).toContain(v)
    const ev = [...base.matchAll(/^\| (EV-\d{2}) \| (\d{4}-\d{2}-\d{2}) \|.*\| (P|R) \| [^|]+ \|$/gm)]
    expect(ev.map((m) => m[1])).toEqual(Array.from({ length: 15 }, (_, i) => `EV-${String(i + 1).padStart(2, '0')}`))
    expect(ev.map((m) => m[2])).toEqual([...Array(12).fill('2026-10-11'), '2026-10-12', '2026-10-12', '2026-10-12'])
    expect([...base.matchAll(/^\| (\d{1,2}) \| /gm)].map((m) => Number(m[1]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect((base.slice(base.indexOf('## 7.'), base.indexOf('## 8.')).match(/^\d+\. \*\*/gm) ?? []).length).toBeGreaterThanOrEqual(10)
    expect(base).not.toContain('evidencia-ejemplo.json)**')
    expect(base).toMatch(/no verifica recursos nuevos/)
  })

  it('M14 · el acta no contiene una aprobación ficticia: estado y firma son del propietario; decisiones con fecha y referencia', async () => {
    const acta = doc('acta-cierre-v1-6.md')
    const { PRODUCCION } = (await import(path.join(OPS, 'produccion-v1-6.mjs'))) as { PRODUCCION: Record<string, string> }
    for (const v of [PRODUCCION.commit, PRODUCCION.digest, PRODUCCION.revision]) expect(acta).toContain(v)
    for (const e of ['LISTA PARA ACEPTACIÓN', 'ESTABLE CON EXCEPCIONES ACEPTADAS', 'ACEPTADA', 'BLOQUEADA']) expect(acta).toContain(`| \`${e}\` |`)
    // El estado lo declaró el propietario (2026-10-12); nunca `ACEPTADA` antes de E1 del 2026-11-11.
    expect(acta).toMatch(/\*\*Estado declarado por el propietario el 2026-10-12: `ESTABLE CON EXCEPCIONES ACEPTADAS`\*\*/)
    expect(acta).not.toMatch(/Estado (propuesto|declarado)[^|\n]*`ACEPTADA`/)
    // Firma y decisiones vacías: nada lo aprueba Claude.
    const aprobacion = acta.slice(acta.indexOf('## 13. Aprobación'))
    const valores = [...aprobacion.matchAll(/^\| [^|]+ \| ([^|]+) \|$/gm)].map((m) => (m[1] ?? '').trim()).filter((v) => v !== 'Valor' && v !== '---')
    expect(valores).toHaveLength(5)
    expect(valores[1]).toBe('`ESTABLE CON EXCEPCIONES ACEPTADAS`')
    expect(valores[2]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    for (const v of valores) expect(v).not.toBe('')
    const excepciones = acta.slice(acta.indexOf('## 8.'), acta.indexOf('## 9.')).split('\n').filter((l) => /^\| (C3|G1|X-2|X-8|E1|F3) \|/.test(l))
    expect(excepciones).toHaveLength(6)
    // Decisiones del propietario (2026-10-12): cada una con la decisión, la fecha y la referencia.
    for (const l of excepciones) {
      const [decision, fecha, referencia] = l.split('|').slice(4, 7).map((c) => c.trim())
      expect(decision, l.slice(0, 12)).toMatch(/^(Aceptar|Rechazar)/)
      expect(fecha, l.slice(0, 12)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(referencia, l.slice(0, 12)).not.toBe('')
    }
    // El resumen del acta es el de la matriz.
    const { resumenCalculado } = (await import(path.join(OPS, 'matriz.mjs'))) as { resumenCalculado: (t: string) => Record<string, string[]> }
    const resumen = resumenCalculado(doc('matriz-aceptacion.md'))
    for (const [estado, ids] of Object.entries(resumen)) expect(acta, estado).toMatch(new RegExp(`\\| ${estado} \\| ${ids.length} \\| ${ids.join(', ')}`))
    // Límites precisos de E1, F3, C3, G1 y G2 (no NO_APLICA como sustituto).
    for (const [id, tipo] of [['E1', 'Temporal'], ['F3', 'Temporal'], ['C3', 'Opcional'], ['G1', 'Opcional, con autorización'], ['G2', 'De aplicabilidad']]) expect(acta).toMatch(new RegExp(`\\| ${id} \\| \\*\\*${tipo}`))
    expect(acta).not.toContain('⟨por completar⟩')
  })

  it('las advertencias centrales de la misión están explícitas', () => {
    const todo = ['matriz-aceptacion.md', 'auditoria-seguridad.md', 'runbook-operativo.md', 'mantenimiento-dependencias.md'].map(doc).join('\n')
    // A9: la advertencia original quedó resuelta y registrada (etiqueta creada por el propietario, C9).
    expect(todo).toMatch(/etiqueta `produccion` (\*\*)?creada/)
    expect(todo).toContain("run.googleapis.com/maxScale: '3'")
    expect(todo).toMatch(/5 alertas altas|Las 5 alertas altas/)
    expect(todo).toMatch(/alerta, no un límite|no es un corte|avisa, no corta/)
    expect(todo).toMatch(/\*\*0\*\* \[registro\]|comparó \*\*0\*\*|0 valores/)
  })
})
