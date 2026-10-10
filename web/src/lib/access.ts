/**
 * Política de usuarios permitidos: lista explícita de correos en AUTH_ALLOWED_EMAILS
 * (separados por coma). Lista vacía = nadie entra (falla cerrada).
 */
export function parseAllowedEmails(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(/[,\s;]+/)
      .map((e) => e.trim().toLowerCase())
      .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)),
  )
}

export function allowedEmails(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return parseAllowedEmails(env.AUTH_ALLOWED_EMAILS)
}

export function isEmailAllowed(email: unknown, allowed: Set<string> = allowedEmails()): boolean {
  return typeof email === 'string' && allowed.has(email.trim().toLowerCase())
}

/** Duración máxima de la sesión (segundos). Por defecto 8 h; máximo 7 días. */
export function sessionMaxAge(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.AUTH_SESSION_MAX_AGE_SECONDS ?? '')
  if (!Number.isInteger(value) || value <= 0) return 8 * 60 * 60
  return Math.min(value, 7 * 24 * 60 * 60)
}

/** Rutas accesibles sin sesión. No devuelven datos de Sheets (/api/health solo responde ok/unavailable). */
export function isPublicPath(pathname: string): boolean {
  return (
    pathname === '/login' ||
    pathname === '/api/health' ||
    pathname === '/robots.txt' ||
    pathname === '/favicon.ico' ||
    pathname.startsWith('/api/auth/') ||
    pathname.startsWith('/_next/static/') ||
    pathname.startsWith('/_next/image')
  )
}

/** Solo rutas internas relativas como destino tras login (evita redirecciones abiertas). */
export function safeCallbackPath(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/'
  return value.slice(0, 500)
}
