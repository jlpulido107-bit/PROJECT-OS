import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DictamenFila, PrFila } from '@/components/operations/orden-filas'

/** Render de las filas PR y Dictamen de /ordenes (ORD-POS-048): cada fallo de GitHub con su texto y su código. */
describe('/ordenes: filas de PR y dictamen', () => {
  const pr = (props: Parameters<typeof PrFila>[0]) => renderToStaticMarkup(createElement(PrFila, props))

  it('«Sin datos de GitHub (código)» cuando no se pudo leer el dictamen', () => {
    expect(renderToStaticMarkup(createElement(DictamenFila, { prUrl: 'https://github.com/o/r/pull/1', ev: null, fallo: 'http-502' }))).toBe('Sin datos de GitHub (http-502)')
  })

  it('distingue «Detección de PR fallida», «Lectura de lanzamientos fallida» y «Sin PR» real', () => {
    expect(pr({ prUrl: null, falloPr: 'tiempo' })).toContain('Detección de PR fallida (tiempo)')
    const lanz = pr({ prUrl: null, falloLanzamiento: 'http-403' })
    expect(lanz).toContain('Sin PR · Lectura de lanzamientos fallida (http-403)')
    expect(lanz).not.toContain('Detección de PR fallida')
    expect(pr({ prUrl: null })).toBe('<span class="muted">Sin PR</span>')
    expect(pr({ prUrl: 'https://github.com/o/r/pull/2', falloPr: 'tiempo' })).toContain('o/r/pull/2')
  })
})
