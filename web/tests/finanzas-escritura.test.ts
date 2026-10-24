import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { render } from '../deploy/cloudrun/render.mjs'
import { describe, expect, it } from 'vitest'
import { decide } from '@/lib/authz'
import { finanzasCanWrite, finanzasWriteMode, finanzasWriteServiceAccount, finanzasWriteStatus, finanzasWriter } from '@/lib/finanzas/escritura-config'
import { evaluateFinanzasWriteRequest } from '@/lib/finanzas/escritura-guard'
import { finanzasWrite, type FinanzasHandlerDeps } from '@/lib/finanzas/escritura-handler'
import { FinanzasWriteService, FINANZAS_OPERATIONS } from '@/lib/finanzas/escritura-service'
import { FinanzasSheetsStore, InMemoryFinanzasStore, type Celda, type FinanzasStore, type FinanzasWriteTab } from '@/lib/finanzas/escritura-store'
import { conceptoFinal, conceptoProhibido, convertirCentavos, parseConfirmar, parseMovimiento } from '@/lib/finanzas/escritura-validacion'
import { ajusteMostrado, CODIGOS_PERMANENTES, cuerpoEnvio, estadoInicial, trasRespuesta, type EnvioEstado, type Payload, type Respuesta } from '@/lib/finanzas/envio'
import { AGENT_OPERATIONS } from '@/lib/operations/constants'
import { OperationError } from '@/lib/operations/errors'
import { RateLimiter } from '@/lib/operations/rate-limit'
import { createWriteTokenProvider } from '@/lib/operations/write-credentials'

/**
 * Escritura de finanzas (ORD-POS-077, docs/diseno-finanzas-v2.md §2 a §7, opción C de §6). Solo dobles de sesión, de
 * token y de fetch: ninguna prueba toca Google. Montos, cuentas y correos inventados.
 */

const PROPIA = '16UXe7fm90fOTTVJhI_RZ8__I876u2buvjeLGr5cJ-Ic'
const FINANZAS = 'LIBRO_FINANZAS_SINTETICO_0123456789'
const RADAROS = 'LIBRO_RADAROS_SINTETICO_0123456789'
const LECTURA = 'project-os-dashboard-run@project-os-511102.iam.gserviceaccount.com'
const ESCRITURA_POS = 'project-os-writer@project-os-511102.iam.gserviceaccount.com'
const CUENTA_FIN = 'project-os-finanzas@project-os-511102.iam.gserviceaccount.com'
const DUENO = 'dueno@example.com'
const ORIGIN = 'http://127.0.0.1:3000'
const PM_TOKEN = 'token-del-pm-sintetico-0123456789'
const PM_HASH = createHash('sha256').update(PM_TOKEN).digest('hex')
// 2026-10-24 12:00 en Mérida (UTC−6).
const NOW = new Date(Date.UTC(2026, 9, 24, 18, 0, 0))

const ACTIVA: Record<string, string> = {
  NEXTAUTH_URL: ORIGIN,
  AUTH_ALLOWED_EMAILS: `lector@example.com, ${DUENO}`,
  SHEETS_SPREADSHEET_ID: PROPIA,
  SHEETS_EXPECTED_SERVICE_ACCOUNT: LECTURA,
  PROJECT_OS_WRITE_SERVICE_ACCOUNT: ESCRITURA_POS,
  FINANZAS_SHEET_ID: FINANZAS,
  FINANZAS_WRITE_MODE: 'sheets',
  FINANZAS_WRITE_SERVICE_ACCOUNT: CUENTA_FIN,
  FINANZAS_WRITER_EMAIL: DUENO,
  PM_AGENT_TOKEN_SHA256: PM_HASH,
}
const env = (vars: Record<string, string | undefined>) => vars as unknown as NodeJS.ProcessEnv

const ENC_MOV = ['MOV_ID', 'FECHA', 'PROYECTO', 'TIPO', 'CATEGORIA', 'CONCEPTO', 'PRODUCTO_ID', 'MONTO_MXN', 'MONEDA_ORIG', 'MONTO_ORIG', 'TIPO_CAMBIO', 'IVA_MXN', 'FUENTE', 'COMPROBANTE', 'AJUSTE_DE']
const ENC_AUD = ['AUDIT_ID', 'FECHA_HORA', 'ACTOR', 'ENTIDAD', 'REGISTRO_ID', 'CAMPO', 'VALOR_ANTES', 'VALOR_DESPUES', 'ORIGEN']
const ENC_REC = ['ID', 'CONCEPTO', 'PROYECTO', 'CATEGORIA', 'MONTO', 'MONEDA', 'DIA_COBRO', 'DESDE', 'HASTA']
const mov = (id: string, monto: number, extra: Partial<Record<string, Celda>> = {}): Celda[] => {
  const r: Record<string, Celda> = { MOV_ID: id, FECHA: '2026-10-02', PROYECTO: 'ECO', TIPO: 'Gasto', CATEGORIA: 'Producto', CONCEPTO: 'Muestras', MONTO_MXN: monto, MONEDA_ORIG: 'MXN', FUENTE: 'manual', COMPROBANTE: 'sí', ...extra } as Record<string, Celda>
  return ENC_MOV.map((c) => r[c] ?? '')
}

function libro(over: Partial<Record<string, unknown[][]>> = {}) {
  return {
    MOVIMIENTOS: [ENC_MOV, mov('MAN-0001', 100), mov('MAN-0003', 50)],
    PARAMETROS: [['PARAMETRO', 'VALOR'], ['MES_INICIO', '2026-09'], ['TIPO_CAMBIO_DEFECTO', 18.5]],
    RECURRENTES: [ENC_REC, ['CLAUDE', 'Suscripción Claude', 'POS', 'Herramientas', 20, 'USD', 5, '2026-01', ''], ['KEEPA', 'Keepa', 'ECO', 'Herramientas', 400, 'MXN', 31, '2026-01', ''], ['VIEJO', 'Baja', 'ECO', 'Herramientas', 10, 'MXN', 1, '2026-01', '2026-08']],
    AUDITORIA: [ENC_AUD],
    ...over,
  }
}

