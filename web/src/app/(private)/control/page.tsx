import type { Metadata } from 'next'
import { ControlView } from '@/components/control/control-view'
import { Freshness, LoadError } from '@/components/data-state'
import { civilDateInZone, MERIDA_TZ } from '@/lib/dates'
import { buildGovernanceReport } from '@/lib/governance/engine'
import { FilterError, parseControlParams, type ControlFilters } from '@/lib/governance/filters'
import { governanceInputFromDataset, governanceLabels } from '@/lib/governance/input'
import { privateData } from '@/lib/page-data'

export const metadata: Metadata = { title: 'Control' }

type Search = Record<string, string | string[] | undefined>

export default async function ControlPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { result } = await privateData('/control')
  if (!result.ok) return <><h1>Centro de control</h1><LoadError result={result} /></>
  const data = result.data
  const params = await searchParams

  // Filtros iniciales desde la URL (solo IDs y códigos). Un valor inválido se informa y se ignora.
  const query = new URLSearchParams()
  for (const key of ['proyecto', 'categoria', 'severidad', 'tipo']) {
    const v = params[key]
    if (typeof v === 'string' && v) query.set(key, v.slice(0, 60))
  }
  let filters: ControlFilters = {}
  let filterError: string | null = null
  try {
    filters = parseControlParams(query).filters
  } catch (error) {
    if (!(error instanceof FilterError)) throw error
    filterError = `Filtro "${error.field}" ignorado: ${error.message}.`
  }
  const alerta = typeof params.alerta === 'string' && /^[a-z0-9-]{1,80}$/.test(params.alerta) ? params.alerta : null

  const report = buildGovernanceReport(governanceInputFromDataset(data), {
    referenceDate: civilDateInZone(data.fetchedAt, MERIDA_TZ),
    timeZone: MERIDA_TZ,
  })
  return (
    <>
      <h1>Centro de control</h1>
      <Freshness data={data} />
      <ControlView report={report} labels={governanceLabels(data)} initialFilters={filters} filterError={filterError} focusId={alerta} />
    </>
  )
}
