#!/usr/bin/env node
/**
 * Prueba E2E del centro de control V1.6 contra el build de producción (`next start`).
 * - Servidor A: datos SINTÉTICOS (fixtures). Servidor B: fuente "sheets" SIN configuración ⇒ estado de error.
 * - Secretos aleatorios de un solo uso y sesiones JWE locales. Nunca contacta a Google ni a Sheets.
 * Verifica: acceso solo con sesión autorizada, API de solo lectura (sin métodos mutadores), filtros, validación,
 * determinismo, minimización de datos, no-store y estados de error.
 * Requisito: `npm run build` antes de ejecutar.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { encode } from 'next-auth/jwt'

const webDir = path.resolve(import.meta.dirname, '..')
const ALLOWED = 'controladora@example.com'
const COOKIE = 'next-auth.session-token'
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Merida' }).format(new Date())
const results = []
const check = (name, ok, detail = '') => results.push({ name, ok, detail })

function startServer(port, extraEnv) {
  const secret = randomBytes(32).toString('base64')
  const base = `http://127.0.0.1:${port}`
  const env = {
    ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', NEXTAUTH_SECRET: secret, NEXTAUTH_URL: base,
    AUTH_ALLOWED_EMAILS: ALLOWED, GOOGLE_CLIENT_ID: 'e2e-client-id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'e2e-client-secret-no-real',
    ...extraEnv,
  }
  for (const key of ['PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_JSON', 'PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_FILE', 'SHEETS_SPREADSHEET_ID', 'GOOGLE_APPLICATION_CREDENTIALS']) delete env[key]
  const child = spawn(path.join(webDir, 'node_modules', '.bin', 'next'), ['start', '-p', String(port), '-H', '127.0.0.1'], { cwd: webDir, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  const server = { base, secret, child, log: '' }
  child.stdout.on('data', (d) => (server.log += d))
  child.stderr.on('data', (d) => (server.log += d))
  return server
}

async function waitFor(base) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(base + '/login', { redirect: 'manual' })).status > 0) return
    } catch {
      // aún iniciando
    }
    await sleep(500)
  }
  throw new Error(`El servidor ${base} no respondió a tiempo`)
}

const get = (base, pathname, cookie, init = {}) => fetch(base + pathname, {
  redirect: 'manual', ...init, headers: { ...(cookie ? { cookie: `${COOKIE}=${cookie}` } : {}), ...(init.headers ?? {}) },
})
const session = (server, email) => encode({ token: { email, name: 'E2E', sub: email }, secret: server.secret })

// Marcadores de datos (nunca sin sesión) y texto libre que nunca debe salir por la API.
const DATA_MARKERS = ['DEMO-', 'Tarea demo', 'Objetivo de demostración']
const FREE_TEXT = ['Persona demo', 'Descripción sintética', 'Falta aprobación', 'Justificación demo', 'Decisión demo', 'Nota sintética', 'Tarea demo', 'Hito demo']
const API = '/api/control'

const A = startServer(Number(process.env.E2E_CONTROL_PORT ?? 3137), { DASHBOARD_DATA_SOURCE: 'fixtures' })
const B = startServer(Number(process.env.E2E_CONTROL_PORT_B ?? 3138), { DASHBOARD_DATA_SOURCE: 'sheets' })
try {
  await Promise.all([waitFor(A.base), waitFor(B.base)])
  const allowed = await session(A, ALLOWED)
  const stranger = await session(A, 'intruso@example.com')

  // 1) Sin sesión o correo no permitido.
  for (const [label, cookie] of [['sin sesión', undefined], ['correo no permitido', stranger]]) {
    const page = await get(A.base, '/control', cookie)
    const body = await page.text()
    check(`${label} /control → redirección a /login sin datos`, [302, 303, 307].includes(page.status) && (page.headers.get('location') ?? '').includes('/login') && !DATA_MARKERS.some((m) => body.includes(m)), `${page.status}`)
    const api = await get(A.base, API, cookie)
    const apiBody = await api.text()
    check(`${label} ${API} → 401/403 sin datos`, [401, 403].includes(api.status) && !DATA_MARKERS.some((m) => apiBody.includes(m)), `${api.status}`)
  }

  // 2) Página con sesión.
  {
    const res = await get(A.base, '/control', allowed)
    const html = await res.text()
    check('/control con sesión → 200', res.status === 200, `${res.status}`)
    check('aviso "Simulación — no se guardaron cambios"', html.includes('Simulación — no se guardaron cambios'))
    check('estado global visible y nunca "todo bien"', html.includes('Estado:') && !/todo bien/i.test(html.replace('No significa "todo bien"', '')))
    check('navegación incluye Control', html.includes('href="/control"'))
    const posts = (text) => (text.match(/<form[^>]*method="post"/gi) ?? []).length
    const reference = await (await get(A.base, '/capacidad', allowed)).text()
    check('el panel no añade formularios POST (mismos que el layout común)', posts(html) === posts(reference), `${posts(html)} vs ${posts(reference)}`)
    check('la página no expone responsables, bloqueos, descripciones ni texto de decisiones', !['Persona demo', 'Falta aprobación', 'Descripción sintética', 'Justificación demo'].some((m) => html.includes(m)))
    const filtered = await (await get(A.base, '/control?severidad=nope', allowed)).text()
    check('filtro inválido en la URL se informa y se ignora (sin error)', filtered.includes('ignorado'))
  }

  // 3) API de solo lectura.
  const api = async (query = '') => {
    const res = await get(A.base, `${API}?fecha=${TODAY}${query ? `&${query}` : ''}`, allowed)
    return { res, json: await res.json().catch(() => null) }
  }
  const base = await api()
  {
    const { res, json } = base
    const alerts = json?.informe?.alertas ?? []
    check('GET API → 200, solo lectura y no-store', res.status === 200 && json?.soloLectura === true && (res.headers.get('cache-control') ?? '').includes('no-store'), `${res.status}`)
    check('informe con alertas, cobertura y estado global', alerts.length > 0 && json.informe.cobertura.length === 8 && typeof json.informe.estadoGlobal === 'string')
    check('cada alerta separa hechos, inferencias, hipótesis y acciones sugeridas', alerts.every((a) => Array.isArray(a.hechos) && Array.isArray(a.inferencias) && Array.isArray(a.hipotesis) && a.acciones.length > 0))
    check('IDs de alerta únicos y sin datos privados', new Set(alerts.map((a) => a.id)).size === alerts.length && alerts.every((a) => /^[a-z0-9-]+-[0-9a-f]{8}$/.test(a.id)))
    const text = JSON.stringify(json)
    check('API sin texto libre ni correos (minimización)', !FREE_TEXT.some((m) => text.includes(m)) && !text.includes('@'), FREE_TEXT.filter((m) => text.includes(m)).join(', '))
    check('aviso: una decisión no autoriza merges ni despliegues', /no autoriza merges, despliegues/.test(json?.aviso ?? ''))
  }
  {
    const again = await api()
    check('misma consulta → mismo informe y huella', JSON.stringify(again.json?.informe) === JSON.stringify(base.json?.informe))
    const media = await api('severidad=media')
    check('filtro severidad=media', media.res.status === 200 && media.json.informe.alertas.length > 0 && media.json.informe.alertas.every((a) => a.severidad === 'media') && media.json.totalSinFiltros === base.json.informe.alertas.length)
    const pos = await api('proyecto=POS&categoria=bloqueos')
    check('filtros proyecto + categoría', pos.res.status === 200 && pos.json.informe.alertas.every((a) => a.proyectoId === 'POS' && a.categoria === 'bloqueos'))
  }
  for (const [query, field] of [['severidad=urgente', 'severidad'], ['categoria=x', 'categoria'], ['tipo=x', 'tipo'], ['foo=1', 'foo'], ['fecha=2026-13-01', 'fecha'], ['proyecto=%3Cscript%3E', 'proyecto'], ['tipo=riesgo&tipo=bloqueo', 'tipo']]) {
    const res = await get(A.base, `${API}?${query}`, allowed)
    const json = await res.json().catch(() => null)
    check(`parámetro inválido ${query} → 400 (${field})`, res.status === 400 && json?.campo === field, `${res.status} ${json?.campo}`)
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const res = await get(A.base, API, allowed, { method, headers: { 'content-type': 'application/json', origin: A.base }, body: JSON.stringify({ aprobar: true }) })
    const body = await res.text()
    check(`${method} ${API} → 405 sin datos`, res.status === 405 && !DATA_MARKERS.some((m) => body.includes(m)), `${res.status}`)
  }
  {
    const after = await api()
    check('tras intentos de mutación, el informe no cambia', JSON.stringify(after.json?.informe) === JSON.stringify(base.json?.informe))
  }

  // 4) Estado de error: fuente Sheets sin configuración ⇒ 503 y página de error, sin datos parciales.
  {
    const cookieB = await session(B, ALLOWED)
    const res = await get(B.base, API, cookieB)
    const json = await res.json().catch(() => null)
    check('fuente no configurada → API 503 sin informe', res.status === 503 && !json?.informe, `${res.status}`)
    const page = await (await get(B.base, '/control', cookieB)).text()
    check('fuente no configurada → página con error y sin datos', page.includes('No se pudieron leer los datos') && !page.includes('Bandeja de atención') && !DATA_MARKERS.some((m) => page.includes(m)))
  }

  check('logs de los servidores sin correos', ![A.log, B.log].some((l) => l.includes(ALLOWED) || l.includes('intruso@')))
} catch (error) {
  check('ejecución', false, error instanceof Error ? error.message : String(error))
} finally {
  for (const s of [A, B]) {
    try {
      process.kill(-s.child.pid, 'SIGTERM')
    } catch {
      // ya terminado
    }
  }
}

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FALLA'} ${r.name}${r.detail && !r.ok ? ` (${r.detail})` : ''}`)
console.log(`\n${results.length - failed.length}/${results.length} comprobaciones correctas.`)
if (failed.length > 0) {
  console.log('\n--- log A ---\n' + A.log.split('\n').slice(-20).join('\n') + '\n--- log B ---\n' + B.log.split('\n').slice(-20).join('\n'))
  process.exit(1)
}
process.exit(0)
