import { afterEach, describe, expect, it, vi } from 'vitest'
import { todayInMerida } from '@/lib/dates'
import { buildFixtureTabs } from '@/lib/fixtures'
import { createRoutineClient, rutinasSupervision, RoutineError, textoSupervision, type RutinasSupervision } from '@/lib/operations/claude-routine'
import { WRITE_HEADERS, type OperationName } from '@/lib/operations/constants'
import { evaluateWriteRequest } from '@/lib/operations/guard'
import { createGitHubClient } from '@/lib/operations/github'
import { RateLimiter } from '@/lib/operations/rate-limit'
import { OperationError } from '@/lib/operations/errors'
import { lanzarSupervision } from '@/lib/operations/revision'
import { OperationsService } from '@/lib/operations/service'
import { InMemoryTableStore } from '@/lib/operations/table-store'
import { parseLanzarSupervision } from '@/lib/operations/validation'
import { extraerCriterios } from '@/lib/supervision/criterios'
import { CORRELATIVO_AGOTADO, evaluarDictamen, MARCA_DICTAMEN } from '@/lib/supervision/dictamen'

/** «Lanzar revisión» y «Pedir corrección» (ORD-POS-037) con GitHub y rutinas simulados: sin red. */

const ME = 'jlpulido107-bit'
const PR_URL = 'https://github.com/jlpulido107-bit/PROJECT-OS/pull/50'
const HEAD = 'a'.repeat(40)
const HEAD2 = 'c'.repeat(40)
const TOKEN_RUTINA = 'token-rutina-secreto'
const CRITERIOS = '1. Uno\n2. Dos'
const crit = extraerCriterios(CRITERIOS)
if (!crit.ok) throw new Error('criterios de prueba inválidos')
const NOW = new Date('2026-10-17T16:30:00Z')
const ACTOR = { actor: 'escritor@example.com' }
let seq = 0
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`

const reporte = (extra: Record<string, unknown> = {}) => ({
  versionContrato: '2', rol: 'PRIMERO', modelo: 'claude-sonnet-5-5', versionPolitica: 'DEC-POS-008', ordenId: 'ORD-POS-099', tareaId: 'POS-001',
  proyectoId: 'POS', repo: 'jlpulido107-bit/PROJECT-OS', issue: 49, pr: 50, headSha: HEAD, baseSha: 'b'.repeat(40), hashCriterios: crit.hashCriterios,
  revisionId: 'REV-ORD-POS-099-1', ejecucionId: 'EJE-ORD-POS-099-1', intento: 1, ronda: 0,
  autorizacion: { otorgadaPor: 'propietario', orden: 'ORD-POS-099', desde: '2026-10-17' }, limiteConsumo: { presupuesto: '1 USD', tiempoMaximo: '30 min' },
  criterios: [{ id: '1', resultado: 'CUMPLE', evidencia: 'ok' }, { id: '2', resultado: 'CUMPLE', evidencia: 'ok' }],
  evidencia: { propias: [{ comando: 'npm test', sha: HEAD, codigoSalida: 0 }], ci: { estado: 'EXITO', ejecucion: 'r1', sha: HEAD }, autor: [] },
  hallazgos: [], veredicto: 'CONFORME', ...extra,
})
const bloqueante = { id: 'H1', severidad: 'ALTA', ubicacion: 'a.ts:1', condicion: 'c', impacto: 'i', bloquea: true, justificacion: 'j' }
const cambios = (extra: Record<string, unknown> = {}) =>
  reporte({ criterios: [{ id: '1', resultado: 'NO_CUMPLE', evidencia: 'x' }, { id: '2', resultado: 'CUMPLE', evidencia: 'ok' }], hallazgos: [bloqueante], veredicto: 'CAMBIOS', ...extra })
const comentario = (r: unknown) => ({ body: `${MARCA_DICTAMEN}\n**Dictamen**\n\n\`\`\`json\n${JSON.stringify(r)}\n\`\`\`` })