let seq = 0
const rid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`
const CTX = { actor: DUENO }
const servicio = (store: FinanzasStore) => new FinanzasWriteService(store, { clock: () => NOW, randomHex: () => 'abcd1234' })
const base = (over: Record<string, unknown> = {}) => ({ requestId: rid(), fecha: '2026-10-20', proyecto: 'ECO', tipo: 'Gasto', categoria: 'Producto', concepto: 'Muestras de empaque', montoMxn: '123.45', comprobante: 'sí', ...over })

async function codigo(p: Promise<unknown> | (() => unknown)) {
  const e = await (typeof p === 'function' ? Promise.resolve().then(p) : p).catch((x: unknown) => x)
  expect(e).toBeInstanceOf(OperationError)
  return (e as OperationError).code
}

const filasMov = (s: InMemoryFinanzasStore) => s.snapshot().MOVIMIENTOS!.slice(1)
const filasAud = (s: InMemoryFinanzasStore) => s.snapshot().AUDITORIA!.slice(1)
const col = (row: unknown[], c: string) => row[ENC_MOV.indexOf(c)]

/* ------------------------------------ Criterios 1 y 2 ------------------------------------ */

describe('criterios 1 y 2: cuenta propia, modo y escritor único', () => {
  it('con todas las condiciones: sheets, y solo el escritor puede', () => {
    expect(finanzasWriteStatus(env(ACTIVA))).toEqual({ mode: 'sheets', reason: null })
    expect(finanzasWriter(env(ACTIVA))).toBe(DUENO)
    expect(finanzasCanWrite(DUENO, env(ACTIVA))).toBe(true)
    expect(finanzasCanWrite(' Dueno@Example.com ', env(ACTIVA))).toBe(true)
    expect(finanzasCanWrite('lector@example.com', env(ACTIVA))).toBe(false)
    expect(finanzasCanWrite(null, env(ACTIVA))).toBe(false)
  })

  it.each([
    [{ FINANZAS_WRITE_MODE: undefined }, 'deshabilitada'],
    [{ FINANZAS_WRITE_MODE: 'disabled' }, 'deshabilitada'],
    [{ FINANZAS_WRITE_MODE: 'Sheets' }, 'modo-invalido'],
    [{ FINANZAS_WRITE_MODE: ' sheets' }, 'modo-invalido'],
    [{ FINANZAS_WRITE_MODE: 'mock' }, 'modo-invalido'],
    [{ FINANZAS_SHEET_ID: undefined }, 'sin-libro'],
    [{ FINANZAS_SHEET_ID: 'corto' }, 'sin-libro'],
    [{ FINANZAS_SHEET_ID: PROPIA }, 'sin-libro'],
    [{ FINANZAS_SHEET_ID: RADAROS, RADAROS_SHEET_ID: RADAROS }, 'sin-libro'],
    [{ FINANZAS_WRITE_SERVICE_ACCOUNT: undefined }, 'sin-cuenta'],
    [{ FINANZAS_WRITE_SERVICE_ACCOUNT: 'dueno@gmail.com' }, 'sin-cuenta'],
    [{ FINANZAS_WRITE_SERVICE_ACCOUNT: LECTURA }, 'cuenta-de-lectura'],
    [{ FINANZAS_WRITE_SERVICE_ACCOUNT: ESCRITURA_POS.toUpperCase() }, 'cuenta-de-project-os'],
    [{ FINANZAS_WRITER_EMAIL: undefined }, 'sin-escritor'],
    [{ FINANZAS_WRITER_EMAIL: 'no-es-correo' }, 'sin-escritor'],
    [{ FINANZAS_WRITER_EMAIL: `${DUENO}, lector@example.com` }, 'escritor-ambiguo'],
    [{ FINANZAS_WRITER_EMAIL: `${DUENO} lector@example.com` }, 'escritor-ambiguo'],
    [{ FINANZAS_WRITER_EMAIL: 'otro@example.com' }, 'escritor-no-permitido'],
    [{ AUTH_ALLOWED_EMAILS: 'lector@example.com' }, 'escritor-no-permitido'],
  ])('falta una condición (%o): deshabilitada con motivo %s y nadie escribe', (over, reason) => {
    const vars = env({ ...ACTIVA, ...over })
    expect(finanzasWriteStatus(vars)).toEqual({ mode: 'disabled', reason })
    expect(finanzasWriteMode(vars)).toBe('disabled')
    expect(finanzasWriter(vars)).toBeNull()
    expect(finanzasCanWrite(DUENO, vars)).toBe(false)
  })

  it('no depende de la escritura de PROJECT-OS: ni PROJECT_OS_WRITE_MODE ni AUTH_WRITER_EMAILS la encienden o la apagan', () => {
    expect(finanzasWriteMode(env({ ...ACTIVA, PROJECT_OS_WRITE_MODE: 'disabled', AUTH_WRITER_EMAILS: '' }))).toBe('sheets')
    const sinFin = { ...ACTIVA, FINANZAS_WRITE_MODE: undefined, PROJECT_OS_WRITE_MODE: 'sheets', AUTH_WRITER_EMAILS: DUENO }
    expect(finanzasWriteMode(env(sinFin))).toBe('disabled')
  })

  it('la cuenta se valida con formato de cuenta de servicio', () => {
    expect(finanzasWriteServiceAccount(env({ FINANZAS_WRITE_SERVICE_ACCOUNT: ` ${CUENTA_FIN.toUpperCase()} ` }))).toBe(CUENTA_FIN)
    expect(finanzasWriteServiceAccount(env({ FINANZAS_WRITE_SERVICE_ACCOUNT: 'x@proyecto.iam.gserviceaccount.com' }))).toBeNull()
  })

  it('token por suplantación de la cuenta de FINANZAS: alcance spreadsheets, 10 min, solo en una petición de escritura', async () => {
    const h = arnes(ACTIVA)
    expect(h.iam).toHaveLength(0) // construir el servicio no pide token
    const r = await h.post('/api/finanzas/movimientos', base())
    expect(r.status).toBe(201)
    expect(h.iam).toHaveLength(1)
    expect(h.iam[0]!.url).toBe(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(CUENTA_FIN)}:generateAccessToken`)
    expect(JSON.parse(String(h.iam[0]!.init.body))).toEqual({ scope: ['https://www.googleapis.com/auth/spreadsheets'], lifetime: '600s' })
    for (const c of h.sheets) expect((c.init.headers as Record<string, string>).Authorization).toBe('Bearer token-finanzas')
  })
})

/* -------------------------------------- Arnés HTTP -------------------------------------- */

interface Llamada { url: string; init: RequestInit }

