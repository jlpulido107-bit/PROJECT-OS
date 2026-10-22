import { describe, expect, it } from 'vitest'
import { buildFixtureTabs } from '@/lib/fixtures'
import { WRITE_HEADERS } from '@/lib/operations/constants'
import { transitionWithDispatch } from '@/lib/operations/dispatch'
import { GitHubError, type GitHubClient } from '@/lib/operations/github'
import type { RoutineClient } from '@/lib/operations/claude-routine'
import { OperationsService } from '@/lib/operations/service'
import { findById, InMemoryTableStore, readView } from '@/lib/operations/table-store'
import { parseOrderTransition } from '@/lib/operations/validation'
import { extraerCriterios } from '@/lib/supervision/criterios'
import { MARCA_DICTAMEN } from '@/lib/supervision/dictamen'

/** DEC-POS-011 (ORD-POS-055): el agente PM aprueba y envía con el «sí» citado y marca REVISADA con dictamen válido. */

const PM = { actor: 'agente-pm', agent: true }
const SI = 'ORD-POS-901 «sí, apruébala» 2026-10-21'
const HEAD = 'a'.repeat(40)
const PR_URL = 'https://github.com/jlpulido107-bit/PROJECT-OS/pull/50'
const CRITERIOS = '1. Uno\n2. Dos'
const crit = extraerCriterios(CRITERIOS)
if (!crit.ok) throw new Error('criterios de prueba inválidos')
let seq = 0
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`

const reporte = (headSha = HEAD, rol = 'PRIMERO', modelo = 'claude-sonnet-5-5', n = 1) => ({
  versionContrato: '2', rol, modelo, versionPolitica: 'DEC-POS-008', ordenId: 'ORD-POS-902', tareaId: 'DEMO-002',
  proyectoId: 'POS', repo: 'jlpulido107-bit/PROJECT-OS', issue: 49, pr: 50, headSha, baseSha: 'b'.repeat(40), hashCriterios: crit.hashCriterios,
  revisionId: `REV-ORD-POS-902-${n}`, ejecucionId: `EJE-ORD-POS-902-${n}`, intento: 1, ronda: 0,
  autorizacion: { otorgadaPor: 'propietario', orden: 'ORD-POS-902', desde: '2026-10-21' }, limiteConsumo: { presupuesto: '1 USD', tiempoMaximo: '30 min' },
  criterios: [{ id: '1', resultado: 'CUMPLE', evidencia: 'ok' }, { id: '2', resultado: 'CUMPLE', evidencia: 'ok' }],
  evidencia: { propias: [{ comando: 'npm test', sha: headSha, codigoSalida: 0 }], ci: { estado: 'EXITO', ejecucion: 'r1', sha: headSha }, autor: [] },
  hallazgos: [], veredicto: 'CONFORME',
})
const comentario = (body: string, id = 7) => ({ id, body: `${MARCA_DICTAMEN}\n\n\`\`\`json\n${body}\n\`\`\`` })

async function setup(cambios: Record<string, Record<string, string>> = {}, comentarios = [comentario(JSON.stringify(reporte()))]) {
  const store = new InMemoryTableStore({ ...(buildFixtureTabs('2026-10-21') as Record<string, unknown[][]>), AUDITORIA: [[...WRITE_HEADERS.AUDITORIA]] })
  const view = await readView(store, 'ORDENES_CODEX')
  for (const [id, campos] of Object.entries(cambios)) {
    const fila = findById(view, 'ORDEN_ID', id)[0]!
    await store.writeRow('ORDENES_CODEX', fila.sheetRow, fila.cells.map((c, i) => campos[view.header[i]!] ?? c))
  }
  const ctl = { ahora: '2026-10-21T16:00:00Z', head: HEAD, fallaGitHub: false }
  const service = new OperationsService(store, { mode: 'mock', clock: () => new Date(ctl.ahora) })
  const lanzadas: string[] = []
  const gh = <T>(v: T) => async () => { if (ctl.fallaGitHub) throw new GitHubError(503); return v }
  const github = { enviar: gh({ issueUrl: 'https://github.com/jlpulido107-bit/PROJECT-OS/issues/100', creado: true }), lanzamientoPrevio: gh(null),
    registrarLanzamiento: gh(undefined), datosDictamen: async () => gh({ headSha: ctl.head, comentarios })() } as unknown as GitHubClient
  const rutina = { ejecutar: async ({ ordenId }: { ordenId: string }) => (lanzadas.push(ordenId), { sessionUrl: 'https://claude.ai/code/session_1' }) } as unknown as RoutineClient
  const auditoria = () => store.snapshot().AUDITORIA!.slice(1)
  const estado = async (id = 'ORD-POS-901') => (await service.readOrder(id))?.ESTADO
  const run = (id: string, body: Record<string, unknown>) => transitionWithDispatch(service, parseOrderTransition(id, body), PM, github, rutina)
  return { run, auditoria, lanzadas, estado, ctl }
}

