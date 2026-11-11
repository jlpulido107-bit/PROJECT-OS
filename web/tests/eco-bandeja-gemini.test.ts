import { readFileSync } from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from '../deploy/cloudrun/render.mjs'
import { BANDERAS } from '@/lib/banderas'
import { OperationError } from '@/lib/operations/errors'
import { RateLimiter } from '@/lib/operations/rate-limit'
import { createEcoLoader, type EcoResult } from '@/lib/radaros/data'
import { construirEco } from '@/lib/radaros/eco'
import {
  COLUMNAS_COTIZACIONES, COLUMNAS_EMBARQUES, COLUMNAS_MIGRACION_PROVEEDORES, COLUMNAS_PRODUCTOS, COLUMNAS_PROVEEDORES, construirPipeline,
} from '@/lib/radaros/pipeline'
import {
  COLUMNAS_BANDEJA, COLUMNAS_BANDEJA_ESCRIBIBLES, confirmableBandeja, ecoBandejaGeminiHabilitada, leerBandeja, migracionBandeja,
  propuestasBandeja, type BandejaVista,
} from '@/lib/radaros/pipeline-bandeja-gemini'
import { ecoPipelineWrite, type EcoHandlerDeps } from '@/lib/radaros/pipeline-escritura-handler'
import { COLUMNAS_AUDITORIA, EcoPipelineWriteService } from '@/lib/radaros/pipeline-escritura-service'
import { InMemoryEcoStore, type Celda, type CeldaCambio, type EcoStoreTab } from '@/lib/radaros/pipeline-escritura-store'
import { CAMPOS, parseBandejaConfirmar, parseBandejaRechazar, parseEco, parseIdRuta } from '@/lib/radaros/pipeline-escritura-validacion'
import type { ContextoPegado } from '@/lib/radaros/pipeline-pegado'
import { COLUMNAS_MIGRACION_COTIZACIONES } from '@/lib/radaros/pipeline-tabulador'

/**
 * Bandeja de Gemini (ORD-POS-155, POS-056; docs/diseno-eco-pipeline.md §18). Almacén en memoria y dobles de sesión y de
 * fetch: ninguna prueba toca Google. Productos, proveedores y precios inventados; los «datos personales» son de ejemplo.
 */

const ORIGIN = 'http://127.0.0.1:3000'
const DUENO = 'dueno@example.com'
const RADAROS = 'LIBRO_RADAROS_SINTETICO_0123456789'
// 2026-11-10 12:00 en Mérida (UTC−6).
const NOW = new Date(Date.UTC(2026, 10, 10, 18, 0, 0))
const ACTIVA: Record<string, string> = {
  NEXTAUTH_URL: ORIGIN,
  AUTH_ALLOWED_EMAILS: `lector@example.com, ${DUENO}`,
  SHEETS_SPREADSHEET_ID: '16UXe7fm90fOTTVJhI_RZ8__I876u2buvjeLGr5cJ-Ic',
  SHEETS_EXPECTED_SERVICE_ACCOUNT: 'project-os-dashboard-run@project-os-511102.iam.gserviceaccount.com',
  PROJECT_OS_WRITE_SERVICE_ACCOUNT: 'project-os-writer@project-os-511102.iam.gserviceaccount.com',
  RADAROS_SHEET_ID: RADAROS,
  ECO_PIPELINE_WRITE_MODE: 'sheets',
  ECO_PIPELINE_WRITE_SERVICE_ACCOUNT: 'project-os-eco@project-os-511102.iam.gserviceaccount.com',
  ECO_PIPELINE_WRITER_EMAIL: DUENO,
}
const CON_BANDEJA = { ...ACTIVA, ECO_BANDEJA_GEMINI: 'true' }
const env = (v: Record<string, string>) => v as unknown as NodeJS.ProcessEnv

/* ------------------------------------- Libro sintético ------------------------------------- */

type Rec = Record<string, Celda>
const fila = (cols: readonly string[], r: Rec): Celda[] => cols.map((c) => r[c] ?? '')
const PRV_HDR = [...COLUMNAS_PROVEEDORES, ...COLUMNAS_MIGRACION_PROVEEDORES]
const COT_HDR = [...COLUMNAS_COTIZACIONES, ...COLUMNAS_MIGRACION_COTIZACIONES]
const prd = (id: string, r: Rec = {}) => fila(COLUMNAS_PRODUCTOS, { PRODUCTO_ID: id, NOMBRE: `Producto ${id}`, ORIGEN: 'MANUAL', ETAPA: 'COTIZANDO', ETAPA_DESDE: '2026-11-01T09:00:00-06:00', VERSION: 1, ...r })
const prv = (id: string, nombre: string) => fila(PRV_HDR, { PROVEEDOR_ID: id, NOMBRE: nombre, CANAL: 'ALIBABA', PAIS: 'CN', ESTADO: 'ACTIVO', VERSION: 1 })
const cot = (id: string, r: Rec) => fila(COT_HDR, { COTIZACION_ID: id, PRODUCTO_ID: 'PRD-0001', PROVEEDOR_ID: 'PRV-0001', MUESTRA_ESTADO: 'NO_PEDIDA', VERSION: 1, ...r })
const ban = (id: string, r: Rec = {}) => fila(COLUMNAS_BANDEJA, {
  BANDEJA_ID: id, FECHA_CAPTURA: '2026-11-09', TIPO: 'COTIZACION', PRODUCTO_ID: 'PRD-0001', PROVEEDOR: 'Fábrica Uno', ESTADO: 'RECIBIDA',
  FECHA_RECIBIDA: '2026-11-09', PRECIO_UNIT: 2.5, MONEDA: 'USD', MOQ: 500, PLAZO_PRODUCCION_DIAS: 20, INCOTERM: 'FOB', PAIS_ORIGEN: 'CN',
  VERSION: 'gem3-v1', ESTADO_BANDEJA: 'PENDIENTE', NOTAS: 'Gemini: precio de la tabla B', ...r,
})

function libro(over: Partial<Record<string, unknown[][]>> = {}): Record<string, unknown[][]> {
  return {
    PIPE_PRODUCTOS: [[...COLUMNAS_PRODUCTOS], prd('PRD-0001'), prd('PRD-0002', { ETAPA: 'DESCARTADO' })],
    PIPE_PROVEEDORES: [PRV_HDR, prv('PRV-0001', 'Fábrica Uno')],
    PIPE_COTIZACIONES: [COT_HDR],
    PIPE_EMBARQUES: [[...COLUMNAS_EMBARQUES]],
    PIPE_AUDITORIA: [[...COLUMNAS_AUDITORIA]],
    PIPE_PARAMETROS: [['CLAVE', 'VALOR']],
    PIPE_BANDEJA_GEMINI: [[...COLUMNAS_BANDEJA], ban('BAN-0001'), ban('BAN-0002', { TIPO: 'PROVEEDOR', PROVEEDOR: 'Taller Dos', PAIS_ORIGEN: 'VN' })],
    ...over,
  }
}

