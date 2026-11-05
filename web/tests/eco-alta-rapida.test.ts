import { readFileSync } from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RateLimiter } from '@/lib/operations/rate-limit'
import type { EcoResult } from '@/lib/radaros/data'
import { construirEco } from '@/lib/radaros/eco'
import {
  COLUMNAS_COTIZACIONES, COLUMNAS_EMBARQUES, COLUMNAS_MIGRACION_PROVEEDORES, COLUMNAS_PRODUCTOS, COLUMNAS_PROVEEDORES,
  ESTADOS_COTIZACION,
} from '@/lib/radaros/pipeline'
import { ecoPipelineWrite } from '@/lib/radaros/pipeline-escritura-handler'
import { COLUMNAS_AUDITORIA, EcoPipelineWriteService, type EcoContext, type EcoResultado } from '@/lib/radaros/pipeline-escritura-service'
import { InMemoryEcoStore, type Celda } from '@/lib/radaros/pipeline-escritura-store'
import { CAMPOS, ESTADOS_COTIZACION as ESTADOS_ESCRITURA, INCOTERMS, parseEco, parseIdRuta } from '@/lib/radaros/pipeline-escritura-validacion'
import { cuerpo, enviar, nombreClave, validarCampo, type Resultado } from '@/lib/radaros/pipeline-formularios'
import { COLUMNAS_TABLA_B, confirmable, parsearTablaGemini, type ContextoPegado } from '@/lib/radaros/pipeline-pegado'
import {
  COLUMNAS_MIGRACION_COTIZACIONES, ESTADOS_TABULADOR, INCOTERMS_TABULADOR, leerParametros, pistasCotizacion,
} from '@/lib/radaros/pipeline-tabulador'

/**
 * ORD-POS-146 (POS-050): alta rápida de proveedores y cotizaciones y «Pegar tabla de Gemini» en /eco/pipeline. Las altas
 * pasan por el núcleo real de la ruta (`ecoPipelineWrite`: guard, CSRF, validación y servicio) sobre un almacén en
 * memoria: ninguna prueba toca Google. Proveedores, productos, precios y correos inventados.
 */

const ORIGIN = 'http://127.0.0.1:3000'
const DUENO = 'dueno@example.com'
const PM_TOKEN = 'token-sintetico-del-pm-0123456789abcdef0123456789abcdef'
const NOW = new Date(Date.UTC(2026, 10, 5, 18, 0, 0))
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

/** Libro sintético; `migrado` = el propietario ya agregó las columnas de §14.1 y §15.1. */
function libro(migrado = true) {
  const prv = migrado ? PRV_COLS : [...COLUMNAS_PROVEEDORES]
  const cot = migrado ? COT_COLS : [...COLUMNAS_COTIZACIONES]
  return {
    PIPE_PRODUCTOS: [[...COLUMNAS_PRODUCTOS],
      fila(COLUMNAS_PRODUCTOS, { PRODUCTO_ID: 'PRD-0003', NOMBRE: 'Soporte sintético', IDEA_ID: 'EC-006', ORIGEN: 'MANUAL', ETAPA: 'COTIZANDO', ETAPA_DESDE: '2026-10-29T09:00:00-06:00', VERSION: 1 }),
      fila(COLUMNAS_PRODUCTOS, { PRODUCTO_ID: 'PRD-0004', NOMBRE: 'Descartado sintético', IDEA_ID: 'EC-009', ORIGEN: 'MANUAL', ETAPA: 'DESCARTADO', ETAPA_DESDE: '2026-10-29T09:00:00-06:00', VERSION: 2 })],
    PIPE_PROVEEDORES: [prv,
      fila(prv, { PROVEEDOR_ID: 'PRV-0001', NOMBRE: 'Fábrica Uno, S.A.', CANAL: 'ALIBABA', PAIS: 'CN', ESTADO: 'ACTIVO', VERSION: 1 }),
      fila(prv, { PROVEEDOR_ID: 'PRV-0002', NOMBRE: 'Acrílicos Dos', CANAL: 'ALIBABA', PAIS: 'CN', ESTADO: 'ACTIVO', VERSION: 1 })],
    PIPE_COTIZACIONES: [cot,
      fila(cot, { COTIZACION_ID: 'COT-0001', PRODUCTO_ID: 'PRD-0003', PROVEEDOR_ID: 'PRV-0001', ESTADO: 'SOLICITADA', MUESTRA_ESTADO: 'NO_PEDIDA', PRECIO_UNIT: 2.4, MONEDA: 'USD', INCOTERM: 'FOB', VERSION: 1 })],
    PIPE_EMBARQUES: [[...COLUMNAS_EMBARQUES]],
    PIPE_AUDITORIA: [[...COLUMNAS_AUDITORIA]],
    PIPE_PARAMETROS: [['CLAVE', 'VALOR'], ['TIPO_CAMBIO_USD_MXN', '18.5'], ['TIPO_CAMBIO_USD_MXN_FECHA', '2026-11-04'], ['IGI_PCT_CN', '20'], ['DTA_PCT', '0.8'], ['AGENTE_ADUANAL_REF', '3500']],
  }
}

