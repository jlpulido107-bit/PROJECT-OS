import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/** Botón de despliegue (ORD-POS-163): workflow fuera de .github/, script WIF y guía. Sin red ni Google Cloud. */
const ROOT = path.resolve(__dirname, '..', '..')
const WORKFLOW = readFileSync(path.join(ROOT, 'web/deploy/github/desplegar-dashboard.yml'), 'utf8')
const WIF = path.join(ROOT, 'web/deploy/infra/wif-despliegue.sh')
const GUIA = readFileSync(path.join(ROOT, 'docs/despliegue-boton.md'), 'utf8')

/** Bloques de cada job: de «  nombre:» hasta el siguiente job de dos espacios. */
function jobs(): Record<string, string> {
  const cuerpo = WORKFLOW.slice(WORKFLOW.indexOf('\njobs:\n') + 7)
  const out: Record<string, string> = {}
  let actual = ''
  for (const linea of cuerpo.split('\n')) {
    const m = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(linea)
    if (m) actual = m[1] ?? ''
    else if (actual) out[actual] = (out[actual] ?? '') + linea + '\n'
  }
  return out
}

/** Bloque de la compuerta entre sus marcadores, sin la sangría del YAML. */
function compuerta(): string {
  const lineas = WORKFLOW.split('\n')
  const i = lineas.findIndex((l) => l.includes('# compuerta:inicio'))
  const f = lineas.findIndex((l) => l.includes('# compuerta:fin'))
  expect(i).toBeGreaterThan(-1)
  expect(f).toBeGreaterThan(i)
  const sangria = /^\s*/.exec(lineas[i] ?? '')![0].length
  return lineas.slice(i, f + 1).map((l) => l.slice(sangria)).join('\n')
}

describe('workflow desplegar-dashboard (ORD-POS-163)', () => {
  it('la copia activa en .github/workflows, si existe, es idéntica byte a byte a la fuente (ORD-POS-167); solo se dispara a mano', () => {
    const activo = path.join(ROOT, '.github/workflows/desplegar-dashboard.yml')
    if (existsSync(activo)) expect(readFileSync(activo).equals(readFileSync(path.join(ROOT, 'web/deploy/github/desplegar-dashboard.yml')))).toBe(true)
    expect(WORKFLOW).toMatch(/^on:\n {2}workflow_dispatch:\n\n/m)
    expect(WORKFLOW).not.toMatch(/^\s+(push|pull_request|schedule|workflow_run|repository_dispatch):/m)
  })

  it('criterio 2: id-token: write solo en el job con environment: produccion', () => {
    const j = jobs()
    expect(Object.keys(j)).toEqual(['compuerta', 'desplegar'])
    expect(WORKFLOW.match(/id-token:/g)).toHaveLength(1)
    expect(j.desplegar).toMatch(/^ {4}environment: produccion$/m)
    expect(j.desplegar).toMatch(/^ {6}id-token: write$/m)
    expect(j.compuerta).not.toMatch(/environment:|id-token/)
    expect(WORKFLOW.slice(0, WORKFLOW.indexOf('\njobs:\n'))).toMatch(/^permissions:\n {2}contents: read\n/m)
    expect(j.desplegar).toMatch(/needs: compuerta/)
  })

  it('criterio 3: ningún secrets', () => {
    expect(WORKFLOW).not.toMatch(/secrets/i)
  })

  it('criterio 4: toda acción fijada por SHA de 40', () => {
    const usos = [...WORKFLOW.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((m) => m[1] ?? '')
    expect(usos.length).toBeGreaterThanOrEqual(4)
    for (const u of usos) expect(u, u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)
  })

  it('criterio 5: deploy.sh solo recibe IMAGE y DEPLOY_COMMIT_SHA, sin --quitar', () => {
    expect(WORKFLOW).not.toMatch(/--quitar/)
    expect(WORKFLOW).not.toMatch(/\bexport\b/)
    expect(WORKFLOW).not.toMatch(/^ {0,4}env:/m) // sin env de workflow ni de job
    const pasos = (jobs().desplegar ?? '').split(/\n(?= {6}- name:)/)
    const deploy = pasos.filter((p) => p.includes('deploy/cloudrun/deploy.sh'))
    expect(deploy).toHaveLength(1)
    expect(deploy[0] ?? '').toMatch(/run: echo desplegar \| bash deploy\/cloudrun\/deploy\.sh --desde-activa --solo-imagen$/m)
    const claves = [...(deploy[0] ?? '').matchAll(/^ {10}([A-Z_][A-Z0-9_]*):/gm)].map((m) => m[1] ?? '').sort()
    expect(claves).toEqual(['DEPLOY_COMMIT_SHA', 'IMAGE'])
  })

  describe('criterio 6: compuerta', () => {
    const SHA = 'a'.repeat(40)
    let dir: string
    beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'compuerta-')) })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    function correr(env: Record<string, string | undefined>) {
      const salida = path.join(dir, 'output')
      writeFileSync(salida, '')
      const base: Record<string, string> = { PATH: process.env.PATH ?? '', GITHUB_OUTPUT: salida }
      for (const [k, v] of Object.entries(env)) if (v !== undefined) base[k] = v
      const r = spawnSync('bash', ['-c', compuerta()], { env: base as unknown as NodeJS.ProcessEnv, encoding: 'utf8' })
      return { code: r.status, err: r.stderr, out: readFileSync(salida, 'utf8') }
    }

    it.each([
      ['vacía', ''],
      ['sin definir', undefined],
      ['false', 'false'],
      ['TRUE', 'TRUE'],
      ['« true»', ' true'],
      ['«true »', 'true '],
    ])('DESPLIEGUE_BOTON %s: se detiene', (_, activo) => {
      const r = correr({ ACTIVO: activo, RAMA: 'refs/heads/main', COMMIT: SHA })
      expect(r.code).toBe(1)
      expect(r.err).toMatch(/DESPLIEGUE_BOTON/)
      expect(r.out).toBe('')
    })

    it.each(['refs/heads/otra', 'refs/heads/main-x', 'refs/tags/main', ''])('otra rama (%s): se detiene', (rama) => {
      const r = correr({ ACTIVO: 'true', RAMA: rama, COMMIT: SHA })
      expect(r.code).toBe(1)
      expect(r.err).toMatch(/solo despliega desde main/)
      expect(r.out).toBe('')
    })

    it.each(['', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), `${'a'.repeat(40)}\n`, 'g'.repeat(40), `${'a'.repeat(39)};`])(
      'SHA inválido (%j): se detiene', (commit) => {
        const r = correr({ ACTIVO: 'true', RAMA: 'refs/heads/main', COMMIT: commit })
        expect(r.code).toBe(1)
        expect(r.err).toMatch(/SHA de 40/)
        expect(r.out).toBe('')
      })

    it('true, main y SHA válido: abre y exporta el commit', () => {
      const r = correr({ ACTIVO: 'true', RAMA: 'refs/heads/main', COMMIT: SHA })
      expect(r.code).toBe(0)
      expect(r.out).toBe(`commit=${SHA}\n`)
    })
  })
})

