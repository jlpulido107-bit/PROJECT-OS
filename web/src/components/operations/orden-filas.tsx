import { Badge, ExternalLink } from '@/components/ui'
import { urlComentario } from '@/lib/operations/dictamenes'
import type { EvaluacionDictamen } from '@/lib/supervision/dictamen'

const SIN_DICTAMEN = { anterior: 'Dictamen de un head anterior', invalido: 'Dictamen no válido', ninguno: 'Sin dictamen del head actual' } as const
const repoPr = (url: string) => url.replace(/^https:\/\/github\.com\//, '')

/** Dictamen vigente del PR (texto plano: solo campos validados, nunca el contenido del comentario). */
export function DictamenFila({ prUrl, ev, fallo }: { prUrl: string; ev: EvaluacionDictamen | null | undefined; fallo?: string | null }) {
  if (!ev) return <>Sin datos de GitHub{fallo ? ` (${fallo})` : ''}</>
  const aviso = ev.ciDetectada ? ' · este repo ya tiene CI: quítalo de REPOS_SIN_CI' : ''
  if (ev.estado.tipo !== 'vigente') return <>{SIN_DICTAMEN[ev.estado.tipo]}{aviso}</>
  const d = ev.estado.dictamen
  const href = urlComentario(prUrl, d.comentarioId)
  return (
    <>
      {d.veredicto} · ronda {d.ronda} · {d.bloquean} bloquean, {d.noBloquean} no{d.sinCi ? ' · sin CI · pruebas del revisor' : ''} · <span className="mono">{d.sha}</span>{aviso}
      {href ? <> · <ExternalLink href={href}>Ver dictamen</ExternalLink></> : null}
    </>
  )
}

/** PR de la orden: registrado, detectado, sin PR o el fallo de lectura de GitHub, distinguiendo PR y lanzamientos (ORD-POS-048). */
export function PrFila({ prUrl, prDetectado, falloPr, falloLanzamiento }: { prUrl: string | null; prDetectado?: { url: string; estado: string }; falloPr?: string; falloLanzamiento?: string }) {
  if (!prUrl && prDetectado) return <><ExternalLink href={prDetectado.url}>{repoPr(prDetectado.url)}</ExternalLink> <Badge tone="info">Detectado: {prDetectado.estado}</Badge></>
  if (prUrl) return <ExternalLink href={prUrl}>{repoPr(prUrl)}</ExternalLink>
  if (falloPr) return <span className="muted">Detección de PR fallida ({falloPr})</span>
  return <span className="muted">Sin PR{falloLanzamiento ? ` · Lectura de lanzamientos fallida (${falloLanzamiento})` : ''}</span>
}
