import Link from 'next/link'
import type { ReactNode } from 'react'
import { canWrite, isWriter, writeModeStatus } from '@/lib/operations/config'

/** Estado de escritura para la sesión actual (el servidor lo vuelve a verificar en cada API). */
export function writeAccess(email: string) {
  const status = writeModeStatus()
  return { status, writer: isWriter(email), allowed: canWrite(email) }
}

export function MockBanner() {
  return (
    <div className="alert alert-warn mock-banner" role="note">
      <p>
        <strong>Modo simulado.</strong> Las operaciones se guardan solo en la memoria de este servidor, con datos
        sintéticos; <strong>no se escribe en Google Sheets</strong> y se pierden al reiniciar.
      </p>
    </div>
  )
}

export function RealWriteBanner() {
  return (
    <div className="alert alert-info" role="note">
      <p>
        <strong>Escritura real.</strong> Lo que guardes se escribe en la hoja de Google y queda en AUDITORIA.
      </p>
    </div>
  )
}

const REASONS: Record<string, string> = {
  deshabilitada: 'La escritura está deshabilitada en este servidor (PROJECT_OS_WRITE_MODE=disabled).',
  'sheets-no-habilitado': 'La escritura real en Google Sheets aún no está habilitada: requiere aprobación.',
  'sheets-requiere-datos-reales': 'La escritura real solo funciona con datos de Google Sheets; la escritura está deshabilitada.',
  'sheets-sin-cuenta-escritura': 'Falta la cuenta de servicio de escritura; la escritura está deshabilitada.',
  'sheets-misma-cuenta': 'La cuenta de escritura no puede ser la lectora; la escritura está deshabilitada.',
  'modo-invalido': 'La configuración del modo de escritura no es válida; la escritura está deshabilitada.',
  'mock-requiere-fixtures': 'El modo simulado solo funciona con datos sintéticos; la escritura está deshabilitada.',
  'mock-no-permitido-en-cloud-run': 'El modo simulado no está permitido en Cloud Run; la escritura está deshabilitada.',
}

/** Renderiza el formulario solo si el usuario puede escribir; si no, explica por qué (sin datos). */
export function WriteGate({ email, children }: { email: string; children: ReactNode }) {
  const access = writeAccess(email)
  if (access.status.mode === 'disabled') {
    return (
      <div className="alert alert-info" role="note">
        <p>{REASONS[access.status.reason ?? 'deshabilitada']}</p>
        <p><Link href="/">Volver al inicio</Link></p>
      </div>
    )
  }
  if (!access.writer) {
    return (
      <div className="alert alert-info" role="note">
        <p>Tu cuenta tiene acceso de <strong>solo lectura</strong>. Para registrar operaciones debe estar en la lista de escritores.</p>
        <p><Link href="/">Volver al inicio</Link></p>
      </div>
    )
  }
  return (
    <>
      {access.status.mode === 'mock' ? <MockBanner /> : <RealWriteBanner />}
      {children}
    </>
  )
}
