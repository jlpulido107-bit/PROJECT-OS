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
    expect(de('A6')).toContain("--format='value(name.basename(),state)'")
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
    const r = node(EVID, [f, '--json'])
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
      { id: 'C2', observado: { resultado: 'OK' } },
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
    ['control sin regla', 'Z9', { algo: 1 }, 'NO_VERIFICADO'],
  ])('%s → %s', (_n, id, observado, esperado) => {
    const r = uno(id, observado)
    expect(r.por[id]).toBe(esperado)
    expect(r.status).toBe(esperado === 'FALLO' ? 1 : esperado === 'OK' ? 0 : 3)
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
