'use client'

import { useRouter } from 'next/navigation'
import { useId, useState, type FormEvent } from 'react'
import { CasillaEntregaCedis, Entrada, Mensaje } from '@/components/eco/formularios-pipeline'
import {
  CASILLA_ENTREGA_CEDIS, cuerpo, enviar, etiquetaCampo, nombreClave, reglaEntregaCedis, validarCampo, type CampoForm, type Resultado,
} from '@/lib/radaros/pipeline-formularios'
import { borradorRespuesta, type ContextoPegado } from '@/lib/radaros/pipeline-pegado'

/* --------------------------------------------------------------------------------------------
 * Bandeja de /eco/cotizaciones (ORD-POS-149, docs/diseno-eco-pipeline.md §16): pedir, recibir y decidir. Solo UI sobre
 * las rutas del pipeline (el servidor repite todo y solo acepta la sesión del propietario). Nada optimista: cada botón se
 * desactiva mientras envía, «Guardado» solo sale con la respuesta ok y la vista se relee con el refresh del router. Un 409
 * (otra versión) se muestra y no se reintenta solo.
 * ------------------------------------------------------------------------------------------ */

type Estado = { status: 'idle' } | { status: 'sending' } | { status: 'hecho'; r: Resultado }

const valoresDe = (form: HTMLFormElement) => {
  const out: Record<string, string> = {}
  for (const [k, v] of new FormData(form).entries()) if (typeof v === 'string') out[k] = v
  return out
}

function Boton({ sending, children, className = 'button' }: { sending: boolean; children: string; className?: string }) {
  return <button type="submit" className={className} disabled={sending} aria-busy={sending}>{sending ? 'Guardando…' : children}</button>
}

/* ------------------------------------------- Pedir ------------------------------------------- */

export interface PedirProps {
  productos: ReadonlyArray<{ id: string; nombre: string | null }>
  proveedores: ReadonlyArray<{ id: string; nombre: string; canal: string | null; pais: string | null }>
  canales: readonly string[]
  /** ORD-POS-150: «Pedir a otro proveedor» desde la ficha llega con el producto ya elegido. */
  productoId?: string
}

/**
 * Paso 1 (criterio 3): producto, proveedor (autocompletado; uno nuevo pide solo NOMBRE y PAIS) y canal. El canal es el del
 * proveedor nuevo; uno existente conserva el suyo. Si el proveedor es nuevo, primero se da de alta (con su propio
 * requestId) y luego se pide la cotización; si la segunda falla, el proveedor ya queda y el siguiente intento lo reúsa.
 */
