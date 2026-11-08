'use client'

import { useEffect } from 'react'

/**
 * Enlace a una idea abierta del ranking de /eco (ORD-POS-151): `#idea-<ID>` abre su `<details>` al cargar y al cambiar
 * el hash, y abrir o cerrar una idea deja el hash en la barra de direcciones (sin recargar ni añadir historial).
 * Sin JavaScript, cada idea se abre con su resumen como siempre.
 */
export const PREFIJO_IDEA = 'idea-'

/** ID del hash sin `#` y decodificado; null si no se puede decodificar. */
export function idDelHash(hash: string): string | null {
  try { return decodeURIComponent(hash.replace(/^#/, '')) } catch { return null }
}

export function detallesDelHash(hash: string, doc: Pick<Document, 'getElementById'>): HTMLDetailsElement | null {
  const id = idDelHash(hash)
  if (!id?.startsWith(PREFIJO_IDEA)) return null
  const el = doc.getElementById(id)
  return el && el.tagName === 'DETAILS' ? (el as HTMLDetailsElement) : null
}

export function AbrirIdeaPorHash() {
  useEffect(() => {
    const abrir = () => {
      const d = detallesDelHash(window.location.hash, document)
      if (d && !d.open) {
        d.open = true
        d.scrollIntoView({ block: 'start' })
      }
    }
    const alternar = (e: Event) => {
      const d = e.target
      if (!(d instanceof HTMLDetailsElement) || !d.id.startsWith(PREFIJO_IDEA)) return
      const { pathname, search, hash } = window.location
      if (d.open) window.history.replaceState(window.history.state, '', `${pathname}${search}#${encodeURIComponent(d.id)}`)
      else if (idDelHash(hash) === d.id) window.history.replaceState(window.history.state, '', `${pathname}${search}#ranking`)
    }
    abrir()
    window.addEventListener('hashchange', abrir)
    // `toggle` no burbujea: se escucha en captura.
    document.addEventListener('toggle', alternar, true)
    return () => {
      window.removeEventListener('hashchange', abrir)
      document.removeEventListener('toggle', alternar, true)
    }
  }, [])
  return null
}
