import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { focoAtrapado, GRUPOS_BARRA, gruposMenu, rutaActiva } from '@/lib/nav'

// ORD-POS-126: menú en 9 grupos con subpestañas.
let ruta = '/'
vi.mock('next/navigation', () => ({ usePathname: () => ruta }))
const { NavLinks } = await import('@/components/nav-links')

const TODAS = { showEco: true, showFinanzas: true, showOperations: true }
const src = (...p: string[]) => readFileSync(path.join(__dirname, '..', 'src', ...p), 'utf8')

// Las 16 rutas de hoy (ORD-POS-149: /eco/cotizaciones), con su grupo y su subpestaña esperados.
const RUTAS: Array<[string, string, string]> = [
  ['/', 'inicio', '/'],
  ['/ordenes', 'ordenes', '/ordenes'],
  ['/control', 'ordenes', '/control'],
  ['/metricas', 'ordenes', '/metricas'],
  ['/tareas', 'tareas', '/tareas'],
  ['/planificacion', 'planificacion', '/planificacion'],
  ['/capacidad', 'planificacion', '/capacidad'],
  ['/proyectos', 'proyectos', '/proyectos'],
  ['/estado', 'proyectos', '/estado'],
  ['/eco', 'radaros', '/eco'],
  ['/eco/pipeline', 'radaros', '/eco/pipeline'],
  ['/eco/cotizaciones', 'radaros', '/eco/cotizaciones'],
  ['/finanzas', 'finanzas', '/finanzas'],
  ['/agentes', 'agentes', '/agentes'],
  ['/actividad', 'agentes', '/actividad'],
  ['/operaciones', 'operaciones', '/operaciones'],
]

describe('grupos y rutas (criterio 1)', () => {
  it('9 grupos con las 16 rutas, sin duplicados y cada una con su página', () => {
    const g = gruposMenu(TODAS)
    expect(g.map((x) => x.id)).toEqual(['inicio', 'ordenes', 'tareas', 'planificacion', 'proyectos', 'radaros', 'finanzas', 'agentes', 'operaciones'])
    const hrefs = g.flatMap((x) => x.items.map((i) => i.href))
    expect(hrefs).toHaveLength(16)
    expect(new Set(hrefs)).toEqual(new Set(RUTAS.map(([r]) => r)))
    for (const h of hrefs) {
      const page = h === '/' ? ['app', '(private)', 'page.tsx'] : ['app', '(private)', ...h.slice(1).split('/'), 'page.tsx']
      expect(() => src(...page), h).not.toThrow()
    }
  })
})

describe('visibilidad de las condicionadas (criterio 2)', () => {
  it('sin booleanos no aparecen RADAROS, Pipeline, Finanzas ni Operaciones', () => {
    const hrefs = gruposMenu().flatMap((g) => g.items.map((i) => i.href))
    expect(hrefs).toHaveLength(11)
    for (const h of ['/eco', '/eco/pipeline', '/eco/cotizaciones', '/finanzas', '/operaciones']) expect(hrefs).not.toContain(h)
    expect(hrefs).toContain('/actividad')
  })

  it('cada booleano enciende solo su grupo', () => {
    const ids = (o: Parameters<typeof gruposMenu>[0]) => gruposMenu(o).map((g) => g.id)
    expect(ids({ showEco: true })).toEqual(['inicio', 'ordenes', 'tareas', 'planificacion', 'proyectos', 'radaros', 'agentes'])
    expect(ids({ showFinanzas: true })).toEqual(['inicio', 'ordenes', 'tareas', 'planificacion', 'proyectos', 'finanzas', 'agentes'])
    expect(ids({ showOperations: true })).toEqual(['inicio', 'ordenes', 'tareas', 'planificacion', 'proyectos', 'agentes', 'operaciones'])
  })

  it('Actividad nunca queda dentro de un grupo condicionado', () => {
    const agentes = gruposMenu().find((g) => g.id === 'agentes')
    expect(agentes?.items.map((i) => i.href)).toEqual(['/agentes', '/actividad'])
    for (const id of ['radaros', 'finanzas', 'operaciones']) {
      expect(gruposMenu(TODAS).find((g) => g.id === id)?.items.map((i) => i.href)).not.toContain('/actividad')
    }
  })

  it('el componente arranca con las condicionadas apagadas y el layout las enciende con los booleanos de siempre', () => {
    ruta = '/'
    const h = renderToStaticMarkup(createElement(NavLinks))
    for (const href of ['/eco', '/eco/pipeline', '/finanzas', '/operaciones']) expect(h).not.toContain(`href="${href}"`)
    const nav = src('components', 'nav-links.tsx')
    expect(nav).toContain('showOperations = false, showEco = false, showFinanzas = false')
    const layout = src('app', '(private)', 'layout.tsx')
    expect(layout).toContain('showOperations={writes} showEco={radarosSheetId() !== null} showFinanzas={finanzasSheetId() !== null}')
  })
})

