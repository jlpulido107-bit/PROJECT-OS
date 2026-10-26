import type { Metadata } from 'next'
import Link from 'next/link'
import { Freshness, LoadError, TabWarnings } from '@/components/data-state'
import { Badge, DateText, Empty, ExternalLink, humanize, Section, StateBadge, Text } from '@/components/ui'
import { CopiarParaClaude, OrderActions } from '@/components/operations/forms'
import { DictamenFila, PrFila } from '@/components/operations/orden-filas'
import { githubClient } from '@/lib/operations/dispatch'
import { routineClient, rutinasSupervision, type RutinasSupervision } from '@/lib/operations/claude-routine'
import { dictamenDeOrden, falloDictamen } from '@/lib/operations/dictamenes'
import { codigoFalloGitHub, textoParaEjecutarDeOrden } from '@/lib/operations/github'
import { claveLanzamiento } from '@/lib/operations/revision'
import { operationsService } from '@/lib/operations/runtime'
import type { EstadoLanzamiento } from '@/lib/operations/service'
import type { EvaluacionDictamen } from '@/lib/supervision/dictamen'
import { ordenSensible } from '@/lib/supervision/politica'
import { writeAccess } from '@/components/operations/write-access'
import { resumenOrdenes, type GrupoOrden, type OrdenVista } from '@/lib/ordenes'
import { privateData } from '@/lib/page-data'

export const metadata: Metadata = { title: 'Órdenes' }

const GRUPOS: Array<{ id: GrupoOrden; titulo: string; vacio: string }> = [
  { id: 'tu-turno', titulo: 'Te toca', vacio: 'No hay órdenes esperando tu aprobación o tu decisión.' },
  { id: 'en-curso', titulo: 'En curso (Claude)', vacio: 'No hay órdenes en curso.' },
  { id: 'invalidas', titulo: 'Con estado inválido', vacio: '' },
  { id: 'terminadas', titulo: 'Terminadas', vacio: 'Todavía no hay órdenes terminadas.' },
]

const RIESGO_TONE = { BAJO: 'ok', MEDIO: 'warn', ALTO: 'danger' } as const

type Supervision = { accion: 'revisar' | 'corregir'; etiqueta: string; headSha: string; sesion?: string; incierto?: boolean; sesionInvalida?: boolean }

/**
 * Un solo botón según el dictamen del PR (ORD-POS-037); sin la rutina configurada o con riesgo ALTO no aparece. Si el
 * paso ya tiene lanzamiento o reserva vigente en AUDITORIA (ORD-POS-039), en lugar del botón va la sesión, «incierto» o «sesión no válida».
 */
function botonSupervision(ordenId: string, ev: EvaluacionDictamen | null | undefined, rutinas: RutinasSupervision, lanzamientos: Map<string, EstadoLanzamiento>): Supervision | undefined {
  const plan = ev?.plan
  if (!plan) return undefined
  const [accion, etiqueta, rutina] = plan.tipo === 'CORREGIR' ? ['corregir', 'Pedir corrección', rutinas.corregir] as const
    : plan.tipo === 'SEGUNDO' ? ['revisar', 'Lanzar segundo revisor', rutinas.segundo] as const
    : ['revisar', 'Lanzar revisión', rutinas.revisar] as const
  if (!rutina) return undefined
  const previo = lanzamientos.get(claveLanzamiento(ordenId, plan))
  return { accion, etiqueta, headSha: plan.headSha, sesion: previo?.tipo === 'lanzada' ? previo.sesion : undefined, incierto: previo?.tipo === 'reservada', sesionInvalida: previo?.tipo === 'sesion-invalida' }
}

