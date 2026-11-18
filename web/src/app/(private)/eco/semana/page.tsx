import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { Empty } from '@/components/ui'
import { formatInstant } from '@/lib/dates'
import { privateEco } from '@/lib/page-data'
import { enlaceFichaCompras } from '@/lib/radaros/eco-ideas'
import type { Buscador, Dictamen, EnProceso, Pasado, Pendiente, Salud } from '@/lib/radaros/eco-semana'
import type { Bloque } from '@/lib/radaros/tabla'

export const metadata: Metadata = { title: 'ECO esta semana (solo lectura)' }

/**
 * «ECO esta semana» (ORD-POS-159, POS-061): solo lectura, con palabras. No tiene formularios, botones ni rutas de
 * escritura; los textos salen de `eco-semana-textos.ts` y los ID van solo en gris pequeño (`eco-id`).
 */

const pesos = (v: number | null) => (v === null ? 'Sin dato' : `$${v.toLocaleString('es-MX', { maximumFractionDigits: 0 })}`)

/** ID en gris pequeño: lo único de la página que no son palabras. */
function Ids({ children }: { children: ReactNode }) {
  return <span className="eco-id small muted">{children}</span>
}

/** Estado de un bloque que no está `ok`: mensaje en palabras; el nombre técnico de lo que falta, en gris pequeño. */
function EstadoBloque<T>({ bloque, nombre, children }: { bloque: Bloque<T>; nombre: string; children: (datos: T) => ReactNode }) {
  if (bloque.estado === 'ausente' || bloque.estado === 'sin-filas') return <Empty>{bloque.mensaje}</Empty>
  if (bloque.estado === 'columnas-faltantes') {
    return (
      <div className="alert alert-warn" role="alert">
        <p>A {nombre} le faltan columnas en el libro de RADAROS; no se muestran sus datos. <Ids>{bloque.tab}: {bloque.faltan.join(', ')}</Ids></p>
      </div>
    )
  }
  return (
    <>
      {bloque.truncado ? (
        <div className="alert alert-warn" role="alert"><p>{nombre} es demasiado largo para leerlo completo: pueden faltar los datos más recientes.</p></div>
      ) : null}
      {children(bloque.datos)}
    </>
  )
}

function TarjetaPasado({ p }: { p: Pasado }) {
  return (
    <li className="card semana-tarjeta">
      <h3>{p.nombre}</h3>
      <dl className="semana-datos">
        <div><dt>Se vende en</dt><dd>{pesos(p.precio)}</dd></div>
        <div><dt>Puedes pagar hasta, por pieza puesta en México</dt><dd>{pesos(p.costoMax)}</dd></div>
        <div><dt>Ganancia por pieza si pagas eso</dt><dd className="semana-ganancia">{pesos(p.ganancia)}</dd></div>
        <div><dt>¿Hay espacio?</dt><dd>{p.espacio}</dd></div>
        <div><dt>Pedido máximo con tu capital</dt><dd>{p.moqMax === null ? 'Sin dato' : `${p.moqMax.toLocaleString('es-MX')} piezas`}</dd></div>
      </dl>
      {p.aviso ? <p className="alert alert-warn semana-aviso">{p.aviso}</p> : null}
      <Ids>{p.id}{p.asin ? ` · ${p.asin}` : ''}</Ids>
    </li>
  )
}

function Pasaron({ d }: { d: Dictamen }) {
  if (!d.pasaron.length) return <Empty>Ningún producto pasó el filtro esta semana.</Empty>
  return <ul className="semana-rejilla" aria-label="Productos que pasaron el filtro">{d.pasaron.map((p) => <TarjetaPasado key={p.id} p={p} />)}</ul>
}

