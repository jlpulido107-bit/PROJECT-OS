import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    expect([...src.matchAll(/execFileSync\(\s*'([^']+)'/g)].map((m) => m[1])).toEqual(['git', 'git'])
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
    expect(Object.entries(por).filter(([id]) => id !== 'P14').every(([, e]) => e === 'OK')).toBe(true)
    expect(status).toBe(3)
    expect(out.codigo).toBe(3)
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
    const { por } = estados(fixtureRoot((r) => edit(r, 'docs/estado-produccion-v1-6-2026-10-11.md', (t) => t.replaceAll('f6e46596', '00000000'))))
    expect(por.P13).toBe('FALLO')
  })

  it('uso incorrecto → código 2', () => {
    expect(node(PREFLIGHT, ['--borrar']).status).toBe(2)
    expect(node(PREFLIGHT, ['--root']).status).toBe(2)
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

describe('matriz de aceptación', () => {
  const matriz = read(path.join(DOCS, 'matriz-aceptacion.md'))
  const IDS = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'B1', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'D1', 'D2', 'D3', 'E1', 'E2', 'F1', 'F2', 'F3', 'G1', 'G2', 'G3', 'H']
  const filas = matriz.slice(matriz.indexOf('## 2. Matriz'), matriz.indexOf('**Resumen')).split('\n')
    .filter((l) => /^\| [A-H]\d? \|/.test(l)).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))
  const estado = (f: string[]) => (f[3] ?? '').replace(/\*/g, '').split(/[\s(—]/)[0] ?? ''

  it('una fila por cada control del checklist (A1–H), con 8 columnas', () => {
    expect(filas.map((f) => f[0])).toEqual(IDS)
    for (const f of filas) expect(f, f[0]).toHaveLength(8)
    const checklist = read(path.join(ROOT, 'docs', 'despliegue-v1-6-aceptacion.md'))
    for (const id of IDS.filter((i) => i !== 'H')) expect(checklist, id).toContain(`| ${id} |`)
  })

  it('los estados son del vocabulario y el resumen coincide con la tabla', () => {
    for (const f of filas) expect(['VERIFICADO', 'PARCIAL', 'PENDIENTE', 'NO_APLICA'], f[0]).toContain(estado(f))
    for (const e of ['VERIFICADO', 'PARCIAL', 'PENDIENTE', 'NO_APLICA']) {
      const ids = filas.filter((f) => estado(f) === e).map((f) => f[0])
      const linea = new RegExp(`\\| ${e} \\((\\d+)\\) \\| ([^|]+) \\|`).exec(matriz)
      expect(linea, e).not.toBeNull()
      expect(Number(linea?.[1]), e).toBe(ids.length)
      expect((linea?.[2] ?? '').replace(/\s*\([^)]*\)/g, '').split(',').map((s) => s.trim()), e).toEqual(ids)
    }
  })

  it('VERIFICADO solo con un hecho registrado (H) o código con prueba en CI; nunca solo con reporte o plantilla', () => {
    for (const f of filas.filter((x) => estado(x) === 'VERIFICADO')) expect(f[2], f[0]).toMatch(/\*\*H:\*\*|\*\*O \+ CI:\*\*/)
  })

  it('los controles que la misión exige destacar no figuran como verificados', () => {
    const por = Object.fromEntries(filas.map((f) => [f[0], estado(f)]))
    for (const id of ['A9', 'C2', 'D1', 'D2', 'E1', 'E2', 'F2', 'G1', 'G3']) expect(por[id], id).toBe('PENDIENTE')
    expect(por.C1).toBe('PARCIAL')
    expect(por.G2).toBe('NO_APLICA')
    expect(matriz).toMatch(/run\.googleapis\.com\/maxScale: '3'/)
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
      expect(p.comando).toMatch(/--format='value\(timestamp\)' \| wc -l$/)
      expect(p.comando).not.toMatch(/textPayload\)|jsonPayload\)|--format=json/)
    }
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
  const run = (controles: unknown[], extra: Record<string, unknown> = {}) => {
    const f = path.join(tmp('evidencia-'), 'e.json')
    writeFileSync(f, JSON.stringify({ ...BASE, ...extra, controles }))
    const r = node(EVID, [f, '--json'])
    const out = r.stdout ? (JSON.parse(r.stdout) as { resultados: Array<{ id: string; estado: string; motivo: string }> }) : { resultados: [] }
    return { ...r, res: out.resultados }
  }
  const uno = (id: string, observado: Record<string, unknown>) => run([{ id, fuente: 'propietario', observado }])

  it('es offline: no importa child_process ni usa la red', () => {
    expect(read(EVID)).not.toMatch(/child_process|fetch\(|https?:\/\//)
  })

  it('camino feliz: todo OK → código 0', () => {
    const r = run([
      { id: 'A1', observado: { imagen: `northamerica-south1-docker.pkg.dev/project-os-511102/project-os/dashboard@${DIGEST}` } },
      { id: 'A2', observado: { urls: 'https://project-os-dashboard-235975889400.northamerica-south1.run.app,https://project-os-dashboard-abc123-uc.a.run.app' } },
      { id: 'A9', observado: { digest_produccion: DIGEST } },
      { id: 'A7', observado: { revision_minScale: '0', revision_maxScale: '1', cpu_throttling: 'true', servicio_maxScale: 'ninguno' } },
      { id: 'C2', observado: { resultado: 'OK' } },
    ])
    expect(r.res.map((x) => x.estado)).toEqual(['OK', 'OK', 'OK', 'OK', 'OK'])
    expect(r.status).toBe(0)
  })

  it.each([
    ['etiqueta ausente', { digest_produccion: 'ERROR: NOT_FOUND' }, 'FALLO'],
    ['otro digest', { digest_produccion: `sha256:${'0'.repeat(64)}` }, 'FALLO'],
    ['sin dato', { digest_produccion: '' }, 'NO_VERIFICADO'],
    ['permiso denegado', { error: 'PERMISSION_DENIED' }, 'NO_VERIFICADO'],
  ])('A9 — %s → %s', (_n, observado, esperado) => {
    const r = uno('A9', observado)
    expect(r.res[0]?.estado).toBe(esperado)
    expect(r.status).toBe(esperado === 'FALLO' ? 1 : 3)
  })

  it.each([
    ['servicio 3 frente a revisión 1 (D-1)', { servicio_maxScale: '3' }, 'NO_VERIFICADO'],
    ['servicio no anotado', { servicio_maxScale: '' }, 'NO_VERIFICADO'],
    ['servicio 1', { servicio_maxScale: '1' }, 'OK'],
    ['revisión 3', { revision_maxScale: '3', servicio_maxScale: '1' }, 'FALLO'],
    ['sin cpu-throttling', { cpu_throttling: 'false', servicio_maxScale: '1' }, 'FALLO'],
  ])('A7 — %s → %s (una anomalía de maxScale nunca es OK)', (_n, cambio, esperado) => {
    const r = uno('A7', { revision_minScale: '0', revision_maxScale: '1', cpu_throttling: 'true', ...cambio })
    expect(r.res[0]?.estado).toBe(esperado)
  })

  it('A7 con instancias observadas > 1 → FALLO; ≤ 1 → OK', () => {
    expect(uno('A7', { instancias_max_30d: 2 }).res[0]?.estado).toBe('FALLO')
    expect(uno('A7', { instancias_max_30d: 1 }).res[0]?.estado).toBe('OK')
  })

  it.each([
    ['URL distinta', 'A2', { urls: ['https://project-os-dashboard-abc123-uc.a.run.app'] }, 'FALLO'],
    ['imagen por etiqueta', 'A1', { imagen: 'northamerica-south1-docker.pkg.dev/project-os-511102/project-os/dashboard:7f44216' }, 'FALLO'],
    ['variable de escritura', 'A4', { variables: ['NEXTAUTH_URL', 'PROJECT_OS_WRITE_MODE'] }, 'FALLO'],
    ['runtime con roles', 'A5', { cuenta: RUNTIME, roles_proyecto: ['roles/editor'] }, 'FALLO'],
    ['otra cuenta de servicio', 'A5', { cuenta: 'otra@project-os-511102.iam.gserviceaccount.com', roles_proyecto: [] }, 'FALLO'],
    ['secreto con dos lectores', 'A6', { secreto: 'project-os-nextauth-secret', miembros: [`roles/secretmanager.secretAccessor serviceAccount:${RUNTIME}`, 'roles/secretmanager.secretAccessor serviceAccount:otra@project-os-511102.iam.gserviceaccount.com'] }, 'FALLO'],
    ['dos versiones habilitadas', 'A6', { secreto: 'project-os-nextauth-secret', miembros: [`roles/secretmanager.secretAccessor serviceAccount:${RUNTIME}`], versiones: ['2 ENABLED', '1 ENABLED'] }, 'FALLO'],
    ['build con otra cuenta', 'A8', { cuenta_build: 'projects/project-os-511102/serviceAccounts/123-compute@developer.gserviceaccount.com' }, 'FALLO'],
    ['logs con coincidencias', 'E1', { patron: 'correo', coincidencias: 3 }, 'FALLO'],
    ['limpieza bloqueada', 'F3', { check: 'BLOQUEADO' }, 'FALLO'],
    ['pocas imágenes', 'F3', { imagenes: 2, mayores_30_dias_no_protegidas: 0 }, 'NO_VERIFICADO'],
    ['una sola revisión', 'G2', { revisiones: ['project-os-dashboard-00001-gsk'] }, 'NO_VERIFICADO'],
    ['humano sin resultado', 'D1', { resultado: '' }, 'NO_VERIFICADO'],
    ['humano FALLO', 'C2', { resultado: 'fallo' }, 'FALLO'],
    ['control sin regla', 'Z9', { algo: 1 }, 'NO_VERIFICADO'],
  ])('%s (%s) → %s', (_n, id, observado, esperado) => {
    expect(uno(id, observado).res[0]?.estado).toBe(esperado)
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
    expect(uno('A5', { cuenta: RUNTIME, roles_proyecto: null }).res[0]?.estado).toBe('NO_VERIFICADO')
    expect(uno('A4', { variables: [] }).res[0]?.estado).toBe('NO_VERIFICADO')
    expect(uno('A6', { secreto: 'project-os-nextauth-secret', miembros: null }).res[0]?.estado).toBe('NO_VERIFICADO')
  })

  it('acepta cuentas de servicio del proyecto y correos de example.com', () => {
    const r = uno('A5', { cuenta: RUNTIME, roles_proyecto: [], nota: 'contacto@example.com' })
    expect(r.status).toBe(0)
  })

  it('formato inválido o archivo ilegible → rechazo o uso incorrecto, nunca OK', () => {
    expect(run([], {}).status).toBe(4)
    expect(run([{ id: 'A9', observado: {} }], { fecha: 'ayer' }).status).toBe(4)
    expect(node(EVID, [path.join(tmpdir(), 'no-existe.json')]).status).toBe(2)
    expect(node(EVID, []).status).toBe(2)
  })

  it('la plantilla del plan de inspección pasa el saneamiento; con la fecha rellenada, todo es NO_VERIFICADO (código 3)', () => {
    const plantilla = JSON.parse(node(path.join(OPS, 'plan-inspeccion.mjs'), ['--plantilla-evidencia']).stdout)
    plantilla.fecha = '2026-10-12'
    const f = path.join(tmp('evidencia-'), 'p.json')
    writeFileSync(f, JSON.stringify(plantilla))
    const r = node(EVID, [f, '--json'])
    expect(r.status).toBe(3)
    const res = JSON.parse(r.stdout).resultados as Array<{ estado: string }>
    expect(res.length).toBeGreaterThanOrEqual(15)
    expect(res.every((x) => x.estado === 'NO_VERIFICADO')).toBe(true)
  })

  it('el ejemplo del repositorio es sintético, se declara así y no se cita como evidencia en la matriz', () => {
    const ejemplo = path.join(DOCS, 'evidencia-ejemplo.json')
    const e = JSON.parse(read(ejemplo))
    expect(e.ejemplo_sintetico).toBe(true)
    expect(e.fecha).toBe('2000-01-01')
    const r = node(EVID, [ejemplo])
    expect(r.stdout).toContain('EJEMPLO SINTÉTICO')
    expect(read(path.join(DOCS, 'matriz-aceptacion.md'))).not.toContain('evidencia-ejemplo')
  })
})

