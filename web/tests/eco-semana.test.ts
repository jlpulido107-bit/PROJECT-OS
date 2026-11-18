import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { createEcoLoader, type EcoResult } from '@/lib/radaros/data'
import { construirEco } from '@/lib/radaros/eco'
import { construirSemana, numeroCelda, SEMANA_TABS, semanasHastaMeta, type SemanaRaw } from '@/lib/radaros/eco-semana'
import {
  CRITERIOS, PATRON_CODIGO, TEXTO_AVISO, TEXTO_ESTADO_PROBLEMA, TEXTO_ETAPA, TEXTO_FALLA, TEXTO_FALTA, TEXTO_MODO, TEXTO_VEREDICTO,
} from '@/lib/radaros/eco-semana-textos'
import { ETAPAS } from '@/lib/radaros/pipeline'

/** «ECO esta semana» (/eco/semana, ORD-POS-159): solo dobles de fetch, nunca red real ni escritura. */

const estado = vi.hoisted(() => ({ result: null as unknown }))
vi.mock('@/lib/page-data', () => ({ privateEco: async () => ({ user: { email: 'revisor@example.com' }, result: estado.result }) }))
const { default: EcoSemanaPage } = await import('@/app/(private)/eco/semana/page')

const raiz = path.join(__dirname, '..', 'src')
const src = (...p: string[]) => readFileSync(path.join(raiz, ...p), 'utf8')
const NOW = Date.UTC(2026, 10, 18, 15, 0, 0) // 2026-11-18 09:00 en Mérida

const K = (estados: Partial<Record<(typeof CRITERIOS)[number], string>>) => CRITERIOS.map((k) => estados[k] ?? 'OK')
const DICTAMEN_ENCABEZADO = ['ID', 'NOMBRE', 'ASIN', 'PRECIO_MXN', ...CRITERIOS.map((k) => `${k}_ESTADO`), 'K3_DETALLE', 'COSTO_MAX_MXN', 'MOQ_MAX', 'VEREDICTO', 'MOTIVO', 'SEMANA', 'ORIGEN']
const fila = (id: string, nombre: string, asin: string, precio: string, k: string[], k3: string, costo: string, moq: string, veredicto: string, semana: string, origen = 'SCORING') =>
  [id, nombre, asin, precio, ...k, k3, costo, moq, veredicto, 'K3 FALLA: texto técnico [fuente AMZ_NICHO]', semana, origen]