describe('wif-despliegue.sh (ORD-POS-163)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'wif-'))
    writeFileSync(path.join(dir, 'gcloud'), '#!/usr/bin/env bash\necho "$*" >> "$GCLOUD_LOG"\necho 123456789012\n')
    chmodSync(path.join(dir, 'gcloud'), 0o755)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function correr(args: string[], input = '') {
    const log = path.join(dir, 'gcloud.log')
    writeFileSync(log, '')
    const r = spawnSync('bash', [WIF, ...args], {
      env: { PATH: `${dir}:${process.env.PATH}`, GCLOUD_LOG: log } as unknown as NodeJS.ProcessEnv, input, encoding: 'utf8',
    })
    return { code: r.status, out: r.stdout, err: r.stderr, log: readFileSync(log, 'utf8') }
  }

  it('criterio 7: sin --apply no llama a gcloud e imprime el plan', () => {
    const r = correr([])
    expect(r.code).toBe(0)
    expect(r.log).toBe('')
    expect(r.out).toMatch(/SIMULACIÓN/)
    expect(r.out).toMatch(/providers create-oidc github-actions/)
    expect(r.out).toContain("assertion.repository==\\'jlpulido107-bit/PROJECT-OS\\'")
    expect(r.out).toContain("assertion.ref==\\'refs/heads/main\\'")
    expect(r.out).toContain("assertion.environment==\\'produccion\\'")
    expect(r.out).toMatch(/WIF_SERVICE_ACCOUNT=project-os-despliegue@project-os-511102\.iam\.gserviceaccount\.com/)
    expect(r.out).not.toMatch(/keys create|roles\/(owner|editor|run\.admin)/)
  })

  it.each([['--plan'], ['--apply', 'extra'], ['apply']])('argumentos no válidos %j: uso, sin gcloud', (...args) => {
    const r = correr(args)
    expect(r.code).toBe(2)
    expect(r.log).toBe('')
  })

  it('--apply sin «AUTORIZO WIF» solo lee el número del proyecto y no cambia nada', () => {
    const r = correr(['--apply'], 'si\n')
    expect(r.code).toBe(1)
    expect(r.log.trim().split('\n')).toEqual(['projects describe project-os-511102 --format=value(projectNumber)'])
  })

  it('no crea claves ni lleva correos de personas', () => {
    const texto = readFileSync(WIF, 'utf8')
    expect(texto).not.toMatch(/keys create/)
    for (const c of texto.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? []) expect(c).toMatch(/\.iam\.gserviceaccount\.com$/)
  })
})

describe('docs/despliegue-boton.md (ORD-POS-163)', () => {
  const bloques = [...GUIA.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1] ?? '')

  it('criterio 8: sin marcadores para pegar literalmente', () => {
    expect(GUIA).not.toMatch(/<[^>\n]*>/)
    expect(GUIA).not.toMatch(/\b(TU_|XXX|PLACEHOLDER|CAMBIAR)/i)
  })

  it('criterio 8: toda variable de shell que usa la guía está definida en ella', () => {
    expect(bloques.length).toBeGreaterThanOrEqual(4)
    const definidas = new Set(bloques.flatMap((b) => [...b.matchAll(/^([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1] ?? '')))
    const usadas = new Set(bloques.flatMap((b) => [...b.matchAll(/\$\{?([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1] ?? '')))
    expect([...usadas].filter((v) => !definidas.has(v))).toEqual([])
    for (const v of ['PROJECT_ID', 'NUMERO_PROYECTO', 'WIF_PROVIDER', 'WIF_SERVICE_ACCOUNT']) expect(definidas.has(v), v).toBe(true)
  })

  it('explica de dónde sale cada valor y marca DEC-POS-036 como pendiente', () => {
    expect(GUIA).toMatch(/DEC-POS-036: PENDIENTE/)
    expect(GUIA).toMatch(/gcloud projects describe "\$PROJECT_ID" --format='value\(projectNumber\)'/)
    expect(GUIA).toMatch(/variables, no secrets/)
  })
})
