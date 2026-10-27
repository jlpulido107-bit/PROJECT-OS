'use client'

import { useRouter } from 'next/navigation'
import { createContext, useContext, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from 'react'
import type { Etapa } from '@/lib/radaros/pipeline'
import { requiereMotivo, TRANSICIONES, transicionPermitida } from '@/lib/radaros/pipeline-transiciones'

/* --------------------------------------------------------------------------------------------
 * Tablero del pipeline con escritura (ORD-POS-102, docs/diseno-eco-pipeline.md §2.1). Solo UI: el servidor repite todas
 * las verificaciones. Arrastre con la API nativa de HTML (sin dependencias) y, para quien no usa ratón, «Mover a…» en
 * cada tarjeta con la misma operación. Nada optimista: la tarjeta no cambia de columna hasta que el servidor confirma y
 * la página se refresca; ante un 409 u otro error se queda donde estaba y se muestra el mensaje.
 * ------------------------------------------------------------------------------------------ */

interface Movible { id: string; version: number; etapa: Etapa; nombre: string }
interface Pendiente extends Movible { a: Etapa }
type Estado = { status: 'idle' } | { status: 'sending'; id: string } | { status: 'error'; id: string; mensaje: string } | { status: 'done'; id: string }

interface Ctx {
  arrastrando: Movible | null
  setArrastrando: (m: Movible | null) => void
  pedir: (m: Movible, a: Etapa) => void
  estado: Estado
  etiquetas: Record<Etapa, string>
}

const TableroCtx = createContext<Ctx | null>(null)

function useTablero(): Ctx {
  const ctx = useContext(TableroCtx)
  if (!ctx) throw new Error('fuera del tablero')
  return ctx
}

export function TableroEditable({ etiquetas, children }: { etiquetas: Record<Etapa, string>; children: ReactNode }) {
  const router = useRouter()
  const [arrastrando, setArrastrando] = useState<Movible | null>(null)
  const [estado, setEstado] = useState<Estado>({ status: 'idle' })
  const [pendiente, setPendiente] = useState<Pendiente | null>(null)
  /** ORD-POS-104 (H2): aviso de la respuesta ok cuando una PIPE_* se acerca al límite de filas. */
  const [aviso, setAviso] = useState<string | null>(null)
  const dialogo = useRef<HTMLDialogElement>(null)

  async function enviar(p: Pendiente, motivo: string | null) {
    setEstado({ status: 'sending', id: p.id })
    try {
      const response = await fetch(`/api/eco/pipeline/productos/${encodeURIComponent(p.id)}/etapa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Project-OS-CSRF': '1' },
        body: JSON.stringify({ requestId: crypto.randomUUID(), expectedVersion: p.version, expectedEtapa: p.etapa, etapa: p.a, ...(motivo ? { motivo } : {}) }),
        credentials: 'same-origin',
      })
      const json = (await response.json().catch(() => null)) as { ok?: boolean; aviso?: string; error?: { mensaje?: string } } | null
      if (json?.ok) {
        setEstado({ status: 'done', id: p.id })
        router.refresh()
        setAviso(json.aviso ?? null)
      } else {
        setEstado({ status: 'error', id: p.id, mensaje: json?.error?.mensaje ?? 'No se pudo mover la tarjeta.' })
      }
    } catch {
      setEstado({ status: 'error', id: p.id, mensaje: 'Sin conexión con el servidor; la tarjeta sigue en su etapa.' })
    }
  }

  function pedir(m: Movible, a: Etapa) {
    if (estado.status === 'sending' || !transicionPermitida(m.etapa, a)) return
    const p = { ...m, a }
    if (requiereMotivo(m.etapa, a)) {
      setPendiente(p)
      dialogo.current?.showModal()
    } else {
      void enviar(p, null)
    }
  }

  function confirmar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const motivo = String(new FormData(event.currentTarget).get('motivo') ?? '').trim()
    if (!pendiente || !motivo) return
    dialogo.current?.close()
    void enviar(pendiente, motivo)
    setPendiente(null)
    event.currentTarget.reset()
  }

  return (
    <TableroCtx.Provider value={{ arrastrando, setArrastrando, pedir, estado, etiquetas }}>
      {estado.status === 'error' ? (
        <div className="alert alert-danger" role="alert"><p><strong>No se movió {estado.id}.</strong> {estado.mensaje}</p></div>
      ) : null}
      {aviso ? <div className="alert alert-warn" role="status"><p>{aviso}</p></div> : null}
      {estado.status === 'sending' ? <p className="small muted" role="status">Moviendo {estado.id}…</p> : null}
      {children}
      <dialog ref={dialogo} aria-labelledby="motivo-titulo" onClose={() => setPendiente(null)}>
        <form onSubmit={confirmar}>
          <h3 id="motivo-titulo">Motivo</h3>
          <p className="small">{pendiente ? `${pendiente.nombre}: ${etiquetas[pendiente.etapa]} → ${etiquetas[pendiente.a]}` : ''}</p>
          <label className="field">
            <span>Motivo (obligatorio, hasta 300 caracteres)</span>
            <textarea name="motivo" required maxLength={300} rows={3} />
          </label>
          <p>
            <button type="submit">Mover</button>{' '}
            <button type="button" onClick={() => dialogo.current?.close()}>Cancelar</button>
          </p>
        </form>
      </dialog>
    </TableroCtx.Provider>
  )
}

/** Columna que acepta soltar solo las tarjetas que pueden llegar a su etapa (§5.1). */
export function ColumnaSoltable({ etapa, label, children }: { etapa: Etapa; label: string; children: ReactNode }) {
  const { arrastrando, setArrastrando, pedir } = useTablero()
  const [encima, setEncima] = useState(false)
  const acepta = arrastrando !== null && transicionPermitida(arrastrando.etapa, etapa)
  function dragOver(event: DragEvent<HTMLElement>) {
    if (!acepta) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setEncima(true)
  }
  function drop(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    setEncima(false)
    if (arrastrando && acepta) pedir(arrastrando, etapa)
    setArrastrando(null)
  }
  return (
    <section className={`board-col${encima ? ' board-col-over' : ''}`} aria-label={label} onDragOver={dragOver} onDragLeave={() => setEncima(false)} onDrop={drop}>
      {children}
    </section>
  )
}

/** Tarjeta arrastrable con «Mover a…» (las etapas permitidas por §5.1). */
export function TarjetaMovible({ id, version, etapa, nombre, children }: Movible & { children: ReactNode }) {
  const { setArrastrando, pedir, estado, etiquetas } = useTablero()
  const [destino, setDestino] = useState<Etapa | ''>('')
  const movible = { id, version, etapa, nombre }
  const ocupado = estado.status === 'sending'
  return (
    <li
      className="card"
      draggable={!ocupado}
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', id)
        event.dataTransfer.effectAllowed = 'move'
        setArrastrando(movible)
      }}
      onDragEnd={() => setArrastrando(null)}
    >
      {children}
      <form
        className="filters"
        aria-label={`Mover ${nombre}`}
        onSubmit={(event) => {
          event.preventDefault()
          if (destino) pedir(movible, destino)
        }}
      >
        <label className="small">Mover a…{' '}
          <select value={destino} onChange={(event) => setDestino(event.target.value as Etapa | '')} disabled={ocupado}>
            <option value="">Elige etapa</option>
            {TRANSICIONES[etapa].map((e) => <option key={e} value={e}>{etiquetas[e]}</option>)}
          </select>
        </label>{' '}
        <button type="submit" disabled={ocupado || !destino}>Mover</button>
      </form>
    </li>
  )
}
