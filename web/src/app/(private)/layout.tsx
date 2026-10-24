import type { ReactNode } from 'react'
import { SignOutButton } from '@/components/auth-buttons'
import { NavLinks } from '@/components/nav-links'
import { writeAccess } from '@/components/operations/write-access'
import { requireUser } from '@/lib/auth'
import { finanzasSheetId, radarosSheetId } from '@/lib/config'

export const dynamic = 'force-dynamic'

export default async function PrivateLayout({ children }: { children: ReactNode }) {
  const user = await requireUser()
  const access = writeAccess(user.email)
  const writes = access.allowed
  const real = writes && access.status.mode === 'sheets'
  return (
    <>
      <a className="skip-link" href="#contenido">Saltar al contenido</a>
      <header className="topbar">
        <div className="topbar-inner">
          <p className="brand">PROJECT-OS <span className="brand-sub">Centro de dirección · {real ? 'escritura real' : writes ? 'escritura simulada' : 'solo lectura'}</span></p>
          <nav aria-label="Principal">
            <NavLinks showOperations={writes} showEco={radarosSheetId() !== null} showFinanzas={finanzasSheetId() !== null} />
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
        <p>
          Fuente operativa: Google Sheets.{' '}
          {real ? 'Las operaciones de este panel escriben en Google Sheets y quedan en AUDITORIA.' : writes ? 'Las operaciones de este panel son simuladas y no escriben en Google Sheets.' : 'Este panel no escribe datos.'}{' '}
          No cierra tareas; los commits son actividad observada, no avance.
        </p>
      </footer>
    </>
  )
}
