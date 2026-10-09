import Link from 'next/link'
import { Freshness, LoadError, TabWarnings } from '@/components/data-state'
import { Badge, Empty, humanize, Section, Stat, StateBadge, Text } from '@/components/ui'
import { executiveSummary, formatMinutes, projectStats } from '@/lib/aggregate'
import { formatTimestamp } from '@/lib/dates'
import { privateData } from '@/lib/page-data'
import type { Dataset } from '@/lib/types'

export default async function HomePage() {
  const { result } = await privateData('/')
  return (
    <>
      <h1>Inicio ejecutivo</h1>
      {result.ok ? <Overview data={result.data} /> : <LoadError result={result} />}
    </>
  )
}

function Overview({ data }: { data: Dataset }) {
  const s = executiveSummary(data)
  const blocked = s.bloqueos.tareasBloqueadas
  const pendingDeps = s.bloqueos.dependenciasPendientes
  const sync = s.ultimoSync

  return (
    <>
      <Freshness data={data} />
      <TabWarnings data={data} tabs={['PROYECTOS', 'TAREAS', 'DEPENDENCIAS', 'TIEMPOS', 'SYNC_RUNS', 'EVIDENCIAS']} />

      <div className="stats" aria-label="Indicadores">
        <Stat label="Proyectos registrados" value={s.proyectos} href="/proyectos" />
        <Stat
          label="Tareas abiertas"
          value={s.tareas.abiertas}
          href="/tareas"
          hint={
            s.tareas.total === null ? undefined : (
              <>
                de {s.tareas.total} registradas
                {s.tareas.sinEstado ? ` · ${s.tareas.sinEstado} sin estado` : ''}
              </>
            )
          }
        />
        <Stat
          label="Bloqueos"
          value={blocked === null ? null : blocked.length}
          tone={blocked && blocked.length > 0 ? 'danger' : undefined}
          href="/tareas?bloqueo=si"
          hint={pendingDeps === null ? 'Dependencias no disponibles' : `${pendingDeps.length} ${pendingDeps.length === 1 ? 'dependencia' : 'dependencias'} sin resolver`}
        />
        <Stat
          label="Tiempo real registrado"
          value={
            s.tiempos === null
              ? null
              : s.tiempos.minutos === null
                ? <span className="stat-empty">Sin registros</span>
                : formatMinutes(s.tiempos.minutos)
          }
          href="/capacidad"
          hint={
            s.tiempos === null
              ? undefined
              : s.tiempos.minutos === null
                ? s.tiempos.sesiones > 0
                  ? `${s.tiempos.sesiones} sesiones sin minutos válidos`
                  : 'No hay sesiones en TIEMPOS'
                : `${s.tiempos.sesiones} sesiones · esta semana: ${
                    s.tiempos.minutosSemana === null ? 'sin registros' : formatMinutes(s.tiempos.minutosSemana)
                  }`
          }
        />
        <Stat
          label="Última sincronización"
          value={
            sync === undefined ? null : sync === null ? <span className="stat-empty">Sin ejecuciones</span> : humanize(sync.estado)
          }
          tone={sync?.estado === 'EXITOSA' ? 'ok' : sync?.estado ? 'warn' : undefined}
          hint={
            sync
              ? <>
                  {sync.fin ? formatTimestamp(sync.fin) : sync.inicio ? formatTimestamp(sync.inicio) : 'Sin fecha'}
                  {' · '}{sync.registrosProcesados === null ? 'registros sin dato' : `${sync.registrosProcesados} registros nuevos`}
                  {' · '}{sync.fuente ?? 'Fuente sin registrar'}
                </>
              : undefined
          }
        />
      </div>

      <Section title="Proyectos" id="proyectos">
        {data.proyectos.length === 0 ? (
          <Empty>No hay proyectos registrados en la pestaña PROYECTOS.</Empty>
        ) : (
          <div className="table-wrap" role="region" aria-label="Tabla de proyectos" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th scope="col">Proyecto</th>
                  <th scope="col">Fase</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Prioridad</th>
                  <th scope="col">Tareas abiertas</th>
                  <th scope="col">Hitos completados</th>
                  <th scope="col">Bloqueos</th>
                </tr>
              </thead>
              <tbody>
                {data.proyectos.map((p) => {
                  const st = projectStats(p.id, data)
                  return (
                    <tr key={p.id}>
                      <th scope="row">
                        <Link href={`/proyectos/${encodeURIComponent(p.id)}`}>
                          <span className="mono">{p.id}</span> · <Text value={p.nombre} empty="Sin nombre" />
                        </Link>
                      </th>
                      <td>{humanize(p.fase)}</td>
                      <td><StateBadge code={p.estado} /></td>
                      <td><StateBadge code={p.prioridad} /></td>
                      <td>{st.tareas === 0 ? <span className="muted">Sin tareas</span> : `${st.tareasAbiertas} de ${st.tareas}`}</td>
                      <td>{st.hitos === 0 ? <span className="muted">Sin hitos</span> : `${st.hitosCompletados} de ${st.hitos}`}</td>
                      <td>{st.tareasBloqueadas > 0 ? <Badge tone="danger">{st.tareasBloqueadas}</Badge> : st.tareas === 0 ? <span className="muted">—</span> : '0'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">No se calculan porcentajes de avance: solo conteos registrados en la hoja.</p>
      </Section>

      <Section title="Bloqueos y dependencias" id="bloqueos">
        {blocked === null ? (
          <Empty>La pestaña TAREAS no está disponible.</Empty>
        ) : blocked.length === 0 ? (
          <Empty>Ninguna tarea abierta tiene un bloqueo registrado (columna BLOQUEO vacía o estado distinto de BLOQUEADO).</Empty>
        ) : (
          <ul className="list">
            {blocked.map((t) => (
              <li key={t.id}>
                <Link href={`/tareas?q=${encodeURIComponent(t.id)}`} className="mono">{t.id}</Link>{' '}
                <Text value={t.titulo} empty="Sin título" /> — <strong>Bloqueo:</strong> <Text value={t.bloqueo} empty={humanize(t.estado)} />
              </li>
            ))}
          </ul>
        )}
        {pendingDeps && pendingDeps.length > 0 ? (
          <>
            <h3>Dependencias activas sin resolver</h3>
            <ul className="list">
              {pendingDeps.map((d) => (
                <li key={d.id}>
                  <span className="mono">{d.tareaId}</span> depende de <span className="mono">{d.dependeDeTareaId}</span>{' '}
                  ({humanize(d.tipo)}) — el prerrequisito no tiene estado COMPLETADO registrado.
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </Section>

      {s.evidencias ? (
        <Section title="Evidencias" id="evidencias" actions={<Link href="/actividad">Ver actividad</Link>}>
          <ul className="inline-stats">
            <li><strong>{s.evidencias['evento-observado']}</strong> eventos observados sin tarea vinculada</li>
            <li><strong>{s.evidencias['vinculada-sin-validar']}</strong> vinculadas a tareas aún no completadas</li>
            <li><strong>{s.evidencias['tarea-validada']}</strong> vinculadas a tareas con estado COMPLETADO</li>
            {s.evidencias['vinculo-roto'] > 0 ? <li><strong>{s.evidencias['vinculo-roto']}</strong> con TAREA_ID inexistente</li> : null}
          </ul>
          <p className="muted small">Un commit o PR confirmado demuestra actividad, no que una tarea esté terminada.</p>
        </Section>
      ) : null}

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
