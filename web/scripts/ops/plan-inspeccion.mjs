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
 * - --plantilla-evidencia imprime un esqueleto JSON para evidencia.mjs. Los campos observados van vacíos o en null:
 *   una lista vacía ([]) significa "ninguno" y solo debe escribirla quien lo haya comprobado.
 * - Código de salida: 0 plan impreso · 1 plan inseguro (no debería ocurrir) · 2 uso incorrecto.
 */
import { PRODUCCION as P } from './produccion-v1-6.mjs'

const G = `--project=${P.proyecto}`
/**
 * Envuelve una tubería de CONTEO para que un fallo de gcloud no se convierta en "0" (revisión R2): con pipefail,
 * si cualquier comando falla se imprime `conteo=LECTURA_FALLIDA`; si no, `conteo=<n>`. Siempre una sola línea.
 */
export const contar = (tuberia) => `( set -o pipefail; n=$(${tuberia}) && echo "conteo=$n" ) || echo "conteo=LECTURA_FALLIDA"`
const ENVOLTURA = /^\( set -o pipefail; n=\$\((.+)\) && echo "conteo=\$n" \) \|\| echo "conteo=LECTURA_FALLIDA"$/
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
    esperado: `incluye ${P.url}`, evidencia: { urls: null },
  },
  {
    control: 'A2', titulo: 'NEXTAUTH_URL de la revisión (es la URL pública, no un secreto)', tipo: 'gcloud',
    comando: `gcloud run services describe ${P.servicio} ${G} ${R} --format='yaml(spec.template.spec.containers[0].env)' | grep -A1 'name: NEXTAUTH_URL$'`,
    esperado: P.url, evidencia: { nextauth_url: '' },
  },
  {
    control: 'A2', titulo: 'Callback registrado en el cliente OAuth de producción', tipo: 'consola',
    comando: 'Google Auth Platform → Clientes → cliente de producción → URI de redireccionamiento autorizados',
    esperado: `${P.url}/api/auth/callback/google`, evidencia: { callback_oauth: '' },
  },
  {
    control: 'A4', titulo: 'Nombres de variables de la revisión (nunca valores)', tipo: 'gcloud',
    comando: `gcloud run services describe ${P.servicio} ${G} ${R} --format='value(spec.template.spec.containers[0].env[].name)'`,
    esperado: `sin ${P.variablesEscritura.join(' ni ')}`, evidencia: { variables: null },
  },
  {
    control: 'A5', titulo: 'Identidad del servicio y sus roles de proyecto', tipo: 'gcloud',
    comando: `gcloud run services describe ${P.servicio} ${G} ${R} --format='value(spec.template.spec.serviceAccountName)' && gcloud projects get-iam-policy ${P.proyecto} --flatten='bindings[].members' --filter='bindings.members:${RUNTIME}' --format='value(bindings.role)'`,
    esperado: `${P.cuentaRuntime}; roles de proyecto: ninguno`, evidencia: { cuenta: '', roles_proyecto: null },
  },
  ...P.secretos.map((s) => ({
    control: 'A6', titulo: `Acceso y versiones del secreto ${s} (nunca su valor)`, tipo: 'gcloud',
    comando: `gcloud secrets get-iam-policy ${s} ${G} --flatten='bindings[].members' --format='value(bindings.role,bindings.members)' && gcloud secrets versions list ${s} ${G} --format='value(name,state)'`,
    esperado: `una sola fila: roles/secretmanager.secretAccessor ${RUNTIME}; exactamente una versión ENABLED`,
    evidencia: { secreto: s, miembros: null, versiones: null, version_fijada: '' },
  })),
  {
    control: 'A6', titulo: 'Versión fijada de cada secreto en la revisión (número de versión, nunca el valor)', tipo: 'gcloud',
    comando: `gcloud run services describe ${P.servicio} ${G} ${R} --format='yaml(spec.template.spec.containers[0].env)' | grep -B1 'name: project-os-'`,
    esperado: 'para cada secreto, key: un número (nunca latest). Anótalo en version_fijada de su entrada A6',
    evidencia: null,
  },
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
    control: 'A8', titulo: 'Paso verificar-identidad en el log del build (CONTEO, sin contenido)', tipo: 'gcloud',
    comando: contar(`gcloud builds log 7768d6a3-332a-48bb-9872-db6b000e929a ${G} ${R} | { grep -c 'Identidad de compilación verificada' || true; }`),
    esperado: 'conteo=1 o más. Si sale conteo=LECTURA_FALLIDA, anota error: "LECTURA_FALLIDA" (nunca 0)', evidencia: { lineas_identidad_verificada: '' },
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
    evidencia: { imagenes: null, mayores_30_dias_no_protegidas: null },
  },
  ...[
    ['correo', '@'], ['token', 'ya29.'], ['bearer', 'Bearer '], ['codigo_oauth', 'code='],
  ].map(([nombre, patron]) => ({
    // Búsqueda de texto libre (sin campo): Cloud Logging la aplica a TODOS los campos (textPayload, jsonPayload,
    // protoPayload, httpRequest…). 30 días = retención del bucket _Default. Solo se imprime un CONTEO.
    control: 'E1', titulo: `Logs del servicio: CONTEO de «${patron}» en todos los campos, 30 días (nunca su contenido)`, tipo: 'gcloud',
    comando: contar(`gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="${P.servicio}" AND "${patron}"' ${G} --freshness=30d --limit=100000 --format='value(timestamp)' | wc -l`),
    esperado: 'conteo=0. Si es > 0, NO copiar líneas: runbook operativo §5. Si sale conteo=LECTURA_FALLIDA, anota error: "LECTURA_FALLIDA" (nunca 0)',
    evidencia: { patron: nombre, coincidencias: '', alcance: 'todos-los-campos', ventana_dias: 30 },
  })),
  {
    control: 'G2', titulo: 'Revisiones disponibles para rollback', tipo: 'gcloud',
    comando: `gcloud run revisions list --service=${P.servicio} ${G} ${R} --format='value(metadata.name,status.conditions[0].status)'`,
    esperado: 'hoy, solo la revisión 00001: G2 es NO_APLICA', evidencia: { revisiones: null, imagen_anterior_digest: '', ensayo_rollback: '' },
  },
  {
    control: 'G2', titulo: 'Solo si hay ≥ 2 revisiones: ¿sigue existiendo la imagen de la anterior?', tipo: 'gcloud',
    comando: `gcloud run revisions describe REVISION_ANTERIOR ${G} ${R} --format='value(spec.containers[0].image)'`,
    esperado: 'una imagen @sha256:…; después comprobarla con «artifacts docker images describe» y anotar su digest o NOT_FOUND en imagen_anterior_digest. ensayo_rollback solo tras un ensayo AUTORIZADO',
    evidencia: null,
  },
]

/** Verbos permitidos (solo lectura) y fragmentos prohibidos. La comprobación es estricta: falla cerrado. */
const PERMITIDO = /^(gcloud (run services describe|run revisions (list|describe)|builds log|projects get-iam-policy|secrets get-iam-policy|secrets versions list|builds describe|artifacts docker images (describe|list)|logging read) |bash web\/deploy\/infra\/limpieza-artifact-v1-6\.sh --check$)/
const PROHIBIDO = /versions access|--apply|add-iam|remove-iam|set-iam|\s(update|delete|create|replace|deploy|auth|enable|disable)\b|tags add|set-cleanup|--fix|>\s*\S/

export function comandosInseguros(pasos = PASOS) {
  // La envoltura de conteo es fija y se valida aparte; dentro solo puede haber una tubería de lectura permitida.
  const nucleo = (c) => ENVOLTURA.exec(c)?.[1] ?? c
  return pasos.filter((p) => p.tipo !== 'consola').flatMap((p) => nucleo(p.comando).split(' && ')
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
      controles: pasos.filter((p) => p.evidencia).map((p) => ({ id: p.control, fuente: 'propietario', comando: p.comando, observado: p.evidencia })),
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
