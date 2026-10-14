import type { Metadata } from 'next'
import Link from 'next/link'
import { Freshness, LoadError, TabWarnings } from '@/components/data-state'
import { Badge, DateText, Empty, ExternalLink, humanize, Section, StateBadge, Text } from '@/components/ui'
import { CopiarParaCodex, OrderActions } from '@/components/operations/forms'
import { githubClient } from '@/lib/operations/dispatch'
import { textoParaCodexDeOrden } from '@/lib/operations/github'
import { writeAccess } from '@/components/operations/write-access'
import { resumenOrdenes, type GrupoOrden, type OrdenVista } from '@/lib/ordenes'
import { privateData } from '@/lib/page-data'

export const metadata: Metadata = { title: 'Órdenes a Codex' }

const GRUPOS: Array<{ id: GrupoOrden; titulo: string; vacio: string }> = [
  { id: 'tu-turno', titulo: 'Te toca', vacio: 'No hay órdenes esperando tu aprobación o tu decisión.' },
  { id: 'en-curso', titulo: 'En curso (Codex o Claude)', vacio: 'No hay órdenes en curso.' },
  { id: 'invalidas', titulo: 'Con estado inválido', vacio: '' },
  { id: 'terminadas', titulo: 'Terminadas', vacio: 'Todavía no hay órdenes terminadas.' },
]

const RIESGO_TONE = { BAJO: 'ok', MEDIO: 'warn', ALTO: 'danger' } as const

