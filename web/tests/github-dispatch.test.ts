import { describe, expect, it } from 'vitest'
import { buildFixtureTabs } from '@/lib/fixtures'
import { WRITE_HEADERS } from '@/lib/operations/constants'
import { derivedRequestId, transitionWithDispatch } from '@/lib/operations/dispatch'
import { createGitHubClient, cuerpoIssue, urlGitHubPermitida } from '@/lib/operations/github'
import { OperationsService } from '@/lib/operations/service'
import { findById, InMemoryTableStore, readView, toRecord } from '@/lib/operations/table-store'
import { parseOrderTransition } from '@/lib/operations/validation'

/** Envío de órdenes a GitHub/Codex (V1.8 F4) con un GitHub simulado: sin red. */

const NOW = new Date('2026-10-14T16:30:00Z')
const ACTOR = { actor: 'escritor@example.com' }
let seq = 0
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`

interface Issue { number: number; title: string; html_url: string; body: string; comments: string[] }

/** GitHub mínimo en memoria: issues, comentarios y PRs de un repositorio. */
function fakeGitHub(opts: { failCreate?: number } = {}) {
  const issues: Issue[] = []
  const prs: Array<{ number: number; title: string; html_url: string; state: string; merged_at: string | null }> = []
  const calls: string[] = []
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url)
    const method = init.method ?? 'GET'
    calls.push(`${method} ${u.pathname}`)
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-falso')
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
    let m: RegExpExecArray | null
    if (method === 'GET' && /\/issues$/.test(u.pathname)) {
      return json(200, issues.map((i) => ({ number: i.number, title: i.title, html_url: i.html_url, state: 'open' })))
    }
    if (method === 'POST' && /\/issues$/.test(u.pathname)) {
      if (opts.failCreate) return json(opts.failCreate, { message: 'secreto interno' })
      const b = JSON.parse(String(init.body)) as { title: string; body: string }
      const n = issues.length + 100
      issues.push({ number: n, title: b.title, body: b.body, html_url: `https://github.com${u.pathname.replace('/repos', '')}/${n}`, comments: [] })
      return json(201, { number: n, title: b.title, html_url: issues.at(-1)!.html_url })
    }
    if ((m = /\/issues\/(\d+)\/comments$/.exec(u.pathname))) {
      const issue = issues.find((i) => i.number === Number(m![1]))!
      if (method === 'GET') return json(200, issue.comments.map((body) => ({ body })))
      issue.comments.push((JSON.parse(String(init.body)) as { body: string }).body)
      return json(201, {})
    }
    if (method === 'GET' && /\/pulls$/.test(u.pathname)) return json(200, prs)
    return json(404, {})
  }) as unknown as typeof fetch
  return { client: createGitHubClient('token-falso', fetchImpl), issues, prs, calls }
}

function setup() {
  const store = new InMemoryTableStore({ ...(buildFixtureTabs('2026-10-14') as Record<string, unknown[][]>), AUDITORIA: [[...WRITE_HEADERS.AUDITORIA]] })
  return { store, service: new OperationsService(store, { mode: 'mock', clock: () => NOW }) }
}

async function orden(store: InMemoryTableStore, id: string) {
  const view = await readView(store, 'ORDENES_CODEX')
  return toRecord(view, findById(view, 'ORDEN_ID', id)[0]!.cells)
}

