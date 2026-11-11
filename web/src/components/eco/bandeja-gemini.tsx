'use client'

import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { CasillaEntregaCedis, Entrada } from '@/components/eco/formularios-pipeline'
import {
  CASILLA_ENTREGA_CEDIS, cuerpo, enviar, etiquetaCampo, pareceContacto, reglaEntregaCedis, validarCampo, type CampoForm, type Resultado,
} from '@/lib/radaros/pipeline-formularios'
import { confirmable, revisarBorrador, type ContextoPegado } from '@/lib/radaros/pipeline-pegado'
import type { PropuestaBandeja } from '@/lib/radaros/pipeline-bandeja-gemini'

/* --------------------------------------------------------------------------------------------
 * Compras > Bandeja (ORD-POS-155, POS-056; docs/diseno-eco-pipeline.md §18). Las filas PENDIENTE de PIPE_BANDEJA_GEMINI,
 * con los chequeos de «Recibir varias»: cada una se corrige y se confirma o se rechaza, una por vez. Confirmar envía a la
 * ruta de la bandeja, que escribe con el servicio del pipeline y marca la fila; nada cambia en pantalla hasta que la hoja
 * lo confirma. Una fila con fórmula, correo o teléfono, duplicada o con errores no tiene botón de confirmar.
 * ------------------------------------------------------------------------------------------ */

type Estado = { status: 'idle' } | { status: 'sending' } | { status: 'hecho'; r: Resultado }

export interface BandejaGeminiProps {
  propuestas: PropuestaBandeja[]
  /** Campos de `eco.bandeja.cotizacion` (los del alta de cotización y la evidencia) con la hoja leída. */
  contexto: ContextoPegado
  /** Campos de `eco.bandeja.proveedor` (los del alta de proveedor). */
  camposProveedor: readonly CampoForm[]
  pistas?: Record<string, string>
}

const ruta = (id: string, accion: 'confirmar' | 'rechazar') => `/api/eco/pipeline/bandeja/${encodeURIComponent(id)}/${accion}`

function useEnvio() {
  const router = useRouter()
  const [estado, setEstado] = useState<Estado>({ status: 'idle' })
  // Un requestId por acción y por fila: reintentar tras un error de red no duplica nada (§18.3).
  const [ids] = useState(() => ({ confirmar: crypto.randomUUID(), rechazar: crypto.randomUUID() }))
  async function mandar(url: string, body: Record<string, unknown>) {
    setEstado({ status: 'sending' })
    const r = await enviar(url, 'POST', body)
    setEstado({ status: 'hecho', r })
    if (r.tipo === 'ok') router.refresh()
    return r
  }
  return { estado, ids, mandar }
}

function Rechazar({ id, deshabilitado, ids, mandar, sending }: {
  id: string; deshabilitado: boolean; ids: { rechazar: string }; mandar: (url: string, body: Record<string, unknown>) => Promise<Resultado>; sending: boolean
}) {
  const [motivo, setMotivo] = useState('')
  const [error, setError] = useState<string | null>(null)
  async function rechazar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const m = motivo.replace(/\s+/g, ' ').trim()
    if (!m) return setError('Escribe el motivo en una línea.')
    if (m.length > 300) return setError('Hasta 300 caracteres.')
    if (pareceContacto(m)) return setError('Sin correos ni teléfonos de personas.')
    setError(null)
    await mandar(ruta(id, 'rechazar'), { requestId: ids.rechazar, motivo: m })
  }
  return (
    <form onSubmit={rechazar} aria-label={`Rechazar ${id}`} className="inline-form">
      <label className="field">
        <span>Motivo del rechazo (se agrega al final de NOTAS)</span>
        <input type="text" name="motivo" maxLength={300} value={motivo} onChange={(e) => setMotivo(e.target.value)} disabled={deshabilitado} />
        {error ? <span className="field-error">{error}</span> : null}
      </label>
      <p><button type="submit" className="button" disabled={deshabilitado || sending}>Rechazar</button></p>
    </form>
  )
}

