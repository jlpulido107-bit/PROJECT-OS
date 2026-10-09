import type { ReactNode } from 'react'
import { SignOutButton } from '@/components/auth-buttons'
import { NavLinks } from '@/components/nav-links'
import { requireUser } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export default async function PrivateLayout({ children }: { children: ReactNode }) {
  const user = await requireUser()
  return (
    <>
      <a className="skip-link" href="#contenido">Saltar al contenido</a>
      <header className="topbar">
        <div className="topbar-inner">
          <p className="brand">PROJECT-OS <span className="brand-sub">Centro de dirección · solo lectura</span></p>
          <nav aria-label="Principal">
            <NavLinks />
          </nav>
          <div className="user">
            <span className="user-email" title="Sesión iniciada">{user.email}</span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main id="contenido" className="container" tabIndex={-1}>
        {children}
      </main>
      <footer className="footer container">
        <p>Fuente operativa: Google Sheets. Este panel no escribe datos ni cierra tareas; los commits son actividad observada, no avance.</p>
      </footer>
    </>
  )
}