const conPr = { 'ORD-POS-902': { PR_URL, CRITERIOS_ACEPTACION: CRITERIOS } }

describe('agente PM: aprobar y enviar (criterio 1)', () => {
  it('con el «sí» citado aprueba, envía y lanza la rutina como hoy', async () => {
    const e = await setup()
    const r = await e.run('ORD-POS-901', { requestId: uuid(), accion: 'APROBAR', expectedEstado: 'BORRADOR', autorizacion: SI })
    expect(r).toMatchObject({ envio: { ok: true }, ejecucion: { ok: true, nueva: true } })
    expect(await e.estado()).toBe('ENVIADA')
    expect(e.lanzadas).toEqual(['ORD-POS-901'])
  })

  it('sin autorización, o sin «sí» y fecha válida, se rechaza sin escribir', async () => {
    const e = await setup()
    await expect(e.run('ORD-POS-901', { requestId: uuid(), accion: 'APROBAR', expectedEstado: 'BORRADOR' })).rejects.toMatchObject({ code: 'validacion' })
    for (const autorizacion of ['«adelante» 2026-10-21', '«sí» 2026-13-40', 'sí 2026-10-21']) {
      expect(() => parseOrderTransition('ORD-POS-901', { requestId: uuid(), accion: 'APROBAR', expectedEstado: 'BORRADOR', autorizacion }), autorizacion).toThrow()
    }
    expect([e.auditoria(), await e.estado()]).toEqual([[], 'BORRADOR'])
  })

  it('una orden de riesgo ALTO no se aprueba ni se envía', async () => {
    const e = await setup({ 'ORD-POS-901': { RIESGO: 'ALTO' } })
    await expect(e.run('ORD-POS-901', { requestId: uuid(), accion: 'APROBAR', expectedEstado: 'BORRADOR', autorizacion: SI })).rejects.toMatchObject({ code: 'riesgo-alto-pm' })
    const enviada = await setup({ 'ORD-POS-901': { RIESGO: 'ALTO', ESTADO: 'APROBADA' } })
    await expect(enviada.run('ORD-POS-901', { requestId: uuid(), accion: 'ENVIAR', expectedEstado: 'APROBADA', autorizacion: SI })).rejects.toMatchObject({ code: 'riesgo-alto-pm' })
    expect([e.auditoria(), enviada.auditoria(), e.lanzadas, await enviada.estado()]).toEqual([[], [], [], 'APROBADA'])
  })

  it('cada fila lleva actor agente-pm, la autorización y el requestId; repetir no añade filas (criterio 4)', async () => {
    const e = await setup()
    const body = { requestId: uuid(), accion: 'APROBAR', expectedEstado: 'BORRADOR', autorizacion: SI }
    await e.run('ORD-POS-901', body)
    const filas = e.auditoria()
    expect(filas.every((f) => f[2] === 'agente-pm' && String(f[8]).endsWith(';agente=pm'))).toBe(true)
    expect(filas.filter((f) => f[5] === 'AUTORIZACION').map((f) => f[7])).toEqual([SI, SI]) // aprobar y enviar
    expect(filas.some((f) => String(f[8]).includes(`req=${body.requestId}`))).toBe(true)
    expect((await e.run('ORD-POS-901', body)).repetida).toBe(true)
    expect(e.auditoria()).toHaveLength(filas.length)
  })
})

