import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { SignInButton } from '@/components/auth-buttons'
import { safeCallbackPath } from '@/lib/access'
import { authConfigured, currentUser } from '@/lib/auth'

export const metadata: Metadata = { title: 'Iniciar sesión' }
export const dynamic = 'force-dynamic'

const ERRORS: Record<string, string> = {
  AccessDenied: 'Esta cuenta no está autorizada para ver el panel. Solo pueden entrar los correos de la lista de permitidos.',
  OAuthCallback: 'No se pudo completar el inicio de sesión con Google. Intenta de nuevo.',
  SessionRequired: 'Inicia sesión para continuar.',
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams
  const callbackUrl = safeCallbackPath(params.callbackUrl)
  const errorCode = typeof params.error === 'string' ? params.error : undefined
  const configured = authConfigured()
  if (configured && !errorCode && (await currentUser())) redirect(callbackUrl)

  return (
    <main className="container narrow login">
      <h1>PROJECT-OS</h1>
      <p className="lead">Centro de dirección privado. Acceso restringido a cuentas autorizadas.</p>
      {errorCode ? (
        <div className="alert alert-danger" role="alert">
          <p>{ERRORS[errorCode] ?? 'No se pudo iniciar sesión. Intenta de nuevo.'}</p>
        </div>
      ) : null}
      {configured ? (
        <SignInButton callbackUrl={callbackUrl} />
      ) : (
        <div className="alert alert-warn" role="alert">
          <p>
            La autenticación no está configurada en este servidor. Define <code>GOOGLE_CLIENT_ID</code>,{' '}
            <code>GOOGLE_CLIENT_SECRET</code>, <code>NEXTAUTH_SECRET</code> y <code>AUTH_ALLOWED_EMAILS</code> (ver{' '}
            <code>web/README.md</code>).
          </p>
        </div>
      )}
      <p className="muted small">Solo lectura. Ningún dato se escribe en Google Sheets desde este panel.</p>
    </main>
  )
}
