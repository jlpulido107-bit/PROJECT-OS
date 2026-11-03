'use client'

import { useRouter } from 'next/navigation'
import { useId, useState, type FormEvent } from 'react'
import { EstadoGuardado } from '@/components/operations/estado-guardado'
import { useOperation } from '@/components/operations/forms'
import {
  bloqueoCapacidad, CAMPOS_CAPACIDAD, cuerpoCapacidad, ESTADOS_CAPACIDAD, ETIQUETA_CAPACIDAD, textoCapacidad,
  type CampoCapacidad, type ObjetivoCapacidad, type ValoresCapacidad,
} from '@/lib/planificacion-capacidad'
import { actualCargado, estadoGuardado, type EdicionSemana, type EnvioOperacion, type EstadoGuardado as Estado } from '@/lib/planificacion-edicion'
import styles from './planning.module.css'

/**
 * Panel «Capacidad de la semana» (ORD-POS-139, DEC-POS-029 c): muestra HORAS_DISPONIBLES, RESERVA_PCT y ESTADO de la fila
 * de CAPACIDAD_SEMANAL de la semana de la vista y, solo para la sesión del propietario con
 * PLANIFICACION_EDICION_PROPIETARIO encendida, los guarda con POST /api/operaciones/capacidad (alta o edición con la
 * versión esperada). Tras guardar, la vista se recarga y las barras de la semana se recalculan. El servidor repite todo.
 */

function Resumen({ v }: { v: ValoresCapacidad }) {
  return <>{CAMPOS_CAPACIDAD.map((c) => `${ETIQUETA_CAPACIDAD[c]}: ${textoCapacidad(c, v[c])}`).join(' · ')}</>
}

/** Un alta que choca con la de otra pestaña (409 conflicto-concurrente) se trata como conflicto: se recarga y se elige. */
function estadoCapacidad(envio: EnvioOperacion): Estado {
  if (envio.status === 'error' && envio.error.codigo === 'conflicto-concurrente') return { tipo: 'conflicto', versionActual: null, mensaje: envio.error.mensaje }
  return estadoGuardado(envio)
}

const errorDeCampo = (estado: Estado, campo: CampoCapacidad): string | undefined => (estado.tipo === 'error' ? estado.campos[campo] : undefined)

export function CapacidadSemana({ objetivo, edicion }: { objetivo: ObjetivoCapacidad; edicion: EdicionSemana }) {
  const capacidad = edicion.encendida ? edicion.capacidad : undefined
  const bloqueo = capacidad ? bloqueoCapacidad(objetivo, capacidad) : null
  return (
    <div className={`card ${styles.capacidadPanel}`} aria-labelledby="capacidad-semana-titulo">
      <h3 id="capacidad-semana-titulo">Capacidad de la semana</h3>
      {objetivo.tipo === 'ambigua' ? null : (
        <p className="small" data-capacidad="valores">
          {objetivo.tipo === 'nueva'
            ? <>Sin capacidad registrada para esta semana (no hay fila <span className="mono">{objetivo.semanaId}</span> en CAPACIDAD_SEMANAL).</>
            : <><span className="mono">{objetivo.semanaId}</span> · <Resumen v={objetivo.valores} /></>}
        </p>
      )}
      {!capacidad ? <p className="small muted" data-edicion="apagada">Edición apagada</p>
        : bloqueo ? <p className="alert alert-warn small" data-edicion="bloqueada">{bloqueo}</p>
          : objetivo.tipo !== 'ambigua'
            ? <Editor objetivo={objetivo} version={objetivo.tipo === 'existente' ? capacidad.versiones[objetivo.semanaId] ?? null : null} />
            : null}
    </div>
  )
}

