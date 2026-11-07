import type { Metadata } from 'next'
import { Badge, Empty, Section, Text } from '@/components/ui'
import { CopiarSeguimiento, DecidirCotizacion, PedirCotizacion, RecibirCotizacion } from '@/components/eco/bandeja-cotizaciones'
import { formatInstant } from '@/lib/dates'
import { privateEco } from '@/lib/page-data'
import { paraLector, type PipelineVista } from '@/lib/radaros/pipeline'
import { construirBandeja, type TarjetaCotizacion } from '@/lib/radaros/pipeline-bandeja'
import { ecoPipelineCanWrite } from '@/lib/radaros/pipeline-escritura-config'
import { CANALES, CAMPOS, DRIVE_URL } from '@/lib/radaros/pipeline-escritura-validacion'
import { versionDeFila } from '@/lib/radaros/pipeline-formularios'
import type { ContextoPegado } from '@/lib/radaros/pipeline-pegado'
import {
  ecoTabuladorHabilitado, formatoMxn, pistasCotizacion, POR_CONFIRMAR, TOPE_CAPITAL_MXN, UNIDAD_PLURAL, veredicto, type PrecioObjetivo,
} from '@/lib/radaros/pipeline-tabulador'

export const metadata: Metadata = { title: 'Cotizaciones' }

/**
 * /eco/cotizaciones (ORD-POS-149, POS-052; docs/diseno-eco-pipeline.md §16): bandeja en 3 pasos — pedir, recibir y
 * decidir — sobre PIPE_COTIZACIONES. Lee lo mismo que /eco/pipeline; los controles de escritura solo los ve el escritor
 * del pipeline (§4.2) y el servidor repite todo. Los números (costo por set, veredicto, precio objetivo y capital) solo
 * con ECO_TABULADOR=true, como «Comparar cotizaciones».
 */

function Objetivo({ o }: { o: PrecioObjetivo | null }) {
  if (!o) return null
  if (o.valor === null) return <p className="small">Precio objetivo: {POR_CONFIRMAR} <span className="muted">({o.motivo})</span></p>
  const unidad = o.unidad ? ` por ${o.unidad === 'SET' ? 'set' : 'pieza'}` : ''
  return (
    <p className="small">
      Precio objetivo: <strong className="mono">{o.valor.toFixed(2)} {o.moneda ?? ''}</strong>{unidad}{o.incoterm ? ` ${o.incoterm}` : ''}
      {o.supuestos.length ? <> <Badge tone="warn" title={o.supuestos.join(', ')}>SUPUESTO</Badge></> : null}
    </p>
  )
}

function Numeros({ t }: { t: TarjetaCotizacion }) {
  const f = t.comparada
  if (!f) return <p className="small muted">El producto no está en PIPE_PRODUCTOS: sin cálculo del tabulador.</p>
  const unidad = f.costo.unidad
  return (
    <dl className="meta">
      <div><dt>Costo por set (MXN)</dt><dd className="mono">{formatoMxn(f.costo.porSetMxn)}{f.costo.supuestos.length ? <> <Badge tone="warn" title={f.costo.supuestos.join(', ')}>SUPUESTO</Badge></> : null}</dd></div>
      <div><dt>Contra el máximo</dt><dd>{f.diferenciaMxn === null ? POR_CONFIRMAR : <Badge tone={f.diferenciaMxn <= 0 ? 'ok' : 'danger'}>{veredicto(f.diferenciaMxn)}</Badge>}</dd></div>
      <div><dt>Capital del lote (tope {formatoMxn(TOPE_CAPITAL_MXN)})</dt><dd>{f.capitalPrimerLoteMxn === null ? POR_CONFIRMAR : <>{formatoMxn(f.capitalPrimerLoteMxn)} {f.capitalPrimerLoteMxn <= TOPE_CAPITAL_MXN ? <Badge tone="ok">Dentro del tope</Badge> : <Badge tone="danger">Excede</Badge>}</>}</dd></div>
      <div><dt>Lote cotizado</dt><dd>{f.costo.cantidad === null ? POR_CONFIRMAR : `${f.costo.cantidad.toLocaleString('es-MX')}${unidad ? ` ${UNIDAD_PLURAL[unidad]}` : ''}`}</dd></div>
    </dl>
  )
}

