import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildFixtureTabs } from '@/lib/fixtures'
import { WRITE_HEADERS } from '@/lib/operations/constants'
import { transitionWithDispatch } from '@/lib/operations/dispatch'
import { OperationError } from '@/lib/operations/errors'
import { GitHubError, type GitHubClient } from '@/lib/operations/github'
import { evaluateWriteRequest } from '@/lib/operations/guard'
import { registrarModeloDeSesion } from '@/lib/operations/modelo-sesion'
import { RateLimiter } from '@/lib/operations/rate-limit'
import { OperationsService } from '@/lib/operations/service'
import { findById, InMemoryTableStore, readView } from '@/lib/operations/table-store'
import { parseModeloSesion, parseOrderTransition, payloadHash } from '@/lib/operations/validation'
import { extraerCriterios } from '@/lib/supervision/criterios'
import { MARCA_DICTAMEN } from '@/lib/supervision/dictamen'

/**
 * ORD-POS-165 (DEC-POS-039): el PM da de alta el modelo real de las sesiones enlazadas a una orden con la operación
 * auditada `orden.modelo_sesion`, y la supervisión (REVISAR del PM) lo usa. Apagada sin SUPERVISION_MODELO_SESION=true.
 */

const PM = { actor: 'agente-pm', agent: true }
const ORDEN = 'ORD-POS-902'
const HEAD = 'a'.repeat(40)
const OTRO_HEAD = 'c'.repeat(40)
const PR_URL = 'https://github.com/jlpulido107-bit/PROJECT-OS/pull/50'
const ISSUE_URL = 'https://github.com/jlpulido107-bit/PROJECT-OS/issues/49'
const CRITERIOS = '1. Uno\n2. Dos'
const crit = extraerCriterios(CRITERIOS)
if (!crit.ok) throw new Error('criterios de prueba inválidos')
const sesion = (nombre: string) => `https://claude.ai/code/session_${nombre}`
const S_IMPL = sesion('impl')
let seq = 0
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`

const reporte = (rol: string, n: number, modelo?: string) => ({
  versionContrato: '2', rol, ...(modelo ? { modelo } : {}), versionPolitica: 'DEC-POS-039', ordenId: ORDEN, tareaId: 'DEMO-002',
  proyectoId: 'POS', repo: 'jlpulido107-bit/PROJECT-OS', issue: 49, pr: 50, headSha: HEAD, baseSha: 'b'.repeat(40), hashCriterios: crit.hashCriterios,
  revisionId: `REV-${ORDEN}-${n}`, ejecucionId: `EJE-${ORDEN}-${n}`, intento: 1, ronda: 0,
  autorizacion: { otorgadaPor: 'propietario', orden: ORDEN, desde: '2026-11-22' }, limiteConsumo: { presupuesto: '1 USD', tiempoMaximo: '30 min' },
  criterios: [{ id: '1', resultado: 'CUMPLE', evidencia: 'ok' }, { id: '2', resultado: 'CUMPLE', evidencia: 'ok' }],
  evidencia: { propias: [{ comando: 'npm test', sha: HEAD, codigoSalida: 0 }], ci: { estado: 'EXITO', ejecucion: 'r1', sha: HEAD }, autor: [] },
  hallazgos: [], veredicto: 'CONFORME',
})
const comentario = (r: unknown, id: number) => ({ id, body: `${MARCA_DICTAMEN}\n\n\`\`\`json\n${JSON.stringify(r)}\n\`\`\`` })
/** PRIMERO de Sonnet y SEGUNDO sin `modelo`, como en ORD-POS-162 y 163. */
const COMENTARIOS = [comentario(reporte('PRIMERO', 1, 'claude-sonnet-5-5'), 7), comentario(reporte('SEGUNDO', 2), 8)]

