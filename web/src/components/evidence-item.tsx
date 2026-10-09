import { classifyEvidence, type EvidenceClass } from '@/lib/aggregate'
import type { Evidencia, Tarea } from '@/lib/types'
import { Badge, DateText, ExternalLink, humanize, Text } from './ui'

export const EVIDENCE_CLASS_LABEL: Record<EvidenceClass, string> = {
  'evento-observado': 'Evento observado',
  'vinculada-sin-validar': 'Vinculada · tarea no completada',
  'tarea-validada': 'Tarea validada (COMPLETADO)',
  'vinculo-roto': 'TAREA_ID inexistente',
}

const TONES: Record<EvidenceClass, 'info' | 'neutral' | 'ok' | 'danger'> = {
  'evento-observado': 'info',
  'vinculada-sin-validar': 'neutral',
  'tarea-validada': 'ok',
  'vinculo-roto': 'danger',
}

export function EvidenceItem({ evidence: e, tasks }: { evidence: Evidencia; tasks: Map<string, Tarea> }) {
  const kind = classifyEvidence(e, tasks)
  const task = e.tareaId ? tasks.get(e.tareaId) : undefined
  return (
    <article className="evidence">
      <div className="badges">
        <Badge tone={TONES[kind]}>{EVIDENCE_CLASS_LABEL[kind]}</Badge>
        <Badge tone="muted">{humanize(e.tipo)}</Badge>
        {e.verificacion ? (
          <Badge tone={e.verificacion === 'CONFIRMADO' ? 'ok' : 'neutral'} title="Verificación del evento en su fuente, no del cumplimiento de la tarea">
            Evento {humanize(e.verificacion).toLocaleLowerCase('es')}
          </Badge>
        ) : null}
      </div>
      <p className="evidence-desc"><Text value={e.descripcion} empty="Sin descripción" /></p>
      <p className="muted small">
        <DateText value={e.fecha} /> · <span className="mono">{e.proyectoId ?? 'sin proyecto'}</span> · Fuente: <Text value={e.fuente} />
        {e.tareaId ? <> · Tarea <span className="mono">{e.tareaId}</span>{task?.titulo ? ` (${task.titulo})` : ''}</> : null}
        {' · '}
        {e.referenciaUrl ? <ExternalLink href={e.referenciaUrl}>Abrir referencia</ExternalLink> : <span>Sin enlace válido</span>}
      </p>
    </article>
  )
}