/** Handler con dobles: sesión, token de origen, IAM y Sheets (este último sirve un libro en memoria). */
function arnes(vars: Record<string, string | undefined>, opts: { email?: string | null; datos?: Partial<Record<string, unknown[][]>> } = {}) {
  const memoria = new InMemoryFinanzasStore(FINANZAS, opts.datos ?? libro())
  const iam: Llamada[] = []
  const sheets: Llamada[] = []
  const otras: Llamada[] = []
  let sesiones = 0
  let fuentes = 0
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (url.startsWith('https://iamcredentials.googleapis.com/')) {
      iam.push({ url, init })
      return new Response(JSON.stringify({ accessToken: 'token-finanzas', expireTime: '2026-10-24T18:10:00Z' }), { status: 200 })
    }
    if (!url.startsWith('https://sheets.googleapis.com/')) {
      otras.push({ url, init })
      return new Response('{}', { status: 500 })
    }
    sheets.push({ url, init })
    const u = new URL(url)
    if (u.search.includes('fields=sheets.properties.title')) {
      return new Response(JSON.stringify({ sheets: (await memoria.tabs()).map((title) => ({ properties: { title } })) }), { status: 200 })
    }
    if (u.pathname.endsWith('/values:batchGet')) {
      const tabs = u.searchParams.getAll('ranges').map((r) => r.slice(1, r.indexOf("'!")) as FinanzasWriteTab)
      const datos = await memoria.read(tabs)
      return new Response(JSON.stringify({ valueRanges: tabs.map((t) => ({ values: datos[t] ?? [] })) }), { status: 200 })
    }
    const append = /\/values\/'([A-Z]+)'!A1:append$/.exec(decodeURIComponent(u.pathname))
    if (append && init.method === 'POST') {
      await memoria.append(append[1] as FinanzasWriteTab, (JSON.parse(String(init.body)) as { values: Celda[][] }).values)
      return new Response('{}', { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
  const vars2 = env(vars)
  let construidos = 0
  const deps: FinanzasHandlerDeps = {
    sessionEmail: async () => {
      sesiones += 1
      return opts.email === undefined ? DUENO : opts.email
    },
    env: vars2,
    limiter: new RateLimiter(5, 10_000),
    service: () => {
      construidos += 1
      const libroId = vars2.FINANZAS_SHEET_ID!
      const cuenta = finanzasWriteServiceAccount(vars2)!
      const token = createWriteTokenProvider(cuenta, { sourceToken: async () => `fuente-${++fuentes}`, fetchImpl, now: () => NOW.getTime() })
      return new FinanzasWriteService(new FinanzasSheetsStore({ spreadsheetId: libroId, getWriteToken: token, fetchImpl }), { clock: () => NOW, randomHex: () => 'abcd1234' })
    },
  }
  async function post(ruta: string, body: unknown, headers: Record<string, string> = {}) {
    const text = JSON.stringify(body)
    const req = new Request(`${ORIGIN}${ruta}`, {
      method: 'POST', body: text,
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-project-os-csrf': '1', 'sec-fetch-site': 'same-origin', ...headers },
    })
    return finanzasWrite(req, deps, (service, b, ctx) => (ruta.endsWith('/confirmar')
      ? service.confirmarRecurrente(parseConfirmar(b), ctx)
      : service.crearMovimiento(parseMovimiento(b), ctx)))
  }
  return {
    post, memoria, iam, sheets, otras, deps,
    get sesiones() { return sesiones },
    get fuentes() { return fuentes },
    get construidos() { return construidos },
  }
}

/* --------------------------------------- Criterio 3 --------------------------------------- */

describe('criterio 3: guard propio sin rama de agente', () => {
  it('con el token del PM, con y sin cookie: 401 antes de leer sesión, cuerpo, token o Sheets', async () => {
    for (const cookie of [undefined, 'next-auth.session-token=valida']) {
      const h = arnes(ACTIVA)
      let leido = false
      const body = new ReadableStream({ pull(c) { leido = true; c.enqueue(new TextEncoder().encode('{}')); c.close() } }, { highWaterMark: 0 })
      const req = new Request(`${ORIGIN}/api/finanzas/movimientos`, {
        method: 'POST', body, duplex: 'half',
        headers: { authorization: `Bearer ${PM_TOKEN}`, origin: ORIGIN, 'content-type': 'application/json', 'x-project-os-csrf': '1', ...(cookie ? { cookie } : {}) },
      } as RequestInit)
      const r = await finanzasWrite(req, h.deps, async () => { throw new Error('no debe correr') })
      expect(r.status).toBe(401)
      expect((r.body.error as { codigo: string }).codigo).toBe('no-autenticado')
      expect(leido).toBe(false)
      expect(req.bodyUsed).toBe(false)
      expect(h.sesiones).toBe(0)
      expect(h.construidos).toBe(0)
      expect(h.iam.length + h.sheets.length + h.fuentes).toBe(0)
    }
  })

  it('cualquier Authorization (no solo el del PM) también es 401 en el guard', async () => {
    const req = new Request(`${ORIGIN}/api/finanzas/movimientos`, { method: 'POST', body: '{}', headers: { authorization: 'Basic abc' } })
    expect(await codigo(evaluateFinanzasWriteRequest(req, { email: DUENO, env: env(ACTIVA), limiter: new RateLimiter() }))).toBe('no-autenticado')
  })

  it('el proxy no trata /api/finanzas/ como del agente: con el token válido del PM, no autenticado', async () => {
    for (const ruta of ['/api/finanzas/movimientos', '/api/finanzas/recurrentes/confirmar']) {
      const req = new NextRequest(new URL(ruta, ORIGIN), { method: 'POST', headers: { authorization: `Bearer ${PM_TOKEN}` } })
      expect((await decide(req, { secret: 'secreto-de-prueba-0123456789abcdef', agentTokenSha256: PM_HASH })).action).toBe('unauthenticated')
    }
    // Control: la misma credencial sí vale en una ruta de la lista del PM.
    const ok = new NextRequest(new URL('/api/operaciones/tareas', ORIGIN), { method: 'POST', headers: { authorization: `Bearer ${PM_TOKEN}` } })
    expect((await decide(ok, { secret: 'x', agentTokenSha256: PM_HASH })).action).toBe('agent')
  })

  it('AGENT_ROUTES y AGENT_OPERATIONS no cambian ni nombran finanzas', () => {
    expect(AGENT_OPERATIONS).toEqual(['tarea.crear', 'tarea.editar', 'decision.crear', 'orden.crear', 'orden.aprobar'])
    for (const op of FINANZAS_OPERATIONS) expect((AGENT_OPERATIONS as readonly string[]).includes(op)).toBe(false)
    const authz = readFileSync(path.join(__dirname, '..', 'src', 'lib', 'authz.ts'), 'utf8')
    const rutas = authz.slice(authz.indexOf('const AGENT_ROUTES'), authz.indexOf(']\n', authz.indexOf('const AGENT_ROUTES')) + 1)
    expect(rutas).toBe([
      "const AGENT_ROUTES: Array<[method: string, path: RegExp]> = [",
      "  ['POST', /^\\/api\\/operaciones\\/(tareas|decisiones|ordenes)\\/?$/],",
      "  ['PATCH', /^\\/api\\/operaciones\\/(tareas|ordenes)\\/[^/]+\\/?$/],",
      ']',
    ].join('\n'))
    expect(authz).not.toMatch(/finanzas/i)
  })

  it('orden de verificaciones: sesión, lector, origen/CSRF, modo, escritor, 415, 429, JSON', async () => {
    const req = (headers: Record<string, string> = {}, body = '{}') => new Request(`${ORIGIN}/api/finanzas/movimientos`, {
      method: 'POST', body, headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-project-os-csrf': '1', ...headers },
    })
    const ctx = (email: string | null, vars = ACTIVA, limiter = new RateLimiter()) => ({ email, env: env(vars), limiter })
    expect(await codigo(evaluateFinanzasWriteRequest(req(), ctx(null)))).toBe('no-autenticado')
    expect(await codigo(evaluateFinanzasWriteRequest(req(), ctx('extrano@example.com')))).toBe('sin-permiso-lectura')
    expect(await codigo(evaluateFinanzasWriteRequest(req({ 'x-project-os-csrf': '0' }), ctx(DUENO)))).toBe('origen-invalido')
    expect(await codigo(evaluateFinanzasWriteRequest(req({ origin: 'https://otro.example.com' }), ctx(DUENO)))).toBe('origen-invalido')
    expect(await codigo(evaluateFinanzasWriteRequest(req(), ctx(DUENO, { ...ACTIVA, FINANZAS_WRITE_MODE: '' })))).toBe('escritura-deshabilitada')
    expect(await codigo(evaluateFinanzasWriteRequest(req(), ctx('lector@example.com')))).toBe('sin-permiso-escritura')
    expect(await codigo(evaluateFinanzasWriteRequest(req({ 'content-type': 'text/plain' }), ctx(DUENO)))).toBe('tipo-contenido')
    expect(await codigo(evaluateFinanzasWriteRequest(req({}, 'no json'), ctx(DUENO)))).toBe('json-invalido')
    const limiter = new RateLimiter(5, 10_000, () => 0)
    for (let i = 0; i < 5; i++) await evaluateFinanzasWriteRequest(req(), ctx(DUENO, ACTIVA, limiter))
    expect(await codigo(evaluateFinanzasWriteRequest(req(), ctx(DUENO, ACTIVA, limiter)))).toBe('demasiadas-solicitudes')
  })
})

/* --------------------------------------- Criterio 4 --------------------------------------- */

describe('criterio 4: finanzas solo toca FINANZAS y operaciones nunca FINANZAS', () => {
  it('cada llamada de la escritura de finanzas va al libro FINANZAS con la cuenta de FINANZAS', async () => {
    const h = arnes(ACTIVA)
    expect((await h.post('/api/finanzas/movimientos', base())).status).toBe(201)
    expect((await h.post('/api/finanzas/recurrentes/confirmar', { requestId: rid(), recurrenteId: 'KEEPA', mes: '2026-10', monto: '400', fecha: '2026-10-24' })).status).toBe(201)
    expect(h.sheets.length).toBeGreaterThan(0)
    for (const c of h.sheets) expect(c.url.startsWith(`https://sheets.googleapis.com/v4/spreadsheets/${FINANZAS}`)).toBe(true)
    const todo = JSON.stringify([...h.sheets, ...h.iam].map((c) => c.url))
    expect(todo).not.toContain(PROPIA)
    expect(todo).not.toContain(encodeURIComponent(ESCRITURA_POS))
    expect(todo).not.toContain(encodeURIComponent(LECTURA))
    expect(h.otras).toHaveLength(0)
  })

  it('el código de operaciones no conoce FINANZAS y el de escritura de finanzas no conoce el servicio de operaciones', () => {
    const SRC = path.join(__dirname, '..', 'src', 'lib')
    const archivos = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
      const full = path.join(dir, n)
      return statSync(full).isDirectory() ? archivos(full) : [full]
    })
    for (const f of archivos(path.join(SRC, 'operations'))) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/FINANZAS_SHEET_ID|finanzasSheetId|finanzasConfig|FINANZAS_WRITE|lib\/finanzas|\.\.\/finanzas/)
    }
    for (const f of readdirSync(path.join(SRC, 'finanzas')).filter((n) => n.startsWith('escritura-'))) {
      const text = readFileSync(path.join(SRC, 'finanzas', f), 'utf8')
      expect(text, f).not.toMatch(/OperationsService|SheetsTableStore|operations\/runtime|operations\/service|spreadsheetId\(\)|writeServiceAccount\(/)
    }
  })

  it('el almacén de finanzas solo construye URLs de su libro, sin aceptar otro por petición', async () => {
    const urls: string[] = []
    const fetchImpl = (async (url: string) => {
      urls.push(url)
      return new Response(JSON.stringify({ sheets: [], valueRanges: [] }), { status: 200 })
    }) as unknown as typeof fetch
    const store = new FinanzasSheetsStore({ spreadsheetId: FINANZAS, getWriteToken: async () => 't', fetchImpl })
    await store.tabs()
    await store.read(['MOVIMIENTOS', 'AUDITORIA'])
    await store.append('AUDITORIA', [['x']])
    expect(urls).toHaveLength(3)
    for (const u of urls) expect(u.startsWith(`https://sheets.googleapis.com/v4/spreadsheets/${FINANZAS}`)).toBe(true)
    expect(urls[2]).toMatch(/:append\?valueInputOption=RAW&insertDataOption=INSERT_ROWS$/)
    expect(urls[1]).toContain('valueRenderOption=UNFORMATTED_VALUE')
  })
})

