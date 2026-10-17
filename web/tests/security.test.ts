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
  // Módulos de V1.4 que solo pueden ejecutarse en el servidor (estado simulado y manejo de escrituras).
  SERVER_ONLY_MODULES.push('lib/operations/runtime', 'lib/operations/http')

  it('ningún código llama endpoints de escritura de Sheets ni usa el alcance de escritura', () => {
    for (const { file, text } of sources) {
      if (file !== WRITE_ADAPTER) {
        expect(text, file).not.toMatch(/:append|:batchUpdate|:clear|values:update|batchUpdateByDataFilter/)
        // Quien hable con las APIs de Google solo puede leer (salvo pedir el token de escritura a IAM Credentials).
        if (/googleapis\.com/.test(text) && file !== WRITE_CREDENTIALS) expect(text, file).not.toMatch(/method:\s*'(PUT|POST|PATCH|DELETE)'/)
      }
      if (file !== WRITE_CREDENTIALS) expect(text, file).not.toMatch(/auth\/spreadsheets['"]/)
      expect(text, file).not.toMatch(/auth\/drive/)
      expect(text, file).not.toMatch(/USER_ENTERED/)
    }
  })

  it('el adaptador de escritura y el token de escritura solo se usan desde runtime.ts', () => {
    for (const { file, text } of sources) {
      if (file === WRITE_ADAPTER || file === WRITE_RUNTIME) continue
      expect(text, file).not.toMatch(/(from|import\(|require\()\s*['"][^'"]*write-credentials['"]/)
      expect(text, file).not.toMatch(/(from|import\(|require\()\s*['"][^'"]*sheets-table-store['"]/)
      expect(text, file).not.toMatch(/new SheetsTableStore/)
    }
    const adapter = sources.find((s) => s.file === WRITE_ADAPTER)!.text
    expect(adapter).toMatch(/valueInputOption=RAW/)
    expect(adapter).not.toMatch(/process\.env|google-auth-library|readFileSync/)
  })

  it('todas las rutas de escritura pasan por la guarda del servidor', () => {
    const routes = sources.filter((s) => s.file.startsWith(path.join('app', 'api', 'operaciones')) && s.file.endsWith('route.ts'))
    expect(routes.length).toBe(8)
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
    for (const { file, text } of pages) expect(text, file).toContain('privateData(')
    const api = sources.find((s) => s.file === path.join('app', 'api', 'resumen', 'route.ts'))!.text
    expect(api.indexOf('currentUser()')).toBeLessThan(api.indexOf('getDataset()'))
  })
})
