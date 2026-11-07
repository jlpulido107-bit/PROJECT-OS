import { readFileSync } from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RateLimiter } from '@/lib/operations/rate-limit'
import type { EcoResult } from '@/lib/radaros/data'
import { construirEco } from '@/lib/radaros/eco'
import { COLUMNAS_COTIZACIONES, COLUMNAS_EMBARQUES, COLUMNAS_MIGRACION_PROVEEDORES, COLUMNAS_PRODUCTOS, COLUMNAS_PROVEEDORES } from '@/lib/radaros/pipeline'
import { columnaDe, construirBandeja, textoSeguimiento } from '@/lib/radaros/pipeline-bandeja'
import { destinoCotizaciones } from '@/lib/radaros/pipeline-compras'
import { ecoPipelineWrite } from '@/lib/radaros/pipeline-escritura-handler'
import {
  COLUMNAS_AUDITORIA, DIAS_RESPUESTA, EcoPipelineWriteService, REQUISITOS_ELEGIDA, REQUISITOS_RECIBIDA, type EcoContext, type EcoResultado,
} from '@/lib/radaros/pipeline-escritura-service'
import { InMemoryEcoStore, type Celda } from '@/lib/radaros/pipeline-escritura-store'
import { CAMPOS, parseEco, parseIdRuta } from '@/lib/radaros/pipeline-escritura-validacion'
import { cuerpo, enviar, validarCampo, type Resultado } from '@/lib/radaros/pipeline-formularios'
import { borradorRespuesta, type ContextoPegado } from '@/lib/radaros/pipeline-pegado'
import { COLUMNAS_MIGRACION_COTIZACIONES, construirTabulador, costoAterrizado, leerParametros, precioObjetivo } from '@/lib/radaros/pipeline-tabulador'
import { notasConMotivo } from '@/components/eco/bandeja-cotizaciones'

/**
 * ORD-POS-149 (POS-052): /eco/cotizaciones, bandeja en 3 pasos (pedir, recibir, decidir) con precio objetivo. Las
 * escrituras pasan por el núcleo real de la ruta (`ecoPipelineWrite`: guard, CSRF, validación y servicio) sobre un almacén
 * en memoria: ninguna prueba toca Google. Productos, proveedores, precios y correos inventados.
 */

const ORIGIN = 'http://127.0.0.1:3000'
const DUENO = 'dueno@example.com'
const PM_TOKEN = 'token-sintetico-del-pm-0123456789abcdef0123456789abcdef'
// 2026-11-05 12:00 en Mérida.
const NOW = new Date(Date.UTC(2026, 10, 5, 18, 0, 0))
const HOY = '2026-11-05'
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
  PROJECT_OS_API_TOKEN: PM_TOKEN,
}

type Rec = Record<string, Celda>
const PRV_COLS = [...COLUMNAS_PROVEEDORES, ...COLUMNAS_MIGRACION_PROVEEDORES]
const COT_COLS = [...COLUMNAS_COTIZACIONES, ...COLUMNAS_MIGRACION_COTIZACIONES]
const fila = (cols: readonly string[], r: Rec): Celda[] => cols.map((c) => r[c] ?? '')

/** «Sandes» sintético: 10.59 USD por set de 6, DDP con entrega incluida, 500 sets, TC 18.5. */
const SANDES: Rec = {
  COTIZACION_ID: 'COT-0002', PRODUCTO_ID: 'PRD-0003', PROVEEDOR_ID: 'PRV-0002', ESTADO: 'RECIBIDA', FECHA_SOLICITUD: '2026-10-25',
  FECHA_RECIBIDA: '2026-10-30', PRECIO_UNIT: 10.59, MONEDA: 'USD', MOQ: 10, PLAZO_PRODUCCION_DIAS: 15, INCOTERM: 'DDP', MUESTRA_ESTADO: 'NO_PEDIDA',
  PRECIO_POR: 'SET', UNIDADES_POR_SET: 6, CANTIDAD_COTIZADA: 500, TIPO_CAMBIO: 18.5, FLETE_CEDIS: 0, VERSION: 3,
}

