import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { dictamenDeOrden, falloDictamen, limpiarCacheDictamenes } from '@/lib/operations/dictamenes'
import { codigoFalloGitHub, createGitHubClient } from '@/lib/operations/github'

/** Diagnóstico de fallos de lectura de GitHub en /ordenes (ORD-POS-042) con fetch simulado: sin red. */

const TOKEN = 'ghp_token-secreto-de-prueba'
const PR_URL = 'https://github.com/jlpulido107-bit/PROJECT-OS/pull/50'
const orden = { id: 'ORD-POS-099', proyectoId: 'POS', prUrl: PR_URL, riesgo: 'BAJO', criterios: '1. Uno' }
const cliente = (fetchImpl: () => Promise<Response>) => createGitHubClient(TOKEN, fetchImpl as unknown as typeof fetch)
const responde = (status: number) => cliente(async () => new Response(`{"message":"cuerpo ${TOKEN}"}`, { status }))
let avisos: MockInstance<typeof console.warn>

beforeEach(() => { limpiarCacheDictamenes(); avisos = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => { vi.useRealTimers(); avisos.mockRestore() })
const registros = () => avisos.mock.calls.map((c) => c.join(' ')).join('\n')

describe('diagnóstico de la lectura de GitHub', () => {
  it.each([[403, 'http-403'], [404, 'http-404']])('dictamen con HTTP %i: null, código guardado 60 s y registrado sin token', async (status, codigo) => {
    expect(await dictamenDeOrden(responde(status), orden, 1_000)).toBeNull()
    expect(falloDictamen(PR_URL)).toBe(codigo)
    expect(registros()).toBe(`[project-os] lectura del dictamen fallida: ${codigo}`)
    expect(registros()).not.toMatch(/token|ghp_|cuerpo|api\.github\.com/)
    // Dentro de los 60 s se sirve el fallo guardado (sin otra llamada ni otro registro) y conserva el código.
    expect(await dictamenDeOrden(responde(200), orden, 59_000)).toBeNull()
    expect([falloDictamen(PR_URL), avisos.mock.calls.length]).toEqual([codigo, 1])
  })

  it('dictamen que no responde en 20 s: código tiempo', async () => {
    vi.useFakeTimers()
    const pendiente = dictamenDeOrden(cliente(() => new Promise<Response>(() => {})), orden, 1_000)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await pendiente).toBeNull()
    expect([falloDictamen(PR_URL), registros()]).toEqual(['tiempo', '[project-os] lectura del dictamen fallida: tiempo'])
  })

  it('sin fallo no hay código; detección de PR con 403 o 404 da http-NNN', async () => {
    expect(falloDictamen(PR_URL)).toBeNull()
    for (const status of [403, 404]) {
      const error = await responde(status).prDeOrden('POS', 'ORD-POS-099').catch((e: unknown) => e)
      expect(codigoFalloGitHub(error)).toBe(`http-${status}`)
    }
    expect([codigoFalloGitHub(new Error('tiempo')), codigoFalloGitHub(new Error(TOKEN))]).toEqual(['tiempo', 'desconocido'])
  })
})