/* --------------------------------------- Criterio 5 --------------------------------------- */

describe('criterio 5: POST /api/finanzas/movimientos (§3.1 a §3.4)', () => {
  it('alta MXN: MAN-NNNN siguiente al máximo de MOVIMIENTOS y AUDITORIA, montos como número y FUENTE manual', async () => {
    const s = new InMemoryFinanzasStore(FINANZAS, libro())
    const r = await servicio(s).crearMovimiento(parseMovimiento(base({ productoId: 'EC-004', ivaMxn: '10' })), CTX)
    expect(r).toEqual({ operacion: 'finanzas.movimiento.crear', id: 'MAN-0004', repetida: false })
    const fila = filasMov(s).at(-1)!
    expect(col(fila, 'MONTO_MXN')).toBe(123.45)
    expect(col(fila, 'IVA_MXN')).toBe(10)
    expect(col(fila, 'FUENTE')).toBe('manual')
    expect(col(fila, 'MONEDA_ORIG')).toBe('MXN')
    expect(col(fila, 'PRODUCTO_ID')).toBe('EC-004')
    // Un MAN- solo en la auditoría (fila borrada a mano) tampoco se reutiliza.
    const s2 = new InMemoryFinanzasStore(FINANZAS, libro({ AUDITORIA: [ENC_AUD, ['AUD-1', '', '', 'MOVIMIENTOS', 'MAN-0042', 'MOV_ID', '', 'MAN-0042', 'manual']] }))
    expect((await servicio(s2).crearMovimiento(parseMovimiento(base()), CTX)).id).toBe('MAN-0043')
  })

  it('MAN-9999 es el último: después, 409 finanzas-ids-agotados sin escribir', async () => {
    const s = new InMemoryFinanzasStore(FINANZAS, libro({ MOVIMIENTOS: [ENC_MOV, mov('MAN-9999', 1)] }))
    expect(await codigo(servicio(s).crearMovimiento(parseMovimiento(base()), CTX))).toBe('finanzas-ids-agotados')
    expect(filasAud(s)).toHaveLength(0)
  })

  it('USD: MONTO_MXN lo calcula el servidor con redondeo; si el cliente manda otro, 400 monto-no-cuadra', async () => {
    expect(convertirCentavos(1999, 185_432)).toBe(37068) // 19.99 × 18.5432 = 370.678... → 370.68
    expect(convertirCentavos(-1999, 185_432)).toBe(-37068)
    const s = new InMemoryFinanzasStore(FINANZAS, libro())
    await servicio(s).crearMovimiento(parseMovimiento(base({ moneda: 'USD', montoOrig: '19.99', tipoCambio: '18.5432', montoMxn: undefined })), CTX)
    const fila = filasMov(s).at(-1)!
    expect([col(fila, 'MONEDA_ORIG'), col(fila, 'MONTO_ORIG'), col(fila, 'TIPO_CAMBIO'), col(fila, 'MONTO_MXN')]).toEqual(['USD', 19.99, 18.5432, 370.68])
    expect(await codigo(() => parseMovimiento(base({ moneda: 'USD', montoOrig: '19.99', tipoCambio: '18.5432', montoMxn: '370.67' })))).toBe('monto-no-cuadra')
    expect((await codigo(() => parseMovimiento(base({ moneda: 'MXN', tipoCambio: '18' }))))).toBe('validacion')
  })

  it('validación de §3.1: campos, listas cerradas, concepto sin datos personales, fecha no futura ni antes de MES_INICIO', async () => {
    const malos: Array<Record<string, unknown>> = [
      { fecha: '2026-13-01' }, { proyecto: 'SIG' }, { tipo: 'Otro' }, { categoria: 'Viajes' }, { concepto: 'ab' },
      { concepto: 'x'.repeat(81) }, { productoId: 'P-1' }, { montoMxn: '0' }, { montoMxn: '-5' }, { montoMxn: '1.234' },
      { ivaMxn: '200' }, { comprobante: 'tal vez' }, { requestId: 'no' }, { moneda: 'EUR' },
    ]
    for (const m of malos) expect(await codigo(() => parseMovimiento(base(m))), JSON.stringify(m)).toBe('validacion')
    for (const t of ['pago a juan@example.com', 'CLABE 012180001234567891', 'tarjeta 4111 1111 1111 1111', 'RFC ABCD800101XY1', 'ver https://banco.example.com', 'www.algo.com']) {
      expect(conceptoProhibido(t), t).toBe(true)
    }
    expect(conceptoProhibido('Suscripción Claude 2026')).toBe(false)
    const s = new InMemoryFinanzasStore(FINANZAS, libro())
    expect(await codigo(servicio(s).crearMovimiento(parseMovimiento(base({ fecha: '2026-10-26' })), CTX))).toBe('validacion')
    expect(await codigo(servicio(s).crearMovimiento(parseMovimiento(base({ fecha: '2026-08-31' })), CTX))).toBe('validacion')
    // Hoy en Mérida más 1 día de margen sí entra.
    expect((await servicio(s).crearMovimiento(parseMovimiento(base({ fecha: '2026-10-25' })), CTX)).repetida).toBe(false)
  })

  it('concepto que empieza por = se neutraliza (RAW y apóstrofo)', async () => {
    const s = new InMemoryFinanzasStore(FINANZAS, libro())
    await servicio(s).crearMovimiento(parseMovimiento(base({ concepto: '=HYPERLINK("x")' })), CTX)
    expect(col(filasMov(s).at(-1)!, 'CONCEPTO')).toBe(`'=HYPERLINK("x")`)
  })

  it('idempotencia de §3.3: repetida, roll-forward y conflicto', async () => {
    const s = new InMemoryFinanzasStore(FINANZAS, libro())
    const svc = servicio(s)
    const body = base()
    const primero = await svc.crearMovimiento(parseMovimiento(body), CTX)
    const otra = await svc.crearMovimiento(parseMovimiento(body), CTX)
    expect(otra).toEqual({ ...primero, repetida: true })
    expect(filasMov(s)).toHaveLength(3)
    expect(await codigo(svc.crearMovimiento(parseMovimiento({ ...body, montoMxn: '1' }), CTX))).toBe('conflicto-idempotencia')
    expect(filasMov(s)).toHaveLength(3)
  })

  it('ajustes de §3.4: negativo solo en ajuste, concepto con prefijo, campos del original y sin bajar de 0', async () => {
    expect(await codigo(() => parseMovimiento(base({ montoMxn: '-10' })))).toBe('validacion')
    const s = new InMemoryFinanzasStore(FINANZAS, libro())
    const svc = servicio(s)
    const r = await svc.crearMovimiento(parseMovimiento(base({ ajusteDe: 'MAN-0001', montoMxn: '-60', concepto: 'Devolución parcial' })), CTX)
    const fila = filasMov(s).at(-1)!
    expect(r.id).toBe('MAN-0004')
    expect([col(fila, 'AJUSTE_DE'), col(fila, 'MONTO_MXN'), col(fila, 'CONCEPTO')]).toEqual(['MAN-0001', -60, 'Ajuste de MAN-0001: Devolución parcial'])
    // 100 − 60 − 50 < 0
    expect(await codigo(svc.crearMovimiento(parseMovimiento(base({ ajusteDe: 'MAN-0001', montoMxn: '-50' })), CTX))).toBe('ajuste-excede-original')
    // Anular el resto exacto sí.
    expect((await svc.crearMovimiento(parseMovimiento(base({ ajusteDe: 'MAN-0001', montoMxn: '-40' })), CTX)).id).toBe('MAN-0005')
    expect(await codigo(svc.crearMovimiento(parseMovimiento(base({ ajusteDe: 'MAN-0404', montoMxn: '-1' })), CTX))).toBe('movimiento-inexistente')
    expect(await codigo(svc.crearMovimiento(parseMovimiento(base({ ajusteDe: 'MAN-0004', montoMxn: '-1' })), CTX))).toBe('movimiento-inexistente')
    expect(await codigo(svc.crearMovimiento(parseMovimiento(base({ ajusteDe: 'MAN-0003', proyecto: 'POS', montoMxn: '-1' })), CTX))).toBe('validacion')
  })
})

