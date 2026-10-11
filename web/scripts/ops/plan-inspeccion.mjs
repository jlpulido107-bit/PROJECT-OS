#!/usr/bin/env node
/**
 * Plan de inspección de SOLO LECTURA de la V1.6 desplegada (docs/operacion-v1-6/runbook-operativo.md).
 *
 *   node scripts/ops/plan-inspeccion.mjs [--control A9[,A7…]] [--json] [--plantilla-evidencia]
 *
 * - SOLO IMPRIME: no ejecuta gcloud, curl ni ninguna consulta. Los comandos los ejecuta el propietario con su cuenta.
 * - Cada comando se valida contra una lista de verbos de lectura; si alguno no la cumple, el script falla (código 1)
 *   antes de imprimir nada. Nunca lee valores de secretos (`versions access`) ni datos de la hoja.
 * - Las salidas pedidas son mínimas y sin PII: digests, nombres de variables, roles, conteos.
 * - --plantilla-evidencia imprime un esqueleto JSON para evidencia.mjs, con los campos observados vacíos.
 * - Código de salida: 0 plan impreso · 1 plan inseguro (no debería ocurrir) · 2 uso incorrecto.
 */
import { PRODUCCION as P } from './produccion-v1-6.mjs'

const G = `--project=${P.proyecto}`
const R = `--region=${P.region}`
const RUNTIME = `serviceAccount:${P.cuentaRuntime}`

/** Cada paso: control, qué se comprueba, tipo (gcloud o consola), comando o instrucción, esperado y campo de evidencia. */
export const PASOS = [
  {
    control: 'A1', titulo: 'Imagen de la revisión activa', tipo: 'gcloud',
    comando: `gcloud run services describe ${P.servicio} ${G} ${R} --format='value(spec.template.spec.containers[0].image)'`,
    esperado: `${P.imagenBase}@${P.digest}`, evidencia: { imagen: '' },
  },
  {
    control: 'A2', titulo: 'URLs publicadas por Cloud Run', tipo: 'gcloud',
    comando: `gcloud run services describe ${P.servicio} ${G} ${R} --format='value(metadata.annotations."run.googleapis.com/urls")'`,
    esperado: `incluye ${P.url}`, evidencia: { urls: [] },
  },
  {
    control: 'A4', titulo: 'Nombres de variables de la revisión (nunca valores)', tipo: 'gcloud',
    comando: `gcloud run services describe ${P.servicio} ${G} ${R} --format='value(spec.template.spec.containers[0].env[].name)'`,
    esperado: `sin ${P.variablesEscritura.join(' ni ')}`, evidencia: { variables: [] },
  },
  {
    control: 'A5', titulo: 'Identidad del servicio y sus roles de proyecto', tipo: 'gcloud',
    comando: `gcloud run services describe ${P.servicio} ${G} ${R} --format='value(spec.template.spec.serviceAccountName)' && gcloud projects get-iam-policy ${P.proyecto} --flatten='bindings[].members' --filter='bindings.members:${RUNTIME}' --format='value(bindings.role)'`,
    esperado: `${P.cuentaRuntime}; roles de proyecto: ninguno`, evidencia: { cuenta: '', roles_proyecto: [] },
  },
  ...P.secretos.map((s) => ({
    control: 'A6', titulo: `Acceso y versiones del secreto ${s} (nunca su valor)`, tipo: 'gcloud',
    comando: `gcloud secrets get-iam-policy ${s} ${G} --flatten='bindings[].members' --format='value(bindings.role,bindings.members)' && gcloud secrets versions list ${s} ${G} --format='value(name,state)'`,
    esperado: `una sola fila: roles/secretmanager.secretAccessor ${RUNTIME}; la versión fijada en ENABLED`,
    evidencia: { secreto: s, miembros: [], versiones: [] },
  })),
  {
    control: 'A7', titulo: 'Límites de escala: revisión Y servicio (D-1)', tipo: 'gcloud',
    comando: `gcloud run services describe ${P.servicio} ${G} ${R} --format='yaml(metadata.annotations."run.googleapis.com/maxScale",spec.template.metadata.annotations)'`,
    esperado: 'revisión minScale 0, maxScale 1, cpu-throttling true; anotar el maxScale de servicio tal cual',
    evidencia: { revision_minScale: '', revision_maxScale: '', cpu_throttling: '', servicio_maxScale: '' },
  },
  {
    control: 'A7', titulo: 'Instancias reales (máximo de los últimos 30 días)', tipo: 'consola',
    comando: `Metrics Explorer → Cloud Run Revision → Instance count (run.googleapis.com/container/instance_count), servicio ${P.servicio}, agregación max, 30 días`,
    esperado: 'el máximo observado (un número); si supera 1, D-1 deja de ser hipotético', evidencia: { instancias_max_30d: '' },
  },
  {
    control: 'A8', titulo: 'Cuenta del build que produjo la imagen', tipo: 'gcloud',
    comando: `gcloud builds describe 7768d6a3-332a-48bb-9872-db6b000e929a ${G} ${R} --format='value(serviceAccount)'`,
    esperado: `projects/${P.proyecto}/serviceAccounts/${P.cuentaBuild}`, evidencia: { cuenta_build: '' },
  },
  {
    control: 'A9', titulo: 'Digest al que apunta la etiqueta produccion', tipo: 'gcloud',
    comando: `gcloud artifacts docker images describe ${P.imagenBase}:produccion ${G} --format='value(image_summary.digest)'`,
    esperado: `${P.digest} (si responde NOT_FOUND, la etiqueta no existe)`, evidencia: { digest_produccion: '' },
  },
  {
    control: 'F3', titulo: 'Política de limpieza activa', tipo: 'script',
    comando: 'bash web/deploy/infra/limpieza-artifact-v1-6.sh --check',
    esperado: 'PERMITIDO (código 0)', evidencia: { check: '' },
  },
  {
    control: 'F3', titulo: 'Imágenes y etiquetas del repositorio (sin borrar nada)', tipo: 'gcloud',
    comando: `gcloud artifacts docker images list ${P.imagenBase} ${G} --include-tags --format='value(version,tags,createTime)'`,
    esperado: 'con ≥ 5 imágenes y alguna de > 30 días: solo quedan produccion, produccion-anterior y las 3 más recientes',
    evidencia: { imagenes: 0, mayores_30_dias_no_protegidas: 0 },
  },
  ...[
    ['correo', '@'], ['token', 'ya29.'], ['bearer', 'Bearer '], ['codigo_oauth', 'code='],
  ].map(([nombre, patron]) => ({
    control: 'E1', titulo: `Logs de la app: CONTEO de coincidencias de «${patron}» (nunca su contenido)`, tipo: 'gcloud',
    comando: `gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="${P.servicio}" AND textPayload:"${patron}"' ${G} --freshness=7d --limit=1000 --format='value(timestamp)' | wc -l`,
    esperado: '0. Si es > 0, NO copiar líneas: seguir el runbook operativo §5',
    evidencia: { patron: nombre, coincidencias: '' },
  })),
  {
    control: 'G2', titulo: 'Revisiones disponibles para rollback', tipo: 'gcloud',
    comando: `gcloud run revisions list --service=${P.servicio} ${G} ${R} --format='value(metadata.name,status.conditions[0].status)'`,
    esperado: 'hoy, solo la revisión 00001: G2 es NO_APLICA', evidencia: { revisiones: [] },
  },
]

