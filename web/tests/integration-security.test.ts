import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Garantías del árbol integrado V1.3–V1.6 en `main`: todas las páginas y APIs con autorización del
 * servidor, navegación por rol y producción sin escritura.
 */
const SRC = path.resolve(__dirname, '..', 'src')
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const full = path.join(dir, n)
  return statSync(full).isDirectory() ? files(full) : [full]
})
const read = (rel: string) => readFileSync(path.join(SRC, rel), 'utf8')

const PAGES = [
  '', 'actividad', 'capacidad', 'control', 'decisiones/nueva', 'eco', 'estado', 'finanzas', 'metricas', 'operaciones', 'ordenes', 'ordenes/nueva', 'planificacion', 'proyectos', 'proyectos/[id]',
  'tareas', 'tareas/[id]/editar', 'tareas/nueva', 'tiempos/nuevo',
]

describe('árbol integrado V1.3–V1.6', () => {
  it('las 18 páginas privadas existen y verifican la sesión antes de leer datos', () => {
    const found = files(path.join(SRC, 'app', '(private)')).filter((f) => f.endsWith('page.tsx'))
      .map((f) => path.relative(path.join(SRC, 'app', '(private)'), path.dirname(f)).split(path.sep).join('/')).sort()
    expect(found).toEqual([...PAGES].sort())
    // /eco (ORD-POS-067): privateEco verifica la sesión y solo después lee RADAROS.
    // /finanzas (ORD-POS-074): privateFinanzas, igual, antes de leer FINANZAS.
    const lector: Record<string, RegExp> = { eco: /privateEco\(/, finanzas: /privateFinanzas\(/ }
    for (const page of PAGES) expect(read(path.join('app', '(private)', page, 'page.tsx')), page).toMatch(lector[page] ?? /privateData\(/)
  })

  it('toda API (salvo NextAuth y la sonda pública) exige sesión en el servidor antes de leer o escribir', () => {
    const apiDir = path.join(SRC, 'app', 'api')
    const routes = files(apiDir).filter((f) => f.endsWith('route.ts')).map((f) => path.relative(apiDir, f).split(path.sep).join('/')).sort()
    expect(routes).toEqual([
      'auth/[...nextauth]/route.ts', 'control/route.ts', 'finanzas/movimientos/route.ts', 'finanzas/recurrentes/confirmar/route.ts', 'health/route.ts', 'operaciones/decisiones/route.ts', 'operaciones/ordenes/[id]/ejecutar/route.ts', 'operaciones/ordenes/[id]/route.ts', 'operaciones/ordenes/[id]/supervision/route.ts', 'operaciones/ordenes/route.ts',
      'operaciones/tareas/[id]/route.ts', 'operaciones/tareas/route.ts', 'operaciones/tiempos/route.ts', 'planificacion/route.ts', 'resumen/route.ts',
    ])
    for (const route of routes) {
      if (route.startsWith('auth/') || route === 'health/route.ts') continue
      const text = readFileSync(path.join(apiDir, route), 'utf8')
      if (route.startsWith('operaciones/')) expect(text, route).toMatch(/handleWrite\(request,/)
      // ORD-POS-077: escritura de finanzas con su guard propio (sesión del único escritor, sin agente).
      else if (route.startsWith('finanzas/')) {
        expect(text, route).toMatch(/handleFinanzasWrite\(request,/)
        expect(text, route).not.toMatch(/export (async )?function (GET|PUT|PATCH|DELETE)/)
      }
      else {
        expect(text, route).toMatch(/export async function GET\(/)
        expect(text, route).not.toMatch(/export (async )?function (POST|PUT|PATCH|DELETE)/)
        expect(text.indexOf('currentUser()'), route).toBeGreaterThan(-1)
        expect(text.indexOf('currentUser()'), route).toBeLessThan(text.indexOf('getDataset()'))
      }
    }
    expect(read(path.join('app', 'api', 'health', 'route.ts'))).not.toMatch(/getDataset|getServerSession|currentUser/)
  })

  it('navegación: Planificación y Control para lectores; Operaciones solo con showOperations (escritor en mock)', () => {
    const nav = read(path.join('components', 'nav-links.tsx'))
    const base = nav.slice(nav.indexOf('const LINKS'), nav.indexOf(']') + 1)
    expect(base).toContain("'/planificacion'")
    expect(base).toContain("'/control'")
    expect(base).not.toContain('/operaciones')
    expect(nav).toMatch(/showOperations \? \[\{ href: '\/operaciones'/)
    expect(nav).toMatch(/showEco \? \[\{ href: '\/eco'/)
    expect(nav).toMatch(/showFinanzas \? \[\{ href: '\/finanzas'/)
    const layout = read(path.join('app', '(private)', 'layout.tsx'))
    expect(layout).toMatch(/showOperations=\{/)
  })

  it('producción: la sonda de Cloud Run solo acepta escritura sheets bien configurada y el mock exige fixtures fuera de Cloud Run', () => {
    expect(read(path.join('lib', 'deployment.ts'))).toContain("problems.push('write-mode')")
    const config = read(path.join('lib', 'operations', 'config.ts'))
    expect(config).toMatch(/K_SERVICE/)
    expect(config).toMatch(/requested === 'sheets'[\s\S]*?mode: 'disabled'/)
  })

  it('data.ts combina el proveedor de tokens de V1.3 (solo lectura) con el mock de V1.4, sin JWT por omisión', () => {
    const data = read(path.join('lib', 'data.ts'))
    expect(data).toContain('createTokenProvider()')
    expect(data).toContain('mockWriteTabs()')
    expect(data).toContain('writeGeneration()')
    expect(data).not.toMatch(/new JWT\(|google-auth-library/)
    expect(read(path.join('lib', 'credentials.ts'))).toMatch(/spreadsheets\.readonly/)
  })
})