function escenario(opts: { comentarios?: Array<{ body: string }>; riesgo?: string; head?: string; rutinaStatus?: number; sinRutinas?: boolean } = {}) {
  const fires: Array<{ rutina: string; text: string; auth: string }> = []
  const rutinaFetch = (nombre: string) => (async (url: string, init: RequestInit = {}) => {
    fires.push({ rutina: nombre, text: (JSON.parse(String(init.body)) as { text: string }).text, auth: (init.headers as Record<string, string>).Authorization! })
    if (opts.rutinaStatus) return new Response(JSON.stringify({ error: { message: 'detalle interno' } }), { status: opts.rutinaStatus })
    return new Response(JSON.stringify({ claude_code_session_url: `https://claude.ai/code/session_${fires.length}` }), { status: 200 })
  }) as unknown as typeof fetch
  const rutinas: RutinasSupervision = opts.sinRutinas ? { revisar: null, segundo: null, corregir: null } : {
    revisar: createRoutineClient('rutina_revisar_01', TOKEN_RUTINA, rutinaFetch('revisar')),
    segundo: createRoutineClient('rutina_segundo_01', TOKEN_RUTINA, rutinaFetch('segundo')),
    corregir: createRoutineClient('rutina_corregir_01', TOKEN_RUTINA, rutinaFetch('corregir')),
  }
  const githubFetch = (async (url: string) => {
    const u = new URL(url)
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
    if (u.pathname === '/user') return json(200, { login: ME })
    if (u.pathname === '/repos/jlpulido107-bit/PROJECT-OS/pulls/50') return json(200, { head: { sha: opts.head ?? HEAD } })
    if (u.pathname === '/repos/jlpulido107-bit/PROJECT-OS/issues/50/comments') return json(200, (opts.comentarios ?? []).map((c, i) => ({ id: 100 + i, body: c.body, user: { login: ME } })))
    return json(404, {})
  }) as unknown as typeof fetch
  const store = new InMemoryTableStore({ ...(buildFixtureTabs('2026-10-17') as Record<string, unknown[][]>), AUDITORIA: [[...WRITE_HEADERS.AUDITORIA]] })
  const service = new OperationsService(store, { mode: 'mock', clock: () => NOW })
  vi.spyOn(service, 'readOrder').mockResolvedValue({
    ORDEN_ID: 'ORD-POS-099', PROYECTO_ID: 'POS', ESTADO: 'PR_ABIERTO', PR_URL: PR_URL, RIESGO: opts.riesgo ?? 'MEDIO', CRITERIOS_ACEPTACION: CRITERIOS,
  })
  const lanzar = (accion: 'revisar' | 'corregir', head = HEAD, requestId = uuid()) =>
    lanzarSupervision(service, parseLanzarSupervision('ORD-POS-099', { requestId, accion: accion.toUpperCase(), headEsperado: head }), ACTOR, { github: createGitHubClient('token-github', githubFetch), rutinas })
  const auditoria = () => store.snapshot().AUDITORIA!.slice(1)
  return { service, store, opts, fires, lanzar, auditoria }
}

afterEach(() => vi.restoreAllMocks())