function Resultado({ estado }: { estado: Estado }) {
  if (estado.status !== 'hecho') return null
  const r = estado.r
  if (r.tipo === 'ok') {
    return <div className="alert alert-ok" role="status"><p><strong>{r.repetida ? 'Ya estaba hecha.' : 'Hecho.'}</strong> <span className="mono">{r.id}</span>{r.aviso ? ` ${r.aviso}` : ''}</p></div>
  }
  return <div className="alert alert-danger" role="alert"><p><strong>No se escribió.</strong> {r.mensaje}</p></div>
}

function Encabezado({ p }: { p: PropuestaBandeja }) {
  const f = p.fila
  return (
    <>
      <p>
        <strong className="mono">{f.id ?? '(sin BANDEJA_ID)'}</strong> · fila {f.fila} · {f.tipo ?? f.tipoTexto ?? 'sin TIPO'}
        {f.celdas.FECHA_CAPTURA ? <> · capturada {f.celdas.FECHA_CAPTURA}</> : null}
        {f.celdas.VERSION ? <> · versión {f.celdas.VERSION}</> : null}
      </p>
      {f.evidencia ? <p className="small"><a href={f.evidencia} target="_blank" rel="noreferrer noopener">Evidencia en Drive</a></p> : null}
      {f.bloqueos.length ? (
        <div className="alert alert-danger" role="alert">
          <p><strong>No se puede confirmar:</strong> corrígela en la hoja (los valores marcados no se muestran).</p>
          <ul className="list small">{f.bloqueos.map((b) => <li key={b}>{b}</li>)}</ul>
        </div>
      ) : null}
    </>
  )
}

function FilaCotizacion({ p, contexto, pistas }: { p: Extract<PropuestaBandeja, { tipo: 'COTIZACION' }>; contexto: ContextoPegado; pistas?: Record<string, string> }) {
  const { estado, ids, mandar } = useEnvio()
  const b = p.borrador
  const [revision, setRevision] = useState({ errores: b.errores, duplicada: b.duplicada })
  const [precioPor, setPrecioPor] = useState(b.valores.precioPor ?? '')
  const hecho = estado.status === 'hecho' && estado.r.tipo === 'ok'
  const sending = estado.status === 'sending'
  const bloqueada = p.fila.bloqueos.length > 0 || !p.fila.id

  async function confirmar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (sending || hecho || bloqueada) return
    const valores: Record<string, string> = {}
    for (const [k, v] of new FormData(event.currentTarget).entries()) if (typeof v === 'string') valores[k] = v
    // Los chequeos de «Recibir varias» otra vez, con lo corregido: un error o un duplicado no se envía.
    const r = revisarBorrador(valores, contexto, { idGemini: b.idGemini })
    setRevision(r)
    if (!confirmable({ reconocida: b.reconocida, ...r })) return
    const aEnviar = reglaEntregaCedis(valores, contexto.fleteCedisRef ?? null).valores
    const res = await mandar(ruta(p.fila.id!, 'confirmar'), { ...cuerpo(contexto.campos, aEnviar, () => ids.confirmar), tipo: 'COTIZACION' })
    if (res.tipo === 'validacion') setRevision({ errores: res.campos, duplicada: null })
  }

  return (
    <li className="card">
      <Encabezado p={p} />
      {!b.reconocida ? <p className="small">{b.motivo}</p> : null}
      {b.notas.length ? <ul className="list small">{b.notas.map((n) => <li key={n}>{n}</li>)}</ul> : null}
      {revision.duplicada ? <div className="alert alert-warn" role="alert"><p><strong>Duplicada: no se confirma.</strong> {revision.duplicada}</p></div> : null}
      <form onSubmit={confirmar} aria-label={`Confirmar ${p.fila.id ?? p.fila.fila}`} onChange={(e) => {
        const t: EventTarget = e.target
        if (t instanceof HTMLSelectElement && t.name === 'precioPor') setPrecioPor(t.value)
      }}>
        <fieldset disabled={hecho || sending || bloqueada} className="stack">
          {contexto.campos.map((c) => (
            <Entrada key={c.clave} c={c} valor={b.valores[c.clave] ?? ''} error={revision.errores[c.clave]} pista={pistas?.[c.columna]} etiqueta={etiquetaCampo(c, precioPor)} />
          ))}
          <CasillaEntregaCedis marcada={b.valores[CASILLA_ENTREGA_CEDIS] === 'SI'} error={revision.errores[CASILLA_ENTREGA_CEDIS]} />
        </fieldset>
        {hecho || bloqueada || revision.duplicada ? null : (
          <p><button type="submit" className="button button-primary" disabled={sending} aria-busy={sending}>{sending ? 'Confirmando…' : 'Confirmar'}</button></p>
        )}
      </form>
      {hecho ? null : <Rechazar id={p.fila.id ?? ''} deshabilitado={!p.fila.id || sending} ids={ids} mandar={mandar} sending={sending} />}
      <Resultado estado={estado} />
    </li>
  )
}

