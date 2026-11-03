'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import { enviarOperacion } from '@/components/operations/forms'
import { fechaCorta, minutosTexto } from '@/lib/planificacion-semana'
import {
  bloqueoPlanDia, diasParaAplicar, REINTENTO_MISMA_SOLICITUD, resultadoDia, textoItemActual,
  type CuerpoPlanDia, type DiaParaAplicar, type EdicionPlanDia, type ElementoPlanDia, type ResultadoDia,
} from '@/lib/planificacion-plan-dia'
import type { PlanningInput, PlanResult } from '@/lib/planning/types'
import styles from './planning.module.css'

/**
 * «Aplicar movimientos al plan» (ORD-POS-140, DEC-POS-029): convierte los bloques movidos de la simulación en el plan
 * registrado de cada día (PLAN_DIARIO y PLAN_ITEMS) con una llamada a POST /api/operaciones/plan-dia por día. Primero
 * muestra la lista de lo que se escribirá por día y nada se escribe sin «Confirmar y guardar». Un conflicto de versión
 * en un día no detiene los demás: se informa día por día, con el plan actual. Solo para la sesión del propietario con
 * PLANIFICACION_EDICION_PROPIETARIO; el servidor repite todas las comprobaciones.
 */

function Elemento({ e }: { e: ElementoPlanDia }) {
  return (
    <li>
      <span className="mono">{e.tareaId}</span>{e.titulo ? ` · ${e.titulo}` : ''} ·{' '}
      {e.minutosAntes === null
        ? <>nuevo en el plan, {minutosTexto(e.minutosPlan)}</>
        : <>{minutosTexto(e.minutosAntes)} → {minutosTexto(e.minutosPlan)} (+{minutosTexto(e.minutosMovidos)})</>}
      {' '}· orden {e.orden || '—'}
    </li>
  )
}

function Dia({ dia }: { dia: DiaParaAplicar }) {
  return (
    <li data-dia={dia.fecha} data-tipo={dia.tipo}>
      <strong>{fechaCorta(dia.fecha)}</strong>{' '}
      {dia.tipo === 'listo'
        ? dia.nuevo
          ? <>· plan nuevo <span className="mono">{dia.planId}</span> (versión 1)</>
          : <>· plan <span className="mono">{dia.planId}</span>, versión {dia.version} → {dia.version! + 1}</>
        : <>· <span className="alert-warn">no se guardará: {dia.motivo}</span></>}
      <ul>{dia.elementos.map((e) => <Elemento key={e.tareaId} e={e} />)}</ul>
    </li>
  )
}

function Resultado({ r }: { r: ResultadoDia }) {
  if (r.tipo === 'guardado') {
    return <li data-resultado="guardado"><strong>{fechaCorta(r.fecha)}</strong>: {r.repetida ? 'ya estaba guardado' : 'guardado'} en <span className="mono">{r.planId}</span>{r.version !== null ? `, versión ${r.version}` : ''}. Queda en AUDITORIA.</li>
  }
  if (r.tipo === 'conflicto') {
    return (
      <li data-resultado="conflicto">
        <strong>{fechaCorta(r.fecha)}</strong>: conflicto de versión, no se guardó. {r.mensaje}
        {r.planActual ? (
          <> Plan actual <span className="mono">{r.planActual.planId}</span>{r.planActual.version !== null ? `, versión ${r.planActual.version}` : ''}:{' '}
            {r.planActual.items.length ? r.planActual.items.map(textoItemActual).join('; ') : 'sin elementos'}.</>
        ) : null}
        {' '}La vista se recargó: revisa la lista y vuelve a aplicar si quieres.
      </li>
    )
  }
  return <li data-resultado="error"><strong>{fechaCorta(r.fecha)}</strong>: no se guardó. {r.mensaje}</li>
}

