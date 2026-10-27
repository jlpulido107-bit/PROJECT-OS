import { createHash } from 'node:crypto'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { bloquesInstrucciones, Instrucciones } from '@/components/instrucciones'
import { TaskCard } from '@/components/task-card'
import { buildFixtureTabs } from '@/lib/fixtures'
import { AGENT_ACTOR, LIMITS, WRITE_HEADERS, type OperationName, type WriteTab } from '@/lib/operations/constants'
import { OperationError } from '@/lib/operations/errors'
import { evaluateWriteRequest } from '@/lib/operations/guard'
import { RateLimiter } from '@/lib/operations/rate-limit'
import { OperationsService } from '@/lib/operations/service'
import { SheetsTableStore } from '@/lib/operations/sheets-table-store'
import { findById, InMemoryTableStore, readView, toRecord, type TableStore } from '@/lib/operations/table-store'
import { parseCreateTask, parseUpdateTask } from '@/lib/operations/validation'
import { TAREAS_INSTRUCCIONES } from '@/lib/schema'
import { buildDataset } from '@/lib/table'
import type { RawTabs } from '@/lib/types'
import { FakeSheets } from './helpers/fake-sheets'

/** Instrucciones de las tareas (ORD-POS-105): columna opcional INSTRUCCIONES al final de TAREAS, inerte sin ella. */

