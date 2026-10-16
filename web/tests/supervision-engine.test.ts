import { describe, expect, it } from 'vitest'
import { MOTIVO_NO_PERMITIDA, RONDA_MAXIMA, siguienteEstado } from '@/lib/supervision/engine'
import { ESTADOS } from '@/lib/supervision/types'
import type { Contexto, Estado, EstadoActual, Evento } from '@/lib/supervision/types'

const CTX: Contexto = {
  ronda: 0, headVigente: 'h1', autorizacionCorreccion: true, presupuestoDisponible: true,
  comprobacionesRequeridasTerminadas: true, hallazgosDentroDeAlcance: true, desacuerdoRepetido: false,
}
const ctx = (p: Partial<Contexto> = {}): Contexto => ({ ...CTX, ...p })
const en = (estado: Estado | null, p: Partial<EstadoActual> = {}): EstadoActual => ({ estado, estadoAnterior: null, cicloTerminado: false, ...p })

/** Aplica eventos en cadena: el resultado alimenta el siguiente paso; `cambios` ajusta el contexto por paso. */
function cadena(inicio: EstadoActual, ronda: number, pasos: [Evento, Partial<Contexto>?][], base: Partial<Contexto> = {}) {
  let actual = inicio
  let r = ronda
  const estados: (Estado | null)[] = []
  for (const [e, p] of pasos) {
    const res = siguienteEstado(actual, e, ctx({ ...base, ...p, ronda: r }))
    estados.push(res.estado)
    actual = { estado: res.estado, estadoAnterior: res.estadoAnterior, cicloTerminado: res.cicloTerminado }
    r = res.ronda
  }
  return { estados, actual, ronda: r }
}