/* --------------------------------------- Criterio 6 --------------------------------------- */

const conf = (over: Record<string, unknown> = {}) => ({ requestId: rid(), recurrenteId: 'KEEPA', mes: '2026-10', monto: '400', fecha: '2026-10-31', ...over })

describe('criterio 6: POST /api/finanzas/recurrentes/confirmar (§4.3)', () => {
  it('MXN: REC-<ID>-AAAA-MM con los datos del recurrente, Gasto y FUENTE recurrente', async () => {
    const s = new InMemoryFinanzasStore(FINANZAS, libro())
    const r = await servicio(s).confirmarRecurrente(parseConfirmar(conf({ monto: '399.90', comprobante: 'sí' })), CTX)
    expect(r).toEqual({ operacion: 'finanzas.recurrente.confirmar', id: 'REC-KEEPA-2026-10', repetida: false })
    const fila = filasMov(s).at(-1)!
    expect([col(fila, 'PROYECTO'), col(fila, 'TIPO'), col(fila, 'CATEGORIA'), col(fila, 'CONCEPTO'), col(fila, 'MONTO_MXN'), col(fila, 'FUENTE'), col(fila, 'COMPROBANTE')])
      .toEqual(['ECO', 'Gasto', 'Herramientas', 'Keepa', 399.9, 'recurrente', 'sí'])
  })

  it('USD: monto y tipo de cambio editados, MONTO_MXN calculado; sin tipo de cambio, 422', async () => {
    const s = new InMemoryFinanzasStore(FINANZAS, libro())
    await servicio(s).confirmarRecurrente(parseConfirmar(conf({ recurrenteId: 'CLAUDE', monto: '21.5', tipoCambio: '18.25', fecha: '2026-10-05' })), CTX)
    const fila = filasMov(s).at(-1)!
    expect([col(fila, 'MOV_ID'), col(fila, 'MONTO_ORIG'), col(fila, 'TIPO_CAMBIO'), col(fila, 'MONTO_MXN')]).toEqual(['REC-CLAUDE-2026-10', 21.5, 18.25, 392.38])
    expect(await codigo(servicio(s).confirmarRecurrente(parseConfirmar(conf({ recurrenteId: 'CLAUDE', mes: '2026-09', fecha: '2026-09-05' })), CTX))).toBe('validacion')
  })

  it('mes M o M−1 y recurrente vigente; fecha dentro del mes', async () => {
    const s = new InMemoryFinanzasStore(FINANZAS, libro())
    const svc = servicio(s)
    expect(await codigo(svc.confirmarRecurrente(parseConfirmar(conf({ mes: '2026-08', fecha: '2026-08-31' })), CTX))).toBe('validacion')
    expect(await codigo(svc.confirmarRecurrente(parseConfirmar(conf({ recurrenteId: 'VIEJO', fecha: '2026-10-01' })), CTX))).toBe('recurrente-inexistente')
    expect(await codigo(svc.confirmarRecurrente(parseConfirmar(conf({ recurrenteId: 'NOEXISTE' })), CTX))).toBe('recurrente-inexistente')
    expect(await codigo(() => parseConfirmar(conf({ fecha: '2026-11-01' })))).toBe('validacion')
    expect((await svc.confirmarRecurrente(parseConfirmar(conf({ mes: '2026-09', fecha: '2026-09-30' })), CTX)).id).toBe('REC-KEEPA-2026-09')
    expect(filasAud(s).length).toBeGreaterThan(0)
  })

  it('nunca se duplica: con otro requestId, 409; con el mismo, repetida', async () => {
    const s = new InMemoryFinanzasStore(FINANZAS, libro())
    const svc = servicio(s)
    const body = conf()
    await svc.confirmarRecurrente(parseConfirmar(body), CTX)
    expect((await svc.confirmarRecurrente(parseConfirmar(body), CTX)).repetida).toBe(true)
    expect(await codigo(svc.confirmarRecurrente(parseConfirmar(conf({ monto: '1' })), CTX))).toBe('recurrente-ya-confirmado')
    expect(filasMov(s).filter((f) => col(f, 'MOV_ID') === 'REC-KEEPA-2026-10')).toHaveLength(1)
    // Una fila escrita a mano en la hoja también cuenta como confirmada.
    const s2 = new InMemoryFinanzasStore(FINANZAS, libro({ MOVIMIENTOS: [ENC_MOV, mov('REC-KEEPA-2026-10', 400, { FUENTE: 'recurrente', CATEGORIA: 'Herramientas' })] }))
    expect(await codigo(servicio(s2).confirmarRecurrente(parseConfirmar(conf()), CTX))).toBe('recurrente-ya-confirmado')
  })

  it('auditado sin fila: otro requestId completa la fila DESDE LA AUDITORÍA; ya completo, 409', async () => {
    const s = new InMemoryFinanzasStore(FINANZAS, libro())
    const caida = new FallaEn(s, 'MOVIMIENTOS')
    expect(await codigo(servicio(caida).confirmarRecurrente(parseConfirmar(conf({ monto: '410' })), CTX))).toBe('escritura-fallida')
    expect(filasMov(s)).toHaveLength(2)
    const r = await servicio(s).confirmarRecurrente(parseConfirmar(conf({ monto: '999' })), CTX)
    expect(r).toEqual({ operacion: 'finanzas.recurrente.confirmar', id: 'REC-KEEPA-2026-10', repetida: true })
    const fila = filasMov(s).at(-1)!
    expect(col(fila, 'MONTO_MXN')).toBe(410)
    expect(await codigo(servicio(s).confirmarRecurrente(parseConfirmar(conf()), CTX))).toBe('recurrente-ya-confirmado')
  })
})

/* --------------------------------------- Criterio 7 --------------------------------------- */

/** Almacén que falla (o descarta) las escrituras de una pestaña. */
class FallaEn implements FinanzasStore {
  readonly libro: string
  constructor(private readonly inner: InMemoryFinanzasStore, private readonly tab: string, private readonly modo: 'falla' | 'descarta' = 'falla', public log: string[] = []) {
    this.libro = inner.libro
  }
  tabs() { return this.inner.tabs() }
  read(tabs: readonly FinanzasWriteTab[]) { return this.inner.read(tabs) }
  async append(tab: FinanzasWriteTab, rows: Celda[][]) {
    this.log.push(tab)
    if (tab === this.tab) {
      if (this.modo === 'falla') throw new Error('HTTP 503')
      return
    }
    return this.inner.append(tab, rows)
  }
}

