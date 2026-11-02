'use client'

import { useEffect, useRef } from 'react'

/**
 * Filtro al cambiar (ORD-POS-130). Se pinta dentro de un `<form method="get">` de filtros, que conserva su botón: sin
 * JavaScript no hace nada y el botón filtra como siempre. Con JavaScript envía el formulario cuando cambia un campo
 * elegido con el puntero; con teclado no envía (cambiar un select con las flechas recargaría la página en cada opción,
 * WCAG 3.2.2) y quien navega así usa Intro o el botón. Los campos de texto nunca se envían solos.
 */
export type Modalidad = 'puntero' | 'teclado' | null

export function debeEnviar(modalidad: Modalidad, campo: { tagName: string; type?: string }): boolean {
  if (modalidad !== 'puntero') return false
  const tag = campo.tagName.toUpperCase()
  if (tag === 'SELECT') return true
  if (tag !== 'INPUT') return false
  return ['checkbox', 'radio', 'date'].includes((campo.type ?? '').toLowerCase())
}

export function FiltroAuto() {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const form = ref.current?.closest('form')
    if (!form) return
    let modalidad: Modalidad = null
    const puntero = () => { modalidad = 'puntero' }
    const teclado = () => { modalidad = 'teclado' }
    const cambio = (e: Event) => {
      const t = e.target
      if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement) {
        if (debeEnviar(modalidad, t)) form.requestSubmit()
      }
    }
    form.addEventListener('pointerdown', puntero)
    form.addEventListener('keydown', teclado)
    form.addEventListener('change', cambio)
    return () => {
      form.removeEventListener('pointerdown', puntero)
      form.removeEventListener('keydown', teclado)
      form.removeEventListener('change', cambio)
    }
  }, [])
  return <span ref={ref} hidden data-filtro-auto="" />
}