describe('contrato §6: los 12 ejemplos', () => {
  it('ejemplo 1: entrega conforme → APROBADO_TECNICAMENTE, sin fusión', () => {
    const { estados, actual } = cadena(en(null), 0, [
      [{ tipo: 'PR_REGISTRADO' }], [{ tipo: 'RESERVA_PERSISTIDA' }], [{ tipo: 'REPORTE', veredicto: 'CONFORME', headSha: 'h1' }],
    ])
    expect(estados).toEqual(['PENDIENTE', 'EN_REVISION', 'APROBADO_TECNICAMENTE'])
    expect(actual.cicloTerminado).toBe(false)
  })

  it('ejemplo 2: una corrección → CAMBIOS_SOLICITADOS → CORRIGIENDO → PENDIENTE → EN_REVISION → APROBADO', () => {
    const { estados, ronda } = cadena(en('EN_REVISION'), 0, [
      [{ tipo: 'REPORTE', veredicto: 'CAMBIOS', headSha: 'h1' }],
      [{ tipo: 'CORRECCION_ENVIADA' }],
      [{ tipo: 'ENTREGA_CORRECCION', headSha: 'h2', mismoPrYRama: true }],
      [{ tipo: 'RESERVA_PERSISTIDA' }, { headVigente: 'h2' }],
      [{ tipo: 'REPORTE', veredicto: 'CONFORME', headSha: 'h2' }, { headVigente: 'h2' }],
    ])
    expect(estados).toEqual(['CAMBIOS_SOLICITADOS', 'CORRIGIENDO', 'PENDIENTE', 'EN_REVISION', 'APROBADO_TECNICAMENTE'])
    expect(ronda).toBe(1)
  })

  it('ejemplo 3: tras dos correcciones y otra revisión con CAMBIOS → ESCALADO, sin tercera corrección', () => {
    expect(RONDA_MAXIMA).toBe(2)
    const { estados, actual, ronda } = cadena(en('EN_REVISION'), 1, [
      [{ tipo: 'REPORTE', veredicto: 'CAMBIOS', headSha: 'h2' }, { headVigente: 'h2' }],
      [{ tipo: 'CORRECCION_ENVIADA' }, { headVigente: 'h2' }],
      [{ tipo: 'ENTREGA_CORRECCION', headSha: 'h3', mismoPrYRama: true }, { headVigente: 'h2' }],
      [{ tipo: 'RESERVA_PERSISTIDA' }, { headVigente: 'h3' }],
      [{ tipo: 'REPORTE', veredicto: 'CAMBIOS', headSha: 'h3' }, { headVigente: 'h3' }],
      [{ tipo: 'CORRECCION_ENVIADA' }, { headVigente: 'h3' }],
    ])
    expect(estados).toEqual(['CAMBIOS_SOLICITADOS', 'CORRIGIENDO', 'PENDIENTE', 'EN_REVISION', 'CAMBIOS_SOLICITADOS', 'ESCALADO'])
    expect(ronda).toBe(2)
    expect(siguienteEstado(actual, { tipo: 'CORRECCION_ENVIADA' }, ctx({ ronda })).motivo).toBe(MOTIVO_NO_PERMITIDA)
  })

  it('ejemplo 4: reporte CONFORME de otro head → histórico, el estado no cambia', () => {
    const r = siguienteEstado(en('EN_REVISION'), { tipo: 'REPORTE', veredicto: 'CONFORME', headSha: 'h0' }, ctx())
    expect(r).toMatchObject({ estado: 'EN_REVISION', soloHistorico: true, ronda: 0 })
  })

  it('ejemplo 5: timeout ambiguo → BLOQUEADO; sin reconciliar → ESCALADO; sin consumir ronda', () => {
    const b = siguienteEstado(en('EN_REVISION'), { tipo: 'FALLO_TECNICO' }, ctx({ ronda: 1 }))
    expect(b).toMatchObject({ estado: 'BLOQUEADO', estadoAnterior: 'EN_REVISION', ronda: 1 })
    const e = siguienteEstado(en('BLOQUEADO', { estadoAnterior: 'EN_REVISION' }), { tipo: 'RECONCILIACION', resultado: 'IMPOSIBLE' }, ctx({ ronda: 1 }))
    expect(e).toMatchObject({ estado: 'ESCALADO', ronda: 1 })
    const ok = siguienteEstado(en('BLOQUEADO', { estadoAnterior: 'EN_REVISION' }), { tipo: 'RECONCILIACION', resultado: 'RECONCILIADA' }, ctx())
    expect(ok.estado).toBe('EN_REVISION')
  })

  it('ejemplo 6: hallazgo fuera de alcance → ESCALADO de inmediato, sin consumir ronda', () => {
    const r = siguienteEstado(en('CAMBIOS_SOLICITADOS'), { tipo: 'CORRECCION_ENVIADA' }, ctx({ ronda: 0, hallazgosDentroDeAlcance: false }))
    expect(r).toMatchObject({ estado: 'ESCALADO', ronda: 0 })
  })

  it('ejemplo 7: sin CI bajo política local no requerida → puede ser CONFORME', () => {
    const { estados } = cadena(en('PENDIENTE'), 0, [
      [{ tipo: 'RESERVA_PERSISTIDA' }, { comprobacionesRequeridasTerminadas: true }],
      [{ tipo: 'REPORTE', veredicto: 'CONFORME', headSha: 'h1' }],
    ])
    expect(estados).toEqual(['EN_REVISION', 'APROBADO_TECNICAMENTE'])
  })

  it('ejemplo 8: CI requerida pendiente → sigue PENDIENTE; luego CAMBIOS por CI fallida', () => {
    const p = siguienteEstado(en('PENDIENTE'), { tipo: 'RESERVA_PERSISTIDA' }, ctx({ comprobacionesRequeridasTerminadas: false }))
    expect(p.estado).toBe('PENDIENTE')
    const { estados } = cadena(en('PENDIENTE'), 0, [
      [{ tipo: 'RESERVA_PERSISTIDA' }], [{ tipo: 'REPORTE', veredicto: 'CAMBIOS', headSha: 'h1' }],
    ])
    expect(estados).toEqual(['EN_REVISION', 'CAMBIOS_SOLICITADOS'])
  })

  it('ejemplo 9: head nuevo con revisión en curso → DESACTUALIZADO, su reporte queda histórico, la nueva clave → PENDIENTE', () => {
    const { estados, actual } = cadena(en('EN_REVISION'), 0, [
      [{ tipo: 'CAMBIO', que: 'HEAD', headSha: 'h2' }],
      [{ tipo: 'REPORTE', veredicto: 'CONFORME', headSha: 'h1' }, { headVigente: 'h2' }],
      [{ tipo: 'NUEVA_REVISION' }, { headVigente: 'h2' }],
    ])
    expect(estados).toEqual(['DESACTUALIZADO', 'DESACTUALIZADO', 'PENDIENTE'])
    expect(actual.estado).toBe('PENDIENTE')
    const tarde = siguienteEstado(en('DESACTUALIZADO'), { tipo: 'REPORTE', veredicto: 'CONFORME', headSha: 'h1' }, ctx({ headVigente: 'h2' }))
    expect(tarde.soloHistorico).toBe(true)
  })

  it('ejemplo 10: reporte sin origen autenticado → BLOQUEADO (fallo técnico); un comentario no autoriza nada', () => {
    expect(siguienteEstado(en('EN_REVISION'), { tipo: 'FALLO_TECNICO' }, ctx()).estado).toBe('BLOQUEADO')
    // un evento de reporte nunca mueve APROBADO_TECNICAMENTE ni PENDIENTE: solo EN_REVISION con head vigente
    for (const s of ['PENDIENTE', 'APROBADO_TECNICAMENTE', 'ESCALADO'] as const) {
      const r = siguienteEstado(en(s), { tipo: 'REPORTE', veredicto: 'CONFORME', headSha: 'h1' }, ctx())
      expect(r).toMatchObject({ estado: s, soloHistorico: true })
    }
  })

  it('ejemplo 11: fallo al registrar → BLOQUEADO sin consumir ronda ni relanzar', () => {
    const r = siguienteEstado(en('EN_REVISION'), { tipo: 'FALLO_TECNICO' }, ctx({ ronda: 2 }))
    expect(r).toMatchObject({ estado: 'BLOQUEADO', ronda: 2, soloHistorico: false })
  })

  it('ejemplo 12: cancelación o PR cerrado → ESCALADO sin reanudación; reporte tardío histórico', () => {
    for (const tipo of ['ORDEN_CANCELADA', 'PR_CERRADO_SIN_FUSION'] as const) {
      const r = siguienteEstado(en('EN_REVISION'), { tipo }, ctx())
      expect(r.estado).toBe('ESCALADO')
      const e = en('ESCALADO')
      for (const ev of [{ tipo: 'RESERVA_PERSISTIDA' }, { tipo: 'NUEVA_REVISION' }, { tipo: 'CORRECCION_ENVIADA' }, { tipo: 'PR_REGISTRADO' }, { tipo: 'CAMBIO', que: 'HEAD', headSha: 'h9' }] as Evento[]) {
        expect(siguienteEstado(e, ev, ctx()).motivo).toBe(MOTIVO_NO_PERMITIDA)
        expect(siguienteEstado(e, ev, ctx()).estado).toBe('ESCALADO')
      }
      expect(siguienteEstado(e, { tipo: 'REPORTE', veredicto: 'CONFORME', headSha: 'h1' }, ctx())).toMatchObject({ estado: 'ESCALADO', soloHistorico: true })
    }
  })
})

