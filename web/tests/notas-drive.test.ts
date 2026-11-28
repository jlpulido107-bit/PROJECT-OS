import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/** NOTAS a Drive con el permiso mínimo (ORD-POS-177) y el cliente de OAuth opcional (ORD-POS-178): fuente del workflow y guía. Dobles: un NOTAS local y un rclone falso; sin red, Google ni GitHub. */
const ROOT = path.resolve(__dirname, '..', '..')
const WORKFLOW = readFileSync(path.join(ROOT, 'web/deploy/github/notas-sync-to-drive.yml'), 'utf8')
const GUIA = readFileSync(path.join(ROOT, 'docs/notas-drive.md'), 'utf8')

const pasos = WORKFLOW.slice(WORKFLOW.indexOf('    steps:\n') + 11).split(/\n(?= {6}- name:)/).map((p) => `${p.trimEnd()}\n`)
const paso = (nombre: string) => pasos.find((p) => p.startsWith(`      - name: ${nombre}`)) ?? ''
/** El bloque `run: |` de un paso, sin la sangría del YAML. */
const script = (p: string) => p.slice(p.indexOf('        run: |\n') + 15).split('\n').map((l) => l.slice(10)).join('\n')
const PREPARAR = paso('Stage only tracked notes')
const SUBIR = paso('Sync notes to the Drive folder')

describe('fuente del workflow de NOTAS a Drive (ORD-POS-177, criterio 3)', () => {
  it('alcance drive.file y nunca el de todo el Drive; sin WIF ni cuenta de servicio', () => {
    expect(SUBIR).toContain('          RCLONE_CONFIG_NOTAS_SCOPE: drive.file\n')
    expect(WORKFLOW.match(/SCOPE:.*/g)).toEqual(['SCOPE: drive.file'])
    expect(WORKFLOW).not.toMatch(/scope\s*=|GDRIVE_TOKEN|rclone\.conf|RCLONE_CONFIG:|service_account|credentials_json/i)
    expect(WORKFLOW).not.toMatch(/^\s*id-token\s*:|google-github-actions/m)
  })

  it('permisos de solo lectura, sin eventos de terceros y con la acción fijada por SHA', () => {
    expect(WORKFLOW).toContain('\npermissions:\n  contents: read\n\njobs:\n')
    expect(WORKFLOW.match(/permissions:/g)).toHaveLength(1)
    expect(WORKFLOW).toMatch(/^on:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:\n/m)
    expect(WORKFLOW).not.toMatch(/^\s+(pull_request|pull_request_target|workflow_run|repository_dispatch|schedule):/m)
    const usos = [...WORKFLOW.matchAll(/^\s*uses:\s*(\S+)/gm)].map((m) => m[1] ?? '')
    expect(usos).toHaveLength(1)
    expect(usos[0]).toMatch(/^actions\/checkout@[0-9a-f]{40}$/)
    expect(paso('Checkout notes')).toContain('          persist-credentials: false\n')
  })

  it('los dos secretos solo los ve el paso que sube; la carpeta y el cliente son variables', () => {
    expect(WORKFLOW.match(/secrets\.\w+/g)).toEqual(['secrets.NOTAS_DRIVE_CLIENT_SECRET', 'secrets.NOTAS_DRIVE_TOKEN'])
    for (const p of pasos.filter((x) => x !== SUBIR)) expect(p).not.toMatch(/secrets\./)
    expect(SUBIR).toContain('          RCLONE_CONFIG_NOTAS_ROOT_FOLDER_ID: ${{ vars.NOTAS_DRIVE_FOLDER_ID }}\n')
    expect(SUBIR).toContain('          RCLONE_CONFIG_NOTAS_CLIENT_ID: ${{ vars.NOTAS_DRIVE_CLIENT_ID }}\n')
    // ORD-POS-178: el cliente es opcional y solo lo mira el paso que sube; el primero ya solo exige la carpeta.
    expect(WORKFLOW.match(/vars\.\w+/g)).toEqual(['vars.NOTAS_DRIVE_FOLDER_ID', 'vars.NOTAS_DRIVE_FOLDER_ID', 'vars.NOTAS_DRIVE_CLIENT_ID'])
    for (const p of pasos.filter((x) => x !== SUBIR)) expect(p).not.toMatch(/CLIENT/)
    // Preparar va antes de instalar y de subir, y ambos pasos usan la misma carpeta.
    const nombres = pasos.map((p) => /- name: (.*)/.exec(p)?.[1] ?? '')
    expect(nombres.map((n) => n.split(' ')[0])).toEqual(['Check', 'Checkout', 'Stage', 'Install', 'Sync'])
    const origen = '          ORIGEN: ${{ runner.temp }}/notas-a-drive\n'
    expect(PREPARAR).toContain(origen)
    expect(SUBIR).toContain(origen)
  })
})