export function AplicarPlan({ plan, input, edicion, onGuardados }: {
  plan: PlanResult
  input: PlanningInput
  edicion: EdicionPlanDia
  /** Tras guardar: los resultados por día, para quitar de la simulación los movimientos ya registrados. */
  onGuardados: (resultados: ResultadoDia[]) => void
}) {
  const router = useRouter()
  const [confirmando, setConfirmando] = useState(false)
  const [enviando, setEnviando] = useState(false)
  const [resultados, setResultados] = useState<ResultadoDia[] | null>(null)
  /** Último envío de cada día: reintentar el mismo cuerpo tras un fallo de escritura o de red reutiliza su requestId. */
  const ultimos = useRef(new Map<string, { cuerpo: string; requestId: string; codigo?: string }>())

  const bloqueo = bloqueoPlanDia(input, edicion)
  const dias = bloqueo ? [] : diasParaAplicar(plan, input, edicion)
  const listos = dias.filter((d): d is Extract<DiaParaAplicar, { tipo: 'listo' }> => d.tipo === 'listo')

  async function enviar(cuerpo: CuerpoPlanDia): Promise<ResultadoDia> {
    const serializado = JSON.stringify(cuerpo)
    const previo = ultimos.current.get(cuerpo.fecha)
    const requestId = previo && previo.cuerpo === serializado && REINTENTO_MISMA_SOLICITUD.has(previo.codigo ?? '') ? previo.requestId : crypto.randomUUID()
    const intento: { cuerpo: string; requestId: string; codigo?: string } = { cuerpo: serializado, requestId }
    ultimos.current.set(cuerpo.fecha, intento)
    try {
      const r = resultadoDia(cuerpo.fecha, await enviarOperacion('/api/operaciones/plan-dia', 'POST', { ...cuerpo }, requestId))
      if (r.tipo === 'error') intento.codigo = r.codigo
      else if (r.tipo === 'guardado') ultimos.current.delete(cuerpo.fecha)
      return r
    } catch {
      intento.codigo = 'red'
      return { tipo: 'error', fecha: cuerpo.fecha, codigo: 'red', mensaje: 'Sin conexión con el servidor. Puedes reintentar sin duplicar.' }
    }
  }

  async function confirmar() {
    setEnviando(true)
    const hechos: ResultadoDia[] = []
    // Una llamada por día, en orden; un conflicto o un error en un día no detiene los demás.
    for (const d of listos) hechos.push(await enviar(d.cuerpo))
    setResultados(hechos)
    setEnviando(false)
    setConfirmando(false)
    onGuardados(hechos)
    router.refresh() // El plan registrado (o el actual, tras un conflicto) llega con la vista recargada.
  }

  if (bloqueo) return <p className="alert alert-warn small" data-aplicar="bloqueado">{bloqueo}</p>
  return (
    <div className={styles.aplicarPlan} data-aplicar={confirmando ? 'confirmando' : 'listo'}>
      {!confirmando ? (
        <button type="button" className="button button-primary" onClick={() => { setResultados(null); setConfirmando(true) }} disabled={dias.length === 0}>
          Aplicar movimientos al plan…
        </button>
      ) : (
        <div className="card" role="region" aria-labelledby="aplicar-plan-titulo">
          <h4 id="aplicar-plan-titulo">Se escribirá en PLAN_DIARIO y PLAN_ITEMS</h4>
          <p className="small">
            Solo los bloques movidos, sumados a lo que cada tarea ya tenga en el plan de ese día. No se quita ni se borra
            nada, TAREAS no cambia (ni FECHA_PLAN ni ESTADO) y cada día queda en AUDITORIA.
          </p>
          <ul className={styles.aplicarDias}>{dias.map((d) => <Dia key={d.fecha} dia={d} />)}</ul>
          <div className="form-actions">
            <button type="button" className="button button-primary" onClick={() => void confirmar()} disabled={enviando || listos.length === 0} aria-busy={enviando}>
              {enviando ? 'Guardando…' : `Confirmar y guardar ${listos.length === 1 ? '1 día' : `${listos.length} días`}`}
            </button>
            <button type="button" className="button" onClick={() => setConfirmando(false)} disabled={enviando}>Cancelar</button>
          </div>
        </div>
      )}
      <div aria-live="polite">
        {resultados ? (
          <ul className={`small ${styles.aplicarDias}`} role={resultados.some((r) => r.tipo !== 'guardado') ? 'alert' : 'status'}>
            {resultados.map((r) => <Resultado key={r.fecha} r={r} />)}
          </ul>
        ) : null}
      </div>
    </div>
  )
}
