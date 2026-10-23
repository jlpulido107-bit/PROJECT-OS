import type { Metadata } from 'next'
import { Freshness, LoadError, TabWarnings } from '@/components/data-state'
import { CostoPendiente, SinDesplegar, TablaSemanas } from '@/components/metricas'
import { writeAccess } from '@/components/operations/write-access'
import { Badge, Empty, Section } from '@/components/ui'
import { metricas, riesgoDe, type Riesgo } from '@/lib/metricas'
import { WRITE_HEADERS } from '@/lib/operations/constants'
import { auditTable } from '@/lib/operations/runtime'
import { InMemoryTableStore, readView, type TableView } from '@/lib/operations/table-store'
import { privateData } from '@/lib/page-data'

export const metadata: Metadata = { title: 'Métricas' }

/**
 * Tablero de entrega del sistema (ORD-POS-072, POS-021). Solo lectura: ORDENES_CODEX de la hoja maestra y AUDITORIA,
 * que se lee como en /operaciones (cuenta de escritura, solo para escritores: sus filas llevan correos). Aquí solo se
 * muestran agregados.
 */
export default async function MetricasPage() {
  const { user, result } = await privateData('/metricas')
  if (!result.ok) return <><h1>Métricas</h1><LoadError result={result} /></>
  const data = result.data
  const porRiesgo = new Map<Riesgo, number>()
  for (const o of data.ordenes) porRiesgo.set(riesgoDe(o.riesgo), (porRiesgo.get(riesgoDe(o.riesgo)) ?? 0) + 1)

  let audit: TableView | null = null
  let aviso: string | null = null
  if (!writeAccess(user.email).allowed) aviso = 'AUDITORIA solo se lee para escritores: sin ella no hay métricas semanales.'
  else {
    try {
      const rows = await auditTable()
      if (rows) audit = await readView(new InMemoryTableStore({ AUDITORIA: rows.length ? rows : [[...WRITE_HEADERS.AUDITORIA]] }), 'AUDITORIA')
      else aviso = 'La escritura no está activa: AUDITORIA no se puede leer.'
    } catch {
      aviso = 'No se pudo leer AUDITORIA con la cuenta de escritura. Revisa sus permisos (docs/escritura-v1-8.md).'
    }
  }
  const m = audit ? metricas(data.ordenes, audit) : null

  return (
    <>
      <h1>Métricas</h1>
      <Freshness data={data} />
      <TabWarnings data={data} tabs={['ORDENES_CODEX']} />
      <p className="muted small">
        Solo lectura de ORDENES_CODEX y AUDITORIA. Cada semana agrupa las órdenes cerradas en ella. «Fusionada» es un
        cierre con «Cerrar (PR fusionado)», comprobado en GitHub; un cierre manual se cuenta aparte porque la hoja no
        dice si hubo fusión. El ciclo va del alta (BORRADOR) al cierre (CERRADA); las rondas son correcciones lanzadas
        desde el dashboard.
      </p>

      <Section title="Órdenes por riesgo (todas)" id="riesgo">
        {data.ordenes.length === 0 ? <Empty>No hay órdenes en ORDENES_CODEX.</Empty> : (
          <div className="badges">
            {[...porRiesgo].map(([r, n]) => <Badge key={r}>{r === 'SIN_RIESGO' ? 'Sin riesgo' : r}: {n}</Badge>)}
          </div>
        )}
      </Section>

      <Section title="Entrega por semana" id="semanas">
        {m ? (
          <>
            <TablaSemanas m={m} />
            {m.cerradasSinAuditoria.length > 0 ? (
              <p className="muted small">Cerradas sin cierre en AUDITORIA (fuera de la tabla): {m.cerradasSinAuditoria.join(', ')}.</p>
            ) : null}
            {m.sinAlta.length > 0 ? (
              <p className="muted small">Sin alta en AUDITORIA (sin ciclo): {m.sinAlta.join(', ')}.</p>
            ) : null}
          </>
        ) : <Empty>{aviso}</Empty>}
      </Section>

      <Section title="Fusionadas sin desplegar" id="despliegue">
        {m ? <SinDesplegar fusionadas={m.semanas.reduce((s, x) => s + x.fusionadas, 0)} /> : <Empty>{aviso}</Empty>}
      </Section>

      <Section title="Costo por orden" id="costo">
        <CostoPendiente />
      </Section>
    </>
  )
}
