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
  | 'dictamen-insuficiente'
  | 'autorizacion-no-valida'
  | 'pr-no-detectado'
  | 'finanzas-esquema-invalido'
  | 'finanzas-ids-agotados'
  | 'monto-no-cuadra'
  | 'ajuste-excede-original'
  | 'movimiento-inexistente'
  | 'recurrente-inexistente'
  | 'recurrente-ya-confirmado'
  | 'corte-no-cerrado'
  | 'corte-fuera-de-plazo'
  | 'corte-ya-registrado'
  | 'monto-excede-tope'
  | 'factura-no-cuadra'
  | 'suscripcion-sin-confirmar'
  | 'moneda-no-permitida'
  | 'tipo-cambio-sin-dato'
  | 'eco-esquema-invalido'
  | 'eco-pestana-llena'
  | 'campo-no-permitido'
  | 'campo-solo-lectura'
  | 'registro-inexistente'
  | 'referencia-inexistente'
  | 'requisito-faltante'
  | 'asin-duplicado'
  | 'elegida-duplicada'
  | 'instrucciones-sin-columna'
  | 'idea-encabezados-distintos'
  | 'idea-fila-ocupada'
  | 'scoring-sin-formulas'
  | 'idea-sin-calculo'
  | 'migracion-pendiente'
  | 'version-faltante'
  | 'semana-inexistente'
  | 'capacidad-semana-ocupada'
  | 'escenario-inexistente'
  | 'escenario-archivado'
  | 'dia-pasado'
  | 'plan-diario-duplicado'
  | 'plan-item-duplicado'

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
  'dictamen-insuficiente': 422,
  'autorizacion-no-valida': 422,
  'pr-no-detectado': 422,
  'finanzas-esquema-invalido': 400,
  'finanzas-ids-agotados': 409,
  'monto-no-cuadra': 400,
  'ajuste-excede-original': 409,
  'movimiento-inexistente': 422,
  'recurrente-inexistente': 422,
  'recurrente-ya-confirmado': 409,
  'corte-no-cerrado': 400,
  'corte-fuera-de-plazo': 400,
  'corte-ya-registrado': 409,
  'monto-excede-tope': 400,
  'factura-no-cuadra': 409,
  'suscripcion-sin-confirmar': 409,
  'moneda-no-permitida': 400,
  'tipo-cambio-sin-dato': 409,
  'eco-esquema-invalido': 400,
  'eco-pestana-llena': 409,
  'campo-no-permitido': 400,
  'campo-solo-lectura': 409,
  'registro-inexistente': 404,
  'referencia-inexistente': 422,
  'requisito-faltante': 409,
  'asin-duplicado': 409,
  'elegida-duplicada': 409,
  'instrucciones-sin-columna': 422,
  'idea-encabezados-distintos': 409,
  'idea-fila-ocupada': 409,
  'scoring-sin-formulas': 409,
  'idea-sin-calculo': 409,
  'migracion-pendiente': 422,
  'version-faltante': 409,
  'semana-inexistente': 422,
  'capacidad-semana-ocupada': 409,
  'escenario-inexistente': 404,
  'escenario-archivado': 409,
  'dia-pasado': 422,
  'plan-diario-duplicado': 409,
  'plan-item-duplicado': 409,
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
  'conflicto-version': 'El registro cambió desde que lo abriste. Recarga y vuelve a intentarlo.',
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
  'dictamen-insuficiente': 'El dictamen del head actual no es CONFORME suficiente (DEC-POS-011, 019 y 022: en MEDIO sensible, también SEGUNDO de otro modelo; si es gemini-supervisado, solo con la vía encendida por el propietario y firmado por un modelo distinto del implementador); no se marcó REVISADA.',
  'autorizacion-no-valida': 'La autorización no lleva el ID de esta orden, la palabra «sí» y la fecha de hoy, o ya se usó para otra orden; no se escribió nada.',
  'pr-no-detectado': 'No hay un único PR abierto de la orden detectado en GitHub; el agente PM no registró nada.',
  'finanzas-esquema-invalido': 'FINANZAS no tiene las pestañas o columnas que exige la escritura (MOVIMIENTOS, RECURRENTES y AUDITORIA); no se escribió nada.',
  'finanzas-ids-agotados': 'Se agotaron los MOV_ID MAN-NNNN; hace falta una orden de migración. No se escribió nada.',
  'monto-no-cuadra': 'MONTO_MXN no cuadra con MONTO_ORIG × TIPO_CAMBIO; no se escribió nada.',
  'ajuste-excede-original': 'El ajuste dejaría el movimiento original por debajo de 0; no se escribió nada.',
  'movimiento-inexistente': 'El movimiento que se quiere ajustar no existe o no es un original; no se escribió nada.',
  'recurrente-inexistente': 'El recurrente no existe, tiene un problema o no está vigente en ese mes; no se escribió nada.',
  'recurrente-ya-confirmado': 'Ese recurrente ya está confirmado en ese mes; no se escribió nada.',
  'corte-no-cerrado': 'El corte todavía no cierra (Q1 desde el día 16, Q2 desde el día 1 del mes siguiente); no se escribió nada.',
  'corte-fuera-de-plazo': 'Solo se registran cortes del mes actual o del anterior; uno más viejo se captura a mano. No se escribió nada.',
  'corte-ya-registrado': 'Ese corte ya está registrado con otra solicitud; no se escribió nada.',
  'monto-excede-tope': 'El monto supera el tope de 3,000.00 USD por fila; se captura a mano. No se escribió nada.',
  'factura-no-cuadra': 'El total de factura no cuadra con la suscripción confirmada del corte; no se escribió nada.',
  'suscripcion-sin-confirmar': 'La suscripción de Claude cae en este corte y su recurrente no está confirmado; no se escribió nada.',
  'moneda-no-permitida': 'La moneda del total debe ser USD o MXN; no se escribió nada.',
  'tipo-cambio-sin-dato': 'Falta un TIPO_CAMBIO_DEFECTO válido en PARAMETROS para revisar el tope; no se escribió nada.',
  'eco-esquema-invalido': 'RADAROS no tiene las pestañas PIPE_* o las columnas que exige el pipeline (o hay una repetida); no se escribió nada.',
  'eco-pestana-llena': 'Una pestaña PIPE_* llegó al límite de filas; archívala (diseño /eco pipeline §7.2) y vuelve a intentarlo. No se escribió nada.',
  'campo-no-permitido': 'La solicitud trae campos que esta operación no admite; no se escribió nada.',
  'campo-solo-lectura': 'Esa celda es una fórmula de la hoja y es de solo lectura en el dashboard; no se escribió nada.',
  'registro-inexistente': 'El registro no existe en el pipeline.',
  'referencia-inexistente': 'El producto, proveedor o cotización referido no existe o no está disponible; no se escribió nada.',
  'requisito-faltante': 'Falta un dato que exige ese cambio; no se escribió nada.',
  'asin-duplicado': 'Ese ASIN ya está en otro producto (uno descartado solo vuelve con «reabrir»); no se escribió nada.',
  'elegida-duplicada': 'El producto ya tiene una cotización ELEGIDA; no se escribió nada.',
  'instrucciones-sin-columna': 'La pestaña TAREAS aún no tiene la columna INSTRUCCIONES (la añade el propietario con la migración); quita las instrucciones o espera la migración. No se escribió nada.',
  'idea-encabezados-distintos': 'Los encabezados de PRODUCTS (A a P) o de SCORING (A a L) del libro de RADAROS no son los esperados (detalle: columnas); no se escribió nada.',
  'idea-fila-ocupada': 'La primera fila con PRODUCT_ID vacío en PRODUCTS tiene otros datos; no se editan filas existentes. No se escribió nada.',
  'scoring-sin-formulas': 'La fila nueva de SCORING no tiene las fórmulas M a P copiadas (las prepara el propietario a mano); no se escribió nada, tampoco en PRODUCTS.',
  'idea-sin-calculo': 'La idea se escribió, pero la columna M de su fila de SCORING quedó sin valor; revisa las fórmulas de SCORING.',
  'migracion-pendiente': 'La hoja aún no tiene la migración que pide esta operación (la aplica el propietario, docs/escritura-v1-8.md §11.2). No se escribió nada.',
  'version-faltante': 'La fila no tiene VERSION (o no es un entero): escribe 1 en la hoja, según la migración, antes de editarla. No se escribió nada.',
  'semana-inexistente': 'Esa semana no tiene fila en CAPACIDAD_SEMANAL: no hay nada que editar. Recarga la vista.',
  'escenario-inexistente': 'Ese escenario no existe en ESCENARIOS. Recarga la vista.',
  'escenario-archivado': 'El escenario ya estaba archivado; no se escribió nada.',
  'capacidad-semana-ocupada': 'Ya hay otra fila de CAPACIDAD_SEMANAL con FECHA_INICIO en esa semana: deja una sola. No se escribió nada.',
  'dia-pasado': 'Ese día ya pasó: su plan registrado no se reescribe. No se escribió nada.',
  'plan-diario-duplicado': 'Hay más de un plan activo en PLAN_DIARIO para ese día: deja uno solo en la hoja. No se escribió nada.',
  'plan-item-duplicado': 'El plan de ese día tiene más de una fila de PLAN_ITEMS para la misma tarea: deja una sola en la hoja. No se escribió nada.',
}

/**
 * Detalle seguro de un rechazo (sin correos ni payloads). ORD-POS-140 añade null y objetos JSON: el plan actual del día
 * en un conflicto de `plan.dia.guardar`, para mostrarlo sin recargar.
 */
export type OperationDetail = string | number | null | { readonly [key: string]: OperationDetail } | readonly OperationDetail[]

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
  readonly detail?: Record<string, OperationDetail>

  constructor(code: OperationErrorCode, opts: { fields?: Record<string, string>; detail?: Record<string, OperationDetail> } = {}) {
    super(MESSAGES[code])
    this.name = 'OperationError'
    this.code = code
    this.status = STATUS[code]
    this.fields = opts.fields
    this.detail = opts.detail
  }
}
