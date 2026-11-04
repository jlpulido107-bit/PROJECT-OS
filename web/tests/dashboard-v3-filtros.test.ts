import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { FiltroForm, TarjetaDictamenes } from '@/components/agentes/agentes'
import { debeEnviar } from '@/components/filtro-auto'
import { FiltroInicio } from '@/components/inicio/inicio'
import { TaskCard } from '@/components/task-card'
import { Pagination } from '@/components/ui'
import { FILTER_OPEN_VALUE, filterTasks, paginate, parseTaskFilters, parseTaskViewFilters } from '@/lib/aggregate'
import type { Dictamenes } from '@/lib/agentes'
import { buildFixtureTabs } from '@/lib/fixtures'
import { buildDataset } from '@/lib/table'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }))

/** Dashboard v3 (ORD-POS-130): histórico plegado, «título · ID», Tareas abiertas por defecto y filtro al cambiar. */

const TODAY = '2026-10-08'
const ds = buildDataset(buildFixtureTabs(TODAY), { source: 'fixtures', fetchedAt: Date.parse('2026-10-08T18:00:00Z') })
const src = (p: string) => readFileSync(path.join(import.meta.dirname, '..', 'src', p), 'utf8')

describe('criterio 1: Agentes · Rondas y dictámenes', () => {
  const fila = (ordenId: string, titulo: string | null, omitida: boolean) => ({
    ordenId, titulo, prUrl: `https://github.com/jlpulido107-bit/PROJECT-OS/pull/${ordenId.slice(-3)}`,
    rondas: 1, conforme: omitida ? null : 1, cambios: omitida ? null : 0, omitida,
  })
  const d: Dictamenes = {
    filas: [fila('ORD-POS-003', 'Vigente', false), fila('ORD-POS-002', null, false), fila('ORD-POS-001', 'Vieja', true)],
    totalConforme: 2, totalCambios: 0, sinLeer: 0, omitidas: 1, rondasSinDatos: false,
  }

  it('CERRADA y CANCELADA van plegadas tras «Ver histórico (N)»', () => {
    const h = renderToStaticMarkup(createElement(TarjetaDictamenes, { d }))
    const [antes, plegado] = h.split('<details')
    expect(plegado).toContain('<summary>Ver histórico (1)</summary>')
    expect(plegado).toContain('ORD-POS-001')
    expect(antes).not.toContain('ORD-POS-001')
    expect(antes).toContain('ORD-POS-003')
    expect(h).not.toContain('<details open')
  })

  it('la columna Orden muestra «título · ID»; sin título, solo el ID', () => {
    const h = renderToStaticMarkup(createElement(TarjetaDictamenes, { d }))
    expect(h).toContain('Vigente · <span class="mono">ORD-POS-003</span>')
    expect(h).toContain('Vieja · <span class="mono">ORD-POS-001</span>')
    expect(h).toMatch(/<a [^>]*><span class="mono">ORD-POS-002<\/span>/)
  })

  it('sin órdenes cerradas no hay histórico', () => {
    const h = renderToStaticMarkup(createElement(TarjetaDictamenes, { d: { ...d, filas: d.filas.slice(0, 2), omitidas: 0 } }))
    expect(h).not.toContain('Ver histórico')
  })
})

