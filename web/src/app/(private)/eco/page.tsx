import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { Badge, Empty, Section, StateBadge, Text } from '@/components/ui'
import { formatInstant } from '@/lib/dates'
import { privateEco } from '@/lib/page-data'
import {
  COLUMNA_ID_IDEA, COLUMNAS_PUNTUACION, COLUMNAS_UNIT, filtrarTendencias, GRUPO_MACRO_TRENDS, GRUPOS_SCORING, type Bloque, type Corridas,
  type Fila, type IdeaRanking, type Ranking, type Tendencias, type UnitEconomics,
} from '@/lib/radaros/eco'
import {
  anclaIdea, enlaceFichaCompras, etapaDeProducto, filtrarIdeas, FILTROS_K4, hrefFiltros, parseFiltroK4, productosPorIdea, SIN_PRODUCTO,
  type FiltroK4,
} from '@/lib/radaros/eco-ideas'
import { paraLector, type Tarjeta } from '@/lib/radaros/pipeline'
import { mejorCotizacion } from '@/lib/radaros/pipeline-compras'
import { ecoPipelineCanWrite } from '@/lib/radaros/pipeline-escritura-config'
import { ecoTabuladorHabilitado, formatoMxn, POR_CONFIRMAR, type TabuladorVista } from '@/lib/radaros/pipeline-tabulador'
import { AbrirIdeaPorHash } from '@/components/eco/abrir-idea'
import { PestanasIdea, type Pestana } from '@/components/eco/pestanas-idea'
import { Veredicto } from '@/components/eco/veredicto'
import { writeAccess } from '@/components/operations/write-access'
import {
  ayudaColumna, COLUMNAS_CORRIDAS_ECO, CORRIDAS_EXTRAS, CORRIDAS_VISIBLES, estadoCorrida, etiquetaIdea, formatearInstante, formatearValor, K4_VIGENCIA_DIAS, SIN_DATO,
  TENDENCIAS_EXTRAS, TENDENCIAS_VISIBLES, tituloColumna, UNIT_EXTRAS, UNIT_VISIBLES, type Columna, type EtiquetaK4,
} from '@/lib/radaros/eco-columnas'
import { FiltroAuto } from '@/components/filtro-auto'
import { COL_EXTRA, MasColumnas } from '@/components/mas-columnas'

export const metadata: Metadata = { title: 'RADAROS (solo lectura)' }

type Search = { estado?: string; etiqueta?: string; k4?: string; compras?: string }

const TENDENCIAS_MAX = 200