async function setup(campos: Record<string, string> = {}) {
  const tabs = buildFixtureTabs('2026-11-22') as Record<string, unknown[][]>
  const store = new InMemoryTableStore({ ...tabs, AUDITORIA: [[...WRITE_HEADERS.AUDITORIA]] })
  const view = await readView(store, 'ORDENES_CODEX')
  const fila = findById(view, 'ORDEN_ID', ORDEN)[0]!
  const valores: Record<string, string> = { PR_URL, ISSUE_URL, CRITERIOS_ACEPTACION: CRITERIOS, RIESGO: 'MEDIO', ...campos }
  await store.writeRow('ORDENES_CODEX', fila.sheetRow, fila.cells.map((c, i) => valores[view.header[i]!] ?? c))
  const ctl = { head: HEAD, fallaGitHub: false, implementacion: S_IMPL as string | null }
  const service = new OperationsService(store, { mode: 'mock', clock: () => new Date('2026-11-22T16:00:00Z') })
  const gh = <T>(v: () => T) => async () => { if (ctl.fallaGitHub) throw new GitHubError(503); return v() }
  const github = {
    lanzamientoPrevio: gh(() => ctl.implementacion), datosDictamen: gh(() => ({ headSha: ctl.head, comentarios: COMENTARIOS })),
  } as unknown as GitHubClient
  const auditoria = () => store.snapshot().AUDITORIA!.slice(1) as string[][]
  /** Lanzamiento del dashboard (revisar o corregir) de la sesión `nombre` con la clave del paso `n` en `head`. */
  const lanzar = (nombre: string, n: number, accion: 'revisar' | 'corregir' = 'revisar', head = HEAD) => service.registrarLanzamiento(
    `orden.${accion}_lanzar`, uuid(), payloadHash(`orden.${accion}_lanzar`, { ordenId: ORDEN, headEsperado: head }), ORDEN, sesion(nombre),
    { actor: 'escritor@example.com' }, `${ORDEN}|${accion}|${head}|${n}`)
  const registrar = (s: string, configuredModel: string, lastServedModel = configuredModel, extra: Record<string, unknown> = {}, ctx = PM) =>
    registrarModeloDeSesion(service, parseModeloSesion(ORDEN, { requestId: uuid(), sesion: s, head: HEAD, configuredModel, lastServedModel, ...extra }), ctx, github)
  const revisar = () => transitionWithDispatch(service, parseOrderTransition(ORDEN, { requestId: uuid(), accion: 'REVISAR', expectedEstado: 'PR_ABIERTO' }), PM, github, null)
  const estado = async () => (await service.readOrder(ORDEN))?.ESTADO
  return { service, github, ctl, auditoria, lanzar, registrar, revisar, estado }
}

const codigo = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof OperationError ? e.code : `otro: ${String(e)}`))

afterEach(() => { vi.unstubAllEnvs() })

describe('bandera apagada (por defecto)', () => {
  it.each([undefined, '', 'on', 'TRUE', '1', ' true'])('con SUPERVISION_MODELO_SESION=%j el PM no registra nada', async (valor) => {
    if (valor !== undefined) vi.stubEnv('SUPERVISION_MODELO_SESION', valor)
    const e = await setup()
    await e.lanzar('rev1', 1)
    const antes = e.auditoria().length
    expect(await codigo(e.registrar(sesion('rev1'), 'claude-sonnet-5-5'))).toBe('operacion-no-permitida')
    expect(e.auditoria()).toHaveLength(antes)
  })

  it('REVISAR del PM sigue como antes: un SEGUNDO sin `modelo` no cuenta', async () => {
    const e = await setup()
    expect(await codigo(e.revisar())).toBe('dictamen-insuficiente')
    expect(await e.estado()).toBe('PR_ABIERTO')
  })

  it('el guard rechaza la operación con el token del PM', async () => {
    expect(await codigo(evaluateWriteRequest(peticion(), contexto({})))).toBe('operacion-no-permitida')
  })
})

const TOKEN = 'token-del-pm-de-prueba'
// SHA-256 de TOKEN, calculado aquí para no dejar un valor fijo que parezca un secreto.
const HASH = (await import('node:crypto')).createHash('sha256').update(TOKEN, 'utf8').digest('hex')
const peticion = (headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) => new Request('http://127.0.0.1:3000/api/operaciones/ordenes/ORD-POS-902/modelo-sesion', {
  method: 'POST', body: JSON.stringify({ requestId: uuid() }), headers: { 'content-type': 'application/json', ...headers },
})
const contexto = (vars: Record<string, string>, email: string | null = null) => ({
  email, limiter: new RateLimiter(), agentLimiter: new RateLimiter(), operation: 'orden.modelo_sesion' as const,
  env: { PROJECT_OS_WRITE_MODE: 'mock', DASHBOARD_DATA_SOURCE: 'fixtures', PM_AGENT_TOKEN_SHA256: HASH, AUTH_ALLOWED_EMAILS: 'escritor@example.com', AUTH_WRITER_EMAILS: 'escritor@example.com', NEXTAUTH_URL: 'http://127.0.0.1:3000', ...vars } as unknown as NodeJS.ProcessEnv,
})