/** Verbos permitidos (solo lectura) y fragmentos prohibidos. La comprobación es estricta: falla cerrado. */
const PERMITIDO = /^(gcloud (run services describe|run revisions list|projects get-iam-policy|secrets get-iam-policy|secrets versions list|builds describe|artifacts docker images (describe|list)|logging read) |bash web\/deploy\/infra\/limpieza-artifact-v1-6\.sh --check$)/
const PROHIBIDO = /versions access|--apply|add-iam|remove-iam|set-iam|\s(update|delete|create|replace|deploy|auth|enable|disable)\b|tags add|set-cleanup|--fix|>\s*\S/

export function comandosInseguros(pasos = PASOS) {
  return pasos.filter((p) => p.tipo !== 'consola').flatMap((p) => p.comando.split(' && ')
    .filter((c) => !PERMITIDO.test(c) || PROHIBIDO.test(c)).map((c) => `${p.control}: ${c}`))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const ci = args.indexOf('--control')
  const conocidos = ['--control', '--json', '--plantilla-evidencia']
  if (args.some((a, i) => !conocidos.includes(a) && args[i - 1] !== '--control') || (ci > -1 && !args[ci + 1])) {
    console.error('Uso: node scripts/ops/plan-inspeccion.mjs [--control A9[,A7…]] [--json] [--plantilla-evidencia]')
    process.exit(2)
  }
  const filtro = ci > -1 ? args[ci + 1].toUpperCase().split(',') : null
  const pasos = filtro ? PASOS.filter((p) => filtro.includes(p.control)) : PASOS
  if (filtro && pasos.length === 0) {
    console.error(`Ningún paso para ${filtro.join(',')}. Controles: ${[...new Set(PASOS.map((p) => p.control))].join(', ')}`)
    process.exit(2)
  }
  const inseguros = comandosInseguros(pasos)
  if (inseguros.length) {
    console.error('PLAN INSEGURO: hay comandos fuera de la lista de lectura. No se imprime nada.')
    process.exit(1)
  }
  if (args.includes('--plantilla-evidencia')) {
    const plantilla = {
      version: 1, fecha: 'AAAA-MM-DD', commit_desplegado: P.commit, revision: P.revision,
      controles: pasos.map((p) => ({ id: p.control, fuente: 'propietario', comando: p.comando, observado: p.evidencia })),
    }
    console.log(JSON.stringify(plantilla, null, 2))
  } else if (args.includes('--json')) {
    console.log(JSON.stringify({ version: 1, solo_lectura: true, pasos }, null, 2))
  } else {
    console.log(`PROJECT-OS V1.6 — plan de inspección de SOLO LECTURA (${P.proyecto}, ${P.region}, ${P.servicio})`)
    console.log('Este script no ejecuta nada. Copia la salida mínima pedida, sin correos ni valores, en el archivo de evidencia.\n')
    for (const p of pasos) {
      console.log(`[${p.control}] ${p.titulo}  (${p.tipo})`)
      console.log(`  ${p.comando}`)
      console.log(`  Esperado: ${p.esperado}\n`)
    }
  }
}
