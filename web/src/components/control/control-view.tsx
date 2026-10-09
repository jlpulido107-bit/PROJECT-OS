'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { Badge, Empty, Section } from '@/components/ui'
import { applyFilters, type ControlFilters } from '@/lib/governance/filters'
import type { GovernanceLabels } from '@/lib/governance/input'
import type { Alert, AlertType, Category, GovernanceReport, Severity } from '@/lib/governance/types'
import styles from './control.module.css'
import {
  CATEGORY_LABEL, CONFIDENCE_LABEL, COVERAGE_LABEL, entityHref, entityLabel, GLOBAL_TEXT, ruleLabel, SEVERITY_LABEL, SEVERITY_TONE, TYPE_LABEL,
} from './presentation'

/* ---------------------------------------------------------------------------------------------
 * Centro de control V1.6. La revisión (revisado / pospuesto / resolución propuesta) es LOCAL y SIMULADA:
 * vive solo en la memoria de esta pestaña, no se envía a ningún sitio y recargar la página la restablece.
 * Nada de lo que se marque aquí aprueba, cierra, envía ni ejecuta acciones.
 * ------------------------------------------------------------------------------------------- */

type ReviewState =
  | { estado: 'revisado' }
  | { estado: 'pospuesto'; hasta: string }
  | { estado: 'resolucion-propuesta'; propuesta: string }

type ReviewFilter = 'todas' | 'pendientes' | 'revisado' | 'pospuesto' | 'resolucion-propuesta'

const SEVERITIES: Severity[] = ['critica', 'alta', 'media', 'baja', 'info']
const CATEGORIES = Object.keys(CATEGORY_LABEL) as Category[]
const TYPES = Object.keys(TYPE_LABEL) as AlertType[]
const REVIEW_LABEL: Record<ReviewState['estado'], string> = {
  revisado: 'Revisado (local)', pospuesto: 'Pospuesto (local)', 'resolucion-propuesta': 'Resolución propuesta (local, no aplicada)',
}

function addDays(civil: string, days: number): string {
  const [y, m, d] = civil.split('-').map(Number) as [number, number, number]
  const date = new Date(Date.UTC(y, m - 1, d + days))
  return date.toISOString().slice(0, 10)
}