/** Libro sintético; `migrado` = el propietario ya agregó las columnas de §14.1, §15.1 y §16.1. */
function libro(migrado = true) {
  const cot = migrado ? COT_COLS : COT_COLS.filter((c) => c !== 'EVIDENCIA_URL' && c !== 'PRECIO_HISTORIAL')
  return {
    PIPE_PRODUCTOS: [[...COLUMNAS_PRODUCTOS],
      fila(COLUMNAS_PRODUCTOS, { PRODUCTO_ID: 'PRD-0003', NOMBRE: 'Portavasos sintético', IDEA_ID: 'EC-006', ORIGEN: 'MANUAL', ETAPA: 'COTIZANDO', ETAPA_DESDE: '2026-10-29T09:00:00-06:00', VERSION: 1 }),
      fila(COLUMNAS_PRODUCTOS, { PRODUCTO_ID: 'PRD-0004', NOMBRE: 'Descartado sintético', IDEA_ID: 'EC-009', ORIGEN: 'MANUAL', ETAPA: 'DESCARTADO', ETAPA_DESDE: '2026-10-29T09:00:00-06:00', VERSION: 2 })],
    PIPE_PROVEEDORES: [PRV_COLS,
      fila(PRV_COLS, { PROVEEDOR_ID: 'PRV-0001', NOMBRE: 'Fábrica Uno', CANAL: 'ALIBABA', PAIS: 'CN', ESTADO: 'ACTIVO', VERSION: 1 }),
      fila(PRV_COLS, { PROVEEDOR_ID: 'PRV-0002', NOMBRE: 'Sandes Sintético', CANAL: 'ALIBABA', PAIS: 'CN', ESTADO: 'ACTIVO', VERSION: 1 }),
      fila(PRV_COLS, { PROVEEDOR_ID: 'PRV-0003', NOMBRE: 'Dormido', CANAL: '1688', PAIS: 'CN', ESTADO: 'INACTIVO', VERSION: 2 })],
    PIPE_COTIZACIONES: [cot,
      // Pedida hace 11 días: respuesta esperada el 2026-11-01, ya vencida.
      fila(cot, { COTIZACION_ID: 'COT-0001', PRODUCTO_ID: 'PRD-0003', PROVEEDOR_ID: 'PRV-0001', ESTADO: 'SOLICITADA', FECHA_SOLICITUD: '2026-10-25', FECHA_RESPUESTA_ESPERADA: '2026-11-01', MUESTRA_ESTADO: 'NO_PEDIDA', VERSION: 1 }),
      fila(cot, SANDES),
      // Recibida sin cantidad cotizada: el tabulador no tiene costo por set.
      fila(cot, { COTIZACION_ID: 'COT-0003', PRODUCTO_ID: 'PRD-0003', PROVEEDOR_ID: 'PRV-0001', ESTADO: 'RECIBIDA', PRECIO_UNIT: 1.8, MONEDA: 'USD', MOQ: 600, INCOTERM: 'FOB', PRECIO_POR: 'PIEZA', MUESTRA_ESTADO: 'NO_PEDIDA', VERSION: 2 }),
      fila(cot, { COTIZACION_ID: 'COT-0004', PRODUCTO_ID: 'PRD-0003', PROVEEDOR_ID: 'PRV-0001', ESTADO: 'RECHAZADA', NOTAS: 'Rechazada: sin certificado', VERSION: 4 })],
    PIPE_EMBARQUES: [[...COLUMNAS_EMBARQUES]],
    PIPE_AUDITORIA: [[...COLUMNAS_AUDITORIA]],
    PIPE_PARAMETROS: [['CLAVE', 'VALOR'], ['TIPO_CAMBIO_USD_MXN', '18.5'], ['IGI_PCT_CN', '20'], ['DTA_PCT', '0.8'], ['AGENTE_ADUANAL_REF', '3500']],
    // COSTO_MAX_MXN de EC-006 = 400 − 60 − 83 − (15 + 8 + 25) % × 400 = 65 MXN (la referencia de DEC-ECO-008).
    UNIT_ECONOMICS: [['IDEA_ID', 'AMZ_PRECIO_MXN', 'AMZ_COMISION_MXN', 'AMZ_COMISION_PCT', 'AMZ_FBA_MXN', 'AMZ_TARIFAS_FECHA'], ['EC-006', '400', '60', '', '83', '2026-11-01']],
  }
}

const RUTAS: Record<string, { crear: 'eco.proveedor.crear' | 'eco.cotizacion.crear'; editar: 'eco.proveedor.editar' | 'eco.cotizacion.editar'; prefijo: 'PRV' | 'COT'; metodo: string }> = {
  proveedores: { crear: 'eco.proveedor.crear', editar: 'eco.proveedor.editar', prefijo: 'PRV', metodo: 'Proveedor' },
  cotizaciones: { crear: 'eco.cotizacion.crear', editar: 'eco.cotizacion.editar', prefijo: 'COT', metodo: 'Cotizacion' },
}

