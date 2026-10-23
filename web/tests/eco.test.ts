import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { render } from '../deploy/cloudrun/render.mjs'
import { radarosConfig as radarosConfigEnv, radarosSheetId as radarosSheetIdEnv } from '@/lib/config'
import { createEcoLoader } from '@/lib/radaros/data'
import { construirEco, ECO_TABS, filtrarTendencias, semanaIsoMerida } from '@/lib/radaros/eco'
import { MAX_DATA_ROWS } from '@/lib/schema'

const radarosConfig = (env: Record<string, string>) => radarosConfigEnv(env as unknown as NodeJS.ProcessEnv)
const radarosSheetId = (env: Record<string, string>) => radarosSheetIdEnv(env as unknown as NodeJS.ProcessEnv)

/** /eco (ORD-POS-067, docs/diseno-eco-radaros.md): solo dobles de fetch y de token, nunca red real. */

const PROPIA = '16UXe7fm90fOTTVJhI_RZ8__I876u2buvjeLGr5cJ-Ic'
const RADAROS = 'LIBRO_RADAROS_SINTETICO_0123456789'
const NOW = Date.UTC(2026, 9, 21, 15, 0, 0) // miércoles 2026-10-21, semana 2026-W43

const CORRIDAS = [
  ['CORRIDA_ID', 'SEMANA', 'MARKETPLACE', 'INICIO', 'FIN', 'ESTADO', 'MENSAJE', 'KEEPA_TOKENS_CONSUMIDOS', 'KEEPA_TOKENS_RESTANTES'],
  ['2026-W42|MX|1', '2026-W42', 'MX', '2026-10-12 06:00:00', '2026-10-12 06:05:00', 'OK', 'bien', '30', '270'],
  ['2026-W43|MX|1', '2026-W43', 'MX', '2026-10-19 06:00:00', '2026-10-19 06:01:00', 'INERTE', 'x'.repeat(300), '0', '300'],
]
const SCORING = [
  ['IDEA_ID', 'NOMBRE', 'PUNTUACION_FINAL', 'AMZ_SEMANA', 'AMZ_DEMANDA_BSR_AVG90', 'AMZ_ESTADO', 'COSTO_SECRETO'],
  ['EC-004', 'Idea 4', '55', '2026-W42', '1200', 'OK', 'no-mostrar'],
  ['EC-005', 'Idea 5', '81,5', '2026-W42', '800', 'OK', 'no-mostrar'],
  ['EC-006', 'Idea 6', '', '', '', '', ''],
]
const RESUMEN = [
  ['SEMANA', 'MARKETPLACE', 'IDEA_ID', 'ASINS_USADOS', 'ESTADO'],
  ['2026-W41', 'MX', 'EC-005', '2', 'OK'],
  ['2026-W42', 'MX', 'EC-005', '2', 'PARCIAL'],
]
const UNIT = [['IDEA_ID', 'AMZ_ASIN_REF', 'AMZ_PRECIO_MXN', 'COSTO_PRODUCTO'], ['EC-004', 'B000000001', '$499.00', '120']]
const TRENDS = [
  ['KEYWORD', 'SEMANAS_DISTINTAS', 'PRIMERA_SEMANA', 'ULTIMA_SEMANA', 'ESTADO', 'ETIQUETA_PRELIMINAR', 'POSICION_ULTIMA', 'URL'],
  ['termo', '3', '2026-W40', '2026-W42', 'RECURRENTE', 'COMERCIALIZABLE', '4', 'https://example.com/a'],
  ['lampara', '1', '2026-W42', '2026-W42', 'UNA_SEMANA', 'REVISAR', '9', 'https://example.com/b'],
]

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** Doble de Sheets API: metadatos con las pestañas dadas y batchGet en el orden pedido. */
function fakeSheets(tabs: Record<string, unknown[][]>, opts: { status?: number } = {}) {
  const urls: string[] = []
  const methods: string[] = []
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    urls.push(url.toString())
    methods.push(init?.method ?? 'GET')
    if (opts.status) return jsonResponse({}, opts.status)
    if (url.pathname.endsWith('values:batchGet')) {
      const ranges = url.searchParams.getAll('ranges').map((r) => /^'(.+)'!/.exec(r)![1]!.replace(/''/g, "'"))
      return jsonResponse({ valueRanges: ranges.map((t) => ({ values: tabs[t] })) })
    }
    return jsonResponse({ sheets: Object.keys(tabs).map((title) => ({ properties: { title } })) })
  }) as unknown as typeof fetch
  return { fetchImpl, urls, methods }
}

