import { Empty, Section } from '@/components/ui'
import type { ObjetivoCapacidad } from '@/lib/planificacion-capacidad'
import type { EdicionSemana, TarjetaSemana as Tarjeta } from '@/lib/planificacion-edicion'
import type { HitoSemana } from '@/lib/planificacion-semana-hitos'
import { fechaCorta, minutosTexto, textoDia, textoDias, type Bloque, type DiasSemana } from '@/lib/planificacion-semana'
import styles from './planning.module.css'
import { CapacidadSemana } from './capacidad-semana'
import { TarjetaSemana } from './tarjeta-semana'

/**
 * Capa Semana (ORD-POS-121, docs/diseno-planificacion-v2.md §5): horas planeadas contra disponibles y reales por día, e
 * hitos con días restantes y avance. Solo lectura. Barras en CSS sin color de «bien» o «mal»; cada gráfica lleva su tabla
 * accesible y el exceso de capacidad se dice con texto. Las tarjetas de tareas (ORD-POS-136) editan FECHA_PLAN,
 * HORAS_ESTIMADAS e HITO_ID solo para el propietario con PLANIFICACION_EDICION_PROPIETARIO; si no, «Edición apagada». El
 * panel «Capacidad de la semana» (ORD-POS-139) registra la fila de CAPACIDAD_SEMANAL con la misma bandera.
 */

const pct = (parte: number, total: number) => (total <= 0 ? 0 : Math.min(100, Math.round((parte / total) * 100)))

function SinDatos({ motivo }: { motivo: string }) {
  return <p className="alert alert-warn" data-estado="sin-datos">Sin datos: {motivo}</p>
}

function Dias({ semana }: { semana: DiasSemana }) {
  const disponibles = semana.horasDisponibles === null ? 'sin capacidad registrada' : `${minutosTexto(Math.round(semana.horasDisponibles * 60))}`
  // RESERVA_PCT vacía: el motor no descuenta reserva; se dice con palabras, nunca «0 %» (ORD-POS-139).
  const reserva = semana.reservaRegistrada === false ? ' (sin reserva registrada)' : semana.reservaPct === null ? '' : ` (reserva ${semana.reservaPct} %)`
  return (
    <>
      <p>
        Semana <span className="mono">{semana.semanaIso}</span> · {fechaCorta(semana.lunes)} – {fechaCorta(semana.domingo)} ·
        {' '}Disponibles {disponibles}{reserva}{semana.netaMin === null ? '' : ` · netas ${minutosTexto(semana.netaMin)}`}
        {' '}· planeadas {minutosTexto(semana.planeadoMin)}
      </p>
      {semana.origen === 'supuesto' ? (
        <p className={styles.supuesto} data-origen="supuesto">
          <strong>Capacidad supuesta</strong> por el escenario (supuesto, no es un dato registrado en CAPACIDAD_SEMANAL).
        </p>
      ) : (
        <p className="muted small" data-origen="dato">
          Capacidad registrada en CAPACIDAD_SEMANAL{semana.semanaId ? <> (<span className="mono">{semana.semanaId}</span>)</> : null}.
        </p>
      )}
      <ul className={styles.semanaBarras} aria-hidden="true">
        {semana.dias.map((d) => (
          <li key={d.fecha} className={styles.semanaDia} data-hoy={d.esHoy || undefined}>
            <span className={styles.semanaFecha}>{fechaCorta(d.fecha)}</span>
            {d.laborable && d.disponibleMin !== null ? (
              <span className={styles.semanaPista}><span className={styles.semanaRelleno} style={{ width: `${pct(d.planeadoMin, d.disponibleMin)}%` }} /></span>
            ) : <span className={styles.semanaPista} data-vacia />}
            <span className="small">{textoDia(d)}{d.esHoy ? ' ← hoy' : ''}</span>
          </li>
        ))}
      </ul>
      <table className="visually-hidden">
        <caption>Horas por día de la semana {semana.semanaIso}</caption>
        <thead><tr><th scope="col">Día</th><th scope="col">Planeadas</th><th scope="col">Disponibles</th><th scope="col">Real</th><th scope="col">Por encima</th></tr></thead>
        <tbody>
          {semana.dias.map((d) => (
            <tr key={d.fecha}>
              <th scope="row">{fechaCorta(d.fecha)}{d.esHoy ? ' (hoy)' : ''}</th>
              <td>{d.laborable ? minutosTexto(d.planeadoMin) : 'no laborable'}</td>
              <td>{d.disponibleMin === null ? '—' : minutosTexto(d.disponibleMin)}</td>
              <td>{d.realMin === null ? '—' : minutosTexto(d.realMin)}</td>
              <td>{d.excesoMin === null ? 'no' : `${minutosTexto(d.excesoMin)} por encima de la capacidad`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

function Hitos({ hitos }: { hitos: HitoSemana[] }) {
  if (hitos.length === 0) return <Empty>No hay hitos abiertos.</Empty>
  return (
    <>
      <ul className={styles.semanaHitos} aria-hidden="true">
        {hitos.map((h) => (
          <li key={h.id}>
            <span>{h.texto}</span>
            <span className="small">{textoDias(h.dias)}{h.fecha ? ` (${fechaCorta(h.fecha)})` : ''}</span>
            {h.total > 0 ? <span className={styles.semanaPista}><span className={styles.semanaRelleno} style={{ width: `${pct(h.completadas, h.total)}%` }} /></span> : <span className={styles.semanaPista} data-vacia />}
            <span className="small">{h.avance}</span>
          </li>
        ))}
      </ul>
      <table className="visually-hidden">
        <caption>Hitos abiertos con días restantes y avance</caption>
        <thead><tr><th scope="col">Hito</th><th scope="col">Fecha objetivo</th><th scope="col">Días</th><th scope="col">Avance</th></tr></thead>
        <tbody>
          {hitos.map((h) => (
            <tr key={h.id}>
              <th scope="row">{h.texto}</th>
              <td>{h.fecha ? fechaCorta(h.fecha) : '—'}</td>
              <td>{textoDias(h.dias)}</td>
              <td>{h.avance}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

function Tarjetas({ tarjetas, edicion }: { tarjetas: Tarjeta[]; edicion: EdicionSemana }) {
  if (tarjetas.length === 0) return <Empty>No hay tareas planeadas esta semana.</Empty>
  return <ul className={styles.tarjetasSemana}>{tarjetas.map((t) => <TarjetaSemana key={t.id} tarea={t} edicion={edicion} />)}</ul>
}

export function CapaSemana({ dias, hitos, tarjetas = [], edicion = { encendida: false }, capacidad }: {
  dias: Bloque<DiasSemana>
  hitos: Bloque<HitoSemana[]>
  tarjetas?: Tarjeta[]
  edicion?: EdicionSemana
  /** ORD-POS-139: fila de CAPACIDAD_SEMANAL de la semana de la vista; sin ella no se muestra el panel. */
  capacidad?: ObjetivoCapacidad
}) {
  return (
    <Section title="Semana" id="semana">
      {dias.estado === 'ok' ? <Dias semana={dias.datos} /> : <SinDatos motivo={dias.motivo} />}
      {capacidad ? <CapacidadSemana key={capacidad.tipo === 'ambigua' ? 'ambigua' : capacidad.semanaId} objetivo={capacidad} edicion={edicion} /> : null}
      <h3>Tareas de la semana</h3>
      <Tarjetas tarjetas={tarjetas} edicion={edicion} />
      <h3>Hitos</h3>
      {hitos.estado === 'ok' ? <Hitos hitos={hitos.datos} /> : <SinDatos motivo={hitos.motivo} />}
    </Section>
  )
}
