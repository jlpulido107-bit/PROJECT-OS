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
             {"logName":"projects/p/logs/run.googleapis.com%2Frequests","severity":"WARNING","timestamp":"2026-10-11T03:04:05Z","httpRequest":{"status":404,"requestUrl":"https://x.run.app/wp-login.php?u=x&code=SECRETO"}},
             {"logName":"projects/p/logs/run.googleapis.com%2Fstderr","severity":"ERROR","textPayload":"[project-os] usuario.fuga@correo-falso.test token=TOKEN-FUGA-1"},
             {"logName":"projects/p/logs/run.googleapis.com%2Fstderr","severity":"ERROR","textPayload":"[project-os] operación rechazada: titular.fuga@correo-falso.test"},
             {"logName":"projects/p/logs/run.googleapis.com%2Fstderr","severity":"WARNING","textPayload":"[next-auth][warn][NO_SECRET] cuenta.fuga@correo-falso.test"},
             {"logName":"projects/p/logs/run.googleapis.com%2Frequests","severity":"WARNING","timestamp":"2026-10-11T04:00:00Z","httpRequest":{"status":404,"requestUrl":"https://x.run.app/usuarios/ruta.fuga@dominio.test?token=TOKEN-FUGA-2"}},
             {"logName":"projects/p/logs/run.googleapis.com%2Frequests","severity":"WARNING","timestamp":"2026-10-11T04:00:00Z","httpRequest":{"status":404,"requestUrl":"https://x.run.app/reset/TOKEN-FUGA-3"}},
             {"logName":"projects/p/logs/run.googleapis.com%2Frequests","severity":"WARNING","timestamp":"2026-10-11T04:00:00Z","httpRequest":{"status":400,"requestUrl":"https://x.run.app/api/auth/callback/google?code=CODIGO-FUGA&state=ESTADO-FUGA"}},
             {"logName":"projects/p/logs/run.googleapis.com%2Frequests","severity":"WARNING","timestamp":"2026-10-11T04:00:00Z","httpRequest":{"status":404,"requestUrl":"https://x.run.app/proyectos/id.fuga@correo-falso.test"}},
             {"logName":"projects/p/logs/run.googleapis.com%2Frequests","severity":"sev.fuga@correo-falso.test","timestamp":"fecha.fuga@correo-falso.test","httpRequest":{"status":"estado.fuga@correo-falso.test","requestUrl":"/"}},
             {"logName":"projects/p/logs/log.fuga%40correo-falso.test","severity":"WARNING","textPayload":"texto libre"}]'
    elif [[ "$3" == *'"@"'* ]]; then
      for i in 1 2 3; do echo 'projects/project-os-511102/logs/cloudaudit.googleapis.com%2Factivity'; done
      echo 'projects/project-os-511102/logs/nombre.fuga%40correo-falso.test'
    elif [[ "$3" == *'"code="'* ]]; then
      echo 'projects/project-os-511102/logs/run.googleapis.com%2Frequests'
    fi ;;
  "run services describe")
    MAX=3; hecho 'run services update' && MAX=1
    REV=project-os-dashboard-00001-gsk; [[ -n "$FAKE_NUEVA_REVISION" ]] && hecho 'run services update' && REV=project-os-dashboard-00002-xyz
    printf '{"metadata":{"annotations":{"run.googleapis.com/maxScale":"%s"}},"spec":{"template":{"metadata":{"annotations":{"autoscaling.knative.dev/maxScale":"%s","autoscaling.knative.dev/minScale":"0"}},"spec":{"containers":[{"env":[{"name":"NEXTAUTH_URL","value":"VALOR-NO-DEBE-SALIR"},{"name":"NEXTAUTH_SECRET","valueFrom":{"secretKeyRef":{"name":"project-os-nextauth-secret","key":"1"}}},{"name":"GOOGLE_CLIENT_SECRET","valueFrom":{"secretKeyRef":{"key":"%s","name":"project-os-google-client-secret"}}},{"name":"AUTH_ALLOWED_EMAILS","valueFrom":{"secretKeyRef":{"name":"project-os-allowed-emails","key":"1"}}}]}]}}},"status":{"latestReadyRevisionName":"%s","traffic":[{"revisionName":"%s","percent":100}]}}\n' \
      "$MAX" "\${FAKE_REV_MAX:-1}" "\${FAKE_FIJADA_CLIENTE:-2}" "$REV" "$REV" ;;
  "secrets versions list")
    # JSON real de Secret Manager: «name» es la ruta completa. FAKE_NOMBRE_RARO simula un nombre no reconocible.
    V="projects/123/secrets/$4/versions"
    if [[ -n "$FAKE_NOMBRE_RARO" ]]; then echo '[{"name":"desconocido","state":"ENABLED"}]'
    elif [[ "$4" == project-os-google-client-secret ]]; then
      if hecho 'versions destroy 1 --secret=project-os-google-client-secret'; then S1=DESTROYED
      elif hecho 'versions disable 1 --secret=project-os-google-client-secret'; then S1=DISABLED
      else S1=ENABLED; fi
      # La versión 3 es DISABLED ajena a la remediación (histórica o de recuperación): nunca debe destruirse.
      printf '[{"name":"%s/2","state":"ENABLED"},{"name":"%s/1","state":"%s"},{"name":"%s/3","state":"DISABLED"}]\n' "$V" "$V" "$S1" "$V"
    else printf '[{"name":"%s/1","state":"ENABLED"}]\n' "$V"; fi ;;
  "secrets versions disable"|"secrets versions destroy"|"run services update") ;;
  "logging sinks describe")
    # FAKE_SINK: (vacío) ausente hasta el update y luego correcta; distinta/deshabilitada desde el inicio; rota = tras
    # el update queda con otro filtro. FAKE_FILTRO es el filtro esperado, ya codificado como cadena JSON.
    ex() { printf '{"name":"_Default","exclusions":[{"name":"project-os-callback-oauth","filter":%s,"disabled":%s}]}\n' "$1" "$2"; }
    case "\${FAKE_SINK:-}" in
      distinta) ex '"logName:\"otro\""' false ;;
      deshabilitada) ex "$FAKE_FILTRO" true ;;
      rota) if hecho 'logging sinks update'; then ex '"logName:\"otro\""' false; else echo '{"name":"_Default"}'; fi ;;
      *) if hecho 'logging sinks update'; then ex "$FAKE_FILTRO" false; else echo '{"name":"_Default"}'; fi ;;
    esac ;;
  "logging sinks update") ;;
  *) echo "gcloud falso: llamada no prevista: $*" >&2; exit 97 ;;
