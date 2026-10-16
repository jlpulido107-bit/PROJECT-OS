import { refreshData } from '@/app/actions'
import { ageLabel } from '@/lib/aggregate'
import { formatInstant } from '@/lib/dates'
import type { LoadResult } from '@/lib/data'
import type { TabName } from '@/lib/schema'
import type { Dataset, TabStatus } from '@/lib/types'
import { SubmitButton } from './submit-button'

function RefreshForm() {
  return (
    <form action={refreshData} className="refresh-form">
      <SubmitButton pendingLabel="Actualizando…">Actualizar datos</SubmitButton>
    </form>
  )
}

/** Etiqueta de frescura: cuándo se leyó la hoja y cómo refrescar. Sin promesas de tiempo real. */
export function Freshness({ data }: { data: Dataset }) {
  // Render por petición: Date.now() es intencional para calcular la antigüedad de la lectura.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now()
  return (
    <div className="freshness" role="status">
      {data.source === 'fixtures' ? (
        <p className="demo-banner">
          <strong>Datos sintéticos de demostración.</strong> No provienen de Google Sheets.
        </p>
      ) : null}
      <p>
        {data.source === 'sheets' ? 'Leído de Google Sheets' : 'Generado'}{' '}
        <time dateTime={new Date(data.fetchedAt).toISOString()}>{formatInstant(data.fetchedAt)}</time>{' '}
        (hora Mérida, {ageLabel(data.fetchedAt, now)}). Los datos no se actualizan solos.
      </p>
      <RefreshForm />
    </div>
  )
}

const PROBLEM_TEXT: Record<NonNullable<TabStatus['problem']>, string> = {
  'pestana-ausente': 'la pestaña no existe en la hoja',
  'encabezados-faltantes': 'faltan columnas',
  'encabezados-duplicados': 'hay columnas duplicadas',
  'sin-encabezados': 'la fila de encabezados está vacía',
}

/** Aviso cuando una pestaña necesaria no es válida: sus datos se muestran como "no disponibles", no como cero. */
export function TabWarnings({ data, tabs }: { data: Dataset; tabs: TabName[] }) {
  // Una pestaña opcional ausente no tiene estado y no genera aviso.
  const problems = tabs
    .map((t) => data.tabs[t])
    .filter((s): s is TabStatus => s !== undefined && (!s.ok || s.truncated))
  if (problems.length === 0) return null
  return (
    <div className="alert alert-warn" role="alert">
      <p><strong>Datos incompletos.</strong></p>
      <ul>
        {problems.map((s) => (
          <li key={s.tab}>
            <code>{s.tab}</code>:{' '}
            {s.problem
              ? `${PROBLEM_TEXT[s.problem]}${s.missingColumns.length ? ` (${s.missingColumns.join(', ')})` : ''}. No se muestran sus datos.`
              : 'se alcanzó el límite de filas leídas; los totales pueden estar incompletos.'}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function LoadError({ result }: { result: Extract<LoadResult, { ok: false }> }) {
  return (
    <div className="alert alert-danger" role="alert">
      <h2>No se pudieron leer los datos</h2>
      <p>{result.error.message}</p>
      <p className="muted">Intento: {formatInstant(result.at)} (hora Mérida). No se muestran datos parciales ni valores en cero.</p>
      <RefreshForm />
    </div>
  )
}
