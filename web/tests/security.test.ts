import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/** Revisiones estáticas: solo lectura, nada de secretos hacia el navegador. */

const SRC = path.join(__dirname, '..', 'src')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? files(full) : /\.(ts|tsx)$/.test(name) ? [full] : []
  })
}

const sources = files(SRC).map((file) => ({ file: path.relative(SRC, file), text: readFileSync(file, 'utf8') }))

const SERVER_ONLY_MODULES = ['lib/config', 'lib/data', 'lib/sheets-client', 'lib/auth', 'lib/page-data', 'lib/credentials', 'lib/deployment']

describe('garantías de seguridad del código', () => {
  // V1.8: el único archivo con endpoints de escritura es el adaptador; solo runtime.ts lo importa, y solo
  // write-credentials.ts pide el alcance de escritura (suplantando la cuenta de escritura dedicada).
  const WRITE_ADAPTER = path.join('lib', 'operations', 'sheets-table-store.ts')
  const WRITE_RUNTIME = path.join('lib', 'operations', 'runtime.ts')
  const WRITE_CREDENTIALS = path.join('lib', 'operations', 'write-credentials.ts')
  // ORD-POS-077: la escritura de finanzas tiene su propio adaptador, ligado solo al libro FINANZAS, y su propio runtime,
  // que suplanta a la cuenta exclusiva de FINANZAS con el mismo proveedor de token.
  const FINANZAS_ADAPTER = path.join('lib', 'finanzas', 'escritura-store.ts')
  const FINANZAS_RUNTIME = path.join('lib', 'finanzas', 'escritura-runtime.ts')
  // ORD-POS-092: el agente de finanzas usa el mismo adaptador (solo FINANZAS) desde su propio runtime y con su cuenta.
  const AGENTE_RUNTIME = path.join('lib', 'finanzas', 'agente-runtime.ts')
  const RUNTIMES_FINANZAS = [FINANZAS_RUNTIME, AGENTE_RUNTIME]
  // ORD-POS-102: la escritura del pipeline de /eco tiene su propio adaptador, ligado solo al libro de RADAROS y a la
  // lista cerrada de pestañas PIPE_*, y su propio runtime, que suplanta a la cuenta exclusiva del pipeline.
  const ECO_ADAPTER = path.join('lib', 'radaros', 'pipeline-escritura-store.ts')
  const ECO_RUNTIME = path.join('lib', 'radaros', 'pipeline-escritura-runtime.ts')
  // ORD-POS-131 (DEC-ECO-007): el alta de ideas tiene su propio adaptador, ligado solo al libro de RADAROS y a PRODUCTS y
  // SCORING (A:P y A:L), y su propio runtime, que suplanta a la misma cuenta del pipeline de /eco.
  const IDEAS_ADAPTER = path.join('lib', 'radaros', 'ideas-alta-store.ts')
  const IDEAS_RUNTIME = path.join('lib', 'radaros', 'ideas-alta-runtime.ts')
  // Módulos de V1.4 que solo pueden ejecutarse en el servidor (estado simulado y manejo de escrituras).
  SERVER_ONLY_MODULES.push('lib/operations/runtime', 'lib/operations/http', 'lib/finanzas/escritura-runtime', 'lib/finanzas/escritura-http', 'lib/finanzas/agente-runtime', 'lib/finanzas/agente-http', 'lib/radaros/pipeline-escritura-runtime', 'lib/radaros/pipeline-escritura-http', 'lib/radaros/ideas-alta-runtime')

  it('ningún código llama endpoints de escritura de Sheets ni usa el alcance de escritura', () => {
    for (const { file, text } of sources) {
      if (file !== WRITE_ADAPTER && file !== FINANZAS_ADAPTER && file !== ECO_ADAPTER && file !== IDEAS_ADAPTER) {
        expect(text, file).not.toMatch(/:append|:batchUpdate|:clear|values:update|batchUpdateByDataFilter/)
        // Quien hable con las APIs de Google solo puede leer (salvo pedir el token de escritura a IAM Credentials).
        if (/googleapis\.com/.test(text) && file !== WRITE_CREDENTIALS) expect(text, file).not.toMatch(/method:\s*'(PUT|POST|PATCH|DELETE)'/)
      }
      if (file !== WRITE_CREDENTIALS) expect(text, file).not.toMatch(/auth\/spreadsheets['"]/)
      expect(text, file).not.toMatch(/auth\/drive/)
      expect(text, file).not.toMatch(/USER_ENTERED/)
    }
  })

  it('el adaptador de escritura y el token de escritura solo se usan desde runtime.ts (y finanzas desde su runtime)', () => {
    for (const { file, text } of sources) {
      if (!RUNTIMES_FINANZAS.includes(file)) expect(text, file).not.toMatch(/new FinanzasSheetsStore/)
      if (file !== ECO_RUNTIME) expect(text, file).not.toMatch(/new EcoSheetsStore/)
      if (file !== IDEAS_RUNTIME) expect(text, file).not.toMatch(/new IdeasSheetsStore/)
      if (file === WRITE_ADAPTER || file === WRITE_RUNTIME) continue
      if (!RUNTIMES_FINANZAS.includes(file) && file !== ECO_RUNTIME && file !== IDEAS_RUNTIME) expect(text, file).not.toMatch(/(from|import\(|require\()\s*['"][^'"]*write-credentials['"]/)
      expect(text, file).not.toMatch(/(from|import\(|require\()\s*['"][^'"]*sheets-table-store['"]/)
      expect(text, file).not.toMatch(/new SheetsTableStore/)
    }
    const adapter = sources.find((s) => s.file === WRITE_ADAPTER)!.text
    expect(adapter).toMatch(/valueInputOption=RAW/)
    expect(adapter).not.toMatch(/process\.env|google-auth-library|readFileSync/)
    const finanzas = sources.find((s) => s.file === FINANZAS_ADAPTER)!.text
    expect(finanzas).toMatch(/valueInputOption=RAW/)
    expect(finanzas).not.toMatch(/process\.env|google-auth-library|readFileSync|:batchUpdate|:clear|values:update|method:\s*'(PUT|PATCH|DELETE)'/)
    // El runtime de finanzas solo usa FINANZAS_SHEET_ID y la cuenta exclusiva, nunca la hoja ni la cuenta de PROJECT-OS.
    const runtime = sources.find((s) => s.file === FINANZAS_RUNTIME)!.text
    expect(runtime).toMatch(/finanzasSheetId\(env\)/)
    expect(runtime).toMatch(/finanzasWriteServiceAccount\(env\)/)
    expect(runtime).not.toMatch(/spreadsheetId\(\)|SHEETS_SPREADSHEET_ID|writeServiceAccount\(|PROJECT_OS_WRITE_SERVICE_ACCOUNT|SheetsTableStore|OperationsService/)
    // El del agente, igual pero con SU cuenta: nunca la del propietario.
    const agente = sources.find((s) => s.file === AGENTE_RUNTIME)!.text
    expect(agente).toMatch(/finanzasSheetId\(env\)/)
    expect(agente).toMatch(/finanzasAgenteServiceAccount\(env\)/)
    expect(agente).not.toMatch(/finanzasWriteServiceAccount|FinanzasWriteService\b|spreadsheetId\(\)|SHEETS_SPREADSHEET_ID|writeServiceAccount\(|PROJECT_OS_WRITE_SERVICE_ACCOUNT|SheetsTableStore|OperationsService/)
    // ORD-POS-102: el adaptador del pipeline solo edita valores en RAW (append y values:batchUpdate), nunca borra ni
    // cambia la estructura del libro; su runtime usa solo RADAROS_SHEET_ID y la cuenta exclusiva del pipeline.
    const eco = sources.find((s) => s.file === ECO_ADAPTER)!.text
    expect(eco).toMatch(/valueInputOption=RAW/)
    expect(eco).toMatch(/valueInputOption: 'RAW'/)
    expect(eco).not.toMatch(/process\.env|google-auth-library|readFileSync|:clear|values:update|batchUpdateByDataFilter|deleteDimension|method:\s*'(PUT|PATCH|DELETE)'/)
    expect(eco.match(/:batchUpdate/g)).toEqual([':batchUpdate'])
    expect(eco).toMatch(/'\/values:batchUpdate'/)
    const ecoRuntime = sources.find((s) => s.file === ECO_RUNTIME)!.text
    expect(ecoRuntime).toMatch(/radarosSheetId\(env\)/)
    expect(ecoRuntime).toMatch(/ecoPipelineWriteServiceAccount\(env\)/)
    expect(ecoRuntime).not.toMatch(/finanzas|FINANZAS|spreadsheetId\(\)|SHEETS_SPREADSHEET_ID|writeServiceAccount\(|PROJECT_OS_WRITE_SERVICE_ACCOUNT|SheetsTableStore|OperationsService/)
    // ORD-POS-131: el adaptador del alta de ideas solo escribe un rango por llamada con values:batchUpdate en RAW (sin
    // append ni borrado); su runtime usa solo RADAROS_SHEET_ID y la cuenta del pipeline, y exige la bandera.
    const ideas = sources.find((s) => s.file === IDEAS_ADAPTER)!.text
    expect(ideas).toMatch(/valueInputOption: 'RAW'/)
    expect(ideas).not.toMatch(/process\.env|google-auth-library|readFileSync|:append|:clear|values:update|batchUpdateByDataFilter|deleteDimension|method:\s*'(PUT|PATCH|DELETE)'/)
    expect(ideas.match(/:batchUpdate/g)).toEqual([':batchUpdate'])
    const ideasRuntime = sources.find((s) => s.file === IDEAS_RUNTIME)!.text
    expect(ideasRuntime).toMatch(/radarosSheetId\(env\)/)
    expect(ideasRuntime).toMatch(/ecoPipelineWriteServiceAccount\(env\)/)
    expect(ideasRuntime).toMatch(/ecoIdeasAltaHabilitada\(env\)/)
    expect(ideasRuntime).not.toMatch(/finanzas|FINANZAS|spreadsheetId\(\)|SHEETS_SPREADSHEET_ID|writeServiceAccount\(|PROJECT_OS_WRITE_SERVICE_ACCOUNT|SheetsTableStore|OperationsService/)
  })

  it('las rutas de finanzas pasan por su guard propio, que rechaza Authorization antes de la sesión y del cuerpo', () => {
    const agenteDir = path.join('app', 'api', 'finanzas', 'agente')
    const routes = sources.filter((s) => s.file.startsWith(path.join('app', 'api', 'finanzas')) && !s.file.startsWith(agenteDir) && s.file.endsWith('route.ts'))
    expect(routes.length).toBe(2)
    for (const { file, text } of routes) {
      expect(text, file).toMatch(/handleFinanzasWrite\(request,/)
      expect(text, file).not.toMatch(/handleWrite\(|operationsService|export async function (GET|PUT|PATCH|DELETE)/)
    }
    const handler = sources.find((s) => s.file === path.join('lib', 'finanzas', 'escritura-handler.ts'))!.text
    expect(handler.indexOf('rejectAuthorization(request)')).toBeGreaterThan(-1)
    expect(handler.indexOf('rejectAuthorization(request)')).toBeLessThan(handler.indexOf('deps.sessionEmail()'))
    expect(handler.indexOf('evaluateFinanzasWriteRequest(')).toBeLessThan(handler.indexOf('deps.service()'))
    expect(handler.indexOf('deps.service()')).toBeLessThan(handler.indexOf('await run('))
    const guard = sources.find((s) => s.file === path.join('lib', 'finanzas', 'escritura-guard.ts'))!.text
    expect(guard).not.toMatch(/operations\/guard'|PM_AGENT_TOKEN|agentLimiter|AGENT_|evaluateWriteRequest\(|FINANZAS_AGENTE/)
  })

  it('las rutas del agente de finanzas (ORD-POS-092) pasan por su guard propio: token antes del cuerpo y del servicio', () => {
    const routes = sources.filter((s) => s.file.startsWith(path.join('app', 'api', 'finanzas', 'agente')) && s.file.endsWith('route.ts'))
    expect(routes.map((r) => r.file).sort()).toEqual([
      path.join('app', 'api', 'finanzas', 'agente', 'cargo-extra', 'route.ts'), path.join('app', 'api', 'finanzas', 'agente', 'rendimiento', 'route.ts'),
    ])
    for (const { file, text } of routes) {
      expect(text, file).toMatch(/handleFinanzasAgente\(request,/)
      expect(text, file).not.toMatch(/handleWrite\(|handleFinanzasWrite\(|operationsService|export async function (GET|PUT|PATCH|DELETE)/)
    }
    const handler = sources.find((s) => s.file === path.join('lib', 'finanzas', 'agente-handler.ts'))!.text
    expect(handler.indexOf('rejectNonAgent(request')).toBeGreaterThan(-1)
    expect(handler.indexOf('rejectNonAgent(request')).toBeLessThan(handler.indexOf('evaluateFinanzasAgenteRequest('))
    expect(handler.indexOf('evaluateFinanzasAgenteRequest(')).toBeLessThan(handler.indexOf('deps.service()'))
    expect(handler.indexOf('deps.service()')).toBeLessThan(handler.indexOf('await run('))
    expect(handler).not.toMatch(/sessionEmail|getServerSession/)
    const guard = sources.find((s) => s.file === path.join('lib', 'finanzas', 'agente-guard.ts'))!.text
    expect(guard).not.toMatch(/operations\/guard'|escritura-guard'|agentLimiter|AGENT_OPERATIONS|evaluateWriteRequest\(|evaluateFinanzasWriteRequest\(/)
  })

  it('todas las rutas de escritura pasan por la guarda del servidor', () => {
    const routes = sources.filter((s) => s.file.startsWith(path.join('app', 'api', 'operaciones')) && s.file.endsWith('route.ts'))
    expect(routes.length).toBe(13) // ORD-POS-139: + /api/operaciones/capacidad; ORD-POS-141: + escenarios y escenarios/archivar
    for (const { file, text } of routes) {
      expect(text, file).toMatch(/handleWrite\(request,/)
      expect(text, file).not.toMatch(/export async function (GET|PUT|DELETE)/)
    }
    const http = sources.find((s) => s.file === path.join('lib', 'operations', 'http.ts'))!.text
    expect(http.indexOf('evaluateWriteRequest(')).toBeLessThan(http.indexOf('await run('))
  })

  it('el modo sheets exige datos reales y una cuenta de escritura distinta de la lectora', () => {
    const config = sources.find((s) => s.file === path.join('lib', 'operations', 'config.ts'))!.text
    expect(config).toMatch(/requested === 'sheets'[\s\S]*?sheets-requiere-datos-reales[\s\S]*?sheets-sin-cuenta-escritura[\s\S]*?sheets-misma-cuenta/)
    const credentials = sources.find((s) => s.file === WRITE_CREDENTIALS)!.text
    expect(credentials).toMatch(/generateAccessToken/)
    expect(credentials).not.toMatch(/auth\/drive|private_key|readFileSync|JWT/)
  })

  it('el cliente de Sheets solo emite GET', () => {
    const client = sources.find((s) => s.file === path.join('lib', 'sheets-client.ts'))!.text
    expect(client).toContain("method: 'GET'")
    expect(client).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'/)
  })

  it('no hay variables NEXT_PUBLIC_ (todo queda en el servidor)', () => {
    for (const { file, text } of sources) expect(text, file).not.toMatch(/process\.env(\.|\[['"])NEXT_PUBLIC_/)
  })

  it('los módulos con credenciales importan server-only', () => {
    for (const mod of SERVER_ONLY_MODULES) {
      const source = sources.find((s) => s.file === `${mod}.ts`)
      expect(source, mod).toBeDefined()
      expect(source!.text, mod).toMatch(/^import 'server-only'/)
    }
  })

  it('los componentes de cliente no importan módulos del servidor', () => {
    const clientFiles = sources.filter((s) => /^['"]use client['"]/.test(s.text))
    expect(clientFiles.length).toBeGreaterThan(0)
    for (const { file, text } of clientFiles) {
      for (const mod of SERVER_ONLY_MODULES) expect(text, file).not.toContain(`@/${mod}'`)
      expect(text, file).not.toContain('process.env')
    }
  })

  it('no se registran tokens, credenciales ni cuerpos de respuesta en logs', () => {
    for (const { file, text } of sources) {
      const logs = text.match(/console\.(log|info|warn|error|debug)\([^)]*\)/g) ?? []
      for (const line of logs) expect(line, file).not.toMatch(/token|key|secret|credential|response|body|email/i)
    }
  })

  it('/api/health no lee datos de Sheets ni la sesión', () => {
    const health = sources.find((s) => s.file === path.join('app', 'api', 'health', 'route.ts'))!.text
    expect(health).not.toMatch(/getDataset|sheets-client|getServerSession|currentUser/)
  })

  it('cada página privada verifica la sesión antes de leer datos', () => {
    const pages = sources.filter((s) => s.file.startsWith(path.join('app', '(private)')) && s.file.endsWith('page.tsx'))
    expect(pages.length).toBeGreaterThanOrEqual(6)
    // /eco (ORD-POS-067) y /finanzas (ORD-POS-074) usan privateEco y privateFinanzas: la misma verificación de sesión.
    for (const { file, text } of pages) expect(text, file).toMatch(/privateData\(|privateEco\(|privateFinanzas\(/)
    const api = sources.find((s) => s.file === path.join('app', 'api', 'resumen', 'route.ts'))!.text
    expect(api.indexOf('currentUser()')).toBeLessThan(api.indexOf('getDataset()'))
  })
})
