import { Freshness, LoadError, TabWarnings } from '@/components/data-state'
import { BloqueEsperando } from '@/components/inicio/esperando'
import { VistaInicio } from '@/components/inicio/inicio'
import { TableroInicio } from '@/components/inicio/tablero'
import { Badge, humanize } from '@/components/ui'
import { conteoOrdenes, ordenesDelFiltro } from '@/lib/agentes'
import { LLAMADAS_AGENTES } from '@/lib/agentes-data'
import { leerAuditoria } from '@/lib/auditoria'
import { todayInMerida } from '@/lib/dates'
import { fuenteBanderas } from '@/lib/banderas'
import { commitDesplegado } from '@/lib/despliegue'
import { esperandoPorTi, githubDeInicio } from '@/lib/esperando'
import { finanzasAgenteMode } from '@/lib/finanzas/agente-config'
import { getFinanzas } from '@/lib/finanzas/data'
import { finanzasInicio, misPendientes, parseFiltroInicio, proyectosInicio, recurrentesSinConfirmar } from '@/lib/inicio'
import { tablero, type FuenteFinanzas } from '@/lib/inicio-tablero'
import { eventosOrdenes } from '@/lib/metricas'
import { isWriter } from '@/lib/operations/config'
import { githubClient } from '@/lib/operations/dispatch'
import { privateData } from '@/lib/page-data'
import type { Dataset } from '@/lib/types'

type Search = Record<string, string | string[] | undefined>

/**
 * Inicio (ORD-POS-090, POS-026): proyectos, pendientes del propietario, finanzas y agentes en una vista. Solo lectura:
 * la hoja que ya lee todo el dashboard, FINANZAS con su caché y las listas de PRs de GitHub con la caché de /agentes
 * (githubDeAgentes sin órdenes: no lee dictámenes). Cada bloque sin fuente dice «sin datos».
 * El tablero de Inicio v2 (ORD-POS-096) reusa esas mismas lecturas y AUDITORIA con la caché compartida con /metricas y
 * /agentes (lib/auditoria.ts, solo para escritores): ninguna llamada nueva a GitHub.
 * «Esperando por ti» (ORD-POS-122, solo para la sesión del propietario) lee además los dictámenes de las PR_ABIERTO con
 * dictamenDeOrden y su caché (la de /ordenes), con el mismo cliente de tope LLAMADAS_AGENTES y lo que queda de
 * LIMITE_GLOBAL_MS en esta carga; lo que no cupo queda «sin datos». Su grupo «Fusionado sin desplegar» (ORD-POS-124)
 * compara main con el commit desplegado (DEPLOY_COMMIT_SHA) con el mismo cliente; sin el commit queda apagado.
 */
