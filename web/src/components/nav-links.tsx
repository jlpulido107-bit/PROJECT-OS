'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const LINKS = [
  { href: '/', label: 'Inicio' },
  { href: '/proyectos', label: 'Proyectos' },
  { href: '/tareas', label: 'Tareas' },
  { href: '/actividad', label: 'Actividad' },
  { href: '/capacidad', label: 'Capacidad y plan' },
  { href: '/planificacion', label: 'Planificación' },
]

export function NavLinks({ showOperations = false }: { showOperations?: boolean }) {
  const pathname = usePathname()
  const links = showOperations ? [...LINKS, { href: '/operaciones', label: 'Operaciones' }] : LINKS
  return (
    <ul className="nav-links">
      {links.map(({ href, label }) => {
        const active = href === '/' ? pathname === '/' : pathname.startsWith(href)
        return (
          <li key={href}>
            <Link href={href} aria-current={active ? 'page' : undefined}>{label}</Link>
          </li>
        )
      })}
    </ul>
  )
}
