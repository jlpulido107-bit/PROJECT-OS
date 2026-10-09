import { describe, expect, it, vi } from 'vitest'
import { ConfigError } from '@/lib/config'
import { createTokenProvider, credentialMode, type CredentialDeps, expectedServiceAccount, validateCredentialConfig } from '@/lib/credentials'
import { SHEETS_READONLY_SCOPE } from '@/lib/sheets-client'

const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv
const PEM = 'PRIVATE ' + 'KEY'
const KEY_JSON = JSON.stringify({
  type: 'service_account',
  client_email: 'local@proyecto.iam.gserviceaccount.com',
  private_key: `-----BEGIN ${PEM}-----\nFAKEFAKEFAKE\n-----END ${PEM}-----\n`,
})
const SA = 'project-os-dashboard-run@proyecto.iam.gserviceaccount.com'
const CLOUD_RUN = { K_SERVICE: 'project-os-dashboard' }

/** Proveedor ADC simulado: registra las opciones y devuelve la identidad indicada. */
function fakeDeps(identity: string | undefined, token: string | null = 'ya29.token-adc-falso') {
  const calls = { adcOptions: [] as unknown[], jwtOptions: [] as unknown[], getCredentials: 0, getAccessToken: 0 }
  const deps: CredentialDeps = {
    GoogleAuth: class {
      constructor(options: { scopes: string[] }) {
        calls.adcOptions.push(options)
      }
      async getCredentials() {
        calls.getCredentials += 1
        return { client_email: identity }
      }
      async getAccessToken() {
        calls.getAccessToken += 1
        return token
      }
    },
    JWT: class {
      constructor(options: { email: string; key: string; scopes: string[] }) {
        calls.jwtOptions.push(options)
      }
      async getAccessToken() {
        return { token: 'ya29.token-jwt-falso' }
      }
    },
  }
  return { deps, calls }
}

describe('selección explícita de credenciales', () => {
  it('sin SHEETS_CREDENTIALS usa la clave local solo si existe (compatibilidad V1.2)', () => {
    expect(credentialMode(env({ PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_FILE: '/fuera/del/repo.json' }))).toBe('service-account-key')
    expect(() => credentialMode(env({}))).toThrow(ConfigError)
  })

  it('nunca cae a ADC por omisión', () => {
    expect(() => credentialMode(env({ GOOGLE_APPLICATION_CREDENTIALS: '/algo.json' }))).toThrow(/SHEETS_CREDENTIALS/)
  })

  it('valores válidos e inválidos', () => {
    expect(credentialMode(env({ SHEETS_CREDENTIALS: 'ADC' }))).toBe('adc')
    expect(() => credentialMode(env({ SHEETS_CREDENTIALS: 'auto' }))).toThrow(ConfigError)
  })

  it('ADC no admite además una clave JSON (sin ambigüedad)', () => {
    expect(() => credentialMode(env({ SHEETS_CREDENTIALS: 'adc', PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_JSON: KEY_JSON }))).toThrow(
      /no admite/,
    )
  })

  it('en Cloud Run se prohíben las claves JSON y GOOGLE_APPLICATION_CREDENTIALS', () => {
    expect(() => credentialMode(env({ ...CLOUD_RUN, PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_JSON: KEY_JSON }))).toThrow(/Cloud Run/)
    expect(() =>
      credentialMode(env({ ...CLOUD_RUN, SHEETS_CREDENTIALS: 'service-account-key', PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_FILE: '/k.json' })),
    ).toThrow(/Cloud Run/)
    expect(() => credentialMode(env({ ...CLOUD_RUN, SHEETS_CREDENTIALS: 'adc', GOOGLE_APPLICATION_CREDENTIALS: '/k.json' }))).toThrow(
      /GOOGLE_APPLICATION_CREDENTIALS/,
    )
    expect(credentialMode(env({ ...CLOUD_RUN, SHEETS_CREDENTIALS: 'adc' }))).toBe('adc')
  })

  it('la cuenta esperada es obligatoria en Cloud Run y opcional en local', () => {
    expect(() => expectedServiceAccount(env(CLOUD_RUN))).toThrow(/SHEETS_EXPECTED_SERVICE_ACCOUNT/)
    expect(expectedServiceAccount(env({}))).toBeNull()
    expect(expectedServiceAccount(env({ SHEETS_EXPECTED_SERVICE_ACCOUNT: ` ${SA.toUpperCase()} ` }))).toBe(SA)
    expect(() => expectedServiceAccount(env({ SHEETS_EXPECTED_SERVICE_ACCOUNT: 'no-es-correo' }))).toThrow(ConfigError)
    expect(() => validateCredentialConfig(env({ ...CLOUD_RUN, SHEETS_CREDENTIALS: 'adc' }))).toThrow(ConfigError)
    expect(validateCredentialConfig(env({ ...CLOUD_RUN, SHEETS_CREDENTIALS: 'adc', SHEETS_EXPECTED_SERVICE_ACCOUNT: SA }))).toBe('adc')
  })

  it('los errores no repiten valores de configuración', () => {
    const cases = [
      env({ ...CLOUD_RUN, PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_JSON: KEY_JSON }),
      env({ SHEETS_CREDENTIALS: 'adc', PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_JSON: KEY_JSON }),
      env({ SHEETS_EXPECTED_SERVICE_ACCOUNT: 'FAKEFAKEFAKE' }),
    ]
    for (const c of cases) {
      let message = ''
      try {
        credentialMode(c)
        expectedServiceAccount(c)
      } catch (error) {
        message = (error as Error).message
      }
      expect(message).not.toBe('')
      expect(message).not.toMatch(/FAKEFAKEFAKE|local@proyecto/)
    }
  })
})

