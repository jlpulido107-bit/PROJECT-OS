#!/usr/bin/env node
/**
 * E2E HTTP de INTEGRACIÓN V1.3–V1.6 contra el build de producción (`next start`). Nunca contacta a Google:
 * datos sintéticos, secretos aleatorios de un solo uso y sesiones JWE locales.
 * Servidores:
 *  M  escritura simulada (mock) con lector y escritor;
 *  D  valores por defecto (sin variables de escritura);
 *  S  PROJECT_OS_WRITE_MODE=sheets (debe quedar bloqueado);
 *  C  Cloud Run simulado (K_SERVICE) con mock pedido: escritura bloqueada y sonda 503;
 *  F  fuente Sheets sin configurar: fallo del lector ⇒ 503 / página de error, sin datos parciales.
 * Requisito: `npm run build` antes de ejecutar.
 */
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { encode } from 'next-auth/jwt'

const webDir = path.resolve(import.meta.dirname, '..')
const READER = 'lectora@example.com'
const WRITER = 'escritor@example.com'
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Merida' }).format(new Date())
const shift = (days) => {
  const [y, m, d] = TODAY.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}
const results = []
const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail })
const servers = []

function start(name, port, extraEnv) {
  const secret = randomBytes(32).toString('base64')
  const base = `http://127.0.0.1:${port}`
  const env = {
    ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', NEXTAUTH_SECRET: secret, NEXTAUTH_URL: base,
    AUTH_ALLOWED_EMAILS: `${READER},${WRITER}`, GOOGLE_CLIENT_ID: 'e2e-client-id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'e2e-secreto-no-real',
    DASHBOARD_DATA_SOURCE: 'fixtures', ...extraEnv,
  }
  for (const key of ['PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_JSON', 'PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_FILE', 'GOOGLE_APPLICATION_CREDENTIALS', 'SHEETS_SPREADSHEET_ID', 'SHEETS_CREDENTIALS']) {
    if (!(key in extraEnv)) delete env[key]
  }
  for (const [k, v] of Object.entries(extraEnv)) if (v === undefined) delete env[k]
  const child = spawn(path.join(webDir, 'node_modules', '.bin', 'next'), ['start', '-p', String(port), '-H', '127.0.0.1'], { cwd: webDir, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  const server = { name, base, secret, origin: new URL(env.NEXTAUTH_URL).origin, child, log: '' }
  child.stdout.on('data', (d) => (server.log += d))
  child.stderr.on('data', (d) => (server.log += d))
  servers.push(server)
  return server
}

async function ready(server) {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(server.base + '/login', { redirect: 'manual' })).status > 0) return
    } catch {
      // aún iniciando
    }
    await sleep(500)
  }
  throw new Error(`El servidor ${server.name} no respondió a tiempo`)
}

async function client(server, email) {
  const token = email ? await encode({ token: { email, name: 'E2E', sub: email }, secret: server.secret }) : null
  // Bajo HTTPS NextAuth usa el prefijo __Secure-; se envían ambos nombres.
  const cookie = token ? `next-auth.session-token=${token}; __Secure-next-auth.session-token=${token}` : null
  const headers = (extra = {}) => ({ ...(cookie ? { cookie } : {}), ...extra })
  return {
    page: (p) => fetch(server.base + p, { redirect: 'manual', headers: headers() }),
    json: async (p) => {
      const res = await fetch(server.base + p, { redirect: 'manual', headers: headers() })
      const text = await res.text()
      let body = null
      try {
        body = JSON.parse(text)
      } catch {
        body = null
      }
      return { res, text, body }
    },
    write: async (method, p, body) => {
      const res = await fetch(server.base + p, {
        method, redirect: 'manual',
        headers: headers({ 'content-type': 'application/json', origin: server.origin, 'sec-fetch-site': 'same-origin', 'x-project-os-csrf': '1' }),
        body: JSON.stringify(body),
      })
      const text = await res.text()
      let parsed = null
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = null
      }
      return { res, text, body: parsed }
    },
  }
}

const NAV = (html, href) => html.includes(`href="${href}"`)
const NO_EMAIL = (text) => !/[A-Za-z0-9._%+-]+@example\.com/.test(text)

const M = start('M', 3161, { PROJECT_OS_WRITE_MODE: 'mock', AUTH_WRITER_EMAILS: WRITER })
const D = start('D', 3162, { PROJECT_OS_WRITE_MODE: undefined, AUTH_WRITER_EMAILS: WRITER })
const S = start('S', 3163, { PROJECT_OS_WRITE_MODE: 'sheets', AUTH_WRITER_EMAILS: WRITER })
const C = start('C', 3164, { PROJECT_OS_WRITE_MODE: 'mock', AUTH_WRITER_EMAILS: WRITER, K_SERVICE: 'project-os-dashboard', NEXTAUTH_URL: 'https://project-os-dashboard-000000000000.us-central1.run.app' })
const F = start('F', 3165, { DASHBOARD_DATA_SOURCE: 'sheets' })

