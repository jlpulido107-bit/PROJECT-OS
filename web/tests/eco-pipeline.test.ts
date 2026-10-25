import { readFileSync } from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { EcoResult } from '@/lib/radaros/data'
import { createEcoLoader } from '@/lib/radaros/data'
import { construirEco } from '@/lib/radaros/eco'
import {
  alertaEmbarque, alertaEtapa, alertasCotizacion, asinValido, construirPipeline, enEtapa, filtrarTarjetas, paraLector,
  PIPE_TABS, type PipeRaw,
} from '@/lib/radaros/pipeline'

/** /eco/pipeline (ORD-POS-097, docs/diseno-eco-pipeline.md §2, §5.2 y §8): datos sintéticos y fechas fijas, sin red. */

const PROPIA = '16UXe7fm90fOTTVJhI_RZ8__I876u2buvjeLGr5cJ-Ic'
const RADAROS = 'LIBRO_RADAROS_SINTETICO_0123456789'
// Miércoles 2026-10-21 10:00 en Mérida (UTC-6): «hoy» = 2026-10-21.
const NOW = Date.UTC(2026, 9, 21, 16, 0, 0)
const CONTACTO_SINTETICO = 'chat-de-tienda-sintetico-000'

const PRODUCTOS = [
  ['PRODUCTO_ID', 'NOMBRE', 'ASIN', 'IDEA_ID', 'ORIGEN', 'ETAPA', 'ETAPA_DESDE', 'COSTO_MAX_MXN', 'K1', 'PROVEEDOR_ELEGIDO_ID', 'NOTAS', 'VERSION', 'COLUMNA_EXTRA'],
  ['PRD-0001', 'Termo sintético', 'B000000001', 'EC-004', 'MANUAL', 'SUGERIDO', '2026-10-01T09:00:00-06:00', '', 'alto', '', '', '1', 'ignorar'],
  ['PRD-0002', 'Vaso sintético', '0123456789', '', 'RADAR_KEEPA', 'COTIZANDO', '2026-10-20T09:00:00-06:00', '150', '', 'PRV-0001', '', '3', ''],
  ['PRD-0003', 'Lámpara sintética', 'b00000000x', '', 'MANUAL', 'EN_VENTA', '2026-01-01T09:00:00-06:00', '', '', 'PRV-0001', '', '5', ''],
  ['PRD-0004', 'Cesta sintética', 'B0123', '', 'MANUAL', 'MUESTRA', '2026-10-07T09:00:00-06:00', '', '', '', '', '2', ''],
  ['PRD-0005', 'Rara', '', '', 'MANUAL', 'PAUSADO', '2026-10-20T09:00:00-06:00', '', '', '', '', '1', ''],
  ['', 'Sin ID', '', '', '', 'SUGERIDO', '', '', '', '', '', '', ''],
]
const PROVEEDORES = [
  ['PROVEEDOR_ID', 'NOMBRE', 'CANAL', 'PAIS', 'CONTACTO', 'ESTADO'],
  ['PRV-0001', 'Proveedor sintético', 'ALIBABA', 'CN', CONTACTO_SINTETICO, 'ACTIVO'],
  ['PRV-0002', 'Otro sintético', 'NACIONAL', 'MX', 'otro-contacto-sintetico', 'INACTIVO'],
]
const COTIZACIONES = [
  ['COTIZACION_ID', 'PRODUCTO_ID', 'PROVEEDOR_ID', 'ESTADO', 'FECHA_RESPUESTA_ESPERADA', 'MUESTRA_ESTADO', 'MUESTRA_FECHA_ESPERADA'],
  ['COT-0001', 'PRD-0002', 'PRV-0001', 'SOLICITADA', '2026-10-20', 'NO_PEDIDA', ''],
  ['COT-0002', 'PRD-0002', 'PRV-0001', 'SOLICITADA', '2026-10-21', 'PEDIDA', '2026-10-21'],
  ['COT-0003', 'PRD-0004', 'PRV-0001', 'RECIBIDA', '2026-10-01', 'PEDIDA', '2026-10-19'],
]
const EMBARQUES = [
  ['EMBARQUE_ID', 'PRODUCTO_ID', 'COTIZACION_ID', 'ESTADO', 'FECHA_LLEGADA_ESPERADA'],
  ['EMB-0001', 'PRD-0003', 'COT-0009', 'EN_TRANSITO', '2026-10-15'],
  ['EMB-0002', 'PRD-0003', 'COT-0009', 'RECIBIDO_FBA', '2026-10-01'],
]
const AUDITORIA = [
  ['AUDIT_ID', 'FECHA_HORA', 'ACTOR', 'ENTIDAD', 'REGISTRO_ID', 'CAMPO', 'VALOR_ANTES', 'VALOR_DESPUES', 'ORIGEN'],
  ['A-1', '2026-10-20T09:00:00-06:00', 'actor@example.com', 'PRODUCTO', 'PRD-0002', 'ETAPA', 'EVALUANDO', 'COTIZANDO', 'dashboard-eco'],
  ['A-2', '2026-10-20T09:05:00-06:00', 'actor@example.com', 'PROVEEDOR', 'PRV-0001', 'CONTACTO', 'antes-sintetico', CONTACTO_SINTETICO, 'dashboard-eco'],
]
const PARAMETROS = [['CLAVE', 'VALOR'], ['DIAS_ALERTA_ETAPA', '14'], ['K1_NOMBRE', 'Demanda sintética']]

