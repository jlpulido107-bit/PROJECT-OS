import { Badge, Text } from '@/components/ui'
import { CopiarSeguimiento, DecidirCotizacion, RecibirCotizacion } from '@/components/eco/bandeja-cotizaciones'
import type { Columna, TarjetaCotizacion as Cot } from '@/lib/radaros/pipeline-bandeja'
import { CAMPOS, DRIVE_URL } from '@/lib/radaros/pipeline-escritura-validacion'
import { versionDeFila } from '@/lib/radaros/pipeline-formularios'
import type { ContextoPegado } from '@/lib/radaros/pipeline-pegado'
import { formatoMxn, POR_CONFIRMAR, TOPE_CAPITAL_MXN, UNIDAD_PLURAL, veredicto, type PrecioObjetivo } from '@/lib/radaros/pipeline-tabulador'

/**
 * Tarjeta de una cotización en su paso (ORD-POS-149; desde ORD-POS-150 vive en la ficha del producto de /eco/pipeline).
 * Los controles de escritura solo con `editable` (ecoPipelineCanWrite, §4.2) y el servidor repite todo; los números solo
 * con ECO_TABULADOR=true.
 */

export function Objetivo({ o }: { o: PrecioObjetivo | null }) {
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

function Numeros({ t }: { t: Cot }) {
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

export interface ContextoTarjeta {
  editable: boolean
  numeros: boolean
  pistas: Record<string, string>
  fleteCedisRef: number | null
  pegado: ContextoPegado
}

export function TarjetaCotizacion({ t, paso, ctx }: { t: Cot; paso: Columna; ctx: ContextoTarjeta }) {
  const f = t.fila
  const version = versionDeFila(f.VERSION)
  return (
    <li className={`card${t.vencida ? ' card-vencida' : ''}`}>
      <p className="card-title">{t.proveedor ?? t.proveedorId ?? '—'}</p>
      <p className="small"><span className="mono">{t.id}</span> · <span className="mono">{t.estado}</span></p>
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
              pistas={ctx.pistas} fleteCedisRef={ctx.fleteCedisRef} pegado={ctx.pegado} accion={paso === 'porCompletar' ? 'Completar' : 'Recibir'} />
          ) : null}
          <DecidirCotizacion id={t.id} version={version} estado={t.estado} notas={f.NOTAS ?? ''} precio={f.PRECIO_UNIT ?? null}
            moneda={f.MONEDA ?? null} historial={f.PRECIO_HISTORIAL ?? null} />
        </div>
      ) : (f.PRECIO_HISTORIAL ? <p className="small muted">Precios anteriores: {f.PRECIO_HISTORIAL}</p> : null)}
    </li>
  )
}
