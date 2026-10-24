import type { ReactNode } from 'react'
import { Badge, Empty, ExternalLink, humanize } from '@/components/ui'
import {
  ESTADOS_SIN_DICTAMEN, PROYECTOS_AGENTES, type ConteoOrdenes, type Dictamenes, type FiltroAgentes, type FusionProyecto, type GastoClaude,
  type Indicador, type MapaLanzamientos,
} from '@/lib/agentes'
import { formatoMxn } from '@/lib/finanzas/finanzas'
import { MAX_PRS_LISTA } from '@/lib/operations/github'
import styles from './agentes.module.css'

/** Tarjetas de /agentes (ORD-POS-078). Solo pintan lo que calcula lib/agentes.ts; «sin datos» nunca es un cero. */

export function SinDatos({ motivo }: { motivo: string }) {
  return <p role="note"><Badge tone="muted">Sin datos</Badge> {motivo}</p>
}

export function Tarjeta<T>({ indicador, children }: { indicador: Indicador<T>; children: (datos: T) => ReactNode }) {
  return indicador.estado === 'ok' ? <>{children(indicador.datos)}</> : <SinDatos motivo={indicador.motivo} />
}

export function FiltroForm({ filtro }: { filtro: FiltroAgentes }) {
  return (
    <form className="filters" method="get" action="/agentes" aria-label="Filtrar indicadores">
      <label className="field">
        <span>Proyecto</span>
        <select name="proyecto" defaultValue={filtro.proyecto ?? ''}>
          <option value="">Todos</option>
          {PROYECTOS_AGENTES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </label>
      <label className="field">
        <span>Desde</span>
        <input type="date" name="desde" defaultValue={filtro.desde ?? ''} />
      </label>
      <label className="field">
        <span>Hasta</span>
        <input type="date" name="hasta" defaultValue={filtro.hasta ?? ''} />
      </label>
      <div className="filter-actions">
        <button type="submit" className="button button-primary">Aplicar filtros</button>
      </div>
    </form>
  )
}

const etiquetaRiesgo = (r: string) => (r === 'SIN_RIESGO' ? 'Sin riesgo' : r)

export function TarjetaOrdenes({ c }: { c: ConteoOrdenes }) {
  if (c.total === 0) return <Empty>Ninguna orden coincide con el filtro.</Empty>
  return (
    <>
      <p>{c.total} órdenes{c.sinFecha ? <span className="muted small"> · {c.sinFecha} sin alta en AUDITORIA, fuera del rango</span> : null}</p>
      <div className="meta meta-wide">
        <div><dt>Por estado</dt><dd className="badges">{c.porEstado.map(([e, n]) => <Badge key={e}>{e === 'SIN_ESTADO' ? 'Sin estado' : humanize(e)}: {n}</Badge>)}</dd></div>
        <div><dt>Por proyecto</dt><dd className="badges">{c.porProyecto.map(([p, n]) => <Badge key={p}>{p === 'SIN_PROYECTO' ? 'Sin proyecto' : p}: {n}</Badge>)}</dd></div>
        <div><dt>Por riesgo</dt><dd className="badges">{c.porRiesgo.map(([r, n]) => <Badge key={r}>{etiquetaRiesgo(r)}: {n}</Badge>)}</dd></div>
      </div>
    </>
  )
}

export function TarjetaFusion({ filas }: { filas: FusionProyecto[] }) {
  const truncados = filas.filter((f) => f.estado === 'ok' && f.truncado).map((f) => f.proyecto)
  return (
    <>
    {truncados.length ? (
      <p role="note"><Badge tone="warn">Lista incompleta</Badge> La lista de PRs de {truncados.join(', ')} llegó al límite de {MAX_PRS_LISTA} PRs:
        la mediana solo usa los más recientes y puede estar sesgada.</p>
    ) : null}
    <div className="table-wrap">
      <table aria-label="Tiempo de ENVIADA a PR fusionado por proyecto">
        <thead><tr><th scope="col">Proyecto</th><th scope="col">Mediana ENVIADA → fusionado</th><th scope="col">Órdenes medidas</th></tr></thead>
        <tbody>
          {filas.map((f) => (
            <tr key={f.proyecto}>
              <th scope="row">{f.proyecto}</th>
              {f.estado === 'ok' ? (
                <><td>{f.medianaDias === null ? <span className="muted">Sin fusiones medibles</span> : `${f.medianaDias} d`}{f.truncado ? <span className="muted small"> (lista incompleta)</span> : null}</td><td>{f.n}</td></>
              ) : <td colSpan={2}><Badge tone="muted">Sin datos</Badge> {f.motivo}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </>
  )
}

const valor = (n: number | null) => (n === null ? <span className="muted">Sin datos</span> : n)

export function TarjetaDictamenes({ d }: { d: Dictamenes }) {
  return (
    <>
      <div className="badges">
        <Badge tone="ok">CONFORME: {d.totalConforme}</Badge>
        <Badge tone="warn">CAMBIOS: {d.totalCambios}</Badge>
        {d.sinLeer ? <Badge tone="muted">{d.sinLeer} PR sin leer en GitHub (fuera de los totales)</Badge> : null}
      </div>
      {d.omitidas ? <p className="muted small">{d.omitidas} órdenes {ESTADOS_SIN_DICTAMEN.join(' o ')}: sus dictámenes no se leen de GitHub (fuera de los totales).</p> : null}
      {d.rondasSinDatos ? <p className="muted small">Sin AUDITORIA no se cuentan las rondas de corrección.</p> : null}
      <div className="table-wrap">
        <table aria-label="Rondas y dictámenes por orden">
          <thead><tr><th scope="col">Orden</th><th scope="col">Rondas de corrección</th><th scope="col">CONFORME</th><th scope="col">CAMBIOS</th></tr></thead>
          <tbody>
            {d.filas.map((f) => (
              <tr key={f.ordenId}>
                <th scope="row"><ExternalLink href={f.prUrl}>{f.ordenId}</ExternalLink></th>
                <td>{valor(f.rondas)}</td>
                {f.omitida ? <td colSpan={2} className="muted">No se lee (CERRADA o CANCELADA)</td> : <><td>{valor(f.conforme)}</td><td>{valor(f.cambios)}</td></>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

const DIAS = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom']

export function TarjetaMapa({ m }: { m: MapaLanzamientos }) {
  if (m.total === 0) return <Empty>No hay lanzamientos de rutinas en AUDITORIA para el filtro.</Empty>
  const nivel = (n: number) => (n === 0 ? 0 : Math.min(4, Math.ceil((n / m.max) * 4)))
  return (
    <>
      <p>{m.total} lanzamientos (hora de Mérida).</p>
      <div className="table-wrap">
        <table className={styles.mapa} aria-label="Lanzamientos de rutinas por día y hora">
          <thead>
            <tr><th scope="col">Día</th>{Array.from({ length: 24 }, (_, h) => <th key={h} scope="col">{h}</th>)}</tr>
          </thead>
          <tbody>
            {m.celdas.map((fila, d) => (
              <tr key={DIAS[d]}>
                <th scope="row">{DIAS[d]}</th>
                {fila.map((n, h) => <td key={h} className={styles[`n${nivel(n)}`]} title={`${DIAS[d]} ${h}:00 · ${n}`}>{n || ''}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
const nombreMes = (mes: string) => `${MESES[Number(mes.slice(5, 7)) - 1]} ${mes.slice(0, 4)}`

export function TarjetaClaude({ g }: { g: GastoClaude }) {
  return (
    <div className="table-wrap">
      <table aria-label="Gasto mensual en Claude">
        <thead><tr><th scope="col">Mes</th><th scope="col">Gasto en Claude</th></tr></thead>
        <tbody>
          {g.meses.map((m) => <tr key={m.mes}><th scope="row">{nombreMes(m.mes)}</th><td>{formatoMxn(m.centavos)}</td></tr>)}
          <tr><th scope="row">Total</th><td>{formatoMxn(g.totalCentavos)}</td></tr>
        </tbody>
      </table>
    </div>
  )
}

export interface IndicadoresAgentes {
  ordenes: Indicador<ConteoOrdenes>
  fusion: Indicador<FusionProyecto[]>
  dictamenes: Indicador<Dictamenes>
  lanzamientos: Indicador<MapaLanzamientos>
  claude: Indicador<GastoClaude>
}

/** Cuerpo de /agentes: filtro y las 5 tarjetas, cada una con su fuente. */
export function VistaAgentes({ filtro, ind }: { filtro: FiltroAgentes; ind: IndicadoresAgentes }) {
  return (
    <>
      <FiltroForm filtro={filtro} />
      <section className="section" aria-labelledby="ag-ordenes"><h2 id="ag-ordenes">Órdenes por estado, proyecto y riesgo</h2>
        <p className="muted small">ORDENES_CODEX. Con rango de fechas, por fecha de alta en AUDITORIA.</p>
        <Tarjeta indicador={ind.ordenes}>{(c) => <TarjetaOrdenes c={c} />}</Tarjeta>
      </section>
      <section className="section" aria-labelledby="ag-fusion"><h2 id="ag-fusion">Tiempo de ENVIADA a PR fusionado</h2>
        <p className="muted small">Envío en AUDITORIA y fusión en GitHub. Con rango, por fecha de envío.</p>
        <Tarjeta indicador={ind.fusion}>{(f) => <TarjetaFusion filas={f} />}</Tarjeta>
      </section>
      <section className="section" aria-labelledby="ag-dictamenes"><h2 id="ag-dictamenes">Rondas de corrección y dictámenes</h2>
        <p className="muted small">Dictámenes válidos en los PRs de GitHub (último de cada revisión); rondas lanzadas desde el dashboard (AUDITORIA).</p>
        <Tarjeta indicador={ind.dictamenes}>{(d) => <TarjetaDictamenes d={d} />}</Tarjeta>
      </section>
      <section className="section" aria-labelledby="ag-lanzamientos"><h2 id="ag-lanzamientos">Lanzamientos de rutinas por día y hora</h2>
        <p className="muted small">Revisiones y correcciones lanzadas (AUDITORIA, hora de Mérida). La ejecución inicial deja constancia en el issue, no en AUDITORIA.</p>
        <Tarjeta indicador={ind.lanzamientos}>{(m) => <TarjetaMapa m={m} />}</Tarjeta>
      </section>
      <section className="section" aria-labelledby="ag-claude"><h2 id="ag-claude">Gasto mensual en Claude</h2>
        <p className="muted small">
          Regla (decisión del propietario del 2026-10-24): el gasto de Claude se toma de FINANZAS, categoría Herramientas,
          de los movimientos con «Claude» en el concepto o MOV_ID CLAUDE- o REC-CLAUDE- (Gasto + Inversión).
        </p>
        <Tarjeta indicador={ind.claude}>{(g) => <TarjetaClaude g={g} />}</Tarjeta>
      </section>
    </>
  )
}
