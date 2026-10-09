#!/usr/bin/env node
/**
 * Prueba E2E de autorización contra el build de producción.
 * - Por defecto levanta `next start` (requiere `npm run build`).
 * - Con E2E_BASE_URL apunta a un servidor ya iniciado, p. ej. el contenedor Docker
 *   (scripts/docker-smoke.sh); entonces E2E_NEXTAUTH_SECRET debe ser el secreto de ese servidor.
 *   Solo se permiten destinos locales: esta prueba emite sesiones y nunca debe apuntar a producción.
 * - Usa datos SINTÉTICOS (DASHBOARD_DATA_SOURCE=fixtures) y secretos aleatorios de un solo uso.
 * - No contacta a Google: las sesiones se emiten con el mismo cifrado JWE de NextAuth.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { encode } from 'next-auth/jwt'

const EXTERNAL = process.env.E2E_BASE_URL?.trim()
const PORT = process.env.E2E_PORT ?? '3107'
const BASE = EXTERNAL || `http://127.0.0.1:${PORT}`
const SECRET = EXTERNAL ? process.env.E2E_NEXTAUTH_SECRET : randomBytes(32).toString('base64')
const ALLOWED = process.env.E2E_ALLOWED_EMAIL ?? 'revisor@example.com'
const COOKIE = 'next-auth.session-token'
const webDir = path.resolve(import.meta.dirname, '..')

if (EXTERNAL) {
  const host = new URL(EXTERNAL).hostname
  if (!['127.0.0.1', 'localhost'].includes(host)) {
    console.error('E2E_BASE_URL solo admite servidores locales (127.0.0.1 o localhost).')
    process.exit(2)
  }
  if (!SECRET) {
    console.error('Con E2E_BASE_URL define E2E_NEXTAUTH_SECRET (el secreto del servidor local de prueba).')
    process.exit(2)
  }
}

const env = {
  ...process.env,
  NODE_ENV: 'production',
  NEXT_TELEMETRY_DISABLED: '1',
  DASHBOARD_DATA_SOURCE: 'fixtures',
  NEXTAUTH_SECRET: SECRET,
  NEXTAUTH_URL: BASE,
  AUTH_ALLOWED_EMAILS: ALLOWED,
  GOOGLE_CLIENT_ID: 'e2e-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'e2e-client-secret-no-real',
}
delete env.PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_JSON
delete env.PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_FILE
delete env.K_SERVICE

const server = EXTERNAL
  ? null
  : spawn(path.join(webDir, 'node_modules', '.bin', 'next'), ['start', '-p', PORT, '-H', '127.0.0.1'], {
      cwd: webDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
let serverLog = ''
server?.stdout.on('data', (d) => (serverLog += d))
server?.stderr.on('data', (d) => (serverLog += d))

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
}

async function get(pathname, cookie, init = {}) {
  return fetch(BASE + pathname, {
    redirect: 'manual',
    ...init,
    headers: { ...(cookie ? { cookie: `${COOKIE}=${cookie}` } : {}), ...(init.headers ?? {}) },
  })
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(BASE + '/login', { redirect: 'manual' })
      if (res.status > 0) return
    } catch {
      // aún iniciando
    }
    await sleep(500)
  }
  throw new Error('El servidor no respondió a tiempo')
}

const PRIVATE_PAGES = ['/', '/proyectos', '/proyectos/POS', '/tareas', '/tareas?bloqueo=si', '/actividad', '/capacidad']
// Marcadores que solo aparecen en datos (sintéticos): nunca deben verse sin sesión.
const DATA_MARKERS = ['DEMO-', 'Objetivo de demostración', 'Persona demo']

try {
  await waitForServer()
  const allowed = await encode({ token: { email: ALLOWED, name: 'Revisor', sub: 'e2e' }, secret: SECRET })
  const stranger = await encode({ token: { email: 'intruso@example.com', name: 'X', sub: 'x' }, secret: SECRET })
  const forged = await encode({ token: { email: ALLOWED, name: 'Revisor', sub: 'e2e' }, secret: randomBytes(32).toString('base64') })

  // 1) Sin sesión: páginas privadas redirigen y no incluyen datos.
  for (const p of PRIVATE_PAGES) {
    const res = await get(p)
    const body = await res.text()
    const location = res.headers.get('location') ?? ''
    check(`sin sesión ${p} → redirección a /login`, [302, 303, 307, 308].includes(res.status) && location.includes('/login'), `${res.status}`)
    check(`sin sesión ${p} → sin datos en la respuesta`, !DATA_MARKERS.some((m) => body.includes(m)))
  }

  // 2) Sin sesión: API privada → 401 sin datos.
  {
    const res = await get('/api/resumen')
    const body = await res.text()
    check('sin sesión /api/resumen → 401', res.status === 401, `${res.status}`)
    check('sin sesión /api/resumen → sin datos', !DATA_MARKERS.some((m) => body.includes(m)) && !body.includes('proyectos'))
  }

  // 3) Cookie falsificada (otro secreto) y basura.
  for (const [label, cookie] of [['falsificada', forged], ['basura', 'abc.def.ghi']]) {
    const page = await get('/', cookie)
    const api = await get('/api/resumen', cookie)
    check(`cookie ${label} → página redirige`, [302, 303, 307, 308].includes(page.status), `${page.status}`)
    check(`cookie ${label} → API 401`, api.status === 401, `${api.status}`)
  }

  // 4) Sesión válida de un correo NO permitido.
  {
    const page = await get('/tareas', stranger)
    const api = await get('/api/resumen', stranger)
    check('correo no permitido → página redirige con AccessDenied', (page.headers.get('location') ?? '').includes('error=AccessDenied'), `${page.status}`)
    check('correo no permitido → API 403', api.status === 403, `${api.status}`)
  }

  // 5) Acción de servidor sin sesión (refresco) no pasa del proxy.
  {
    const res = await get('/', undefined, { method: 'POST', headers: { 'Next-Action': 'x', 'Content-Type': 'text/plain' }, body: '[]' })
    check('POST de acción de servidor sin sesión → bloqueado', [302, 303, 307, 308, 401, 403].includes(res.status), `${res.status}`)
  }

  // 6) Rutas públicas no exponen datos.
  {
    const res = await get('/login')
    const body = await res.text()
    check('/login es pública (200)', res.status === 200, `${res.status}`)
    check('/login sin datos ni secretos', !DATA_MARKERS.some((m) => body.includes(m)) && !body.includes(env.GOOGLE_CLIENT_SECRET) && !body.includes(SECRET))
    const session = await get('/api/auth/session')
    check('/api/auth/session sin sesión → objeto vacío', (await session.text()).trim() === '{}')
  }

  // 7) Sesión válida y permitida: todo accesible, con cabeceras privadas.
  for (const p of PRIVATE_PAGES) {
    const res = await get(p, allowed)
    const body = await res.text()
    check(`sesión permitida ${p} → 200`, res.status === 200, `${res.status}`)
    check(`sesión permitida ${p} → marca de datos sintéticos`, body.includes('Datos sintéticos de demostración'))
    check(`sesión permitida ${p} → Cache-Control no-store`, (res.headers.get('cache-control') ?? '').includes('no-store'))
    check(`sesión permitida ${p} → sin secretos en HTML`, !body.includes(env.GOOGLE_CLIENT_SECRET) && !body.includes(SECRET))
  }
  {
    const res = await get('/api/resumen', allowed)
    const json = await res.json()
    check('sesión permitida /api/resumen → 200 con 4 proyectos (fixtures)', res.status === 200 && json.proyectos === 4, `${res.status} ${json.proyectos}`)
    check('resumen distingue tareas abiertas', json.tareas?.abiertas === 3, String(json.tareas?.abiertas))
    // Con loading.tsx la respuesta se transmite en streaming: Next conserva HTTP 200 y renderiza not-found.
    const missing = await get('/proyectos/NO-EXISTE', allowed)
    const missingBody = await missing.text()
    check('proyecto inexistente → página "No encontrado"', missingBody.includes('No encontrado') && !missingBody.includes('Hitos ('), `${missing.status}`)
  }

  // 8) Sonda de salud pública: sin sesión, sin datos, sin detalles de configuración.
  {
    const res = await get('/api/health')
    const body = await res.text()
    check('/api/health sin sesión → 200 {"status":"ok"}', res.status === 200 && JSON.parse(body).status === 'ok', `${res.status}`)
    check('/api/health sin datos', !DATA_MARKERS.some((m) => body.includes(m)) && Object.keys(JSON.parse(body)).length === 1)
  }

  // 9) Cabeceras de seguridad.
  {
    const res = await get('/login')
    check('X-Frame-Options DENY', res.headers.get('x-frame-options') === 'DENY')
    check('X-Robots-Tag noindex', (res.headers.get('x-robots-tag') ?? '').includes('noindex'))
    check('Sin cabecera X-Powered-By', res.headers.get('x-powered-by') === null)
    check('Strict-Transport-Security presente', (res.headers.get('strict-transport-security') ?? '').includes('max-age='))
  }
} catch (error) {
  check('ejecución', false, error instanceof Error ? error.message : String(error))
} finally {
  server?.kill('SIGTERM')
}

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FALLA'} ${r.name}${r.detail && !r.ok ? ` (${r.detail})` : ''}`)
console.log(`\n${results.length - failed.length}/${results.length} comprobaciones correctas.`)
if (failed.length > 0) {
  if (serverLog) console.log('\n--- log del servidor (últimas líneas) ---\n' + serverLog.split('\n').slice(-30).join('\n'))
  process.exit(1)
}