/** `fetch` del navegador hacia el núcleo real de las rutas; `extra` simula a otro cliente (p. ej. el PM con su token). */
function servidor(migrado = true, extra: Record<string, string> = {}) {
  const memoria = new InMemoryEcoStore(ACTIVA.RADAROS_SHEET_ID!, libro(migrado))
  const svc = new EcoPipelineWriteService(memoria, { clock: () => NOW, randomHex: () => 'abcd1234' })
  let pedidos = 0
  const f = (async (url: string, init: RequestInit) => {
    const [, , , , entidad, id] = url.split('/')
    const r = RUTAS[entidad!]!
    const req = new Request(`${ORIGIN}${url}`, { ...init, headers: { ...(init.headers as Record<string, string>), origin: ORIGIN, ...extra } })
    const run = (s: EcoPipelineWriteService, b: unknown, ctx: EcoContext): Promise<EcoResultado> => {
      if (id === 'pedir') return s.pedirCotizacion(parseEco('eco.cotizacion.pedir', b), ctx)
      const m = s as unknown as Record<string, (...a: unknown[]) => Promise<EcoResultado>>
      return id ? m[`editar${r.metodo}`]!.call(s, parseIdRuta(r.prefijo, id), parseEco(r.editar, b), ctx) : m[`crear${r.metodo}`]!.call(s, parseEco(r.crear, b), ctx)
    }
    const { status, body } = await ecoPipelineWrite(req, {
      sessionEmail: async () => DUENO, env: ACTIVA as unknown as NodeJS.ProcessEnv, limiter: new RateLimiter(50, 1),
      service: () => { pedidos++; return svc },
    }, 'prueba', run, id && id !== 'pedir' ? 200 : 201)
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  const tabla = (tab: string) => {
    const [header, ...rows] = memoria.snapshot()[tab]!
    return rows.map((row) => Object.fromEntries(header!.map((h, i) => [String(h), String(row[i] ?? '')])))
  }
  const cot = (id: string) => tabla('PIPE_COTIZACIONES').find((c) => c.COTIZACION_ID === id)!
  return { f, tabla, cot, pedidos: () => pedidos, snapshot: () => memoria.snapshot() }
}

const rid = () => crypto.randomUUID()
const pedir = (s: ReturnType<typeof servidor>, body: Record<string, string>) => enviar('/api/eco/pipeline/cotizaciones/pedir', 'POST', { requestId: rid(), ...body }, s.f)
const patch = (s: ReturnType<typeof servidor>, id: string, version: number, body: Record<string, string>) =>
  enviar(`/api/eco/pipeline/cotizaciones/${id}`, 'PATCH', { requestId: rid(), expectedVersion: version, ...body }, s.f)
const conflicto = (r: Resultado) => (r.tipo === 'conflicto' ? r.mensaje : `(${r.tipo})`)

/* ------------------------------------------ Paso 1: pedir ------------------------------------------ */

describe('criterio 3: pedir con 3 campos', () => {
  it('crea la cotización SOLICITADA con FECHA_SOLICITUD = hoy (Mérida) y FECHA_RESPUESTA_ESPERADA = hoy + 7', async () => {
    const s = servidor()
    expect(CAMPOS['eco.cotizacion.pedir'].map((c) => c.columna)).toEqual(['PRODUCTO_ID', 'PROVEEDOR_ID'])
    const r = await pedir(s, { productoId: 'PRD-0003', proveedorId: 'PRV-0002' })
    expect(r).toMatchObject({ tipo: 'ok', id: 'COT-0005' })
    expect(DIAS_RESPUESTA).toBe(7)
    expect(s.cot('COT-0005')).toMatchObject({ ESTADO: 'SOLICITADA', FECHA_SOLICITUD: HOY, FECHA_RESPUESTA_ESPERADA: '2026-11-12', MUESTRA_ESTADO: 'NO_PEDIDA', VERSION: '1' })
  })

  it('un proveedor nuevo con solo NOMBRE, PAIS y canal, y luego la cotización (lo que hace la pantalla)', async () => {
    const s = servidor()
    const prv = await enviar('/api/eco/pipeline/proveedores', 'POST', { requestId: rid(), nombre: 'Moldes Nuevos', canal: 'MADE_IN_CHINA', pais: 'VN' }, s.f)
    expect(prv).toMatchObject({ tipo: 'ok', id: 'PRV-0004' })
    expect(await pedir(s, { productoId: 'PRD-0003', proveedorId: 'PRV-0004' })).toMatchObject({ tipo: 'ok' })
    expect(s.tabla('PIPE_PROVEEDORES').at(-1)).toMatchObject({ NOMBRE: 'Moldes Nuevos', CANAL: 'MADE_IN_CHINA', PAIS: 'VN', ESTADO: 'ACTIVO', CONTACTO: '' })
  })

  it('no acepta otros campos, ni producto descartado, ni proveedor INACTIVO; no escribe nada', async () => {
    const s = servidor()
    const antes = s.snapshot()
    expect((await pedir(s, { productoId: 'PRD-0003', proveedorId: 'PRV-0002', estado: 'RECIBIDA' })).tipo).toBe('validacion')
    expect((await pedir(s, { productoId: 'PRD-0004', proveedorId: 'PRV-0002' })).tipo).toBe('validacion')
    expect((await pedir(s, { productoId: 'PRD-0003', proveedorId: 'PRV-0003' })).tipo).toBe('validacion')
    expect(s.snapshot()).toEqual(antes)
  })
})

/* ----------------------------------------- Criterio 8: solo el propietario ----------------------------------------- */

describe('criterio 8: solo escribe la sesión del propietario', () => {
  it('con el token del PM, pedir, recibir y decidir responden 401 sin pedir el servicio ni escribir', async () => {
    const s = servidor(true, { authorization: `Bearer ${PM_TOKEN}` })
    const antes = s.snapshot()
    for (const r of [
      await pedir(s, { productoId: 'PRD-0003', proveedorId: 'PRV-0002' }),
      await patch(s, 'COT-0001', 1, { estado: 'RECIBIDA', precioUnit: '2', precioPor: 'PIEZA', incoterm: 'FOB', moq: '100' }),
      await patch(s, 'COT-0002', 3, { estado: 'ELEGIDA' }),
    ]) expect(r).toMatchObject({ tipo: 'error' })
    expect(s.pedidos()).toBe(0)
    expect(s.snapshot()).toEqual(antes)
  })

  it('la ruta de «pedir» pasa por el guard del pipeline (sin agente) y no expone GET ni DELETE', () => {
    const text = readFileSync(path.join(__dirname, '..', 'src', 'app', 'api', 'eco', 'pipeline', 'cotizaciones', 'pedir', 'route.ts'), 'utf8')
    expect(text).toMatch(/handleEcoWrite\(request, 'eco\.cotizacion\.pedir'/)
    expect(text).not.toMatch(/export (async )?function (GET|PUT|PATCH|DELETE)/)
  })
})

/* ------------------------------------------ Paso 2: recibir ------------------------------------------ */

describe('criterio 4: recibir edita la misma fila con VERSION', () => {
  const RECIBIR = { estado: 'RECIBIDA', precioUnit: '2.1', precioPor: 'PIEZA', incoterm: 'FOB', cantidadCotizada: '1200', moq: '600', moneda: 'USD', paisOrigen: 'CN', certificadoOrigen: 'NO', unidadesPorSet: '6' }

  it('pasa la misma COT a RECIBIDA (sin fila nueva), sube la VERSION y pone FECHA_RECIBIDA = hoy; el plazo no hace falta', async () => {
    const s = servidor()
    const filas = s.tabla('PIPE_COTIZACIONES').length
    expect(await patch(s, 'COT-0001', 1, RECIBIR)).toMatchObject({ tipo: 'ok', id: 'COT-0001' })
    expect(s.tabla('PIPE_COTIZACIONES')).toHaveLength(filas)
    expect(s.cot('COT-0001')).toMatchObject({ ESTADO: 'RECIBIDA', PRECIO_UNIT: '2.1', PRECIO_POR: 'PIEZA', CANTIDAD_COTIZADA: '1200', FECHA_RECIBIDA: HOY, FECHA_SOLICITUD: '2026-10-25', PLAZO_PRODUCCION_DIAS: '', VERSION: '2' })
    expect(REQUISITOS_RECIBIDA).not.toContain('PLAZO_PRODUCCION_DIAS')
  })

  it('conflicto: con una VERSION vieja responde 409 y no escribe nada', async () => {
    const s = servidor()
    expect(await patch(s, 'COT-0001', 1, RECIBIR)).toMatchObject({ tipo: 'ok' })
    const antes = s.snapshot()
    const r = await patch(s, 'COT-0001', 1, { ...RECIBIR, precioUnit: '2.3' })
    expect(r).toMatchObject({ tipo: 'conflicto', versionActual: 2 })
    expect(conflicto(r)).toContain('Recarga')
    expect(s.snapshot()).toEqual(antes)
  })

  it('sin «por pieza / por set» o sin precio no se recibe (409 requisito-faltante)', async () => {
    const s = servidor()
    const { precioPor: _pp, ...sinUnidad } = RECIBIR
    void _pp
    expect(await patch(s, 'COT-0001', 1, sinUnidad)).toMatchObject({ tipo: 'conflicto' })
    const { precioUnit: _pu, ...sinPrecio } = RECIBIR
    void _pu
    expect(await patch(s, 'COT-0001', 1, sinPrecio)).toMatchObject({ tipo: 'conflicto' })
    expect(s.cot('COT-0001')).toMatchObject({ ESTADO: 'SOLICITADA', VERSION: '1' })
  })

  it('EVIDENCIA_URL: solo una liga de Drive o Docs, nunca un correo', async () => {
    const c = CAMPOS['eco.cotizacion.editar'].find((x) => x.columna === 'EVIDENCIA_URL')!
    expect(validarCampo(c, 'https://drive.google.com/file/d/1AbCdEf1234567890/view')).toBeNull()
    expect(validarCampo(c, 'https://docs.google.com/document/d/1x/edit')).toBeNull()
    for (const mala of ['https://example.com/x', 'http://drive.google.com/x', 'https://drive.google.com/x?u=ana@example.com', 'drive.google.com/x']) {
      expect(validarCampo(c, mala), mala).not.toBeNull()
      expect(() => parseEco('eco.cotizacion.editar', { requestId: rid(), expectedVersion: 1, evidenciaUrl: mala }), mala).toThrow()
    }
    const s = servidor()
    expect(await patch(s, 'COT-0002', 3, { evidenciaUrl: 'https://drive.google.com/file/d/1AbC/view' })).toMatchObject({ tipo: 'ok' })
    expect(s.cot('COT-0002').EVIDENCIA_URL).toBe('https://drive.google.com/file/d/1AbC/view')
  })

  it('el pegado de Gemini o de texto llena un borrador (sin guardar nada)', () => {
    const ctx: ContextoPegado = { campos: CAMPOS['eco.cotizacion.crear'], productos: [{ id: 'PRD-0003', ideaId: 'EC-006', etapa: 'COTIZANDO' }], proveedores: [{ id: 'PRV-0001', nombre: 'Fábrica Uno' }], cotizaciones: [] }
    const ids = { productoId: 'PRD-0003', proveedorId: 'PRV-0001' }
    const texto = borradorRespuesta('PRECIO_UNIT: US$ 2.10\nPRECIO_POR: pcs\nINCOTERM: fob\nMOQ: 1,000\nCOLOR: rojo', ctx, ids)
    expect(texto).toMatchObject({ error: null, valores: { precioUnit: '2.10', precioPor: 'PIEZA', incoterm: 'FOB', moq: '1000' }, ignoradas: ['COLOR'] })
    expect(texto.valores).not.toHaveProperty('productoId')
    const tabla = borradorRespuesta('| PRD / EC | PROVEEDOR (empresa) | ESTADO | PRECIO_UNIT | MONEDA | INCOTERM |\n|---|---|---|---|---|---|\n| EC-999 | Otro | RECIBIDA (PARCIAL) | 3.4 | USD | DDP |', ctx, ids)
    expect(tabla).toMatchObject({ error: null, valores: { precioUnit: '3.4', moneda: 'USD', incoterm: 'DDP' } })
    expect(tabla.valores).not.toHaveProperty('estado')
    expect(borradorRespuesta('hola', ctx, ids).error).toContain('No se reconoció')
  })
})

/* ------------------------------------------ Paso 3: decidir ------------------------------------------ */

describe('criterio 5: decidir y contraoferta', () => {
  it('ELEGIDA en 1 clic; exige el plazo (ELEGIDA pide más que RECIBIDA)', async () => {
    const s = servidor()
    expect(await patch(s, 'COT-0002', 3, { estado: 'ELEGIDA' })).toMatchObject({ tipo: 'ok' })
    expect(s.cot('COT-0002')).toMatchObject({ ESTADO: 'ELEGIDA', VERSION: '4' })
    expect(await patch(s, 'COT-0003', 2, { estado: 'ELEGIDA' })).toMatchObject({ tipo: 'conflicto' })
    expect(REQUISITOS_ELEGIDA).toContain('PLAZO_PRODUCCION_DIAS')
  })

  it('RECHAZADA en 1 clic con el motivo de una línea al final de NOTAS', async () => {
    expect(notasConMotivo('', '  precio  alto\n')).toBe('Rechazada: precio alto')
    expect(notasConMotivo('parcial', 'sin certificado')).toBe('parcial\nRechazada: sin certificado')
    const s = servidor()
    expect(await patch(s, 'COT-0003', 2, { estado: 'RECHAZADA', notas: notasConMotivo('', 'MOQ muy alto') })).toMatchObject({ tipo: 'ok' })
    expect(s.cot('COT-0003')).toMatchObject({ ESTADO: 'RECHAZADA', NOTAS: 'Rechazada: MOQ muy alto' })
  })

  it('contraoferta: guarda el precio nuevo y conserva los anteriores en PRECIO_HISTORIAL, sin borrar', async () => {
    const s = servidor()
    expect(await patch(s, 'COT-0002', 3, { precioUnit: '9.8' })).toMatchObject({ tipo: 'ok' })
    expect(s.cot('COT-0002')).toMatchObject({ PRECIO_UNIT: '9.8', PRECIO_HISTORIAL: `${HOY}: 10.59 USD por SET DDP`, VERSION: '4' })
    expect(await patch(s, 'COT-0002', 4, { precioUnit: '8.75' })).toMatchObject({ tipo: 'ok' })
    expect(s.cot('COT-0002').PRECIO_HISTORIAL).toBe(`${HOY}: 10.59 USD por SET DDP | ${HOY}: 9.8 USD por SET DDP`)
    // La auditoría guarda el antes y el después de las dos columnas.
    const aud = s.tabla('PIPE_AUDITORIA').filter((a) => a.REGISTRO_ID === 'COT-0002' && a.CAMPO === 'PRECIO_HISTORIAL')
    expect(aud.at(-1)).toMatchObject({ VALOR_ANTES: `${HOY}: 10.59 USD por SET DDP` })
  })

  it('sin la columna PRECIO_HISTORIAL (migración pendiente) la contraoferta es 409 y no escribe', async () => {
    const s = servidor(false)
    const antes = s.snapshot()
    const r = await patch(s, 'COT-0002', 3, { precioUnit: '9.8' })
    expect(r).toMatchObject({ tipo: 'conflicto' })
    expect(conflicto(r)).toContain('PRECIO_HISTORIAL')
    expect(s.snapshot()).toEqual(antes)
  })
})

/* -------------------------------------- Criterio 6: precio objetivo -------------------------------------- */

describe('criterio 6: precio objetivo con el cálculo del tabulador', () => {
  const p = leerParametros(libro().PIPE_PARAMETROS)
  const sandes = Object.fromEntries(Object.entries(SANDES).map(([k, v]) => [k, String(v)]))

  it('Sandes (10.59 USD DDP, set de 6, COSTO_MAX 65 MXN): objetivo cercano a 3.5 USD por set', () => {
    const o = precioObjetivo(sandes, p, 65)
    expect(o).toMatchObject({ moneda: 'USD', incoterm: 'DDP', unidad: 'SET', motivo: null })
    expect(o.valor).toBeCloseTo(65 / 18.5, 6)
    expect(o.valor!.toFixed(2)).toBe('3.51')
    // Con el objetivo, el tabulador da exactamente el máximo.
    expect(costoAterrizado({ ...sandes, PRECIO_UNIT: String(o.valor) }, p).porSetMxn).toBeCloseTo(65, 6)
  })

  it('FOB: despeja también el IGI y el DTA sobre el valor en aduana, y los costos fijos', () => {
    const fob = { ...sandes, INCOTERM: 'FOB', FLETE_INTERNACIONAL: '200', SEGURO: '20', FLETE_CEDIS: '1500', PAIS_ORIGEN: 'CN' }
    const o = precioObjetivo(fob, p, 120)
    expect(o.valor).not.toBeNull()
    expect(costoAterrizado({ ...fob, PRECIO_UNIT: String(o.valor) }, p).porSetMxn).toBeCloseTo(120, 6)
    expect(o.supuestos).toEqual(expect.arrayContaining(['Agente aduanal']))
  })

  it('sin máximo, sin datos del tabulador o con costos fijos por encima: «Por confirmar» con el motivo', () => {
    expect(precioObjetivo(sandes, p, null).motivo).toContain('COSTO_MAX_MXN')
    expect(precioObjetivo({ ...sandes, CANTIDAD_COTIZADA: '' }, p, 65)).toMatchObject({ valor: null })
    expect(precioObjetivo({ ...sandes, FLETE_CEDIS: '50000' }, p, 65).motivo).toContain('Ni con precio 0')
  })
})

/* ---------------------------------- Criterios 2 y 7: bandeja y seguimiento ---------------------------------- */

describe('criterios 2 y 7: bandeja en 3 columnas, vencidas y seguimiento', () => {
  const vista = () => construirEco(libro() as unknown as Parameters<typeof construirEco>[0], NOW.getTime())

  it('reparte: SOLICITADA espera, RECIBIDA sin datos por completar, RECIBIDA con costo lista; RECHAZADA fuera', () => {
    const v = vista()
    const b = construirBandeja(v.pipeline, v.tabulador)
    expect(b.esperando.map((t) => t.id)).toEqual(['COT-0001'])
    expect(b.porCompletar.map((t) => t.id)).toEqual(['COT-0003'])
    expect(b.listas.map((t) => t.id)).toEqual(['COT-0002'])
    expect(b.fuera).toBe(1)
    expect(columnaDe('ELEGIDA', 100)).toBe('listas')
    expect(columnaDe('RECHAZADA', 100)).toBeNull()
  })

  it('listas: costo por set, «No cumple por X», precio objetivo y capital del lote, del tabulador', () => {
    const v = vista()
    const [t] = construirBandeja(v.pipeline, v.tabulador).listas
    expect(t!.comparada!.costo.porSetMxn).toBeCloseTo(10.59 * 18.5)
    expect(t!.comparada!.diferenciaMxn).toBeCloseTo(10.59 * 18.5 - 65)
    expect(t!.comparada!.capitalPrimerLoteMxn).toBeCloseTo(500 * 10.59 * 18.5)
    expect(t!.objetivo!.valor).toBeCloseTo(3.51, 2)
  })

  it('por completar dice qué le falta al tabulador; recibir trae los valores por defecto visibles', () => {
    const v = vista()
    const b = construirBandeja(v.pipeline, v.tabulador)
    expect(b.porCompletar[0]!.faltan.join(' ')).toContain('CANTIDAD_COTIZADA')
    // UNIDADES_POR_SET del producto (de su otra cotización), PAIS_ORIGEN del proveedor, certificado NO; USD ya está.
    expect(b.porCompletar[0]!.defectos).toEqual({ PAIS_ORIGEN: 'CN', CERTIFICADO_ORIGEN: 'NO', UNIDADES_POR_SET: '6' })
    expect(b.esperando[0]!.defectos).toMatchObject({ MONEDA: 'USD', PAIS_ORIGEN: 'CN', CERTIFICADO_ORIGEN: 'NO' })
  })

  it('vencida: SOLICITADA con la respuesta esperada antes de hoy; el seguimiento es corto, en inglés y sin contactos', () => {
    const v = vista()
    const [t] = construirBandeja(v.pipeline, v.tabulador).esperando
    expect(t!.vencida).toBe(true)
    expect(t!.seguimiento).toBe(textoSeguimiento('Fábrica Uno', 'Portavasos sintético', '2026-10-25'))
    expect(t!.seguimiento).toMatch(/^Hello Fábrica Uno team, following up on our quotation request for Portavasos sintético sent on 2026-10-25\./)
    expect(t!.seguimiento).not.toMatch(/@|\d{10}/)
    expect(t!.seguimiento.length).toBeLessThan(300)
  })

  it('no vencida: la respuesta esperada es hoy o después', async () => {
    const s = servidor()
    await pedir(s, { productoId: 'PRD-0003', proveedorId: 'PRV-0002' })
    const v = construirEco(s.snapshot() as unknown as Parameters<typeof construirEco>[0], NOW.getTime())
    const nueva = construirBandeja(v.pipeline, construirTabulador(s.snapshot())).esperando.find((t) => t.id === 'COT-0005')!
    expect(nueva.vencida).toBe(false)
  })
})

/* ------------------------------------------ Pantalla (criterio 1) ------------------------------------------ */

const estado = vi.hoisted(() => ({ result: null as unknown, email: 'lector@example.com' }))
vi.mock('@/lib/page-data', () => ({ privateEco: async () => ({ user: { email: estado.email }, result: estado.result }) }))
vi.mock('@/components/operations/write-access', () => ({ writeAccess: () => ({ allowed: false }) }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => undefined }),
  redirect: (url: string) => { throw new Error(`REDIRECT ${url}`) },
}))
vi.mock('@/lib/auth', async (original) => ({ ...(await original<typeof import('@/lib/auth')>()), requireUser: async () => ({ email: estado.email }) }))

