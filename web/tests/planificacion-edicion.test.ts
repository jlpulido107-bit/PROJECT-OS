import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { EstadoGuardado } from '@/components/operations/estado-guardado'
import { CapaSemana } from '@/components/planning/capa-semana'
import { BANDERAS, estadoBandera } from '@/lib/banderas'
import { buildFixtureTabs } from '@/lib/fixtures'
import { canWrite, planificacionEdicionPropietario, puedeEditarPlanificacion } from '@/lib/operations/config'
import { WRITE_HEADERS } from '@/lib/operations/constants'
import { OperationError } from '@/lib/operations/errors'
import { evaluateWriteRequest } from '@/lib/operations/guard'
import { RateLimiter } from '@/lib/operations/rate-limit'
import { OperationsService } from '@/lib/operations/service'
import { findById, InMemoryTableStore, readView, toRecord } from '@/lib/operations/table-store'
import { parseUpdateTask } from '@/lib/operations/validation'
import {
  actualCargado, cambiosEdicion, cuerpoEdicion, errorDeCampo, estadoGuardado, tarjetasSemana,
  type EdicionSemana, type EnvioOperacion, type TarjetaSemana, type ValoresEdicion,
} from '@/lib/planificacion-edicion'
import { planWeek } from '@/lib/planning/engine'
import { planningInputFromDataset } from '@/lib/planning/input'
import { DEFAULT_SCENARIO } from '@/lib/planning/scenario'
import { buildDataset } from '@/lib/table'
import type { RawTabs } from '@/lib/types'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }))

/** Edición en línea de la capa Semana (ORD-POS-136, DEC-POS-029): FECHA_PLAN, HORAS_ESTIMADAS e HITO_ID. */

const ORIGIN = 'http://127.0.0.1:3000'
const DUENO = 'dueno@example.com'
const OTRO = 'otro-escritor@example.com'
const LECTOR = 'lector@example.com'
const TODAY = '2026-11-02'
const NOW = new Date('2026-11-02T16:30:00Z')
const BASE = {
  NEXTAUTH_URL: ORIGIN, AUTH_ALLOWED_EMAILS: `${DUENO},${OTRO},${LECTOR}`, AUTH_WRITER_EMAILS: `${DUENO},${OTRO}`,
  PROJECT_OS_WRITE_MODE: 'mock', DASHBOARD_DATA_SOURCE: 'fixtures',
  PM_AGENT_TOKEN_SHA256: createHash('sha256').update('token-de-prueba-sintetico-0123456789').digest('hex'),
}
const ENCENDIDA = { ...BASE, PLANIFICACION_EDICION_PROPIETARIO: 'true', PLANIFICACION_EDICION_PROPIETARIO_EMAIL: DUENO }
const env = (extra: Record<string, string | undefined>) => extra as unknown as NodeJS.ProcessEnv

const seed = () => ({ ...(buildFixtureTabs(TODAY) as Record<string, unknown[][]>), AUDITORIA: [[...WRITE_HEADERS.AUDITORIA]] })
const data = buildDataset(seed() as RawTabs, { source: 'fixtures', fetchedAt: NOW.getTime() })
const input = planningInputFromDataset(data)
const plan = planWeek(input, DEFAULT_SCENARIO, { referenceDate: TODAY, timeZone: 'America/Merida' })
const tarjetas = tarjetasSemana(plan, input)
const demo = data.tareas.find((t) => t.id === 'DEMO-002')!
const VERSION = Number(demo.version)
const ACTUAL: ValoresEdicion = { fechaPlan: demo.fechaPlan ?? '', horasEstimadas: String(demo.horasEstimadas), hitoId: demo.hitoId ?? '' }

/** Lo mismo que calcula /planificacion: propietario con la bandera y escritura habilitada. */
function edicionPara(email: string, e: NodeJS.ProcessEnv): EdicionSemana {
  return puedeEditarPlanificacion(email, e) && canWrite(email, e)
    ? { encendida: true, versiones: Object.fromEntries(data.tareas.map((t) => [t.id, Number(t.version ?? '0') || 0])), hitosPorProyecto: { POS: [{ value: 'DEMO-H1', label: 'DEMO-H1 · Hito demo' }] } }
    : { encendida: false }
}
const capa = (edicion: EdicionSemana, lista: TarjetaSemana[] = tarjetas) => renderToStaticMarkup(createElement(CapaSemana, {
  dias: { estado: 'sin-datos', motivo: 'prueba' }, hitos: { estado: 'ok', datos: [] }, tarjetas: lista, edicion,
}))