describe('guard: solo el token del PM y solo con la bandera', () => {
  it('con SUPERVISION_MODELO_SESION=true el token del PM pasa como agente-pm', async () => {
    expect(await evaluateWriteRequest(peticion(), contexto({ SUPERVISION_MODELO_SESION: 'true' }))).toMatchObject({ actor: 'agente-pm', agent: true })
  })

  it('otro token no pasa', async () => {
    expect(await codigo(evaluateWriteRequest(peticion({ authorization: 'Bearer otro' }), contexto({ SUPERVISION_MODELO_SESION: 'true' })))).toBe('no-autenticado')
  })

  it('una sesión de navegador de un escritor nunca, con la bandera encendida', async () => {
    const navegador = peticion({ origin: 'http://127.0.0.1:3000', 'x-project-os-csrf': '1', 'sec-fetch-site': 'same-origin' })
    expect(await codigo(evaluateWriteRequest(navegador, contexto({ SUPERVISION_MODELO_SESION: 'true' }, 'escritor@example.com')))).toBe('operacion-no-permitida')
  })
})

describe('alta auditada con la bandera encendida', () => {
  beforeEach(() => { vi.stubEnv('SUPERVISION_MODELO_SESION', 'true') })

  it('registra una sesión de revisión lanzada: actor agente-pm, sesión, orden, head, papel y los dos modelos; no toca la orden', async () => {
    const e = await setup()
    await e.lanzar('rev1', 1)
    const antes = e.auditoria().length
    const r = await e.registrar(sesion('rev1'), 'claude-sonnet-5-5', 'claude-sonnet-5-5[1m]')
    expect(r).toEqual({ operacion: 'orden.modelo_sesion', entidad: 'ORDENES_CODEX', id: ORDEN, repetida: false })
    const filas = e.auditoria().slice(antes)
    const h = WRITE_HEADERS.AUDITORIA as readonly string[]
    const col = (f: string[], c: string) => f[h.indexOf(c)]
    expect(Object.fromEntries(filas.map((f) => [col(f, 'CAMPO'), col(f, 'VALOR_DESPUES')]))).toEqual({
      SESION: sesion('rev1'), HEAD, PAPEL: 'REVISION', MODELO_CONFIGURADO: 'claude-sonnet-5-5', MODELO_SERVIDO: 'claude-sonnet-5-5[1m]',
    })
    for (const f of filas) {
      expect(col(f, 'ACTOR')).toBe('agente-pm')
      expect(col(f, 'ENTIDAD')).toBe('ORDENES_CODEX')
      expect(col(f, 'REGISTRO_ID')).toBe(ORDEN)
      expect(col(f, 'VALOR_ANTES')).toBe('')
      expect(col(f, 'FECHA_HORA')).toMatch(/^2026-11-22T/)
      expect(col(f, 'ORIGEN')).toMatch(/;op=orden\.modelo_sesion;req=[0-9a-f-]{36};h=[0-9a-f]{16};agente=pm$/)
    }
    expect(await e.estado()).toBe('PR_ABIERTO')
    expect((await e.service.reconcile()).pendientes).toEqual([])
  })

  it('el papel lo deriva el servidor: revisión, corrección o implementación según dónde quedó la sesión', async () => {
    const e = await setup()
    await e.lanzar('rev1', 1)
    await e.lanzar('corr', 2, 'corregir')
    await e.registrar(sesion('rev1'), 'claude-sonnet-5-5')
    await e.registrar(sesion('corr'), 'claude-opus-5-5')
    await e.registrar(S_IMPL, 'claude-fable-5-2', 'claude-opus-5-5')
    expect(await e.service.modelosDeOrden(ORDEN)).toEqual({
      registros: [
        { papel: 'REVISION', sesion: sesion('rev1'), head: HEAD, n: 1, configurado: 'claude-sonnet-5-5', servido: 'claude-sonnet-5-5' },
        { papel: 'CORRECCION', sesion: sesion('corr'), head: HEAD, configurado: 'claude-opus-5-5', servido: 'claude-opus-5-5' },
        { papel: 'IMPLEMENTACION', sesion: S_IMPL, head: HEAD, configurado: 'claude-fable-5-2', servido: 'claude-opus-5-5' },
      ],
      correcciones: [sesion('corr')],
    })
    expect((await e.service.modelosDeOrden('ORD-POS-901')).registros).toEqual([])
  })

  it('una sesión que el dashboard no lanzó para esta orden no se registra', async () => {
    const e = await setup()
    await e.lanzar('rev1', 1)
    const antes = e.auditoria().length
    expect(await codigo(e.registrar(sesion('ajena'), 'claude-haiku-5-5'))).toBe('sesion-no-enlazada')
    e.ctl.implementacion = null
    expect(await codigo(e.registrar(S_IMPL, 'claude-fable-5-2'))).toBe('sesion-no-enlazada')
    expect(e.auditoria()).toHaveLength(antes)
  })

  it('el head tiene que ser el actual del PR, y la orden tener un PR abierto registrado', async () => {
    const e = await setup()
    await e.lanzar('rev1', 1)
    const antes = e.auditoria().length
    expect(await codigo(e.registrar(sesion('rev1'), 'claude-sonnet-5-5', undefined, { head: OTRO_HEAD }))).toBe('head-no-vigente')
    e.ctl.head = OTRO_HEAD
    expect(await codigo(e.registrar(sesion('rev1'), 'claude-sonnet-5-5'))).toBe('head-no-vigente')
    expect(e.auditoria()).toHaveLength(antes)
    const sinPr: Array<Record<string, string>> = [{ ESTADO: 'ENVIADA' }, { ESTADO: 'CERRADA' }, { PR_URL: '' }, { PR_URL: 'https://github.com/otro/repo/pull/50' }]
    for (const campos of sinPr) {
      const otra = await setup(campos)
      expect(await codigo(otra.registrar(S_IMPL, 'claude-fable-5-2')), JSON.stringify(campos)).toBe('head-no-vigente')
    }
  })

  it('sin GitHub no se registra nada (falla cerrado)', async () => {
    const e = await setup()
    await e.lanzar('rev1', 1)
    const antes = e.auditoria().length
    e.ctl.fallaGitHub = true
    expect(await codigo(e.registrar(sesion('rev1'), 'claude-sonnet-5-5'))).toBe('github-no-disponible')
    expect(await codigo(registrarModeloDeSesion(e.service, parseModeloSesion(ORDEN, { requestId: uuid(), sesion: sesion('rev1'), head: HEAD, configuredModel: 'claude-sonnet-5-5', lastServedModel: 'claude-sonnet-5-5' }), PM, null))).toBe('github-no-disponible')
    expect(e.auditoria()).toHaveLength(antes)
  })

  it('solo el agente PM: un escritor con sesión no registra aunque llegue hasta aquí', async () => {
    const e = await setup()
    await e.lanzar('rev1', 1)
    expect(await codigo(e.registrar(sesion('rev1'), 'claude-sonnet-5-5', undefined, {}, { actor: 'escritor@example.com', agent: false }))).toBe('operacion-no-permitida')
  })

  it('una orden que no existe', async () => {
    const e = await setup()
    const cmd = parseModeloSesion('ORD-POS-999', { requestId: uuid(), sesion: S_IMPL, head: HEAD, configuredModel: 'claude-fable-5-2', lastServedModel: 'claude-fable-5-2' })
    expect(await codigo(registrarModeloDeSesion(e.service, cmd, PM, e.github))).toBe('orden-inexistente')
  })

  it('idempotente: el mismo requestId no añade filas, y con otro contenido es un conflicto', async () => {
    const e = await setup()
    await e.lanzar('rev1', 1)
    const cuerpo = { requestId: uuid(), sesion: sesion('rev1'), head: HEAD, configuredModel: 'claude-sonnet-5-5', lastServedModel: 'claude-sonnet-5-5' }
    const enviar = (c: Record<string, unknown>) => registrarModeloDeSesion(e.service, parseModeloSesion(ORDEN, c), PM, e.github)
    expect((await enviar(cuerpo)).repetida).toBe(false)
    const filas = e.auditoria().length
    expect((await enviar(cuerpo)).repetida).toBe(true)
    expect(e.auditoria()).toHaveLength(filas)
    expect(await codigo(enviar({ ...cuerpo, lastServedModel: 'claude-haiku-5-5' }))).toBe('conflicto-idempotencia')
    expect(e.auditoria()).toHaveLength(filas)
  })

  it('solo alta: registrar otra vez la misma sesión añade un registro y no cambia el anterior', async () => {
    const e = await setup()
    await e.lanzar('rev1', 1)
    await e.registrar(sesion('rev1'), 'claude-sonnet-5-5')
    const primero = e.auditoria().map((f) => [...f])
    await e.registrar(sesion('rev1'), 'claude-sonnet-5-5', 'claude-haiku-5-5')
    expect(e.auditoria().slice(0, primero.length)).toEqual(primero)
    expect((await e.service.modelosDeOrden(ORDEN)).registros.map((r) => r.servido)).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5'])
  })

  it('el registro de una revisión toma head y correlativo del lanzamiento: uno de otro head no entra', async () => {
    const e = await setup()
    await e.lanzar('vieja', 1, 'revisar', OTRO_HEAD)
    // La sesión se lanzó para otro head; el PM la registra en el head actual: queda en AUDITORIA pero la supervisión no la usa.
    await e.registrar(sesion('vieja'), 'claude-haiku-5-5')
    expect((await e.service.modelosDeOrden(ORDEN)).registros).toEqual([])
  })
})

