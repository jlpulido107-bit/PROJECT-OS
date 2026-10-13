import Link from 'next/link'
import type { ReactNode } from 'react'
import { formatCivilDate } from '@/lib/dates'
import type { Page } from '@/lib/aggregate'

/** "POR_DIAGNOSTICAR" → "Por diagnosticar". */
export function humanize(code: string | null): string {
  if (!code) return '—'
  const text = code.replace(/_/g, ' ').toLocaleLowerCase('es')
  return text.charAt(0).toLocaleUpperCase('es') + text.slice(1)
}

type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'muted'

const STATE_TONES: Record<string, Tone> = {
  COMPLETADO: 'ok', EXITOSA: 'ok', CONFIRMADO: 'ok', APROBADA: 'ok', ACTIVA: 'info',
  EN_PROGRESO: 'info', EN_CURSO: 'info',
  PENDIENTE: 'neutral', BORRADOR: 'neutral', POR_DIAGNOSTICAR: 'neutral', POR_VERIFICAR: 'neutral',
  ENVIADA: 'info', PR_ABIERTO: 'info', REVISADA: 'warn', CERRADA: 'ok',
  BLOQUEADO: 'danger', FALLIDA: 'danger', ERROR: 'danger', PARCIAL: 'warn', CANCELADO: 'muted',
  ALTA: 'warn', CRITICA: 'danger', MEDIA: 'neutral', BAJA: 'muted',
}

export function Badge({ children, tone = 'neutral', title }: { children: ReactNode; tone?: Tone; title?: string }) {
  return <span className={`badge badge-${tone}`} title={title}>{children}</span>
}

export function StateBadge({ code, label }: { code: string | null; label?: string }) {
  if (!code) return <Badge tone="muted">{label ? `${label}: sin valor` : 'Sin valor'}</Badge>
  return <Badge tone={STATE_TONES[code] ?? 'neutral'}>{label ? `${label}: ` : ''}{humanize(code)}</Badge>
}

/** Indicador que distingue "sin datos" de un valor real. */
export function Stat({
  label, value, hint, href, tone,
}: { label: string; value: ReactNode | null; hint?: ReactNode; href?: string; tone?: Tone }) {
  const body = (
    <>
      <span className="stat-label">{label}</span>
      {value === null ? (
        <span className="stat-value stat-empty">Sin datos</span>
      ) : (
        <span className={`stat-value${tone ? ` stat-${tone}` : ''}`}>{value}</span>
      )}
      {hint ? <span className="stat-hint">{hint}</span> : null}
    </>
  )
  return href ? <Link className="stat stat-link" href={href}>{body}</Link> : <div className="stat">{body}</div>
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty" role="note">{children}</p>
}

export function Section({ title, id, children, actions }: { title: string; id?: string; children: ReactNode; actions?: ReactNode }) {
  const headingId = id ? `${id}-titulo` : undefined
  return (
    <section className="section" aria-labelledby={headingId} id={id}>
      <div className="section-head">
        <h2 id={headingId}>{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  )
}

export function DateText({ value, empty = 'Sin fecha' }: { value: string | null; empty?: string }) {
  if (!value) return <span className="muted">{empty}</span>
  return <time dateTime={value}>{formatCivilDate(value)}</time>
}

export function Text({ value, empty = 'Sin registrar' }: { value: string | null; empty?: string }) {
  return value ? <>{value}</> : <span className="muted">{empty}</span>
}

/** Enlace externo seguro: solo URLs ya validadas (http/https). */
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
      <span className="visually-hidden"> (se abre en otra pestaña)</span>
    </a>
  )
}

export function Pagination({ page, basePath, params }: {
  page: Page<unknown>
  basePath: string
  params: Record<string, string | undefined>
}) {
  if (page.pageCount <= 1) return null
  const href = (n: number) => {
    const query = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v) query.set(k, v)
    query.set('pagina', String(n))
    return `${basePath}?${query.toString()}`
  }
  return (
    <nav className="pagination" aria-label="Paginación">
      {page.page > 1 ? <Link href={href(page.page - 1)} rel="prev">← Anterior</Link> : <span aria-hidden="true" />}
      <span>Página {page.page} de {page.pageCount}</span>
      {page.page < page.pageCount ? <Link href={href(page.page + 1)} rel="next">Siguiente →</Link> : <span aria-hidden="true" />}
    </nav>
  )
}
