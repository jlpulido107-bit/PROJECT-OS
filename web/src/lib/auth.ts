import 'server-only'

import { getServerSession, type NextAuthOptions } from 'next-auth'
import GoogleProvider from 'next-auth/providers/google'
import { redirect } from 'next/navigation'
import { isEmailAllowed, sessionMaxAge } from './access'
import { authProblems } from './deployment'

/** Solo se ofrece el inicio de sesión si la configuración de autenticación es completa y segura. */
export function authConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return authProblems(env).length === 0
}

export const authOptions: NextAuthOptions = {
  secret: process.env.NEXTAUTH_SECRET,
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      // Solo identidad básica; el dashboard no pide acceso a Drive/Sheets del usuario.
      authorization: { params: { scope: 'openid email profile', prompt: 'select_account' } },
    }),
  ],
  session: { strategy: 'jwt', maxAge: sessionMaxAge(), updateAge: 60 * 60 },
  pages: { signIn: '/login', error: '/login' },
  callbacks: {
    async signIn({ account, profile }) {
      if (account?.provider !== 'google') return false
      const p = profile as { email?: string; email_verified?: boolean } | undefined
      // Correo verificado por Google y presente en la lista de permitidos.
      return p?.email_verified === true && isEmailAllowed(p.email)
    },
    async jwt({ token }) {
      delete token.picture
      if (token.email) token.email = token.email.toLowerCase()
      return token
    },
    async session({ session }) {
      if (session.user) session.user.image = null
      return session
    },
  },
}

export interface SessionUser {
  email: string
  name: string | null
}

/** Sesión válida y autorizada, o null. No redirige. */
export async function currentUser(): Promise<SessionUser | null> {
  const session = await getServerSession(authOptions)
  const email = session?.user?.email
  if (!email || !isEmailAllowed(email)) return null
  return { email, name: session.user?.name ?? null }
}

/** Para páginas privadas: redirige a /login si no hay sesión autorizada. */
export async function requireUser(callbackPath = '/'): Promise<SessionUser> {
  const session = await getServerSession(authOptions)
  const email = session?.user?.email
  if (!email) redirect(`/login?callbackUrl=${encodeURIComponent(callbackPath)}`)
  if (!isEmailAllowed(email)) redirect('/login?error=AccessDenied')
  return { email, name: session?.user?.name ?? null }
}
