import { describe, expect, it } from 'vitest'
import { createWriteTokenProvider, SHEETS_WRITE_SCOPE } from '@/lib/operations/write-credentials'

const ACCOUNT = 'project-os-writer@project-os-511102.iam.gserviceaccount.com'

function harness(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  let now = Date.parse('2026-10-13T12:00:00Z')
  let sources = 0
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const r = responses.shift() ?? { status: 500 }
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status })
  }) as unknown as typeof fetch
  const provider = createWriteTokenProvider(ACCOUNT, {
    sourceToken: async () => `fuente-${++sources}`,
    fetchImpl,
    now: () => now,
  })
  return { provider, calls, advance: (ms: number) => { now += ms } }
}

describe('token de escritura por suplantación (V1.8 F2)', () => {
  it('pide a IAM Credentials un token solo con el alcance spreadsheets, por 10 minutos, para la cuenta de escritura', async () => {
    const h = harness([{ status: 200, body: { accessToken: 'escritura-1', expireTime: '2026-10-13T12:10:00Z' } }])
    expect(await h.provider()).toBe('escritura-1')
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]!.url).toBe(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(ACCOUNT)}:generateAccessToken`)
    expect(h.calls[0]!.init.method).toBe('POST')
    expect((h.calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer fuente-1')
    expect(JSON.parse(String(h.calls[0]!.init.body))).toEqual({ scope: [SHEETS_WRITE_SCOPE], lifetime: '600s' })
    expect(SHEETS_WRITE_SCOPE).toBe('https://www.googleapis.com/auth/spreadsheets')
  })

  it('reutiliza el token hasta 60 s antes de que caduque y luego lo renueva', async () => {
    const h = harness([
      { status: 200, body: { accessToken: 'escritura-1', expireTime: '2026-10-13T12:10:00Z' } },
      { status: 200, body: { accessToken: 'escritura-2', expireTime: '2026-10-13T12:20:00Z' } },
    ])
    expect(await h.provider()).toBe('escritura-1')
    h.advance(8 * 60_000)
    expect(await h.provider()).toBe('escritura-1')
    h.advance(61_000)
    expect(await h.provider()).toBe('escritura-2')
    expect(h.calls).toHaveLength(2)
  })

  it('un error de IAM solo expone el estado HTTP, nunca el cuerpo', async () => {
    const h = harness([{ status: 403, body: { error: { message: 'detalle interno con correo@example.com' } } }])
    await expect(h.provider()).rejects.toThrow(/^write token HTTP 403$/)
  })

  it('una respuesta sin token falla cerrado', async () => {
    const h = harness([{ status: 200, body: {} }])
    await expect(h.provider()).rejects.toThrow('write token vacío')
  })
})
