import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildFixtureTabs } from '@/lib/fixtures'
import { WRITE_HEADERS } from '@/lib/operations/constants'
import { pmPuedeRegistrarPr } from '@/lib/operations/config'
import { transitionWithDispatch } from '@/lib/operations/dispatch'
import { GitHubError, type GitHubClient, type PrDeOrden } from '@/lib/operations/github'
import { evaluateWriteRequest } from '@/lib/operations/guard'
import { RateLimiter } from '@/lib/operations/rate-limit'
import { OperationsService } from '@/lib/operations/service'
import { findById, InMemoryTableStore, readView } from '@/lib/operations/table-store'
import { parseOrderTransition } from '@/lib/operations/validation'
import { createHash } from 'node:crypto'

/** ORD-POS-063 (DEC-POS-014): REGISTRAR_PR del agente PM con el PR detectado, inerte sin PM_PUEDE_REGISTRAR_PR=true. */

const PM = { actor: 'agente-pm', agent: true }
const HEAD = 'c'.repeat(40)
const PR: PrDeOrden = { url: 'https://github.com/jlpulido107-bit/PROJECT-OS/pull/77', number: 77, estado: 'abierto', headSha: HEAD, baseSha: 'b'.repeat(40) }
let seq = 0
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`

afterEach(() => vi.unstubAllEnvs())

async function setup(detectado: { pr: PrDeOrden | null; total: number } = { pr: PR, total: 1 }) {
  const store = new InMemoryTableStore({ ...(buildFixtureTabs('2026-10-22') as Record<string, unknown[][]>), AUDITORIA: [[...WRITE_HEADERS.AUDITORIA]] })
  const view = await readView(store, 'ORDENES_CODEX')
  const fila = findById(view, 'ORDEN_ID', 'ORD-POS-901')[0]!
  const enviada: Record<string, string> = { ESTADO: 'ENVIADA', ISSUE_URL: 'https://github.com/jlpulido107-bit/PROJECT-OS/issues/76' }
  await store.writeRow('ORDENES_CODEX', fila.sheetRow, fila.cells.map((c, i) => enviada[view.header[i]!] ?? c))
  const service = new OperationsService(store, { mode: 'mock', clock: () => new Date('2026-10-22T16:00:00Z') })
  const ctl = { detectado, falla: false, lecturas: 0 }
  const github = {
    prDetectadoDeOrden: async () => { ctl.lecturas++; if (ctl.falla) throw new GitHubError(503); return ctl.detectado },
  } as unknown as GitHubClient
  const run = (body: Record<string, unknown>) =>
    transitionWithDispatch(service, parseOrderTransition('ORD-POS-901', body, { agente: true }), PM, github, null)
  const auditoria = () => store.snapshot().AUDITORIA!.slice(1)
  const orden = () => service.readOrder('ORD-POS-901')
  return { run, auditoria, orden, ctl }
}

const body = () => ({ requestId: uuid(), accion: 'REGISTRAR_PR', expectedEstado: 'ENVIADA' })

describe('bandera apagada por defecto (criterio 1)', () => {
  it('solo el valor exacto true la enciende', () => {
    for (const v of [undefined, '', 'TRUE', '1', 'yes', ' true']) expect(pmPuedeRegistrarPr({ PM_PUEDE_REGISTRAR_PR: v } as unknown as NodeJS.ProcessEnv), String(v)).toBe(false)
    expect(pmPuedeRegistrarPr({ PM_PUEDE_REGISTRAR_PR: 'true' } as unknown as NodeJS.ProcessEnv)).toBe(true)
  })

  it('sin la bandera, REGISTRAR_PR del PM responde transicion-reservada-pm sin escribir ni leer GitHub', async () => {
    for (const v of [undefined, 'false', 'TRUE']) {
      if (v === undefined) vi.unstubAllEnvs(); else vi.stubEnv('PM_PUEDE_REGISTRAR_PR', v)
      const e = await setup()
      await expect(e.run(body())).rejects.toMatchObject({ code: 'transicion-reservada-pm' })
      expect([e.auditoria(), (await e.orden())?.ESTADO, e.ctl.lecturas]).toEqual([[], 'ENVIADA', 0])
    }
  })

  it('el guard la rechaza con la bandera apagada y la deja pasar encendida', async () => {
    const token = 'token-de-prueba-sintetico-0123456789'
    const base = { PROJECT_OS_WRITE_MODE: 'mock', DASHBOARD_DATA_SOURCE: 'fixtures', PM_AGENT_TOKEN_SHA256: createHash('sha256').update(token).digest('hex') }
    const pedir = (env: Record<string, string | undefined>) => evaluateWriteRequest(
      new Request('http://127.0.0.1:3000/api/operaciones/ordenes/ORD-POS-901', {
        method: 'PATCH', body: JSON.stringify({ accion: 'registrar_pr ' }), headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      }),
      { email: null, env: env as unknown as NodeJS.ProcessEnv, limiter: new RateLimiter(), agentLimiter: new RateLimiter(5, 60_000), operation: 'orden.aprobar' },
    )
    for (const flag of [{}, { PM_PUEDE_REGISTRAR_PR: 'false' }]) {
      await expect(pedir({ ...base, ...flag })).rejects.toMatchObject({ code: 'transicion-reservada-pm', status: 403 })
    }
    expect((await pedir({ ...base, PM_PUEDE_REGISTRAR_PR: 'true' })).actor).toBe('agente-pm')
  })
})

describe('con la bandera: solo el PR detectado (criterio 2)', () => {
  it('pasa ENVIADA → PR_ABIERTO con el PR que detecta /ordenes', async () => {
    vi.stubEnv('PM_PUEDE_REGISTRAR_PR', 'true')
    const e = await setup()
    expect(await e.run(body())).toMatchObject({ operacion: 'orden.registrar_pr', repetida: false })
    expect(await e.orden()).toMatchObject({ ESTADO: 'PR_ABIERTO', PR_URL: PR.url })
  })

  it('el cuerpo del PM no acepta url libre', async () => {
    vi.stubEnv('PM_PUEDE_REGISTRAR_PR', 'true')
    expect(() => parseOrderTransition('ORD-POS-901', { ...body(), url: PR.url }, { agente: true })).toThrow()
    // El propietario sigue registrando con url, y sin ella falla como antes.
    expect(parseOrderTransition('ORD-POS-901', { ...body(), url: PR.url }).url).toBe(PR.url)
    expect(() => parseOrderTransition('ORD-POS-901', body())).toThrow()
  })

  it('sin PR, con más de uno, no abierto, con otro estado de la orden o sin GitHub: error propio sin escribir', async () => {
    vi.stubEnv('PM_PUEDE_REGISTRAR_PR', 'true')
    const casos: Array<[{ pr: PrDeOrden | null; total: number }, string]> = [
      [{ pr: null, total: 0 }, 'pr-no-detectado'],
      [{ pr: PR, total: 2 }, 'pr-no-detectado'],
      [{ pr: { ...PR, estado: 'cerrado' }, total: 1 }, 'pr-no-detectado'],
      [{ pr: { ...PR, estado: 'fusionado' }, total: 1 }, 'pr-no-detectado'],
    ]
    for (const [detectado, codigo] of casos) {
      const e = await setup(detectado)
      await expect(e.run(body()), JSON.stringify(detectado)).rejects.toMatchObject({ code: codigo, status: 422 })
      expect([e.auditoria(), await e.orden()]).toMatchObject([[], { ESTADO: 'ENVIADA', PR_URL: '' }])
    }
    const e = await setup()
    e.ctl.falla = true
    await expect(e.run(body())).rejects.toMatchObject({ code: 'github-no-disponible' })
    e.ctl.falla = false
    await expect(e.run({ ...body(), expectedEstado: 'APROBADA' })).rejects.toMatchObject({ code: 'conflicto-version' })
    expect([e.auditoria(), (await e.orden())?.ESTADO]).toEqual([[], 'ENVIADA'])
  })
})

describe('auditoría e idempotencia (criterio 3)', () => {
  it('audita actor agente-pm, la URL y el head; repetir con el mismo requestId no añade filas ni relee GitHub', async () => {
    vi.stubEnv('PM_PUEDE_REGISTRAR_PR', 'true')
    const e = await setup()
    const b = body()
    await e.run(b)
    const filas = e.auditoria()
    const texto = JSON.stringify(filas)
    expect(texto).toContain('agente-pm')
    expect(texto).toContain(PR.url)
    expect(texto).toContain(`pr ${PR.url} head ${HEAD}`)
    expect(texto).toContain(b.requestId)
    Object.assign(e.ctl, { falla: true, lecturas: 0 })
    expect(await e.run(b)).toMatchObject({ repetida: true })
    expect([e.auditoria(), e.ctl.lecturas]).toEqual([filas, 0])
    expect(await e.orden()).toMatchObject({ ESTADO: 'PR_ABIERTO', PR_URL: PR.url })
  })
})
