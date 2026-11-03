'use client'

import { useRouter } from 'next/navigation'
import { useId, useState, type FormEvent } from 'react'
import { Badge } from '@/components/ui'
import { EstadoGuardado } from '@/components/operations/estado-guardado'
import { useOperation } from '@/components/operations/forms'
import { fechaCorta } from '@/lib/planificacion-semana'
import {
  actualCargado, CAMPOS_EDICION, cuerpoEdicion, errorDeCampo, estadoGuardado, ETIQUETA_CAMPO,
  type EdicionSemana, type OpcionHito, type TarjetaSemana as Tarjeta, type ValoresEdicion,
} from '@/lib/planificacion-edicion'
import styles from './planning.module.css'

/**
 * Tarjeta de tarea de la capa Semana (ORD-POS-136, DEC-POS-029 b): muestra FECHA_PLAN, HORAS_ESTIMADAS e HITO_ID y, solo
 * para la sesión del propietario con PLANIFICACION_EDICION_PROPIETARIO encendida, los edita en línea con
 * PATCH /api/operaciones/tareas/{id} y la versión esperada. El servidor vuelve a verificar todo.
 */

const horasTexto = (h: string) => (h === '' ? 'Sin estimación' : `${h} h`)
const fechaTexto = (f: string) => (f === '' ? 'Sin fecha plan' : `No antes de ${fechaCorta(f)}`)

function Resumen({ v, hitos }: { v: ValoresEdicion; hitos: OpcionHito[] }) {
  const hito = v.hitoId === '' ? 'Sin hito' : hitos.find((h) => h.value === v.hitoId)?.label ?? v.hitoId
  return <>{fechaTexto(v.fechaPlan)} · {horasTexto(v.horasEstimadas)} · {hito}</>
}

export function TarjetaSemana({ tarea, edicion }: { tarea: Tarjeta; edicion: EdicionSemana }) {
  const version = edicion.encendida ? edicion.versiones[tarea.id] : undefined
  const hitos = edicion.encendida && tarea.proyectoId ? edicion.hitosPorProyecto[tarea.proyectoId] ?? [] : []
  return (
    <li className={`card ${styles.tarjetaSemana}`} aria-labelledby={`tarjeta-${tarea.id}`}>
      <p id={`tarjeta-${tarea.id}`} className={styles.tarjetaTitulo}>{tarea.titulo ?? 'Sin título'}</p>
      <p className="mono small">{tarea.id}{tarea.proyectoId ? ` · ${tarea.proyectoId}` : ''}</p>
      <p className="badges">
        <Badge tone={tarea.valores.horasEstimadas === '' ? 'warn' : 'neutral'}>{horasTexto(tarea.valores.horasEstimadas)}</Badge>
        <Badge tone="neutral">{fechaTexto(tarea.valores.fechaPlan)}</Badge>
        <Badge tone="muted">{tarea.valores.hitoId === '' ? 'Sin hito' : tarea.valores.hitoId}</Badge>
      </p>
      {edicion.encendida && version !== undefined
        ? <Editor tarea={tarea} version={version} hitos={hitos} />
        : <p className="small muted" data-edicion="apagada">Edición apagada</p>}
    </li>
  )
}

function Editor({ tarea, version, hitos }: { tarea: Tarjeta; version: number; hitos: OpcionHito[] }) {
  const op = useOperation(`/api/operaciones/tareas/${encodeURIComponent(tarea.id)}`, 'PATCH')
  const router = useRouter()
  const id = useId()
  const [abierto, setAbierto] = useState(false)
  const [valores, setValores] = useState<ValoresEdicion>(tarea.valores)
  const [sinCambios, setSinCambios] = useState(false)
  const estado = estadoGuardado(op.state)
  const opciones = tarea.valores.hitoId && !hitos.some((h) => h.value === tarea.valores.hitoId)
    ? [{ value: tarea.valores.hitoId, label: tarea.valores.hitoId }, ...hitos] : hitos

  async function guardar() {
    // Contra el valor y la versión que trae la vista ahora (tras un conflicto, los ya recargados).
    const cuerpo = cuerpoEdicion(version, tarea.valores, valores)
    setSinCambios(cuerpo === null)
    if (!cuerpo) return
    const hecho = await op.submit(cuerpo)
    if (hecho) setAbierto(false) // useOperation ya llamó a router.refresh(): la vista se recalcula con lo guardado.
    else router.refresh() // Conflicto o error: se recarga el valor actual; lo escrito se conserva en el estado.
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void guardar()
  }

  function abrir() {
    op.reset()
    setSinCambios(false)
    setValores(tarea.valores)
    setAbierto(true)
  }

  function usarActual() {
    op.reset()
    setValores(tarea.valores)
  }

  const enviando = op.state.status === 'sending'
  return (
    <>
      {abierto ? (
        <form className={styles.tarjetaEditor} onSubmit={onSubmit} noValidate aria-label={`Editar ${tarea.id}`}>
          {CAMPOS_EDICION.map((campo) => {
            const error = errorDeCampo(estado, campo)
            const campoId = `${id}-${campo}`
            const props = {
              id: campoId,
              name: campo,
              value: valores[campo],
              disabled: enviando,
              ...(error ? { 'aria-invalid': true as const, 'aria-describedby': `${campoId}-error` } : {}),
              ...(campo === 'horasEstimadas' && !error ? { 'aria-describedby': `${campoId}-hint` } : {}),
              onChange: (e: { target: { value: string } }) => setValores({ ...valores, [campo]: e.target.value }),
            }
            return (
              <div key={campo} className="field">
                <label htmlFor={campoId}>{ETIQUETA_CAMPO[campo]}</label>
                {campo === 'fechaPlan' ? <input {...props} type="date" /> : null}
                {campo === 'horasEstimadas' ? <input {...props} inputMode="decimal" maxLength={7} placeholder="vacío" /> : null}
                {campo === 'hitoId' ? (
                  <select {...props}>
                    <option value="">Sin hito</option>
                    {opciones.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
                  </select>
                ) : null}
                {campo === 'horasEstimadas' ? <span id={`${campoId}-hint`} className="field-hint">Vacío = sin estimación (no es 0)</span> : null}
                {error ? <span id={`${campoId}-error`} className="field-error">{error}</span> : null}
              </div>
            )
          })}
          <div className="form-actions">
            <button type="submit" className="button button-primary" disabled={enviando} aria-busy={enviando}>
              {enviando ? 'Guardando…' : 'Guardar'}
            </button>
            <button type="button" className="button button-ghost" onClick={() => { op.reset(); setAbierto(false) }} disabled={enviando}>Cerrar</button>
            <span className="mono small">versión {version}</span>
          </div>
          {sinCambios ? <p className="small muted" role="status">Sin cambios que guardar.</p> : null}
        </form>
      ) : (
        <div className="form-actions">
          <button type="button" className="button" onClick={abrir} aria-label={`Editar fecha plan, horas e hito de ${tarea.id}`}>Editar</button>
        </div>
      )}
      <EstadoGuardado
        estado={estado}
        actual={<Resumen v={tarea.valores} hitos={opciones} />}
        tuyo={<Resumen v={valores} hitos={opciones} />}
      >
        <div className="form-actions">
          <button type="button" className="button" onClick={usarActual}>Usar el actual</button>
          <button type="button" className="button" onClick={() => void guardar()} disabled={!actualCargado(estado, version) || enviando}>
            {actualCargado(estado, version) ? 'Guardar el mío sobre el actual' : 'Cargando el valor actual…'}
          </button>
        </div>
      </EstadoGuardado>
    </>
  )
}