describe('grupo y subpestaña activos (criterio 3)', () => {
  for (const [r, grupo, href] of RUTAS) {
    it(`${r} → ${grupo} · ${href}`, () => {
      expect(rutaActiva(r, gruposMenu(TODAS))).toEqual({ grupo, href })
    })
  }

  it('subrutas heredan su pestaña y gana el más largo: en /eco/pipeline, Pipeline', () => {
    const g = gruposMenu(TODAS)
    expect(rutaActiva('/ordenes/ORD-POS-001', g)).toEqual({ grupo: 'ordenes', href: '/ordenes' })
    expect(rutaActiva('/eco/pipeline/PRD-0001', g)).toEqual({ grupo: 'radaros', href: '/eco/pipeline' })
    expect(rutaActiva('/ecox', g)).toEqual({ grupo: null, href: null })
    expect(rutaActiva('/login', g)).toEqual({ grupo: null, href: null })
  })

  it('en /eco/pipeline el grupo RADAROS y la subpestaña Pipeline llevan aria-current="page"; RADAROS (/eco) no', () => {
    ruta = '/eco/pipeline'
    const h = renderToStaticMarkup(createElement(NavLinks, TODAS))
    expect(h).toMatch(/<a aria-current="page" href="\/eco">RADAROS<\/a><ul class="nav-subs"/)
    expect(h).toMatch(/<a aria-current="page" href="\/eco\/pipeline">Pipeline<\/a>/)
    expect(h).toContain('<li><a href="/eco">RADAROS</a></li>')
    expect(h).not.toMatch(/<li><a aria-current="page" href="\/eco">RADAROS<\/a><\/li>/)
    expect(h).toContain('class="nav-mas nav-mas-activo"')
  })

  it('en /control: grupo Órdenes y subpestaña Control, nada más', () => {
    ruta = '/control'
    const h = renderToStaticMarkup(createElement(NavLinks, TODAS))
    const actuales = [...h.matchAll(/<a aria-current="page" href="([^"]+)">([^<]+)<\/a>/g)].map((m) => `${m[1]} ${m[2]}`)
    // Lateral: grupo y subpestaña; celular: subpestaña y botón de la barra inferior.
    expect(actuales).toEqual(['/ordenes Órdenes', '/control Control', '/control Control', '/ordenes Órdenes'])
  })
})

