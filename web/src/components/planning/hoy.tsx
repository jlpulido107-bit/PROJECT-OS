import Link from 'next/link'
import { bloquesInstrucciones, Instrucciones } from '@/components/instrucciones'
import { CompleteTaskForm } from '@/components/operations/forms'
import { Badge } from '@/components/ui'
import { duracion, fechaCorta, type CapaHoy, type Etiqueta as EtiquetaDatos, type TarjetaHoy } from '@/lib/planificacion-v2'

/** Nombre primero y el ID después, pequeño y en monoespaciada, como enlace a su ficha (§2). */
export function Etiqueta({ e, href }: { e: EtiquetaDatos; href?: string }) {
  return (
    <>
      {e.nombre}
      {e.id ? (
        <>
          {' · '}
          {href ? <Link href={href} className="mono small">{e.id}</Link> : <span className="mono small">{e.id}</span>}
        </>
      ) : null}
    </>
  )
}

const fichaTarea = (id: string) => `/tareas?q=${encodeURIComponent(id)}`

function Tarjeta({ t, puedeCerrar }: { t: TarjetaHoy; puedeCerrar: boolean }) {
  const pasos = t.instrucciones ? bloquesInstrucciones(t.instrucciones).reduce((n, b) => n + (b.tipo === 'p' ? 0 : b.items.length), 0) : 0
  return (
    <li>
      <article className="card" aria-labelledby={`hoy-${t.tareaId}`}>
        <header className="card-head">
          <h3 id={`hoy-${t.tareaId}`}><Etiqueta e={t.etiqueta} href={fichaTarea(t.tareaId)} /></h3>
          <span>{duracion(t.minutos)}</span>
        </header>
        <p className="badges">
          <span>{t.proyecto ? <Etiqueta e={t.proyecto} /> : <span className="muted">Sin proyecto</span>}</span>
          {t.venceHoy ? <Badge tone="warn">vence hoy</Badge> : null}
          {t.vencida ? <Badge tone="danger">vencida</Badge> : null}
          {t.registradoMin > 0 ? <span className="muted">ya llevas {duracion(t.registradoMin)}</span> : null}
          {t.origen === 'propuesto' ? <span className="muted">propuesta del plan</span> : null}
        </p>
        {t.instrucciones ? (
          <details className="instrucciones-tarea">
            <summary>Instrucciones{pasos > 0 ? ` (${pasos} ${pasos === 1 ? 'paso' : 'pasos'})` : ''}</summary>
            <Instrucciones texto={t.instrucciones} />
          </details>
        ) : <p className="muted small">(sin instrucciones)</p>}
        {t.cierre === null ? (
          <p className="muted small">La tarea no está en TAREAS: no se puede cerrar desde aquí.</p>
        ) : puedeCerrar ? (
          <CompleteTaskForm key={`cerrar-${t.cierre.id}-${t.cierre.version}`} task={t.cierre} />
        ) : (
          <p className="muted small">El cierre lo hace el propietario.</p>
        )}
      </article>
    </li>
  )
}

/**
 * Capa Hoy de /planificacion (ORD-POS-120, diseño §3). Solo lectura: el único botón es `CompleteTaskForm` tal cual,
 * que se pinta solo si la sesión puede cerrar tareas (el guard del servidor lo vuelve a verificar).
 */
export function HoyView({ capa, puedeCerrar }: { capa: CapaHoy; puedeCerrar: boolean }) {
  const titulo = `Hoy · ${fechaCorta(capa.fecha)}`
  return (
    <section aria-labelledby="hoy-titulo" className="stack">
      <header className="card-head">
        <h2 id="hoy-titulo">{titulo}</h2>
        {capa.estado === 'ok' && capa.tarjetas.length > 0 ? (
          <span>
            {capa.tarjetas.length} {capa.tarjetas.length === 1 ? 'tarea' : 'tareas'} · {duracion(capa.totalMin)}
            {capa.capacidadMin !== null ? ` de ${duracion(capa.capacidadMin)}` : null}
          </span>
        ) : null}
      </header>
      {capa.estado === 'sin-datos' ? (
        <div className="alert alert-warn" role="note"><p><strong>Sin datos.</strong> {capa.motivo}</p></div>
      ) : capa.estado === 'no-laborable' ? (
        <div className="alert alert-info" role="note"><p>{capa.motivo}</p></div>
      ) : capa.tarjetas.length === 0 ? (
        <p className="muted">Nada planeado para hoy.</p>
      ) : (
        <ol className="plain stack" aria-label="Tareas de hoy en el orden del plan">
          {capa.tarjetas.map((t) => <Tarjeta key={t.tareaId} t={t} puedeCerrar={puedeCerrar} />)}
        </ol>
      )}
      {capa.estado !== 'sin-datos' && capa.fueraDelPlan.length > 0 ? (
        <p>
          <strong>También vencen hoy, fuera del plan:</strong>{' '}
          {capa.fueraDelPlan.map((v, i) => (
            <span key={v.tareaId}>{i > 0 ? '; ' : ''}<Etiqueta e={v.etiqueta} href={fichaTarea(v.tareaId)} /></span>
          ))}
        </p>
      ) : null}
    </section>
  )
}
