'use client'

import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { cuerpo, enviar, type CampoForm, type Resultado } from '@/lib/radaros/pipeline-formularios'

/* --------------------------------------------------------------------------------------------
 * Alta y edición de producto, proveedor, cotización y embarque (ORD-POS-110, docs/diseno-eco-pipeline.md §4.1). Solo
 * UI sobre las rutas existentes; el servidor repite todo. Nada optimista: el botón se desactiva mientras se envía, el
 * mensaje «Guardado» solo sale con la respuesta ok y la vista se relee de la hoja con el refresh del router. Un 409 se
 * muestra con la versión actual y no se reintenta solo.
 * ------------------------------------------------------------------------------------------ */

type Estado = { status: 'idle' } | { status: 'sending' } | { status: 'hecho'; r: Resultado }

export interface FormularioEcoProps {
  titulo: string
  url: string
  campos: readonly CampoForm[]
  /** Valores de la hoja por columna: en la edición, los que se comparan para enviar solo lo que cambió. */
  iniciales?: Record<string, string | null>
  /** Solo en la edición (PATCH con expectedVersion). */
  version?: number
}

function Entrada({ c, valor, error }: { c: CampoForm; valor: string; error?: string }) {
  const t = c.tipo
  const comunes = { name: c.clave, defaultValue: valor, required: c.obligatorio, 'aria-invalid': error ? true : undefined }
  let control
  if (t.k === 'lista') {
    const opciones = valor && !t.valores.includes(valor) ? [valor, ...t.valores] : t.valores
    control = (
      <select {...comunes}>
        {c.obligatorio && valor ? null : <option value="">—</option>}
        {opciones.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    )
  } else if (t.k === 'texto' && t.multilinea) {
    control = <textarea {...comunes} maxLength={t.max} rows={3} />
  } else {
    const pista = t.k === 'fecha' ? 'AAAA-MM-DD' : t.k === 'id' ? `${t.prefijo}-NNNN` : t.k === 'pais' ? 'CN' : t.k === 'idea' ? 'EC-004' : undefined
    const numerico = t.k === 'numero' || t.k === 'entero'
    control = <input {...comunes} type="text" placeholder={pista} inputMode={numerico ? (t.k === 'entero' ? 'numeric' : 'decimal') : undefined} maxLength={t.k === 'texto' ? t.max : undefined} />
  }
  return (
    <label className="field">
      <span>{c.columna}{c.obligatorio ? ' *' : ''}</span>
      {control}
      {error ? <span className="field-error">{error}</span> : null}
    </label>
  )
}

function Mensaje({ r, campos }: { r: Resultado; campos: readonly CampoForm[] }) {
  if (r.tipo === 'ok') {
    return (
      <div className="alert alert-ok" role="status">
        <p><strong>{r.repetida ? 'Ya estaba guardado.' : 'Guardado.'}</strong> <span className="mono">{r.id}</span></p>
        {r.aviso ? <p>{r.aviso}</p> : null}
      </div>
    )
  }
  const columna = (clave: string) => campos.find((c) => c.clave === clave)?.columna ?? clave
  return (
    <div className="alert alert-danger" role="alert">
      <p><strong>No se guardó.</strong> {r.mensaje}</p>
      {r.tipo === 'validacion' ? <ul className="list">{Object.entries(r.campos).map(([k, m]) => <li key={k}><code>{columna(k)}</code>: {m}</li>)}</ul> : null}
      {r.tipo === 'conflicto' ? (
        <p className="small">{r.versionActual !== null ? `Versión actual en la hoja: ${r.versionActual}. ` : ''}No se reintenta solo: recarga la página para ver lo que hay y vuelve a editar.</p>
      ) : null}
    </div>
  )
}

/** Un formulario de alta (POST) o de edición (PATCH con expectedVersion); requestId nuevo en cada envío. */
export function FormularioEco({ titulo, url, campos, iniciales, version }: FormularioEcoProps) {
  const router = useRouter()
  const [estado, setEstado] = useState<Estado>({ status: 'idle' })
  const edicion = version !== undefined && iniciales ? { version, iniciales } : undefined

  async function guardar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (estado.status === 'sending') return
    const form = event.currentTarget
    const valores: Record<string, string> = {}
    for (const [k, v] of new FormData(form).entries()) if (typeof v === 'string') valores[k] = v
    setEstado({ status: 'sending' })
    const r = await enviar(url, edicion ? 'PATCH' : 'POST', cuerpo(campos, valores, () => crypto.randomUUID(), edicion))
    setEstado({ status: 'hecho', r })
    if (r.tipo === 'ok') {
      if (!edicion) form.reset()
      router.refresh()
    }
  }

  const sending = estado.status === 'sending'
  const errores = estado.status === 'hecho' && estado.r.tipo === 'validacion' ? estado.r.campos : {}
  return (
    <details className="eco-form">
      <summary>{titulo}</summary>
      <form onSubmit={guardar} aria-label={titulo}>
        {campos.map((c) => <Entrada key={c.clave} c={c} valor={iniciales?.[c.columna] ?? ''} error={errores[c.clave]} />)}
        {estado.status === 'hecho' ? <Mensaje r={estado.r} campos={campos} /> : <div aria-live="polite" className="visually-hidden">{sending ? 'Guardando…' : ''}</div>}
        <p><button type="submit" className="button button-primary" disabled={sending} aria-busy={sending}>{sending ? 'Guardando…' : 'Guardar'}</button></p>
      </form>
    </details>
  )
}