describe('los bloques de shell, ejecutados tal cual con un NOTAS de prueba y un rclone falso', () => {
  let dir: string
  let notas: string
  let origen: string
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=Prueba', '-c', 'user.email=prueba@example.invalid', ...args], { cwd: notas, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(r.stderr)
  }
  const escribir = (rel: string, texto = 'nota\n') => {
    mkdirSync(path.dirname(path.join(notas, rel)), { recursive: true })
    writeFileSync(path.join(notas, rel), texto)
  }
  const correr = (bloque: string, env: Record<string, string> = {}) => {
    const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', bloque], {
      cwd: notas, encoding: 'utf8', env: { PATH: `${dir}/bin:${process.env.PATH}`, ORIGEN: origen, RCLONE_LOG: path.join(dir, 'rclone.log'), ...env } as unknown as NodeJS.ProcessEnv,
    })
    return { code: r.status, out: r.stdout + r.stderr }
  }
  const subidos = () => spawnSync('find', ['.', '-type', 'f'], { cwd: origen, encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map((l) => l.slice(2)).sort()
  const log = () => (existsSync(path.join(dir, 'rclone.log')) ? readFileSync(path.join(dir, 'rclone.log'), 'utf8') : '')
  /** El `env:` de un paso como lo entrega GitHub: una variable o un secreto que no existe llega como cadena vacía. */
  const github = (p: string, vars: Record<string, string> = {}, secrets: Record<string, string> = {}) => {
    const bloque = /\n {8}env:\n((?: {10}.*\n)+)/.exec(p)?.[1] ?? ''
    const env = Object.fromEntries([...bloque.matchAll(/^ {10}(\w+): (.*)$/gm)].map((m) => [m[1] ?? '', (m[2] ?? '')
      .replace(/\$\{\{ (vars|secrets)\.(\w+) \}\}/g, (_m, tipo: string, nombre: string) => (tipo === 'vars' ? vars : secrets)[nombre] ?? '')
      .replace('${{ runner.temp }}', path.join(dir, 'tmp'))]))
    for (const v of Object.values(env)) expect(v).not.toContain('${{')
    return env
  }
  /** La configuración del remoto que de verdad le llegó al rclone falso (su entorno), o null si nadie lo llamó. */
  const remoto = () => (existsSync(path.join(dir, 'rclone.log.env'))
    ? Object.fromEntries(readFileSync(path.join(dir, 'rclone.log.env'), 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
    : null)
  const subir = (vars: Record<string, string>, secrets: Record<string, string>) => correr(script(SUBIR), github(SUBIR, vars, secrets))

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'notas-drive-'))
    notas = path.join(dir, 'notas')
    origen = path.join(dir, 'tmp', 'notas-a-drive')
    mkdirSync(path.join(dir, 'bin'), { recursive: true })
    mkdirSync(notas)
    // rclone falso: anota sus argumentos, el alcance y los archivos de la carpeta de origen; aparte, la configuración del remoto que recibió.
    writeFileSync(path.join(dir, 'bin', 'rclone'), '#!/usr/bin/env bash\n{ echo "ARGS $*"; echo "SCOPE ${RCLONE_CONFIG_NOTAS_SCOPE-}"; (cd "$2" && find . -type f | sort); } >> "$RCLONE_LOG"\nenv | grep "^RCLONE_CONFIG_" | sort > "$RCLONE_LOG.env"\n')
    chmodSync(path.join(dir, 'bin', 'rclone'), 0o755)
    git('init', '-q', '-b', 'main')
    escribir('.gitignore', 'privado/\n.obsidian/workspace*\n')
    escribir('POS/indice.md')
    escribir('POS/ideas/una idea con acentó.md')
    escribir('-raro.md')
    escribir('.obsidian/app.json', '{}')
    escribir('privado.md', 'una nota que solo se llama así\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'base')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const LIMPIO = ['-raro.md', '.gitignore', '.obsidian/app.json', 'POS/ideas/una idea con acentó.md', 'POS/indice.md', 'privado.md']
  const TOKEN = '{"access_token":"acceso-falso","refresh_token":"refresco-falso"}'
  const CARPETA = { NOTAS_DRIVE_FOLDER_ID: 'carpeta-de-prueba' }
  const ID_PROPIO = { NOTAS_DRIVE_CLIENT_ID: 'id-falso.apps.googleusercontent.com' }
  const SECRETO_PROPIO = { NOTAS_DRIVE_CLIENT_SECRET: 'secreto-falso' }
  /** Lo que rclone recibe siempre: tipo, alcance, carpeta y token. Sin client_id ni client_secret usa su cliente integrado. */
  const SIN_CLIENTE = { RCLONE_CONFIG_NOTAS_TYPE: 'drive', RCLONE_CONFIG_NOTAS_SCOPE: 'drive.file', RCLONE_CONFIG_NOTAS_ROOT_FOLDER_ID: 'carpeta-de-prueba', RCLONE_CONFIG_NOTAS_TOKEN: TOKEN }

  it('lo ignorado por git (privado/ y el estado de Obsidian) no llega a la carpeta que se sube', () => {
    escribir('privado/secreto.md')
    escribir('.obsidian/workspace.json', '{}')
    escribir('.obsidian/workspace-mobile.json', '{}')
    escribir('sin-commit.md')
    expect(correr(script(PREPARAR)).code).toBe(0)
    expect(subidos()).toEqual(LIMPIO)
  })

  it('aunque alguien los meta a git a la fuerza, privado/ y .obsidian/workspace* tampoco se suben, a ningún nivel', () => {
    for (const rel of ['privado/secreto.md', 'privado/sub/otro.md', 'POS/privado/x.md', '.obsidian/workspace.json', '.obsidian/workspace-mobile.json', '.obsidian/workspaces.json', 'SIG/.obsidian/workspace.json']) escribir(rel)
    git('add', '-A', '-f')
    git('commit', '-q', '-m', 'a la fuerza')
    expect(correr(script(PREPARAR)).code).toBe(0)
    expect(subidos()).toEqual(LIMPIO)
    expect(subidos().join('\n')).not.toMatch(/privado\/|workspace/)
  })

  it('una corrida anterior no deja restos: la carpeta se arma de cero', () => {
    mkdirSync(path.join(origen, 'privado'), { recursive: true })
    writeFileSync(path.join(origen, 'privado', 'viejo.md'), 'resto')
    expect(correr(script(PREPARAR)).code).toBe(0)
    expect(subidos()).toEqual(LIMPIO)
  })

  it('si un enlace simbólico se llama privado, se detiene sin subir', () => {
    spawnSync('ln', ['-s', 'POS', 'privado'], { cwd: notas })
    git('add', '-A', '-f')
    git('commit', '-q', '-m', 'enlace')
    // El filtro ya lo deja fuera; se comprueba además la segunda barrera con un filtro roto.
    expect(correr(script(PREPARAR)).code).toBe(0)
    expect(existsSync(path.join(origen, 'privado'))).toBe(false)
    const sinFiltro = script(PREPARAR).replace(/grep -zvE '[^']*'/, "grep -zvE 'NADA-COINCIDE'")
    expect(sinFiltro).not.toBe(script(PREPARAR))
    const r = correr(sinFiltro)
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/::error::privado\/ or \.obsidian\/workspace\* reached the upload folder; no sync attempted/)
  })

  it('sin nada que subir se detiene', () => {
    git('rm', '-q', '-r', '--cached', '.')
    git('commit', '-q', '-m', 'vacío')
    const r = correr(script(PREPARAR))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/::error::No tracked notes to upload; no sync attempted/)
  })

  it('rclone recibe solo la carpeta preparada, con drive.file y las exclusiones repetidas', () => {
    escribir('privado/secreto.md')
    expect(correr(script(PREPARAR)).code).toBe(0)
    expect(subir({ ...CARPETA, ...ID_PROPIO }, { NOTAS_DRIVE_TOKEN: TOKEN, ...SECRETO_PROPIO }).code).toBe(0)
    const lineas = log().split('\n').filter(Boolean)
    expect(lineas[0]).toBe(`ARGS sync ${origen} notas: --exclude privado/** --exclude .obsidian/workspace* --max-delete 50 --stats-one-line -v`)
    expect(lineas[1]).toBe('SCOPE drive.file')
    expect(lineas.slice(2).map((l) => l.slice(2))).toEqual(LIMPIO)
    expect(log()).not.toMatch(/secreto|falso/)
  })

  describe('cliente de OAuth opcional (ORD-POS-178, criterios 1 a 3)', () => {
    it('sin cliente usa el integrado de rclone: no le llega client_id ni client_secret', () => {
      expect(correr(script(PREPARAR)).code).toBe(0)
      const r = subir(CARPETA, { NOTAS_DRIVE_TOKEN: TOKEN })
      expect(r.code).toBe(0)
      expect(r.out).toContain('OAuth client: rclone built-in')
      expect(remoto()).toEqual(SIN_CLIENTE)
      expect(log().split('\n').filter((l) => l.startsWith('ARGS '))).toHaveLength(1)
    })

    it('con los dos datos usa el cliente propio, sin tocarlos', () => {
      expect(correr(script(PREPARAR)).code).toBe(0)
      const r = subir({ ...CARPETA, ...ID_PROPIO }, { NOTAS_DRIVE_TOKEN: TOKEN, ...SECRETO_PROPIO })
      expect(r.code).toBe(0)
      expect(r.out).toContain('OAuth client: own')
      expect(remoto()).toEqual({ ...SIN_CLIENTE, RCLONE_CONFIG_NOTAS_CLIENT_ID: 'id-falso.apps.googleusercontent.com', RCLONE_CONFIG_NOTAS_CLIENT_SECRET: 'secreto-falso' })
      // El registro del paso dice qué cliente usó, nunca su valor.
      expect(r.out).not.toMatch(/id-falso|secreto-falso|refresco-falso/)
    })

    it.each([
      ['solo el ID de cliente', ID_PROPIO, {}],
      ['solo el secreto de cliente', {}, SECRETO_PROPIO],
    ])('con %s falla sin subir nada', (_n, vars, secrets) => {
      expect(correr(script(PREPARAR)).code).toBe(0)
      const r = subir({ ...CARPETA, ...vars }, { NOTAS_DRIVE_TOKEN: TOKEN, ...secrets })
      expect(r.code).toBe(1)
      expect(r.out).toMatch(/::error::Set both NOTAS_DRIVE_CLIENT_ID and NOTAS_DRIVE_CLIENT_SECRET, or neither; no sync attempted/)
      expect(r.out).not.toContain('OAuth client:')
      expect(log()).toBe('')
      expect(remoto()).toBeNull()
    })

    it.each([
      ['sin cliente', {}, {}],
      ['con el cliente propio completo', ID_PROPIO, SECRETO_PROPIO],
    ])('el token sigue siendo obligatorio: %s y sin token no llama a rclone', (_n, vars, secrets) => {
      const r = subir({ ...CARPETA, ...vars }, secrets)
      expect(r.code).toBe(1)
      expect(r.out).toMatch(/::error::Missing secret NOTAS_DRIVE_TOKEN; no sync attempted/)
      expect(log()).toBe('')
      expect(remoto()).toBeNull()
    })

    it('la carpeta sigue siendo obligatoria: sin su variable se detiene en el primer paso, con o sin cliente', () => {
      const primero = pasos[0] ?? ''
      for (const vars of [{}, ID_PROPIO]) {
        const r = correr(script(primero), github(primero, vars))
        expect(r.code).toBe(1)
        expect(r.out).toMatch(/::error::Missing repository variable NOTAS_DRIVE_FOLDER_ID; no sync attempted/)
      }
      expect(correr(script(primero), github(primero, CARPETA)).code).toBe(0)
    })
  })
})

