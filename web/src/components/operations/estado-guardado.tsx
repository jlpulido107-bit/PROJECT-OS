import type { ReactNode } from 'react'
import type { EstadoGuardado as Estado } from '@/lib/planificacion-edicion'

/**
 * Estado de un guardado, reutilizable (ORD-POS-136): guardando, guardado con su versión, conflicto con el valor actual y
 * el tuyo, y error que conserva lo escrito. Todo vive dentro de una región aria-live que existe desde el primer render,
 * para que el lector de pantalla anuncie cada cambio; el conflicto y el error, además, como alerta.
 */
export function EstadoGuardado({ estado, actual, tuyo, children, registro = 'la tarea' }: {
  estado: Estado
  /** Qué cambió otra sesión, para el texto del conflicto («la tarea», «la capacidad de la semana»). */
  registro?: string
  /** Valor actual de la hoja (tras recargar la vista), para el conflicto. */
  actual?: ReactNode
  /** Lo que escribiste, para el conflicto. */
  tuyo?: ReactNode
  /** Acciones del conflicto (usar el actual, guardar el tuyo encima). */
  children?: ReactNode
}) {
  return (
    <div aria-live="polite" data-estado-guardado={estado.tipo}>
      {estado.tipo === 'guardando' ? <p className="small">Guardando…</p> : null}
      {estado.tipo === 'guardado' ? (
        <p className="alert alert-ok small" role="status">
          <strong>{estado.repetida ? 'Ya estaba guardado.' : 'Guardado.'}</strong>
          {estado.version !== null ? <> Versión {estado.version}.</> : null} Queda en AUDITORIA.
        </p>
      ) : null}
      {estado.tipo === 'guardado' && estado.aviso ? <p className="alert alert-warn small" role="status">{estado.aviso}</p> : null}
      {estado.tipo === 'conflicto' ? (
        <div className="alert alert-danger small" role="alert">
          <p>
            <strong>Conflicto de versión: no se guardó.</strong> Otra sesión cambió {registro}
            {estado.versionActual !== null ? <> (ahora va en la versión {estado.versionActual})</> : null}.
          </p>
          {actual !== undefined ? <p>Valor actual: {actual}</p> : null}
          {tuyo !== undefined ? <p>Tu cambio: {tuyo}</p> : null}
          {children}
        </div>
      ) : null}
      {estado.tipo === 'error' ? (
        <p className="alert alert-danger small" role="alert">
          <strong>No se guardó.</strong> {estado.mensaje} Lo que escribiste sigue en el formulario; puedes reintentar.
        </p>
      ) : null}
    </div>
  )
}
