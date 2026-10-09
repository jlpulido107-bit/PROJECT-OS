import { describe, expect, it } from 'vitest'
import { OperationError } from '@/lib/operations/errors'
import { cleanText, safeCellText } from '@/lib/operations/sanitize'
import { meridaIsoTimestamp } from '@/lib/operations/time'
import { parseCreateDecision, parseCreateTask, parseLogTime, parseUpdateTask, payloadHash } from '@/lib/operations/validation'

const RID = '11111111-2222-4333-8444-555555555555'
const TODAY = '2026-10-08'

function fields(fn: () => unknown): Record<string, string> {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(OperationError)
    return (error as OperationError).fields ?? { _code: (error as OperationError).code }
  }
  throw new Error('se esperaba error')
}

const TASK = { requestId: RID, proyectoId: 'POS', titulo: 'Tarea válida', tipo: 'DESARROLLO', prioridad: 'ALTA', criterioTerminado: 'Criterio' }

describe('saneamiento', () => {
  it('elimina controles, normaliza saltos y espacios', () => {
    expect(cleanText('  a\u0000b\u0007c​  ', false)).toBe('abc​')
    expect(cleanText('línea 1\r\nlínea 2\n\n\n\nfin', true)).toBe('línea 1\nlínea 2\n\nfin')
    expect(cleanText('una\nsola\tlínea', false)).toBe('una sola línea')
    expect(cleanText('é', false)).toBe('é')
  })

  it.each(['=1+1', '+SUM(A1)', '-2+3', '@cmd', '=HYPERLINK("http://x")'])('neutraliza fórmula %s', (value) => {
    expect(safeCellText(value)).toBe(`'${value}`)
  })

  it('no altera texto normal', () => {
    expect(safeCellText('Revisar PR #6')).toBe('Revisar PR #6')
  })
})

