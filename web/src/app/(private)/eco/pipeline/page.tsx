import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { Badge, Empty, Section, StateBadge, Text } from '@/components/ui'
import { ColumnaSoltable, TableroEditable, TarjetaMovible } from '@/components/eco/tablero-escritura'
import { FormularioEco } from '@/components/eco/formularios-pipeline'
import { PegarTablaGemini } from '@/components/eco/pegar-gemini'
import { writeAccess } from '@/components/operations/write-access'
import { formatInstant } from '@/lib/dates'
import { privateEco } from '@/lib/page-data'
import {
  ETAPAS, ETIQUETAS_ETAPA, enEtapa, filtrarTarjetas, paraLector, type PipelineVista, type Tarjeta,
} from '@/lib/radaros/pipeline'
import { etiquetaIdea } from '@/lib/radaros/eco-columnas'
import { ecoPipelineCanWrite } from '@/lib/radaros/pipeline-escritura-config'
import { CAMPOS, type EcoCampoOperacion } from '@/lib/radaros/pipeline-escritura-validacion'
import { versionDeFila } from '@/lib/radaros/pipeline-formularios'
import type { ContextoPegado } from '@/lib/radaros/pipeline-pegado'
import type { Bloque, Fila } from '@/lib/radaros/tabla'
import { FiltroAuto } from '@/components/filtro-auto'
import {
  ecoTabuladorHabilitado, ESTADOS_TABULADOR, formatoMxn, pistasCotizacion, POR_CONFIRMAR, TOPE_CAPITAL_MXN, UNIDAD_PLURAL, veredicto,
  type PrecioPor,
  type Componente, type FilaComparada, type TabuladorVista,
} from '@/lib/radaros/pipeline-tabulador'

export const metadata: Metadata = { title: 'Pipeline de ECOMMERCE' }

type Search = { producto?: string; proveedor?: string; fproveedor?: string; origen?: string; vencidas?: string; estado?: string; comparar?: string }

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

/** ORD-POS-110: formulario de edición con la VERSION de la fila; la clave lo rehace cuando la hoja sube la versión. */
function Editar({ titulo, ruta, id, op, fila }: { titulo: string; ruta: string; id: string; op: EcoCampoOperacion; fila: Fila }) {
  const version = versionDeFila(fila.VERSION)
  if (version === null) return <p className="small muted">{titulo}: sin VERSION válida; no se edita desde aquí.</p>
  return <FormularioEco key={`${id}-${version}`} titulo={titulo} url={`/api/eco/pipeline/${ruta}/${encodeURIComponent(id)}`} campos={CAMPOS[op]} iniciales={fila} version={version} />
}

const fichaProducto = (id: string) => `/eco/pipeline?producto=${encodeURIComponent(id)}#ficha-producto`
const fichaProveedor = (id: string) => `/eco/pipeline?proveedor=${encodeURIComponent(id)}#ficha-proveedor`

function ContenidoTarjeta({ t }: { t: Tarjeta }) {
  return (
    <>
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
    </>
  )
}

/** VERSION entera ≥ 1, o null: una fila sin VERSION (escrita a mano) no se puede mover desde el tablero. */
function versionDe(t: Tarjeta): number | null {
  const n = Number(t.fila.VERSION ?? '')
  return Number.isInteger(n) && n >= 1 ? n : null
}

/** §2.1: con escritura, arrastrable y con «Mover a…»; sin ella, la misma tarjeta sin controles. */
function TarjetaProducto({ t, editable }: { t: Tarjeta; editable: boolean }) {
  const version = versionDe(t)
  if (editable && t.etapa && version !== null) {
    return <TarjetaMovible id={t.id} version={version} etapa={t.etapa} nombre={t.nombre ?? t.id}><ContenidoTarjeta t={t} /></TarjetaMovible>
  }
  return <li className="card"><ContenidoTarjeta t={t} />{editable ? <p className="small muted">Sin VERSION válida: no se mueve desde aquí.</p> : null}</li>
}

