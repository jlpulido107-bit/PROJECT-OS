'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState, type FormEvent, type ReactNode, type SyntheticEvent } from 'react'
import { CONCEPTO_MAX, prefijoAjuste } from '@/lib/finanzas/escritura-validacion'
import { CODIGOS_PENDIENTES, cuerpoEnvio, estadoInicial, trasRespuesta, type EnvioEstado, type Respuesta } from '@/lib/finanzas/envio'

/* --------------------------------------------------------------------------------------------
 * Formularios de escritura de /finanzas (ORD-POS-077, docs/diseno-finanzas-v2.md §3 y §4.3). Solo UI: el servidor
 * repite todas las verificaciones. Cada formulario genera su requestId al abrirse y lo reenvía en cada reintento; solo
 * se renueva tras un alta correcta. Tras un fallo que pudo dejar la auditoría escrita, el reintento reenvía el mismo
 * cuerpo aunque el formulario cambie (ORD-POS-079, `lib/finanzas/envio.ts`). El botón se desactiva mientras se envía:
 * doble clic, recarga o red lenta no duplican.
 * ------------------------------------------------------------------------------------------ */

interface Exito { ok: true; id: string; repetida: boolean }
interface Fallo { ok: false; error: { codigo: string; mensaje: string; campos?: Record<string, string> } }
type Estado = { status: 'idle' } | { status: 'sending' } | { status: 'done'; result: Exito } | { status: 'error'; error: Fallo['error'] }

export interface AjustableOpcion { movId: string; proyecto: string; tipo: string; categoria: string; concepto: string }
export interface PendienteOpcion {
  recurrenteId: string
  mes: string
  movId: string
  concepto: string
  moneda: 'MXN' | 'USD'
  /** Monto esperado como texto decimal (p. ej. «123.45»). */
  monto: string
  fechaCobro: string
}

const PROYECTOS = ['ECO', 'POS']
const TIPOS = ['Gasto', 'Ingreso', 'Inversión']
const CATEGORIAS = ['Herramientas', 'Marketplace', 'Producto', 'Marketing', 'Legal y marca', 'Ventas']

function nuevoId(): string {
  return crypto.randomUUID()
}

/** requestId por apertura del formulario; envío con el botón desactivado y cuerpo congelado tras un fallo a medias. */
function useEnvio(endpoint: string) {
  const router = useRouter()
  const [estado, setEstado] = useState<Estado>({ status: 'idle' })
  const [congelado, setCongelado] = useState(false)
  const envio = useRef<EnvioEstado | null>(null)

  /** Al abrir el formulario: si no hay un requestId pendiente, se crea uno. */
  function abrir() {
    envio.current ??= estadoInicial(nuevoId)
  }

  async function enviar(formulario: Record<string, unknown>) {
    if (estado.status === 'sending') return
    abrir()
    const actual = envio.current!
    const cuerpo = cuerpoEnvio(actual, formulario)
    setEstado({ status: 'sending' })
    let respuesta: Respuesta
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Project-OS-CSRF': '1' },
        body: JSON.stringify(cuerpo),
        credentials: 'same-origin',
      })
      const json = (await response.json().catch(() => null)) as Exito | Fallo | null
      if (json && json.ok) {
        setEstado({ status: 'done', result: json })
        respuesta = { ok: true }
      } else {
        const error = json && !json.ok ? json.error : { codigo: 'error', mensaje: 'No se pudo completar la operación.' }
        setEstado({ status: 'error', error })
        respuesta = { ok: false, codigo: error.codigo }
      }
    } catch {
      setEstado({ status: 'error', error: { codigo: 'red', mensaje: 'Sin conexión con el servidor. Puedes reintentar sin duplicar.' } })
      respuesta = { ok: false, codigo: 'red' }
    }
    envio.current = trasRespuesta(actual, cuerpo, respuesta, nuevoId)
    setCongelado(envio.current.congelado !== null)
    if (respuesta.ok) router.refresh()
  }

  return { estado, enviar, abrir, congelado }
}