const TODAY = '2026-10-08'
const NOW = new Date('2026-10-08T16:30:00Z')
const ACTOR = { actor: 'escritor@example.com' }
let seq = 0
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`
const PASOS = '1. Leer el issue\n2. Correr las pruebas\n\nNotas:\n- sin datos personales'

function seed(conColumna: boolean): Record<string, unknown[][]> {
  const tabs: Record<string, unknown[][]> = { ...(buildFixtureTabs(TODAY) as Record<string, unknown[][]>), AUDITORIA: [[...WRITE_HEADERS.AUDITORIA]] }
  if (conColumna) tabs.TAREAS = [[...tabs.TAREAS![0]!, TAREAS_INSTRUCCIONES], ...tabs.TAREAS!.slice(1)]
  return tabs
}

const ADAPTERS: Array<[string, (conColumna: boolean) => TableStore]> = [
  ['InMemoryTableStore', (c) => new InMemoryTableStore(seed(c))],
  ['SheetsTableStore (servidor simulado)', (c) => {
    const fake = new FakeSheets('HOJA_DE_PRUEBA_SINTETICA_0123456789', seed(c))
    return new SheetsTableStore({ spreadsheetId: fake.spreadsheetId, getWriteToken: async () => 'token-falso', fetchImpl: fake.fetch })
  }],
]

function taskInput(extra: Record<string, unknown> = {}) {
  return {
    requestId: uuid(), proyectoId: 'POS', titulo: 'Preparar informe semanal', tipo: 'documentacion', prioridad: 'media',
    criterioTerminado: 'Informe revisado por el usuario', ...extra,
  }
}

async function record(store: TableStore, id: string) {
  const view = await readView(store, 'TAREAS')
  const rows = findById(view, 'TAREA_ID', id)
  return rows.length === 1 ? toRecord(view, rows[0]!.cells) : null
}

const rows = async (store: TableStore, tab: WriteTab) => (await store.readTable(tab)).length - 1

const dataset = (raw: RawTabs) => buildDataset(raw, { source: 'fixtures', fetchedAt: NOW.getTime() })

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.catch((e: unknown) => e)
  expect(error).toBeInstanceOf(OperationError)
  expect((error as OperationError).code).toBe(code)
}

describe.each(ADAPTERS)('instrucciones de tareas — %s', (_name, make) => {
  describe('sin la columna (inerte, criterio 2)', () => {
    let store: TableStore
    let service: OperationsService
    beforeEach(() => {
      store = make(false)
      service = new OperationsService(store, { mode: 'mock', clock: () => NOW })
    })

    it('el alta con instrucciones responde un error claro sin escribir nada', async () => {
      const antes = [await rows(store, 'TAREAS'), await rows(store, 'AUDITORIA')]
      await expectCode(service.createTask(parseCreateTask(taskInput({ instrucciones: PASOS })), ACTOR), 'instrucciones-sin-columna')
      expect([await rows(store, 'TAREAS'), await rows(store, 'AUDITORIA')]).toEqual(antes)
      expect(new OperationError('instrucciones-sin-columna').status).toBe(422)
    })

    it('la edición con instrucciones (también vaciarlas) responde el error sin escribir nada', async () => {
      await service.createTask(parseCreateTask(taskInput()), ACTOR)
      const antes = [await record(store, 'POS-001'), await rows(store, 'AUDITORIA')]
      for (const instrucciones of [PASOS, null]) {
        const cmd = parseUpdateTask('POS-001', { requestId: uuid(), expectedVersion: 1, changes: { instrucciones } })
        await expectCode(service.updateTask(cmd, ACTOR), 'instrucciones-sin-columna')
      }
      expect([await record(store, 'POS-001'), await rows(store, 'AUDITORIA')]).toEqual(antes)
    })

    it('el resto de la tarea se escribe igual que hoy', async () => {
      const input = taskInput({ descripcion: 'Una descripción', instrucciones: '   ' })
      const cmd = parseCreateTask(input)
      expect('instrucciones' in cmd).toBe(false)
      const r = await service.createTask(cmd, ACTOR)
      expect(r).toMatchObject({ id: 'POS-001', version: 1, repetida: false })
      const tarea = await record(store, 'POS-001')
      expect(Object.keys(tarea!)).toEqual([...WRITE_HEADERS.TAREAS])
      expect(tarea).toMatchObject({ DESCRIPCION: 'Una descripción', ESTADO: 'PENDIENTE', VERSION: '1' })
      const edit = parseUpdateTask('POS-001', { requestId: uuid(), expectedVersion: 1, changes: { titulo: 'Título nuevo' } })
      expect(await service.updateTask(edit, ACTOR)).toMatchObject({ version: 2 })
      expect((await store.readTable('TAREAS'))[0]).toEqual([...WRITE_HEADERS.TAREAS])
    })
  })

  describe('con la columna (criterio 3)', () => {
    let store: TableStore
    let service: OperationsService
    beforeEach(() => {
      store = make(true)
      service = new OperationsService(store, { mode: 'mock', clock: () => NOW })
    })

    const audit = async () => {
      const view = await readView(store, 'AUDITORIA')
      return view.rows.map((r) => toRecord(view, r.cells))
    }

    it('alta multilínea con VERSION 1 y AUDITORIA del campo', async () => {
      const r = await service.createTask(parseCreateTask(taskInput({ instrucciones: PASOS })), ACTOR)
      expect(r).toMatchObject({ id: 'POS-001', version: 1 })
      expect(await record(store, 'POS-001')).toMatchObject({ INSTRUCCIONES: PASOS, VERSION: '1' })
      expect((await audit()).find((a) => a.CAMPO === 'INSTRUCCIONES')).toMatchObject({ REGISTRO_ID: 'POS-001', VALOR_ANTES: '', VALOR_DESPUES: PASOS })
    })

    it('alta sin instrucciones deja la celda vacía y no la audita', async () => {
      await service.createTask(parseCreateTask(taskInput()), ACTOR)
      expect(await record(store, 'POS-001')).toMatchObject({ INSTRUCCIONES: '' })
      expect((await audit()).some((a) => a.CAMPO === 'INSTRUCCIONES')).toBe(false)
    })

    it('edición con VERSION + 1 y AUDITORIA antes/después; otra edición las conserva', async () => {
      await service.createTask(parseCreateTask(taskInput({ instrucciones: '1. Primero' })), ACTOR)
      const cmd = parseUpdateTask('POS-001', { requestId: uuid(), expectedVersion: 1, changes: { instrucciones: PASOS } })
      expect(await service.updateTask(cmd, ACTOR)).toMatchObject({ version: 2, repetida: false })
      expect(await record(store, 'POS-001')).toMatchObject({ INSTRUCCIONES: PASOS, VERSION: '2' })
      const fila = (await audit()).filter((a) => a.ORIGEN!.includes('op=tarea.editar')).find((a) => a.CAMPO === 'INSTRUCCIONES')
      expect(fila).toMatchObject({ VALOR_ANTES: '1. Primero', VALOR_DESPUES: PASOS })

      const titulo = parseUpdateTask('POS-001', { requestId: uuid(), expectedVersion: 2, changes: { titulo: 'Otro título' } })
      await service.updateTask(titulo, ACTOR)
      expect(await record(store, 'POS-001')).toMatchObject({ INSTRUCCIONES: PASOS, TITULO: 'Otro título', VERSION: '3' })

      const vaciar = parseUpdateTask('POS-001', { requestId: uuid(), expectedVersion: 3, changes: { instrucciones: '' } })
      await service.updateTask(vaciar, ACTOR)
      expect(await record(store, 'POS-001')).toMatchObject({ INSTRUCCIONES: '', VERSION: '4' })
    })

    it('conflicto de VERSION: no escribe nada', async () => {
      await service.createTask(parseCreateTask(taskInput()), ACTOR)
      const antes = await rows(store, 'AUDITORIA')
      const cmd = parseUpdateTask('POS-001', { requestId: uuid(), expectedVersion: 7, changes: { instrucciones: PASOS } })
      await expectCode(service.updateTask(cmd, ACTOR), 'conflicto-version')
      expect(await record(store, 'POS-001')).toMatchObject({ INSTRUCCIONES: '', VERSION: '1' })
      expect(await rows(store, 'AUDITORIA')).toBe(antes)
    })

    it('repetición del mismo requestId: idempotente en alta y edición', async () => {
      const alta = taskInput({ instrucciones: PASOS })
      await service.createTask(parseCreateTask(alta), ACTOR)
      const auditAlta = await rows(store, 'AUDITORIA')
      expect(await service.createTask(parseCreateTask(alta), ACTOR)).toMatchObject({ id: 'POS-001', repetida: true })
      expect([await rows(store, 'TAREAS'), await rows(store, 'AUDITORIA')]).toEqual([buildFixtureTabs(TODAY).TAREAS!.length, auditAlta])

      const body = { requestId: uuid(), expectedVersion: 1, changes: { instrucciones: '1. Otro paso' } }
      await service.updateTask(parseUpdateTask('POS-001', body), ACTOR)
      const auditEdit = await rows(store, 'AUDITORIA')
      expect(await service.updateTask(parseUpdateTask('POS-001', body), ACTOR)).toMatchObject({ version: 2, repetida: true })
      expect(await rows(store, 'AUDITORIA')).toBe(auditEdit)
      const otra = parseUpdateTask('POS-001', { ...body, changes: { instrucciones: '1. Distinto' } })
      await expectCode(service.updateTask(otra, ACTOR), 'conflicto-idempotencia')
    })

    it('fórmulas neutralizadas como en descripcion', async () => {
      await service.createTask(parseCreateTask(taskInput({ instrucciones: '=IMPORTXML("x")\n2. paso' })), ACTOR)
      expect((await record(store, 'POS-001'))!.INSTRUCCIONES).toBe('\'=IMPORTXML("x")\n2. paso')
      for (const inicio of ['+', '-', '@']) {
        expect(parseCreateTask(taskInput({ instrucciones: `${inicio}1` })).instrucciones).toBe(`'${inicio}1`)
        const u = parseUpdateTask('POS-001', { requestId: uuid(), expectedVersion: 1, changes: { instrucciones: `${inicio}1` } })
        expect(u.changes.instrucciones).toBe(`'${inicio}1`)
      }
    })
  })
})

