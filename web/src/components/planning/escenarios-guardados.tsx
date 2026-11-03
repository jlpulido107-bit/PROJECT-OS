'use client'

import { useId, useState, type FormEvent } from 'react'
import { EstadoGuardado } from '@/components/operations/estado-guardado'
import { useOperation } from '@/components/operations/forms'
import { estadoGuardado, type EdicionSemana } from '@/lib/planificacion-edicion'
import { avisoAlCargar, cuerpoEscenario, type EscenarioCargable } from '@/lib/planificacion-escenarios'
import type { Scenario } from '@/lib/planning/types'
import styles from './planning.module.css'

/**
 * Panel «Escenarios guardados» de /planificacion (ORD-POS-141, DEC-POS-029 d). Cargar re-simula en el navegador con los
 * parámetros guardados y avisa si la huella de los datos cambió desde que se guardó; no escribe nada. Guardar (alta en
 * ESCENARIOS) y Archivar (ESTADO ARCHIVADO con versión esperada) solo para la sesión del propietario con
 * PLANIFICACION_EDICION_PROPIETARIO y la migración de §11.2. Guardar un escenario nunca cambia el plan.
 */
export function EscenariosGuardados({ guardados, edicion, escenario, semanaId, huellaActual, onCargar }: {
  guardados: EscenarioCargable[]
  edicion: EdicionSemana
  /** Escenario activo de la simulación (el que se guarda). */
  escenario: Scenario
  /** Semana ISO de la propuesta que se ve (SEMANA_ID del escenario guardado). */
  semanaId: string
  huellaActual: string
  onCargar: (escenario: Scenario) => void
}) {
  const escenarios = edicion.encendida ? edicion.escenarios : undefined
  const puedeEscribir = escenarios?.migrada === true
  const [cargado, setCargado] = useState<{ id: string; nombre: string; aviso: string | null } | null>(null)

  function cargar(g: EscenarioCargable) {
    if (!g.escenario) return
    onCargar(g.escenario)
    setCargado({ id: g.id, nombre: g.nombre, aviso: avisoAlCargar(g, huellaActual) })
  }

  return (
    <div className={`card ${styles.capacidadPanel}`} aria-labelledby="escenarios-guardados-titulo">
      <h3 id="escenarios-guardados-titulo">Escenarios guardados</h3>
      <div aria-live="polite" data-escenario-cargado={cargado?.id ?? ''}>
        {cargado ? (
          <p className={`small ${cargado.aviso ? 'alert alert-warn' : 'alert alert-info'}`} role={cargado.aviso ? 'alert' : 'status'}>
            Cargado «{cargado.nombre}» (<span className="mono">{cargado.id}</span>): la propuesta se re-simuló en esta pestaña.
            {cargado.aviso ? <> <strong>{cargado.aviso}.</strong> La propuesta usa los datos de ahora.</> : null}
          </p>
        ) : null}
      </div>
      {!edicion.encendida ? <p className="small muted" data-edicion="apagada">Edición apagada: puedes cargar, no guardar ni archivar.</p>
        : !puedeEscribir ? <p className="alert alert-warn small" data-edicion="bloqueada">Falta la migración: la hoja aún no tiene la pestaña ESCENARIOS (la crea el propietario, docs/escritura-v1-8.md §11.2).</p>
          : <Guardar escenario={escenario} semanaId={semanaId} huella={huellaActual} />}
      {guardados.length === 0 ? <p className="small muted">Sin escenarios guardados.</p> : (
        <ul className={styles.escenarioLista}>
          {guardados.map((g) => (
            <li key={g.id} data-escenario={g.id}>
              <span><strong>{g.nombre}</strong> · <span className="mono">{g.id}</span>{g.semanaId ? <> · semana <span className="mono">{g.semanaId}</span></> : null}{g.creadoEn ? <> · {g.creadoEn}</> : null}</span>
              {g.problema ? <span className="small field-error">No se puede cargar: {g.problema}.</span> : null}
              <span className="form-actions">
                <button type="button" className="button" onClick={() => cargar(g)} disabled={!g.escenario}>Cargar</button>
                {puedeEscribir ? <Archivar guardado={g} /> : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Guardar({ escenario, semanaId, huella }: { escenario: Scenario; semanaId: string; huella: string }) {
  const op = useOperation('/api/operaciones/escenarios', 'POST')
  const id = useId()
  const [nombre, setNombre] = useState('')
  const [error, setError] = useState<string | null>(null)
  const estado = estadoGuardado(op.state)
  const enviando = op.state.status === 'sending'
  const errorNombre = error ?? (estado.tipo === 'error' ? estado.campos.nombre : undefined)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const cuerpo = cuerpoEscenario(nombre, semanaId, escenario, huella)
    if ('error' in cuerpo) {
      setError(cuerpo.error)
      return
    }
    setError(null)
    // Tras guardar, useOperation recarga la vista: la lista trae el escenario nuevo y la simulación sigue igual.
    if (await op.submit({ ...cuerpo })) setNombre('')
  }

  return (
    <>
      <form className={styles.capacidadForm} onSubmit={(e) => void onSubmit(e)} noValidate aria-label="Guardar el escenario actual">
        <div className="field">
          <label htmlFor={`${id}-nombre`}>Nombre del escenario</label>
          <input
            id={`${id}-nombre`} name="nombre" value={nombre} maxLength={80} disabled={enviando}
            onChange={(e) => setNombre(e.target.value)}
            {...(errorNombre ? { 'aria-invalid': true as const, 'aria-describedby': `${id}-nombre-error` } : { 'aria-describedby': `${id}-nombre-hint` })}
          />
          {errorNombre ? <span id={`${id}-nombre-error`} className="field-error">{errorNombre}</span>
            : <span id={`${id}-nombre-hint`} className="field-hint">Guarda los parámetros y movimientos de la simulación; no cambia el plan.</span>}
        </div>
        <div className="form-actions">
          <button type="submit" className="button button-primary" disabled={enviando} aria-busy={enviando}>
            {enviando ? 'Guardando…' : 'Guardar escenario'}
          </button>
          <span className="mono small">semana {semanaId}</span>
        </div>
      </form>
      <EstadoGuardado estado={estado} registro="los escenarios" />
    </>
  )
}

function Archivar({ guardado }: { guardado: EscenarioCargable }) {
  const op = useOperation('/api/operaciones/escenarios/archivar', 'POST')
  const estado = estadoGuardado(op.state)
  const enviando = op.state.status === 'sending'
  if (guardado.version === null) return <span className="small muted">Sin VERSION: escribe 1 en la hoja para archivarlo.</span>
  return (
    <>
      <button
        type="button" className="button" disabled={enviando} aria-busy={enviando}
        onClick={() => void op.submit({ escenarioId: guardado.id, expectedVersion: guardado.version })}
      >
        {enviando ? 'Archivando…' : 'Archivar'}
      </button>
      <EstadoGuardado estado={estado} registro="el escenario" />
    </>
  )
}
