import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { gruposMenu } from '@/lib/nav'

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
  '', 'actividad', 'agentes', 'capacidad', 'control', 'decisiones/nueva', 'eco', 'eco/cotizaciones', 'eco/pipeline', 'estado', 'finanzas', 'metricas', 'operaciones', 'ordenes', 'ordenes/nueva', 'planificacion', 'proyectos', 'proyectos/[id]',
  'tareas', 'tareas/[id]/editar', 'tareas/nueva', 'tiempos/nuevo',
]

describe('árbol integrado V1.3–V1.6', () => {
  it('las 22 páginas privadas existen y verifican la sesión antes de leer datos', () => {
    const found = files(path.join(SRC, 'app', '(private)')).filter((f) => f.endsWith('page.tsx'))
      .map((f) => path.relative(path.join(SRC, 'app', '(private)'), path.dirname(f)).split(path.sep).join('/')).sort()
    expect(found).toEqual([...PAGES].sort())
    // /eco (ORD-POS-067): privateEco verifica la sesión y solo después lee RADAROS.
    // /eco/pipeline (ORD-POS-097) usa el mismo lector, igual de verificado.
    // /finanzas (ORD-POS-074): privateFinanzas, igual, antes de leer FINANZAS.
    // /eco/cotizaciones (ORD-POS-150) ya no lee datos: verifica la sesión con requireUser y redirige a /eco/pipeline.
    const lector: Record<string, RegExp> = { eco: /privateEco\(/, 'eco/pipeline': /privateEco\(/, 'eco/cotizaciones': /await requireUser\('\/eco\/cotizaciones'\)\n\s+redirect\(/, finanzas: /privateFinanzas\(/ }
    for (const page of PAGES) expect(read(path.join('app', '(private)', page, 'page.tsx')), page).toMatch(lector[page] ?? /privateData\(/)
  })

  it('toda API (salvo NextAuth y la sonda pública) exige sesión en el servidor antes de leer o escribir', () => {
    const apiDir = path.join(SRC, 'app', 'api')
    const routes = files(apiDir).filter((f) => f.endsWith('route.ts')).map((f) => path.relative(apiDir, f).split(path.sep).join('/')).sort()
    expect(routes).toEqual([
      'auth/[...nextauth]/route.ts', 'control/route.ts',
      'eco/pipeline/bandeja/[id]/confirmar/route.ts', 'eco/pipeline/bandeja/[id]/rechazar/route.ts',
      'eco/pipeline/cotizaciones/[id]/route.ts', 'eco/pipeline/cotizaciones/pedir/route.ts', 'eco/pipeline/cotizaciones/route.ts', 'eco/pipeline/embarques/[id]/route.ts', 'eco/pipeline/embarques/route.ts',
      'eco/pipeline/productos/[id]/etapa/route.ts', 'eco/pipeline/productos/[id]/route.ts', 'eco/pipeline/productos/route.ts', 'eco/pipeline/proveedores/[id]/route.ts', 'eco/pipeline/proveedores/route.ts',
      'finanzas/agente/cargo-extra/route.ts', 'finanzas/agente/rendimiento/route.ts', 'finanzas/movimientos/route.ts', 'finanzas/recurrentes/confirmar/route.ts', 'health/route.ts', 'operaciones/capacidad/route.ts', 'operaciones/decisiones/route.ts', 'operaciones/escenarios/archivar/route.ts', 'operaciones/escenarios/route.ts', 'operaciones/ideas/route.ts', 'operaciones/ordenes/[id]/ejecutar/route.ts', 'operaciones/ordenes/[id]/route.ts', 'operaciones/ordenes/[id]/supervision/route.ts', 'operaciones/ordenes/route.ts', 'operaciones/plan-dia/route.ts',
      'operaciones/tareas/[id]/completar/route.ts', 'operaciones/tareas/[id]/route.ts', 'operaciones/tareas/route.ts', 'operaciones/tiempos/route.ts', 'planificacion/calendario.ics/route.ts', 'planificacion/route.ts', 'resumen/route.ts',
    ])
    for (const route of routes) {
      if (route.startsWith('auth/') || route === 'health/route.ts') continue
      const text = readFileSync(path.join(apiDir, route), 'utf8')
      if (route.startsWith('operaciones/')) expect(text, route).toMatch(/handleWrite\(request,/)
      // ORD-POS-092: el agente de finanzas, sin sesión, con su token y su guard propio (diseño v3 §2.3).
      else if (route.startsWith('finanzas/agente/')) {
        expect(text, route).toMatch(/handleFinanzasAgente\(request,/)
        expect(text, route).not.toMatch(/export (async )?function (GET|PUT|PATCH|DELETE)/)
      }
      // ORD-POS-102: escritura del pipeline de /eco con su guard propio (sesión del único escritor, sin agente, sin DELETE).
      else if (route.startsWith('eco/pipeline/')) {
        expect(text, route).toMatch(/handleEcoWrite\(request,/)
        expect(text, route).not.toMatch(/export (async )?function (GET|PUT|DELETE)/)
      }
      // ORD-POS-077: escritura de finanzas con su guard propio (sesión del único escritor, sin agente).
      else if (route.startsWith('finanzas/')) {
        expect(text, route).toMatch(/handleFinanzasWrite\(request,/)
        expect(text, route).not.toMatch(/export (async )?function (GET|PUT|PATCH|DELETE)/)
      }
      // ORD-POS-142: calendario ICS sin sesión; solo GET y el secreto del enlace antes de leer la hoja (escritura §11.3).
      else if (route === 'planificacion/calendario.ics/route.ts') {
        expect(text, route).toMatch(/export async function GET\(/)
        expect(text, route).not.toMatch(/export (async )?function (POST|PUT|PATCH|DELETE|HEAD|OPTIONS)/)
        expect(text.indexOf('esSecretoDelCalendario('), route).toBeGreaterThan(-1)
        expect(text.indexOf('esSecretoDelCalendario('), route).toBeLessThan(text.indexOf('getDataset()'))
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
    // ORD-POS-126: los grupos viven en lib/nav.ts; sin booleanos solo quedan los de lectura.
    const nav = read(path.join('lib', 'nav.ts'))
    const base = gruposMenu().flatMap((g) => g.items.map((i) => i.href))
    expect(base).toContain('/planificacion')
    expect(base).toContain('/control')
    expect(base).not.toContain('/operaciones')
    expect(gruposMenu({ showOperations: true }).flatMap((g) => g.items.map((i) => i.href))).toContain('/operaciones')
    expect(nav).toMatch(/showOperations \? \[\{ id: 'operaciones', [^\n]*\{ href: '\/operaciones'/)
    expect(nav).toMatch(/showEco\s*\? \[\{ id: 'radaros', [^\n]*\{ href: '\/eco'/)
    expect(nav).toMatch(/showFinanzas \? \[\{ id: 'finanzas', [^\n]*\{ href: '\/finanzas'/)
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