const RAW: SemanaRaw = {
  AMZ_DICTAMEN: [
    DICTAMEN_ENCABEZADO,
    // Semana anterior: nunca debe salir (criterio 3).
    fila('EC-001', 'Idea vieja', 'B000000001', '500', K({}), '', '100', '10', 'LISTO_PARA_RFQ', '2026-W46'),
    fila('EC-004', 'Servidor de café de 600 ml', 'B0D9PQ9GGH', '$832.00', K({ K1: 'AVISO' }), '3 del top 10 con < 100 reseñas [AMZ_NICHO_TOP]', '259.4', '88', 'LISTO_PARA_RFQ', '2026-W47'),
    fila('EC-007', 'Kit de pulseras foliadas', '', '', K({ K2: 'SIN_DATO', K3: 'SIN_DATO', K5: 'SIN_DATO' }), '', '', '', 'INVESTIGAR', '2026-W47'),
    fila('EC-008', 'Bolsa de gimnasio', 'B000000008', '300', K({ K3: 'FALLA', K6: 'FALLA' }), '', '90', '', 'KILL', '2026-W47'),
    fila('B0DESCUBR1', 'Candidato del buscador', 'B0DESCUBR1', '400', K({}), '', '120', '', 'LISTO_PARA_RFQ', '2026-W47', 'DESCUBRIR'),
  ],
  AMZ_CANDIDATOS: [
    ['ASIN', 'TITULO', 'CATEGORIA', 'MARCA', 'PRECIO_MXN', 'BSR_AVG90', 'VENTAS_MES', 'CV_BSR90', 'PUNTAJE', 'COSTO_MAX_MXN', 'MOQ_MAX', 'K3_ESTADO', 'VEREDICTO', 'MOTIVO', 'SEMANA_DATO', 'SEMANA', 'DECISION_HUMANA'],
    ['B0GUANTES1', 'Guantes de trabajo', 'x', 'Genérica', '419', '', '', '', '70', '149', '', 'SIN_DATO', 'INVESTIGAR', 'm', '2026-W47', '2026-W47', ''],
    ['B0BLOCPLA1', 'Bloc planificador', 'x', '', '787', '', '', '', '90', '281', '', 'SIN_DATO', 'INVESTIGAR', 'm', '2026-W47', '2026-W47', ''],
    ['B0DEWALT01', 'Taladro de marca', 'x', ' dewalt ', '900', '', '', '', '99', '300', '', 'SIN_DATO', 'INVESTIGAR', 'm', '2026-W47', '2026-W47', ''],
    ['B0KILLED01', 'Descartado', 'x', '', '100', '', '', '', '95', '10', '', 'FALLA', 'KILL', 'm', '2026-W47', '2026-W47', ''],
    ['B0FUERA001', 'Fuera de lista', 'x', '', '100', '', '', '', '95', '10', '', 'OK', 'FUERA_DE_LISTA', 'm', '2026-W46', '2026-W46', 'sí'],
    ['B0DECIDID1', 'Ya decidido', 'x', '', '100', '', '', '', '95', '10', '', 'OK', 'INVESTIGAR', 'm', '2026-W47', '2026-W47', 'no me interesa'],
  ],
  CFG_MARCAS: [['MARCA'], ['DEWALT'], ['Beaphar']],
  AMZ_AVISOS: [
    ['SEMANA', 'TIPO', 'SEVERIDAD', 'ID', 'MENSAJE', 'ACCION'],
    ['2026-W47', 'FALTA_ASIN', 'BAJA', 'EC-007', '1 producto(s) sin ASIN de referencia', 'escribir el ASIN de la idea en AMZ_IDEA_ASIN'],
    ['2026-W47', 'LISTO', 'ALTA', 'EC-004', 'EC-004: pasa a LISTO_PARA_RFQ', 'pedir cotización (RFQ)'],
    ['2026-W46', 'FALTA_COSTO', 'BAJA', 'EC-001', 'viejo', 'viejo'],
  ],
  AMZ_BITACORA: [
    ['FECHA_HORA', 'MODO', 'SEMANA', 'ESTADO', 'TOKENS', 'TOKENS_RESTANTES', 'DETALLE', 'MENSAJE'],
    ['2026-11-18 07:05', 'EVALUAR', '2026-W47', 'OK', '10', '900', '', ''],
    ['2026-11-18 08:05', 'BARRIDO', '2026-W47', 'OK', '50', '1,250', 'evaluados=30', ''],
  ],
}
const PIPE = [
  ['PRODUCTO_ID', 'NOMBRE', 'IDEA_ID', 'ETAPA', 'ETAPA_DESDE', 'FASE', 'SIGUIENTE_PASO'],
  ['PRD-0003', 'Soporte de vinilo', 'EC-006', 'COTIZANDO', '2026-11-06', '4 · Cotizando, sin margen', 'Renegocia el costo o descarta'],
  ['PRD-0004', 'Sin fórmula', 'EC-009', 'MUESTRA', '2026-11-06', '#N/A', ''],
  ['PRD-0005', 'Ya descartado', 'EC-010', 'DESCARTADO', '2026-11-06', '✖ Descartado', 'Nada'],
]

function ok(raw: SemanaRaw = RAW, pipe: unknown[][] | undefined = PIPE, now = NOW) {
  return construirSemana(raw, pipe, now)
}
const datos = <T,>(b: { estado: string; datos?: T }): T => {
  if (b.estado !== 'ok') throw new Error(`bloque ${b.estado}`)
  return b.datos as T
}

