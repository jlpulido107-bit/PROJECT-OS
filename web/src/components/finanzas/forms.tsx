'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState, type FormEvent, type ReactNode, type SyntheticEvent } from 'react'

/* --------------------------------------------------------------------------------------------
 * Formularios de escritura de /finanzas (ORD-POS-077, docs/diseno-finanzas-v2.md §3 y §4.3). Solo UI: el servidor
 * repite todas las verificaciones. Cada formulario genera su requestId al abrirse y lo reenvía en cada reintento; solo
 * se renueva tras un alta correcta (o si el servidor dice que ese requestId ya se usó con otros datos). El botón se
 * desactiva mientras se envía: doble clic, recarga o red lenta no duplican.
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

/** requestId por apertura del formulario; envío con el botón desactivado. */
function useEnvio(endpoint: string) {
  const router = useRouter()
  const [estado, setEstado] = useState<Estado>({ status: 'idle' })
  const requestId = useRef<string | null>(null)

  /** Al abrir el formulario: si no hay un requestId pendiente, se crea uno. */
  function abrir() {
    requestId.current ??= nuevoId()
  }

  async function enviar(payload: Record<string, unknown>) {
    if (estado.status === 'sending') return
    abrir()
    setEstado({ status: 'sending' })
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Project-OS-CSRF': '1' },
        body: JSON.stringify({ ...payload, requestId: requestId.current }),
        credentials: 'same-origin',
      })
      const json = (await response.json().catch(() => null)) as Exito | Fallo | null
      if (json && json.ok) {
        requestId.current = nuevoId()
        setEstado({ status: 'done', result: json })
        router.refresh()
        return
      }
      const error = json && !json.ok ? json.error : { codigo: 'error', mensaje: 'No se pudo completar la operación.' }
      if (error.codigo === 'conflicto-idempotencia') requestId.current = nuevoId()
      setEstado({ status: 'error', error })
    } catch {
      setEstado({ status: 'error', error: { codigo: 'red', mensaje: 'Sin conexión con el servidor. Puedes reintentar sin duplicar.' } })
    }
  }

  return { estado, enviar, abrir }
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

function Resultado({ estado }: { estado: Estado }) {
  if (estado.status === 'error') {
    return (
      <div className="alert alert-danger" role="alert">
        <p><strong>No se guardó.</strong> {estado.error.mensaje}</p>
        {['escritura-fallida', 'red', 'verificacion-fallida'].includes(estado.error.codigo)
          ? <p className="small">Al reintentar se reutiliza la misma solicitud: no se duplicará.</p> : null}
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

function Boton({ estado, label }: { estado: Estado; label: string }) {
  const sending = estado.status === 'sending'
  return <button type="submit" className="button button-primary" disabled={sending} aria-busy={sending}>{sending ? 'Guardando…' : label}</button>
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

function CamposComunes({ estado, hoy }: { estado: Estado; hoy: string }) {
  return (
    <>
      <Campo label="Fecha" error={campo(estado, 'fecha')}><input name="fecha" type="date" required defaultValue={hoy} /></Campo>
      <Campo label="Concepto" error={campo(estado, 'concepto')}>
        <input name="concepto" required minLength={3} maxLength={80} placeholder="Sin datos personales ni bancarios" />
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
  const { estado, enviar, abrir } = useEnvio(ENDPOINT_MOVIMIENTOS)
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
        <Boton estado={estado} label="Registrar movimiento" />
        <Resultado estado={estado} />
      </form>
    </details>
  )
}

/** «Ajustar» (§3.4): otro movimiento con `AJUSTE_DE`; PROYECTO, TIPO y CATEGORIA copiados del original y bloqueados. */
export function AjustarForm({ ajustables, hoy, tipoCambioDefecto }: { ajustables: AjustableOpcion[]; hoy: string; tipoCambioDefecto: string | null }) {
  const { estado, enviar, abrir } = useEnvio(ENDPOINT_MOVIMIENTOS)
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
        <CamposComunes estado={estado} hoy={hoy} />
        <CamposMonto estado={estado} tipoCambioDefecto={tipoCambioDefecto} ajuste />
        <Boton estado={estado} label="Registrar ajuste" />
        <Resultado estado={estado} />
      </form>
    </details>
  )
}

/** «Confirmar» un recurrente pendiente (§4.3): crea `REC-<ID>-AAAA-MM`; monto, tipo de cambio y fecha editables. */
export function ConfirmarForm({ pendiente, tipoCambioDefecto }: { pendiente: PendienteOpcion; tipoCambioDefecto: string | null }) {
  const { estado, enviar, abrir } = useEnvio(ENDPOINT_CONFIRMAR)
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
        <Boton estado={estado} label={`Confirmar ${pendiente.movId}`} />
        <Resultado estado={estado} />
      </form>
    </details>
  )
}
