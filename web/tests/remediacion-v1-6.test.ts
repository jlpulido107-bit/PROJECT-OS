import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * Remediación de los hallazgos de la auditoría en Cloud Shell (E1, A6, A7/D-1). Se ejecuta el script real contra un
 * gcloud FALSO que simula el estado observado. El gcloud real (/usr/local/bin) no está en el PATH: nunca hay GCP.
 */
const SCRIPT = path.resolve(__dirname, '..', 'deploy', 'infra', 'remediacion-v1-6.sh')
const text = readFileSync(SCRIPT, 'utf8')
const dir = mkdtempSync(path.join(tmpdir(), 'remediacion-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const log = path.join(dir, 'llamadas.log')

// Estado simulado: el de la auditoría (servicio maxScale 3, versión 1 sobrante de google-client-secret fijada en 2,
// «@» en logs de auditoría y «code=» en el log de peticiones). Las mutaciones cambian el estado vía el log de llamadas.
writeFileSync(path.join(dir, 'gcloud'), String.raw`#!/bin/bash
printf '%s\n' "$*" >> "$FAKE_LOG"
hecho() { grep -q -- "$1" "$FAKE_LOG"; }
case "$1 $2 $3" in
  "logging read "*)
    if [[ "$*" == *"--format=json"* ]]; then
      echo '[{"logName":"projects/p/logs/run.googleapis.com%2Fstderr","severity":"WARNING","textPayload":"[project-os] Configuración inválida: SHEETS_CREDENTIALS"},
             {"logName":"projects/p/logs/run.googleapis.com%2Fstderr","severity":"WARNING","textPayload":"persona.ficticia@correo-falso.test texto libre"},
             {"logName":"projects/p/logs/run.googleapis.com%2Frequests","severity":"WARNING","httpRequest":{"status":404,"requestUrl":"/wp-login.php?u=x"}}]'
    elif [[ "$3" == *'"@"'* ]]; then
      for i in 1 2 3; do echo 'projects/project-os-511102/logs/cloudaudit.googleapis.com%2Factivity'; done
    elif [[ "$3" == *'"code="'* ]]; then
      echo 'projects/project-os-511102/logs/run.googleapis.com%2Frequests'
    fi ;;
  "run services describe")
    MAX=3; hecho 'run services update' && MAX=1
    REV=project-os-dashboard-00001-gsk; [[ -n "$FAKE_NUEVA_REVISION" ]] && hecho 'run services update' && REV=project-os-dashboard-00002-xyz
    printf '{"metadata":{"annotations":{"run.googleapis.com/maxScale":"%s"}},"spec":{"template":{"metadata":{"annotations":{"autoscaling.knative.dev/maxScale":"%s","autoscaling.knative.dev/minScale":"0"}},"spec":{"containers":[{"env":[{"name":"NEXTAUTH_URL","value":"VALOR-NO-DEBE-SALIR"},{"name":"NEXTAUTH_SECRET","valueFrom":{"secretKeyRef":{"name":"project-os-nextauth-secret","key":"1"}}},{"name":"GOOGLE_CLIENT_SECRET","valueFrom":{"secretKeyRef":{"key":"%s","name":"project-os-google-client-secret"}}},{"name":"AUTH_ALLOWED_EMAILS","valueFrom":{"secretKeyRef":{"name":"project-os-allowed-emails","key":"1"}}}]}]}}},"status":{"latestReadyRevisionName":"%s","traffic":[{"revisionName":"%s","percent":100}]}}\n' \
      "$MAX" "\${FAKE_REV_MAX:-1}" "\${FAKE_FIJADA_CLIENTE:-2}" "$REV" "$REV" ;;
  "secrets versions list")
    if [[ "$4" == project-os-google-client-secret ]]; then
      if hecho 'versions destroy 1 --secret=project-os-google-client-secret'; then printf '2\tENABLED\n1\tDESTROYED\n'
      elif hecho 'versions disable 1 --secret=project-os-google-client-secret'; then printf '2\tENABLED\n1\tDISABLED\n'
      else printf '2\tENABLED\n1\tENABLED\n'; fi
    else printf '1\tENABLED\n'; fi ;;
  "secrets versions disable"|"secrets versions destroy"|"run services update") ;;
  "logging sinks describe")
    if hecho 'logging sinks update'; then echo '{"name":"_Default","exclusions":[{"name":"project-os-callback-oauth"}]}'; else echo '{"name":"_Default"}'; fi ;;
  "logging sinks update") ;;
  *) echo "gcloud falso: llamada no prevista: $*" >&2; exit 97 ;;
esac
`.replaceAll('\\$', '$'))
chmodSync(path.join(dir, 'gcloud'), 0o755)

function run(modo: string, input: string | null = '', extra: Record<string, string> = {}, limpiar = true) {
  if (limpiar) writeFileSync(log, '')
  const r = spawnSync('bash', [SCRIPT, ...(modo ? [modo] : [])], {
    input: input ?? undefined, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'], encoding: 'utf8',
    env: { PATH: `${dir}:/usr/bin:/bin`, FAKE_LOG: log, ...extra } as unknown as NodeJS.ProcessEnv,
  })
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean)
  const mutaciones = calls.filter((c) => /versions (disable|destroy)|services update|sinks update/.test(c))
  return { ...r, salida: r.stdout + r.stderr, calls, mutaciones }
}

describe('remediación V1.6: controles estáticos', () => {
  it('toda llamada fija --project; nunca lee valores de secretos ni borra logs, servicios o secretos completos', () => {
    const lineas = text.split('\n').filter((l) => /^\s*(gcloud|\( set -o pipefail; gcloud|[a-z]+="\$\(gcloud)/.test(l.trim()) || /\bgcloud (run|secrets|logging)/.test(l))
    for (const l of lineas.filter((x) => !/^\s*(#|echo )/.test(x) && /gcloud (run|secrets|logging) /.test(x))) expect(l, l).toContain('--project="$PROJECT_ID"')
    expect(text).not.toMatch(/versions access|logs delete|secrets delete|services delete|sinks delete|--clear-exclusions|remove-iam|add-iam/)
  })

  it('cada mutación exige una frase de confirmación propia', () => {
    for (const frase of ['AUTORIZO DESHABILITAR VERSIONES', 'AUTORIZO DESTRUIR VERSIONES TRAS VERIFICAR EL LOGIN', 'AUTORIZO MAX SERVICIO 1', 'AUTORIZO EXCLUIR CALLBACK OAUTH DE LOS LOGS']) {
      expect(text).toContain(`confirm '${frase}'`)
    }
    expect(text).toContain('--max=1')
    expect(text).not.toContain('--max-instances')
  })
})

describe('remediación V1.6: diagnóstico (solo lectura, gcloud falso)', () => {
  const r = run('')

  it('no hace ninguna mutación y termina bien', () => {
    expect(r.status).toBe(0)
    expect(r.mutaciones).toEqual([])
    expect(r.stdout).toContain('no se modificó nada')
  })

  it('E1: clasifica por origen — «@» en auditoría, «code=» en el log de peticiones', () => {
    expect(r.stdout).toMatch(/3 {2}cloudaudit\.googleapis\.com\/activity {2}\[auditoría de Google/)
    expect(r.stdout).toMatch(/1 {2}run\.googleapis\.com\/requests {2}\[peticiones HTTP/)
    expect(r.stdout).not.toContain('SALIDA DE LA APP')
  })

  it('E2: agrupa por código sin mostrar texto libre, correos ni URLs', () => {
    expect(r.stdout).toContain('[project-os] Configuración inválida')
    expect(r.stdout).toContain('petición HTTP 404')
    expect(r.stdout).toContain('(otro; no se muestra)')
    for (const prohibido of ['persona.ficticia', 'SHEETS_CREDENTIALS', 'wp-login', 'texto libre', 'VALOR-NO-DEBE-SALIR']) expect(r.salida).not.toContain(prohibido)
  })

  it('A6: señala la versión ENABLED no fijada de google-client-secret', () => {
    expect(r.stdout).toContain('project-os-google-client-secret: fijada=2; ENABLED=[2 1]; ENABLED_no_fijadas=[1]')
    expect(r.stdout).toContain('project-os-nextauth-secret: fijada=1; ENABLED=[1]; ENABLED_no_fijadas=[]')
  })

  it('A7: muestra los dos límites y la revisión activa', () => {
    expect(r.stdout).toContain('servicio_maxScale 3')
    expect(r.stdout).toContain('revision_maxScale 1')
    expect(r.stdout).toContain('revision_activa project-os-dashboard-00001-gsk')
  })

  it('un modo desconocido no hace nada', () => {
    const x = run('borrar-todo')
    expect(x.status).toBe(2)
    expect(x.mutaciones).toEqual([])
  })
})

describe('remediación V1.6: mutaciones con confirmación (gcloud falso)', () => {
  it('deshabilitar-sobrantes: sin la frase exacta no cambia nada', () => {
    for (const input of ['si\n', '\n', null]) {
      const r = run('deshabilitar-sobrantes', input)
      expect(r.status).toBe(1)
      expect(r.mutaciones).toEqual([])
    }
  })

  it('deshabilitar-sobrantes: deshabilita SOLO la versión no fijada (1), nunca la fijada (2)', () => {
    const r = run('deshabilitar-sobrantes', 'AUTORIZO DESHABILITAR VERSIONES\n')
    expect(r.status).toBe(0)
    expect(r.mutaciones).toEqual(['secrets versions disable 1 --secret=project-os-google-client-secret --project=project-os-511102 --format=none'])
    expect(r.stdout).toContain('Verifica AHORA el login real')
  })

  it('deshabilitar-sobrantes: se detiene si la versión fijada no está ENABLED', () => {
    const r = run('deshabilitar-sobrantes', 'AUTORIZO DESHABILITAR VERSIONES\n', { FAKE_FIJADA_CLIENTE: '3' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('no está ENABLED')
    expect(r.mutaciones).toEqual([])
  })

  it('destruir-deshabilitadas: antes de deshabilitar no hay nada que destruir; después destruye solo la DISABLED no fijada', () => {
    expect(run('destruir-deshabilitadas', 'AUTORIZO DESTRUIR VERSIONES TRAS VERIFICAR EL LOGIN\n').mutaciones).toEqual([])
    run('deshabilitar-sobrantes', 'AUTORIZO DESHABILITAR VERSIONES\n')
    const r = run('destruir-deshabilitadas', 'AUTORIZO DESTRUIR VERSIONES TRAS VERIFICAR EL LOGIN\n', {}, false)
    expect(r.status).toBe(0)
    expect(r.mutaciones.filter((c) => c.includes('destroy'))).toEqual(['secrets versions destroy 1 --secret=project-os-google-client-secret --project=project-os-511102 --quiet --format=none'])
  })

  it('alinear-max-servicio: usa --max=1 (servicio) y confirma que la revisión no cambió', () => {
    const r = run('alinear-max-servicio', 'AUTORIZO MAX SERVICIO 1\n')
    expect(r.status).toBe(0)
    expect(r.mutaciones).toEqual(['run services update project-os-dashboard --project=project-os-511102 --region=northamerica-south1 --max=1 --format=none'])
    expect(r.stdout).toContain('OK: máximo de servicio 1, misma revisión activa')
  })

  it('alinear-max-servicio: avisa si apareció una revisión nueva', () => {
    const r = run('alinear-max-servicio', 'AUTORIZO MAX SERVICIO 1\n', { FAKE_NUEVA_REVISION: '1' })
    expect(r.stdout).toContain('AVISO: la revisión activa cambió')
  })

  it('alinear-max-servicio: no actúa si la revisión no tiene maxScale 1', () => {
    const r = run('alinear-max-servicio', 'AUTORIZO MAX SERVICIO 1\n', { FAKE_REV_MAX: '3' })
    expect(r.status).toBe(1)
    expect(r.mutaciones).toEqual([])
  })

  it('excluir-callback-en-logs: añade la exclusión del callback y la verifica; es idempotente', () => {
    const r = run('excluir-callback-en-logs', 'AUTORIZO EXCLUIR CALLBACK OAUTH DE LOS LOGS\n')
    expect(r.status).toBe(0)
    expect(r.mutaciones).toHaveLength(1)
    expect(r.mutaciones[0]).toContain('--add-exclusion=name=project-os-callback-oauth,')
    expect(r.mutaciones[0]).toContain('httpRequest.requestUrl:"/api/auth/callback/google"')
    // El filtro va dentro de clave=valor,…: no puede contener «=» ni «,».
    const filtro = /filter=(.*) --format=none$/.exec(r.mutaciones[0] ?? '')?.[1] ?? ''
    expect(filtro).not.toMatch(/[=,]/)
    expect(r.stdout).toContain('OK: exclusión project-os-callback-oauth activa')
    const otra = run('excluir-callback-en-logs', 'AUTORIZO EXCLUIR CALLBACK OAUTH DE LOS LOGS\n', {}, false)
    expect(otra.stdout).toContain('ya existe: nada que hacer')
  })
})
