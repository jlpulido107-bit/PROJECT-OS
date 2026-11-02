'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { entradaGrupo, focoAtrapado, GRUPOS_BARRA, gruposMenu, rutaActiva, type Grupo } from '@/lib/nav'

// Menú en 9 grupos (ORD-POS-126): barra lateral en escritorio; en celular, barra inferior de 4 + «Más».
// Las condicionadas (RADAROS, Finanzas, Operaciones) arrancan apagadas: solo el layout las enciende con un booleano.
// Este componente no recibe ni muestra el correo; eso vive solo en el layout.
// ORD-POS-127: `borradores` es el número de órdenes BORRADOR que calcula el layout solo para el propietario; el grupo
// Órdenes lo muestra solo si es mayor que 0. null (sin dato) no muestra contador, nunca un 0.
export function NavLinks({ showOperations = false, showEco = false, showFinanzas = false, borradores = null }: {
  showOperations?: boolean; showEco?: boolean; showFinanzas?: boolean; borradores?: number | null
}) {
  const pathname = usePathname()
  const grupos = gruposMenu({ showEco, showFinanzas, showOperations })
  const activo = rutaActiva(pathname, grupos)
  const enBarra = (g: Grupo) => (GRUPOS_BARRA as readonly string[]).includes(g.id)
  const barra = GRUPOS_BARRA.map((id) => grupos.find((g) => g.id === id)).filter((g): g is Grupo => g !== undefined)
  const resto = grupos.filter((g) => !enBarra(g))
  const grupoActivo = grupos.find((g) => g.id === activo.grupo) ?? null
  const masActivo = grupoActivo !== null && !enBarra(grupoActivo)

  const [abierta, setAbierta] = useState(false)
  const hoja = useRef<HTMLDivElement>(null)
  const botonMas = useRef<HTMLButtonElement>(null)
  const cerrar = () => {
    setAbierta(false)
    botonMas.current?.focus()
  }

  // Al navegar se cierra la hoja (ajuste de estado durante el render, sin efecto); al abrirla, el foco entra en ella.
  const [ruta, setRuta] = useState(pathname)
  if (ruta !== pathname) {
    setRuta(pathname)
    setAbierta(false)
  }
  useEffect(() => {
    if (abierta) hoja.current?.querySelector<HTMLElement>('button, a[href]')?.focus()
  }, [abierta])

  const teclaHoja = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      cerrar()
      return
    }
    if (e.key !== 'Tab' || hoja.current === null) return
    const focos = Array.from(hoja.current.querySelectorAll<HTMLElement>('button, a[href]'))
    const siguiente = focoAtrapado(focos.indexOf(document.activeElement as HTMLElement), focos.length, e.shiftKey)
    if (siguiente < 0) return
    e.preventDefault()
    focos[siguiente]?.focus()
  }

  const contador = (g: Grupo) => (g.id === 'ordenes' && borradores !== null && borradores > 0
    ? <> <span className="badge badge-warn nav-contador" aria-label={`${borradores} ${borradores === 1 ? 'orden espera' : 'órdenes esperan'} tu aprobación`}>{borradores}</span></>
    : null)
  const actual = (href: string) => (href === activo.href ? 'page' as const : undefined)
  const grupoActual = (g: Grupo) => (g.id === activo.grupo ? 'page' as const : undefined)

  return (
    <>
      {/* Escritorio: barra lateral con los grupos; el activo despliega sus subpestañas. */}
      <ul className="nav-groups">
        {grupos.map((g) => (
          <li key={g.id}>
            <Link href={entradaGrupo(g)} aria-current={grupoActual(g)}>{g.label}{contador(g)}</Link>
            {g.id === activo.grupo && g.items.length > 1 ? (
              <ul className="nav-subs" aria-label={`Secciones de ${g.label}`}>
                {g.items.map((i) => (
                  <li key={i.href}><Link href={i.href} aria-current={actual(i.href)}>{i.label}</Link></li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>

      {/* Celular: subpestañas del grupo activo arriba del contenido. */}
      {grupoActivo !== null && grupoActivo.items.length > 1 ? (
        <ul className="nav-subtabs" aria-label={`Secciones de ${grupoActivo.label}`}>
          {grupoActivo.items.map((i) => (
            <li key={i.href}><Link href={i.href} aria-current={actual(i.href)}>{i.label}</Link></li>
          ))}
        </ul>
      ) : null}

      {/* Celular: barra inferior Inicio · Órdenes · Tareas · Plan · Más. */}
      <ul className="nav-bottom">
        {barra.map((g) => (
          <li key={g.id}><Link href={entradaGrupo(g)} aria-current={grupoActual(g)}>{g.corto}{contador(g)}</Link></li>
        ))}
        <li>
          <button
            ref={botonMas}
            type="button"
            className={masActivo ? 'nav-mas nav-mas-activo' : 'nav-mas'}
            aria-haspopup="dialog"
            aria-expanded={abierta}
            aria-controls="nav-hoja-mas"
            onClick={() => setAbierta(true)}
          >
            Más
          </button>
        </li>
      </ul>

      {abierta ? (
        <div className="nav-hoja-fondo" onClick={cerrar}>
          <div
            ref={hoja}
            id="nav-hoja-mas"
            className="nav-hoja"
            role="dialog"
            aria-modal="true"
            aria-labelledby="nav-hoja-titulo"
            onKeyDown={teclaHoja}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="nav-hoja-cabeza">
              <h2 id="nav-hoja-titulo">Más secciones</h2>
              <button type="button" className="button" onClick={cerrar}>Cerrar</button>
            </div>
            {resto.map((g) => (
              <section key={g.id} className="nav-hoja-grupo" aria-label={g.label}>
                <h3>{g.label}</h3>
                <ul>
                  {g.items.map((i) => (
                    <li key={i.href}><Link href={i.href} aria-current={actual(i.href)} onClick={() => setAbierta(false)}>{i.label}</Link></li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      ) : null}
    </>
  )
}