describe('validación del cuerpo', () => {
  const base = { requestId: '00000000-0000-4000-8000-000000000001', sesion: S_IMPL, head: HEAD, configuredModel: 'claude-fable-5-2', lastServedModel: 'claude-opus-5-5[1m]' }
  it('acepta el comando y normaliza el ID de la orden', () => {
    expect(parseModeloSesion(' ord-pos-902 ', base)).toEqual({ ...base, ordenId: ORDEN })
  })

  it.each([
    ['sesión que no es de claude.ai/code', { sesion: 'https://evil.example/code/session_1' }],
    ['sesión con texto alrededor', { sesion: `ver ${S_IMPL}` }],
    ['head corto', { head: 'abc1234' }],
    ['modelo con mayúsculas y espacios', { configuredModel: 'Fable 5.2' }],
    ['modelo vacío', { lastServedModel: '' }],
    ['modelo ausente', { lastServedModel: undefined }],
    ['papel enviado por el PM', { papel: 'REVISION' }],
    ['clave desconocida', { n: 2 }],
    ['requestId inválido', { requestId: 'x' }],
  ])('rechaza %s', (_, cambio) => {
    expect(() => parseModeloSesion(ORDEN, { ...base, ...cambio })).toThrow(OperationError)
  })

  it('rechaza un ID de orden inválido', () => {
    expect(() => parseModeloSesion('ORDEN', base)).toThrow(OperationError)
  })
})

