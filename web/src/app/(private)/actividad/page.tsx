import type { Metadata } from 'next'
import Link from 'next/link'
import { Freshness, LoadError, TabWarnings } from '@/components/data-state'
import { EVIDENCE_CLASS_LABEL, EvidenceItem } from '@/components/evidence-item'
import { Empty, Pagination } from '@/components/ui'
import { classifyEvidence, distinctValues, indexTasks, paginate, type EvidenceClass } from '@/lib/aggregate'
import { privateData } from '@/lib/page-data'

export const metadata: Metadata = { title: 'Actividad' }

const PAGE_SIZE = 30
const CLASSES = Object.keys(EVIDENCE_CLASS_LABEL) as EvidenceClass[]

type Search = Record<string, string | string[] | undefined>
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim().slice(0, 120) || undefined

export default async function ActivityPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams
  const { result } = await privateData('/actividad')
  if (!result.ok) return <><h1>Actividad</h1><LoadError result={result} /></>
  const data = result.data
  const tasks = indexTasks(data.tareas)

  const proyecto = one(params.proyecto)
  const fuente = one(params.fuente)
  const claseParam = one(params.clase)
  const clase = CLASSES.includes(claseParam as EvidenceClass) ? (claseParam as EvidenceClass) : undefined

  const filtered = data.evidencias
    .filter((e) => (!proyecto || e.proyectoId === proyecto) && (!fuente || e.fuente === fuente) && (!clase || classifyEvidence(e, tasks) === clase))
    .sort((a, b) => (b.fecha ?? '').localeCompare(a.fecha ?? '') || b.id.localeCompare(a.id))
  const page = paginate(filtered, params.pagina, PAGE_SIZE)

  return (
    <>
      <h1>Actividad y evidencias</h1>
      <Freshness data={data} />
      <TabWarnings data={data} tabs={['EVIDENCIAS', 'TAREAS']} />
      <div className="alert alert-info">
        <p>
          <strong>Evento observado</strong> = actividad confirmada en su fuente (commit, PR, ejecución de CI); no implica avance.{' '}
          <strong>Tarea validada</strong> = la evidencia está vinculada a una tarea cuyo estado COMPLETADO fue registrado por una persona en Sheets.
        </p>
      </div>
      <form className="filters" method="get" action="/actividad" aria-label="Filtrar actividad">
        <label className="field">
          <span>Proyecto</span>
          <select name="proyecto" defaultValue={proyecto ?? ''}>
            <option value="">Todos</option>
            {distinctValues(data.evidencias, (e) => e.proyectoId).map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Fuente</span>
          <select name="fuente" defaultValue={fuente ?? ''}>
            <option value="">Todas</option>
            {distinctValues(data.evidencias, (e) => e.fuente).map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Clasificación</span>
          <select name="clase" defaultValue={clase ?? ''}>
            <option value="">Todas</option>
            {CLASSES.map((c) => <option key={c} value={c}>{EVIDENCE_CLASS_LABEL[c]}</option>)}
          </select>
        </label>
        <div className="filter-actions"><button type="submit" className="button button-primary">Aplicar filtros</button></div>
      </form>
      <p role="status" className="result-count">
        {page.total === 0 ? 'Ninguna evidencia coincide' : `Mostrando ${page.from}–${page.to} de ${page.total} evidencias`}
        {proyecto || fuente || clase ? <> · <Link href="/actividad">Quitar filtros</Link></> : null}
      </p>
      {data.evidencias.length === 0 ? (
        <Empty>No hay evidencias registradas en la pestaña EVIDENCIAS.</Empty>
      ) : page.total === 0 ? (
        <Empty>Ninguna evidencia coincide con los filtros.</Empty>
      ) : (
        <ul className="stack plain">
          {page.items.map((e) => <li key={e.id}><EvidenceItem evidence={e} tasks={tasks} /></li>)}
        </ul>
      )}
      <Pagination page={page} basePath="/actividad" params={{ proyecto, fuente, clase }} />
    </>
  )
}
