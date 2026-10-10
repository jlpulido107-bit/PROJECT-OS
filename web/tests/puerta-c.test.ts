import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * Puerta C: script de la política de limpieza de Artifact Registry y documentación de preparación.
 * Todo es local: se lee el texto del script y se ejecuta con un `gcloud` FALSO que registra cada llamada.
 * El gcloud real (/usr/local/bin) no está en el PATH de las pruebas. Nunca se contacta a Google Cloud.
 */
const ROOT = path.resolve(__dirname, '..', '..')
const SCRIPT = path.join(ROOT, 'web', 'deploy', 'infra', 'limpieza-artifact-v1-6.sh')
const POLICY = path.join(ROOT, 'web', 'deploy', 'cloudrun', 'artifact-cleanup-policy.json')
const INFRA = path.join(ROOT, 'web', 'deploy', 'infra', 'project-os-infra-minima-v1-6.sh')
const DOC = path.join(ROOT, 'docs', 'puerta-c-v1-6.md')
const RUNBOOK = path.join(ROOT, 'docs', 'despliegue-privado-v1-3.md')
const text = readFileSync(SCRIPT, 'utf8')
const ACK = 'AUTORIZO LIMPIEZA PROJECT-OS'

/** Líneas lógicas del script, sin comentarios ni heredocs (plan y ayudante Python). */
const code = (() => {
  const out: Array<{ n: number; line: string }> = []
  let heredoc: string | null = null
  text.replace(/\\\n\s*/g, ' ').split('\n').forEach((line, n) => {
    if (heredoc) {
      if (line.trim() === heredoc) heredoc = null
      return
    }
    const start = /<<'?([A-Z]+)'?/.exec(line)
    if (start?.[1]) heredoc = start[1]
    if (!line.trim().startsWith('#')) out.push({ n, line })
  })
  return out
})()
const gcloudCalls = code.flatMap(({ n, line }) => [...line.matchAll(/gcloud (?:artifacts|auth|projects|services|iam|storage|builds|run|secrets) [^|)]*/g)].map((m) => ({ n, cmd: m[0].trim() })))

// Respuestas de `gcloud artifacts repositories describe --format=json`.
// API: acciones en mayúsculas y duración en segundos enteros. SDK: lo que el propio gcloud envía tras procesar el
// archivo (comprobado con el SDK 570.0.0 local, sin red): `Delete`/`Keep` y `2592000.0s`.
const policies = (keep = 3, older = '2592000s', del = 'DELETE', kp = 'KEEP') => ({
  'conservar-3-recientes': { id: 'conservar-3-recientes', action: kp, mostRecentVersions: { keepCount: keep } },
  'borrar-mayores-30-dias': { id: 'borrar-mayores-30-dias', action: del, condition: { tagState: 'ANY', olderThan: older } },
})
const repo = (extra: Record<string, unknown> = {}) => JSON.stringify({
  name: 'projects/project-os-511102/locations/northamerica-south1/repositories/project-os', format: 'DOCKER', ...extra,
})
const ACTIVE = repo({ cleanupPolicies: policies(), cleanupPolicyDryRun: false })

