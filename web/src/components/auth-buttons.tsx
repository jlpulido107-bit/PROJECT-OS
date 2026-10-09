'use client'

import { signIn, signOut } from 'next-auth/react'
import { useState } from 'react'

export function SignInButton({ callbackUrl }: { callbackUrl: string }) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      type="button"
      className="button button-primary"
      disabled={busy}
      aria-busy={busy}
      onClick={() => {
        setBusy(true)
        void signIn('google', { callbackUrl })
      }}
    >
      {busy ? 'Redirigiendo a Google…' : 'Iniciar sesión con Google'}
    </button>
  )
}

export function SignOutButton() {
  return (
    <button type="button" className="button button-ghost" onClick={() => void signOut({ callbackUrl: '/login' })}>
      Cerrar sesión
    </button>
  )
}