async function html(result: EcoResult) {
  estado.result = result
  return renderToStaticMarkup(await EcoSemanaPage())
}
const pagina = (raw: SemanaRaw = RAW, now = NOW) => html({ estado: 'ok', vista: construirEco({ ...raw, PIPE_PRODUCTOS: PIPE }, now), fetchedAt: now })
/** Lo que ve el propietario: sin etiquetas y sin los ID en gris pequeño (`eco-id`). */
const visible = (h: string) => h.replace(/<span class="eco-id small muted">[^<]*<\/span>/g, '').replace(/<[^>]+>/g, ' ')

describe('criterio 1: no escribe nada', () => {
  const archivos = ['lib/radaros/eco-semana.ts', 'lib/radaros/eco-semana-textos.ts', 'app/(private)/eco/semana/page.tsx']

  it('la vista no tiene rutas: ni route.ts ni API propia, solo page.tsx', () => {
    expect(readdirSync(path.join(raiz, 'app', '(private)', 'eco', 'semana'))).toEqual(['page.tsx'])
    expect(existsSync(path.join(raiz, 'app', 'api', 'eco', 'semana'))).toBe(false)
  })

  it('su código no nombra métodos de escritura, la API de escritura de hojas ni los módulos de escritura', () => {
    for (const a of archivos) {
      const s = src(a)
      expect(s, a).not.toMatch(/['"`](POST|PUT|PATCH|DELETE)['"`]|values:append|batchUpdate|values:clear|method\s*:|\bfetch\(|from '[^']*(escritura|write|operations|actions)[^']*'|'use server'|<form|<button|<input/i)
    }
  })

  it('no lee PIPE_PROVEEDORES ni PIPE_AUDITORIA', () => {
    expect([...SEMANA_TABS]).toEqual(['AMZ_DICTAMEN', 'AMZ_CANDIDATOS', 'AMZ_AVISOS', 'AMZ_BITACORA', 'CFG_MARCAS'])
    expect(src('lib/radaros/eco-semana.ts')).not.toMatch(/PIPE_PROVEEDORES['"]|PIPE_AUDITORIA['"]/)
  })

  function fakeSheets(tabs: Record<string, unknown[][]>, falla?: string) {
    const methods: string[] = []
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      methods.push(init?.method ?? 'GET')
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
      if (!url.pathname.endsWith('values:batchGet')) return json({ sheets: Object.keys(tabs).map((title) => ({ properties: { title } })) })
      const ranges = url.searchParams.getAll('ranges').map((r) => /^'(.+)'!/.exec(r)![1]!)
      if (falla && ranges.includes(falla)) return json({}, 403)
      return json({ valueRanges: ranges.map((t) => ({ values: tabs[t] })) })
    }) as unknown as typeof fetch
    const l = createEcoLoader({
      env: { SHEETS_SPREADSHEET_ID: 'HOJA_PROPIA_SINTETICA_0123456789abcdef', RADAROS_SHEET_ID: 'LIBRO_RADAROS_SINTETICO_0123456789' } as unknown as NodeJS.ProcessEnv,
      getAccessToken: async () => 'ya29.token-de-prueba-no-real', fetchImpl, sleep: async () => {}, now: () => NOW, generacion: () => 0,
    })
    return { methods, load: l.load }
  }

  it('el lector solo hace GET, también al leer las pestañas de la semana', async () => {
    const { methods, load } = fakeSheets({ ...RAW, PIPE_PRODUCTOS: PIPE } as Record<string, unknown[][]>)
    const r = await load()
    if (r.estado !== 'ok') throw new Error('no ok')
    expect(datos(r.vista.semana.dictamen).semana).toBe('2026-W47')
    expect(methods.length).toBeGreaterThan(0)
    expect(new Set(methods)).toEqual(new Set(['GET']))
  })

  it('inerte si falla la lectura: mensaje claro con aria-live, sin datos y sin lanzar', async () => {
    const r = await fakeSheets({ ...RAW, PIPE_PRODUCTOS: PIPE } as Record<string, unknown[][]>, 'AMZ_DICTAMEN').load()
    expect(r.estado).toBe('error')
    const h = await html(r)
    expect(h).toContain('No se pudieron leer los datos de la semana')
    expect(h).toContain('role="alert" aria-live="assertive"')
    expect(h).not.toContain('Pasaron el filtro')
  })

  it('pestañas de la semana ausentes o rotas no rompen /eco: cada bloque dice su estado', async () => {
    const r = await fakeSheets({ PIPE_PRODUCTOS: PIPE, AMZ_DICTAMEN: [['OTRA']], AMZ_CANDIDATOS: [[]] }).load()
    if (r.estado !== 'ok') throw new Error('no ok')
    expect(r.vista.pipeline.productos.estado).toBe('ok')
    expect(r.vista.semana.dictamen.estado).toBe('columnas-faltantes')
    const texto = visible(await html(r))
    expect(texto).toContain('A El resultado de la semana le faltan columnas en el libro de RADAROS')
    expect(texto).toContain('Buscador detenido o sin confirmar')
    expect(texto).not.toMatch(PATRON_CODIGO)
  })
})

describe('criterio 2: sin códigos visibles, una sola tabla de textos', () => {
  it('la tabla traduce todos los códigos conocidos de RADAROS', () => {
    for (const v of ['LISTO_PARA_RFQ', 'INVESTIGAR', 'KILL', 'FUERA_DE_LISTA']) expect(TEXTO_VEREDICTO[v]).toBeTruthy()
    for (const k of CRITERIOS) expect(TEXTO_FALLA[k] && TEXTO_FALTA[k]).toBeTruthy()
    for (const t of ['CORRIDA', 'SIN_CORRIDA', 'LISTO', 'CAMBIO', 'FALTA_PALABRA_CLAVE', 'FALTA_COSTO', 'FALTA_ASIN']) expect(TEXTO_AVISO[t]).toBeTruthy()
    for (const e of ETAPAS.filter((x) => x !== 'DESCARTADO')) expect(TEXTO_ETAPA[e]).toBeTruthy()
    for (const m of ['EVALUAR', 'DESCUBRIR', 'NICHO', 'DICTAMEN', 'BARRIDO', 'NICHOS']) expect(TEXTO_MODO[m]).toBeTruthy()
    for (const e of ['ERROR', 'PARCIAL', 'NEEDS_REAUTH']) expect(TEXTO_ESTADO_PROBLEMA[e]).toBeTruthy()
  })

  it('ningún texto de la tabla contiene un código', () => {
    const textos = [TEXTO_VEREDICTO, TEXTO_FALLA, TEXTO_FALTA, TEXTO_MODO, TEXTO_ESTADO_PROBLEMA].flatMap((t) => Object.values(t))
      .concat(Object.values(TEXTO_AVISO).flatMap((a) => [a.que, a.hacer]), Object.values(TEXTO_ETAPA).flatMap((e) => [e.fase, e.siguiente]))
    for (const t of textos) expect(t).not.toMatch(PATRON_CODIGO)
  })

  it('los códigos solo se traducen en eco-semana-textos.ts: la página no los nombra', () => {
    expect(src('app/(private)/eco/semana/page.tsx')).not.toMatch(PATRON_CODIGO)
  })

  it('la página no pinta códigos: ni veredictos, ni K1–K6, ni MOTIVO/MENSAJE/ACCION de la hoja; los ID solo en gris pequeño', async () => {
    const h = await pagina()
    const texto = visible(h)
    expect(texto).not.toMatch(PATRON_CODIGO)
    expect(texto).not.toMatch(/\b(EC|PRD|COT)-\d+|B0[A-Z0-9]{8}/)
    expect(texto).not.toContain('texto técnico')
    expect(texto).not.toContain('pedir cotización (RFQ)')
    expect(h).toContain('<span class="eco-id small muted">EC-004 · B0D9PQ9GGH</span>')
    expect(h).toContain('<span class="eco-id small muted">PRD-0003 · EC-006</span>')
    for (const t of ['Servidor de café de 600 ml', 'Puedes pagar hasta', 'Categoría que no vendemos', 'Falta el enlace de Amazon de un producto parecido']) expect(texto).toContain(t)
  })

  it('un código desconocido sale con texto genérico, nunca tal cual', async () => {
    const raw: SemanaRaw = {
      ...RAW,
      AMZ_AVISOS: [['SEMANA', 'TIPO', 'SEVERIDAD', 'ID'], ['2026-W47', 'TIPO_NUEVO', 'ALTA', '']],
      AMZ_BITACORA: [['FECHA_HORA', 'MODO', 'ESTADO'], ['2026-11-18 08:30', 'MODO_NUEVO', 'ERROR']],
    }
    const h = await html({ estado: 'ok', vista: construirEco({ ...raw, PIPE_PRODUCTOS: [PIPE[0]!, ['PRD-0009', 'Rara', '', 'ETAPA_RARA', '', '', '']] }, NOW), fetchedAt: NOW })
    const texto = visible(h)
    expect(texto).not.toMatch(PATRON_CODIGO)
    for (const t of ['Hay un aviso del sistema', 'una tarea del buscador terminó con un error', 'En proceso']) expect(texto).toContain(t)
  })
})

describe('criterio 3: solo la semana más reciente del dictamen', () => {
  it('pasaron, falta medir y descartados salen de 2026-W47; la idea de W46 no aparece', () => {
    const d = datos(ok().dictamen)
    expect(d.semana).toBe('2026-W47')
    expect(d.pasaron.map((p) => p.id)).toEqual(['EC-004'])
    expect(d.porMedir.map((p) => p.id)).toEqual(['EC-007'])
    expect(d.descartados.map((p) => p.id)).toEqual(['EC-008'])
    expect(ok().pendientes.map((p) => p.ids)).toEqual(['EC-007'])
  })

  it('ganancia por pieza = 25 % del precio; «puedes pagar hasta» = COSTO_MAX_MXN tal cual, sin recalcular', () => {
    const [p] = datos(ok().dictamen).pasaron
    expect(p).toMatchObject({ precio: 832, costoMax: 259.4, ganancia: 208, moqMax: 88 })
    expect(p!.espacio).toBe('Sí · 3 de los 10 más vendidos tienen pocas reseñas')
    expect(p!.aviso).toContain('Margen muy justo')
  })

  it('falta medir: K5 no repite el costo de K2 y la falta de enlace va primero; descartado: sus motivos en palabras', () => {
    const d = datos(ok().dictamen)
    expect(d.porMedir[0]!.faltas).toEqual([
      'Falta el enlace de Amazon de un producto parecido', TEXTO_FALTA.K2, TEXTO_FALTA.K3,
    ])
    expect(d.descartados[0]!.motivos).toEqual([TEXTO_FALLA.K3, TEXTO_FALLA.K6])
  })

  it('frase de la semana y semanas a la meta', () => {
    expect(ok().frase).toBe('Esta semana 1 producto pasó el filtro. 1 idea espera un dato para poder medirse.')
    expect(ok({}).frase).toBe('Todavía no hay resultado de esta semana.')
    expect(semanasHastaMeta(NOW)).toBe(11)
    expect(semanasHastaMeta(Date.UTC(2027, 5, 1))).toBe(0)
  })

  it('numeroCelda: formato de hoja sí; vacío o texto, null (nunca 0)', () => {
    expect([numeroCelda('$1,473.50'), numeroCelda('832 MXN'), numeroCelda('-3'), numeroCelda(''), numeroCelda(null), numeroCelda('n/d')])
      .toEqual([1473.5, 832, -3, null, null, null])
  })

  it('en proceso: FASE y SIGUIENTE_PASO de la hoja; sin ellas o con error de fórmula, el texto de la etapa; sin descartados', () => {
    expect(datos(ok().proceso)).toEqual([
      { id: 'PRD-0003', nombre: 'Soporte de vinilo', ideaId: 'EC-006', fase: '4 · Cotizando, sin margen', siguiente: 'Renegocia el costo o descarta' },
      { id: 'PRD-0004', nombre: 'Sin fórmula', ideaId: 'EC-009', ...TEXTO_ETAPA.MUESTRA },
    ])
    const sinColumnas = PIPE.map((f) => f.slice(0, 5))
    expect(datos(ok(RAW, sinColumnas).proceso)[0]).toMatchObject(TEXTO_ETAPA.COTIZANDO!)
  })
})

describe('criterio 4: marcas de CFG_MARCAS', () => {
  it('con la lista: quita las marcas (sin distinguir mayúsculas ni espacios), los descartados, los que salieron y los ya decididos; ordena por puntaje', () => {
    const b = datos(ok().buscador)
    expect(b.hallazgos.map((h) => h.asin)).toEqual(['B0BLOCPLA1', 'B0GUANTES1'])
    expect(b.marcas).toEqual({ estado: 'ok', total: 2, quitados: 1, ejemplos: ['DEWALT'] })
  })

  it('sin la pestaña: el top sin filtrar, y la página lo avisa', async () => {
    const sinMarcas: SemanaRaw = { ...RAW, CFG_MARCAS: undefined }
    const b = datos(ok(sinMarcas).buscador)
    expect(b.hallazgos.map((h) => h.asin)).toEqual(['B0DEWALT01', 'B0BLOCPLA1', 'B0GUANTES1'])
    expect(b.marcas).toEqual({ estado: 'sin-lista' })
    expect(visible(await pagina(sinMarcas))).toContain('La lista de marcas conocidas todavía no existe en el libro: se muestran los mejores sin filtrar')
    expect(visible(await pagina())).toContain('Se excluyen las 2 marcas conocidas de tu lista. Por eso se quitó 1 candidato (DEWALT).')
  })
})

describe('criterio 5: salud del buscador', () => {
  const HORA = 3_600_000
  const ultima = Date.UTC(2026, 10, 18, 14, 5) // 08:05 en Mérida

  it('con una corrida en las últimas 3 horas: en orden, con sus créditos', () => {
    const s = ok().salud
    expect(s.tono).toBe('ok')
    expect(s.frases[0]).toContain('El buscador está corriendo')
    expect(s.frases).toContain('Te quedan 1,250 créditos de Keepa.')
    expect(ok(RAW, PIPE, ultima + 3 * HORA).salud.tono).toBe('ok')
  })

  it('sin corrida en las últimas 3 horas: rojo, y lo dice con palabras', async () => {
    const tarde = ultima + 3 * HORA + 60_000
    const s = ok(RAW, PIPE, tarde).salud
    expect(s.tono).toBe('danger')
    expect(s.frases[0]).toMatch(/^El buscador no ha corrido en las últimas 3 horas: su última corrida fue el .+, hace 3 horas\.$/)
    const h = await pagina(RAW, tarde)
    expect(h).toContain('semana-salud-danger')
    expect(visible(h)).toContain('Buscador detenido o sin confirmar')
  })

  it('sin bitácora, vacía, sin fechas legibles o truncada: rojo (no se puede confirmar)', () => {
    const con = (b: unknown[][] | undefined) => ok({ ...RAW, AMZ_BITACORA: b }).salud
    expect(con(undefined)).toMatchObject({ tono: 'danger' })
    expect(con([['FECHA_HORA', 'MODO']]).frases[0]).toBe('El buscador todavía no ha corrido.')
    expect(con([['FECHA_HORA'], ['ayer']]).tono).toBe('danger')
    expect(con([['MODO'], ['BARRIDO']]).tono).toBe('danger')
    const larga = [['FECHA_HORA'], ...Array.from({ length: 5001 }, () => ['2026-11-18 08:05'])]
    expect(con(larga).frases[0]).toContain('demasiado largo')
  })

  it('una corrida reciente con problema o un aviso de corrida: aviso, en palabras', () => {
    const s = ok({ ...RAW, AMZ_BITACORA: [['FECHA_HORA', 'MODO', 'ESTADO'], ['2026-11-18 08:30', 'EVALUAR', 'NEEDS_REAUTH']] }).salud
    expect(s.tono).toBe('warn')
    expect(s.frases[1]).toBe('En esa corrida, la revisión de tus ideas necesita que vuelvas a autorizar la conexión con Amazon.')
    const a = ok({ ...RAW, AMZ_AVISOS: [['SEMANA', 'TIPO', 'SEVERIDAD', 'ID'], ['2026-W47', 'SIN_CORRIDA', 'MEDIA', 'EVALUAR']] })
    expect(a.salud.tono).toBe('warn')
    expect(a.salud.frases.at(-1)).toContain('no hay una revisión completa')
    expect(a.pendientes).toEqual([])
  })
})

describe('criterio 6: accesibilidad como W1', () => {
  const css = src('app', 'globals.css')

  it('aria-live para la carga, el estado de lectura, la salud y los errores', async () => {
    expect(src('app/(private)/loading.tsx')).toContain('role="status" aria-live="polite"')
    const h = await pagina()
    expect(h.match(/aria-live="polite"/g)!.length).toBeGreaterThanOrEqual(2)
    expect(await html({ estado: 'error', code: 'permission', message: 'Sin acceso.', reintentar: false, at: NOW })).toContain('role="alert" aria-live="assertive"')
    expect(await html({ estado: 'no-configurado', motivo: 'ausente' })).toContain('aria-live="polite"')
  })

  it('áreas táctiles de 44 px: lo único que se toca son enlaces y el plegado', async () => {
    expect(css).toMatch(/\.semana-enlace \{[^}]*min-height: 44px; min-width: 44px/)
    expect(css).toMatch(/\.semana-plegado > summary \{[^}]*min-height: 44px/)
    const h = await pagina()
    expect(h).not.toMatch(/<(button|input|select|textarea|form)\b/)
    for (const a of h.match(/<a [^>]*>/g) ?? []) expect(a).toContain('class="semana-enlace"')
    expect(h).toContain('<details class="section plegable-seccion semana-plegado">')
  })

  it('contraste ≥ 4.5:1 de cada par de colores que usa la página, en claro y en oscuro', () => {
    const [claro, oscuro] = css.split('@media (prefers-color-scheme: dark)') as [string, string]
    const tokens = (bloque: string) => Object.fromEntries([...bloque.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1]!, m[2]!]))
    const luz = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number]
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const contraste = (a: string, b: string) => (Math.max(luz(a), luz(b)) + 0.05) / (Math.min(luz(a), luz(b)) + 0.05)
    const pares = [
      ['text', 'bg'], ['text', 'surface'], ['muted', 'bg'], ['muted', 'surface'], ['accent', 'bg'], ['accent', 'surface'], ['accent', 'danger-bg'],
      ['ok-fg', 'ok-bg'], ['ok-fg', 'surface'], ['warn-fg', 'warn-bg'], ['danger-fg', 'danger-bg'], ['muted-fg', 'muted-bg'],
    ] as const
    for (const [nombre, t] of [['claro', tokens(claro.slice(0, 2000))], ['oscuro', tokens(oscuro.slice(0, 2000))]] as const) {
      for (const [fg, bg] of pares) expect(contraste(t[fg]!, t[bg]!), `${nombre}: ${fg} sobre ${bg}`).toBeGreaterThanOrEqual(4.5)
    }
  })
})
