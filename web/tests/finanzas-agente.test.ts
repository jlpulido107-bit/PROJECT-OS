import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'
import { render } from '../deploy/cloudrun/render.mjs'
import { decide } from '@/lib/authz'
import { finanzasAgenteMode, finanzasAgenteStatus } from '@/lib/finanzas/agente-config'
import { evaluateFinanzasAgenteRequest } from '@/lib/finanzas/agente-guard'
import { finanzasAgenteWrite, type FinanzasAgenteHandlerDeps } from '@/lib/finanzas/agente-handler'
import { auditoriaAgente, codificarFuente, FINANZAS_AGENTE_OPERATIONS, FinanzasAgenteService, leerOrigenAgente, origenAgente } from '@/lib/finanzas/agente-service'
import { fuenteProhibida, parseCargoExtra, parseCorte, parseRendimiento } from '@/lib/finanzas/agente-validacion'
import { evaluateFinanzasWriteRequest } from '@/lib/finanzas/escritura-guard'
import { FINANZAS_OPERATIONS, tabla, COLUMNAS_AUDITORIA } from '@/lib/finanzas/escritura-service'
import { FinanzasSheetsStore, InMemoryFinanzasStore, type Celda, type FinanzasStore, type FinanzasWriteTab } from '@/lib/finanzas/escritura-store'
import { capitalUsado, costoHerramientas, gastoClaudeMensual, leerMovimientos } from '@/lib/finanzas/finanzas'
import { AGENT_OPERATIONS } from '@/lib/operations/constants'
import { OperationError } from '@/lib/operations/errors'
import { evaluateWriteRequest } from '@/lib/operations/guard'
import { RateLimiter } from '@/lib/operations/rate-limit'
import { createWriteTokenProvider } from '@/lib/operations/write-credentials'

/**
 * Agente de finanzas (ORD-POS-092, docs/diseno-finanzas-v3.md, DEC-POS-018). Solo dobles de token y de fetch: ninguna
 * prueba toca Google. Montos, cuentas, tokens y sesiones inventados; las cifras de §5 son las sintéticas del diseño.
 */

const PROPIA = '16UXe7fm90fOTTVJhI_RZ8__I876u2buvjeLGr5cJ-Ic'
const FINANZAS = 'LIBRO_FINANZAS_SINTETICO_0123456789'
const LECTURA = 'project-os-dashboard-run@project-os-511102.iam.gserviceaccount.com'
const ESCRITURA_POS = 'project-os-writer@project-os-511102.iam.gserviceaccount.com'
const CUENTA_FIN = 'project-os-finanzas@project-os-511102.iam.gserviceaccount.com'
const CUENTA_AGENTE = 'project-os-finanzas-agente@project-os-511102.iam.gserviceaccount.com'
const DUENO = 'dueno@example.com'
const ORIGIN = 'http://127.0.0.1:3000'
const PM_TOKEN = 'token-del-pm-sintetico-0123456789'
const PM_HASH = createHash('sha256').update(PM_TOKEN).digest('hex')
const AGENTE_TOKEN = 'token-del-agente-de-finanzas-sintetico-0123456789'
const AGENTE_HASH = createHash('sha256').update(AGENTE_TOKEN).digest('hex')
const REPORTE = 'session_SINTETICA0123456789'

const ACTIVA: Record<string, string> = {
  NEXTAUTH_URL: ORIGIN,
  AUTH_ALLOWED_EMAILS: `lector@example.com, ${DUENO}`,
  SHEETS_SPREADSHEET_ID: PROPIA,
  SHEETS_EXPECTED_SERVICE_ACCOUNT: LECTURA,
  PROJECT_OS_WRITE_SERVICE_ACCOUNT: ESCRITURA_POS,
  FINANZAS_SHEET_ID: FINANZAS,
  FINANZAS_WRITE_SERVICE_ACCOUNT: CUENTA_FIN,
  PM_AGENT_TOKEN_SHA256: PM_HASH,
  FINANZAS_AGENTE_MODE: 'sheets',
  FINANZAS_AGENTE_SERVICE_ACCOUNT: CUENTA_AGENTE,
  FINANZAS_AGENTE_TOKEN_SHA256: AGENTE_HASH,
}
const env = (vars: Record<string, string | undefined>) => vars as unknown as NodeJS.ProcessEnv

/** Mediodía en Mérida (UTC−6) del día dado. */
const dia = (fecha: string) => new Date(`${fecha}T18:00:00Z`)

const ENC_MOV = ['MOV_ID', 'FECHA', 'PROYECTO', 'TIPO', 'CATEGORIA', 'CONCEPTO', 'PRODUCTO_ID', 'MONTO_MXN', 'MONEDA_ORIG', 'MONTO_ORIG', 'TIPO_CAMBIO', 'IVA_MXN', 'FUENTE', 'COMPROBANTE', 'AJUSTE_DE']
const ENC_AUD = ['AUDIT_ID', 'FECHA_HORA', 'ACTOR', 'ENTIDAD', 'REGISTRO_ID', 'CAMPO', 'VALOR_ANTES', 'VALOR_DESPUES', 'ORIGEN']
const ENC_REC = ['ID', 'CONCEPTO', 'PROYECTO', 'CATEGORIA', 'MONTO', 'MONEDA', 'DIA_COBRO', 'DESDE', 'HASTA']
const ENC_REND = ['REND_ID', 'CORTE_INICIO', 'CORTE_FIN', 'COSTO_EQUIV_USD', 'SESIONES', 'SESIONES_SIN_DATO', 'TOKENS_ENTRADA', 'TOKENS_SALIDA', 'REPORTE', 'FECHA_REGISTRO']

const mov = (r: Record<string, Celda>): Celda[] => ENC_MOV.map((c) => r[c] ?? '')
/** `REC-CLAUDE-AAAA-MM` confirmado por el propietario: S = 50.00 USD (cifra sintética de §5). */
const recClaude = (mes: string, fecha: string, usd = 50) => mov({
  MOV_ID: `REC-CLAUDE-${mes}`, FECHA: fecha, PROYECTO: 'POS', TIPO: 'Gasto', CATEGORIA: 'Herramientas', CONCEPTO: 'Suscripción Claude',
  MONTO_MXN: Number((usd * 18.5).toFixed(2)), MONEDA_ORIG: 'USD', MONTO_ORIG: usd, TIPO_CAMBIO: 18.5, FUENTE: 'recurrente', COMPROBANTE: 'sí',
})

function libro(over: Partial<Record<string, unknown[][]>> = {}) {
  return {
    MOVIMIENTOS: [ENC_MOV, mov({ MOV_ID: 'MAN-0001', FECHA: '2027-01-05', PROYECTO: 'ECO', TIPO: 'Gasto', CATEGORIA: 'Producto', CONCEPTO: 'Muestras', MONTO_MXN: 100, MONEDA_ORIG: 'MXN', FUENTE: 'manual', COMPROBANTE: 'sí' })],
    PARAMETROS: [['PARAMETRO', 'VALOR'], ['MES_INICIO', '2026-09'], ['TIPO_CAMBIO_DEFECTO', 18.5]],
    // DIA_COBRO = 10: la suscripción cae en Q1 (§5).
    RECURRENTES: [ENC_REC, ['CLAUDE', 'Suscripción Claude', 'POS', 'Herramientas', 50, 'USD', 10, '2026-01', ''], ['KEEPA', 'Keepa', 'ECO', 'Herramientas', 400, 'MXN', 20, '2026-01', '']],
    AUDITORIA: [ENC_AUD],
    RENDIMIENTO_CLAUDE: [ENC_REND],
    ...over,
  }
}

