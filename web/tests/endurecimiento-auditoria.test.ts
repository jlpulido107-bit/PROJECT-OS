import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import * as metricasUi from '@/components/metricas'
import { FinanzasSheetsStore } from '@/lib/finanzas/escritura-store'
import { createGitHubClient, GitHubError } from '@/lib/operations/github'
import { OperationError } from '@/lib/operations/errors'
import { CSRF_HEADER, evaluateWriteRequest } from '@/lib/operations/guard'
import { mapaDeProceso } from '@/lib/operations/process-map'
import { RateLimiter } from '@/lib/operations/rate-limit'
import { operacionSupervision } from '@/lib/operations/revision'
import { SheetsTableStore } from '@/lib/operations/sheets-table-store'
import { decodeIdRuta } from '@/lib/operations/validation'
import { enParalelo, LLAMADAS_ORDENES, PARALELO_ORDENES } from '@/lib/ordenes'
import { parseEco } from '@/lib/radaros/pipeline-escritura-validacion'
import { MAX_DATA_ROWS, ULTIMA_COLUMNA } from '@/lib/schema'
import { createHash } from 'node:crypto'

/** ORD-POS-154: endurecimiento menor tras la auditoría (PAQ-2026-11-10-01). Una prueba por criterio. */

const SRC = path.join(__dirname, '..', 'src')
const fuente = (rel: string) => readFileSync(path.join(SRC, rel), 'utf8')
const codigoDe = async (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof OperationError ? e.code : String(e)))

describe('criterio 1 (DIS-02, DIS-07): los adaptadores leen hasta ULTIMA_COLUMNA', () => {
  it('SheetsTableStore.readTable y FinanzasSheetsStore.read piden A1:<ULTIMA_COLUMNA>, no A1:Z', async () => {
    const urls: string[] = []
    const fetchImpl = (async (url: string) => {
      urls.push(decodeURIComponent(url))
      return new Response(JSON.stringify({ values: [], valueRanges: [{ values: [] }] }), { status: 200 })
    }) as unknown as typeof fetch
    const opts = { spreadsheetId: 'LIBRO_SINTETICO', getWriteToken: async () => 'token-falso', fetchImpl }
    await new SheetsTableStore(opts).readTable('TAREAS')
    await new FinanzasSheetsStore(opts).read(['MOVIMIENTOS'])
    const esperado = `!A1:${ULTIMA_COLUMNA}${MAX_DATA_ROWS + 2}`
    expect(ULTIMA_COLUMNA).not.toBe('Z')
    expect(urls).toHaveLength(2)
    for (const u of urls) {
      expect(u).toContain(esperado)
      expect(u).not.toContain(`!A1:Z${MAX_DATA_ROWS + 2}`)
    }
  })
})

describe('criterio 2 (SEC-07): decodeURIComponent seguro en las rutas [id]', () => {
  it('un ID mal codificado es OperationError validacion (4xx), nunca un URIError que acabe en 500', () => {
    expect(decodeIdRuta('ORD-POS-001')).toBe('ORD-POS-001')
    expect(decodeIdRuta('POS%2D001')).toBe('POS-001')
    for (const malo of ['%', '%E0%A4%A', 'ORD-POS-%zz']) {
      let error: unknown
      try { decodeIdRuta(malo) } catch (e) { error = e }
      expect(error).toBeInstanceOf(OperationError)
      expect((error as OperationError).code).toBe('validacion')
      expect((error as OperationError).status).toBeLessThan(500)
    }
  })

  it('las cinco rutas [id] de operaciones usan decodeIdRuta y ninguna llama a decodeURIComponent', () => {
    const rutas = ['tareas/[id]', 'tareas/[id]/completar', 'ordenes/[id]', 'ordenes/[id]/supervision', 'ordenes/[id]/ejecutar']
    for (const r of rutas) {
      const s = fuente(`app/api/operaciones/${r}/route.ts`)
      expect(s, r).toContain('decodeIdRuta(id)')
      expect(s, r).not.toContain('decodeURIComponent')
    }
  })
})