try {
  await Promise.all(servers.map(ready))
  const anon = await client(M)
  const reader = await client(M, READER)
  const writer = await client(M, WRITER)

  // 1) Sesión bloqueada y permitida en todas las páginas.
  const PAGES = ['/', '/estado', '/proyectos', '/proyectos/POS', '/tareas', '/actividad', '/capacidad', '/planificacion', '/control', '/operaciones', '/tareas/nueva']
  for (const p of PAGES) {
    const a = await anon.page(p)
    check(`sin sesión ${p} → /login`, [302, 307].includes(a.status) && (a.headers.get('location') ?? '').includes('/login'), a.status)
    const r = await reader.page(p)
    check(`lectora ${p} → 200`, r.status === 200, r.status)
  }

  // 2) Navegación por rol.
  const readerHome = await (await reader.page('/')).text()
  const writerHome = await (await writer.page('/')).text()
  check('lectora ve Planificación y Control, no Operaciones', NAV(readerHome, '/planificacion') && NAV(readerHome, '/control') && !NAV(readerHome, '/operaciones'))
  check('escritor (mock) ve Planificación, Control y Operaciones', NAV(writerHome, '/planificacion') && NAV(writerHome, '/control') && NAV(writerHome, '/operaciones'))
  const readerForm = await (await reader.page('/tareas/nueva')).text()
  check('lectora en /tareas/nueva: sin formulario', !readerForm.includes('<form') || !readerForm.includes('Crear tarea'))

  // 3) Errores de la API de escritura: 401 / 403 / 422.
  const TASK = { proyectoId: 'POS', titulo: 'Integración vencida', tipo: 'DESARROLLO', prioridad: 'ALTA', criterioTerminado: 'Comprobada', horasEstimadas: '2', fechaLimite: shift(-2) }
  check('sin sesión POST tareas → 401', (await anon.write('POST', '/api/operaciones/tareas', { ...TASK, requestId: randomUUID() })).res.status === 401)
  const r403 = await reader.write('POST', '/api/operaciones/tareas', { ...TASK, requestId: randomUUID() })
  check('lectora POST tareas → 403 sin-permiso-escritura', r403.res.status === 403 && r403.body?.error?.codigo === 'sin-permiso-escritura', `${r403.res.status} ${r403.body?.error?.codigo}`)
  const r422 = await writer.write('POST', '/api/operaciones/tareas', { ...TASK, requestId: randomUUID(), titulo: '' })
  check('escritor con datos inválidos → 422', r422.res.status === 422, r422.res.status)

  // 4) Una escritura simulada se refleja en dashboard, control y planificador.
  const before = (await reader.json('/api/resumen')).body
  const created = await writer.write('POST', '/api/operaciones/tareas', { ...TASK, requestId: randomUUID() })
  const id = created.body?.id
  check('escritor crea tarea vencida (mock) → 201', created.res.status === 201 && /^POS-\d+$/.test(id ?? ''), `${created.res.status} ${id}`)
  const after = (await reader.json('/api/resumen')).body
  check('dashboard: /api/resumen cuenta la tarea nueva', after?.tareas?.total === (before?.tareas?.total ?? 0) + 1, `${before?.tareas?.total} → ${after?.tareas?.total}`)
  const tareas = await (await reader.page(`/tareas?q=${id}`)).text()
  check('dashboard: /tareas muestra la tarea simulada', tareas.includes('Integración vencida'))
  const control = await reader.json(`/api/control?fecha=${TODAY}`)
  const overdue = control.body?.informe?.alertas?.find((a) => a.regla === 'tarea-vencida' && a.entidades.some((e) => e.id === id))
  check('control: alerta tarea-vencida para la tarea simulada', overdue && overdue.severidad === 'alta', JSON.stringify(overdue?.regla ?? null))
  check('control: la API no expone el título (minimización)', !control.text.includes('Integración vencida'))
  const plan = await reader.json(`/api/planificacion?fecha=${TODAY}&horasSiFaltan=20`)
  const planned = plan.body?.plan?.tareas?.find((t) => t.id === id)
  check('planificador: la tarea vencida va primero', planned?.vencida === true && planned?.rango === 1, JSON.stringify({ rango: planned?.rango, cat: planned?.categoria }))
  // Edición a BLOQUEADO: excluida del plan y alerta de bloqueo.
  const blocked = await writer.write('PATCH', `/api/operaciones/tareas/${id}`, { requestId: randomUUID(), expectedVersion: 1, changes: { estado: 'BLOQUEADO', bloqueo: 'Espera integración' } })
  check('escritor bloquea la tarea → 200 versión 2', blocked.res.status === 200 && blocked.body?.version === 2, blocked.res.status)
  const stale = await writer.write('PATCH', `/api/operaciones/tareas/${id}`, { requestId: randomUUID(), expectedVersion: 1, changes: { prioridad: 'BAJA' } })
  check('versión desactualizada → 409 conflicto-version', stale.res.status === 409 && stale.body?.error?.codigo === 'conflicto-version', stale.res.status)
  const control2 = await reader.json(`/api/control?fecha=${TODAY}`)
  check('control: alerta tarea-bloqueada tras la edición', control2.body?.informe?.alertas?.some((a) => a.regla === 'tarea-bloqueada' && a.entidades.some((e) => e.id === id)))
  const plan2 = await reader.json(`/api/planificacion?fecha=${TODAY}&horasSiFaltan=20`)
  const excluded = plan2.body?.plan?.tareas?.find((t) => t.id === id)
  check('planificador: la tarea bloqueada queda excluida', excluded?.categoria === 'excluida' && excluded?.motivos?.includes('bloqueada'))
  check('planificador: ningún bloque propuesto para la tarea bloqueada', !(plan2.body?.plan?.dias ?? []).some((d) => d.items.some((i) => i.tareaId === id)))
  const controlPage = await (await reader.page('/control')).text()
  check('/control (página) muestra la tarea simulada', controlPage.includes(id))

  // 5) Planificación y control no envían escrituras; las propuestas no se aplican.
  const total = (await reader.json('/api/resumen')).body?.tareas?.total
  for (const apiPath of ['/api/planificacion', '/api/control']) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await writer.write(method, apiPath, { aplicar: true, aprobar: true })
      check(`${method} ${apiPath} (escritor, con CSRF) → 405`, res.res.status === 405, res.res.status)
    }
  }
  check('tras intentar aplicar propuestas, los datos no cambian', (await reader.json('/api/resumen')).body?.tareas?.total === total)

  // 6) Sin PII en respuestas JSON.
  for (const apiPath of ['/api/resumen', `/api/control?fecha=${TODAY}`, `/api/planificacion?fecha=${TODAY}&horasSiFaltan=20`]) {
    const { text } = await writer.json(apiPath)
    check(`${apiPath.split('?')[0]} sin correos`, NO_EMAIL(text))
  }

  // 7) Valores por defecto: sin escritura aunque haya escritores en la lista.
  const dWriter = await client(D, WRITER)
  const dRes = await dWriter.write('POST', '/api/operaciones/tareas', { ...TASK, requestId: randomUUID() })
  check('por defecto: escritura → 403 escritura-deshabilitada', dRes.res.status === 403 && dRes.body?.error?.codigo === 'escritura-deshabilitada', `${dRes.res.status} ${dRes.body?.error?.codigo}`)
  check('por defecto: sin enlace a Operaciones', !NAV(await (await dWriter.page('/')).text(), '/operaciones'))

  // 8) sheets bloqueado.
  const sRes = await (await client(S, WRITER)).write('POST', '/api/operaciones/tareas', { ...TASK, requestId: randomUUID() })
  check('PROJECT_OS_WRITE_MODE=sheets → 403 (bloqueado)', sRes.res.status === 403 && sRes.body?.error?.codigo === 'escritura-deshabilitada', `${sRes.res.status} ${sRes.body?.error?.codigo}`)

  // 9) Cloud Run simulado con mock pedido: escritura bloqueada y sonda 503.
  const cWriter = await client(C, WRITER)
  const cRes = await cWriter.write('POST', '/api/operaciones/tareas', { ...TASK, requestId: randomUUID() })
  check('Cloud Run + mock → escritura 403 escritura-deshabilitada', cRes.res.status === 403 && cRes.body?.error?.codigo === 'escritura-deshabilitada', `${cRes.res.status} ${cRes.body?.error?.codigo}`)
  const health = await fetch(C.base + '/api/health')
  check('Cloud Run + modo de escritura → /api/health 503 sin detalles', health.status === 503 && (await health.text()) === '{"status":"unavailable"}', health.status)
  check('servidor M (local, fixtures) → /api/health 200', (await fetch(M.base + '/api/health')).status === 200)

  // 10) Fallo del lector: 503 en todas las APIs de lectura y páginas de error sin datos.
  const fReader = await client(F, READER)
  for (const apiPath of ['/api/resumen', '/api/control', '/api/planificacion']) {
    const res = await fReader.json(apiPath)
    check(`lector sin configurar: ${apiPath} → 503 sin datos`, res.res.status === 503 && !res.text.includes('DEMO-'), res.res.status)
  }
  for (const p of ['/', '/control', '/planificacion']) {
    const html = await (await fReader.page(p)).text()
    check(`lector sin configurar: ${p} muestra error sin datos parciales`, html.includes('No se pudieron leer los datos') && !html.includes('DEMO-'))
  }

  // 11) Registros sin correos ni contenido.
  check('logs de los 5 servidores sin correos', servers.every((s) => NO_EMAIL(s.log)), servers.filter((s) => !NO_EMAIL(s.log)).map((s) => s.name).join(','))
} catch (error) {
  check('ejecución', false, error instanceof Error ? error.message : String(error))
} finally {
  for (const s of servers) {
    try {
      process.kill(-s.child.pid, 'SIGTERM')
    } catch {
      // ya terminado
    }
  }
}

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FALLA'} ${r.name}${r.detail !== '' && !r.ok ? ` (${r.detail})` : ''}`)
console.log(`\n${results.length - failed.length}/${results.length} comprobaciones correctas.`)
if (failed.length) {
  for (const s of servers) console.log(`\n--- log ${s.name} ---\n${s.log.split('\n').slice(-12).join('\n')}`)
  process.exit(1)
}
process.exit(0)
