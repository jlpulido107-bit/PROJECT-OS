import Link from 'next/link'
import { Badge, Section } from '@/components/ui'
import { formatoMxn } from '@/lib/finanzas/finanzas'
import {
  DIAS_G1, ENTIDADES_G1, type Actividad, type DatosTablero, type EntidadG1, type Estado, type Formato, type TarjetaTablero, type Tendencia,
} from '@/lib/inicio-tablero'
import styles from './tablero.module.css'

/**
 * Tablero de operación de Inicio v2 (ORD-POS-096). Solo pinta lo que calcula lib/inicio-tablero.ts: un número sale solo
 * en estado `ok`; «sin datos» y «fuente apagada» muestran su motivo, nunca un 0.
 */

const ETIQUETA_ENTIDAD: Record<EntidadG1, string> = { ORDENES_CODEX: 'Órdenes', TAREAS: 'Tareas', DECISIONES: 'Decisiones', TIEMPOS: 'Tiempos' }

function valor(n: number, formato: Formato): string {
  if (formato === 'pct') return `${n} %`
  if (formato === 'mxn') return formatoMxn(n)
  return String(n)
}

function diferencia(n: number, formato: Formato): string {
  if (n === 0) return '='
  const abs = formato === 'pct' ? `${Math.abs(n)} pp` : formato === 'mxn' ? formatoMxn(Math.abs(n)) : String(Math.abs(n))
  return `${n > 0 ? '+' : '−'}${abs}`
}

/** «Sin datos» o «Fuente apagada» con su motivo (nunca un número). */
export function SinValor({ estado, motivo }: { estado: 'sin-datos' | 'apagada'; motivo: string }) {
  return (
    <>
      <span className={styles.estado}>{estado === 'apagada' ? 'Fuente apagada' : 'Sin datos'}</span>
      <p className={styles.motivo} role="note">{motivo}</p>
    </>
  )
}

function LineaTendencia({ t, formato }: { t: Estado<Tendencia>; formato: Formato }) {
  if (t.estado !== 'ok') {
    return <span className={styles.tendencia}>Tendencia: {t.estado === 'apagada' ? 'fuente apagada' : 'sin datos'} ({t.motivo})</span>
  }
  return (
    <span className={styles.tendencia}>
      {diferencia(t.datos.diferencia, formato)} {t.datos.etiqueta} (antes {valor(t.datos.anterior, formato)})
    </span>
  )
}

function Tarjeta({ t }: { t: TarjetaTablero }) {
  const e = t.estado
  return (
    <div className={`stat ${styles.tarjeta}`} data-tarjeta={t.id} data-estado={e.estado}>
      <span className="stat-label"><Link href={t.href}>{t.titulo}</Link></span>
      {e.estado !== 'ok' ? <SinValor estado={e.estado} motivo={e.motivo} /> : (
        <>
          <span className="stat-value">{valor(e.datos.valor, t.formato)}</span>
          {e.datos.detalle ? <span className="stat-hint">{e.datos.detalle}</span> : null}
          <LineaTendencia t={e.datos.tendencia} formato={t.formato} />
          {e.datos.notas.map((n) => <span key={n} className="stat-hint">{n}</span>)}
        </>
      )}
      <span className="stat-hint">Fuente: {t.fuente}</span>
    </div>
  )
}

function GraficaActividad({ a }: { a: Actividad }) {
  const fmt = (fecha: string) => `${fecha.slice(8, 10)}/${fecha.slice(5, 7)}`
  return (
    <>
      <p>{a.total} operaciones en {DIAS_G1} días (hora de Mérida).</p>
      <div className={styles.barras} aria-hidden="true">
        {a.dias.map((d) => (
          <div key={d.fecha} className={styles.columna} title={`${fmt(d.fecha)} · ${d.total}`}>
            {ENTIDADES_G1.map((e) => d.porEntidad[e] ? (
              <div key={e} className={styles[e]} style={{ height: `${(d.porEntidad[e] / a.max) * 100}%` }} />
            ) : null)}
          </div>
        ))}
      </div>
      <ul className={styles.leyenda} aria-hidden="true">
        {ENTIDADES_G1.map((e) => <li key={e}><span className={`${styles.muestra} ${styles[e]}`} />{ETIQUETA_ENTIDAD[e]}</li>)}
      </ul>
      <details>
        <summary>Tabla de datos</summary>
        <div className="table-wrap">
          <table aria-label={`Operaciones del dashboard por día, últimos ${DIAS_G1} días`}>
            <thead>
              <tr><th scope="col">Día</th>{ENTIDADES_G1.map((e) => <th key={e} scope="col">{ETIQUETA_ENTIDAD[e]}</th>)}<th scope="col">Total</th></tr>
            </thead>
            <tbody>
              {a.dias.map((d) => (
                <tr key={d.fecha}>
                  <th scope="row" className="mono">{d.fecha}</th>
                  {ENTIDADES_G1.map((e) => <td key={e}>{d.porEntidad[e]}</td>)}
                  <td>{d.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  )
}

export function TableroInicio({ t }: { t: DatosTablero }) {
  const a = t.actividad
  const g2 = t.costoPorRol
  return (
    <Section title="Cómo va el sistema" id="tablero">
      <p className="muted small">
        Tendencia de esta semana (últimos 7 días, hoy incluido) contra los 7 previos. «Fuente apagada»: falta una
        configuración que enciende el propietario; «sin datos»: la fuente se leyó pero no alcanza.
      </p>
      <div className="stats" aria-label="Tarjetas del tablero">
        {t.tarjetas.map((x) => <Tarjeta key={x.id} t={x} />)}
      </div>
      <h3>Actividad por día <Badge tone="muted">AUDITORIA</Badge></h3>
      <div data-grafica="G1" data-estado={a.estado}>
        {a.estado === 'ok' ? <GraficaActividad a={a.datos} /> : <SinValor estado={a.estado} motivo={a.motivo} />}
      </div>
      <h3>Costo por rol y modelo <Badge tone="muted">FINANZAS</Badge></h3>
      <div data-grafica="G2" data-estado={g2.estado}>
        {g2.estado !== 'ok' ? <SinValor estado={g2.estado} motivo={g2.motivo} /> : null}
      </div>
    </Section>
  )
}