const TODO: PipeRaw = {
  PIPE_PRODUCTOS: PRODUCTOS, PIPE_PROVEEDORES: PROVEEDORES, PIPE_COTIZACIONES: COTIZACIONES, PIPE_EMBARQUES: EMBARQUES,
  PIPE_AUDITORIA: AUDITORIA, PIPE_PARAMETROS: PARAMETROS,
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function loader(tabs: Record<string, unknown[][]>) {
  const urls: string[] = []
  const methods: string[] = []
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    urls.push(url.toString())
    methods.push(init?.method ?? 'GET')
    if (url.pathname.endsWith('values:batchGet')) {
      const ranges = url.searchParams.getAll('ranges').map((r) => /^'(.+)'!/.exec(r)![1]!)
      return jsonResponse({ valueRanges: ranges.map((t) => ({ values: tabs[t] })) })
    }
    return jsonResponse({ sheets: Object.keys(tabs).map((title) => ({ properties: { title } })) })
  }) as unknown as typeof fetch
  const l = createEcoLoader({
    env: { SHEETS_SPREADSHEET_ID: PROPIA, RADAROS_SHEET_ID: RADAROS } as unknown as NodeJS.ProcessEnv,
    getAccessToken: async () => 'ya29.token-de-prueba-no-real', fetchImpl, sleep: async () => {}, now: () => NOW,
  })
  return { urls, methods, load: l.load }
}

describe('lector (criterio 1)', () => {
  it('pide las PIPE_* que existen en el mismo batchGet: 2 lecturas, solo GET', async () => {
    const l = loader({ SCORING: [['IDEA_ID']], PIPE_PRODUCTOS: PRODUCTOS, PIPE_PROVEEDORES: PROVEEDORES, OTRA: [['X']] })
    const r = await l.load()
    expect(r.estado).toBe('ok')
    expect(l.urls).toHaveLength(2)
    expect(new Set(l.methods)).toEqual(new Set(['GET']))
    const batch = new URL(l.urls.find((u) => u.includes('values:batchGet'))!)
    expect(batch.searchParams.getAll('ranges').map((x) => /^'(.+)'!/.exec(x)![1])).toEqual(['SCORING', 'PIPE_PRODUCTOS', 'PIPE_PROVEEDORES'])
    expect(r.estado === 'ok' && r.vista.pipeline.productos.estado).toBe('ok')
    expect(r.estado === 'ok' && r.vista.pipeline.cotizaciones.estado).toBe('ausente')
  })

  it('con todas las PIPE_* sigue en 2 lecturas', async () => {
    const l = loader(TODO as Record<string, unknown[][]>)
    await l.load()
    expect(l.urls).toHaveLength(2)
    expect(PIPE_TABS).toHaveLength(6)
  })
})