describe('documentos de operación (Entregas B y C)', () => {
  const doc = (n: string) => read(path.join(DOCS, n))

  it('el índice enlaza todos los documentos de la carpeta', () => {
    const indice = doc('README.md')
    for (const n of ['matriz-aceptacion.md', 'auditoria-seguridad.md', 'runbook-operativo.md', 'evidencia.md', 'mantenimiento-dependencias.md', 'backlog-v1-7.md', 'hoja-propietario.md']) {
      expect(indice, n).toContain(`(${n})`)
    }
  })

  it('la hoja del propietario es breve, ordenada y no pide pruebas que Claude ya hizo ni mutaciones', () => {
    const hoja = doc('hoja-propietario.md')
    expect(hoja.length).toBeLessThan(6000)
    const pasos = [...hoja.matchAll(/^\| (\d) \|/gm)].map((m) => Number(m[1]))
    expect(pasos).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(hoja).not.toMatch(/npm (test|run (lint|typecheck|build|test:e2e))/)
    expect(hoja).not.toMatch(/tags add|services update|add-iam-policy-binding|versions access|--apply/)
  })

  it('el runbook distingue instrucción de ejecución y marca las mutaciones', () => {
    const rb = doc('runbook-operativo.md')
    expect(rb).toMatch(/Instrucción no es ejecución/)
    expect((rb.match(/\[M\]/g) ?? []).length).toBeGreaterThanOrEqual(10)
    for (const t of ['401 inesperado', '403 de un usuario permitido', 'Callback OAuth', 'Lectura de Sheets 503', 'Fallo de sonda', 'Costo inesperado', 'Posible exposición de datos', 'Bloqueo de acceso']) expect(rb, t).toContain(t)
    expect(rb).toMatch(/una sola revisión/i)
    expect(rb).toMatch(/alerta, no un límite/)
  })

  it('el backlog V1.7 son hipótesis no aprobadas y separa lo que exige autorización', () => {
    const b = doc('backlog-v1-7.md')
    expect(b).toMatch(/hipótesis, \*\*no aprobadas\*\*/)
    for (const s of ['Quick wins', 'Mejoras arquitectónicas', 'exigen autorización explícita']) expect(b).toContain(s)
    expect(b).toMatch(/X6 \| \*\*Escritura real en Sheets\*\*/)
  })

  it('las advertencias centrales de la misión están explícitas', () => {
    const todo = ['matriz-aceptacion.md', 'auditoria-seguridad.md', 'runbook-operativo.md', 'mantenimiento-dependencias.md'].map(doc).join('\n')
    expect(todo).toMatch(/etiqueta `produccion`[^\n]*(no está confirmada|sin confirmar|no confirmad)/i)
    expect(todo).toContain("run.googleapis.com/maxScale: '3'")
    expect(todo).toMatch(/5 alertas altas|Las 5 alertas altas/)
    expect(todo).toMatch(/alerta, no un límite|no es un corte|avisa, no corta/)
    expect(todo).toMatch(/\*\*0\*\* \[registro\]|comparó \*\*0\*\*|0 valores/)
  })
})
