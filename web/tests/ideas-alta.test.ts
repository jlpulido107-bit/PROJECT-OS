import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'
import { render } from '../deploy/cloudrun/render.mjs'
import { decide } from '@/lib/authz'
import { estadoBandera } from '@/lib/banderas'
import { AGENT_OPERATIONS, WRITE_HEADERS, type OperationName } from '@/lib/operations/constants'
import { OperationError } from '@/lib/operations/errors'
import { evaluateWriteRequest } from '@/lib/operations/guard'
import { RateLimiter } from '@/lib/operations/rate-limit'
import { OperationsService, parseAudit } from '@/lib/operations/service'
import { InMemoryTableStore, readView } from '@/lib/operations/table-store'
import {
  ecoIdeasAltaHabilitada, parseAltaIdea, PRODUCTS_HEADERS, SCORING_HEADERS, type IdeasTab,
} from '@/lib/radaros/ideas-alta'
import { IdeasSheetsStore, InMemoryIdeasStore } from '@/lib/radaros/ideas-alta-store'

/** Alta de ideas en RADAROS por el PM (ORD-POS-131, DEC-ECO-007), con dobles de Sheets: ninguna prueba sale a la red. */

const AUT = 'PAQ-2026-11-01-01 «sí PAQ-2026-11-01-01» 2026-11-01'
let seq = 0
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`
const PM_CTX = { actor: 'agente-pm', agent: true } as const

const productsRow = (n: number) => [`EC-${String(n).padStart(3, '0')}`, `Idea ${n}`, 'Hogar', 'B1', 'Cliente', 'Problema', 'Amazon', 'N1', 'IDEA', 'Media', 250, 3000, 'No', 'Precio', 'Cotizar', 'PM']
const scoringRow = (n: number) => [`EC-${String(n).padStart(3, '0')}`, `Idea ${n}`, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3]

/** Libro sintético: 8 ideas (filas 2 a 9) y fórmulas M a P copiadas hasta la fila 12, como en la hoja real. */
function libro(opts: { formulasHasta?: number; products?: unknown[][]; scoring?: unknown[][] } = {}) {
  const products = opts.products ?? [[...PRODUCTS_HEADERS], ...Array.from({ length: 8 }, (_, i) => productsRow(i + 1))]
  const scoring = opts.scoring ?? [[...SCORING_HEADERS, 'Score', 'Total', 'Rank', 'Nota', 'IDEA_ID'], ...Array.from({ length: 8 }, (_, i) => scoringRow(i + 1))]
  const store = new InMemoryIdeasStore('LIBRO_RADAROS_SINTETICO', { PRODUCTS: products, SCORING: scoring })
  for (let fila = 2; fila <= (opts.formulasHasta ?? 12); fila++) {
    for (const col of [12, 13, 14, 15]) store.formulasHoja.set(`SCORING!${fila}!${col}`, `=IF(A${fila}="","",SUM(C${fila}:L${fila}))`)
  }
  return store
}

function servicio() {
  const store = new InMemoryTableStore({ AUDITORIA: [[...WRITE_HEADERS.AUDITORIA]] })
  return { store, service: new OperationsService(store, { mode: 'sheets' }) }
}

const body = (extra: Record<string, unknown> = {}) => ({
  requestId: uuid(), autorizacion: AUT, producto: 'Organizador de cables', categoria: 'Hogar', precioObservadoMxn: 199.5,
  owner: 'PM', puntajes: { demanda: 4, competencia: 2, marca: 5 }, ...extra,
})

const codeOf = async (p: Promise<unknown>) => {
  const e = await p.then(() => undefined, (x: unknown) => x)
  return e instanceof OperationError ? e.code : e
}

describe('idea.alta: servicio y libro (criterios 1, 3, 4, 5 y 7)', () => {
  it('alta correcta: EC-009 al final de PRODUCTS (A:P) y en la primera fila de SCORING con fórmulas (A:L), auditada como agente-pm', async () => {
    const ideas = libro()
    const antes = ideas.snapshot()
    const { store, service } = servicio()
    const cmd = parseAltaIdea(body())
    const r = await service.altaIdea(cmd, PM_CTX, ideas)
    expect(r).toEqual({ operacion: 'idea.alta', entidad: 'PRODUCTS', id: 'EC-009', repetida: false })

    expect(ideas.escrituras.map((e) => [e.tab, e.fila, e.celdas.length])).toEqual([['PRODUCTS', 10, 16], ['SCORING', 10, 12]])
    const despues = ideas.snapshot()
    expect(despues.PRODUCTS![9]).toEqual(['EC-009', 'Organizador de cables', 'Hogar', '', '', '', '', '', '', '', 199.5, '', '', '', '', 'PM'])
    // SCORING B se copia de PRODUCTS B; los puntajes sin dato quedan vacíos; M a P no se escriben.
    expect(despues.SCORING![9]).toEqual(['EC-009', 'Organizador de cables', 4, 2, '', '', '', '', '', '', '', 5])
    expect((await ideas.formulas('SCORING'))[9]!.slice(12, 16).every((f) => String(f).startsWith('='))).toBe(true)
    expect((await ideas.values('SCORING'))[9]![12]).toBe('calc:EC-009')
    // Filas existentes intactas.
    expect(despues.PRODUCTS!.slice(0, 9)).toEqual(antes.PRODUCTS)
    expect(despues.SCORING!.slice(0, 9)).toEqual(antes.SCORING)

    const audit = await readView(store, 'AUDITORIA')
    const [op] = parseAudit(audit)
    expect(op).toMatchObject({ operacion: 'idea.alta', entidad: 'PRODUCTS', id: 'EC-009', integridad: 'completa' })
    expect(op!.fields.get('AUTORIZACION')?.despues).toBe(AUT)
    expect(op!.fields.get('PRODUCTS!Producto / Idea')?.despues).toBe('Organizador de cables')
    expect(op!.fields.get('SCORING!Marca')?.despues).toBe('5')
    expect(audit.rows.every((row) => row.cells[2] === 'agente-pm' && /;op=idea\.alta;.*;agente=pm$/.test(row.cells[8]!))).toBe(true)
  })

  it('el ID sigue al mayor EC-NNN de la columna A de PRODUCTS, aunque haya huecos', async () => {
    const products = [[...PRODUCTS_HEADERS], productsRow(1), productsRow(7), productsRow(3)]
    const ideas = libro({ products, scoring: [[...SCORING_HEADERS], scoringRow(1), scoringRow(7), scoringRow(3)] })
    const r = await servicio().service.altaIdea(parseAltaIdea(body()), PM_CTX, ideas)
    expect(r.id).toBe('EC-008')
  })

  it('encabezado distinto en PRODUCTS o SCORING: no escribe nada, ni la auditoría, y dice en qué columnas', async () => {
    for (const tab of ['PRODUCTS', 'SCORING'] as IdeasTab[]) {
      const products = [[...PRODUCTS_HEADERS], productsRow(1)]
      const scoring = [[...SCORING_HEADERS], scoringRow(1)]
      ;(tab === 'PRODUCTS' ? products : scoring)[0]![3] = 'Otra'
      const ideas = libro({ products, scoring })
      const { store, service } = servicio()
      const e = await service.altaIdea(parseAltaIdea(body()), PM_CTX, ideas).catch((x: unknown) => x)
      expect(e).toBeInstanceOf(OperationError)
      expect((e as OperationError).code).toBe('idea-encabezados-distintos')
      expect((e as OperationError).detail).toEqual({ [tab]: 'D' })
      expect(ideas.escrituras).toEqual([])
      expect((await store.readTable('AUDITORIA')).length).toBe(1)
    }
  })

  it('fórmulas que no cubren la fila nueva de SCORING: no escribe nada, tampoco en PRODUCTS', async () => {
    const ideas = libro({ formulasHasta: 9 })
    const { store, service } = servicio()
    expect(await codeOf(service.altaIdea(parseAltaIdea(body()), PM_CTX, ideas))).toBe('scoring-sin-formulas')
    expect(ideas.escrituras).toEqual([])
    expect((await store.readTable('AUDITORIA')).length).toBe(1)
    // Una sola fórmula que falte (P) también deja la fila sin cubrir.
    const parcial = libro()
    parcial.formulasHoja.delete('SCORING!10!15')
    expect(await codeOf(servicio().service.altaIdea(parseAltaIdea(body()), PM_CTX, parcial))).toBe('scoring-sin-formulas')
    expect(parcial.escrituras).toEqual([])
  })

  it('la primera fila con PRODUCT_ID vacío pero con otros datos no se pisa', async () => {
    const products = [[...PRODUCTS_HEADERS], productsRow(1), ['', 'nota suelta']]
    const ideas = libro({ products, scoring: [[...SCORING_HEADERS], scoringRow(1)] })
    expect(await codeOf(servicio().service.altaIdea(parseAltaIdea(body()), PM_CTX, ideas))).toBe('idea-fila-ocupada')
    expect(ideas.escrituras).toEqual([])
  })

  it('tras escribir, M sin valor se reporta (idea-sin-calculo)', async () => {
    const ideas = libro()
    ideas.calcular = () => ''
    expect(await codeOf(servicio().service.altaIdea(parseAltaIdea(body()), PM_CTX, ideas))).toBe('idea-sin-calculo')
  })

  it('un ID nuevo que ya está en SCORING (sin PRODUCTS) no se escribe', async () => {
    const ideas = libro({ scoring: [[...SCORING_HEADERS], ...Array.from({ length: 9 }, (_, i) => scoringRow(i + 1))] })
    expect(await codeOf(servicio().service.altaIdea(parseAltaIdea(body()), PM_CTX, ideas))).toBe('conflicto-concurrente')
    expect(ideas.escrituras).toEqual([])
  })

  it('mismo requestId: no duplica; con otros datos, conflicto', async () => {
    const ideas = libro()
    const { service } = servicio()
    const cmd = parseAltaIdea(body())
    await service.altaIdea(cmd, PM_CTX, ideas)
    const otra = await service.altaIdea(cmd, PM_CTX, ideas)
    expect(otra).toMatchObject({ id: 'EC-009', repetida: true })
    expect(ideas.escrituras.length).toBe(2)
    expect(ideas.snapshot().PRODUCTS!.filter((r) => r[0] === 'EC-009').length).toBe(1)
    expect(await codeOf(service.altaIdea({ ...cmd, products: ['Otro', ...cmd.products.slice(1)] }, PM_CTX, ideas))).toBe('conflicto-idempotencia')
  })

  it('escritura a medias (falla SCORING): el mismo requestId completa lo que falta con lo auditado', async () => {
    const ideas = libro()
    const write = ideas.writeRow.bind(ideas)
    let falla = true
    ideas.writeRow = async (tab, fila, celdas) => {
      if (tab === 'SCORING' && falla) { falla = false; throw new Error('HTTP 503') }
      return write(tab, fila, celdas)
    }
    const { service } = servicio()
    const cmd = parseAltaIdea(body())
    expect(await codeOf(service.altaIdea(cmd, PM_CTX, ideas))).toBe('escritura-fallida')
    const r = await service.altaIdea(cmd, PM_CTX, ideas)
    expect(r).toMatchObject({ id: 'EC-009', repetida: true })
    expect(ideas.escrituras.map((e) => [e.tab, e.fila])).toEqual([['PRODUCTS', 10], ['SCORING', 10]])
    expect(ideas.snapshot().SCORING![9]).toEqual(['EC-009', 'Organizador de cables', 4, 2, '', '', '', '', '', '', '', 5])
  })
})

describe('idea.alta: validación del comando (criterio 5)', () => {
  const campos = (b: unknown) => {
    try { parseAltaIdea(b); return null } catch (e) { return (e as OperationError).fields }
  }

  it('puntajes: enteros del 1 al 5 o vacíos', () => {
    for (const v of [0, 6, 2.5, '3', -1]) expect(campos(body({ puntajes: { demanda: v } }))).toHaveProperty('puntajes.demanda')
    expect(campos(body({ puntajes: { demanda: 1, riesgo: 5, marca: null, tendencia: '' } }))).toBeNull()
    expect(campos(body({ puntajes: { otro: 3 } }))).toHaveProperty('puntajes.otro')
  })

  it('autorización «sí PAQ», producto obligatorio y sin campos de más', () => {
    expect(campos(body({ autorizacion: undefined }))).toHaveProperty('autorizacion')
    expect(campos(body({ autorizacion: 'PAQ-2026-11-01-01 «ok» 2026-11-01' }))).toHaveProperty('autorizacion')
    expect(campos(body({ autorizacion: 'PAQ-2026-11-01-01 «sí PAQ-2026-11-01-02» 2026-11-01' }))).toHaveProperty('autorizacion')
    expect(campos(body({ autorizacion: 'PAQ-2026-11-01-01 «sí PAQ-2026-11-01-01» 2026-02-30' }))).toHaveProperty('autorizacion')
    expect(campos(body({ producto: '' }))).toHaveProperty('producto')
    expect(campos(body({ productId: 'EC-050' }))).toHaveProperty('productId')
    expect(campos(body({ precioObservadoMxn: 'mucho' }))).toHaveProperty('precioObservadoMxn')
  })

  it('texto que empieza por = se neutraliza (nunca una fórmula)', () => {
    expect(parseAltaIdea(body({ producto: '=IMPORTXML("x")' })).products[0]).toBe('\'=IMPORTXML("x")')
  })
})

describe('idea.alta: bandera, guard y proxy (criterios 1 y 6)', () => {
  const PM = 'token-pm-sintetico-0123456789'
  const ORIGIN = 'http://127.0.0.1:3000'
  const sha = (t: string) => createHash('sha256').update(t).digest('hex')
  const BASE = { PM_AGENT_TOKEN_SHA256: sha(PM), PROJECT_OS_WRITE_MODE: 'mock', DASHBOARD_DATA_SOURCE: 'fixtures', AUTH_ALLOWED_EMAILS: 'escritor@example.com', AUTH_WRITER_EMAILS: 'escritor@example.com' }
  const env = (extra: Record<string, string | undefined>) => ({ ...BASE, ...extra }) as unknown as NodeJS.ProcessEnv
  const ctx = (e: NodeJS.ProcessEnv, email: string | null = null, operation: OperationName = 'idea.alta') => ({
    email, env: e, limiter: new RateLimiter(), agentLimiter: new RateLimiter(5, 60_000), operation,
  })
  const alta = (headers: Record<string, string>) => new Request(`${ORIGIN}/api/operaciones/ideas`, {
    method: 'POST', body: JSON.stringify(body()), headers: { 'content-type': 'application/json', ...headers },
  })

  it('bandera apagada (o con otro valor): inerte, operacion-no-permitida antes de leer el cuerpo', async () => {
    for (const valor of [undefined, 'TRUE', 'on', '1']) {
      expect(await codeOf(evaluateWriteRequest(alta({ authorization: `Bearer ${PM}` }), ctx(env({ ECO_IDEAS_ALTA: valor })))), String(valor)).toBe('operacion-no-permitida')
    }
  })

  it('bandera encendida: solo el token del PM, como agente-pm; una sesión de navegador nunca', async () => {
    const r = await evaluateWriteRequest(alta({ authorization: `Bearer ${PM}` }), ctx(env({ ECO_IDEAS_ALTA: 'true' })))
    expect(r).toMatchObject({ actor: 'agente-pm', agent: true })
    expect(await codeOf(evaluateWriteRequest(alta({ authorization: 'Bearer otro-token-0123456789' }), ctx(env({ ECO_IDEAS_ALTA: 'true' }))))).toBe('no-autenticado')
    const sesion = alta({ origin: ORIGIN, 'x-project-os-csrf': '1' })
    expect(await codeOf(evaluateWriteRequest(sesion, ctx(env({ ECO_IDEAS_ALTA: 'true', NEXTAUTH_URL: ORIGIN }), 'escritor@example.com')))).toBe('operacion-no-permitida')
    expect(AGENT_OPERATIONS).not.toContain('idea.alta')
  })

  it('encendida de verdad solo con la escritura del pipeline activa (su cuenta y RADAROS_SHEET_ID)', () => {
    expect(ecoIdeasAltaHabilitada(env({ ECO_IDEAS_ALTA: 'true' }))).toBe(false)
    expect(estadoBandera('ECO_IDEAS_ALTA', env({ ECO_IDEAS_ALTA: 'true' }))).toMatchObject({ tipo: 'apagada' })
    const pipeline = {
      ECO_IDEAS_ALTA: 'true', ECO_PIPELINE_WRITE_MODE: 'sheets', RADAROS_SHEET_ID: 'LIBRO_RADAROS_SINTETICO_0123456789',
      SHEETS_SPREADSHEET_ID: 'HOJA_PROJECT_OS_SINTETICA_0123456789', SHEETS_EXPECTED_SERVICE_ACCOUNT: 'lector@project-os-511102.iam.gserviceaccount.com',
      ECO_PIPELINE_WRITE_SERVICE_ACCOUNT: 'project-os-eco@project-os-511102.iam.gserviceaccount.com', ECO_PIPELINE_WRITER_EMAIL: 'escritor@example.com',
    }
    expect(ecoIdeasAltaHabilitada(env(pipeline))).toBe(true)
    expect(ecoIdeasAltaHabilitada(env({ ...pipeline, ECO_IDEAS_ALTA: 'TRUE' }))).toBe(false)
  })

  it('el proxy deja pasar el token del PM a POST /api/operaciones/ideas y nada más', async () => {
    const e = env({})
    const req = (method: string) => new NextRequest(new URL('/api/operaciones/ideas', ORIGIN), { method, headers: { authorization: `Bearer ${PM}` } })
    const d = (r: NextRequest) => decide(r, { secret: 'secreto-de-prueba-0123456789abcdef', agentTokenSha256: e.PM_AGENT_TOKEN_SHA256 })
    expect((await d(req('POST'))).action).toBe('agent')
    expect((await d(req('PATCH'))).action).not.toBe('agent')
  })
})

describe('idea.alta: adaptador de Sheets (criterio 4)', () => {
  it('escribe un solo rango A:P o A:L en RAW y nunca otra pestaña ni otro ancho', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : null })
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const store = new IdeasSheetsStore({ spreadsheetId: 'LIBRO', getWriteToken: async () => 't', fetchImpl })
    await store.writeRow('PRODUCTS', 10, Array.from({ length: 16 }, () => ''))
    await store.writeRow('SCORING', 10, Array.from({ length: 12 }, () => ''))
    expect(calls.map((c) => (c.body as { data: Array<{ range: string }> }).data[0]!.range)).toEqual(["'PRODUCTS'!A10:P10", "'SCORING'!A10:L10"])
    expect(calls.every((c) => c.url.endsWith('/values:batchUpdate') && (c.body as { valueInputOption: string }).valueInputOption === 'RAW')).toBe(true)
    await expect(store.writeRow('SCORING', 10, Array.from({ length: 16 }, () => ''))).rejects.toThrow('ancho')
    await expect(store.writeRow('PIPE_PRODUCTOS' as IdeasTab, 10, [])).rejects.toThrow('lista cerrada')
    await expect(store.writeRow('PRODUCTS', 1, Array.from({ length: 16 }, () => ''))).rejects.toThrow('fila')
    expect(calls.length).toBe(2)
  })
})

describe('render.mjs (criterio 6)', () => {
  const template = readFileSync(path.join(__dirname, '..', 'deploy', 'cloudrun', 'service.template.yaml'), 'utf8')
  const BASE = {
    SERVICE_NAME: 'project-os-dashboard', PROJECT_ID: 'project-os-511102', REGION: 'northamerica-south1',
    IMAGE: `us-docker.pkg.dev/proj-os-1/repo/dash@sha256:${'a'.repeat(64)}`, RUNTIME_SA: 'runtime@project-os-511102.iam.gserviceaccount.com',
    SERVICE_URL: 'https://dash.example.com', OAUTH_CLIENT_ID: '123-abc.apps.googleusercontent.com', SECRET_VERSION_NEXTAUTH: '1',
    SECRET_VERSION_OAUTH: '1', SECRET_VERSION_ALLOWLIST: '1', WRITE_MODE: 'sheets', WRITE_SERVICE_ACCOUNT: 'writer@project-os-511102.iam.gserviceaccount.com',
    SECRET_VERSION_WRITERS: '1', SECRET_VERSION_PM_AGENT: '7',
  }
  const PIPE = {
    RADAROS_SHEET_ID: 'LIBRO_RADAROS_SINTETICO_0123456789', ECO_PIPELINE_WRITE_MODE: 'sheets',
    ECO_PIPELINE_WRITE_SERVICE_ACCOUNT: 'project-os-eco@project-os-511102.iam.gserviceaccount.com', ECO_PIPELINE_WRITER_EMAIL: 'dueno@example.com',
  }

  it('sin la bandera el YAML no la lleva; con true y la escritura del pipeline, sí', () => {
    expect(render(template, { ...BASE, ...PIPE })).not.toContain('ECO_IDEAS_ALTA')
    expect(render(template, { ...BASE, ...PIPE, ECO_IDEAS_ALTA: 'true' })).toContain("- name: ECO_IDEAS_ALTA\n              value: 'true'")
  })

  it('rechaza otro valor, o la bandera sin el pipeline o sin el token del PM', () => {
    expect(() => render(template, { ...BASE, ...PIPE, ECO_IDEAS_ALTA: 'on' })).toThrow('ECO_IDEAS_ALTA solo admite true')
    expect(() => render(template, { ...BASE, ECO_IDEAS_ALTA: 'true' })).toThrow('ECO_IDEAS_ALTA exige ECO_PIPELINE_WRITE_MODE=sheets')
    expect(() => render(template, { ...BASE, ...PIPE, SECRET_VERSION_PM_AGENT: '', ECO_IDEAS_ALTA: 'true' })).toThrow('SECRET_VERSION_PM_AGENT')
  })
})
