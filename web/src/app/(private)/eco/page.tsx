import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { Badge, Empty, Section, StateBadge, Text } from '@/components/ui'
import { formatInstant } from '@/lib/dates'
import { privateEco } from '@/lib/page-data'
import {
  COLUMNA_ID_IDEA, COLUMNAS_PUNTUACION, filtrarTendencias, GRUPO_MACRO_TRENDS, GRUPOS_SCORING, type Bloque, type Corridas, type Fila,
  type Ranking, type Tendencias, type UnitEconomics,
} from '@/lib/radaros/eco'
import {
  ayudaColumna, COLUMNAS_CORRIDAS_ECO, estadoCorrida, etiquetaIdea, formatearInstante, formatearValor, K4_VIGENCIA_DIAS, SIN_DATO,
  tituloColumna, type Columna, type EtiquetaK4,
} from '@/lib/radaros/eco-columnas'
import { FiltroAuto } from '@/components/filtro-auto'

export const metadata: Metadata = { title: 'RADAROS (solo lectura)' }

type Search = { estado?: string; etiqueta?: string }

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

function Celda({ fila, col }: { fila: Fila; col: string }) {
  const valor = formatearValor(col, fila[col] ?? null)
  return <td>{valor === null ? <SinDato /> : valor}</td>
}

function Ayuda({ texto }: { texto: string }) {
  return <span title={texto} role="img" aria-label={`Ayuda: ${texto}`}>ⓘ</span>
}

