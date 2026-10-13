import 'server-only'

import { GoogleAuth } from 'google-auth-library'

/**
 * Token de ESCRITURA para Google Sheets (V1.8, plan F2). El servidor nunca tiene una clave: suplanta a la cuenta de
 * servicio de escritura dedicada con la API IAM Credentials (generateAccessToken).
 *
 * - Identidad de origen: ADC (en Cloud Run, la cuenta del servicio), que solo necesita
 *   roles/iam.serviceAccountTokenCreator SOBRE la cuenta de escritura.
 * - Alcance del token emitido: solo `spreadsheets` (nunca `drive`); vida de 10 minutos; se renueva 60 s antes.
 * - Errores sin cuerpo ni valores: solo el estado HTTP.
 */

export const SHEETS_WRITE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets'
const IAM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
const LIFETIME_S = 600
const MARGIN_MS = 60_000
const TIMEOUT_MS = 15_000

export interface WriteTokenDeps {
  /** Token de la identidad de origen (ADC). */
  sourceToken: () => Promise<string>
  fetchImpl: typeof fetch
  now: () => number
}

function defaultDeps(): WriteTokenDeps {
  const auth = new GoogleAuth({ scopes: [IAM_SCOPE] })
  return {
    async sourceToken() {
      const token = await auth.getAccessToken()
      if (!token) throw new Error('empty source token')
      return token
    },
    fetchImpl: fetch,
    now: Date.now,
  }
}

export function createWriteTokenProvider(account: string, deps: WriteTokenDeps = defaultDeps()): () => Promise<string> {
  let cached: { token: string; expiresAt: number } | null = null
  const url = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(account)}:generateAccessToken`
  return async () => {
    if (cached && cached.expiresAt - MARGIN_MS > deps.now()) return cached.token
    const source = await deps.sourceToken()
    const response = await deps.fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${source}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ scope: [SHEETS_WRITE_SCOPE], lifetime: `${LIFETIME_S}s` }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`write token HTTP ${response.status}`)
    const data = (await response.json()) as { accessToken?: unknown; expireTime?: unknown }
    if (typeof data.accessToken !== 'string' || !data.accessToken) throw new Error('write token vacío')
    const expires = typeof data.expireTime === 'string' ? Date.parse(data.expireTime) : NaN
    cached = { token: data.accessToken, expiresAt: Number.isFinite(expires) ? expires : deps.now() + LIFETIME_S * 1000 }
    return cached.token
  }
}