const dir = mkdtempSync(path.join(tmpdir(), 'puerta-c-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const log = path.join(dir, 'llamadas.log')
writeFileSync(path.join(dir, 'gcloud'), [
  '#!/bin/sh',
  'printf "%s\\n" "$*" >> "$FAKE_LOG"',
  'case "$*" in',
  '  "artifacts repositories describe"*)',
  '    if [ -n "${FAKE_DESCRIBE_ERROR:-}" ]; then echo "ERROR: PERMISSION_DENIED para persona.real@gmail.com" >&2; exit 1; fi',
  '    if grep -q "^artifacts repositories set-cleanup-policies" "$FAKE_LOG"; then printf "%s\\n" "${FAKE_AFTER:-$FAKE_REPO}"; else printf "%s\\n" "$FAKE_REPO"; fi ;;',
  '  "artifacts repositories set-cleanup-policies"*)',
  '    if [ -n "${FAKE_SET_ERROR:-}" ]; then echo "ERROR: denegado" >&2; exit 1; fi ;;',
  '  *) echo "gcloud falso: llamada no prevista: $*" >&2; exit 97 ;;',
  'esac',
].join('\n'))
chmodSync(path.join(dir, 'gcloud'), 0o755)

function run(mode: string, env: Record<string, string> = {}, input: string | null = '') {
  writeFileSync(log, '')
  const r = spawnSync('bash', [SCRIPT, mode], {
    input: input ?? undefined, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'], encoding: 'utf8',
    env: { PATH: `${dir}:/usr/bin:/bin`, FAKE_LOG: log, FAKE_REPO: ACTIVE, ...env } as unknown as NodeJS.ProcessEnv,
  })
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean)
  return { ...r, calls, sets: calls.filter((c) => c.startsWith('artifacts repositories set-cleanup-policies')) }
}

describe('limpieza de Artifact Registry: controles estáticos del script', () => {
  it('usa el mismo proyecto, región y repositorio que la infraestructura mínima (Puerta B)', () => {
    const infra = readFileSync(INFRA, 'utf8')
    for (const constant of ["PROJECT_ID='project-os-511102'", "REGION='northamerica-south1'", "REPO='project-os'"]) {
      expect(text, constant).toContain(`readonly ${constant}`)
      expect(infra, constant).toContain(`readonly ${constant}`)
    }
  })

  it('la única mutación es set-cleanup-policies, con --no-dry-run y después de la confirmación', () => {
    const ack = code.find(({ line }) => /read -r -p .*ACK_TEXT/.test(line))?.n ?? -1
    expect(ack).toBeGreaterThan(0)
    const mutating = gcloudCalls.filter((g) => !/ describe /.test(` ${g.cmd} `))
    expect(mutating.map((g) => g.cmd.split(' "')[0])).toEqual(['gcloud artifacts repositories set-cleanup-policies'])
    expect(mutating[0]?.n).toBeGreaterThan(ack)
    expect(mutating[0]?.cmd).toContain('--no-dry-run')
    expect(mutating[0]?.cmd).toContain('--policy="$POLICY_FILE"')
    expect(text).toContain(`readonly ACK_TEXT='${ACK}'`)
  })

  it('todas las llamadas fijan --project y --location; no hay builds, pushes, borrados, IAM ni secretos', () => {
    expect(gcloudCalls.length).toBeGreaterThanOrEqual(2)
    for (const g of gcloudCalls) {
      expect(g.cmd, g.cmd).toContain('--project="$PROJECT_ID"')
      expect(g.cmd, g.cmd).toContain('--location="$REGION"')
    }
    const body = code.map((c) => c.line).join('\n')
    for (const forbidden of [/builds submit/, /docker push/, /\bdelete\b/, /iam-policy/, /secrets /, /services enable/, /\brm\b/]) {
      expect(body, String(forbidden)).not.toMatch(forbidden)
    }
  })

  it('la política esperada está fijada en el script y coincide con el archivo revisado', () => {
    expect(text).toContain("'conservar-3-recientes': {'action': 'KEEP', 'condition': None, 'mostRecentVersions': {'keepCount': 3")
    expect(text).toContain("'borrar-mayores-30-dias': {'action': 'DELETE', 'condition': {'tagState': 'ANY', 'olderThan': 2592000.0}")
    const helper = spawnSync('bash', ['-c', `source "${SCRIPT}"; py file < "${POLICY}"`], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } as unknown as NodeJS.ProcessEnv })
    expect(helper.status).toBe(0)
  })

  it.each([
    ['keepCount distinto', '[{"name":"conservar-3-recientes","action":{"type":"Keep"},"mostRecentVersions":{"keepCount":1}},{"name":"borrar-mayores-30-dias","action":{"type":"Delete"},"condition":{"tagState":"ANY","olderThan":"2592000s"}}]'],
    ['edad distinta', '[{"name":"conservar-3-recientes","action":{"type":"Keep"},"mostRecentVersions":{"keepCount":3}},{"name":"borrar-mayores-30-dias","action":{"type":"Delete"},"condition":{"tagState":"ANY","olderThan":"1d"}}]'],
    ['sin la regla Keep', '[{"name":"borrar-mayores-30-dias","action":{"type":"Delete"},"condition":{"tagState":"ANY","olderThan":"2592000s"}}]'],
    ['nombre repetido', '[{"name":"x","action":{"type":"Keep"},"mostRecentVersions":{"keepCount":3}},{"name":"x","action":{"type":"Keep"},"mostRecentVersions":{"keepCount":3}}]'],
  ])('un archivo de política alterado se rechaza (%s)', (_name, json) => {
    const r = spawnSync('bash', ['-c', `source "${SCRIPT}"; py file`], { input: json, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } as unknown as NodeJS.ProcessEnv })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('FALLA')
  })

  it('acepta duraciones equivalentes del archivo (30d = 2592000s)', () => {
    const json = '[{"name":"conservar-3-recientes","action":{"type":"Keep"},"mostRecentVersions":{"keepCount":3}},{"name":"borrar-mayores-30-dias","action":{"type":"Delete"},"condition":{"tagState":"any","olderThan":"30d"}}]'
    const r = spawnSync('bash', ['-c', `source "${SCRIPT}"; py file`], { input: json, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } as unknown as NodeJS.ProcessEnv })
    expect(r.status).toBe(0)
  })
})