esac
`.replaceAll('\\$', '$'))
chmodSync(path.join(dir, 'gcloud'), 0o755)

const FILTRO = 'logName:"run.googleapis.com%2Frequests" AND resource.labels.service_name:"project-os-dashboard" AND httpRequest.requestUrl:"/api/auth/callback/google"'

function run(modo: string | string[], input: string | null = '', extra: Record<string, string> = {}, limpiar = true) {
  if (limpiar) writeFileSync(log, '')
  const r = spawnSync('bash', [SCRIPT, ...(Array.isArray(modo) ? modo : modo ? [modo] : [])], {
    input: input ?? undefined, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'], encoding: 'utf8',
    env: { PATH: `${dir}:/usr/bin:/bin`, FAKE_LOG: log, FAKE_FILTRO: JSON.stringify(FILTRO), ...extra } as unknown as NodeJS.ProcessEnv,
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
    for (const frase of ['AUTORIZO DESHABILITAR VERSIONES', 'AUTORIZO DESTRUIR VERSION TRAS VERIFICAR EL LOGIN', 'AUTORIZO MAX SERVICIO 1', 'AUTORIZO EXCLUIR CALLBACK OAUTH DE LOS LOGS']) {
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

  it('E1: un nombre de log fuera de la lista cerrada se omite (R1-1)', () => {
    expect(r.stdout).toMatch(/1 {2}\[log-omitido\] {2}\[otro\]/)
    expect(r.salida).not.toContain('nombre.fuga')
  })

  it('E2: agrupa por código sin mostrar texto libre, correos ni URLs', () => {
    expect(r.stdout).toContain('[project-os] Configuración inválida')
    expect(r.stdout).toContain('(otro; no se muestra)')
    for (const prohibido of ['persona.ficticia', 'SHEETS_CREDENTIALS', 'u=x', 'SECRETO', 'texto libre', 'VALOR-NO-DEBE-SALIR']) expect(r.salida).not.toContain(prohibido)
  })

  it('E2: vocabulario cerrado — correo, token y query incrustados en textPayload o en la ruta nunca salen (R1-1)', () => {
    // textPayload: sin categoría conocida → marcador; con categoría conocida → solo la categoría.
    expect(r.stdout).toContain('[project-os] (categoría no reconocida; no se muestra)')
    expect(r.stdout).toContain('[project-os] operación rechazada (')
    expect(r.stdout).toContain('[next-auth][warn][NO_SECRET] (')
    // Rutas: solo las de la lista fija o sus plantillas; cualquier otra → [ruta-omitida]; nunca la query.
    expect(r.stdout).toContain('petición HTTP 404 [ruta-omitida] (2026-10-11)')
    expect(r.stdout).toContain('petición HTTP 400 /api/auth/callback/google (2026-10-11)')
    expect(r.stdout).toContain('petición HTTP 404 /proyectos/[id] (2026-10-11)')
    expect(r.stdout).not.toContain('wp-login')
    // Severidad, estado y día fuera de formato → «?»; log desconocido → [log-omitido].
    expect(r.stdout).toContain('?        run.googleapis.com/requests  petición HTTP ? / (?)')
    expect(r.stdout).toMatch(/WARNING +\[log-omitido\] {2}\(otro; no se muestra\)/)
    // «code=» sí aparece en la cabecera «Patrón «code=»» del script; aquí se busca como parámetro de query.
    expect(r.salida).not.toMatch(/fuga|TOKEN|CODIGO|ESTADO-|@correo|@dominio|token=|[?&]code=|state=|\/usuarios|\/reset/)
  })

  it('A6: señala la versión ENABLED no fijada de google-client-secret', () => {
    expect(r.stdout).toContain('project-os-google-client-secret: fijada=2; ENABLED=[2 1]; ENABLED_no_fijadas=[1]')
    expect(r.stdout).toContain('project-os-nextauth-secret: fijada=1; ENABLED=[1]; ENABLED_no_fijadas=[]')
  })

  it('A6: lee el JSON real (ruta completa) sin depender de transformaciones de --format', () => {
    expect(text).toContain("secrets versions list \"$1\" --project=\"$PROJECT_ID\" --format=json | py versiones")
    expect(text).not.toMatch(/basename\(\),state\)'/)
  })

  it('A6: un nombre de versión no reconocible se declara ilegible, no como «sin versiones»', () => {
    const x = run('', '', { FAKE_NOMBRE_RARO: '1' })
    expect(x.stdout).toContain('project-os-nextauth-secret: VERSIONES_ILEGIBLES')
    const y = run('deshabilitar-sobrantes', 'AUTORIZO DESHABILITAR VERSIONES\n', { FAKE_NOMBRE_RARO: '1' })
    expect(y.status).toBe(1)
    expect(y.stderr).toContain('versiones ilegibles')
    expect(y.mutaciones).toEqual([])
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

  it('la confirmación tolera espacios al pegar, pero no frases incompletas o con erratas', () => {
    expect(run('alinear-max-servicio', '  AUTORIZO MAX SERVICIO 1   \n').mutaciones).toHaveLength(1)
    for (const mala of ['AUTORIZO MAX SERVICIO\n', 'AUTORIZO MAX SERVICIO 1 X\n', 'autorizo max servicio 1\n']) {
      const r = run('alinear-max-servicio', mala)
      expect(r.mutaciones, mala).toEqual([])
      expect(r.stdout).toContain('la frase no coincide')
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

  const DESTRUIR = 'AUTORIZO DESTRUIR VERSION TRAS VERIFICAR EL LOGIN\n'
  const CLIENTE = 'project-os-google-client-secret'

  it('el modo antiguo que barría todas las DISABLED ya no existe (R1-2)', () => {
    expect(text).not.toContain('destruir-deshabilitadas')
    const r = run('destruir-deshabilitadas', DESTRUIR)
    expect(r.status).toBe(2)
    expect(r.mutaciones).toEqual([])
  })

  it('deshabilitar-sobrantes: indica el comando exacto de destrucción para cada versión deshabilitada', () => {
    const r = run('deshabilitar-sobrantes', 'AUTORIZO DESHABILITAR VERSIONES\n')
    expect(r.stdout).toContain(`destruir-version ${CLIENTE} 1`)
    expect(r.stdout).not.toContain(`destruir-version ${CLIENTE} 3`)
  })

  it('destruir-version: destruye SOLO el par indicado; la versión DISABLED ajena (3) no se toca (R1-2)', () => {
    run('deshabilitar-sobrantes', 'AUTORIZO DESHABILITAR VERSIONES\n')
    const r = run(['destruir-version', CLIENTE, '1'], DESTRUIR, {}, false)
    expect(r.status).toBe(0)
    expect(r.mutaciones.filter((c) => c.includes('destroy'))).toEqual([`secrets versions destroy 1 --secret=${CLIENTE} --project=project-os-511102 --quiet --format=none`])
    expect(r.calls.join('\n')).not.toMatch(/versions destroy 3/)
    expect(r.stdout).toContain(`destruida: ${CLIENTE} versión 1`)
  })

  it('destruir-version: sin la frase exacta no destruye nada', () => {
    run('deshabilitar-sobrantes', 'AUTORIZO DESHABILITAR VERSIONES\n')
    for (const mala of ['AUTORIZO DESTRUIR VERSIONES TRAS VERIFICAR EL LOGIN\n', 'si\n', null]) {
      const r = run(['destruir-version', CLIENTE, '1'], mala, {}, false)
      expect(r.status).toBe(1)
      expect(r.calls.filter((c) => c.includes('destroy'))).toEqual([])
    }
  })

  it('destruir-version: rechaza la fijada, una no DISABLED, una inexistente, un secreto ajeno y argumentos mal formados', () => {
    const casos: [string[], RegExp][] = [
      [['destruir-version', CLIENTE, '2'], /es la FIJADA/],
      [['destruir-version', CLIENTE, '1'], /estado «ENABLED», no DISABLED/],
      [['destruir-version', CLIENTE, '9'], /estado «inexistente»/],
      [['destruir-version', 'otro-secreto', '1'], /secreto no reconocido/],
      [['destruir-version', CLIENTE, '1a'], /versión no numérica/],
      [['destruir-version', CLIENTE, '0'], /versión no numérica/],
    ]
    for (const [args, error] of casos) {
      const r = run(args, DESTRUIR)
      expect(r.status, args.join(' ')).toBe(1)
      expect(r.stderr, args.join(' ')).toMatch(error)
      expect(r.mutaciones, args.join(' ')).toEqual([])
    }
    for (const args of [['destruir-version'], ['destruir-version', CLIENTE], ['destruir-version', CLIENTE, '1', '3'], ['diagnostico', 'extra']]) {
      const r = run(args, DESTRUIR)
      expect(r.status, args.join(' ')).toBe(2)
      expect(r.calls, args.join(' ')).toEqual([])
    }
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
    expect(r.stdout).toContain('OK: exclusión project-os-callback-oauth activa, con el filtro esperado')
    expect(r.stdout).toContain('al sink _Default (solo ese sink)')
    const otra = run('excluir-callback-en-logs', 'AUTORIZO EXCLUIR CALLBACK OAUTH DE LOS LOGS\n', {}, false)
    expect(otra.stdout).toContain('ya existe con el filtro esperado y activa: nada que hacer')
    expect(otra.mutaciones).toHaveLength(1) // solo la del primer run: el log no se limpió entre ambos
  })

  it('excluir-callback-en-logs: el filtro que se añade es exactamente el que se verifica', () => {
    expect(text).toContain(`EXCLUSION_FILTER="${FILTRO.replaceAll('"', '\\"').replace('project-os-dashboard', '${SERVICE}')}"`)
  })

  it('excluir-callback-en-logs: con el mismo nombre pero otro filtro → NO_VERIFICADO, sin modificar (R1-3)', () => {
    const r = run('excluir-callback-en-logs', 'AUTORIZO EXCLUIR CALLBACK OAUTH DE LOS LOGS\n', { FAKE_SINK: 'distinta' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('DISTINTA')
    expect(r.stderr).toContain('NO_VERIFICADO')
    expect(r.mutaciones).toEqual([])
  })

  it('excluir-callback-en-logs: existente pero disabled=true → NO_VERIFICADO, sin modificar (R1-3)', () => {
    const r = run('excluir-callback-en-logs', 'AUTORIZO EXCLUIR CALLBACK OAUTH DE LOS LOGS\n', { FAKE_SINK: 'deshabilitada' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('DESHABILITADA')
    expect(r.stderr).toContain('NO_VERIFICADO')
    expect(r.mutaciones).toEqual([])
  })

  it('excluir-callback-en-logs: si tras añadirla no queda CORRECTA, no declara éxito (R1-3)', () => {
    const r = run('excluir-callback-en-logs', 'AUTORIZO EXCLUIR CALLBACK OAUTH DE LOS LOGS\n', { FAKE_SINK: 'rota' })
    expect(r.status).toBe(1)
    expect(r.mutaciones).toHaveLength(1)
    expect(r.stderr).toContain('NO_VERIFICADO')
    expect(r.stdout).not.toContain('OK: exclusión')
  })
})