/** Título en español con ayuda (ⓘ) de una línea; sin traducción, el encabezado tal cual. */
function Encabezado({ col, mapa }: { col: string; mapa?: Readonly<Record<string, Columna>> }) {
  const titulo = tituloColumna(col, mapa)
  const ayuda = ayudaColumna(col, mapa)
  return (
    <th scope="col">
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
const COLUMNAS_TABLA_CORRIDAS = [
  'SEMANA', 'INICIO', 'FIN', 'ESTADO', 'IDEAS', 'ASINS_OK', 'ASINS_FALTAN', 'KEEPA_TOKENS_CONSUMIDOS', 'SPAPI_LLAMADAS', 'MENSAJE',
] as const

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
  return <td>{valor === null ? <SinDato /> : valor}</td>
}

function TablaCorridas({ filas }: { filas: Fila[] }) {
  return (
    <div className="table-wrap">
      <table aria-label="Últimas corridas">
        <thead><tr>{COLUMNAS_TABLA_CORRIDAS.map((c) => <Encabezado key={c} col={c} mapa={COLUMNAS_CORRIDAS_ECO} />)}</tr></thead>
        <tbody>
          {filas.map((f, i) => (
            <tr key={`${f.CORRIDA_ID ?? ''}-${i}`}>
              {COLUMNAS_TABLA_CORRIDAS.map((c) => <CeldaCorrida key={c} fila={f} col={c} />)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const LEYENDA_SIN_DATO = <p className="small muted">«—» = {SIN_DATO}.</p>

function TablaColumnas({ filas, columnas, label, clave, nombres }: {
  filas: Fila[]; columnas: readonly string[]; label: string; clave: string; nombres?: Map<string, string>
}) {
  return (
    <div className="table-wrap">
      <table aria-label={label}>
        <thead><tr>{columnas.map((c) => (nombres && c === COLUMNA_ID_IDEA ? <th key={c} scope="col">Idea</th> : <Encabezado key={c} col={c} />))}</tr></thead>
        <tbody>
          {filas.map((f, i) => (
            <tr key={`${f[clave] ?? ''}-${i}`}>
              {columnas.map((c) => (nombres && c === COLUMNA_ID_IDEA
                ? <th key={c} scope="row">{etiquetaIdea(f[c] ?? '', nombres.get(f[c] ?? ''))}</th>
                : <Celda key={c} fila={f} col={c} />))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function BloqueCorridas({ datos }: { datos: Corridas }) {
  const u = datos.ultima
  return (
    <>
      {datos.avisos.length ? (
        <ul className="list" aria-label="Avisos del motor">
          {datos.avisos.map((a) => <li key={a}><Badge tone="warn">Aviso</Badge> {a}</li>)}
        </ul>
      ) : null}
      {u ? (
        <dl className="meta meta-wide">
          <div><dt>Última corrida</dt><dd><Text value={u.CORRIDA_ID ?? null} /> <EstadoDeCorrida raw={u.ESTADO ?? null} /></dd></div>
          <div><dt>Semana</dt><dd><Text value={u.SEMANA ?? null} /></dd></div>
          <div><dt>Inicio (hora Mérida)</dt><dd><Text value={formatearInstante(u.INICIO ?? null)} /></dd></div>
          <div><dt>Tokens de Keepa</dt><dd><Text value={u.KEEPA_TOKENS_CONSUMIDOS ?? null} empty="—" /> consumidos · <Text value={u.KEEPA_TOKENS_RESTANTES ?? null} empty="—" /> restantes</dd></div>
        </dl>
      ) : null}
      <h3>Últimas corridas</h3>
      <p className="small muted">Inicio y Fin en hora de Mérida. «—» en Mensaje = la corrida no dejó nota.</p>
      <TablaCorridas filas={datos.recientes} />
    </>
  )
}

/** Etiqueta K4 (ORD-POS-148); sin valor en K4_MACRO_STATUS, nada. */
function EtiquetaMacro({ k4 }: { k4: EtiquetaK4 | null }) {
  return k4 ? <Badge tone={k4.tono} title={k4.ayuda}>{k4.texto}</Badge> : null
}

const AYUDA_K4 = `Validación macro de Google Trends que calcula RADAROS (K4_MACRO_STATUS); «consulta vencida» = más de ${K4_VIGENCIA_DIAS} días. Un veto lo decide el propietario.`

function BloqueRanking({ datos }: { datos: Ranking }) {
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
      <div className="table-wrap">
        <table aria-label="Ranking de ideas">
          <thead>
            <tr>
              <th scope="col">Idea</th><th scope="col">Puntuación</th><Encabezado col="AMZ_SEMANA" /><Encabezado col="AMZ_ESTADO" />
              <th scope="col">Última semana en AMZ_RESUMEN</th><th scope="col">Semanas con historial</th>
              {datos.conColumnasTrends ? <th scope="col">Validación macro (K4) <Ayuda texto={AYUDA_K4} /></th> : null}
            </tr>
          </thead>
          <tbody>
            {datos.ideas.map((idea) => (
              <tr key={idea.id}>
                <th scope="row">{etiquetaIdea(idea.id, idea.nombre)}</th>
                <td>{idea.puntuacion ?? <SinDato />}</td>
                <Celda fila={idea.campos} col="AMZ_SEMANA" />
                <Celda fila={idea.campos} col="AMZ_ESTADO" />
                <td>{idea.resumen ? <>{idea.resumen.ultimaSemana} <StateBadge code={idea.resumen.estado} /></> : <span className="muted">—</span>}</td>
                <td>{idea.resumen ? idea.resumen.semanas : <span className="muted">0</span>}</td>
                {datos.conColumnasTrends ? <td><EtiquetaMacro k4={idea.k4} /></td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {datos.resumen.estado === 'ok' ? null : (
        <EstadoBloque bloque={datos.resumen}>{() => null}</EstadoBloque>
      )}
      {Object.entries(GRUPOS_SCORING).map(([grupo, columnas]) => (
        <details key={grupo}>
          <summary>{grupo}</summary>
          <TablaColumnas filas={datos.ideas.map((i) => i.campos)} columnas={[COLUMNA_ID_IDEA, ...columnas]} label={`Insumos de ${grupo}`} clave={COLUMNA_ID_IDEA} nombres={datos.nombres} />
        </details>
      ))}
      {datos.conColumnasTrends ? (
        <details>
          <summary>Macro (Trends)</summary>
          <TablaColumnas filas={datos.ideas.map((i) => i.campos)} columnas={[COLUMNA_ID_IDEA, ...GRUPO_MACRO_TRENDS]} label="Insumos de Macro (Trends)" clave={COLUMNA_ID_IDEA} nombres={datos.nombres} />
        </details>
      ) : null}
      {LEYENDA_SIN_DATO}
    </>
  )
}

function BloqueUnit({ datos }: { datos: UnitEconomics }) {
  return (
    <>
      <p className="small"><strong>Las tarifas de SP-API son estimaciones no garantizadas.</strong></p>
      {datos.conColumnasAmz ? null : <p className="small muted">UNIT_ECONOMICS todavía no tiene columnas <code>AMZ_*</code>: se agregan en la activación de V1.2.</p>}
      <TablaColumnas filas={datos.filas} label="Unit economics por idea" clave={COLUMNA_ID_IDEA} nombres={datos.nombres}
        columnas={[COLUMNA_ID_IDEA, 'AMZ_ASIN_REF', 'AMZ_PRECIO_MXN', 'AMZ_PRECIO_MXN_AVG90', 'AMZ_COMISION_MXN', 'AMZ_COMISION_PCT', 'AMZ_FBA_MXN', 'AMZ_OTRAS_TARIFAS_MXN', 'AMZ_TARIFAS_FECHA']} />
      {LEYENDA_SIN_DATO}
    </>
  )
}

function BloqueTendencias({ datos, filtro }: { datos: Tendencias; filtro: Search }) {
  const estado = filtro.estado && datos.estados.includes(filtro.estado) ? filtro.estado : undefined
  const etiqueta = filtro.etiqueta && datos.etiquetas.includes(filtro.etiqueta) ? filtro.etiqueta : undefined
  const filas = filtrarTendencias(datos.filas, { estado, etiqueta })
  return (
    <>
      <form method="get" action="/eco#tendencias" className="filters" aria-label="Filtrar tendencias">
        <FiltroAuto />
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
      <TablaColumnas filas={filas.slice(0, TENDENCIAS_MAX)} label="Tendencias de Mercado Libre" clave="KEYWORD"
        columnas={['KEYWORD', 'SEMANAS_DISTINTAS', 'PRIMERA_SEMANA', 'ULTIMA_SEMANA', 'ESTADO', 'ETIQUETA_PRELIMINAR', 'POSICION_ULTIMA']} />
      <p className="small muted"><code>POSICION_ULTIMA</code> no es un ranking: son tres listas concatenadas.</p>
    </>
  )
}

export default async function EcoPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { result } = await privateEco('/eco')
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
  return (
    <>
      <h1>RADAROS</h1>
      <p className="muted small">
        Solo lectura de la hoja de RADAROS, leída {formatInstant(result.fetchedAt)} (hora Mérida). Esta página no escribe,
        no llama a Keepa ni a SP-API y no calcula puntuaciones: muestra lo que el motor dejó en la hoja.
      </p>
      <Section title="Estado del motor" id="motor"><EstadoBloque bloque={v.corridas}>{(d) => <BloqueCorridas datos={d} />}</EstadoBloque></Section>
      <Section title="Ranking de ideas" id="ranking"><EstadoBloque bloque={v.ranking}>{(d) => <BloqueRanking datos={d} />}</EstadoBloque></Section>
      <Section title="Unit economics" id="unit-economics"><EstadoBloque bloque={v.unitEconomics}>{(d) => <BloqueUnit datos={d} />}</EstadoBloque></Section>
      <Section title="Candidatos" id="candidatos"><Empty>{v.candidatos.mensaje}</Empty></Section>
      <Section title="Tendencias" id="tendencias"><EstadoBloque bloque={v.tendencias}>{(d) => <BloqueTendencias datos={d} filtro={params} />}</EstadoBloque></Section>
    </>
  )
}