describe('limpieza de Artifact Registry: --plan y --check con gcloud falso', () => {
  it('--plan no invoca gcloud', () => {
    const r = run('--plan')
    expect(r.status).toBe(0)
    expect(r.calls).toEqual([])
    expect(r.stdout).toContain('Keep tiene prioridad sobre Delete')
  })

  it('un modo desconocido no hace nada', () => {
    const r = run('--borrar')
    expect(r.status).toBe(2)
    expect(r.calls).toEqual([])
  })

  it.each([
    ['respuesta de la API', ACTIVE],
    ['formato del SDK (Keep/Delete, 2592000.0s)', repo({ cleanupPolicies: policies(3, '2592000.0s', 'Delete', 'Keep'), cleanupPolicyDryRun: false })],
    ['dry run ausente (falso por defecto)', repo({ cleanupPolicies: policies() })],
  ])('--check permite el build con la política activa (%s), con una sola lectura', (_name, json) => {
    const r = run('--check', { FAKE_REPO: json })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('PERMITIDO')
    expect(r.calls).toEqual(['artifacts repositories describe project-os --project=project-os-511102 --location=northamerica-south1 --format=json'])
  })

  it.each([
    ['sin políticas', repo(), 'falta la política conservar-3-recientes'],
    ['dry run activo', repo({ cleanupPolicies: policies(), cleanupPolicyDryRun: true }), 'FALLA  ejecución en seco'],
    ['keepCount distinto', repo({ cleanupPolicies: policies(10) }), 'no coincide'],
    ['edad distinta', repo({ cleanupPolicies: policies(3, '604800s') }), 'no coincide'],
    ['política adicional', repo({ cleanupPolicies: { ...policies(), extra: { id: 'extra', action: 'DELETE', condition: { tagState: 'UNTAGGED' } } } }), 'política no prevista: extra'],
    ['formato no Docker', repo({ format: 'MAVEN', cleanupPolicies: policies() }), 'FALLA  formato DOCKER'],
    ['JSON no válido', 'no es json', 'FALLA  formato no reconocido'],
  ])('--check BLOQUEA el build: %s', (_name, json, expected) => {
    const r = run('--check', { FAKE_REPO: json })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain(expected)
    expect(r.stderr).toContain('BLOQUEADO')
    expect(r.sets).toEqual([])
  })

  it('--check bloquea si no puede leer el repositorio, sin mostrar correos de personas', () => {
    const r = run('--check', { FAKE_DESCRIBE_ERROR: '1' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('BLOQUEADO')
    expect(r.stderr).toContain('***@***')
    expect(r.stderr).not.toContain('persona.real@gmail.com')
  })
})

describe('limpieza de Artifact Registry: --apply con gcloud falso (sin GCP)', () => {
  const EMPTY = repo()

  it('aplica la política una sola vez tras AUTORIZO y la verifica después', () => {
    const r = run('--apply', { FAKE_REPO: EMPTY, FAKE_AFTER: ACTIVE }, `${ACK}\n`)
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('FINALIZADO')
    expect(r.sets).toEqual([
      `artifacts repositories set-cleanup-policies project-os --project=project-os-511102 --location=northamerica-south1 --policy=${POLICY} --no-dry-run --format=none`,
    ])
    expect(r.calls.filter((c) => c.includes(' describe '))).toHaveLength(2)
    expect(r.calls.indexOf(r.sets[0] ?? '')).toBe(1)
  })

  it.each([
    ['texto distinto', 'si\n'],
    ['línea vacía', '\n'],
  ])('sin la confirmación exacta no cambia nada (%s)', (_name, input) => {
    const r = run('--apply', { FAKE_REPO: EMPTY }, input)
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('Cancelado sin cambios')
    expect(r.sets).toEqual([])
  })

  it('sin entrada estándar no cambia nada', () => {
    const r = run('--apply', { FAKE_REPO: EMPTY }, null)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('sin confirmación')
    expect(r.sets).toEqual([])
  })

  it('se detiene sin preguntar si el repositorio ya tiene otras políticas (no las reemplaza)', () => {
    const other = repo({ cleanupPolicies: { ajena: { id: 'ajena', action: 'DELETE', condition: { tagState: 'UNTAGGED' } } } })
    const r = run('--apply', { FAKE_REPO: other }, `${ACK}\n`)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('las reemplazaría')
    expect(r.stdout).not.toContain('escribe exactamente')
    expect(r.sets).toEqual([])
  })

  it('se detiene sin preguntar si el repositorio no es Docker o no se puede leer', () => {
    const cases: Array<Record<string, string>> = [{ FAKE_REPO: repo({ format: 'NPM' }) }, { FAKE_DESCRIBE_ERROR: '1' }]
    for (const env of cases) {
      const r = run('--apply', env, `${ACK}\n`)
      expect(r.status).toBe(1)
      expect(r.sets).toEqual([])
    }
  })

  it('si la política ya está activa no hace nada', () => {
    const r = run('--apply', {}, `${ACK}\n`)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('nada que hacer')
    expect(r.sets).toEqual([])
  })

  it('si las políticas existen en dry run, las reactiva tras AUTORIZO', () => {
    const dry = repo({ cleanupPolicies: policies(), cleanupPolicyDryRun: true })
    const r = run('--apply', { FAKE_REPO: dry, FAKE_AFTER: ACTIVE }, `${ACK}\n`)
    expect(r.status).toBe(0)
    expect(r.sets).toHaveLength(1)
  })

  it('si set-cleanup-policies falla, termina con error y remite a --check', () => {
    const r = run('--apply', { FAKE_REPO: EMPTY, FAKE_SET_ERROR: '1' }, `${ACK}\n`)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('set-cleanup-policies falló')
    expect(r.stdout).not.toContain('FINALIZADO')
  })

  it('si la verificación posterior falla, termina con error y bloquea el build', () => {
    const r = run('--apply', { FAKE_REPO: EMPTY, FAKE_AFTER: repo({ cleanupPolicies: policies(), cleanupPolicyDryRun: true }) }, `${ACK}\n`)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('NO compilar')
    expect(r.stdout).not.toContain('FINALIZADO')
  })
})

describe('documentación de la Puerta C', () => {
  const doc = readFileSync(DOC, 'utf8')
  const runbook = readFileSync(RUNBOOK, 'utf8')

  /** Bloques de operación: `#### C… — título` hasta el siguiente encabezado de nivel ≤ 4. */
  const ops = [...doc.matchAll(/^#### (C\d+[a-z]?) — (.+)\n([\s\S]*?)(?=^#{2,4} )/gm)].map((m) => ({ id: m[1] ?? '', title: m[2] ?? '', body: m[3] ?? '' }))

  it('cada operación futura tiene tipo, comando, precondiciones, impacto, verificación y procedimiento ante fallos', () => {
    expect(ops.length).toBeGreaterThanOrEqual(8)
    for (const op of ops) {
      for (const field of ['**Tipo:**', '**Comando', '**Precondiciones:**', '**Impacto:**', '**Verificación', '**Si falla:**']) {
        expect(op.body, `${op.id} ${field}`).toContain(field)
      }
      expect(op.body, op.id).toMatch(/\*\*Tipo:\*\* (Solo lectura|Mutación — requiere autorización)/)
    }
  })

  it('las mutaciones están separadas de las lecturas y ninguna está autorizada por el documento', () => {
    const mutations = ops.filter((o) => o.body.includes('**Tipo:** Mutación'))
    const reads = ops.filter((o) => o.body.includes('**Tipo:** Solo lectura'))
    expect(mutations.length).toBeGreaterThanOrEqual(5)
    expect(reads.length).toBeGreaterThanOrEqual(2)
    for (const op of mutations) expect(op.body, op.id).toMatch(/Estado:\*\* Pendiente de autorización/)
    // Las lecturas no contienen comandos que cambien nada.
    for (const op of reads) {
      expect(op.body, op.id).not.toMatch(/\b(create|set-cleanup-policies --|add-iam-policy-binding|services enable|versions add|--apply)\b/)
    }
  })

  it('la política de limpieza se verifica antes de permitir el primer build (doc y runbook)', () => {
    const c1v = doc.indexOf('limpieza-artifact-v1-6.sh --check')
    expect(c1v).toBeGreaterThan(0)
    expect(doc).toMatch(/[Bb]loqueo antes del primer build/)
    const check = runbook.indexOf('limpieza-artifact-v1-6.sh --check')
    expect(check).toBeGreaterThan(0)
    expect(check).toBeLessThan(runbook.indexOf('gcloud builds submit web'))
    expect(check).toBeLessThan(runbook.indexOf('docker push'))
  })

  it('los secretos se crean sin valores en el documento, con entrada oculta y acceso solo para la cuenta runtime', () => {
    for (const s of ['project-os-nextauth-secret', 'project-os-google-client-secret', 'project-os-allowed-emails']) expect(doc).toContain(s)
    expect(doc).toContain('read -r -s')
    expect(doc).toContain('--member="serviceAccount:${RUNTIME_SA}" --role=roles/secretmanager.secretAccessor')
    expect(doc).not.toMatch(/gcloud secrets versions access [^|\n]*$/m)
    expect(doc).not.toMatch(/--data-file=(?!-)/)
  })

  it('el runbook distingue recursos existentes, pendientes y acciones que requieren autorización', () => {
    for (const label of ['Existente (Puerta B)', 'Pendiente', 'Requiere autorización']) expect(runbook, label).toContain(label)
    expect(runbook).toContain('[Puerta C](puerta-c-v1-6.md)')
  })
})