function Tablero({ v, filtro, editable }: { v: PipelineVista; filtro: Search; editable: boolean }) {
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
              <FiltroAuto />
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
            {editable ? (
              <TableroEditable etiquetas={ETIQUETAS_ETAPA}>
                <div className="board">
                  {ETAPAS.map((e) => (
                    <ColumnaSoltable key={e} etapa={e} label={ETIQUETAS_ETAPA[e]}>
                      <Columna e={e} lista={enEtapa(visibles, e)} editable />
                    </ColumnaSoltable>
                  ))}
                </div>
              </TableroEditable>
            ) : (
              <div className="board">
                {ETAPAS.map((e) => (
                  <section key={e} className="board-col" aria-label={ETIQUETAS_ETAPA[e]}>
                    <Columna e={e} lista={enEtapa(visibles, e)} editable={false} />
                  </section>
                ))}
              </div>
            )}
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

function Columna({ e, lista, editable }: { e: (typeof ETAPAS)[number]; lista: Tarjeta[]; editable: boolean }) {
  return (
    <>
      <h3>{ETIQUETAS_ETAPA[e]} <span className="muted">({lista.length})</span></h3>
      {lista.length ? <ul className="plain stack">{lista.map((t) => <TarjetaProducto key={t.id} t={t} editable={editable} />)}</ul> : <p className="small muted">Sin productos.</p>}
    </>
  )
}

/** ORD-POS-146 (criterio 1): proveedores existentes, para avisar de un nombre repetido antes de enviar. */
function proveedoresExistentes(v: PipelineVista): Array<{ id: string; nombre: string }> {
  return v.proveedores.estado === 'ok'
    ? v.proveedores.datos.filas.flatMap((p) => (p.PROVEEDOR_ID && p.NOMBRE ? [{ id: p.PROVEEDOR_ID, nombre: p.NOMBRE }] : []))
    : []
}

/** ORD-POS-146 (criterio 3): lo que el pegado necesita de la hoja para resolver y revisar cada fila. */
function contextoPegado(v: PipelineVista, tarjetas: Tarjeta[], fleteCedisRef: number | null): ContextoPegado {
  const cots = v.cotizaciones.estado === 'ok' ? v.cotizaciones.datos.filas : []
  return {
    campos: CAMPOS['eco.cotizacion.crear'],
    fleteCedisRef,
    productos: tarjetas.map((t) => ({ id: t.id, ideaId: t.fila.IDEA_ID ?? null, etapa: t.etapaTexto })),
    proveedores: proveedoresExistentes(v),
    cotizaciones: cots.flatMap((c) => (c.COTIZACION_ID ? [{
      id: c.COTIZACION_ID, productoId: c.PRODUCTO_ID ?? null, proveedorId: c.PROVEEDOR_ID ?? null, incoterm: c.INCOTERM ?? null,
      precioUnit: c.PRECIO_UNIT ?? null, moneda: c.MONEDA ?? null,
    }] : [])),
  }
}

/**
 * «Alta rápida» (ORD-POS-146): proveedor, cotización con las columnas del tabulador y el pegado de la tabla B de Gemini.
 * Reúsa `FormularioEco` y las rutas de alta; solo la ve el escritor del pipeline (§4.2) y el servidor repite todo.
 */
function AltaRapida({ v, tarjetas, pistas, fleteCedisRef }: { v: PipelineVista; tarjetas: Tarjeta[]; pistas: Record<string, string>; fleteCedisRef: number | null }) {
  return (
    <Section title="Alta rápida de proveedores y cotizaciones" id="alta-rapida">
      <p className="small muted">
        Solo escribe tu sesión del dashboard: el token del PM y los de otros agentes se rechazan. Sin correos ni teléfonos de
        personas. Los campos vacíos de la cotización toman el valor de <code>PIPE_PARAMETROS</code> que indica cada uno.
      </p>
      <FormularioEco titulo="Nuevo proveedor" url="/api/eco/pipeline/proveedores" campos={CAMPOS['eco.proveedor.crear']}
        duplicados={{ clave: 'nombre', existentes: proveedoresExistentes(v) }} />
      <FormularioEco titulo="Nueva cotización" url="/api/eco/pipeline/cotizaciones" campos={CAMPOS['eco.cotizacion.crear']} pistas={pistas} entregaCedis={{ fleteCedisRef }} />
      <PegarTablaGemini contexto={contextoPegado(v, tarjetas, fleteCedisRef)} pistas={pistas} />
    </Section>
  )
}

function FichaProducto({ v, t, editable, nombres, pistas, fleteCedisRef, completas }: { v: PipelineVista; t: Tarjeta; editable: boolean; nombres: Map<string, string>; pistas: Record<string, string>; fleteCedisRef: number | null; completas: Map<string, Fila> }) {
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
        <Dato label="Idea" value={f.IDEA_ID ? etiquetaIdea(f.IDEA_ID, nombres.get(f.IDEA_ID)) : null} /><Dato label="Origen" value={f.ORIGEN} /><Dato label="Referencia de origen" value={f.ORIGEN_REF} />
        <div><dt>Etapa</dt><dd>{t.etapa ? ETIQUETAS_ETAPA[t.etapa] : <Text value={t.etapaTexto} empty="—" />}</dd></div>
        <Dato label="En la etapa desde" value={f.ETAPA_DESDE} />
        {f.MOTIVO_DESCARTE ? <Dato label="Motivo de descarte" value={f.MOTIVO_DESCARTE} /> : null}
      </dl>
      {f.IDEA_ID ? <p className="small"><a href="/eco#ranking">Datos vivos de la idea en el ranking de /eco</a></p> : null}
      {editable ? <Editar titulo="Editar producto" ruta="productos" id={t.id} op="eco.producto.editar" fila={f} /> : null}
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
      {editable ? (
        <>
          {cots.map((c) => c.COTIZACION_ID ? <Editar key={c.COTIZACION_ID} titulo={`Editar cotización ${c.COTIZACION_ID}`} ruta="cotizaciones" id={c.COTIZACION_ID} op="eco.cotizacion.editar" fila={completas.get(c.COTIZACION_ID) ?? c} /> : null)}
          <FormularioEco titulo="Nueva cotización" url="/api/eco/pipeline/cotizaciones" campos={CAMPOS['eco.cotizacion.crear']} iniciales={{ PRODUCTO_ID: t.id }} pistas={pistas} entregaCedis={{ fleteCedisRef }} />
        </>
      ) : null}
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
      {editable ? (
        <>
          {embs.map((e) => e.EMBARQUE_ID ? <Editar key={e.EMBARQUE_ID} titulo={`Editar embarque ${e.EMBARQUE_ID}`} ruta="embarques" id={e.EMBARQUE_ID} op="eco.embarque.editar" fila={e} /> : null)}
          <FormularioEco titulo="Nuevo embarque" url="/api/eco/pipeline/embarques" campos={CAMPOS['eco.embarque.crear']} iniciales={{ PRODUCTO_ID: t.id }} />
        </>
      ) : null}
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
              <FiltroAuto />
              <label>Estado{' '}
                <select name="estado" defaultValue={estado ?? ''}>
                  <option value="">Todos</option>
                  {estados.map((e) => <option key={e} value={e}>{e}</option>)}
                </select>
              </label>{' '}
              <button type="submit">Filtrar</button>
            </form>
            {verContacto ? null : <p className="small muted"><code>CONTACTO</code> solo lo ve el escritor del dashboard, igual que las notas del proveedor.</p>}
            <Tabla filas={filas.filter((p) => !estado || p.ESTADO === estado)} columnas={columnas} label="Proveedores" clave="PROVEEDOR_ID"
              enlace={(p) => (p.PROVEEDOR_ID ? fichaProveedor(p.PROVEEDOR_ID) : null)} />
          </>
        )
      }}
    </EstadoPipe>
  )
}