/** El JSON que devuelve handleWrite/errorResponse para un OperationError (misma forma, sin Next). */
const respuestaError = (e: OperationError): EnvioOperacion => ({
  status: 'error',
  error: { codigo: e.code, mensaje: e.message, ...(e.fields ? { campos: e.fields } : {}), ...(e.detail ? { detalle: e.detail } : {}) },
})

describe('tarjetas de la capa Semana', () => {
  it('lista las tareas abiertas de la semana con sus 3 valores; horas vacías se quedan vacías', () => {
    expect(tarjetas.map((t) => t.id)).toContain('DEMO-002')
    expect(tarjetas.find((t) => t.id === 'DEMO-002')!.valores).toEqual(ACTUAL)
    expect(tarjetas.some((t) => t.id === 'DEMO-001')).toBe(false) // cerrada
    const html = capa({ encendida: false })
    expect(html).toContain('Tareas de la semana')
    expect(html).toContain('No antes de')
  })
})

describe('bandera PLANIFICACION_EDICION_PROPIETARIO (criterio 2, prueba «bandera apagada»)', () => {
  it('apagada, mal escrita, sin correo o con otra sesión: «Edición apagada» y sin formulario ni botón', () => {
    for (const [email, e] of [
      [DUENO, env(BASE)],
      [DUENO, env({ ...ENCENDIDA, PLANIFICACION_EDICION_PROPIETARIO: 'TRUE' })],
      [DUENO, env({ ...ENCENDIDA, PLANIFICACION_EDICION_PROPIETARIO_EMAIL: '' })],
      [DUENO, env({ ...ENCENDIDA, PLANIFICACION_EDICION_PROPIETARIO_EMAIL: 'fuera@example.com' })],
      [DUENO, env({ ...ENCENDIDA, PROJECT_OS_WRITE_MODE: 'disabled' })],
      [OTRO, env(ENCENDIDA)],
      [LECTOR, env(ENCENDIDA)],
    ] as const) {
      const html = capa(edicionPara(email, e))
      expect(html, `${email}`).toContain('Edición apagada')
      expect(html).not.toContain('<form')
      expect(html).not.toContain('>Editar</button>')
    }
  })

  it('encendida y sesión del propietario: botón Editar en cada tarjeta, sin «Edición apagada»', () => {
    const html = capa(edicionPara(DUENO, env(ENCENDIDA)))
    expect(html).not.toContain('Edición apagada')
    expect(html.match(/>Editar<\/button>/g)).toHaveLength(tarjetas.length)
    expect(html).toContain('aria-live="polite"')
  })

  it('el correo no reconocido no cuenta; el estado se expone como bandera sin valor', () => {
    expect(planificacionEdicionPropietario(env(ENCENDIDA))).toBe(DUENO)
    expect(planificacionEdicionPropietario(env({ ...ENCENDIDA, PLANIFICACION_EDICION_PROPIETARIO_EMAIL: `${DUENO},${OTRO}` }))).toBeNull()
    expect(BANDERAS.PLANIFICACION_EDICION_PROPIETARIO).toBeDefined()
    expect(estadoBandera('PLANIFICACION_EDICION_PROPIETARIO', env(ENCENDIDA))).toMatchObject({ tipo: 'encendida' })
    expect(estadoBandera('PLANIFICACION_EDICION_PROPIETARIO', env(BASE))).toMatchObject({ tipo: 'apagada' })
  })

  it('/planificacion la calcula con la sesión y canWrite; el servidor no cambia (sin ruta ni operación nuevas)', () => {
    const raiz = path.join(__dirname, '..', 'src')
    const page = readFileSync(path.join(raiz, 'app', '(private)', 'planificacion', 'page.tsx'), 'utf8')
    expect(page).toContain('puedeEditarPlanificacion(user.email) && canWrite(user.email)')
    expect(page).not.toMatch(/PM_AGENT|authorization/i)
    const tarjeta = readFileSync(path.join(raiz, 'components', 'planning', 'tarjeta-semana.tsx'), 'utf8')
    expect(tarjeta).toContain("useOperation(`/api/operaciones/tareas/${encodeURIComponent(tarea.id)}`, 'PATCH')")
    // ORD-POS-139 usa la bandera en el guard solo para sus operaciones del propietario (capacidad.registrar); tarea.editar
    // sigue sin depender de ella (límite conocido de §10).
    const guard = readFileSync(path.join(raiz, 'lib', 'operations', 'guard.ts'), 'utf8')
    expect(guard.match(/puedeEditarPlanificacion\(/g)).toHaveLength(1)
    expect(guard).toContain("if (ownerOp && !puedeEditarPlanificacion(ctx.email, ctx.env)) throw new OperationError('operacion-no-permitida')")
  })
})

describe('cuerpo del PATCH (criterios 1, 4 y 5)', () => {
  it('ESTADO, BLOQUEO y cualquier otro campo no se pueden enviar', () => {
    const cuerpo = cuerpoEdicion(VERSION, ACTUAL, {
      ...ACTUAL, horasEstimadas: '3', estado: 'COMPLETADO', bloqueo: 'algo', titulo: 'Otro', ESTADO: 'CANCELADO', BLOQUEO: 'x',
    })
    expect(cuerpo).toEqual({ expectedVersion: VERSION, changes: { horasEstimadas: '3' } })
    expect(Object.keys(cambiosEdicion(ACTUAL, { estado: 'BLOQUEADO', bloqueo: 'b', ...ACTUAL }))).toEqual([])
  })

  it('HORAS vacía se manda vacía (null), nunca 0; sin cambios no hay cuerpo', () => {
    expect(cambiosEdicion(ACTUAL, { ...ACTUAL, horasEstimadas: '  ' })).toEqual({ horasEstimadas: null })
    expect(cambiosEdicion(ACTUAL, { ...ACTUAL, fechaPlan: '', hitoId: '' })).toEqual({ fechaPlan: null, hitoId: null })
    expect(cuerpoEdicion(VERSION, ACTUAL, { ...ACTUAL })).toBeNull()
  })

  it('el formulario rotula FECHA_PLAN como «no antes de» y avisa que vacío no es 0', () => {
    const fuente = readFileSync(path.join(__dirname, '..', 'src', 'lib', 'planificacion-edicion.ts'), 'utf8')
    expect(fuente).toContain("fechaPlan: 'Fecha plan (no antes de)'")
    const tarjeta = readFileSync(path.join(__dirname, '..', 'src', 'components', 'planning', 'tarjeta-semana.tsx'), 'utf8')
    expect(tarjeta).toContain('Vacío = sin estimación (no es 0)')
  })
})

describe('escritura simulada con las 3 respuestas (criterios 3 y 5)', () => {
  const peticion = (body: unknown) => new Request(`${ORIGIN}/api/operaciones/tareas/DEMO-002`, {
    method: 'PATCH', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'x-project-os-csrf': '1' },
  })
  const ctx = (email: string) => ({ email, env: env(ENCENDIDA), limiter: new RateLimiter(), agentLimiter: new RateLimiter(5, 60_000), operation: 'tarea.editar' as const })
  const requestId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

  async function enviar(store: InMemoryTableStore, cuerpo: Record<string, unknown>, n: number): Promise<EnvioOperacion> {
    const req = await evaluateWriteRequest(peticion({ ...cuerpo, requestId: requestId(n) }), ctx(DUENO))
    const service = new OperationsService(store, { mode: 'mock', clock: () => NOW })
    try {
      const r = await service.updateTask(parseUpdateTask('DEMO-002', req.body), { actor: req.actor })
      return { status: 'done', result: { version: r.version, repetida: r.repetida } }
    } catch (e) {
      if (e instanceof OperationError) return respuestaError(e)
      throw e
    }
  }

  it('guardado: cambia solo los 3 campos, sube la versión y queda en AUDITORIA con ACTOR = propietario', async () => {
    const store = new InMemoryTableStore(seed())
    const cuerpo = cuerpoEdicion(VERSION, ACTUAL, { fechaPlan: '2026-11-04', horasEstimadas: '', hitoId: '' })!
    const envio = await enviar(store, cuerpo, 1)
    expect(estadoGuardado(envio)).toEqual({ tipo: 'guardado', version: VERSION + 1, repetida: false })
    const view = await readView(store, 'TAREAS')
    const fila = toRecord(view, findById(view, 'TAREA_ID', 'DEMO-002')[0]!.cells)
    expect(fila).toMatchObject({ FECHA_PLAN: '2026-11-04', HORAS_ESTIMADAS: '', HITO_ID: '', ESTADO: demo.estado, BLOQUEO: '', VERSION: String(VERSION + 1) })
    const audit = await readView(store, 'AUDITORIA')
    expect(audit.rows.map((r) => toRecord(audit, r.cells)).some((a) => a.ACTOR === DUENO && a.REGISTRO_ID === 'DEMO-002' && a.CAMPO === 'FECHA_PLAN')).toBe(true)
    const html = renderToStaticMarkup(createElement(EstadoGuardado, { estado: estadoGuardado(envio) }))
    expect(html).toContain(`Versión ${VERSION + 1}`)
    expect(html).toContain('aria-live="polite"')
  })

  it('conflicto de versión: no escribe, trae la versión actual y muestra el valor actual y el tuyo', async () => {
    const store = new InMemoryTableStore(seed())
    await enviar(store, cuerpoEdicion(VERSION, ACTUAL, { ...ACTUAL, horasEstimadas: '2' })!, 2) // otra sesión gana
    const envio = await enviar(store, cuerpoEdicion(VERSION, ACTUAL, { ...ACTUAL, horasEstimadas: '9' })!, 3)
    const estado = estadoGuardado(envio)
    expect(estado).toMatchObject({ tipo: 'conflicto', versionActual: VERSION + 1 })
    const view = await readView(store, 'TAREAS')
    expect(toRecord(view, findById(view, 'TAREA_ID', 'DEMO-002')[0]!.cells).HORAS_ESTIMADAS).toBe('2')
    // Hasta que la vista recargue la versión nueva no se ofrece guardar encima.
    expect(actualCargado(estado, VERSION)).toBe(false)
    expect(actualCargado(estado, VERSION + 1)).toBe(true)
    const html = renderToStaticMarkup(createElement(EstadoGuardado, { estado, actual: '2 h', tuyo: '9 h' }, 'acciones'))
    expect(html).toContain('Conflicto de versión')
    expect(html).toContain('Valor actual: 2 h')
    expect(html).toContain('Tu cambio: 9 h')
    expect(html).toContain('role="alert"')
    // Guardar el mío sobre el actual: con la versión recargada sí se guarda.
    const encima = await enviar(store, cuerpoEdicion(VERSION + 1, { ...ACTUAL, horasEstimadas: '2' }, { ...ACTUAL, horasEstimadas: '9' })!, 4)
    expect(estadoGuardado(encima)).toMatchObject({ tipo: 'guardado', version: VERSION + 2 })
  })

  it('error del servidor: estado de error que conserva lo escrito y marca el campo', async () => {
    const store = new InMemoryTableStore(seed())
    const invalido = estadoGuardado(await enviar(store, { expectedVersion: VERSION, changes: { horasEstimadas: '0' } }, 5))
    expect(invalido.tipo).toBe('error')
    expect(errorDeCampo(invalido, 'horasEstimadas')).toMatch(/mayor que 0/)
    const caida = estadoGuardado(respuestaError(new OperationError('escritura-fallida')))
    expect(caida).toMatchObject({ tipo: 'error' })
    const red = estadoGuardado({ status: 'error', error: { codigo: 'red', mensaje: 'Sin conexión con el servidor.' } })
    const html = renderToStaticMarkup(createElement(EstadoGuardado, { estado: red }))
    expect(html).toContain('No se guardó.')
    expect(html).toContain('Lo que escribiste sigue en el formulario')
    expect(html).toContain('role="alert"')
  })

  it('el token del PM tampoco puede enviar ESTADO ni BLOQUEO por esta ruta (lista blanca existente, sin cambios)', async () => {
    const r = new Request(`${ORIGIN}/api/operaciones/tareas/DEMO-002`, {
      method: 'PATCH', body: JSON.stringify({ requestId: requestId(6), expectedVersion: VERSION, changes: { bloqueo: 'x' } }),
      headers: { 'content-type': 'application/json', authorization: 'Bearer token-de-prueba-sintetico-0123456789' },
    })
    const code = await evaluateWriteRequest(r, { ...ctx(DUENO), email: null }).then(() => 'ok', (e: unknown) => (e instanceof OperationError ? e.code : String(e)))
    expect(code).toBe('operacion-no-permitida')
  })
})