let seq = 0
const rid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`
const svc = (store: FinanzasStore, now: Date) => new FinanzasAgenteService(store, { clock: () => now, randomHex: () => 'abcd1234' })
const fuente = (corte: string, cita: string, fecha: string) => `${corte} «${cita}» ${fecha}`
const rend = (corte: string, costo: string, over: Record<string, unknown> = {}) => ({ requestId: rid(), corte, reporte: REPORTE, costoEquivUsd: costo, sesiones: 12, sesionesSinDato: 1, tokensEntrada: 1000, tokensSalida: 500, ...over })
const cargo = (corte: string, total: string, fecha: string, over: Record<string, unknown> = {}) => ({
  requestId: rid(), corte, reporte: REPORTE, facturaTotalUsd: total, fuente: fuente(corte, `total de Anthropic ${total} USD`, fecha), proyecto: 'POS', ...over,
})

async function codigo(p: Promise<unknown> | (() => unknown)) {
  const e = await (typeof p === 'function' ? Promise.resolve().then(p) : p).catch((x: unknown) => x)
  expect(e).toBeInstanceOf(OperationError)
  return (e as OperationError).code
}

const filas = (s: InMemoryFinanzasStore, tab: string) => s.snapshot()[tab]!.slice(1)
const col = (row: unknown[], c: string) => row[ENC_MOV.indexOf(c)]

/** Almacén espía: registra lecturas y escrituras, y puede fallar o descartar las de una pestaña. */
class Espia implements FinanzasStore {
  readonly libro: string
  appends: string[] = []
  reads: string[][] = []
  constructor(private readonly inner: InMemoryFinanzasStore, private readonly tab = 'NINGUNA', private readonly modo: 'falla' | 'descarta' = 'falla') {
    this.libro = inner.libro
  }
  tabs() { return this.inner.tabs() }
  read(tabs: readonly FinanzasWriteTab[]) {
    this.reads.push([...tabs])
    return this.inner.read(tabs)
  }
  async append(tab: FinanzasWriteTab, rows: Celda[][]) {
    this.appends.push(tab)
    if (tab === this.tab) {
      if (this.modo === 'falla') throw new Error('HTTP 503')
      return
    }
    return this.inner.append(tab, rows)
  }
}

/* -------------------------------- §9 criterio 1: la vista -------------------------------- */

describe('vista: FUENTE agente-finanzas y CLAUDE-EXTRA- solo juntos y con TIPO Gasto (§7)', () => {
  const extra = (over: Record<string, Celda> = {}) => mov({
    MOV_ID: 'CLAUDE-EXTRA-2027-02-Q2', FECHA: '2027-02-28', PROYECTO: 'POS', TIPO: 'Gasto', CATEGORIA: 'Herramientas', CONCEPTO: 'Claude: cargo adicional 2027-02-Q2',
    MONTO_MXN: 370, MONEDA_ORIG: 'USD', MONTO_ORIG: 20, TIPO_CAMBIO: 18.5, FUENTE: 'agente-finanzas', COMPROBANTE: 'sí', ...over,
  })

  it('fila válida: se suma como cualquier gasto (capital, gasto de Claude)', () => {
    const l = leerMovimientos([ENC_MOV, recClaude('2027-02', '2027-02-10'), extra()])
    if (l.estado !== 'ok') throw new Error('lectura')
    expect(l.problemas).toEqual([])
    expect(capitalUsado(l.movimientos, { topeCentavos: null, alertaPct: 80, mesInicio: null, avisos: [] }).porProyecto.POS).toBe(92500 + 37000)
    expect(gastoClaudeMensual(l.movimientos)).toEqual([{ mes: '2027-02', gasto: { ECO: 0, POS: 92500 + 37000 } }])
  })

  it.each([
    [{ FUENTE: 'manual' }, 'MOV_ID'],
    [{ FUENTE: 'anthropic' }, 'MOV_ID'],
    [{ MOV_ID: 'MAN-0009' }, 'MOV_ID'],
    [{ MOV_ID: 'CLAUDE-EXTRA-2027-13-Q1' }, 'MOV_ID'],
    [{ MOV_ID: 'CLAUDE-EXTRA-2027-02-Q3' }, 'MOV_ID'],
    [{ MOV_ID: 'CLAUDE-EXTRA-2027-02' }, 'MOV_ID'],
    [{ TIPO: 'Inversión' }, 'TIPO'],
    [{ TIPO: 'Ingreso' }, 'TIPO'],
  ])('%o: fila con problema en %s, sin sumar', (over, columna) => {
    const l = leerMovimientos([ENC_MOV, extra(over)])
    if (l.estado !== 'ok') throw new Error('lectura')
    expect(l.movimientos).toEqual([])
    expect(l.problemas[0]!.columnas).toContain(columna)
  })

  it('CLAUDE-2027-02 sigue siendo de anthropic: CLAUDE-EXTRA- no choca con él', () => {
    const l = leerMovimientos([ENC_MOV, mov({ MOV_ID: 'CLAUDE-2027-02', FECHA: '2027-02-01', PROYECTO: 'POS', TIPO: 'Gasto', CATEGORIA: 'Herramientas', CONCEPTO: 'x', MONTO_MXN: 10, FUENTE: 'anthropic', COMPROBANTE: 'sí' })])
    expect(l.estado === 'ok' && l.problemas).toEqual([])
  })

  it('criterio 5: Claude sale en una sola línea de Herramientas (suscripción, cargo extra y MAN- con «Claude»)', () => {
    const l = leerMovimientos([
      ENC_MOV, recClaude('2027-02', '2027-02-10'), extra(),
      mov({ MOV_ID: 'MAN-0001', FECHA: '2027-01-08', PROYECTO: 'POS', TIPO: 'Gasto', CATEGORIA: 'Herramientas', CONCEPTO: 'Claude Max (antes del recurrente)', MONTO_MXN: 900, FUENTE: 'manual', COMPROBANTE: 'sí' }),
      mov({ MOV_ID: 'MAN-0002', FECHA: '2027-02-08', PROYECTO: 'ECO', TIPO: 'Gasto', CATEGORIA: 'Herramientas', CONCEPTO: 'Keepa', MONTO_MXN: 400, FUENTE: 'manual', COMPROBANTE: 'sí' }),
    ])
    if (l.estado !== 'ok') throw new Error('lectura')
    const h = costoHerramientas(l.movimientos, ['2027-01', '2027-02'])
    expect(h.conceptos.map((c) => [c.concepto, c.porMes])).toEqual([
      ['Claude', { '2027-01': 90000, '2027-02': 92500 + 37000 }],
      ['Keepa', { '2027-01': null, '2027-02': 40000 }],
    ])
  })
})

/* ---------------------------- §9 criterio 2: configuración §8.1 ---------------------------- */

describe('configuración de §8.1: inerte salvo con todas las condiciones', () => {
  it('con todas: sheets', () => {
    expect(finanzasAgenteStatus(env(ACTIVA))).toEqual({ mode: 'sheets', reason: null })
  })

  it.each([
    [{ FINANZAS_AGENTE_MODE: undefined }, 'deshabilitada'],
    [{ FINANZAS_AGENTE_MODE: 'disabled' }, 'deshabilitada'],
    [{ FINANZAS_AGENTE_MODE: 'Sheets' }, 'modo-invalido'],
    [{ FINANZAS_AGENTE_MODE: ' sheets' }, 'modo-invalido'],
    [{ FINANZAS_SHEET_ID: undefined }, 'sin-libro'],
    [{ FINANZAS_SHEET_ID: PROPIA }, 'sin-libro'],
    [{ FINANZAS_AGENTE_SERVICE_ACCOUNT: undefined }, 'sin-cuenta'],
    [{ FINANZAS_AGENTE_SERVICE_ACCOUNT: 'agente@gmail.com' }, 'sin-cuenta'],
    [{ SHEETS_EXPECTED_SERVICE_ACCOUNT: undefined }, 'sin-cuenta-de-lectura'],
    [{ FINANZAS_AGENTE_SERVICE_ACCOUNT: 'project-os-finanzas-agente@otro-proyecto-1.iam.gserviceaccount.com' }, 'cuenta-de-otro-proyecto'],
    [{ FINANZAS_AGENTE_SERVICE_ACCOUNT: LECTURA }, 'cuenta-de-lectura'],
    [{ FINANZAS_AGENTE_SERVICE_ACCOUNT: ESCRITURA_POS.toUpperCase() }, 'cuenta-de-project-os'],
    [{ FINANZAS_AGENTE_SERVICE_ACCOUNT: CUENTA_FIN }, 'cuenta-del-propietario'],
    [{ FINANZAS_AGENTE_TOKEN_SHA256: undefined }, 'sin-hash'],
    [{ FINANZAS_AGENTE_TOKEN_SHA256: 'abc' }, 'sin-hash'],
    [{ FINANZAS_AGENTE_TOKEN_SHA256: PM_HASH.toUpperCase() }, 'hash-del-pm'],
  ])('%o: deshabilitada con motivo %s', (over, reason) => {
    expect(finanzasAgenteStatus(env({ ...ACTIVA, ...over }))).toEqual({ mode: 'disabled', reason })
  })

  it('no depende de FINANZAS_WRITE_MODE ni de PROJECT_OS_WRITE_MODE', () => {
    expect(finanzasAgenteMode(env({ ...ACTIVA, FINANZAS_WRITE_MODE: undefined, PROJECT_OS_WRITE_MODE: undefined }))).toBe('sheets')
    expect(finanzasAgenteMode(env({ ...ACTIVA, FINANZAS_AGENTE_MODE: undefined, FINANZAS_WRITE_MODE: 'sheets', PROJECT_OS_WRITE_MODE: 'sheets' }))).toBe('disabled')
  })
})

/* ----------------------------- §9 criterio 3: proxy y guard ----------------------------- */

describe('proxy y guard propios: 401 cruzados', () => {
  const RUTAS = ['/api/finanzas/agente/rendimiento', '/api/finanzas/agente/cargo-extra']
  const nreq = (ruta: string, headers: Record<string, string>, method = 'POST') => new NextRequest(new URL(ruta, ORIGIN), { method, headers })
  const opts = { secret: 'secreto-de-prueba-0123456789abcdef', agentTokenSha256: PM_HASH, finanzasAgenteTokenSha256: AGENTE_HASH }

  it('proxy: el token del agente solo abre sus dos rutas POST; el del PM, sin cookie o con cookie, no', async () => {
    for (const ruta of RUTAS) {
      expect((await decide(nreq(ruta, { authorization: `Bearer ${AGENTE_TOKEN}` }), opts)).action).toBe('agent')
      expect((await decide(nreq(ruta, { authorization: `Bearer ${AGENTE_TOKEN}` }, 'GET'), opts)).action).toBe('unauthenticated')
      expect((await decide(nreq(ruta, { authorization: `Bearer ${PM_TOKEN}` }), opts)).action).toBe('unauthenticated')
      expect((await decide(nreq(ruta, {}), opts)).action).toBe('unauthenticated')
      const conCookie = nreq(ruta, { authorization: `Bearer ${AGENTE_TOKEN}`, cookie: 'next-auth.session-token=manipulada' })
      expect((await decide(conCookie, opts)).action).toBe('unauthenticated')
      // Con el hash del agente igual al del PM, ningún token entra a estas rutas.
      expect((await decide(nreq(ruta, { authorization: `Bearer ${PM_TOKEN}` }), { ...opts, finanzasAgenteTokenSha256: PM_HASH })).action).toBe('unauthenticated')
    }
    for (const ruta of ['/api/finanzas/movimientos', '/api/finanzas/recurrentes/confirmar', '/api/operaciones/tareas', '/api/operaciones/ordenes', '/finanzas']) {
      expect((await decide(nreq(ruta, { authorization: `Bearer ${AGENTE_TOKEN}` }), opts)).action, ruta).toBe('unauthenticated')
    }
    // Control: el token del PM sigue valiendo en su lista.
    expect((await decide(nreq('/api/operaciones/tareas', { authorization: `Bearer ${PM_TOKEN}` }), opts)).action).toBe('agent')
  })

  const req = (headers: Record<string, string>, body = '{}') => new Request(`${ORIGIN}/api/finanzas/agente/rendimiento`, {
    method: 'POST', body, headers: { 'content-type': 'application/json', ...headers },
  })
  const ctx = (vars = ACTIVA, limiter = new RateLimiter(3, 60_000)) => ({ env: env(vars), limiter })
  const auth = { authorization: `Bearer ${AGENTE_TOKEN}` }

  it('guard: 401 sin token, con cookie, con el del PM o con otro; 403 sin modo; 415; 413; 429; 400 JSON', async () => {
    expect(await codigo(evaluateFinanzasAgenteRequest(req({}), ctx()))).toBe('no-autenticado')
    expect(await codigo(evaluateFinanzasAgenteRequest(req({ ...auth, cookie: 'next-auth.session-token=x' }), ctx()))).toBe('no-autenticado')
    expect(await codigo(evaluateFinanzasAgenteRequest(req({ authorization: `Bearer ${PM_TOKEN}` }), ctx()))).toBe('no-autenticado')
    expect(await codigo(evaluateFinanzasAgenteRequest(req({ authorization: 'Bearer otro' }), ctx()))).toBe('no-autenticado')
    expect(await codigo(evaluateFinanzasAgenteRequest(req({ authorization: AGENTE_TOKEN }), ctx()))).toBe('no-autenticado')
    // El token no cuadra se decide antes que el modo: sin hash, 401 aunque falte el modo.
    expect(await codigo(evaluateFinanzasAgenteRequest(req(auth), ctx({ ...ACTIVA, FINANZAS_AGENTE_TOKEN_SHA256: '' })))).toBe('no-autenticado')
    expect(await codigo(evaluateFinanzasAgenteRequest(req(auth), ctx({ ...ACTIVA, FINANZAS_AGENTE_MODE: '' })))).toBe('escritura-deshabilitada')
    expect(await codigo(evaluateFinanzasAgenteRequest(req({ ...auth, 'content-type': 'text/plain' }), ctx()))).toBe('tipo-contenido')
    expect(await codigo(evaluateFinanzasAgenteRequest(req({ ...auth, 'content-length': '999999' }), ctx()))).toBe('payload-demasiado-grande')
    const limiter = new RateLimiter(3, 60_000)
    for (let i = 0; i < 3; i++) await evaluateFinanzasAgenteRequest(req(auth), ctx(ACTIVA, limiter))
    expect(await codigo(evaluateFinanzasAgenteRequest(req(auth), ctx(ACTIVA, limiter)))).toBe('demasiadas-solicitudes')
    expect(await codigo(evaluateFinanzasAgenteRequest(req(auth, '{no'), ctx()))).toBe('json-invalido')
    expect(await evaluateFinanzasAgenteRequest(req(auth, '{"a":1}'), ctx())).toEqual({ actor: 'agente-finanzas', body: { a: 1 } })
  })

  it('el token del agente da 401 en las rutas del propietario y del PM', async () => {
    const owner = new Request(`${ORIGIN}/api/finanzas/movimientos`, { method: 'POST', body: '{}', headers: { ...auth, origin: ORIGIN, 'content-type': 'application/json', 'x-project-os-csrf': '1' } })
    expect(await codigo(evaluateFinanzasWriteRequest(owner, { email: DUENO, env: env({ ...ACTIVA, FINANZAS_WRITE_MODE: 'sheets', FINANZAS_WRITER_EMAIL: DUENO }), limiter: new RateLimiter() }))).toBe('no-autenticado')
    const pm = new Request(`${ORIGIN}/api/operaciones/tareas`, { method: 'POST', body: '{}', headers: { ...auth, 'content-type': 'application/json' } })
    expect(await codigo(evaluateWriteRequest(pm, { email: null, env: env({ ...ACTIVA, PROJECT_OS_WRITE_MODE: 'sheets' }), limiter: new RateLimiter(), operation: 'tarea.crear', agentLimiter: new RateLimiter() }))).toBe('no-autenticado')
  })

  it('AGENT_OPERATIONS sin cambios y sin operaciones de finanzas', () => {
    expect(AGENT_OPERATIONS).toEqual(['tarea.crear', 'tarea.editar', 'decision.crear', 'orden.crear', 'orden.aprobar'])
    for (const op of [...FINANZAS_AGENTE_OPERATIONS, ...FINANZAS_OPERATIONS]) expect((AGENT_OPERATIONS as readonly string[]).includes(op)).toBe(false)
  })
})

/* ---------------------- §9 criterio 4: rendimiento, cargo extra y §5 ---------------------- */

describe('cortes e IDs (§3)', () => {
  it('Q1 = 1 a 15; Q2 = 16 al último día; ID derivado solo del corte', () => {
    expect(parseCorte('2027-02-Q2')).toEqual({ id: '2027-02-Q2', mes: '2027-02', quincena: 2, inicio: '2027-02-16', fin: '2027-02-28' })
    expect(parseCorte('2028-02-Q2')!.fin).toBe('2028-02-29')
    expect(parseCorte('2027-01-Q1')!.fin).toBe('2027-01-15')
    for (const malo of ['2027-13-Q1', '2027-01-Q3', '2027-1-Q1', '2027-01', 7]) expect(parseCorte(malo)).toBeNull()
  })

  it('corte abierto: corte-no-cerrado; más viejo que el mes anterior: corte-fuera-de-plazo', async () => {
    const s = new InMemoryFinanzasStore(FINANZAS, libro())
    expect(await codigo(svc(s, dia('2027-01-15')).registrarRendimiento(parseRendimiento(rend('2027-01-Q1', '10'))))).toBe('corte-no-cerrado')
    expect(await codigo(svc(s, dia('2027-01-31')).registrarRendimiento(parseRendimiento(rend('2027-01-Q2', '10'))))).toBe('corte-no-cerrado')
    expect(await codigo(svc(s, dia('2027-03-01')).registrarRendimiento(parseRendimiento(rend('2027-01-Q2', '10'))))).toBe('corte-fuera-de-plazo')
    expect(await svc(s, dia('2027-03-01')).registrarRendimiento(parseRendimiento(rend('2027-02-Q1', '10')))).toMatchObject({ id: 'REND-CLAUDE-2027-02-Q1' })
    expect(await svc(s, dia('2027-01-16')).registrarRendimiento(parseRendimiento(rend('2027-01-Q1', '10')))).toMatchObject({ id: 'REND-CLAUDE-2027-01-Q1' })
  })
})

describe('rendimiento (§4.2)', () => {
  it('una fila en RENDIMIENTO_CLAUDE; MOVIMIENTOS no cambia; vacío = sin dato', async () => {
    const s = new InMemoryFinanzasStore(FINANZAS, libro())
    const r = await svc(s, dia('2027-01-16')).registrarRendimiento(parseRendimiento(rend('2027-01-Q1', '300', { tokensEntrada: '', tokensSalida: null })))
    expect(r).toEqual({ operacion: 'finanzas.agente.rendimiento', id: 'REND-CLAUDE-2027-01-Q1', repetida: false })
    expect(filas(s, 'RENDIMIENTO_CLAUDE')).toEqual([['REND-CLAUDE-2027-01-Q1', '2027-01-01', '2027-01-15', 300, 12, 1, '', '', REPORTE, '2027-01-16']])
    expect(filas(s, 'MOVIMIENTOS')).toEqual(libro().MOVIMIENTOS.slice(1))
  })

  it('idempotencia: repetida, roll-forward, conflicto-idempotencia y corte-ya-registrado', async () => {
    const s = new InMemoryFinanzasStore(FINANZAS, libro())
    const body = rend('2027-01-Q1', '300')
    const falla = new Espia(s, 'RENDIMIENTO_CLAUDE')
    expect(await codigo(svc(falla, dia('2027-01-16')).registrarRendimiento(parseRendimiento(body)))).toBe('escritura-fallida')
    expect(filas(s, 'RENDIMIENTO_CLAUDE')).toEqual([])
    // Roll-forward: la auditoría quedó; el reintento completa la fila con lo auditado.
    expect(await svc(s, dia('2027-01-17')).registrarRendimiento(parseRendimiento(body))).toMatchObject({ repetida: true })
    expect(filas(s, 'RENDIMIENTO_CLAUDE')).toHaveLength(1)
    expect(filas(s, 'RENDIMIENTO_CLAUDE')[0]![9]).toBe('2027-01-16')
    const espia = new Espia(s)
    expect(await svc(espia, dia('2027-01-17')).registrarRendimiento(parseRendimiento(body))).toMatchObject({ repetida: true })
    expect(espia.appends).toEqual([])
    expect(await codigo(svc(s, dia('2027-01-17')).registrarRendimiento(parseRendimiento({ ...body, costoEquivUsd: '301' })))).toBe('conflicto-idempotencia')
    expect(await codigo(svc(s, dia('2027-01-17')).registrarRendimiento(parseRendimiento(rend('2027-01-Q1', '300'))))).toBe('corte-ya-registrado')
    expect(filas(s, 'RENDIMIENTO_CLAUDE')).toHaveLength(1)
  })

  it('tope de 3,000 USD por fila y validación del cuerpo', async () => {
    const s = new InMemoryFinanzasStore(FINANZAS, libro())
    expect(await svc(s, dia('2027-01-16')).registrarRendimiento(parseRendimiento(rend('2027-01-Q1', '3000.00')))).toMatchObject({ repetida: false })
    expect(await codigo(() => parseRendimiento(rend('2027-01-Q2', '3000.01')))).toBe('monto-excede-tope')
    for (const over of [{ corte: '2027-01' }, { reporte: 'sesion-x' }, { costoEquivUsd: '-1' }, { costoEquivUsd: '1.234' }, { sesiones: -1 }, { sesiones: 1.5 }, { sesionesSinDato: undefined }, { tokensEntrada: 'mil' }, { requestId: 'x' }]) {
      expect(await codigo(() => parseRendimiento(rend('2027-01-Q2', '1', over))), JSON.stringify(over)).toBe('validacion')
    }
  })

  it('sin la pestaña RENDIMIENTO_CLAUDE: 400 y nada escrito', async () => {
    const { RENDIMIENTO_CLAUDE: _r, ...sin } = libro()
    void _r
    const s = new Espia(new InMemoryFinanzasStore(FINANZAS, sin))
    expect(await codigo(svc(s, dia('2027-01-16')).registrarRendimiento(parseRendimiento(rend('2027-01-Q1', '1'))))).toBe('finanzas-esquema-invalido')
    expect(s.appends).toEqual([])
  })
})

describe('cargo extra y la regla de §5 con los dos meses de ejemplo', () => {
  /** Registra el mes completo (rendimiento y cargo de Q1 y Q2) y devuelve el libro. */
  async function mes(mesId: string, siguiente: string, recFecha: string | null, totales: [string, string], costos: [string, string]) {
    const s = new InMemoryFinanzasStore(FINANZAS, libro({ MOVIMIENTOS: [...libro().MOVIMIENTOS, ...(recFecha ? [recClaude(mesId, recFecha)] : [])] }))
    const q1 = dia(`${mesId}-16`)
    const q2 = dia(`${siguiente}-01`)
    const r = [
      await svc(s, q1).registrarCargoExtra(parseCargoExtra(cargo(`${mesId}-Q1`, totales[0], `${mesId}-16`))),
      await svc(s, q2).registrarCargoExtra(parseCargoExtra(cargo(`${mesId}-Q2`, totales[1], `${siguiente}-01`))),
    ]
    await svc(s, q1).registrarRendimiento(parseRendimiento(rend(`${mesId}-Q1`, costos[0])))
    await svc(s, q2).registrarRendimiento(parseRendimiento(rend(`${mesId}-Q2`, costos[1])))
    return { s, r }
  }
  const usd = (s: InMemoryFinanzasStore, prefijo: string) => filas(s, 'MOVIMIENTOS').filter((f) => String(col(f, 'MOV_ID')).startsWith(prefijo)).reduce((t, f) => t + Number(col(f, 'MONTO_ORIG')), 0)

  it('mes sin cargo extra (2027-01): dos cierres «sin cargo», gasto de Claude = 50.00 USD', async () => {
    const { s, r } = await mes('2027-01', '2027-02', '2027-01-10', ['50.00', '0.00'], ['300.00', '280.00'])
    expect(r.map((x) => [x.id, x.sinCargo])).toEqual([['CLAUDE-EXTRA-2027-01-Q1', true], ['CLAUDE-EXTRA-2027-01-Q2', true]])
    expect(usd(s, 'CLAUDE-EXTRA-')).toBe(0)
    expect(usd(s, 'REC-CLAUDE-') + usd(s, 'CLAUDE-EXTRA-')).toBe(50)
    expect(filas(s, 'RENDIMIENTO_CLAUDE').map((f) => [f[0], f[3]])).toEqual([['REND-CLAUDE-2027-01-Q1', 300], ['REND-CLAUDE-2027-01-Q2', 280]])
    // Comprobación mensual: suma de T − REC del mes = suma de extras.
    expect(50 + 0 - usd(s, 'REC-CLAUDE-')).toBe(usd(s, 'CLAUDE-EXTRA-'))
  })

  it('mes con cargo extra (2027-02): CLAUDE-EXTRA-2027-02-Q2 de 20.00 USD, gasto = 70.00 USD', async () => {
    const { s, r } = await mes('2027-02', '2027-03', '2027-02-10', ['50.00', '20.00'], ['310.00', '450.00'])
    expect(r.map((x) => [x.id, x.sinCargo])).toEqual([['CLAUDE-EXTRA-2027-02-Q1', true], ['CLAUDE-EXTRA-2027-02-Q2', false]])
    const fila = filas(s, 'MOVIMIENTOS').find((f) => col(f, 'MOV_ID') === 'CLAUDE-EXTRA-2027-02-Q2')!
    expect(Object.fromEntries(ENC_MOV.map((c) => [c, col(fila, c) ?? '']))).toEqual({
      MOV_ID: 'CLAUDE-EXTRA-2027-02-Q2', FECHA: '2027-02-28', PROYECTO: 'POS', TIPO: 'Gasto', CATEGORIA: 'Herramientas',
      CONCEPTO: 'Claude: cargo adicional 2027-02-Q2', PRODUCTO_ID: '', MONTO_MXN: 370, MONEDA_ORIG: 'USD', MONTO_ORIG: 20,
      TIPO_CAMBIO: 18.5, IVA_MXN: '', FUENTE: 'agente-finanzas', COMPROBANTE: 'sí', AJUSTE_DE: '',
    })
    expect(usd(s, 'REC-CLAUDE-') + usd(s, 'CLAUDE-EXTRA-')).toBe(70)
    expect(50 + 20 - usd(s, 'REC-CLAUDE-')).toBe(usd(s, 'CLAUDE-EXTRA-'))
    // La vista acepta la fila y la suma una vez; el rendimiento no suma.
    const l = leerMovimientos(s.snapshot().MOVIMIENTOS)
    if (l.estado !== 'ok') throw new Error('lectura')
    expect(l.problemas).toEqual([])
    expect(gastoClaudeMensual(l.movimientos)).toEqual([{ mes: '2027-02', gasto: { ECO: 0, POS: 92500 + 37000 } }])
  })

  it('variante: suscripción y extra en la misma factura de Q1 (70.00) da el mismo mes', async () => {
    const { s } = await mes('2027-02', '2027-03', '2027-02-10', ['70.00', '0.00'], ['310.00', '450.00'])
    expect(filas(s, 'MOVIMIENTOS').filter((f) => String(col(f, 'MOV_ID')).startsWith('CLAUDE-EXTRA-')).map((f) => [col(f, 'MOV_ID'), col(f, 'MONTO_ORIG')])).toEqual([['CLAUDE-EXTRA-2027-02-Q1', 20]])
    expect(usd(s, 'REC-CLAUDE-') + usd(s, 'CLAUDE-EXTRA-')).toBe(70)
  })

  it('criterio 2: una sola ancla. Con el REC fechado en el otro corte, la suscripción no se registra como extra', async () => {
    // DIA_COBRO = 10 (Q1), pero el propietario confirmó REC-CLAUDE-2027-02 con FECHA 2027-02-20 (Q2).
    const { s, r } = await mes('2027-02', '2027-03', '2027-02-20', ['0.00', '50.00'], ['1', '1'])
    expect(r.map((x) => x.sinCargo)).toEqual([true, true])
    expect(usd(s, 'CLAUDE-EXTRA-')).toBe(0)
    expect(usd(s, 'REC-CLAUDE-') + usd(s, 'CLAUDE-EXTRA-')).toBe(50)
    // Con DIA_COBRO como ancla, Q2 habría dado 50.00 de extra (doble conteo) y Q1 habría restado 50 de un total de 0.
  })

  it('sin REC-CLAUDE del mes y con DIA_COBRO en el corte: suscripcion-sin-confirmar; fuera del corte, S = 0', async () => {
    const s = new Espia(new InMemoryFinanzasStore(FINANZAS, libro()))
    expect(await codigo(svc(s, dia('2027-02-16')).registrarCargoExtra(parseCargoExtra(cargo('2027-02-Q1', '50.00', '2027-02-16'))))).toBe('suscripcion-sin-confirmar')
    expect(s.appends).toEqual([])
    // Q2 no contiene DIA_COBRO = 10: sin REC, S = 0 y todo el total es extra.
    expect(await svc(s, dia('2027-03-01')).registrarCargoExtra(parseCargoExtra(cargo('2027-02-Q2', '20.00', '2027-03-01')))).toMatchObject({ sinCargo: false })
  })

  it('recurrente CLAUDE con problema: no se descarta, suscripcion-sin-confirmar', async () => {
    const s = new InMemoryFinanzasStore(FINANZAS, libro({ RECURRENTES: [ENC_REC, ['CLAUDE', 'Suscripción Claude', 'POS', 'Herramientas', 50, 'USD', 40, '2026-01', '']] }))
    expect(await codigo(svc(s, dia('2027-03-01')).registrarCargoExtra(parseCargoExtra(cargo('2027-02-Q2', '20.00', '2027-03-01'))))).toBe('suscripcion-sin-confirmar')
  })

  it('T − S < 0: factura-no-cuadra; REC en MXN o duplicado: factura-no-cuadra, sin escribir', async () => {
    const base = libro().MOVIMIENTOS
    for (const movs of [
      [...base, recClaude('2027-02', '2027-02-10')],
      [...base, mov({ ...Object.fromEntries(ENC_MOV.map((c, i) => [c, recClaude('2027-02', '2027-02-10')[i]!])), MONEDA_ORIG: 'MXN', MONTO_ORIG: '', TIPO_CAMBIO: '' })],
      [...base, recClaude('2027-02', '2027-02-10'), recClaude('2027-02', '2027-02-11')],
    ]) {
      const s = new Espia(new InMemoryFinanzasStore(FINANZAS, libro({ MOVIMIENTOS: movs })))
      expect(await codigo(svc(s, dia('2027-02-16')).registrarCargoExtra(parseCargoExtra(cargo('2027-02-Q1', '30.00', '2027-02-16'))))).toBe('factura-no-cuadra')
      expect(s.appends).toEqual([])
    }
  })

  it('tope de 3,000 USD sobre el extra; sin tipo de cambio ni TIPO_CAMBIO_DEFECTO: validación', async () => {
    const s = new InMemoryFinanzasStore(FINANZAS, libro())
    expect(await codigo(svc(s, dia('2027-03-01')).registrarCargoExtra(parseCargoExtra(cargo('2027-02-Q2', '3000.01', '2027-03-01'))))).toBe('monto-excede-tope')
    expect(await svc(s, dia('2027-03-01')).registrarCargoExtra(parseCargoExtra(cargo('2027-02-Q2', '3000.00', '2027-03-01', { tipoCambio: '17.25' })))).toMatchObject({ sinCargo: false })
    expect(filas(s, 'MOVIMIENTOS').at(-1)!.slice(7, 11)).toEqual([51750, 'USD', 3000, 17.25])
    const sinTc = new InMemoryFinanzasStore(FINANZAS, libro({ PARAMETROS: [['PARAMETRO', 'VALOR']] }))
    expect(await codigo(svc(sinTc, dia('2027-03-01')).registrarCargoExtra(parseCargoExtra(cargo('2027-02-Q2', '20', '2027-03-01'))))).toBe('validacion')
  })

  it('idempotencia del cargo: repetida, roll-forward, conflicto y corte-ya-registrado', async () => {
    const s = new InMemoryFinanzasStore(FINANZAS, libro())
    const body = cargo('2027-02-Q2', '20.00', '2027-03-01')
    expect(await codigo(svc(new Espia(s, 'MOVIMIENTOS'), dia('2027-03-01')).registrarCargoExtra(parseCargoExtra(body)))).toBe('escritura-fallida')
    expect(await svc(s, dia('2027-03-02')).registrarCargoExtra(parseCargoExtra(body))).toEqual({ operacion: 'finanzas.agente.cargo-extra', id: 'CLAUDE-EXTRA-2027-02-Q2', repetida: true, sinCargo: false })
    expect(filas(s, 'MOVIMIENTOS').filter((f) => col(f, 'MOV_ID') === 'CLAUDE-EXTRA-2027-02-Q2')).toHaveLength(1)
    expect(await svc(s, dia('2027-03-02')).registrarCargoExtra(parseCargoExtra(body))).toMatchObject({ repetida: true })
    expect(await codigo(svc(s, dia('2027-03-01')).registrarCargoExtra(parseCargoExtra({ ...body, proyecto: 'ECO' })))).toBe('conflicto-idempotencia')
    expect(await codigo(svc(s, dia('2027-03-01')).registrarCargoExtra(parseCargoExtra(cargo('2027-02-Q2', '20.00', '2027-03-01'))))).toBe('corte-ya-registrado')
  })

  it('la fecha de la fuente es la de hoy con 1 día de margen', async () => {
    const s = new InMemoryFinanzasStore(FINANZAS, libro())
    expect(await codigo(svc(s, dia('2027-03-03')).registrarCargoExtra(parseCargoExtra(cargo('2027-02-Q2', '20', '2027-03-01'))))).toBe('validacion')
    expect(await svc(s, dia('2027-03-02')).registrarCargoExtra(parseCargoExtra(cargo('2027-02-Q2', '20', '2027-03-01')))).toMatchObject({ repetida: false })
  })
})

describe('criterio 3: cierre «sin cargo»', () => {
  it('una sola fila de AUDITORIA, sin MOVIMIENTOS; la verificación relee AUDITORIA, no MOVIMIENTOS', async () => {
    const s = new InMemoryFinanzasStore(FINANZAS, libro({ MOVIMIENTOS: [...libro().MOVIMIENTOS, recClaude('2027-02', '2027-02-10')] }))
    const espia = new Espia(s)
    const body = cargo('2027-02-Q1', '50.00', '2027-02-16')
    expect(await svc(espia, dia('2027-02-16')).registrarCargoExtra(parseCargoExtra(body))).toEqual({ operacion: 'finanzas.agente.cargo-extra', id: 'CLAUDE-EXTRA-2027-02-Q1', repetida: false, sinCargo: true })
    expect(espia.appends).toEqual(['AUDITORIA'])
    expect(espia.reads.at(-1)).toEqual(['AUDITORIA'])
    expect(espia.reads.flat().filter((t) => t === 'MOVIMIENTOS')).toHaveLength(1) // solo la lectura inicial
    const aud = filas(s, 'AUDITORIA')
    expect(aud).toHaveLength(1)
    expect(aud[0]!.slice(2, 8)).toEqual(['agente-finanzas', 'MOVIMIENTOS', 'CLAUDE-EXTRA-2027-02-Q1', 'ESTADO', '', 'sin-cargo'])
    expect(String(aud[0]![0])).toMatch(/-01-01$/)
    expect(leerOrigenAgente(String(aud[0]![8]))).toMatchObject({ requestId: body.requestId, reporte: REPORTE, fuente: body.fuente })
    expect(filas(s, 'MOVIMIENTOS')).toHaveLength(2)
  })

  it('su repetición: repetida sin roll-forward (cero escrituras); otro requestId: corte-ya-registrado; otro cuerpo: conflicto', async () => {
    const s = new InMemoryFinanzasStore(FINANZAS, libro({ MOVIMIENTOS: [...libro().MOVIMIENTOS, recClaude('2027-02', '2027-02-10')] }))
    const body = cargo('2027-02-Q1', '50.00', '2027-02-16')
    await svc(s, dia('2027-02-16')).registrarCargoExtra(parseCargoExtra(body))
    const espia = new Espia(s)
    expect(await svc(espia, dia('2027-02-17')).registrarCargoExtra(parseCargoExtra(body))).toEqual({ operacion: 'finanzas.agente.cargo-extra', id: 'CLAUDE-EXTRA-2027-02-Q1', repetida: true, sinCargo: true })
    expect(espia.appends).toEqual([])
    expect(await codigo(svc(s, dia('2027-02-16')).registrarCargoExtra(parseCargoExtra(cargo('2027-02-Q1', '70.00', '2027-02-16'))))).toBe('corte-ya-registrado')
    expect(await codigo(svc(s, dia('2027-02-16')).registrarCargoExtra(parseCargoExtra({ ...body, facturaTotalUsd: '70.00', fuente: fuente('2027-02-Q1', 'total 70.00 USD', '2027-02-16') })))).toBe('conflicto-idempotencia')
    expect(filas(s, 'AUDITORIA')).toHaveLength(1)
  })

  it('si la AUDITORIA descarta la fila: verificacion-fallida (no se da por cerrado)', async () => {
    const s = new InMemoryFinanzasStore(FINANZAS, libro({ MOVIMIENTOS: [...libro().MOVIMIENTOS, recClaude('2027-02', '2027-02-10')] }))
    expect(await codigo(svc(new Espia(s, 'AUDITORIA', 'descarta'), dia('2027-02-16')).registrarCargoExtra(parseCargoExtra(cargo('2027-02-Q1', '50', '2027-02-16'))))).toBe('verificacion-fallida')
  })
})

/* ------------------------- §9 criterio 5: auditoría y verificación ------------------------- */

describe('auditoría de §6 antes de la fila y verificación después', () => {
  it('orden AUDITORIA → fila; una fila por campo, ACTOR agente-finanzas, ORIGEN con reporte y fuente', async () => {
    const s = new InMemoryFinanzasStore(FINANZAS, libro())
    const espia = new Espia(s)
    const body = cargo('2027-02-Q2', '20.00', '2027-03-01')
    await svc(espia, dia('2027-03-01')).registrarCargoExtra(parseCargoExtra(body))
    expect(espia.appends).toEqual(['AUDITORIA', 'MOVIMIENTOS'])
    expect(espia.reads.at(-1)).toEqual(['MOVIMIENTOS'])
    const aud = filas(s, 'AUDITORIA')
    expect(aud).toHaveLength(12) // los 15 campos menos PRODUCTO_ID, IVA_MXN y AJUSTE_DE, vacíos
    for (const f of aud) {
      expect(f.slice(2, 5)).toEqual(['agente-finanzas', 'MOVIMIENTOS', 'CLAUDE-EXTRA-2027-02-Q2'])
      expect(String(f[8])).toMatch(new RegExp(`^agente-finanzas;modo=sheets;req=${body.requestId};hash=[0-9a-f]{16};reporte=${REPORTE};moneda=USD;fuente=`))
    }
    const [op] = auditoriaAgente(tabla(s.snapshot().AUDITORIA!, COLUMNAS_AUDITORIA, 'AUDITORIA'))
    expect(op).toMatchObject({ requestId: body.requestId, integridad: 'completa', sinCargo: false, fuente: body.fuente, id: 'CLAUDE-EXTRA-2027-02-Q2' })
    const r = await svc(new InMemoryFinanzasStore(FINANZAS, libro()), dia('2027-01-16')).registrarRendimiento(parseRendimiento(rend('2027-01-Q1', '1')))
    expect(r.id).toBe('REND-CLAUDE-2027-01-Q1')
  })

  it('falla la AUDITORIA: auditoria-fallida y ninguna fila', async () => {
    const s = new InMemoryFinanzasStore(FINANZAS, libro())
    const espia = new Espia(s, 'AUDITORIA')
    expect(await codigo(svc(espia, dia('2027-03-01')).registrarCargoExtra(parseCargoExtra(cargo('2027-02-Q2', '20', '2027-03-01'))))).toBe('auditoria-fallida')
    expect(espia.appends).toEqual(['AUDITORIA'])
    expect(filas(s, 'MOVIMIENTOS')).toHaveLength(1)
    expect(await codigo(svc(new Espia(s, 'AUDITORIA'), dia('2027-01-16')).registrarRendimiento(parseRendimiento(rend('2027-01-Q1', '1'))))).toBe('auditoria-fallida')
    expect(filas(s, 'RENDIMIENTO_CLAUDE')).toEqual([])
  })

  it('la fila no aparece al releer: verificacion-fallida, en las dos rutas', async () => {
    const s = new InMemoryFinanzasStore(FINANZAS, libro())
    expect(await codigo(svc(new Espia(s, 'MOVIMIENTOS', 'descarta'), dia('2027-03-01')).registrarCargoExtra(parseCargoExtra(cargo('2027-02-Q2', '20', '2027-03-01'))))).toBe('verificacion-fallida')
    expect(await codigo(svc(new Espia(s, 'RENDIMIENTO_CLAUDE', 'descarta'), dia('2027-01-16')).registrarRendimiento(parseRendimiento(rend('2027-01-Q1', '1'))))).toBe('verificacion-fallida')
  })

  it('la fila cambió a mano: estado-divergente al repetir; auditoría parcial: auditoria-inconsistente', async () => {
    const s = new InMemoryFinanzasStore(FINANZAS, libro())
    const body = cargo('2027-02-Q2', '20', '2027-03-01')
    await svc(s, dia('2027-03-01')).registrarCargoExtra(parseCargoExtra(body))
    const datos = s.snapshot()
    datos.MOVIMIENTOS!.at(-1)![ENC_MOV.indexOf('MONTO_ORIG')] = 25
    expect(await codigo(svc(new InMemoryFinanzasStore(FINANZAS, datos), dia('2027-03-01')).registrarCargoExtra(parseCargoExtra(body)))).toBe('estado-divergente')
    const parcial = s.snapshot()
    parcial.AUDITORIA!.splice(2, 1)
    parcial.MOVIMIENTOS!.pop()
    expect(await codigo(svc(new InMemoryFinanzasStore(FINANZAS, parcial), dia('2027-03-01')).registrarCargoExtra(parseCargoExtra(body)))).toBe('auditoria-inconsistente')
  })

  it('no se puede leer el libro: lectura-fallida', async () => {
    const roto: FinanzasStore = { libro: FINANZAS, tabs: async () => { throw new Error('HTTP 500') }, read: async () => ({}), append: async () => { throw new Error('no') } }
    expect(await codigo(svc(roto, dia('2027-03-01')).registrarCargoExtra(parseCargoExtra(cargo('2027-02-Q2', '20', '2027-03-01'))))).toBe('lectura-fallida')
  })

  it('la escritura del propietario no lee las filas del agente como suyas', async () => {
    const { FinanzasWriteService } = await import('@/lib/finanzas/escritura-service')
    const s = new InMemoryFinanzasStore(FINANZAS, libro())
    await svc(s, dia('2027-03-01')).registrarCargoExtra(parseCargoExtra(cargo('2027-02-Q2', '20', '2027-03-01')))
    const owner = new FinanzasWriteService(s, { clock: () => dia('2027-03-01'), randomHex: () => 'abcd1234' })
    const { parseMovimiento } = await import('@/lib/finanzas/escritura-validacion')
    const r = await owner.crearMovimiento(parseMovimiento({ requestId: rid(), fecha: '2027-03-01', proyecto: 'ECO', tipo: 'Gasto', categoria: 'Producto', concepto: 'Muestras', montoMxn: '10', comprobante: 'no' }), { actor: DUENO })
    expect(r.id).toBe('MAN-0002')
  })
})

/* ----------------------- criterio 4 de la orden: ORIGEN y fuente ----------------------- */

describe('criterio 4: analizador propio del ORIGEN; la fuente no altera req ni hash', () => {
  const REQ = '00000000-0000-4000-8000-000000000999'
  const OTRO = '11111111-1111-4111-8111-111111111111'

  it.each([
    'total 20 USD;req=11111111-1111-4111-8111-111111111111;hash=0000000000000000',
    'total=20;hash=ffffffffffffffff',
    'cien % 20 USD %3B ya codificado',
    'sin nada raro 20 USD',
  ])('fuente «%s»: ida y vuelta exacta, req y hash intactos', (cita) => {
    const f = fuente('2027-02-Q2', cita, '2027-03-01')
    const origen = origenAgente(REQ, 'abcdef0123456789', REPORTE, f)
    expect(origen.slice(origen.indexOf(';fuente=') + 8)).not.toMatch(/[;=]/)
    expect(leerOrigenAgente(origen)).toEqual({ requestId: REQ, hash: 'abcdef0123456789', reporte: REPORTE, moneda: null, fuente: f })
    expect(codificarFuente(f)).not.toContain(';')
  })

  it('una fuente con «;req=<otro>» no hace que otra solicitud parezca repetida', async () => {
    const s = new InMemoryFinanzasStore(FINANZAS, libro())
    const body = cargo('2027-02-Q2', '20', '2027-03-01', { fuente: fuente('2027-02-Q2', `20 USD;req=${OTRO};hash=abcdefabcdefabcd`, '2027-03-01') })
    await svc(s, dia('2027-03-01')).registrarCargoExtra(parseCargoExtra(body))
    const ops = auditoriaAgente(tabla(s.snapshot().AUDITORIA!, COLUMNAS_AUDITORIA, 'AUDITORIA'))
    expect(ops.map((o) => o.requestId)).toEqual([body.requestId])
    expect(await codigo(svc(s, dia('2027-03-01')).registrarCargoExtra(parseCargoExtra({ ...body, requestId: OTRO })))).toBe('corte-ya-registrado')
  })

  it('ORIGEN del propietario u otros textos no se leen como del agente', () => {
    expect(leerOrigenAgente(`dashboard-finanzas;modo=sheets;op=finanzas.movimiento.crear;req=${REQ};hash=abcdef0123456789`)).toBeNull()
    expect(leerOrigenAgente(`agente-finanzas;modo=sheets;req=${REQ};hash=abcdef0123456789;reporte=${REPORTE};fuente=a;b`)).toBeNull()
    expect(leerOrigenAgente(`agente-finanzas;modo=sheets;req=${REQ};hash=abcdef0123456789;reporte=${REPORTE};fuente=%E0%A4%A`)).toBeNull()
  })

  it('fuente: formato, corte, total en la cita y nada de datos de factura', () => {
    const ok = parseCargoExtra(cargo('2027-02-Q2', '1234.50', '2027-03-01', { fuente: fuente('2027-02-Q2', 'Anthropic: 1,234.50 USD', '2027-03-01') }))
    expect(ok.facturaTotalCentavos).toBe(123450)
    const malas = [
      'sin comillas 20 USD 2027-03-01',
      fuente('2027-02-Q1', '20 USD', '2027-03-01'),
      fuente('2027-02-Q2', 'me cobraron 25 USD', '2027-03-01'),
      fuente('2027-02-Q2', '20 USD, factura INV-0001', '2027-03-01'),
      fuente('2027-02-Q2', '20 USD folio #123', '2027-03-01'),
      fuente('2027-02-Q2', '20 USD a dueno@example.com', '2027-03-01'),
      fuente('2027-02-Q2', '20 USD https://example.com', '2027-03-01'),
      fuente('2027-02-Q2', `20 USD ${'x'.repeat(200)}`, '2027-03-01'),
    ]
    for (const f of malas) expect(() => parseCargoExtra(cargo('2027-02-Q2', '20', '2027-03-01', { fuente: f })), f).toThrow(OperationError)
    expect(fuenteProhibida('total del corte 20 USD')).toBe(false)
    for (const over of [{ facturaTotalUsd: undefined }, { facturaTotalUsd: '-1' }, { proyecto: undefined }, { proyecto: 'RADAROS' }, { tipoCambio: '0' }]) {
      expect(() => parseCargoExtra(cargo('2027-02-Q2', '20', '2027-03-01', over)), JSON.stringify(over)).toThrow(OperationError)
    }
  })
})

/* ------------------------- ORD-POS-133: cargo extra con suscripción en MXN ------------------------- */

describe('ORD-POS-133: cargo extra en la moneda de REC-CLAUDE (MXN), sin convertir T ni S', () => {
  /** `REC-CLAUDE-AAAA-MM` confirmado en MXN como lo deja «Recurrentes del mes»: MONTO_ORIG y TIPO_CAMBIO vacíos. */
  const recMxn = (mes: string, fecha: string, mxn = 900) => mov({
    MOV_ID: `REC-CLAUDE-${mes}`, FECHA: fecha, PROYECTO: 'POS', TIPO: 'Gasto', CATEGORIA: 'Herramientas', CONCEPTO: 'Suscripción Claude',
    MONTO_MXN: mxn, MONEDA_ORIG: 'MXN', FUENTE: 'recurrente', COMPROBANTE: 'sí',
  })
  /** Recurrente CLAUDE de 900.00 MXN con DIA_COBRO = 10 (cifras sintéticas). */
  const REC_MXN = [ENC_REC, ['CLAUDE', 'Suscripción Claude', 'POS', 'Herramientas', 900, 'MXN', 10, '2026-01', '']]
  const libroMxn = (movs: Celda[][] = [], over: Partial<Record<string, unknown[][]>> = {}) => libro({ MOVIMIENTOS: [...libro().MOVIMIENTOS, ...movs], RECURRENTES: REC_MXN, ...over })
  const cargoMxn = (corte: string, total: string, fecha: string, over: Record<string, unknown> = {}) => ({
    requestId: rid(), corte, reporte: REPORTE, moneda: 'MXN', facturaTotal: total, fuente: fuente(corte, `total de Anthropic ${total} MXN`, fecha), proyecto: 'POS', ...over,
  })
  const extras = (s: InMemoryFinanzasStore) => filas(s, 'MOVIMIENTOS').filter((f) => String(col(f, 'MOV_ID')).startsWith('CLAUDE-EXTRA-'))
  async function detalle(p: Promise<unknown>) {
    const e = await p.catch((x: unknown) => x)
    expect(e).toBeInstanceOf(OperationError)
    return { codigo: (e as OperationError).code, motivo: (e as OperationError).detail?.motivo }
  }

  it('criterio 1: moneda opcional (USD por defecto); facturaTotalUsd = facturaTotal en USD, mismo comando y mismo hash', async () => {
    const base = { requestId: rid(), corte: '2027-02-Q2', reporte: REPORTE, proyecto: 'POS', fuente: fuente('2027-02-Q2', 'total 20.00 USD', '2027-03-01') }
    const viejo = parseCargoExtra({ ...base, facturaTotalUsd: '20.00' })
    const nuevo = parseCargoExtra({ ...base, facturaTotal: '20.00', moneda: 'USD' })
    expect(viejo).toEqual(nuevo)
    expect(nuevo).toMatchObject({ moneda: 'USD', facturaTotalCentavos: 2000 })
    expect(parseCargoExtra({ ...base, facturaTotal: '20.00' }).moneda).toBe('USD')
    expect(parseCargoExtra(cargoMxn('2027-02-Q2', '360.00', '2027-03-01', { moneda: 'mxn' }))).toMatchObject({ moneda: 'MXN', facturaTotalCentavos: 36000, tipoCambioDiezmil: null })
    // Con el mismo requestId, el cuerpo viejo y el nuevo son la misma solicitud; el MXN, otra (el hash lleva la moneda).
    const s = new InMemoryFinanzasStore(FINANZAS, libro())
    await svc(s, dia('2027-03-01')).registrarCargoExtra(viejo)
    expect(await svc(s, dia('2027-03-01')).registrarCargoExtra(nuevo)).toMatchObject({ repetida: true })
    expect(await codigo(svc(s, dia('2027-03-01')).registrarCargoExtra(parseCargoExtra({ ...base, facturaTotal: '20.00', moneda: 'MXN', fuente: fuente('2027-02-Q2', 'total 20.00 MXN', '2027-03-01') })))).toBe('conflicto-idempotencia')
  })

  // «400» de la orden = rechazo de validación sin escribir: `validacion` responde 422 en toda la API, como el resto de esta ruta.
  it('criterio 1: moneda inválida, los dos totales, facturaTotalUsd con MXN, tipoCambio con MXN o sin total: validacion', async () => {
    const malos: Array<[Record<string, unknown>, string]> = [
      [{ moneda: 'EUR' }, 'moneda'], [{ moneda: 7 }, 'moneda'], [{ moneda: 'US D' }, 'moneda'],
      [{ facturaTotalUsd: '360.00' }, 'facturaTotal'],
      [{ facturaTotal: undefined, facturaTotalUsd: '360.00' }, 'facturaTotalUsd'],
      [{ tipoCambio: '18.5' }, 'tipoCambio'],
      [{ facturaTotal: undefined }, 'facturaTotal'], [{ facturaTotal: '-1' }, 'facturaTotal'], [{ facturaTotal: '1.234' }, 'facturaTotal'],
    ]
    for (const [over, campo] of malos) {
      const e = (() => { try { parseCargoExtra(cargoMxn('2027-02-Q2', '360.00', '2027-03-01', over)) } catch (x) { return x } })()
      expect(e, JSON.stringify(over)).toBeInstanceOf(OperationError)
      expect((e as OperationError).code).toBe('validacion')
      expect((e as OperationError).status).toBe(422)
      expect(Object.keys((e as OperationError).fields ?? {}), JSON.stringify(over)).toContain(campo)
    }
    // El handler responde 400 sin escribir a una moneda inválida.
    const s = new Espia(new InMemoryFinanzasStore(FINANZAS, libroMxn()))
    expect(await codigo(() => svc(s, dia('2027-03-01')).registrarCargoExtra(parseCargoExtra(cargoMxn('2027-02-Q2', '360.00', '2027-03-01', { moneda: 'EUR' }))))).toBe('validacion')
    expect(s.appends).toEqual([])
  })

  it('criterio 2 y 3: mes sin cargo extra en MXN (2027-01): dos cierres «sin cargo»', async () => {
    const s = new InMemoryFinanzasStore(FINANZAS, libroMxn([recMxn('2027-01', '2027-01-10')]))
    const r = [
      await svc(s, dia('2027-01-16')).registrarCargoExtra(parseCargoExtra(cargoMxn('2027-01-Q1', '900.00', '2027-01-16'))),
      await svc(s, dia('2027-02-01')).registrarCargoExtra(parseCargoExtra(cargoMxn('2027-01-Q2', '0.00', '2027-02-01'))),
    ]
    expect(r.map((x) => [x.id, x.sinCargo])).toEqual([['CLAUDE-EXTRA-2027-01-Q1', true], ['CLAUDE-EXTRA-2027-01-Q2', true]])
    expect(extras(s)).toEqual([])
    for (const f of filas(s, 'AUDITORIA')) expect(leerOrigenAgente(String(f[8]))).toMatchObject({ moneda: 'MXN' })
  })

  it('criterio 2 y 3: mes con cargo extra en MXN (2027-02): CLAUDE-EXTRA-2027-02-Q2 con MONTO_ORIG = MONTO_MXN = 360.00 y sin TIPO_CAMBIO', async () => {
    const s = new InMemoryFinanzasStore(FINANZAS, libroMxn([recMxn('2027-02', '2027-02-10')]))
    expect(await svc(s, dia('2027-02-16')).registrarCargoExtra(parseCargoExtra(cargoMxn('2027-02-Q1', '900.00', '2027-02-16')))).toMatchObject({ sinCargo: true })
    const espia = new Espia(s)
    expect(await svc(espia, dia('2027-03-01')).registrarCargoExtra(parseCargoExtra(cargoMxn('2027-02-Q2', '360.00', '2027-03-01')))).toEqual({ operacion: 'finanzas.agente.cargo-extra', id: 'CLAUDE-EXTRA-2027-02-Q2', repetida: false, sinCargo: false })
    expect(espia.appends).toEqual(['AUDITORIA', 'MOVIMIENTOS'])
    const [fila] = extras(s)
    expect(Object.fromEntries(ENC_MOV.map((c) => [c, col(fila!, c) ?? '']))).toEqual({
      MOV_ID: 'CLAUDE-EXTRA-2027-02-Q2', FECHA: '2027-02-28', PROYECTO: 'POS', TIPO: 'Gasto', CATEGORIA: 'Herramientas',
      CONCEPTO: 'Claude: cargo adicional 2027-02-Q2', PRODUCTO_ID: '', MONTO_MXN: 360, MONEDA_ORIG: 'MXN', MONTO_ORIG: 360,
      TIPO_CAMBIO: '', IVA_MXN: '', FUENTE: 'agente-finanzas', COMPROBANTE: 'sí', AJUSTE_DE: '',
    })
    // Comprobación mensual en MXN: suma de T − REC del mes = suma de extras; la vista la acepta y la suma una vez.
    expect(900 + 360 - 900).toBe(360)
    const l = leerMovimientos(s.snapshot().MOVIMIENTOS)
    if (l.estado !== 'ok') throw new Error('lectura')
    expect(l.problemas).toEqual([])
    expect(gastoClaudeMensual(l.movimientos)).toEqual([{ mes: '2027-02', gasto: { ECO: 0, POS: 90000 + 36000 } }])
    // Repetición: repetida, sin otra fila.
    const aud = auditoriaAgente(tabla(s.snapshot().AUDITORIA!, COLUMNAS_AUDITORIA, 'AUDITORIA')).find((o) => o.id === 'CLAUDE-EXTRA-2027-02-Q2')!
    expect(aud).toMatchObject({ moneda: 'MXN', integridad: 'completa', sinCargo: false })
    expect(String(filas(s, 'AUDITORIA').at(-1)![8])).toMatch(/;reporte=session_[A-Za-z0-9]+;moneda=MXN;fuente=/)
  })

  it('variante MXN: suscripción y extra en la misma factura de Q1 (1,260.00) da el mismo mes', async () => {
    const s = new InMemoryFinanzasStore(FINANZAS, libroMxn([recMxn('2027-02', '2027-02-10')]))
    await svc(s, dia('2027-02-16')).registrarCargoExtra(parseCargoExtra(cargoMxn('2027-02-Q1', '1260.00', '2027-02-16', { fuente: fuente('2027-02-Q1', 'total de Anthropic 1,260.00 MXN', '2027-02-16') })))
    await svc(s, dia('2027-03-01')).registrarCargoExtra(parseCargoExtra(cargoMxn('2027-02-Q2', '0.00', '2027-03-01')))
    expect(extras(s).map((f) => [col(f, 'MOV_ID'), col(f, 'MONTO_ORIG'), col(f, 'MONTO_MXN'), col(f, 'MONEDA_ORIG')])).toEqual([['CLAUDE-EXTRA-2027-02-Q1', 360, 360, 'MXN']])
  })

  it('criterio 2: T y S en otra moneda: 409 factura-no-cuadra con motivo moneda-distinta, sin escribir', async () => {
    const casos: Array<[Partial<Record<string, unknown[][]>>, Record<string, unknown>, string, string]> = [
      // REC en USD y total en MXN (aunque el REC caiga en el otro corte).
      [{ MOVIMIENTOS: [...libro().MOVIMIENTOS, recClaude('2027-02', '2027-02-10')] }, cargoMxn('2027-02-Q1', '900.00', '2027-02-16'), '2027-02-16', 'Q1'],
      [{ MOVIMIENTOS: [...libro().MOVIMIENTOS, recClaude('2027-02', '2027-02-10')] }, cargoMxn('2027-02-Q2', '360.00', '2027-03-01'), '2027-03-01', 'Q2'],
      // REC en MXN y total en USD, con el cuerpo viejo o con moneda USD.
      [{ MOVIMIENTOS: [...libro().MOVIMIENTOS, recMxn('2027-02', '2027-02-10')], RECURRENTES: REC_MXN }, cargo('2027-02-Q1', '50.00', '2027-02-16'), '2027-02-16', 'Q1'],
      [{ MOVIMIENTOS: [...libro().MOVIMIENTOS, recMxn('2027-02', '2027-02-10')], RECURRENTES: REC_MXN }, cargoMxn('2027-02-Q2', '20.00', '2027-03-01', { moneda: 'USD' }), '2027-03-01', 'Q2'],
      // Sin REC del mes y fuera del DIA_COBRO: la moneda es la del recurrente CLAUDE vigente.
      [{ RECURRENTES: REC_MXN }, cargo('2027-02-Q2', '20.00', '2027-03-01'), '2027-03-01', 'Q2'],
      [{}, cargoMxn('2027-02-Q2', '360.00', '2027-03-01'), '2027-03-01', 'Q2'],
    ]
    for (const [over, body, hoy, q] of casos) {
      const s = new Espia(new InMemoryFinanzasStore(FINANZAS, libro(over)))
      expect(await detalle(svc(s, dia(hoy)).registrarCargoExtra(parseCargoExtra(body))), q).toEqual({ codigo: 'factura-no-cuadra', motivo: 'moneda-distinta' })
      expect(s.appends).toEqual([])
    }
    // Sin REC y sin recurrente CLAUDE vigente no hay moneda que exigir: S = 0 y el total es extra.
    const libre = new InMemoryFinanzasStore(FINANZAS, libro({ RECURRENTES: [ENC_REC] }))
    expect(await svc(libre, dia('2027-03-01')).registrarCargoExtra(parseCargoExtra(cargoMxn('2027-02-Q2', '360.00', '2027-03-01')))).toMatchObject({ sinCargo: false })
  })

  it('criterio 3: T − S < 0 en MXN: factura-no-cuadra; DIA_COBRO en el corte sin REC: suscripcion-sin-confirmar', async () => {
    const s = new Espia(new InMemoryFinanzasStore(FINANZAS, libroMxn([recMxn('2027-02', '2027-02-10')])))
    expect(await detalle(svc(s, dia('2027-02-16')).registrarCargoExtra(parseCargoExtra(cargoMxn('2027-02-Q1', '899.99', '2027-02-16'))))).toEqual({ codigo: 'factura-no-cuadra', motivo: undefined })
    const sinRec = new Espia(new InMemoryFinanzasStore(FINANZAS, libroMxn()))
    expect(await codigo(svc(sinRec, dia('2027-02-16')).registrarCargoExtra(parseCargoExtra(cargoMxn('2027-02-Q1', '900.00', '2027-02-16'))))).toBe('suscripcion-sin-confirmar')
    // REC en MXN sin MONTO_MXN: no se adivina S.
    const sinMonto = new Espia(new InMemoryFinanzasStore(FINANZAS, libroMxn([mov({ MOV_ID: 'REC-CLAUDE-2027-02', FECHA: '2027-02-10', MONEDA_ORIG: 'MXN' })])))
    expect(await detalle(svc(sinMonto, dia('2027-02-16')).registrarCargoExtra(parseCargoExtra(cargoMxn('2027-02-Q1', '900.00', '2027-02-16'))))).toEqual({ codigo: 'factura-no-cuadra', motivo: 'suscripcion-sin-monto' })
    expect([...s.appends, ...sinRec.appends, ...sinMonto.appends]).toEqual([])
  })

  it('criterio 4: tope de 3,000 USD en MXN con TIPO_CAMBIO_DEFECTO, en el límite; sin tipo de cambio válido, 409 sin escribir', async () => {
    // 3,000.00 USD × 18.5 = 55,500.00 MXN; sin REC ni DIA_COBRO en Q2, todo el total es extra.
    const enLimite = new InMemoryFinanzasStore(FINANZAS, libroMxn())
    expect(await svc(enLimite, dia('2027-03-01')).registrarCargoExtra(parseCargoExtra(cargoMxn('2027-02-Q2', '55500.00', '2027-03-01')))).toMatchObject({ sinCargo: false })
    expect(extras(enLimite).map((f) => [col(f, 'MONTO_MXN'), col(f, 'MONTO_ORIG'), col(f, 'TIPO_CAMBIO')])).toEqual([[55500, 55500, '']])
    const sobre = new Espia(new InMemoryFinanzasStore(FINANZAS, libroMxn()))
    expect(await codigo(svc(sobre, dia('2027-03-01')).registrarCargoExtra(parseCargoExtra(cargoMxn('2027-02-Q2', '55500.01', '2027-03-01'))))).toBe('monto-excede-tope')
    // Con un tipo de cambio con decimales: 3,000 × 17.1234 = 51,370.20 MXN exactos.
    const tc = { PARAMETROS: [['PARAMETRO', 'VALOR'], ['TIPO_CAMBIO_DEFECTO', 17.1234]] }
    expect(await svc(new InMemoryFinanzasStore(FINANZAS, libroMxn([], tc)), dia('2027-03-01')).registrarCargoExtra(parseCargoExtra(cargoMxn('2027-02-Q2', '51370.20', '2027-03-01')))).toMatchObject({ sinCargo: false })
    expect(await codigo(svc(new InMemoryFinanzasStore(FINANZAS, libroMxn([], tc)), dia('2027-03-01')).registrarCargoExtra(parseCargoExtra(cargoMxn('2027-02-Q2', '51370.21', '2027-03-01'))))).toBe('monto-excede-tope')
    // Sin TIPO_CAMBIO_DEFECTO, vacío, 0, texto o sin PARAMETROS: 409 tipo-cambio-sin-dato.
    for (const over of [
      { PARAMETROS: [['PARAMETRO', 'VALOR'], ['MES_INICIO', '2026-09']] },
      { PARAMETROS: [['PARAMETRO', 'VALOR'], ['TIPO_CAMBIO_DEFECTO', '']] },
      { PARAMETROS: [['PARAMETRO', 'VALOR'], ['TIPO_CAMBIO_DEFECTO', 0]] },
      { PARAMETROS: [['PARAMETRO', 'VALOR'], ['TIPO_CAMBIO_DEFECTO', 'dieciocho']] },
    ]) {
      const s = new Espia(new InMemoryFinanzasStore(FINANZAS, libroMxn([], over)))
      const e = await svc(s, dia('2027-03-01')).registrarCargoExtra(parseCargoExtra(cargoMxn('2027-02-Q2', '360.00', '2027-03-01'))).catch((x: unknown) => x)
      expect((e as OperationError).code, JSON.stringify(over)).toBe('tipo-cambio-sin-dato')
      expect((e as OperationError).status).toBe(409)
      expect(s.appends).toEqual([])
    }
    // Un cierre «sin cargo» en MXN no necesita tipo de cambio.
    const sinTc = new InMemoryFinanzasStore(FINANZAS, libroMxn([recMxn('2027-02', '2027-02-10')], { PARAMETROS: [['PARAMETRO', 'VALOR']] }))
    expect(await svc(sinTc, dia('2027-02-16')).registrarCargoExtra(parseCargoExtra(cargoMxn('2027-02-Q1', '900.00', '2027-02-16')))).toMatchObject({ sinCargo: true })
  })

  it('criterio 5: ORIGEN con moneda= en el cargo extra, nunca en el rendimiento; una moneda alterada en una fila es inconsistente', async () => {
    const s = new InMemoryFinanzasStore(FINANZAS, libroMxn())
    const body = cargoMxn('2027-02-Q2', '360.00', '2027-03-01')
    await svc(s, dia('2027-03-01')).registrarCargoExtra(parseCargoExtra(body))
    await svc(s, dia('2027-03-01')).registrarRendimiento(parseRendimiento(rend('2027-02-Q2', '1')))
    const ops = auditoriaAgente(tabla(s.snapshot().AUDITORIA!, COLUMNAS_AUDITORIA, 'AUDITORIA'))
    expect(ops.map((o) => [o.entidad, o.moneda])).toEqual([['MOVIMIENTOS', 'MXN'], ['RENDIMIENTO_CLAUDE', null]])
    expect(origenAgente(body.requestId, 'abcdef0123456789', REPORTE, body.fuente, 'MXN')).toContain(`reporte=${REPORTE};moneda=MXN;fuente=`)
    expect(leerOrigenAgente(`agente-finanzas;modo=sheets;req=${body.requestId};hash=abcdef0123456789;reporte=${REPORTE};moneda=EUR;fuente=x`)).toBeNull()
    const alterada = s.snapshot()
    const i = alterada.AUDITORIA!.findIndex((f) => String(f[8]).includes('moneda=MXN'))
    alterada.AUDITORIA![i]![8] = String(alterada.AUDITORIA![i]![8]).replace('moneda=MXN', 'moneda=USD')
    expect(await codigo(svc(new InMemoryFinanzasStore(FINANZAS, alterada), dia('2027-03-01')).registrarCargoExtra(parseCargoExtra(body)))).toBe('auditoria-inconsistente')
  })
})

/* ------------------------------ §9 criterio 6: inercia ------------------------------ */

interface Llamada { url: string; init: RequestInit }

/** Handler con dobles de token y de fetch: IAM responde un token y Sheets sirve un libro en memoria. */
function arnes(vars: Record<string, string | undefined>) {
  const memoria = new InMemoryFinanzasStore(FINANZAS, libro())
  const iam: Llamada[] = []
  const sheets: Llamada[] = []
  let fuentes = 0
  let construidos = 0
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (url.startsWith('https://iamcredentials.googleapis.com/')) {
      iam.push({ url, init })
      return new Response(JSON.stringify({ accessToken: 'token-agente', expireTime: '2027-03-01T18:10:00Z' }), { status: 200 })
    }
    sheets.push({ url, init })
    const u = new URL(url)
    if (u.search.includes('fields=sheets.properties.title')) return new Response(JSON.stringify({ sheets: (await memoria.tabs()).map((title) => ({ properties: { title } })) }), { status: 200 })
    if (u.pathname.endsWith('/values:batchGet')) {
      const tabs = u.searchParams.getAll('ranges').map((r) => r.slice(1, r.indexOf("'!")) as FinanzasWriteTab)
      const datos = await memoria.read(tabs)
      return new Response(JSON.stringify({ valueRanges: tabs.map((t) => ({ values: datos[t] ?? [] })) }), { status: 200 })
    }
    const append = /\/values\/'([A-Z_]+)'!A1:append$/.exec(decodeURIComponent(u.pathname))
    if (append && init.method === 'POST') {
      await memoria.append(append[1] as FinanzasWriteTab, (JSON.parse(String(init.body)) as { values: Celda[][] }).values)
      return new Response('{}', { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
  const vars2 = env(vars)
  const now = dia('2027-03-01')
  const deps: FinanzasAgenteHandlerDeps = {
    env: vars2,
    limiter: new RateLimiter(3, 60_000),
    service: () => {
      construidos += 1
      const token = createWriteTokenProvider(vars2.FINANZAS_AGENTE_SERVICE_ACCOUNT!, { sourceToken: async () => `fuente-${++fuentes}`, fetchImpl, now: () => now.getTime() })
      return new FinanzasAgenteService(new FinanzasSheetsStore({ spreadsheetId: vars2.FINANZAS_SHEET_ID!, getWriteToken: token, fetchImpl }), { clock: () => now, randomHex: () => 'abcd1234' })
    },
  }
  async function post(ruta: 'rendimiento' | 'cargo-extra', body: unknown, headers: Record<string, string> = { authorization: `Bearer ${AGENTE_TOKEN}` }) {
    const req = new Request(`${ORIGIN}/api/finanzas/agente/${ruta}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } })
    return finanzasAgenteWrite(req, deps, (service, b) => (ruta === 'rendimiento' ? service.registrarRendimiento(parseRendimiento(b)) : service.registrarCargoExtra(parseCargoExtra(b))))
  }
  return { post, memoria, iam, sheets, get fuentes() { return fuentes }, get construidos() { return construidos } }
}

