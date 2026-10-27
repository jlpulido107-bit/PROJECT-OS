import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from '../deploy/cloudrun/render.mjs'
import { decide } from '@/lib/authz'
import { AGENT_OPERATIONS, type OperationName } from '@/lib/operations/constants'
import { OperationError } from '@/lib/operations/errors'
import { RateLimiter } from '@/lib/operations/rate-limit'
import { createWriteTokenProvider } from '@/lib/operations/write-credentials'
import type { EcoResult } from '@/lib/radaros/data'
import { construirEco } from '@/lib/radaros/eco'
import {
  COLUMNAS_COTIZACIONES, COLUMNAS_EMBARQUES, COLUMNAS_PRODUCTOS, COLUMNAS_PROVEEDORES, ETAPAS, paraLector, type Etapa,
} from '@/lib/radaros/pipeline'
import {
  ecoPipelineCanWrite, ecoPipelineWriteMode, ecoPipelineWriter, ecoPipelineWriteServiceAccount, ecoPipelineWriteStatus,
} from '@/lib/radaros/pipeline-escritura-config'
import { evaluateEcoWriteRequest } from '@/lib/radaros/pipeline-escritura-guard'
import { ecoPipelineWrite, type EcoHandlerDeps } from '@/lib/radaros/pipeline-escritura-handler'
import { COLUMNAS_AUDITORIA, ECO_OPERATIONS, EcoPipelineWriteService, type EcoOperationName } from '@/lib/radaros/pipeline-escritura-service'
import {
  EcoSheetsStore, InMemoryEcoStore, letraColumna, type Celda, type CeldaCambio, type EcoPipelineStore, type EcoWriteTab,
} from '@/lib/radaros/pipeline-escritura-store'
import { parseEco, parseIdRuta, parseMover } from '@/lib/radaros/pipeline-escritura-validacion'
import { TRANSICIONES } from '@/lib/radaros/pipeline-transiciones'

/**
 * Escritura del pipeline de /eco (ORD-POS-102, docs/diseno-eco-pipeline.md §4 a §7). Solo dobles de sesión, de token y
 * de fetch: ninguna prueba toca Google. Productos, proveedores, contactos, cuentas y correos inventados.
 */

const PROPIA = '16UXe7fm90fOTTVJhI_RZ8__I876u2buvjeLGr5cJ-Ic'
const RADAROS = 'LIBRO_RADAROS_SINTETICO_0123456789'
const FINANZAS = 'LIBRO_FINANZAS_SINTETICO_0123456789'
const LECTURA = 'project-os-dashboard-run@project-os-511102.iam.gserviceaccount.com'
const ESCRITURA_POS = 'project-os-writer@project-os-511102.iam.gserviceaccount.com'
const CUENTA_FIN = 'project-os-finanzas@project-os-511102.iam.gserviceaccount.com'
const CUENTA_AGENTE = 'project-os-fin-agente@project-os-511102.iam.gserviceaccount.com'
const CUENTA_ECO = 'project-os-eco@project-os-511102.iam.gserviceaccount.com'
const DUENO = 'dueno@example.com'
const ORIGIN = 'http://127.0.0.1:3000'
const PM_TOKEN = 'token-del-pm-sintetico-0123456789'
const PM_HASH = createHash('sha256').update(PM_TOKEN).digest('hex')
const FIN_TOKEN = 'token-del-agente-de-finanzas-sintetico-0123'
const FIN_HASH = createHash('sha256').update(FIN_TOKEN).digest('hex')
// 2026-10-24 12:00 en Mérida (UTC−6): «hoy» = 2026-10-24.
const NOW = new Date(Date.UTC(2026, 9, 24, 18, 0, 0))
const STAMP = '2026-10-24T12:00:00-06:00'

const ACTIVA: Record<string, string> = {
  NEXTAUTH_URL: ORIGIN,
  AUTH_ALLOWED_EMAILS: `lector@example.com, ${DUENO}`,
  SHEETS_SPREADSHEET_ID: PROPIA,
  SHEETS_EXPECTED_SERVICE_ACCOUNT: LECTURA,
  PROJECT_OS_WRITE_SERVICE_ACCOUNT: ESCRITURA_POS,
  FINANZAS_SHEET_ID: FINANZAS,
  FINANZAS_WRITE_SERVICE_ACCOUNT: CUENTA_FIN,
  FINANZAS_AGENTE_SERVICE_ACCOUNT: CUENTA_AGENTE,
  RADAROS_SHEET_ID: RADAROS,
  ECO_PIPELINE_WRITE_MODE: 'sheets',
  ECO_PIPELINE_WRITE_SERVICE_ACCOUNT: CUENTA_ECO,
  ECO_PIPELINE_WRITER_EMAIL: DUENO,
  PM_AGENT_TOKEN_SHA256: PM_HASH,
  FINANZAS_AGENTE_TOKEN_SHA256: FIN_HASH,
}
const env = (vars: Record<string, string | undefined>) => vars as unknown as NodeJS.ProcessEnv

/* ------------------------------------- Libro sintético ------------------------------------- */

type Rec = Record<string, Celda>
const fila = (cols: readonly string[], r: Rec): Celda[] => cols.map((c) => r[c] ?? '')
const prd = (id: string, etapa: Etapa, r: Rec = {}) => fila(COLUMNAS_PRODUCTOS, { PRODUCTO_ID: id, NOMBRE: `Producto ${id}`, ORIGEN: 'MANUAL', ETAPA: etapa, ETAPA_DESDE: '2026-10-01T09:00:00-06:00', VERSION: 1, ...r })
const prv = (id: string, estado = 'ACTIVO', r: Rec = {}) => fila(COLUMNAS_PROVEEDORES, { PROVEEDOR_ID: id, NOMBRE: `Proveedor ${id}`, CANAL: 'ALIBABA', PAIS: 'CN', ESTADO: estado, VERSION: 1, ...r })
const cot = (id: string, producto: string, proveedor: string, estado: string, r: Rec = {}) => fila(COLUMNAS_COTIZACIONES, { COTIZACION_ID: id, PRODUCTO_ID: producto, PROVEEDOR_ID: proveedor, ESTADO: estado, MUESTRA_ESTADO: 'NO_PEDIDA', VERSION: 1, ...r })
const RECIBIDA = { PRECIO_UNIT: 2.5, MONEDA: 'USD', MOQ: 500, PLAZO_PRODUCCION_DIAS: 20, INCOTERM: 'FOB' }

function libro(over: Partial<Record<string, unknown[][]>> = {}) {
  return {
    PIPE_PRODUCTOS: [[...COLUMNAS_PRODUCTOS], prd('PRD-0001', 'SUGERIDO', { ASIN: 'B000000001' }), prd('PRD-0002', 'EVALUANDO', { VERSION: 2 }), prd('PRD-0003', 'COTIZANDO', { COSTO_MAX_MXN: 150 })],
    PIPE_PROVEEDORES: [[...COLUMNAS_PROVEEDORES], prv('PRV-0001'), prv('PRV-0002', 'INACTIVO')],
    PIPE_COTIZACIONES: [[...COLUMNAS_COTIZACIONES]],
    PIPE_EMBARQUES: [[...COLUMNAS_EMBARQUES]],
    PIPE_AUDITORIA: [[...COLUMNAS_AUDITORIA]],
    PIPE_PARAMETROS: [['CLAVE', 'VALOR']],
    SCORING: [['IDEA_ID'], ['EC-004']],
    ...over,
  }
}