describe('lanzar revisión', () => {
  it('sin dictamen: primer revisor con datos derivados, audita la sesión y concilia', async () => {
    const e = escenario()
    const r = await e.lanzar('revisar')
    expect(r).toEqual({ ok: true, nueva: true, sessionUrl: 'https://claude.ai/code/session_1' })
    expect(e.fires).toHaveLength(1)
    expect(e.fires[0]!.rutina).toBe('revisar')
    expect(e.fires[0]!.text).toBe([
      'ORDEN_ID: ORD-POS-099', 'REPOSITORIO: jlpulido107-bit/PROJECT-OS', 'PR: 50', `HEAD_ESPERADO: ${HEAD}`, 'ROL: PRIMERO',
      'REVISION_ID: REV-ORD-POS-099-1', 'EJECUCION_ID: EJE-ORD-POS-099-1', 'INTENTO: 1', 'RONDA: 0', 'LIMITE_CONSUMO: 1 USD; 30 min',
      // La autorización se fecha con el reloj real (todayInMerida), no con el de la prueba.
      `AUTORIZACION: propietario; ORD-POS-099; ${todayInMerida()}`,
    ].join('\n'))
    const fila = e.auditoria().find((f) => f.includes('SESION'))!
    expect(e.auditoria().filter((f) => f.includes(`ORD-POS-099|revisar|${HEAD}|1`))).toHaveLength(2)
    expect(fila).toContain('https://claude.ai/code/session_1')
    expect(fila.join('|')).toMatch(/op=orden\.revisar_lanzar/)
    expect((await e.service.reconcile()).pendientes).toEqual([])
  })

  it('doble clic y reintento con el mismo requestId lanzan una sola sesión', async () => {
    const e = escenario()
    const id = uuid()
    const [a, b] = await Promise.all([e.lanzar('revisar', HEAD, id), e.lanzar('revisar', HEAD, id)])
    expect(a).toEqual(b)
    expect(await e.lanzar('revisar', HEAD, id)).toEqual({ ok: true, nueva: false, sessionUrl: 'https://claude.ai/code/session_1' })
    expect(e.fires).toHaveLength(1)
    expect(e.auditoria().filter((f) => f.includes('SESION'))).toHaveLength(1)
  })

  it('si la rutina responde error: solo el estado HTTP, sin auditoría ni éxito, y el token no sale', async () => {
    const aviso = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const e = escenario({ rutinaStatus: 429 })
    const r = await e.lanzar('revisar')
    expect(r).toEqual({ ok: false, codigo: 'http-429' })
    expect(e.auditoria().filter((f) => f.includes('SESION'))).toHaveLength(0)
    expect(e.fires[0]!.auth).toBe(`Bearer ${TOKEN_RUTINA}`)
    expect(JSON.stringify([r, aviso.mock.calls])).not.toMatch(/token|detalle interno/)
  })

  it('no lanza si el head cambió, si no hay rutina o si el riesgo es ALTO', async () => {
    expect(await escenario({ head: HEAD2 }).lanzar('revisar')).toEqual({ ok: false, codigo: 'head-cambio' })
    expect(await escenario({ sinRutinas: true }).lanzar('revisar')).toEqual({ ok: false, codigo: 'sin-rutina' })
    expect(await escenario({ riesgo: 'ALTO' }).lanzar('revisar')).toEqual({ ok: false, codigo: 'sin-accion' })
    expect(await escenario().lanzar('corregir')).toEqual({ ok: false, codigo: 'sin-accion' })
  })

  it('MEDIO con un CONFORME: segundo revisor con su rutina, ronda y correlativo derivados', async () => {
    const e = escenario({ comentarios: [comentario(reporte())] })
    expect(await e.lanzar('revisar')).toMatchObject({ ok: true })
    expect(e.fires[0]!.rutina).toBe('segundo')
    expect(e.fires[0]!.text).toContain('ROL: SEGUNDO')
    expect(e.fires[0]!.text).toContain('REVISION_ID: REV-ORD-POS-099-2')
  })

  it('correlativo REV-…-999: sin botón, lo explica y el servidor no dispara', async () => {
    const r999 = reporte({ revisionId: 'REV-ORD-POS-099-999', ejecucionId: 'EJE-ORD-POS-099-999' })
    const ev = evaluarDictamen({ headSha: HEAD, comentarios: [{ id: 1, ...comentario(r999) }] }, { id: 'ORD-POS-099', riesgo: 'MEDIO', criterios: CRITERIOS }, { repo: 'jlpulido107-bit/PROJECT-OS', numero: 50 })
    expect(ev).toMatchObject({ siguiente: CORRELATIVO_AGOTADO, plan: null, agotado: true })
    expect(CORRELATIVO_AGOTADO).toBe('Correlativo de revisión agotado (máximo 999)')
    const e = escenario({ comentarios: [comentario(r999)] })
    expect(await e.lanzar('revisar')).toEqual({ ok: false, codigo: 'correlativo-agotado' })
    expect(e.fires).toHaveLength(0)
    expect(await escenario({ comentarios: [comentario(reporte({ revisionId: 'REV-ORD-POS-099-998', ejecucionId: 'EJE-ORD-POS-099-998' }))] }).lanzar('revisar')).toMatchObject({ ok: true })
  })

  it('CAMBIOS con ronda menor que 2: pide corrección con la URL del comentario; con ronda 2 no hay botón', async () => {
    const e = escenario({ comentarios: [comentario(cambios())] })
    expect(await e.lanzar('corregir')).toMatchObject({ ok: true })
    expect(e.fires[0]!.rutina).toBe('corregir')
    expect(e.fires[0]!.text).toBe(['ORDEN_ID: ORD-POS-099', 'REPOSITORIO: jlpulido107-bit/PROJECT-OS', `PR: ${PR_URL}`, `HEAD_ESPERADO: ${HEAD}`, `HALLAZGOS: ${PR_URL}#issuecomment-100`].join('\n'))
    expect(await escenario({ comentarios: [comentario(cambios({ ronda: 2 }))] }).lanzar('corregir')).toEqual({ ok: false, codigo: 'sin-accion' })
    expect(await escenario({ comentarios: [comentario(cambios({ ronda: 2 }))] }).lanzar('revisar')).toEqual({ ok: false, codigo: 'sin-accion' })
  })

  it('tras una corrección (head nuevo) toca el delta de la ronda siguiente', async () => {
    const e = escenario({ comentarios: [comentario(cambios())], head: HEAD2 })
    expect(await e.lanzar('revisar', HEAD2)).toMatchObject({ ok: true })
    expect(e.fires[0]!.rutina).toBe('revisar')
    expect(e.fires[0]!.text).toMatch(/ROL: DELTA[\s\S]*REVISION_ID: REV-ORD-POS-099-2[\s\S]*RONDA: 1/)
  })
})

