/**
 * Estado esperado de la V1.6 desplegada (registro docs/estado-produccion-v1-6-2026-10-11.md).
 * Solo identificadores técnicos ya documentados: ningún secreto, correo de persona, ID de facturación ni dato de la hoja.
 * Lo usan las herramientas offline de docs/operacion-v1-6/ como referencia para comparar evidencia.
 */
export const PRODUCCION = Object.freeze({
  proyecto: 'project-os-511102',
  region: 'northamerica-south1',
  servicio: 'project-os-dashboard',
  revision: 'project-os-dashboard-00001-gsk',
  url: 'https://project-os-dashboard-235975889400.northamerica-south1.run.app',
  commit: '7f44216bdf85a9832e014f45c27ac643e00ceff9',
  digest: 'sha256:f6e46596ef36522134096d97431f32036bb71298033f9694023137497d3d5c07',
  imagenBase: 'northamerica-south1-docker.pkg.dev/project-os-511102/project-os/dashboard',
  repositorio: 'project-os',
  cuentaRuntime: 'project-os-dashboard-run@project-os-511102.iam.gserviceaccount.com',
  cuentaBuild: 'project-os-build@project-os-511102.iam.gserviceaccount.com',
  secretos: Object.freeze(['project-os-nextauth-secret', 'project-os-google-client-secret', 'project-os-allowed-emails']),
  /** Variables cuya presencia en la revisión activaría la escritura de V1.4 (deben faltar en producción). */
  variablesEscritura: Object.freeze(['PROJECT_OS_WRITE_MODE', 'AUTH_WRITER_EMAILS']),
  /** Día del registro de despliegue: una evidencia con fecha anterior no puede describir esta versión. */
  fechaDespliegue: '2026-10-11',
})

/**
 * Versión DESPLEGADA HOY (puede ser posterior a la línea base V1.6 de arriba). La usan P13 y P14 del preflight para
 * comprobar que el árbol coincide con lo que sirve producción. Cada despliegue autorizado la actualiza junto con su
 * registro fechado en docs/. PRODUCCION sigue describiendo la V1.6 congelada (línea base, matriz y acta).
 */
export const DESPLEGADO = Object.freeze({
  revision: 'project-os-dashboard-00002-58z',
  commit: '77a79705017139c99ac977c96602b0b0b5c19b1a',
  digest: 'sha256:cde104f0cec42810d6175fd521686a9b43dff1416cf259fa1bf8068d3a2745fe',
  registro: 'docs/estado-produccion-v1-7-2026-10-13.md',
})

/**
 * Controles que se comprueban con LECTURAS remotas del propietario (plan-inspeccion.mjs). Sin todos ellos, una evidencia
 * nunca da «todo OK» (evidencia.mjs, salvo --parcial). Una prueba comprueba que coincide con los pasos del plan.
 */
export const CONTROLES_LECTURA = Object.freeze(['A1', 'A2', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'E1', 'F3', 'G2'])

/** Archivos que entran en la imagen (web/.dockerignore y web/.gcloudignore): definen el código desplegado. */
export const RUTAS_DE_LA_IMAGEN = Object.freeze([
  'web/.dockerignore', 'web/Dockerfile', 'web/package.json', 'web/package-lock.json', 'web/next.config.ts',
  'web/tsconfig.json', 'web/src',
])

/** Estados válidos de la matriz y de la evaluación. NO_VERIFICADO nunca cuenta como OK. */
export const ESTADOS = Object.freeze(['OK', 'FALLO', 'NO_VERIFICADO'])

/** Código de salida común: 0 todo OK, 1 algún FALLO, 3 sin fallos pero con NO_VERIFICADO. */
export function codigoDeSalida(resultados) {
  if (resultados.some((r) => r.estado === 'FALLO')) return 1
  if (resultados.some((r) => r.estado !== 'OK')) return 3
  return 0
}

/** Línea de resultado de ancho fijo: estado, control y motivo. Nunca incluye valores observados sensibles. */
export function linea(r) {
  return `${r.estado.padEnd(13)} ${r.id.padEnd(5)} ${r.motivo}`
}
