import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CalendarioIcsPanel } from '@/components/planning/calendario-ics'
import { render } from '../deploy/cloudrun/render.mjs'
import { GET } from '@/app/api/planificacion/calendario.ics/route'
import { decide, respond } from '@/lib/authz'
import { BANDERAS, estadoBandera } from '@/lib/banderas'
import { calendarioDesdeDataset, calendarioIcs, escaparTexto, eventosCalendario, plegarLinea } from '@/lib/calendario-ics'
import { calendarioIcsTokenHash, esSecretoDelCalendario } from '@/lib/calendario-ics-acceso'
import { CALENDARIO_ICS_RUTA, enlaceCalendario, enlaceOculto } from '@/lib/calendario-ics-enlace'
import { addDays } from '@/lib/dates'
import { buildFixtureTabs } from '@/lib/fixtures'
import { buildDataset } from '@/lib/table'
import type { RawTabs } from '@/lib/types'

/** Calendario ICS de solo lectura (ORD-POS-142, escritura §11.3 a §11.5). Solo datos y secretos sintéticos. */

const HOY = '2026-11-03'
const SECRETO = 'secreto-sintetico-del-calendario-0123456789abcdef'
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const PM = 'token-sintetico-del-pm-0123456789'
const env = (extra: Record<string, string | undefined> = {}) =>
  ({ PLANIFICACION_ICS: 'true', CALENDARIO_ICS_TOKEN_SHA256: sha(SECRETO), PM_AGENT_TOKEN_SHA256: sha(PM), ...extra }) as unknown as NodeJS.ProcessEnv

type Tabs = Record<string, unknown[][]>
const T_PLAN = '2026-11-02T15:00:00Z'

/** Fixtures con un plan de hoy y otro dentro de la ventana, y casos que no deben salir. */
function tabs(cambiar: (t: Tabs) => void = () => undefined): Tabs {
  const t = structuredClone(buildFixtureTabs(HOY)) as Tabs
  t.PLAN_DIARIO!.push(
    ['P-FUT', addDays(HOY, 5), '', 'PLANEADO', '2', 'Nota del plan que nunca sale', T_PLAN],
    ['P-CANC', addDays(HOY, 6), '', 'CANCELADO', '2', '', ''],
    ['P-FUERA', addDays(HOY, 14), '', 'PLANEADO', '2', '', ''],
  )
  t.PLAN_ITEMS!.push(
    ['PI-A', 'P-FUT', 'DEMO-005', '1', '45', 'Resultado que nunca sale', ''],
    ['PI-B', 'P-FUT', 'DEMO-005', '2', '15', '', ''],
    ['PI-CERO', 'P-FUT', 'DEMO-002', '3', '0', '', ''],
    ['PI-CERRADA', 'P-FUT', 'DEMO-001', '4', '30', '', ''],
    ['PI-HUERFANO', 'P-FUT', 'NO-EXISTE', '5', '30', '', ''],
    ['PI-CANC', 'P-CANC', 'DEMO-005', '1', '30', '', ''],
    ['PI-FUERA', 'P-FUERA', 'DEMO-005', '1', '30', '', ''],
  )
  cambiar(t)
  return t
}
const dataset = (t: Tabs = tabs()) => buildDataset(t as RawTabs, { source: 'fixtures', fetchedAt: 0 })

