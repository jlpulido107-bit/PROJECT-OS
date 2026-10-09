import Link from 'next/link'

export default function NotFound() {
  return (
    <main className="container narrow">
      <h1>No encontrado</h1>
      <p>El recurso solicitado no existe o no está registrado en la hoja.</p>
      <p><Link href="/">Volver al inicio</Link></p>
    </main>
  )
}