describe('una sola sesión por paso (ORD-POS-039)', () => {
  const HORA = 60 * 60 * 1000
  it('otro requestId tras lanzar no dispara y devuelve la sesión; /ordenes la ve por clave', async () => {
    const e = escenario()
    await e.lanzar('revisar')
    expect(await e.lanzar('revisar')).toEqual({ ok: true, nueva: false, sessionUrl: 'https://claude.ai/code/session_1' })
    expect(e.fires).toHaveLength(1)
    expect(await e.service.lanzamientosPorClave([`ORD-POS-099|revisar|${HEAD}|1`])).toEqual(new Map([[`ORD-POS-099|revisar|${HEAD}|1`, { tipo: 'lanzada', sesion: 'https://claude.ai/code/session_1' }]]))
    expect((await e.service.reconcile()).pendientes).toEqual([])
  })

  it('si falla la auditoría tras lanzar, el reintento (mismo u otro requestId) no dispara: resultado incierto', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const e = escenario()
    vi.spyOn(e.service, 'registrarLanzamiento').mockRejectedValueOnce(new OperationError('auditoria-fallida'))
    const id = uuid()
    expect(await e.lanzar('revisar', HEAD, id)).toMatchObject({ ok: true, codigo: 'auditoria-pendiente' })
    expect(await e.lanzar('revisar', HEAD, id)).toEqual({ ok: false, codigo: 'resultado-incierto' })
    expect(await e.lanzar('revisar')).toEqual({ ok: false, codigo: 'resultado-incierto' })
    expect(e.fires).toHaveLength(1)
    expect([...(await e.service.lanzamientosPorClave([`ORD-POS-099|revisar|${HEAD}|1`])).values()]).toEqual([{ tipo: 'reservada' }])
  })

  it('si no se puede escribir la reserva, no dispara', async () => {
    const e = escenario()
    vi.spyOn(e.store, 'appendRows').mockRejectedValueOnce(new Error('cuota'))
    expect(await e.lanzar('revisar')).toEqual({ ok: false, codigo: 'auditoria-fallida' })
    expect(e.fires).toHaveLength(0)
  })

  it('la reserva sin lanzamiento caduca a las 2 horas', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const e = escenario({ rutinaStatus: 500 })
    await e.lanzar('revisar')
    const reloj = vi.spyOn(e.service as unknown as { clock: () => Date }, 'clock')
    reloj.mockReturnValue(new Date(NOW.getTime() + 2 * HORA - 1))
    expect(await e.lanzar('revisar')).toEqual({ ok: false, codigo: 'resultado-incierto' })
    reloj.mockReturnValue(new Date(NOW.getTime() + 2 * HORA))
    expect(await e.lanzar('revisar')).toEqual({ ok: false, codigo: 'http-500' })
    expect(e.fires).toHaveLength(2)
  })

  it('un head nuevo o un correlativo nuevo es otra clave: sí dispara', async () => {
    const e = escenario({ comentarios: [comentario(cambios())] })
    await e.lanzar('corregir')
    e.opts.head = HEAD2
    expect(await e.lanzar('revisar', HEAD2)).toMatchObject({ ok: true, nueva: true })
    const f = escenario()
    await f.lanzar('revisar')
    f.opts.comentarios = [comentario(reporte())]
    expect(await f.lanzar('revisar')).toMatchObject({ ok: true, nueva: true })
    expect([e.fires.length, f.fires.length]).toEqual([2, 2])
  })
})