describe('REVISAR del PM con el registro (de punta a punta)', () => {
  beforeEach(() => { vi.stubEnv('SUPERVISION_MODELO_SESION', 'true') })

  it('sin registro falta segundo revisor; con el de las tres sesiones, el SEGUNDO sin `modelo` cuenta y la orden pasa a REVISADA', async () => {
    const e = await setup()
    await e.lanzar('rev1', 1)
    await e.lanzar('rev2', 2)
    expect(await codigo(e.revisar())).toBe('dictamen-insuficiente')
    await e.registrar(S_IMPL, 'claude-fable-5-2')
    await e.registrar(sesion('rev1'), 'claude-sonnet-5-5')
    expect(await codigo(e.revisar())).toBe('dictamen-insuficiente')
    await e.registrar(sesion('rev2'), 'claude-haiku-5-5')
    await e.revisar()
    expect(await e.estado()).toBe('REVISADA')
  })

  it('si la orden la implementó la familia del SEGUNDO, no pasa', async () => {
    const e = await setup()
    await e.lanzar('rev1', 1)
    await e.lanzar('rev2', 2)
    await e.registrar(S_IMPL, 'claude-fable-5-2', 'claude-haiku-5-5')
    await e.registrar(sesion('rev1'), 'claude-sonnet-5-5')
    await e.registrar(sesion('rev2'), 'claude-haiku-5-5')
    expect(await codigo(e.revisar())).toBe('dictamen-insuficiente')
    expect(await e.estado()).toBe('PR_ABIERTO')
  })

  it('un SEGUNDO cuya sesión no lanzó el dashboard no se puede registrar ni cuenta', async () => {
    const e = await setup()
    await e.lanzar('rev1', 1)
    await e.registrar(S_IMPL, 'claude-fable-5-2')
    await e.registrar(sesion('rev1'), 'claude-sonnet-5-5')
    expect(await codigo(e.registrar(sesion('rev2'), 'claude-haiku-5-5'))).toBe('sesion-no-enlazada')
    expect(await codigo(e.revisar())).toBe('dictamen-insuficiente')
  })
})
