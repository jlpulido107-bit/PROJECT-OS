import { describe, expect, it } from 'vitest'
import { MAX_DATA_ROWS, TAB_HEADERS, TABS_READ } from '@/lib/schema'
import { buildDataset, parseTable } from '@/lib/table'

const DEP_HEADER = [...TAB_HEADERS.DEPENDENCIAS]

describe('validación de encabezados', () => {
  it('mapea por nombre aunque cambie el orden y haya columnas extra', () => {
    const header = ['ESTADO', 'EXTRA', 'TIPO', 'DEPENDE_DE_TAREA_ID', 'TAREA_ID', 'DEPENDENCIA_ID']
    const { status, rows } = parseTable('DEPENDENCIAS', [header, ['ACTIVA', 'x', 'TECNICA', 'B', 'A', 'D1']])
    expect(status.ok).toBe(true)
    expect(rows[0]?.get('DEPENDENCIA_ID')).toBe('D1')
    expect(rows[0]?.get('TAREA_ID')).toBe('A')
    expect(rows[0]?.get('ESTADO')).toBe('ACTIVA')
  })

  it('rechaza la pestaña si falta una columna exacta (sin renombrar en silencio)', () => {
    const header = DEP_HEADER.map((h) => (h === 'DEPENDE_DE_TAREA_ID' ? 'DEPENDE_DE' : h))
    const { status, rows } = parseTable('DEPENDENCIAS', [header, ['D1', 'A', 'B', 'TECNICA', 'ACTIVA']])
    expect(status).toMatchObject({ ok: false, problem: 'encabezados-faltantes', missingColumns: ['DEPENDE_DE_TAREA_ID'] })
    expect(rows).toEqual([])
  })

  it('rechaza encabezados duplicados', () => {
    const { status } = parseTable('DEPENDENCIAS', [[...DEP_HEADER, 'ESTADO']])
    expect(status).toMatchObject({ ok: false, problem: 'encabezados-duplicados', missingColumns: ['ESTADO'] })
  })

  it('distingue pestaña ausente de pestaña vacía', () => {
    expect(parseTable('HITOS', undefined).status.problem).toBe('pestana-ausente')
    expect(parseTable('HITOS', []).status.problem).toBe('sin-encabezados')
    const empty = parseTable('HITOS', [[...TAB_HEADERS.HITOS]])
    expect(empty.status).toMatchObject({ ok: true, rows: 0 })
  })
})

describe('filas', () => {
  it('omite filas en blanco, cuenta filas sin ID y conserva el primer ID duplicado', () => {
    const { status, rows } = parseTable('DEPENDENCIAS', [
      DEP_HEADER,
      ['D1', 'A', 'B'],
      [],
      ['', '', '', '', ''],
      ['', 'A', 'C'],
      ['D1', 'X', 'Y'],
      ['D2', 'A'],
    ])
    expect(rows.map((r) => r.get('DEPENDENCIA_ID'))).toEqual(['D1', 'D2'])
    expect(rows[0]?.get('DEPENDE_DE_TAREA_ID')).toBe('B')
    expect(rows[1]?.get('ESTADO')).toBeNull()
    expect(rows[1]?.sheetRow).toBe(7)
    expect(status).toMatchObject({ rows: 2, rowsWithoutId: 1, duplicateIds: ['D1'], truncated: false })
  })

  it('marca la pestaña como truncada al superar el límite de filas', () => {
    const values = [DEP_HEADER, ...Array.from({ length: MAX_DATA_ROWS + 1 }, (_, i) => [`D${i}`])]
    const { status } = parseTable('DEPENDENCIAS', values)
    expect(status.truncated).toBe(true)
    expect(status.rows).toBe(MAX_DATA_ROWS)
  })
})

describe('conjunto de datos', () => {
  it('registra incidencias de formato sin incluir el valor original', () => {
    const ds = buildDataset(
      {
        TIEMPOS: [[...TAB_HEADERS.TIEMPOS], ['S1', 'T1', '08/10/2026', 'Ana', 'noventa']],
      },
      { source: 'fixtures', fetchedAt: 0 },
    )
    expect(ds.tiempos[0]).toMatchObject({ id: 'S1', fecha: null, minutosReales: null })
    expect(ds.issues).toEqual([
      { tab: 'TIEMPOS', row: 2, column: 'FECHA', message: expect.any(String) },
      { tab: 'TIEMPOS', row: 2, column: 'MINUTOS_REALES', message: expect.any(String) },
    ])
    expect(JSON.stringify(ds.issues)).not.toContain('noventa')
  })

  it('las pestañas no recibidas quedan como ausentes, no como vacías', () => {
    const ds = buildDataset({}, { source: 'sheets', fetchedAt: 0 })
    for (const tab of TABS_READ) expect(ds.tabs[tab]).toMatchObject({ ok: false, problem: 'pestana-ausente' })
    expect(ds.proyectos).toEqual([])
  })
})