function OrdenCard({ v, canWrite, prDetectado, falloPr, falloLanzamiento, claude, dictamen, supervision, prFusionado }: {
  v: OrdenVista; canWrite: boolean; prDetectado?: { url: string; estado: string }; falloPr?: string; falloLanzamiento?: string; prFusionado?: boolean
  dictamen?: EvaluacionDictamen | null
  supervision?: Supervision
  claude?: { configurada: boolean; sesion?: string | null }
}) {
  const o = v.orden
  const tone = RIESGO_TONE[o.riesgo as keyof typeof RIESGO_TONE] ?? 'neutral'
  // Mientras no haya PR, el propietario pide a Claude que ejecute la orden con este texto.
  const textoOrden = canWrite && !prDetectado ? textoParaEjecutarDeOrden(o) : null
  return (
    <article className="card" aria-labelledby={`orden-${o.id}`}>
      <header className="card-head">
        <h3 id={`orden-${o.id}`} className="card-title"><span className="mono">{o.id}</span> · <Text value={o.titulo} empty="Sin título" /></h3>
        <div className="badges">
          <StateBadge code={o.estado} />
          <Badge tone={tone}>Riesgo: {o.riesgo ?? '—'}</Badge>
          {o.riesgo === 'MEDIO' ? <Badge>{ordenSensible(o.sensible) ? 'Sensible' : 'No sensible'}</Badge> : null}
        </div>
      </header>
      <dl className="meta">
        <div><dt>Proyecto</dt><dd>{o.proyectoId ? <Link href={`/proyectos/${encodeURIComponent(o.proyectoId)}`}>{o.proyectoId}</Link> : <span className="muted">—</span>}</dd></div>
        <div><dt>Tarea</dt><dd>{o.tareaId ? <Link href={`/tareas/${encodeURIComponent(o.tareaId)}/editar`} className="mono">{o.tareaId}</Link> : <span className="muted">—</span>}</dd></div>
        <div><dt>Siguiente paso</dt><dd>{v.siguiente ? v.siguiente.texto : <span className="muted">—</span>}</dd></div>
        {o.prUrl && dictamen !== undefined ? (
          <>
            <div><dt>Dictamen</dt><dd><DictamenFila prUrl={o.prUrl} ev={dictamen} fallo={falloPr} /></dd></div>
            {dictamen ? <div><dt>Siguiente (revisión)</dt><dd>{dictamen.siguiente}</dd></div> : null}
          </>
        ) : null}
        <div><dt>Actualizada</dt><dd><DateText value={o.actualizadoEn} /></dd></div>
        <div><dt>Issue</dt><dd>{o.issueUrl ? <ExternalLink href={o.issueUrl}>{o.issueUrl.replace(/^https:\/\/github\.com\//, '')}</ExternalLink> : <span className="muted">Sin issue</span>}</dd></div>
        <div><dt>PR</dt><dd><PrFila prUrl={o.prUrl} prDetectado={prDetectado} falloPr={falloPr} falloLanzamiento={falloLanzamiento} /></dd></div>
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
      {textoOrden ? <CopiarParaClaude ordenId={o.id} texto={textoOrden} /> : null}
      {canWrite && v.estado && v.estado !== 'CERRADA' && v.estado !== 'CANCELADA' ? (
        <OrderActions ordenId={o.id} estado={v.estado} canApprove={v.estado === 'BORRADOR' && v.problemas.length === 0} prDetectado={prDetectado?.url} claude={claude} supervision={supervision} prFusionado={prFusionado} />
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
  if (!result.ok) return <><h1>Órdenes</h1><LoadError result={result} /></>
  const data = result.data
  const r = resumenOrdenes(data)
  const total = data.ordenes.length
  const canWrite = writeAccess(user.email).allowed
  // PRs de las órdenes ENVIADA (solo lectura en GitHub; si falla, simplemente no se muestran).
  const client = canWrite ? githubClient() : null
  const prs = new Map<string, { url: string; estado: string }>()
  // Ejecución automática con Claude (F5a): solo si la rutina está configurada; la sesión ya lanzada se lee del issue.
  const rutina = canWrite && routineClient() !== null
  const sesiones = new Map<string, string | null>()
  const fallos = new Map<string, string>()
  const fallosLanzamiento = new Map<string, string>()
  // El panel sigue funcionando sin la detección; queda el código, nunca el token ni el cuerpo.
  const registrarFallo = (mapa: Map<string, string>, id: string, texto: string, error: unknown): undefined => {
    mapa.set(id, codigoFalloGitHub(error))
    console.warn(`[project-os] ${texto}: ${mapa.get(id)}`)
  }
  // Cierre asistido (ORD-POS-046): órdenes cuyo PR (detectado o registrado) ya está fusionado y lleva su ID en el título.
  const cierres = new Set<string>()
  if (client) {
    await Promise.all(data.ordenes.filter((o) => o.estado === 'ENVIADA' && o.proyectoId).map(async (o) => {
      // Si falla la detección queda undefined (no null): no se lee el lanzamiento y la tarjeta dice cuál de las dos falló.
      const pr = await client.prDeOrden(o.proyectoId!, o.id).catch((e) => registrarFallo(fallos, o.id, 'detección de PR fallida', e))
      if (pr?.estado === 'fusionado') cierres.add(o.id)
      if (pr) prs.set(o.id, pr)
      else if (pr === null && rutina && o.issueUrl) {
        await client.lanzamientoPrevio(o.proyectoId!, o.issueUrl).then((s) => { sesiones.set(o.id, s) }, (e) => registrarFallo(fallosLanzamiento, o.id, 'lectura de lanzamientos fallida', e))
      }
    }))
    await Promise.all(data.ordenes.filter((o) => o.proyectoId && o.prUrl && (o.estado === 'PR_ABIERTO' || o.estado === 'REVISADA')).map(async (o) => {
      const pr = await client.prParaCierre(o.proyectoId!, o.id, o.prUrl!).catch(() => null)
      if (pr?.fusionado && pr.deLaOrden) cierres.add(o.id)
    }))
  }

  // Dictamen vigente de las órdenes con PR (solo lectura en GitHub; null = «Sin datos de GitHub»).
  const dictamenes = new Map<string, EvaluacionDictamen | null>()
  const lector = githubClient()
  const rutinas: RutinasSupervision = canWrite ? rutinasSupervision() : { revisar: null, segundo: null, corregir: null }
  await Promise.all(data.ordenes.filter((o) => o.prUrl && (o.estado === 'PR_ABIERTO' || o.estado === 'REVISADA')).map(async (o) => {
    dictamenes.set(o.id, lector ? await dictamenDeOrden(lector, o) : null)
    const fallo = falloDictamen(o.prUrl!)
    if (fallo) fallos.set(o.id, fallo)
  }))
  // Lanzamientos y reservas de la clave del plan actual (AUDITORIA, solo para escritores; si falla, se muestra el botón y el servidor decide).
  const lanzamientos = new Map<string, EstadoLanzamiento>()
  const claves = [...dictamenes].flatMap(([id, ev]) => ev?.plan ? [claveLanzamiento(id, ev.plan)] : [])
  const servicio = canWrite && claves.length > 0 ? operationsService() : null
  if (servicio) for (const [c, e] of await servicio.lanzamientosPorClave(claves).catch(() => new Map<string, EstadoLanzamiento>())) lanzamientos.set(c, e)

  return (
    <>
      <h1>Órdenes</h1>
      <Freshness data={data} />
      <TabWarnings data={data} tabs={['ORDENES_CODEX', 'TAREAS']} />
      {canWrite ? <p><a className="button button-primary" href="/ordenes/nueva">Nueva orden</a></p> : null}
      <p className="muted small">
        Lectura de la pestaña ORDENES_CODEX. Solo el propietario aprueba; una orden cerrada no cierra su tarea.
      </p>
      <p className="muted small">
        Revisión de MEDIO: basta un CONFORME de PRIMERO o DELTA si la orden no es sensible (SENSIBLE = NO). Si es sensible
        (SENSIBLE vacía o SI), falta además un SEGUNDO de otro modelo; si es gemini-supervisado, lo firma un modelo distinto
        del implementador (DEC-POS-019 y DEC-POS-022).
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
            {items.length === 0 ? <Empty>{g.vacio}</Empty> : <div className="stack">{items.map((v) => <OrdenCard key={v.orden.id} v={v} canWrite={canWrite} prDetectado={prs.get(v.orden.id)} falloPr={fallos.get(v.orden.id)} falloLanzamiento={fallosLanzamiento.get(v.orden.id)} dictamen={dictamenes.get(v.orden.id)} prFusionado={cierres.has(v.orden.id)} supervision={botonSupervision(v.orden.id, dictamenes.get(v.orden.id), rutinas, lanzamientos)} claude={rutina ? { configurada: true, sesion: sesiones.get(v.orden.id) ?? null } : undefined} />)}</div>}
          </Section>
        )
      })}
    </>
  )
}