describe('estados vacíos de §8 (criterio 2)', () => {
  it('pestaña sin crear: cada bloque lo dice y la vista se construye igual', () => {
    const v = construirPipeline({}, NOW)
    for (const b of [v.productos, v.proveedores, v.cotizaciones, v.embarques, v.historial]) {
      expect(b.estado).toBe('ausente')
      expect(b.estado === 'ausente' && b.mensaje).toContain('pestaña sin crear')
    }
    expect(v.parametros.diasAlertaEtapa).toBe(14)
    expect(v.parametros.etiquetasK.K1).toBe('K1')
  })

  it('columna obligatoria ausente: ese bloque no da datos y los demás sí', () => {
    const v = construirPipeline({ ...TODO, PIPE_PRODUCTOS: [['PRODUCTO_ID', 'NOMBRE', 'ETAPA'], ['PRD-0001', 'x', 'SUGERIDO']] }, NOW)
    expect(v.productos).toMatchObject({ estado: 'columnas-faltantes', faltan: ['ETAPA_DESDE'] })
    expect(v.proveedores.estado).toBe('ok')
  })

  it('columnas por encabezado en cualquier orden; las no listadas se ignoran; filas sin ID se cuentan', () => {
    const reordenado = PRODUCTOS.map((f) => [...f].reverse())
    const v = construirPipeline({ ...TODO, PIPE_PRODUCTOS: reordenado }, NOW)
    expect(v.productos.estado === 'ok' && v.productos.datos.tarjetas.map((t) => t.id)).toEqual(['PRD-0001', 'PRD-0002', 'PRD-0003', 'PRD-0004', 'PRD-0005'])
    expect(v.productos.estado === 'ok' && v.productos.datos.sinId).toBe(1)
    expect(JSON.stringify(v)).not.toContain('ignorar')
  })

  it('tablero de 6 etapas y ETAPA no reconocida fuera del tablero', () => {
    const v = construirPipeline(TODO, NOW)
    if (v.productos.estado !== 'ok') throw new Error('sin productos')
    const t = v.productos.datos.tarjetas
    expect(enEtapa(t, 'SUGERIDO').map((x) => x.id)).toEqual(['PRD-0001'])
    expect(enEtapa(t, 'DESCARTADO')).toEqual([])
    expect(t.find((x) => x.id === 'PRD-0005')).toMatchObject({ etapa: null, etapaTexto: 'PAUSADO' })
    expect(t.find((x) => x.id === 'PRD-0002')!.proveedorElegido).toEqual({ id: 'PRV-0001', nombre: 'Proveedor sintético' })
  })

  it('historial: solo cambios de ETAPA, sin ACTOR ni otros campos', () => {
    const v = construirPipeline(TODO, NOW)
    expect(v.historial.estado === 'ok' && v.historial.datos.filas).toEqual([
      { FECHA_HORA: '2026-10-20T09:00:00-06:00', REGISTRO_ID: 'PRD-0002', CAMPO: 'ETAPA', VALOR_ANTES: 'EVALUANDO', VALOR_DESPUES: 'COTIZANDO' },
    ])
    const sinProveedores = JSON.stringify({ ...v, proveedores: null })
    expect(sinProveedores).not.toContain('actor@example.com')
    expect(sinProveedores).not.toContain(CONTACTO_SINTETICO)
  })
})