describe('criterio 2: Tareas arranca con Estado = abiertas', () => {
  const ids = (p: Record<string, string>) => filterTasks(ds.tareas, parseTaskViewFilters(p)).map((t) => t.id).sort()

  it('sin parámetros de filtro (o solo la página) excluye COMPLETADO y CANCELADO', () => {
    expect(parseTaskViewFilters({}).estado).toBe(FILTER_OPEN_VALUE)
    expect(parseTaskViewFilters({ pagina: '2' }).estado).toBe(FILTER_OPEN_VALUE)
    const abiertas = ids({})
    expect(abiertas).not.toContain('DEMO-001')
    expect(abiertas.every((id) => {
      const t = ds.tareas.find((x) => x.id === id)!
      return t.estado !== 'COMPLETADO' && t.estado !== 'CANCELADO'
    })).toBe(true)
    expect(abiertas).toContain('DEMO-004') // sin estado cuenta como abierta
  })

  it('«Todos» (estado vacío) muestra todas', () => {
    expect(ids({ estado: '' })).toHaveLength(ds.tareas.length)
  })

  it('la paginación conserva «Todos» y «Abiertas»', () => {
    const page = { ...paginate(ds.tareas, '1', 1) }
    const todos = renderToStaticMarkup(createElement(Pagination, { page, basePath: '/tareas', params: { estado: undefined }, keepEmpty: ['estado'] }))
    expect(todos).toContain('href="/tareas?estado=&amp;pagina=2"')
    const abiertas = renderToStaticMarkup(createElement(Pagination, { page, basePath: '/tareas', params: { estado: FILTER_OPEN_VALUE }, keepEmpty: ['estado'] }))
    expect(abiertas).toContain(`href="/tareas?estado=${FILTER_OPEN_VALUE}&amp;pagina=2"`)
  })

  it('el select de Estado ofrece «Abiertas» y la tarjeta ya no muestra Versión (editar la conserva)', () => {
    expect(src('app/(private)/tareas/page.tsx')).toContain("extra={[FILTER_OPEN_VALUE, 'Abiertas']}")
    const t = ds.tareas.find((x) => x.id === 'DEMO-002')!
    const h = renderToStaticMarkup(createElement(TaskCard, { task: t, data: ds, canEdit: true, puedeCerrar: true }))
    expect(h).not.toContain('Versión')
    expect(src('app/(private)/tareas/[id]/editar/page.tsx')).toContain('Versión: <Text value={task.version} />')
  })
})

describe('criterio 3: filtro al cambiar, con el botón intacto', () => {
  it('envía solo cuando el cambio viene del puntero y en selects, casillas, radios o fechas', () => {
    expect(debeEnviar('puntero', { tagName: 'SELECT' })).toBe(true)
    expect(debeEnviar('puntero', { tagName: 'INPUT', type: 'date' })).toBe(true)
    expect(debeEnviar('puntero', { tagName: 'INPUT', type: 'checkbox' })).toBe(true)
    expect(debeEnviar('teclado', { tagName: 'SELECT' })).toBe(false)
    expect(debeEnviar(null, { tagName: 'SELECT' })).toBe(false)
    expect(debeEnviar('puntero', { tagName: 'INPUT', type: 'search' })).toBe(false)
    expect(debeEnviar('puntero', { tagName: 'INPUT', type: 'text' })).toBe(false)
  })

  it('Inicio y Agentes: el formulario GET lleva FiltroAuto y conserva su botón', () => {
    for (const h of [
      renderToStaticMarkup(createElement(FiltroInicio, { filtro: null })),
      renderToStaticMarkup(createElement(FiltroForm, { filtro: { proyecto: null, desde: null, hasta: null } })),
    ]) {
      expect(h).toMatch(/<form[^>]*method="get"/)
      expect(h).toContain('data-filtro-auto=""')
      expect(h).toContain('type="submit"')
    }
  })

  it.each([
    ['app/(private)/tareas/page.tsx', 1],
    ['app/(private)/actividad/page.tsx', 1],
    ['app/(private)/eco/page.tsx', 1],
    ['app/(private)/eco/pipeline/page.tsx', 3], // ORD-POS-145: «Comparar cotizaciones»
  ])('%s: %i formularios de filtro con FiltroAuto y botón', (archivo, n) => {
    const s = src(archivo)
    const forms = s.match(/<form method="get"[\s\S]*?<\/form>|<form className="filters" method="get"[\s\S]*?<\/form>/g) ?? []
    expect(forms).toHaveLength(n)
    for (const f of forms) {
      expect(f).toContain('<FiltroAuto />')
      expect(f).toMatch(/<button type="submit"/)
    }
  })

  it('el botón Mover del pipeline no se toca (fuera de alcance)', () => {
    expect(src('components/eco/tablero-escritura.tsx')).not.toContain('FiltroAuto')
  })
})

describe('criterio 4: las URLs con parámetros de filtro se leen igual', () => {
  it.each([
    [{ proyecto: 'POS' }],
    [{ estado: 'pendiente' }],
    [{ estado: '__SIN__' }],
    [{ q: 'bloqueada', bloqueo: 'si' }],
    [{ desde: '2026-10-01', hasta: '2026-10-31' }],
  ])('%o', (p) => {
    expect(parseTaskViewFilters(p)).toEqual(parseTaskFilters(p))
  })
})
