'use client'

import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { CasillaEntregaCedis, Entrada } from '@/components/eco/formularios-pipeline'
import { CASILLA_ENTREGA_CEDIS, cuerpo, enviar, etiquetaCampo, reglaEntregaCedis, type Resultado } from '@/lib/radaros/pipeline-formularios'
import {
  confirmable, firmaDe, parsearTablaGemini, revisarBorrador, type Borrador, type ContextoPegado, type ResultadoPegado,
} from '@/lib/radaros/pipeline-pegado'

/* --------------------------------------------------------------------------------------------
 * «Pegar tabla de Gemini» (ORD-POS-146, criterio 3; docs/diseno-eco-pipeline.md §15.3). El texto pegado se interpreta en
 * el navegador y genera un borrador por fila; nada se envía al generarlo. Cada fila se corrige y se guarda solo con
 * «Confirmar y guardar» de esa fila, por la ruta de alta de cotizaciones que ya existe (el servidor repite todo). Las
 * filas no reconocidas, las duplicadas y las que tienen errores no tienen botón de guardar.
 * ------------------------------------------------------------------------------------------ */

type EstadoFila = { status: 'borrador' } | { status: 'sending' } | { status: 'hecho'; r: Resultado }

export interface PegarTablaGeminiProps {
  contexto: ContextoPegado
  /** Pistas de PIPE_PARAMETROS por columna (las mismas del formulario). */
  pistas?: Record<string, string>
}

function FilaBorrador({ b, contexto, pistas, guardadas, alGuardar }: {
  b: Borrador; contexto: ContextoPegado; pistas?: Record<string, string>; guardadas: ReadonlyMap<string, string>
  alGuardar: (firma: string | null, id: string) => void
}) {
  const router = useRouter()
  const [estado, setEstado] = useState<EstadoFila>({ status: 'borrador' })
  const [revision, setRevision] = useState({ errores: b.errores, duplicada: b.duplicada })
  const [precioPor, setPrecioPor] = useState(b.valores.precioPor ?? '')
  const titulo = `Fila de la línea ${b.linea}`

  if (!b.reconocida) {
    return (
      <li className="card">
        <p><strong>{titulo}: no reconocida</strong> — no se guarda. {b.motivo}</p>
        <pre className="small mono">{b.crudo}</pre>
      </li>
    )
  }

  async function confirmar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (estado.status === 'sending' || (estado.status === 'hecho' && estado.r.tipo === 'ok')) return
    const valores: Record<string, string> = {}
    for (const [k, v] of new FormData(event.currentTarget).entries()) if (typeof v === 'string') valores[k] = v
    // Se revisa otra vez con lo corregido: un error o un duplicado (con la hoja o con lo guardado en esta pantalla) no se envía.
    const r = revisarBorrador(valores, contexto, { idGemini: b.idGemini, previas: guardadas })
    setRevision(r)
    if (!confirmable({ reconocida: true, ...r })) return
    setEstado({ status: 'sending' })
    // ORD-POS-147 (criterio 2): con la casilla de DDP marcada se envía FLETE_CEDIS = 0 (ya revisado arriba).
    const aEnviar = reglaEntregaCedis(valores, contexto.fleteCedisRef ?? null).valores
    const res = await enviar('/api/eco/pipeline/cotizaciones', 'POST', cuerpo(contexto.campos, aEnviar, () => crypto.randomUUID()))
    setEstado({ status: 'hecho', r: res })
    if (res.tipo === 'ok') {
      alGuardar(firmaDe(valores), res.id)
      router.refresh()
    } else if (res.tipo === 'validacion') {
      setRevision({ errores: res.campos, duplicada: null })
    }
  }

  const guardada = estado.status === 'hecho' && estado.r.tipo === 'ok' ? estado.r : null
  const sending = estado.status === 'sending'
  const bloqueada = revision.duplicada !== null
  return (
    <li className="card">
      <form onSubmit={confirmar} aria-label={titulo} onChange={(e) => {
        const t: EventTarget = e.target
        if (!(t instanceof HTMLSelectElement)) return
        if (t.name === 'precioPor') setPrecioPor(t.value)
      }}>
        <p>
          <strong>{titulo}</strong>
          {b.idGemini ? <> · <span className="mono">{b.idGemini}</span> de Gemini (el ID real lo pone la hoja)</> : null}
        </p>
        {b.notas.length ? <ul className="list small">{b.notas.map((n) => <li key={n}>{n}</li>)}</ul> : null}
        {revision.duplicada ? <div className="alert alert-warn" role="alert"><p><strong>Duplicada: no se guarda.</strong> {revision.duplicada}</p></div> : null}
        <fieldset disabled={guardada !== null || sending} className="stack">
          {contexto.campos.map((c) => (
            <Entrada key={c.clave} c={c} valor={b.valores[c.clave] ?? ''} error={revision.errores[c.clave]} pista={pistas?.[c.columna]} etiqueta={etiquetaCampo(c, precioPor)} />
          ))}
          <CasillaEntregaCedis marcada={b.valores[CASILLA_ENTREGA_CEDIS] === 'SI'} error={revision.errores[CASILLA_ENTREGA_CEDIS]} />
        </fieldset>
        {guardada ? (
          <div className="alert alert-ok" role="status"><p><strong>{guardada.repetida ? 'Ya estaba guardada.' : 'Guardada.'}</strong> <span className="mono">{guardada.id}</span></p></div>
        ) : estado.status === 'hecho' && estado.r.tipo !== 'ok' ? (
          <div className="alert alert-danger" role="alert"><p><strong>No se guardó.</strong> {estado.r.mensaje}</p></div>
        ) : null}
        {guardada || bloqueada ? null : (
          <p><button type="submit" className="button button-primary" disabled={sending} aria-busy={sending}>{sending ? 'Guardando…' : 'Confirmar y guardar esta fila'}</button></p>
        )}
      </form>
    </li>
  )
}

