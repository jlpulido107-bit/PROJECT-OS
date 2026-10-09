import 'server-only'

import { parseAllowedEmails } from './access'
import { ConfigError, dataSource, spreadsheetId } from './config'
import { isCloudRun, validateCredentialConfig } from './credentials'

/**
 * Comprobaciones de configuración del servidor, sin red ni lectura de Sheets.
 * Se usan en /api/health (sonda de arranque de Cloud Run: una revisión mal configurada no recibe
 * tráfico) y para decidir si se ofrece el inicio de sesión. Devuelven solo códigos, nunca valores.
 */

export type DeploymentProblem =
  | 'nextauth-secret'
  | 'oauth-client'
  | 'allowed-emails'
  | 'nextauth-url'
  | 'nextauth-url-https'
  | 'data-config'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Problemas que impiden una autenticación segura. */
export function authProblems(env: NodeJS.ProcessEnv = process.env): DeploymentProblem[] {
  const problems: DeploymentProblem[] = []
  if ((env.NEXTAUTH_SECRET?.trim().length ?? 0) < 32) problems.push('nextauth-secret')
  if (!env.GOOGLE_CLIENT_ID?.trim() || !env.GOOGLE_CLIENT_SECRET?.trim()) problems.push('oauth-client')
  if (parseAllowedEmails(env.AUTH_ALLOWED_EMAILS).size === 0) problems.push('allowed-emails')

  let url: URL | null = null
  try {
    url = env.NEXTAUTH_URL ? new URL(env.NEXTAUTH_URL) : null
  } catch {
    url = null
  }
  if (!url) {
    problems.push('nextauth-url')
  } else {
    // Fuera de localhost (y siempre en Cloud Run) la URL pública debe ser HTTPS: cookies Secure.
    const local = LOCAL_HOSTS.has(url.hostname)
    if (url.protocol !== 'https:' && (isCloudRun(env) || (env.NODE_ENV === 'production' && !local))) {
      problems.push('nextauth-url-https')
    }
  }
  return problems
}

export function deploymentProblems(env: NodeJS.ProcessEnv = process.env): DeploymentProblem[] {
  const problems = authProblems(env)
  try {
    if (dataSource(env) === 'sheets') {
      spreadsheetId(env)
      validateCredentialConfig(env)
    }
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    problems.push('data-config')
  }
  return problems
}
