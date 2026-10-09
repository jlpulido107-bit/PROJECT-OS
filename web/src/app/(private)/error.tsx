'use client'

export default function PrivateError({ reset }: { error: Error; reset: () => void }) {
  // No se muestra el detalle del error: puede contener información interna.
  return (
    <div className="alert alert-danger" role="alert">
      <h2>Ocurrió un error al mostrar esta página</h2>
      <p>No se muestran datos parciales. Puedes reintentar; si persiste, revisa los registros del servidor.</p>
      <button type="button" className="button" onClick={() => reset()}>Reintentar</button>
    </div>
  )
}