describe('eventos (criterios 2 y 3)', () => {
  const eventos = eventosCalendario(dataset(), HOY)

  it('plan registrado con «Nombre · ID · N min» y vencimientos «Vence: Nombre · ID», en los próximos 14 días', () => {
    expect(eventos.map((e) => [e.fecha, e.summary])).toEqual([
      [HOY, 'Tarea demo en curso · DEMO-002 · 120 min'],
      [HOY, 'Tarea demo bloqueada · DEMO-003 · 30 min'],
      [addDays(HOY, 4), 'Vence: Tarea demo en curso · DEMO-002'],
      [addDays(HOY, 5), 'Tarea demo pendiente · DEMO-005 · 60 min'],
      [addDays(HOY, 9), 'Vence: Tarea demo pendiente · DEMO-005'],
      [addDays(HOY, 10), 'Vence: Tarea demo bloqueada · DEMO-003'],
    ])
    for (const e of eventos) expect(e.fecha >= HOY && e.fecha <= addDays(HOY, 13)).toBe(true)
  })

  it('no salen: plan cancelado, fuera de la ventana, minutos 0 o vacíos, tareas cerradas ni inexistentes', () => {
    const texto = JSON.stringify(eventos)
    expect(texto).not.toContain('DEMO-001')
    expect(texto).not.toContain('NO-EXISTE')
    expect(eventos.filter((e) => e.uid.startsWith('DEMO-002-') && e.uid.endsWith('-plan@project-os')).map((e) => e.fecha)).toEqual([HOY])
    expect(eventos.some((e) => e.fecha === addDays(HOY, 6) || e.fecha === addDays(HOY, 14))).toBe(false)
  })

  it('UID estable por tarea y fecha; DTSTAMP de la hoja, nunca del reloj; mismo archivo si la hoja no cambia', () => {
    expect(eventos.map((e) => e.uid)).toEqual([
      `DEMO-002-${HOY}-plan@project-os`, `DEMO-003-${HOY}-plan@project-os`, `DEMO-002-${addDays(HOY, 4)}-vence@project-os`,
      `DEMO-005-${addDays(HOY, 5)}-plan@project-os`, `DEMO-005-${addDays(HOY, 9)}-vence@project-os`, `DEMO-003-${addDays(HOY, 10)}-vence@project-os`,
    ])
    expect(new Set(eventos.map((e) => e.uid)).size).toBe(eventos.length)
    expect(eventos.find((e) => e.uid.startsWith('DEMO-005') && e.uid.endsWith('plan@project-os'))!.dtstamp).toBe(Date.parse(T_PLAN))
    // DEMO-003 no tiene ACTUALIZADO_EN: medianoche UTC de la fecha del evento.
    expect(eventos.find((e) => e.uid.startsWith('DEMO-003') && e.uid.endsWith('vence@project-os'))!.dtstamp).toBe(Date.parse(`${addDays(HOY, 10)}T00:00:00Z`))
    expect(calendarioIcs(eventosCalendario(dataset(), HOY))).toBe(calendarioIcs(eventosCalendario(dataset(), HOY)))
  })

  it('sin plan registrado, solo vencimientos', () => {
    const sinPlan = eventosCalendario(dataset(tabs((t) => { t.PLAN_ITEMS = [t.PLAN_ITEMS![0]!] })), HOY)
    expect(sinPlan.length).toBeGreaterThan(0)
    expect(sinPlan.every((e) => e.summary.startsWith('Vence: ') && e.uid.endsWith('-vence@project-os'))).toBe(true)
  })

  it('nunca instrucciones, descripción, notas, responsable ni correos', () => {
    const ds = dataset(tabs((t) => {
      t.TAREAS![0]!.push('INSTRUCCIONES')
      for (const fila of t.TAREAS!.slice(1)) {
        while (fila.length < t.TAREAS![0]!.length - 1) fila.push('')
        fila.push('Paso secreto: escribe a alguien@example.com')
      }
    }))
    expect(ds.tareas.find((t) => t.id === 'DEMO-002')?.instrucciones).toContain('Paso secreto')
    const ics = calendarioIcs(eventosCalendario(ds, HOY))
    for (const nunca of ['Paso secreto', '@example.com', 'Descripción sintética', 'Persona demo', 'Nota del plan', 'Resultado que nunca sale', 'Panel accesible', 'DESCRIPTION', 'ORGANIZER', 'ATTENDEE']) {
      expect(ics).not.toContain(nunca)
    }
  })
})