function Evidencia({ url }: { url: string | null }) {
  if (!url) return null
  // Solo se enlaza una liga de Drive válida; cualquier otra cosa se muestra como texto.
  return DRIVE_URL.test(url)
    ? <p className="small"><a href={url} target="_blank" rel="noopener noreferrer">Evidencia en Drive</a></p>
    : <p className="small">Evidencia: <Text value={url} empty="—" /> <Badge tone="warn">No es una liga de Drive</Badge></p>
}

interface Contexto {
  editable: boolean
  numeros: boolean
  pistas: Record<string, string>
  fleteCedisRef: number | null
  pegado: ContextoPegado
}

function Tarjeta({ t, paso, ctx }: { t: TarjetaCotizacion; paso: 'esperando' | 'porCompletar' | 'listas'; ctx: Contexto }) {
  const f = t.fila
  const version = versionDeFila(f.VERSION)
  return (
    <li className={`card${t.vencida ? ' card-vencida' : ''}`}>
      <p className="card-title"><span className="mono">{t.id}</span> · {t.producto ?? t.productoId ?? '—'}</p>
      <p className="small">Proveedor: {t.proveedor ?? t.proveedorId ?? '—'} · <span className="mono">{t.estado}</span></p>
      {paso === 'esperando' ? (
        <>
          <p className="small">Pedida {f.FECHA_SOLICITUD ?? '—'} · respuesta esperada {f.FECHA_RESPUESTA_ESPERADA ?? '—'}</p>
          {t.vencida ? <p><Badge tone="danger">Vencida</Badge></p> : null}
          <CopiarSeguimiento texto={t.seguimiento} />
        </>
      ) : (
        <p className="small">
          Precio: <Text value={f.PRECIO_UNIT ?? null} empty="—" /> {f.MONEDA ?? ''}{f.PRECIO_POR ? ` por ${f.PRECIO_POR.toLowerCase()}` : ''} {f.INCOTERM ?? ''}
          {f.MOQ ? ` · MOQ ${f.MOQ}` : ''}
        </p>
      )}
      {paso === 'porCompletar' ? (
        <ul className="list small" aria-label={`Qué falta en ${t.id}`}>{t.faltan.map((m) => <li key={m}><Badge tone="warn">{POR_CONFIRMAR}</Badge> {m}</li>)}</ul>
      ) : null}
      {paso === 'listas' && ctx.numeros ? <Numeros t={t} /> : null}
      {paso !== 'esperando' && ctx.numeros ? <Objetivo o={t.objetivo} /> : null}
      <Evidencia url={f.EVIDENCIA_URL ?? null} />
      {ctx.editable && version === null ? <p className="small muted">Sin VERSION válida: no se edita desde aquí.</p> : null}
      {ctx.editable && version !== null ? (
        <div className="card-actions stack">
          {paso !== 'listas' ? (
            <RecibirCotizacion id={t.id} version={version} fila={f} defectos={t.defectos} campos={CAMPOS['eco.cotizacion.editar']}
              pistas={ctx.pistas} fleteCedisRef={ctx.fleteCedisRef} pegado={ctx.pegado} />
          ) : null}
          <DecidirCotizacion id={t.id} version={version} estado={t.estado} notas={f.NOTAS ?? ''} precio={f.PRECIO_UNIT ?? null}
            moneda={f.MONEDA ?? null} historial={f.PRECIO_HISTORIAL ?? null} />
        </div>
      ) : (f.PRECIO_HISTORIAL ? <p className="small muted">Precios anteriores: {f.PRECIO_HISTORIAL}</p> : null)}
    </li>
  )
}

const PASOS = [
  { paso: 'esperando', titulo: 'Esperando respuesta', vacio: 'Ninguna cotización SOLICITADA.' },
  { paso: 'porCompletar', titulo: 'Por completar', vacio: 'Ninguna RECIBIDA a la que le falten datos.' },
  { paso: 'listas', titulo: 'Listas para comparar', vacio: 'Ninguna lista todavía.' },
] as const

function contextoPegado(v: PipelineVista, fleteCedisRef: number | null): ContextoPegado {
  return {
    campos: CAMPOS['eco.cotizacion.crear'],
    fleteCedisRef,
    productos: v.productos.estado === 'ok' ? v.productos.datos.tarjetas.map((t) => ({ id: t.id, ideaId: t.fila.IDEA_ID ?? null, etapa: t.etapaTexto })) : [],
    proveedores: v.proveedores.estado === 'ok' ? v.proveedores.datos.filas.flatMap((p) => (p.PROVEEDOR_ID && p.NOMBRE ? [{ id: p.PROVEEDOR_ID, nombre: p.NOMBRE }] : [])) : [],
    cotizaciones: [],
  }
}

