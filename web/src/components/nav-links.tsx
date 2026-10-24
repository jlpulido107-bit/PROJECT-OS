'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const LINKS = [
  { href: '/', label: 'Inicio' },
  { href: '/estado', label: 'Estado' },
  { href: '/ordenes', label: 'Órdenes' },
  { href: '/metricas', label: 'Métricas' },
  { href: '/agentes', label: 'Agentes' },
  { href: '/control', label: 'Control' },
  { href: '/proyectos', label: 'Proyectos' },
  { href: '/tareas', label: 'Tareas' },
  { href: '/actividad', label: 'Actividad' },
  { href: '/capacidad', label: 'Capacidad y plan' },
  { href: '/planificacion', label: 'Planificación' },
]

export function NavLinks({ showOperations = false, showEco = false, showFinanzas = false }: {
  showOperations?: boolean; showEco?: boolean; showFinanzas?: boolean
}) {
  const pathname = usePathname()
  const links = [
    ...LINKS,
    // /eco solo aparece con RADAROS_SHEET_ID configurada (ORD-POS-067); el layout pasa solo el booleano.
    ...(showEco ? [{ href: '/eco', label: 'RADAROS' }] : []),
    // /finanzas solo aparece con FINANZAS_SHEET_ID configurada (ORD-POS-074); igual, solo el booleano.
    ...(showFinanzas ? [{ href: '/finanzas', label: 'Finanzas' }] : []),
    ...(showOperations ? [{ href: '/operaciones', label: 'Operaciones' }] : []),
  ]
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