let seq = 0
const rid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`
const CTX = { actor: DUENO }
const servicio = (s: InMemoryEcoStore) => new EcoPipelineWriteService(s, { clock: () => NOW, randomHex: () => 'abcd1234' })
const tabla = (s: InMemoryEcoStore, tab: string) => s.snapshot()[tab]!
const registro = (s: InMemoryEcoStore, tab: string, id: string): Record<string, unknown> => {
  const [header, ...rows] = tabla(s, tab)
  const row = rows.find((r) => r[0] === id)
  return row ? Object.fromEntries(header!.map((h, i) => [h, row[i] ?? ''])) : {}
}
const auditoria = (s: InMemoryEcoStore) => tabla(s, 'PIPE_AUDITORIA').slice(1).map((r) => Object.fromEntries(COLUMNAS_AUDITORIA.map((c, i) => [c, r[i] ?? ''])))

async function codigo(p: Promise<unknown>) {
  const e = await p.catch((x: unknown) => x)
  expect(e).toBeInstanceOf(OperationError)
  return e as OperationError
}

const COTIZACION = {
  tipo: 'COTIZACION', productoId: 'PRD-0001', proveedorId: 'PRV-0001', estado: 'RECIBIDA', fechaRecibida: '2026-11-09', precioPor: 'SET',
  precioUnit: '2.5', moneda: 'USD', moq: '500', plazoProduccionDias: '20', incoterm: 'FOB', notas: 'Gemini: precio de la tabla B',
}
const confirmar = (svc: EcoPipelineWriteService, id: string, body: Record<string, unknown>, requestId = rid()) =>
  svc.confirmarBandeja(id, parseBandejaConfirmar({ requestId, ...body }), CTX)
const rechazar = (svc: EcoPipelineWriteService, id: string, motivo: string, requestId = rid()) =>
  svc.rechazarBandeja(id, parseBandejaRechazar({ requestId, motivo }), CTX)

/** Celdas de la fila de la bandeja que no son ESTADO_BANDEJA, RESULTADO_ID ni NOTAS. */
const sinEscribibles = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).filter(([c]) => !COLUMNAS_BANDEJA_ESCRIBIBLES.includes(c)))

/* ------------------------------------------ Criterio 1 ------------------------------------------ */

describe('criterio 1: migración explícita e idempotente de PIPE_BANDEJA_GEMINI', () => {
  it('sin pestaña: encabezado completo en el orden de la orden (control, tabla B, trazabilidad, estado)', () => {
    const m = migracionBandeja(null)
    expect(m.crearPestana).toBe(true)
    expect(m.encabezado).toEqual([
      'BANDEJA_ID', 'FECHA_CAPTURA', 'TIPO', 'PRODUCTO_ID', 'PROVEEDOR',
      'ESTADO', 'FECHA_RECIBIDA', 'PRECIO_UNIT', 'MONEDA', 'MOQ', 'PLAZO_PRODUCCION_DIAS', 'INCOTERM', 'COSTO_ATERRIZADO_MXN',
      'MUESTRA_COSTO', 'MUESTRA_MONEDA', 'PAIS_ORIGEN', 'CERTIFICADO_ORIGEN', 'UNIDADES_POR_SET', 'FLETE_INTERNACIONAL', 'IGI_PCT',
      'VERSION', 'EVIDENCIA_URL', 'ESTADO_BANDEJA', 'RESULTADO_ID', 'NOTAS',
    ])
    // Las columnas de la tabla B siguen el orden de PIPE_COTIZACIONES.
    const orden = COT_HDR.filter((c) => m.encabezado.slice(5, 20).includes(c))
    expect(m.encabezado.slice(5, 20)).toEqual(orden)
  })

  it('idempotente: sobre su resultado no agrega nada; con columnas a medias solo agrega las que faltan, al final', () => {
    const completa = migracionBandeja(null).encabezado
    expect(migracionBandeja(completa)).toMatchObject({ crearPestana: false, faltan: [], encabezado: completa })
    const media = ['BANDEJA_ID', 'TIPO', 'EXTRA_DEL_PROPIETARIO', '', '']
    const m = migracionBandeja(media)
    expect(m.encabezado.slice(0, 3)).toEqual(['BANDEJA_ID', 'TIPO', 'EXTRA_DEL_PROPIETARIO'])
    expect(m.faltan).not.toContain('TIPO')
    expect(migracionBandeja(m.encabezado).faltan).toEqual([])
    expect(migracionBandeja(['BANDEJA_ID', 'BANDEJA_ID']).repetidos).toEqual(['BANDEJA_ID'])
  })
})

/* ---------------------------------- Lectura y criterio 4 ---------------------------------- */

const ctxPegado = (raw: Record<string, unknown[][]>): ContextoPegado => {
  const v = construirPipeline(raw, NOW.getTime())
  const tarjetas = v.productos.estado === 'ok' ? v.productos.datos.tarjetas : []
  return {
    campos: CAMPOS['eco.bandeja.cotizacion'], fleteCedisRef: null,
    productos: tarjetas.map((t) => ({ id: t.id, ideaId: t.fila.IDEA_ID ?? null, etapa: t.etapaTexto })),
    proveedores: v.proveedores.estado === 'ok' ? v.proveedores.datos.filas.map((p) => ({ id: p.PROVEEDOR_ID!, nombre: p.NOMBRE! })) : [],
    cotizaciones: v.cotizaciones.estado === 'ok' ? v.cotizaciones.datos.filas.map((c) => ({
      id: c.COTIZACION_ID!, productoId: c.PRODUCTO_ID ?? null, proveedorId: c.PROVEEDOR_ID ?? null, incoterm: c.INCOTERM ?? null, precioUnit: c.PRECIO_UNIT ?? null, moneda: c.MONEDA ?? null,
    })) : [],
  }
}
const ok = (b: BandejaVista) => {
  if (b.estado !== 'ok') throw new Error(`bandeja ${b.estado}`)
  return b
}

describe('lectura de la bandeja y criterio 4: datos personales y fórmulas', () => {
  it('pestaña ausente y columna faltante: se dice y se nombra la columna', () => {
    expect(leerBandeja(undefined)).toMatchObject({ estado: 'ausente' })
    expect(leerBandeja([COLUMNAS_BANDEJA.filter((c) => c !== 'RESULTADO_ID')])).toEqual({ estado: 'columnas-faltantes', faltan: ['RESULTADO_ID'], repetidas: [] })
  })

  it('columnas extra al final se aceptan; correo, teléfono o fórmula en cualquier celda marcan la fila y no se muestran', () => {
    const hdr = [...COLUMNAS_BANDEJA, 'EXTRA']
    const v = ok(leerBandeja([
      hdr,
      [...ban('BAN-0001'), 'libre'],
      [...ban('BAN-0002', { NOTAS: 'escribir a ventas.persona@example.com' }), ''],
      [...ban('BAN-0003', { PRECIO_UNIT: '=A1*2' }), ''],
      [...ban('BAN-0004'), '+52 999 123 4567'],
      ban('BAN-0001'),
    ]))
    expect(v.extra).toEqual(['EXTRA'])
    const [a, b, c, d, e] = v.filas
    expect(a!.bloqueos).toEqual(['BANDEJA_ID repetido en la pestaña'])
    expect(b!.bloqueos).toEqual(['NOTAS: parece correo o teléfono (sin datos personales)'])
    expect(b!.celdas.NOTAS).toBe('')
    expect(c!.bloqueos).toEqual(['PRECIO_UNIT: fórmula (solo valores escritos)'])
    expect(c!.celdas.PRECIO_UNIT).toBe('')
    expect(d!.bloqueos).toEqual(['EXTRA: parece correo o teléfono (sin datos personales)'])
    expect(e!.bloqueos).toContain('BANDEJA_ID repetido en la pestaña')
    // Fechas y ligas de Drive no son teléfonos por sus dígitos.
    expect(ok(leerBandeja([[...COLUMNAS_BANDEJA], ban('BAN-0009', { FECHA_CAPTURA: '2026-11-09 10:30:00', EVIDENCIA_URL: 'https://drive.google.com/file/d/1234567890123/view' })])).filas[0]!.bloqueos).toEqual([])
  })

  it('propuestas: los mismos chequeos de «Recibir varias» (proveedor por nombre, duplicada contra la hoja, producto descartado)', () => {
    const raw = libro({
      PIPE_COTIZACIONES: [COT_HDR, cot('COT-0001', { ESTADO: 'RECIBIDA', PRECIO_UNIT: 9, MONEDA: 'USD', INCOTERM: 'EXW' })],
      PIPE_BANDEJA_GEMINI: [[...COLUMNAS_BANDEJA], ban('BAN-0001'), ban('BAN-0002', { PRECIO_UNIT: 9, INCOTERM: 'EXW' }), ban('BAN-0003', { PRODUCTO_ID: 'PRD-0002' }),
        ban('BAN-0004', { PROVEEDOR: 'Desconocida SA' }), ban('BAN-0005', { TIPO: 'PROVEEDOR', PROVEEDOR: 'fabrica uno' }), ban('BAN-0006', { ESTADO_BANDEJA: 'CONFIRMADA' }),
        ban('BAN-0007', { NOTAS: 'tel 9991234567' })],
    })
    const r = propuestasBandeja(ok(leerBandeja(raw.PIPE_BANDEJA_GEMINI)), ctxPegado(raw))
    expect(r.pendientes.map((p) => p.fila.id)).toEqual(['BAN-0001', 'BAN-0002', 'BAN-0003', 'BAN-0004', 'BAN-0005', 'BAN-0007'])
    expect(r.confirmadas).toBe(1)
    const [uno, dos, tres, cuatro, cinco, siete] = r.pendientes
    // Sin PRECIO_POR en la tabla B: se pide antes de confirmar, como en el pegado.
    expect(uno!.tipo === 'COTIZACION' && uno!.borrador.errores).toEqual({ precioPor: 'Obligatorio.' })
    expect(uno!.tipo === 'COTIZACION' && uno!.borrador.valores.proveedorId).toBe('PRV-0001')
    expect(dos!.tipo === 'COTIZACION' && dos!.borrador.duplicada).toMatch(/COT-0001/)
    expect(tres!.tipo === 'COTIZACION' && tres!.borrador.errores.productoId).toMatch(/descartado/)
    expect(cuatro!.tipo === 'COTIZACION' && cuatro!.borrador.errores.proveedorId).toMatch(/no está en PIPE_PROVEEDORES/)
    expect(cinco!.tipo === 'PROVEEDOR' && cinco!.proveedor.existente).toBe('PRV-0001')
    expect(confirmableBandeja(siete!)).toBe(false)
    expect(siete!.fila.bloqueos).toEqual(['NOTAS: parece correo o teléfono (sin datos personales)'])
  })
})

/* ---------------------------------- Criterios 2, 3 y 7 ---------------------------------- */

describe('criterios 2, 3 y 7: confirmar y rechazar con el servicio de escritura', () => {
  it('confirmar una COTIZACION: alta con auditoría en PIPE_AUDITORIA y la fila CONFIRMADA con el ID; solo ESTADO_BANDEJA y RESULTADO_ID cambian', async () => {
    const s = new InMemoryEcoStore(RADAROS, libro())
    const antes = registro(s, 'PIPE_BANDEJA_GEMINI', 'BAN-0001')
    const r = await confirmar(servicio(s), 'BAN-0001', COTIZACION)
    expect(r).toMatchObject({ operacion: 'eco.bandeja.confirmar', id: 'COT-0001', repetida: false })
    expect(registro(s, 'PIPE_COTIZACIONES', 'COT-0001')).toMatchObject({ ESTADO: 'RECIBIDA', PRECIO_UNIT: 2.5, PRECIO_POR: 'SET', VERSION: 1 })
    const despues = registro(s, 'PIPE_BANDEJA_GEMINI', 'BAN-0001')
    expect(despues).toMatchObject({ ESTADO_BANDEJA: 'CONFIRMADA', RESULTADO_ID: 'COT-0001', NOTAS: 'Gemini: precio de la tabla B' })
    expect(sinEscribibles(despues)).toEqual(sinEscribibles(antes))
    expect(tabla(s, 'PIPE_BANDEJA_GEMINI')).toHaveLength(3)
    const aud = auditoria(s)
    expect(aud.filter((a) => a.ENTIDAD === 'PIPE_COTIZACIONES' && a.REGISTRO_ID === 'COT-0001').length).toBeGreaterThan(5)
    expect(aud.filter((a) => a.ENTIDAD === 'PIPE_BANDEJA_GEMINI').map((a) => [a.CAMPO, a.VALOR_ANTES, a.VALOR_DESPUES]))
      .toEqual([['ESTADO_BANDEJA', 'PENDIENTE', 'CONFIRMADA'], ['RESULTADO_ID', '', 'COT-0001']])
  })

  it('reintentar no duplica: mismo requestId, otro requestId y la marca que falló a medias', async () => {
    const s = new InMemoryEcoStore(RADAROS, libro())
    const svc = servicio(s)
    const id = rid()
    await confirmar(svc, 'BAN-0001', COTIZACION, id)
    expect(await confirmar(svc, 'BAN-0001', COTIZACION, id)).toMatchObject({ id: 'COT-0001', repetida: true })
    expect(await confirmar(svc, 'BAN-0001', COTIZACION)).toMatchObject({ id: 'COT-0001', repetida: true })
    expect(tabla(s, 'PIPE_COTIZACIONES')).toHaveLength(2)

    // La cotización se escribe y la marca de la bandeja falla: el reintento (con otro requestId) no crea otra.
    class FallaMarca extends InMemoryEcoStore {
      fallar = true
      async update(tab: EcoStoreTab, n: number, celdas: CeldaCambio[]) {
        if (this.fallar && tab === 'PIPE_BANDEJA_GEMINI') throw new Error('HTTP 500')
        return super.update(tab, n, celdas)
      }
    }
    const f = new FallaMarca(RADAROS, libro())
    const sf = servicio(f)
    expect((await codigo(confirmar(sf, 'BAN-0001', COTIZACION))).code).toBe('escritura-fallida')
    expect(tabla(f, 'PIPE_COTIZACIONES')).toHaveLength(2)
    expect(registro(f, 'PIPE_BANDEJA_GEMINI', 'BAN-0001').ESTADO_BANDEJA).toBe('PENDIENTE')
    // Mientras tanto no se puede rechazar: ya se escribió COT-0001 desde la fila.
    expect((await codigo(rechazar(sf, 'BAN-0001', 'otra idea'))).detail).toMatchObject({ id: 'COT-0001' })
    f.fallar = false
    expect(await confirmar(sf, 'BAN-0001', COTIZACION)).toMatchObject({ id: 'COT-0001' })
    expect(tabla(f, 'PIPE_COTIZACIONES')).toHaveLength(2)
    expect(registro(f, 'PIPE_BANDEJA_GEMINI', 'BAN-0001')).toMatchObject({ ESTADO_BANDEJA: 'CONFIRMADA', RESULTADO_ID: 'COT-0001' })
  })

  // CORRECCIÓN 1 (SEGUNDO H1): tras la marca fallida, el reintento con otro cuerpo termina la marca con el ID auditado.
  it('marca fallida y reintento con NOTAS distinto: CONFIRMADA con el ID original, una sola cotización y sin crear ni editar otra vez', async () => {
    class FallaMarca extends InMemoryEcoStore {
      fallar = true
      async update(tab: EcoStoreTab, n: number, celdas: CeldaCambio[]) {
        if (this.fallar && tab === 'PIPE_BANDEJA_GEMINI') throw new Error('HTTP 500')
        return super.update(tab, n, celdas)
      }
    }
    const f = new FallaMarca(RADAROS, libro())
    const sf = servicio(f)
    expect((await codigo(confirmar(sf, 'BAN-0001', COTIZACION))).code).toBe('escritura-fallida')
    f.fallar = false
    const crear = vi.spyOn(sf, 'crearCotizacion')
    const editar = vi.spyOn(sf, 'editarCotizacion')
    const r = await confirmar(sf, 'BAN-0001', { ...COTIZACION, notas: 'Corregido en pantalla', precioUnit: '2.4' })
    expect(r).toMatchObject({ operacion: 'eco.bandeja.confirmar', id: 'COT-0001' })
    expect(crear).not.toHaveBeenCalled()
    expect(editar).not.toHaveBeenCalled()
    expect(tabla(f, 'PIPE_COTIZACIONES')).toHaveLength(2)
    expect(registro(f, 'PIPE_COTIZACIONES', 'COT-0001')).toMatchObject({ PRECIO_UNIT: 2.5, NOTAS: 'Gemini: precio de la tabla B', VERSION: 1 })
    expect(registro(f, 'PIPE_BANDEJA_GEMINI', 'BAN-0001')).toMatchObject({ ESTADO_BANDEJA: 'CONFIRMADA', RESULTADO_ID: 'COT-0001' })
    expect(auditoria(f).filter((a) => a.ENTIDAD === 'PIPE_COTIZACIONES' && a.CAMPO === 'VERSION')).toHaveLength(1)

    // Lo mismo para un PROVEEDOR: un solo PRV-0002 y la fila CONFIRMADA con él.
    const p = new FallaMarca(RADAROS, libro())
    const sp = servicio(p)
    const PROVEEDOR = { tipo: 'PROVEEDOR', nombre: 'Taller Dos', canal: 'ALIBABA', pais: 'VN' }
    expect((await codigo(confirmar(sp, 'BAN-0002', PROVEEDOR))).code).toBe('escritura-fallida')
    p.fallar = false
    const crearPrv = vi.spyOn(sp, 'crearProveedor')
    expect(await confirmar(sp, 'BAN-0002', { ...PROVEEDOR, notas: 'Otra nota' })).toMatchObject({ id: 'PRV-0002' })
    expect(crearPrv).not.toHaveBeenCalled()
    expect(tabla(p, 'PIPE_PROVEEDORES')).toHaveLength(3)
    expect(registro(p, 'PIPE_BANDEJA_GEMINI', 'BAN-0002')).toMatchObject({ ESTADO_BANDEJA: 'CONFIRMADA', RESULTADO_ID: 'PRV-0002' })
  })

  // CORRECCIÓN 1 (SEGUNDO H2): rechazar y confirmar a la vez nunca deja RECHAZADA una fila desde la que se escribió.
  it('carrera rechazar + confirmar: el estado final es coherente en los dos órdenes', async () => {
    for (const orden of ['rechazar-primero', 'confirmar-primero'] as const) {
      const s = new InMemoryEcoStore(RADAROS, libro())
      const svc = servicio(s)
      const ops = orden === 'rechazar-primero'
        ? [rechazar(svc, 'BAN-0001', 'precio fuera de mercado'), confirmar(svc, 'BAN-0001', COTIZACION)]
        : [confirmar(svc, 'BAN-0001', COTIZACION), rechazar(svc, 'BAN-0001', 'precio fuera de mercado')]
      const res = await Promise.allSettled(ops)
      expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
      const fallida = res.find((x) => x.status === 'rejected') as PromiseRejectedResult
      expect((fallida.reason as OperationError).code).toBe('bandeja-no-pendiente')
      const fila = registro(s, 'PIPE_BANDEJA_GEMINI', 'BAN-0001')
      const cotizaciones = tabla(s, 'PIPE_COTIZACIONES').length - 1
      if (fila.ESTADO_BANDEJA === 'RECHAZADA') {
        expect(cotizaciones).toBe(0)
        expect(auditoria(s).filter((a) => a.ENTIDAD === 'PIPE_COTIZACIONES')).toEqual([])
      } else {
        expect(fila).toMatchObject({ ESTADO_BANDEJA: 'CONFIRMADA', RESULTADO_ID: 'COT-0001' })
        expect(cotizaciones).toBe(1)
      }
    }
  })

  /* ------------------------- ORD-POS-156: casos límite de rechazo y reintento ------------------------- */

  /**
   * Almacén con dos dobles: `fallarMarca` hace fallar el update de la bandeja (la marca), y `retener()` detiene la
   * siguiente lectura de solo PIPE_AUDITORIA DESPUÉS de leerla (Rechazar se queda con su lectura previa) hasta `soltar()`.
   */
  class Compuerta extends InMemoryEcoStore {
    fallarMarca = false
    private espera: Promise<void> | null = null
    private avisar: (() => void) | null = null
    soltar: () => void = () => undefined
    retener(): Promise<void> {
      this.espera = new Promise<void>((r) => { this.soltar = r })
      return new Promise<void>((r) => { this.avisar = r })
    }
    async read(tabs: readonly EcoStoreTab[]) {
      const out = await super.read(tabs)
      if (this.espera && tabs.length === 1 && tabs[0] === 'PIPE_AUDITORIA') {
        const e = this.espera
        this.espera = null
        this.avisar?.()
        await e
      }
      return out
    }
    async update(tab: EcoStoreTab, n: number, celdas: CeldaCambio[]) {
      if (this.fallarMarca && tab === 'PIPE_BANDEJA_GEMINI') throw new Error('HTTP 500')
      return super.update(tab, n, celdas)
    }
  }

  // Criterio 1 (SEGUNDO H1 + DELTA H-B de #346): el roll-forward de un Rechazar ya auditado no marca RECHAZADA una fila
  // desde la que ya se escribió una entidad.
  it('reintento de un Rechazar con marca fallida + Confirmar concurrente: bandeja-no-pendiente, nunca RECHAZADA con cotización', async () => {
    const s = new Compuerta(RADAROS, libro())
    const svc = servicio(s)
    const R = rid()
    // 1) El rechazo se audita, pero la celda no se escribe: la fila sigue PENDIENTE.
    s.fallarMarca = true
    expect((await codigo(rechazar(svc, 'BAN-0001', 'precio fuera de mercado', R))).code).toBe('escritura-fallida')
    s.fallarMarca = false
    expect(registro(s, 'PIPE_BANDEJA_GEMINI', 'BAN-0001').ESTADO_BANDEJA).toBe('PENDIENTE')
    // 2) El reintento del rechazo (mismo requestId) hace su chequeo previo con la auditoría sin cotización...
    const leida = s.retener()
    const reintento = rechazar(svc, 'BAN-0001', 'precio fuera de mercado', R).catch((e: unknown) => e)
    await leida
    // 3) ...mientras un Confirmar escribe COT-0001 y su marca falla (la fila sigue PENDIENTE).
    s.fallarMarca = true
    expect((await codigo(confirmar(svc, 'BAN-0001', COTIZACION))).code).toBe('escritura-fallida')
    s.fallarMarca = false
    expect(tabla(s, 'PIPE_COTIZACIONES')).toHaveLength(2)
    s.soltar()
    const e = await reintento
    expect(e).toBeInstanceOf(OperationError)
    expect([(e as OperationError).code, (e as OperationError).detail]).toEqual(['bandeja-no-pendiente', { estado: 'PENDIENTE', id: 'COT-0001' }])
    expect(registro(s, 'PIPE_BANDEJA_GEMINI', 'BAN-0001').ESTADO_BANDEJA).toBe('PENDIENTE')
    // La salida es terminar de confirmar: CONFIRMADA con COT-0001 y una sola cotización.
    expect(await confirmar(svc, 'BAN-0001', COTIZACION)).toMatchObject({ id: 'COT-0001' })
    expect(registro(s, 'PIPE_BANDEJA_GEMINI', 'BAN-0001')).toMatchObject({ ESTADO_BANDEJA: 'CONFIRMADA', RESULTADO_ID: 'COT-0001' })
    expect(tabla(s, 'PIPE_COTIZACIONES')).toHaveLength(2)
  })

  // Criterio 2 (SEGUNDO H2 de #346): la entidad auditada cambió de versión antes del reintento.
  it('marca fallida → edición de la cotización (VERSION 1→2) → el reintento de Confirmar termina CONFIRMADA sin tocar la cotización', async () => {
    const s = new Compuerta(RADAROS, libro())
    const svc = servicio(s)
    s.fallarMarca = true
    expect((await codigo(confirmar(svc, 'BAN-0001', COTIZACION))).code).toBe('escritura-fallida')
    s.fallarMarca = false
    await svc.editarCotizacion('COT-0001', { requestId: rid(), expectedVersion: 1, valores: { NOTAS: 'Editada en /eco/pipeline' } }, CTX)
    expect(registro(s, 'PIPE_COTIZACIONES', 'COT-0001')).toMatchObject({ VERSION: 2 })
    expect(await confirmar(svc, 'BAN-0001', COTIZACION)).toMatchObject({ operacion: 'eco.bandeja.confirmar', id: 'COT-0001' })
    expect(registro(s, 'PIPE_BANDEJA_GEMINI', 'BAN-0001')).toMatchObject({ ESTADO_BANDEJA: 'CONFIRMADA', RESULTADO_ID: 'COT-0001' })
    // La edición del propietario se conserva: no hay roll-forward ni vuelta atrás.
    expect(registro(s, 'PIPE_COTIZACIONES', 'COT-0001')).toMatchObject({ VERSION: 2, NOTAS: 'Editada en /eco/pipeline', PRECIO_UNIT: 2.5 })
    expect(tabla(s, 'PIPE_COTIZACIONES')).toHaveLength(2)

    // El alta cuyo append falló sí se completa (roll-forward): la fila no existe y se escribe la auditada.
    class FallaAlta extends Compuerta {
      fallarAlta = true
      async append(tab: Parameters<InMemoryEcoStore['append']>[0], rows: Celda[][]) {
        if (this.fallarAlta && tab === 'PIPE_COTIZACIONES') throw new Error('HTTP 500')
        return super.append(tab, rows)
      }
    }
    const a = new FallaAlta(RADAROS, libro())
    const sa = servicio(a)
    expect((await codigo(confirmar(sa, 'BAN-0001', COTIZACION))).code).toBe('escritura-fallida')
    expect(tabla(a, 'PIPE_COTIZACIONES')).toHaveLength(1)
    a.fallarAlta = false
    expect(await confirmar(sa, 'BAN-0001', { ...COTIZACION, notas: 'otra' })).toMatchObject({ id: 'COT-0001' })
    expect(registro(a, 'PIPE_COTIZACIONES', 'COT-0001')).toMatchObject({ VERSION: 1, NOTAS: 'Gemini: precio de la tabla B' })
    expect(registro(a, 'PIPE_BANDEJA_GEMINI', 'BAN-0001')).toMatchObject({ ESTADO_BANDEJA: 'CONFIRMADA', RESULTADO_ID: 'COT-0001' })
  })

  // Criterio 3 (SEGUNDO H3 de #346): un REGISTRO_ID de PIPE_AUDITORIA sin el patrón de su entidad no llega a un mensaje.
  it('ID auditado sin el patrón de su entidad: no aparece en el mensaje ni en el detalle, ni se usa como RESULTADO_ID', async () => {
    const s = new Compuerta(RADAROS, libro())
    s.fallarMarca = true
    expect((await codigo(confirmar(servicio(s), 'BAN-0001', COTIZACION))).code).toBe('escritura-fallida')
    // La pestaña de auditoría editada a mano: el ID de la cotización cambia por un correo.
    const datos = s.snapshot()
    const cambiar = (rows: unknown[][]) => rows.map((r) => r.map((c) => (c === 'COT-0001' ? 'a@b.mx' : c)))
    const m = new InMemoryEcoStore(RADAROS, { ...datos, PIPE_AUDITORIA: cambiar(datos.PIPE_AUDITORIA!), PIPE_COTIZACIONES: cambiar(datos.PIPE_COTIZACIONES!) })
    const svc = servicio(m)
    const r = await codigo(rechazar(svc, 'BAN-0001', 'otra idea'))
    expect(r.code).toBe('bandeja-no-pendiente')
    expect(JSON.stringify([r.message, r.detail, r.fields])).not.toMatch(/a@b\.mx/)
    const c = await codigo(confirmar(svc, 'BAN-0001', COTIZACION))
    expect(JSON.stringify([c.message, c.detail, c.fields])).not.toMatch(/a@b\.mx/)
    expect(registro(m, 'PIPE_BANDEJA_GEMINI', 'BAN-0001')).toMatchObject({ ESTADO_BANDEJA: 'PENDIENTE', RESULTADO_ID: '' })
  })

  // Criterio 4 (DELTA H-A de #346): el chequeo de Rechazar dentro de `exclusive` (marcarBandeja), no solo el previo.
  it('Rechazar con la lectura previa retenida: el chequeo dentro de exclusive ve la cotización escrita y no marca RECHAZADA', async () => {
    const s = new Compuerta(RADAROS, libro())
    const svc = servicio(s)
    const leida = s.retener()
    const rechazo = rechazar(svc, 'BAN-0001', 'precio fuera de mercado').catch((e: unknown) => e)
    await leida
    // Con la lectura de Rechazar retenida (auditoría sin cotización), Confirmar escribe COT-0001 y su marca falla.
    s.fallarMarca = true
    expect((await codigo(confirmar(svc, 'BAN-0001', COTIZACION))).code).toBe('escritura-fallida')
    s.fallarMarca = false
    s.soltar()
    const e = await rechazo
    expect(e).toBeInstanceOf(OperationError)
    expect([(e as OperationError).code, (e as OperationError).detail]).toEqual(['bandeja-no-pendiente', { estado: 'PENDIENTE', id: 'COT-0001' }])
    expect(registro(s, 'PIPE_BANDEJA_GEMINI', 'BAN-0001').ESTADO_BANDEJA).toBe('PENDIENTE')
    expect(auditoria(s).filter((a) => a.ENTIDAD === 'PIPE_BANDEJA_GEMINI' && a.VALOR_DESPUES === 'RECHAZADA')).toEqual([])
  })

  // CORRECCIÓN 1 (PRIMERO H1, SEGUNDO H3): los errores no repiten celdas de la hoja fuera de la lista cerrada.
  it('bandeja-no-pendiente y TIPO: sin valores de la hoja que no sean de la lista cerrada', async () => {
    const s = new InMemoryEcoStore(RADAROS, libro({
      PIPE_BANDEJA_GEMINI: [[...COLUMNAS_BANDEJA],
        ban('BAN-0001', { ESTADO_BANDEJA: 'a@b.mx' }), ban('BAN-0003', { TIPO: '9991234567' }),
        ban('BAN-0004', { ESTADO_BANDEJA: 'RECHAZADA' }), ban('BAN-0006', { TIPO: 'PROVEEDOR' })],
    }))
    const svc = servicio(s)
    const estado = await codigo(confirmar(svc, 'BAN-0001', COTIZACION))
    expect([estado.code, estado.detail]).toEqual(['bandeja-no-pendiente', {}])
    const tipo = await codigo(confirmar(svc, 'BAN-0003', COTIZACION))
    expect(tipo.fields).toEqual({ tipo: 'La fila BAN-0003 es de un tipo no válido.' })
    for (const e of [estado, tipo]) expect(JSON.stringify([e.message, e.detail, e.fields])).not.toMatch(/a@b\.mx|9991234567/)
    // Los valores de la lista cerrada sí se nombran.
    expect((await codigo(confirmar(svc, 'BAN-0004', COTIZACION))).detail).toEqual({ estado: 'RECHAZADA' })
    expect((await codigo(confirmar(svc, 'BAN-0006', COTIZACION))).fields).toEqual({ tipo: 'La fila BAN-0006 es de tipo PROVEEDOR.' })
  })

  it('actualiza la única SOLICITADA del mismo producto y proveedor (como «Recibir»); una igual es cotizacion-duplicada', async () => {
    const s = new InMemoryEcoStore(RADAROS, libro({ PIPE_COTIZACIONES: [COT_HDR, cot('COT-0007', { ESTADO: 'SOLICITADA', FECHA_SOLICITUD: '2026-11-01', VERSION: 3 })] }))
    expect(await confirmar(servicio(s), 'BAN-0001', COTIZACION)).toMatchObject({ id: 'COT-0007' })
    expect(registro(s, 'PIPE_COTIZACIONES', 'COT-0007')).toMatchObject({ ESTADO: 'RECIBIDA', PRECIO_UNIT: 2.5, FECHA_SOLICITUD: '2026-11-01', VERSION: 4 })
    expect(tabla(s, 'PIPE_COTIZACIONES')).toHaveLength(2)

    const d = new InMemoryEcoStore(RADAROS, libro({ PIPE_COTIZACIONES: [COT_HDR, cot('COT-0003', { ESTADO: 'RECIBIDA', PRECIO_UNIT: 2.5, MONEDA: 'USD', INCOTERM: 'FOB' })] }))
    const e = await codigo(confirmar(servicio(d), 'BAN-0001', COTIZACION))
    expect([e.code, e.detail]).toEqual(['cotizacion-duplicada', { id: 'COT-0003' }])
    expect(registro(d, 'PIPE_BANDEJA_GEMINI', 'BAN-0001').ESTADO_BANDEJA).toBe('PENDIENTE')
  })

  it('confirmar un PROVEEDOR: alta con crearProveedor, o se liga al que ya existe con ese nombre sin duplicarlo', async () => {
    const s = new InMemoryEcoStore(RADAROS, libro())
    const svc = servicio(s)
    expect(await confirmar(svc, 'BAN-0002', { tipo: 'PROVEEDOR', nombre: 'Taller Dos', canal: 'ALIBABA', pais: 'VN' })).toMatchObject({ id: 'PRV-0002' })
    expect(registro(s, 'PIPE_PROVEEDORES', 'PRV-0002')).toMatchObject({ NOMBRE: 'Taller Dos', ESTADO: 'ACTIVO' })
    const l = new InMemoryEcoStore(RADAROS, libro({ PIPE_BANDEJA_GEMINI: [[...COLUMNAS_BANDEJA], ban('BAN-0005', { TIPO: 'PROVEEDOR', PROVEEDOR: 'FABRICA UNO' })] }))
    expect(await confirmar(servicio(l), 'BAN-0005', { tipo: 'PROVEEDOR', nombre: 'FABRICA UNO', canal: 'ALIBABA', pais: 'CN' })).toMatchObject({ id: 'PRV-0001' })
    expect(tabla(l, 'PIPE_PROVEEDORES')).toHaveLength(2)
    expect(registro(l, 'PIPE_BANDEJA_GEMINI', 'BAN-0005')).toMatchObject({ ESTADO_BANDEJA: 'CONFIRMADA', RESULTADO_ID: 'PRV-0001' })
    // Ya confirmada: otro intento responde «repetida» con su ID. El tipo del cuerpo debe ser el de la fila.
    expect(await confirmar(servicio(l), 'BAN-0005', { tipo: 'PROVEEDOR', nombre: 'FABRICA UNO', canal: 'ALIBABA', pais: 'CN' })).toMatchObject({ id: 'PRV-0001', repetida: true })
    expect((await codigo(confirmar(servicio(s), 'BAN-0001', { tipo: 'PROVEEDOR', nombre: 'X', canal: 'OTRO', pais: 'MX' }))).code).toBe('validacion')
  })

  it('rechazar: RECHAZADA con el motivo al final de NOTAS, sin borrar; repetida con el mismo requestId; después no se confirma', async () => {
    const s = new InMemoryEcoStore(RADAROS, libro())
    const svc = servicio(s)
    const id = rid()
    expect(await rechazar(svc, 'BAN-0001', 'precio fuera de mercado', id)).toMatchObject({ operacion: 'eco.bandeja.rechazar', id: 'BAN-0001', repetida: false })
    expect(registro(s, 'PIPE_BANDEJA_GEMINI', 'BAN-0001')).toMatchObject({
      ESTADO_BANDEJA: 'RECHAZADA', RESULTADO_ID: '', NOTAS: 'Gemini: precio de la tabla B\nRechazada: precio fuera de mercado',
    })
    expect(await rechazar(svc, 'BAN-0001', 'precio fuera de mercado', id)).toMatchObject({ repetida: true })
    expect(registro(s, 'PIPE_BANDEJA_GEMINI', 'BAN-0001').NOTAS).toBe('Gemini: precio de la tabla B\nRechazada: precio fuera de mercado')
    expect((await codigo(confirmar(svc, 'BAN-0001', COTIZACION))).code).toBe('bandeja-no-pendiente')
    expect(tabla(s, 'PIPE_COTIZACIONES')).toHaveLength(1)
    expect(tabla(s, 'PIPE_BANDEJA_GEMINI')).toHaveLength(3)
    expect(auditoria(s).filter((a) => a.ENTIDAD === 'PIPE_BANDEJA_GEMINI').map((a) => a.CAMPO)).toEqual(['ESTADO_BANDEJA', 'NOTAS'])
    // Motivo obligatorio, sin datos personales ni fórmulas.
    for (const motivo of ['', 'llamar al 9991234567', '=HYPERLINK("x")']) expect(() => parseBandejaRechazar({ requestId: rid(), motivo })).toThrow(OperationError)
  })

  it('criterio 4: una fila con correo, teléfono o fórmula no se confirma y no se escribe nada', async () => {
    const correo = new InMemoryEcoStore(RADAROS, libro({ PIPE_BANDEJA_GEMINI: [[...COLUMNAS_BANDEJA], ban('BAN-0001', { PROVEEDOR: 'ventas@fabrica.example' })] }))
    const e = await codigo(confirmar(servicio(correo), 'BAN-0001', COTIZACION))
    expect([e.code, e.detail]).toEqual(['bandeja-bloqueada', { columnas: 'PROVEEDOR' }])
    const formula = new InMemoryEcoStore(RADAROS, libro())
    formula.formulasHoja.set('PIPE_BANDEJA_GEMINI!2!7', '=B2*3')
    expect((await codigo(confirmar(servicio(formula), 'BAN-0001', COTIZACION))).detail).toEqual({ columnas: 'PRECIO_UNIT' })
    for (const st of [correo, formula]) {
      expect(tabla(st, 'PIPE_COTIZACIONES')).toHaveLength(1)
      expect(auditoria(st)).toEqual([])
      expect(registro(st, 'PIPE_BANDEJA_GEMINI', 'BAN-0001').ESTADO_BANDEJA).toBe('PENDIENTE')
    }
    // El cuerpo confirmado tampoco lleva correos ni teléfonos.
    expect(() => parseBandejaConfirmar({ requestId: rid(), ...COTIZACION, notas: 'tel 9991234567' })).toThrow(OperationError)
  })

  it('criterio 3: el almacén nunca agrega filas a la bandeja y el servicio no escribe otras columnas', async () => {
    const s = new InMemoryEcoStore(RADAROS, libro())
    await expect(s.append('PIPE_BANDEJA_GEMINI' as never, [['x']])).rejects.toThrow(/no admite filas nuevas/)
    expect(COLUMNAS_BANDEJA_ESCRIBIBLES).toEqual(['ESTADO_BANDEJA', 'RESULTADO_ID', 'NOTAS'])
    const src = readFileSync(path.join(__dirname, '..', 'src', 'lib', 'radaros', 'pipeline-escritura-service.ts'), 'utf8')
    expect(src).toContain("if (Object.keys(cambios).some((c) => !COLUMNAS_BANDEJA_ESCRIBIBLES.includes(c))) throw")
    expect(parseIdRuta('BAN', 'BAN-0001')).toBe('BAN-0001')
    expect(() => parseIdRuta('BAN', 'COT-0001')).toThrow(OperationError)
  })
})

/* ------------------------------------------ Criterio 5 ------------------------------------------ */

describe('criterio 5: PIPE_COTIZACIONES y PIPE_PROVEEDORES por nombre, con columnas extra y la faltante nombrada', () => {
  it('columnas extra al final: la lectura y la escritura funcionan y la celda extra queda vacía', async () => {
    const raw = libro({
      PIPE_PROVEEDORES: [[...PRV_HDR, 'NOTA_PROPIETARIO'], [...prv('PRV-0001', 'Fábrica Uno'), 'a mano']],
      PIPE_COTIZACIONES: [[...COT_HDR, 'MI_COLUMNA'], [...cot('COT-0001', { ESTADO: 'SOLICITADA' }), 'x']],
    })
    const v = construirPipeline(raw, NOW.getTime())
    expect(v.proveedores.estado).toBe('ok')
    expect(v.cotizaciones.estado).toBe('ok')
    const s = new InMemoryEcoStore(RADAROS, raw)
    const r = await servicio(s).crearProveedor(parseEco('eco.proveedor.crear', { requestId: rid(), nombre: 'Taller Tres', canal: 'OTRO', pais: 'MX' }), CTX)
    expect(registro(s, 'PIPE_PROVEEDORES', r.id)).toMatchObject({ NOMBRE: 'Taller Tres', NOTA_PROPIETARIO: '' })
    expect(await confirmar(servicio(s), 'BAN-0001', COTIZACION)).toMatchObject({ id: 'COT-0001' })
  })

  it('una columna requerida que falta se nombra en la lectura y en el mensaje de la escritura', async () => {
    const sinMoneda = COT_HDR.filter((c) => c !== 'MONEDA')
    const raw = libro({ PIPE_COTIZACIONES: [sinMoneda], PIPE_PROVEEDORES: [PRV_HDR.filter((c) => c !== 'ESTADO')] })
    expect(construirPipeline(raw, NOW.getTime()).proveedores).toMatchObject({ estado: 'columnas-faltantes', faltan: ['ESTADO'] })
    const s = new InMemoryEcoStore(RADAROS, raw)
    const e = await codigo(servicio(s).crearProveedor(parseEco('eco.proveedor.crear', { requestId: rid(), nombre: 'Taller', canal: 'OTRO', pais: 'MX' }), CTX))
    expect([e.code, e.detail]).toEqual(['eco-esquema-invalido', { pestana: 'PIPE_PROVEEDORES', columnas: 'ESTADO' }])
    // Por la ruta: el mensaje nombra la pestaña y la columna.
    const res = await ecoPipelineWrite(peticion({ requestId: rid(), nombre: 'Taller', canal: 'OTRO', pais: 'MX' }), deps(ACTIVA, s), 'eco.proveedor.crear',
      (svc, body, ctx) => svc.crearProveedor(parseEco('eco.proveedor.crear', body), ctx))
    expect(res.status).toBe(400)
    expect((res.body.error as { mensaje: string }).mensaje).toContain('PIPE_PROVEEDORES no tiene la columna ESTADO')
  })
})

/* ---------------------------------- Criterio 6: inerte ---------------------------------- */

function peticion(body: unknown) {
  return new Request(`${ORIGIN}/api/eco/pipeline/bandeja/BAN-0001/confirmar`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'x-project-os-csrf': '1', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
function deps(vars: Record<string, string>, store: InMemoryEcoStore, extra: Partial<EcoHandlerDeps> = {}): EcoHandlerDeps {
  return { sessionEmail: async () => DUENO, env: env(vars), limiter: new RateLimiter(100, 1), service: () => servicio(store), ...extra }
}

describe('criterio 6: todo inerte sin ECO_BANDEJA_GEMINI=true', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('la bandera solo vale con «true» exacto y está en BANDERAS', () => {
    expect(ecoBandejaGeminiHabilitada(env({}))).toBe(false)
    for (const v of ['TRUE', '1', 'si', ' true']) expect(ecoBandejaGeminiHabilitada(env({ ECO_BANDEJA_GEMINI: v }))).toBe(false)
    expect(ecoBandejaGeminiHabilitada(env({ ECO_BANDEJA_GEMINI: 'true' }))).toBe(true)
    expect(BANDERAS.ECO_BANDEJA_GEMINI!.encendida(env({}))).toBe(false)
  })

  it('apagada: 403 operacion-no-permitida sin leer la sesión ni el cuerpo, sin pedir el servicio y sin escribir', async () => {
    const s = new InMemoryEcoStore(RADAROS, libro())
    const sessionEmail = vi.fn(async () => DUENO)
    const service = vi.fn(() => servicio(s))
    const run = (svc: EcoPipelineWriteService, body: unknown, ctx: { actor: string }) => svc.confirmarBandeja('BAN-0001', parseBandejaConfirmar(body), ctx)
    const res = await ecoPipelineWrite(peticion({ requestId: rid(), ...COTIZACION }), deps(ACTIVA, s, { sessionEmail, service, habilitada: ecoBandejaGeminiHabilitada }), 'eco.bandeja.confirmar', run, 200)
    expect(res.status).toBe(403)
    expect((res.body.error as { codigo: string }).codigo).toBe('operacion-no-permitida')
    expect(sessionEmail).not.toHaveBeenCalled()
    expect(service).not.toHaveBeenCalled()
    expect(s.snapshot()).toEqual(new InMemoryEcoStore(RADAROS, libro()).snapshot())
    // Encendida: la misma petición confirma.
    const on = await ecoPipelineWrite(peticion({ requestId: rid(), ...COTIZACION }), deps(CON_BANDEJA, s, { habilitada: ecoBandejaGeminiHabilitada }), 'eco.bandeja.confirmar', run, 200)
    expect([on.status, on.body.id]).toEqual([200, 'COT-0001'])
  })

  it('las dos rutas pasan la bandera a handleEcoWrite', () => {
    for (const a of ['confirmar', 'rechazar']) {
      const src = readFileSync(path.join(__dirname, '..', 'src', 'app', 'api', 'eco', 'pipeline', 'bandeja', '[id]', a, 'route.ts'), 'utf8')
      expect(src).toMatch(/, 200, ecoBandejaGeminiHabilitada\)/)
      expect(src).not.toMatch(/export (async )?function (GET|PUT|PATCH|DELETE)/)
    }
  })

  it('apagada: el lector no pide la pestaña; encendida, la pide aparte con valueRenderOption=FORMULA', async () => {
    const urls: string[] = []
    const fetchImpl = (async (url: string) => {
      urls.push(url)
      if (url.includes('?fields=')) return Response.json({ sheets: ['PIPE_PRODUCTOS', 'PIPE_BANDEJA_GEMINI'].map((title) => ({ properties: { title } })) })
      const n = new URL(url).searchParams.getAll('ranges').length
      const bandeja = url.includes('PIPE_BANDEJA_GEMINI')
      return Response.json({ valueRanges: Array.from({ length: n }, () => ({ values: bandeja ? [[...COLUMNAS_BANDEJA], ban('BAN-0001')] : [[...COLUMNAS_PRODUCTOS]] })) })
    }) as typeof fetch
    const cargar = async (vars: Record<string, string>) => {
      urls.length = 0
      const r = await createEcoLoader({ env: env(vars), getAccessToken: async () => 't', fetchImpl, now: () => NOW.getTime(), generacion: () => 0 }).load()
      if (r.estado !== 'ok') throw new Error(r.estado)
      return r.vista.bandejaGemini
    }
    expect(await cargar(ACTIVA)).toEqual({ estado: 'apagada' })
    expect(urls.some((u) => u.includes('PIPE_BANDEJA_GEMINI') && u.includes('values'))).toBe(false)
    const b = await cargar(CON_BANDEJA)
    expect(b.estado === 'ok' && b.filas.map((f) => f.id)).toEqual(['BAN-0001'])
    expect(urls.filter((u) => u.includes('PIPE_BANDEJA_GEMINI')).every((u) => u.includes('valueRenderOption=FORMULA'))).toBe(true)
  })

  it('render.mjs: ECO_BANDEJA_GEMINI solo admite true y exige la escritura del pipeline', () => {
    const plantilla = readFileSync(path.join(__dirname, '..', 'deploy', 'cloudrun', 'service.template.yaml'), 'utf8')
    const base: Record<string, string> = {
      SERVICE_NAME: 'project-os-dashboard', PROJECT_ID: 'project-os-511102', REGION: 'northamerica-south1',
      IMAGE: `us-docker.pkg.dev/project-os-511102/repo/dash@sha256:${'a'.repeat(64)}`,
      RUNTIME_SA: ACTIVA.SHEETS_EXPECTED_SERVICE_ACCOUNT!, SERVICE_URL: 'https://dash.example.com',
      OAUTH_CLIENT_ID: '123-abc.apps.googleusercontent.com', SECRET_VERSION_NEXTAUTH: '1', SECRET_VERSION_OAUTH: '1', SECRET_VERSION_ALLOWLIST: '1',
      RADAROS_SHEET_ID: RADAROS,
    }
    const eco = { ECO_PIPELINE_WRITE_MODE: 'sheets', ECO_PIPELINE_WRITE_SERVICE_ACCOUNT: ACTIVA.ECO_PIPELINE_WRITE_SERVICE_ACCOUNT!, ECO_PIPELINE_WRITER_EMAIL: DUENO }
    const intento = (vars: Record<string, string>) => {
      try {
        return render(plantilla, { ...base, ...vars })
      } catch (e) {
        return (e as Error).message
      }
    }
    expect(intento({ ECO_BANDEJA_GEMINI: 'TRUE' })).toContain('ECO_BANDEJA_GEMINI solo admite true')
    expect(intento({ ECO_BANDEJA_GEMINI: 'true' })).toContain('ECO_BANDEJA_GEMINI exige ECO_PIPELINE_WRITE_MODE=sheets')
    expect(intento({})).not.toContain('ECO_BANDEJA_GEMINI')
    const con = intento({ ...eco, ECO_BANDEJA_GEMINI: 'true' })
    expect(con).toContain("            - name: ECO_BANDEJA_GEMINI\n              value: 'true'\n")
    expect(con.replace("            - name: ECO_BANDEJA_GEMINI\n              value: 'true'\n", '')).toBe(intento(eco))
  })
})

/* -------------------------------- Pantalla: Compras > Bandeja -------------------------------- */

const estado = vi.hoisted(() => ({ result: null as unknown, email: 'lector@example.com' }))
vi.mock('@/lib/page-data', () => ({ privateEco: async () => ({ user: { email: estado.email }, result: estado.result }) }))
vi.mock('@/components/operations/write-access', () => ({ writeAccess: () => ({ allowed: false }) }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }))

describe('Compras > Bandeja: solo con la bandera y para el escritor', () => {
  afterEach(() => vi.unstubAllEnvs())
  const raw = libro()

  async function pagina(email: string, vars: Record<string, string>, b: BandejaVista) {
    for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v)
    estado.email = email
    estado.result = { estado: 'ok', vista: construirEco(raw, NOW.getTime(), b), fetchedAt: NOW.getTime() } satisfies EcoResult
    const { default: PipelinePage } = await import('@/app/(private)/eco/pipeline/page')
    return renderToStaticMarkup(await PipelinePage({ searchParams: Promise.resolve({ seccion: 'bandeja' }) }))
  }

  it('apagada (o lector): ni enlace ni sección', async () => {
    for (const [email, vars] of [[DUENO, ACTIVA], ['lector@example.com', CON_BANDEJA]] as const) {
      const h = await pagina(email, vars, leerBandeja(raw.PIPE_BANDEJA_GEMINI))
      expect(h).not.toContain('seccion=bandeja')
      expect(h).not.toContain('Bandeja de Gemini')
      expect(h).not.toContain('BAN-0001')
    }
  })

  it('encendida para el escritor: las filas PENDIENTE con Confirmar y Rechazar; una bloqueada sin Confirmar', async () => {
    const b = leerBandeja([[...COLUMNAS_BANDEJA], ban('BAN-0001'), ban('BAN-0003', { NOTAS: 'ventas@fabrica.example' }), ban('BAN-0004', { ESTADO_BANDEJA: 'RECHAZADA' })])
    const h = await pagina(DUENO, CON_BANDEJA, b)
    expect(h).toContain('href="/eco/pipeline?seccion=bandeja#bandeja"')
    expect(h).toContain('Bandeja de Gemini')
    expect(h).toContain('1 rechazadas')
    expect(h).toContain('aria-label="Confirmar BAN-0001"')
    expect(h).toContain('aria-label="Rechazar BAN-0001"')
    expect(h).toContain('NOTAS: parece correo o teléfono')
    expect(h).not.toContain('ventas@fabrica.example')
    expect(h).not.toContain('BAN-0004')
    const bloque = h.slice(h.indexOf('BAN-0003'))
    expect(bloque.slice(0, bloque.indexOf('aria-label="Rechazar BAN-0003"'))).not.toContain('>Confirmar<')
  })

  it('columna faltante en la bandeja: se nombra', async () => {
    const h = await pagina(DUENO, CON_BANDEJA, leerBandeja([COLUMNAS_BANDEJA.filter((c) => c !== 'TIPO')]))
    expect(h).toContain('falta la columna TIPO')
  })
})
