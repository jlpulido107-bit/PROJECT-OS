import { Etiqueta } from '@/components/planning/hoy'
import { Badge, ExternalLink } from '@/components/ui'
import { MOTIVO_SIN_COMMIT } from '@/lib/despliegue'
import { MOTIVO_F5 } from '@/lib/esperando'
import type { CapaFlujo, EstadoPaso, LineaFlujo, Quien } from '@/lib/planificacion-flujo'

/**
 * Capa Flujo de /planificacion (ORD-POS-123, diseño §4). Solo pinta lo que calcula lib/planificacion-flujo.ts. Cada paso
 * lleva su símbolo y su estado en texto (no solo color); «sin datos» y «apagada» dicen su motivo.
 */

const SIMBOLO: Record<EstadoPaso, string> = {
  hecho: '●', actual: '◉', pendiente: '○', 'no-aplica': '·', 'sin-datos': '?', apagada: '–',
}
const TEXTO: Record<EstadoPaso, string> = {
  hecho: 'hecho', actual: 'paso actual', pendiente: 'pendiente', 'no-aplica': 'no aplica', 'sin-datos': 'sin datos', apagada: 'fuente apagada',
}
const QUIEN: Record<Quien, string> = { propietario: 'a ti', claude: 'a Claude', revisor: 'al revisor' }

function Linea({ l }: { l: LineaFlujo }) {
  return (
    <li>
      <article className="card" aria-labelledby={`flujo-${l.ordenId}`}>
        <header className="card-head">
          <h3 id={`flujo-${l.ordenId}`}><Etiqueta e={l.etiqueta} href={`/ordenes#orden-${l.ordenId}`} /></h3>
          <span className="small">
            {l.riesgo ?? 'sin riesgo'}{l.riesgo === 'MEDIO' ? (l.sensible ? ' · sensible' : ' · no sensible') : null}
          </span>
        </header>
        <ol className="plain badges" aria-label="Pasos de la orden">
          {l.pasos.map((p) => (
            <li key={p.paso} title={p.motivo}>
              <Badge tone={p.estado === 'actual' ? 'warn' : p.estado === 'hecho' ? 'ok' : 'muted'}>
                <span aria-hidden="true">{SIMBOLO[p.estado]} </span>{p.paso}
                <span className="visually-hidden">: {TEXTO[p.estado]}</span>
              </Badge>
            </li>
          ))}
        </ol>
        <p className="small">
          {l.espera.quien ? <><strong>Espera {QUIEN[l.espera.quien]}:</strong> {l.espera.texto}</> : <span className="muted">{l.espera.texto}</span>}
          {l.pr ? <> · <ExternalLink href={l.pr.url}>{`PR #${l.pr.numero}`}</ExternalLink></> : null}
        </p>
        {l.pasos.some((p) => p.estado === 'sin-datos' || p.estado === 'no-aplica') ? (
          <ul className="muted small">
            {l.pasos.filter((p) => p.estado === 'sin-datos' || p.estado === 'no-aplica').map((p) => <li key={p.paso}>{p.paso}: {p.motivo}</li>)}
          </ul>
        ) : null}
      </article>
    </li>
  )
}

export function FlujoView({ capa }: { capa: CapaFlujo }) {
  return (
    <section aria-labelledby="flujo-titulo" className="stack">
      <header className="card-head">
        <h2 id="flujo-titulo">Flujo de las órdenes</h2>
        {capa.estado === 'ok' ? (
          <span>
            Esperan por ti: {capa.encabezado.propietario} · por Claude: {capa.encabezado.claude} · por revisor: {capa.encabezado.revisor}
          </span>
        ) : null}
      </header>
      {capa.estado === 'sin-datos' ? (
        <div className="alert alert-warn" role="note"><p><strong>Sin datos.</strong> {capa.motivo}</p></div>
      ) : (
        <>
          <p className="muted small">
            ● hecho · ◉ paso actual · ○ pendiente · · no aplica · ? sin datos · – fuente apagada.
            {capa.commit ? ' Desplegada: solo PROJECT-OS (el dashboard).' : ` Desplegada: ${MOTIVO_SIN_COMMIT}`} Activada: {MOTIVO_F5}
            {capa.github === 'sin-token' ? ' Sin token de GitHub en este servidor: lo que sale de GitHub queda sin datos.' : null}
            {capa.github === 'parcial' ? ' Parte de GitHub no se leyó en esta carga: se intenta en la siguiente; esas órdenes no cuentan en el encabezado.' : null}
          </p>
          {capa.lineas.length === 0 ? <p className="muted">No hay órdenes abiertas.</p> : (
            <ol className="plain stack" aria-label="Órdenes abiertas y su paso">
              {capa.lineas.map((l) => <Linea key={l.ordenId} l={l} />)}
            </ol>
          )}
        </>
      )}
    </section>
  )
}