function valores(form: HTMLFormElement): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of new FormData(form).entries()) if (typeof v === 'string' && v.trim() !== '') out[k] = v.trim()
  return out
}

function Campo({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {error ? <span className="field-error">{error}</span> : null}
    </label>
  )
}

function Resultado({ estado, congelado }: { estado: Estado; congelado: boolean }) {
  if (estado.status === 'error') {
    return (
      <div className="alert alert-danger" role="alert">
        <p><strong>No se guardó.</strong> {estado.error.mensaje}</p>
        {congelado || CODIGOS_PENDIENTES.includes(estado.error.codigo)
          ? <p className="small">Al reintentar se reenvían los mismos datos de la solicitud anterior, aunque cambies el formulario: no se duplicará. Si algo estaba mal, corrígelo después con «Ajustar».</p> : null}
      </div>
    )
  }
  if (estado.status === 'done') {
    return (
      <div className="alert alert-ok" role="status">
        <p><strong>{estado.result.repetida ? 'Ya estaba registrado.' : 'Guardado.'}</strong> <span className="mono">{estado.result.id}</span></p>
      </div>
    )
  }
  return <div aria-live="polite" className="visually-hidden">{estado.status === 'sending' ? 'Guardando…' : ''}</div>
}

function Boton({ estado, label, congelado }: { estado: Estado; label: string; congelado: boolean }) {
  const sending = estado.status === 'sending'
  return <button type="submit" className="button button-primary" disabled={sending} aria-busy={sending}>{sending ? 'Guardando…' : congelado ? 'Reintentar la misma solicitud' : label}</button>
}

const campo = (estado: Estado, nombre: string) => (estado.status === 'error' ? estado.error.campos?.[nombre] : undefined)

