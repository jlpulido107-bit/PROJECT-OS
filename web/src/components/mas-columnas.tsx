'use client'

import { useId, useState, useSyncExternalStore, type ReactNode } from 'react'

/**
 * «Más columnas» de una tabla (ORD-POS-152). Mejora progresiva: sin JavaScript (y en el render del servidor) se ven
 * todas las columnas y no hay botón; con JavaScript se ocultan las celdas marcadas con `COL_EXTRA` y un botón con
 * `aria-expanded` las muestra u oculta. La elección se recuerda solo en la sesión del navegador (`sessionStorage`); si el
 * navegador no deja guardarla, el botón sigue funcionando mientras la página está abierta.
 */
export const COL_EXTRA = 'col-extra'
export const PREFIJO_CLAVE = 'mas-columnas:'
const EVENTO = 'mas-columnas'

type Lectura = Pick<Storage, 'getItem'>
type Escritura = Pick<Storage, 'setItem' | 'removeItem'>

/** true si en esta sesión se pidió ver todas las columnas de `clave`; sin almacenamiento o con error, false. */
export function leerEleccion(store: Lectura | null, clave: string): boolean {
  try { return store?.getItem(PREFIJO_CLAVE + clave) === '1' } catch { return false }
}

/** Guarda la elección; false si el navegador no la deja guardar (modo privado, almacenamiento bloqueado). */
export function guardarEleccion(store: Escritura | null, clave: string, todas: boolean): boolean {
  if (!store) return false
  try {
    if (todas) store.setItem(PREFIJO_CLAVE + clave, '1')
    else store.removeItem(PREFIJO_CLAVE + clave)
    return true
  } catch { return false }
}

function almacen(): Storage | null {
  try { return window.sessionStorage } catch { return null }
}

function suscribir(cb: () => void) {
  window.addEventListener(EVENTO, cb)
  return () => window.removeEventListener(EVENTO, cb)
}

export function MasColumnas({ clave, extras, children }: { clave: string; extras: number; children: ReactNode }) {
  const id = useId()
  // null en el servidor y al hidratar (todas las columnas, sin botón); en el navegador, lo guardado en la sesión.
  const guardada = useSyncExternalStore(suscribir, () => leerEleccion(almacen(), clave), () => null)
  const [local, setLocal] = useState<boolean | null>(null)
  const todas = guardada === null ? null : (local ?? guardada)
  const alternar = () => {
    const siguiente = !todas
    setLocal(siguiente)
    if (guardarEleccion(almacen(), clave, siguiente)) window.dispatchEvent(new Event(EVENTO))
  }
  return (
    <div className="mas-columnas" data-cortas={todas === false ? '' : undefined}>
      {todas === null ? null : (
        <button type="button" className="button button-ghost mas-columnas-boton" aria-expanded={todas} aria-controls={id} onClick={alternar}>
          {todas ? 'Menos columnas' : `Más columnas (${extras})`}
        </button>
      )}
      <div id={id}>{children}</div>
    </div>
  )
}
