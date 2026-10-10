import 'server-only'

import { GoogleAuth, JWT } from 'google-auth-library'
import { ConfigError, serviceAccount } from './config'
import { SHEETS_READONLY_SCOPE } from './sheets-client'

/**
 * Política de credenciales para leer Google Sheets (V1.3). Selección EXPLÍCITA, sin
 * fallback silencioso entre tipos de credencial:
 *
 * - `service-account-key` (solo local): clave JSON guardada fuera del repositorio
 *   (PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_FILE o _JSON). Prohibida en Cloud Run.
 * - `adc` (Cloud Run): Application Default Credentials de la cuenta de servicio adjunta al
 *   servicio, sin clave persistente. En Cloud Run exige SHEETS_EXPECTED_SERVICE_ACCOUNT para no
 *   operar por error con la cuenta por defecto del proyecto.
 *
 * Si SHEETS_CREDENTIALS no está definido se acepta `service-account-key` solo cuando hay una clave
 * configurada (compatibilidad con V1.2 local); nunca se cae a ADC por omisión.
 * En ambos modos el token se pide con el alcance `spreadsheets.readonly`.
 */

export type CredentialMode = 'service-account-key' | 'adc'

const MODES: readonly CredentialMode[] = ['service-account-key', 'adc']
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/** Cloud Run define K_SERVICE en cada contenedor. */
export function isCloudRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.K_SERVICE?.trim())
}

function hasServiceAccountKey(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_JSON?.trim() || env.PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_FILE?.trim())
}

export function credentialMode(env: NodeJS.ProcessEnv = process.env): CredentialMode {
  const raw = env.SHEETS_CREDENTIALS?.trim().toLowerCase()
  const hasKey = hasServiceAccountKey(env)
  const cloudRun = isCloudRun(env)

  let mode: CredentialMode
  if (!raw) {
    if (!hasKey) {
      throw new ConfigError('Define SHEETS_CREDENTIALS (adc en Cloud Run) o una clave local de cuenta de servicio')
    }
    mode = 'service-account-key'
  } else if ((MODES as readonly string[]).includes(raw)) {
    mode = raw as CredentialMode
  } else {
    throw new ConfigError('SHEETS_CREDENTIALS debe ser "adc" o "service-account-key"')
  }

  if (mode === 'service-account-key') {
    if (cloudRun) throw new ConfigError('En Cloud Run no se permiten claves JSON: usa SHEETS_CREDENTIALS=adc')
    if (!hasKey) throw new ConfigError('SHEETS_CREDENTIALS=service-account-key requiere una clave local configurada')
  } else {
    if (hasKey) {
      throw new ConfigError('SHEETS_CREDENTIALS=adc no admite PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_*; elimina la clave')
    }
    if (cloudRun && env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) {
      throw new ConfigError('En Cloud Run no se permite GOOGLE_APPLICATION_CREDENTIALS (archivo de clave)')
    }
  }
  return mode
}

/** Correo esperado de la identidad ADC; obligatorio en Cloud Run. */
export function expectedServiceAccount(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.SHEETS_EXPECTED_SERVICE_ACCOUNT?.trim().toLowerCase()
  if (!value) {
    if (isCloudRun(env)) throw new ConfigError('En Cloud Run define SHEETS_EXPECTED_SERVICE_ACCOUNT')
    return null
  }
  if (!EMAIL.test(value)) throw new ConfigError('SHEETS_EXPECTED_SERVICE_ACCOUNT no es un correo válido')
  return value
}

/** Valida toda la configuración de credenciales sin pedir tokens (para /api/health). */
export function validateCredentialConfig(env: NodeJS.ProcessEnv = process.env): CredentialMode {
  const mode = credentialMode(env)
  if (mode === 'adc') expectedServiceAccount(env)
  else serviceAccount(env)
  return mode
}

export interface TokenProvider {
  mode: CredentialMode
  getAccessToken(): Promise<string>
}

/** Dependencias inyectables para pruebas (proveedor ADC simulado). */
export interface CredentialDeps {
  GoogleAuth: new (options: { scopes: string[] }) => {
    getAccessToken(): Promise<string | null | undefined>
    getCredentials(): Promise<{ client_email?: string }>
  }
  JWT: new (options: { email: string; key: string; scopes: string[] }) => {
    getAccessToken(): Promise<{ token?: string | null }>
  }
}

const DEFAULT_DEPS: CredentialDeps = {
  GoogleAuth: GoogleAuth as unknown as CredentialDeps['GoogleAuth'],
  JWT: JWT as unknown as CredentialDeps['JWT'],
}

export function createTokenProvider(
  env: NodeJS.ProcessEnv = process.env,
  deps: CredentialDeps = DEFAULT_DEPS,
): TokenProvider {
  const mode = credentialMode(env)

  if (mode === 'service-account-key') {
    const account = serviceAccount(env)
    const client = new deps.JWT({ email: account.clientEmail, key: account.privateKey, scopes: [SHEETS_READONLY_SCOPE] })
    return {
      mode,
      async getAccessToken() {
        const { token } = await client.getAccessToken()
        if (!token) throw new Error('empty token')
        return token
      },
    }
  }

  const expected = expectedServiceAccount(env)
  const auth = new deps.GoogleAuth({ scopes: [SHEETS_READONLY_SCOPE] })
  let identityChecked = false
  return {
    mode,
    async getAccessToken() {
      if (expected && !identityChecked) {
        const credentials = await auth.getCredentials()
        if (credentials.client_email?.trim().toLowerCase() !== expected) {
          // No se incluye ningún correo en el mensaje.
          throw new ConfigError('La identidad de Google del servidor no coincide con SHEETS_EXPECTED_SERVICE_ACCOUNT')
        }
        identityChecked = true
      }
      const token = await auth.getAccessToken()
      if (!token) throw new Error('empty token')
      return token
    },
  }
}
