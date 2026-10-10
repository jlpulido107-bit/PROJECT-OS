#!/usr/bin/env node
/**
 * Smoke test SIN SESIÓN contra un despliegue (p. ej. Cloud Run), para ejecutar manualmente
 * solo después de que el usuario autorice el despliegue:
 *
 *   node scripts/smoke-remote.mjs --url https://SERVICIO-NUMERO.REGION.run.app
 *
 * - No inicia sesión, no emite cookies y no lee datos: solo verifica que lo privado está cerrado.
 * - Imprime únicamente códigos de estado y OK/FALLA; nunca cuerpos de respuesta.
 * - No se ejecuta en CI.
 */
const arg = process.argv.indexOf('--url')
const raw = arg > -1 ? process.argv[arg + 1] : undefined
if (!raw) {
  console.error('Uso: node scripts/smoke-remote.mjs --url https://…')
  process.exit(2)
}
const base = new URL(raw)
if (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname)) {
  console.error('La URL debe ser HTTPS.')
  process.exit(2)
}
const origin = base.origin

const results = []
const check = (name, ok, detail) => results.push({ name, ok, detail })
const get = (path) => fetch(origin + path, { redirect: 'manual', headers: { 'user-agent': 'project-os-smoke' } })

const health = await get('/api/health')
const healthBody = await health.json().catch(() => ({}))
check('/api/health → 200 {"status":"ok"}', health.status === 200 && healthBody.status === 'ok', health.status)

for (const path of ['/', '/proyectos', '/tareas', '/actividad', '/capacidad']) {
  const res = await get(path)
  const location = res.headers.get('location') ?? ''
  check(`${path} sin sesión → redirección a /login`, res.status >= 300 && res.status < 400 && location.includes('/login'), res.status)
  await res.body?.cancel()
}

const api = await get('/api/resumen')
const apiBody = await api.json().catch(() => ({}))
check('/api/resumen sin sesión → 401 sin datos', api.status === 401 && Object.keys(apiBody).join() === 'error', api.status)

const login = await get('/login')
check('/login → 200', login.status === 200, login.status)
check('Strict-Transport-Security', (login.headers.get('strict-transport-security') ?? '').includes('max-age='), '')
check('Cache-Control no-store', (login.headers.get('cache-control') ?? '').includes('no-store'), '')
check('X-Frame-Options DENY', login.headers.get('x-frame-options') === 'DENY', '')
await login.body?.cancel()

const session = await get('/api/auth/session')
check('/api/auth/session sin sesión → {}', (await session.text()).trim() === '{}', session.status)

for (const r of results) console.log(`${r.ok ? 'OK   ' : 'FALLA'} ${r.name}${r.ok ? '' : ` (HTTP ${r.detail})`}`)
const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} comprobaciones correctas.`)
process.exit(failed ? 1 : 0)