/** Vista previa de `round(MONTO_ORIG × TIPO_CAMBIO, 2)`; el servidor hace el cálculo definitivo. */
function mxnDe(monto: string, tc: string): string | null {
  const a = Number(monto)
  const b = Number(tc)
  if (!monto || !tc || !Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null
  return (Math.round(Math.abs(a * b) * 100) / 100 * Math.sign(a)).toFixed(2)
}

function CamposMonto({ estado, tipoCambioDefecto, ajuste }: { estado: Estado; tipoCambioDefecto: string | null; ajuste: boolean }) {
  const [moneda, setMoneda] = useState('MXN')
  const [orig, setOrig] = useState('')
  const [tc, setTc] = useState(tipoCambioDefecto ?? '')
  const calculado = moneda === 'USD' ? mxnDe(orig, tc) : null
  const paso = '0.01'
  const min = ajuste ? undefined : '0.01'
  return (
    <>
      <Campo label="Moneda" error={campo(estado, 'moneda')}>
        <select name="moneda" value={moneda} onChange={(e) => setMoneda(e.target.value)}>
          <option value="MXN">MXN</option>
          <option value="USD">USD</option>
        </select>
      </Campo>
      {moneda === 'USD' ? (
        <>
          <Campo label="Monto en USD" error={campo(estado, 'montoOrig')}>
            <input name="montoOrig" type="number" step={paso} min={min} required value={orig} onChange={(e) => setOrig(e.target.value)} />
          </Campo>
          <Campo label="Tipo de cambio" error={campo(estado, 'tipoCambio')}>
            <input name="tipoCambio" type="number" step="0.0001" min="0.0001" required value={tc} onChange={(e) => setTc(e.target.value)} />
          </Campo>
          <p className="small">Monto en MXN que se registrará: <strong>{calculado ?? '—'}</strong></p>
        </>
      ) : (
        <Campo label={ajuste ? 'Monto en MXN (negativo para restar)' : 'Monto en MXN'} error={campo(estado, 'montoMxn')}>
          <input name="montoMxn" type="number" step={paso} min={min} required />
        </Campo>
      )}
    </>
  )
}

function CamposComunes({ estado, hoy, conceptoMax = CONCEPTO_MAX }: { estado: Estado; hoy: string; conceptoMax?: number }) {
  return (
    <>
      <Campo label="Fecha" error={campo(estado, 'fecha')}><input name="fecha" type="date" required defaultValue={hoy} /></Campo>
      <Campo label="Concepto" error={campo(estado, 'concepto')}>
        <input name="concepto" required minLength={3} maxLength={conceptoMax} placeholder="Sin datos personales ni bancarios" />
      </Campo>
      <Campo label="Producto (opcional)" error={campo(estado, 'productoId')}><input name="productoId" pattern="EC-\d{3,4}" placeholder="EC-NNN" /></Campo>
      <Campo label="IVA en MXN (opcional)" error={campo(estado, 'ivaMxn')}><input name="ivaMxn" type="number" step="0.01" min="0" /></Campo>
      <Campo label="Comprobante" error={campo(estado, 'comprobante')}>
        <select name="comprobante" defaultValue="no"><option value="sí">sí</option><option value="no">no</option></select>
      </Campo>
    </>
  )
}

function Lista({ name, opciones, error }: { name: string; opciones: string[]; error?: string }) {
  return (
    <Campo label={name[0]!.toUpperCase() + name.slice(1)} error={error}>
      <select name={name} required defaultValue="">
        <option value="" disabled>Elige…</option>
        {opciones.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </Campo>
  )
}

const ENDPOINT_MOVIMIENTOS = '/api/finanzas/movimientos'
const ENDPOINT_CONFIRMAR = '/api/finanzas/recurrentes/confirmar'

/** «Nuevo movimiento» (§3.1): alta manual con MAN-NNNN asignado por el servidor. */
export function NuevoMovimientoForm({ hoy, tipoCambioDefecto }: { hoy: string; tipoCambioDefecto: string | null }) {
  const { estado, enviar, abrir, congelado } = useEnvio(ENDPOINT_MOVIMIENTOS)
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    await enviar(valores(e.currentTarget))
  }
  return (
    <details onToggle={(e: SyntheticEvent<HTMLDetailsElement>) => { if (e.currentTarget.open) abrir() }}>
      <summary className="button">Nuevo movimiento</summary>
      <form onSubmit={onSubmit} className="form" aria-label="Nuevo movimiento">
        <Lista name="proyecto" opciones={PROYECTOS} error={campo(estado, 'proyecto')} />
        <Lista name="tipo" opciones={TIPOS} error={campo(estado, 'tipo')} />
        <Lista name="categoria" opciones={CATEGORIAS} error={campo(estado, 'categoria')} />
        <CamposComunes estado={estado} hoy={hoy} />
        <CamposMonto estado={estado} tipoCambioDefecto={tipoCambioDefecto} ajuste={false} />
        <Boton estado={estado} label="Registrar movimiento" congelado={congelado} />
        <Resultado estado={estado} congelado={congelado} />
      </form>
    </details>
  )
}

/** «Ajustar» (§3.4): otro movimiento con `AJUSTE_DE`; PROYECTO, TIPO y CATEGORIA copiados del original y bloqueados. */
export function AjustarForm({ ajustables, hoy, tipoCambioDefecto }: { ajustables: AjustableOpcion[]; hoy: string; tipoCambioDefecto: string | null }) {
  const { estado, enviar, abrir, congelado } = useEnvio(ENDPOINT_MOVIMIENTOS)
  const [movId, setMovId] = useState('')
  const original = ajustables.find((a) => a.movId === movId) ?? null
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!original) return
    await enviar({ ...valores(e.currentTarget), ajusteDe: original.movId, proyecto: original.proyecto, tipo: original.tipo, categoria: original.categoria })
  }
  return (
    <details onToggle={(e: SyntheticEvent<HTMLDetailsElement>) => { if (e.currentTarget.open) abrir() }}>
      <summary className="button">Ajustar</summary>
      <form onSubmit={onSubmit} className="form" aria-label="Ajustar un movimiento">
        <p className="small">El original nunca se edita ni se borra: el ajuste es otro movimiento que lo corrige. Anular = ajuste por el monto completo en negativo.</p>
        <Campo label="Movimiento a ajustar" error={campo(estado, 'ajusteDe')}>
          <select required value={movId} onChange={(e) => setMovId(e.target.value)}>
            <option value="" disabled>Elige…</option>
            {ajustables.map((a) => <option key={a.movId} value={a.movId}>{a.movId} · {a.concepto}</option>)}
          </select>
        </Campo>
        {original ? (
          <p className="small">Proyecto <strong>{original.proyecto}</strong> · Tipo <strong>{original.tipo}</strong> · Categoría <strong>{original.categoria}</strong> (copiados del original, no editables).</p>
        ) : null}
        {original ? <p className="small">El concepto se guardará como «{prefijoAjuste(original.movId)}…».</p> : null}
        <CamposComunes estado={estado} hoy={hoy} conceptoMax={CONCEPTO_MAX - prefijoAjuste(original?.movId ?? null).length} />
        <CamposMonto estado={estado} tipoCambioDefecto={tipoCambioDefecto} ajuste />
        <Boton estado={estado} label="Registrar ajuste" congelado={congelado} />
        <Resultado estado={estado} congelado={congelado} />
      </form>
    </details>
  )
}

