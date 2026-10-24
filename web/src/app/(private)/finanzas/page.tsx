import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { Badge, Empty, Section, Stat } from '@/components/ui'
import { formatInstant } from '@/lib/dates'
import {
  formatoMoneda, formatoMxn, PROYECTOS, type Bloque, type Capital, type FilaProblema, type GastoMensual, type Herramientas,
  type Pyl, type RecurrentesMes,
} from '@/lib/finanzas/finanzas'
import { privateFinanzas } from '@/lib/page-data'

export const metadata: Metadata = { title: 'Finanzas (solo lectura)' }

/** Estado de un bloque que no está `ok` (diseño §5); los demás bloques se pintan igual. */
function EstadoBloque<T>({ bloque, children }: { bloque: Bloque<T>; children: (datos: T) => ReactNode }) {
  if (bloque.estado === 'vacio') return <Empty>{bloque.mensaje}</Empty>
  if (bloque.estado === 'no-disponible') {
    return <div className="alert alert-warn" role="alert"><p>{bloque.mensaje}</p></div>
  }
  return <>{children(bloque.datos)}</>
}

function Avisos({ avisos, label }: { avisos: string[]; label: string }) {
  if (!avisos.length) return null
  return (
    <ul className="list" aria-label={label}>
      {avisos.map((a) => <li key={a}><Badge tone="warn">Aviso</Badge> {a}</li>)}
    </ul>
  )
}

const Monto = ({ centavos }: { centavos: number }) => <td>{formatoMxn(centavos)}</td>

function BloqueCapital({ datos }: { datos: Capital }) {
  const pct = datos.pct === null ? null : Math.floor(datos.pct)
  return (
    <>
      {datos.alerta === 'superado' ? (
        <div className="alert alert-danger" role="alert"><p>Tope de capital superado ({pct} % del tope).</p></div>
      ) : datos.alerta === 'aviso' ? (
        <div className="alert alert-warn" role="alert"><p>Capital al {pct} % del tope (alerta desde {datos.alertaPct} %).</p></div>
      ) : null}
      <div className="stats" aria-label="Capital">
        <Stat label="Capital usado" value={formatoMxn(datos.usadoCentavos)} hint="Gasto + Inversión de ECO y POS, sin restar ingresos" />
        <Stat label="Tope" value={datos.topeCentavos === null ? null : formatoMxn(datos.topeCentavos)} />
        <Stat label="Restante" value={datos.restanteCentavos === null ? null : formatoMxn(datos.restanteCentavos)}
          tone={datos.alerta === 'superado' ? 'danger' : datos.alerta === 'aviso' ? 'warn' : undefined} />
      </div>
      {datos.topeCentavos !== null && datos.pct !== null ? (
        <p>
          <progress max={100} value={Math.min(datos.pct, 100)} aria-label="Capital usado contra el tope" />{' '}
          {pct} % del tope
        </p>
      ) : null}
      <div className="table-wrap">
        <table aria-label="Capital usado por proyecto">
          <thead><tr><th scope="col">Proyecto</th><th scope="col">Capital usado</th></tr></thead>
          <tbody>
            {PROYECTOS.map((p) => <tr key={p}><th scope="row">{p}</th><Monto centavos={datos.porProyecto[p]} /></tr>)}
          </tbody>
        </table>
      </div>
      <Avisos avisos={datos.avisos} label="Avisos de PARAMETROS" />
    </>
  )
}