function FilaProveedor({ p, campos }: { p: Extract<PropuestaBandeja, { tipo: 'PROVEEDOR' }>; campos: readonly CampoForm[] }) {
  const { estado, ids, mandar } = useEnvio()
  const [errores, setErrores] = useState<Record<string, string>>(p.proveedor.errores)
  const hecho = estado.status === 'hecho' && estado.r.tipo === 'ok'
  const sending = estado.status === 'sending'
  const bloqueada = p.fila.bloqueos.length > 0 || !p.fila.id
  const iniciales: Record<string, string> = { nombre: p.proveedor.nombre, pais: p.proveedor.pais, notas: p.proveedor.notas }

  async function confirmar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (sending || hecho || bloqueada) return
    const valores: Record<string, string> = {}
    for (const [k, v] of new FormData(event.currentTarget).entries()) if (typeof v === 'string') valores[k] = v
    const e: Record<string, string> = {}
    for (const c of campos) {
      const m = validarCampo(c, valores[c.clave] ?? '')
      if (m) e[c.clave] = m
    }
    setErrores(e)
    if (Object.keys(e).length) return
    const res = await mandar(ruta(p.fila.id!, 'confirmar'), { ...cuerpo(campos, valores, () => ids.confirmar), tipo: 'PROVEEDOR' })
    if (res.tipo === 'validacion') setErrores(res.campos)
  }

  return (
    <li className="card">
      <Encabezado p={p} />
      {p.proveedor.existente ? <p className="small"><strong>Ya existe {p.proveedor.existente}</strong> con ese nombre: confirmar lo liga, sin duplicarlo.</p> : null}
      <form onSubmit={confirmar} aria-label={`Confirmar ${p.fila.id ?? p.fila.fila}`}>
        <fieldset disabled={hecho || sending || bloqueada} className="stack">
          {campos.map((c) => <Entrada key={c.clave} c={c} valor={iniciales[c.clave] ?? ''} error={errores[c.clave]} />)}
        </fieldset>
        {hecho || bloqueada ? null : (
          <p><button type="submit" className="button button-primary" disabled={sending} aria-busy={sending}>{sending ? 'Confirmando…' : 'Confirmar'}</button></p>
        )}
      </form>
      {hecho ? null : <Rechazar id={p.fila.id ?? ''} deshabilitado={!p.fila.id || sending} ids={ids} mandar={mandar} sending={sending} />}
      <Resultado estado={estado} />
    </li>
  )
}

function FilaSinTipo({ p }: { p: PropuestaBandeja }) {
  const { estado, ids, mandar } = useEnvio()
  const hecho = estado.status === 'hecho' && estado.r.tipo === 'ok'
  return (
    <li className="card">
      <Encabezado p={p} />
      {hecho ? null : <Rechazar id={p.fila.id ?? ''} deshabilitado={!p.fila.id || estado.status === 'sending'} ids={ids} mandar={mandar} sending={estado.status === 'sending'} />}
      <Resultado estado={estado} />
    </li>
  )
}

export function BandejaGemini({ propuestas, contexto, camposProveedor, pistas }: BandejaGeminiProps) {
  if (!propuestas.length) return <p className="muted">No hay filas PENDIENTE en la bandeja.</p>
  return (
    <ul className="plain stack" aria-label="Propuestas de Gemini">
      {propuestas.map((p) => (
        p.tipo === 'COTIZACION' ? <FilaCotizacion key={p.fila.fila} p={p} contexto={contexto} pistas={pistas} />
          : p.tipo === 'PROVEEDOR' ? <FilaProveedor key={p.fila.fila} p={p} campos={camposProveedor} />
            : <FilaSinTipo key={p.fila.fila} p={p} />
      ))}
    </ul>
  )
}
