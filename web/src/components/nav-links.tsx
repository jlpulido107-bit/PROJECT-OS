'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const LINKS = [
  { href: '/', label: 'Inicio' },
  { href: '/proyectos', label: 'Proyectos' },
  { href: '/tareas', label: 'Tareas' },
  { href: '/actividad', label: 'Actividad' },
  { href: '/capacidad', label: 'Capacidad y plan' },
]

export function NavLinks() {
  const pathname = usePathname()
  return (
    <ul className="nav-links">
      {LINKS.map(({ href, label }) => {
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
