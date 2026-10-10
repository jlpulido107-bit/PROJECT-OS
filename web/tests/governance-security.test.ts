import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Garantías de la V1.6 verificadas sobre el código fuente: motor puro, sin texto libre en su entrada,
 * API de solo lectura y revisión local que no se persiste ni se envía.
 */
const SRC = path.resolve(__dirname, '..', 'src')
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const full = path.join(dir, n)
  return statSync(full).isDirectory() ? files(full) : /\.(ts|tsx)$/.test(n) ? [full] : []
})
const load = (dir: string) => files(path.join(SRC, dir)).map((f) => ({ file: path.relative(SRC, f), text: readFileSync(f, 'utf8') }))
const engine = load(path.join('lib', 'governance'))
const ui = load(path.join('components', 'control'))
const read = (rel: string) => readFileSync(path.join(SRC, rel), 'utf8')

describe('motor de control puro', () => {
  it('sin reloj global, azar, red, entorno ni almacenamiento', () => {
    expect(engine.length).toBeGreaterThanOrEqual(6)
    for (const { file, text } of engine) {
      expect(text, file).not.toMatch(/Date\.now\(|new Date\(\s*\)|Math\.random|performance\.now/)
      expect(text, file).not.toMatch(/process\.env|fetch\(|XMLHttpRequest|localStorage|sessionStorage|indexedDB/)
      expect(text, file).not.toMatch(/['"]server-only['"]|['"]use server['"]/)
      for (const [, spec] of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        expect(spec === '../types' || spec!.startsWith('./'), `${file} importa ${spec}`).toBe(true)
      }
    }
  })

  it('la entrada del motor no tiene campos de texto libre', () => {
    const types = read(path.join('lib', 'governance', 'types.ts'))
    const shape = types.slice(types.indexOf('export interface GovernanceInput'), types.indexOf('export interface PlannerSignals'))
    expect(shape).not.toMatch(/\b(titulo|nombre|descripcion|notas|bloqueo|asunto|decision|justificacion|responsable|criterio)\s*:/i)
    const input = read(path.join('lib', 'governance', 'input.ts'))
    const projection = input.slice(input.indexOf('export function governanceInputFromDataset'), input.indexOf('export interface GovernanceLabels'))
    expect(projection).not.toMatch(/\.(titulo|nombre|descripcion|notas|asunto|justificacion|responsable)\b/)
    expect(projection).toContain('tieneBloqueo: t.bloqueo !== null')
  })
})

describe('solo lectura y revisión simulada', () => {
  it('la API solo exporta GET y verifica la sesión antes de leer datos', () => {
    const route = read(path.join('app', 'api', 'control', 'route.ts'))
    expect(route).toMatch(/export async function GET\(/)
    expect(route).not.toMatch(/export (async )?function (POST|PUT|PATCH|DELETE)|export const (POST|PUT|PATCH|DELETE)/)
    expect(route.indexOf('currentUser()')).toBeLessThan(route.indexOf('getDataset()'))
    expect(route).not.toMatch(/governanceLabels|invalidateDataset/)
    expect(route).toContain('no-store')
  })

  it('la página verifica la sesión y las etiquetas solo van a la página privada', () => {
    const page = read(path.join('app', '(private)', 'control', 'page.tsx'))
    expect(page).toContain("privateData('/control')")
    expect(page).toContain('governanceLabels(data)')
  })

  it('la UI no envía, guarda ni persiste nada; el aviso de simulación está presente', () => {
    for (const { file, text } of ui) {
      expect(text, file).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|indexedDB|document\.cookie/)
      expect(text, file).not.toMatch(/['"]use server['"]|action=\{|method="post"/i)
      expect(text, file).not.toMatch(/\b(Aprobad[oa]|Aprobar)\b/)
    }
    const view = ui.find((f) => f.file.endsWith('control-view.tsx'))!.text
    expect(view).toContain('Simulación — no se guardaron cambios')
    expect(view).toContain('no autoriza merges, despliegues')
  })

  it('los enlaces a entidades son internos y codifican los IDs', () => {
    const presentation = ui.find((f) => f.file.endsWith('presentation.ts'))!.text
    expect(presentation).not.toMatch(/https?:\/\//)
    expect(presentation.match(/encodeURIComponent/g)!.length).toBeGreaterThanOrEqual(2)
  })
})
