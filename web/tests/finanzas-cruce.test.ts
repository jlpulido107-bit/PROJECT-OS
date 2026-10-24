import { afterAll, describe, expect, it, vi } from 'vitest'

/**
 * Prueba cruzada con los runtimes reales (ORD-POS-077, criterio 4): el de operaciones solo habla con la hoja de
 * PROJECT-OS y el de finanzas solo con FINANZAS, aunque las dos escrituras estén configuradas a la vez. El token y
 * `fetch` son dobles: nunca se toca Google.
 */
const PROPIA = '16UXe7fm90fOTTVJhI_RZ8__I876u2buvjeLGr5cJ-Ic'
const FINANZAS = 'LIBRO_FINANZAS_SINTETICO_0123456789'
const ESCRITURA_POS = 'project-os-writer@project-os-511102.iam.gserviceaccount.com'
const CUENTA_FIN = 'project-os-finanzas@project-os-511102.iam.gserviceaccount.com'

const cuentas: string[] = []
vi.mock('@/lib/operations/write-credentials', () => ({
  createWriteTokenProvider: (account: string) => {
    cuentas.push(account)
    return async () => `token-de-${account.split('@')[0]}`
  },
}))

const urls: string[] = []
vi.stubGlobal('fetch', (async (url: string) => {
  urls.push(url)
  return new Response('{}', { status: 503 })
}) as unknown as typeof fetch)

for (const [k, v] of Object.entries({
  SHEETS_SPREADSHEET_ID: PROPIA, DASHBOARD_DATA_SOURCE: 'sheets', PROJECT_OS_WRITE_MODE: 'sheets',
  PROJECT_OS_WRITE_SERVICE_ACCOUNT: ESCRITURA_POS, SHEETS_EXPECTED_SERVICE_ACCOUNT: 'runtime@project-os-511102.iam.gserviceaccount.com',
  AUTH_ALLOWED_EMAILS: 'dueno@example.com', FINANZAS_SHEET_ID: FINANZAS, FINANZAS_WRITE_MODE: 'sheets',
  FINANZAS_WRITE_SERVICE_ACCOUNT: CUENTA_FIN, FINANZAS_WRITER_EMAIL: 'dueno@example.com',
})) vi.stubEnv(k, v)
afterAll(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('criterio 4: pruebas cruzadas con los runtimes', () => {
  it('operaciones nunca llama a FINANZAS ni usa la cuenta de FINANZAS', async () => {
    const { auditTable } = await import('@/lib/operations/runtime')
    urls.length = 0
    cuentas.length = 0
    await auditTable().catch(() => undefined)
    expect(urls.length).toBeGreaterThan(0)
    for (const u of urls) {
      expect(u.startsWith(`https://sheets.googleapis.com/v4/spreadsheets/${PROPIA}`)).toBe(true)
      expect(u).not.toContain(FINANZAS)
    }
    expect(cuentas).toEqual([ESCRITURA_POS])
  })

  it('finanzas nunca llama a la hoja de PROJECT-OS ni usa su cuenta de escritura', async () => {
    const { finanzasWriteService } = await import('@/lib/finanzas/escritura-runtime')
    urls.length = 0
    cuentas.length = 0
    const service = finanzasWriteService()!
    expect(service.libro).toBe(FINANZAS)
    const error = await service.crearMovimiento({
      requestId: '00000000-0000-4000-8000-000000000001', fecha: '2026-10-20', proyecto: 'ECO', tipo: 'Gasto', categoria: 'Producto',
      concepto: 'Muestras', productoId: null, moneda: 'MXN', montoOrigCentavos: null, tipoCambioDiezmil: null, montoMxnCentavos: 100,
      ivaMxnCentavos: null, comprobante: 'no', ajusteDe: null,
    }, { actor: 'dueno@example.com' }).catch((e: unknown) => e)
    expect((error as { code?: string }).code).toBe('lectura-fallida')
    expect(urls.length).toBeGreaterThan(0)
    for (const u of urls) {
      expect(u.startsWith(`https://sheets.googleapis.com/v4/spreadsheets/${FINANZAS}`)).toBe(true)
      expect(u).not.toContain(PROPIA)
    }
    expect(cuentas).toEqual([CUENTA_FIN])
  })

  it('sin FINANZAS_WRITE_MODE el runtime de finanzas no construye nada', async () => {
    const { finanzasWriteService } = await import('@/lib/finanzas/escritura-runtime')
    cuentas.length = 0
    expect(finanzasWriteService({ ...process.env, FINANZAS_WRITE_MODE: undefined })).toBeNull()
    expect(cuentas).toEqual([])
  })
})