describe('reglas del contrato', () => {
  it('CORRIGIENDO: head nuevo es la entrega (ronda +1); otro cambio desactualiza', () => {
    expect(siguienteEstado(en('CORRIGIENDO'), { tipo: 'CAMBIO', que: 'HEAD', headSha: 'h2' }, ctx({ ronda: 1 }))).toMatchObject({ estado: 'PENDIENTE', ronda: 2 })
    expect(siguienteEstado(en('CORRIGIENDO'), { tipo: 'CAMBIO', que: 'BASE' }, ctx({ ronda: 1 }))).toMatchObject({ estado: 'DESACTUALIZADO', ronda: 1 })
  })

  it('fuera de CORRIGIENDO cualquier cambio de vigencia → DESACTUALIZADO', () => {
    for (const s of ['PENDIENTE', 'EN_REVISION', 'CAMBIOS_SOLICITADOS', 'APROBADO_TECNICAMENTE', 'BLOQUEADO'] as const) {
      for (const que of ['HEAD', 'BASE', 'CRITERIOS', 'POLITICA'] as const) {
        expect(siguienteEstado(en(s), { tipo: 'CAMBIO', que, headSha: 'h2' }, ctx()).estado).toBe('DESACTUALIZADO')
      }
    }
  })

  it('CAMBIOS_SOLICITADOS escala por rondas agotadas, desacuerdo repetido, sin autorización o sin presupuesto', () => {
    const e = en('CAMBIOS_SOLICITADOS')
    for (const p of [{ ronda: 2 }, { desacuerdoRepetido: true }, { autorizacionCorreccion: false }, { presupuestoDisponible: false }]) {
      expect(siguienteEstado(e, { tipo: 'CORRECCION_ENVIADA' }, ctx(p)).estado).toBe('ESCALADO')
    }
    expect(siguienteEstado(e, { tipo: 'CORRECCION_ENVIADA' }, ctx({ ronda: 1 })).estado).toBe('CORRIGIENDO')
  })

  it('INCONCLUSO → BLOQUEADO (se reconcilia, no se corrige)', () => {
    expect(siguienteEstado(en('EN_REVISION'), { tipo: 'REPORTE', veredicto: 'INCONCLUSO', headSha: 'h1' }, ctx())).toMatchObject({ estado: 'BLOQUEADO', estadoAnterior: 'EN_REVISION' })
  })

  it('PR fusionado termina el ciclo sin cambiar el estado ni la orden', () => {
    const r = siguienteEstado(en('APROBADO_TECNICAMENTE'), { tipo: 'PR_FUSIONADO' }, ctx())
    expect(r).toMatchObject({ estado: 'APROBADO_TECNICAMENTE', cicloTerminado: true, soloHistorico: true })
    const despues = siguienteEstado({ ...en('APROBADO_TECNICAMENTE'), cicloTerminado: true }, { tipo: 'ORDEN_CANCELADA' }, ctx())
    expect(despues).toMatchObject({ estado: 'APROBADO_TECNICAMENTE', motivo: MOTIVO_NO_PERMITIDA })
  })

  it('es determinista y no modifica sus entradas', () => {
    const a = Object.freeze(en('EN_REVISION'))
    const c = Object.freeze(ctx())
    const e = Object.freeze({ tipo: 'REPORTE', veredicto: 'CAMBIOS', headSha: 'h1' } as const)
    expect(siguienteEstado(a, e, c)).toEqual(siguienteEstado(a, e, c))
  })

  it('el resultado no expone efectos (fusionar, desplegar, cerrar, ORDENES_CODEX)', () => {
    const r = siguienteEstado(en('EN_REVISION'), { tipo: 'REPORTE', veredicto: 'CONFORME', headSha: 'h1' }, ctx())
    expect(Object.keys(r).sort()).toEqual(['cicloTerminado', 'estado', 'estadoAnterior', 'motivo', 'ronda', 'soloHistorico'])
  })
})

