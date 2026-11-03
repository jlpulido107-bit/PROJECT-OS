'use client'

import { useId, useState } from 'react'
import { enlaceCalendario, enlaceOculto } from '@/lib/calendario-ics-enlace'

/**
 * Enlace del calendario ICS de solo lectura (ORD-POS-142, criterio 5), solo para la sesión del propietario. El servidor
 * guarda únicamente el SHA-256 del secreto (escritura §11.3), así que no puede mostrarlo: el enlace se ve con el secreto
 * oculto y «Copiar enlace» lo arma en este navegador con el secreto que el propietario pega. El secreto no se envía al
 * servidor ni se guarda: solo vive en este campo mientras la página está abierta.
 */
export function CalendarioIcsPanel({ origen, encendido }: { origen: string; encendido: boolean }) {
  const [secreto, setSecreto] = useState('')
  const [estado, setEstado] = useState<'idle' | 'copiado' | 'manual' | 'invalido'>('idle')
  const [manual, setManual] = useState<string | null>(null)
  const id = useId()

  async function copiar() {
    const enlace = enlaceCalendario(origen || window.location.origin, secreto)
    if (!enlace) {
      setEstado('invalido')
      return
    }
    try {
      await navigator.clipboard.writeText(enlace)
      setManual(null)
      setEstado('copiado')
    } catch {
      setManual(enlace)
      setEstado('manual')
    }
  }

  return (
    <section className="card" aria-labelledby={`${id}-titulo`}>
      <header className="card-head">
        <h2 id={`${id}-titulo`}>Calendario (solo lectura)</h2>
      </header>
      {!encendido ? (
        <p className="muted small">
          Calendario apagado: lo enciende solo el propietario con deploy.sh (PLANIFICACION_ICS y su secreto).
        </p>
      ) : (
        <>
          <p className="small">
            Suscríbete desde Google Calendar («Otros calendarios» → «Desde URL») con este enlace. Trae el plan registrado y
            los vencimientos de los próximos 14 días; nada se escribe de vuelta en la hoja.
          </p>
          <p><code className="mono small" aria-label="Enlace del calendario con el secreto oculto">{enlaceOculto(origen)}</code></p>
          <label className="small" htmlFor={`${id}-secreto`}>
            Secreto del enlace (el que creaste al activar; no se envía ni se guarda)
          </label>
          <input
            id={`${id}-secreto`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={secreto}
            onChange={(e) => { setSecreto(e.currentTarget.value); setEstado('idle'); setManual(null) }}
          />
          <div className="card-actions">
            <button type="button" className="button button-primary" onClick={copiar} aria-describedby={`${id}-ayuda`}>
              {estado === 'copiado' ? 'Copiado ✓' : 'Copiar enlace'}
            </button>
          </div>
          <p id={`${id}-ayuda`} className="muted small" role="status">
            {estado === 'copiado'
              ? 'Enlace copiado con el secreto. Pégalo solo en tu app de calendario.'
              : estado === 'invalido'
                ? 'Pega primero el secreto del enlace (letras, dígitos, punto, guion o guion bajo; 16 caracteres o más).'
                : estado === 'manual'
                  ? 'No se pudo copiar automáticamente: selecciona el enlace de abajo y cópialo.'
                  : 'El servidor solo guarda la huella del secreto: por eso no puede mostrarlo.'}
          </p>
          {manual ? <textarea readOnly value={manual} rows={2} aria-label="Enlace del calendario" onFocus={(e) => e.currentTarget.select()} /> : null}
          <p className="small">
            <strong>Aviso:</strong> Google Calendar relee el enlace cada varias horas; un cambio en la hoja puede tardar en
            verse. Si el secreto se filtra, rótalo (escritura §11.3): el enlace viejo deja de funcionar.
          </p>
        </>
      )}
    </section>
  )
}
