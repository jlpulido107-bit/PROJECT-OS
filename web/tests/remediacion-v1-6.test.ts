import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * Remediación de los hallazgos de la auditoría en Cloud Shell (E1, A6, A7/D-1). Se ejecuta el script real contra un
 * gcloud FALSO (tests/helpers/gcloud-falso-remediacion.sh) que simula el estado observado. El gcloud real
 * (/usr/local/bin) no está en el PATH: nunca hay GCP. Revisiones R1 y R2 de ChatGPT (PR #24) y Misión 014 (A.2).
 */
const SCRIPT = path.resolve(__dirname, '..', 'deploy', 'infra', 'remediacion-v1-6.sh')
const FAKE = path.resolve(__dirname, 'helpers', 'gcloud-falso-remediacion.sh')
const text = readFileSync(SCRIPT, 'utf8')
const dir = mkdtempSync(path.join(tmpdir(), 'remediacion-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const log = path.join(dir, 'llamadas.log')
copyFileSync(FAKE, path.join(dir, 'gcloud'))
chmodSync(path.join(dir, 'gcloud'), 0o755)

const FILTRO = 'logName:"run.googleapis.com%2Frequests" AND resource.labels.service_name:"project-os-dashboard" AND httpRequest.requestUrl:"/api/auth/callback/google"'
const CLIENTE = 'project-os-google-client-secret'
const FRASE = {
  deshabilitar: 'AUTORIZO DESHABILITAR VERSIONES\n',
  destruir: 'AUTORIZO DESTRUIR VERSION TRAS VERIFICAR EL LOGIN\n',
  max: 'AUTORIZO MAX SERVICIO 1\n',
  excluir: 'AUTORIZO EXCLUIR CALLBACK OAUTH DE LOS LOGS\n',
}
const MUTACION = /^(secrets versions (disable|destroy)|run services update|logging sinks update)/

/** Ejecuta el script. `limpiar = false` conserva el estado simulado de ejecuciones anteriores (p. ej. una versión ya deshabilitada). */
function run(modo: string | string[], input: string | null = '', extra: Record<string, string> = {}, limpiar = true, PATH = `${dir}:/usr/bin:/bin`) {
  if (limpiar) writeFileSync(log, '')
  appendFileSync(log, '--- run\n')
  const r = spawnSync('bash', [SCRIPT, ...(Array.isArray(modo) ? modo : modo ? [modo] : [])], {
    input: input ?? undefined, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'], encoding: 'utf8',
    env: { PATH, FAKE_LOG: log, FAKE_FILTRO: JSON.stringify(FILTRO), ...extra } as unknown as NodeJS.ProcessEnv,
  })
  const lineas = readFileSync(log, 'utf8').split('\n')
  const calls = lineas.slice(lineas.lastIndexOf('--- run') + 1).filter(Boolean) // solo las de ESTA ejecución
  return {
    ...r, salida: r.stdout + r.stderr, calls,
    mutaciones: calls.filter((c) => MUTACION.test(c)), // efectivas (las rechazadas por la API se registran aparte)
    rechazadas: calls.filter((c) => c.startsWith('RECHAZADA ')),
  }
}
/** Lo que el script nunca debe imprimir: datos de los fixtures, trazas de Python ni correos de los errores del SDK. */
const sinFugas = (salida: string) => {
  for (const prohibido of ['fuga', 'persona.ficticia', 'SHEETS_CREDENTIALS', 'texto libre', 'VALOR-NO-DEBE-SALIR', 'Traceback', 'e1-ENABLED', 'e1-DISABLED']) {
    expect(salida, prohibido).not.toContain(prohibido)
  }
}
/** Líneas de una sección del diagnóstico: desde el encabezado indicado hasta el siguiente encabezado. */
const seccion = (salida: string, encabezado: string) => {
  const lineas = salida.split('\n')
  const i = lineas.findIndex((l) => l.startsWith(encabezado))
  expect(i, encabezado).toBeGreaterThan(-1)
  const fin = lineas.findIndex((l, j) => j > i && /^(Patrón|Exclusión|== |Diagnóstico)/.test(l))
  return lineas.slice(i + 1, fin === -1 ? undefined : fin).filter((l) => l.trim() !== '')
}

describe('remediación V1.6: controles estáticos', () => {
  it('toda llamada fija --project; nunca lee valores de secretos ni borra logs, servicios o secretos completos', () => {
    const lineas = text.split('\n').filter((l) => /\bgcloud (run|secrets|logging) /.test(l) && !/^\s*(#|echo )/.test(l))
    expect(lineas.length).toBeGreaterThanOrEqual(10)
    for (const l of lineas) expect(l, l).toContain('--project="$PROJECT_ID"')
    // «versions enable» solo aparece en un mensaje que indica al propietario cómo revertir a mano.
    expect(text.replaceAll('«versions enable»', '')).not.toMatch(/versions access|versions enable|logs delete|secrets delete|services delete|sinks delete|--clear-exclusions|remove-iam|add-iam|set-iam/)
  })

  it('cada mutación exige una frase de confirmación propia; --max (servicio) y nunca --max-instances', () => {
    for (const frase of Object.values(FRASE)) expect(text).toContain(`confirm '${frase.trim()}'`)
    expect(text).toContain('--max=1')
    expect(text).not.toContain('--max-instances')
  })

  it('las mutaciones de secretos son condicionales (--etag de la última lectura) y se verifican después', () => {
    expect(text).toMatch(/gcloud secrets versions disable "\$n" --secret="\$s" --etag="\$etag"/)
    expect(text).toMatch(/gcloud secrets versions destroy "\$n" --secret="\$s" --etag="\$etag"/)
    expect(text).toContain('deshabilitada (verificado)')
    expect(text).toContain('destruida (verificado)')
  })

  it('sin el EJECUTABLE gcloud se detiene: la función gcloud() del script no lo enmascara', () => {
    const r = run('', '', {}, true, '/usr/bin:/bin')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('gcloud no disponible')
    expect(r.calls).toEqual([])
  })

  it('un modo desconocido o argumentos de más no hacen nada (código 2)', () => {
    for (const args of [['borrar-todo'], ['diagnostico', 'extra'], ['alinear-max-servicio', '1']]) {
      const x = run(args)
      expect(x.status, args.join(' ')).toBe(2)
      expect(x.calls, args.join(' ')).toEqual([])
    }
  })
})

describe('remediación V1.6: diagnóstico (solo lectura, gcloud falso)', () => {
  const r = run('')

  it('no hace ninguna mutación y termina bien', () => {
    expect(r.status).toBe(0)
    expect(r.mutaciones).toEqual([])
    expect(r.calls.every((c) => /^(logging read|logging sinks describe|run services describe|secrets versions list) /.test(c)), r.calls.join('\n')).toBe(true)
    expect(r.stdout).toContain('no se modificó nada')
    sinFugas(r.salida)
  })

  it('E1: clasifica por origen los 4 patrones — «@» en auditoría, «code=» en peticiones, «ya29.» y «Bearer » en 0', () => {
    expect(r.stdout).toMatch(/3 {2}cloudaudit\.googleapis\.com\/activity {2}\[auditoría de Google/)
    expect(r.stdout).toMatch(/1 {2}run\.googleapis\.com\/requests {2}\[peticiones HTTP/)
    expect(seccion(r.stdout, 'Patrón «ya29.»')).toEqual(['      0  (sin coincidencias)'])
    expect(seccion(r.stdout, 'Patrón «Bearer »')).toEqual(['      0  (sin coincidencias)'])
    expect(r.stdout).not.toContain('SALIDA DE LA APP')
  })

  it('E1: un nombre de log fuera de la lista cerrada se omite (R1-1)', () => {
    expect(r.stdout).toMatch(/1 {2}\[log-omitido\] {2}\[otro\]/)
  })

  it('E1: muestra el estado de la exclusión del callback en _Default, de solo lectura (aquí, ausente → NO_VERIFICADO)', () => {
    expect(seccion(r.stdout, 'Exclusión «project-os-callback-oauth»')).toEqual(['  estado: AUSENTE → NO_VERIFICADO: revisar en la consola (no se corrige automáticamente)'])
    expect(r.stdout).toContain('solo el sink _Default; no cubre otros sinks ni registros ya guardados')
  })

  it.each([
    ['distinta', 'DISTINTA → NO_VERIFICADO'],
    ['deshabilitada', 'DESHABILITADA → NO_VERIFICADO'],
  ])('E1: exclusión %s → %s, sin modificarla', (sink, esperado) => {
    const x = run('', '', { FAKE_SINK: sink })
    expect(x.stdout).toContain(`estado: ${esperado}`)
    expect(x.mutaciones).toEqual([])
  })

  it('E1: exclusión correcta (nombre, filtro y activa) → CORRECTA', () => {
    run('excluir-callback-en-logs', FRASE.excluir)
    const x = run('', '', {}, false)
    expect(x.stdout).toContain('estado: CORRECTA (nombre, filtro esperado y activa)')
    expect(x.mutaciones).toEqual([])
  })

  it('E2: lee también las líneas [project-os] de CUALQUIER severidad (console.warn/error puede no llevar nivel)', () => {
    const e2 = r.calls.find((c) => c.startsWith('logging read') && c.includes('--format=json')) ?? ''
    expect(e2).toContain('(severity>=WARNING OR textPayload:"[project-os]")')
  })

  it('E2: agrupa por código sin mostrar texto libre, correos ni URLs', () => {
    expect(r.stdout).toContain('[project-os] Configuración inválida')
    expect(r.stdout).toContain('(otro; no se muestra)')
    for (const prohibido of ['u=x', 'SECRETO', 'wp-login']) expect(r.salida).not.toContain(prohibido)
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
    // Severidad, estado y día fuera de formato → «?»; log desconocido → [log-omitido].
    expect(r.stdout).toContain('?        run.googleapis.com/requests  petición HTTP ? / (?)')
    expect(r.stdout).toMatch(/WARNING +\[log-omitido\] {2}\(otro; no se muestra\)/)
    // «code=» sí aparece en la cabecera «Patrón «code=»» del script; aquí se busca como parámetro de query.
    expect(r.salida).not.toMatch(/TOKEN|CODIGO|ESTADO-|@correo|@dominio|token=|[?&]code=|state=|\/usuarios|\/reset/)
  })

  it('A6: señala la versión ENABLED no fijada y lista todos los estados (también la DISABLED ajena)', () => {
    expect(r.stdout).toContain(`${CLIENTE}: fijada=2; ENABLED=[2 1]; ENABLED_no_fijadas=[1]; estados=[2:ENABLED 1:ENABLED 3:DISABLED]`)
    expect(r.stdout).toContain('project-os-nextauth-secret: fijada=1; ENABLED=[1]; ENABLED_no_fijadas=[]; estados=[1:ENABLED]')
  })

  it('A6: lee el JSON real (ruta completa) sin depender de transformaciones de --format', () => {
    expect(text).toContain("secrets versions list \"$1\" --project=\"$PROJECT_ID\" --format=json | py versiones")
    expect(text).not.toMatch(/basename\(\),state\)'/)
  })

  it('A6: un nombre de versión no reconocible se declara ilegible (diagnóstico incompleto, código 3) y nunca se muta', () => {
    const x = run('', '', { FAKE_NOMBRE_RARO: '1' })
    expect(x.stdout).toContain('project-os-nextauth-secret: VERSIONES_ILEGIBLES')
    expect(x.status).toBe(3)
    const y = run('deshabilitar-sobrantes', FRASE.deshabilitar, { FAKE_NOMBRE_RARO: '1' })
    expect(y.status).toBe(1)
    expect(y.stderr).toContain('versiones ilegibles')
    expect(y.mutaciones).toEqual([])
  })

  it('A7: muestra los dos límites, la revisión activa y si el tráfico es de una sola revisión', () => {
    for (const l of ['servicio_maxScale 3', 'revision_maxScale 1', 'revision_activa project-os-dashboard-00001-gsk', 'trafico_unico SI']) expect(r.stdout).toContain(l)
    expect(run('', '', { FAKE_TRAFICO: 'repartido' }).stdout).toContain('trafico_unico NO (TRAFICO_EN_VARIAS_REVISIONES)')
  })

  // ---- A.2: ausencia de permisos, resultados vacíos, JSON inválido y fallas de consulta: nunca un «0» ni un OK ----
  it.each([
    ['permiso denegado en E1 «@»', { FAKE_FALLA: 'logging read .*"@"' }, 'Patrón «@»'],
    ['permiso denegado en E1 «code=»', { FAKE_FALLA: 'logging read .*"code="' }, 'Patrón «code=»'],
    ['permiso denegado en la exclusión', { FAKE_FALLA: 'logging sinks describe' }, 'Exclusión «project-os-callback-oauth»'],
    ['JSON inválido en la exclusión', { FAKE_INVALIDO: 'logging sinks describe' }, 'Exclusión «project-os-callback-oauth»'],
    ['permiso denegado en E2', { FAKE_FALLA: 'logging read .*severity' }, '== E2'],
    ['JSON inválido en E2', { FAKE_INVALIDO: 'logging read .*severity' }, '== E2'],
    ['respuesta vacía en E2', { FAKE_VACIO: 'logging read .*severity' }, '== E2'],
  ])('%s → LECTURA_FALLIDA en su sección, sin «0», y diagnóstico INCOMPLETO (código 3)', (_n, extra, encabezado) => {
    const x = run('', '', extra)
    const lineas = seccion(x.stdout, encabezado)
    expect(lineas).toEqual(['  LECTURA_FALLIDA (no es un 0: repetir la lectura)'])
    expect(x.status).toBe(3)
    expect(x.stdout).toContain('Diagnóstico INCOMPLETO: 1 lectura(s) fallaron → NO_VERIFICADO')
    expect(x.stdout).not.toContain('Comparte solo estas líneas')
    expect(x.mutaciones).toEqual([])
    sinFugas(x.salida)
  })

  it.each([
    ['permiso denegado en el servicio', { FAKE_FALLA: 'run services describe' }, '== A6 y A7: LECTURA_FALLIDA'],
    ['JSON inválido del servicio', { FAKE_INVALIDO: 'run services describe' }, '== A6 y A7: LECTURA_FALLIDA'],
    ['servicio vacío', { FAKE_VACIO: 'run services describe' }, '== A6 y A7: LECTURA_FALLIDA'],
    ['permiso denegado en las versiones de un secreto', { FAKE_FALLA: 'secrets versions list project-os-allowed-emails' }, '  project-os-allowed-emails: LECTURA_FALLIDA'],
    ['JSON inválido en las versiones de un secreto', { FAKE_INVALIDO: 'secrets versions list project-os-allowed-emails' }, '  project-os-allowed-emails: LECTURA_FALLIDA'],
  ])('%s → %s y código 3', (_n, extra, esperado) => {
    const x = run('', '', extra)
    expect(x.stdout).toContain(esperado)
    expect(x.status).toBe(3)
    expect(x.stdout).toContain('Diagnóstico INCOMPLETO')
    sinFugas(x.salida)
  })

  it('los errores del SDK salen sin el correo de la persona', () => {
    const x = run('', '', { FAKE_FALLA: 'logging read .*"@"' })
    expect(x.stderr).toContain('PERMISSION_DENIED: ***@***')
    expect(x.salida).not.toContain('persona.fuga')
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
    expect(run('alinear-max-servicio', `  ${FRASE.max.trim()}   \n`).mutaciones).toHaveLength(1)
    for (const mala of ['AUTORIZO MAX SERVICIO\n', 'AUTORIZO MAX SERVICIO 1 X\n', 'autorizo max servicio 1\n']) {
      const r = run('alinear-max-servicio', mala)
      expect(r.mutaciones, mala).toEqual([])
      expect(r.stdout).toContain('la frase no coincide')
    }
    for (const mala of ['AUTORIZO EXCLUIR CALLBACK OAUTH\n', 'AUTORIZO EXCLUIR CALLBACK OAUTH DE LOS LOG\n']) {
      expect(run('excluir-callback-en-logs', mala).mutaciones, mala).toEqual([])
    }
  })

  it('deshabilitar-sobrantes: deshabilita SOLO la versión no fijada (1), con su etag, y lo verifica', () => {
    const r = run('deshabilitar-sobrantes', FRASE.deshabilitar)
    expect(r.status).toBe(0)
    expect(r.mutaciones).toEqual([`secrets versions disable 1 --secret=${CLIENTE} --etag="e1-ENABLED" --project=project-os-511102 --format=none`])
    expect(r.stdout).toContain(`deshabilitada (verificado): ${CLIENTE} versión 1`)
    expect(r.stdout).toContain('Verifica AHORA el login real')
    sinFugas(r.salida.replace(/--etag="e1-ENABLED"/g, ''))
  })

  it('deshabilitar-sobrantes: se detiene si la versión fijada no está ENABLED', () => {
    const r = run('deshabilitar-sobrantes', FRASE.deshabilitar, { FAKE_FIJADA_CLIENTE: '3' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('no está ENABLED')
    expect(r.mutaciones).toEqual([])
  })

  it('deshabilitar-sobrantes: indica el comando exacto de destrucción para cada versión deshabilitada', () => {
    const r = run('deshabilitar-sobrantes', FRASE.deshabilitar)
    expect(r.stdout).toContain(`destruir-version ${CLIENTE} 1`)
    expect(r.stdout).not.toContain(`destruir-version ${CLIENTE} 3`)
  })

  it('el modo antiguo que barría todas las DISABLED ya no existe (R1-2)', () => {
    expect(text).not.toContain('destruir-deshabilitadas')
    const r = run('destruir-deshabilitadas', FRASE.destruir)
    expect(r.status).toBe(2)
    expect(r.mutaciones).toEqual([])
  })

  it('destruir-version: destruye SOLO el par indicado, con su etag; la versión DISABLED ajena (3) no se toca (R1-2)', () => {
    run('deshabilitar-sobrantes', FRASE.deshabilitar)
    const r = run(['destruir-version', CLIENTE, '1'], FRASE.destruir, {}, false)
    expect(r.status).toBe(0)
    expect(r.mutaciones).toEqual([`secrets versions destroy 1 --secret=${CLIENTE} --etag="e1-DISABLED" --project=project-os-511102 --quiet --format=none`])
    expect(r.calls.join('\n')).not.toMatch(/versions destroy 3/)
    expect(r.stdout).toContain(`destruida (verificado): ${CLIENTE} versión 1`)
  })

  it('destruir-version: con TTL de destrucción del secreto, informa la destrucción PROGRAMADA y no repite', () => {
    run('deshabilitar-sobrantes', FRASE.deshabilitar)
    const r = run(['destruir-version', CLIENTE, '1'], FRASE.destruir, { FAKE_TTL: '1' }, false)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain(`destrucción PROGRAMADA (verificado): ${CLIENTE} versión 1`)
    const otra = run(['destruir-version', CLIENTE, '1'], FRASE.destruir, { FAKE_TTL: '1' }, false)
    expect(otra.status).toBe(1)
    expect(otra.stderr).toContain('ya tiene una destrucción programada')
    expect(otra.mutaciones).toEqual([])
  })

  it('destruir-version: sin la frase exacta no destruye nada', () => {
    run('deshabilitar-sobrantes', FRASE.deshabilitar)
    for (const mala of ['AUTORIZO DESTRUIR VERSIONES TRAS VERIFICAR EL LOGIN\n', 'si\n', null]) {
      const r = run(['destruir-version', CLIENTE, '1'], mala, {}, false)
      expect(r.status).toBe(1)
      expect(r.mutaciones).toEqual([])
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
      const r = run(args, FRASE.destruir)
      expect(r.status, args.join(' ')).toBe(1)
      expect(r.stderr, args.join(' ')).toMatch(error)
      expect(r.mutaciones, args.join(' ')).toEqual([])
    }
    for (const args of [['destruir-version'], ['destruir-version', CLIENTE], ['destruir-version', CLIENTE, '1', '3']]) {
      const r = run(args, FRASE.destruir)
      expect(r.status, args.join(' ')).toBe(2)
      expect(r.calls, args.join(' ')).toEqual([])
    }
  })

  it.each([
    ['otros', 'un lector más'],
    ['condicion', 'una condición IAM'],
  ])('destruir-version: el secreto con %s (%s) → no destruye: otro consumidor podría usar la versión', (iam) => {
    run('deshabilitar-sobrantes', FRASE.deshabilitar)
    const r = run(['destruir-version', CLIENTE, '1'], FRASE.destruir, { FAKE_IAM: iam }, false)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('lectores distintos de la cuenta del servicio')
    expect(r.mutaciones).toEqual([])
    expect(r.stdout).not.toContain('Se DESTRUIRÁ') // se detiene antes de pedir la frase
    sinFugas(r.salida)
  })

  // ---- R2-1 y A.2: el servicio cambia entre el plan y la confirmación → ninguna mutación ----
  describe('R2-1: el servicio cambia entre el plan y la confirmación → ninguna mutación', () => {
    for (const cambio of ['fijada', 'revision', 'volumen', 'variable', 'trafico', 'generacion']) {
      it(`deshabilitar-sobrantes con cambio «${cambio}»: aborta sin deshabilitar`, () => {
        const r = run('deshabilitar-sobrantes', FRASE.deshabilitar, { FAKE_CAMBIA: cambio })
        expect(r.stdout).toContain(`${CLIENTE} 1`) // el plan sí la proponía
        expect(r.status).toBe(1)
        expect(r.stderr).toContain('el servicio cambió')
        expect(r.mutaciones).toEqual([])
      })

      it(`destruir-version con cambio «${cambio}»: no destruye`, () => {
        run('deshabilitar-sobrantes', FRASE.deshabilitar)
        const r = run(['destruir-version', CLIENTE, '1'], FRASE.destruir, { FAKE_CAMBIA: cambio }, false)
        expect(r.stdout).toContain('Se DESTRUIRÁ') // pasó las comprobaciones previas a la confirmación
        expect(r.status).toBe(1)
        expect(r.stderr).toContain('el servicio cambió')
        expect(r.mutaciones).toEqual([])
      })
    }

    it('la revalidación ocurre DESPUÉS de la confirmación: el servicio se vuelve a leer antes de mutar', () => {
      const r = run('deshabilitar-sobrantes', FRASE.deshabilitar)
      const lecturas = r.calls.map((c, i) => (c.startsWith('run services describe') ? i : -1)).filter((i) => i >= 0)
      const mutacion = r.calls.findIndex((c) => c.startsWith('secrets versions disable'))
      expect(lecturas.length).toBeGreaterThanOrEqual(2)
      expect(lecturas.at(-1)).toBeLessThan(mutacion)
    })

    it.each(['volumen', 'variable'])('cuenta TODAS las referencias (segunda referencia por %s), no solo una variable', (extra) => {
      const d = run('', '', { FAKE_REF_EXTRA: extra })
      expect(d.stdout).toContain(`${CLIENTE}: fijada=1,2; ENABLED=[2 1]; ENABLED_no_fijadas=[]`)
      const r = run('deshabilitar-sobrantes', FRASE.deshabilitar, { FAKE_REF_EXTRA: extra })
      expect(r.stdout).toContain('nada que hacer')
      expect(r.mutaciones).toEqual([])
      run('deshabilitar-sobrantes', FRASE.deshabilitar)
      const x = run(['destruir-version', CLIENTE, '1'], FRASE.destruir, { FAKE_REF_EXTRA: extra }, false)
      expect(x.stderr).toContain('es la FIJADA')
      expect(x.mutaciones).toEqual([])
    })
  })

  describe('el tráfico no sale al 100 % de la última revisión lista → no se puede ver toda referencia: falla cerrado', () => {
    it.each([
      ['repartido', 'TRAFICO_EN_VARIAS_REVISIONES'],
      ['otra', 'TRAFICO_EN_VARIAS_REVISIONES'],
      ['etiqueta', 'TRAFICO_EN_VARIAS_REVISIONES'],
      ['creada', 'ULTIMA_REVISION_NO_LISTA'],
    ])('tráfico %s (%s): ni deshabilitar ni destruir', (trafico, motivo) => {
      const d = run('deshabilitar-sobrantes', FRASE.deshabilitar, { FAKE_TRAFICO: trafico })
      expect(d.status).toBe(1)
      expect(d.stderr).toContain(`única revisión lista (${motivo})`)
      expect(d.mutaciones).toEqual([])
      run('deshabilitar-sobrantes', FRASE.deshabilitar)
      const x = run(['destruir-version', CLIENTE, '1'], FRASE.destruir, { FAKE_TRAFICO: trafico }, false)
      expect(x.status).toBe(1)
      expect(x.stderr).toContain(motivo)
      expect(x.mutaciones).toEqual([])
    })
  })

  describe('cambios de estado de la versión antes de la mutación (A.2)', () => {
    it('deshabilitar: la versión deja de estar ENABLED tras la frase → aborta sin mutar', () => {
      const r = run('deshabilitar-sobrantes', FRASE.deshabilitar, { FAKE_ESTADO_CAMBIA: '1' })
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('ya no está ENABLED')
      expect(r.mutaciones).toEqual([])
    })

    it('destruir: la versión vuelve a ENABLED tras la frase → no destruye', () => {
      run('deshabilitar-sobrantes', FRASE.deshabilitar)
      const r = run(['destruir-version', CLIENTE, '1'], FRASE.destruir, { FAKE_ESTADO_CAMBIA: '1' }, false)
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('cambió de estado')
      expect(r.mutaciones).toEqual([])
    })

    it('si cambia entre la última lectura y la llamada, la API rechaza el etag: nada se da por hecho', () => {
      const d = run('deshabilitar-sobrantes', FRASE.deshabilitar, { FAKE_RECHAZA: '1' })
      expect(d.status).toBe(1)
      expect(d.rechazadas).toHaveLength(1)
      expect(d.mutaciones).toEqual([])
      expect(d.stderr).toContain('la API rechazó deshabilitar')
      expect(d.stdout).not.toContain('deshabilitada (verificado)')
      run('deshabilitar-sobrantes', FRASE.deshabilitar)
      const x = run(['destruir-version', CLIENTE, '1'], FRASE.destruir, { FAKE_RECHAZA: '1' }, false)
      expect(x.status).toBe(1)
      expect(x.rechazadas).toHaveLength(1)
      expect(x.stderr).toContain('no se destruyó nada')
      expect(x.stdout).not.toContain('destruida')
    })

    it.each([
      ['deshabilitar', 'disable', 'no quedó DISABLED: NO_VERIFICADO'],
      ['destruir', 'destroy', 'quedó en estado «DISABLED» tras destruirla: NO_VERIFICADO'],
    ])('%s: si la mutación no surte efecto, la verificación posterior lo declara NO_VERIFICADO', (modo, sinEfecto, error) => {
      if (modo === 'destruir') run('deshabilitar-sobrantes', FRASE.deshabilitar)
      const r = modo === 'destruir'
        ? run(['destruir-version', CLIENTE, '1'], FRASE.destruir, { FAKE_SIN_EFECTO: sinEfecto }, false)
        : run('deshabilitar-sobrantes', FRASE.deshabilitar, { FAKE_SIN_EFECTO: sinEfecto })
      expect(r.status).toBe(1)
      expect(r.stderr).toContain(error)
      expect(r.stdout).not.toMatch(/\((verificado)\)/)
    })
  })

  describe('lecturas fallidas, vacías o inválidas en las mutaciones → se detienen sin mutar (A.2)', () => {
    it.each([
      ['deshabilitar', 'permiso denegado en el servicio', { FAKE_FALLA: 'run services describe' }],
      ['deshabilitar', 'servicio con JSON inválido', { FAKE_INVALIDO: 'run services describe' }],
      ['deshabilitar', 'servicio vacío', { FAKE_VACIO: 'run services describe' }],
      ['deshabilitar', 'permiso denegado en las versiones', { FAKE_FALLA: 'secrets versions list' }],
      ['deshabilitar', 'versiones con JSON inválido', { FAKE_INVALIDO: 'secrets versions list' }],
      ['destruir', 'permiso denegado en el servicio', { FAKE_FALLA: 'run services describe' }],
      ['destruir', 'permiso denegado en la política IAM', { FAKE_FALLA: 'secrets get-iam-policy' }],
      ['destruir', 'política IAM con JSON inválido', { FAKE_INVALIDO: 'secrets get-iam-policy' }],
      ['destruir', 'política IAM vacía', { FAKE_VACIO: 'secrets get-iam-policy' }],
      ['destruir', 'versiones con JSON inválido', { FAKE_INVALIDO: 'secrets versions list' }],
      ['alinear', 'permiso denegado en el servicio', { FAKE_FALLA: 'run services describe' }],
      ['excluir', 'permiso denegado en el sink', { FAKE_FALLA: 'logging sinks describe' }],
      ['excluir', 'sink con JSON inválido', { FAKE_INVALIDO: 'logging sinks describe' }],
    ])('%s con %s', (modo, _n, extra) => {
      if (modo === 'destruir') run('deshabilitar-sobrantes', FRASE.deshabilitar)
      const r = {
        deshabilitar: () => run('deshabilitar-sobrantes', FRASE.deshabilitar, extra),
        destruir: () => run(['destruir-version', CLIENTE, '1'], FRASE.destruir, extra, false),
        alinear: () => run('alinear-max-servicio', FRASE.max, extra),
        excluir: () => run('excluir-callback-en-logs', FRASE.excluir, extra),
      }[modo as 'deshabilitar' | 'destruir' | 'alinear' | 'excluir']()
      expect(r.status).toBe(1)
      expect(r.mutaciones).toEqual([])
      expect(r.stdout).not.toMatch(/^OK|\(verificado\)/m)
      sinFugas(r.salida)
    })
  })

  it('alinear-max-servicio: usa --max=1 (servicio) y confirma que la revisión no cambió', () => {
    const r = run('alinear-max-servicio', FRASE.max)
    expect(r.status).toBe(0)
    expect(r.mutaciones).toEqual(['run services update project-os-dashboard --project=project-os-511102 --region=northamerica-south1 --max=1 --format=none'])
    expect(r.stdout).toContain('OK: máximo de servicio 1, misma revisión activa')
  })

  it('alinear-max-servicio: avisa si apareció una revisión nueva', () => {
    const r = run('alinear-max-servicio', FRASE.max, { FAKE_NUEVA_REVISION: '1' })
    expect(r.stdout).toContain('AVISO: la revisión activa cambió')
  })

  it('alinear-max-servicio: no actúa si la revisión no tiene maxScale 1', () => {
    const r = run('alinear-max-servicio', FRASE.max, { FAKE_REV_MAX: '3' })
    expect(r.status).toBe(1)
    expect(r.mutaciones).toEqual([])
  })

  it('excluir-callback-en-logs: añade la exclusión del callback y la verifica; es idempotente', () => {
    const r = run('excluir-callback-en-logs', FRASE.excluir)
    expect(r.status).toBe(0)
    expect(r.mutaciones).toHaveLength(1)
    expect(r.mutaciones[0]).toContain('--add-exclusion=name=project-os-callback-oauth,')
    expect(r.mutaciones[0]).toContain('httpRequest.requestUrl:"/api/auth/callback/google"')
    // El filtro va dentro de clave=valor,…: no puede contener «=» ni «,».
    const filtro = /filter=(.*) --format=none$/.exec(r.mutaciones[0] ?? '')?.[1] ?? ''
    expect(filtro).not.toMatch(/[=,]/)
    expect(r.stdout).toContain('OK: exclusión project-os-callback-oauth activa, con el filtro esperado')
    expect(r.stdout).toContain('al sink _Default (solo ese sink)')
    const otra = run('excluir-callback-en-logs', FRASE.excluir, {}, false)
    expect(otra.stdout).toContain('ya existe con el filtro esperado y activa: nada que hacer')
    expect(otra.mutaciones).toEqual([])
  })

  it('excluir-callback-en-logs: el filtro que se añade es exactamente el que se verifica', () => {
    expect(text).toContain(`EXCLUSION_FILTER="${FILTRO.replaceAll('"', '\\"').replace('project-os-dashboard', '${SERVICE}')}"`)
  })

  it.each([
    ['distinta', 'DISTINTA'],
    ['deshabilitada', 'DESHABILITADA'],
  ])('excluir-callback-en-logs: misma exclusión con filtro %s → NO_VERIFICADO, sin modificar (R1-3)', (sink, estado) => {
    const r = run('excluir-callback-en-logs', FRASE.excluir, { FAKE_SINK: sink })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(estado)
    expect(r.stderr).toContain('NO_VERIFICADO')
    expect(r.mutaciones).toEqual([])
  })

  it('excluir-callback-en-logs: si tras añadirla no queda CORRECTA, no declara éxito (R1-3)', () => {
    const r = run('excluir-callback-en-logs', FRASE.excluir, { FAKE_SINK: 'rota' })
    expect(r.status).toBe(1)
    expect(r.mutaciones).toHaveLength(1)
    expect(r.stderr).toContain('NO_VERIFICADO')
    expect(r.stdout).not.toContain('OK: exclusión')
  })
})