describe('criterio 7: auditoría en FINANZAS antes de la fila y verificación después', () => {
  it('orden: AUDITORIA y luego MOVIMIENTOS; una fila por campo con el origen de finanzas', async () => {
    const s = new InMemoryFinanzasStore(FINANZAS, libro())
    const espia = new FallaEn(s, 'NINGUNA')
    const body = base()
    await servicio(espia).crearMovimiento(parseMovimiento(body), CTX)
    expect(espia.log).toEqual(['AUDITORIA', 'MOVIMIENTOS'])
    const aud = filasAud(s)
    expect(aud.length).toBeGreaterThan(5)
    for (const f of aud) {
      expect(f[ENC_AUD.indexOf('ENTIDAD')]).toBe('MOVIMIENTOS')
      expect(f[ENC_AUD.indexOf('REGISTRO_ID')]).toBe('MAN-0004')
      expect(f[ENC_AUD.indexOf('ACTOR')]).toBe(DUENO)
      expect(String(f[ENC_AUD.indexOf('ORIGEN')])).toMatch(new RegExp(`^dashboard-finanzas;modo=sheets;op=finanzas\\.movimiento\\.crear;req=${body.requestId};hash=[0-9a-f]{16}$`))
      expect(f[ENC_AUD.indexOf('AUDIT_ID')]).toMatch(/^AUD-20261024120000-ABCD1234-\d{2}-\d{2}$/)
    }
  })

  it.each(['AUDITORIA', 'RECURRENTES', 'MOVIMIENTOS'])('sin la pestaña %s: 400 finanzas-esquema-invalido y nada escrito', async (tab) => {
    for (const ruta of ['/api/finanzas/movimientos', '/api/finanzas/recurrentes/confirmar']) {
      const datos = libro()
      delete (datos as Record<string, unknown>)[tab]
      const h = arnes(ACTIVA, { datos })
      const r = await h.post(ruta, ruta.endsWith('confirmar') ? conf() : base())
      expect(r.status).toBe(400)
      expect((r.body.error as { codigo: string }).codigo).toBe('finanzas-esquema-invalido')
      expect(h.sheets.filter((c) => c.init.method === 'POST')).toHaveLength(0)
    }
  })

  it('MOVIMIENTOS sin AJUSTE_DE o con una columna repetida: 400 sin escribir', async () => {
    for (const enc of [ENC_MOV.slice(0, -1), [...ENC_MOV, 'FECHA']]) {
      const s = new InMemoryFinanzasStore(FINANZAS, libro({ MOVIMIENTOS: [enc] }))
      expect(await codigo(servicio(s).crearMovimiento(parseMovimiento(base()), CTX))).toBe('finanzas-esquema-invalido')
      expect(filasAud(s)).toHaveLength(0)
    }
  })

  it('falla la auditoría: auditoria-fallida y ninguna fila en MOVIMIENTOS', async () => {
    const s = new InMemoryFinanzasStore(FINANZAS, libro())
    expect(await codigo(servicio(new FallaEn(s, 'AUDITORIA')).crearMovimiento(parseMovimiento(base()), CTX))).toBe('auditoria-fallida')
    expect(filasMov(s)).toHaveLength(2)
  })

  it('falla la fila: escritura-fallida con la auditoría escrita; el reintento con el mismo requestId completa el mismo MAN', async () => {
    const s = new InMemoryFinanzasStore(FINANZAS, libro())
    const body = base()
    expect(await codigo(servicio(new FallaEn(s, 'MOVIMIENTOS')).crearMovimiento(parseMovimiento(body), CTX))).toBe('escritura-fallida')
    expect(filasAud(s).length).toBeGreaterThan(0)
    expect(filasMov(s)).toHaveLength(2)
    expect(await servicio(s).crearMovimiento(parseMovimiento(body), CTX)).toEqual({ operacion: 'finanzas.movimiento.crear', id: 'MAN-0004', repetida: true })
    expect(filasMov(s)).toHaveLength(3)
  })

  it('la fila no aparece al releer: verificacion-fallida', async () => {
    const s = new InMemoryFinanzasStore(FINANZAS, libro())
    expect(await codigo(servicio(new FallaEn(s, 'MOVIMIENTOS', 'descarta')).crearMovimiento(parseMovimiento(base()), CTX))).toBe('verificacion-fallida')
  })

  it('no se puede leer el libro: lectura-fallida y nada escrito', async () => {
    const roto: FinanzasStore = { libro: FINANZAS, tabs: async () => { throw new Error('HTTP 500') }, read: async () => ({}), append: async () => { throw new Error('no') } }
    expect(await codigo(servicio(roto).crearMovimiento(parseMovimiento(base()), CTX))).toBe('lectura-fallida')
  })

  it('la fila no coincide con lo auditado al repetir: estado-divergente', async () => {
    const s = new InMemoryFinanzasStore(FINANZAS, libro())
    const body = base()
    await servicio(s).crearMovimiento(parseMovimiento(body), CTX)
    const datos = s.snapshot()
    datos.MOVIMIENTOS!.at(-1)![ENC_MOV.indexOf('MONTO_MXN')] = 1
    expect(await codigo(servicio(new InMemoryFinanzasStore(FINANZAS, datos)).crearMovimiento(parseMovimiento(body), CTX))).toBe('estado-divergente')
  })
})

/* --------------------------------------- Criterio 8 --------------------------------------- */

describe('criterio 8: inercia sin cualquiera de las condiciones', () => {
  const faltas: Array<Record<string, string | undefined>> = [
    { FINANZAS_WRITE_MODE: undefined }, { FINANZAS_WRITE_MODE: 'SHEETS' }, { FINANZAS_SHEET_ID: undefined }, { FINANZAS_SHEET_ID: PROPIA },
    { FINANZAS_WRITE_SERVICE_ACCOUNT: undefined }, { FINANZAS_WRITE_SERVICE_ACCOUNT: LECTURA }, { FINANZAS_WRITE_SERVICE_ACCOUNT: ESCRITURA_POS },
    { FINANZAS_WRITER_EMAIL: undefined }, { FINANZAS_WRITER_EMAIL: `${DUENO},lector@example.com` }, { FINANZAS_WRITER_EMAIL: 'fuera@example.com' },
  ]
  it.each(faltas)('sin %o: 403, cero llamadas a los dobles de token y de fetch, en las dos rutas', async (over) => {
    for (const ruta of ['/api/finanzas/movimientos', '/api/finanzas/recurrentes/confirmar']) {
      const h = arnes({ ...ACTIVA, ...over })
      const r = await h.post(ruta, ruta.endsWith('confirmar') ? conf() : base())
      expect(r.status).toBe(403)
      expect((r.body.error as { codigo: string }).codigo).toBe('escritura-deshabilitada')
      expect(h.construidos).toBe(0)
      expect(h.fuentes + h.iam.length + h.sheets.length + h.otras.length).toBe(0)
    }
  })

  it('con todo activo pero otra cuenta en sesión: 403 sin-permiso-escritura y cero llamadas', async () => {
    const h = arnes(ACTIVA, { email: 'lector@example.com' })
    const r = await h.post('/api/finanzas/movimientos', base())
    expect(r.status).toBe(403)
    expect((r.body.error as { codigo: string }).codigo).toBe('sin-permiso-escritura')
    expect(h.fuentes + h.iam.length + h.sheets.length).toBe(0)
  })
})

/* --------------------------------------- Criterio 9 --------------------------------------- */

describe('criterio 9: render.mjs valida y agrega la escritura de finanzas', () => {
  const template = readFileSync(path.join(__dirname, '..', 'deploy', 'cloudrun', 'service.template.yaml'), 'utf8')
  const ACTUAL = {
    SERVICE_NAME: 'project-os-dashboard', PROJECT_ID: 'project-os-511102', REGION: 'northamerica-south1',
    IMAGE: `us-docker.pkg.dev/project-os-511102/repo/dash@sha256:${'a'.repeat(64)}`,
    RUNTIME_SA: LECTURA, SERVICE_URL: 'https://dash.example.com',
    OAUTH_CLIENT_ID: '123-abc.apps.googleusercontent.com', SECRET_VERSION_NEXTAUTH: '1', SECRET_VERSION_OAUTH: '1',
    SECRET_VERSION_ALLOWLIST: '1', WRITE_MODE: 'sheets', WRITE_SERVICE_ACCOUNT: ESCRITURA_POS, SECRET_VERSION_WRITERS: '1',
    FINANZAS_SHEET_ID: FINANZAS,
  }
  const LECT = { ...ACTUAL, WRITE_MODE: undefined, WRITE_SERVICE_ACCOUNT: undefined, SECRET_VERSION_WRITERS: undefined }
  const FIN = { FINANZAS_WRITE_MODE: 'sheets', FINANZAS_WRITE_SERVICE_ACCOUNT: CUENTA_FIN, FINANZAS_WRITER_EMAIL: DUENO }
  const bloque = `            - name: FINANZAS_WRITE_MODE\n              value: sheets\n            - name: FINANZAS_WRITE_SERVICE_ACCOUNT\n              value: ${CUENTA_FIN}\n            - name: FINANZAS_WRITER_EMAIL\n              value: '${DUENO}'\n`

  it('sin las tres variables (o vacías) el YAML no cambia', () => {
    for (const b of [ACTUAL, LECT]) {
      const sin = render(template, b)
      expect(sin).not.toContain('FINANZAS_WRITE')
      expect(render(template, { ...b, FINANZAS_WRITE_MODE: '', FINANZAS_WRITE_SERVICE_ACCOUNT: ' ', FINANZAS_WRITER_EMAIL: '' })).toBe(sin)
    }
  })

  it('con las tres válidas agrega solo ese bloque, con o sin escritura de PROJECT-OS', () => {
    for (const b of [ACTUAL, LECT]) {
      const con = render(template, { ...b, ...FIN })
      expect(con).toContain(bloque)
      expect(con.replace(bloque, '')).toBe(render(template, b))
    }
  })

  it.each([
    [{ FINANZAS_WRITE_MODE: 'disabled' }, 'FINANZAS_WRITE_MODE solo admite sheets'],
    [{ FINANZAS_WRITE_MODE: undefined }, 'van juntas'],
    [{ FINANZAS_WRITER_EMAIL: undefined }, 'van juntas'],
    [{ FINANZAS_WRITE_SERVICE_ACCOUNT: undefined }, 'van juntas'],
    [{ FINANZAS_SHEET_ID: undefined }, 'FINANZAS_WRITE_MODE exige FINANZAS_SHEET_ID'],
    [{ FINANZAS_WRITE_SERVICE_ACCOUNT: 'cuenta-secreta@gmail.com' }, 'FINANZAS_WRITE_SERVICE_ACCOUNT no tiene el formato esperado'],
    [{ FINANZAS_WRITE_SERVICE_ACCOUNT: LECTURA }, 'no puede ser la cuenta runtime'],
    [{ FINANZAS_WRITE_SERVICE_ACCOUNT: ESCRITURA_POS }, 'no puede ser la cuenta de escritura de PROJECT-OS'],
    [{ FINANZAS_WRITE_SERVICE_ACCOUNT: 'project-os-finanzas@otro-proyecto-1.iam.gserviceaccount.com' }, 'debe pertenecer a PROJECT_ID'],
    [{ FINANZAS_WRITER_EMAIL: `${DUENO},otro@example.com` }, 'FINANZAS_WRITER_EMAIL debe ser un único correo'],
    [{ FINANZAS_WRITER_EMAIL: "x'@example.com" }, 'FINANZAS_WRITER_EMAIL debe ser un único correo'],
  ])('%o: falla el render sin imprimir valores', (over, mensaje) => {
    let error = ''
    try {
      render(template, { ...ACTUAL, ...FIN, ...over })
    } catch (e) {
      error = (e as Error).message
    }
    expect(error).toContain(mensaje)
    for (const v of [CUENTA_FIN, DUENO, LECTURA, ESCRITURA_POS, 'cuenta-secreta', FINANZAS]) expect(error).not.toContain(v)
  })
  // deploy.sh --desde-activa las conserva y --quitar las retira juntas: tests/deploy-script.test.ts (ORD-POS-077).
})

