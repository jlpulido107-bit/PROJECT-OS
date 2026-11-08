'use client'

import { useId, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react'

/**
 * Pestañas del detalle de una idea en /eco (ORD-POS-151). Mejora progresiva: sin JavaScript (y en el render del
 * servidor) se ven todas las secciones, cada una con su título; con JavaScript, una lista de pestañas con el patrón de
 * WAI-ARIA (flechas, Inicio y Fin; solo la pestaña activa entra en el orden de tabulación).
 */
export interface Pestana { id: string; titulo: string; contenido: ReactNode }

export function siguiente(actual: number, total: number, tecla: string): number | null {
  if (total === 0) return null
  if (tecla === 'ArrowRight') return (actual + 1) % total
  if (tecla === 'ArrowLeft') return (actual - 1 + total) % total
  if (tecla === 'Home') return 0
  if (tecla === 'End') return total - 1
  return null
}

const sinSuscripcion = () => () => {}

export function PestanasIdea({ pestanas, etiqueta }: { pestanas: Pestana[]; etiqueta: string }) {
  const base = useId()
  // false en el servidor y al hidratar; true ya en el navegador (mejora progresiva sin setState en un efecto).
  const listo = useSyncExternalStore(sinSuscripcion, () => true, () => false)
  const [activa, setActiva] = useState(0)
  const refs = useRef<Array<HTMLButtonElement | null>>([])

  if (!listo) {
    return (
      <div className="idea-secciones">
        {pestanas.map((p) => <section key={p.id} aria-label={p.titulo}><h4>{p.titulo}</h4>{p.contenido}</section>)}
      </div>
    )
  }
  const tecla = (e: KeyboardEvent<HTMLButtonElement>) => {
    const n = siguiente(activa, pestanas.length, e.key)
    if (n === null) return
    e.preventDefault()
    setActiva(n)
    refs.current[n]?.focus()
  }
  return (
    <div className="idea-pestanas">
      <div role="tablist" aria-label={etiqueta} className="idea-tablist">
        {pestanas.map((p, i) => (
          <button key={p.id} type="button" role="tab" id={`${base}-t-${p.id}`} aria-controls={`${base}-p-${p.id}`}
            aria-selected={i === activa} tabIndex={i === activa ? 0 : -1} onClick={() => setActiva(i)} onKeyDown={tecla}
            ref={(el) => { refs.current[i] = el }}>
            {p.titulo}
          </button>
        ))}
      </div>
      {pestanas.map((p, i) => (
        <div key={p.id} role="tabpanel" id={`${base}-p-${p.id}`} aria-labelledby={`${base}-t-${p.id}`} hidden={i !== activa} tabIndex={0}>
          {p.contenido}
        </div>
      ))}
    </div>
  )
}
