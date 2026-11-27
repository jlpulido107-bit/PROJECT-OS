import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/** NOTAS a Drive con el permiso mínimo (ORD-POS-177): fuente del workflow y guía. Dobles: un NOTAS local y un rclone falso; sin red, Google ni GitHub. */
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

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'notas-drive-'))
    notas = path.join(dir, 'notas')
    origen = path.join(dir, 'tmp', 'notas-a-drive')
    mkdirSync(path.join(dir, 'bin'), { recursive: true })
    mkdirSync(notas)
    // rclone falso: anota sus argumentos, el alcance y los archivos de la carpeta de origen.
    writeFileSync(path.join(dir, 'bin', 'rclone'), '#!/usr/bin/env bash\n{ echo "ARGS $*"; echo "SCOPE ${RCLONE_CONFIG_NOTAS_SCOPE-}"; (cd "$2" && find . -type f | sort); } >> "$RCLONE_LOG"\n')
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
    const env = { RCLONE_CONFIG_NOTAS_SCOPE: 'drive.file', RCLONE_CONFIG_NOTAS_CLIENT_SECRET: 'falso', RCLONE_CONFIG_NOTAS_TOKEN: '{"falso":1}' }
    expect(correr(script(SUBIR), env).code).toBe(0)
    const lineas = log().split('\n').filter(Boolean)
    expect(lineas[0]).toBe(`ARGS sync ${origen} notas: --exclude privado/** --exclude .obsidian/workspace* --max-delete 50 --stats-one-line -v`)
    expect(lineas[1]).toBe('SCOPE drive.file')
    expect(lineas.slice(2).map((l) => l.slice(2))).toEqual(LIMPIO)
    expect(log()).not.toMatch(/secreto|falso/)
  })

  it.each([
    ['el token', { RCLONE_CONFIG_NOTAS_CLIENT_SECRET: 'falso' }],
    ['el secreto del cliente', { RCLONE_CONFIG_NOTAS_TOKEN: '{}' }],
  ])('sin %s no llama a rclone', (_n, env) => {
    const r = correr(script(SUBIR), env as Record<string, string>)
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/::error::Missing secret NOTAS_DRIVE_CLIENT_SECRET or NOTAS_DRIVE_TOKEN; no sync attempted/)
    expect(log()).toBe('')
  })

  it.each([
    ['la carpeta', { CLIENTE: 'x' }],
    ['el cliente', { CARPETA: 'x' }],
  ])('sin la variable de %s se detiene en el primer paso', (_n, env) => {
    const r = correr(script(pasos[0] ?? ''), env as Record<string, string>)
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/::error::Missing repository variable NOTAS_DRIVE_FOLDER_ID or NOTAS_DRIVE_CLIENT_ID; no sync attempted/)
    expect(correr(script(pasos[0] ?? ''), { CARPETA: 'x', CLIENTE: 'y' }).code).toBe(0)
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
