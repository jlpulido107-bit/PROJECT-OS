import { describe, expect, it } from 'vitest'
import { buildFixtureTabs } from '@/lib/fixtures'
import { estadoOrden, resumenOrdenes, vistaOrden } from '@/lib/ordenes'
import { ordenSensible } from '@/lib/supervision/politica'
import { buildDataset } from '@/lib/table'
import type { Orden } from '@/lib/types'

const ds = buildDataset(buildFixtureTabs('2026-10-14'), { source: 'fixtures', fetchedAt: 0 })

const orden = (extra: Partial<Orden> = {}): Orden => ({
  id: 'ORD-POS-001', proyectoId: 'POS', tareaId: 'DEMO-002', titulo: 'T', objetivo: 'O', contexto: null, criterios: 'C',
  fueraDeAlcance: 'F', comoProbar: 'npm test', riesgo: 'BAJO', sensible: null, estado: 'BORRADOR', issueUrl: null, prUrl: null, notas: null,
  actualizadoEn: '2026-10-13', ...extra,
})

describe('órdenes a Codex: lectura', () => {
  it('la pestaña ORDENES_CODEX se lee con su esquema', () => {
    expect(ds.tabs.ORDENES_CODEX).toMatchObject({ ok: true, rows: 3 })
    expect(ds.ordenes.map((o) => o.id)).toEqual(['ORD-POS-901', 'ORD-POS-902', 'ORD-ECO-901'])
    expect(ds.ordenes[1]).toMatchObject({ estado: 'PR_ABIERTO', prUrl: 'https://github.com/example/demo/pull/2', riesgo: 'BAJO' })
  })

  it('solo reconoce los estados de la migración', () => {
    expect(estadoOrden('APROBADA')).toBe('APROBADA')
    expect(estadoOrden('COMPLETADO')).toBeNull()
    expect(estadoOrden(null)).toBeNull()
  })

  it('agrupa por quién tiene el siguiente paso', () => {
    const r = resumenOrdenes(ds)
    expect(r.grupos['tu-turno'].map((v) => v.orden.id)).toEqual(['ORD-POS-901'])
    expect(r.grupos['en-curso'].map((v) => v.orden.id)).toEqual(['ORD-POS-902'])
    expect(r.grupos.terminadas.map((v) => v.orden.id)).toEqual(['ORD-ECO-901'])
    expect(r.porEstado).toEqual([['BORRADOR', 1], ['PR_ABIERTO', 1], ['CERRADA', 1]])
  })

  it('filtra por proyecto', () => {
    const r = resumenOrdenes(ds, 'ECO')
    expect(Object.values(r.grupos).flat().map((v) => v.orden.id)).toEqual(['ORD-ECO-901'])
  })

  it('señala problemas de datos sin cambiar el estado', () => {
    expect(vistaOrden(orden(), ds).problemas).toEqual([])
    expect(vistaOrden(orden({ id: 'ORD-SIG-001' }), ds).problemas).toContain('El prefijo de ORDEN_ID no coincide con PROYECTO_ID')
    expect(vistaOrden(orden({ id: 'X-1' }), ds).problemas).toContain('ORDEN_ID no tiene el formato ORD-PRY-NNN')
    expect(vistaOrden(orden({ tareaId: 'NO-EXISTE' }), ds).problemas).toContain('La tarea NO-EXISTE no existe en TAREAS')
    expect(vistaOrden(orden({ riesgo: 'ALTO' }), ds).problemas).toContain('Riesgo ALTO: no se delega')
    expect(vistaOrden(orden({ estado: 'ENVIADA' }), ds).problemas).toContain('Falta ISSUE_URL')
    const invalida = vistaOrden(orden({ estado: 'HECHA' }), ds)
    expect(invalida).toMatchObject({ estado: null, grupo: 'invalidas', siguiente: null })
    expect(invalida.problemas).toContain('ESTADO no es válido')
  })
})

describe('columna SENSIBLE de ORDENES_CODEX (ORD-POS-100, DEC-POS-019)', () => {
  const conColumna = (valores: string[]) => {
    const tabs = buildFixtureTabs('2026-10-14') as Record<string, unknown[][]>
    tabs.ORDENES_CODEX = tabs.ORDENES_CODEX!.map((fila, i) => [...fila, i === 0 ? 'SENSIBLE' : valores[i - 1] ?? ''])
    return buildDataset(tabs as ReturnType<typeof buildFixtureTabs>, { source: 'fixtures', fetchedAt: 0 })
  }

  it('sin migrar, la pestaña sigue válida y SENSIBLE se lee como null (= sensible)', () => {
    expect(ds.tabs.ORDENES_CODEX.ok).toBe(true)
    expect(ds.ordenes.length).toBeGreaterThan(0)
    expect(ds.ordenes.every((o) => o.sensible === null && ordenSensible(o.sensible))).toBe(true)
  })

  it('migrada, lee SI y NO normalizados y la celda vacía como null', () => {
    const d = conColumna(['no', ' SI ', ''])
    expect(d.tabs.ORDENES_CODEX.ok).toBe(true)
    expect(d.ordenes.slice(0, 3).map((o) => [o.sensible, ordenSensible(o.sensible)])).toEqual([['NO', false], ['SI', true], [null, true]])
  })
})