export function PegarTablaGemini({ contexto, pistas }: PegarTablaGeminiProps) {
  const [texto, setTexto] = useState('')
  const [resultado, setResultado] = useState<ResultadoPegado | null>(null)
  const [generacion, setGeneracion] = useState(0)
  const [guardadas, setGuardadas] = useState<Map<string, string>>(new Map())

  function generar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setResultado(parsearTablaGemini(texto, contexto))
    setGeneracion((g) => g + 1)
  }

  const noReconocidas = resultado?.columnas.filter((c) => c.destino === null) ?? []
  return (
    <details className="eco-form">
      <summary>Pegar tabla de Gemini</summary>
      <form onSubmit={generar} aria-label="Pegar tabla de Gemini">
        <label className="field">
          <span>Tabla B del Gem 3 (Markdown o copiada de una hoja)</span>
          <textarea name="tabla" rows={8} value={texto} onChange={(e) => setTexto(e.target.value)} />
        </label>
        <p className="small muted">Generar no guarda nada: crea un borrador por fila para que lo revises y confirmes una por una.</p>
        <p><button type="submit" className="button">Generar borradores</button></p>
      </form>
      {resultado?.error ? <div className="alert alert-warn" role="alert"><p>{resultado.error}</p></div> : null}
      {noReconocidas.length ? (
        <div className="alert alert-warn" role="status">
          <p>Columnas no reconocidas (no se guardan): <code>{noReconocidas.map((c) => c.texto || '(vacía)').join(', ')}</code>.</p>
        </div>
      ) : null}
      {resultado && resultado.borradores.length ? (
        <ul className="plain stack" aria-label="Borradores">
          {resultado.borradores.map((b) => (
            <FilaBorrador key={`${generacion}-${b.linea}`} b={b} contexto={contexto} pistas={pistas} guardadas={guardadas}
              alGuardar={(f, id) => { if (f) setGuardadas((m) => new Map(m).set(f, id)) }} />
          ))}
        </ul>
      ) : null}
    </details>
  )
}