describe('validación de instrucciones', () => {
  it('hasta 4000 caracteres; 4001 se rechaza en alta y edición', () => {
    expect(LIMITS.instrucciones).toBe(4000)
    expect(parseCreateTask(taskInput({ instrucciones: 'a'.repeat(4000) })).instrucciones).toHaveLength(4000)
    const largo = 'a'.repeat(4001)
    for (const parse of [
      () => parseCreateTask(taskInput({ instrucciones: largo })),
      () => parseUpdateTask('POS-001', { requestId: uuid(), expectedVersion: 1, changes: { instrucciones: largo } }),
    ]) {
      const error = (() => { try { parse() } catch (e) { return e } })() as OperationError
      expect(error.code).toBe('validacion')
      expect(Object.values(error.fields ?? {})).toContain('Máximo 4000 caracteres')
    }
  })

  it('conserva saltos de línea y quita controles', () => {
    expect(parseCreateTask(taskInput({ instrucciones: '1. a\r\n2. b\u0007\n\n\n\n3. c' })).instrucciones).toBe('1. a\n2. b\n\n3. c')
  })

  it('el hash de un alta sin instrucciones no cambia (el campo se omite)', () => {
    expect(Object.keys(parseCreateTask(taskInput()))).not.toContain('instrucciones')
  })
})