function loader(env: Record<string, string | undefined>, tabs: Record<string, unknown[][]> = {}, opts: { status?: number } = {}) {
  const sheets = fakeSheets(tabs, opts)
  const getAccessToken = vi.fn(async () => 'ya29.token-de-prueba-no-real')
  const l = createEcoLoader({
    env: { SHEETS_SPREADSHEET_ID: PROPIA, ...env } as unknown as NodeJS.ProcessEnv, getAccessToken, fetchImpl: sheets.fetchImpl,
    sleep: async () => {}, now: () => NOW,
  })
  return { ...sheets, getAccessToken, load: l.load }
}

describe('radarosSheetId (criterio 1)', () => {
  it('null sin variable, vacía, con formato no válido o igual a SHEETS_SPREADSHEET_ID', () => {
    const base = { SHEETS_SPREADSHEET_ID: PROPIA }
    expect(radarosSheetId(base)).toBeNull()
    expect(radarosConfig(base)).toEqual({ id: null, motivo: 'ausente' })
    for (const v of ['', '   ']) expect(radarosConfig({ ...base, RADAROS_SHEET_ID: v })).toEqual({ id: null, motivo: 'ausente' })
    for (const v of ['corto', 'con espacios en medio 0123456789', 'a/b/../0123456789abcdefgh', `${PROPIA}`, ` ${PROPIA} `]) {
      expect(radarosConfig({ ...base, RADAROS_SHEET_ID: v }), v).toEqual({ id: null, motivo: 'no-valido' })
    }
    expect(radarosSheetId({ ...base, RADAROS_SHEET_ID: ` ${RADAROS} ` })).toBe(RADAROS)
  })

  it('nunca lanza ni incluye el valor en lo que devuelve', () => {
    const malo = 'VALOR-SECRETO no válido'
    expect(() => radarosConfig({ RADAROS_SHEET_ID: malo })).not.toThrow()
    expect(JSON.stringify(radarosConfig({ RADAROS_SHEET_ID: malo }))).not.toContain('VALOR-SECRETO')
  })
})

