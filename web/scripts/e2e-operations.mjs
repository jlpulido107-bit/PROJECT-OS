#!/usr/bin/env node
/**
 * E2E HTTP del motor de operaciones V1.4 contra el build de producción (`next start`).
 * - Datos SINTÉTICOS y escritura SIMULADA (PROJECT_OS_WRITE_MODE=mock): nunca toca Google Sheets.
 * - Dos servidores: (A) mock con lector y escritor; (B) configuración por defecto (escritura deshabilitada).
 * - Sesiones emitidas con el cifrado JWE de NextAuth y un secreto aleatorio de un solo uso.
 * Requisito: `npm run build`.
 */
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { encode } from 'next-auth/jwt'

const webDir = path.resolve(import.meta.dirname, '..')
const READER = 'lector@example.com'
const WRITER = 'escritor@example.com'
const WRITER2 = 'escritora@example.com'
const COOKIE = 'next-auth.session-token'
const DATA_MARKERS = ['DEMO-', 'Objetivo de demostración', 'Persona demo']
const results = []
const check = (name, ok, detail = '') => results.push({ name, ok, detail })
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Merida' }).format(new Date())

async function startServer(port, extraEnv) {
  const secret = randomBytes(32).toString('base64')
  const base = `http://127.0.0.1:${port}`
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    DASHBOARD_DATA_SOURCE: 'fixtures',
    NEXTAUTH_SECRET: secret,
    NEXTAUTH_URL: base,
    AUTH_ALLOWED_EMAILS: `${READER},${WRITER},${WRITER2}`,
    GOOGLE_CLIENT_ID: 'e2e-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'e2e-client-secret-no-real',
    ...extraEnv,
  }
  for (const key of ['PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_JSON', 'PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_FILE', 'K_SERVICE']) delete env[key]
  for (const [key, value] of Object.entries(extraEnv)) if (value === undefined) delete env[key]
  const proc = spawn(path.join(webDir, 'node_modules', '.bin', 'next'), ['start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: webDir, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  proc.stdout.on('data', (d) => (log += d))
  proc.stderr.on('data', (d) => (log += d))
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(base + '/login')
      break
    } catch {
      await sleep(500)
    }
  }
  const session = async (email) => encode({ token: { email, name: 'E2E', sub: email }, secret })
  return { base, proc, session, log: () => log }
}