describe('criterio 3 (DIS-03): los «en curso» de dispatch y revision viven en globalThis con Symbol.for', () => {
  it('mapaDeProceso guarda un único Map por nombre en globalThis[Symbol.for(...)]', () => {
    const a = mapaDeProceso<string, number>('prueba.endurecimiento')
    a.set('x', 1)
    expect(mapaDeProceso<string, number>('prueba.endurecimiento')).toBe(a)
    expect((globalThis as unknown as Record<symbol, unknown>)[Symbol.for('project-os.prueba.endurecimiento')]).toBe(a)
    a.clear()
  })

  it('dispatch.ts (envíos y ejecuciones) y revision.ts (supervisiones) ya no usan un Map de módulo', () => {
    const dispatch = fuente('lib/operations/dispatch.ts')
    const revision = fuente('lib/operations/revision.ts')
    expect(dispatch).toContain("mapaDeProceso<string, Promise<EnvioInfo>>('dispatch.envios-en-curso')")
    expect(dispatch).toContain("mapaDeProceso<string, Promise<EjecucionInfo>>('dispatch.ejecuciones-en-curso')")
    expect(revision).toContain("mapaDeProceso<string, Promise<SupervisionInfo>>('revision.supervisiones-en-curso')")
    for (const s of [dispatch, revision]) expect(s).not.toMatch(/=\s*new Map<string, Promise</)
  })
})

describe('criterio 4 (DIS-05): supervisión pasa al guard la operación real', () => {
  const ORIGIN = 'http://127.0.0.1:3000'
  const ESCRITOR = 'escritor@example.com'
  const TOKEN = 'token-de-prueba-sintetico-0123456789'
  const ENV = {
    NEXTAUTH_URL: ORIGIN, AUTH_ALLOWED_EMAILS: ESCRITOR, AUTH_WRITER_EMAILS: ESCRITOR, PROJECT_OS_WRITE_MODE: 'mock', DASHBOARD_DATA_SOURCE: 'fixtures',
    PM_AGENT_TOKEN_SHA256: createHash('sha256').update(TOKEN).digest('hex'),
  } as unknown as NodeJS.ProcessEnv
  const req = (body: unknown, headers: Record<string, string>) => new Request(`${ORIGIN}/api/operaciones/ordenes/ORD-POS-001/supervision`, {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers },
  })
  const sesion = { origin: ORIGIN, [CSRF_HEADER]: '1', 'sec-fetch-site': 'same-origin' }

  it('operacionSupervision da corregir_lanzar solo con CORREGIR (normalizado como el parser)', () => {
    expect(operacionSupervision({ accion: 'CORREGIR' })).toBe('orden.corregir_lanzar')
    expect(operacionSupervision({ accion: ' corregir ' })).toBe('orden.corregir_lanzar')
    expect(operacionSupervision({ accion: 'REVISAR' })).toBe('orden.revisar_lanzar')
    expect(operacionSupervision({})).toBe('orden.revisar_lanzar')
    expect(operacionSupervision(null)).toBe('orden.revisar_lanzar')
  })

  it('la política no cambia: el escritor con sesión lanza revisar y corregir; el agente PM no puede ninguna', async () => {
    for (const accion of ['REVISAR', 'CORREGIR']) {
      const r = await evaluateWriteRequest(req({ accion }, sesion), {
        email: ESCRITOR, env: ENV, limiter: new RateLimiter(), operation: 'orden.revisar_lanzar', operationFromBody: operacionSupervision,
      })
      expect(r.actor).toBe(ESCRITOR)
      expect(r.body).toEqual({ accion })
      expect(await codigoDe(evaluateWriteRequest(req({ accion }, { authorization: `Bearer ${TOKEN}` }), {
        email: null, env: ENV, limiter: new RateLimiter(), agentLimiter: new RateLimiter(5, 60_000), operation: 'orden.revisar_lanzar', operationFromBody: operacionSupervision,
      }))).toBe('operacion-no-permitida')
    }
  })

  it('el guard evalúa la operación real tras leer el cuerpo (sesión y agente)', async () => {
    // Con una operación real de política distinta, manda la real: así una política futura para corregir aplica.
    expect(await codigoDe(evaluateWriteRequest(req({}, sesion), {
      email: ESCRITOR, env: ENV, limiter: new RateLimiter(), operation: 'orden.revisar_lanzar', operationFromBody: () => 'tarea.completar',
    }))).toBe('cierre-no-permitido')
    expect(await codigoDe(evaluateWriteRequest(req({ accion: 'APROBAR' }, { authorization: `Bearer ${TOKEN}` }), {
      email: null, env: ENV, limiter: new RateLimiter(), agentLimiter: new RateLimiter(5, 60_000), operation: 'orden.aprobar', operationFromBody: () => 'orden.corregir_lanzar',
    }))).toBe('operacion-no-permitida')
  })

  it('la ruta pasa operacionSupervision a handleWrite', () => {
    expect(fuente('app/api/operaciones/ordenes/[id]/supervision/route.ts')).toContain("200, 'orden.revisar_lanzar', operacionSupervision)")
  })
})