export default async function EcoCotizacionesPage() {
  const { user, result } = await privateEco('/eco/cotizaciones')
  if (result.estado !== 'ok') {
    return (
      <>
        <h1>Cotizaciones</h1>
        <div className={`alert ${result.estado === 'error' ? 'alert-danger' : 'alert-warn'}`} role="alert">
          <p>{result.estado === 'error' ? `No se pudieron leer los datos de RADAROS. ${result.message}` : 'RADAROS no está configurado en este despliegue (RADAROS_SHEET_ID).'}</p>
        </div>
      </>
    )
  }
  const editable = ecoPipelineCanWrite(user.email)
  // CONTACTO y NOTAS del proveedor nunca se usan aquí; se recortan igual que en /eco/pipeline para un lector.
  const v = paraLector(result.vista.pipeline, editable)
  const tab = result.vista.tabulador
  const numeros = ecoTabuladorHabilitado()
  const bandeja = construirBandeja(v, tab)
  const fleteCedisRef = editable ? tab.parametros.numero('FLETE_CEDIS_REF') : null
  const ctx: Contexto = { editable, numeros, pistas: editable ? pistasCotizacion(tab.parametros) : {}, fleteCedisRef, pegado: contextoPegado(v, fleteCedisRef) }
  const productos = v.productos.estado === 'ok'
    ? v.productos.datos.tarjetas.filter((t) => t.etapa !== 'DESCARTADO').map((t) => ({ id: t.id, nombre: t.nombre }))
    : []
  const proveedores = v.proveedores.estado === 'ok'
    ? v.proveedores.datos.filas.flatMap((p) => (p.PROVEEDOR_ID && p.NOMBRE && p.ESTADO === 'ACTIVO' ? [{ id: p.PROVEEDOR_ID, nombre: p.NOMBRE, canal: p.CANAL ?? null, pais: p.PAIS ?? null }] : []))
    : []
  return (
    <>
      <h1>Cotizaciones</h1>
      <p className="muted small">
        <code>PIPE_COTIZACIONES</code> de RADAROS, leída {formatInstant(result.fetchedAt)} (hora Mérida). Vencida = respuesta esperada
        anterior a hoy ({bandeja.hoy}). <a href="/eco/pipeline">Volver al pipeline</a>.
        {numeros ? ' Los números salen del tabulador (DEC-ECO-008).' : ' Tabulador apagado (ECO_TABULADOR): sin costos ni precio objetivo.'}
      </p>
      {tab.migracion && tab.migracion.faltan.length ? (
        <p className="small"><Badge tone="warn">Migración pendiente</Badge> <code>PIPE_COTIZACIONES</code> aún no tiene {tab.migracion.faltan.join(', ')} (la agrega el propietario, docs/diseno-eco-pipeline.md §14.1 y §16.1).</p>
      ) : null}
      {editable ? (
        <Section title="Pedir" id="pedir">
          <PedirCotizacion productos={productos} proveedores={proveedores} canales={CANALES} />
        </Section>
      ) : null}
      {v.cotizaciones.estado === 'ok' || v.cotizaciones.estado === 'sin-filas' ? (
        <div className="board board-3">
          {PASOS.map(({ paso, titulo, vacio }) => (
            <section key={paso} className="board-col" aria-label={titulo}>
              <h3>{titulo} <span className="muted">({bandeja[paso].length})</span></h3>
              {bandeja[paso].length ? <ul className="plain stack">{bandeja[paso].map((t) => <Tarjeta key={t.id} t={t} paso={paso} ctx={ctx} />)}</ul> : <p className="small muted">{vacio}</p>}
            </section>
          ))}
        </div>
      ) : (
        <Empty>{v.cotizaciones.estado === 'columnas-faltantes' ? `PIPE_COTIZACIONES: columna obligatoria ausente (${v.cotizaciones.faltan.join(', ')}).` : v.cotizaciones.mensaje}</Empty>
      )}
      {bandeja.fuera ? <p className="small muted">{bandeja.fuera} {bandeja.fuera === 1 ? 'cotización RECHAZADA o con otro estado no aparece' : 'cotizaciones RECHAZADAS o con otro estado no aparecen'} en la bandeja; están en <a href="/eco/pipeline">el pipeline</a>.</p> : null}
    </>
  )
}