export function ControlView({ report, labels, initialFilters, filterError, focusId }: {
  report: GovernanceReport
  labels: GovernanceLabels
  initialFilters: ControlFilters
  filterError: string | null
  focusId: string | null
}) {
  const [filters, setFilters] = useState<ControlFilters>(initialFilters)
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('todas')
  const [reviews, setReviews] = useState<Record<string, ReviewState>>({})

  const visible = useMemo(() => {
    const base = applyFilters(report.alertas, filters)
    return base.filter((a) => {
      const r = reviews[a.id]
      if (reviewFilter === 'todas') return true
      if (reviewFilter === 'pendientes') return !r
      return r?.estado === reviewFilter
    })
  }, [report.alertas, filters, reviewFilter, reviews])

  const reviewedCount = Object.keys(reviews).length
  const global = GLOBAL_TEXT[report.estadoGlobal]
  const setReview = (id: string, state: ReviewState | null) => setReviews((prev) => {
    const next = { ...prev }
    if (state) next[id] = state
    else delete next[id]
    return next
  })
  const projectName = (id: string | null) => (id ? labels.proyectos[id] ?? null : null)

  return (
    <div className={styles.root}>
      <div className={styles.simBanner} role="status">
        <p>
          <strong>Simulación — no se guardaron cambios.</strong> Marcar como revisado, posponer o proponer una resolución solo
          vive en esta pestaña: recargar la página lo restablece. Nada se aprueba, cierra, envía ni escribe en Google Sheets.
        </p>
        <button type="button" className="button" onClick={() => setReviews({})} disabled={reviewedCount === 0}>Descartar revisión local</button>
      </div>
      {filterError ? <p className="alert alert-warn" role="alert">{filterError}</p> : null}

      <section className={`${styles.global} ${styles[`tone_${global.tone}`]}`} aria-labelledby="estado-global">
        <h2 id="estado-global">Estado: {global.titulo}</h2>
        <p>{global.detalle}</p>
        <p className="small">Referencia {report.referencia.fecha} ({report.referencia.zona}) · semana {report.referencia.semana.lunes} a {report.referencia.semana.domingo} · {report.resumen.total} alertas · huella <span className="mono">{report.huella}</span></p>
      </section>

      <div className="stats" aria-label="Alertas por severidad">
        {SEVERITIES.filter((s) => s !== 'info').map((s) => (
          <button key={s} type="button" className={`stat ${styles.statButton}`} aria-pressed={filters.severidad === s} onClick={() => setFilters({ ...filters, severidad: filters.severidad === s ? undefined : s })}>
            <span className="stat-label">{SEVERITY_LABEL[s]}</span>
            <span className={`stat-value${s === 'critica' || s === 'alta' ? ' stat-danger' : s === 'media' ? ' stat-warn' : ''}`}>{report.resumen.porSeveridad[s]}</span>
          </button>
        ))}
        <div className="stat"><span className="stat-label">Revisión local</span><span className="stat-value">{reviewedCount}/{report.resumen.total}</span><span className="stat-hint">no se guarda</span></div>
      </div>

      <Section title="Cobertura por categoría" id="cobertura">
        <ul className={styles.coverage}>
          {report.cobertura.map((c) => (
            <li key={c.categoria}>
              <button type="button" className={`button ${styles.coverageButton}`} aria-pressed={filters.categoria === c.categoria} onClick={() => setFilters({ ...filters, categoria: filters.categoria === c.categoria ? undefined : c.categoria })}>
                <span>{CATEGORY_LABEL[c.categoria]}</span>
                <Badge tone={c.estado === 'con-alertas' ? 'warn' : c.estado === 'sin-datos' ? 'danger' : 'muted'}>
                  {c.estado === 'con-alertas' ? `${c.alertas} ${c.alertas === 1 ? 'alerta' : 'alertas'}` : COVERAGE_LABEL[c.estado]}
                </Badge>
              </button>
              {c.pestanasFaltantes.length ? <span className="small muted"> Falta: {c.pestanasFaltantes.join(', ')}</span> : null}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Por proyecto" id="proyectos">
        <div className="table-wrap" role="region" aria-label="Alertas por proyecto" tabIndex={0}>
          <table>
            <thead><tr><th scope="col">Proyecto</th><th scope="col">Estado</th><th scope="col">Alertas</th><th scope="col">Críticas / altas</th><th scope="col">Filtro</th></tr></thead>
            <tbody>
              {report.proyectos.map((p) => (
                <tr key={p.id}>
                  <th scope="row"><span className="mono">{p.id}</span>{projectName(p.id) ? <><br /><span className="small">{projectName(p.id)}</span></> : null}</th>
                  <td>{!p.registrado ? <Badge tone="danger">No registrado</Badge> : p.activo === false ? <Badge tone="muted">Inactivo</Badge> : <Badge tone="info">Activo</Badge>}</td>
                  <td>{p.total}</td>
                  <td>{p.porSeveridad.critica + p.porSeveridad.alta}</td>
                  <td><button type="button" className="button" aria-pressed={filters.proyecto === p.id} onClick={() => setFilters({ ...filters, proyecto: filters.proyecto === p.id ? undefined : p.id })}>{filters.proyecto === p.id ? 'Quitar filtro' : 'Ver'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Bandeja de atención" id="bandeja">
        <form className={styles.filters} onSubmit={(e) => e.preventDefault()} aria-label="Filtros de la bandeja">
          <div className="field"><label htmlFor="f-proyecto">Proyecto</label>
            <select id="f-proyecto" value={filters.proyecto ?? ''} onChange={(e) => setFilters({ ...filters, proyecto: e.target.value || undefined })}>
              <option value="">Todos</option>
              {report.proyectos.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
              <option value="sin-proyecto">Sin proyecto</option>
            </select>
          </div>
          <div className="field"><label htmlFor="f-categoria">Categoría</label>
            <select id="f-categoria" value={filters.categoria ?? ''} onChange={(e) => setFilters({ ...filters, categoria: (e.target.value || undefined) as Category | undefined })}>
              <option value="">Todas</option>
              {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
            </select>
          </div>
          <div className="field"><label htmlFor="f-severidad">Severidad</label>
            <select id="f-severidad" value={filters.severidad ?? ''} onChange={(e) => setFilters({ ...filters, severidad: (e.target.value || undefined) as Severity | undefined })}>
              <option value="">Todas</option>
              {SEVERITIES.map((s) => <option key={s} value={s}>{SEVERITY_LABEL[s]}</option>)}
            </select>
          </div>
          <div className="field"><label htmlFor="f-tipo">Tipo</label>
            <select id="f-tipo" value={filters.tipo ?? ''} onChange={(e) => setFilters({ ...filters, tipo: (e.target.value || undefined) as AlertType | undefined })}>
              <option value="">Todos</option>
              {TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
            </select>
          </div>
          <div className="field"><label htmlFor="f-revision">Revisión local</label>
            <select id="f-revision" value={reviewFilter} onChange={(e) => setReviewFilter(e.target.value as ReviewFilter)}>
              <option value="todas">Todas</option>
              <option value="pendientes">Sin revisar</option>
              <option value="revisado">Revisadas</option>
              <option value="pospuesto">Pospuestas</option>
              <option value="resolucion-propuesta">Con resolución propuesta</option>
            </select>
          </div>
          <div className={styles.filterActions}>
            <button type="button" className="button button-ghost" onClick={() => { setFilters({}); setReviewFilter('todas') }}>Limpiar filtros</button>
          </div>
        </form>
        <p className="muted small" role="status" aria-live="polite">Mostrando {visible.length} de {report.alertas.length} alertas.</p>
        {visible.length === 0 ? (
          <Empty>{report.alertas.length === 0 ? GLOBAL_TEXT[report.estadoGlobal].detalle : 'Ninguna alerta coincide con los filtros.'}</Empty>
        ) : (
          <ul className={styles.alertList}>
            {visible.map((a) => (
              <AlertCard key={a.id} alert={a} labels={labels} review={reviews[a.id]} onReview={(s) => setReview(a.id, s)} refDate={report.referencia.fecha} focused={a.id === focusId} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}

function AlertCard({ alert, labels, review, onReview, refDate, focused }: {
  alert: Alert
  labels: GovernanceLabels
  review: ReviewState | undefined
  onReview: (s: ReviewState | null) => void
  refDate: string
  focused: boolean
}) {
  const [mode, setMode] = useState<'none' | 'posponer' | 'proponer'>('none')
  const [until, setUntil] = useState(addDays(refDate, 7))
  const [text, setText] = useState('')
  const headingId = `alerta-${alert.id}`
  const label = (e: Alert['entidades'][number]) =>
    e.tipo === 'tarea' ? labels.tareas[e.id] : e.tipo === 'hito' ? labels.hitos[e.id] : e.tipo === 'decision' ? labels.decisiones[e.id] : e.tipo === 'proyecto' ? labels.proyectos[e.id] : undefined

  return (
    <li id={`a-${alert.id}`} className={`card ${styles.alert} ${styles[`sev_${alert.severidad}`]}${review ? ` ${styles.reviewed}` : ''}`} aria-labelledby={headingId}>
      <details open={focused}>
        <summary className={styles.summary}>
          <span id={headingId} className={styles.title}>{ruleLabel(alert.regla)}</span>
          <span className="badges">
            <Badge tone={SEVERITY_TONE[alert.severidad]}>{SEVERITY_LABEL[alert.severidad]}</Badge>
            <Badge tone="neutral">{TYPE_LABEL[alert.tipo]}</Badge>
            <Badge tone={alert.confianza === 'baja' ? 'muted' : 'neutral'}>{CONFIDENCE_LABEL[alert.confianza]}</Badge>
            {alert.proyectoId ? <Badge tone="info">{alert.proyectoId}</Badge> : null}
            {review ? <Badge tone="ok">{REVIEW_LABEL[review.estado]}{review.estado === 'pospuesto' ? ` hasta ${review.hasta}` : ''}</Badge> : null}
          </span>
        </summary>
        <ul className={styles.entities} aria-label="Entidades relacionadas">
          {alert.entidades.map((e) => {
            const href = entityHref(e, alert)
            const name = label(e)
            const content = <><span className="small muted">{entityLabel(e.tipo)}</span> <span className="mono">{e.id}</span>{name ? ` · ${name}` : ''}</>
            return <li key={`${e.tipo}:${e.id}`}>{href ? <Link href={href}>{content}</Link> : content}</li>
          })}
        </ul>
        <Block title="Hechos registrados" items={alert.hechos} />
        <Block title="Inferencias (derivadas de los hechos)" items={alert.inferencias} />
        <Block title="Hipótesis (posibles riesgos, no hechos)" items={alert.hipotesis} />
        <Block title="Acción sugerida (no ejecutada)" items={alert.acciones} />
        {alert.categoria === 'decisiones' || alert.regla.startsWith('decision-') ? (
          <p className={`small ${styles.notice}`}>Una decisión registrada en Sheets no autoriza merges, despliegues, escrituras reales, gasto ni cambios de infraestructura: eso requiere una autorización explícita, específica y verificable.</p>
        ) : null}
        <div className={styles.review} role="group" aria-label="Revisión local (simulada)">
          {review ? (
            <>
              {review.estado === 'resolucion-propuesta' ? <p className="small">Propuesta local (no enviada): «{review.propuesta}»</p> : null}
              <button type="button" className="button" onClick={() => onReview(null)}>Deshacer (volver a pendiente)</button>
            </>
          ) : (
            <>
              <button type="button" className="button" onClick={() => onReview({ estado: 'revisado' })}>Marcar revisado</button>
              <button type="button" className="button" aria-expanded={mode === 'posponer'} onClick={() => setMode(mode === 'posponer' ? 'none' : 'posponer')}>Posponer…</button>
              <button type="button" className="button" aria-expanded={mode === 'proponer'} onClick={() => setMode(mode === 'proponer' ? 'none' : 'proponer')}>Proponer resolución…</button>
            </>
          )}
          {!review && mode === 'posponer' ? (
            <div className={styles.inline}>
              <div className="field"><label htmlFor={`pos-${alert.id}`}>Posponer hasta</label>
                <input id={`pos-${alert.id}`} type="date" value={until} min={refDate} onChange={(e) => setUntil(e.target.value)} />
              </div>
              <button type="button" className="button button-primary" disabled={!/^\d{4}-\d{2}-\d{2}$/.test(until) || until < refDate} onClick={() => { onReview({ estado: 'pospuesto', hasta: until }); setMode('none') }}>Posponer (local)</button>
            </div>
          ) : null}
          {!review && mode === 'proponer' ? (
            <div className={styles.inline}>
              <div className="field"><label htmlFor={`pro-${alert.id}`}>Resolución propuesta (borrador local, no se envía)</label>
                <textarea id={`pro-${alert.id}`} rows={2} maxLength={300} value={text} onChange={(e) => setText(e.target.value)} />
              </div>
              <button type="button" className="button button-primary" disabled={text.trim().length < 3} onClick={() => { onReview({ estado: 'resolucion-propuesta', propuesta: text.trim() }); setMode('none') }}>Guardar borrador local</button>
            </div>
          ) : null}
        </div>
        <p className="small muted">ID de alerta <span className="mono">{alert.id}</span> · <Link href={`/control?alerta=${encodeURIComponent(alert.id)}#a-${encodeURIComponent(alert.id)}`}>enlace directo</Link></p>
      </details>
    </li>
  )
}

function Block({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null
  return (
    <div className={styles.block}>
      <h3>{title}</h3>
      <ul className="list">{items.map((t, i) => <li key={i}>{t}</li>)}</ul>
    </div>
  )
}