describe('lectura con y sin la columna (criterio 1)', () => {
  const raw = (conColumna: boolean): RawTabs => seed(conColumna) as RawTabs

  it('sin la columna, la pestaña TAREAS es válida e instrucciones queda en null', () => {
    const data = dataset(raw(false))
    expect(data.tabs.TAREAS).toMatchObject({ ok: true, missingColumns: [] })
    expect(data.tareas.length).toBeGreaterThan(0)
    expect(data.tareas.every((t) => t.instrucciones === null)).toBe(true)
  })

  it('con la columna, se lee con sus saltos de línea', () => {
    const tabs = raw(true)
    const tareas = tabs.TAREAS as unknown[][]
    tareas[1] = [...(tareas[1] as unknown[]).slice(0, WRITE_HEADERS.TAREAS.length), PASOS]
    const data = dataset(tabs)
    expect(data.tabs.TAREAS).toMatchObject({ ok: true })
    expect(data.tareas[0]!.instrucciones).toBe(PASOS)
  })
})

describe('render (criterio 4)', () => {
  it('saltos de línea y listas numeradas, sin HTML crudo', () => {
    const html = renderToStaticMarkup(createElement(Instrucciones, { texto: 'Contexto\nsegunda línea\n\n3. Tercero\n4. Cuarto\n- viñeta' }))
    expect(html).toContain('<p>Contexto<br/>segunda línea</p>')
    expect(html).toContain('<ol start="3"><li>Tercero</li><li>Cuarto</li></ol>')
    expect(html).toContain('<ul><li>viñeta</li></ul>')
  })

  it('un <script> se pinta como texto escapado', () => {
    const html = renderToStaticMarkup(createElement(Instrucciones, { texto: '1. <script>alert(1)</script>\n<img src=x onerror=alert(1)>' }))
    expect(html).not.toMatch(/<script|<img/i)
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('no muestra el apóstrofo que neutraliza una fórmula', () => {
    expect(bloquesInstrucciones("'- paso")).toEqual([{ tipo: 'ul', items: ['paso'] }])
    expect(bloquesInstrucciones("'texto")).toEqual([{ tipo: 'p', lineas: ["'texto"] }])
  })

  it('la tarjeta muestra las instrucciones en un desplegable y nada si no hay', () => {
    const data = dataset(seed(false) as RawTabs)
    const task = { ...data.tareas[0]!, instrucciones: '1. <script>x</script>' }
    const html = renderToStaticMarkup(createElement(TaskCard, { task, data }))
    expect(html).toContain('<summary>Instrucciones</summary>')
    expect(html).toContain('<ol start="1"><li>&lt;script&gt;x&lt;/script&gt;</li></ol>')
    expect(html).not.toContain('<script')
    const sin = renderToStaticMarkup(createElement(TaskCard, { task: { ...task, instrucciones: null }, data }))
    expect(sin).not.toContain('Instrucciones')
  })
})

describe('agente PM (criterio 5)', () => {
  const ORIGIN = 'http://127.0.0.1:3000'
  const TOKEN = 'token-de-prueba-sintetico-0123456789'
  const ENV = {
    NEXTAUTH_URL: ORIGIN, AUTH_ALLOWED_EMAILS: 'escritor@example.com', AUTH_WRITER_EMAILS: 'escritor@example.com',
    PROJECT_OS_WRITE_MODE: 'mock', DASHBOARD_DATA_SOURCE: 'fixtures',
    PM_AGENT_TOKEN_SHA256: createHash('sha256').update(TOKEN).digest('hex'),
  } as unknown as NodeJS.ProcessEnv
  const req = (body: unknown) => new Request(`${ORIGIN}/api/operaciones/tareas`, {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
  })
  const ctx = (operation: OperationName) => ({ email: null, env: ENV, limiter: new RateLimiter(), agentLimiter: new RateLimiter(5, 60_000), operation })

  it('tarea.crear del PM admite instrucciones y se audita como agente', async () => {
    const r = await evaluateWriteRequest(req(taskInput({ instrucciones: PASOS })), ctx('tarea.crear'))
    expect(r.actor).toBe(AGENT_ACTOR)
    const store = new InMemoryTableStore(seed(true))
    const service = new OperationsService(store, { mode: 'mock', clock: () => NOW })
    await service.createTask(parseCreateTask(r.body), { actor: r.actor, agent: true })
    expect(await record(store, 'POS-001')).toMatchObject({ INSTRUCCIONES: PASOS })
  })

  it('tarea.editar del PM con instrucciones → 403: la lista de campos editables no cambia', async () => {
    const error = await evaluateWriteRequest(req({ requestId: uuid(), expectedVersion: 1, changes: { instrucciones: PASOS } }), ctx('tarea.editar')).catch((e: unknown) => e)
    expect((error as OperationError).code).toBe('operacion-no-permitida')
  })
})
