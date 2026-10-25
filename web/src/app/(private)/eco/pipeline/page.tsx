import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { Badge, Empty, Section, StateBadge, Text } from '@/components/ui'
import { writeAccess } from '@/components/operations/write-access'
import { formatInstant } from '@/lib/dates'
import { privateEco } from '@/lib/page-data'
import {
  ETAPAS, ETIQUETAS_ETAPA, enEtapa, filtrarTarjetas, paraLector, type PipelineVista, type Tarjeta,
} from '@/lib/radaros/pipeline'
import type { Bloque, Fila } from '@/lib/radaros/tabla'

export const metadata: Metadata = { title: 'Pipeline de ECOMMERCE (solo lectura)' }

type Search = { producto?: string; proveedor?: string; fproveedor?: string; origen?: string; vencidas?: string; estado?: string }

/** Estados vacíos de §8: «pestaña sin crear» y «columna obligatoria ausente»; las demás pestañas se pintan igual. */
function EstadoPipe<T>({ bloque, children }: { bloque: Bloque<T>; children: (datos: T) => ReactNode }) {
  if (bloque.estado === 'ausente' || bloque.estado === 'sin-filas') return <Empty>{bloque.mensaje}</Empty>
  if (bloque.estado === 'columnas-faltantes') {
    return (
      <div className="alert alert-warn" role="alert">
        <p><code>{bloque.tab}</code>: columna obligatoria ausente ({bloque.faltan.join(', ')}). No se muestran sus datos.</p>
      </div>
    )
  }
  return (
    <>
      {bloque.truncado ? (
        <div className="alert alert-warn" role="alert">
          <p><code>{bloque.tab}</code>: truncado; se alcanzó el límite de filas leídas y faltan filas.</p>
        </div>
      ) : null}
      {children(bloque.datos)}
    </>
  )
}

function Dato({ label, value }: { label: string; value: string | null | undefined }) {
  return <div><dt>{label}</dt><dd><Text value={value ?? null} empty="—" /></dd></div>
}

