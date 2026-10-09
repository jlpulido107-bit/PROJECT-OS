'use client'

import type { ReactNode } from 'react'
import { useFormStatus } from 'react-dom'

export function SubmitButton({ children, pendingLabel }: { children: ReactNode; pendingLabel: string }) {
  const { pending } = useFormStatus()
  return (
    <button type="submit" className="button" disabled={pending} aria-busy={pending}>
      {pending ? pendingLabel : children}
    </button>
  )
}