/** «Confirmar» un recurrente pendiente (§4.3): crea `REC-<ID>-AAAA-MM`; monto, tipo de cambio y fecha editables. */
export function ConfirmarForm({ pendiente, tipoCambioDefecto }: { pendiente: PendienteOpcion; tipoCambioDefecto: string | null }) {
  const { estado, enviar, abrir, congelado } = useEnvio(ENDPOINT_CONFIRMAR)
  const [monto, setMonto] = useState(pendiente.monto)
  const [tc, setTc] = useState(tipoCambioDefecto ?? '')
  const ultimo = `${pendiente.mes}-${String(new Date(Date.UTC(Number(pendiente.mes.slice(0, 4)), Number(pendiente.mes.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')}`
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    await enviar({ ...valores(e.currentTarget), recurrenteId: pendiente.recurrenteId, mes: pendiente.mes })
  }
  return (
    <details onToggle={(e: SyntheticEvent<HTMLDetailsElement>) => { if (e.currentTarget.open) abrir() }}>
      <summary className="button">Confirmar</summary>
      <form onSubmit={onSubmit} className="form" aria-label={`Confirmar ${pendiente.movId}`}>
        <Campo label={`Monto en ${pendiente.moneda}`} error={campo(estado, 'monto')}>
          <input name="monto" type="number" step="0.01" min="0.01" required value={monto} onChange={(e) => setMonto(e.target.value)} />
        </Campo>
        {pendiente.moneda === 'USD' ? (
          <>
            <Campo label="Tipo de cambio" error={campo(estado, 'tipoCambio')}>
              <input name="tipoCambio" type="number" step="0.0001" min="0.0001" required value={tc} onChange={(e) => setTc(e.target.value)} />
            </Campo>
            <p className="small">Monto en MXN que se registrará: <strong>{mxnDe(monto, tc) ?? '—'}</strong></p>
          </>
        ) : null}
        <Campo label="Fecha" error={campo(estado, 'fecha')}>
          <input name="fecha" type="date" required defaultValue={pendiente.fechaCobro} min={`${pendiente.mes}-01`} max={ultimo} />
        </Campo>
        <Campo label="Comprobante" error={campo(estado, 'comprobante')}>
          <select name="comprobante" defaultValue="no"><option value="sí">sí</option><option value="no">no</option></select>
        </Campo>
        <Boton estado={estado} label={`Confirmar ${pendiente.movId}`} congelado={congelado} />
        <Resultado estado={estado} congelado={congelado} />
      </form>
    </details>
  )
}
