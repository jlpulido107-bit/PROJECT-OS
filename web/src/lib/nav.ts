// Menú del dashboard en 9 grupos con subpestañas (ORD-POS-126). Módulo puro: sin red, sin sesión, sin correo.
// Las rutas no cambian; solo se agrupan. RADAROS, Finanzas y Operaciones siguen condicionadas: arrancan apagadas y
// solo las enciende el layout con los booleanos de siempre (RADAROS_SHEET_ID, FINANZAS_SHEET_ID, sesión con escritura).

export type Enlace = { href: string; label: string }
export type Grupo = {
  id: string
  label: string
  /** Etiqueta corta para la barra inferior del celular. */
  corto: string
  items: Enlace[]
}
export type OpcionesMenu = { showEco?: boolean; showFinanzas?: boolean; showOperations?: boolean }

/** Grupos de la barra inferior del celular, en orden; el resto va en «Más». */
export const GRUPOS_BARRA = ['inicio', 'ordenes', 'tareas', 'planificacion'] as const

export function gruposMenu({ showEco = false, showFinanzas = false, showOperations = false }: OpcionesMenu = {}): Grupo[] {
  return [
    { id: 'inicio', label: 'Inicio', corto: 'Inicio', items: [{ href: '/', label: 'Inicio' }] },
    {
      id: 'ordenes', label: 'Órdenes', corto: 'Órdenes',
      items: [{ href: '/ordenes', label: 'Órdenes' }, { href: '/control', label: 'Control' }, { href: '/metricas', label: 'Métricas' }],
    },
    { id: 'tareas', label: 'Tareas', corto: 'Tareas', items: [{ href: '/tareas', label: 'Tareas' }] },
    {
      id: 'planificacion', label: 'Planificación', corto: 'Plan',
      items: [{ href: '/planificacion', label: 'Planificación' }, { href: '/capacidad', label: 'Capacidad y plan' }],
    },
    {
      id: 'proyectos', label: 'Proyectos', corto: 'Proyectos',
      items: [{ href: '/proyectos', label: 'Proyectos' }, { href: '/estado', label: 'Estado' }],
    },
    // /eco y /eco/pipeline solo con RADAROS_SHEET_ID (ORD-POS-067, ORD-POS-097); el layout pasa solo el booleano. ORD-POS-150:
    // Ideas y Compras (/eco/cotizaciones redirige a Compras).
    ...(showEco
      ? [{ id: 'radaros', label: 'RADAROS', corto: 'RADAROS', items: [{ href: '/eco', label: 'Ideas' }, { href: '/eco/pipeline', label: 'Compras' }] }]
      : []),
    // /finanzas solo con FINANZAS_SHEET_ID (ORD-POS-074).
    ...(showFinanzas ? [{ id: 'finanzas', label: 'Finanzas', corto: 'Finanzas', items: [{ href: '/finanzas', label: 'Finanzas' }] }] : []),
    // Agentes no es condicionado: Actividad nunca queda dentro de un grupo condicionado.
    {
      id: 'agentes', label: 'Agentes', corto: 'Agentes',
      items: [{ href: '/agentes', label: 'Agentes' }, { href: '/actividad', label: 'Actividad' }],
    },
    // /operaciones solo con sesión con escritura.
    ...(showOperations ? [{ id: 'operaciones', label: 'Operaciones', corto: 'Operaciones', items: [{ href: '/operaciones', label: 'Operaciones' }] }] : []),
  ]
}

function coincide(href: string, pathname: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`)
}

/** Grupo y subpestaña activos: gana el enlace más largo que coincide (en /eco/pipeline, Compras y no Ideas). */
export function rutaActiva(pathname: string, grupos: Grupo[]): { grupo: string | null; href: string | null } {
  let grupo: string | null = null
  let href: string | null = null
  for (const g of grupos) {
    for (const item of g.items) {
      if (coincide(item.href, pathname) && (href === null || item.href.length > href.length)) {
        grupo = g.id
        href = item.href
      }
    }
  }
  return { grupo, href }
}

/** Siguiente índice de foco dentro de la hoja «Más»: Tab y Mayús+Tab dan la vuelta sin salir de ella. */
export function focoAtrapado(actual: number, total: number, atras: boolean): number {
  if (total <= 0) return -1
  if (actual < 0 || actual >= total) return atras ? total - 1 : 0
  return atras ? (actual - 1 + total) % total : (actual + 1) % total
}

/** Destino del enlace de un grupo: su primera subpestaña (todo grupo tiene al menos una). */
export function entradaGrupo(g: Grupo): string {
  return g.items[0]?.href ?? '/'
}