function Editor({ objetivo, version }: { objetivo: Exclude<ObjetivoCapacidad, { tipo: 'ambigua' }>; version: number | null }) {
  const op = useOperation('/api/operaciones/capacidad', 'POST')
  const router = useRouter()
  const id = useId()
  const [valores, setValores] = useState<ValoresCapacidad>(objetivo.valores)
  const [sinCambios, setSinCambios] = useState(false)
  const estado = estadoCapacidad(op.state)
  // «Guardar el mío» solo con el valor actual ya recargado: tras un alta que chocó, cuando la vista ya trae la fila.
  const choqueDeAlta = op.state.status === 'error' && op.state.error.codigo === 'conflicto-concurrente'
  const listo = choqueDeAlta ? objetivo.tipo === 'existente' : actualCargado(estado, version ?? 0)

  async function guardar() {
    // Contra la fila y la versión que trae la vista ahora (tras un conflicto, las ya recargadas).
    const cuerpo = cuerpoCapacidad(objetivo, version, valores)
    setSinCambios(cuerpo === null)
    if (!cuerpo) return
    const hecho = await op.submit(cuerpo)
    if (!hecho) router.refresh() // Conflicto o error: se recarga el valor actual; lo escrito se conserva en el estado.
    // Si guardó, useOperation ya llamó a router.refresh(): las barras de la semana se recalculan con lo guardado.
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void guardar()
  }

  function usarActual() {
    op.reset()
    setValores(objetivo.valores)
  }

  const enviando = op.state.status === 'sending'
  const estados = valores.estado && !(ESTADOS_CAPACIDAD as readonly string[]).includes(valores.estado) ? [valores.estado, ...ESTADOS_CAPACIDAD] : ESTADOS_CAPACIDAD
  return (
    <>
      <form className={styles.capacidadForm} onSubmit={onSubmit} noValidate aria-label={`Capacidad de la semana ${objetivo.semanaId}`}>
        {CAMPOS_CAPACIDAD.map((campo) => {
          const error = errorDeCampo(estado, campo)
          const campoId = `${id}-${campo}`
          const props = {
            id: campoId,
            name: campo,
            value: valores[campo],
            disabled: enviando,
            ...(error ? { 'aria-invalid': true as const, 'aria-describedby': `${campoId}-error` } : campo !== 'estado' ? { 'aria-describedby': `${campoId}-hint` } : {}),
            onChange: (e: { target: { value: string } }) => setValores({ ...valores, [campo]: e.target.value }),
          }
          return (
            <div key={campo} className="field">
              <label htmlFor={campoId}>{ETIQUETA_CAPACIDAD[campo]}</label>
              {campo === 'horasDisponibles' ? <input {...props} type="number" inputMode="decimal" min={0} max={168} step={0.25} placeholder="vacío" /> : null}
              {campo === 'reservaPct' ? <input {...props} type="number" inputMode="decimal" min={0} max={100} step={1} placeholder="vacío" /> : null}
              {campo === 'estado' ? (
                <select {...props}>
                  <option value="">Sin estado</option>
                  {estados.map((e) => <option key={e} value={e}>{e}</option>)}
                </select>
              ) : null}
              {campo === 'horasDisponibles' && !error ? <span id={`${campoId}-hint`} className="field-hint">0 a 168. Vacío = sin capacidad registrada (no es 0)</span> : null}
              {campo === 'reservaPct' && !error ? <span id={`${campoId}-hint`} className="field-hint">0 a 100. Vacío = sin reserva registrada (no es 0)</span> : null}
              {error ? <span id={`${campoId}-error`} className="field-error">{error}</span> : null}
            </div>
          )
        })}
        <div className="form-actions">
          <button type="submit" className="button button-primary" disabled={enviando} aria-busy={enviando}>
            {enviando ? 'Guardando…' : 'Guardar capacidad'}
          </button>
          <span className="mono small">{version === null ? `fila nueva ${objetivo.semanaId}` : `versión ${version}`}</span>
        </div>
        {sinCambios ? <p className="small muted" role="status">Sin cambios que guardar.</p> : null}
      </form>
      <EstadoGuardado estado={estado} registro="la capacidad de la semana" actual={objetivo.tipo === 'existente' ? <Resumen v={objetivo.valores} /> : 'sin fila registrada'} tuyo={<Resumen v={valores} />}>
        <div className="form-actions">
          <button type="button" className="button" onClick={usarActual}>Usar el actual</button>
          <button type="button" className="button" onClick={() => void guardar()} disabled={!listo || enviando}>
            {listo ? 'Guardar el mío sobre el actual' : 'Cargando el valor actual…'}
          </button>
        </div>
      </EstadoGuardado>
    </>
  )
}
