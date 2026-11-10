import { Badge, Empty } from '@/components/ui'
import { formatCivilDate } from '@/lib/dates'
import type { Metricas } from '@/lib/metricas'

const dias = (n: number | null) => (n === null ? '—' : `${n} d`)

/** Tabla semanal de /metricas (ORD-POS-072): cada fila agrupa las órdenes cerradas esa semana. */
export function TablaSemanas({ m }: { m: Metricas }) {
  if (m.semanas.length === 0) return <Empty>No hay órdenes cerradas con cierre registrado en AUDITORIA.</Empty>
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Semana (lunes)</th>
            <th scope="col">Fusionadas</th>
            <th scope="col">Cerradas sin confirmar fusión</th>
            <th scope="col">Ciclo BORRADOR→CERRADA: mediana</th>
            <th scope="col">p90</th>
            <th scope="col">Rondas de corrección (total · por orden)</th>
            <th scope="col">Por riesgo</th>
          </tr>
        </thead>
        <tbody>
          {m.semanas.map((s) => (
            <tr key={s.semana}>
              <td>{formatCivilDate(s.semana)}</td>
              <td>{s.fusionadas}</td>
              <td>{s.cerradasSinConfirmar}</td>
              <td>{dias(s.ciclo.medianaDias)}{s.ciclo.n > 0 ? <span className="muted small"> (n={s.ciclo.n})</span> : null}</td>
              <td>{dias(s.ciclo.p90Dias)}</td>
              <td>{s.rondas.total} · {s.rondas.promedio ?? '—'}</td>
              <td>
                <span className="badges">
                  {s.porRiesgo.BAJO ? <Badge tone="ok">BAJO: {s.porRiesgo.BAJO}</Badge> : null}
                  {s.porRiesgo.MEDIO ? <Badge tone="warn">MEDIO: {s.porRiesgo.MEDIO}</Badge> : null}
                  {s.porRiesgo.ALTO ? <Badge tone="danger">ALTO: {s.porRiesgo.ALTO}</Badge> : null}
                  {s.porRiesgo.SIN_RIESGO ? <Badge>Sin riesgo: {s.porRiesgo.SIN_RIESGO}</Badge> : null}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Fusionadas sin desplegar: la hoja no registra la revisión desplegada, así que se indica en lugar de calcularlo. */
export function SinDesplegar({ fusionadas }: { fusionadas: number }) {
  return (
    <p>
      <Badge tone="warn">Sin dato</Badge> Ni ORDENES_CODEX ni AUDITORIA registran la revisión desplegada ni su fecha:
      no se puede saber cuáles de las {fusionadas} órdenes fusionadas faltan por desplegar.
    </p>
  )
}