function Proceso({ lista }: { lista: EnProceso[] }) {
  if (!lista.length) return <Empty>Ningún producto en proceso.</Empty>
  return (
    <ul className="semana-lineas" aria-label="Productos en proceso">
      {lista.map((p) => (
        <li key={p.id} className="card">
          <p><strong>{p.nombre}</strong> · {p.fase}</p>
          <p><strong>Siguiente paso:</strong> {p.siguiente}</p>
          <p><a className="semana-enlace" href={enlaceFichaCompras(p.id)}>Ver su ficha en Compras<span className="visually-hidden">: {p.nombre}</span></a></p>
          <Ids>{p.id}{p.ideaId ? ` · ${p.ideaId}` : ''}</Ids>
        </li>
      ))}
    </ul>
  )
}

function FaltaMedir({ d, pendientes }: { d: Bloque<Dictamen>; pendientes: Pendiente[] }) {
  return (
    <>
      <EstadoBloque bloque={d} nombre="El resultado de la semana">
        {(datos) => (datos.porMedir.length ? (
          <ul className="semana-lineas" aria-label="Ideas que falta medir">
            {datos.porMedir.map((p) => (
              <li key={p.id} className="card">
                <p><strong>{p.nombre}</strong></p>
                <ul className="list">{p.faltas.map((f) => <li key={f}>{f}</li>)}</ul>
                <Ids>{p.id}</Ids>
              </li>
            ))}
          </ul>
        ) : <Empty>Todas tus ideas de la semana ya se pudieron medir.</Empty>)}
      </EstadoBloque>
      {pendientes.length ? (
        <ul className="list" aria-label="Qué hacer">
          {pendientes.map((p, i) => <li key={i}><strong>{p.que}.</strong> {p.hacer}{p.ids ? <>{' '}<Ids>{p.ids}</Ids></> : null}</li>)}
        </ul>
      ) : null}
    </>
  )
}