function BloqueMensual({ datos }: { datos: GastoMensual }) {
  return (
    <>
      <Avisos avisos={datos.avisos} label="Avisos de la ventana" />
      <div className="table-wrap">
        <table aria-label="Gasto mensual por proyecto">
          <thead>
            <tr><th scope="col">Mes</th>{PROYECTOS.map((p) => <th key={p} scope="col">{p} (gasto + inversión)</th>)}<th scope="col">Ingreso (aparte)</th></tr>
          </thead>
          <tbody>
            {[...datos.meses].reverse().map((m) => (
              <tr key={m.mes}>
                <th scope="row" className="mono">{m.mes}</th>
                {PROYECTOS.map((p) => <Monto key={p} centavos={m.gasto[p]} />)}
                <Monto centavos={m.ingresoCentavos} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {[...datos.meses].reverse().filter((m) => m.categorias.length).map((m) => (
        <details key={m.mes}>
          <summary>Detalle por categoría de {m.mes}</summary>
          <div className="table-wrap">
            <table aria-label={`Gasto por categoría de ${m.mes}`}>
              <thead><tr><th scope="col">Categoría</th>{PROYECTOS.map((p) => <th key={p} scope="col">{p}</th>)}</tr></thead>
              <tbody>
                {m.categorias.map((c) => (
                  <tr key={c.categoria}><th scope="row">{c.categoria}</th>{PROYECTOS.map((p) => <Monto key={p} centavos={c.gasto[p]} />)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ))}
    </>
  )
}

function BloqueHerramientas({ datos }: { datos: Herramientas }) {
  const meses = [...datos.meses].reverse()
  return (
    <>
      <Avisos avisos={datos.avisos} label="Avisos de la ventana" />
      <p className="small">
        Promedio mensual de {datos.mesesPromedio.join(', ')}: <strong>{formatoMxn(datos.promedioCentavos)}</strong>.
        «Sin registrar» marca un mes sin fila de una herramienta que sí tuvo cargo el mes anterior; no se inventa el monto.
      </p>
      <div className="table-wrap">
        <table aria-label="Costo de herramientas por mes">
          <thead>
            <tr><th scope="col">Mes</th>{datos.conceptos.map((c) => <th key={c.concepto} scope="col">{c.concepto}</th>)}<th scope="col">Total</th></tr>
          </thead>
          <tbody>
            {meses.map((mes) => (
              <tr key={mes}>
                <th scope="row" className="mono">{mes}</th>
                {datos.conceptos.map((c) => {
                  const v = c.porMes[mes]
                  if (v !== null && v !== undefined) return <Monto key={c.concepto} centavos={v} />
                  return <td key={c.concepto}>{c.sinRegistrar.includes(mes) ? <Badge tone="warn">Sin registrar</Badge> : <span className="muted">—</span>}</td>
                })}
                <Monto centavos={datos.totalPorMes[mes] ?? 0} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function BloquePyl({ datos }: { datos: Pyl }) {
  const filas = datos.sinProducto ? [...datos.productos, datos.sinProducto] : datos.productos
  return (
    <>
      <p className="small muted">Solo lo capturado en MOVIMIENTOS; no usa las estimaciones de tarifas de /eco ni calcula márgenes unitarios.</p>
      <div className="table-wrap">
        <table aria-label="P&L por producto">
          <thead>
            <tr><th scope="col">Producto</th><th scope="col">Ingresos</th><th scope="col">Gastos</th><th scope="col">Inversión</th><th scope="col">Resultado</th></tr>
          </thead>
          <tbody>
            {filas.map((p) => (
              <tr key={p.productoId ?? '__sin_producto__'}>
                <th scope="row" className={p.productoId ? 'mono' : undefined}>{p.productoId ?? 'Sin producto'}</th>
                <Monto centavos={p.ingresoCentavos} />
                <Monto centavos={p.gastoCentavos} />
                <Monto centavos={p.inversionCentavos} />
                <Monto centavos={p.resultadoCentavos} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

/** v2 §4.2: solo lectura, sin botones. «Confirmar» llega con la escritura (docs/diseno-finanzas-v2.md §9.2). */
function BloqueRecurrentes({ datos }: { datos: RecurrentesMes }) {
  return (
    <>
      <p className="small">
        Cargos vigentes en {datos.mes} ({datos.vigentes}) sin su fila <code>REC-&lt;ID&gt;-AAAA-MM</code> en MOVIMIENTOS, y los
        de {datos.mesAnterior} marcados «atrasado». Montos esperados según RECURRENTES; esta vista no confirma nada: se
        capturan en la hoja.
      </p>
      {datos.pendientes.length === 0 ? <Empty>Sin recurrentes pendientes de {datos.mes} ni de {datos.mesAnterior}.</Empty> : (
        <div className="table-wrap">
          <table aria-label="Recurrentes pendientes">
            <thead>
              <tr><th scope="col">Concepto</th><th scope="col">Proyecto</th><th scope="col">Monto esperado</th><th scope="col">Moneda</th><th scope="col">Día de cobro</th><th scope="col">Estado</th></tr>
            </thead>
            <tbody>
              {datos.pendientes.map((p) => (
                <tr key={p.movId}>
                  <th scope="row">{p.recurrente.concepto} <span className="mono small muted">{p.movId}</span></th>
                  <td>{p.recurrente.proyecto}</td>
                  <td>{formatoMoneda(p.recurrente.centavos, p.recurrente.moneda)}</td>
                  <td>{p.recurrente.moneda}</td>
                  <td className="mono">{p.fechaCobro}</td>
                  <td>{p.atrasado ? <Badge tone="danger">Atrasado</Badge> : p.aunNoVence ? <Badge tone="muted">Aún no vence</Badge> : <Badge tone="warn">Pendiente</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {datos.problemas.length ? (
        <>
          <p className="small">Recurrentes con problema: no generan pendientes. Corrígelos en la hoja.</p>
          <ul className="list" aria-label="Recurrentes con problema">
            {datos.problemas.map((p) => <li key={p.ref}><span className="mono">{p.ref}</span>: {p.columnas.join(', ')}</li>)}
          </ul>
        </>
      ) : null}
    </>
  )
}

function BloqueProblemas({ problemas }: { problemas: FilaProblema[] }) {
  return (
    <>
      <p className="small">Estas filas no se sumaron. Corrígelas en la hoja; la vista no corrige nada.</p>
      <ul className="list" aria-label="Filas con problema">
        {problemas.map((p) => <li key={p.ref}><span className="mono">{p.ref}</span>: {p.columnas.join(', ')}</li>)}
      </ul>
    </>
  )
}

export default async function FinanzasPage() {
  const { result } = await privateFinanzas('/finanzas')

  if (result.estado === 'no-configurado') {
    return (
      <>
        <h1>Finanzas</h1>
        <div className="alert alert-warn" role="status">
          <p>FINANZAS no está configurado en este despliegue{result.motivo === 'no-valido' ? ' (valor no válido)' : ''}.</p>
          <p className="small">La activación es del propietario: crear la hoja FINANZAS, compartirla como Lector con la cuenta de
            lectura, configurar <code>FINANZAS_SHEET_ID</code> con <code>deploy.sh --desde-activa</code> y verificar
            (docs/diseno-finanzas.md §6).</p>
        </div>
      </>
    )
  }
  if (result.estado === 'error') {
    return (
      <>
        <h1>Finanzas</h1>
        <div className="alert alert-danger" role="alert">
          <h2>No se pudieron leer los datos de FINANZAS</h2>
          <p>{result.message}{result.reintentar ? ' Intenta en un minuto.' : ''}</p>
          <p className="muted">Intento: {formatInstant(result.at)} (hora Mérida). No se muestran datos parciales.</p>
        </div>
      </>
    )
  }

  const v = result.vista
  return (
    <>
      <h1>Finanzas</h1>
      <p className="muted small">
        Solo lectura del libro FINANZAS (ECO y POS), leído {formatInstant(result.fetchedAt)} (hora Mérida). Montos en MXN.
        Esta página no escribe, no llama a SP-API, a Anthropic ni a ningún banco y no lee la pestaña RESUMEN.
      </p>
      <Section title="Capital usado contra el tope" id="capital"><EstadoBloque bloque={v.capital}>{(d) => <BloqueCapital datos={d} />}</EstadoBloque></Section>
      <Section title="Gasto mensual por proyecto y categoría" id="mensual"><EstadoBloque bloque={v.mensual}>{(d) => <BloqueMensual datos={d} />}</EstadoBloque></Section>
      <Section title="Costo de herramientas" id="herramientas"><EstadoBloque bloque={v.herramientas}>{(d) => <BloqueHerramientas datos={d} />}</EstadoBloque></Section>
      <Section title="Recurrentes del mes" id="recurrentes"><EstadoBloque bloque={v.recurrentes}>{(d) => <BloqueRecurrentes datos={d} />}</EstadoBloque></Section>
      <Section title="P&L por producto" id="pyl"><EstadoBloque bloque={v.pyl}>{(d) => <BloquePyl datos={d} />}</EstadoBloque></Section>
      {v.problemas.length ? <Section title="Filas con problema" id="problemas"><BloqueProblemas problemas={v.problemas} /></Section> : null}
    </>
  )
}