/* ------------------------------- ORD-POS-079: hallazgos de 077 ------------------------------- */

describe('ORD-POS-079 criterio 1 (H1): el CONCEPTO final de un ajuste respeta los 80 caracteres', () => {
  const prefijo = 'Ajuste de MAN-0001: '

  it('el prefijo cuenta dentro del límite: 60 + 20 entra; 61 + 20, 400 con el motivo', async () => {
    expect(prefijo).toHaveLength(20)
    const cabe = parseMovimiento(base({ ajusteDe: 'MAN-0001', montoMxn: '-1', concepto: 'x'.repeat(60) }))
    expect(conceptoFinal(cabe)).toHaveLength(80)
    const e = await Promise.resolve().then(() => parseMovimiento(base({ ajusteDe: 'MAN-0001', montoMxn: '-1', concepto: 'x'.repeat(61) }))).catch((x: unknown) => x)
    expect((e as OperationError).code).toBe('validacion')
    expect((e as OperationError).fields?.concepto).toMatch(/hasta 60 caracteres/)
    // Sin ajuste, los 80 siguen valiendo.
    expect(conceptoFinal(parseMovimiento(base({ concepto: 'x'.repeat(80) })))).toHaveLength(80)
  })

  it('lo que se escribe en la hoja nunca pasa de 80, con o sin el prefijo ya escrito por el usuario', async () => {
    const s = new InMemoryFinanzasStore(FINANZAS, libro())
    const svc = servicio(s)
    await svc.crearMovimiento(parseMovimiento(base({ ajusteDe: 'MAN-0001', montoMxn: '-1', concepto: 'y'.repeat(60) })), CTX)
    await svc.crearMovimiento(parseMovimiento(base({ ajusteDe: 'MAN-0001', montoMxn: '-1', concepto: prefijo + 'z'.repeat(60) })), CTX)
    expect(await codigo(() => parseMovimiento(base({ ajusteDe: 'MAN-0001', montoMxn: '-1', concepto: prefijo + 'z'.repeat(61) })))).toBe('validacion')
    // Un 80 que empieza por = ganaría el apóstrofo: también se rechaza.
    expect(await codigo(() => parseMovimiento(base({ concepto: '=' + 'x'.repeat(79) })))).toBe('validacion')
    const conceptos = filasMov(s).slice(2).map((f) => String(col(f, 'CONCEPTO')))
    expect(conceptos).toEqual([prefijo + 'y'.repeat(60), prefijo + 'z'.repeat(60)])
    for (const c of conceptos) expect(c.length).toBeLessThanOrEqual(80)
  })
})

describe('ORD-POS-079 criterio 2 (H2): la cuenta de finanzas debe ser distinta de la de lectura, aunque falte SHEETS_EXPECTED_SERVICE_ACCOUNT', () => {
  it.each([undefined, '', '   '])('sin SHEETS_EXPECTED_SERVICE_ACCOUNT (%o): deshabilitada, no se puede comprobar', (lectura) => {
    const vars = env({ ...ACTIVA, SHEETS_EXPECTED_SERVICE_ACCOUNT: lectura })
    expect(finanzasWriteStatus(vars)).toEqual({ mode: 'disabled', reason: 'sin-cuenta-de-lectura' })
    expect(finanzasWriter(vars)).toBeNull()
    expect(finanzasCanWrite(DUENO, vars)).toBe(false)
  })

  it('con la cuenta de lectura declarada: igual (aun con otras mayúsculas) deshabilita; distinta, sheets', () => {
    expect(finanzasWriteStatus(env({ ...ACTIVA, SHEETS_EXPECTED_SERVICE_ACCOUNT: ` ${CUENTA_FIN.toUpperCase()} ` }))).toEqual({ mode: 'disabled', reason: 'cuenta-de-lectura' })
    expect(finanzasWriteStatus(env({ ...ACTIVA, SHEETS_EXPECTED_SERVICE_ACCOUNT: LECTURA }))).toEqual({ mode: 'sheets', reason: null })
  })
})