describe('celular (criterio 4)', () => {
  it('barra inferior Inicio · Órdenes · Tareas · Plan · Más; la hoja arranca cerrada', () => {
    ruta = '/'
    const h = renderToStaticMarkup(createElement(NavLinks, TODAS))
    const barra = h.slice(h.indexOf('<ul class="nav-bottom">'))
    const etiquetas = [...barra.matchAll(/>([^<>]+)<\/(?:a|button)>/g)].map((m) => m[1])
    expect(etiquetas).toEqual(['Inicio', 'Órdenes', 'Tareas', 'Plan', 'Más'])
    expect(GRUPOS_BARRA).toEqual(['inicio', 'ordenes', 'tareas', 'planificacion'])
    expect(barra).toContain('aria-haspopup="dialog"')
    expect(barra).toContain('aria-expanded="false"')
    expect(h).not.toContain('role="dialog"')
  })

  it('la hoja es un diálogo modal con Cerrar, Escape y foco atrapado', () => {
    const nav = src('components', 'nav-links.tsx')
    expect(nav).toContain('role="dialog"')
    expect(nav).toContain('aria-modal="true"')
    expect(nav).toContain(">Cerrar</button>")
    expect(nav).toContain("e.key === 'Escape'")
    expect(nav).toContain('focoAtrapado(')
  })

  it('el foco da la vuelta dentro de la hoja con Tab y Mayús+Tab', () => {
    expect(focoAtrapado(0, 3, false)).toBe(1)
    expect(focoAtrapado(2, 3, false)).toBe(0)
    expect(focoAtrapado(0, 3, true)).toBe(2)
    expect(focoAtrapado(-1, 3, false)).toBe(0)
    expect(focoAtrapado(-1, 3, true)).toBe(2)
    expect(focoAtrapado(0, 0, false)).toBe(-1)
  })

  it('la barra inferior y la hoja respetan env(safe-area-inset-bottom)', () => {
    const css = src('app', 'globals.css')
    const barra = css.slice(css.indexOf('  .nav-bottom {'), css.indexOf('}', css.indexOf('  .nav-bottom {')))
    expect(barra).toContain('env(safe-area-inset-bottom)')
    expect(css.slice(css.indexOf('.nav-hoja {'))).toContain('env(safe-area-inset-bottom)')
    expect(src('app', 'layout.tsx')).toContain("viewportFit: 'cover'")
  })
})

describe('implementación (criterio 5)', () => {
  beforeEach(() => { ruta = '/' })
  it('usa next/link y usePathname, sin Tailwind ni correo', () => {
    const nav = src('components', 'nav-links.tsx')
    expect(nav).toContain("import Link from 'next/link'")
    expect(nav).toContain("import { usePathname } from 'next/navigation'")
    expect(nav).not.toMatch(/\.email|requireUser|currentUser/)
    expect(src('lib', 'nav.ts')).not.toMatch(/email|fetch\(|process\.env/)
    const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
    expect(JSON.stringify(pkg)).not.toMatch(/tailwind/i)
    const css = src('app', 'globals.css')
    for (const c of ['.nav-groups', '.nav-subs', '.nav-subtabs', '.nav-bottom', '.nav-hoja']) expect(css).toContain(c)
  })

  it('el correo solo viene del layout', () => {
    expect(src('app', '(private)', 'layout.tsx')).toContain('{user.email}')
    const h = renderToStaticMarkup(createElement(NavLinks, TODAS))
    expect(h).not.toContain('@')
  })
})

describe('contador de BORRADOR en el grupo Órdenes (ORD-POS-127, criterio 4)', () => {
  const contadores = (h: string) => h.match(/nav-contador/g)?.length ?? 0

  it('se muestra solo con dato mayor que 0, en la barra lateral y en la inferior', () => {
    ruta = '/'
    const con = renderToStaticMarkup(createElement(NavLinks, { borradores: 3 }))
    expect(contadores(con)).toBe(2)
    expect(con).toMatch(/href="\/ordenes"[^>]*>Órdenes <span class="badge badge-warn nav-contador" aria-label="3 órdenes esperan tu aprobación">3<\/span>/)
    expect(renderToStaticMarkup(createElement(NavLinks, { borradores: 1 }))).toContain('1 orden espera tu aprobación')
    for (const sin of [0, null, undefined]) expect(contadores(renderToStaticMarkup(createElement(NavLinks, { borradores: sin })))).toBe(0)
  })

  it('solo la sesión del propietario lo calcula en el layout (criterio 5)', () => {
    const layout = src('app', '(private)', 'layout.tsx')
    expect(layout).toContain('const borradores = access.writer ? await borradoresMenu() : null')
    expect(layout).toContain('borradores={borradores}')
  })
})
