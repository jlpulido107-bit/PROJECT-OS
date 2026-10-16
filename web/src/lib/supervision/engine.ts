import type { Contexto, Estado, EstadoActual, Evento, Resultado } from './types'

/**
 * Motor de estados de supervisión: función PURA y determinista (contrato §2, §4, §5).
 * Sin red, hoja, reloj ni azar; no modifica sus entradas ni lanza excepciones.
 * No fusiona, despliega, cierra tareas ni toca ORDENES_CODEX: solo devuelve el estado siguiente.
 */
export const RONDA_MAXIMA = 2
export const MOTIVO_NO_PERMITIDA = 'transición no permitida'

const out = (a: EstadoActual, ctx: Contexto, estado: Estado | null, motivo: string, extra: Partial<Resultado> = {}): Resultado => ({
  estado, estadoAnterior: a.estadoAnterior, cicloTerminado: a.cicloTerminado, ronda: ctx.ronda, motivo, soloHistorico: false, ...extra,
})
const igual = (a: EstadoActual, ctx: Contexto, motivo: string, soloHistorico = false): Resultado =>
  out(a, ctx, a.estado, motivo, { soloHistorico })
const noPermitida = (a: EstadoActual, ctx: Contexto): Resultado => igual(a, ctx, MOTIVO_NO_PERMITIDA)
const bloquear = (a: EstadoActual, ctx: Contexto, motivo: string): Resultado =>
  out(a, ctx, 'BLOQUEADO', motivo, { estadoAnterior: a.estado })

/** Entrega de corrección: PENDIENTE con ronda +1 (nueva clave y nueva reserva). */
const entrega = (a: EstadoActual, ctx: Contexto): Resultado =>
  out(a, ctx, 'PENDIENTE', 'entrega de corrección: nueva revisión pendiente', { ronda: ctx.ronda + 1 })

const desactualizar = (a: EstadoActual, ctx: Contexto): Resultado =>
  out(a, ctx, 'DESACTUALIZADO', 'cambió head, base, criterios o política: aprobación o revisión sin vigencia')

function evaluarCorreccion(a: EstadoActual, ctx: Contexto): Resultado {
  const escalar = (motivo: string) => out(a, ctx, 'ESCALADO', motivo)
  if (!ctx.hallazgosDentroDeAlcance) return escalar('hallazgo fuera de alcance: se escala sin consumir ronda')
  if (ctx.desacuerdoRepetido) return escalar('mismo desacuerdo repetido sin avance')
  if (ctx.ronda >= RONDA_MAXIMA) return escalar('rondas de corrección agotadas')
  if (!ctx.autorizacionCorreccion) return escalar('sin autorización de corrección en la orden')
  if (!ctx.presupuestoDisponible) return escalar('sin presupuesto disponible')
  return out(a, ctx, 'CORRIGIENDO', 'solicitud de corrección enviada')
}

