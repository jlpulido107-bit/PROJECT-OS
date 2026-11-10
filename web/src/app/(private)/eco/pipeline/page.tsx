import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { Badge, Empty, Section, StateBadge, Stat, Text } from '@/components/ui'
import { ColumnaSoltable, TableroEditable, TarjetaMovible } from '@/components/eco/tablero-escritura'
import { FormularioEco } from '@/components/eco/formularios-pipeline'
import { PegarTablaGemini } from '@/components/eco/pegar-gemini'
import { BandejaGemini } from '@/components/eco/bandeja-gemini'
import { PedirCotizacion } from '@/components/eco/bandeja-cotizaciones'
import { TarjetaCotizacion, type ContextoTarjeta } from '@/components/eco/tarjeta-cotizacion'
import { Veredicto } from '@/components/eco/veredicto'
import { writeAccess } from '@/components/operations/write-access'
import { formatInstant } from '@/lib/dates'
import { privateEco } from '@/lib/page-data'
import {
  ETAPAS, ETIQUETAS_ETAPA, enEtapa, filtrarTarjetas, paraLector, type PipelineVista, type Tarjeta,
} from '@/lib/radaros/pipeline'
import { construirBandeja } from '@/lib/radaros/pipeline-bandeja'
import { ecoBandejaGeminiHabilitada, propuestasBandeja, type BandejaVista } from '@/lib/radaros/pipeline-bandeja-gemini'
import {
  conParams, filtrarPorEtapa, filtrarPorPaso, mejorCotizacion, parseEtapa, parsePaso, PASOS, porProducto, type FiltroEtapa, type PorPaso,
} from '@/lib/radaros/pipeline-compras'
import { etiquetaIdea } from '@/lib/radaros/eco-columnas'
import { ecoPipelineCanWrite } from '@/lib/radaros/pipeline-escritura-config'
import { CANALES, CAMPOS, type EcoCampoOperacion } from '@/lib/radaros/pipeline-escritura-validacion'
import { versionDeFila } from '@/lib/radaros/pipeline-formularios'
import type { ContextoPegado } from '@/lib/radaros/pipeline-pegado'
import type { Bloque, Fila } from '@/lib/radaros/tabla'
import { FiltroAuto } from '@/components/filtro-auto'
import {
  ecoTabuladorHabilitado, ESTADOS_TABULADOR, formatoMxn, pistasCotizacion, POR_CONFIRMAR, precioObjetivo, TOPE_CAPITAL_MXN, UNIDAD_PLURAL,
  type Comparacion, type Componente, type FilaComparada, type PrecioPor, type TabuladorVista,
} from '@/lib/radaros/pipeline-tabulador'

export const metadata: Metadata = { title: 'Compras de ECOMMERCE' }

/**
 * Compras por producto (ORD-POS-150, POS-053; docs/diseno-eco-pipeline.md §17): pipeline y cotizaciones en una vista.
 * Arriba, los 3 pasos de la bandeja (§16) como chips; la lista de productos y, al elegir uno, su ficha con sus
 * cotizaciones por paso y «Comparar» (§14). Solo presentación y navegación: los cálculos, las rutas de escritura y su
 * guard no cambian. Los controles solo los ve ecoPipelineCanWrite(email) (§4.2) y el servidor repite todo.
 */

type Search = {
  producto?: string; proveedor?: string; fproveedor?: string; origen?: string; vencidas?: string; estado?: string; comparar?: string
  paso?: string; etapa?: string; vista?: string; seccion?: string
}

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

const fichaProveedor = (id: string) => `/eco/pipeline?proveedor=${encodeURIComponent(id)}#ficha-proveedor`
const diasTexto = (dias: number | null) => (dias === null ? 'días: —' : `${dias} ${dias === 1 ? 'día' : 'días'}`)
const etapaTexto = (t: Tarjeta) => (t.etapa ? ETIQUETAS_ETAPA[t.etapa] : t.etapaTexto ?? '—')

/* --------------------------------------- Vista tablero --------------------------------------- */