const RUTAS = {
  proveedores: { crear: 'eco.proveedor.crear', editar: 'eco.proveedor.editar', prefijo: 'PRV', metodo: 'Proveedor' },
  cotizaciones: { crear: 'eco.cotizacion.crear', editar: 'eco.cotizacion.editar', prefijo: 'COT', metodo: 'Cotizacion' },
} as const

/** `fetch` del navegador hacia el núcleo real de la ruta; `headers` extra simula a otro cliente (p. ej. el PM). */
function servidor(migrado = true, extra: Record<string, string> = {}) {
  const memoria = new InMemoryEcoStore(ACTIVA.RADAROS_SHEET_ID!, libro(migrado))
  const svc = new EcoPipelineWriteService(memoria, { clock: () => NOW, randomHex: () => 'abcd1234' })
  let pedidos = 0
  const llamadas: Array<Record<string, unknown>> = []
  const f = (async (url: string, init: RequestInit) => {
    llamadas.push(JSON.parse(String(init.body)) as Record<string, unknown>)
    const [, , , , entidad, id] = url.split('/')
    const r = RUTAS[entidad as keyof typeof RUTAS]
    const req = new Request(`${ORIGIN}${url}`, { ...init, headers: { ...(init.headers as Record<string, string>), origin: ORIGIN, ...extra } })
    const run = (s: EcoPipelineWriteService, b: unknown, ctx: EcoContext): Promise<EcoResultado> => {
      const m = s as unknown as Record<string, (...a: unknown[]) => Promise<EcoResultado>>
      return id ? m[`editar${r.metodo}`]!.call(s, parseIdRuta(r.prefijo, id), parseEco(r.editar, b), ctx) : m[`crear${r.metodo}`]!.call(s, parseEco(r.crear, b), ctx)
    }
    const { status, body } = await ecoPipelineWrite(req, {
      sessionEmail: async () => DUENO, env: ACTIVA as unknown as NodeJS.ProcessEnv, limiter: new RateLimiter(50, 1),
      service: () => { pedidos++; return svc },
    }, 'prueba', run, id ? 200 : 201)
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  const tabla = (tab: string) => {
    const [header, ...rows] = memoria.snapshot()[tab]!
    return rows.map((row) => Object.fromEntries(header!.map((h, i) => [String(h), String(row[i] ?? '')])))
  }
  return { f, llamadas, tabla, pedidos: () => pedidos, snapshot: () => memoria.snapshot() }
}

const nuevoId = () => crypto.randomUUID()
const alta = (s: ReturnType<typeof servidor>, ruta: keyof typeof RUTAS, valores: Record<string, string>) =>
  enviar(`/api/eco/pipeline/${ruta}`, 'POST', cuerpo(CAMPOS[RUTAS[ruta].crear], valores, nuevoId), s.f)

/* ------------------------------------------ Criterio 1 ------------------------------------------ */

describe('criterio 1: alta rápida de proveedores', () => {
  it('el formulario pide NOMBRE, CANAL, PAIS, años en la plataforma, Verified Supplier, Trade Assurance y NOTAS; sin CONTACTO', () => {
    expect(CAMPOS['eco.proveedor.crear'].map((c) => c.columna)).toEqual(['NOMBRE', 'CANAL', 'PAIS', 'ANOS_PLATAFORMA', 'VERIFIED_SUPPLIER', 'TRADE_ASSURANCE', 'NOTAS'])
    // La edición conserva el contacto comercial (§6.4) y suma las columnas nuevas.
    expect(CAMPOS['eco.proveedor.editar'].map((c) => c.columna)).toEqual(expect.arrayContaining(['CONTACTO', ...COLUMNAS_MIGRACION_PROVEEDORES]))
  })

  it('con la migración aplicada, guarda las columnas nuevas al final, con su auditoría', async () => {
    const s = servidor()
    const r = await alta(s, 'proveedores', { nombre: 'Moldes Tres', canal: 'ALIBABA', pais: 'CN', anosPlataforma: '6', verifiedSupplier: 'SI', tradeAssurance: 'NO', notas: 'Confirma PMMA virgen' })
    expect(r).toMatchObject({ tipo: 'ok', id: 'PRV-0003' })
    expect(s.tabla('PIPE_PROVEEDORES')[2]).toMatchObject({ NOMBRE: 'Moldes Tres', ANOS_PLATAFORMA: '6', VERIFIED_SUPPLIER: 'SI', TRADE_ASSURANCE: 'NO', ESTADO: 'ACTIVO', CONTACTO: '' })
    expect(s.tabla('PIPE_AUDITORIA').map((a) => a.CAMPO)).toEqual(expect.arrayContaining(['ANOS_PLATAFORMA', 'VERIFIED_SUPPLIER', 'TRADE_ASSURANCE']))
  })

  it('un nombre que ya existe (sin acentos, mayúsculas ni signos) avisa con su ID y no duplica', async () => {
    const s = servidor()
    const antes = s.snapshot()
    for (const nombre of ['Fábrica Uno, S.A.', 'fabrica uno sa', '  FABRICA   UNO S.A ']) {
      const r = await alta(s, 'proveedores', { nombre, canal: 'ALIBABA', pais: 'CN' })
      expect(r.tipo, nombre).toBe('conflicto')
      expect((r as Extract<Resultado, { tipo: 'conflicto' }>).mensaje).toContain('PRV-0001')
    }
    expect(s.snapshot()).toEqual(antes) // ni fila ni auditoría
    expect(nombreClave('Fábrica Uno, S.A.')).toBe(nombreClave('fabrica uno sa'))
    expect(nombreClave('Fábrica Dos')).not.toBe(nombreClave('Fábrica Uno'))
    // Renombrar al editar a uno que ya existe, tampoco.
    const e = await enviar('/api/eco/pipeline/proveedores/PRV-0002', 'PATCH', { requestId: nuevoId(), expectedVersion: 1, nombre: 'FABRICA UNO SA' }, s.f)
    expect(e).toMatchObject({ tipo: 'conflicto' })
  })

  it('sin correos ni teléfonos de personas en el nombre ni en las notas (servidor y pantalla)', async () => {
    const s = servidor()
    for (const malo of [{ nombre: 'ventas@fabrica-sintetica.example', notas: '' }, { nombre: 'Taller', notas: 'llamar al +86 138 0000 0000' }, { nombre: 'Taller', notas: 'escribir a juan.perez@example.com' }]) {
      const r = await alta(s, 'proveedores', { canal: 'ALIBABA', pais: 'CN', ...malo })
      expect(r.tipo, JSON.stringify(malo)).toBe('validacion')
      expect(Object.values((r as Extract<Resultado, { tipo: 'validacion' }>).campos)).toContain('Sin correos ni teléfonos de personas.')
    }
    expect(s.tabla('PIPE_PROVEEDORES')).toHaveLength(2)
    const notas = CAMPOS['eco.proveedor.crear'].find((c) => c.clave === 'notas')!
    expect(validarCampo(notas, 'contacto: x@y.com')).toBe('Sin correos ni teléfonos de personas.')
    expect(validarCampo(notas, 'MOQ 500 sets, 25 días')).toBeNull()
  })

  it('migración explícita: sin las columnas nuevas, llenarlas responde 409 y no escribe; vacías, el alta sigue igual', async () => {
    const s = servidor(false)
    const antes = s.snapshot()
    const r = await alta(s, 'proveedores', { nombre: 'Moldes Tres', canal: 'ALIBABA', pais: 'CN', verifiedSupplier: 'SI' })
    expect(r).toMatchObject({ tipo: 'conflicto' })
    expect((r as Extract<Resultado, { tipo: 'conflicto' }>).mensaje).toMatch(/PIPE_PROVEEDORES aún no tiene VERIFIED_SUPPLIER/)
    expect(s.snapshot()).toEqual(antes)
    expect(await alta(s, 'proveedores', { nombre: 'Moldes Tres', canal: 'ALIBABA', pais: 'CN' })).toMatchObject({ tipo: 'ok', id: 'PRV-0003' })
  })
})

/* ------------------------------------------ Criterio 2 ------------------------------------------ */

describe('criterio 2: el formulario de cotización trae las columnas del tabulador con lo que tomará de PIPE_PARAMETROS', () => {
  const TABULADOR = ['INCOTERM', 'PAIS_ORIGEN', 'CERTIFICADO_ORIGEN', 'UNIDADES_POR_SET', 'CANTIDAD_COTIZADA', 'TIPO_CAMBIO', 'TIPO_CAMBIO_FECHA',
    'FLETE_LOCAL_EXPORT', 'FLETE_INTERNACIONAL', 'SEGURO', 'IGI_PCT', 'DTA', 'AGENTE_ADUANAL', 'FLETE_CEDIS', 'MUESTRA_ESTADO', 'MUESTRA_COSTO', 'MUESTRA_MONEDA']

  it('incluye todas las columnas del tabulador y la muestra; nunca COSTO_ATERRIZADO_CALC_MXN', () => {
    const cols = CAMPOS['eco.cotizacion.crear'].map((c) => c.columna)
    expect(cols).toEqual(expect.arrayContaining(TABULADOR))
    expect(cols).not.toContain('COSTO_ATERRIZADO_CALC_MXN')
    // INCOTERM alineado con el tabulador (más OTRO, que el tabulador deja «Por confirmar»).
    expect(INCOTERMS).toEqual([...INCOTERMS_TABULADOR, 'OTRO'])
    // La edición de cotizaciones no cambia (fuera de alcance).
    expect(CAMPOS['eco.cotizacion.editar'].map((c) => c.columna)).not.toContain('PAIS_ORIGEN')
  })

  it('cada campo vacío dice qué valor de PIPE_PARAMETROS tomará, o «Por confirmar» si no hay', () => {
    const p = pistasCotizacion(leerParametros(libro().PIPE_PARAMETROS))
    expect(p.TIPO_CAMBIO).toContain('TIPO_CAMBIO_USD_MXN = 18.5 (2026-11-04)')
    expect(p.IGI_PCT).toContain('CN 20')
    expect(p.IGI_PCT).toContain('US sin valor')
    expect(p.DTA).toContain('DTA_PCT = 0.8')
    expect(p.AGENTE_ADUANAL).toContain('AGENTE_ADUANAL_REF = 3500 MXN')
    expect(p.FLETE_CEDIS).toMatch(/no hay FLETE_CEDIS_REF en PIPE_PARAMETROS; quedará «Por confirmar»/)
    expect(p.CERTIFICADO_ORIGEN).toContain('se supone NO')
    for (const col of ['CANTIDAD_COTIZADA', 'UNIDADES_POR_SET', 'FLETE_LOCAL_EXPORT', 'FLETE_INTERNACIONAL', 'SEGURO']) expect(p[col], col).toContain('Por confirmar')
    const vacio = pistasCotizacion(leerParametros(undefined))
    expect(vacio.TIPO_CAMBIO).toContain('no hay TIPO_CAMBIO_USD_MXN')
  })

  it('alta con las columnas del tabulador (FCA y porcentajes en puntos); RECIBIDA exige sus cinco datos', async () => {
    const s = servidor()
    const base = { productoId: 'PRD-0003', proveedorId: 'PRV-0002' }
    const ok = await alta(s, 'cotizaciones', {
      ...base, estado: 'RECIBIDA', fechaRecibida: '2026-11-04', precioUnit: '2.35', moneda: 'USD', moq: '500', plazoProduccionDias: '20', incoterm: 'FCA',
      paisOrigen: 'CN', certificadoOrigen: 'NO', unidadesPorSet: '6', cantidadCotizada: '3000', fleteInternacional: '420', igiPct: '20', dta: '0.8',
    })
    expect(ok).toMatchObject({ tipo: 'ok', id: 'COT-0002' })
    expect(s.tabla('PIPE_COTIZACIONES')[1]).toMatchObject({ ESTADO: 'RECIBIDA', INCOTERM: 'FCA', IGI_PCT: '20', CANTIDAD_COTIZADA: '3000', COSTO_ATERRIZADO_CALC_MXN: '' })
    expect(await alta(s, 'cotizaciones', { ...base, estado: 'RECIBIDA', precioUnit: '2' })).toMatchObject({ tipo: 'conflicto' })
    expect(await alta(s, 'cotizaciones', { ...base, igiPct: '120' })).toMatchObject({ tipo: 'validacion' })
    expect(await alta(s, 'cotizaciones', { ...base, estado: 'ELEGIDA' })).toMatchObject({ tipo: 'validacion' })
  })

  it('sin la migración de §14.1, llenar una columna del tabulador responde 409 y no escribe nada', async () => {
    const s = servidor(false)
    const antes = s.snapshot()
    const r = await alta(s, 'cotizaciones', { productoId: 'PRD-0003', proveedorId: 'PRV-0002', paisOrigen: 'CN' })
    expect(r).toMatchObject({ tipo: 'conflicto' })
    expect(s.snapshot()).toEqual(antes)
  })
})

/* ------------------------------------------ Criterio 3 ------------------------------------------ */

const ctx = (): ContextoPegado => ({
  campos: CAMPOS['eco.cotizacion.crear'],
  productos: [{ id: 'PRD-0003', ideaId: 'EC-006', etapa: 'COTIZANDO' }, { id: 'PRD-0004', ideaId: 'EC-009', etapa: 'DESCARTADO' }],
  proveedores: [{ id: 'PRV-0001', nombre: 'Fábrica Uno, S.A.' }, { id: 'PRV-0002', nombre: 'Acrílicos Dos' }],
  cotizaciones: [{ id: 'COT-0001', productoId: 'PRD-0003', proveedorId: 'PRV-0001', incoterm: 'FOB', precioUnit: '2.4', moneda: 'USD' }],
})

const ENCABEZADO = `| ${COLUMNAS_TABLA_B.join(' | ')} |`
const SEP = `|${COLUMNAS_TABLA_B.map(() => '---').join('|')}|`
const fb = (celdas: string[]) => `| ${celdas.join(' | ')} |`
const VALIDA = [
  'Aquí está la tabla B:',
  ENCABEZADO, SEP,
  fb(['COT-0102', 'PRD-0003 / EC-006', 'Acrílicos Dos', 'RECIBIDA', '2026-11-04', '2.35 (DATO)', 'USD', '500', '20', 'FOB', 'CN', 'por confirmar', '6', '420', '20 %', '1,250.50', '35', 'USD', 'set de 6']),
  fb(['COT-0103', 'EC-006', 'acrilicos dos', 'RECIBIDA (PARCIAL)', '2026-11-04', '2.10', 'USD', '1,000', '25', 'EXW', 'CN', 'NO', '8', '[NV]', '20', '—', '—', '—', 'falta flete']),
].join('\n')

describe('criterio 3: «Pegar tabla de Gemini» (tabla B del Gem 3)', () => {
  it('tabla válida: un borrador por fila, con producto y proveedor resueltos y valores listos para el formulario', () => {
    const r = parsearTablaGemini(VALIDA, ctx())
    expect(r.error).toBeNull()
    expect(r.columnas.every((c) => c.destino !== null)).toBe(true)
    expect(r.borradores).toHaveLength(2)
    const [a, b] = r.borradores
    expect(a).toMatchObject({ reconocida: true, idGemini: 'COT-0102', duplicada: null, errores: {} })
    expect(a!.valores).toMatchObject({ productoId: 'PRD-0003', proveedorId: 'PRV-0002', estado: 'RECIBIDA', precioUnit: '2.35', moq: '500', igiPct: '20', certificadoOrigen: '', costoAterrizadoMxn: '1250.50' })
    expect(b!.valores).toMatchObject({ productoId: 'PRD-0003', estado: 'RECIBIDA', moq: '1000', notas: 'parcial. falta flete', fleteInternacional: '' })
    expect(b!.notas.join(' ')).toMatch(/EC-006 → PRD-0003.*|RECIBIDA con «parcial»/)
    expect(r.borradores.every(confirmable)).toBe(true)
  })

  it('nada se guarda sin confirmar; al confirmar una fila se guarda solo esa, por la ruta de alta', async () => {
    const s = servidor()
    const r = parsearTablaGemini(VALIDA, ctx())
    expect(s.llamadas).toHaveLength(0) // generar no envía nada
    const [a] = r.borradores
    // El propietario corrige el borrador antes de confirmar (p. ej. la fecha) y confirma solo esa fila.
    const res = await enviar('/api/eco/pipeline/cotizaciones', 'POST', cuerpo(CAMPOS['eco.cotizacion.crear'], { ...a!.valores, fechaRecibida: '2026-11-03' }, nuevoId), s.f)
    expect(res).toMatchObject({ tipo: 'ok', id: 'COT-0002' })
    expect(s.llamadas).toHaveLength(1)
    expect(s.tabla('PIPE_COTIZACIONES')).toHaveLength(2)
    expect(s.tabla('PIPE_COTIZACIONES')[1]).toMatchObject({ PROVEEDOR_ID: 'PRV-0002', ESTADO: 'RECIBIDA', FECHA_RECIBIDA: '2026-11-03', PRECIO_UNIT: '2.35', IGI_PCT: '20' })
  })

  it('tabla con errores: columnas y filas no reconocidas quedan marcadas y no se guardan; los valores malos, con su motivo', () => {
    const texto = [
      `| ${[...COLUMNAS_TABLA_B, 'MARGEN_ESTIMADO'].join(' | ')} |`, SEP,
      fb(['', 'PRD-0003', 'Proveedor Nuevo Ltd', 'RECIBIDA', '04/11/2026', '2.3', 'EUR', '500', '20', 'FOB', 'China', 'SI', '6', '400', '20', '', '', '', 'ok', '30 %']),
      fb(['', 'PRD-0004', 'Acrílicos Dos', 'SOLICITADA', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'x', '']),
      '| solo | tres | celdas |',
      fb(['', 'PRD-0003', 'Acrílicos Dos', 'SOLICITADA', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'ventas@proveedor.example', '']),
    ].join('\n')
    const r = parsearTablaGemini(texto, ctx())
    expect(r.columnas.filter((c) => c.destino === null).map((c) => c.texto)).toEqual(['MARGEN_ESTIMADO'])
    const [malos, descartado, corta, contacto] = r.borradores
    expect(malos!.errores).toMatchObject({ proveedorId: expect.stringContaining('no está en PIPE_PROVEEDORES'), fechaRecibida: expect.any(String), moneda: expect.any(String), paisOrigen: expect.any(String) })
    expect(malos!.valores).not.toHaveProperty('MARGEN_ESTIMADO')
    expect(descartado!.errores.productoId).toContain('descartado')
    expect(corta).toMatchObject({ reconocida: false, motivo: expect.stringContaining('3 celdas') })
    expect(contacto!.errores.notas).toBe('Sin correos ni teléfonos de personas.')
    expect(r.borradores.some(confirmable)).toBe(false)
    expect(parsearTablaGemini('texto sin tabla', ctx()).error).toMatch(/No se encontró la tabla B/)
  })

  it('fila duplicada: con la hoja (mismo ID o mismo producto, proveedor, incoterm, precio y moneda) o repetida en el pegado', () => {
    const texto = [ENCABEZADO, SEP,
      fb(['COT-0001', 'PRD-0003', 'Acrílicos Dos', 'SOLICITADA', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '']),
      fb(['', 'PRD-0003', 'FABRICA UNO S.A.', 'RECIBIDA', '2026-11-04', '2.40', 'USD', '500', '20', 'FOB', 'CN', 'NO', '6', '', '', '', '', '', '']),
      fb(['', 'PRD-0003', 'Acrílicos Dos', 'SOLICITADA', '', '1.9', 'USD', '', '', 'DDP', '', '', '', '', '', '', '', '', '']),
      fb(['', 'PRD-0003', 'ACRILICOS DOS', 'SOLICITADA', '', '1.90', 'USD', '', '', 'DDP', '', '', '', '', '', '', '', '', '']),
    ].join('\n')
    const [porId, porFirma, primera, repetida] = parsearTablaGemini(texto, ctx()).borradores
    expect(porId!.duplicada).toContain('COT-0001 ya existe')
    expect(porFirma!.duplicada).toContain('Igual a COT-0001')
    expect(primera!.duplicada).toBeNull()
    expect(confirmable(primera!)).toBe(true)
    expect(repetida!.duplicada).toMatch(/Igual a la fila de la línea 5 del pegado/)
    expect([porId, porFirma, repetida].some((b) => confirmable(b!))).toBe(false)
  })

  it('la pantalla no guarda al generar: solo «Confirmar y guardar esta fila» envía, una por una', () => {
    const src = readFileSync(path.join(__dirname, '..', 'src', 'components', 'eco', 'pegar-gemini.tsx'), 'utf8')
    expect(src.match(/enviar\(/g)).toHaveLength(1)
    expect(src).toMatch(/async function confirmar[\s\S]*if \(!confirmable\(\{ reconocida: true, \.\.\.r \}\)\) return[\s\S]*enviar\('\/api\/eco\/pipeline\/cotizaciones', 'POST'/)
    expect(src).toMatch(/function generar[^}]*setResultado\(parsearTablaGemini\(texto, contexto\)\)/)
    expect(src).not.toMatch(/fetch\(/)
  })
})

/* ------------------------------------------ Criterio 4 ------------------------------------------ */

describe('criterio 4: una sola lista de estados', () => {
  it('formulario, escritura y tabulador usan SOLICITADA · RECIBIDA · ELEGIDA · RECHAZADA', () => {
    expect([...ESTADOS_COTIZACION]).toEqual(['SOLICITADA', 'RECIBIDA', 'ELEGIDA', 'RECHAZADA'])
    expect(ESTADOS_TABULADOR).toBe(ESTADOS_COTIZACION)
    expect(ESTADOS_ESCRITURA).toBe(ESTADOS_COTIZACION)
    const estado = CAMPOS['eco.cotizacion.editar'].find((c) => c.clave === 'estado')!
    expect(estado.tipo).toEqual({ k: 'lista', valores: ESTADOS_COTIZACION })
  })

  it('el tabulador deja de marcar RECHAZADA como «Estado no válido»; una fila vieja no se reescribe, se marca', () => {
    const raw = libro()
    raw.PIPE_COTIZACIONES.push(fila(COT_COLS, { COTIZACION_ID: 'COT-0009', PRODUCTO_ID: 'PRD-0003', PROVEEDOR_ID: 'PRV-0002', ESTADO: 'RECHAZADA', VERSION: 1 }))
    raw.PIPE_COTIZACIONES.push(fila(COT_COLS, { COTIZACION_ID: 'COT-0010', PRODUCTO_ID: 'PRD-0003', PROVEEDOR_ID: 'PRV-0002', ESTADO: 'RECIBIDA (PARCIAL)', VERSION: 1 }))
    const vista = construirEco(raw as unknown as Parameters<typeof construirEco>[0], NOW.getTime())
    const filas = vista.tabulador.comparar('PRD-0003', 'EC-006').filas
    expect(filas.find((f) => f.id === 'COT-0009')!.estadoValido).toBe(true)
    expect(filas.find((f) => f.id === 'COT-0010')).toMatchObject({ estado: 'RECIBIDA (PARCIAL)', estadoValido: false })
  })
})

/* ------------------------------------------ Criterio 5 ------------------------------------------ */

describe('criterio 5: solo escribe la sesión del propietario', () => {
  it('con el token del PM (o cualquier Authorization) las altas responden 401 antes del servicio y nada se escribe', async () => {
    for (const authorization of [`Bearer ${PM_TOKEN}`, 'Bearer token-de-otro-agente']) {
      const s = servidor(true, { authorization })
      const antes = s.snapshot()
      const p = await alta(s, 'proveedores', { nombre: 'Moldes Tres', canal: 'ALIBABA', pais: 'CN' })
      const c = await alta(s, 'cotizaciones', { productoId: 'PRD-0003', proveedorId: 'PRV-0002' })
      for (const r of [p, c]) expect(r).toMatchObject({ tipo: 'error', mensaje: expect.stringMatching(/sesión|autentic/i) })
      expect(s.pedidos()).toBe(0)
      expect(s.snapshot()).toEqual(antes)
    }
  })

  it('docs: corrigen el texto de ORD-POS-145 sobre quién escribe cotizaciones', () => {
    const doc = readFileSync(path.join(__dirname, '..', '..', 'docs', 'diseno-eco-pipeline.md'), 'utf8')
    expect(doc).toMatch(/## 15\. Alta rápida de proveedores y cotizaciones \(ORD-POS-146/)
    expect(doc).toMatch(/«escribir cotizaciones \(sigue siendo del\nPM con «sí»\)»\. Ese texto no es correcto/)
  })
})

/* -------------------------------------- Pantalla (criterios 1 a 3) -------------------------------------- */

const estado = vi.hoisted(() => ({ result: null as unknown, email: 'lector@example.com' }))
vi.mock('@/lib/page-data', () => ({ privateEco: async () => ({ user: { email: estado.email }, result: estado.result }) }))
vi.mock('@/components/operations/write-access', () => ({ writeAccess: () => ({ allowed: false }) }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }))

describe('pantalla: «Alta rápida» solo para el escritor del pipeline', () => {
  afterEach(() => vi.unstubAllEnvs())

  async function pagina(email: string, vars: Record<string, string>) {
    for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v)
    estado.email = email
    estado.result = { estado: 'ok', vista: construirEco(libro() as unknown as Parameters<typeof construirEco>[0], NOW.getTime()), fetchedAt: NOW.getTime() } satisfies EcoResult
    const { default: PipelinePage } = await import('@/app/(private)/eco/pipeline/page')
    return renderToStaticMarkup(await PipelinePage({ searchParams: Promise.resolve({}) }))
  }

  it('el escritor ve proveedor, cotización con pistas de PIPE_PARAMETROS y «Pegar tabla de Gemini»', async () => {
    const h = await pagina(DUENO, ACTIVA)
    expect(h).toContain('id="alta-rapida"')
    expect(h).toContain('aria-label="Nuevo proveedor"')
    expect(h).toContain('aria-label="Pegar tabla de Gemini"')
    const ini = h.indexOf('aria-label="Nueva cotización"')
    const form = h.slice(ini, h.indexOf('</form>', ini))
    expect(form).toContain('TIPO_CAMBIO_USD_MXN = 18.5 (2026-11-04)')
    expect(form).toContain('name="igiPct"')
  })

  it('un lector, o el escritor con la escritura apagada, no ve el alta rápida', async () => {
    for (const [email, vars] of [['lector@example.com', ACTIVA], [DUENO, { ...ACTIVA, ECO_PIPELINE_WRITE_MODE: '' }]] as const) {
      const h = await pagina(email, vars)
      expect(h).not.toMatch(/alta-rapida|Pegar tabla de Gemini|aria-label="Nuevo proveedor"/)
    }
  })
})