describe('RFC 5545 (cómo probar: escapes, plegado y UID)', () => {
  it('escapa \\ ; , y saltos de línea, y quita otros caracteres de control', () => {
    expect(escaparTexto('a\\b;c,d\ne\r\nf\rg\u0007h')).toBe('a\\\\b\\;c\\,d\\ne\\nf\\ng' + 'h')
  })

  it('pliega a 75 octetos sin cortar caracteres UTF-8', () => {
    const linea = `SUMMARY:${'ñ'.repeat(100)}`
    const plegada = plegarLinea(linea)
    const partes = plegada.split('\r\n')
    expect(partes.length).toBeGreaterThan(1)
    for (const p of partes) expect(Buffer.byteLength(p, 'utf8')).toBeLessThanOrEqual(75)
    for (const p of partes.slice(1)) expect(p.startsWith(' ')).toBe(true)
    expect(partes.map((p, i) => (i === 0 ? p : p.slice(1))).join('')).toBe(linea)
    expect(plegada).not.toContain('�')
    expect(plegarLinea('corta')).toBe('corta')
  })

  it('estructura: CRLF, VCALENDAR, eventos de día completo y título escapado', () => {
    const ics = calendarioIcs([{ uid: 'POS-1-2026-11-03-plan@project-os', fecha: '2026-11-03', summary: 'Revisar; contrato, v2 · POS-1 · 45 min', dtstamp: Date.parse('2026-11-02T15:04:05Z') }])
    expect(ics.endsWith('\r\n')).toBe(true)
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
    const lineas = ics.split('\r\n')
    expect(lineas.slice(0, 5)).toEqual(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PROJECT-OS//Planificacion//ES', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'])
    expect(lineas).toContain('UID:POS-1-2026-11-03-plan@project-os')
    expect(lineas).toContain('DTSTAMP:20261102T150405Z')
    expect(lineas).toContain('DTSTART;VALUE=DATE:20261103')
    expect(lineas).toContain('DTEND;VALUE=DATE:20261104')
    expect(lineas).toContain('SUMMARY:Revisar\\; contrato\\, v2 · POS-1 · 45 min')
    expect(lineas.at(-2)).toBe('END:VCALENDAR')
  })

  it('sin una de sus pestañas leída completa no se genera', () => {
    const ds = dataset()
    ds.tabs.PLAN_ITEMS = { ...ds.tabs.PLAN_ITEMS, ok: false }
    expect(calendarioDesdeDataset(ds, HOY)).toMatchObject({ ok: false })
    expect(calendarioDesdeDataset(dataset(), HOY).ok).toBe(true)
  })
})

describe('secreto y bandera (criterio 1)', () => {
  it('solo con PLANIFICACION_ICS=true exacto y un hash válido distinto de los de los agentes', () => {
    expect(calendarioIcsTokenHash(env())).toBe(sha(SECRETO))
    for (const valor of [undefined, '', 'TRUE', 'on', '1']) expect(calendarioIcsTokenHash(env({ PLANIFICACION_ICS: valor })), String(valor)).toBeNull()
    expect(calendarioIcsTokenHash(env({ CALENDARIO_ICS_TOKEN_SHA256: '' }))).toBeNull()
    expect(calendarioIcsTokenHash(env({ CALENDARIO_ICS_TOKEN_SHA256: 'abc' }))).toBeNull()
    for (const otro of ['PM_AGENT_TOKEN_SHA256', 'TIEMPOS_AGENTE_TOKEN_SHA256', 'FINANZAS_AGENTE_TOKEN_SHA256']) {
      expect(calendarioIcsTokenHash(env({ [otro]: sha(SECRETO).toUpperCase() })), otro).toBeNull()
    }
    expect(calendarioIcsTokenHash(env({ CALENDARIO_ICS_TOKEN_SHA256: ` ${sha(SECRETO).toUpperCase()} ` }))).toBe(sha(SECRETO))
  })

  it('compara el SHA-256 del secreto; sin token, con otro o con el del PM, no', async () => {
    expect(await esSecretoDelCalendario(SECRETO, env())).toBe(true)
    for (const malo of [null, undefined, '', `${SECRETO}x`, PM, sha(SECRETO), 'a'.repeat(600)]) {
      expect(await esSecretoDelCalendario(malo, env()), String(malo).slice(0, 20)).toBe(false)
    }
    expect(await esSecretoDelCalendario(SECRETO, env({ PLANIFICACION_ICS: undefined }))).toBe(false)
  })

  it('bandera en el registro de banderas, apagada sin entorno', () => {
    expect(BANDERAS.PLANIFICACION_ICS?.nombre).toBe('Calendario ICS de la planificación')
    expect(estadoBandera('PLANIFICACION_ICS', env())?.tipo).toBe('encendida')
    expect(estadoBandera('PLANIFICACION_ICS', {} as NodeJS.ProcessEnv)?.tipo).toBe('apagada')
  })
})

describe('proxy: única exención GET a la ruta exacta (escritura §11.3)', () => {
  const opts = { secret: 'secreto-de-prueba-solo-para-tests-0123456789abcdef', allowed: new Set(['revisor@example.com']) }
  const req = (method: string, path: string) => new NextRequest(new URL(path, 'http://localhost:3000'), { method })

  it('GET a la ruta exacta pasa sin sesión (la ruta valida el secreto)', async () => {
    for (const path of [CALENDARIO_ICS_RUTA, `${CALENDARIO_ICS_RUTA}?token=x`]) {
      expect((await decide(req('GET', path), opts)).action).toBe('public')
    }
  })

  it('otro método, otra ruta o variantes de la ruta piden sesión', async () => {
    const casos: Array<[string, string]> = [
      ['POST', CALENDARIO_ICS_RUTA], ['HEAD', CALENDARIO_ICS_RUTA], ['PUT', CALENDARIO_ICS_RUTA], ['DELETE', CALENDARIO_ICS_RUTA],
      ['GET', `${CALENDARIO_ICS_RUTA}/`], ['GET', '/api/planificacion/calendario.ics.json'], ['GET', '/api/planificacion/calendario'],
      ['GET', '/api/planificacion'], ['GET', '/api/planificacion/calendario.icsx'], ['GET', '/planificacion'],
    ]
    for (const [method, path] of casos) {
      const r = req(method, path)
      const d = await decide(r, opts)
      expect(d.action, `${method} ${path}`).toBe('unauthenticated')
      expect([401, 307]).toContain(respond(d, r).status)
    }
  })
})

describe('ruta GET /api/planificacion/calendario.ics (criterios 1 a 4)', () => {
  const KEYS = ['DASHBOARD_DATA_SOURCE', 'PLANIFICACION_ICS', 'CALENDARIO_ICS_TOKEN_SHA256', 'PM_AGENT_TOKEN_SHA256']
  const saved: Record<string, string | undefined> = {}
  beforeAll(() => {
    for (const key of KEYS) saved[key] = process.env[key]
    Object.assign(process.env, { DASHBOARD_DATA_SOURCE: 'fixtures', CALENDARIO_ICS_TOKEN_SHA256: sha(SECRETO), PM_AGENT_TOKEN_SHA256: sha(PM) })
  })
  afterAll(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })
  const get = (query: string) => GET(new Request(`http://localhost:3000${CALENDARIO_ICS_RUTA}${query}`))

  it('apagada: 404 aunque el secreto sea el correcto', async () => {
    for (const valor of [undefined, 'TRUE']) {
      if (valor === undefined) delete process.env.PLANIFICACION_ICS
      else process.env.PLANIFICACION_ICS = valor
      const r = await get(`?token=${SECRETO}`)
      expect(r.status).toBe(404)
      expect(r.headers.get('cache-control')).toContain('no-store')
    }
  })

  it('encendida: sin token, con otro o con el del PM, 404', async () => {
    process.env.PLANIFICACION_ICS = 'true'
    for (const q of ['', '?token=', '?token=otro-cualquiera', `?token=${PM}`, `?clave=${SECRETO}`]) expect((await get(q)).status, q).toBe(404)
  })

  it('encendida y con el secreto: text/calendar, no-store, noindex y sin correos', async () => {
    process.env.PLANIFICACION_ICS = 'true'
    const r = await get(`?token=${SECRETO}`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('text/calendar; charset=utf-8')
    expect(r.headers.get('cache-control')).toContain('no-store')
    expect(r.headers.get('x-robots-tag')).toBe('noindex')
    const ics = await r.text()
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true)
    expect(ics).toContain('SUMMARY:Tarea demo en curso · DEMO-002 · 120 min')
    expect(ics).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
  })

  it('solo exporta GET: sin ida y vuelta', async () => {
    const mod = await import('@/app/api/planificacion/calendario.ics/route')
    expect(Object.keys(mod).filter((k) => /^[A-Z]+$/.test(k))).toEqual(['GET'])
  })
})

