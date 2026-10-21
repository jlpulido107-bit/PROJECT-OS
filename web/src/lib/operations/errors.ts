/** Errores de operación con código estable, estado HTTP y mensaje seguro (sin valores ni datos internos). */
export type OperationErrorCode =
  | 'no-autenticado'
  | 'sin-permiso-lectura'
  | 'origen-invalido'
  | 'credenciales-ambiguas'
  | 'operacion-no-permitida'
  | 'escritura-deshabilitada'
  | 'sin-permiso-escritura'
  | 'tipo-contenido'
  | 'payload-demasiado-grande'
  | 'demasiadas-solicitudes'
  | 'json-invalido'
  | 'validacion'
  | 'proyecto-inexistente'
  | 'hito-inexistente'
  | 'tarea-inexistente'
  | 'orden-inexistente'
  | 'orden-cerrada'
  | 'orden-incompleta'
  | 'transicion-no-permitida'
  | 'tarea-cerrada'
  | 'cierre-no-permitido'
  | 'sin-cambios'
  | 'conflicto-version'
  | 'conflicto-concurrente'
  | 'conflicto-idempotencia'
  | 'esquema-invalido'
  | 'lectura-fallida'
  | 'auditoria-fallida'
  | 'escritura-fallida'
  | 'verificacion-fallida'
  | 'auditoria-inconsistente'
  | 'estado-divergente'
  | 'pr-no-fusionado'
  | 'orden-sin-proyecto'
  | 'github-no-disponible'
  | 'transicion-reservada-pm'
  | 'riesgo-alto-pm'
  | 'dictamen-no-valido'

const STATUS: Record<OperationErrorCode, number> = {
  'no-autenticado': 401,
  'sin-permiso-lectura': 403,
  'origen-invalido': 403,
  'credenciales-ambiguas': 400,
  'operacion-no-permitida': 403,
  'escritura-deshabilitada': 403,
  'sin-permiso-escritura': 403,
  'tipo-contenido': 415,
  'payload-demasiado-grande': 413,
  'demasiadas-solicitudes': 429,
  'json-invalido': 400,
  validacion: 422,
  'proyecto-inexistente': 422,
  'hito-inexistente': 422,
  'tarea-inexistente': 404,
  'orden-inexistente': 404,
  'orden-cerrada': 422,
  'orden-incompleta': 422,
  'transicion-no-permitida': 422,
  'tarea-cerrada': 422,
  'cierre-no-permitido': 422,
  'sin-cambios': 422,
  'conflicto-version': 409,
  'conflicto-concurrente': 409,
  'conflicto-idempotencia': 409,
  'esquema-invalido': 503,
  'lectura-fallida': 503,
  'auditoria-fallida': 503,
  'escritura-fallida': 503,
  'verificacion-fallida': 409,
  'auditoria-inconsistente': 409,
  'estado-divergente': 409,
  'pr-no-fusionado': 422,
  'orden-sin-proyecto': 422,
  'github-no-disponible': 503,
  'transicion-reservada-pm': 403,
  'riesgo-alto-pm': 422,
  'dictamen-no-valido': 422,
}

const MESSAGES: Record<OperationErrorCode, string> = {
  'no-autenticado': 'Inicia sesión para continuar.',
  'sin-permiso-lectura': 'Tu cuenta no está autorizada.',
  'origen-invalido': 'Solicitud rechazada por origen no válido.',
  'credenciales-ambiguas': 'La solicitud trae dos credenciales distintas.',
  'operacion-no-permitida': 'Esta credencial no puede realizar esa operación.',
  'escritura-deshabilitada': 'La escritura está deshabilitada en este servidor.',
  'sin-permiso-escritura': 'Tu cuenta solo tiene permiso de lectura.',
  'tipo-contenido': 'Se esperaba JSON.',
  'payload-demasiado-grande': 'La solicitud es demasiado grande.',
  'demasiadas-solicitudes': 'Demasiadas operaciones seguidas. Espera unos segundos.',
  'json-invalido': 'El cuerpo de la solicitud no es JSON válido.',
  validacion: 'Hay campos con errores.',
  'proyecto-inexistente': 'El proyecto no existe.',
  'hito-inexistente': 'El hito no existe o no pertenece al proyecto.',
  'tarea-inexistente': 'La tarea no existe.',
  'orden-inexistente': 'La orden no existe.',
  'orden-cerrada': 'La orden ya está cerrada o cancelada.',
  'orden-incompleta': 'La orden no se puede aprobar: le faltan datos, su tarea no existe o su riesgo es ALTO.',
  'transicion-no-permitida': 'Ese cambio de estado no está permitido desde el estado actual.',
  'tarea-cerrada': 'La tarea está cerrada y no se puede modificar desde el dashboard.',
  'cierre-no-permitido': 'Cerrar una tarea (COMPLETADO/CANCELADO) requiere aprobación humana y no está disponible.',
  'sin-cambios': 'No hay cambios que guardar.',
  'conflicto-version': 'La tarea cambió desde que la abriste. Recarga y vuelve a intentarlo.',
  'conflicto-concurrente': 'Otra modificación se cruzó con la tuya. Recarga y vuelve a intentarlo.',
  'conflicto-idempotencia': 'Esta solicitud ya se usó con otros datos. Recarga el formulario.',
  'esquema-invalido': 'La estructura de la hoja no coincide con el contrato; no se escribió nada.',
  'lectura-fallida': 'No se pudo leer la hoja; no se escribió nada.',
  'auditoria-fallida': 'No se pudo registrar la auditoría; no se escribió nada.',
  'escritura-fallida': 'La auditoría quedó registrada pero la escritura falló. Reintenta para completarla.',
  'verificacion-fallida': 'La escritura no se pudo verificar; queda pendiente de conciliación.',
  'auditoria-inconsistente': 'La auditoría de esta solicitud está incompleta o es contradictoria; queda para revisión manual.',
  'estado-divergente': 'El registro no coincide con lo auditado (cambio sin operación auditada); revisa la conciliación.',
  'orden-sin-proyecto': 'La orden no tiene PROYECTO_ID; no se consultó GitHub ni se cerró nada.',
  'pr-no-fusionado': 'GitHub no confirma un PR fusionado con el ID de la orden en el título; no se cerró nada.',
  'github-no-disponible': 'No se pudo leer el PR en GitHub; no se cerró nada.',
  'transicion-reservada-pm': 'El agente PM solo aprueba, envía y marca REVISADA; esa transición es del propietario.',
  'riesgo-alto-pm': 'El agente PM no aprueba ni envía órdenes de riesgo ALTO; no se escribió nada.',
  'dictamen-no-valido': 'No hay un dictamen válido del head actual del PR; no se marcó REVISADA.',
}

const BRAND = Symbol.for('project-os.operation-error')

export class OperationError extends Error {
  /**
   * Next empaqueta rutas y páginas por separado y el runtime simulado vive en globalThis: un error lanzado
   * por el servicio puede venir de otra copia de esta clase. `instanceof` se resuelve por marca, no por identidad.
   */
  static [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[BRAND] === true
  }

  readonly [BRAND] = true
  readonly code: OperationErrorCode
  readonly status: number
  readonly fields?: Record<string, string>
  readonly detail?: Record<string, string | number>

  constructor(code: OperationErrorCode, opts: { fields?: Record<string, string>; detail?: Record<string, string | number> } = {}) {
    super(MESSAGES[code])
    this.name = 'OperationError'
    this.code = code
    this.status = STATUS[code]
    this.fields = opts.fields
    this.detail = opts.detail
  }
}
