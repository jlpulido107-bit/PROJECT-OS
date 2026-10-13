import type { Metadata } from 'next'
import Link from 'next/link'
import { WriteGate } from '@/components/operations/write-access'
import { Badge, Empty, Section } from '@/components/ui'
import { WRITE_HEADERS } from '@/lib/operations/constants'
import { auditTable, operationsService } from '@/lib/operations/runtime'
import { parseAudit } from '@/lib/operations/service'
import { InMemoryTableStore, readView } from '@/lib/operations/table-store'
import { privateData } from '@/lib/page-data'

export const metadata: Metadata = { title: 'Operaciones' }

const OPS: Record<string, string> = {
  'tarea.crear': 'Tarea creada',
  'tarea.editar': 'Tarea editada',
  'tiempo.registrar': 'Tiempo registrado',
  'decision.crear': 'Decisión registrada',
}

const RECONCILE_LABEL: Record<string, string> = {
  'sin-efecto': 'Sin efecto',
  divergente: 'Divergente',
  'auditoria-parcial': 'Auditoría parcial',
  'auditoria-inconsistente': 'Auditoría contradictoria',
  'actualizacion-perdida': 'Posible actualización perdida',
}

export default async function OperationsPage() {
  const { user } = await privateData('/operaciones')
  return (
    <>
      <h1>Operaciones</h1>
      <WriteGate email={user.email}>
        <Operations />
      </WriteGate>
    </>
  )
}

async function Operations() {
  const service = operationsService()
  let auditRows: string[][] | null
  try {
    auditRows = await auditTable()
  } catch {
    // Sin detalles: lo habitual es un permiso faltante de la cuenta de escritura (docs/escritura-v1-8.md).
    return <Empty>No se pudo leer AUDITORIA con la cuenta de escritura. Revisa sus permisos (docs/escritura-v1-8.md).</Empty>
  }
  if (!service || !auditRows) return <Empty>La escritura no está activa.</Empty>
  const audit = await readView(new InMemoryTableStore({ AUDITORIA: auditRows.length ? auditRows : [[...WRITE_HEADERS.AUDITORIA]] }), 'AUDITORIA')
  const ops = parseAudit(audit).sort((a, b) => b.order - a.order).slice(0, 30)
  const report = await service.reconcile()
  return (
    <>
      <div className="actions-row">
        <Link className="button button-primary" href="/tareas/nueva">Nueva tarea</Link>
        <Link className="button" href="/tiempos/nuevo">Registrar tiempo</Link>
        <Link className="button" href="/decisiones/nueva">Registrar decisión</Link>
      </div>

      <Section title="Conciliación" id="conciliacion">
        {report.pendientes.length === 0 ? (
          <p><Badge tone="ok">Sin pendientes</Badge> {report.operaciones} operaciones auditadas coinciden con el estado actual.</p>
        ) : (
          <ul className="list">
            {report.pendientes.map((p) => (
              <li key={p.requestId}>
                <Badge tone="warn">{RECONCILE_LABEL[p.motivo]}</Badge>{' '}
                {OPS[p.operacion] ?? p.operacion} · <span className="mono">{p.id}</span> · solicitud <span className="mono">{p.requestId.slice(0, 8)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Auditoría reciente" id="auditoria">
        {ops.length === 0 ? <Empty>Aún no hay operaciones registradas.</Empty> : (
          <ul className="stack plain">
            {ops.map((op) => (
              <li key={op.requestId} className="card">
                <p><strong>{OPS[op.operacion] ?? op.operacion}</strong> · <span className="mono">{op.entidad} {op.id}</span></p>
                <ul className="list small">
                  {[...op.fields.entries()].filter(([campo]) => campo !== 'ACTUALIZADO_EN').map(([campo, { antes, despues }]) => (
                    <li key={campo}><code>{campo}</code>: {antes ? <><span className="muted">{antes}</span> → </> : null}{despues || <span className="muted">(vacío)</span>}</li>
                  ))}
                </ul>
                <p className="muted small">Solicitud <span className="mono">{op.requestId}</span></p>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  )
}
