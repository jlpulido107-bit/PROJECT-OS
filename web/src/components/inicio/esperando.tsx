import Link from 'next/link'
import type { ReactNode } from 'react'
import { Badge, ExternalLink, Section } from '@/components/ui'
import type { ProyectoAgentes } from '@/lib/agentes'
import type { Esperando, Grupo } from '@/lib/esperando'
import { urlGithub } from '@/lib/estado'

/**
 * Bloque «Esperando por ti» (ORD-POS-122; docs/diseno-planificacion-v2.md §6). Solo pinta lo que calcula
 * lib/esperando.ts. Regla de lenguaje (§2): el nombre primero y el ID después, en monoespaciada y pequeño. «Sin datos»
 * y «apagada» dicen su motivo, nunca un 0. Las banderas (6.4, ORD-POS-125) salen por su nombre en palabras y solo como
 * apagadas: nunca su valor ni un correo.
 * «Fusionado sin desplegar» (6.2, ORD-POS-124) lista los PR de PROJECT-OS cuyo commit de fusión no está desplegado.
 */

function Id({ children, href }: { children: string; href?: string }) {
  return href ? <Link href={href} className="mono small">{children}</Link> : <span className="mono small">{children}</span>
}

function Nombre({ value, vacio }: { value: string | null; vacio: string }) {
  return value?.trim() ? <>{value}</> : <span className="muted">{vacio}</span>
}

function Motivo({ estado, motivo }: { estado: 'sin-datos' | 'apagada'; motivo: string }) {
  return <p role="note"><Badge tone="muted">{estado === 'apagada' ? 'Fuente apagada' : 'Sin datos'}</Badge> {motivo}</p>
}

function GrupoEsperando<T>({ titulo, grupo, children }: { titulo: string; grupo: Grupo<T>; children: (datos: T) => ReactNode }) {
  return (
    <>
      <h3>{titulo}</h3>
      {grupo.estado === 'ok' ? children(grupo.datos) : <Motivo estado={grupo.estado} motivo={grupo.motivo} />}
    </>
  )
}

const Vacio = ({ children }: { children: ReactNode }) => <p className="muted small">{children}</p>

function Cuando({ dias }: { dias: number }) {
  return dias === 0 ? <>vence hoy</> : <>venció hace {-dias} {dias === -1 ? 'día' : 'días'}</>
}

export function BloqueEsperando({ e, filtro }: { e: Grupo<Esperando>; filtro: ProyectoAgentes | null }) {
  const titulo = e.estado === 'ok' ? `Esperando por ti (${e.datos.contador})` : 'Esperando por ti'
  return (
    <Section title={titulo} id="esperando">
      {e.estado !== 'ok' ? <Motivo estado={e.estado} motivo={e.motivo} /> : <Grupos d={e.datos} />}
      {e.estado === 'ok' && e.datos.sinContar ? (
        <p className="muted small">El contador suma solo los grupos con datos; {e.datos.sinContar} sin datos o apagados no cuentan.</p>
      ) : null}
      {filtro ? <p className="muted small">Filtrado por {filtro}.</p> : null}
    </Section>
  )
}