describe('cliente de GitHub', () => {
  it('solo acepta URLs de issues/PRs de los 3 repositorios permitidos', () => {
    expect(urlGitHubPermitida('https://github.com/jlpulido107-bit/PROJECT-OS/issues/29', 'issues')).toBe(true)
    expect(urlGitHubPermitida('https://github.com/jlpulido107-bit/sigsah/pull/7', 'pull')).toBe(true)
    expect(urlGitHubPermitida('https://github.com/jlpulido107-bit/PROJECT-OS/pull/29', 'issues')).toBe(false)
    expect(urlGitHubPermitida('https://github.com/otro/PROJECT-OS/issues/1', 'issues')).toBe(false)
    expect(urlGitHubPermitida('https://github.com/jlpulido107-bit/PROJECT-OS/issues/1?x=1', 'issues')).toBe(false)
  })

  it('el cuerpo del issue lleva las secciones de la plantilla y el ID de la orden', () => {
    const body = cuerpoIssue({ ordenId: 'ORD-POS-001', proyectoId: 'POS', tareaId: 'POS-009', titulo: 't', objetivo: 'O', contexto: '', criterios: 'C', fueraDeAlcance: 'F', comoProbar: 'npm test', riesgo: 'BAJO' })
    for (const s of ['### ID de la tarea', '### Objetivo', '### Criterios de aceptación', '### Fuera de alcance', '### Cómo probar', '### Riesgo', '`[ORD-POS-001]`']) expect(body).toContain(s)
  })
})