function OrdenCard({ v, canWrite, prDetectado }: { v: OrdenVista; canWrite: boolean; prDetectado?: { url: string; estado: string } }) {
  const o = v.orden
  const tone = RIESGO_TONE[o.riesgo as keyof typeof RIESGO_TONE] ?? 'neutral'
  // Mientras Codex no tenga el PR, el propietario lanza la tarea con este texto (el @codex en issues no la inicia).
  const textoCodex = canWrite && !prDetectado ? textoParaCodexDeOrden(o) : null
  return (
    <article className="card" aria-labelledby={`orden-${o.id}`}>
      <header className="card-head">
        <h3 id={`orden-${o.id}`} className="card-title"><span className="mono">{o.id}</span> · <Text value={o.titulo} empty="Sin título" /></h3>
        <div className="badges">
          <StateBadge code={o.estado} />
          <Badge tone={tone}>Riesgo: {o.riesgo ?? '—'}</Badge>
        </div>
      </header>
      <dl className="meta">
        <div><dt>Proyecto</dt><dd>{o.proyectoId ? <Link href={`/proyectos/${encodeURIComponent(o.proyectoId)}`}>{o.proyectoId}</Link> : <span className="muted">—</span>}</dd></div>
        <div><dt>Tarea</dt><dd>{o.tareaId ? <Link href={`/tareas/${encodeURIComponent(o.tareaId)}/editar`} className="mono">{o.tareaId}</Link> : <span className="muted">—</span>}</dd></div>
        <div><dt>Siguiente paso</dt><dd>{v.siguiente ? v.siguiente.texto : <span className="muted">—</span>}</dd></div>
        <div><dt>Actualizada</dt><dd><DateText value={o.actualizadoEn} /></dd></div>
        <div><dt>Issue</dt><dd>{o.issueUrl ? <ExternalLink href={o.issueUrl}>{o.issueUrl.replace(/^https:\/\/github\.com\//, '')}</ExternalLink> : <span className="muted">Sin issue</span>}</dd></div>
        <div><dt>PR</dt><dd>{!o.prUrl && prDetectado ? <><ExternalLink href={prDetectado.url}>{prDetectado.url.replace(/^https:\/\/github\.com\//, '')}</ExternalLink> <Badge tone="info">Detectado: {prDetectado.estado}</Badge></> : o.prUrl ? <ExternalLink href={o.prUrl}>{o.prUrl.replace(/^https:\/\/github\.com\//, '')}</ExternalLink> : <span className="muted">Sin PR</span>}</dd></div>
      </dl>
      <details>
        <summary>Detalle de la orden</summary>
        <dl className="meta meta-wide">
          <div><dt>Objetivo</dt><dd><Text value={o.objetivo} /></dd></div>
          <div><dt>Contexto</dt><dd><Text value={o.contexto} /></dd></div>
          <div><dt>Criterios de aceptación</dt><dd><Text value={o.criterios} /></dd></div>
          <div><dt>Fuera de alcance</dt><dd><Text value={o.fueraDeAlcance} /></dd></div>
          <div><dt>Cómo probar</dt><dd><Text value={o.comoProbar} /></dd></div>
          <div><dt>Notas</dt><dd><Text value={o.notas} empty="Sin notas" /></dd></div>
        </dl>
      </details>
      {textoCodex ? <CopiarParaCodex ordenId={o.id} texto={textoCodex} /> : null}
      {canWrite && v.estado && v.estado !== 'CERRADA' && v.estado !== 'CANCELADA' ? (
        <OrderActions ordenId={o.id} estado={v.estado} canApprove={v.estado === 'BORRADOR' && v.problemas.length === 0} prDetectado={prDetectado?.url} />
      ) : null}
      {v.problemas.length > 0 ? (
        <ul className="list" aria-label={`Problemas de ${o.id}`}>
          {v.problemas.map((p) => <li key={p}><Badge tone="warn">Revisar</Badge> {p}</li>)}
        </ul>
      ) : null}
    </article>
  )
}

export default async function OrdenesPage() {
  const { user, result } = await privateData('/ordenes')
  if (!result.ok) return <><h1>Órdenes a Codex</h1><LoadError result={result} /></>
  const data = result.data
  const r = resumenOrdenes(data)
  const total = data.ordenes.length
  const canWrite = writeAccess(user.email).allowed
  // PRs de Codex para las órdenes ENVIADA (solo lectura en GitHub; si falla, simplemente no se muestran).
  const client = canWrite ? githubClient() : null
  const prs = new Map<string, { url: string; estado: string }>()
  if (client) {
    await Promise.all(data.ordenes.filter((o) => o.estado === 'ENVIADA' && o.proyectoId).map(async (o) => {
      try {
        const pr = await client.prDeOrden(o.proyectoId!, o.id)
        if (pr) prs.set(o.id, pr)
      } catch {
        // Sin detalles: el panel sigue funcionando sin la detección.
      }
    }))
  }

  return (
    <>
      <h1>Órdenes a Codex</h1>
      <Freshness data={data} />
      <TabWarnings data={data} tabs={['ORDENES_CODEX', 'TAREAS']} />
      {canWrite ? <p><a className="button button-primary" href="/ordenes/nueva">Nueva orden</a></p> : null}
      <p className="muted small">
        Lectura de la pestaña ORDENES_CODEX. Solo el propietario aprueba; una orden cerrada no cierra su tarea.
      </p>
      {total === 0 ? <Empty>No hay órdenes en ORDENES_CODEX.</Empty> : (
        <div className="badges" aria-label="Órdenes por estado">
          {r.porEstado.map(([estado, n]) => <Badge key={estado}>{humanize(estado)}: {n}</Badge>)}
        </div>
      )}
      {total > 0 && GRUPOS.map((g) => {
        const items = r.grupos[g.id]
        if (items.length === 0 && !g.vacio) return null
        return (
          <Section key={g.id} id={g.id} title={`${g.titulo} (${items.length})`}>
            {items.length === 0 ? <Empty>{g.vacio}</Empty> : <div className="stack">{items.map((v) => <OrdenCard key={v.orden.id} v={v} canWrite={canWrite} prDetectado={prs.get(v.orden.id)} />)}</div>}
          </Section>
        )
      })}
    </>
  )
}