export default async function HomePage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams
  const { user, result } = await privateData('/')
  if (!result.ok) return <><h1>Inicio</h1><LoadError result={result} /></>
  const data = result.data
  const filtro = parseFiltroInicio(params)
  // Render por petición: hoy y el mes dependen de la fecha en Mérida (como /estado).
  const ahora = new Date()
  const now = ahora.getTime()
  const hoy = todayInMerida(ahora)

  const client = githubClient(process.env, { maxLlamadas: LLAMADAS_AGENTES })
  const propietario = isWriter(user.email)
  const commit = commitDesplegado()
  const lecturas = client ? await githubDeInicio(client, filtro, data.ordenes, propietario, { commit }) : null
  const gh = lecturas?.gh ?? null
  const listos = lecturas?.listos ?? null
  const finanzas = await getFinanzas()
  const vista = finanzas.estado === 'ok' ? finanzas.vista : null
  const motivo = finanzas.estado === 'no-configurado' ? 'FINANZAS no está configurado en este despliegue (sin FINANZAS_SHEET_ID).' : 'No se pudo leer FINANZAS.'
  const audit = await leerAuditoria(user.email)
  const proyectos = proyectosInicio(data, hoy, filtro)
  const fuenteFinanzas: FuenteFinanzas = finanzas.estado === 'ok' ? { estado: 'ok', vista: finanzas.vista }
    : finanzas.estado === 'no-configurado' ? { estado: 'no-configurado' } : { estado: 'error', motivo }
  const pendientes = misPendientes(data, hoy, filtro, { prs: gh?.prs ?? null, recurrentes: recurrentesSinConfirmar(vista, motivo) })
  // 6.4 (ORD-POS-125): la columna BANDERA y el estado de cada bandera, solo para la sesión del propietario; la fusión sale
  // de las listas de PRs ya leídas (cero llamadas nuevas).
  const esperando = esperandoPorTi({
    propietario, ordenes: data.ordenes, ordenesOk: data.tabs.ORDENES_CODEX.ok, filtro, pendientes, listos, commit,
    despliegue: lecturas ? { prs: gh?.prs.POS ?? null, sinDesplegar: lecturas.sinDesplegar } : null,
    banderas: fuenteBanderas(data.ordenesConBandera, propietario), prs: gh?.prs ?? null, truncados: gh?.truncados ?? [],
  })
  const t = tablero({
    ds: data, hoy, now, filtro, proyectos, gh, finanzas: fuenteFinanzas, audit, agenteFinanzas: finanzasAgenteMode() === 'sheets',
    eventos: audit.estado === 'ok' ? { estado: 'ok', datos: eventosOrdenes(data.ordenes, audit.datos) } : audit,
  })

  return (
    <>
      <h1>Inicio</h1>
      <Freshness data={data} />
      <TabWarnings data={data} tabs={['PROYECTOS', 'HITOS', 'TAREAS', 'DECISIONES', 'ORDENES_CODEX']} />
      <p className="muted small">Solo lectura: nada de esta página escribe en la hoja, en FINANZAS ni en GitHub.</p>
      <VistaInicio esperando={<BloqueEsperando e={esperando} filtro={filtro} />} tablero={<TableroInicio t={t} />} d={{
        filtro,
        proyectos,
        pendientes,
        cubiertoPorEsperando: esperando.estado === 'ok',
        finanzas: finanzasInicio(vista, motivo, now, filtro),
        ordenes: conteoOrdenes(ordenesDelFiltro(data.ordenes, null, { proyecto: filtro, desde: null, hasta: null })),
      }} />
      <Diagnostics data={data} />
    </>
  )
}

function Diagnostics({ data }: { data: Dataset }) {
  const tabs = Object.values(data.tabs)
  const notes = tabs.filter((t) => t.rowsWithoutId > 0 || t.duplicateIds.length > 0)
  return (
    <details className="diagnostics">
      <summary>Diagnóstico de datos ({tabs.filter((t) => t.ok).length}/{tabs.length} pestañas válidas · {data.issues.length} incidencias)</summary>
      <div className="table-wrap" role="region" aria-label="Estado de pestañas" tabIndex={0}>
        <table>
          <thead>
            <tr><th scope="col">Pestaña</th><th scope="col">Esquema</th><th scope="col">Filas</th><th scope="col">Notas</th></tr>
          </thead>
          <tbody>
            {tabs.map((t) => (
              <tr key={t.tab}>
                <th scope="row" className="mono">{t.tab}</th>
                <td>{t.ok ? <Badge tone="ok">Válido</Badge> : <Badge tone="danger">{humanize(t.problem)}</Badge>}</td>
                <td>{t.ok ? t.rows : '—'}</td>
                <td>
                  {[
                    t.missingColumns.length ? `Columnas: ${t.missingColumns.join(', ')}` : null,
                    t.truncated ? 'Límite de filas alcanzado' : null,
                    t.rowsWithoutId ? `${t.rowsWithoutId} filas sin ID (ignoradas)` : null,
                    t.duplicateIds.length ? `IDs duplicados: ${t.duplicateIds.join(', ')}` : null,
                  ].filter(Boolean).join(' · ') || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {notes.length === 0 && data.issues.length === 0 ? <p className="muted small">Sin incidencias de formato.</p> : null}
      {data.issues.length > 0 ? (
        <ul className="list small">
          {data.issues.map((i) => (
            <li key={`${i.tab}-${i.row}-${i.column}`}>
              <code>{i.tab}</code> fila {i.row}, <code>{i.column}</code>: {i.message}
            </li>
          ))}
          {data.issuesTruncated ? <li>… y más incidencias no listadas.</li> : null}
        </ul>
      ) : null}
      <p className="muted small">Fechas sin hora se muestran como fecha civil; las fechas con hora, en hora de Mérida (America/Merida).</p>
    </details>
  )
}
