import Link from 'next/link'
import type { ReactNode } from 'react'
import { SinDatos, Tarjeta, TarjetaOrdenes } from '@/components/agentes/agentes'
import { Badge, DateText, ExternalLink, Section, Stat, Text } from '@/components/ui'
import { PROYECTOS_AGENTES, type ConteoOrdenes, type Indicador, type ProyectoAgentes } from '@/lib/agentes'
import { urlGithub } from '@/lib/estado'
import { formatoMoneda, formatoMxn, type Pendiente } from '@/lib/finanzas/finanzas'
import type { FinanzasInicio, Marca, Pendientes, ProyectoInicio } from '@/lib/inicio'

/** Bloques del inicio (ORD-POS-090). Solo pintan lo que calcula lib/inicio.ts; «sin datos» nunca es un cero. */

export interface DatosInicio {
  filtro: ProyectoAgentes | null
  proyectos: Indicador<ProyectoInicio[]>
  pendientes: Pendientes
  finanzas: Indicador<FinanzasInicio>
  ordenes: Indicador<ConteoOrdenes>
}

const conFiltro = (path: string, filtro: ProyectoAgentes | null) => (filtro ? `${path}?proyecto=${filtro}` : path)

function MarcaBadge({ marca }: { marca: Marca }) {
  if (marca === 'vencido') return <Badge tone="danger">Vencido</Badge>
  if (marca === 'proximo') return <Badge tone="warn">Vence en 7 días</Badge>
  return null
}

function Dias({ dias }: { dias: number }) {
  if (dias < 0) return <>hace {-dias} {dias === -1 ? 'día' : 'días'}</>
  if (dias === 0) return <>hoy</>
  return <>en {dias} {dias === 1 ? 'día' : 'días'}</>
}