function ContenidoTarjeta({ t, ficha }: { t: Tarjeta; ficha: (id: string) => string }) {
  return (
    <>
      <p className="card-title"><a href={ficha(t.id)}>{t.nombre ?? t.id}</a></p>
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
function TarjetaProducto({ t, editable, ficha }: { t: Tarjeta; editable: boolean; ficha: (id: string) => string }) {
  const version = versionDe(t)
  if (editable && t.etapa && version !== null) {
    return <TarjetaMovible id={t.id} version={version} etapa={t.etapa} nombre={t.nombre ?? t.id}><ContenidoTarjeta t={t} ficha={ficha} /></TarjetaMovible>
  }
  return <li className="card"><ContenidoTarjeta t={t} ficha={ficha} />{editable ? <p className="small muted">Sin VERSION válida: no se mueve desde aquí.</p> : null}</li>
}

function Columna({ e, lista, editable, ficha }: { e: (typeof ETAPAS)[number]; lista: Tarjeta[]; editable: boolean; ficha: (id: string) => string }) {
  return (
    <>
      <h3>{ETIQUETAS_ETAPA[e]} <span className="muted">({lista.length})</span></h3>
      {lista.length ? <ul className="plain stack">{lista.map((t) => <TarjetaProducto key={t.id} t={t} editable={editable} ficha={ficha} />)}</ul> : <p className="small muted">Sin productos.</p>}
    </>
  )
}

/** «Vista tablero» (criterio 2): el tablero por etapas de siempre, con arrastre y «Mover a…» para el escritor. */
function Tablero({ visibles, editable, ficha }: { visibles: Tarjeta[]; editable: boolean; ficha: (id: string) => string }) {
  const fuera = visibles.filter((t) => t.etapa === null)
  return (
    <>
      {editable ? (
        <TableroEditable etiquetas={ETIQUETAS_ETAPA}>
          <div className="board">
            {ETAPAS.map((e) => (
              <ColumnaSoltable key={e} etapa={e} label={ETIQUETAS_ETAPA[e]}>
                <Columna e={e} lista={enEtapa(visibles, e)} editable ficha={ficha} />
              </ColumnaSoltable>
            ))}
          </div>
        </TableroEditable>
      ) : (
        <div className="board">
          {ETAPAS.map((e) => (
            <section key={e} className="board-col" aria-label={ETIQUETAS_ETAPA[e]}>
              <Columna e={e} lista={enEtapa(visibles, e)} editable={false} ficha={ficha} />
            </section>
          ))}
        </div>
      )}
      {fuera.length ? (
        <div className="alert alert-warn" role="alert">
          <p>Productos con <code>ETAPA</code> no reconocida (no se pintan en el tablero):</p>
          <ul className="list">{fuera.map((t) => <li key={t.id}><a href={ficha(t.id)}>{t.id}</a>: <Text value={t.etapaTexto} empty="vacía" /></li>)}</ul>
        </div>
      ) : null}
    </>
  )
}

/* ---------------------------------------- Vista lista ---------------------------------------- */

/** Criterio 2: un renglón por producto con etapa y días, costo máximo, mejor cotización, conteo por paso y alerta. */
function FilaProducto({ t, cmp, grupo, actual, ficha, tabulador }: {
  t: Tarjeta; cmp: Comparacion | null; grupo: PorPaso | undefined; actual: boolean; ficha: (id: string) => string; tabulador: boolean
}) {
  const mejor = mejorCotizacion(cmp)
  const max = cmp?.costoMaximo
  const conteo = PASOS.map(({ paso, titulo }) => `${grupo?.[paso].length ?? 0} ${titulo.toLowerCase()}`).join(' · ')
  return (
    <li className="card compras-fila" aria-current={actual ? 'true' : undefined}>
      <p className="card-title"><a href={ficha(t.id)}>{t.nombre ?? t.id}</a> <span className="small mono">{t.id}</span></p>
      <p className="small">
        {t.etapa ? <Badge tone={t.etapa === 'DESCARTADO' ? 'muted' : 'info'}>{ETIQUETAS_ETAPA[t.etapa]} · {diasTexto(t.dias)}</Badge>
          : <Badge tone="warn" title="ETAPA no reconocida">Etapa: {t.etapaTexto ?? 'vacía'}</Badge>}
        {t.asinValido === false ? <> <Badge tone="warn" title="10 caracteres A-Z y 0-9">ASIN no válido</Badge></> : null}
        {t.alertas.length ? <> <Badge tone="danger" title={t.alertas.map((a) => a.detalle).join(' ')}>Seguimiento vencido ({t.alertas.length})</Badge></> : null}
      </p>
      {tabulador ? (
        <p className="small">
          Costo máximo: {max?.mxn == null
            ? <span title={max?.porConfirmar.join('; ')}>{POR_CONFIRMAR}</span>
            : <span className="mono">{formatoMxn(max.mxn)} MXN</span>}
          {' · '}Mejor: {mejor
            ? <><span className="mono">{formatoMxn(mejor.costo.porSetMxn)} MXN</span> ({mejor.proveedor ?? mejor.proveedorId ?? '—'}) <Veredicto f={mejor} motivo={max?.porConfirmar.join('; ')} /></>
            : <span className="muted">— (ninguna con costo por set)</span>}
        </p>
      ) : null}
      <p className="small muted">{grupo ? conteo : 'Sin cotizaciones en la bandeja.'}</p>
    </li>
  )
}

/* ----------------------------------------- Comparar ----------------------------------------- */

const ETIQUETA_ORIGEN: Record<Componente['origen'], string> = { COTIZACION: 'Cotización', SUPUESTO: 'SUPUESTO', POR_CONFIRMAR: POR_CONFIRMAR }

/** Desglose visible del costo aterrizado (ORD-POS-145): cada componente con su origen; un faltante dice «Por confirmar». */
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

function Capital({ mxn }: { mxn: number | null }) {
  if (mxn === null) return <>{POR_CONFIRMAR}</>
  return <>{formatoMxn(mxn)} {mxn <= TOPE_CAPITAL_MXN ? <Badge tone="ok">Dentro del tope</Badge> : <Badge tone="danger">Excede por {formatoMxn(mxn - TOPE_CAPITAL_MXN)} MXN</Badge>}</>
}

/**
 * «Comparar» de la ficha (criterio 3), solo con ECO_TABULADOR=true: 6 columnas visibles, «Más columnas» con el resto y
 * el desglose de cada fila plegado. Mismas cifras que ORD-POS-145/147: solo cambia cómo se reparten.
 */
function Comparar({ tab, cmp, t }: { tab: TabuladorVista; cmp: Comparacion; t: Tarjeta }) {
  const max = cmp.costoMaximo
  return (
    <section id="comparar" aria-labelledby="comparar-titulo" className="ficha-bloque">
      <h3 id="comparar-titulo">Comparar cotizaciones</h3>
      {tab.migracion && tab.migracion.faltan.length ? (
        <p className="small"><Badge tone="warn">Migración pendiente</Badge> <code>PIPE_COTIZACIONES</code> aún no tiene {tab.migracion.faltan.join(', ')} (la agrega el propietario, docs/diseno-eco-pipeline.md §14.1). Esos componentes quedan «{POR_CONFIRMAR}» o SUPUESTO.</p>
      ) : null}
      {tab.parametros.avisos.map((a) => <p key={a} className="small"><Badge tone="warn">Aviso</Badge> {a}</p>)}
      <details className="plegable">
        <summary>De dónde sale el costo máximo</summary>
        <dl className="meta">
          <Dato label="COSTO_MAX_MXN calculado" value={formatoMxn(max.mxn)} />
          <Dato label="Fecha de sus datos" value={max.fecha} />
          <Dato label="Precio de venta" value={max.precio ? `${formatoMxn(max.precio.mxn)} (${max.precio.fuente})` : POR_CONFIRMAR} />
          <Dato label="Comisión de Amazon" value={formatoMxn(max.comisionMxn)} />
          <Dato label="FBA" value={formatoMxn(max.fbaMxn)} />
          <Dato label="PPC, devoluciones y margen K2" value={`${max.porcentajes.ppc * 100} %, ${max.porcentajes.devoluciones * 100} % y ${max.porcentajes.margenK2 * 100} % del precio`} />
          <Dato label="COSTO_MAX_MXN en la hoja (manual)" value={t.fila.COSTO_MAX_MXN} />
        </dl>
        {max.porConfirmar.length ? <ul className="list">{max.porConfirmar.map((m) => <li key={m}><Badge tone="warn">{POR_CONFIRMAR}</Badge> {m}</li>)}</ul> : null}
      </details>
      {cmp.filas.length ? (
        <>
          <div className="table-wrap">
            <table aria-label="Cotizaciones comparadas">
              <thead>
                <tr>
                  {['Proveedor', 'Estado', 'Costo por set (MXN)', 'Contra el máximo', `Capital del lote (tope ${formatoMxn(TOPE_CAPITAL_MXN)} MXN)`, 'Plazo (días)'].map((h) => <th key={h} scope="col">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {cmp.filas.map((f) => (
                  <tr key={f.id}>
                    <th scope="row"><Text value={f.proveedor ?? f.proveedorId} empty="—" /> <span className="small mono">{f.id}</span></th>
                    <td><Text value={f.estado} empty="—" />{f.estadoValido ? null : <> <Badge tone="warn" title={ESTADOS_TABULADOR.join(', ')}>Estado no válido</Badge></>}</td>
                    <td className="mono">{formatoMxn(f.costo.porSetMxn)}{f.costo.supuestos.length ? <> <Badge tone="warn" title={f.costo.supuestos.join(', ')}>SUPUESTO</Badge></> : null}</td>
                    <td><Veredicto f={f} motivo={[...max.porConfirmar, ...f.costo.porConfirmar].join('; ')} /></td>
                    <td><Capital mxn={f.capitalPrimerLoteMxn} /></td>
                    <td><Text value={f.plazoDias} empty="—" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details className="plegable">
            <summary>Más columnas</summary>
            <div className="table-wrap">
              <table aria-label="Más columnas de las cotizaciones comparadas">
                <thead>
                  <tr>{['Cotización', 'País', 'Incoterm', 'Precio por', 'MOQ', 'Cantidad cotizada', 'Mínimo del proveedor (MXN)', 'Sets que caben en el tope'].map((h) => <th key={h} scope="col">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {cmp.filas.map((f) => (
                    <tr key={f.id}>
                      <th scope="row" className="mono">{f.id}</th>
                      <td><Text value={f.pais} empty="—" /></td>
                      <td><Text value={f.incoterm} empty="—" /></td>
                      <td>{f.costo.unidad ? f.costo.unidad.toLowerCase() : POR_CONFIRMAR}</td>
                      <td>{f.moq === null ? POR_CONFIRMAR : enUnidad(f.moq, f.costo.unidad)}</td>
                      <td>{f.costo.cantidad === null ? POR_CONFIRMAR : enUnidad(f.costo.cantidad, f.costo.unidad)}</td>
                      <td className="mono">{formatoMxn(f.minimoProveedorMxn)}</td>
                      <td>{f.setsEnTope === null ? POR_CONFIRMAR : f.setsEnTope.toLocaleString('es-MX')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <details className="plegable">
            <summary>Desglose por cotización</summary>
            {cmp.filas.map((f) => <Desglose key={f.id} f={f} />)}
          </details>
        </>
      ) : <Empty>Sin cotizaciones para este producto.</Empty>}
    </section>
  )
}

/* ------------------------------------------- Ficha ------------------------------------------- */

/** Criterio 3: costo máximo, mejor cotización, precio objetivo y capital del lote contra el tope. */
function Indicadores({ tab, cmp, mejor }: { tab: TabuladorVista; cmp: Comparacion; mejor: FilaComparada | null }) {
  const max = cmp.costoMaximo
  const fila = mejor ? tab.cotizaciones.find((c) => c.COTIZACION_ID === mejor.id) : undefined
  const o = fila ? precioObjetivo(fila, tab.parametros, max.mxn) : null
  return (
    <div className="kpis" aria-label="Indicadores del producto">
      <Stat label="Costo máximo por set" value={max.mxn === null ? POR_CONFIRMAR : `${formatoMxn(max.mxn)} MXN`}
        hint={max.mxn === null ? max.porConfirmar.join('; ') : `Datos de ${max.fecha}`} />
      <Stat label="Mejor cotización" value={mejor ? `${formatoMxn(mejor.costo.porSetMxn)} MXN` : '—'}
        hint={mejor ? <>{mejor.proveedor ?? mejor.proveedorId ?? mejor.id} · <Veredicto f={mejor} motivo={max.porConfirmar.join('; ')} /></> : 'Ninguna con costo por set'} />
      <Stat label="Precio objetivo" value={o?.valor == null ? POR_CONFIRMAR : `${o.valor.toFixed(2)} ${o.moneda ?? ''}`}
        hint={o === null ? 'Sin mejor cotización' : o.valor === null ? o.motivo : `${o.unidad ? `por ${o.unidad === 'SET' ? 'set' : 'pieza'}` : ''}${o.incoterm ? ` ${o.incoterm}` : ''}${o.supuestos.length ? ' · SUPUESTO' : ''}`} />
      <Stat label={`Capital del lote (tope ${formatoMxn(TOPE_CAPITAL_MXN)} MXN)`}
        value={mejor?.capitalPrimerLoteMxn == null ? POR_CONFIRMAR : `${formatoMxn(mejor.capitalPrimerLoteMxn)} MXN`}
        tone={mejor?.capitalPrimerLoteMxn == null ? undefined : mejor.capitalPrimerLoteMxn <= TOPE_CAPITAL_MXN ? 'ok' : 'danger'}
        hint={mejor?.capitalPrimerLoteMxn == null ? (mejor ? 'Sin CANTIDAD_COTIZADA o sin costo' : 'Sin mejor cotización')
          : mejor.capitalPrimerLoteMxn <= TOPE_CAPITAL_MXN ? 'Dentro del tope' : `Excede por ${formatoMxn(mejor.capitalPrimerLoteMxn - TOPE_CAPITAL_MXN)} MXN`} />
    </div>
  )
}

interface DatosFicha {
  v: PipelineVista
  editable: boolean
  nombres: Map<string, string>
  pistas: Record<string, string>
  fleteCedisRef: number | null
  completas: Map<string, Fila>
  grupos: Map<string, PorPaso>
  tab: TabuladorVista | null
  ctx: ContextoTarjeta
  pedir: Parameters<typeof PedirCotizacion>[0]
  cerrar: string
}

function FichaProducto({ t, cmp, d }: { t: Tarjeta; cmp: Comparacion | null; d: DatosFicha }) {
  const { v, editable } = d
  const f = t.fila
  const cots = v.cotizaciones.estado === 'ok' ? v.cotizaciones.datos.filas.filter((c) => c.PRODUCTO_ID === t.id) : []
  const embs = v.embarques.estado === 'ok' ? v.embarques.datos.filas.filter((e) => e.PRODUCTO_ID === t.id) : []
  const historial = v.historial.estado === 'ok' ? v.historial.datos.filas.filter((h) => h.REGISTRO_ID === t.id) : []
  const k = v.parametros.etiquetasK
  const grupo = d.grupos.get(t.id)
  const enBandeja = new Set(PASOS.flatMap(({ paso }) => grupo?.[paso].map((c) => c.id) ?? []))
  const fuera = cots.filter((c) => c.COTIZACION_ID && !enBandeja.has(c.COTIZACION_ID))
  return (
    <section className="section ficha" id="ficha-producto" aria-labelledby="ficha-producto-titulo">
      <div className="section-head">
        <h2 id="ficha-producto-titulo">Ficha de producto · {t.nombre ?? t.id}</h2>
        <a href={d.cerrar} className="small">Cerrar ficha</a>
      </div>
      <p className="small">
        <span className="mono">{t.id}</span> · {etapaTexto(t)} · {diasTexto(t.dias)} en la etapa · Elegido:{' '}
        {t.proveedorElegido ? <a href={fichaProveedor(t.proveedorElegido.id)}>{t.proveedorElegido.nombre ?? t.proveedorElegido.id}</a> : '—'}
      </p>
      {d.tab && cmp ? (
        <EstadoPipe bloque={d.tab.bloque}>{() => <Indicadores tab={d.tab as TabuladorVista} cmp={cmp} mejor={mejorCotizacion(cmp)} />}</EstadoPipe>
      ) : (
        <p className="small muted">Tabulador apagado (<code>ECO_TABULADOR</code>): sin costo máximo, mejor cotización, precio objetivo, capital ni «Comparar». Lo enciende el propietario.</p>
      )}

      <h3>Cotizaciones de este producto</h3>
      <EstadoPipe bloque={v.cotizaciones}>
        {() => (
          <div className="pasos">
            {PASOS.map(({ paso, titulo, vacio }) => (
              <section key={paso} className="board-col" aria-label={`${titulo} de ${t.id}`}>
                <h4>{titulo} <span className="muted">({grupo?.[paso].length ?? 0})</span></h4>
                {grupo?.[paso].length
                  ? <ul className="plain stack">{grupo[paso].map((c) => <TarjetaCotizacion key={c.id} t={c} paso={paso} ctx={d.ctx} />)}</ul>
                  : <p className="small muted">{vacio}</p>}
              </section>
            ))}
          </div>
        )}
      </EstadoPipe>
      {fuera.length ? (
        <p className="small muted">Fuera de la bandeja: {fuera.map((c) => `${c.COTIZACION_ID} (${c.ESTADO ?? 'sin estado'})`).join(', ')}.</p>
      ) : null}
      {editable ? (
        t.etapa === 'DESCARTADO'
          ? <p className="small muted">Producto descartado: no se piden cotizaciones.</p>
          : (
            <details className="plegable" id="pedir-producto">
              <summary>Pedir a otro proveedor</summary>
              <PedirCotizacion {...d.pedir} productoId={t.id} />
            </details>
          )
      ) : null}

      {d.tab && cmp ? <EstadoPipe bloque={d.tab.bloque}>{() => <Comparar tab={d.tab as TabuladorVista} cmp={cmp} t={t} />}</EstadoPipe> : null}

      {editable ? (
        <details className="plegable">
          <summary>Editar cotizaciones (todos los campos)</summary>
          {cots.map((c) => c.COTIZACION_ID ? <Editar key={c.COTIZACION_ID} titulo={`Editar cotización ${c.COTIZACION_ID}`} ruta="cotizaciones" id={c.COTIZACION_ID} op="eco.cotizacion.editar" fila={d.completas.get(c.COTIZACION_ID) ?? c} /> : null)}
          <FormularioEco titulo="Nueva cotización" url="/api/eco/pipeline/cotizaciones" campos={CAMPOS['eco.cotizacion.crear']} iniciales={{ PRODUCTO_ID: t.id }} pistas={d.pistas} entregaCedis={{ fleteCedisRef: d.fleteCedisRef }} />
        </details>
      ) : null}

      <details className="plegable">
        <summary>Identidad y Keepa</summary>
        <dl className="meta meta-wide">
          <Dato label="PRODUCTO_ID" value={t.id} /><Dato label="Nombre" value={t.nombre} />
          <div><dt>ASIN</dt><dd><Text value={t.asin} empty="—" />{t.asinValido === false ? <> <Badge tone="warn">ASIN no válido</Badge></> : null}</dd></div>
          <Dato label="Idea" value={f.IDEA_ID ? etiquetaIdea(f.IDEA_ID, d.nombres.get(f.IDEA_ID)) : null} /><Dato label="Origen" value={f.ORIGEN} /><Dato label="Referencia de origen" value={f.ORIGEN_REF} />
          <div><dt>Etapa</dt><dd>{t.etapa ? ETIQUETAS_ETAPA[t.etapa] : <Text value={t.etapaTexto} empty="—" />}</dd></div>
          <Dato label="En la etapa desde" value={f.ETAPA_DESDE} />
          {f.MOTIVO_DESCARTE ? <Dato label="Motivo de descarte" value={f.MOTIVO_DESCARTE} /> : null}
        </dl>
        {f.IDEA_ID ? <p className="small"><a href="/eco#ranking">Datos vivos de la idea en el ranking de /eco</a></p> : null}
        {editable ? <Editar titulo="Editar producto" ruta="productos" id={t.id} op="eco.producto.editar" fila={f} /> : null}
        <h4>Keepa (foto)</h4>
        <dl className="meta">
          <Dato label="Fecha" value={f.KEEPA_FECHA} /><Dato label="Precio MXN prom. 90 d" value={f.KEEPA_PRECIO_MXN_AVG90} />
          <Dato label="BSR prom. 90 d" value={f.KEEPA_BSR_AVG90} /><Dato label="Ventas al mes" value={f.KEEPA_VENTAS_MES} />
          <Dato label="Ofertas" value={f.KEEPA_OFERTAS} />
        </dl>
        <h4>Costo máximo y criterios (hoja)</h4>
        <dl className="meta">
          <Dato label="COSTO_MAX_MXN" value={f.COSTO_MAX_MXN} />
          {(['K1', 'K2', 'K3', 'K4', 'K5', 'K6'] as const).map((c) => <Dato key={c} label={k[c]} value={f[c]} />)}
        </dl>
      </details>

      <details className="plegable">
        <summary>Seguimiento y embarques{t.alertas.length ? ` (${t.alertas.length} vencido${t.alertas.length === 1 ? '' : 's'})` : ''}</summary>
        {t.alertas.length ? (
          <ul className="list" aria-label="Seguimiento vencido">{t.alertas.map((a, i) => <li key={i}><Badge tone="danger">Vencida</Badge> {a.detalle}</li>)}</ul>
        ) : <p className="small muted">Sin fechas vencidas al {v.hoy}.</p>}
        {t.avisos.length ? <ul className="list" aria-label="Avisos de datos">{t.avisos.map((a) => <li key={a}><Badge tone="warn">Aviso</Badge> {a}</li>)}</ul> : null}
        {cots.length ? (
          <Tabla filas={cots} label="Fechas de cotizaciones y muestras" clave="COTIZACION_ID"
            columnas={['COTIZACION_ID', 'ESTADO', 'FECHA_SOLICITUD', 'FECHA_RESPUESTA_ESPERADA', 'FECHA_RECIBIDA', 'MUESTRA_ESTADO', 'MUESTRA_FECHA_PEDIDO', 'MUESTRA_FECHA_ESPERADA', 'MUESTRA_FECHA_RECIBIDA']} />
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
      </details>

      <details className="plegable">
        <summary>Notas e historial</summary>
        <p><Text value={f.NOTAS ?? null} empty="Sin notas." /></p>
        <EstadoPipe bloque={v.historial}>
          {() => historial.length ? (
            <Tabla filas={historial} label="Historial de etapas" clave="FECHA_HORA" columnas={['FECHA_HORA', 'VALOR_ANTES', 'VALOR_DESPUES']} />
          ) : <Empty>Sin cambios de etapa registrados.</Empty>}
        </EstadoPipe>
      </details>
    </section>
  )
}

/* ---------------------------------------- Proveedores ---------------------------------------- */

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
              <input type="hidden" name="seccion" value="proveedores" />
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

function FichaProveedor({ v, p, tarjetas, verContacto, editable, ficha }: { v: PipelineVista; p: Fila; tarjetas: Tarjeta[]; verContacto: boolean; editable: boolean; ficha: (id: string) => string }) {
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
          <Tabla filas={cots} label="Cotizaciones del proveedor" clave="PRODUCTO_ID" enlace={(c) => (c.PRODUCTO_ID ? ficha(c.PRODUCTO_ID) : null)}
            columnas={['PRODUCTO_ID', 'COTIZACION_ID', 'PRECIO_UNIT', 'MONEDA', 'MOQ', 'PLAZO_PRODUCCION_DIAS', 'ESTADO', 'MUESTRA_ESTADO']} />
        ) : <Empty>Sin cotizaciones.</Empty>}
      </EstadoPipe>
      <h3>Productos en los que es el elegido</h3>
      {elegidos.length ? <ul className="list">{elegidos.map((t) => <li key={t.id}><a href={ficha(t.id)}>{t.nombre ?? t.id}</a> ({t.etapa ? ETIQUETAS_ETAPA[t.etapa] : t.etapaTexto ?? '—'})</li>)}</ul> : <Empty>Ninguno.</Empty>}
    </Section>
  )
}

/* ------------------------------------------ Página ------------------------------------------ */

/**
 * Compras > Bandeja (ORD-POS-155, §18): solo con ECO_BANDEJA_GEMINI=true y para el escritor del pipeline. Las filas
 * PENDIENTE con los chequeos de «Recibir varias»; las columnas que faltan se nombran.
 */
function SeccionBandeja({ b, contexto, pistas }: { b: BandejaVista; contexto: ContextoPegado; pistas: Record<string, string> }) {
  let contenido: ReactNode
  if (b.estado === 'apagada') contenido = null
  else if (b.estado === 'ausente') contenido = <Empty>{b.mensaje}</Empty>
  else if (b.estado === 'error') contenido = <div className="alert alert-danger" role="alert"><p>No se pudo leer la bandeja: {b.mensaje}</p></div>
  else if (b.estado === 'columnas-faltantes') {
    contenido = (
      <div className="alert alert-warn" role="alert">
        <p>
          <code>PIPE_BANDEJA_GEMINI</code>:{b.faltan.length ? <> falta la columna {b.faltan.join(', ')}.</> : null}
          {b.repetidas.length ? <> Encabezado repetido: {b.repetidas.join(', ')}.</> : null} La corrige el propietario (diseño /eco pipeline §18.1); no se muestran sus filas.
        </p>
      </div>
    )
  } else {
    const r = propuestasBandeja(b, { ...contexto, campos: CAMPOS['eco.bandeja.cotizacion'] })
    contenido = (
      <>
        <p className="small muted">
          Propuestas de Gemini en <code>PIPE_BANDEJA_GEMINI</code>: {r.pendientes.length} pendientes · {r.confirmadas} confirmadas · {r.rechazadas} rechazadas
          {r.otras ? ` · ${r.otras} con ESTADO_BANDEJA vacío o no válido (no se muestran)` : ''}. Confirmar escribe con el servicio del pipeline;
          en la bandeja solo se escriben ESTADO_BANDEJA, RESULTADO_ID y NOTAS, y nunca se borra una fila.
        </p>
        {b.truncado ? <div className="alert alert-warn" role="alert"><p><code>PIPE_BANDEJA_GEMINI</code>: truncado; faltan filas.</p></div> : null}
        <BandejaGemini propuestas={r.pendientes} contexto={{ ...contexto, campos: CAMPOS['eco.bandeja.cotizacion'] }} camposProveedor={CAMPOS['eco.bandeja.proveedor']} pistas={pistas} />
      </>
    )
  }
  return <Section title="Bandeja de Gemini" id="bandeja">{contenido}</Section>
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

const OPCIONES_ETAPA: ReadonlyArray<[FiltroEtapa, string]> = [['ACTIVAS', 'Activas'], ['TODAS', 'Todas'], ...ETAPAS.map((e) => [e, ETIQUETAS_ETAPA[e]] as [FiltroEtapa, string])]

export default async function EcoPipelinePage({ searchParams }: { searchParams: Promise<Search> }) {
  const { user, result } = await privateEco('/eco/pipeline')
  const params = await searchParams

  if (result.estado === 'no-configurado') {
    return (
      <>
        <h1>Compras por producto</h1>
        <div className="alert alert-warn" role="status">
          <p>RADAROS no está configurado en este despliegue{result.motivo === 'no-valido' ? ' (valor no válido)' : ''}.</p>
          <p className="small">Compras lee la hoja de RADAROS: requiere <code>RADAROS_SHEET_ID</code> (docs/diseno-eco-radaros.md §6).</p>
        </div>
      </>
    )
  }
  if (result.estado === 'error') {
    return (
      <>
        <h1>Compras por producto</h1>
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
  // ORD-POS-145: números y «Comparar» solo con ECO_TABULADOR=true (la pone el propietario con deploy.sh).
  const tabulador = ecoTabuladorHabilitado() ? result.vista.tabulador : null
  const tarjetas = v.productos.estado === 'ok' ? v.productos.datos.tarjetas : []
  // ORD-POS-146 (criterio 2): las pistas leen PIPE_PARAMETROS aunque ECO_TABULADOR esté apagada (solo texto, sin cálculo).
  const pistas = editable ? pistasCotizacion(result.vista.tabulador.parametros) : {}
  // ORD-POS-147 (criterio 2): sin la casilla de DDP y sin este parámetro, el alta pide el flete al CEDIS.
  const fleteCedisRef = editable ? result.vista.tabulador.parametros.numero('FLETE_CEDIS_REF') : null
  // ORD-POS-149: la bandeja en 3 pasos (los mismos conteos y el mismo reparto que /eco/cotizaciones).
  const bandeja = construirBandeja(v, result.vista.tabulador)
  const grupos = porProducto(bandeja)

  // Criterio 5: ?comparar= abre la ficha de ese producto con «Comparar»; ?proveedor= y ?estado= abren Proveedores.
  const productoId = params.producto ?? params.comparar
  const producto = productoId ? tarjetas.find((t) => t.id === productoId) : undefined
  const proveedor = params.proveedor && v.proveedores.estado === 'ok' ? v.proveedores.datos.filas.find((p) => p.PROVEEDOR_ID === params.proveedor) : undefined
  const enProveedores = params.seccion === 'proveedores' || params.proveedor !== undefined || params.estado !== undefined
  // ORD-POS-155: sin ECO_BANDEJA_GEMINI=true (o sin ser el escritor) no hay enlace, ni sección, ni lectura de la pestaña.
  const conBandeja = editable && ecoBandejaGeminiHabilitada() && result.vista.bandejaGemini.estado !== 'apagada'
  const enBandeja = conBandeja && params.seccion === 'bandeja' && !enProveedores
  const pendientesBandeja = result.vista.bandejaGemini.estado === 'ok' ? result.vista.bandejaGemini.filas.filter((f) => f.estado === 'PENDIENTE').length : null

  const paso = parsePaso(params.paso)
  const etapa = parseEtapa(params.etapa)
  const tablero = params.vista === 'tablero'
  const proveedoresElegidos = [...new Map(tarjetas.flatMap((t) => (t.proveedorElegido ? [[t.proveedorElegido.id, t.proveedorElegido]] as const : []))).values()]
  const origenes = [...new Set(tarjetas.map((t) => t.origen).filter((o): o is string => o !== null))].sort()
  const fproveedor = proveedoresElegidos.some((p) => p.id === params.fproveedor) ? params.fproveedor : undefined
  const origen = params.origen && origenes.includes(params.origen) ? params.origen : undefined
  const vencidas = params.vencidas === '1'
  // Lo que conservan los enlaces de la vista de productos (filtros, paso, vista y ficha abierta).
  const actual: Record<string, string | undefined> = {
    paso: paso ?? undefined, etapa: etapa === 'ACTIVAS' ? undefined : etapa, vista: tablero ? 'tablero' : undefined,
    fproveedor, origen, vencidas: vencidas ? '1' : undefined, producto: producto?.id,
  }
  const ficha = (id: string) => conParams(actual, { producto: id }, '#ficha-producto')
  const filtradas = filtrarPorPaso(filtrarTarjetas(tarjetas, { proveedor: fproveedor, origen, vencidas }), paso, grupos)
  const visibles = tablero ? filtradas : filtrarPorEtapa(filtradas, etapa)
  // Una comparación por producto mostrado (la misma de «Comparar»); sin ECO_TABULADOR no se calcula nada.
  const comparaciones = new Map<string, Comparacion>(tabulador
    ? [...new Set([...visibles, ...(producto ? [producto] : [])])].map((t) => [t.id, tabulador.comparar(t.id, t.fila.IDEA_ID ?? null)] as const)
    : [])
  const comparar = (t: Tarjeta) => comparaciones.get(t.id) ?? null
  const vencidasEsperando = bandeja.esperando.filter((c) => c.vencida).length
  const sinId = v.productos.estado === 'ok' ? v.productos.datos.sinId : 0

  const pegado = contextoPegado(v, tarjetas, fleteCedisRef)
  const pedir = {
    productos: tarjetas.filter((t) => t.etapa !== 'DESCARTADO').map((t) => ({ id: t.id, nombre: t.nombre })),
    proveedores: v.proveedores.estado === 'ok'
      ? v.proveedores.datos.filas.flatMap((p) => (p.PROVEEDOR_ID && p.NOMBRE && p.ESTADO === 'ACTIVO' ? [{ id: p.PROVEEDOR_ID, nombre: p.NOMBRE, canal: p.CANAL ?? null, pais: p.PAIS ?? null }] : []))
      : [],
    canales: CANALES,
  }
  // «Recibir» rellena una fila que ya existe: el pegado no la compara contra las demás (como en ORD-POS-149).
  const ctx: ContextoTarjeta = { editable, numeros: tabulador !== null, pistas, fleteCedisRef, pegado: { ...pegado, cotizaciones: [] } }
  const datosFicha: DatosFicha = {
    v, editable, nombres: result.vista.nombres, pistas, fleteCedisRef, grupos, tab: tabulador, ctx, pedir,
    completas: new Map(result.vista.tabulador.cotizaciones.flatMap((c) => (c.COTIZACION_ID ? [[c.COTIZACION_ID, c] as const] : []))),
    cerrar: conParams(actual, { producto: undefined }, '#productos'),
  }

  const fichaProducto = producto ? <FichaProducto t={producto} cmp={comparar(producto)} d={datosFicha} /> : null
  const noHayProducto = productoId && !producto ? <div className="alert alert-warn" role="status"><p>No hay un producto con ese ID.</p></div> : null

  return (
    <>
      <h1>Compras por producto</h1>
      <p className="muted small">
        Pipeline y cotizaciones de las pestañas <code>PIPE_*</code> de RADAROS, leídas {formatInstant(result.fetchedAt)} (hora Mérida).{' '}
        {editable
          ? 'Solo tu sesión ve los botones; el servidor lo repite. Nada cambia en pantalla hasta que la hoja lo confirma.'
          : 'Solo lectura: esta vista no cambia nada.'}{' '}
        {tabulador
          ? 'Los costos salen del tabulador (DEC-ECO-008); el resto muestra lo que hay en la hoja.'
          : 'Tabulador apagado (ECO_TABULADOR): no calcula costos ni muestra «Comparar»; solo lo que hay en la hoja.'} Vencido = fecha esperada anterior a hoy ({v.hoy}).
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
      {result.vista.tabulador.migracion && result.vista.tabulador.migracion.faltan.length && !tabulador ? (
        <p className="small"><Badge tone="warn">Migración pendiente</Badge> <code>PIPE_COTIZACIONES</code> aún no tiene {result.vista.tabulador.migracion.faltan.join(', ')} (la agrega el propietario, docs/diseno-eco-pipeline.md §14.1 y §16.1).</p>
      ) : null}

      <nav className="subnav" aria-label="Secciones de compras">
        <a href="/eco/pipeline#productos" aria-current={enProveedores || enBandeja ? undefined : 'page'}>Productos</a>
        <a href="/eco/pipeline?seccion=proveedores#proveedores" aria-current={enProveedores ? 'page' : undefined}>Proveedores</a>
        {conBandeja ? (
          <a href="/eco/pipeline?seccion=bandeja#bandeja" aria-current={enBandeja ? 'page' : undefined}>
            Bandeja{pendientesBandeja ? <> <Badge tone="warn">{pendientesBandeja}</Badge></> : null}
          </a>
        ) : null}
      </nav>

      {enBandeja ? (
        <SeccionBandeja b={result.vista.bandejaGemini} contexto={pegado} pistas={pistas} />
      ) : enProveedores ? (
        <>
          <Section title="Proveedores" id="proveedores">
            {editable ? <p className="small"><a href="/eco/pipeline#pedir">Proveedor nuevo: en «Pedir cotización»</a></p> : null}
            <Proveedores v={v} filtro={params} verContacto={verContacto} />
          </Section>
          {params.proveedor && !proveedor ? <div className="alert alert-warn" role="status"><p>No hay un proveedor con ese ID.</p></div> : null}
          {proveedor ? <FichaProveedor v={v} p={proveedor} tarjetas={tarjetas} verContacto={verContacto} editable={editable} ficha={(id) => conParams({}, { producto: id }, '#ficha-producto')} /> : null}
        </>
      ) : (
        <>
          <div className="bandeja-chips" role="group" aria-label="Bandeja de cotizaciones">
            {PASOS.map(({ paso: p, titulo }) => (
              <a key={p} className="chip" href={conParams(actual, { paso: paso === p ? undefined : p }, '#productos')} aria-current={paso === p ? 'true' : undefined}>
                {titulo} <strong>{bandeja[p].length}</strong>
                {p === 'esperando' && vencidasEsperando ? <Badge tone="danger">{vencidasEsperando} {vencidasEsperando === 1 ? 'vencida' : 'vencidas'}</Badge> : null}
              </a>
            ))}
            {paso ? <a className="small" href={conParams(actual, { paso: undefined }, '#productos')}>Quitar filtro</a> : null}
          </div>
          {bandeja.fuera ? <p className="small muted">{bandeja.fuera} {bandeja.fuera === 1 ? 'cotización RECHAZADA o con otro estado no entra' : 'cotizaciones RECHAZADAS o con otro estado no entran'} en los pasos; se ven en la ficha de su producto.</p> : null}

          <form method="get" action="/eco/pipeline#productos" className="filters" aria-label="Filtrar productos">
            <FiltroAuto />
            {paso ? <input type="hidden" name="paso" value={paso} /> : null}
            {tablero ? <input type="hidden" name="vista" value="tablero" /> : null}
            {producto ? <input type="hidden" name="producto" value={producto.id} /> : null}
            {tablero ? null : (
              <label>Etapa{' '}
                <select name="etapa" defaultValue={etapa}>
                  {OPCIONES_ETAPA.map(([valor, etiqueta]) => <option key={valor} value={valor}>{etiqueta}</option>)}
                </select>
              </label>
            )}{' '}
            <label>Proveedor elegido{' '}
              <select name="fproveedor" defaultValue={fproveedor ?? ''}>
                <option value="">Todos</option>
                {proveedoresElegidos.map((p) => <option key={p.id} value={p.id}>{p.nombre ?? p.id}</option>)}
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

          <p className="actions-row">
            <a className="button" href={conParams(actual, { vista: tablero ? undefined : 'tablero' }, tablero ? '#productos' : '#tablero')}>{tablero ? 'Vista lista' : 'Vista tablero'}</a>
          </p>

          {editable ? (
            <div className="stack compras-acciones">
              <details className="plegable" id="pedir">
                <summary>Pedir cotización</summary>
                <PedirCotizacion {...pedir} />
                <details className="plegable">
                  <summary>Proveedor nuevo con todos sus datos</summary>
                  <p className="small muted">Sin correos ni teléfonos de personas. Para pedir basta con nombre, país y canal (arriba).</p>
                  <FormularioEco titulo="Nuevo proveedor" url="/api/eco/pipeline/proveedores" campos={CAMPOS['eco.proveedor.crear']}
                    duplicados={{ clave: 'nombre', existentes: proveedoresExistentes(v) }} />
                </details>
              </details>
              <details className="plegable" id="recibir">
                <summary>Recibir varias: pegar tabla de Gemini</summary>
                <p className="small muted">Los campos vacíos de la cotización toman el valor de <code>PIPE_PARAMETROS</code> que indica cada uno. Una sola respuesta se recibe en su tarjeta, en la ficha del producto.</p>
                <PegarTablaGemini contexto={pegado} pistas={pistas} />
                <details className="plegable">
                  <summary>Cotización ya recibida, a mano</summary>
                  <FormularioEco titulo="Nueva cotización" url="/api/eco/pipeline/cotizaciones" campos={CAMPOS['eco.cotizacion.crear']} pistas={pistas} entregaCedis={{ fleteCedisRef }} />
                </details>
              </details>
              <details className="plegable">
                <summary>Nuevo producto</summary>
                <FormularioEco titulo="Nuevo producto" url="/api/eco/pipeline/productos" campos={CAMPOS['eco.producto.crear']} />
              </details>
            </div>
          ) : null}

          {noHayProducto}
          {tablero ? (
            <>
              <Section title="Tablero" id="tablero">
                <EstadoPipe bloque={v.productos}>
                  {() => (
                    <>
                      {sinId ? <p className="small muted">{sinId} {sinId === 1 ? 'fila' : 'filas'} de PIPE_PRODUCTOS sin PRODUCTO_ID: no se muestran.</p> : null}
                      <Tablero visibles={visibles} editable={editable} ficha={ficha} />
                    </>
                  )}
                </EstadoPipe>
              </Section>
              {fichaProducto}
            </>
          ) : (
            <div className="compras-layout">
              <section className="section" id="productos" aria-labelledby="productos-titulo">
                <div className="section-head"><h2 id="productos-titulo">Productos <span className="muted">({visibles.length})</span></h2></div>
                <EstadoPipe bloque={v.productos}>
                  {() => (
                    <>
                      {sinId ? <p className="small muted">{sinId} {sinId === 1 ? 'fila' : 'filas'} de PIPE_PRODUCTOS sin PRODUCTO_ID: no se muestran.</p> : null}
                      {visibles.length ? (
                        <ul className="plain stack" aria-label="Lista de productos">
                          {visibles.map((t) => <FilaProducto key={t.id} t={t} cmp={comparar(t)} grupo={grupos.get(t.id)} actual={t.id === producto?.id} ficha={ficha} tabulador={tabulador !== null} />)}
                        </ul>
                      ) : <Empty>Ningún producto con estos filtros.</Empty>}
                    </>
                  )}
                </EstadoPipe>
              </section>
              {fichaProducto ?? <p className="small muted compras-sin-ficha">Elige un producto de la lista para ver su ficha, sus cotizaciones y «Comparar».</p>}
            </div>
          )}
        </>
      )}
    </>
  )
}

