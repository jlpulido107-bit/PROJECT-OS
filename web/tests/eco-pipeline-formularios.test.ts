import { readFileSync } from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RateLimiter } from '@/lib/operations/rate-limit'
import type { EcoResult } from '@/lib/radaros/data'
import { construirEco } from '@/lib/radaros/eco'
import { COLUMNAS_COTIZACIONES, COLUMNAS_EMBARQUES, COLUMNAS_PRODUCTOS, COLUMNAS_PROVEEDORES } from '@/lib/radaros/pipeline'
import { ecoPipelineWrite } from '@/lib/radaros/pipeline-escritura-handler'
import { COLUMNAS_AUDITORIA, EcoPipelineWriteService, type EcoContext, type EcoResultado } from '@/lib/radaros/pipeline-escritura-service'
import { InMemoryEcoStore, type Celda } from '@/lib/radaros/pipeline-escritura-store'
import { CAMPOS, parseEco, parseIdRuta, type EcoCampoOperacion } from '@/lib/radaros/pipeline-escritura-validacion'
import { cuerpo, enviar, versionDeFila, type Resultado } from '@/lib/radaros/pipeline-formularios'

/**
 * Formularios de alta y edición del pipeline (ORD-POS-110). El envío pasa por el núcleo real de la ruta
 * (`ecoPipelineWrite`: guard, CSRF, validación y servicio) sobre un almacén en memoria: ninguna prueba toca Google.
 * Datos inventados.
 */

const ORIGIN = 'http://127.0.0.1:3000'
const DUENO = 'dueno@example.com'
const NOW = new Date(Date.UTC(2026, 9, 24, 18, 0, 0))
const ACTIVA: Record<string, string> = {
  NEXTAUTH_URL: ORIGIN,
  AUTH_ALLOWED_EMAILS: `lector@example.com, ${DUENO}`,
  SHEETS_SPREADSHEET_ID: '16UXe7fm90fOTTVJhI_RZ8__I876u2buvjeLGr5cJ-Ic',
  SHEETS_EXPECTED_SERVICE_ACCOUNT: 'project-os-dashboard-run@project-os-511102.iam.gserviceaccount.com',
  PROJECT_OS_WRITE_SERVICE_ACCOUNT: 'project-os-writer@project-os-511102.iam.gserviceaccount.com',
  RADAROS_SHEET_ID: 'LIBRO_RADAROS_SINTETICO_0123456789',
  ECO_PIPELINE_WRITE_MODE: 'sheets',
  ECO_PIPELINE_WRITE_SERVICE_ACCOUNT: 'project-os-eco@project-os-511102.iam.gserviceaccount.com',
  ECO_PIPELINE_WRITER_EMAIL: DUENO,
}

type Rec = Record<string, Celda>
const fila = (cols: readonly string[], r: Rec): Celda[] => cols.map((c) => r[c] ?? '')
const libro = () => ({
  PIPE_PRODUCTOS: [[...COLUMNAS_PRODUCTOS], fila(COLUMNAS_PRODUCTOS, { PRODUCTO_ID: 'PRD-0001', NOMBRE: 'Termo', ORIGEN: 'MANUAL', ETAPA: 'COTIZANDO', ETAPA_DESDE: '2026-10-01T09:00:00-06:00', COSTO_MAX_MXN: 150, VERSION: 2 })],
  PIPE_PROVEEDORES: [[...COLUMNAS_PROVEEDORES], fila(COLUMNAS_PROVEEDORES, { PROVEEDOR_ID: 'PRV-0001', NOMBRE: 'Fábrica', CANAL: 'ALIBABA', PAIS: 'CN', ESTADO: 'ACTIVO', VERSION: 1 })],
  PIPE_COTIZACIONES: [[...COLUMNAS_COTIZACIONES], fila(COLUMNAS_COTIZACIONES, {
    COTIZACION_ID: 'COT-0001', PRODUCTO_ID: 'PRD-0001', PROVEEDOR_ID: 'PRV-0001', ESTADO: 'ELEGIDA', MUESTRA_ESTADO: 'NO_PEDIDA',
    PRECIO_UNIT: 2.5, MONEDA: 'USD', MOQ: 500, PLAZO_PRODUCCION_DIAS: 20, INCOTERM: 'FOB', VERSION: 1,
  })],
  PIPE_EMBARQUES: [[...COLUMNAS_EMBARQUES]],
  PIPE_AUDITORIA: [[...COLUMNAS_AUDITORIA]],
  PIPE_PARAMETROS: [['CLAVE', 'VALOR']],
})

