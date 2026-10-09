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

const SERVER_ONLY_MODULES = ['lib/config', 'lib/data', 'lib/sheets-client', 'lib/auth', 'lib/page-data']

describe('garantías de seguridad del código', () => {
  it('ningún código llama endpoints de escritura de Sheets ni usa el alcance de escritura', () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/:append|:batchUpdate|:clear|values:update|batchUpdateByDataFilter/)
      expect(text, file).not.toMatch(/auth\/spreadsheets['"]/)
      expect(text, file).not.toMatch(/auth\/drive/)
    }
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

  it('cada página privada verifica la sesión antes de leer datos', () => {
    const pages = sources.filter((s) => s.file.startsWith(path.join('app', '(private)')) && s.file.endsWith('page.tsx'))
    expect(pages.length).toBe(6)
    for (const { file, text } of pages) expect(text, file).toContain('privateData(')
    const api = sources.find((s) => s.file === path.join('app', 'api', 'resumen', 'route.ts'))!.text
    expect(api.indexOf('currentUser()')).toBeLessThan(api.indexOf('getDataset()'))
  })
})
