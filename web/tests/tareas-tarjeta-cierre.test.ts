import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TaskCard } from '@/components/task-card'
import { buildFixtureTabs } from '@/lib/fixtures'
import { canWrite, puedeCerrarTareas } from '@/lib/operations/config'
import { WRITE_HEADERS } from '@/lib/operations/constants'
import { OperationError } from '@/lib/operations/errors'
import { evaluateWriteRequest } from '@/lib/operations/guard'
import { RateLimiter } from '@/lib/operations/rate-limit'
import { OperationsService } from '@/lib/operations/service'
import { findById, InMemoryTableStore, readView, toRecord } from '@/lib/operations/table-store'
import { parseCompleteTask } from '@/lib/operations/validation'
import { buildDataset } from '@/lib/table'
import type { RawTabs } from '@/lib/types'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }))

/** «Completar» en la tarjeta de /tareas (ORD-POS-129, DEC-POS-023): CompleteTaskForm tal cual, solo para el propietario. */

const ORIGIN = 'http://127.0.0.1:3000'
const DUENO = 'dueno@example.com'
const OTRO = 'otro-escritor@example.com'
const LECTOR = 'lector@example.com'
const TODAY = '2026-11-01'
const NOW = new Date('2026-11-01T16:30:00Z')
const BASE = {
  NEXTAUTH_URL: ORIGIN, AUTH_ALLOWED_EMAILS: `${DUENO},${OTRO},${LECTOR}`, AUTH_WRITER_EMAILS: `${DUENO},${OTRO}`,
  PROJECT_OS_WRITE_MODE: 'mock', DASHBOARD_DATA_SOURCE: 'fixtures',
  PM_AGENT_TOKEN_SHA256: createHash('sha256').update('token-de-prueba-sintetico-0123456789').digest('hex'),
}
const ENCENDIDA = { ...BASE, TAREAS_CIERRE_PROPIETARIO: 'true', TAREAS_CIERRE_PROPIETARIO_EMAIL: DUENO }
const env = (extra: Record<string, string | undefined>) => extra as unknown as NodeJS.ProcessEnv

const seed = () => ({ ...(buildFixtureTabs(TODAY) as Record<string, unknown[][]>), AUDITORIA: [[...WRITE_HEADERS.AUDITORIA]] })
const data = buildDataset(seed() as RawTabs, { source: 'fixtures', fetchedAt: NOW.getTime() })
const abierta = data.tareas.find((t) => t.id === 'DEMO-002')!
const cerrada = data.tareas.find((t) => t.id === 'DEMO-001')!

/** Lo mismo que calcula /tareas: escritor con escritura activa y, además, propietario con la bandera encendida. */
function tarjeta(email: string, e: NodeJS.ProcessEnv, task = abierta) {
  const canEdit = canWrite(email, e)
  const puedeCerrar = canEdit && puedeCerrarTareas(email, e)
  return renderToStaticMarkup(createElement(TaskCard, { task, data, canEdit, puedeCerrar }))
}

describe('tarjeta de /tareas (criterios 1 y 2)', () => {
  it('propietario con la bandera encendida: muestra CompleteTaskForm cerrado, con su botón y sin llamar al servidor', () => {
    const html = tarjeta(DUENO, env(ENCENDIDA))
    expect(html).toContain('>Marcar completada</button>')
    expect(html).not.toContain('Confirmar: marcar completada')
    expect(html.match(/Marcar completada/g)).toHaveLength(1)
  })

  it('bandera apagada o mal escrita: no aparece', () => {
    expect(tarjeta(DUENO, env(BASE))).not.toContain('Marcar completada')
    expect(tarjeta(DUENO, env({ ...ENCENDIDA, TAREAS_CIERRE_PROPIETARIO: 'TRUE' }))).not.toContain('Marcar completada')
  })

  it('otro escritor, solo lectura o escritura deshabilitada: no aparece', () => {
    expect(tarjeta(OTRO, env(ENCENDIDA))).not.toContain('Marcar completada')
    const lectura = tarjeta(LECTOR, env(ENCENDIDA))
    expect(lectura).not.toContain('Marcar completada')
    expect(lectura).not.toContain('card-actions')
    expect(tarjeta(DUENO, env({ ...ENCENDIDA, PROJECT_OS_WRITE_MODE: 'disabled' }))).not.toContain('Marcar completada')
  })

  it('tarea cerrada: no aparece, ni con la bandera encendida', () => {
    expect(tarjeta(DUENO, env(ENCENDIDA), cerrada)).not.toContain('Marcar completada')
  })

  it('sin puedeCerrar explícito la tarjeta no lo pinta (otras vistas que la reúsan quedan igual)', () => {
    expect(renderToStaticMarkup(createElement(TaskCard, { task: abierta, data, canEdit: true }))).not.toContain('Marcar completada')
  })

  it('/tareas lo calcula con canEdit y puedeCerrarTareas de la sesión, y no lee el token del PM', () => {
    const page = readFileSync(path.join(__dirname, '..', 'src', 'app', '(private)', 'tareas', 'page.tsx'), 'utf8')
    expect(page).toContain('const puedeCerrar = canEdit && puedeCerrarTareas(user.email)')
    expect(page).toContain('puedeCerrar={puedeCerrar}')
    expect(page).not.toMatch(/PM_AGENT|authorization/i)
  })
})

describe('escritura simulada desde la tarjeta (criterios 2 y 3)', () => {
  const peticion = (body: unknown, headers: Record<string, string> = {}) => new Request(`${ORIGIN}/api/operaciones/tareas/DEMO-002/completar`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'x-project-os-csrf': '1', ...headers },
  })
  const ctx = (email: string | null, e: NodeJS.ProcessEnv) => ({
    email, env: e, limiter: new RateLimiter(), agentLimiter: new RateLimiter(5, 60_000), operation: 'tarea.completar' as const,
  })
  const codeOf = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => (e instanceof OperationError ? e.code : String(e)))

  it('el propietario cierra en modo simulado; el servidor vuelve a verificar bandera y sesión', async () => {
    const body = { requestId: '00000000-0000-4000-8000-000000000129', expectedVersion: 2 }
    expect(await codeOf(evaluateWriteRequest(peticion(body), ctx(DUENO, env(BASE))))).toBe('cierre-no-permitido')
    expect(await codeOf(evaluateWriteRequest(peticion(body), ctx(OTRO, env(ENCENDIDA))))).toBe('cierre-no-permitido')
    expect(await codeOf(evaluateWriteRequest(peticion(body, { authorization: 'Bearer token-de-prueba-sintetico-0123456789' }), ctx(null, env(ENCENDIDA))))).toBe('cierre-no-permitido')

    const req = await evaluateWriteRequest(peticion(body), ctx(DUENO, env(ENCENDIDA)))
    expect(req.actor).toBe(DUENO)
    expect(req.agent).toBeUndefined()
    const store = new InMemoryTableStore(seed())
    const service = new OperationsService(store, { mode: 'mock', clock: () => NOW })
    await service.completeTask(parseCompleteTask('DEMO-002', req.body), { actor: req.actor })
    const view = await readView(store, 'TAREAS')
    expect(toRecord(view, findById(view, 'TAREA_ID', 'DEMO-002')[0]!.cells)).toMatchObject({ ESTADO: 'COMPLETADO', VERSION: '3' })
  })
})