describe('alertas de §5.2 con fechas fijas (criterios 2 y 6)', () => {
  const HOY = '2026-10-21'

  it('cotización SOLICITADA vencida solo si la fecha esperada es anterior a hoy', () => {
    expect(alertasCotizacion({ COTIZACION_ID: 'C', ESTADO: 'SOLICITADA', FECHA_RESPUESTA_ESPERADA: '2026-10-20' }, HOY)).toHaveLength(1)
    expect(alertasCotizacion({ COTIZACION_ID: 'C', ESTADO: 'SOLICITADA', FECHA_RESPUESTA_ESPERADA: HOY }, HOY)).toEqual([])
    expect(alertasCotizacion({ COTIZACION_ID: 'C', ESTADO: 'RECIBIDA', FECHA_RESPUESTA_ESPERADA: '2026-10-01' }, HOY)).toEqual([])
    expect(alertasCotizacion({ COTIZACION_ID: 'C', ESTADO: 'SOLICITADA', FECHA_RESPUESTA_ESPERADA: null }, HOY)).toEqual([])
    expect(alertasCotizacion({ COTIZACION_ID: 'C', ESTADO: 'SOLICITADA', FECHA_RESPUESTA_ESPERADA: 'mañana' }, HOY)).toEqual([])
  })

  it('muestra PEDIDA vencida; RECIBIDA o NO_PEDIDA no', () => {
    expect(alertasCotizacion({ COTIZACION_ID: 'C', ESTADO: 'RECIBIDA', MUESTRA_ESTADO: 'PEDIDA', MUESTRA_FECHA_ESPERADA: '2026-10-19' }, HOY))
      .toEqual([{ tipo: 'muestra', ref: 'C', detalle: 'Muestra de C esperada el 2026-10-19.' }])
    expect(alertasCotizacion({ COTIZACION_ID: 'C', MUESTRA_ESTADO: 'PEDIDA', MUESTRA_FECHA_ESPERADA: HOY }, HOY)).toEqual([])
    expect(alertasCotizacion({ COTIZACION_ID: 'C', MUESTRA_ESTADO: 'RECIBIDA', MUESTRA_FECHA_ESPERADA: '2026-10-01' }, HOY)).toEqual([])
  })

  it('embarque PAGADO o EN_TRANSITO vencido; RECIBIDO_FBA, PLANEADO y CANCELADO no', () => {
    for (const estado of ['PAGADO', 'EN_TRANSITO']) {
      expect(alertaEmbarque({ EMBARQUE_ID: 'E', ESTADO: estado, FECHA_LLEGADA_ESPERADA: '2026-10-20' }, HOY)?.tipo).toBe('embarque')
    }
    for (const estado of ['RECIBIDO_FBA', 'PLANEADO', 'CANCELADO']) {
      expect(alertaEmbarque({ EMBARQUE_ID: 'E', ESTADO: estado, FECHA_LLEGADA_ESPERADA: '2026-10-01' }, HOY)).toBeNull()
    }
    expect(alertaEmbarque({ EMBARQUE_ID: 'E', ESTADO: 'PAGADO', FECHA_LLEGADA_ESPERADA: HOY }, HOY)).toBeNull()
  })

  it('etapa: más de DIAS_ALERTA_ETAPA días, salvo EN_VENTA y DESCARTADO', () => {
    expect(alertaEtapa('P', 'SUGERIDO', 15, 14)?.tipo).toBe('etapa')
    expect(alertaEtapa('P', 'SUGERIDO', 14, 14)).toBeNull()
    expect(alertaEtapa('P', 'EN_VENTA', 300, 14)).toBeNull()
    expect(alertaEtapa('P', 'DESCARTADO', 300, 14)).toBeNull()
    expect(alertaEtapa('P', 'MUESTRA', null, 14)).toBeNull()
  })

  it('en el tablero: cada tarjeta junta sus alertas y los días se cuentan en Mérida', () => {
    const v = construirPipeline(TODO, NOW)
    if (v.productos.estado !== 'ok') throw new Error('sin productos')
    const por = new Map(v.productos.datos.tarjetas.map((t) => [t.id, t]))
    expect(por.get('PRD-0001')!.dias).toBe(20)
    expect(por.get('PRD-0001')!.alertas.map((a) => a.tipo)).toEqual(['etapa'])
    expect(por.get('PRD-0002')!.dias).toBe(1)
    expect(por.get('PRD-0002')!.alertas.map((a) => a.ref)).toEqual(['COT-0001'])
    expect(por.get('PRD-0003')!.alertas.map((a) => a.ref)).toEqual(['EMB-0001'])
    // 14 días exactos en MUESTRA: sin alerta de etapa; la muestra sí venció.
    expect(por.get('PRD-0004')!.dias).toBe(14)
    expect(por.get('PRD-0004')!.alertas.map((a) => a.tipo)).toEqual(['muestra'])
    expect(filtrarTarjetas(v.productos.datos.tarjetas, { vencidas: true }).map((t) => t.id)).toEqual(['PRD-0001', 'PRD-0002', 'PRD-0003', 'PRD-0004'])
    expect(filtrarTarjetas(v.productos.datos.tarjetas, { proveedor: 'PRV-0001', origen: 'MANUAL' }).map((t) => t.id)).toEqual(['PRD-0003'])
  })

  it('DIAS_ALERTA_ETAPA de PIPE_PARAMETROS cambia el umbral; un valor no entero avisa y usa 14', () => {
    const v = construirPipeline({ ...TODO, PIPE_PARAMETROS: [['CLAVE', 'VALOR'], ['DIAS_ALERTA_ETAPA', '0']] }, NOW)
    expect(v.productos.estado === 'ok' && v.productos.datos.tarjetas.find((t) => t.id === 'PRD-0002')!.alertas.map((a) => a.tipo)).toContain('etapa')
    const malo = construirPipeline({ ...TODO, PIPE_PARAMETROS: [['CLAVE', 'VALOR'], ['DIAS_ALERTA_ETAPA', 'x']] }, NOW)
    expect(malo.parametros.diasAlertaEtapa).toBe(14)
    expect(malo.parametros.avisos[0]).toContain('no es un entero')
    expect(construirPipeline(TODO, NOW).parametros.etiquetasK.K1).toBe('Demanda sintética')
  })
})