/* ------------------- ORD-POS-150 (POS-053): compras por producto en /eco/pipeline ------------------- */

describe('ORD-POS-150: pipeline y cotizaciones en una vista', () => {
  afterEach(() => vi.unstubAllEnvs())

  async function pagina(email: string, vars: Record<string, string>, search: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v)
    estado.email = email
    estado.result = { estado: 'ok', vista: construirEco(libro() as unknown as Parameters<typeof construirEco>[0], NOW.getTime()), fetchedAt: NOW.getTime() } satisfies EcoResult
    const { default: Page } = await import('@/app/(private)/eco/pipeline/page')
    return renderToStaticMarkup(await Page({ searchParams: Promise.resolve(search) }))
  }
  const LECTOR = 'lector@example.com'
  const chip = (h: string, titulo: string) => {
    const ini = h.lastIndexOf('<a', h.indexOf(`${titulo} <strong>`))
    return h.slice(ini, h.indexOf('</a>', ini))
  }
  // La lista no anida otras <ul>: va de su etiqueta al primer </ul>.
  const lista = (h: string) => {
    const ini = h.indexOf('aria-label="Lista de productos"')
    return ini < 0 ? '' : h.slice(ini, h.indexOf('</ul>', ini))
  }

  it('criterio 1: 3 chips con los conteos de construirBandeja (vencidas aparte) y, al tocar uno, la lista se filtra', async () => {
    const h = await pagina(LECTOR, { ...ACTIVA, ECO_TABULADOR: 'true' })
    expect(chip(h, 'Esperando respuesta')).toMatch(/href="\/eco\/pipeline\?paso=esperando#productos"[^>]*>Esperando respuesta <strong>1<\/strong><span class="badge badge-danger">1 vencida<\/span>/)
    expect(chip(h, 'Por completar')).toContain('Por completar <strong>1</strong>')
    expect(chip(h, 'Listas para decidir')).toContain('Listas para decidir <strong>1</strong>')
    // Activas por omisión: sin el descartado; «Todas» lo trae.
    expect(lista(h)).toContain('PRD-0003')
    expect(lista(h)).not.toContain('PRD-0004')
    expect(h).toMatch(/<select name="etapa"><option value="ACTIVAS" selected="">Activas<\/option><option value="TODAS">Todas<\/option>/)
    expect(lista(await pagina(LECTOR, ACTIVA, { etapa: 'TODAS' }))).toContain('PRD-0004')
    // El chip activo lleva aria-current y vuelve a tocarse para quitarlo; un paso sin cotizaciones deja la lista vacía.
    const listas = await pagina(LECTOR, ACTIVA, { paso: 'listas', etapa: 'TODAS' })
    expect(chip(listas, 'Listas para decidir')).toMatch(/href="\/eco\/pipeline\?etapa=TODAS#productos" aria-current="true"/)
    expect(lista(listas)).toContain('PRD-0003')
    expect(lista(listas)).not.toContain('PRD-0004')
    expect(listas).toContain('Quitar filtro')
    // Un paso inventado se ignora (sin filtro).
    expect(lista(await pagina(LECTOR, ACTIVA, { paso: 'otro' }))).toContain('PRD-0003')
  })

  it('criterio 2: renglón con etapa y días, costo máximo, mejor cotización con veredicto y conteo por paso; «Vista tablero» conserva el tablero', async () => {
    const h = await pagina(LECTOR, { ...ACTIVA, ECO_TABULADOR: 'true' })
    const r = lista(h)
    expect(r).toContain('Portavasos sintético')
    expect(r).toMatch(/Cotizando · \d+ días/)
    expect(r).toContain('Costo máximo: <span class="mono">65.00 MXN</span>')
    // La mejor es la primera con costo en el orden de «Comparar»: COT-0002 (la única con costo por set).
    const tab = construirTabulador(libro() as unknown as Parameters<typeof construirTabulador>[0])
    const cmp = tab.comparar('PRD-0003', 'EC-006')
    const mejor = cmp.filas.find((f) => f.costo.porSetMxn !== null)!
    expect(mejor.id).toBe('COT-0002')
    expect(r).toContain(`Mejor: <span class="mono">${mejor.costo.porSetMxn!.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MXN</span> (Sandes Sintético)`)
    expect(r).toContain('No cumple por')
    expect(r).toContain('1 esperando respuesta · 1 por completar · 1 listas para decidir')
    expect(h).toContain('href="/eco/pipeline?vista=tablero#tablero">Vista tablero</a>')
    const tablero = await pagina(LECTOR, ACTIVA, { vista: 'tablero' })
    for (const e of ['Sugerido', 'Evaluando', 'Cotizando', 'Muestra', 'En venta', 'Descartado']) expect(tablero).toContain(`aria-label="${e}"`)
    expect(tablero).not.toContain('aria-label="Lista de productos"')
  })

  it('criterio 3: ficha con 4 indicadores, cotizaciones en 3 columnas con sus acciones, «Pedir a otro proveedor» y Comparar en 6 columnas', async () => {
    const h = await pagina(DUENO, { ...ACTIVA, ECO_TABULADOR: 'true' }, { producto: 'PRD-0003' })
    for (const t of ['Costo máximo por set', 'Mejor cotización', 'Precio objetivo', 'Capital del lote (tope 30,000.00 MXN)']) expect(h).toContain(`<span class="stat-label">${t}</span>`)
    expect(h).toContain('<span class="stat-value">3.51 USD</span>')
    for (const t of ['Esperando respuesta de PRD-0003', 'Por completar de PRD-0003', 'Listas para decidir de PRD-0003']) expect(h).toContain(`aria-label="${t}"`)
    expect(h).toContain('class="card card-vencida"')
    expect(h).toContain('Copiar seguimiento')
    expect(h).toContain('aria-label="Recibir COT-0001"')
    expect(h).toContain('aria-label="Completar COT-0003"')
    expect(h).toContain('aria-label="Elegir COT-0002"')
    for (const t of ['Rechazar COT-0002', 'Contraoferta de COT-0002']) expect(h).toContain(`aria-label="${t}"`)
    // «Recibir» conserva sus valores por defecto visibles y «Más detalles» plegado (ORD-POS-149).
    const ini = h.indexOf('aria-label="Recibir COT-0001"')
    const form = h.slice(ini, h.indexOf('</form>', ini))
    expect(form).toMatch(/<select name="moneda">(?:<option[^>]*>[^<]*<\/option>)*?<option value="USD" selected="">/)
    expect(form).toMatch(/<summary>Más detalles<\/summary>[\s\S]*name="seguro"/)
    expect(h).toContain('Precio objetivo: <strong class="mono">3.51 USD</strong> por set DDP')
    // «Pedir a otro proveedor» con el producto ya elegido.
    const pedir = h.slice(h.indexOf('id="pedir-producto"'), h.indexOf('</details>', h.indexOf('id="pedir-producto"')))
    expect(pedir).toContain('<summary>Pedir a otro proveedor</summary>')
    expect(pedir).toMatch(/<option value="PRD-0003" selected="">/)
    // Comparar: 6 columnas visibles; el resto en «Más columnas»; el desglose plegado.
    const tabla = h.slice(h.indexOf('aria-label="Cotizaciones comparadas"'), h.indexOf('</thead>', h.indexOf('aria-label="Cotizaciones comparadas"')))
    expect([...tabla.matchAll(/<th scope="col">([^<]*)<\/th>/g)].map((m) => m[1])).toEqual(['Proveedor', 'Estado', 'Costo por set (MXN)', 'Contra el máximo', 'Capital del lote (tope 30,000.00 MXN)', 'Plazo (días)'])
    expect(h).toMatch(/<summary>Más columnas<\/summary>[\s\S]*Mínimo del proveedor \(MXN\)[\s\S]*Sets que caben en el tope/)
    expect(h).toMatch(/<summary>Desglose por cotización<\/summary>[\s\S]*Desglose de COT-0002/)
  })

  it('criterio 3: Comparar da las mismas cifras que el tabulador para el producto de prueba', async () => {
    const h = await pagina(LECTOR, { ...ACTIVA, ECO_TABULADOR: 'true' }, { comparar: 'PRD-0003' })
    const cmp = construirTabulador(libro() as unknown as Parameters<typeof construirTabulador>[0]).comparar('PRD-0003', 'EC-006')
    const mxn = (v: number) => v.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    expect(cmp.costoMaximo.mxn).toBe(65)
    for (const f of cmp.filas) {
      if (f.costo.porSetMxn !== null) expect(h).toContain(`<td class="mono">${mxn(f.costo.porSetMxn)}`)
      if (f.capitalPrimerLoteMxn !== null) expect(h).toContain(`${mxn(f.capitalPrimerLoteMxn)} <span class="badge`)
      if (f.diferenciaMxn !== null) expect(h).toContain(`No cumple por ${mxn(f.diferenciaMxn)} MXN`)
      if (f.minimoProveedorMxn !== null) expect(h).toContain(`<td class="mono">${mxn(f.minimoProveedorMxn)}</td>`)
    }
  })

  it('criterio 4: Identidad y Keepa, Seguimiento y embarques, y Notas e historial plegados; Proveedores en su subpestaña', async () => {
    const h = await pagina(LECTOR, ACTIVA, { producto: 'PRD-0003' })
    for (const t of ['Identidad y Keepa', 'Seguimiento y embarques', 'Notas e historial']) expect(h).toMatch(new RegExp(`<details class="plegable"><summary>${t}`))
    // La subpestaña Productos no pinta la lista de proveedores; Proveedores sí, con su ficha.
    expect(h).not.toContain('aria-label="Proveedores"')
    expect(h).toContain('href="/eco/pipeline?seccion=proveedores#proveedores"')
    const prv = await pagina(LECTOR, ACTIVA, { seccion: 'proveedores' })
    expect(prv).toContain('aria-label="Proveedores"')
    expect(prv).toMatch(/<a href="\/eco\/pipeline\?seccion=proveedores#proveedores" aria-current="page">Proveedores<\/a>/)
    expect(prv).not.toContain('aria-label="Lista de productos"')
    expect(await pagina(LECTOR, ACTIVA, { proveedor: 'PRV-0002' })).toContain('Ficha de proveedor · Sandes Sintético')
  })

  it('criterio 5: /eco/cotizaciones redirige a /eco/pipeline y conserva el paso; los enlaces antiguos siguen funcionando', async () => {
    expect(destinoCotizaciones({})).toBe('/eco/pipeline#productos')
    expect(destinoCotizaciones({ paso: 'porCompletar' })).toBe('/eco/pipeline?paso=porCompletar#productos')
    expect(destinoCotizaciones({ paso: '<script>' })).toBe('/eco/pipeline#productos')
    expect(destinoCotizaciones({ paso: ['listas', 'esperando'] })).toBe('/eco/pipeline#productos')
    const { default: Redirige } = await import('@/app/(private)/eco/cotizaciones/page')
    await expect(Redirige({ searchParams: Promise.resolve({ paso: 'listas' }) })).rejects.toThrow('REDIRECT /eco/pipeline?paso=listas#productos')
    // ?producto=, ?comparar= (con #comparar) y ?proveedor= abren lo mismo que antes.
    expect(await pagina(LECTOR, ACTIVA, { producto: 'PRD-0003' })).toContain('id="ficha-producto"')
    const cmp = await pagina(LECTOR, { ...ACTIVA, ECO_TABULADOR: 'true' }, { comparar: 'PRD-0003' })
    expect(cmp).toContain('id="ficha-producto"')
    expect(cmp).toContain('<section id="comparar"')
    expect(await pagina(LECTOR, ACTIVA, { producto: 'PRD-9999' })).toContain('No hay un producto con ese ID.')
  })

  it('criterio 5: «Alta rápida» deja de ser sección: el alta de proveedor en «Pedir» y el pegado de Gemini en «Recibir»', async () => {
    const h = await pagina(DUENO, ACTIVA)
    expect(h).not.toContain('alta-rapida')
    const pedir = h.slice(h.indexOf('id="pedir"'), h.indexOf('id="recibir"'))
    expect(pedir).toContain('aria-label="Pedir cotización"')
    expect(pedir).toContain('aria-label="Nuevo proveedor"')
    const recibir = h.slice(h.indexOf('id="recibir"'))
    expect(recibir).toContain('aria-label="Pegar tabla de Gemini"')
    const nav = readFileSync(path.join(__dirname, '..', 'src', 'lib', 'nav.ts'), 'utf8')
    expect(nav).toContain("items: [{ href: '/eco', label: 'Ideas' }, { href: '/eco/pipeline', label: 'Compras' }]")
    expect(nav).not.toContain("href: '/eco/cotizaciones'")
  })

  it('la sesión del propietario ve los botones; un lector y el escritor con la escritura apagada no', async () => {
    const CONTROLES = /Pedir cotización|Pedir a otro proveedor|Recibir COT|Completar COT|Elegir COT|Rechazar COT|Contraoferta|Pegar tabla de Gemini|Nuevo producto|Editar cotización|draggable|Mover a/
    expect(await pagina(DUENO, ACTIVA, { producto: 'PRD-0003' })).toMatch(CONTROLES)
    for (const [email, vars] of [[LECTOR, ACTIVA], [DUENO, { ...ACTIVA, ECO_PIPELINE_WRITE_MODE: '' }]] as const) {
      for (const search of [{ producto: 'PRD-0003' }, { vista: 'tablero' }, {}] as Record<string, string>[]) {
        const h = await pagina(email, { ...vars, ECO_TABULADOR: 'true' }, search)
        expect(h).not.toMatch(CONTROLES)
      }
      // Copiar el seguimiento no escribe nada: también lo ve el lector.
      expect(await pagina(email, vars, { producto: 'PRD-0003' })).toContain('Copiar seguimiento')
    }
  })

  it('con ECO_TABULADOR apagada no hay números ni Comparar, y se dice por qué', async () => {
    const h = await pagina(DUENO, ACTIVA, { producto: 'PRD-0003', comparar: 'PRD-0003' })
    expect(h).toContain('Tabulador apagado (ECO_TABULADOR)')
    expect(h).toContain('Tabulador apagado (<code>ECO_TABULADOR</code>): sin costo máximo, mejor cotización, precio objetivo, capital ni «Comparar»')
    expect(h).not.toMatch(/Comparar cotizaciones|Costo máximo:|stat-label|Precio objetivo|Costo por set|No cumple por|Desglose de/)
  })

  it('accesible con teclado y a 390 px: chips y subpestañas son enlaces, los plegados son <details>, la lista y la ficha se apilan', async () => {
    const h = await pagina(LECTOR, { ...ACTIVA, ECO_TABULADOR: 'true' }, { producto: 'PRD-0003' })
    expect(h).toContain('role="group" aria-label="Bandeja de cotizaciones"')
    expect(h).toMatch(/<nav class="subnav" aria-label="Secciones de compras"><a href="\/eco\/pipeline#productos" aria-current="page">Productos<\/a>/)
    expect(h).toMatch(/<li class="card compras-fila" aria-current="true">/)
    expect(h).not.toMatch(/<(div|span|li)[^>]*onClick|tabindex="-1"/)
    const css = readFileSync(path.join(__dirname, '..', 'src', 'app', 'globals.css'), 'utf8')
    expect(css).toMatch(/@media \(max-width: 900px\) \{\n\s+\.compras-layout \{ grid-template-columns: minmax\(0, 1fr\); \}/)
    expect(css).toMatch(/\.chip \{[^}]*min-height: 40px/)
  })
})

describe('el formulario de «Recibir» envía solo lo que se ve (nunca vacía columnas ocultas)', () => {
  it('cuerpo() con los campos mostrados no incluye FECHA_SOLICITUD ni FECHA_RESPUESTA_ESPERADA', () => {
    const mostrados = CAMPOS['eco.cotizacion.editar'].filter((c) => !['FECHA_SOLICITUD', 'FECHA_RESPUESTA_ESPERADA', 'COSTO_ATERRIZADO_MXN'].includes(c.columna))
    const b = cuerpo(mostrados, { estado: 'RECIBIDA', precioUnit: '2' }, () => 'x', { version: 1, iniciales: { ESTADO: 'SOLICITADA', FECHA_SOLICITUD: '2026-10-25' } })
    expect(b).toEqual({ requestId: 'x', expectedVersion: 1, estado: 'RECIBIDA', precioUnit: '2' })
  })
})