describe('enlace de la vista (criterio 5)', () => {
  it('se muestra con el secreto oculto y se copia completo solo con un secreto válido', () => {
    expect(enlaceOculto('https://dash.example.com/')).toBe('https://dash.example.com/api/planificacion/calendario.ics?token=••••••••')
    expect(enlaceOculto('https://dash.example.com')).not.toContain(SECRETO)
    expect(enlaceCalendario('https://dash.example.com', ` ${SECRETO} `)).toBe(`https://dash.example.com/api/planificacion/calendario.ics?token=${SECRETO}`)
    for (const malo of ['', 'corto', 'con espacio dentro 0123456789', 'a&b=c0123456789abcdef']) expect(enlaceCalendario('https://dash.example.com', malo), malo).toBeNull()
  })
})

describe('render.mjs: PLANIFICACION_ICS y su secreto van juntos (criterio 1)', () => {
  const template = readFileSync(path.join(__dirname, '..', 'deploy', 'cloudrun', 'service.template.yaml'), 'utf8')
  const VARS = {
    SERVICE_NAME: 'project-os-dashboard', PROJECT_ID: 'project-os-511102', REGION: 'northamerica-south1',
    IMAGE: `us-docker.pkg.dev/proj-os-1/repo/dash@sha256:${'a'.repeat(64)}`, RUNTIME_SA: 'runtime@project-os-511102.iam.gserviceaccount.com',
    SERVICE_URL: 'https://dash.example.com', OAUTH_CLIENT_ID: '123-abc.apps.googleusercontent.com', SECRET_VERSION_NEXTAUTH: '1',
    SECRET_VERSION_OAUTH: '1', SECRET_VERSION_ALLOWLIST: '1',
  }
  const ON = { ...VARS, PLANIFICACION_ICS: 'true', SECRET_VERSION_CALENDARIO_ICS: '2' }

  it('sin la bandera el YAML no cambia; con ella agrega la bandera y el hash desde Secret Manager (sin WRITE_MODE)', () => {
    const sin = render(template, VARS)
    expect(sin).not.toMatch(/PLANIFICACION_ICS|CALENDARIO_ICS/)
    expect(render(template, { ...VARS, PLANIFICACION_ICS: ' ', SECRET_VERSION_CALENDARIO_ICS: '' })).toBe(sin)
    expect(render(template, ON)).toMatch(new RegExp(
      "- name: PLANIFICACION_ICS\\n\\s+value: 'true'\\n\\s+- name: CALENDARIO_ICS_TOKEN_SHA256\\n\\s+valueFrom:\\n\\s+secretKeyRef:\\n" +
      "\\s+name: project-os-calendario-ics-token-sha256\\n\\s+key: '2'\\n",
    ))
  })

  it.each([
    [{ PLANIFICACION_ICS: 'TRUE' }, 'PLANIFICACION_ICS solo admite true'],
    [{ PLANIFICACION_ICS: 'on' }, 'PLANIFICACION_ICS solo admite true'],
    [{ PLANIFICACION_ICS: '' }, 'van juntas'],
    [{ SECRET_VERSION_CALENDARIO_ICS: '' }, 'van juntas'],
    [{ SECRET_VERSION_CALENDARIO_ICS: 'latest' }, 'SECRET_VERSION_CALENDARIO_ICS no tiene el formato esperado'],
  ])('rechaza %o', (cambio, mensaje) => {
    expect(() => render(template, { ...ON, ...cambio })).toThrow(mensaje)
  })
})

describe('panel de la vista (criterio 5)', () => {
  const html = (encendido: boolean) => renderToStaticMarkup(createElement(CalendarioIcsPanel, { origen: 'https://dash.example.com', encendido }))

  it('encendido: enlace con el secreto oculto, «Copiar enlace» y el aviso de relectura de Google', () => {
    const h = html(true)
    expect(h).toContain('https://dash.example.com/api/planificacion/calendario.ics?token=••••••••')
    expect(h).toContain('Copiar enlace')
    expect(h).toContain('relee el enlace cada varias horas')
    expect(h).toContain('type="password"')
  })

  it('apagado: lo dice y no muestra enlace ni botón', () => {
    const h = html(false)
    expect(h).toContain('Calendario apagado')
    expect(h).not.toContain('Copiar enlace')
    expect(h).not.toContain('calendario.ics')
  })
})