/** Rutas de `web/src/app/api/eco/pipeline/`, con las mismas operaciones que sus `route.ts`. */
const RUTAS: Record<string, { crear: EcoCampoOperacion; editar: EcoCampoOperacion; prefijo: 'PRD' | 'PRV' | 'COT' | 'EMB'; metodo: 'Producto' | 'Proveedor' | 'Cotizacion' | 'Embarque' }> = {
  productos: { crear: 'eco.producto.crear', editar: 'eco.producto.editar', prefijo: 'PRD', metodo: 'Producto' },
  proveedores: { crear: 'eco.proveedor.crear', editar: 'eco.proveedor.editar', prefijo: 'PRV', metodo: 'Proveedor' },
  cotizaciones: { crear: 'eco.cotizacion.crear', editar: 'eco.cotizacion.editar', prefijo: 'COT', metodo: 'Cotizacion' },
  embarques: { crear: 'eco.embarque.crear', editar: 'eco.embarque.editar', prefijo: 'EMB', metodo: 'Embarque' },
}

/** `fetch` del navegador hacia el núcleo real de la ruta; el navegador añade `origin`, el resto lo pone el formulario. */
function servidor() {
  const memoria = new InMemoryEcoStore(ACTIVA.RADAROS_SHEET_ID!, libro())
  const svc = new EcoPipelineWriteService(memoria, { clock: () => NOW, randomHex: () => 'abcd1234' })
  const llamadas: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = []
  const f = (async (url: string, init: RequestInit) => {
    llamadas.push({ url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> })
    const [, , , , entidad, id] = url.split('/')
    const r = RUTAS[entidad!]!
    const req = new Request(`${ORIGIN}${url}`, { ...init, headers: { ...(init.headers as Record<string, string>), origin: ORIGIN } })
    const run = (s: EcoPipelineWriteService, b: unknown, ctx: EcoContext): Promise<EcoResultado> => {
      const m = s as unknown as Record<string, (...a: unknown[]) => Promise<EcoResultado>>
      return id ? m[`editar${r.metodo}`]!.call(s, parseIdRuta(r.prefijo, id), parseEco(r.editar, b), ctx) : m[`crear${r.metodo}`]!.call(s, parseEco(r.crear, b), ctx)
    }
    const { status, body } = await ecoPipelineWrite(req, {
      sessionEmail: async () => DUENO, env: ACTIVA as unknown as NodeJS.ProcessEnv, limiter: new RateLimiter(10, 3_000), service: () => svc,
    }, 'prueba', run, id ? 200 : 201)
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  const registro = (tab: string, id: string): Record<string, string> => {
    const [header, ...rows] = memoria.snapshot()[tab]!
    const row = rows.find((x) => x[0] === id)
    return row ? Object.fromEntries(header!.map((h, i) => [String(h), String(row[i] ?? '')])) : {}
  }
  return { f, llamadas, registro }
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const nuevoId = () => crypto.randomUUID()

describe('criterios 1, 4 y 5: alta y edición de cada entidad por las rutas existentes', () => {
  const casos = [
    { ruta: 'productos', tab: 'PIPE_PRODUCTOS', alta: { nombre: 'Vaso térmico', asin: 'B000000009', keepaVentasMes: '120' }, cambio: { nombre: 'Vaso térmico 500 ml' } },
    { ruta: 'proveedores', tab: 'PIPE_PROVEEDORES', alta: { nombre: 'Taller', canal: '1688', pais: 'CN', contacto: '+52 999 000 0000' }, cambio: { estado: 'INACTIVO' } },
    { ruta: 'cotizaciones', tab: 'PIPE_COTIZACIONES', alta: { productoId: 'PRD-0001', proveedorId: 'PRV-0001', precioUnit: '0.125', moneda: 'USD' }, cambio: { moq: '300', notas: 'Pedir muestra' } },
    { ruta: 'embarques', tab: 'PIPE_EMBARQUES', alta: { productoId: 'PRD-0001', cotizacionId: 'COT-0001', unidades: '200' }, cambio: { estado: 'PAGADO', fechaPago: '2026-10-20' } },
  ] as const

  it.each(casos)('$ruta: alta (POST) y edición (PATCH con expectedVersion y solo lo que cambió)', async ({ ruta, tab, alta, cambio }) => {
    const s = servidor()
    const r = RUTAS[ruta]!
    const creado = await enviar(`/api/eco/pipeline/${ruta}`, 'POST', cuerpo(CAMPOS[r.crear], alta, nuevoId), s.f)
    expect(creado).toMatchObject({ tipo: 'ok', repetida: false })
    const id = (creado as Extract<Resultado, { tipo: 'ok' }>).id
    expect(id).toMatch(new RegExp(`^${r.prefijo}-\\d{4}$`))
    const hoja = s.registro(tab, id)
    expect(hoja.VERSION).toBe('1')

    // El formulario de edición se abre con la fila tal como la lee la vista y se envía con un campo cambiado.
    const valores = Object.fromEntries(CAMPOS[r.editar].map((c) => [c.clave, hoja[c.columna] ?? '']))
    const editado = await enviar(`/api/eco/pipeline/${ruta}/${id}`, 'PATCH', cuerpo(CAMPOS[r.editar], { ...valores, ...cambio }, nuevoId, { version: versionDeFila(hoja.VERSION)!, iniciales: hoja }), s.f)
    expect(editado).toMatchObject({ tipo: 'ok', id })
    expect(s.registro(tab, id).VERSION).toBe('2')

    const [post, patch] = s.llamadas
    expect(post!.init.method).toBe('POST')
    expect(patch!.init.method).toBe('PATCH')
    for (const { init, body } of s.llamadas) {
      expect((init.headers as Record<string, string>)['X-Project-OS-CSRF']).toBe('1')
      expect(body.requestId).toMatch(UUID_V4)
    }
    expect(post!.body.requestId).not.toBe(patch!.body.requestId)
    expect(post!.body).not.toHaveProperty('expectedVersion')
    expect(Object.keys(patch!.body).sort()).toEqual(['expectedVersion', 'requestId', ...Object.keys(cambio)].sort())
    expect(patch!.body.expectedVersion).toBe(1)
  })

  it('cada envío lleva un requestId nuevo; el alta omite los vacíos y la edición manda «» para vaciar', () => {
    const campos = CAMPOS['eco.producto.editar']
    const a = cuerpo(campos, { nombre: 'x' }, nuevoId)
    const b = cuerpo(campos, { nombre: 'x' }, nuevoId)
    expect(a.requestId).not.toBe(b.requestId)
    expect(cuerpo(CAMPOS['eco.producto.crear'], { nombre: ' x ', asin: '  ' }, () => 'id')).toEqual({ requestId: 'id', nombre: 'x' })
    const iniciales = { NOMBRE: 'x', NOTAS: 'algo', COSTO_MAX_MXN: '=fórmula' }
    expect(cuerpo(campos, { nombre: 'x', notas: '', costoMaxMxn: '=fórmula' }, () => 'id', { version: 4, iniciales })).toEqual({ requestId: 'id', expectedVersion: 4, notas: '' })
    expect(versionDeFila('3')).toBe(3)
    for (const malo of [null, '', '0', '1.5', 'x']) expect(versionDeFila(malo)).toBeNull()
  })
})

describe('criterio 3: errores del servidor visibles y nada guardado antes del ok', () => {
  it('400/422 de validación: el campo y el motivo; no se crea la fila', async () => {
    const s = servidor()
    const r = await enviar('/api/eco/pipeline/proveedores', 'POST', cuerpo(CAMPOS['eco.proveedor.crear'], { nombre: 'Taller', canal: 'ALIBABA', pais: 'china' }, nuevoId), s.f)
    expect(r).toEqual({ tipo: 'validacion', mensaje: 'Hay campos con errores.', campos: { pais: 'Código ISO 3166-1 alfa-2 en mayúsculas (p. ej. CN).' } })
    expect(s.registro('PIPE_PROVEEDORES', 'PRV-0002')).toEqual({})
    // 400: un campo que la operación no admite (ETAPA nunca se edita desde un formulario).
    const extra = await enviar('/api/eco/pipeline/productos', 'POST', { requestId: nuevoId(), nombre: 'x', etapa: 'EVALUANDO' }, s.f)
    expect(extra).toMatchObject({ tipo: 'validacion', campos: { etapa: 'Campo no admitido.' } })
    expect(s.registro('PIPE_PRODUCTOS', 'PRD-0002')).toEqual({})
  })

  it('409 con la versión actual y una sola llamada: sin reintento automático', async () => {
    const s = servidor()
    const r = await enviar('/api/eco/pipeline/productos/PRD-0001', 'PATCH', { requestId: nuevoId(), expectedVersion: 1, nombre: 'Otro' }, s.f)
    expect(r).toMatchObject({ tipo: 'conflicto', versionActual: 2 })
    expect(s.llamadas).toHaveLength(1)
    expect(s.registro('PIPE_PRODUCTOS', 'PRD-0001')).toMatchObject({ NOMBRE: 'Termo', VERSION: '2' })
  })

  it('sin conexión o sin JSON: error, nunca «guardado»', async () => {
    const caida = (async () => { throw new TypeError('red') }) as unknown as typeof fetch
    expect((await enviar('/x', 'POST', {}, caida)).tipo).toBe('error')
    const html = (async () => new Response('<html>', { status: 502 })) as unknown as typeof fetch
    expect(await enviar('/x', 'POST', {}, html)).toEqual({ tipo: 'error', mensaje: 'No se pudo guardar.' })
  })

  it('el componente solo muestra «Guardado» y refresca tras el ok; sin estado optimista ni dependencias nuevas', () => {
    const src = readFileSync(path.join(__dirname, '..', 'src', 'components', 'eco', 'formularios-pipeline.tsx'), 'utf8')
    expect([...src.matchAll(/^import .* from '([^']+)'$/gm)].map((m) => m[1]).sort()).toEqual(['@/lib/radaros/pipeline-formularios', 'next/navigation', 'react'])
    expect(src.match(/router\.refresh\(\)/g)).toHaveLength(1)
    expect(src).toMatch(/if \(r\.tipo === 'ok'\) \{\n\s+if \(!edicion\) form\.reset\(\)\n\s+router\.refresh\(\)/)
    expect(src).toContain("crypto.randomUUID()")
    expect(src).not.toMatch(/localStorage|sessionStorage|optimistic|setTimeout|setInterval/i)
  })
})

/* -------------------------------------- Criterio 2: render -------------------------------------- */

const estado = vi.hoisted(() => ({ result: null as unknown, email: 'lector@example.com' }))
vi.mock('@/lib/page-data', () => ({ privateEco: async () => ({ user: { email: estado.email }, result: estado.result }) }))
vi.mock('@/components/operations/write-access', () => ({ writeAccess: () => ({ allowed: false }) }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }))

describe('criterio 2: los formularios se pintan solo si ecoPipelineCanWrite(email)', () => {
  afterEach(() => vi.unstubAllEnvs())
  const result: EcoResult = { estado: 'ok', vista: construirEco(libro(), NOW.getTime()), fetchedAt: NOW.getTime() }

  async function pagina(email: string, vars: Record<string, string>, search: Record<string, string>) {
    for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v)
    estado.email = email
    estado.result = result
    const { default: PipelinePage } = await import('@/app/(private)/eco/pipeline/page')
    return renderToStaticMarkup(await PipelinePage({ searchParams: Promise.resolve(search) }))
  }

  const TITULOS = ['Nuevo producto', 'Nuevo proveedor', 'Editar producto', 'Editar cotización COT-0001', 'Nueva cotización', 'Nuevo embarque']

  it('el escritor con la escritura activa ve los formularios, solo con los campos editables de §3', async () => {
    const h = await pagina(DUENO, ACTIVA, { producto: 'PRD-0001' })
    for (const t of TITULOS) expect(h).toContain(`aria-label="${t}"`)
    const nombres = (titulo: string) => {
      const ini = h.indexOf(`aria-label="${titulo}"`)
      return [...h.slice(ini, h.indexOf('</form>', ini)).matchAll(/ name="([a-zA-Z0-9]+)"/g)].map((m) => m[1])
    }
    expect(nombres('Nuevo producto')).toEqual(CAMPOS['eco.producto.crear'].map((c) => c.clave))
    expect(nombres('Editar producto')).toEqual(CAMPOS['eco.producto.editar'].map((c) => c.clave))
    expect(nombres('Nueva cotización')).toEqual(CAMPOS['eco.cotizacion.crear'].map((c) => c.clave))
    expect(nombres('Nuevo embarque')).toEqual(CAMPOS['eco.embarque.crear'].map((c) => c.clave))
    expect(h).toMatch(/aria-label="Nueva cotización".*?name="productoId" value="PRD-0001"/s)
    expect(await pagina(DUENO, ACTIVA, { proveedor: 'PRV-0001' })).toContain('aria-label="Editar proveedor"')
  })

  it('otro usuario, o el escritor con la escritura apagada: ningún formulario', async () => {
    for (const [email, vars] of [['lector@example.com', ACTIVA], [DUENO, { ...ACTIVA, ECO_PIPELINE_WRITE_MODE: '' }]] as const) {
      for (const search of [{ producto: 'PRD-0001' }, { proveedor: 'PRV-0001' }] as Record<string, string>[]) {
        const h = await pagina(email, vars, search)
        expect(h).toContain('Ficha de')
        expect(h).not.toMatch(/Nuevo producto|Nuevo proveedor|Editar (producto|proveedor|cotización)|Nueva cotización|Nuevo embarque|<form[^>]*aria-label="(Nuevo|Nueva|Editar)/)
      }
    }
  })
})