describe('inercia: sin cualquiera de las condiciones de §8.1, cero llamadas a los dobles de token y de fetch', () => {
  const faltas: Array<Record<string, string | undefined>> = [
    { FINANZAS_AGENTE_MODE: undefined }, { FINANZAS_AGENTE_MODE: 'SHEETS' }, { FINANZAS_SHEET_ID: undefined }, { FINANZAS_SHEET_ID: PROPIA },
    { FINANZAS_AGENTE_SERVICE_ACCOUNT: undefined }, { FINANZAS_AGENTE_SERVICE_ACCOUNT: LECTURA }, { FINANZAS_AGENTE_SERVICE_ACCOUNT: ESCRITURA_POS },
    { FINANZAS_AGENTE_SERVICE_ACCOUNT: CUENTA_FIN }, { SHEETS_EXPECTED_SERVICE_ACCOUNT: undefined },
    { FINANZAS_AGENTE_TOKEN_SHA256: undefined }, { FINANZAS_AGENTE_TOKEN_SHA256: PM_HASH },
  ]
  it.each(faltas)('sin %o: 401 o 403 en las dos rutas, sin construir el servicio', async (over) => {
    for (const ruta of ['rendimiento', 'cargo-extra'] as const) {
      const h = arnes({ ...ACTIVA, ...over })
      const r = await h.post(ruta, ruta === 'rendimiento' ? rend('2027-02-Q2', '1') : cargo('2027-02-Q2', '20', '2027-03-01'))
      expect([401, 403]).toContain(r.status)
      expect(h.construidos).toBe(0)
      expect(h.fuentes + h.iam.length + h.sheets.length).toBe(0)
    }
  })

  it('sin token, con el del PM o con cookie: 401 y cero llamadas, aun con todo activo', async () => {
    const variantes: Array<Record<string, string>> = [{}, { authorization: `Bearer ${PM_TOKEN}` }, { authorization: `Bearer ${AGENTE_TOKEN}`, cookie: 'next-auth.session-token=x' }]
    for (const headers of variantes) {
      const h = arnes(ACTIVA)
      const r = await h.post('cargo-extra', cargo('2027-02-Q2', '20', '2027-03-01'), headers)
      expect(r.status).toBe(401)
      expect(h.construidos + h.fuentes + h.iam.length + h.sheets.length).toBe(0)
    }
  })

  it('con todo activo: 201 y el token se pide suplantando la cuenta del AGENTE, nunca la del propietario', async () => {
    const h = arnes(ACTIVA)
    const r = await h.post('cargo-extra', cargo('2027-02-Q2', '20', '2027-03-01'))
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ ok: true, id: 'CLAUDE-EXTRA-2027-02-Q2', repetida: false, sinCargo: false })
    expect(h.iam).toHaveLength(1)
    expect(h.iam[0]!.url).toContain(encodeURIComponent(CUENTA_AGENTE))
    expect(h.iam[0]!.url).not.toContain(encodeURIComponent(CUENTA_FIN))
    expect(h.sheets.every((c) => c.url.includes(FINANZAS))).toBe(true)
    const repetida = await h.post('rendimiento', rend('2027-02-Q2', '450'))
    expect(repetida.status).toBe(201)
  })
})