function transicion(a: EstadoActual, e: Evento, ctx: Contexto): Resultado {
  const s = a.estado
  switch (e.tipo) {
    case 'PR_REGISTRADO':
      return s === null ? out(a, ctx, 'PENDIENTE', 'PR registrado') : noPermitida(a, ctx)

    case 'ORDEN_CANCELADA':
    case 'PR_CERRADO_SIN_FUSION':
      if (s === null) return noPermitida(a, ctx)
      if (s === 'ESCALADO') return igual(a, ctx, 'ya escalado: el ciclo no se reanuda')
      return out(a, ctx, 'ESCALADO', e.tipo === 'ORDEN_CANCELADA' ? 'orden cancelada: sin reanudación' : 'PR cerrado sin fusión: sin reanudación')

    case 'PR_FUSIONADO':
      if (s === null) return noPermitida(a, ctx)
      return igual({ ...a, cicloTerminado: true }, ctx, 'PR fusionado: ciclo terminado; la orden no cambia', true)

    case 'REPORTE': {
      if (s === null) return noPermitida(a, ctx)
      if (s !== 'EN_REVISION') return igual(a, ctx, 'reporte fuera de una revisión en curso: solo histórico', true)
      if (e.headSha !== ctx.headVigente) return igual(a, ctx, 'reporte de otro head: solo histórico; se exige revisión del head vigente', true)
      if (e.veredicto === 'CONFORME') return out(a, ctx, 'APROBADO_TECNICAMENTE', 'reporte CONFORME: espera al propietario')
      if (e.veredicto === 'CAMBIOS') return out(a, ctx, 'CAMBIOS_SOLICITADOS', 'reporte CAMBIOS')
      if (e.veredicto === 'INCONCLUSO') return bloquear(a, ctx, 'reporte INCONCLUSO: se reconcilia, no se corrige')
      return noPermitida(a, ctx)
    }

    case 'RESERVA_PERSISTIDA':
      if (s !== 'PENDIENTE') return noPermitida(a, ctx)
      if (!ctx.comprobacionesRequeridasTerminadas) return igual(a, ctx, 'comprobaciones requeridas sin terminar: sigue pendiente')
      if (!ctx.presupuestoDisponible) return igual(a, ctx, 'sin presupuesto disponible: sigue pendiente')
      return out(a, ctx, 'EN_REVISION', 'reserva persistida y solicitud enviada')

    case 'CORRECCION_ENVIADA':
      return s === 'CAMBIOS_SOLICITADOS' ? evaluarCorreccion(a, ctx) : noPermitida(a, ctx)

    case 'ENTREGA_CORRECCION':
      if (s !== 'CORRIGIENDO') return noPermitida(a, ctx)
      if (!e.mismoPrYRama || e.headSha === ctx.headVigente) return igual(a, ctx, 'entrega inválida: debe ser un head nuevo en el mismo PR y rama', true)
      return entrega(a, ctx)

    case 'CAMBIO':
      if (s === null || s === 'ESCALADO') return noPermitida(a, ctx)
      if (s === 'CORRIGIENDO' && e.que === 'HEAD') {
        return e.headSha === ctx.headVigente ? igual(a, ctx, 'head sin cambios', true) : entrega(a, ctx)
      }
      if (s === 'DESACTUALIZADO') return igual(a, ctx, 'ya desactualizado')
      return desactualizar(a, ctx)

    case 'NUEVA_REVISION':
      return s === 'DESACTUALIZADO' ? out(a, ctx, 'PENDIENTE', 'nueva revisión con nueva clave') : noPermitida(a, ctx)

    case 'FALLO_TECNICO':
      return s === 'PENDIENTE' || s === 'EN_REVISION' || s === 'CORRIGIENDO'
        ? bloquear(a, ctx, 'fallo técnico o lanzamiento desconocido: se reconcilia sin consumir ronda')
        : noPermitida(a, ctx)

    case 'RECONCILIACION': {
      if (s !== 'BLOQUEADO') return noPermitida(a, ctx)
      const previo = a.estadoAnterior
      if (e.resultado === 'RECONCILIADA' && previo !== null && previo !== 'BLOQUEADO' && previo !== 'ESCALADO') {
        return out(a, ctx, previo, 'reconciliado: vuelve al estado anterior', { estadoAnterior: null })
      }
      return out(a, ctx, 'ESCALADO', 'reconciliación imposible', { estadoAnterior: null })
    }

    default:
      return noPermitida(a, ctx)
  }
}

/**
 * Estado siguiente, ronda resultante, motivo y si el resultado es solo histórico.
 * Un evento no permitido en el estado actual devuelve el mismo estado con motivo «transición no permitida».
 */
export function siguienteEstado(actual: EstadoActual, evento: Evento, contexto: Contexto): Resultado {
  if (!Number.isInteger(contexto.ronda) || contexto.ronda < 0) {
    return { estado: actual.estado, estadoAnterior: actual.estadoAnterior, cicloTerminado: actual.cicloTerminado, ronda: contexto.ronda, motivo: MOTIVO_NO_PERMITIDA, soloHistorico: false }
  }
  if (actual.cicloTerminado && evento.tipo !== 'REPORTE' && evento.tipo !== 'PR_FUSIONADO') return noPermitida(actual, contexto)
  if (actual.cicloTerminado && evento.tipo === 'REPORTE') return igual(actual, contexto, 'ciclo terminado: reporte solo histórico', true)
  return transicion(actual, evento, contexto)
}