export function FiltroInicio({ filtro }: { filtro: ProyectoAgentes | null }) {
  return (
    <form className="filters" method="get" action="/" aria-label="Filtrar el inicio por proyecto">
      <label className="field">
        <span>Proyecto</span>
        <select name="proyecto" defaultValue={filtro ?? ''}>
          <option value="">Todos</option>
          {PROYECTOS_AGENTES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </label>
      <div className="filter-actions">
        <button type="submit" className="button button-primary">Filtrar</button>
        {filtro ? <Link href="/">Quitar filtro</Link> : null}
      </div>
    </form>
  )
}

function BloqueProyectos({ proyectos }: { proyectos: ProyectoInicio[] }) {
  return (
    <div className="stack">
      {proyectos.map((p) => (
        <div key={p.proyecto}>
          <h3>
            <Link href={`/estado#proyecto-${p.proyecto}`}><span className="mono">{p.proyecto}</span></Link>
            {p.nombre ? <> · {p.nombre}</> : null}
          </h3>
          {p.hitos.length === 0 ? <p className="muted small">Sin hitos abiertos con fecha en HITOS.</p> : (
            <ul className="list" aria-label={`Hitos de ${p.proyecto}`}>
              {p.hitos.map((h) => (
                <li key={h.id}>
                  <Link href={`/estado#proyecto-${p.proyecto}`}><span className="mono">{h.id}</span></Link>{' '}
                  <Text value={h.nombre} empty="Sin nombre" /> · <DateText value={h.fecha} /> <span className="small muted">(<Dias dias={h.dias} />)</span>{' '}
                  <MarcaBadge marca={h.marca} />
                  <div className="small">
                    {h.total === 0 ? <span className="muted">Sin tareas ligadas</span> : (
                      <>
                        <progress max={h.total} value={h.completadas} aria-label={`Avance de ${h.id}`} /> {h.completadas}/{h.total} tareas completadas
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  )
}

function Lista<T>({ titulo, indicador, vacio, children }: {
  titulo: string; indicador: Indicador<T[]>; vacio: string; children: (item: T) => ReactNode
}) {
  return (
    <>
      <h3>{titulo}{indicador.estado === 'ok' ? ` (${indicador.datos.length})` : null}</h3>
      <Tarjeta indicador={indicador}>
        {(items) => items.length === 0 ? <p className="muted small">{vacio}</p> : <ul className="list" aria-label={titulo}>{items.map(children)}</ul>}
      </Tarjeta>
    </>
  )
}

function EstadoRecurrente({ p }: { p: Pendiente }) {
  return p.atrasado ? <Badge tone="danger">Atrasado</Badge> : p.aunNoVence ? <Badge tone="muted">Aún no vence</Badge> : <Badge tone="warn">Pendiente</Badge>
}

function BloquePendientes({ p, filtro }: { p: Pendientes; filtro: ProyectoAgentes | null }) {
  const pr = p.prSinRegistrar
  return (
    <>
      <Lista titulo="Tareas vencidas o que vencen en 7 días" indicador={p.tareas} vacio="Ninguna tarea tuya vence en los próximos 7 días.">
        {({ tarea, dias, marca }) => (
          <li key={tarea.id}>
            <Link href={`/tareas?q=${encodeURIComponent(tarea.id)}`} className="mono">{tarea.id}</Link>{' '}
            <Text value={tarea.titulo} empty="Sin título" /> · <Dias dias={dias} /> <MarcaBadge marca={marca} />
          </li>
        )}
      </Lista>
      <Lista titulo="Órdenes REVISADA por cerrar" indicador={p.revisadas} vacio="Ninguna orden revisada espera tu cierre.">
        {(o) => {
          const issue = urlGithub(o.issueUrl)
          return (
            <li key={o.id}>
              <Link href="/ordenes#tu-turno" className="mono">{o.id}</Link> <Text value={o.titulo} empty="Sin título" />
              {issue ? <> · <ExternalLink href={issue}>Issue</ExternalLink></> : null}
            </li>
          )
        }}
      </Lista>
      <h3>Órdenes con PR sin registrar{pr.estado === 'ok' ? ` (${pr.datos.lista.length})` : null}</h3>
      <Tarjeta indicador={pr}>
        {(d) => (
          <>
            {d.lista.length === 0 ? <p className="muted small">Ninguna orden ENVIADA tiene un PR detectado sin registrar.</p> : (
              <ul className="list" aria-label="Órdenes con PR sin registrar">
                {d.lista.map(({ orden, prUrl }) => (
                  <li key={orden.id}>
                    <Link href="/ordenes#en-curso" className="mono">{orden.id}</Link> <Text value={orden.titulo} empty="Sin título" />
                    {prUrl ? <> · <ExternalLink href={prUrl}>PR</ExternalLink></> : null}
                  </li>
                ))}
              </ul>
            )}
            {d.sinDatos.length ? <SinDatos motivo={`No se pudieron leer los PRs de ${d.sinDatos.join(', ')}.`} /> : null}
          </>
        )}
      </Tarjeta>
      <Lista titulo="Decisiones PENDIENTE" indicador={p.decisiones} vacio="Ninguna decisión pendiente.">
        {(d) => (
          <li key={d.id}>
            {d.proyectoId ? <Link href={`/proyectos/${encodeURIComponent(d.proyectoId)}`} className="mono">{d.id}</Link> : <span className="mono">{d.id}</span>}{' '}
            <Text value={d.asunto} empty="Sin asunto" />
          </li>
        )}
      </Lista>
      <Lista titulo="Recurrentes del mes sin confirmar" indicador={p.recurrentes} vacio="Todos los recurrentes del mes están confirmados.">
        {(r) => (
          <li key={r.movId}>
            <Link href="/finanzas#recurrentes">{r.recurrente.concepto}</Link> ({r.recurrente.proyecto}) ·{' '}
            {formatoMoneda(r.recurrente.centavos, r.recurrente.moneda)} · cobro <span className="mono">{r.fechaCobro}</span> <EstadoRecurrente p={r} />
          </li>
        )}
      </Lista>
      {filtro ? <p className="muted small">Filtrado por {filtro}.</p> : null}
    </>
  )
}

function BloqueFinanzas({ f }: { f: FinanzasInicio }) {
  const { capital, claude, gastoMes } = f
  const cap = capital.estado === 'ok' ? capital.datos : null
  return (
    <>
      <div className="stats" aria-label="Finanzas del mes">
        <Stat label={`Gasto de ${f.mes}`} value={gastoMes.estado === 'ok' ? formatoMxn(gastoMes.datos) : null} href="/finanzas#mensual"
          hint={gastoMes.estado === 'ok' ? 'Gasto + inversión' : gastoMes.motivo} />
        <Stat label="Capital usado" value={cap ? formatoMxn(cap.usadoCentavos) : null} href="/finanzas#capital"
          tone={cap?.alerta === 'superado' ? 'danger' : cap?.alerta === 'aviso' ? 'warn' : undefined}
          hint={capital.estado !== 'ok' ? capital.motivo : cap!.topeCentavos === null ? 'Sin tope en PARAMETROS' : `de ${formatoMxn(cap!.topeCentavos)} de tope (ECO + POS)`} />
        <Stat label="Claude (recurrente)" href="/finanzas#recurrentes"
          value={claude.estado !== 'ok' ? null : claude.datos.registradoCentavos !== null ? formatoMxn(claude.datos.registradoCentavos) : <span className="stat-empty">Sin registrar</span>}
          hint={claude.estado !== 'ok' ? claude.motivo : claude.datos.pendiente
            ? `Esperado ${formatoMoneda(claude.datos.pendiente.recurrente.centavos, claude.datos.pendiente.recurrente.moneda)} sin confirmar (${claude.datos.pendiente.mes})`
            : `Registrado en ${f.mes}`} />
      </div>
      {cap && cap.pct !== null ? (
        <p><progress max={100} value={Math.min(cap.pct, 100)} aria-label="Capital usado contra el tope" /> {Math.floor(cap.pct)} % del tope</p>
      ) : null}
    </>
  )
}

/** `tablero`: la franja de Inicio v2 (ORD-POS-096), entre el filtro y los bloques de siempre. */
export function VistaInicio({ d, tablero }: { d: DatosInicio; tablero?: ReactNode }) {
  return (
    <>
      <FiltroInicio filtro={d.filtro} />
      {tablero}
      <Section title="Proyectos" id="proyectos" actions={<Link href="/estado">Ver estado →</Link>}>
        <Tarjeta indicador={d.proyectos}>{(p) => <BloqueProyectos proyectos={p} />}</Tarjeta>
      </Section>
      <Section title="Mis pendientes" id="pendientes" actions={<Link href="/ordenes">Ver órdenes →</Link>}>
        <BloquePendientes p={d.pendientes} filtro={d.filtro} />
      </Section>
      <Section title="Finanzas" id="finanzas" actions={<Link href="/finanzas">Ver finanzas →</Link>}>
        <Tarjeta indicador={d.finanzas}>{(f) => <BloqueFinanzas f={f} />}</Tarjeta>
      </Section>
      <Section title="Agentes" id="agentes" actions={<Link href={conFiltro('/agentes', d.filtro)}>Ver agentes →</Link>}>
        <Tarjeta indicador={d.ordenes}>{(c) => <TarjetaOrdenes c={c} />}</Tarjeta>
      </Section>
    </>
  )
}