function client(base, cookie) {
  const headers = (extra = {}) => ({ ...(cookie ? { cookie: `${COOKIE}=${cookie}` } : {}), ...extra })
  return {
    page: (p) => fetch(base + p, { redirect: 'manual', headers: headers() }),
    write: (method, p, body, extra = {}) =>
      fetch(base + p, {
        method,
        redirect: 'manual',
        headers: headers({ origin: base, 'content-type': 'application/json', 'x-project-os-csrf': '1', 'sec-fetch-site': 'same-origin', ...extra }),
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
  }
}

async function json(res) {
  const text = await res.text()
  try {
    return { text, body: JSON.parse(text) }
  } catch {
    return { text, body: null }
  }
}

const TASK = { proyectoId: 'POS', titulo: 'Tarea creada por E2E', tipo: 'DESARROLLO', prioridad: 'ALTA', criterioTerminado: 'Verificada en E2E' }
const ENDPOINTS = [
  ['POST', '/api/operaciones/tareas', TASK],
  ['PATCH', '/api/operaciones/tareas/DEMO-002', { expectedVersion: 2, changes: { prioridad: 'BAJA' } }],
  ['POST', '/api/operaciones/tiempos', { tareaId: 'DEMO-002', fecha: today, responsable: 'E2E', minutos: 15, tipoTrabajo: 'REVISION' }],
  ['POST', '/api/operaciones/decisiones', { proyectoId: 'POS', asunto: 'Asunto E2E', decision: 'Decisión E2E', justificacion: 'Prueba', responsable: 'E2E' }],
]
const SUCCESS_KEYS = ['entidad', 'id', 'modo', 'ok', 'operacion', 'repetida', 'requestId', 'version']

const servers = []
try {
  // ------------------------------- A: modo simulado -------------------------------
  const A = await startServer(Number(process.env.E2E_OPS_PORT ?? 3121), {
    PROJECT_OS_WRITE_MODE: 'mock',
    AUTH_WRITER_EMAILS: `${WRITER},${WRITER2}`,
  })
  servers.push(A)
  const anon = client(A.base)
  const reader = client(A.base, await A.session(READER))
  const writer = client(A.base, await A.session(WRITER))
  // Segundo escritor: el límite de frecuencia es por actor (10 inmediatas + 1 cada 20 s).
  const writer2 = client(A.base, await A.session(WRITER2))
  const stranger = client(A.base, await A.session('intruso@example.com'))
  // Uso real: primero se abre una página, que crea el runtime simulado desde el paquete de páginas.
  // Los errores del servicio (404, 409, 422) deben seguir reconociéndose en las rutas (no 500).
  const first = await writer.page('/tareas')
  check('primera visita a /tareas (escritor) → 200', first.status === 200, first.status)

  for (const [method, p, body] of ENDPOINTS) {
    const res = await anon.write(method, p, { ...body, requestId: randomUUID() })
    const { text } = await json(res)
    check(`sin sesión ${method} ${p} → 401 sin datos`, res.status === 401 && !DATA_MARKERS.some((m) => text.includes(m)), res.status)
    const r2 = await reader.write(method, p, { ...body, requestId: randomUUID() })
    const j2 = await json(r2)
    check(`lector ${method} ${p} → 403 sin-permiso-escritura`, r2.status === 403 && j2.body?.error?.codigo === 'sin-permiso-escritura', `${r2.status} ${j2.body?.error?.codigo}`)
    const r3 = await stranger.write(method, p, { ...body, requestId: randomUUID() })
    check(`correo no permitido ${method} ${p} → 403`, r3.status === 403, r3.status)
  }

  // CSRF / origen / tipo / tamaño
  const csrfCases = [
    ['sin Origin', { origin: '' }],
    ['Origin ajeno', { origin: 'https://evil.example' }],
    ['Sec-Fetch-Site cross-site', { 'sec-fetch-site': 'cross-site' }],
    ['sin cabecera CSRF', { 'x-project-os-csrf': '' }],
  ]
  for (const [name, extra] of csrfCases) {
    const res = await writer.write('POST', '/api/operaciones/tareas', { ...TASK, requestId: randomUUID() }, extra)
    const { body } = await json(res)
    check(`escritor ${name} → 403 origen-invalido`, res.status === 403 && body?.error?.codigo === 'origen-invalido', `${res.status} ${body?.error?.codigo}`)
  }
  {
    const res = await writer.write('POST', '/api/operaciones/tareas', 'titulo=x', { 'content-type': 'application/x-www-form-urlencoded' })
    check('escritor form-urlencoded → 415', res.status === 415, res.status)
    const big = await writer.write('POST', '/api/operaciones/tareas', { ...TASK, requestId: randomUUID(), descripcion: 'x'.repeat(20000) })
    check('payload > 16 KiB → 413', big.status === 413, big.status)
    const bad = await writer.write('POST', '/api/operaciones/tareas', '{no json')
    check('JSON inválido → 400', bad.status === 400, bad.status)
    const extra = await writer.write('POST', '/api/operaciones/tareas', { ...TASK, requestId: randomUUID(), VERSION: '99', estado: 'COMPLETADO' })
    const ej = await json(extra)
    check('campos de sistema/desconocidos → 422 validacion', extra.status === 422 && ej.body?.error?.campos?.VERSION && ej.body?.error?.campos?.estado, extra.status)
    const get = await writer.page('/api/operaciones/tareas')
    const getText = await get.text()
    check('GET en API de escritura → 405 sin datos', get.status === 405 && !DATA_MARKERS.some((m) => getText.includes(m)), get.status)
  }

  // Crear tarea + idempotencia
  const requestId = randomUUID()
  const created = await writer.write('POST', '/api/operaciones/tareas', { ...TASK, requestId })
  const cj = await json(created)
  check('escritor crea tarea → 201 POS-001 versión 1 (mock)', created.status === 201 && cj.body?.id === 'POS-001' && cj.body?.version === 1 && cj.body?.modo === 'mock', `${created.status} ${cj.text.slice(0, 80)}`)
  check('respuesta de éxito sin datos extra', cj.body && Object.keys(cj.body).every((k) => SUCCESS_KEYS.includes(k)) && !DATA_MARKERS.some((m) => cj.text.includes(m)))
  check('respuesta con Cache-Control no-store', (created.headers.get('cache-control') ?? '').includes('no-store'))
  const replay = await writer.write('POST', '/api/operaciones/tareas', { ...TASK, requestId })
  const rj = await json(replay)
  check('mismo requestId → 200 repetida, mismo ID', replay.status === 200 && rj.body?.repetida === true && rj.body?.id === 'POS-001', `${replay.status}`)
  const reuse = await writer.write('POST', '/api/operaciones/tareas', { ...TASK, titulo: 'Otro título', requestId })
  const uj = await json(reuse)
  check('mismo requestId, otro payload → 409 conflicto-idempotencia', reuse.status === 409 && uj.body?.error?.codigo === 'conflicto-idempotencia', reuse.status)

  // La UI refleja la tarea simulada
  const tareas = await (await writer.page('/tareas?q=POS-001')).text()
  check('/tareas muestra la tarea simulada y acciones de escritor', tareas.includes('Tarea creada por E2E') && tareas.includes('/tareas/POS-001/editar') && tareas.includes('Nueva tarea'))
  const readerTareas = await (await reader.page('/tareas?q=POS-001')).text()
  check('lector ve la tarea pero sin acciones de escritura', readerTareas.includes('Tarea creada por E2E') && !readerTareas.includes('/tareas/POS-001/editar') && !readerTareas.includes('Nueva tarea'))

  // Editar
  const upd = await writer.write('PATCH', '/api/operaciones/tareas/POS-001', { requestId: randomUUID(), expectedVersion: 1, changes: { estado: 'EN_PROGRESO' } })
  const updj = await json(upd)
  check('editar estado → 200 versión 2', upd.status === 200 && updj.body?.version === 2, `${upd.status} ${updj.text.slice(0, 80)}`)
  const stale = await writer.write('PATCH', '/api/operaciones/tareas/POS-001', { requestId: randomUUID(), expectedVersion: 1, changes: { prioridad: 'BAJA' } })
  const sj = await json(stale)
  check('versión desactualizada → 409 conflicto-version', stale.status === 409 && sj.body?.error?.codigo === 'conflicto-version', stale.status)
  const close = await writer.write('PATCH', '/api/operaciones/tareas/POS-001', { requestId: randomUUID(), expectedVersion: 2, changes: { estado: 'COMPLETADO' } })
  const clj = await json(close)
  check('cerrar tarea → 422 cierre-no-permitido', close.status === 422 && clj.body?.error?.codigo === 'cierre-no-permitido', close.status)
  // ORD-POS-106: sin TAREAS_CIERRE_PROPIETARIO, la ruta del propietario tampoco cierra y no hay botón.
  const completar = await writer.write('POST', '/api/operaciones/tareas/POS-001/completar', { requestId: randomUUID(), expectedVersion: 2 })
  const cpj = await json(completar)
  check('completar sin la bandera → 422 cierre-no-permitido', completar.status === 422 && cpj.body?.error?.codigo === 'cierre-no-permitido', completar.status)
  const editar = await (await writer.page('/tareas/POS-001/editar')).text()
  check('sin la bandera no aparece «Marcar completada»', editar.includes('Guardar cambios') && !editar.includes('Marcar completada'))
  const closed = await writer.write('PATCH', '/api/operaciones/tareas/DEMO-001', { requestId: randomUUID(), expectedVersion: 1, changes: { prioridad: 'BAJA' } })
  const cdj = await json(closed)
  check('editar tarea cerrada → 422 tarea-cerrada', closed.status === 422 && cdj.body?.error?.codigo === 'tarea-cerrada', closed.status)
  const missing = await writer.write('PATCH', '/api/operaciones/tareas/NO-EXISTE', { requestId: randomUUID(), expectedVersion: 1, changes: { prioridad: 'BAJA' } })
  check('editar tarea inexistente → 404', missing.status === 404, missing.status)

  // Tiempo
  const time = await writer2.write('POST', '/api/operaciones/tiempos', { requestId: randomUUID(), tareaId: 'POS-001', fecha: today, responsable: 'E2E', minutos: 30, tipoTrabajo: 'DESARROLLO' })
  const tj = await json(time)
  check('registrar tiempo → 201 SES-…', time.status === 201 && /^SES-\d{8}-[0-9A-F]{8}$/.test(tj.body?.id ?? ''), `${time.status} ${tj.body?.id}`)
  const badTime = await writer2.write('POST', '/api/operaciones/tiempos', { requestId: randomUUID(), tareaId: 'NO-EXISTE', fecha: today, responsable: 'E2E', minutos: 30, tipoTrabajo: 'DESARROLLO' })
  check('tiempo con tarea inexistente → 404', badTime.status === 404, badTime.status)
  const future = await writer2.write('POST', '/api/operaciones/tiempos', { requestId: randomUUID(), tareaId: 'POS-001', fecha: '2999-01-01', responsable: 'E2E', minutos: 30, tipoTrabajo: 'DESARROLLO' })
  check('tiempo con fecha futura → 422', future.status === 422, future.status)

  // Decisión
  const dec = await writer2.write('POST', '/api/operaciones/decisiones', { requestId: randomUUID(), proyectoId: 'POS', asunto: 'Asunto E2E', decision: 'Decisión E2E', justificacion: 'Prueba', responsable: 'E2E' })
  const dj = await json(dec)
  check('registrar decisión → 201 DEC-POS-001', dec.status === 201 && dj.body?.id === 'DEC-POS-001', `${dec.status} ${dj.body?.id}`)
  const decBad = await writer2.write('POST', '/api/operaciones/decisiones', { requestId: randomUUID(), proyectoId: 'NOPE', asunto: 'Asunto', decision: 'Decisión', justificacion: 'Prueba', responsable: 'E2E' })
  check('decisión con proyecto inexistente → 422', decBad.status === 422, decBad.status)

  // Inyección de fórmulas
  const formula = await writer2.write('POST', '/api/operaciones/tareas', { ...TASK, requestId: randomUUID(), titulo: '=HYPERLINK("https://evil.example","x")' })
  const fj = await json(formula)
  const fPage = await (await writer.page(`/tareas?q=${fj.body?.id}`)).text()
  check('fórmula neutralizada con apóstrofo y escapada en HTML', formula.status === 201 && fPage.includes('&#x27;=HYPERLINK(') && !fPage.includes('<a href="https://evil.example"'), formula.status)

  // Reflejo en el dashboard
  const home = await (await writer.page('/capacidad')).text()
  check('tiempos simulados visibles en /capacidad', home.includes('Datos sintéticos de demostración'))
  const proj = await (await writer.page('/proyectos/POS')).text()
  check('decisión simulada visible en /proyectos/POS', proj.includes('DEC-POS-001') && proj.includes('Asunto E2E'))

  // Página de operaciones (auditoría + conciliación)
  const ops = await (await writer.page('/operaciones')).text()
  check('/operaciones (escritor) → conciliación sin pendientes y auditoría', ops.includes('Sin pendientes') && ops.includes('Tarea creada') && ops.includes('Modo simulado'))
  const opsReader = await reader.page('/operaciones')
  const opsReaderText = await opsReader.text()
  check('/operaciones (lector) → sin auditoría ni correos de actores', opsReader.status === 200 && opsReaderText.includes('solo lectura') && !opsReaderText.includes(WRITER) && !opsReaderText.includes('Auditoría reciente'))
  const formReader = await (await reader.page('/tareas/nueva')).text()
  check('/tareas/nueva (lector) → sin formulario', !formReader.includes('<form') && formReader.includes('solo lectura'))
  const formWriter = await (await writer.page('/tareas/nueva')).text()
  check('/tareas/nueva (escritor) → formulario y aviso de simulación', formWriter.includes('<form') && formWriter.includes('Modo simulado'))
  const anonPage = await anon.page('/tareas/nueva')
  check('/tareas/nueva sin sesión → redirección a /login', [302, 307].includes(anonPage.status) && (anonPage.headers.get('location') ?? '').includes('/login'), anonPage.status)

  // Límite de frecuencia por actor → 429
  let limited = null
  for (let i = 0; i < 15 && !limited; i++) {
    const res = await writer.write('POST', '/api/operaciones/tareas', '{no json')
    if (res.status === 429) limited = await json(res)
  }
  check('ráfaga de escrituras del mismo actor → 429 demasiadas-solicitudes', limited?.body?.error?.codigo === 'demasiadas-solicitudes')

  // Logs del servidor sin correos ni payloads
  const logA = A.log()
  check('logs del servidor sin correos ni contenido de operaciones', !logA.includes(WRITER) && !logA.includes(WRITER2) && !logA.includes('Tarea creada por E2E') && !logA.includes('HYPERLINK'))

  // ---------------------- B: configuración por defecto (escritura OFF) ----------------------
  const B = await startServer(Number(process.env.E2E_OPS_PORT_B ?? 3122), {
    PROJECT_OS_WRITE_MODE: undefined,
    AUTH_WRITER_EMAILS: undefined,
  })
  servers.push(B)
  const writerB = client(B.base, await B.session(WRITER))
  for (const [method, p, body] of ENDPOINTS) {
    const res = await writerB.write(method, p, { ...body, requestId: randomUUID() })
    const { body: j } = await json(res)
    check(`por defecto ${method} ${p} → 403 escritura-deshabilitada`, res.status === 403 && j?.error?.codigo === 'escritura-deshabilitada', `${res.status} ${j?.error?.codigo}`)
  }
  const pageB = await (await writerB.page('/tareas')).text()
  check('por defecto: sin botones de escritura en /tareas', !pageB.includes('Nueva tarea') && !pageB.includes('/editar'))
  const formB = await (await writerB.page('/tareas/nueva')).text()
  check('por defecto: /tareas/nueva explica que la escritura está deshabilitada', !formB.includes('<form') && formB.includes('deshabilitada'))
  const sheetsB = await startServer(Number(process.env.E2E_OPS_PORT_C ?? 3123), { PROJECT_OS_WRITE_MODE: 'sheets', AUTH_WRITER_EMAILS: WRITER, DASHBOARD_DATA_SOURCE: 'fixtures' })
  servers.push(sheetsB)
  const writerC = client(sheetsB.base, await sheetsB.session(WRITER))
  const resC = await writerC.write('POST', '/api/operaciones/tareas', { ...TASK, requestId: randomUUID() })
  const jc = await json(resC)
  check('PROJECT_OS_WRITE_MODE=sheets → 403 (bloqueado en V1.4)', resC.status === 403 && jc.body?.error?.codigo === 'escritura-deshabilitada', resC.status)
} catch (error) {
  check('ejecución', false, error instanceof Error ? error.message : String(error))
} finally {
  for (const s of servers) s.proc.kill('SIGTERM')
}

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log(`${r.ok ? 'OK   ' : 'FALLA'} ${r.name}${!r.ok && r.detail !== '' ? ` (${r.detail})` : ''}`)
console.log(`\n${results.length - failed.length}/${results.length} comprobaciones correctas.`)
if (failed.length > 0) {
  for (const s of servers) console.log('\n--- log ---\n' + s.log().split('\n').slice(-25).join('\n'))
  process.exit(1)
}