let seq = 0
const rid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`
const CTX = { actor: DUENO }
const servicio = (store: EcoPipelineStore) => new EcoPipelineWriteService(store, { clock: () => NOW, randomHex: () => 'abcd1234' })

async function codigo(p: Promise<unknown> | (() => unknown)) {
  const e = await (typeof p === 'function' ? Promise.resolve().then(p) : p).catch((x: unknown) => x)
  expect(e).toBeInstanceOf(OperationError)
  return (e as OperationError).code
}

const tabla = (s: InMemoryEcoStore, tab: string) => s.snapshot()[tab]!
const registro = (s: InMemoryEcoStore, tab: string, id: string): Record<string, unknown> => {
  const [header, ...rows] = tabla(s, tab)
  const row = rows.find((r) => r[0] === id)
  return row ? Object.fromEntries(header!.map((h, i) => [h, row[i] ?? ''])) : {}
}
const auditoria = (s: InMemoryEcoStore) => tabla(s, 'PIPE_AUDITORIA').slice(1).map((r) => Object.fromEntries(COLUMNAS_AUDITORIA.map((c, i) => [c, r[i] ?? ''])))

const crearProducto = (svc: EcoPipelineWriteService, body: Record<string, unknown> = {}) => svc.crearProducto(parseEco('eco.producto.crear', { requestId: rid(), nombre: 'Termo sintético', ...body }), CTX)
const mover = (svc: EcoPipelineWriteService, id: string, desde: Etapa, a: Etapa, version: number, motivo?: string) =>
  svc.moverProducto(id, parseMover({ requestId: rid(), expectedVersion: version, expectedEtapa: desde, etapa: a, ...(motivo ? { motivo } : {}) }), CTX)

/* ------------------------------------------ Criterio 1 ------------------------------------------ */

describe('criterio 1: configuración de §7.1 (modo, libro, cuenta propia y escritor único)', () => {
  it('con todas las condiciones: sheets, y solo el escritor puede', () => {
    expect(ecoPipelineWriteStatus(env(ACTIVA))).toEqual({ mode: 'sheets', reason: null })
    expect(ecoPipelineWriter(env(ACTIVA))).toBe(DUENO)
    expect(ecoPipelineCanWrite(' Dueno@Example.com ', env(ACTIVA))).toBe(true)
    expect(ecoPipelineCanWrite('lector@example.com', env(ACTIVA))).toBe(false)
    expect(ecoPipelineCanWrite(null, env(ACTIVA))).toBe(false)
  })

  it.each([
    [{ ECO_PIPELINE_WRITE_MODE: undefined }, 'deshabilitada'],
    [{ ECO_PIPELINE_WRITE_MODE: 'disabled' }, 'deshabilitada'],
    [{ ECO_PIPELINE_WRITE_MODE: 'Sheets' }, 'modo-invalido'],
    [{ ECO_PIPELINE_WRITE_MODE: ' sheets' }, 'modo-invalido'],
    [{ ECO_PIPELINE_WRITE_MODE: 'mock' }, 'modo-invalido'],
    [{ RADAROS_SHEET_ID: undefined }, 'sin-libro'],
    [{ RADAROS_SHEET_ID: 'corto' }, 'sin-libro'],
    [{ RADAROS_SHEET_ID: PROPIA }, 'sin-libro'],
    [{ ECO_PIPELINE_WRITE_SERVICE_ACCOUNT: undefined }, 'sin-cuenta'],
    [{ ECO_PIPELINE_WRITE_SERVICE_ACCOUNT: 'dueno@gmail.com' }, 'sin-cuenta'],
    [{ SHEETS_EXPECTED_SERVICE_ACCOUNT: undefined }, 'sin-cuenta-de-lectura'],
    [{ ECO_PIPELINE_WRITE_SERVICE_ACCOUNT: LECTURA }, 'cuenta-de-lectura'],
    [{ ECO_PIPELINE_WRITE_SERVICE_ACCOUNT: ESCRITURA_POS.toUpperCase() }, 'cuenta-de-project-os'],
    [{ ECO_PIPELINE_WRITE_SERVICE_ACCOUNT: CUENTA_FIN }, 'cuenta-de-finanzas'],
    [{ ECO_PIPELINE_WRITE_SERVICE_ACCOUNT: CUENTA_AGENTE }, 'cuenta-del-agente-de-finanzas'],
    [{ ECO_PIPELINE_WRITER_EMAIL: undefined }, 'sin-escritor'],
    [{ ECO_PIPELINE_WRITER_EMAIL: 'no-es-correo' }, 'sin-escritor'],
    [{ ECO_PIPELINE_WRITER_EMAIL: `${DUENO}, lector@example.com` }, 'escritor-ambiguo'],
    [{ ECO_PIPELINE_WRITER_EMAIL: `${DUENO};lector@example.com` }, 'escritor-ambiguo'],
    [{ ECO_PIPELINE_WRITER_EMAIL: 'otro@example.com' }, 'escritor-no-permitido'],
    [{ AUTH_ALLOWED_EMAILS: 'lector@example.com' }, 'escritor-no-permitido'],
  ])('falta una condición (%o): deshabilitada con motivo %s y nadie escribe', (over, reason) => {
    const vars = env({ ...ACTIVA, ...over })
    expect(ecoPipelineWriteStatus(vars)).toEqual({ mode: 'disabled', reason })
    expect(ecoPipelineWriteMode(vars)).toBe('disabled')
    expect(ecoPipelineWriter(vars)).toBeNull()
    expect(ecoPipelineCanWrite(DUENO, vars)).toBe(false)
  })

  it('no depende de las otras escrituras: ni PROJECT_OS_WRITE_MODE, ni FINANZAS_WRITE_MODE, ni sus escritores', () => {
    expect(ecoPipelineWriteMode(env({ ...ACTIVA, PROJECT_OS_WRITE_MODE: 'disabled', FINANZAS_WRITE_MODE: 'disabled', AUTH_WRITER_EMAILS: '' }))).toBe('sheets')
    const sinEco = { ...ACTIVA, ECO_PIPELINE_WRITE_MODE: undefined, PROJECT_OS_WRITE_MODE: 'sheets', FINANZAS_WRITE_MODE: 'sheets', AUTH_WRITER_EMAILS: DUENO, FINANZAS_WRITER_EMAIL: DUENO }
    expect(ecoPipelineWriteMode(env(sinEco))).toBe('disabled')
    expect(ecoPipelineCanWrite(DUENO, env({ ...ACTIVA, ECO_PIPELINE_WRITER_EMAIL: 'lector@example.com', FINANZAS_WRITER_EMAIL: DUENO, AUTH_WRITER_EMAILS: DUENO }))).toBe(false)
  })

  it('la cuenta se valida con formato de cuenta de servicio y se normaliza', () => {
    expect(ecoPipelineWriteServiceAccount(env({ ECO_PIPELINE_WRITE_SERVICE_ACCOUNT: ` ${CUENTA_ECO.toUpperCase()} ` }))).toBe(CUENTA_ECO)
    expect(ecoPipelineWriteServiceAccount(env({ ECO_PIPELINE_WRITE_SERVICE_ACCOUNT: 'x@proyecto.iam.gserviceaccount.com' }))).toBeNull()
  })
})

/* ---------------------------------------- Arnés HTTP ---------------------------------------- */

interface Llamada { url: string; init: RequestInit }

/** Handler con dobles: sesión, token de origen, IAM y Sheets (este último sirve un libro en memoria). */
function arnes(vars: Record<string, string | undefined>, opts: { email?: string | null; datos?: Partial<Record<string, unknown[][]>> } = {}) {
  const memoria = new InMemoryEcoStore(RADAROS, opts.datos ?? libro())
  const iam: Llamada[] = []
  const sheets: Llamada[] = []
  const otras: Llamada[] = []
  let sesiones = 0
  let fuentes = 0
  let construidos = 0
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (url.startsWith('https://iamcredentials.googleapis.com/')) {
      iam.push({ url, init })
      return new Response(JSON.stringify({ accessToken: 'token-eco', expireTime: '2026-10-24T18:10:00Z' }), { status: 200 })
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
      const tabs = u.searchParams.getAll('ranges').map((r) => r.slice(1, r.indexOf("'!")) as EcoWriteTab)
      const datos = await memoria.read(tabs)
      return new Response(JSON.stringify({ valueRanges: tabs.map((t) => ({ values: datos[t] ?? [] })) }), { status: 200 })
    }
    if (u.pathname.endsWith('/values:batchUpdate') && init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { valueInputOption: string; data: Array<{ range: string; values: Celda[][] }> }
      for (const d of body.data) {
        const m = /^'([A-Z_]+)'!([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(d.range)!
        const columna = [...m[2]!].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1
        await memoria.update(m[1] as EcoWriteTab, Number(m[3]), [{ columna, valor: d.values[0]![0]! }])
      }
      return new Response('{}', { status: 200 })
    }
    const append = /\/values\/'([A-Z_]+)'!A1:append$/.exec(decodeURIComponent(u.pathname))
    if (append && init.method === 'POST') {
      await memoria.append(append[1] as EcoWriteTab, (JSON.parse(String(init.body)) as { values: Celda[][] }).values)
      return new Response('{}', { status: 200 })
    }
    const formulas = /\/values\/'([A-Z_]+)'!A(\d+):AZ\d+$/.exec(decodeURIComponent(u.pathname))
    if (formulas && u.searchParams.get('valueRenderOption') === 'FORMULA') {
      return new Response(JSON.stringify({ values: [await memoria.formulas(formulas[1] as EcoWriteTab, Number(formulas[2]))] }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
  const vars2 = env(vars)
  const deps: EcoHandlerDeps = {
    sessionEmail: async () => {
      sesiones += 1
      return opts.email === undefined ? DUENO : opts.email
    },
    env: vars2,
    limiter: new RateLimiter(10, 3_000),
    service: () => {
      construidos += 1
      const token = createWriteTokenProvider(ecoPipelineWriteServiceAccount(vars2)!, { sourceToken: async () => `fuente-${++fuentes}`, fetchImpl, now: () => NOW.getTime() })
      return new EcoPipelineWriteService(new EcoSheetsStore({ spreadsheetId: vars2.RADAROS_SHEET_ID!, getWriteToken: token, fetchImpl }), { clock: () => NOW, randomHex: () => 'abcd1234' })
    },
  }
  async function llamar(metodo: 'POST' | 'PATCH', ruta: string, body: unknown, headers: Record<string, string> = {}) {
    const req = new Request(`${ORIGIN}${ruta}`, {
      method: metodo, body: JSON.stringify(body),
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-project-os-csrf': '1', 'sec-fetch-site': 'same-origin', ...headers },
    })
    const partes = ruta.split('/')
    return ecoPipelineWrite(req, deps, 'prueba', (service, b, ctx) => {
      if (ruta.endsWith('/etapa')) return service.moverProducto(parseIdRuta('PRD', partes[5]!), parseMover(b), ctx)
      if (ruta === '/api/eco/pipeline/productos') return service.crearProducto(parseEco('eco.producto.crear', b), ctx)
      if (ruta.startsWith('/api/eco/pipeline/productos/')) return service.editarProducto(parseIdRuta('PRD', partes[5]!), parseEco('eco.producto.editar', b), ctx)
      if (ruta === '/api/eco/pipeline/proveedores') return service.crearProveedor(parseEco('eco.proveedor.crear', b), ctx)
      return service.editarProveedor(parseIdRuta('PRV', partes[5]!), parseEco('eco.proveedor.editar', b), ctx)
    }, metodo === 'POST' && !ruta.endsWith('/etapa') ? 201 : 200)
  }
  return {
    llamar, memoria, iam, sheets, otras, deps,
    get sesiones() { return sesiones },
    get fuentes() { return fuentes },
    get construidos() { return construidos },
  }
}

/* ------------------------------------------ Criterio 2 ------------------------------------------ */

describe('criterio 2: guard propio sin rama de agente (§4.1 y §4.2)', () => {
  it('el token del PM, el del agente de finanzas y cualquier Authorization: 401 antes de sesión, cuerpo, token o Sheets', async () => {
    for (const authorization of [`Bearer ${PM_TOKEN}`, `Bearer ${FIN_TOKEN}`, 'Basic abc', 'Bearer otro']) {
      for (const cookie of [undefined, 'next-auth.session-token=valida']) {
        const h = arnes(ACTIVA)
        let leido = false
        const body = new ReadableStream({ pull(c) { leido = true; c.enqueue(new TextEncoder().encode('{}')); c.close() } }, { highWaterMark: 0 })
        const req = new Request(`${ORIGIN}/api/eco/pipeline/productos`, {
          method: 'POST', body, duplex: 'half',
          headers: { authorization, origin: ORIGIN, 'content-type': 'application/json', 'x-project-os-csrf': '1', ...(cookie ? { cookie } : {}) },
        } as RequestInit)
        const r = await ecoPipelineWrite(req, h.deps, 'prueba', async () => { throw new Error('no debe correr') })
        expect(r.status).toBe(401)
        expect((r.body.error as { codigo: string }).codigo).toBe('no-autenticado')
        expect(leido).toBe(false)
        expect(req.bodyUsed).toBe(false)
        expect(h.sesiones).toBe(0)
        expect(h.construidos).toBe(0)
        expect(h.iam.length + h.sheets.length + h.fuentes).toBe(0)
      }
    }
    const req = new Request(`${ORIGIN}/api/eco/pipeline/productos`, { method: 'POST', body: '{}', headers: { authorization: 'Basic abc' } })
    expect(await codigo(evaluateEcoWriteRequest(req, { email: DUENO, env: env(ACTIVA), limiter: new RateLimiter() }))).toBe('no-autenticado')
  })

  it('el proxy nunca trata /api/eco/ como de un agente: con el token válido del PM o del agente de finanzas, no autenticado', async () => {
    const rutas: Array<[string, string]> = [
      ['POST', '/api/eco/pipeline/productos'], ['PATCH', '/api/eco/pipeline/productos/PRD-0001'], ['POST', '/api/eco/pipeline/productos/PRD-0001/etapa'],
      ['POST', '/api/eco/pipeline/proveedores'], ['PATCH', '/api/eco/pipeline/cotizaciones/COT-0001'], ['POST', '/api/eco/pipeline/embarques'],
    ]
    for (const [method, ruta] of rutas) {
      for (const token of [PM_TOKEN, FIN_TOKEN]) {
        const req = new NextRequest(new URL(ruta, ORIGIN), { method, headers: { authorization: `Bearer ${token}` } })
        expect((await decide(req, { secret: 'secreto-de-prueba-0123456789abcdef', agentTokenSha256: PM_HASH, finanzasAgenteTokenSha256: FIN_HASH })).action, `${method} ${ruta}`).toBe('unauthenticated')
      }
    }
    // Control: la misma credencial del PM sí vale en una ruta de su lista.
    const ok = new NextRequest(new URL('/api/operaciones/tareas', ORIGIN), { method: 'POST', headers: { authorization: `Bearer ${PM_TOKEN}` } })
    expect((await decide(ok, { secret: 'x', agentTokenSha256: PM_HASH })).action).toBe('agent')
  })

  it('AGENT_ROUTES, FINANZAS_AGENT_ROUTES y AGENT_OPERATIONS no cambian y no nombran /api/eco ni eco.*', () => {
    expect(AGENT_OPERATIONS).toEqual(['tarea.crear', 'tarea.editar', 'decision.crear', 'orden.crear', 'orden.aprobar'])
    for (const op of ECO_OPERATIONS) expect((AGENT_OPERATIONS as readonly string[]).includes(op)).toBe(false)
    const authz = readFileSync(path.join(__dirname, '..', 'src', 'lib', 'authz.ts'), 'utf8')
    const lista = (nombre: string) => authz.slice(authz.indexOf(`const ${nombre}`), authz.indexOf(']\n', authz.indexOf(`const ${nombre}`)) + 1)
    expect(lista('AGENT_ROUTES')).toBe([
      'const AGENT_ROUTES: Array<[method: string, path: RegExp]> = [',
      "  ['POST', /^\\/api\\/operaciones\\/(tareas|decisiones|ordenes)\\/?$/],",
      "  ['PATCH', /^\\/api\\/operaciones\\/(tareas|ordenes)\\/[^/]+\\/?$/],",
      ']',
    ].join('\n'))
    expect(lista('FINANZAS_AGENT_ROUTES')).toBe([
      'const FINANZAS_AGENT_ROUTES: Array<[method: string, path: RegExp]> = [',
      "  ['POST', /^\\/api\\/finanzas\\/agente\\/(rendimiento|cargo-extra)\\/?$/],",
      ']',
    ].join('\n'))
    expect(authz).not.toMatch(/\/api\/eco|api\\\/eco|ECO_PIPELINE/)
  })

  it('las 9 operaciones son de su propio tipo, disjunto de OperationName (prueba de tipos)', () => {
    // Si alguna eco.* entrara en OperationName, `Comun` dejaría de ser never y esta línea no compilaría (npm run typecheck).
    type Comun = Extract<EcoOperationName, OperationName>
    const disjuntos: [Comun] extends [never] ? true : false = true
    expect(disjuntos).toBe(true)
    expect(ECO_OPERATIONS).toHaveLength(9)
  })

  it('el guard no reutiliza el de operaciones ni el de finanzas', () => {
    const guard = readFileSync(path.join(__dirname, '..', 'src', 'lib', 'radaros', 'pipeline-escritura-guard.ts'), 'utf8')
    expect(guard).not.toMatch(/operations\/guard'|finanzas\/|PM_AGENT_TOKEN|FINANZAS_AGENTE|agentLimiter|AGENT_|evaluateWriteRequest\(|evaluateFinanzasWriteRequest\(/)
  })

  it('orden de verificaciones: 401, 403 lector, 403 origen/CSRF, 403 modo, 403 escritor, 415, 413, 429 (10 y 1 cada 3 s), 400 JSON', async () => {
    const req = (headers: Record<string, string> = {}, body = '{}') => new Request(`${ORIGIN}/api/eco/pipeline/productos`, {
      method: 'POST', body, headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-project-os-csrf': '1', ...headers },
    })
    const ctx = (email: string | null, vars = ACTIVA, limiter = new RateLimiter()) => ({ email, env: env(vars), limiter })
    expect(await codigo(evaluateEcoWriteRequest(req(), ctx(null)))).toBe('no-autenticado')
    expect(await codigo(evaluateEcoWriteRequest(req(), ctx('extrano@example.com')))).toBe('sin-permiso-lectura')
    expect(await codigo(evaluateEcoWriteRequest(req({ 'x-project-os-csrf': '0' }), ctx(DUENO)))).toBe('origen-invalido')
    expect(await codigo(evaluateEcoWriteRequest(req({ origin: 'https://otro.example.com' }), ctx(DUENO)))).toBe('origen-invalido')
    expect(await codigo(evaluateEcoWriteRequest(req({ 'sec-fetch-site': 'cross-site' }), ctx(DUENO)))).toBe('origen-invalido')
    expect(await codigo(evaluateEcoWriteRequest(req(), ctx(DUENO, { ...ACTIVA, ECO_PIPELINE_WRITE_MODE: '' })))).toBe('escritura-deshabilitada')
    // Fuera de modo, ni el escritor de PROJECT-OS ni el de finanzas pasan; con modo, solo ECO_PIPELINE_WRITER_EMAIL.
    expect(await codigo(evaluateEcoWriteRequest(req(), ctx('lector@example.com', { ...ACTIVA, AUTH_WRITER_EMAILS: 'lector@example.com', FINANZAS_WRITER_EMAIL: 'lector@example.com' })))).toBe('sin-permiso-escritura')
    expect(await codigo(evaluateEcoWriteRequest(req({ 'content-type': 'text/plain' }), ctx(DUENO)))).toBe('tipo-contenido')
    expect(await codigo(evaluateEcoWriteRequest(req({ 'content-length': String(64 * 1024) }), ctx(DUENO)))).toBe('payload-demasiado-grande')
    expect(await codigo(evaluateEcoWriteRequest(req({}, 'no json'), ctx(DUENO)))).toBe('json-invalido')
    let t = 0
    const limiter = new RateLimiter(10, 3_000, () => t)
    for (let i = 0; i < 10; i++) await evaluateEcoWriteRequest(req(), ctx(DUENO, ACTIVA, limiter))
    expect(await codigo(evaluateEcoWriteRequest(req(), ctx(DUENO, ACTIVA, limiter)))).toBe('demasiadas-solicitudes')
    t = 3_000
    await evaluateEcoWriteRequest(req(), ctx(DUENO, ACTIVA, limiter))
    expect(await codigo(evaluateEcoWriteRequest(req(), ctx(DUENO, ACTIVA, limiter)))).toBe('demasiadas-solicitudes')
  })
})

/* ------------------------------------------ Criterio 3 ------------------------------------------ */

describe('criterio 3: las 9 operaciones, IDs de §3, expectedVersion e idempotencia', () => {
  it('nueve rutas, ninguna DELETE ni GET, y cada una por handleEcoWrite con su operación', () => {
    const dir = path.join(__dirname, '..', 'src', 'app', 'api', 'eco')
    const archivos = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(path.join(d, n)).isDirectory() ? archivos(path.join(d, n)) : [path.join(d, n)]))
    const rutas = archivos(dir).map((f) => readFileSync(f, 'utf8'))
    expect(rutas).toHaveLength(9)
    const ops = new Set<string>()
    for (const text of rutas) {
      expect(text).toMatch(/handleEcoWrite\(request, 'eco\.[a-z]+\.[a-z]+'/)
      expect(text).not.toMatch(/export (async )?function (GET|PUT|DELETE)|export const (GET|PUT|PATCH|POST|DELETE)/)
      ops.add(/handleEcoWrite\(request, '([^']+)'/.exec(text)![1]!)
    }
    expect([...ops].sort()).toEqual([...ECO_OPERATIONS].sort())
  })

  it('eco.producto.crear: PRD-NNNN siguiente al máximo de la pestaña y de la auditoría, alta en SUGERIDO, VERSION 1', async () => {
    const s = new InMemoryEcoStore(RADAROS, libro())
    const r = await crearProducto(servicio(s), { asin: 'B0ABCDEFGH', costoMaxMxn: '120.5', k1: 'alto', keepaBsrAvg90: '1500', notas: 'Línea 1\nLínea 2' })
    expect(r).toEqual({ operacion: 'eco.producto.crear', id: 'PRD-0004', version: 1, repetida: false })
    expect(registro(s, 'PIPE_PRODUCTOS', 'PRD-0004')).toMatchObject({
      NOMBRE: 'Termo sintético', ASIN: 'B0ABCDEFGH', ORIGEN: 'MANUAL', ETAPA: 'SUGERIDO', ETAPA_DESDE: STAMP, COSTO_MAX_MXN: 120.5,
      KEEPA_BSR_AVG90: 1500, K1: 'alto', NOTAS: 'Línea 1\nLínea 2', CREADO: STAMP, ACTUALIZADO: STAMP, VERSION: 1,
    })
    const aud = auditoria(s)
    expect(new Set(aud.map((a) => a.ENTIDAD))).toEqual(new Set(['PIPE_PRODUCTOS']))
    expect(aud.find((a) => a.CAMPO === 'ETAPA')).toMatchObject({ REGISTRO_ID: 'PRD-0004', VALOR_ANTES: '', VALOR_DESPUES: 'SUGERIDO', ACTOR: DUENO })
    expect(String(aud[0]!.ORIGEN)).toMatch(/^dashboard-eco;modo=sheets;req=[0-9a-f-]{36};hash=[0-9a-f]{16}$/)
    // Un ID que solo queda en la auditoría (fila borrada a mano) no se reutiliza; tras PRD-9999 siguen más dígitos.
    const s2 = new InMemoryEcoStore(RADAROS, libro({ PIPE_AUDITORIA: [[...COLUMNAS_AUDITORIA], ['AUD-1', '', '', 'PIPE_PRODUCTOS', 'PRD-0042', 'NOMBRE', '', 'x', 'a-mano']] }))
    expect((await crearProducto(servicio(s2))).id).toBe('PRD-0043')
    const s3 = new InMemoryEcoStore(RADAROS, libro({ PIPE_PRODUCTOS: [[...COLUMNAS_PRODUCTOS], prd('PRD-9999', 'SUGERIDO')] }))
    expect((await crearProducto(servicio(s3))).id).toBe('PRD-10000')
  })

  it('validación del alta: campos cerrados, sin fórmulas, ASIN único (también contra descartados) y proveedor ACTIVO', async () => {
    const s = new InMemoryEcoStore(RADAROS, libro())
    for (const malo of [{ nombre: '' }, { nombre: 'x'.repeat(121) }, { asin: 'b000000001' }, { asin: 'B0123' }, { costoMaxMxn: '-1' }, { costoMaxMxn: '1.234' }, { k1: 'x'.repeat(41) }, { ideaId: 'idea' }, { proveedorElegidoId: 'P-1' }, { keepaFecha: '2026-13-01' }, { requestId: 'no' }, { nombre: '=HYPERLINK("x")' }, { nombre: '+1' }, { notas: '@usuario' }]) {
      expect(await codigo(() => parseEco('eco.producto.crear', { requestId: rid(), nombre: 'ok', ...malo })), JSON.stringify(malo)).toBe('validacion')
    }
    for (const sobra of [{ etapa: 'EN_VENTA' }, { origen: 'RADAR_KEEPA' }, { version: 3 }, { productoId: 'PRD-0001' }, { rango: "'SCORING'!A1" }]) {
      expect(await codigo(() => parseEco('eco.producto.crear', { requestId: rid(), nombre: 'ok', ...sobra })), JSON.stringify(sobra)).toBe('campo-no-permitido')
    }
    expect(await codigo(crearProducto(servicio(s), { asin: 'B000000001' }))).toBe('asin-duplicado')
    const conDescartado = new InMemoryEcoStore(RADAROS, libro({ PIPE_PRODUCTOS: [[...COLUMNAS_PRODUCTOS], prd('PRD-0001', 'DESCARTADO', { ASIN: 'B000000009' })] }))
    expect(await codigo(crearProducto(servicio(conDescartado), { asin: 'B000000009' }))).toBe('asin-duplicado')
    expect(await codigo(crearProducto(servicio(s), { proveedorElegidoId: 'PRV-0002' }))).toBe('referencia-inexistente')
    expect(await codigo(crearProducto(servicio(s), { proveedorElegidoId: 'PRV-0099' }))).toBe('referencia-inexistente')
    expect(auditoria(s)).toHaveLength(0)
  })

  it('eco.producto.editar: solo cambia lo enviado, exige expectedVersion y sube VERSION; nunca ETAPA', async () => {
    const s = new InMemoryEcoStore(RADAROS, libro())
    const svc = servicio(s)
    const editar = (id: string, body: Record<string, unknown>) => svc.editarProducto(id, parseEco('eco.producto.editar', { requestId: rid(), ...body }), CTX)
    expect(await editar('PRD-0002', { expectedVersion: 2, costoMaxMxn: 99, notas: 'nota' })).toEqual({ operacion: 'eco.producto.editar', id: 'PRD-0002', version: 3, repetida: false })
    expect(registro(s, 'PIPE_PRODUCTOS', 'PRD-0002')).toMatchObject({ COSTO_MAX_MXN: 99, NOTAS: 'nota', VERSION: 3, ACTUALIZADO: STAMP, ETAPA: 'EVALUANDO' })
    const aud = auditoria(s)
    expect(aud.map((a) => a.CAMPO).sort()).toEqual(['ACTUALIZADO', 'COSTO_MAX_MXN', 'NOTAS', 'VERSION'])
    expect(aud.find((a) => a.CAMPO === 'VERSION')).toMatchObject({ VALOR_ANTES: '2', VALOR_DESPUES: '3' })
    expect(await codigo(editar('PRD-0002', { expectedVersion: 2, notas: 'otra' }))).toBe('conflicto-version')
    expect(await codigo(editar('PRD-0002', { expectedVersion: 3, costoMaxMxn: 99 }))).toBe('sin-cambios')
    expect(await codigo(editar('PRD-0099', { expectedVersion: 1, notas: 'x' }))).toBe('registro-inexistente')
    expect(await codigo(editar('PRD-0003', { expectedVersion: 1, asin: 'B000000001' }))).toBe('asin-duplicado')
    expect(await codigo(() => parseEco('eco.producto.editar', { requestId: rid(), expectedVersion: 1, etapa: 'EN_VENTA' }))).toBe('campo-no-permitido')
    expect(await codigo(() => parseEco('eco.producto.editar', { requestId: rid(), expectedVersion: 1, keepaOfertas: 3 }))).toBe('campo-no-permitido')
    expect(await codigo(() => parseEco('eco.producto.editar', { requestId: rid(), notas: 'x' }))).toBe('validacion')
    expect(await codigo(() => parseEco('eco.producto.editar', { requestId: rid(), expectedVersion: 1, nombre: '' }))).toBe('validacion')
    expect(await codigo(() => parseEco('eco.producto.editar', { requestId: rid(), expectedVersion: 1 }))).toBe('sin-cambios')
    expect(await codigo(() => parseIdRuta('PRD', "PRD-0001'!A1"))).toBe('registro-inexistente')
  })

  it('la tabla de §5.1 es exactamente la del diseño', () => {
    expect(TRANSICIONES).toEqual({
      SUGERIDO: ['EVALUANDO', 'DESCARTADO'],
      EVALUANDO: ['COTIZANDO', 'SUGERIDO', 'DESCARTADO'],
      COTIZANDO: ['MUESTRA', 'EVALUANDO', 'DESCARTADO'],
      MUESTRA: ['EN_VENTA', 'COTIZANDO', 'DESCARTADO'],
      EN_VENTA: ['MUESTRA', 'DESCARTADO'],
      DESCARTADO: ['SUGERIDO', 'EVALUANDO'],
    })
  })

  /** Un producto en `desde` con todos los requisitos de cualquier destino ya cumplidos. */
  const completo = (desde: Etapa) => new InMemoryEcoStore(RADAROS, libro({
    PIPE_PRODUCTOS: [[...COLUMNAS_PRODUCTOS], prd('PRD-0001', desde, { ASIN: 'B000000001', COSTO_MAX_MXN: 150, PROVEEDOR_ELEGIDO_ID: 'PRV-0001', VERSION: 4, MOTIVO_DESCARTE: desde === 'DESCARTADO' ? 'antes' : '' })],
    PIPE_COTIZACIONES: [[...COLUMNAS_COTIZACIONES], cot('COT-0001', 'PRD-0001', 'PRV-0001', 'ELEGIDA', { ...RECIBIDA, MUESTRA_ESTADO: 'APROBADA' })],
  }))

  it.each(ETAPAS.flatMap((desde) => ETAPAS.filter((a) => a !== desde).map((a) => [desde, a] as const)))('mover %s → %s: permitido solo si está en la tabla', async (desde, a) => {
    const s = completo(desde)
    const p = mover(servicio(s), 'PRD-0001', desde, a, 4, 'motivo sintético')
    if (TRANSICIONES[desde].includes(a)) {
      expect(await p).toEqual({ operacion: 'eco.producto.mover', id: 'PRD-0001', version: 5, repetida: false })
      const r = registro(s, 'PIPE_PRODUCTOS', 'PRD-0001')
      expect(r).toMatchObject({ ETAPA: a, ETAPA_DESDE: STAMP, VERSION: 5 })
      expect(r.MOTIVO_DESCARTE).toBe(a === 'DESCARTADO' ? 'motivo sintético' : desde === 'DESCARTADO' ? 'antes' : '')
      const etapa = auditoria(s).find((x) => x.CAMPO === 'ETAPA')!
      expect([etapa.VALOR_ANTES, etapa.VALOR_DESPUES]).toEqual([desde, a])
    } else {
      expect(await codigo(p)).toBe('transicion-no-permitida')
      expect(auditoria(s)).toHaveLength(0)
    }
  })

  it('requisitos de §5.1: sin escribir y con 409 requisito-faltante', async () => {
    const sinCosto = new InMemoryEcoStore(RADAROS, libro())
    expect(await codigo(mover(servicio(sinCosto), 'PRD-0002', 'EVALUANDO', 'COTIZANDO', 2))).toBe('requisito-faltante')
    const sinRecibida = new InMemoryEcoStore(RADAROS, libro({ PIPE_COTIZACIONES: [[...COLUMNAS_COTIZACIONES], cot('COT-0001', 'PRD-0003', 'PRV-0001', 'SOLICITADA')] }))
    expect(await codigo(mover(servicio(sinRecibida), 'PRD-0003', 'COTIZANDO', 'MUESTRA', 1))).toBe('requisito-faltante')
    const variantes: Array<[Rec, Rec]> = [
      [{ PROVEEDOR_ELEGIDO_ID: 'PRV-0001' }, { ESTADO: 'RECIBIDA', MUESTRA_ESTADO: 'APROBADA' }],
      [{ PROVEEDOR_ELEGIDO_ID: 'PRV-0001' }, { ESTADO: 'ELEGIDA', MUESTRA_ESTADO: 'RECIBIDA' }],
      [{ PROVEEDOR_ELEGIDO_ID: 'PRV-0002' }, { ESTADO: 'ELEGIDA', MUESTRA_ESTADO: 'APROBADA' }],
      [{}, { ESTADO: 'ELEGIDA', MUESTRA_ESTADO: 'APROBADA' }],
    ]
    for (const [p, c] of variantes) {
      const s = new InMemoryEcoStore(RADAROS, libro({
        PIPE_PRODUCTOS: [[...COLUMNAS_PRODUCTOS], prd('PRD-0001', 'MUESTRA', p)],
        PIPE_COTIZACIONES: [[...COLUMNAS_COTIZACIONES], cot('COT-0001', 'PRD-0001', 'PRV-0001', String(c.ESTADO), { ...RECIBIDA, ...c })],
      }))
      expect(await codigo(mover(servicio(s), 'PRD-0001', 'MUESTRA', 'EN_VENTA', 1)), JSON.stringify([p, c])).toBe('requisito-faltante')
      expect(auditoria(s)).toHaveLength(0)
    }
  })

  it('motivo obligatorio al descartar, al reabrir y de EN_VENTA a MUESTRA; reabrir exige el ASIN libre', async () => {
    for (const [desde, a] of [['SUGERIDO', 'DESCARTADO'], ['DESCARTADO', 'SUGERIDO'], ['EN_VENTA', 'MUESTRA']] as const) {
      expect(await codigo(mover(servicio(completo(desde)), 'PRD-0001', desde, a, 4))).toBe('validacion')
    }
    const s = new InMemoryEcoStore(RADAROS, libro({ PIPE_PRODUCTOS: [[...COLUMNAS_PRODUCTOS], prd('PRD-0001', 'DESCARTADO', { ASIN: 'B000000001' }), prd('PRD-0002', 'SUGERIDO', { ASIN: 'B000000001' })] }))
    expect(await codigo(mover(servicio(s), 'PRD-0001', 'DESCARTADO', 'SUGERIDO', 1, 'volver'))).toBe('asin-duplicado')
    // El motivo de un movimiento que no es descarte queda en la auditoría.
    const m = completo('EN_VENTA')
    await mover(servicio(m), 'PRD-0001', 'EN_VENTA', 'MUESTRA', 4, 'devolución sintética')
    expect(auditoria(m).find((x) => x.CAMPO === 'MOTIVO')).toMatchObject({ VALOR_DESPUES: 'devolución sintética' })
  })

  it('etapa o versión distintas de las esperadas: 409 conflicto-version con la etapa y la versión actuales', async () => {
    const s = new InMemoryEcoStore(RADAROS, libro())
    const e1 = await mover(servicio(s), 'PRD-0001', 'EVALUANDO', 'COTIZANDO', 1).catch((e: OperationError) => e)
    expect((e1 as OperationError).code).toBe('conflicto-version')
    expect((e1 as OperationError).detail).toEqual({ etapa: 'SUGERIDO', version: 1 })
    expect(await codigo(mover(servicio(s), 'PRD-0001', 'SUGERIDO', 'EVALUANDO', 7))).toBe('conflicto-version')
    expect(await codigo(() => parseMover({ requestId: rid(), expectedVersion: 1, expectedEtapa: 'SUGERIDO', etapa: 'PAUSADO' }))).toBe('validacion')
    expect(await codigo(() => parseMover({ requestId: rid(), expectedVersion: 1, expectedEtapa: 'SUGERIDO', etapa: 'EVALUANDO', version: 2 }))).toBe('campo-no-permitido')
  })

  it('eco.proveedor.crear y editar: PRV-NNNN en ACTIVO; INACTIVO en vez de borrar', async () => {
    const s = new InMemoryEcoStore(RADAROS, libro())
    const svc = servicio(s)
    const r = await svc.crearProveedor(parseEco('eco.proveedor.crear', { requestId: rid(), nombre: 'Fábrica sintética', canal: '1688', pais: 'CN', contacto: 'chat-de-tienda-sintetico' }), CTX)
    expect(r.id).toBe('PRV-0003')
    expect(registro(s, 'PIPE_PROVEEDORES', 'PRV-0003')).toMatchObject({ ESTADO: 'ACTIVO', CANAL: '1688', VERSION: 1 })
    expect((await svc.editarProveedor('PRV-0003', parseEco('eco.proveedor.editar', { requestId: rid(), expectedVersion: 1, estado: 'INACTIVO' }), CTX)).version).toBe(2)
    expect(registro(s, 'PIPE_PROVEEDORES', 'PRV-0003').ESTADO).toBe('INACTIVO')
    for (const malo of [{ canal: 'TEMU' }, { pais: 'china' }, { canal: undefined }]) {
      expect(await codigo(() => parseEco('eco.proveedor.crear', { requestId: rid(), nombre: 'x', canal: 'OTRO', pais: 'MX', ...malo })), JSON.stringify(malo)).toBe('validacion')
    }
    expect(await codigo(() => parseEco('eco.proveedor.crear', { requestId: rid(), nombre: 'x', canal: 'OTRO', pais: 'MX', estado: 'INACTIVO' }))).toBe('campo-no-permitido')
  })

  it('eco.cotizacion.crear y editar: SOLICITADA → RECIBIDA (con sus datos) → ELEGIDA, una ELEGIDA por producto, fechas', async () => {
    const s = new InMemoryEcoStore(RADAROS, libro({ PIPE_PRODUCTOS: [[...COLUMNAS_PRODUCTOS], prd('PRD-0001', 'COTIZANDO'), prd('PRD-0002', 'DESCARTADO')] }))
    const svc = servicio(s)
    const crear = (body: Record<string, unknown>) => svc.crearCotizacion(parseEco('eco.cotizacion.crear', { requestId: rid(), productoId: 'PRD-0001', proveedorId: 'PRV-0001', ...body }), CTX)
    const editar = (id: string, version: number, body: Record<string, unknown>) => svc.editarCotizacion(id, parseEco('eco.cotizacion.editar', { requestId: rid(), expectedVersion: version, ...body }), CTX)
    expect((await crear({ fechaSolicitud: '2026-10-20', fechaRespuestaEsperada: '2026-10-27' })).id).toBe('COT-0001')
    expect(registro(s, 'PIPE_COTIZACIONES', 'COT-0001')).toMatchObject({ ESTADO: 'SOLICITADA', MUESTRA_ESTADO: 'NO_PEDIDA', FECHA_SOLICITUD: '2026-10-20' })
    expect(await codigo(crear({ productoId: 'PRD-0002' }))).toBe('referencia-inexistente')
    expect(await codigo(crear({ productoId: 'PRD-0099' }))).toBe('referencia-inexistente')
    expect(await codigo(crear({ proveedorId: 'PRV-0099' }))).toBe('referencia-inexistente')
    expect(await codigo(() => parseEco('eco.cotizacion.crear', { requestId: rid(), productoId: 'PRD-0001', proveedorId: 'PRV-0001', estado: 'ELEGIDA' }))).toBe('campo-no-permitido')
    expect(await codigo(editar('COT-0001', 1, { estado: 'RECIBIDA' }))).toBe('requisito-faltante')
    expect(await codigo(editar('COT-0001', 1, { estado: 'ELEGIDA', precioUnit: 2, moneda: 'USD', moq: 10, plazoProduccionDias: 5, incoterm: 'FOB' }))).toBe('transicion-no-permitida')
    expect(await codigo(editar('COT-0001', 1, { estado: 'RECIBIDA', fechaRecibida: '2026-10-19', precioUnit: 2, moneda: 'USD', moq: 10, plazoProduccionDias: 5, incoterm: 'FOB' }))).toBe('validacion')
    expect(await codigo(editar('COT-0001', 1, { fechaRecibida: '2026-10-25' }))).toBe('validacion')
    expect(await codigo(() => parseEco('eco.cotizacion.editar', { requestId: rid(), expectedVersion: 1, moq: 0 }))).toBe('validacion')
    expect((await editar('COT-0001', 1, { estado: 'RECIBIDA', fechaRecibida: '2026-10-22', precioUnit: '2.5', moneda: 'USD', moq: 500, plazoProduccionDias: 20, incoterm: 'FOB' })).version).toBe(2)
    expect((await editar('COT-0001', 2, { estado: 'ELEGIDA' })).version).toBe(3)
    await crear({})
    await editar('COT-0002', 1, { estado: 'RECIBIDA', precioUnit: 3, moneda: 'CNY', moq: 100, plazoProduccionDias: 10, incoterm: 'EXW' })
    expect(await codigo(editar('COT-0002', 2, { estado: 'ELEGIDA' }))).toBe('elegida-duplicada')
    expect((await editar('COT-0002', 2, { estado: 'RECHAZADA' })).version).toBe(3)
    expect(await codigo(editar('COT-0002', 3, { estado: 'RECIBIDA' }))).toBe('transicion-no-permitida')
    expect(await codigo(() => parseEco('eco.cotizacion.editar', { requestId: rid(), expectedVersion: 1, productoId: 'PRD-0002' }))).toBe('campo-no-permitido')
  })

  it('eco.embarque.crear y editar: cotización ELEGIDA del mismo producto, PLANEADO → PAGADO → EN_TRANSITO → RECIBIDO_FBA', async () => {
    const s = new InMemoryEcoStore(RADAROS, libro({
      PIPE_COTIZACIONES: [[...COLUMNAS_COTIZACIONES], cot('COT-0001', 'PRD-0003', 'PRV-0001', 'ELEGIDA', RECIBIDA), cot('COT-0002', 'PRD-0003', 'PRV-0001', 'RECIBIDA', RECIBIDA)],
    }))
    const svc = servicio(s)
    const crear = (body: Record<string, unknown>) => svc.crearEmbarque(parseEco('eco.embarque.crear', { requestId: rid(), productoId: 'PRD-0003', cotizacionId: 'COT-0001', unidades: 300, ...body }), CTX)
    const editar = (version: number, body: Record<string, unknown>) => svc.editarEmbarque('EMB-0001', parseEco('eco.embarque.editar', { requestId: rid(), expectedVersion: version, ...body }), CTX)
    expect(await codigo(crear({ cotizacionId: 'COT-0002' }))).toBe('requisito-faltante')
    expect(await codigo(crear({ productoId: 'PRD-0001' }))).toBe('referencia-inexistente')
    expect(await codigo(crear({ cotizacionId: 'COT-0099' }))).toBe('referencia-inexistente')
    expect(await codigo(() => parseEco('eco.embarque.crear', { requestId: rid(), productoId: 'PRD-0003', cotizacionId: 'COT-0001', unidades: 0 }))).toBe('validacion')
    expect((await crear({ fechaPago: '2026-10-20', costoTotal: '1500.25', moneda: 'USD' })).id).toBe('EMB-0001')
    expect(registro(s, 'PIPE_EMBARQUES', 'EMB-0001')).toMatchObject({ ESTADO: 'PLANEADO', UNIDADES: 300, COSTO_TOTAL: 1500.25 })
    expect(await codigo(editar(1, { estado: 'EN_TRANSITO' }))).toBe('transicion-no-permitida')
    expect(await codigo(editar(1, { fechaSalida: '2026-10-19' }))).toBe('validacion')
    expect((await editar(1, { estado: 'PAGADO' })).version).toBe(2)
    expect((await editar(2, { estado: 'EN_TRANSITO', fechaSalida: '2026-10-21', fechaLlegadaEsperada: '2026-11-15' })).version).toBe(3)
    expect(await codigo(editar(3, { estado: 'RECIBIDO_FBA', fechaLlegada: '2026-10-30' }))).toBe('validacion')
    expect((await editar(3, { estado: 'RECIBIDO_FBA', fechaLlegada: '2026-10-23' })).version).toBe(4)
    expect(await codigo(editar(4, { estado: 'CANCELADO' }))).toBe('transicion-no-permitida')
  })

  it('idempotencia de §6.1: repetida, roll-forward (alta y edición) y conflicto', async () => {
    const s = new InMemoryEcoStore(RADAROS, libro())
    const svc = servicio(s)
    const body = { requestId: rid(), nombre: 'Repetible' }
    const primero = await svc.crearProducto(parseEco('eco.producto.crear', body), CTX)
    expect(await svc.crearProducto(parseEco('eco.producto.crear', body), CTX)).toEqual({ ...primero, repetida: true })
    expect(tabla(s, 'PIPE_PRODUCTOS')).toHaveLength(5)
    expect(await codigo(svc.crearProducto(parseEco('eco.producto.crear', { ...body, nombre: 'Otro' }), CTX))).toBe('conflicto-idempotencia')
    expect(await codigo(svc.crearProveedor(parseEco('eco.proveedor.crear', { requestId: body.requestId, nombre: 'Repetible', canal: 'OTRO', pais: 'MX' }), CTX))).toBe('conflicto-idempotencia')
    const mov = { requestId: rid(), expectedVersion: 1, expectedEtapa: 'SUGERIDO', etapa: 'EVALUANDO' }
    await svc.moverProducto('PRD-0001', parseMover(mov), CTX)
    expect((await svc.moverProducto('PRD-0001', parseMover(mov), CTX)).repetida).toBe(true)
    expect(registro(s, 'PIPE_PRODUCTOS', 'PRD-0001').VERSION).toBe(2)

    // Roll-forward: la auditoría quedó escrita y la entidad falló; el reintento con el mismo requestId la completa.
    for (const caso of ['alta', 'edicion'] as const) {
      const f = new FallaStore(libro())
      f.fallar = caso === 'alta' ? 'append-PIPE_PRODUCTOS' : 'update'
      const sv = servicio(f)
      const b = caso === 'alta' ? { requestId: rid(), nombre: 'A medias' } : { requestId: rid(), expectedVersion: 1, expectedEtapa: 'SUGERIDO', etapa: 'EVALUANDO' }
      const correr = () => (caso === 'alta' ? sv.crearProducto(parseEco('eco.producto.crear', b), CTX) : sv.moverProducto('PRD-0001', parseMover(b), CTX))
      expect(await codigo(correr())).toBe('escritura-fallida')
      expect(auditoria(f).length).toBeGreaterThan(0)
      f.fallar = null
      expect((await correr()).repetida).toBe(true)
      const id = caso === 'alta' ? 'PRD-0004' : 'PRD-0001'
      expect(registro(f, 'PIPE_PRODUCTOS', id)).toMatchObject(caso === 'alta' ? { NOMBRE: 'A medias', VERSION: 1 } : { ETAPA: 'EVALUANDO', VERSION: 2 })
      expect(tabla(f, 'PIPE_PRODUCTOS').filter((r) => r[0] === id)).toHaveLength(1)
    }
  })
})

/* ------------------------------------------ Criterio 4 ------------------------------------------ */

/** Libro en memoria que registra el orden de las llamadas y puede fallar en el paso elegido. */
class FallaStore extends InMemoryEcoStore {
  fallar: string | null = null
  llamadas: string[] = []
  antesDeReleer: (() => void) | null = null
  private lecturas = 0
  constructor(datos: Partial<Record<string, unknown[][]>>) {
    super(RADAROS, datos)
  }
  async tabs() {
    this.llamadas.push('tabs')
    if (this.fallar === 'tabs') throw new Error('HTTP 503')
    return super.tabs()
  }
  async read(tabs: readonly EcoWriteTab[]) {
    this.llamadas.push(`read-${tabs.join(',')}`)
    this.lecturas += 1
    if (this.fallar === 'read' || (this.fallar === 'releer' && this.lecturas > 1)) throw new Error('HTTP 503')
    if (this.lecturas > 1 && this.antesDeReleer) this.antesDeReleer()
    return super.read(tabs)
  }
  async formulas(tab: EcoWriteTab, n: number) {
    this.llamadas.push('formulas')
    return super.formulas(tab, n)
  }
  async append(tab: EcoWriteTab, rows: Celda[][]) {
    this.llamadas.push(`append-${tab}`)
    if (this.fallar === `append-${tab}`) throw new Error('HTTP 500')
    if (this.fallar === 'corromper' && tab !== 'PIPE_AUDITORIA') return super.append(tab, rows.map((r) => r.map((v, i) => (i === 1 ? 'otro' : v))))
    return super.append(tab, rows)
  }
  async update(tab: EcoWriteTab, n: number, celdas: CeldaCambio[]) {
    this.llamadas.push(`update-${tab}`)
    if (this.fallar === 'update') throw new Error('HTTP 500')
    if (this.fallar === 'corromper') return super.update(tab, n, celdas.map((c) => ({ ...c, valor: 'otro' })))
    return super.update(tab, n, celdas)
  }
}

describe('criterio 4: auditoría antes de la entidad y verificación después (§6.1)', () => {
  it('orden de un alta y de una edición: leer → auditoría → entidad → releer para verificar', async () => {
    const f = new FallaStore(libro())
    await crearProducto(servicio(f))
    expect(f.llamadas).toEqual(['tabs', expect.stringMatching(/^read-PIPE_PRODUCTOS,/), 'append-PIPE_AUDITORIA', 'append-PIPE_PRODUCTOS', 'read-PIPE_PRODUCTOS'])
    f.llamadas = []
    await mover(servicio(f), 'PRD-0001', 'SUGERIDO', 'EVALUANDO', 1)
    expect(f.llamadas).toEqual(['tabs', expect.stringMatching(/^read-PIPE_PRODUCTOS,/), 'formulas', 'append-PIPE_AUDITORIA', 'read-PIPE_PRODUCTOS', 'update-PIPE_PRODUCTOS', 'read-PIPE_PRODUCTOS'])
  })

  it.each([
    ['tabs', 'lectura-fallida'],
    ['read', 'lectura-fallida'],
    ['append-PIPE_AUDITORIA', 'auditoria-fallida'],
  ])('falla en %s: %s y la entidad no se toca', async (paso, esperado) => {
    for (const correr of [(s: EcoPipelineWriteService) => crearProducto(s), (s: EcoPipelineWriteService) => mover(s, 'PRD-0001', 'SUGERIDO', 'EVALUANDO', 1)]) {
      const f = new FallaStore(libro())
      f.fallar = paso
      const antes = tabla(f, 'PIPE_PRODUCTOS')
      expect(await codigo(correr(servicio(f)))).toBe(esperado)
      expect(tabla(f, 'PIPE_PRODUCTOS')).toEqual(antes)
      expect(auditoria(f)).toHaveLength(0)
      expect(f.llamadas.some((l) => l.startsWith('update') || l === 'append-PIPE_PRODUCTOS')).toBe(false)
    }
  })

  it('falla la entidad (alta o edición): escritura-fallida con la auditoría ya escrita (se completa al reintentar)', async () => {
    const f = new FallaStore(libro())
    f.fallar = 'append-PIPE_PRODUCTOS'
    expect(await codigo(crearProducto(servicio(f)))).toBe('escritura-fallida')
    expect(auditoria(f).length).toBeGreaterThan(0)
    const g = new FallaStore(libro())
    g.fallar = 'update'
    expect(await codigo(mover(servicio(g), 'PRD-0001', 'SUGERIDO', 'EVALUANDO', 1))).toBe('escritura-fallida')
    expect(registro(g, 'PIPE_PRODUCTOS', 'PRD-0001').ETAPA).toBe('SUGERIDO')
  })

  it('falla la relectura de verificación o no cuadra: verificacion-fallida', async () => {
    const f = new FallaStore(libro())
    f.fallar = 'corromper'
    expect(await codigo(crearProducto(servicio(f)))).toBe('verificacion-fallida')
    const g = new FallaStore(libro())
    g.fallar = 'corromper'
    expect(await codigo(mover(servicio(g), 'PRD-0001', 'SUGERIDO', 'EVALUANDO', 1))).toBe('verificacion-fallida')
    const h = new FallaStore(libro())
    h.fallar = 'releer'
    expect(await codigo(crearProducto(servicio(h)))).toBe('verificacion-fallida')
  })

  it('la fila cambió entre la lectura y la escritura: conflicto-concurrente sin escribir la entidad', async () => {
    const f = new FallaStore(libro())
    f.antesDeReleer = () => void f.update('PIPE_PRODUCTOS', 2, [{ columna: COLUMNAS_PRODUCTOS.indexOf('VERSION'), valor: 9 }])
    expect(await codigo(mover(servicio(f), 'PRD-0001', 'SUGERIDO', 'EVALUANDO', 1))).toBe('conflicto-concurrente')
    expect(f.llamadas.filter((l) => l.startsWith('update')).length).toBe(1) // solo la del doble
    expect(registro(f, 'PIPE_PRODUCTOS', 'PRD-0001').ETAPA).toBe('SUGERIDO')
    // Dos filas con el mismo ID: 409 conflicto-concurrente.
    const d = new InMemoryEcoStore(RADAROS, libro({ PIPE_PRODUCTOS: [[...COLUMNAS_PRODUCTOS], prd('PRD-0001', 'SUGERIDO'), prd('PRD-0001', 'SUGERIDO')] }))
    expect(await codigo(mover(servicio(d), 'PRD-0001', 'SUGERIDO', 'EVALUANDO', 1))).toBe('conflicto-concurrente')
  })

  it('esquema (§6.1 paso 1 y §8): pestaña sin crear, columna ausente o repetida → 400 eco-esquema-invalido sin escribir', async () => {
    const casos: Array<Partial<Record<string, unknown[][]>>> = [
      { PIPE_EMBARQUES: undefined },
      { PIPE_AUDITORIA: undefined },
      { PIPE_PRODUCTOS: [COLUMNAS_PRODUCTOS.filter((c) => c !== 'VERSION')] },
      { PIPE_PRODUCTOS: [[...COLUMNAS_PRODUCTOS, 'NOMBRE']] },
      { PIPE_AUDITORIA: [COLUMNAS_AUDITORIA.slice(0, 8)] },
    ]
    for (const over of casos) {
      const datos = libro(over)
      for (const [k, v] of Object.entries(over)) if (v === undefined) delete (datos as Record<string, unknown>)[k]
      const f = new FallaStore(datos)
      expect(await codigo(crearProducto(servicio(f))), JSON.stringify(Object.keys(over))).toBe('eco-esquema-invalido')
      expect(f.llamadas.some((l) => l.startsWith('append') || l.startsWith('update'))).toBe(false)
    }
  })

  it('❓ §12: una celda que es fórmula de la hoja (COSTO_MAX_MXN, COSTO_ATERRIZADO_MXN) es de solo lectura', async () => {
    const f = new FallaStore(libro({ PIPE_COTIZACIONES: [[...COLUMNAS_COTIZACIONES], cot('COT-0001', 'PRD-0003', 'PRV-0001', 'SOLICITADA')] }))
    f.formulasHoja.set(`PIPE_PRODUCTOS!3!${COLUMNAS_PRODUCTOS.indexOf('COSTO_MAX_MXN')}`, '=SCORING!B2*0.3')
    f.formulasHoja.set(`PIPE_COTIZACIONES!2!${COLUMNAS_COTIZACIONES.indexOf('COSTO_ATERRIZADO_MXN')}`, '=H2*20')
    const svc = servicio(f)
    expect(await codigo(svc.editarProducto('PRD-0002', parseEco('eco.producto.editar', { requestId: rid(), expectedVersion: 2, costoMaxMxn: 10 }), CTX))).toBe('campo-solo-lectura')
    expect(await codigo(svc.editarCotizacion('COT-0001', parseEco('eco.cotizacion.editar', { requestId: rid(), expectedVersion: 1, costoAterrizadoMxn: 10 }), CTX))).toBe('campo-solo-lectura')
    expect(auditoria(f)).toHaveLength(0)
    // Otra columna de la misma fila sí se edita, y solo se escriben sus celdas (la fórmula queda intacta).
    await svc.editarProducto('PRD-0002', parseEco('eco.producto.editar', { requestId: rid(), expectedVersion: 2, notas: 'ok' }), CTX)
    expect(f.formulasHoja.size).toBe(2)
  })
})

/* ------------------------------------------ Criterio 5 ------------------------------------------ */

describe('criterio 5: lista cerrada de pestañas y pruebas cruzadas (§6.2)', () => {
  it('escribir en SCORING o AMZ_CORRIDAS (o leerlas) lanza antes de pedir el token', async () => {
    let tokens = 0
    const urls: string[] = []
    const store = new EcoSheetsStore({
      spreadsheetId: RADAROS,
      getWriteToken: async () => { tokens += 1; return 't' },
      fetchImpl: (async (url: string) => { urls.push(url); return new Response('{}') }) as unknown as typeof fetch,
    })
    for (const tab of ['SCORING', 'AMZ_CORRIDAS', 'PIPE_PARAMETROS', 'PRODUCTS', 'UNIT_ECONOMICS', "PIPE_PRODUCTOS'!A1:Z9,'SCORING"]) {
      await expect(store.append(tab as EcoWriteTab, [['x']])).rejects.toThrow('lista cerrada')
      await expect(store.update(tab as EcoWriteTab, 2, [{ columna: 0, valor: 'x' }])).rejects.toThrow('lista cerrada')
      await expect(store.read([tab as EcoWriteTab])).rejects.toThrow('lista cerrada')
      await expect(store.formulas(tab as EcoWriteTab, 2)).rejects.toThrow('lista cerrada')
    }
    await expect(store.update('PIPE_PRODUCTOS', 1, [{ columna: 0, valor: 'x' }])).rejects.toThrow('fila fuera de rango')
    expect(tokens).toBe(0)
    expect(urls).toHaveLength(0)
    await expect(new InMemoryEcoStore(RADAROS, libro()).append('SCORING' as EcoWriteTab, [['x']])).rejects.toThrow('lista cerrada')
  })

  it('el almacén solo construye URLs de su libro, rangos propios y RAW', async () => {
    const llamadas: Llamada[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      llamadas.push({ url, init })
      return new Response(JSON.stringify({ sheets: [], valueRanges: [], values: [[]] }), { status: 200 })
    }) as unknown as typeof fetch
    const store = new EcoSheetsStore({ spreadsheetId: RADAROS, getWriteToken: async () => 't', fetchImpl })
    await store.tabs()
    await store.read(['PIPE_PRODUCTOS', 'PIPE_AUDITORIA'])
    await store.formulas('PIPE_PRODUCTOS', 5)
    await store.append('PIPE_AUDITORIA', [['x']])
    await store.update('PIPE_PRODUCTOS', 5, [{ columna: 6, valor: 'EVALUANDO' }, { columna: 25, valor: 2 }])
    for (const c of llamadas) expect(c.url.startsWith(`https://sheets.googleapis.com/v4/spreadsheets/${RADAROS}`)).toBe(true)
    expect(decodeURIComponent(llamadas[2]!.url)).toContain("/values/'PIPE_PRODUCTOS'!A5:AZ5?majorDimension=ROWS&valueRenderOption=FORMULA")
    expect(llamadas[3]!.url).toMatch(/:append\?valueInputOption=RAW&insertDataOption=INSERT_ROWS$/)
    expect(llamadas[4]!.url).toMatch(/\/values:batchUpdate$/)
    expect(JSON.parse(String(llamadas[4]!.init.body))).toEqual({
      valueInputOption: 'RAW',
      data: [
        { range: "'PIPE_PRODUCTOS'!G5:G5", majorDimension: 'ROWS', values: [['EVALUANDO']] },
        { range: "'PIPE_PRODUCTOS'!Z5:Z5", majorDimension: 'ROWS', values: [[2]] },
      ],
    })
    expect([0, 25, 26, 51].map(letraColumna)).toEqual(['A', 'Z', 'AA', 'AZ'])
  })

  it('por HTTP: cada llamada va al libro de RADAROS con la cuenta del pipeline, nunca a PROJECT-OS ni a FINANZAS', async () => {
    const h = arnes(ACTIVA)
    expect(h.iam).toHaveLength(0)
    const alta = await h.llamar('POST', '/api/eco/pipeline/productos', { requestId: rid(), nombre: 'Por HTTP' })
    expect(alta.status).toBe(201)
    expect(alta.body).toMatchObject({ ok: true, id: 'PRD-0004', version: 1, repetida: false })
    expect((await h.llamar('POST', '/api/eco/pipeline/productos/PRD-0004/etapa', { requestId: rid(), expectedVersion: 1, expectedEtapa: 'SUGERIDO', etapa: 'EVALUANDO' })).status).toBe(200)
    expect((await h.llamar('PATCH', '/api/eco/pipeline/productos/PRD-0004', { requestId: rid(), expectedVersion: 2, notas: 'x' })).status).toBe(200)
    expect((await h.llamar('POST', '/api/eco/pipeline/proveedores', { requestId: rid(), nombre: 'P', canal: 'OTRO', pais: 'MX' })).status).toBe(201)
    expect(h.sheets.length).toBeGreaterThan(0)
    for (const c of h.sheets) {
      expect(c.url.startsWith(`https://sheets.googleapis.com/v4/spreadsheets/${RADAROS}`)).toBe(true)
      expect((c.init.headers as Record<string, string>).Authorization).toBe('Bearer token-eco')
    }
    // El arnés construye un servicio por petición (en el runtime es uno por proceso): un token por petición, todos de la cuenta del pipeline.
    expect(h.iam).toHaveLength(4)
    for (const c of h.iam) {
      expect(c.url).toBe(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(CUENTA_ECO)}:generateAccessToken`)
      expect(JSON.parse(String(c.init.body))).toEqual({ scope: ['https://www.googleapis.com/auth/spreadsheets'], lifetime: '600s' })
    }
    const todo = JSON.stringify([...h.sheets, ...h.iam].map((c) => c.url))
    for (const ajeno of [PROPIA, FINANZAS, encodeURIComponent(ESCRITURA_POS), encodeURIComponent(LECTURA), encodeURIComponent(CUENTA_FIN), encodeURIComponent(CUENTA_AGENTE)]) expect(todo).not.toContain(ajeno)
    expect(h.otras).toHaveLength(0)
    // 409 por HTTP: la tarjeta vuelve a su sitio con la etapa y la versión reales.
    const conflicto = await h.llamar('POST', '/api/eco/pipeline/productos/PRD-0004/etapa', { requestId: rid(), expectedVersion: 1, expectedEtapa: 'SUGERIDO', etapa: 'EVALUANDO' })
    expect(conflicto.status).toBe(409)
    expect(conflicto.body.error).toMatchObject({ codigo: 'conflicto-version', detalle: { etapa: 'EVALUANDO', version: 3 } })
    expect(JSON.stringify(conflicto.body)).not.toContain(DUENO)
  })

  it('el código del pipeline no conoce operaciones ni finanzas, y viceversa', () => {
    const SRC = path.join(__dirname, '..', 'src', 'lib')
    const archivos = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
      const full = path.join(dir, n)
      return statSync(full).isDirectory() ? archivos(full) : [full]
    })
    const eco = readdirSync(path.join(SRC, 'radaros')).filter((n) => n.startsWith('pipeline-escritura-') || n === 'pipeline-transiciones.ts' || n === 'pipeline-generacion.ts')
    expect(eco.length).toBe(10)
    for (const f of eco) {
      const text = readFileSync(path.join(SRC, 'radaros', f), 'utf8')
      expect(text, f).not.toMatch(/OperationsService|SheetsTableStore|operations\/runtime|operations\/service|operations\/config|spreadsheetId\(\)|writeServiceAccount\(|finanzasSheetId|finanzasConfig|FINANZAS_SHEET_ID|lib\/finanzas|\.\.\/finanzas|FinanzasSheetsStore/)
    }
    for (const f of [...archivos(path.join(SRC, 'operations')), ...archivos(path.join(SRC, 'finanzas'))]) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/ECO_PIPELINE|pipeline-escritura|EcoSheetsStore|EcoPipelineWriteService|radarosSheetId/)
    }
  })
})

/* ------------------------------------------ Criterio 6 ------------------------------------------ */

describe('criterio 6: inercia sin cualquiera de las condiciones de §7.1', () => {
  it.each([
    [{ ECO_PIPELINE_WRITE_MODE: undefined }], [{ ECO_PIPELINE_WRITE_MODE: 'mock' }], [{ RADAROS_SHEET_ID: undefined }],
    [{ RADAROS_SHEET_ID: PROPIA }], [{ ECO_PIPELINE_WRITE_SERVICE_ACCOUNT: undefined }], [{ ECO_PIPELINE_WRITE_SERVICE_ACCOUNT: LECTURA }],
    [{ ECO_PIPELINE_WRITE_SERVICE_ACCOUNT: ESCRITURA_POS }], [{ ECO_PIPELINE_WRITE_SERVICE_ACCOUNT: CUENTA_FIN }],
    [{ ECO_PIPELINE_WRITE_SERVICE_ACCOUNT: CUENTA_AGENTE }], [{ SHEETS_EXPECTED_SERVICE_ACCOUNT: undefined }],
    [{ ECO_PIPELINE_WRITER_EMAIL: undefined }], [{ ECO_PIPELINE_WRITER_EMAIL: `${DUENO} otro@example.com` }],
    [{ AUTH_ALLOWED_EMAILS: 'lector@example.com' }],
  ])('sin %o: 403 escritura-deshabilitada y cero llamadas a los dobles de token y de fetch', async (over) => {
    for (const [metodo, ruta, body] of [
      ['POST', '/api/eco/pipeline/productos', { requestId: rid(), nombre: 'x' }],
      ['POST', '/api/eco/pipeline/productos/PRD-0001/etapa', { requestId: rid(), expectedVersion: 1, expectedEtapa: 'SUGERIDO', etapa: 'EVALUANDO' }],
      ['PATCH', '/api/eco/pipeline/proveedores/PRV-0001', { requestId: rid(), expectedVersion: 1, notas: 'x' }],
    ] as const) {
      const h = arnes({ ...ACTIVA, ...over })
      const r = await h.llamar(metodo, ruta, body)
      // Sin escritor en AUTH_ALLOWED_EMAILS, el propio correo deja de ser lector: 403 antes del modo.
      expect(r.status).toBe(403)
      expect(['escritura-deshabilitada', 'sin-permiso-lectura']).toContain((r.body.error as { codigo: string }).codigo)
      expect(h.construidos).toBe(0)
      expect(h.fuentes + h.iam.length + h.sheets.length + h.otras.length).toBe(0)
    }
  })

  it('con todo activo pero otra cuenta en sesión: 403 sin-permiso-escritura y cero llamadas', async () => {
    const h = arnes(ACTIVA, { email: 'lector@example.com' })
    const r = await h.llamar('POST', '/api/eco/pipeline/productos', { requestId: rid(), nombre: 'x' })
    expect(r.status).toBe(403)
    expect((r.body.error as { codigo: string }).codigo).toBe('sin-permiso-escritura')
    expect(h.construidos + h.fuentes + h.iam.length + h.sheets.length).toBe(0)
  })
})

/* ------------------------------------------ Criterio 7 ------------------------------------------ */

const estado = vi.hoisted(() => ({ result: null as unknown, email: 'lector@example.com' }))
vi.mock('@/lib/page-data', () => ({ privateEco: async () => ({ user: { email: estado.email }, result: estado.result }) }))
vi.mock('@/components/operations/write-access', () => ({ writeAccess: () => ({ allowed: false }) }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }))

describe('criterio 7: arrastre nativo y «Mover a…» accesible (§2.1)', () => {
  afterEach(() => vi.unstubAllEnvs())
  const NOW_MS = NOW.getTime()
  const datos = libro()
  const result: EcoResult = { estado: 'ok', vista: construirEco(datos, NOW_MS), fetchedAt: NOW_MS }

  async function pagina(email: string, vars: Record<string, string | undefined>) {
    for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v)
    estado.email = email
    estado.result = result
    const { default: PipelinePage } = await import('@/app/(private)/eco/pipeline/page')
    return renderToStaticMarkup(await PipelinePage({ searchParams: Promise.resolve({}) }))
  }

  it('el escritor con la escritura activa ve tarjetas arrastrables y «Mover a…» con solo las etapas permitidas', async () => {
    const h = await pagina(DUENO, ACTIVA)
    expect(h).toContain('draggable="true"')
    expect(h).toContain('Mover a…')
    const form = h.slice(h.indexOf('aria-label="Mover Producto PRD-0001"'), h.indexOf('</form>', h.indexOf('aria-label="Mover Producto PRD-0001"')))
    expect([...form.matchAll(/<option value="([A-Z_]+)"/g)].map((m) => m[1])).toEqual(['EVALUANDO', 'DESCARTADO'])
    expect(h).toContain('<dialog')
  })

  it('un lector, o el escritor sin la escritura activa: el mismo tablero sin arrastre ni botones', async () => {
    for (const [email, vars] of [['lector@example.com', ACTIVA], [DUENO, { ...ACTIVA, ECO_PIPELINE_WRITE_MODE: '' }]] as const) {
      const h = await pagina(email, vars)
      expect(h).toContain('aria-label="Sugerido"')
      expect(h).not.toMatch(/draggable|Mover a|<dialog/)
    }
  })

  it('sin dependencias nuevas, API nativa y nada optimista: solo refresca tras un ok', () => {
    const src = readFileSync(path.join(__dirname, '..', 'src', 'components', 'eco', 'tablero-escritura.tsx'), 'utf8')
    expect([...src.matchAll(/^import .* from '([^']+)'$/gm)].map((m) => m[1]).sort()).toEqual(['@/lib/radaros/pipeline', '@/lib/radaros/pipeline-transiciones', 'next/navigation', 'react'])
    expect(src).toMatch(/import type \{ Etapa \} from '@\/lib\/radaros\/pipeline'/)
    for (const api of ['draggable=', 'onDragStart', 'onDragOver', 'onDrop', 'dataTransfer', 'showModal']) expect(src).toContain(api)
    expect(src.match(/router\.refresh\(\)/g)).toHaveLength(1)
    expect(src).toMatch(/if \(json\?\.ok\) \{\n\s+setEstado\(\{ status: 'done', id: p\.id \}\)\n\s+router\.refresh\(\)/)
    expect(src).not.toMatch(/localStorage|sessionStorage|setTarjetas|optimistic/i)
    const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['google-auth-library', 'next', 'next-auth', 'react', 'react-dom', 'server-only'].filter((d) => d in pkg.dependencies).sort())
  })
})

/* ------------------------------------------ Criterio 8 ------------------------------------------ */

describe('criterio 8: render.mjs valida y agrega la escritura del pipeline', () => {
  const template = readFileSync(path.join(__dirname, '..', 'deploy', 'cloudrun', 'service.template.yaml'), 'utf8')
  const ACTUAL = {
    SERVICE_NAME: 'project-os-dashboard', PROJECT_ID: 'project-os-511102', REGION: 'northamerica-south1',
    IMAGE: `us-docker.pkg.dev/project-os-511102/repo/dash@sha256:${'a'.repeat(64)}`,
    RUNTIME_SA: LECTURA, SERVICE_URL: 'https://dash.example.com',
    OAUTH_CLIENT_ID: '123-abc.apps.googleusercontent.com', SECRET_VERSION_NEXTAUTH: '1', SECRET_VERSION_OAUTH: '1',
    SECRET_VERSION_ALLOWLIST: '1', WRITE_MODE: 'sheets', WRITE_SERVICE_ACCOUNT: ESCRITURA_POS, SECRET_VERSION_WRITERS: '1',
    RADAROS_SHEET_ID: RADAROS, FINANZAS_SHEET_ID: FINANZAS, FINANZAS_WRITE_MODE: 'sheets', FINANZAS_WRITE_SERVICE_ACCOUNT: CUENTA_FIN,
    FINANZAS_WRITER_EMAIL: DUENO,
  }
  const LECT = { ...ACTUAL, WRITE_MODE: undefined, WRITE_SERVICE_ACCOUNT: undefined, SECRET_VERSION_WRITERS: undefined, FINANZAS_WRITE_MODE: undefined, FINANZAS_WRITE_SERVICE_ACCOUNT: undefined, FINANZAS_WRITER_EMAIL: undefined }
  const ECO = { ECO_PIPELINE_WRITE_MODE: 'sheets', ECO_PIPELINE_WRITE_SERVICE_ACCOUNT: CUENTA_ECO, ECO_PIPELINE_WRITER_EMAIL: DUENO }
  const bloque = `            - name: ECO_PIPELINE_WRITE_MODE\n              value: sheets\n            - name: ECO_PIPELINE_WRITE_SERVICE_ACCOUNT\n              value: ${CUENTA_ECO}\n            - name: ECO_PIPELINE_WRITER_EMAIL\n              value: '${DUENO}'\n`

  it('sin las tres variables (o vacías) el YAML no cambia', () => {
    for (const b of [ACTUAL, LECT]) {
      const sin = render(template, b)
      expect(sin).not.toContain('ECO_PIPELINE')
      expect(render(template, { ...b, ECO_PIPELINE_WRITE_MODE: '', ECO_PIPELINE_WRITE_SERVICE_ACCOUNT: ' ', ECO_PIPELINE_WRITER_EMAIL: '' })).toBe(sin)
    }
  })

  it('con las tres válidas agrega solo ese bloque, con o sin las otras escrituras', () => {
    for (const b of [ACTUAL, LECT]) {
      const con = render(template, { ...b, ...ECO })
      expect(con).toContain(bloque)
      expect(con.replace(bloque, '')).toBe(render(template, b))
    }
  })

  it.each([
    [{ ECO_PIPELINE_WRITE_MODE: 'disabled' }, 'ECO_PIPELINE_WRITE_MODE solo admite sheets'],
    [{ ECO_PIPELINE_WRITE_MODE: undefined }, 'van juntas'],
    [{ ECO_PIPELINE_WRITER_EMAIL: undefined }, 'van juntas'],
    [{ ECO_PIPELINE_WRITE_SERVICE_ACCOUNT: undefined }, 'van juntas'],
    [{ RADAROS_SHEET_ID: undefined, FINANZAS_SHEET_ID: undefined, FINANZAS_WRITE_MODE: undefined, FINANZAS_WRITE_SERVICE_ACCOUNT: undefined, FINANZAS_WRITER_EMAIL: undefined }, 'ECO_PIPELINE_WRITE_MODE exige RADAROS_SHEET_ID'],
    [{ ECO_PIPELINE_WRITE_SERVICE_ACCOUNT: 'cuenta-secreta@gmail.com' }, 'ECO_PIPELINE_WRITE_SERVICE_ACCOUNT no tiene el formato esperado'],
    [{ ECO_PIPELINE_WRITE_SERVICE_ACCOUNT: LECTURA }, 'no puede ser la cuenta runtime'],
    [{ ECO_PIPELINE_WRITE_SERVICE_ACCOUNT: ESCRITURA_POS }, 'no puede ser la cuenta de escritura de PROJECT-OS'],
    [{ ECO_PIPELINE_WRITE_SERVICE_ACCOUNT: CUENTA_FIN }, 'no puede ser la cuenta de escritura de FINANZAS'],
    [{ ECO_PIPELINE_WRITE_SERVICE_ACCOUNT: CUENTA_AGENTE, FINANZAS_AGENTE_SERVICE_ACCOUNT: CUENTA_AGENTE, FINANZAS_AGENTE_MODE: 'sheets', SECRET_VERSION_FINANZAS_AGENTE: '1' }, 'no puede ser la cuenta del agente de finanzas'],
    [{ ECO_PIPELINE_WRITE_SERVICE_ACCOUNT: 'project-os-eco@otro-proyecto-1.iam.gserviceaccount.com' }, 'debe pertenecer a PROJECT_ID'],
    [{ ECO_PIPELINE_WRITER_EMAIL: `${DUENO},otro@example.com` }, 'ECO_PIPELINE_WRITER_EMAIL debe ser un único correo'],
    [{ ECO_PIPELINE_WRITER_EMAIL: "dueno'@example.com" }, 'ECO_PIPELINE_WRITER_EMAIL debe ser un único correo'],
  ])('combinación inválida %o: falla el render sin imprimir valores', (over, mensaje) => {
    let error: Error | null = null
    try {
      render(template, { ...ACTUAL, ...ECO, ...over })
    } catch (e) {
      error = e as Error
    }
    expect(error?.message).toContain(mensaje)
    for (const v of [CUENTA_ECO, DUENO, RADAROS, 'cuenta-secreta']) expect(error?.message).not.toContain(v)
  })
})

/* ------------------------------------------ Criterio 9 ------------------------------------------ */

describe('criterio 9: hallazgos de revisiones', () => {
  it('CONTACTO acepta un «+» inicial (teléfono) y lo neutraliza con apóstrofo, además de RAW; =, - y @ siguen fuera', async () => {
    const s = new InMemoryEcoStore(RADAROS, libro())
    const svc = servicio(s)
    const crear = (contacto: string) => svc.crearProveedor(parseEco('eco.proveedor.crear', { requestId: rid(), nombre: 'Con teléfono', canal: 'NACIONAL', pais: 'MX', contacto }), CTX)
    const r = await crear('+52 000 000 0000')
    expect(registro(s, 'PIPE_PROVEEDORES', r.id).CONTACTO).toBe("'+52 000 000 0000")
    // La verificación releyó el mismo texto (con apóstrofo) y el reintento con el mismo requestId lo reconoce.
    expect(auditoria(s).find((a) => a.CAMPO === 'CONTACTO')!.VALOR_DESPUES).toBe("'+52 000 000 0000")
    for (const malo of ['=HYPERLINK("http://x")', '-1+1', '@SUM(A1)']) {
      expect(await codigo(() => parseEco('eco.proveedor.crear', { requestId: rid(), nombre: 'x', canal: 'OTRO', pais: 'MX', contacto: malo })), malo).toBe('validacion')
    }
    // En los demás textos, un «+» inicial sigue rechazado.
    expect(await codigo(() => parseEco('eco.proveedor.crear', { requestId: rid(), nombre: '+52', canal: 'OTRO', pais: 'MX' }))).toBe('validacion')
  })

  it('NOTAS del proveedor ocultas a lectores no escritores, como CONTACTO', () => {
    const raw = libro({ PIPE_PROVEEDORES: [[...COLUMNAS_PROVEEDORES], prv('PRV-0001', 'ACTIVO', { CONTACTO: 'contacto-sintetico-1', NOTAS: 'nota-con-contacto-sintetico' })] })
    const v = construirEco(raw, NOW.getTime()).pipeline
    expect(JSON.stringify(paraLector(v, false))).not.toMatch(/contacto-sintetico-1|nota-con-contacto-sintetico/)
    expect(JSON.stringify(paraLector(v, true))).toMatch(/nota-con-contacto-sintetico/)
  })

  it('la cita a write-credentials apunta a web/src/lib/operations/write-credentials.ts', () => {
    const ROOT = path.join(__dirname, '..', '..')
    const diseno = readFileSync(path.join(ROOT, 'docs', 'diseno-eco-pipeline.md'), 'utf8')
    expect(diseno).toContain('web/src/lib/operations/write-credentials.ts')
    expect(diseno).not.toMatch(/[^/]`write-credentials\.ts`/)
    const reglas = readFileSync(path.join(ROOT, '.claude', 'rules', 'web.md'), 'utf8')
    expect(reglas).toContain('web/src/lib/operations/write-credentials.ts')
  })
})