function Descartados({ d }: { d: Dictamen }) {
  return (
    <details className="section plegable-seccion semana-plegado">
      <summary><h2>Descartados esta semana</h2> <span className="small muted">({d.descartados.length})</span></summary>
      {d.descartados.length ? (
        <div className="table-wrap">
          <table aria-label="Descartados esta semana">
            <thead><tr><th scope="col">Producto</th><th scope="col">Por qué</th></tr></thead>
            <tbody>
              {d.descartados.map((p) => (
                <tr key={p.id}><th scope="row">{p.nombre} <Ids>{p.id}</Ids></th><td>{p.motivos.join('. ')}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <Empty>Nada se descartó esta semana.</Empty>}
    </details>
  )
}

function Hallazgos({ b }: { b: Buscador }) {
  const m = b.marcas
  return (
    <>
      {b.hallazgos.length ? (
        <div className="table-wrap">
          <table aria-label="Lo que encontró el buscador">
            <thead><tr><th scope="col">Producto</th><th scope="col" className="semana-num">Se vende en</th><th scope="col" className="semana-num">Podrías pagar hasta</th></tr></thead>
            <tbody>
              {b.hallazgos.map((h) => (
                <tr key={h.asin}><th scope="row">{h.titulo} <Ids>{h.asin}</Ids></th><td className="semana-num">{pesos(h.precio)}</td><td className="semana-num">{pesos(h.costoMax)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <Empty>El buscador no tiene candidatos nuevos esta semana.</Empty>}
      {m.estado === 'ok' ? (
        <p className="small">
          Se excluyen las {m.total} marcas conocidas de tu lista.{' '}
          {m.quitados ? `Por eso se ${m.quitados === 1 ? 'quitó 1 candidato' : `quitaron ${m.quitados} candidatos`} (${m.ejemplos.join(', ')}${m.quitados > m.ejemplos.length ? '…' : ''}).` : 'Esta semana ningún candidato era de esas marcas.'}
        </p>
      ) : (
        <p className="alert alert-warn" role="note">La lista de marcas conocidas todavía no existe en el libro: se muestran los mejores sin filtrar, y puede haber marcas establecidas entre ellos.</p>
      )}
    </>
  )
}

const tituloSalud: Record<Salud['tono'], string> = { ok: 'Buscador en orden', warn: 'Buscador con avisos', danger: 'Buscador detenido o sin confirmar' }

function SaludBuscador({ s }: { s: Salud }) {
  return (
    <section className={`semana-salud semana-salud-${s.tono}`} role="status" aria-live="polite" aria-labelledby="salud-titulo">
      <h2 id="salud-titulo"><span aria-hidden="true">{s.tono === 'ok' ? '✅' : s.tono === 'warn' ? '⚠️' : '🔴'}</span> {tituloSalud[s.tono]}</h2>
      {s.frases.map((f) => <p key={f}>{f}</p>)}
    </section>
  )
}

function Seccion({ id, titulo, sub, children }: { id: string; titulo: string; sub?: string; children: ReactNode }) {
  return (
    <section className="section" id={id} aria-labelledby={`${id}-titulo`}>
      <h2 id={`${id}-titulo`}>{titulo}</h2>
      {sub ? <p className="muted">{sub}</p> : null}
      {children}
    </section>
  )
}

export default async function EcoSemanaPage() {
  const { result } = await privateEco('/eco/semana')

  if (result.estado === 'no-configurado') {
    return (
      <>
        <h1>ECO esta semana</h1>
        <div className="alert alert-warn" role="status" aria-live="polite">
          <p>RADAROS no está configurado en este despliegue{result.motivo === 'no-valido' ? ' (valor no válido)' : ''}. La activación es del propietario.</p>
        </div>
      </>
    )
  }
  if (result.estado === 'error') {
    return (
      <>
        <h1>ECO esta semana</h1>
        <div className="alert alert-danger" role="alert" aria-live="assertive">
          <h2>No se pudieron leer los datos de la semana</h2>
          <p>{result.message}{result.reintentar ? ' Intenta en un minuto.' : ''}</p>
          <p>Intento: {formatInstant(result.at)} (hora Mérida). No se muestran datos parciales.</p>
        </div>
      </>
    )
  }

  const v = result.vista.semana
  return (
    <>
      <h1>ECO esta semana</h1>
      <p className="muted small" role="status" aria-live="polite">
        Datos del libro de RADAROS, leídos el {formatInstant(result.fetchedAt)} (hora Mérida). Esta página solo lee: nada se guarda desde aquí.
      </p>
      <section className="card semana-frase" aria-label="Resumen de la semana">
        <p className="semana-frase-texto">{v.frase}</p>
        <p className="muted">Meta: {v.meta.texto} el <strong>{v.meta.fechaTexto}</strong> · {v.meta.semanasFaltan === 1 ? 'falta 1 semana' : `faltan ${v.meta.semanasFaltan} semanas`}.</p>
        {v.dictamen.estado === 'ok' && v.dictamen.datos.semana ? <Ids>Semana {v.dictamen.datos.semana}</Ids> : null}
      </section>
      <Seccion id="pasaron" titulo="Pasaron el filtro" sub="Se venden, hay espacio para alguien nuevo y dejan al menos 25 % de ganancia si consigues este costo.">
        <EstadoBloque bloque={v.dictamen} nombre="El resultado de la semana">{(d) => <Pasaron d={d} />}</EstadoBloque>
      </Seccion>
      <Seccion id="proceso" titulo="En proceso" sub="Lo que ya avanzó y qué toca.">
        <EstadoBloque bloque={v.proceso} nombre="La lista de productos en proceso">{(lista) => <Proceso lista={lista} />}</EstadoBloque>
      </Seccion>
      <Seccion id="falta-medir" titulo="Falta medir" sub="Ideas tuyas que el sistema todavía no puede calificar, y qué dato necesita.">
        <FaltaMedir d={v.dictamen} pendientes={v.pendientes} />
      </Seccion>
      {v.dictamen.estado === 'ok' ? <Descartados d={v.dictamen.datos} /> : null}
      <Seccion id="buscador" titulo="Lo que encontró el buscador" sub="El sistema revisa Amazon solo. Estos son los mejores de la semana; todavía no mide su competencia.">
        <EstadoBloque bloque={v.buscador} nombre="La lista del buscador">{(b) => <Hallazgos b={b} />}</EstadoBloque>
      </Seccion>
      <SaludBuscador s={v.salud} />
    </>
  )
}
