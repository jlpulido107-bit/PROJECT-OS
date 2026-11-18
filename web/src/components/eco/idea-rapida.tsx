'use client'

import { useState, type FormEvent } from 'react'
import { NOMBRE_MAX, PALABRA_MAX, tarjetaIdeaRapida, type IdeaRapida, type TarjetaIdeaRapida } from '@/lib/radaros/idea-amazon'

/* --------------------------------------------------------------------------------------------
 * Alta rápida de una idea (ORD-POS-160, DEC-ECO-017): tres campos (nombre, enlace de Amazon México y palabra de
 * búsqueda) que generan una tarjeta de texto para pegar en POS · Ideas. Este formulario NO escribe: no llama a ninguna
 * ruta ni a Sheets; todo ocurre en el navegador. El alta real la hace el PM con `idea.alta` tras el «sí PAQ».
 *
 * Montaje: componente aislado, sin props ni datos del servidor. Va en la página de ORD-POS-159 con una sola línea,
 * `<IdeaRapida />` (docs/escritura-v1-8.md §9.1); mientras esa página no esté en main, no se monta en ninguna.
 * ------------------------------------------------------------------------------------------ */

const VACIA: IdeaRapida = { nombre: '', enlace: '', palabra: '' }
const CAMPOS: Array<{ clave: keyof IdeaRapida; etiqueta: string; ayuda: string; max?: number; tipo?: string }> = [
  { clave: 'nombre', etiqueta: 'Nombre de la idea', ayuda: 'Como se llamará en PRODUCTS.', max: NOMBRE_MAX },
  { clave: 'enlace', etiqueta: 'Enlace de Amazon México', ayuda: 'Del producto en amazon.com.mx (con /dp/ o /gp/product/).', tipo: 'url' },
  { clave: 'palabra', etiqueta: 'Palabra de búsqueda', ayuda: 'Lo que buscarías en Amazon México para ver el nicho.', max: PALABRA_MAX },
]

export function IdeaRapida() {
  const [idea, setIdea] = useState<IdeaRapida>(VACIA)
  const [tarjeta, setTarjeta] = useState<TarjetaIdeaRapida | null>(null)
  const [copia, setCopia] = useState<'idle' | 'copiado' | 'manual'>('idle')
  const errores = tarjeta && !tarjeta.ok ? tarjeta.errores : {}

  function generar(e: FormEvent) {
    e.preventDefault()
    setCopia('idle')
    setTarjeta(tarjetaIdeaRapida(idea))
  }

  async function copiar(texto: string) {
    try {
      await navigator.clipboard.writeText(texto)
      setCopia('copiado')
    } catch {
      setCopia('manual')
    }
  }

  return (
    <section className="card stack" aria-labelledby="idea-rapida-titulo">
      <h2 id="idea-rapida-titulo">Idea rápida</h2>
      <p className="small muted">Genera el texto para POS · Ideas. Aquí no se guarda ni se envía nada.</p>
      <form className="stack" onSubmit={generar} noValidate>
        {CAMPOS.map(({ clave, etiqueta, ayuda, max, tipo }) => (
          <div key={clave}>
            <label htmlFor={`idea-rapida-${clave}`}>{etiqueta}</label>
            <input
              id={`idea-rapida-${clave}`} type={tipo ?? 'text'} value={idea[clave]} maxLength={max} required autoComplete="off"
              aria-invalid={errores[clave] ? true : undefined} aria-describedby={`idea-rapida-${clave}-ayuda`}
              onChange={(e) => { setIdea({ ...idea, [clave]: e.target.value }); setTarjeta(null) }}
            />
            <p id={`idea-rapida-${clave}-ayuda`} className="small muted">
              {errores[clave] ? <span className="alert alert-danger" role="alert">{errores[clave]}</span> : ayuda}
            </p>
          </div>
        ))}
        <button type="submit" className="button button-primary">Generar tarjeta</button>
      </form>
      {tarjeta?.ok ? (
        <div className="stack">
          <textarea readOnly rows={7} value={tarjeta.texto} aria-label="Tarjeta para POS · Ideas" className="mono" />
          <div>
            <button type="button" className="button" onClick={() => void copiar(tarjeta.texto)}>Copiar tarjeta</button>{' '}
            <span role="status" className="small muted">
              {copia === 'copiado' ? 'Copiada.' : copia === 'manual' ? 'No se pudo copiar: selecciona el texto y cópialo.' : ''}
            </span>
          </div>
        </div>
      ) : null}
    </section>
  )
}