function Tabla({ filas, columnas, label, clave, enlace }: {
  filas: Fila[]; columnas: readonly string[]; label: string; clave: string; enlace?: (f: Fila) => string | null
}) {
  return (
    <div className="table-wrap">
      <table aria-label={label}>
        <thead><tr>{columnas.map((c) => <th key={c} scope="col"><code>{c}</code></th>)}</tr></thead>
        <tbody>
          {filas.map((f, i) => (
            <tr key={`${f[clave] ?? ''}-${i}`}>
              {columnas.map((c) => {
                const href = c === clave && enlace ? enlace(f) : null
                return <td key={c}>{href ? <a href={href}>{f[c]}</a> : <Text value={f[c] ?? null} empty="—" />}</td>
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const fichaProducto = (id: string) => `/eco/pipeline?producto=${encodeURIComponent(id)}#ficha-producto`
const fichaProveedor = (id: string) => `/eco/pipeline?proveedor=${encodeURIComponent(id)}#ficha-proveedor`

function TarjetaProducto({ t }: { t: Tarjeta }) {
  return (
    <li className="card">
      <p className="card-title"><a href={fichaProducto(t.id)}>{t.nombre ?? t.id}</a></p>
      <p className="small mono">{t.id}</p>
      <p className="small">
        ASIN: <Text value={t.asin} empty="—" />
        {t.asinValido === false ? <> <Badge tone="warn" title="10 caracteres A-Z y 0-9">ASIN no válido</Badge></> : null}
      </p>
      <p className="small">{t.dias === null ? 'Días en la etapa: —' : `${t.dias} ${t.dias === 1 ? 'día' : 'días'} en la etapa`}</p>
      {t.proveedorElegido ? <p className="small">Proveedor: {t.proveedorElegido.nombre ?? t.proveedorElegido.id}</p> : null}
      {t.alertas.length ? (
        <p><Badge tone="danger" title={t.alertas.map((a) => a.detalle).join(' ')}>Seguimiento vencido ({t.alertas.length})</Badge></p>
      ) : null}
    </li>
  )
}

function Tablero({ v, filtro }: { v: PipelineVista; filtro: Search }) {
  return (
    <EstadoPipe bloque={v.productos}>
      {({ tarjetas, sinId }) => {
        const proveedores = [...new Map(tarjetas.flatMap((t) => (t.proveedorElegido ? [[t.proveedorElegido.id, t.proveedorElegido]] as const : []))).values()]
        const origenes = [...new Set(tarjetas.map((t) => t.origen).filter((o): o is string => o !== null))].sort()
        const proveedor = proveedores.some((p) => p.id === filtro.fproveedor) ? filtro.fproveedor : undefined
        const origen = filtro.origen && origenes.includes(filtro.origen) ? filtro.origen : undefined
        const vencidas = filtro.vencidas === '1'
        const visibles = filtrarTarjetas(tarjetas, { proveedor, origen, vencidas })
        const fuera = visibles.filter((t) => t.etapa === null)
        return (
          <>
            <form method="get" action="/eco/pipeline#tablero" className="filters" aria-label="Filtrar el tablero">
              <label>Proveedor{' '}
                <select name="fproveedor" defaultValue={proveedor ?? ''}>
                  <option value="">Todos</option>
                  {proveedores.map((p) => <option key={p.id} value={p.id}>{p.nombre ?? p.id}</option>)}
                </select>
              </label>{' '}
              <label>Origen{' '}
                <select name="origen" defaultValue={origen ?? ''}>
                  <option value="">Todos</option>
                  {origenes.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </label>{' '}
              <label><input type="checkbox" name="vencidas" value="1" defaultChecked={vencidas} /> Con seguimiento vencido</label>{' '}
              <button type="submit">Filtrar</button>
            </form>
            {sinId ? <p className="small muted">{sinId} {sinId === 1 ? 'fila' : 'filas'} de PIPE_PRODUCTOS sin PRODUCTO_ID: no se muestran.</p> : null}
            <div className="board">
              {ETAPAS.map((e) => {
                const lista = enEtapa(visibles, e)
                return (
                  <section key={e} className="board-col" aria-label={ETIQUETAS_ETAPA[e]}>
                    <h3>{ETIQUETAS_ETAPA[e]} <span className="muted">({lista.length})</span></h3>
                    {lista.length ? <ul className="plain stack">{lista.map((t) => <TarjetaProducto key={t.id} t={t} />)}</ul> : <p className="small muted">Sin productos.</p>}
                  </section>
                )
              })}
            </div>
            {fuera.length ? (
              <div className="alert alert-warn" role="alert">
                <p>Productos con <code>ETAPA</code> no reconocida (no se pintan en el tablero):</p>
                <ul className="list">{fuera.map((t) => <li key={t.id}><a href={fichaProducto(t.id)}>{t.id}</a>: <Text value={t.etapaTexto} empty="vacía" /></li>)}</ul>
              </div>
            ) : null}
          </>
        )
      }}
    </EstadoPipe>
  )
}

function FichaProducto({ v, t }: { v: PipelineVista; t: Tarjeta }) {
  const f = t.fila
  const cots = v.cotizaciones.estado === 'ok' ? v.cotizaciones.datos.filas.filter((c) => c.PRODUCTO_ID === t.id) : []
  const embs = v.embarques.estado === 'ok' ? v.embarques.datos.filas.filter((e) => e.PRODUCTO_ID === t.id) : []
  const historial = v.historial.estado === 'ok' ? v.historial.datos.filas.filter((h) => h.REGISTRO_ID === t.id) : []
  const k = v.parametros.etiquetasK
  return (
    <Section title={`Ficha de producto · ${t.nombre ?? t.id}`} id="ficha-producto">
      <h3>Identidad</h3>
      <dl className="meta meta-wide">
        <Dato label="PRODUCTO_ID" value={t.id} /><Dato label="Nombre" value={t.nombre} />
        <div><dt>ASIN</dt><dd><Text value={t.asin} empty="—" />{t.asinValido === false ? <> <Badge tone="warn">ASIN no válido</Badge></> : null}</dd></div>
        <Dato label="IDEA_ID" value={f.IDEA_ID} /><Dato label="Origen" value={f.ORIGEN} /><Dato label="Referencia de origen" value={f.ORIGEN_REF} />
        <div><dt>Etapa</dt><dd>{t.etapa ? ETIQUETAS_ETAPA[t.etapa] : <Text value={t.etapaTexto} empty="—" />}</dd></div>
        <Dato label="En la etapa desde" value={f.ETAPA_DESDE} />
        {f.MOTIVO_DESCARTE ? <Dato label="Motivo de descarte" value={f.MOTIVO_DESCARTE} /> : null}
      </dl>
      {f.IDEA_ID ? <p className="small"><a href="/eco#ranking">Datos vivos de la idea en el ranking de /eco</a></p> : null}
      <h3>Keepa (foto)</h3>
      <dl className="meta">
        <Dato label="Fecha" value={f.KEEPA_FECHA} /><Dato label="Precio MXN prom. 90 d" value={f.KEEPA_PRECIO_MXN_AVG90} />
        <Dato label="BSR prom. 90 d" value={f.KEEPA_BSR_AVG90} /><Dato label="Ventas al mes" value={f.KEEPA_VENTAS_MES} />
        <Dato label="Ofertas" value={f.KEEPA_OFERTAS} />
      </dl>
      <h3>Costo máximo y criterios</h3>
      <dl className="meta">
        <Dato label="COSTO_MAX_MXN" value={f.COSTO_MAX_MXN} />
        {(['K1', 'K2', 'K3', 'K4', 'K5', 'K6'] as const).map((c) => <Dato key={c} label={k[c]} value={f[c]} />)}
      </dl>
      <h3>Proveedor y cotizaciones</h3>
      <p className="small">Elegido: {t.proveedorElegido ? <a href={fichaProveedor(t.proveedorElegido.id)}>{t.proveedorElegido.nombre ?? t.proveedorElegido.id}</a> : '—'}</p>
      <EstadoPipe bloque={v.cotizaciones}>
        {() => cots.length ? (
          <Tabla filas={cots} label="Cotizaciones del producto" clave="COTIZACION_ID"
            columnas={['COTIZACION_ID', 'PROVEEDOR_ID', 'ESTADO', 'PRECIO_UNIT', 'MONEDA', 'MOQ', 'PLAZO_PRODUCCION_DIAS', 'INCOTERM', 'COSTO_ATERRIZADO_MXN', 'MUESTRA_ESTADO']} />
        ) : <Empty>Sin cotizaciones.</Empty>}
      </EstadoPipe>
      <h3>Seguimiento</h3>
      {t.alertas.length ? (
        <ul className="list" aria-label="Seguimiento vencido">{t.alertas.map((a, i) => <li key={i}><Badge tone="danger">Vencida</Badge> {a.detalle}</li>)}</ul>
      ) : <p className="small muted">Sin fechas vencidas al {v.hoy}.</p>}
      {t.avisos.length ? <ul className="list" aria-label="Avisos de datos">{t.avisos.map((a) => <li key={a}><Badge tone="warn">Aviso</Badge> {a}</li>)}</ul> : null}
      {cots.length ? (
        <Tabla filas={cots} label="Fechas de cotizaciones y muestras" clave="COTIZACION_ID"
          columnas={['COTIZACION_ID', 'FECHA_SOLICITUD', 'FECHA_RESPUESTA_ESPERADA', 'FECHA_RECIBIDA', 'MUESTRA_FECHA_PEDIDO', 'MUESTRA_FECHA_ESPERADA', 'MUESTRA_FECHA_RECIBIDA']} />
      ) : null}
      <EstadoPipe bloque={v.embarques}>
        {() => embs.length ? (
          <Tabla filas={embs} label="Embarques del producto" clave="EMBARQUE_ID"
            columnas={['EMBARQUE_ID', 'COTIZACION_ID', 'UNIDADES', 'ESTADO', 'FECHA_PAGO', 'FECHA_SALIDA', 'FECHA_LLEGADA_ESPERADA', 'FECHA_LLEGADA']} />
        ) : <Empty>Sin embarques.</Empty>}
      </EstadoPipe>
      <h3>Notas e historial</h3>
      <p><Text value={f.NOTAS ?? null} empty="Sin notas." /></p>
      <EstadoPipe bloque={v.historial}>
        {() => historial.length ? (
          <Tabla filas={historial} label="Historial de etapas" clave="FECHA_HORA" columnas={['FECHA_HORA', 'VALOR_ANTES', 'VALOR_DESPUES']} />
        ) : <Empty>Sin cambios de etapa registrados.</Empty>}
      </EstadoPipe>
    </Section>
  )
}

function Proveedores({ v, filtro, verContacto }: { v: PipelineVista; filtro: Search; verContacto: boolean }) {
  const columnas = ['PROVEEDOR_ID', 'NOMBRE', 'CANAL', 'PAIS', ...(verContacto ? ['CONTACTO'] : []), 'ESTADO']
  return (
    <EstadoPipe bloque={v.proveedores}>
      {({ filas }) => {
        const estados = [...new Set(filas.map((p) => p.ESTADO).filter((e): e is string => e !== null))].sort()
        const estado = filtro.estado && estados.includes(filtro.estado) ? filtro.estado : undefined
        return (
          <>
            <form method="get" action="/eco/pipeline#proveedores" className="filters" aria-label="Filtrar proveedores">
              <label>Estado{' '}
                <select name="estado" defaultValue={estado ?? ''}>
                  <option value="">Todos</option>
                  {estados.map((e) => <option key={e} value={e}>{e}</option>)}
                </select>
              </label>{' '}
              <button type="submit">Filtrar</button>
            </form>
            {verContacto ? null : <p className="small muted"><code>CONTACTO</code> solo lo ve el escritor del dashboard.</p>}
            <Tabla filas={filas.filter((p) => !estado || p.ESTADO === estado)} columnas={columnas} label="Proveedores" clave="PROVEEDOR_ID"
              enlace={(p) => (p.PROVEEDOR_ID ? fichaProveedor(p.PROVEEDOR_ID) : null)} />
          </>
        )
      }}
    </EstadoPipe>
  )
}

function FichaProveedor({ v, p, tarjetas, verContacto }: { v: PipelineVista; p: Fila; tarjetas: Tarjeta[]; verContacto: boolean }) {
  const id = p.PROVEEDOR_ID as string
  const cots = v.cotizaciones.estado === 'ok' ? v.cotizaciones.datos.filas.filter((c) => c.PROVEEDOR_ID === id) : []
  const elegidos = tarjetas.filter((t) => t.proveedorElegido?.id === id)
  return (
    <Section title={`Ficha de proveedor · ${p.NOMBRE ?? id}`} id="ficha-proveedor">
      <dl className="meta meta-wide">
        <Dato label="PROVEEDOR_ID" value={id} /><Dato label="Nombre" value={p.NOMBRE} /><Dato label="Canal" value={p.CANAL} />
        <Dato label="País" value={p.PAIS} />
        {verContacto ? <Dato label="Contacto" value={p.CONTACTO} /> : null}
        <div><dt>Estado</dt><dd><StateBadge code={p.ESTADO ?? null} /></dd></div>
      </dl>
      <p><Text value={p.NOTAS ?? null} empty="Sin notas." /></p>
      <h3>Cotizaciones</h3>
      <EstadoPipe bloque={v.cotizaciones}>
        {() => cots.length ? (
          <Tabla filas={cots} label="Cotizaciones del proveedor" clave="PRODUCTO_ID" enlace={(c) => (c.PRODUCTO_ID ? fichaProducto(c.PRODUCTO_ID) : null)}
            columnas={['PRODUCTO_ID', 'COTIZACION_ID', 'PRECIO_UNIT', 'MONEDA', 'MOQ', 'PLAZO_PRODUCCION_DIAS', 'ESTADO', 'MUESTRA_ESTADO']} />
        ) : <Empty>Sin cotizaciones.</Empty>}
      </EstadoPipe>
      <h3>Productos en los que es el elegido</h3>
      {elegidos.length ? <ul className="list">{elegidos.map((t) => <li key={t.id}><a href={fichaProducto(t.id)}>{t.nombre ?? t.id}</a> ({t.etapa ? ETIQUETAS_ETAPA[t.etapa] : t.etapaTexto ?? '—'})</li>)}</ul> : <Empty>Ninguno.</Empty>}
    </Section>
  )
}

export default async function EcoPipelinePage({ searchParams }: { searchParams: Promise<Search> }) {
  const { user, result } = await privateEco('/eco/pipeline')
  const params = await searchParams

  if (result.estado === 'no-configurado') {
    return (
      <>
        <h1>Pipeline de ECOMMERCE</h1>
        <div className="alert alert-warn" role="status">
          <p>RADAROS no está configurado en este despliegue{result.motivo === 'no-valido' ? ' (valor no válido)' : ''}.</p>
          <p className="small">El pipeline lee la hoja de RADAROS: requiere <code>RADAROS_SHEET_ID</code> (docs/diseno-eco-radaros.md §6).</p>
        </div>
      </>
    )
  }
  if (result.estado === 'error') {
    return (
      <>
        <h1>Pipeline de ECOMMERCE</h1>
        <div className="alert alert-danger" role="alert">
          <h2>No se pudieron leer los datos de RADAROS</h2>
          <p>{result.message}{result.reintentar ? ' Intenta en un minuto.' : ''}</p>
          <p className="muted">Intento: {formatInstant(result.at)} (hora Mérida). No se muestran datos parciales.</p>
        </div>
      </>
    )
  }

  const verContacto = writeAccess(user.email).allowed
  const v = paraLector(result.vista.pipeline, verContacto)
  const tarjetas = v.productos.estado === 'ok' ? v.productos.datos.tarjetas : []
  const producto = params.producto ? tarjetas.find((t) => t.id === params.producto) : undefined
  const proveedor = params.proveedor && v.proveedores.estado === 'ok' ? v.proveedores.datos.filas.find((p) => p.PROVEEDOR_ID === params.proveedor) : undefined
  return (
    <>
      <h1>Pipeline de ECOMMERCE</h1>
      <p className="muted small">
        Solo lectura de las pestañas <code>PIPE_*</code> de la hoja de RADAROS, leída {formatInstant(result.fetchedAt)} (hora
        Mérida). Esta página no escribe, no mueve tarjetas y no calcula costos: muestra lo que hay en la hoja. Vencido = fecha
        esperada anterior a hoy ({v.hoy}).
      </p>
      {v.parametros.bloque.estado === 'ok' ? null : (
        <p className="small muted">
          {v.parametros.bloque.estado === 'columnas-faltantes'
            ? <><code>PIPE_PARAMETROS</code>: columna obligatoria ausente ({v.parametros.bloque.faltan.join(', ')}).</>
            : v.parametros.bloque.mensaje}{' '}
          Se usan las etiquetas K1 … K6 y {v.parametros.diasAlertaEtapa} días de aviso por etapa.
        </p>
      )}
      {v.parametros.avisos.map((a) => <p key={a} className="small"><Badge tone="warn">Aviso</Badge> {a}</p>)}
      <Section title="Tablero" id="tablero"><Tablero v={v} filtro={params} /></Section>
      {params.producto && !producto ? <div className="alert alert-warn" role="status"><p>No hay un producto con ese ID.</p></div> : null}
      {producto ? <FichaProducto v={v} t={producto} /> : null}
      <Section title="Proveedores" id="proveedores"><Proveedores v={v} filtro={params} verContacto={verContacto} /></Section>
      {params.proveedor && !proveedor ? <div className="alert alert-warn" role="status"><p>No hay un proveedor con ese ID.</p></div> : null}
      {proveedor ? <FichaProveedor v={v} p={proveedor} tarjetas={tarjetas} verContacto={verContacto} /> : null}
    </>
  )
}