/* -------------------------- §9 criterio 8: render.mjs y deploy.sh -------------------------- */

describe('render.mjs acepta, valida y agrega las tres variables del agente', () => {
  const template = readFileSync(path.join(__dirname, '..', 'deploy', 'cloudrun', 'service.template.yaml'), 'utf8')
  const BASE = {
    SERVICE_NAME: 'project-os-dashboard', PROJECT_ID: 'project-os-511102', REGION: 'northamerica-south1',
    IMAGE: `us-docker.pkg.dev/project-os-511102/repo/dash@sha256:${'a'.repeat(64)}`,
    RUNTIME_SA: LECTURA, SERVICE_URL: 'https://dash.example.com',
    OAUTH_CLIENT_ID: '123-abc.apps.googleusercontent.com', SECRET_VERSION_NEXTAUTH: '1', SECRET_VERSION_OAUTH: '1',
    SECRET_VERSION_ALLOWLIST: '1', WRITE_MODE: 'sheets', WRITE_SERVICE_ACCOUNT: ESCRITURA_POS, SECRET_VERSION_WRITERS: '1',
    FINANZAS_SHEET_ID: FINANZAS, FINANZAS_WRITE_MODE: 'sheets', FINANZAS_WRITE_SERVICE_ACCOUNT: CUENTA_FIN, FINANZAS_WRITER_EMAIL: DUENO,
  }
  const AGENTE = { FINANZAS_AGENTE_MODE: 'sheets', FINANZAS_AGENTE_SERVICE_ACCOUNT: CUENTA_AGENTE, SECRET_VERSION_FINANZAS_AGENTE: '3' }
  const bloque = [
    '            - name: FINANZAS_AGENTE_MODE', '              value: sheets',
    '            - name: FINANZAS_AGENTE_SERVICE_ACCOUNT', `              value: ${CUENTA_AGENTE}`,
    '            - name: FINANZAS_AGENTE_TOKEN_SHA256', '              valueFrom:', '                secretKeyRef:',
    '                  name: project-os-finanzas-agente-token-sha256', "                  key: '3'", '',
  ].join('\n')

  it('sin las tres (o vacías) el YAML no cambia; con las tres, solo ese bloque y el hash una vez', () => {
    const sin = render(template, BASE)
    expect(sin).not.toContain('FINANZAS_AGENTE')
    expect(render(template, { ...BASE, FINANZAS_AGENTE_MODE: '', FINANZAS_AGENTE_SERVICE_ACCOUNT: ' ', SECRET_VERSION_FINANZAS_AGENTE: '' })).toBe(sin)
    const con = render(template, { ...BASE, ...AGENTE })
    expect(con).toContain(bloque)
    expect(con.replace(bloque, '')).toBe(sin)
    expect(con.match(/FINANZAS_AGENTE_TOKEN_SHA256/g)).toHaveLength(1)
  })

  it.each([
    [{ FINANZAS_AGENTE_MODE: 'disabled' }, 'FINANZAS_AGENTE_MODE solo admite sheets'],
    [{ FINANZAS_AGENTE_MODE: undefined }, 'van juntas'],
    [{ FINANZAS_AGENTE_SERVICE_ACCOUNT: undefined }, 'van juntas'],
    [{ SECRET_VERSION_FINANZAS_AGENTE: undefined }, 'van juntas'],
    [{ FINANZAS_SHEET_ID: undefined, FINANZAS_WRITE_MODE: undefined, FINANZAS_WRITE_SERVICE_ACCOUNT: undefined, FINANZAS_WRITER_EMAIL: undefined }, 'FINANZAS_AGENTE_MODE exige FINANZAS_SHEET_ID'],
    [{ FINANZAS_AGENTE_SERVICE_ACCOUNT: 'agente@gmail.com' }, 'no tiene el formato esperado'],
    [{ FINANZAS_AGENTE_SERVICE_ACCOUNT: LECTURA }, 'no puede ser la cuenta runtime'],
    [{ FINANZAS_AGENTE_SERVICE_ACCOUNT: ESCRITURA_POS }, 'no puede ser la cuenta de escritura de PROJECT-OS'],
    [{ FINANZAS_AGENTE_SERVICE_ACCOUNT: CUENTA_FIN }, 'no puede ser la cuenta de escritura del propietario'],
    [{ FINANZAS_AGENTE_SERVICE_ACCOUNT: 'project-os-finanzas-agente@otro-proyecto-1.iam.gserviceaccount.com' }, 'debe pertenecer a PROJECT_ID'],
    [{ SECRET_VERSION_FINANZAS_AGENTE: 'latest' }, 'SECRET_VERSION_FINANZAS_AGENTE no tiene el formato esperado'],
  ])('%o: falla el render sin imprimir valores', (over, mensaje) => {
    let error = ''
    try {
      render(template, { ...BASE, ...AGENTE, ...over })
    } catch (e) {
      error = (e as Error).message
    }
    expect(error).toContain(mensaje)
    expect(error).not.toContain(CUENTA_AGENTE)
    expect(error).not.toContain(LECTURA)
  })
})