describe('ASIN (criterio 5)', () => {
  it('10 caracteres [A-Z0-9], no solo B0…', () => {
    for (const a of ['B000000001', '0123456789', 'B0ABCDEFGH', 'X123456789']) expect(asinValido(a), a).toBe(true)
    for (const a of ['b00000000x', 'B0123', 'B0000000011', 'B00000000-', ' B000000001', '']) expect(asinValido(a), a).toBe(false)
    const v = construirPipeline(TODO, NOW)
    if (v.productos.estado !== 'ok') throw new Error('sin productos')
    expect(v.productos.datos.tarjetas.map((t) => t.asinValido)).toEqual([true, true, false, false, null])
  })
})

describe('CONTACTO (criterio 4)', () => {
  it('paraLector lo quita para quien no escribe y lo deja para el escritor', () => {
    const v = construirPipeline(TODO, NOW)
    expect(JSON.stringify(paraLector(v, false))).not.toContain(CONTACTO_SINTETICO)
    expect(JSON.stringify(paraLector(v, true))).toContain(CONTACTO_SINTETICO)
    // La vista en caché no se modifica.
    expect(JSON.stringify(v)).toContain(CONTACTO_SINTETICO)
  })
})

const estado = vi.hoisted(() => ({ result: null as unknown, escritor: false }))
vi.mock('@/lib/page-data', () => ({ privateEco: async () => ({ user: { email: 'lector@example.com' }, result: estado.result }) }))
vi.mock('@/components/operations/write-access', () => ({ writeAccess: () => ({ allowed: estado.escritor }) }))

const { default: PipelinePage } = await import('@/app/(private)/eco/pipeline/page')

async function html(result: EcoResult, search: Record<string, string> = {}, escritor = false) {
  estado.result = result
  estado.escritor = escritor
  return renderToStaticMarkup(await PipelinePage({ searchParams: Promise.resolve(search) }))
}

const ok = (raw: PipeRaw): EcoResult => ({ estado: 'ok', vista: construirEco(raw, NOW), fetchedAt: NOW })