/** Estado de un bloque que no está `ok` (diseño §4); los demás bloques se pintan igual. */
function EstadoBloque<T>({ bloque, children }: { bloque: Bloque<T>; children: (datos: T) => ReactNode }) {
  if (bloque.estado === 'ausente' || bloque.estado === 'sin-filas') return <Empty>{bloque.mensaje}</Empty>
  if (bloque.estado === 'columnas-faltantes') {
    return (
      <div className="alert alert-warn" role="alert">
        <p><code>{bloque.tab}</code>: faltan columnas ({bloque.faltan.join(', ')}). No se muestran sus datos.</p>
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

/** «—» con su leyenda: vacío, columna sin leer (más allá de Z) o no numérico en una columna numérica. */
function SinDato() {
  return <span className="muted" title={SIN_DATO}><span aria-hidden="true">—</span><span className="visually-hidden">{SIN_DATO}</span></span>
}

/** Clase de una columna que se oculta hasta pedir «Más columnas» (ORD-POS-152). */
function claseExtra(col: string, extras?: readonly string[]): string | undefined {
  return extras?.includes(col) ? COL_EXTRA : undefined
}

function Celda({ fila, col, className }: { fila: Fila; col: string; className?: string }) {
  const valor = formatearValor(col, fila[col] ?? null)
  return <td className={className}>{valor === null ? <SinDato /> : valor}</td>
}

function Ayuda({ texto }: { texto: string }) {
  return <span title={texto} role="img" aria-label={`Ayuda: ${texto}`}>ⓘ</span>
}

/** Título en español con ayuda (ⓘ) de una línea; sin traducción, el encabezado tal cual. */
function Encabezado({ col, mapa, className }: { col: string; mapa?: Readonly<Record<string, Columna>>; className?: string }) {
  const titulo = tituloColumna(col, mapa)
  const ayuda = ayudaColumna(col, mapa)
  return (
    <th scope="col" className={className}>
      {titulo === col ? <code>{col}</code> : titulo}
      {ayuda ? <>{' '}<Ayuda texto={ayuda} /></> : null}
    </th>
  )
}

/** Estado de una corrida en palabras, con su color y su explicación en la ayuda (ORD-POS-135). */
function EstadoDeCorrida({ raw }: { raw: string | null }) {
  const e = estadoCorrida(raw)
  if (!e) return <SinDato />
  return <Badge tone={e.tono} title={e.ayuda}>{e.texto}</Badge>
}

/** Columnas de «Últimas corridas»; `CORRIDA_ID` va en la ayuda de la fila, no como columna. */
const COLUMNAS_TABLA_CORRIDAS = [...CORRIDAS_VISIBLES, ...CORRIDAS_EXTRAS]

function CeldaCorrida({ fila, col }: { fila: Fila; col: (typeof COLUMNAS_TABLA_CORRIDAS)[number] }) {
  const raw = fila[col] ?? null
  if (col === 'SEMANA') {
    const id = fila.CORRIDA_ID
    return <th scope="row">{raw ?? <SinDato />}{id ? <>{' '}<Ayuda texto={`Corrida ${id}`} /></> : null}</th>
  }
  if (col === 'ESTADO') return <td><EstadoDeCorrida raw={raw} /></td>
  // Un mensaje vacío es normal (corrida sin notas): «—» sin la leyenda «sin dato».
  if (col === 'MENSAJE') return <td>{raw ?? <span className="muted">—</span>}</td>
  const valor = col === 'INICIO' || col === 'FIN' ? formatearInstante(raw) : formatearValor(col, raw)
  return <td className={claseExtra(col, CORRIDAS_EXTRAS)}>{valor === null ? <SinDato /> : valor}</td>
}

function TablaCorridas({ filas }: { filas: Fila[] }) {
  return (
    <MasColumnas clave="eco-corridas" extras={CORRIDAS_EXTRAS.length}>
      <div className="table-wrap">
        <table aria-label="Últimas corridas">
          <thead><tr>{COLUMNAS_TABLA_CORRIDAS.map((c) => <Encabezado key={c} col={c} mapa={COLUMNAS_CORRIDAS_ECO} className={claseExtra(c, CORRIDAS_EXTRAS)} />)}</tr></thead>
          <tbody>
            {filas.map((f, i) => (
              <tr key={`${f.CORRIDA_ID ?? ''}-${i}`}>
                {COLUMNAS_TABLA_CORRIDAS.map((c) => <CeldaCorrida key={c} fila={f} col={c} />)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </MasColumnas>
  )
}

const LEYENDA_SIN_DATO = <p className="small muted">«—» = {SIN_DATO}.</p>

/** Tabla con `visibles` siempre a la vista y `extras` tras «Más columnas» (ORD-POS-152); sin JavaScript, todas. */
function TablaColumnas({ filas, visibles, extras, label, clave, memoria, nombres }: {
  filas: Fila[]; visibles: readonly string[]; extras: readonly string[]; label: string; clave: string; memoria: string; nombres?: Map<string, string>
}) {
  const columnas = [...visibles, ...extras]
  return (
    <MasColumnas clave={memoria} extras={extras.length}>
      <div className="table-wrap">
        <table aria-label={label}>
          <thead><tr>{columnas.map((c) => (nombres && c === COLUMNA_ID_IDEA ? <th key={c} scope="col">Idea</th> : <Encabezado key={c} col={c} className={claseExtra(c, extras)} />))}</tr></thead>
          <tbody>
            {filas.map((f, i) => (
              <tr key={`${f[clave] ?? ''}-${i}`}>
                {columnas.map((c) => (nombres && c === COLUMNA_ID_IDEA
                  ? <th key={c} scope="row">{etiquetaIdea(f[c] ?? '', nombres.get(f[c] ?? ''))}</th>
                  : <Celda key={c} fila={f} col={c} className={claseExtra(c, extras)} />))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </MasColumnas>
  )
}

/** Criterio 1: el estado del motor en una línea (última corrida, semana, inicio, tokens de Keepa restantes y avisos). */
function LineaMotor({ datos }: { datos: Corridas }) {
  const u = datos.ultima
  return (
    <div className="motor-linea" aria-label="Última corrida del motor">
      {u ? (
        <>
          <span>Última corrida <EstadoDeCorrida raw={u.ESTADO ?? null} />{u.CORRIDA_ID ? <>{' '}<Ayuda texto={`Corrida ${u.CORRIDA_ID}`} /></> : null}</span>
          <span>Semana <Text value={u.SEMANA ?? null} empty="—" /></span>
          <span>Inicio <Text value={formatearInstante(u.INICIO ?? null)} empty="—" /> <span className="small muted">(hora Mérida)</span></span>
          <span>Keepa: <Text value={u.KEEPA_TOKENS_RESTANTES ?? null} empty="—" /> tokens restantes</span>
        </>
      ) : <span className="muted">Sin corridas en AMZ_CORRIDAS.</span>}
      {datos.avisos.length ? (
        <ul className="motor-avisos" aria-label="Avisos del motor">
          {datos.avisos.map((a) => <li key={a}><Badge tone="warn">Aviso</Badge> {a}</li>)}
        </ul>
      ) : null}
      {datos.recientes.length ? <a className="small" href="#corridas">Ver últimas corridas</a> : null}
    </div>
  )
}

/** Criterio 1: «Últimas corridas» plegada abajo, con 5 columnas y «Más columnas» para el resto. */
function BloqueCorridas({ datos }: { datos: Corridas }) {
  return (
    <details className="section plegable-seccion" id="corridas">
      <summary><h2>Últimas corridas</h2> <span className="small muted">({datos.recientes.length})</span></summary>
      <p className="small muted">Inicio y Fin en hora de Mérida. «—» en Mensaje = la corrida no dejó nota.</p>
      <TablaCorridas filas={datos.recientes} />
    </details>
  )
}

/** Etiqueta K4 (ORD-POS-148); sin valor en K4_MACRO_STATUS, nada. */
function EtiquetaMacro({ k4 }: { k4: EtiquetaK4 | null }) {
  return k4 ? <Badge tone={k4.tono} title={k4.ayuda}>{k4.texto}</Badge> : null
}

const AYUDA_K4 = `Validación macro de Google Trends que calcula RADAROS (K4_MACRO_STATUS); «consulta vencida» = más de ${K4_VIGENCIA_DIAS} días. Un veto lo decide el propietario.`

/** Pares nombre–valor del detalle de una idea (criterio 4): título en español, ayuda y formato de `formatearValor`. */
function Pares({ fila, columnas, mapa }: { fila: Fila; columnas: readonly string[]; mapa?: Readonly<Record<string, Columna>> }) {
  return (
    <dl className="meta meta-wide idea-pares">
      {columnas.map((c) => {
        const titulo = tituloColumna(c, mapa)
        const ayuda = ayudaColumna(c, mapa)
        const valor = formatearValor(c, fila[c] ?? null)
        return (
          <div key={c}>
            <dt>{titulo === c ? <code>{c}</code> : titulo}{ayuda ? <>{' '}<Ayuda texto={ayuda} /></> : null}</dt>
            <dd>{valor === null ? <SinDato /> : valor}</dd>
          </div>
        )
      })}
    </dl>
  )
}

/** Pestaña «Unit economics» de una idea: su fila de UNIT_ECONOMICS o el estado del bloque (diseño §4). */
function UnitDeIdea({ unit, id }: { unit: Bloque<UnitEconomics>; id: string }) {
  if (unit.estado === 'columnas-faltantes') return <p className="small muted"><code>{unit.tab}</code>: faltan columnas ({unit.faltan.join(', ')}).</p>
  if (unit.estado !== 'ok') return <p className="small muted">{unit.mensaje}</p>
  const fila = unit.datos.filas.find((f) => f[COLUMNA_ID_IDEA] === id)
  if (!fila) return <p className="small muted">Sin fila en <code>UNIT_ECONOMICS</code> para esta idea.</p>
  return (
    <>
      <p className="small"><strong>Las tarifas de SP-API son estimaciones no garantizadas.</strong></p>
      <Pares fila={fila} columnas={COLUMNAS_UNIT} />
    </>
  )
}

/** Datos del ranking que no vienen de SCORING: productos de compras por idea y el tabulador (null si está apagado). */
interface Compras {
  productos: ReadonlyMap<string, Tarjeta>
  /** Mensaje si PIPE_PRODUCTOS no se pudo leer; las ideas se muestran sin producto. */
  avisoProductos: string | null
  tabulador: TabuladorVista | null
}

/** Criterio 3: costo máximo contra la mejor cotización, del mismo `comparar` y `mejorCotizacion` que la ficha de Compras. */
function CostoIdea({ t, tabulador }: { t: Tarjeta | undefined; tabulador: TabuladorVista | null }) {
  if (!tabulador) return <span className="muted" title="ECO_TABULADOR apagada: la enciende el propietario.">Tabulador apagado</span>
  if (!t) return <span className="muted" title={SIN_PRODUCTO}>—</span>
  const cmp = tabulador.comparar(t.id, t.fila.IDEA_ID ?? null)
  const max = cmp.costoMaximo
  const mejor = mejorCotizacion(cmp)
  return (
    <>
      Máx. {max.mxn == null ? <span title={max.porConfirmar.join('; ')}>{POR_CONFIRMAR}</span> : <span className="mono">{formatoMxn(max.mxn)} MXN</span>}
      {' · '}Mejor {mejor
        ? <><span className="mono">{formatoMxn(mejor.costo.porSetMxn)} MXN</span> <Veredicto f={mejor} motivo={max.porConfirmar.join('; ')} /></>
        : <span className="muted" title="Ninguna cotización con costo por set">—</span>}
    </>
  )
}

/** Criterios 1 y 2: un renglón por idea; al abrirlo, su detalle en pestañas (criterio 4). */
function FilaIdea({ idea, datos, unit, compras }: { idea: IdeaRanking; datos: Ranking; unit: Bloque<UnitEconomics>; compras: Compras }) {
  const t = compras.productos.get(idea.id)
  const semana = idea.campos.AMZ_SEMANA ?? idea.resumen?.ultimaSemana ?? null
  const pestanas: Pestana[] = [
    ...Object.entries(GRUPOS_SCORING).map(([grupo, columnas]) => ({ id: grupo.toLowerCase(), titulo: grupo, contenido: <Pares fila={idea.campos} columnas={columnas} /> })),
    ...(datos.conColumnasTrends ? [{ id: 'macro', titulo: 'Macro (Trends)', contenido: <Pares fila={idea.campos} columnas={GRUPO_MACRO_TRENDS} /> }] : []),
    { id: 'unit', titulo: 'Unit economics', contenido: <UnitDeIdea unit={unit} id={idea.id} /> },
  ]
  return (
    <li className="card idea-fila">
      <details id={anclaIdea(idea.id)}>
        <summary>
          <span className="idea-nombre">
            <strong>{idea.nombre ?? idea.id}</strong>{idea.nombre ? <> · <span className="small mono">{idea.id}</span></> : null}
            {' '}<span className="small muted">· Semana {semana ?? '—'}</span>
          </span>
          <span className="idea-dato"><span className="muted small">Puntaje</span> {idea.puntuacion ?? <SinDato />}</span>
          {datos.conColumnasTrends ? <span className="idea-dato"><EtiquetaMacro k4={idea.k4} /></span> : null}
          <span className="idea-dato">
            <span className="muted small">Decisión</span> {idea.decision ?? <SinDato />}
            {' · '}{t ? etapaDeProducto(t) : <span className="muted">{SIN_PRODUCTO}</span>}
          </span>
          <span className="idea-dato idea-costo"><CostoIdea t={t} tabulador={compras.tabulador} /></span>
        </summary>
        <div className="idea-detalle">
          <dl className="meta meta-wide">
            <div><dt>Estado en el motor (<code>AMZ_ESTADO</code>)</dt><dd><Text value={idea.campos.AMZ_ESTADO ?? null} empty="—" /></dd></div>
            <div><dt>Última semana en AMZ_RESUMEN</dt><dd>{idea.resumen ? <>{idea.resumen.ultimaSemana} <StateBadge code={idea.resumen.estado} /></> : <span className="muted">—</span>}</dd></div>
            <div><dt>Semanas con historial</dt><dd>{idea.resumen ? idea.resumen.semanas : <span className="muted">0</span>}</dd></div>
          </dl>
          <PestanasIdea pestanas={pestanas} etiqueta={`Insumos de ${etiquetaIdea(idea.id, idea.nombre)}`} />
        </div>
      </details>
      {t ? <a className="small idea-compras" href={enlaceFichaCompras(t.id)} aria-label={`Ficha en Compras de ${etiquetaIdea(idea.id, idea.nombre)} (${t.id})`}>Ficha en Compras</a> : null}
    </li>
  )
}

type FiltroRanking = { k4: FiltroK4 | null; conProducto: boolean }

function BloqueRanking({ datos, unit, compras, filtro, tendencias }: {
  datos: Ranking; unit: Bloque<UnitEconomics>; compras: Compras; filtro: FiltroRanking; tendencias: Search
}) {
  const efectivo: FiltroRanking = { ...filtro, k4: datos.conColumnasTrends ? filtro.k4 : null }
  const ideas = filtrarIdeas(datos.ideas, efectivo, compras.productos)
  const filtrando = efectivo.k4 !== null || efectivo.conProducto
  return (
    <>
      {datos.columnaPuntuacion ? (
        <p className="small muted">Orden de SCORING por <code>{datos.columnaPuntuacion}</code> (mayor primero). La puntuación la calculan las fórmulas de la hoja.</p>
      ) : (
        <div className="alert alert-warn" role="alert">
          <p>SCORING no tiene columna de puntuación reconocida ({COLUMNAS_PUNTUACION.join(', ')}); las ideas van por ID.</p>
        </div>
      )}
      {datos.conColumnasAmz ? null : <p className="small muted">SCORING todavía no tiene columnas <code>AMZ_*</code>: se agregan en la activación de V1.2.</p>}
      {datos.conColumnaDecision ? null : <p className="small muted">SCORING no tiene la columna «Decisión»: la decisión se muestra «—».</p>}
      {compras.avisoProductos ? <p className="small muted">{compras.avisoProductos} Las ideas se muestran sin producto.</p> : null}
      <form method="get" action="/eco#ranking" className="filters" aria-label="Filtrar ideas">
        <FiltroAuto />
        {tendencias.estado ? <input type="hidden" name="estado" value={tendencias.estado} /> : null}
        {tendencias.etiqueta ? <input type="hidden" name="etiqueta" value={tendencias.etiqueta} /> : null}
        {datos.conColumnasTrends ? (
          <label>Validación macro (K4) <Ayuda texto={AYUDA_K4} />{' '}
            <select name="k4" defaultValue={efectivo.k4 ?? ''}>
              {FILTROS_K4.map(([v, texto]) => <option key={v} value={v}>{texto}</option>)}
            </select>
          </label>
        ) : null}{' '}
        <label><input type="checkbox" name="compras" value="1" defaultChecked={efectivo.conProducto} /> Solo con producto en compras</label>{' '}
        <button type="submit">Filtrar</button>
        {filtrando ? <>{' '}<a className="small" href={hrefFiltros({ k4: null, conProducto: false }, { estado: tendencias.estado, etiqueta: tendencias.etiqueta })}>Quitar filtros</a></> : null}
      </form>
      {filtrando ? <p className="small muted" role="status">Se muestran {ideas.length} de {datos.ideas.length} ideas.</p> : null}
      <AbrirIdeaPorHash />
      {ideas.length ? (
        <ol className="list idea-lista" aria-label="Ranking de ideas">
          {ideas.map((idea) => <FilaIdea key={idea.id} idea={idea} datos={datos} unit={unit} compras={compras} />)}
        </ol>
      ) : <Empty>Ninguna idea con esos filtros.</Empty>}
      {datos.resumen.estado === 'ok' ? null : (
        <EstadoBloque bloque={datos.resumen}>{() => null}</EstadoBloque>
      )}
      <p className="small muted">Abre una idea para ver sus insumos; su enlace queda como <code>#idea-&lt;ID&gt;</code>. Costos del tabulador (DEC-ECO-008), los mismos de la ficha de Compras.</p>
      {LEYENDA_SIN_DATO}
    </>
  )
}

function BloqueUnit({ datos }: { datos: UnitEconomics }) {
  return (
    <>
      <p className="small"><strong>Las tarifas de SP-API son estimaciones no garantizadas.</strong></p>
      {datos.conColumnasAmz ? null : <p className="small muted">UNIT_ECONOMICS todavía no tiene columnas <code>AMZ_*</code>: se agregan en la activación de V1.2.</p>}
      <TablaColumnas filas={datos.filas} label="Unit economics por idea" clave={COLUMNA_ID_IDEA} memoria="eco-unit" nombres={datos.nombres}
        visibles={UNIT_VISIBLES} extras={UNIT_EXTRAS} />
      {LEYENDA_SIN_DATO}
    </>
  )
}

function BloqueTendencias({ datos, filtro }: { datos: Tendencias; filtro: Search }) {
  const k4 = parseFiltroK4(filtro.k4)
  const estado = filtro.estado && datos.estados.includes(filtro.estado) ? filtro.estado : undefined
  const etiqueta = filtro.etiqueta && datos.etiquetas.includes(filtro.etiqueta) ? filtro.etiqueta : undefined
  const filas = filtrarTendencias(datos.filas, { estado, etiqueta })
  return (
    <>
      <form method="get" action="/eco#tendencias" className="filters" aria-label="Filtrar tendencias">
        <FiltroAuto />
        {k4 ? <input type="hidden" name="k4" value={k4} /> : null}
        {filtro.compras === '1' ? <input type="hidden" name="compras" value="1" /> : null}
        <label>Estado{' '}
          <select name="estado" defaultValue={estado ?? ''}>
            <option value="">Todos</option>
            {datos.estados.map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
        </label>{' '}
        <label>Etiqueta{' '}
          <select name="etiqueta" defaultValue={etiqueta ?? ''}>
            <option value="">Todas</option>
            {datos.etiquetas.map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
        </label>{' '}
        <button type="submit">Filtrar</button>
      </form>
      {filas.length > TENDENCIAS_MAX ? <p className="small muted">Se muestran {TENDENCIAS_MAX} de {filas.length} términos, en el orden de la hoja.</p> : null}
      <TablaColumnas filas={filas.slice(0, TENDENCIAS_MAX)} label="Tendencias de Mercado Libre" clave="KEYWORD" memoria="eco-tendencias"
        visibles={TENDENCIAS_VISIBLES} extras={TENDENCIAS_EXTRAS} />
      <p className="small muted"><code>POSICION_ULTIMA</code> no es un ranking: son tres listas concatenadas.</p>
    </>
  )
}

export default async function EcoPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { user, result } = await privateEco('/eco')
  const params = await searchParams

  if (result.estado === 'no-configurado') {
    return (
      <>
        <h1>RADAROS</h1>
        <div className="alert alert-warn" role="status">
          <p>RADAROS no está configurado en este despliegue{result.motivo === 'no-valido' ? ' (valor no válido)' : ''}.</p>
          <p className="small">La activación es del propietario: compartir la hoja como Lector con la cuenta de lectura, configurar
            {' '}<code>RADAROS_SHEET_ID</code> con <code>deploy.sh --desde-activa</code> y verificar (docs/diseno-eco-radaros.md §6).</p>
        </div>
      </>
    )
  }
  if (result.estado === 'error') {
    return (
      <>
        <h1>RADAROS</h1>
        <div className="alert alert-danger" role="alert">
          <h2>No se pudieron leer los datos de RADAROS</h2>
          <p>{result.message}{result.reintentar ? ' Intenta en un minuto.' : ''}</p>
          <p className="muted">Intento: {formatInstant(result.at)} (hora Mérida). No se muestran datos parciales.</p>
        </div>
      </>
    )
  }

  const v = result.vista
  // ORD-POS-151: el producto de compras de cada idea y el tabulador, de lo que ya se leyó (sin lecturas nuevas).
  // paraLector como en /eco/pipeline: un lector nunca recibe CONTACTO ni NOTAS de proveedores (aquí no se pintan).
  const pipeline = paraLector(v.pipeline, writeAccess(user.email).allowed || ecoPipelineCanWrite(user.email))
  const compras: Compras = {
    productos: productosPorIdea(pipeline.productos.estado === 'ok' ? pipeline.productos.datos.tarjetas : []),
    avisoProductos: pipeline.productos.estado === 'ok' ? null
      : pipeline.productos.estado === 'columnas-faltantes' ? `PIPE_PRODUCTOS: faltan columnas (${pipeline.productos.faltan.join(', ')}).`
        : pipeline.productos.mensaje,
    tabulador: ecoTabuladorHabilitado() ? v.tabulador : null,
  }
  const filtro: FiltroRanking = { k4: parseFiltroK4(params.k4), conProducto: params.compras === '1' }
  return (
    <>
      <h1>RADAROS</h1>
      <p className="muted small">
        Solo lectura de la hoja de RADAROS, leída {formatInstant(result.fetchedAt)} (hora Mérida). Esta página no escribe,
        no llama a Keepa ni a SP-API y no calcula puntuaciones: muestra lo que el motor dejó en la hoja.
      </p>
      <Section title="Estado del motor" id="motor"><EstadoBloque bloque={v.corridas}>{(d) => <LineaMotor datos={d} />}</EstadoBloque></Section>
      <Section title="Ranking de ideas" id="ranking"><EstadoBloque bloque={v.ranking}>{(d) => <BloqueRanking datos={d} unit={v.unitEconomics} compras={compras} filtro={filtro} tendencias={params} />}</EstadoBloque></Section>
      <Section title="Unit economics" id="unit-economics"><EstadoBloque bloque={v.unitEconomics}>{(d) => <BloqueUnit datos={d} />}</EstadoBloque></Section>
      {/* Criterio 4: candidatos en una línea, sin sección propia. */}
      <p className="small muted" id="candidatos"><strong>Candidatos:</strong> {v.candidatos.mensaje}</p>
      {/* Criterios 1 y 3: lo secundario, plegado abajo. Con un filtro de tendencias aplicado, se abre. */}
      <details className="section plegable-seccion" id="tendencias" open={Boolean(params.estado || params.etiqueta)}>
        <summary><h2>Tendencias</h2>{v.tendencias.estado === 'ok' ? <> <span className="small muted">({v.tendencias.datos.filas.length} términos)</span></> : null}</summary>
        <EstadoBloque bloque={v.tendencias}>{(d) => <BloqueTendencias datos={d} filtro={params} />}</EstadoBloque>
      </details>
      {v.corridas.estado === 'ok' && v.corridas.datos.recientes.length ? <BloqueCorridas datos={v.corridas.datos} /> : null}
    </>
  )
}