describe('deploy.sh --desde-activa conserva las tres y --quitar de cualquiera retira las tres', () => {
  const SCRIPT = path.join(__dirname, '..', 'deploy', 'cloudrun', 'deploy.sh')
  const min = { PROJECT_ID: 'project-os-511102', REGION: 'northamerica-south1', SERVICE_NAME: 'project-os-dashboard' }
  const activaBase = () => ({ spec: { template: { spec: { serviceAccountName: LECTURA, containers: [{ image: `us-docker.pkg.dev/project-os-511102/repo/dash@sha256:${'b'.repeat(64)}`, env: [
    { name: 'NEXTAUTH_URL', value: 'https://dash.example.com' }, { name: 'GOOGLE_CLIENT_ID', value: '123-abc.apps.googleusercontent.com' },
    { name: 'NEXTAUTH_SECRET', valueFrom: { secretKeyRef: { name: 'project-os-nextauth-secret', key: '1' } } },
    { name: 'GOOGLE_CLIENT_SECRET', valueFrom: { secretKeyRef: { name: 'project-os-oauth-client-secret', key: '1' } } },
    { name: 'AUTH_ALLOWED_EMAILS', valueFrom: { secretKeyRef: { name: 'project-os-allowed-emails', key: '1' } } },
    { name: 'FINANZAS_SHEET_ID', value: FINANZAS },
  ] }] } } } })

  function run(args: string[], activa: unknown, extra: Record<string, string> = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), 'deploy-agente-'))
    try {
      writeFileSync(path.join(dir, 'gcloud'), '#!/usr/bin/env bash\necho "$*" >> "$GCLOUD_LOG"\ncase "$*" in *"services describe"*) cat "$GCLOUD_ACTIVA" ;; esac\n')
      chmodSync(path.join(dir, 'gcloud'), 0o755)
      writeFileSync(path.join(dir, 'activa.json'), JSON.stringify(activa))
      writeFileSync(path.join(dir, 'gcloud.log'), '')
      const r = spawnSync('bash', [SCRIPT, ...args], {
        cwd: dir, input: '', encoding: 'utf8',
        env: { PATH: `${dir}:${process.env.PATH}`, GCLOUD_LOG: path.join(dir, 'gcloud.log'), GCLOUD_ACTIVA: path.join(dir, 'activa.json'), ...min, ...extra } as unknown as NodeJS.ProcessEnv,
      })
      return { code: r.status, out: `${r.stdout}${r.stderr}`, calls: readFileSync(path.join(dir, 'gcloud.log'), 'utf8') }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('la activa sin agente: el YAML no trae sus variables; exportarlas las lista como nuevas', () => {
    const sigue = run(['--desde-activa', '--dry-run'], activaBase())
    expect(sigue.code).toBe(0)
    expect(sigue.out).not.toContain('FINANZAS_AGENTE')
    const nueva = run(['--desde-activa', '--dry-run'], activaBase(), { FINANZAS_AGENTE_MODE: 'sheets', FINANZAS_AGENTE_SERVICE_ACCOUNT: CUENTA_AGENTE, SECRET_VERSION_FINANZAS_AGENTE: '3' })
    expect(nueva.code).toBe(0)
    for (const n of ['FINANZAS_AGENTE_MODE', 'FINANZAS_AGENTE_SERVICE_ACCOUNT', 'FINANZAS_AGENTE_TOKEN_SHA256']) expect(nueva.out).toContain(`  + ${n}\n`)
    expect(nueva.out).not.toContain(CUENTA_AGENTE)
  })

  it('la activa con agente: se conserva sin imprimir valores; --quitar de cualquiera retira las tres', () => {
    const activa = activaBase()
    activa.spec.template.spec.containers[0]!.env.push(
      { name: 'FINANZAS_AGENTE_MODE', value: 'sheets' }, { name: 'FINANZAS_AGENTE_SERVICE_ACCOUNT', value: CUENTA_AGENTE },
      { name: 'FINANZAS_AGENTE_TOKEN_SHA256', valueFrom: { secretKeyRef: { name: 'project-os-finanzas-agente-token-sha256', key: '3' } } } as never)
    const sigue = run(['--desde-activa', '--dry-run'], activa)
    expect(sigue.code).toBe(0)
    expect(sigue.out).not.toMatch(/  [+-] FINANZAS_AGENTE/)
    expect(sigue.out).toMatch(/Variables quitadas:\n  \(ninguna\)/)
    expect(sigue.out).not.toContain(CUENTA_AGENTE)
    for (const nombre of ['FINANZAS_AGENTE_MODE', 'FINANZAS_AGENTE_SERVICE_ACCOUNT', 'FINANZAS_AGENTE_TOKEN_SHA256']) {
      const apagada = run(['--desde-activa', '--quitar', nombre, '--dry-run'], activa)
      expect(apagada.code, nombre).toBe(0)
      for (const n of ['FINANZAS_AGENTE_MODE', 'FINANZAS_AGENTE_SERVICE_ACCOUNT', 'FINANZAS_AGENTE_TOKEN_SHA256']) expect(apagada.out).toContain(`  - ${n}\n`)
      expect(apagada.out).not.toContain('  - FINANZAS_SHEET_ID')
    }
    const mala = run(['--desde-activa'], activa, { FINANZAS_AGENTE_SERVICE_ACCOUNT: LECTURA })
    expect(mala.code).toBe(1)
    expect(mala.out).toContain('no puede ser la cuenta runtime')
    expect(mala.calls).not.toContain('replace')
  })
})