describe('casos negativos: transición no permitida', () => {
  const eventos: Evento[] = [
    { tipo: 'PR_REGISTRADO' }, { tipo: 'RESERVA_PERSISTIDA' }, { tipo: 'CORRECCION_ENVIADA' },
    { tipo: 'ENTREGA_CORRECCION', headSha: 'h2', mismoPrYRama: true }, { tipo: 'NUEVA_REVISION' }, { tipo: 'FALLO_TECNICO' },
    { tipo: 'RECONCILIACION', resultado: 'RECONCILIADA' },
  ]
  const permitido = (s: Estado | null, t: Evento['tipo']) =>
    (t === 'PR_REGISTRADO' && s === null) || (t === 'RESERVA_PERSISTIDA' && s === 'PENDIENTE') ||
    (t === 'CORRECCION_ENVIADA' && s === 'CAMBIOS_SOLICITADOS') || (t === 'ENTREGA_CORRECCION' && s === 'CORRIGIENDO') ||
    (t === 'NUEVA_REVISION' && s === 'DESACTUALIZADO') || (t === 'RECONCILIACION' && s === 'BLOQUEADO') ||
    (t === 'FALLO_TECNICO' && (s === 'PENDIENTE' || s === 'EN_REVISION' || s === 'CORRIGIENDO'))

  it('un evento fuera de su estado devuelve el mismo estado y ronda, sin lanzar', () => {
    for (const s of [null, ...ESTADOS]) {
      for (const e of eventos.filter((x) => !permitido(s, x.tipo))) {
        const a = en(s)
        const r = siguienteEstado(a, e, ctx({ ronda: 1 }))
        expect(r).toMatchObject({ estado: s, ronda: 1, motivo: MOTIVO_NO_PERMITIDA, soloHistorico: false })
      }
    }
  })

  it('sin estado registrado solo PR_REGISTRADO es válido', () => {
    expect(siguienteEstado(en(null), { tipo: 'PR_REGISTRADO' }, ctx()).estado).toBe('PENDIENTE')
    expect(siguienteEstado(en(null), { tipo: 'ORDEN_CANCELADA' }, ctx()).motivo).toBe(MOTIVO_NO_PERMITIDA)
    expect(siguienteEstado(en(null), { tipo: 'PR_FUSIONADO' }, ctx()).motivo).toBe(MOTIVO_NO_PERMITIDA)
  })

  it('evento desconocido o ronda inválida no lanzan', () => {
    expect(siguienteEstado(en('PENDIENTE'), { tipo: 'X' } as unknown as Evento, ctx()).motivo).toBe(MOTIVO_NO_PERMITIDA)
    expect(siguienteEstado(en('PENDIENTE'), { tipo: 'RESERVA_PERSISTIDA' }, ctx({ ronda: -1 })).motivo).toBe(MOTIVO_NO_PERMITIDA)
    expect(siguienteEstado(en('PENDIENTE'), { tipo: 'RESERVA_PERSISTIDA' }, ctx({ ronda: NaN })).estado).toBe('PENDIENTE')
  })

  it('una entrega inválida (otra rama, otro PR o el mismo head) no avanza ni consume ronda', () => {
    for (const e of [{ headSha: 'h2', mismoPrYRama: false }, { headSha: 'h1', mismoPrYRama: true }]) {
      expect(siguienteEstado(en('CORRIGIENDO'), { tipo: 'ENTREGA_CORRECCION', ...e }, ctx({ ronda: 1 }))).toMatchObject({ estado: 'CORRIGIENDO', ronda: 1 })
    }
  })
})