export function PedirCotizacion({ productos, proveedores, canales, productoId }: PedirProps) {
  const router = useRouter()
  // Puede haber dos «Pedir» en la página (arriba y en la ficha): cada uno con su propia lista de proveedores.
  const listaId = `proveedores-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const [estado, setEstado] = useState<Estado>({ status: 'idle' })
  const [nombre, setNombre] = useState('')
  const [errores, setErrores] = useState<Record<string, string>>({})
  const clave = nombreClave(nombre)
  const existente = clave ? proveedores.find((p) => nombreClave(p.nombre) === clave || p.id === nombre.trim().toUpperCase()) : undefined
  const nuevo = clave !== '' && !existente

  async function pedir(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (estado.status === 'sending') return
    const form = event.currentTarget
    const v = valoresDe(form)
    const e: Record<string, string> = {}
    if (!v.productoId) e.productoId = 'Elige el producto.'
    if (!clave) e.proveedor = 'Escribe el proveedor.'
    if (nuevo) {
      const errNombre = validarCampo({ clave: 'nombre', columna: 'NOMBRE', tipo: { k: 'texto', max: 120, sinContacto: true }, obligatorio: true }, nombre)
      if (errNombre) e.proveedor = errNombre
      const errPais = validarCampo({ clave: 'pais', columna: 'PAIS', tipo: { k: 'pais' }, obligatorio: true }, (v.pais ?? '').toUpperCase())
      if (errPais) e.pais = errPais
      if (!v.canal) e.canal = 'Elige el canal.'
    }
    setErrores(e)
    if (Object.keys(e).length) return
    setEstado({ status: 'sending' })
    let proveedorId = existente?.id
    if (!proveedorId) {
      const r = await enviar('/api/eco/pipeline/proveedores', 'POST', { requestId: crypto.randomUUID(), nombre: nombre.trim(), canal: v.canal, pais: (v.pais ?? '').toUpperCase() })
      if (r.tipo !== 'ok') {
        setEstado({ status: 'hecho', r })
        return
      }
      proveedorId = r.id
    }
    const r = await enviar('/api/eco/pipeline/cotizaciones/pedir', 'POST', { requestId: crypto.randomUUID(), productoId: v.productoId, proveedorId })
    setEstado({ status: 'hecho', r })
    if (r.tipo === 'ok') {
      form.reset()
      setNombre('')
    }
    router.refresh()
  }

  const sending = estado.status === 'sending'
  return (
    <form onSubmit={pedir} aria-label="Pedir cotización" className="eco-form">
      <label className="field">
        <span>Producto *</span>
        <select name="productoId" required defaultValue={productoId && productos.some((p) => p.id === productoId) ? productoId : ''} aria-invalid={errores.productoId ? true : undefined}>
          <option value="">—</option>
          {productos.map((p) => <option key={p.id} value={p.id}>{p.nombre ? `${p.id} · ${p.nombre}` : p.id}</option>)}
        </select>
        {errores.productoId ? <span className="field-error">{errores.productoId}</span> : null}
      </label>
      <label className="field">
        <span>Proveedor *</span>
        <input name="proveedor" type="text" list={listaId} autoComplete="off" maxLength={120} required value={nombre}
          onChange={(e) => setNombre(e.target.value)} aria-invalid={errores.proveedor ? true : undefined} />
        <datalist id={listaId}>{proveedores.map((p) => <option key={p.id} value={p.nombre}>{p.id}</option>)}</datalist>
        <span className="small muted">
          {existente ? `${existente.id} (canal ${existente.canal ?? '—'}, ${existente.pais ?? '—'})` : nuevo ? 'Proveedor nuevo: se da de alta con nombre, país y canal.' : 'Escribe para buscar; si no existe, se crea.'}
        </span>
        {errores.proveedor ? <span className="field-error">{errores.proveedor}</span> : null}
      </label>
      {nuevo ? (
        <label className="field">
          <span>País del proveedor * (PAIS)</span>
          <input name="pais" type="text" placeholder="CN" maxLength={2} required aria-invalid={errores.pais ? true : undefined} />
          {errores.pais ? <span className="field-error">{errores.pais}</span> : null}
        </label>
      ) : null}
      <label className="field">
        <span>Canal{nuevo ? ' *' : ''}</span>
        <select name="canal" defaultValue="ALIBABA" disabled={!nuevo} aria-invalid={errores.canal ? true : undefined}>
          {canales.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        {!nuevo && existente ? <span className="small muted">Se conserva el canal del proveedor.</span> : null}
        {errores.canal ? <span className="field-error">{errores.canal}</span> : null}
      </label>
      <p className="small muted">Queda SOLICITADA con fecha de hoy y respuesta esperada en 7 días.</p>
      {estado.status === 'hecho' ? <Mensaje r={estado.r} campos={[]} /> : null}
      <p><Boton sending={sending} className="button button-primary">Pedir</Boton></p>
    </form>
  )
}

/* ------------------------------------------ Recibir ------------------------------------------ */

export interface RecibirProps {
  id: string
  version: number
  /** Valores de la hoja por columna (lo que se compara para enviar solo lo que cambió). */
  fila: Record<string, string | null>
  /** Valores visibles por defecto donde la hoja está vacía (MONEDA, PAIS_ORIGEN, CERTIFICADO_ORIGEN, UNIDADES_POR_SET). */
  defectos: Record<string, string>
  /** `CAMPOS['eco.cotizacion.editar']`. */
  campos: readonly CampoForm[]
  /** Pistas de PIPE_PARAMETROS por columna. */
  pistas: Record<string, string>
  fleteCedisRef: number | null
  /** Para el pegado: los campos del alta (mismas limpiezas que «Pegar tabla de Gemini»). */
  pegado: ContextoPegado
  /** ORD-POS-150: «Recibir» en «Esperando respuesta» y «Completar» en «Por completar» (el mismo formulario). */
  accion?: 'Recibir' | 'Completar'
}

/** Criterio 4: visibles, con su valor por defecto visible antes de guardar, y el resto plegado en «Más detalles». */
export const VISIBLES_RECIBIR = ['PRECIO_UNIT', 'PRECIO_POR', 'INCOTERM', 'CANTIDAD_COTIZADA', 'MOQ'] as const
export const DEFECTOS_RECIBIR = ['MONEDA', 'PAIS_ORIGEN', 'CERTIFICADO_ORIGEN', 'UNIDADES_POR_SET'] as const
export const DETALLES_RECIBIR = [
  'FLETE_LOCAL_EXPORT', 'FLETE_INTERNACIONAL', 'FLETE_CEDIS', 'SEGURO', 'IGI_PCT', 'DTA', 'AGENTE_ADUANAL', 'PLAZO_PRODUCCION_DIAS',
  'TIPO_CAMBIO', 'TIPO_CAMBIO_FECHA', 'MUESTRA_ESTADO', 'MUESTRA_FECHA_PEDIDO', 'MUESTRA_FECHA_ESPERADA', 'MUESTRA_FECHA_RECIBIDA',
  'MUESTRA_COSTO', 'MUESTRA_MONEDA', 'FECHA_RECIBIDA', 'EVIDENCIA_URL', 'NOTAS',
] as const

/**
 * Paso 2 (criterio 4): edita la MISMA fila (PATCH con expectedVersion) y la pasa a RECIBIDA. Solo se envía lo que cambió
 * respecto de la hoja, más los valores por defecto que se ven en pantalla. «DDP incluye CEDIS» viene marcada: en DDP
 * guarda FLETE_CEDIS = 0; con otro incoterm no aplica y no se envía.
 */
export function RecibirCotizacion({ id, version, fila, defectos, campos, pistas, fleteCedisRef, pegado, accion = 'Recibir' }: RecibirProps) {
  const router = useRouter()
  const [estado, setEstado] = useState<Estado>({ status: 'idle' })
  const [errores, setErrores] = useState<Record<string, string>>({})
  const [borrador, setBorrador] = useState<{ n: number; valores: Record<string, string>; notas: string[]; ignoradas: string[]; error: string | null }>({ n: 0, valores: {}, notas: [], ignoradas: [], error: null })
  const [precioPor, setPrecioPor] = useState(fila.PRECIO_POR ?? '')
  // Solo los campos que se ven: uno que no se pinta nunca se envía (así no se vacía, p. ej., FECHA_SOLICITUD).
  const mostrados = campos.filter((c) => c.columna === 'ESTADO' || ([...VISIBLES_RECIBIR, ...DEFECTOS_RECIBIR, ...DETALLES_RECIBIR] as readonly string[]).includes(c.columna))
  const porColumna = new Map(mostrados.map((c) => [c.columna, c]))
  const valorDe = (c: CampoForm) => borrador.valores[c.clave] ?? fila[c.columna] ?? defectos[c.columna] ?? ''

  function pegar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const texto = String(new FormData(event.currentTarget).get('respuesta') ?? '')
    const b = borradorRespuesta(texto, pegado, { productoId: fila.PRODUCTO_ID ?? '', proveedorId: fila.PROVEEDOR_ID ?? '' })
    setBorrador({ n: borrador.n + 1, ...b })
    if (b.valores.precioPor) setPrecioPor(b.valores.precioPor)
  }

  async function guardar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (estado.status === 'sending') return
    const valores = valoresDe(event.currentTarget)
    // «DDP incluye CEDIS» solo cuenta en DDP; con otro incoterm se ignora (no es error en este paso).
    if ((valores.incoterm ?? '').trim().toUpperCase() !== 'DDP') delete valores[CASILLA_ENTREGA_CEDIS]
    const regla = reglaEntregaCedis(valores, fleteCedisRef)
    const e: Record<string, string> = { ...regla.errores }
    for (const col of VISIBLES_RECIBIR) {
      const c = porColumna.get(col)
      if (c && !(regla.valores[c.clave] ?? '').trim()) e[c.clave] = 'Obligatorio para recibir.'
    }
    for (const c of mostrados) {
      const m = validarCampo(c, regla.valores[c.clave] ?? '')
      if (m && !e[c.clave]) e[c.clave] = m
    }
    setErrores(e)
    if (Object.keys(e).length) return
    setEstado({ status: 'sending' })
    const r = await enviar(`/api/eco/pipeline/cotizaciones/${encodeURIComponent(id)}`, 'PATCH', cuerpo(mostrados, regla.valores, () => crypto.randomUUID(), { version, iniciales: fila }))
    setEstado({ status: 'hecho', r })
    if (r.tipo === 'ok') router.refresh()
  }

  const sending = estado.status === 'sending'
  const todos = { ...(estado.status === 'hecho' && estado.r.tipo === 'validacion' ? estado.r.campos : {}), ...errores }
  const entrada = (col: string) => {
    const c = porColumna.get(col)
    // Los cinco visibles son obligatorios para recibir (el servidor exige precio, moneda, MOQ, incoterm y PRECIO_POR).
    const visible = (VISIBLES_RECIBIR as readonly string[]).includes(col)
    return c ? <Entrada key={`${col}-${borrador.n}`} c={visible ? { ...c, obligatorio: true } : c} valor={valorDe(c)} error={todos[c.clave]} pista={pistas[col]} etiqueta={etiquetaCampo(c, precioPor)} /> : null
  }
  const ddpMarcada = borrador.valores[CASILLA_ENTREGA_CEDIS] !== undefined ? borrador.valores[CASILLA_ENTREGA_CEDIS] === 'SI' : (fila.FLETE_CEDIS ?? '') === '' || Number(fila.FLETE_CEDIS) === 0
  return (
    <details className="eco-form">
      <summary>{accion} {id}</summary>
      <form onSubmit={pegar} aria-label={`Pegar respuesta de ${id}`}>
        <label className="field">
          <span>Pegar respuesta (fila de la tabla B de Gemini o líneas «PRECIO_UNIT: 10.59»)</span>
          <textarea name="respuesta" rows={3} maxLength={20000} />
        </label>
        <p><button type="submit" className="button">Llenar borrador</button> <span className="small muted">No guarda nada: revisa y pulsa «Guardar».</span></p>
        {borrador.error ? <p className="field-error">{borrador.error}</p> : null}
        {borrador.notas.length || borrador.ignoradas.length ? (
          <ul className="list small">
            {borrador.notas.map((n) => <li key={n}>{n}</li>)}
            {borrador.ignoradas.length ? <li>Columnas no reconocidas (no se usan): {borrador.ignoradas.join(', ')}</li> : null}
          </ul>
        ) : null}
      </form>
      <form key={borrador.n} onSubmit={guardar} aria-label={`${accion} ${id}`} onChange={(e) => {
        const t: EventTarget = e.target
        if (t instanceof HTMLSelectElement && t.name === 'precioPor') setPrecioPor(t.value)
      }}>
        <input type="hidden" name="estado" value={fila.ESTADO === 'SOLICITADA' ? 'RECIBIDA' : (fila.ESTADO ?? '')} />
        {VISIBLES_RECIBIR.map(entrada)}
        {DEFECTOS_RECIBIR.map(entrada)}
        <CasillaEntregaCedis marcada={ddpMarcada} error={todos[CASILLA_ENTREGA_CEDIS]} />
        <details>
          <summary>Más detalles</summary>
          <p className="small muted">Vacíos, el tabulador usa PIPE_PARAMETROS (lo dice cada campo) o queda «Por confirmar».</p>
          {DETALLES_RECIBIR.map(entrada)}
        </details>
        {estado.status === 'hecho' ? <Mensaje r={estado.r} campos={campos} /> : null}
        <p><Boton sending={sending} className="button button-primary">Guardar</Boton></p>
      </form>
    </details>
  )
}

/* ------------------------------------------ Decidir ------------------------------------------ */

export interface DecidirProps {
  id: string
  version: number
  estado: string
  notas: string
  precio: string | null
  moneda: string | null
  historial: string | null
}

/** Una edición de 1 clic con la VERSION de la fila (criterio 5). */
function useEdicion(id: string, version: number) {
  const router = useRouter()
  const [estado, setEstado] = useState<Estado>({ status: 'idle' })
  async function patch(cambios: Record<string, string>) {
    if (estado.status === 'sending') return
    setEstado({ status: 'sending' })
    const r = await enviar(`/api/eco/pipeline/cotizaciones/${encodeURIComponent(id)}`, 'PATCH', { requestId: crypto.randomUUID(), expectedVersion: version, ...cambios })
    setEstado({ status: 'hecho', r })
    if (r.tipo === 'ok') router.refresh()
  }
  return { estado, patch }
}

/** Texto de NOTAS con el motivo del rechazo al final (una línea; nunca borra lo que ya había). */
export function notasConMotivo(previas: string, motivo: string): string {
  const linea = `Rechazada: ${motivo.replace(/\s+/g, ' ').trim()}`
  return previas.trim() ? `${previas.trim()}\n${linea}` : linea
}

/**
 * Paso 3 (criterio 5): ELEGIDA en 1 clic; RECHAZADA en 1 clic con un motivo de una línea que se agrega a NOTAS;
 * contraoferta: el precio nuevo se guarda y el servidor conserva el anterior en PRECIO_HISTORIAL.
 */
export function DecidirCotizacion({ id, version, estado: actual, notas, precio, moneda, historial }: DecidirProps) {
  const { estado, patch } = useEdicion(id, version)
  const [error, setError] = useState<string | null>(null)
  const sending = estado.status === 'sending'

  function rechazar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const motivo = String(new FormData(event.currentTarget).get('motivo') ?? '').trim()
    if (!motivo) return setError('Escribe el motivo (una línea).')
    if (/^[=+\-@]/.test(motivo)) return setError('No puede empezar por =, +, - ni @.')
    setError(null)
    void patch({ estado: 'RECHAZADA', notas: notasConMotivo(notas, motivo) })
  }

  function contraoferta(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nuevo = String(new FormData(event.currentTarget).get('precioUnit') ?? '').trim()
    const m = validarCampo({ clave: 'precioUnit', columna: 'PRECIO_UNIT', tipo: { k: 'numero', decimales: 4 }, obligatorio: true }, nuevo)
    if (m) return setError(`Precio nuevo: ${m}`)
    setError(null)
    void patch({ precioUnit: nuevo })
  }

  return (
    <div className="stack">
      <div className="actions-row">
        {actual === 'RECIBIDA' ? (
          <form onSubmit={(e) => { e.preventDefault(); void patch({ estado: 'ELEGIDA' }) }} aria-label={`Elegir ${id}`}>
            <Boton sending={sending} className="button button-primary">Elegir</Boton>
          </form>
        ) : null}
        <form onSubmit={rechazar} aria-label={`Rechazar ${id}`}>
          <input name="motivo" type="text" maxLength={200} placeholder="Motivo (una línea)" aria-label={`Motivo del rechazo de ${id}`} />{' '}
          <Boton sending={sending}>Rechazar</Boton>
        </form>
      </div>
      <form onSubmit={contraoferta} aria-label={`Contraoferta de ${id}`}>
        <label>Contraoferta: precio nuevo{moneda ? ` (${moneda})` : ''}{' '}
          <input name="precioUnit" type="text" inputMode="decimal" placeholder={precio ?? ''} size={8} />
        </label>{' '}
        <Boton sending={sending}>Guardar precio</Boton>
      </form>
      {historial ? <p className="small muted">Precios anteriores: {historial}</p> : null}
      {error ? <p className="field-error">{error}</p> : null}
      {estado.status === 'hecho' ? <Mensaje r={estado.r} campos={[]} /> : null}
    </div>
  )
}

/* ---------------------------------------- Seguimiento ---------------------------------------- */

/** Criterio 7: copia el texto al portapapeles; no envía nada. Si el navegador no deja copiar, el texto queda a la vista. */
export function CopiarSeguimiento({ texto }: { texto: string }) {
  const [estado, setEstado] = useState<'idle' | 'copiado' | 'manual'>('idle')
  async function copiar() {
    try {
      await navigator.clipboard.writeText(texto)
      setEstado('copiado')
    } catch {
      setEstado('manual')
    }
  }
  return (
    <div>
      <button type="button" className="button" onClick={() => void copiar()}>Copiar seguimiento</button>{' '}
      <span role="status" className="small muted">{estado === 'copiado' ? 'Copiado.' : ''}</span>
      {estado === 'manual' ? <textarea readOnly rows={3} value={texto} aria-label="Texto de seguimiento" /> : null}
    </div>
  )
}