describe('ORD-POS-079 criterio 3 (H3): reenviar tras escritura-fallida no deja un MAN auditado sin fila ni huecos', () => {
  let n = 0
  const nuevoId = () => `00000000-0000-4000-9000-${String(++n).padStart(12, '0')}`

  /** Lo que haría el formulario: cuerpo según el estado, respuesta del servicio y estado siguiente. */
  async function enviarComoFormulario(svc: FinanzasWriteService, estado: EnvioEstado, formulario: Payload): Promise<[EnvioEstado, Respuesta]> {
    const cuerpo = cuerpoEnvio(estado, formulario)
    let respuesta: Respuesta
    try {
      await svc.crearMovimiento(parseMovimiento(cuerpo), CTX)
      respuesta = { ok: true }
    } catch (e) {
      respuesta = { ok: false, codigo: (e as OperationError).code }
    }
    return [trasRespuesta(estado, cuerpo, respuesta, nuevoId), respuesta]
  }

  /** Cada MAN- de la auditoría tiene su fila, y los MAN- van seguidos desde MAN-0001 (salvo el MAN-0002 del libro base). */
  function sinHuerfanosNiHuecos(s: InMemoryFinanzasStore) {
    const movs = new Set(filasMov(s).map((f) => String(col(f, 'MOV_ID'))))
    const auditados = new Set(filasAud(s).map((f) => String(f[ENC_AUD.indexOf('REGISTRO_ID')])))
    for (const id of auditados) expect(movs.has(id), id).toBe(true)
    const nums = [...movs].map((id) => Number(/^MAN-(\d{4})$/.exec(id)![1])).sort((a, b) => a - b)
    expect(nums).toEqual([1, ...Array.from({ length: nums.length - 1 }, (_, i) => i + 3)])
  }

  it.each([
    ['sin cambios', {}],
    ['con otro monto', { montoMxn: '999' }],
    ['con otro concepto y fecha', { concepto: 'Otro concepto', fecha: '2026-10-21' }],
  ])('%s: el reintento completa el mismo MAN con los datos auditados, y la siguiente alta sigue la numeración', async (_caso, cambio) => {
    const s = new InMemoryFinanzasStore(FINANZAS, libro())
    const formulario = { ...base(), requestId: undefined }
    let estado = estadoInicial(nuevoId)
    let r: Respuesta
    ;[estado, r] = await enviarComoFormulario(servicio(new FallaEn(s, 'MOVIMIENTOS')), estado, formulario)
    expect(r).toEqual({ ok: false, codigo: 'escritura-fallida' })
    expect(estado.congelado).not.toBeNull()

    // El usuario edita (o no) y reenvía: mismo requestId y mismo cuerpo, nunca 409 ni otro MAN.
    const requestId = estado.requestId
    expect(cuerpoEnvio(estado, { ...formulario, ...cambio }).requestId).toBe(requestId)
    ;[estado, r] = await enviarComoFormulario(servicio(s), estado, { ...formulario, ...cambio })
    expect(r).toEqual({ ok: true })
    expect(estado.congelado).toBeNull()
    expect(estado.requestId).not.toBe(requestId)
    const fila = filasMov(s).find((f) => col(f, 'MOV_ID') === 'MAN-0004')!
    expect([col(fila, 'MONTO_MXN'), col(fila, 'CONCEPTO')]).toEqual([123.45, 'Muestras de empaque'])

    // La siguiente alta con el formulario ya cambiado lleva el MAN siguiente: sin huecos ni huérfanos.
    ;[estado, r] = await enviarComoFormulario(servicio(s), estado, { ...formulario, ...cambio })
    expect(r).toEqual({ ok: true })
    expect(filasMov(s).map((f) => col(f, 'MOV_ID'))).toEqual(['MAN-0001', 'MAN-0003', 'MAN-0004', 'MAN-0005'])
    sinHuerfanosNiHuecos(s)
  })

  it('si el reintento vuelve a fallar sigue congelado con el mismo requestId; los fallos previos a la auditoría no congelan', async () => {
    const s = new InMemoryFinanzasStore(FINANZAS, libro())
    const formulario = { ...base(), requestId: undefined }
    let estado = estadoInicial(nuevoId)
    ;[estado] = await enviarComoFormulario(servicio(new FallaEn(s, 'MOVIMIENTOS')), estado, formulario)
    const congelado = estado
    ;[estado] = await enviarComoFormulario(servicio(new FallaEn(s, 'MOVIMIENTOS')), estado, { ...formulario, montoMxn: '5' })
    expect(estado).toBe(congelado)
    ;[estado] = await enviarComoFormulario(servicio(s), estado, formulario)
    expect(estado.congelado).toBeNull()
    sinHuerfanosNiHuecos(s)

    // Validación: nada auditado, el usuario corrige y el mismo requestId sirve.
    const antes = estado
    const [tras, r] = await enviarComoFormulario(servicio(s), estado, { ...formulario, concepto: 'ab' })
    expect(r).toEqual({ ok: false, codigo: 'validacion' })
    expect(tras).toBe(antes)
    for (const codigo of ['verificacion-fallida', 'auditoria-fallida', 'red', 'error', 'error-interno']) {
      expect(trasRespuesta(antes, { a: 1, requestId: antes.requestId }, { ok: false, codigo }, nuevoId), codigo).toEqual({ requestId: antes.requestId, congelado: { a: 1 } })
    }
  })

  it('ORD-POS-080 criterio 4: un error permanente descongela; con validacion se conserva el requestId y la corrección entra', async () => {
    const s = new InMemoryFinanzasStore(FINANZAS, libro())
    const formulario = { ...base(), requestId: undefined }
    let estado = estadoInicial(nuevoId)
    // El primer envío no tuvo respuesta (red) con un concepto que solo rechaza el servidor: queda congelado.
    estado = trasRespuesta(estado, cuerpoEnvio(estado, { ...formulario, concepto: 'ab' }), { ok: false, codigo: 'red' }, nuevoId)
    expect(estado.congelado).toMatchObject({ concepto: 'ab' })
    const requestId = estado.requestId
    let r: Respuesta
    // El reenvío del congelado da validacion: se descongela con el mismo requestId.
    ;[estado, r] = await enviarComoFormulario(servicio(s), estado, { ...formulario, concepto: 'Concepto corregido' })
    expect(r).toEqual({ ok: false, codigo: 'validacion' })
    expect(estado).toEqual({ requestId, congelado: null })
    // Ahora el formulario corregido sí se envía y entra.
    expect(cuerpoEnvio(estado, { ...formulario, concepto: 'Concepto corregido' }).concepto).toBe('Concepto corregido')
    ;[estado, r] = await enviarComoFormulario(servicio(s), estado, { ...formulario, concepto: 'Concepto corregido' })
    expect(r).toEqual({ ok: true })
    expect(filasMov(s).map((f) => [col(f, 'MOV_ID'), col(f, 'CONCEPTO')]).at(-1)).toEqual(['MAN-0004', 'Concepto corregido'])
    sinHuerfanosNiHuecos(s)
  })

  it('ORD-POS-080 criterio 4: auditoria-inconsistente y estado-divergente descongelan y renuevan el requestId; los pendientes no', () => {
    expect(CODIGOS_PERMANENTES).toEqual(['validacion', 'auditoria-inconsistente', 'estado-divergente'])
    const congelado: EnvioEstado = { requestId: 'rid-1', congelado: { a: 1 } }
    for (const codigo of ['auditoria-inconsistente', 'estado-divergente']) {
      const tras = trasRespuesta(congelado, { a: 1, requestId: 'rid-1' }, { ok: false, codigo }, nuevoId)
      expect(tras.congelado, codigo).toBeNull()
      expect(tras.requestId, codigo).not.toBe('rid-1')
      // Sin congelar también: ese requestId ya no puede entrar.
      expect(trasRespuesta({ requestId: 'rid-2', congelado: null }, { a: 2, requestId: 'rid-2' }, { ok: false, codigo }, nuevoId).requestId, codigo).not.toBe('rid-2')
    }
    for (const codigo of ['escritura-fallida', 'red', 'error', 'conflicto-idempotencia']) {
      expect(trasRespuesta(congelado, { a: 1, requestId: 'rid-1' }, { ok: false, codigo }, nuevoId), codigo).toBe(congelado)
    }
  })

  it('ORD-POS-080 criterio 4: en Ajustar, el ajusteDe enviado es siempre el original que se muestra', () => {
    const ajuste = { ...base(), requestId: undefined, ajusteDe: 'MAN-0001', montoMxn: '-10' }
    let estado = estadoInicial(nuevoId)
    // Sin congelar se muestra (y se envía) el elegido.
    expect(ajusteMostrado(estado, 'MAN-0001')).toEqual({ movId: 'MAN-0001', bloqueado: false })
    estado = trasRespuesta(estado, cuerpoEnvio(estado, ajuste), { ok: false, codigo: 'escritura-fallida' }, nuevoId)
    // Congelado: aunque el usuario elija otro original, se muestra el congelado con la lista bloqueada, y es el que se envía.
    const mostrado = ajusteMostrado(estado, 'MAN-0003')
    expect(mostrado).toEqual({ movId: 'MAN-0001', bloqueado: true })
    expect(cuerpoEnvio(estado, { ...ajuste, ajusteDe: 'MAN-0003' }).ajusteDe).toBe(mostrado.movId)
    // Al descongelar (error permanente) vuelve a mostrarse el elegido, que es el que se envía.
    estado = trasRespuesta(estado, cuerpoEnvio(estado, ajuste), { ok: false, codigo: 'validacion' }, nuevoId)
    expect(ajusteMostrado(estado, 'MAN-0003')).toEqual({ movId: 'MAN-0003', bloqueado: false })
    expect(cuerpoEnvio(estado, { ...ajuste, ajusteDe: 'MAN-0003' }).ajusteDe).toBe('MAN-0003')

    const src = readFileSync(path.join(__dirname, '..', 'src', 'components', 'finanzas', 'forms.tsx'), 'utf8')
    expect(src).toMatch(/const mostrado = ajusteMostrado\(envioVisible, movId\)/)
    expect(src).toMatch(/const original = ajustables\.find\(\(a\) => a\.movId === mostrado\.movId\)/)
    expect(src).toMatch(/<select required value=\{mostrado\.movId\} disabled=\{mostrado\.bloqueado\}/)
    expect(src).toMatch(/ajusteDe: original\.movId/)
  })
})