describe('proveedor de tokens', () => {
  it('ADC (Cloud Run): pide el alcance de solo lectura y verifica la identidad una vez', async () => {
    const { deps, calls } = fakeDeps(SA)
    const provider = createTokenProvider(env({ ...CLOUD_RUN, SHEETS_CREDENTIALS: 'adc', SHEETS_EXPECTED_SERVICE_ACCOUNT: SA }), deps)
    expect(provider.mode).toBe('adc')
    await expect(provider.getAccessToken()).resolves.toBe('ya29.token-adc-falso')
    await provider.getAccessToken()
    expect(calls.adcOptions).toEqual([{ scopes: [SHEETS_READONLY_SCOPE] }])
    expect(SHEETS_READONLY_SCOPE).toBe('https://www.googleapis.com/auth/spreadsheets.readonly')
    expect(calls.getCredentials).toBe(1)
    expect(calls.getAccessToken).toBe(2)
    expect(calls.jwtOptions).toEqual([])
  })

  it('ADC con otra identidad (p. ej. la cuenta por defecto del proyecto) → error sin token', async () => {
    const { deps, calls } = fakeDeps('123456-compute@developer.gserviceaccount.com')
    const provider = createTokenProvider(env({ ...CLOUD_RUN, SHEETS_CREDENTIALS: 'adc', SHEETS_EXPECTED_SERVICE_ACCOUNT: SA }), deps)
    const error = await provider.getAccessToken().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConfigError)
    expect((error as Error).message).not.toMatch(/compute@|project-os-dashboard-run/)
    expect(calls.getAccessToken).toBe(0)
  })

  it('ADC con credencial de usuario (sin client_email) y cuenta esperada → error', async () => {
    const { deps } = fakeDeps(undefined)
    const provider = createTokenProvider(env({ SHEETS_CREDENTIALS: 'adc', SHEETS_EXPECTED_SERVICE_ACCOUNT: SA }), deps)
    await expect(provider.getAccessToken()).rejects.toBeInstanceOf(ConfigError)
  })

  it('ADC local sin cuenta esperada no consulta la identidad', async () => {
    const { deps, calls } = fakeDeps(undefined)
    const provider = createTokenProvider(env({ SHEETS_CREDENTIALS: 'adc' }), deps)
    await expect(provider.getAccessToken()).resolves.toBe('ya29.token-adc-falso')
    expect(calls.getCredentials).toBe(0)
  })

  it('ADC sin token → error', async () => {
    const { deps } = fakeDeps(SA, null)
    const provider = createTokenProvider(env({ SHEETS_CREDENTIALS: 'adc', SHEETS_EXPECTED_SERVICE_ACCOUNT: SA }), deps)
    await expect(provider.getAccessToken()).rejects.toThrow()
  })

  it('clave local: JWT con alcance de solo lectura; ADC no se usa', async () => {
    const { deps, calls } = fakeDeps(SA)
    const provider = createTokenProvider(env({ PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_JSON: KEY_JSON }), deps)
    expect(provider.mode).toBe('service-account-key')
    await expect(provider.getAccessToken()).resolves.toBe('ya29.token-jwt-falso')
    expect(calls.adcOptions).toEqual([])
    expect(calls.jwtOptions).toEqual([
      expect.objectContaining({ email: 'local@proyecto.iam.gserviceaccount.com', scopes: [SHEETS_READONLY_SCOPE] }),
    ])
  })

  it('la configuración inválida falla antes de crear clientes', () => {
    const { deps, calls } = fakeDeps(SA)
    expect(() => createTokenProvider(env({ ...CLOUD_RUN, SHEETS_CREDENTIALS: 'adc' }), deps)).toThrow(ConfigError)
    expect(calls.adcOptions).toEqual([])
    vi.restoreAllMocks()
  })
})