describe('guía del propietario (ORD-POS-177, criterios 1, 3 y 5)', () => {
  it('dice que WIF no es viable, con la fuente oficial, y nombra el riesgo que queda', () => {
    expect(GUIA).toContain('https://developers.google.com/workspace/drive/api/guides/about-shareddrives')
    expect(GUIA).toMatch(/no es viable/i)
    expect(GUIA).toMatch(/## Riesgo que queda/)
  })

  it('usa los mismos nombres que la fuente y cubre copiar, probar y retirar el token anterior', () => {
    for (const n of ['NOTAS_DRIVE_FOLDER_ID', 'NOTAS_DRIVE_CLIENT_ID', 'NOTAS_DRIVE_CLIENT_SECRET', 'NOTAS_DRIVE_TOKEN', 'GDRIVE_TOKEN', 'drive.file']) expect(GUIA, n).toContain(n)
    expect(GUIA).toContain('cp ../PROJECT-OS/web/deploy/github/notas-sync-to-drive.yml .github/workflows/sync-to-drive.yml')
    expect(GUIA).toMatch(/--dry-run/)
    // Ningún paso pide el alcance de todo el Drive ni --apply.
    expect(GUIA).not.toMatch(/--drive-scope[ =]drive(\s|$)|--apply/m)
  })
})

describe('guía del propietario: cliente de OAuth opcional (ORD-POS-178, criterio 4)', () => {
  /** El texto de una sección de la guía, de su título al siguiente título de nivel 2 o 3. */
  const seccion = (titulo: string) => {
    const desde = GUIA.indexOf(`\n${titulo}\n`)
    expect(desde, titulo).toBeGreaterThan(-1)
    const cuerpo = GUIA.slice(desde + titulo.length + 2)
    const fin = cuerpo.search(/^#{2,3} /m)
    return fin < 0 ? cuerpo : cuerpo.slice(0, fin)
  }
  const ORDEN = 'https://github.com/jlpulido107-bit/PROJECT-OS/issues/394'
  const SIN_CLIENTE = '\nrclone config create notas-drive drive scope drive.file\n'

  it('(a) el paso 1 es opcional, solo con un dominio verificado, y dice por qué no se publicó el 28-nov', () => {
    const paso = seccion('### 1. Cliente de OAuth propio (opcional)')
    expect(paso).toMatch(/Sáltalo si no tienes un dominio verificado/)
    expect(paso).toMatch(/el 28-nov, al aplicar la ORD-POS-177, Google no dejó publicar la app sin un dominio verificado/)
    expect(paso).toContain(ORDEN)
    expect(paso).toMatch(/expira en 7 días/)
  })

  it('(b) el paso 2 autoriza sin cliente, con el comando de la orden; el del cliente propio queda solo para el paso 1', () => {
    const paso = seccion('### 2. Autorizar con `drive.file`')
    const sin = paso.indexOf(SIN_CLIENTE)
    const con = paso.indexOf('rclone config create notas-drive drive scope drive.file client_id "$NOTAS_ID" client_secret "$NOTAS_SECRETO"\n')
    expect(sin).toBeGreaterThan(-1)
    expect(con).toBeGreaterThan(sin)
    expect(paso.slice(sin, con)).toMatch(/Solo si hiciste el paso 1/)
    // En el paso 4, los dos datos del cliente son opcionales y la carpeta y el token no.
    const tabla = seccion('### 4. Variables y secretos en NOTAS')
    expect(tabla).toContain('| Variable | `NOTAS_DRIVE_FOLDER_ID` |')
    expect(tabla).toContain('| Secret | `NOTAS_DRIVE_TOKEN` |')
    expect(tabla).toContain('| Variable, opcional | `NOTAS_DRIVE_CLIENT_ID` |')
    expect(tabla).toContain('| Secret, opcional | `NOTAS_DRIVE_CLIENT_SECRET` |')
  })

  it('(c) dice qué app quitar y cuándo: el permiso viejo antes de autorizar, y al retirar el token viejo ya no se toca rclone', () => {
    const autorizar = seccion('### 2. Autorizar con `drive.file`')
    const quitar = autorizar.indexOf('Primero quita el permiso viejo')
    expect(quitar).toBeGreaterThan(-1)
    expect(quitar).toBeLessThan(autorizar.indexOf(SIN_CLIENTE))
    expect(autorizar.slice(quitar, autorizar.indexOf(SIN_CLIENTE))).toMatch(/misma app, el\s+cliente integrado de `rclone`/)
    const retirar = seccion('### 7. Retirar el `GDRIVE_TOKEN`')
    expect(retirar).toMatch(/No quites `rclone` de tu cuenta de Google ahora/)
    expect(retirar).toMatch(/el token viejo y el nuevo son de esa\s+misma app/)
    expect(retirar).not.toMatch(/Revoca el acceso anterior/)
  })

  it('(d) el riesgo que queda nombra la cuota compartida del cliente de rclone y su retiro, con la fuente', () => {
    const riesgo = seccion('## Riesgo que queda')
    expect(riesgo).toMatch(/El cliente integrado de `rclone` es compartido/)
    expect(riesgo).toMatch(/cuota/)
    expect(riesgo).toMatch(/global rate limit/)
    expect(riesgo).toMatch(/during 2026/)
    expect(riesgo).toContain('https://rclone.org/drive/#making-your-own-client-id')
    // El aviso del retiro también va arriba, antes de los pasos.
    expect(GUIA.slice(0, GUIA.indexOf('\n## Pasos\n'))).toMatch(/will stop working during 2026/)
  })

  it('la tabla de pasos en rojo nombra pasos y mensajes que existen en la fuente', () => {
    const nombres = pasos.map((p) => /- name: (.*)/.exec(p)?.[1] ?? '')
    const filas = [...seccion('### 6. Probar').matchAll(/^\| \*([^*]+)\*/gm)].map((m) => m[1] ?? '')
    expect(filas.length).toBeGreaterThanOrEqual(7)
    for (const fila of filas) expect(nombres.some((n) => n.startsWith(fila)), fila).toBe(true)
    for (const mensaje of ['Missing secret', 'Set both']) {
      expect(GUIA).toContain(`| *Sync notes* con \`${mensaje}\` |`)
      expect(SUBIR).toContain(`echo "::error::${mensaje} `)
    }
    expect(GUIA).toContain('`OAuth client:`')
    expect(SUBIR.match(/echo "OAuth client: /g)).toHaveLength(2)
  })
})
