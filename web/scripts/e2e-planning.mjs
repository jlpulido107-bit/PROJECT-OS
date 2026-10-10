#!/usr/bin/env node
/**
 * Prueba E2E de la planificación V1.5 contra el build de producción (`next start`).
 * - Datos SINTÉTICOS (DASHBOARD_DATA_SOURCE=fixtures), secretos aleatorios de un solo uso y sesiones JWE locales.
 * - Nunca contacta a Google ni a Sheets.
 * Verifica: acceso solo con sesión autorizada, API de solo lectura (sin métodos mutadores), validación de
 * escenarios, determinismo y minimización de datos.
 * Requisito: `npm run build` antes de ejecutar.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { encode } from 'next-auth/jwt'

const PORT = process.env.E2E_PLANNING_PORT ?? '3127'
const BASE = `http://127.0.0.1:${PORT}`
const SECRET = randomBytes(32).toString('base64')
const ALLOWED = 'planificadora@example.com'
const COOKIE = 'next-auth.session-token'
const webDir = path.resolve(import.meta.dirname, '..')
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Merida' }).format(new Date())

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

const server = spawn(path.join(webDir, 'node_modules', '.bin', 'next'), ['start', '-p', PORT, '-H', '127.0.0.1'], {
  cwd: webDir,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})
let serverLog = ''
server.stdout.on('data', (d) => (serverLog += d))
server.stderr.on('data', (d) => (serverLog += d))
const stop = () => {
  try {
    process.kill(-server.pid, 'SIGTERM')
  } catch {
    // ya terminado
  }
}

const results = []
const check = (name, ok, detail = '') => results.push({ name, ok, detail })

function get(pathname, cookie, init = {}) {
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

// Marcadores de datos: nunca sin sesión. Responsables, descripciones y notas nunca en la planificación.
const DATA_MARKERS = ['DEMO-', 'Tarea demo', 'Objetivo de demostración']
const NOT_IN_PLANNING = ['Persona demo', 'Descripción sintética', 'Nota sintética', 'Espera una aprobación']
const API = '/api/planificacion'

try {
  await waitForServer()
  const allowed = await encode({ token: { email: ALLOWED, name: 'Planificadora', sub: 'e2e' }, secret: SECRET })
  const stranger = await encode({ token: { email: 'intruso@example.com', name: 'X', sub: 'x' }, secret: SECRET })

  // 1) Sin sesión o con correo no permitido: sin planificación.
  for (const [label, cookie] of [['sin sesión', undefined], ['correo no permitido', stranger]]) {
    const page = await get('/planificacion', cookie)
    const pageBody = await page.text()
    check(`${label} /planificacion → redirección a /login sin datos`, [302, 303, 307].includes(page.status) && (page.headers.get('location') ?? '').includes('/login') && !DATA_MARKERS.some((m) => pageBody.includes(m)), `${page.status}`)
    const api = await get(`${API}?horasSiFaltan=20`, cookie)
    const apiBody = await api.text()
    check(`${label} ${API} → 401/403 sin datos`, [401, 403].includes(api.status) && !DATA_MARKERS.some((m) => apiBody.includes(m)), `${api.status}`)
  }

  // 2) Página con sesión: aviso de simulación, sin formularios que envíen al servidor y datos minimizados.
  {
    const res = await get('/planificacion', allowed)
    const html = await res.text()
    check('sesión permitida /planificacion → 200', res.status === 200, `${res.status}`)
    check('la página muestra "Simulación — sin cambios guardados"', html.includes('Simulación — sin cambios guardados'))
    check('la página incluye diagnóstico (fixtures sin horas disponibles)', html.includes('Faltan datos para proponer un plan'))
    // Las únicas acciones POST son las del layout común (actualizar datos, cerrar sesión): las mismas que /capacidad.
    const posts = (text) => (text.match(/<form[^>]*method="post"/gi) ?? []).length
    const reference = await (await get('/capacidad', allowed)).text()
    check('la planificación no añade formularios POST (mismos que el layout común)', posts(html) === posts(reference), `${posts(html)} vs ${posts(reference)}`)
    check('la página no expone responsables, descripciones ni notas', !NOT_IN_PLANNING.some((m) => html.includes(m)), NOT_IN_PLANNING.filter((m) => html.includes(m)).join(', '))
    check('navegación incluye Planificación', html.includes('href="/planificacion"'))
  }

  // 3) API de solo lectura con sesión.
  const fetchPlan = async (query) => {
    const res = await get(`${API}?fecha=${TODAY}${query ? `&${query}` : ''}`, allowed)
    return { res, json: await res.json().catch(() => null) }
  }
  {
    const { res, json } = await fetchPlan('')
    check('GET API sin escenario → 200 y datos insuficientes (sin plan ficticio)', res.status === 200 && json?.plan?.estado === 'datos-insuficientes' && json.plan.capacidad.propuestoMin === 0, `${res.status} ${json?.plan?.estado}`)
    check('respuesta marcada como simulación y no-store', json?.simulacion === true && (res.headers.get('cache-control') ?? '').includes('no-store'))
    check('pregunta concreta por la capacidad faltante', json?.plan?.preguntas?.some((q) => q.codigo === 'capacidad-faltante'))
  }
  let baseline
  {
    const { res, json } = await fetchPlan('horasSiFaltan=20&horasSiSinEstimacion=2')
    baseline = json
    const plan = json?.plan
    const scheduled = new Set((plan?.dias ?? []).flatMap((d) => d.items.map((i) => i.tareaId)))
    const byId = new Map((plan?.tareas ?? []).map((t) => [t.id, t]))
    check('escenario explícito → propuesta marcada como supuesto', res.status === 200 && plan?.estado === 'propuesta' && plan.capacidad.origen === 'supuesto', `${res.status} ${plan?.estado}`)
    check('propuesto ≤ capacidad libre ≤ neta', plan && plan.capacidad.propuestoMin <= plan.capacidad.libreMin && plan.capacidad.libreMin <= plan.capacidad.netaMin)
    check('no propone bloqueadas, sin estado ni con dependencias pendientes', !scheduled.has('DEMO-003') && !scheduled.has('DEMO-004') && !scheduled.has('DEMO-005') && !scheduled.has('DEMO-001'))
    check('explica exclusiones (bloqueada, sin estado, dependencia)', byId.get('DEMO-003')?.motivos.includes('bloqueada') && byId.get('DEMO-004')?.motivos.includes('sin-estado') && byId.get('DEMO-005')?.motivos.includes('dependencia-pendiente'))
    const text = JSON.stringify(json)
    check('API sin responsables, descripciones, notas ni correos', !NOT_IN_PLANNING.some((m) => text.includes(m)) && !text.includes('@'))
  }

  // 4) Determinismo.
  {
    const again = await fetchPlan('horasSiFaltan=20&horasSiSinEstimacion=2')
    check('misma consulta → misma propuesta y misma huella', JSON.stringify(again.json?.plan) === JSON.stringify(baseline?.plan) && again.json?.plan?.huella === baseline?.plan?.huella)
    const other = await fetchPlan('horasSiFaltan=20&horasSiSinEstimacion=2&reservaPct=50')
    check('otro escenario → otra huella', other.json?.plan?.huella && other.json.plan.huella !== baseline?.plan?.huella)
  }

  // 5) Validación de parámetros (nunca se corrige en silencio).
  for (const [query, field] of [['reservaPct=150', 'reservaPct'], ['foo=1', 'foo'], ['fecha=2026-13-01', 'fecha'], ['semana=pasada', 'semana'], ['ajusteHoras=1e9', 'ajusteHoras'], ['prioridad.POS=MAXIMA', 'prioridadProyecto']]) {
    const res = await get(`${API}?${query}`, allowed)
    const json = await res.json().catch(() => null)
    check(`parámetro inválido ${query} → 400 (${field})`, res.status === 400 && json?.campo === field, `${res.status} ${json?.campo}`)
  }

  // 6) Sin métodos mutadores: la API no acepta escrituras ni "aplicar" propuestas.
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const res = await get(API, allowed, {
      method,
      headers: { 'content-type': 'application/json', origin: BASE, 'x-project-os-csrf': '1' },
      body: JSON.stringify({ aplicar: true }),
    })
    const body = await res.text()
    check(`${method} ${API} → 405 sin datos`, res.status === 405 && !DATA_MARKERS.some((m) => body.includes(m)), `${res.status}`)
  }
  {
    const after = await fetchPlan('horasSiFaltan=20&horasSiSinEstimacion=2')
    check('tras intentos de escritura, la propuesta no cambia', JSON.stringify(after.json?.plan) === JSON.stringify(baseline?.plan))
  }

  // 7) Logs sin correos ni contenido.
  check('logs del servidor sin correos', !serverLog.includes(ALLOWED) && !serverLog.includes('intruso@'))
} catch (error) {
  check('ejecución', false, error instanceof Error ? error.message : String(error))
} finally {
  stop()
}

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FALLA'} ${r.name}${r.detail && !r.ok ? ` (${r.detail})` : ''}`)
console.log(`\n${results.length - failed.length}/${results.length} comprobaciones correctas.`)
if (failed.length > 0) {
  if (serverLog) console.log('\n--- log del servidor (últimas líneas) ---\n' + serverLog.split('\n').slice(-30).join('\n'))
  process.exit(1)
}
process.exit(0)
