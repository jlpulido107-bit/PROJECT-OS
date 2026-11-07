import { readFileSync } from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RateLimiter } from '@/lib/operations/rate-limit'
import type { EcoResult } from '@/lib/radaros/data'
import { construirEco } from '@/lib/radaros/eco'
import { COLUMNAS_COTIZACIONES, COLUMNAS_EMBARQUES, COLUMNAS_MIGRACION_PROVEEDORES, COLUMNAS_PRODUCTOS, COLUMNAS_PROVEEDORES } from '@/lib/radaros/pipeline'
import { columnaDe, construirBandeja, textoSeguimiento } from '@/lib/radaros/pipeline-bandeja'
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
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }))

describe('criterio 1: /eco/cotizaciones, enlazada desde /eco/pipeline', () => {
  afterEach(() => vi.unstubAllEnvs())

  async function pagina(email: string, vars: Record<string, string>) {
    for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v)
    estado.email = email
    estado.result = { estado: 'ok', vista: construirEco(libro() as unknown as Parameters<typeof construirEco>[0], NOW.getTime()), fetchedAt: NOW.getTime() } satisfies EcoResult
    const { default: Page } = await import('@/app/(private)/eco/cotizaciones/page')
    return renderToStaticMarkup(await Page())
  }

  it('el escritor ve las 3 columnas, «Pedir», «Recibir» con sus valores por defecto y «Más detalles» plegado', async () => {
    const h = await pagina(DUENO, { ...ACTIVA, ECO_TABULADOR: 'true' })
    for (const t of ['aria-label="Esperando respuesta"', 'aria-label="Por completar"', 'aria-label="Listas para comparar"', 'aria-label="Pedir cotización"']) expect(h).toContain(t)
    expect(h).toContain('class="card card-vencida"')
    expect(h).toContain('Copiar seguimiento')
    const ini = h.indexOf('aria-label="Recibir COT-0001"')
    const form = h.slice(ini, h.indexOf('</form>', ini))
    expect(form).toMatch(/<select name="moneda">(?:<option[^>]*>[^<]*<\/option>)*?<option value="USD" selected="">/)
    expect(form).toMatch(/<select name="certificadoOrigen">(?:<option[^>]*>[^<]*<\/option>)*?<option value="NO" selected="">/)
    expect(form).toMatch(/name="paisOrigen"[^>]*value="CN"/)
    expect(form).toContain('name="incluyeEntregaCedis" checked="" value="SI"')
    expect(form).toMatch(/<span>PRECIO_UNIT \*<\/span><input[^>]*required=""/)
    expect(form).toMatch(/<summary>Más detalles<\/summary>[\s\S]*name="seguro"/)
    expect(h).toContain('Precio objetivo: <strong class="mono">3.51 USD</strong> por set DDP')
    expect(h).toContain('No cumple por')
  })

  it('un lector no ve controles de escritura; sin ECO_TABULADOR no hay números', async () => {
    const h = await pagina('lector@example.com', ACTIVA)
    expect(h).toContain('aria-label="Listas para comparar"')
    expect(h).not.toMatch(/Pedir cotización|Recibir COT|Rechazar COT|Contraoferta/)
    expect(h).not.toContain('Precio objetivo')
    expect(h).toContain('Tabulador apagado')
  })

  it('/eco/pipeline enlaza la bandeja y el menú la incluye', () => {
    const pipe = readFileSync(path.join(__dirname, '..', 'src', 'app', '(private)', 'eco', 'pipeline', 'page.tsx'), 'utf8')
    expect(pipe).toContain('href="/eco/cotizaciones"')
    expect(readFileSync(path.join(__dirname, '..', 'src', 'lib', 'nav.ts'), 'utf8')).toContain("href: '/eco/cotizaciones'")
  })
})

describe('el formulario de «Recibir» envía solo lo que se ve (nunca vacía columnas ocultas)', () => {
  it('cuerpo() con los campos mostrados no incluye FECHA_SOLICITUD ni FECHA_RESPUESTA_ESPERADA', () => {
    const mostrados = CAMPOS['eco.cotizacion.editar'].filter((c) => !['FECHA_SOLICITUD', 'FECHA_RESPUESTA_ESPERADA', 'COSTO_ATERRIZADO_MXN'].includes(c.columna))
    const b = cuerpo(mostrados, { estado: 'RECIBIDA', precioUnit: '2' }, () => 'x', { version: 1, iniciales: { ESTADO: 'SOLICITADA', FECHA_SOLICITUD: '2026-10-25' } })
    expect(b).toEqual({ requestId: 'x', expectedVersion: 1, estado: 'RECIBIDA', precioUnit: '2' })
  })
})