describe('agente PM: marcar REVISADA (criterio 2)', () => {
  it('con un dictamen válido del head actual pasa a REVISADA', async () => {
    const e = await setup(conPr)
    await e.run('ORD-POS-902', { requestId: uuid(), accion: 'REVISAR', expectedEstado: 'PR_ABIERTO' })
    expect(await e.estado('ORD-POS-902')).toBe('REVISADA')
    expect(e.auditoria().find((f) => f[5] === 'AUTORIZACION')?.[7]).toBe(`dictamen CONFORME head ${HEAD} comentario 7`)
  })

  it.each([
    ['de otro head', JSON.stringify(reporte('c'.repeat(40)))],
    ['inválido', JSON.stringify({ ...reporte(), veredicto: 'TAL VEZ' })],
  ])('con un dictamen %s se rechaza sin escribir', async (_n, body) => {
    const e = await setup(conPr, [comentario(body)])
    await expect(e.run('ORD-POS-902', { requestId: uuid(), accion: 'REVISAR', expectedEstado: 'PR_ABIERTO' })).rejects.toMatchObject({ code: 'dictamen-no-valido' })
    expect([e.auditoria(), await e.estado('ORD-POS-902')]).toEqual([[], 'PR_ABIERTO'])
  })
})

describe('agente PM: REVISADA solo con CONFORME suficiente (ORD-POS-057, DEC-POS-011)', () => {
  const bloqueante = { id: 'H1', severidad: 'ALTA', ubicacion: 'a.ts:1', condicion: 'falla', impacto: 'rompe', bloquea: true, justificacion: 'npm test' }
  const medio = { 'ORD-POS-902': { ...conPr['ORD-POS-902'], RIESGO: 'MEDIO' } }
  const segundo = (modelo: string) => comentario(JSON.stringify(reporte(HEAD, 'SEGUNDO', modelo, 2)), 8)
  const primero = comentario(JSON.stringify(reporte()))

  it.each([
    ['CAMBIOS', conPr, [comentario(JSON.stringify({ ...reporte(), veredicto: 'CAMBIOS', hallazgos: [bloqueante], criterios: [{ id: '1', resultado: 'NO_CUMPLE', evidencia: 'x' }, { id: '2', resultado: 'CUMPLE', evidencia: 'ok' }] }))]],
    ['INCONCLUSO', conPr, [comentario(JSON.stringify({ ...reporte(), veredicto: 'INCONCLUSO', criterios: [{ id: '1', resultado: 'NO_VERIFICADO', evidencia: 'x' }, { id: '2', resultado: 'CUMPLE', evidencia: 'ok' }] }))]],
    ['MEDIO sin SEGUNDO', medio, [primero]],
    ['MEDIO con SEGUNDO del mismo modelo', medio, [primero, segundo('claude-sonnet-5-5')]],
    ['ALTO', { 'ORD-POS-902': { ...conPr['ORD-POS-902'], RIESGO: 'ALTO' } }, [primero]],
  ])('con %s responde dictamen-insuficiente sin escribir', async (_n, cambios, comentarios) => {
    const e = await setup(cambios, comentarios)
    await expect(e.run('ORD-POS-902', { requestId: uuid(), accion: 'REVISAR', expectedEstado: 'PR_ABIERTO' })).rejects.toMatchObject({ code: 'dictamen-insuficiente' })
    expect([e.auditoria(), await e.estado('ORD-POS-902')]).toEqual([[], 'PR_ABIERTO'])
  })

  it('MEDIO con PRIMERO y SEGUNDO CONFORME de otro modelo pasa a REVISADA', async () => {
    const e = await setup(medio, [primero, segundo('claude-fable-5-1')])
    await e.run('ORD-POS-902', { requestId: uuid(), accion: 'REVISAR', expectedEstado: 'PR_ABIERTO' })
    expect(await e.estado('ORD-POS-902')).toBe('REVISADA')
  })
})

