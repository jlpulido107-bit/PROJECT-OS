import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Preflight estático del despliegue privado V1.6 (Misión 010). Sin red ni Google Cloud: valida que la
 * documentación de despliegue no contenga datos sensibles, que sus enlaces existan, que las puertas 2–4
 * sigan pendientes hasta que el usuario las cambie de forma explícita y que el smoke remoto cubra todas
 * las rutas privadas.
 */
const ROOT = path.resolve(__dirname, '..', '..')
const DOCS = ['docs/despliegue-privado-v1-3.md', 'docs/despliegue-v1-6-preparacion.md', 'docs/despliegue-v1-6-aceptacion.md', 'docs/infra-minima-v1-6-revision.md', 'docs/puerta-c-v1-6.md', 'docs/operacion-v1-6/matriz-aceptacion.md', 'docs/operacion-v1-6/auditoria-seguridad.md', 'docs/operacion-v1-6/evidencia.md',
  'docs/operacion-v1-6/README.md', 'docs/operacion-v1-6/runbook-operativo.md', 'docs/operacion-v1-6/mantenimiento-dependencias.md',
  'docs/operacion-v1-6/backlog-v1-7.md', 'docs/operacion-v1-6/hoja-propietario.md',
  'docs/operacion-v1-6/remediacion-2026-10-11.md']
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8')
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const full = path.join(dir, n)
  return statSync(full).isDirectory() ? files(full) : [full]
})

/** Filas de la primera tabla markdown que sigue al encabezado indicado. */
function tableAfter(text: string, heading: string): string[][] {
  const start = text.indexOf(heading)
  expect(start, heading).toBeGreaterThan(-1)
  const lines = text.slice(start).split('\n')
  const first = lines.findIndex((l) => l.startsWith('|'))
  const rows: string[][] = []
  for (const line of lines.slice(first)) {
    if (!line.startsWith('|')) break
    rows.push(line.split('|').slice(1, -1).map((c) => c.trim()))
  }
  return rows.slice(2) // sin encabezado ni separador
}

describe('documentación de despliegue V1.6', () => {
  it.each(DOCS)('%s: solo correos de ejemplo o marcadores de cuenta de servicio', (doc) => {
    const emails = read(doc).match(/[A-Za-z0-9._%+${}-]+@[A-Za-z0-9.${}-]+\.[A-Za-z]{2,}/g) ?? []
    for (const email of emails) {
      const ok = email.endsWith('@example.com') || /@(\$\{PROJECT_ID\}|PROJECT_ID)\.iam\.gserviceaccount\.com$/.test(email)
      expect(ok, `correo no permitido en ${doc}`).toBe(true)
    }
  })

  it.each(DOCS)('%s: sin secretos, claves, tokens ni identificadores reales de facturación u OAuth', (doc) => {
    const text = read(doc)
    for (const pattern of [
      /GOCSPX-/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /"private_key"/, /AIza[0-9A-Za-z_-]{20,}/, /ya29\.[0-9A-Za-z_-]{10,}/,
      /\b[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}\b/, /\b\d{6,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com/,
    ]) {
      expect(pattern.test(text), `${doc} contiene ${pattern}`).toBe(false)
    }
  })

  it.each(DOCS)('%s: los enlaces relativos apuntan a archivos existentes', (doc) => {
    for (const [, target] of read(doc).matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      if (!target || /^[a-z]+:/i.test(target)) continue
      expect(existsSync(path.join(ROOT, path.dirname(doc), target)), `${doc} → ${target}`).toBe(true)
    }
  })

  it('puerta 1 completada; las puertas 2–4 siguen pendientes (cambiarlas exige un commit explícito)', () => {
    const gates = tableAfter(read('docs/despliegue-privado-v1-3.md'), '## 1. Puertas de autorización')
    expect(gates.map((r) => r[0])).toEqual(['1', '2', '3', '4'])
    expect(gates[0]?.[3]).toMatch(/^Completada/)
    for (const row of gates.slice(1)) expect(row[3], `puerta ${row[0]}`).toMatch(/^Pendiente/)
  })

  it('la matriz de decisiones no asume respuestas del propietario', () => {
    const rows = tableAfter(read('docs/despliegue-v1-6-preparacion.md'), '## 2. Matriz de decisiones del propietario')
    expect(rows.length).toBeGreaterThanOrEqual(8)
    for (const row of rows) expect(row.at(-1), row[1]).toBe('Pendiente')
  })

  it('el runbook y la preparación advierten que /api/health no prueba OAuth ni el acceso real a Sheets', () => {
    for (const doc of DOCS.slice(0, 2)) expect(read(doc), doc).toMatch(/no prueba OAuth ni (el )?(acceso|permiso) real a (Google )?Sheets/i)
    expect(read('docs/despliegue-v1-6-preparacion.md')).toMatch(/no (es|son) un (corte|límite)/i)
  })

  it('el checklist de aceptación cubre todos los puntos exigidos por la misión', () => {
    const text = read('docs/despliegue-v1-6-aceptacion.md')
    for (const item of [
      'Invitado autorizado', 'no autorizada', '`401`', '`403`', 'Planificación', 'Centro de control', 'Secret Manager',
      'Sin correos ni tokens', 'smoke:remote', 'Facturación', 'Rollback', 'Solo lectura real',
    ]) expect(text, item).toContain(item)
  })
})

describe('smoke remoto (scripts/smoke-remote.mjs)', () => {
  const script = read('web/scripts/smoke-remote.mjs')
  const list = (name: string) => {
    const match = script.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\]`))
    expect(match, name).not.toBeNull()
    return [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '')
  }
  const toPattern = (route: string) => new RegExp(`^${route.replace(/\[[^\]]+\]/g, '[^/]+')}$`)

  it('cubre todas las páginas privadas', () => {
    const appDir = path.join(ROOT, 'web', 'src', 'app', '(private)')
    const routes = files(appDir).filter((f) => f.endsWith('page.tsx'))
      .map((f) => `/${path.relative(appDir, path.dirname(f)).split(path.sep).join('/')}`.replace(/\/$/, '') || '/')
    const pages = list('PRIVATE_PAGES')
    for (const route of routes) expect(pages.some((p) => toPattern(route).test(p)), route).toBe(true)
  })

  it('cubre todas las APIs privadas (todas salvo NextAuth y la sonda)', () => {
    const apiDir = path.join(ROOT, 'web', 'src', 'app', 'api')
    const routes = files(apiDir).filter((f) => f.endsWith('route.ts'))
      .map((f) => `/api/${path.relative(apiDir, path.dirname(f)).split(path.sep).join('/')}`)
      .filter((r) => !r.startsWith('/api/auth/') && r !== '/api/health')
    const apis = list('PRIVATE_APIS')
    for (const route of routes) expect(apis.some((p) => toPattern(route).test(p)), route).toBe(true)
  })

  it('solo usa GET, sin cookies ni cuerpos de respuesta impresos', () => {
    expect(script).not.toMatch(/method:/)
    expect(script).not.toMatch(/['"]?cookie['"]?\s*:/i)
    expect(script).not.toMatch(/console\.log\([^)]*(text\(\)|json\(\)|Body)/)
  })
})