describe('aprobar y enviar a Codex (F4)', () => {
  it('aprobar crea el issue, menciona a @codex una vez y deja la orden ENVIADA con su ISSUE_URL', async () => {
    const { store, service } = setup()
    const gh = fakeGitHub()
    const r = await transitionWithDispatch(service, parseOrderTransition('ORD-POS-901', { accion: 'APROBAR', expectedEstado: 'BORRADOR', requestId: uuid() }), ACTOR, gh.client)
    expect(r.envio).toMatchObject({ ok: true, creado: true, issueUrl: 'https://github.com/jlpulido107-bit/PROJECT-OS/issues/100' })
    expect(gh.issues).toHaveLength(1)
    expect(gh.issues[0]!.title).toBe('[ORD-POS-901][DEMO-002] Orden demo por aprobar')
    expect(gh.issues[0]!.comments).toHaveLength(1)
    expect(gh.issues[0]!.comments[0]).toMatch(/^@codex resuelve este issue/)
    expect(await orden(store, 'ORD-POS-901')).toMatchObject({ ESTADO: 'ENVIADA', ISSUE_URL: 'https://github.com/jlpulido107-bit/PROJECT-OS/issues/100' })
    expect((await service.reconcile()).pendientes).toEqual([])
  })

  it('si GitHub falla, la orden queda APROBADA y reintentar «Enviar» no duplica el issue ni la mención', async () => {
    const { store, service } = setup()
    const caida = fakeGitHub({ failCreate: 502 })
    const r = await transitionWithDispatch(service, parseOrderTransition('ORD-POS-901', { accion: 'APROBAR', expectedEstado: 'BORRADOR', requestId: uuid() }), ACTOR, caida.client)
    expect(r.envio).toEqual({ ok: false, codigo: 'http-502' })
    expect(await orden(store, 'ORD-POS-901')).toMatchObject({ ESTADO: 'APROBADA', ISSUE_URL: '' })

    const gh = fakeGitHub()
    const retry = parseOrderTransition('ORD-POS-901', { accion: 'ENVIAR', expectedEstado: 'APROBADA', requestId: uuid() })
    expect((await transitionWithDispatch(service, retry, ACTOR, gh.client)).envio).toMatchObject({ ok: true, creado: true })
    // Simula una orden que volviera a APROBADA con el issue ya creado: se reutiliza y no se menciona dos veces.
    const again = await gh.client.enviar({ ordenId: 'ORD-POS-901', proyectoId: 'POS', tareaId: 'DEMO-002', titulo: 'x', objetivo: 'o', contexto: '', criterios: 'c', fueraDeAlcance: 'f', comoProbar: 'p', riesgo: 'BAJO' })
    expect(again).toMatchObject({ creado: false, mencionado: false, issueNumber: 100 })
    expect(gh.issues).toHaveLength(1)
    expect(gh.issues[0]!.comments).toHaveLength(1)
  })

  it('sin token la aprobación se guarda y avisa sin-token; sin red no se llama a GitHub', async () => {
    const { store, service } = setup()
    const r = await transitionWithDispatch(service, parseOrderTransition('ORD-POS-901', { accion: 'APROBAR', expectedEstado: 'BORRADOR', requestId: uuid() }), ACTOR, null)
    expect(r.envio).toEqual({ ok: false, codigo: 'sin-token' })
    expect((await orden(store, 'ORD-POS-901')).ESTADO).toBe('APROBADA')
  })

  it('enviar solo desde APROBADA; luego registrar PR, revisar y cerrar en orden', async () => {
    const { store, service } = setup()
    const gh = fakeGitHub()
    await expect(transitionWithDispatch(service, parseOrderTransition('ORD-POS-901', { accion: 'ENVIAR', expectedEstado: 'BORRADOR', requestId: uuid() }), ACTOR, gh.client)).rejects.toMatchObject({ code: 'transicion-no-permitida' })
    await transitionWithDispatch(service, parseOrderTransition('ORD-POS-901', { accion: 'APROBAR', expectedEstado: 'BORRADOR', requestId: uuid() }), ACTOR, gh.client)
    const pr = 'https://github.com/jlpulido107-bit/PROJECT-OS/pull/101'
    await service.transitionOrder(parseOrderTransition('ORD-POS-901', { accion: 'REGISTRAR_PR', expectedEstado: 'ENVIADA', url: pr, requestId: uuid() }), ACTOR)
    expect(await orden(store, 'ORD-POS-901')).toMatchObject({ ESTADO: 'PR_ABIERTO', PR_URL: pr })
    await service.transitionOrder(parseOrderTransition('ORD-POS-901', { accion: 'REVISAR', expectedEstado: 'PR_ABIERTO', requestId: uuid() }), ACTOR)
    await service.transitionOrder(parseOrderTransition('ORD-POS-901', { accion: 'CERRAR', expectedEstado: 'REVISADA', requestId: uuid() }), ACTOR)
    expect((await orden(store, 'ORD-POS-901')).ESTADO).toBe('CERRADA')
    expect((await service.reconcile()).pendientes).toEqual([])
  })

  it('registrar PR exige una URL de PR de los repositorios permitidos', () => {
    expect(() => parseOrderTransition('ORD-POS-901', { accion: 'REGISTRAR_PR', expectedEstado: 'ENVIADA', requestId: uuid() })).toThrow()
    expect(() => parseOrderTransition('ORD-POS-901', { accion: 'REGISTRAR_PR', expectedEstado: 'ENVIADA', url: 'https://github.com/otro/x/pull/1', requestId: uuid() })).toThrow()
    expect(() => parseOrderTransition('ORD-POS-901', { accion: 'REVISAR', expectedEstado: 'PR_ABIERTO', url: 'https://github.com/jlpulido107-bit/PROJECT-OS/pull/1', requestId: uuid() })).toThrow()
  })

  it('detecta el PR de una orden por su título, sin escribir', async () => {
    const gh = fakeGitHub()
    gh.prs.push({ number: 7, title: '[ORD-POS-901] Prueba', html_url: 'https://github.com/jlpulido107-bit/PROJECT-OS/pull/7', state: 'open', merged_at: null })
    expect(await gh.client.prDeOrden('POS', 'ORD-POS-901')).toEqual({ url: 'https://github.com/jlpulido107-bit/PROJECT-OS/pull/7', number: 7, estado: 'abierto' })
    expect(await gh.client.prDeOrden('POS', 'ORD-POS-999')).toBeNull()
    expect(gh.calls.every((c) => c.startsWith('GET'))).toBe(true)
  })

  it('el requestId derivado es un UUID v4 estable', () => {
    const a = derivedRequestId('00000000-0000-4000-8000-000000000001', 'enviar')
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(derivedRequestId('00000000-0000-4000-8000-000000000001', 'enviar')).toBe(a)
  })
})