describe('protección y validación', () => {
  const ORIGIN = 'http://127.0.0.1:3000'
  const ENV = { NEXTAUTH_URL: ORIGIN, AUTH_ALLOWED_EMAILS: 'escritor@example.com', AUTH_WRITER_EMAILS: 'escritor@example.com', PROJECT_OS_WRITE_MODE: 'mock', DASHBOARD_DATA_SOURCE: 'fixtures', PM_AGENT_TOKEN_SHA256: 'a'.repeat(64) } as unknown as NodeJS.ProcessEnv
  const req = (headers: Record<string, string>) => new Request(`${ORIGIN}/api/operaciones/ordenes/ORD-POS-099/supervision`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', ...headers } })
  const ctx = (email: string | null) => ({ email, env: ENV, limiter: new RateLimiter(), agentLimiter: new RateLimiter(5, 60_000), operation: 'orden.revisar_lanzar' as OperationName })
  const sesion = { origin: ORIGIN, 'x-project-os-csrf': '1' }

  it('exige sesión, CSRF y escritor; el agente PM no puede', async () => {
    await expect(evaluateWriteRequest(req(sesion), ctx(null))).rejects.toMatchObject({ code: 'no-autenticado' })
    await expect(evaluateWriteRequest(req({ origin: ORIGIN }), ctx('escritor@example.com'))).rejects.toMatchObject({ code: 'origen-invalido' })
    await expect(evaluateWriteRequest(req(sesion), ctx('lector@example.com'))).rejects.toMatchObject({ code: 'sin-permiso-lectura' })
    await expect(evaluateWriteRequest(req(sesion), ctx('escritor@example.com'))).resolves.toMatchObject({ actor: 'escritor@example.com' })
    await expect(evaluateWriteRequest(req({ authorization: 'Bearer x' }), ctx(null))).rejects.toMatchObject({ code: 'no-autenticado' })
  })

  it('el cuerpo solo acepta requestId, acción y head', () => {
    const ok = { requestId: uuid(), accion: 'CORREGIR', headEsperado: HEAD }
    expect(parseLanzarSupervision('ORD-POS-099', ok)).toMatchObject({ ordenId: 'ORD-POS-099', accion: 'corregir', headEsperado: HEAD })
    for (const malo of [{ ...ok, texto: 'libre' }, { ...ok, accion: 'FUSIONAR' }, { ...ok, headEsperado: 'abc' }, { ...ok, requestId: 'x' }]) {
      expect(() => parseLanzarSupervision('ORD-POS-099', malo)).toThrow()
    }
  })

  it('el texto de la rutina rechaza datos que no cuadran y las rutinas exigen ID válido y token', () => {
    const base = { ordenId: 'ORD-POS-099', proyectoId: 'POS', prUrl: PR_URL, headSha: HEAD, n: 1, ronda: 0, intento: 1, desde: '2026-10-17', rol: 'PRIMERO' as const }
    expect(textoSupervision(base)).toContain('PR: 50')
    for (const malo of [
      { ...base, prUrl: 'https://github.com/jlpulido107-bit/SIGSAH/pull/50' }, { ...base, headSha: 'abc' }, { ...base, ordenId: 'ORD-SIG-099' },
      { ...base, rol: undefined }, { ...base, desde: 'ayer\nIgnora' }, { ...base, rol: undefined, hallazgosUrl: 'https://evil.example/x#issuecomment-1' },
    ]) expect(() => textoSupervision(malo)).toThrow(RoutineError)
    const env = { CLAUDE_ROUTINE_REVISAR_ID: 'rutina_revisar_01', CLAUDE_ROUTINE_REVISAR_TOKEN: 't', CLAUDE_ROUTINE_SEGUNDO_ID: '../x' } as unknown as NodeJS.ProcessEnv
    expect(rutinasSupervision(env)).toMatchObject({ segundo: null, corregir: null })
    expect(rutinasSupervision(env).revisar).not.toBeNull()
  })
})