describe('validación estricta', () => {
  it('tarea válida se normaliza', () => {
    const cmd = parseCreateTask({ ...TASK, tipo: ' desarrollo ', prioridad: 'alta', horasEstimadas: 6.5, proyectoId: 'pos' })
    expect(cmd).toMatchObject({ proyectoId: 'POS', tipo: 'DESARROLLO', prioridad: 'ALTA', horasEstimadas: '6.5', hitoId: null })
  })

  it('rechaza claves desconocidas o de sistema (sin asignación masiva)', () => {
    expect(fields(() => parseCreateTask({ ...TASK, VERSION: '99', tareaId: 'POS-999' }))).toMatchObject({ VERSION: 'Campo no permitido', tareaId: 'Campo no permitido' })
    expect(fields(() => parseCreateTask({ ...TASK, estado: 'COMPLETADO' }))).toMatchObject({ estado: expect.any(String) })
    expect(fields(() => parseUpdateTask('POS-001', { requestId: RID, expectedVersion: 1, changes: { version: 5, proyectoId: 'SIG' } }))).toMatchObject({
      'changes.version': 'Campo no permitido', 'changes.proyectoId': 'Campo no permitido',
    })
  })

  it('requestId debe ser UUID v4', () => {
    expect(fields(() => parseCreateTask({ ...TASK, requestId: 'abc' }))).toMatchObject({ requestId: expect.any(String) })
    expect(fields(() => parseCreateTask({ ...TASK, requestId: undefined }))).toMatchObject({ requestId: expect.any(String) })
  })

  it.each([
    [{ proyectoId: "POS'; DROP" }, 'proyectoId'],
    [{ proyectoId: 123 }, 'proyectoId'],
    [{ hitoId: '../x' }, 'hitoId'],
    [{ titulo: 'ab' }, 'titulo'],
    [{ titulo: 'x'.repeat(161) }, 'titulo'],
    [{ titulo: '   ' }, 'titulo'],
    [{ titulo: ['array'] }, 'titulo'],
    [{ tipo: 'tipo con espacios' }, 'tipo'],
    [{ prioridad: 'URGENTE' }, 'prioridad'],
    [{ fechaPlan: '2026-02-30' }, 'fechaPlan'],
    [{ fechaPlan: '08/10/2026' }, 'fechaPlan'],
    [{ fechaPlan: '2026-10-10', fechaLimite: '2026-10-01' }, 'fechaLimite'],
    [{ horasEstimadas: -1 }, 'horasEstimadas'],
    [{ horasEstimadas: '1e3' }, 'horasEstimadas'],
    [{ horasEstimadas: 1001 }, 'horasEstimadas'],
    [{ criterioTerminado: '' }, 'criterioTerminado'],
    [{ descripcion: 'x'.repeat(2001) }, 'descripcion'],
  ])('tarea inválida %j → campo %s', (patch, field) => {
    expect(fields(() => parseCreateTask({ ...TASK, ...patch }))).toHaveProperty(field)
  })

  it('cuerpos no objeto → json-invalido', () => {
    for (const body of [null, [], 'texto', 42]) expect(fields(() => parseCreateTask(body))).toEqual({ _code: 'json-invalido' })
  })

  it('edición: cierre bloqueado; estados y versión validados', () => {
    expect(fields(() => parseUpdateTask('POS-001', { requestId: RID, expectedVersion: 1, changes: { estado: 'COMPLETADO' } }))).toEqual({ _code: 'cierre-no-permitido' })
    expect(fields(() => parseUpdateTask('POS-001', { requestId: RID, expectedVersion: 1, changes: { estado: 'ARCHIVADO' } }))).toHaveProperty('changes.estado')
    expect(fields(() => parseUpdateTask('POS-001', { requestId: RID, expectedVersion: '1', changes: { prioridad: 'ALTA' } }))).toHaveProperty('expectedVersion')
    expect(fields(() => parseUpdateTask('POS-001', { requestId: RID, expectedVersion: 1, changes: {} }))).toHaveProperty('changes.changes')
    expect(fields(() => parseUpdateTask('POS-001', { requestId: RID, expectedVersion: 1, changes: { titulo: '' } }))).toHaveProperty('changes.titulo')
    expect(fields(() => parseUpdateTask('../../etc', { requestId: RID, expectedVersion: 1, changes: { prioridad: 'ALTA' } }))).toHaveProperty('tareaId')
    const cmd = parseUpdateTask('pos-001', { requestId: RID, expectedVersion: 1, changes: { estado: 'en_progreso', hitoId: '', descripcion: null } })
    expect(cmd).toEqual({ requestId: RID, tareaId: 'POS-001', expectedVersion: 1, changes: { estado: 'EN_PROGRESO', hitoId: null, descripcion: null } })
  })

  it('tiempo: minutos enteros 1–960, fecha no futura ni anterior a 365 días', () => {
    const base = { requestId: RID, tareaId: 'POS-001', fecha: TODAY, responsable: 'Usuario', minutos: 30, tipoTrabajo: 'REVISION' }
    expect(parseLogTime(base, TODAY)).toMatchObject({ minutos: '30', notas: null })
    expect(fields(() => parseLogTime({ ...base, minutos: 0 }, TODAY))).toHaveProperty('minutos')
    expect(fields(() => parseLogTime({ ...base, minutos: 961 }, TODAY))).toHaveProperty('minutos')
    expect(fields(() => parseLogTime({ ...base, minutos: 1.5 }, TODAY))).toHaveProperty('minutos')
    expect(fields(() => parseLogTime({ ...base, fecha: '2026-10-09' }, TODAY))).toHaveProperty('fecha')
    expect(fields(() => parseLogTime({ ...base, fecha: '2025-10-07' }, TODAY))).toHaveProperty('fecha')
  })

  it('decisión: estado no editable, URL solo https sin credenciales', () => {
    const base = { requestId: RID, proyectoId: 'POS', asunto: 'Asunto', decision: 'Decisión', justificacion: 'Porque sí', responsable: 'Usuario' }
    expect(parseCreateDecision(base, TODAY)).toMatchObject({ fecha: TODAY, evidenciaUrl: null })
    expect(fields(() => parseCreateDecision({ ...base, estado: 'APROBADA' }, TODAY))).toHaveProperty('estado')
    for (const url of ['javascript:alert(1)', 'http://inseguro.example', 'https://user:pass@x.example/']) {
      expect(fields(() => parseCreateDecision({ ...base, evidenciaUrl: url }, TODAY))).toHaveProperty('evidenciaUrl')
    }
  })

  it('hash del payload: estable, ignora requestId, distingue cambios', () => {
    const a = parseCreateTask(TASK)
    const b = parseCreateTask({ ...TASK, requestId: '99999999-2222-4333-8444-555555555555' })
    expect(payloadHash('tarea.crear', a)).toBe(payloadHash('tarea.crear', b))
    expect(payloadHash('tarea.crear', a)).not.toBe(payloadHash('tarea.crear', { ...a, titulo: 'Otro' }))
    expect(payloadHash('tarea.crear', a)).not.toBe(payloadHash('decision.crear', a))
  })
})

describe('marca de tiempo de Mérida', () => {
  it('formatea con desfase -06:00', () => {
    expect(meridaIsoTimestamp(new Date('2026-10-09T03:21:25.900Z'))).toBe('2026-10-08T21:21:25-06:00')
  })
})