describe('inercia (criterio 4)', () => {
  for (const [caso, valor] of [['sin variable', undefined], ['vacía', ''], ['no válida', 'no válida'], ['igual a PROJECT-OS', PROPIA]] as const) {
    it(`${caso}: «no configurado» y cero llamadas a fetch y al token`, async () => {
      const l = loader({ RADAROS_SHEET_ID: valor }, { SCORING })
      const r = await l.load()
      expect(r.estado).toBe('no-configurado')
      expect(l.fetchImpl).not.toHaveBeenCalled()
      expect(l.getAccessToken).not.toHaveBeenCalled()
    })
  }

  it('la página resuelve la variable antes de leer y el enlace depende solo de ella', () => {
    const page = readFileSync(path.join(__dirname, '..', 'src', 'app', '(private)', 'eco', 'page.tsx'), 'utf8')
    expect(page).toContain('RADAROS no está configurado en este despliegue')
    expect(page).toContain("privateEco('/eco')")
    const layout = readFileSync(path.join(__dirname, '..', 'src', 'app', '(private)', 'layout.tsx'), 'utf8')
    expect(layout).toContain('showEco={radarosSheetId() !== null}')
    const nav = readFileSync(path.join(__dirname, '..', 'src', 'components', 'nav-links.tsx'), 'utf8')
    expect(nav).toMatch(/showEco \? \[\{ href: '\/eco'/)
  })
})

describe('lector de RADAROS (criterio 2)', () => {
  it('solo GET a sheets.googleapis.com, máximo 2 lecturas y el libro de RADAROS', async () => {
    const l = loader({ RADAROS_SHEET_ID: RADAROS }, { SCORING, ML_TRENDS_ANALISIS_AUTO: TRENDS, ML_TRENDS_RAW: [['X']] })
    const r = await l.load()
    expect(r.estado).toBe('ok')
    expect(l.urls).toHaveLength(2)
    expect(new Set(l.methods)).toEqual(new Set(['GET']))
    for (const u of l.urls) expect(u.startsWith(`https://sheets.googleapis.com/v4/spreadsheets/${RADAROS}`)).toBe(true)
    expect(l.urls.join(' ')).not.toContain(PROPIA)
  })

  it('el batchGet no pide pestañas inexistentes ni fuera de la lista fija (criterio 5)', async () => {
    const l = loader({ RADAROS_SHEET_ID: RADAROS }, { SCORING, ML_TRENDS_ANALISIS_AUTO: TRENDS, ML_TRENDS_RAW: [['X']], AMZ_KEEPA_RAW: [['X']] })
    await l.load()
    const batch = new URL(l.urls.find((u) => u.includes('values:batchGet'))!)
    const pedidas = batch.searchParams.getAll('ranges').map((r) => /^'(.+)'!/.exec(r)![1])
    expect(pedidas).toEqual(['SCORING', 'ML_TRENDS_ANALISIS_AUTO'])
    expect(ECO_TABS).not.toContain('AMZ_CANDIDATOS')
    expect(batch.searchParams.get('valueRenderOption')).toBe('FORMATTED_VALUE')
  })

  it('sin ninguna pestaña de la lista: solo metadatos, sin batchGet, y los bloques dicen que no existen', async () => {
    const l = loader({ RADAROS_SHEET_ID: RADAROS }, { OTRA: [['X']] })
    const r = await l.load()
    expect(l.urls).toHaveLength(1)
    expect(r.estado === 'ok' && r.vista.corridas.estado).toBe('ausente')
  })

  it('caché propia: una segunda carga no vuelve a leer', async () => {
    const l = loader({ RADAROS_SHEET_ID: RADAROS }, { SCORING })
    await l.load()
    await l.load()
    expect(l.urls).toHaveLength(2)
    expect(l.getAccessToken).toHaveBeenCalledTimes(2)
  })

  it('403: mensaje seguro de permiso, sin datos ni el ID en el mensaje', async () => {
    const l = loader({ RADAROS_SHEET_ID: RADAROS }, {}, { status: 403 })
    const r = await l.load()
    expect(r).toMatchObject({ estado: 'error', code: 'permission', reintentar: false })
    expect(JSON.stringify(r)).not.toContain(RADAROS)
    expect(r.estado === 'error' && r.message).toContain('Compártela como Lector')
  })

  it('cuota o 5xx: mensaje del cliente y «intenta en un minuto»', async () => {
    for (const status of [429, 503]) {
      const r = await loader({ RADAROS_SHEET_ID: RADAROS }, {}, { status }).load()
      expect(r).toMatchObject({ estado: 'error', reintentar: true })
    }
  })

  it('el lector es server-only y no usa la API de operaciones ni la cuenta de escritura', () => {
    const src = readFileSync(path.join(__dirname, '..', 'src', 'lib', 'radaros', 'data.ts'), 'utf8')
    expect(src.startsWith("import 'server-only'")).toBe(true)
    expect(src).not.toMatch(/operations|write-credentials|POST|PUT|keepa\.com|sellingpartnerapi/i)
    const eco = readFileSync(path.join(__dirname, '..', 'src', 'lib', 'radaros', 'eco.ts'), 'utf8')
    expect(eco).not.toMatch(/fetch\(|https?:\/\//)
  })
})

describe('bloques y estados de §4 (criterios 3 y 5)', () => {
  const todo = { AMZ_CORRIDAS: CORRIDAS, SCORING, AMZ_RESUMEN: RESUMEN, UNIT_ECONOMICS: UNIT, ML_TRENDS_ANALISIS_AUTO: TRENDS }

  it('los 5 bloques con datos; columnas por encabezado y las no listadas se ignoran', () => {
    const v = construirEco(todo, NOW)
    expect(v.corridas.estado).toBe('ok')
    if (v.corridas.estado !== 'ok') return
    expect(v.corridas.datos.ultima?.CORRIDA_ID).toBe('2026-W43|MX|1')
    expect(v.corridas.datos.ultima?.MENSAJE).toHaveLength(201)
    expect(v.corridas.datos.avisos).toContain('El motor está apagado (AMZ_ACTIVO sin activar).')
    expect(v.corridas.datos.avisos.some((a) => a.startsWith('Sin corrida esta semana'))).toBe(false)

    expect(v.ranking.estado).toBe('ok')
    if (v.ranking.estado !== 'ok') return
    expect(v.ranking.datos.columnaPuntuacion).toBe('PUNTUACION_FINAL')
    expect(v.ranking.datos.ideas.map((i) => i.id)).toEqual(['EC-005', 'EC-004', 'EC-006'])
    expect(v.ranking.datos.ideas[0]!.resumen).toEqual({ ultimaSemana: '2026-W42', estado: 'PARCIAL', semanas: 2 })
    expect(JSON.stringify(v)).not.toContain('no-mostrar')

    expect(v.unitEconomics.estado === 'ok' && v.unitEconomics.datos.filas[0]).toMatchObject({ IDEA_ID: 'EC-004', AMZ_PRECIO_MXN: '$499.00' })
    expect(JSON.stringify(v.unitEconomics)).not.toContain('COSTO_PRODUCTO')

    expect(v.candidatos.mensaje).toContain('pendiente de V1.3')

    expect(v.tendencias.estado).toBe('ok')
    if (v.tendencias.estado !== 'ok') return
    expect(v.tendencias.datos.filas.map((f) => f.KEYWORD)).toEqual(['termo', 'lampara'])
    expect(JSON.stringify(v.tendencias)).not.toContain('example.com')
    expect(filtrarTendencias(v.tendencias.datos.filas, { estado: 'UNA_SEMANA' }).map((f) => f.KEYWORD)).toEqual(['lampara'])
    expect(v.tendencias.datos.estados).toEqual(['RECURRENTE', 'UNA_SEMANA'])
  })

  it('columnas en otro orden y AMZ_* al final: se encuentran por nombre', () => {
    const scoring = [['AMZ_ESTADO', 'PUNTUACION_FINAL', 'IDEA_ID'], ['OK', '10', 'EC-009']]
    const v = construirEco({ SCORING: scoring }, NOW)
    expect(v.ranking.estado === 'ok' && v.ranking.datos.ideas[0]).toMatchObject({ id: 'EC-009', puntuacion: '10' })
  })

  it('pestañas AMZ_* ausentes: estado vacío con su activación; las demás siguen', () => {
    const v = construirEco({ SCORING: [['IDEA_ID', 'NOMBRE'], ['EC-004', 'x']], UNIT_ECONOMICS: [['IDEA_ID'], ['EC-004']], ML_TRENDS_ANALISIS_AUTO: TRENDS }, NOW)
    expect(v.corridas).toMatchObject({ estado: 'ausente', mensaje: 'AMZ_CORRIDAS todavía no existe: se crea en la activación de V1.2.' })
    expect(v.ranking.estado === 'ok' && v.ranking.datos.resumen).toMatchObject({ estado: 'ausente' })
    expect(v.ranking.estado === 'ok' && v.ranking.datos.conColumnasAmz).toBe(false)
    expect(v.unitEconomics.estado === 'ok' && v.unitEconomics.datos.conColumnasAmz).toBe(false)
    expect(v.tendencias.estado).toBe('ok')
  })

  it('sin columna de puntuación: ideas por ID con aviso', () => {
    const v = construirEco({ SCORING: [['IDEA_ID'], ['EC-006'], ['EC-004']] }, NOW)
    expect(v.ranking.estado === 'ok' && v.ranking.datos.columnaPuntuacion).toBeNull()
    expect(v.ranking.estado === 'ok' && v.ranking.datos.ideas.map((i) => i.id)).toEqual(['EC-004', 'EC-006'])
  })

  it('solo encabezado: «sin filas» con la explicación del bloque', () => {
    const v = construirEco({ AMZ_CORRIDAS: [CORRIDAS[0]!], ML_TRENDS_ANALISIS_AUTO: [TRENDS[0]!] }, NOW)
    expect(v.corridas).toMatchObject({ estado: 'sin-filas', mensaje: 'Sin filas todavía: el motor no ha corrido.' })
    expect(v.tendencias.estado).toBe('sin-filas')
  })

  it('columna obligatoria ausente: el bloque la nombra y no muestra datos; los demás siguen', () => {
    const v = construirEco({ AMZ_CORRIDAS: [['CORRIDA_ID', 'SEMANA'], ['a', '2026-W43']], SCORING: [['NOMBRE'], ['x']], ML_TRENDS_ANALISIS_AUTO: TRENDS }, NOW)
    expect(v.corridas).toEqual({ estado: 'columnas-faltantes', tab: 'AMZ_CORRIDAS', faltan: ['INICIO', 'ESTADO'] })
    expect(v.ranking).toEqual({ estado: 'columnas-faltantes', tab: 'SCORING', faltan: ['IDEA_ID'] })
    expect(v.tendencias.estado).toBe('ok')
  })

  it('truncado: aviso en el bloque y como máximo MAX_DATA_ROWS filas', () => {
    const filas = Array.from({ length: MAX_DATA_ROWS + 1 }, (_, i) => [`t${i}`, 'RECURRENTE'])
    const v = construirEco({ ML_TRENDS_ANALISIS_AUTO: [['KEYWORD', 'ESTADO'], ...filas] }, NOW)
    expect(v.tendencias.estado === 'ok' && v.tendencias.truncado).toBe(true)
    expect(v.tendencias.estado === 'ok' && v.tendencias.datos.filas).toHaveLength(MAX_DATA_ROWS)
    const justo = construirEco({ ML_TRENDS_ANALISIS_AUTO: [['KEYWORD', 'ESTADO'], ...filas.slice(1)] }, NOW)
    expect(justo.tendencias.estado === 'ok' && justo.tendencias.truncado).toBe(false)
  })

  it('NEEDS_REAUTH y sin corrida esta semana', () => {
    const v = construirEco({ AMZ_CORRIDAS: [['SEMANA', 'INICIO', 'ESTADO'], ['2026-W40', '2026-09-28 06:00:00', 'NEEDS_REAUTH']] }, NOW)
    expect(v.corridas.estado === 'ok' && v.corridas.datos.avisos).toEqual(['El propietario debe reautorizar SP-API.', 'Sin corrida esta semana (2026-W43).'])
  })

  it('semana ISO en Mérida, como 70_Puro.js de RADAROS', () => {
    expect(semanaIsoMerida(NOW)).toBe('2026-W43')
    expect(semanaIsoMerida(Date.UTC(2027, 0, 1, 12))).toBe('2026-W53')
    // 2026-10-26 03:00 UTC sigue siendo domingo 25 en Mérida (UTC−6).
    expect(semanaIsoMerida(Date.UTC(2026, 9, 26, 3))).toBe('2026-W43')
  })
})

describe('render.mjs y deploy.sh (criterio 6)', () => {
  const template = readFileSync(path.join(__dirname, '..', 'deploy', 'cloudrun', 'service.template.yaml'), 'utf8')
  const ACTUAL = {
    SERVICE_NAME: 'project-os-dashboard', PROJECT_ID: 'project-os-511102', REGION: 'northamerica-south1',
    IMAGE: `us-docker.pkg.dev/project-os-511102/repo/dash@sha256:${'a'.repeat(64)}`,
    RUNTIME_SA: 'runtime@project-os-511102.iam.gserviceaccount.com', SERVICE_URL: 'https://dash.example.com',
    OAUTH_CLIENT_ID: '123-abc.apps.googleusercontent.com', SECRET_VERSION_NEXTAUTH: '1', SECRET_VERSION_OAUTH: '1',
    SECRET_VERSION_ALLOWLIST: '1', WRITE_MODE: 'sheets', WRITE_SERVICE_ACCOUNT: 'writer@project-os-511102.iam.gserviceaccount.com',
    SECRET_VERSION_WRITERS: '1', SECRET_VERSION_GITHUB: '2', SECRET_VERSION_PM_AGENT: '3',
  }

  it('con la configuración actual (sin RADAROS_SHEET_ID, o vacía) el YAML no cambia', () => {
    const sin = render(template, ACTUAL)
    expect(sin).not.toContain('RADAROS')
    expect(render(template, { ...ACTUAL, RADAROS_SHEET_ID: '' })).toBe(sin)
    const lectura = { ...ACTUAL, WRITE_MODE: undefined, WRITE_SERVICE_ACCOUNT: undefined, SECRET_VERSION_WRITERS: undefined, SECRET_VERSION_GITHUB: undefined, SECRET_VERSION_PM_AGENT: undefined }
    expect(render(template, lectura)).not.toContain('RADAROS')
  })

  it('con RADAROS_SHEET_ID válida agrega solo esa variable literal, con o sin escritura', () => {
    const sin = render(template, ACTUAL)
    const con = render(template, { ...ACTUAL, RADAROS_SHEET_ID: RADAROS })
    const linea = `            - name: RADAROS_SHEET_ID\n              value: '${RADAROS}'\n`
    expect(con.replace(linea, '')).toBe(sin)
    const lectura = { ...ACTUAL, WRITE_MODE: undefined, WRITE_SERVICE_ACCOUNT: undefined, SECRET_VERSION_WRITERS: undefined, SECRET_VERSION_GITHUB: undefined, SECRET_VERSION_PM_AGENT: undefined }
    expect(render(template, { ...lectura, RADAROS_SHEET_ID: RADAROS })).toContain(linea)
  })

  it('formato no válido o igual a la hoja de PROJECT-OS: falla sin imprimir el valor', () => {
    for (const [valor, mensaje] of [['VALOR-SECRETO con espacios', 'RADAROS_SHEET_ID no tiene el formato esperado'], [PROPIA, 'no puede ser la hoja de PROJECT-OS']]) {
      let error = ''
      try {
        render(template, { ...ACTUAL, RADAROS_SHEET_ID: valor })
      } catch (e) {
        error = (e as Error).message
      }
      expect(error).toContain(mensaje)
      expect(error).not.toContain(valor)
    }
  })

  // deploy.sh --desde-activa la conserva y --quitar la retira: tests/deploy-script.test.ts (ORD-POS-067).
})