describe('/eco/pipeline: render', () => {
  it('no configurado: aviso, sin tablero', async () => {
    const h = await html({ estado: 'no-configurado', motivo: 'ausente' })
    expect(h).toContain('RADAROS no está configurado en este despliegue.')
    expect(h).not.toContain('Tablero')
  })

  it('sin pestañas PIPE_*: estados «pestaña sin crear» en tablero y proveedores', async () => {
    const h = await html(ok({}))
    expect(h).toContain('PIPE_PRODUCTOS: pestaña sin crear')
    expect(h).toContain('PIPE_PROVEEDORES: pestaña sin crear')
  })

  it('columna obligatoria ausente', async () => {
    const h = await html(ok({ PIPE_PRODUCTOS: [['PRODUCTO_ID'], ['PRD-0001']] }))
    expect(h).toContain('columna obligatoria ausente (NOMBRE, ETAPA, ETAPA_DESDE)')
  })

  it('tablero de 6 columnas, alertas, ASIN no válido y sin controles de escritura', async () => {
    const h = await html(ok(TODO))
    for (const e of ['Sugerido', 'Evaluando', 'Cotizando', 'Muestra', 'En venta', 'Descartado']) expect(h).toContain(`aria-label="${e}"`)
    expect(h).toContain('Seguimiento vencido (1)')
    expect(h).toContain('ASIN no válido')
    expect(h).toContain('ETAPA</code> no reconocida')
    expect(h).not.toMatch(/draggable|method="post"|Mover a/i)
  })

  it('CONTACTO oculto para el lector, en la lista y en la ficha', async () => {
    const h = await html(ok(TODO), { proveedor: 'PRV-0001' }, false)
    expect(h).toContain('Ficha de proveedor')
    expect(h).not.toContain(CONTACTO_SINTETICO)
    expect(h).toContain('solo lo ve el escritor del dashboard')
  })

  it('CONTACTO visible para el escritor', async () => {
    const h = await html(ok(TODO), { proveedor: 'PRV-0001' }, true)
    expect(h).toContain(CONTACTO_SINTETICO)
  })

  it('ficha de producto con historial de etapas, etiqueta de K1 y texto escapado', async () => {
    const raw = { ...TODO, PIPE_PRODUCTOS: [...PRODUCTOS, ['PRD-0009', '<script>alert(1)</script>', '', '', 'MANUAL', 'SUGERIDO', '2026-10-21T08:00:00-06:00', '', '', '', '', '1', '']] }
    const h = await html(ok(raw), { producto: 'PRD-0002' })
    expect(h).toContain('Ficha de producto')
    expect(h).toContain('EVALUANDO')
    expect(h).toContain('Demanda sintética')
    expect(h).toContain('Cotización COT-0001 sin respuesta desde 2026-10-20.')
    expect(h).not.toContain('<script>alert(1)</script>')
    expect(await html(ok(TODO), { producto: 'PRD-9999' })).toContain('No hay un producto con ese ID.')
  })
})

describe('navegación (criterio 3)', () => {
  it('el enlace a /eco/pipeline solo aparece con showEco, que depende solo de RADAROS_SHEET_ID', () => {
    const nav = readFileSync(path.join(__dirname, '..', 'src', 'components', 'nav-links.tsx'), 'utf8')
    expect(nav).toMatch(/showEco \? \[\{ href: '\/eco\/pipeline'/)
    expect(nav.match(/'\/eco\/pipeline'/g)).toHaveLength(1)
    const layout = readFileSync(path.join(__dirname, '..', 'src', 'app', '(private)', 'layout.tsx'), 'utf8')
    expect(layout).toContain('showEco={radarosSheetId() !== null}')
    const page = readFileSync(path.join(__dirname, '..', 'src', 'app', '(private)', 'eco', 'pipeline', 'page.tsx'), 'utf8')
    expect(page).toContain("privateEco('/eco/pipeline')")
  })

  it('la vista del pipeline no hace red ni escribe', () => {
    const src = readFileSync(path.join(__dirname, '..', 'src', 'lib', 'radaros', 'pipeline.ts'), 'utf8')
    expect(src).not.toMatch(/fetch\(|https?:\/\/|operations|write-credentials/)
  })
})
