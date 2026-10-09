import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Garantías de la V1.5 verificadas sobre el código fuente:
 * - el motor es puro (sin reloj, azar, red, entorno, Sheets ni OAuth);
 * - no hay endpoints mutadores ni aplicación automática de propuestas;
 * - la revisión y los escenarios no se persisten.
 */
const SRC = path.resolve(__dirname, '..', 'src')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? files(full) : /\.(ts|tsx)$/.test(name) ? [full] : []
  })
}
const read = (rel: string) => readFileSync(path.join(SRC, rel), 'utf8')
const engineFiles = files(path.join(SRC, 'lib', 'planning')).map((f) => ({ file: path.relative(SRC, f), text: readFileSync(f, 'utf8') }))
const uiFiles = files(path.join(SRC, 'components', 'planning')).map((f) => ({ file: path.relative(SRC, f), text: readFileSync(f, 'utf8') }))

describe('motor de planificación puro', () => {
  it('sin reloj global, azar, red, variables de entorno ni almacenamiento', () => {
    expect(engineFiles.length).toBeGreaterThanOrEqual(9)
    for (const { file, text } of engineFiles) {
      expect(text, file).not.toMatch(/Date\.now\(|new Date\(\s*\)|Math\.random|performance\.now/)
      expect(text, file).not.toMatch(/process\.env|fetch\(|XMLHttpRequest|localStorage|sessionStorage|indexedDB/)
      expect(text, file).not.toMatch(/['"]server-only['"]|['"]use server['"]/)
    }
  })

  it('no importa Sheets, OAuth, autenticación, configuración ni el adaptador de datos', () => {
    for (const { file, text } of engineFiles) {
      const imports = [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!)
      for (const spec of imports) {
        // Solo módulos propios del motor y utilidades puras de fechas/tipos.
        expect(['../dates', '../types'].includes(spec) || spec.startsWith('./'), `${file} importa ${spec}`).toBe(true)
      }
    }
  })
})

describe('sin escrituras ni aplicación automática', () => {
  it('la API de planificación solo exporta GET y verifica la sesión antes de leer datos', () => {
    const route = read(path.join('app', 'api', 'planificacion', 'route.ts'))
    expect(route).toMatch(/export async function GET\(/)
    expect(route).not.toMatch(/export (async )?function (POST|PUT|PATCH|DELETE)|export const (POST|PUT|PATCH|DELETE)/)
    expect(route.indexOf('currentUser()')).toBeLessThan(route.indexOf('getDataset()'))
    expect(route).not.toMatch(/invalidateDataset|sheets-client|spreadsheets\b(?!\.readonly)/)
  })

  it('ninguna ruta de API exporta métodos mutadores salvo NextAuth', () => {
    const apiDir = path.join(SRC, 'app', 'api')
    for (const file of files(apiDir)) {
      const rel = path.relative(apiDir, file)
      if (rel.startsWith(`auth${path.sep}`) || rel.startsWith(`operaciones${path.sep}`)) continue
      expect(readFileSync(file, 'utf8'), rel).not.toMatch(/export (async )?function (POST|PUT|PATCH|DELETE)/)
    }
  })

  it('la UI no envía nada al servidor ni persiste escenarios o revisiones', () => {
    for (const { file, text } of uiFiles) {
      expect(text, file).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|indexedDB|document\.cookie/)
      expect(text, file).not.toMatch(/['"]use server['"]|action=\{/)
    }
    const view = uiFiles.find((f) => f.file.endsWith('planning-view.tsx'))!.text
    expect(view).toContain('Simulación — sin cambios guardados')
    expect(view).toContain('Restablecer escenario')
  })

  it('la página de planificación verifica la sesión y solo pasa la proyección mínima', () => {
    const page = read(path.join('app', '(private)', 'planificacion', 'page.tsx'))
    expect(page).toContain("privateData('/planificacion')")
    expect(page).toMatch(/planningInputFromDataset\(data\)/)
    const input = read(path.join('lib', 'planning', 'input.ts'))
    expect(input).not.toMatch(/\b(responsable|notas|descripcion|objetivo|referenciaUrl|repositorioUrl|evidenciaUrl)\s*:/)
  })

  it('la exportación no incluye títulos, nombres ni texto libre', () => {
    const exp = read(path.join('lib', 'planning', 'export.ts'))
    const shape = exp.slice(exp.indexOf('export interface ProposalExport'), exp.indexOf('export function reviewKey'))
    expect(shape).not.toMatch(/\b(titulo|nombre|responsable|notas|descripcion|email|correo)\b/i)
  })
})