function Grupos({ d }: { d: Esperando }) {
  return (
    <>
      <GrupoEsperando titulo="Listos para fusionar" grupo={d.listos}>
        {(l) => (
          <>
            {l.lista.length === 0 ? <Vacio>Ninguna orden está lista para fusionar.</Vacio> : (
              <ul className="list" aria-label="Listos para fusionar">
                {l.lista.map(({ orden, via }) => {
                  const pr = urlGithub(orden.prUrl)
                  return (
                    <li key={orden.id}>
                      <Nombre value={orden.titulo} vacio="(orden sin título)" /> · <Id href="/ordenes#tu-turno">{orden.id}</Id>{' '}
                      {via === 'revisada' ? <Badge tone="ok">Revisada</Badge> : <Badge tone="ok">CONFORME en el head actual</Badge>}
                      {pr ? <> · <ExternalLink href={pr}>Fusionar en GitHub</ExternalLink></> : null}
                    </li>
                  )
                })}
              </ul>
            )}
            {l.sinDatos.length ? (
              <p role="note"><Badge tone="muted">Sin datos</Badge> {l.motivoSinDatos}{' '}
                {l.sinDatos.map((o, i) => <span key={o.id}>{i ? ', ' : ''}<Nombre value={o.titulo} vacio="(orden sin título)" /> · <Id href="/ordenes">{o.id}</Id></span>)}
              </p>
            ) : null}
          </>
        )}
      </GrupoEsperando>
      <GrupoEsperando titulo="Fusionado sin desplegar" grupo={d.fusionadoSinDesplegar}>
        {(f) => (
          <>
            {f.lista.length === 0 ? <Vacio>Todo lo fusionado de las órdenes está desplegado.</Vacio> : (
              <ul className="list" aria-label="Fusionado sin desplegar">
                {f.lista.map((x) => (
                  <li key={x.ordenId}>
                    <Nombre value={x.titulo} vacio="(orden sin título)" /> · <Id href="/ordenes">{x.ordenId}</Id> ·{' '}
                    <ExternalLink href={x.url}>{`PR #${x.numero}`}</ExternalLink> → desplegar (DEC-POS-017)
                  </li>
                ))}
              </ul>
            )}
            {f.otrosCommits ? <p className="muted small">Además, {f.otrosCommits} {f.otrosCommits === 1 ? 'commit' : 'commits'} de main sin desplegar que no son la fusión de un PR de orden de la lista.</p> : null}
            {f.sinDatos.length ? (
              <p role="note"><Badge tone="muted">Sin datos</Badge> GitHub no dio el commit de fusión de: {f.sinDatos.map((id, i) => <span key={id}>{i ? ', ' : ''}<Id href="/ordenes">{id}</Id></span>)}</p>
            ) : null}
          </>
        )}
      </GrupoEsperando>
      <GrupoEsperando titulo="Decisiones por tomar" grupo={d.decisiones}>
        {(ds) => ds.length === 0 ? <Vacio>Ninguna decisión pendiente.</Vacio> : (
          <ul className="list" aria-label="Decisiones por tomar">
            {ds.map((x) => (
              <li key={x.id}>
                <Nombre value={x.asunto} vacio="(decisión sin asunto)" /> ·{' '}
                <Id href={x.proyectoId ? `/proyectos/${encodeURIComponent(x.proyectoId)}` : undefined}>{x.id}</Id> → decidir
              </li>
            ))}
          </ul>
        )}
      </GrupoEsperando>
      <GrupoEsperando titulo="Banderas sin encender" grupo={d.banderas}>
        {(b) => (
          <>
            {b.lista.length === 0 ? <Vacio>Ninguna orden fusionada espera una bandera apagada.</Vacio> : (
              <ul className="list" aria-label="Banderas sin encender">
                {b.lista.map(({ orden, nombre }) => (
                  <li key={orden.id}>
                    {nombre} <Badge tone="warn">apagada</Badge> · <Nombre value={orden.titulo} vacio="(orden sin título)" /> ·{' '}
                    <Id href="/ordenes">{orden.id}</Id> → encender con deploy.sh
                  </li>
                ))}
              </ul>
            )}
            {b.desconocidas.length ? (
              <p role="note"><Badge tone="muted">Sin datos</Badge>{' '}
                {b.desconocidas.map(({ orden, nombre }, i) => (
                  <span key={orden.id}>{i ? '; ' : ''}Bandera {nombre} no reconocida · <Id href="/ordenes">{orden.id}</Id></span>
                ))}
              </p>
            ) : null}
            {b.sinDatos.length ? (
              <p role="note"><Badge tone="muted">Sin datos</Badge> {b.motivoSinDatos}{' '}
                {b.sinDatos.map((o, i) => <span key={o.id}>{i ? ', ' : ''}<Id href="/ordenes">{o.id}</Id></span>)}
              </p>
            ) : null}
          </>
        )}
      </GrupoEsperando>
      <GrupoEsperando titulo="Vencen hoy" grupo={d.vencenHoy}>
        {(ts) => ts.length === 0 ? <Vacio>Ninguna tarea tuya vence hoy ni está vencida.</Vacio> : (
          <ul className="list" aria-label="Vencen hoy">
            {ts.map(({ tarea, dias, marca }) => (
              <li key={tarea.id}>
                <Nombre value={tarea.titulo} vacio="(tarea sin título)" /> · <Id href={`/tareas?q=${encodeURIComponent(tarea.id)}`}>{tarea.id}</Id>{' '}
                · <Cuando dias={dias} /> {marca === 'vencido' ? <Badge tone="danger">Vencida</Badge> : null} → ver tarea
              </li>
            ))}
          </ul>
        )}
      </GrupoEsperando>
    </>
  )
}