function FichaProveedor({ v, p, tarjetas, verContacto, editable }: { v: PipelineVista; p: Fila; tarjetas: Tarjeta[]; verContacto: boolean; editable: boolean }) {
  const id = p.PROVEEDOR_ID as string
  const cots = v.cotizaciones.estado === 'ok' ? v.cotizaciones.datos.filas.filter((c) => c.PROVEEDOR_ID === id) : []
  const elegidos = tarjetas.filter((t) => t.proveedorElegido?.id === id)
  return (
    <Section title={`Ficha de proveedor · ${p.NOMBRE ?? id}`} id="ficha-proveedor">
      <dl className="meta meta-wide">
        <Dato label="PROVEEDOR_ID" value={id} /><Dato label="Nombre" value={p.NOMBRE} /><Dato label="Canal" value={p.CANAL} />
        <Dato label="País" value={p.PAIS} />
        <Dato label="Años en la plataforma" value={p.ANOS_PLATAFORMA} /><Dato label="Verified Supplier" value={p.VERIFIED_SUPPLIER} />
        <Dato label="Trade Assurance" value={p.TRADE_ASSURANCE} />
        {verContacto ? <Dato label="Contacto" value={p.CONTACTO} /> : null}
        <div><dt>Estado</dt><dd><StateBadge code={p.ESTADO ?? null} /></dd></div>
      </dl>
      {verContacto ? <p><Text value={p.NOTAS ?? null} empty="Sin notas." /></p> : null}
      {editable ? <Editar titulo="Editar proveedor" ruta="proveedores" id={id} op="eco.proveedor.editar" fila={p} /> : null}
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

const ETIQUETA_ORIGEN: Record<Componente['origen'], string> = { COTIZACION: 'Cotización', SUPUESTO: 'SUPUESTO', POR_CONFIRMAR: POR_CONFIRMAR }

/** Desglose visible del costo aterrizado (criterio 3): cada componente con su origen; un faltante dice «Por confirmar». */
function Desglose({ f }: { f: FilaComparada }) {
  const c = f.costo
  return (
    <details>
      <summary>Desglose de {f.id} ({c.base ? `${c.incoterm} → ${c.base}` : 'INCOTERM no válido'})</summary>
      <div className="table-wrap">
        <table aria-label={`Desglose de ${f.id}`}>
          <thead><tr><th scope="col">Componente</th><th scope="col">MXN</th><th scope="col">Origen</th><th scope="col">Detalle</th></tr></thead>
          <tbody>
            {c.componentes.map((x) => (
              <tr key={`${x.clave}-${x.etiqueta}`}>
                <td>{x.etiqueta}</td><td className="mono">{formatoMxn(x.mxn)}</td>
                <td>{x.origen === 'COTIZACION' ? ETIQUETA_ORIGEN[x.origen] : <Badge tone="warn">{ETIQUETA_ORIGEN[x.origen]}</Badge>}</td>
                <td><Text value={x.detalle} empty="—" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="meta">
        <Dato label="Valor en aduana (MXN)" value={c.base === 'DDP' ? 'No aplica (DDP)' : formatoMxn(c.valorAduanaMxn)} />
        <Dato label="Total del embarque (MXN)" value={formatoMxn(c.totalMxn)} />
        <Dato label="El precio es por" value={c.unidad ? c.unidad.toLowerCase() : POR_CONFIRMAR} />
        <Dato label="Sets" value={c.sets === null ? POR_CONFIRMAR : String(Number(c.sets.toFixed(4)))} />
        <Dato label="Costo aterrizado por set (MXN)" value={formatoMxn(c.porSetMxn)} />
        <Dato label="Tipo de cambio" value={c.tipoCambio ? `${c.tipoCambio.valor}${c.tipoCambio.fecha ? ` (${c.tipoCambio.fecha})` : ''}${c.tipoCambio.origen === 'SUPUESTO' ? ' · SUPUESTO' : ''}` : POR_CONFIRMAR} />
        {f.calcHoja ? <Dato label="COSTO_ATERRIZADO_CALC_MXN en la hoja" value={`${f.calcHoja.valor}${f.calcHoja.difiere ? ' (no coincide con el cálculo)' : ''}`} /> : null}
      </dl>
      {c.porConfirmar.length ? <ul className="list" aria-label={`Por confirmar en ${f.id}`}>{c.porConfirmar.map((m) => <li key={m}><Badge tone="warn">{POR_CONFIRMAR}</Badge> {m}</li>)}</ul> : null}
      {c.avisos.length ? <ul className="list">{c.avisos.map((m) => <li key={m}><Badge tone="warn">Aviso</Badge> {m}</li>)}</ul> : null}
      <p className="small muted">El IVA de importación no entra en el costo aterrizado: va aparte, como flujo de efectivo.</p>
    </details>
  )
}

/** ORD-POS-147 (criterio 4): MOQ y cantidad con su unidad («500 sets», «600 piezas»). */
function enUnidad(n: number, unidad: PrecioPor | null): string {
  return unidad ? `${n.toLocaleString('es-MX')} ${UNIDAD_PLURAL[unidad]}` : String(n)
}

/** Vista «Comparar» por producto (criterios 4 y 5), solo con ECO_TABULADOR=true. */
function Comparar({ tab, tarjetas, productoId }: { tab: TabuladorVista; tarjetas: Tarjeta[]; productoId: string | undefined }) {
  const elegido = productoId ? tarjetas.find((t) => t.id === productoId) : undefined
  const cmp = elegido ? tab.comparar(elegido.id, elegido.fila.IDEA_ID ?? null) : null
  const max = cmp?.costoMaximo
  return (
    <>
      <form method="get" action="/eco/pipeline#comparar" className="filters" aria-label="Elegir producto para comparar">
        <FiltroAuto />
        <label>Producto{' '}
          <select name="comparar" defaultValue={elegido?.id ?? ''}>
            <option value="">Elige un producto</option>
            {tarjetas.map((t) => <option key={t.id} value={t.id}>{t.nombre ? `${t.id} · ${t.nombre}` : t.id}</option>)}
          </select>
        </label>{' '}
        <button type="submit">Comparar</button>
      </form>
      {tab.migracion && tab.migracion.faltan.length ? (
        <p className="small"><Badge tone="warn">Migración pendiente</Badge> <code>PIPE_COTIZACIONES</code> aún no tiene {tab.migracion.faltan.join(', ')} (la agrega el propietario, docs/diseno-eco-pipeline.md §14.1). Esos componentes quedan «{POR_CONFIRMAR}» o SUPUESTO.</p>
      ) : null}
      {tab.parametros.avisos.map((a) => <p key={a} className="small"><Badge tone="warn">Aviso</Badge> {a}</p>)}
      {productoId && !elegido ? <div className="alert alert-warn" role="status"><p>No hay un producto con ese ID.</p></div> : null}
      {cmp && max && elegido ? (
        <>
          <h3>{elegido.nombre ?? elegido.id}: costo máximo</h3>
          <dl className="meta">
            <Dato label="COSTO_MAX_MXN calculado" value={formatoMxn(max.mxn)} />
            <Dato label="Fecha de sus datos" value={max.fecha} />
            <Dato label="Precio de venta" value={max.precio ? `${formatoMxn(max.precio.mxn)} (${max.precio.fuente})` : POR_CONFIRMAR} />
            <Dato label="Comisión de Amazon" value={formatoMxn(max.comisionMxn)} />
            <Dato label="FBA" value={formatoMxn(max.fbaMxn)} />
            <Dato label="PPC, devoluciones y margen K2" value={`${max.porcentajes.ppc * 100} %, ${max.porcentajes.devoluciones * 100} % y ${max.porcentajes.margenK2 * 100} % del precio`} />
            <Dato label="COSTO_MAX_MXN en la hoja (manual)" value={elegido.fila.COSTO_MAX_MXN} />
          </dl>
          {max.porConfirmar.length ? <ul className="list">{max.porConfirmar.map((m) => <li key={m}><Badge tone="warn">{POR_CONFIRMAR}</Badge> {m}</li>)}</ul> : null}
          {cmp.filas.length ? (
            <>
              <div className="table-wrap">
                <table aria-label="Cotizaciones comparadas">
                  <thead>
                    <tr>
                      {['Cotización', 'Estado', 'Proveedor', 'País', 'Incoterm', 'Precio por', 'MOQ', 'Cantidad cotizada', 'Plazo (días)', 'Costo aterrizado por set (MXN)', 'Contra el máximo', `Capital del primer lote (tope ${formatoMxn(TOPE_CAPITAL_MXN)} MXN)`, 'Mínimo del proveedor (MXN)', 'Sets que caben en el tope'].map((h) => <th key={h} scope="col">{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {cmp.filas.map((f) => (
                      <tr key={f.id}>
                        <td className="mono">{f.id}</td>
                        <td><Text value={f.estado} empty="—" />{f.estadoValido ? null : <> <Badge tone="warn" title={ESTADOS_TABULADOR.join(', ')}>Estado no válido</Badge></>}</td>
                        <td><Text value={f.proveedor ?? f.proveedorId} empty="—" /></td>
                        <td><Text value={f.pais} empty="—" /></td>
                        <td><Text value={f.incoterm} empty="—" /></td>
                        <td>{f.costo.unidad ? f.costo.unidad.toLowerCase() : POR_CONFIRMAR}</td>
                        <td>{f.moq === null ? POR_CONFIRMAR : enUnidad(f.moq, f.costo.unidad)}</td>
                        <td>{f.costo.cantidad === null ? POR_CONFIRMAR : enUnidad(f.costo.cantidad, f.costo.unidad)}</td>
                        <td><Text value={f.plazoDias} empty="—" /></td>
                        <td className="mono">{formatoMxn(f.costo.porSetMxn)}{f.costo.supuestos.length ? <> <Badge tone="warn" title={f.costo.supuestos.join(', ')}>SUPUESTO</Badge></> : null}</td>
                        <td>{f.diferenciaMxn === null ? POR_CONFIRMAR : <Badge tone={f.diferenciaMxn <= 0 ? 'ok' : 'danger'}>{veredicto(f.diferenciaMxn)}</Badge>}</td>
                        <td>{f.capitalPrimerLoteMxn === null ? POR_CONFIRMAR : <>{formatoMxn(f.capitalPrimerLoteMxn)} {f.capitalPrimerLoteMxn <= TOPE_CAPITAL_MXN ? <Badge tone="ok">Dentro del tope</Badge> : <Badge tone="danger">Excede por {formatoMxn(f.capitalPrimerLoteMxn - TOPE_CAPITAL_MXN)} MXN</Badge>}</>}</td>
                        <td className="mono">{formatoMxn(f.minimoProveedorMxn)}</td>
                        <td>{f.setsEnTope === null ? POR_CONFIRMAR : f.setsEnTope.toLocaleString('es-MX')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {cmp.filas.map((f) => <Desglose key={f.id} f={f} />)}
            </>
          ) : <Empty>Sin cotizaciones para este producto.</Empty>}
        </>
      ) : null}
    </>
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

  // §4.2: arrastre, «Mover a…» y los formularios (ORD-POS-110) solo para ECO_PIPELINE_WRITER_EMAIL con la escritura activa; el servidor repite todo.
  const editable = ecoPipelineCanWrite(user.email)
  const verContacto = writeAccess(user.email).allowed || editable
  const v = paraLector(result.vista.pipeline, verContacto)
  // ORD-POS-145: la vista «Comparar» solo con ECO_TABULADOR=true (la pone el propietario con deploy.sh).
  const tabulador = ecoTabuladorHabilitado() ? result.vista.tabulador : null
  const tarjetas = v.productos.estado === 'ok' ? v.productos.datos.tarjetas : []
  // ORD-POS-146 (criterio 2): las pistas leen PIPE_PARAMETROS aunque ECO_TABULADOR esté apagada (solo texto, sin cálculo).
  const pistas = editable ? pistasCotizacion(result.vista.tabulador.parametros) : {}
  // ORD-POS-147 (criterio 2): sin la casilla de DDP y sin este parámetro, el alta pide el flete al CEDIS.
  const fleteCedisRef = editable ? result.vista.tabulador.parametros.numero('FLETE_CEDIS_REF') : null
  const producto = params.producto ? tarjetas.find((t) => t.id === params.producto) : undefined
  const proveedor = params.proveedor && v.proveedores.estado === 'ok' ? v.proveedores.datos.filas.find((p) => p.PROVEEDOR_ID === params.proveedor) : undefined
  return (
    <>
      <h1>Pipeline de ECOMMERCE</h1>
      <p className="muted small">
        Pestañas <code>PIPE_*</code> de la hoja de RADAROS, leídas {formatInstant(result.fetchedAt)} (hora Mérida).{' '}
        {editable
          ? 'Puedes arrastrar una tarjeta o usar «Mover a…»: solo cambia de columna cuando la hoja lo confirma.'
          : 'Solo lectura: esta vista no mueve tarjetas.'}{' '}
        {tabulador ? 'Solo «Comparar cotizaciones» calcula costos (DEC-ECO-008); el resto muestra lo que hay en la hoja.' : 'No calcula costos: muestra lo que hay en la hoja.'} Vencido = fecha esperada anterior a hoy ({v.hoy}).
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
      <p className="small"><a href="/eco/cotizaciones">Cotizaciones: bandeja para pedir, recibir y decidir</a></p>
      <Section title="Tablero" id="tablero">
        {editable ? <FormularioEco titulo="Nuevo producto" url="/api/eco/pipeline/productos" campos={CAMPOS['eco.producto.crear']} /> : null}
        <Tablero v={v} filtro={params} editable={editable} />
      </Section>
      {editable ? <AltaRapida v={v} tarjetas={tarjetas} pistas={pistas} fleteCedisRef={fleteCedisRef} /> : null}
      {tabulador ? (
        <Section title="Comparar cotizaciones" id="comparar">
          <EstadoPipe bloque={tabulador.bloque}>{() => <Comparar tab={tabulador} tarjetas={tarjetas} productoId={params.comparar} />}</EstadoPipe>
        </Section>
      ) : null}
      {params.producto && !producto ? <div className="alert alert-warn" role="status"><p>No hay un producto con ese ID.</p></div> : null}
      {producto ? <FichaProducto v={v} t={producto} editable={editable} nombres={result.vista.nombres} pistas={pistas} fleteCedisRef={fleteCedisRef}
        completas={new Map(result.vista.tabulador.cotizaciones.flatMap((c) => (c.COTIZACION_ID ? [[c.COTIZACION_ID, c] as const] : [])))} /> : null}
      <Section title="Proveedores" id="proveedores">
        {editable ? <p className="small"><a href="#alta-rapida">Nuevo proveedor en «Alta rápida»</a></p> : null}
        <Proveedores v={v} filtro={params} verContacto={verContacto} />
      </Section>
      {params.proveedor && !proveedor ? <div className="alert alert-warn" role="status"><p>No hay un proveedor con ese ID.</p></div> : null}
      {proveedor ? <FichaProveedor v={v} p={proveedor} tarjetas={tarjetas} verContacto={verContacto} editable={editable} /> : null}
    </>
  )
}
