'use client'

import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { CASILLA_ENTREGA_CEDIS, cuerpo, enviar, etiquetaCampo, nombreClave, reglaEntregaCedis, type CampoForm, type Resultado } from '@/lib/radaros/pipeline-formularios'

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
  /** ORD-POS-146 (criterio 2): por columna, qué valor tomará el tabulador si el campo queda vacío. */
  pistas?: Record<string, string>
  /** ORD-POS-146 (criterio 1): registros existentes; si el campo `clave` coincide por nombre, avisa y no envía. */
  duplicados?: { clave: string; existentes: ReadonlyArray<{ id: string; nombre: string }> }
  /**
   * ORD-POS-147 (criterio 2): alta de cotización con la casilla «Incluye entrega en CEDIS Amazon». `fleteCedisRef` es
   * FLETE_CEDIS_REF de PIPE_PARAMETROS (null si no hay): sin la casilla y sin él, DDP pide el monto.
   */
  entregaCedis?: { fleteCedisRef: number | null }
}

/** Un campo del formulario; lo reúsan el alta, la edición y los borradores del pegado (ORD-POS-146). */
export function Entrada({ c, valor, error, pista, etiqueta }: { c: CampoForm; valor: string; error?: string; pista?: string; etiqueta?: string }) {
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
      <span>{etiqueta ?? etiquetaCampo(c, null)}{c.obligatorio ? ' *' : ''}</span>
      {control}
      {pista ? <span className="small muted">{pista}</span> : null}
      {error ? <span className="field-error">{error}</span> : null}
    </label>
  )
}

/** ORD-POS-147 (criterio 2): la casilla de DDP. Marcada guarda FLETE_CEDIS = 0; nunca se envía como columna. */
export function CasillaEntregaCedis({ marcada, error }: { marcada: boolean; error?: string }) {
  return (
    <label className="field">
      <span><input type="checkbox" name={CASILLA_ENTREGA_CEDIS} value="SI" defaultChecked={marcada} aria-invalid={error ? true : undefined} /> Incluye entrega en CEDIS Amazon</span>
      <span className="small muted">Solo con INCOTERM DDP: guarda FLETE_CEDIS = 0. Sin marcarla, escribe el flete o se usa FLETE_CEDIS_REF.</span>
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
export function FormularioEco({ titulo, url, campos, iniciales, version, pistas, duplicados, entregaCedis }: FormularioEcoProps) {
  const router = useRouter()
  const [estado, setEstado] = useState<Estado>({ status: 'idle' })
  const [duplicado, setDuplicado] = useState<string | null>(null)
  const [erroresLocales, setErroresLocales] = useState<Record<string, string>>({})
  // ORD-POS-147 (criterio 4): la etiqueta de MOQ y CANTIDAD_COTIZADA sigue a «El precio es por».
  const [precioPor, setPrecioPor] = useState<string>(iniciales?.PRECIO_POR ?? '')
  const edicion = version !== undefined && iniciales ? { version, iniciales } : undefined

  async function guardar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (estado.status === 'sending') return
    const form = event.currentTarget
    const valores: Record<string, string> = {}
    for (const [k, v] of new FormData(form).entries()) if (typeof v === 'string') valores[k] = v
    // ORD-POS-146: mismo nombre que un registro existente (sin acentos, mayúsculas ni signos) → aviso, sin enviar. El
    // servidor repite la comprobación con la hoja recién leída.
    if (duplicados) {
      const clave = nombreClave(valores[duplicados.clave])
      const otro = clave ? duplicados.existentes.find((x) => nombreClave(x.nombre) === clave) : undefined
      setDuplicado(otro ? `Ya existe ${otro.id} «${otro.nombre}»: no se duplica. Edítalo en su ficha.` : null)
      if (otro) return
    }
    // ORD-POS-147 (criterio 2): la casilla de DDP se convierte en FLETE_CEDIS = 0 o pide el monto, antes de enviar.
    let aEnviar = valores
    if (entregaCedis) {
      const regla = reglaEntregaCedis(valores, entregaCedis.fleteCedisRef)
      setErroresLocales(regla.errores)
      if (Object.keys(regla.errores).length) return
      aEnviar = regla.valores
    }
    setEstado({ status: 'sending' })
    const r = await enviar(url, edicion ? 'PATCH' : 'POST', cuerpo(campos, aEnviar, () => crypto.randomUUID(), edicion))
    setEstado({ status: 'hecho', r })
    if (r.tipo === 'ok') {
      if (!edicion) form.reset()
      router.refresh()
    }
  }

  const sending = estado.status === 'sending'
  const errores = { ...(estado.status === 'hecho' && estado.r.tipo === 'validacion' ? estado.r.campos : {}), ...erroresLocales }
  return (
    <details className="eco-form">
      <summary>{titulo}</summary>
      <form onSubmit={guardar} aria-label={titulo} onChange={(e) => {
        const t: EventTarget = e.target
        if (!(t instanceof HTMLSelectElement)) return
        if (t.name === 'precioPor') setPrecioPor(t.value)
      }}>
        {campos.map((c) => <Entrada key={c.clave} c={c} valor={iniciales?.[c.columna] ?? ''} error={errores[c.clave]} pista={pistas?.[c.columna]} etiqueta={etiquetaCampo(c, precioPor)} />)}
        {entregaCedis ? <CasillaEntregaCedis marcada={false} error={errores[CASILLA_ENTREGA_CEDIS]} /> : null}
        {duplicado ? <div className="alert alert-warn" role="alert"><p><strong>No se guardó.</strong> {duplicado}</p></div> : null}
        {estado.status === 'hecho' ? <Mensaje r={estado.r} campos={campos} /> : <div aria-live="polite" className="visually-hidden">{sending ? 'Guardando…' : ''}</div>}
        <p><button type="submit" className="button button-primary" disabled={sending} aria-busy={sending}>{sending ? 'Guardando…' : 'Guardar'}</button></p>
      </form>
    </details>
  )
}
