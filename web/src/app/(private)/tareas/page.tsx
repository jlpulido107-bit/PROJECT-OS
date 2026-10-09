import type { Metadata } from 'next'
import Link from 'next/link'
import { Freshness, LoadError, TabWarnings } from '@/components/data-state'
import { TaskCard } from '@/components/task-card'
import { Empty, humanize, Pagination } from '@/components/ui'
import {
  distinctValues, FILTER_EMPTY_VALUE, filterTasks, paginate, parseTaskFilters, sortTasks, type TaskFilters,
} from '@/lib/aggregate'
import { privateData } from '@/lib/page-data'

export const metadata: Metadata = { title: 'Tareas' }

const PAGE_SIZE = 25

type Search = Record<string, string | string[] | undefined>

export default async function TasksPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams
  const { result } = await privateData('/tareas')
  if (!result.ok) return <><h1>Tareas</h1><LoadError result={result} /></>
  const data = result.data
  const filters = parseTaskFilters(params)
  const filtered = sortTasks(filterTasks(data.tareas, filters))
  const page = paginate(filtered, params.pagina, PAGE_SIZE)
  const active = Object.values(filters).some((v) => v !== undefined)

  return (
    <>
      <h1>Tareas</h1>
      <Freshness data={data} />
      <TabWarnings data={data} tabs={['TAREAS', 'DEPENDENCIAS']} />
      <Filters data={data} filters={filters} />
      <p role="status" className="result-count">
        {page.total === 0 ? 'Ninguna tarea coincide' : `Mostrando ${page.from}–${page.to} de ${page.total} tareas`}
        {active ? <> · <Link href="/tareas">Quitar filtros</Link></> : null}
      </p>
      {data.tareas.length === 0 ? (
        <Empty>No hay tareas registradas en la pestaña TAREAS.</Empty>
      ) : page.total === 0 ? (
        <Empty>Ninguna tarea coincide con los filtros. Las fechas filtran por FECHA_LIMITE (o FECHA_PLAN si no hay límite); tareas sin fecha se excluyen al filtrar por fecha.</Empty>
      ) : (
        <div className="stack">{page.items.map((t) => <TaskCard key={t.id} task={t} data={data} />)}</div>
      )}
      <Pagination page={page} basePath="/tareas" params={{ ...filters }} />
    </>
  )
}

function Select({ name, label, value, options, emptyLabel }: {
  name: string; label: string; value: string | undefined; options: Array<[string, string]>; emptyLabel?: string
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select name={name} defaultValue={value ?? ''}>
        <option value="">Todos</option>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        {emptyLabel ? <option value={FILTER_EMPTY_VALUE}>{emptyLabel}</option> : null}
      </select>
    </label>
  )
}

function Filters({ data, filters }: { data: Parameters<typeof TaskCard>[0]['data']; filters: TaskFilters }) {
  const t = data.tareas
  const asOptions = (values: string[], human = false): Array<[string, string]> => values.map((v) => [v, human ? humanize(v) : v])
  return (
    <form className="filters" method="get" action="/tareas" aria-label="Filtrar tareas">
      <label className="field field-wide">
        <span>Buscar</span>
        <input type="search" name="q" defaultValue={filters.q ?? ''} placeholder="ID, título o descripción" maxLength={120} />
      </label>
      <Select name="proyecto" label="Proyecto" value={filters.proyecto}
        options={data.proyectos.map((p) => [p.id, `${p.id}${p.nombre ? ` · ${p.nombre}` : ''}`])} emptyLabel="Sin proyecto" />
      <Select name="estado" label="Estado" value={filters.estado} options={asOptions(distinctValues(t, (x) => x.estado), true)} emptyLabel="Sin estado" />
      <Select name="responsable" label="Responsable" value={filters.responsable} options={asOptions(distinctValues(t, (x) => x.responsable))} emptyLabel="Sin responsable" />
      <Select name="prioridad" label="Prioridad" value={filters.prioridad} options={asOptions(distinctValues(t, (x) => x.prioridad), true)} emptyLabel="Sin prioridad" />
      <label className="field">
        <span>Bloqueo</span>
        <select name="bloqueo" defaultValue={filters.bloqueo ?? ''}>
          <option value="">Todas</option>
          <option value="si">Solo bloqueadas</option>
          <option value="no">Sin bloqueo</option>
        </select>
      </label>
      <label className="field">
        <span>Fecha desde</span>
        <input type="date" name="desde" defaultValue={filters.desde ?? ''} />
      </label>
      <label className="field">
        <span>Fecha hasta</span>
        <input type="date" name="hasta" defaultValue={filters.hasta ?? ''} />
      </label>
      <div className="filter-actions">
        <button type="submit" className="button button-primary">Aplicar filtros</button>
      </div>
    </form>
  )
}