describe('criterio 5 (SEC-01, matiz): el texto libre del pipeline ECO pasa por safeCellText', () => {
  it('el texto se escribe limpio y una fórmula se sigue rechazando', () => {
    const cmd = parseEco('eco.producto.crear', {
      requestId: '00000000-0000-4000-8000-000000000154', nombre: 'Termo\u0007 sintético', notas: 'línea 1\r\n\n\n\nlínea 2',
    })
    expect(cmd.valores.NOMBRE).toBe('Termo sintético')
    expect(cmd.valores.NOTAS).toBe('línea 1\n\nlínea 2')
    let error: unknown
    try { parseEco('eco.producto.crear', { requestId: '00000000-0000-4000-8000-000000000155', nombre: '=IMPORTXML("x")' }) } catch (e) { error = e }
    expect((error as OperationError).code).toBe('validacion')
    const s = fuente('lib/radaros/pipeline-escritura-validacion.ts')
    expect(s).toMatch(/function textoLimpio[\s\S]*?return safeCellText\(raw, multilinea\)\n\}/)
  })
})

describe('criterio 6 (SEC-08): /ordenes con tope de llamadas y no más de 6 consultas a la vez', () => {
  it('enParalelo nunca tiene más de PARALELO_ORDENES (6) en curso y procesa todo', async () => {
    expect(PARALELO_ORDENES).toBe(6)
    let enCurso = 0
    let maximo = 0
    const hechos: number[] = []
    await enParalelo(Array.from({ length: 20 }, (_, i) => i), async (i) => {
      enCurso++
      maximo = Math.max(maximo, enCurso)
      await new Promise((r) => setTimeout(r, 1))
      hechos.push(i)
      enCurso--
    })
    expect(maximo).toBe(6)
    expect(hechos.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i))
    await enParalelo([], async () => { throw new Error('no se llama') })
  })

  it('el cliente con maxLlamadas corta en el tope sin llamar a GitHub, y la página lo usa', async () => {
    let llamadas = 0
    const fetchImpl = (async () => { llamadas++; return new Response('[]', { status: 200 }) }) as unknown as typeof fetch
    const client = createGitHubClient('token-falso', fetchImpl, { maxLlamadas: LLAMADAS_ORDENES })
    expect(client.llamadasRestantes()).toBe(LLAMADAS_ORDENES)
    const agotado = createGitHubClient('token-falso', fetchImpl, { maxLlamadas: 0 })
    await expect(agotado.prDeOrden('POS', 'ORD-POS-001')).rejects.toBeInstanceOf(GitHubError)
    expect(llamadas).toBe(0)
    const pagina = fuente('app/(private)/ordenes/page.tsx')
    expect(pagina.match(/githubClient\(process\.env, \{ maxLlamadas: LLAMADAS_ORDENES \}\)/g)).toHaveLength(2)
    expect(pagina).not.toMatch(/githubClient\(\)/)
    expect(pagina).not.toContain('Promise.all')
    expect(pagina.match(/await enParalelo\(/g)).toHaveLength(3)
  })
})

describe('criterio 7 (DIS-08): /metricas sin CostoPendiente', () => {
  it('ni el componente ni la sección «Costo por orden» existen; el costo vive en /finanzas', () => {
    expect('CostoPendiente' in metricasUi).toBe(false)
    const pagina = fuente('app/(private)/metricas/page.tsx')
    expect(pagina).not.toContain('CostoPendiente')
    expect(pagina).not.toContain('Costo por orden')
  })
})