describe('agente PM: autorización ligada a la orden y a la fecha (ORD-POS-059)', () => {
  const aprobar = (autorizacion: string, id = 'ORD-POS-901') => ({ requestId: uuid(), accion: 'APROBAR', expectedEstado: 'BORRADOR', autorizacion, _id: id })
  const run = (e: Awaited<ReturnType<typeof setup>>, { _id, ...body }: ReturnType<typeof aprobar>) => e.run(_id, body)

  it.each([
    ['«si quieres»', 'ORD-POS-901 «si quieres» 2026-10-21'],
    ['fecha de 1999', 'ORD-POS-901 «sí» 1999-10-21'],
    ['fecha de 2099', 'ORD-POS-901 «sí» 2099-10-21'],
    ['ID de otra orden', 'ORD-POS-902 «sí» 2026-10-21'],
    ['ID que solo empieza igual', 'ORD-POS-9010 «sí» 2026-10-21'],
  ])('con %s responde autorizacion-no-valida sin escribir (criterio 1)', async (_n, autorizacion) => {
    const e = await setup()
    await expect(run(e, aprobar(autorizacion))).rejects.toMatchObject({ code: 'autorizacion-no-valida' })
    expect([e.auditoria(), await e.estado()]).toEqual([[], 'BORRADOR'])
  })

  it('la fecha admite un día de margen en Mérida, con el reloj del servicio', async () => {
    const e = await setup()
    await expect(run(e, aprobar('ORD-POS-901 «Sí, adelante» 2026-10-23'))).rejects.toMatchObject({ code: 'autorizacion-no-valida' })
    e.ctl.ahora = '2026-10-22T05:00:00Z' // aún 21 en Mérida (UTC−6): el 22 es mañana, dentro del margen
    await run(e, aprobar('ORD-POS-901 «Sí, adelante» 2026-10-22'))
    expect(await e.estado()).toBe('ENVIADA')
  })

  it('una autorización ya auditada para otra orden se rechaza sin escribir (criterio 2)', async () => {
    const e = await setup({ 'ORD-POS-902': { ESTADO: 'BORRADOR', ISSUE_URL: '', PR_URL: '' } })
    await run(e, aprobar('ORD-POS-901 «sí, las dos» 2026-10-21'))
    const filas = e.auditoria().length
    await expect(run(e, aprobar('ORD-POS-902 «sí, las dos» 2026-10-21', 'ORD-POS-902'))).rejects.toMatchObject({ code: 'autorizacion-no-valida' })
    expect([e.auditoria().length, await e.estado('ORD-POS-902')]).toEqual([filas, 'BORRADOR'])
  })

  it('ENVIAR con url es del propietario: se rechaza sin escribir (criterio 3)', async () => {
    const e = await setup({ 'ORD-POS-901': { ESTADO: 'APROBADA' } })
    const body = { requestId: uuid(), accion: 'ENVIAR', expectedEstado: 'APROBADA', autorizacion: SI, url: 'https://github.com/jlpulido107-bit/PROJECT-OS/issues/7' }
    await expect(e.run('ORD-POS-901', body)).rejects.toMatchObject({ code: 'transicion-reservada-pm' })
    expect([e.auditoria(), await e.estado(), e.lanzadas]).toEqual([[], 'APROBADA', []])
  })

  it('el reintento de APROBAR y ENVIAR devuelve repetida=true aunque la fecha ya no valga y GitHub falle (criterio 4)', async () => {
    const e = await setup({ 'ORD-POS-902': { ESTADO: 'APROBADA', ISSUE_URL: '', PR_URL: '' } })
    const ap = aprobar(SI)
    const env = { requestId: uuid(), accion: 'ENVIAR', expectedEstado: 'APROBADA', autorizacion: 'ORD-POS-902 «sí, envíala» 2026-10-21' }
    await run(e, ap)
    await e.run('ORD-POS-902', env)
    const filas = e.auditoria().length
    Object.assign(e.ctl, { ahora: '2026-10-30T16:00:00Z', fallaGitHub: true })
    expect((await run(e, ap)).repetida).toBe(true)
    expect((await e.run('ORD-POS-902', env)).repetida).toBe(true)
    expect(e.auditoria()).toHaveLength(filas)
  })

  it('el reintento de REVISAR devuelve repetida=true aunque el head cambie o GitHub falle (criterio 4)', async () => {
    const e = await setup(conPr)
    const body = { requestId: uuid(), accion: 'REVISAR', expectedEstado: 'PR_ABIERTO' }
    await e.run('ORD-POS-902', body)
    const filas = e.auditoria().length
    e.ctl.head = 'c'.repeat(40)
    expect((await e.run('ORD-POS-902', body)).repetida).toBe(true)
    e.ctl.fallaGitHub = true
    expect((await e.run('ORD-POS-902', body)).repetida).toBe(true)
    expect(e.auditoria()).toHaveLength(filas)
  })
})
