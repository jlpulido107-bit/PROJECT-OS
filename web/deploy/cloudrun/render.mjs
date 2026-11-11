#!/usr/bin/env node
/**
 * Renderiza service.template.yaml con variables de entorno y lo imprime por stdout.
 * NO contacta a Google Cloud ni despliega: el resultado se revisa a mano y se aplica manualmente
 * (docs/despliegue-privado-v1-3.md). Falla si falta una variable o si un valor es inseguro.
 *
 *   node deploy/cloudrun/render.mjs > /tmp/project-os-service.yaml
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

const REQUIRED = {
  SERVICE_NAME: /^[a-z][a-z0-9-]{0,48}[a-z0-9]$/,
  PROJECT_ID: /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/,
  REGION: /^[a-z]+-[a-z]+\d$/,
  IMAGE: /^[a-z0-9.-]+-docker\.pkg\.dev\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9._-]+@sha256:[0-9a-f]{64}$/,
  RUNTIME_SA: /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z0-9-]+\.iam\.gserviceaccount\.com$/,
  SERVICE_URL: /^https:\/\/[a-z0-9.-]+$/,
  OAUTH_CLIENT_ID: /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/,
  SECRET_VERSION_NEXTAUTH: /^[1-9][0-9]*$/,
  SECRET_VERSION_OAUTH: /^[1-9][0-9]*$/,
  SECRET_VERSION_ALLOWLIST: /^[1-9][0-9]*$/,
}

export function render(template, env) {
  const problems = []
  for (const [name, pattern] of Object.entries(REQUIRED)) {
    const value = env[name]?.trim()
    // Solo se nombra la variable; nunca se imprime su valor.
    if (!value) problems.push(`falta ${name}`)
    else if (!pattern.test(value)) problems.push(`${name} no tiene el formato esperado`)
  }
  if (!problems.length && env.RUNTIME_SA.trim().split('@')[1] !== `${env.PROJECT_ID.trim()}.iam.gserviceaccount.com`) {
    problems.push('RUNTIME_SA debe pertenecer a PROJECT_ID')
  }
  const writeBlock = escritura(env, problems) + radaros(template, env, problems) + finanzas(template, env, problems) + finanzasEscritura(env, problems) + finanzasAgente(env, problems) + ecoPipeline(env, problems) + segundoGemini(env, problems) + cierrePropietario(env, problems) + edicionPlanificacion(env, problems) + tiemposAgente(env, problems) + calendarioIcs(env, problems) + ideasAlta(env, problems) + ecoTabulador(env, problems) + ecoBandejaGemini(env, problems) + commitDesplegado(env, problems)
  if (problems.length) throw new Error(problems.join('; '))
  const output = template.replace(/\$\{([A-Z_]+)\}/g, (match, name) => {
    if (!(name in REQUIRED)) throw new Error(`variable no reconocida en la plantilla: ${name}`)
    return env[name].trim()
  })
  const marker = /^ *# __ESCRITURA__.*\n/m
  if (writeBlock && !marker.test(output)) throw new Error('la plantilla no tiene el marcador __ESCRITURA__: no se puede agregar la escritura, RADAROS_SHEET_ID, FINANZAS_SHEET_ID, la escritura de finanzas, el agente de finanzas, la escritura del pipeline de ECO, SEGUNDO_GEMINI_SUPERVISADO, TAREAS_CIERRE_PROPIETARIO, PLANIFICACION_EDICION_PROPIETARIO, TIEMPOS_AGENTE, PLANIFICACION_ICS, ECO_IDEAS_ALTA, ECO_TABULADOR, ECO_BANDEJA_GEMINI ni DEPLOY_COMMIT_SHA')
  return output.replace(marker, writeBlock)
}

/**
 * Escritura real opcional (V1.8, docs/plan-v1-8-automatizacion.md). Sin WRITE_MODE (o con `disabled`) la plantilla
 * queda de solo lectura, igual que V1.6. Con `sheets` exige:
 * - WRITE_SERVICE_ACCOUNT: cuenta dedicada del mismo proyecto, distinta de la runtime;
 * - SECRET_VERSION_WRITERS: versión fijada del secreto project-os-writer-emails (lista de escritores).
 * Opcional (F4): SECRET_VERSION_GITHUB, versión fijada del secreto project-os-github-token (issue de cada orden).
 * Opcional (F5a, docs/rutina-claude.md): CLAUDE_ROUTINE_ID (no secreto) y SECRET_VERSION_CLAUDE_ROUTINE, versión fijada del
 * secreto project-os-claude-routine-token. Van juntos y exigen SECRET_VERSION_GITHUB (la ejecución se registra en el issue).
 * Opcional (ORD-POS-037, docs/rutina-claude.md): por parejas y con la misma exigencia, CLAUDE_ROUTINE_REVISAR_ID con
 * SECRET_VERSION_CLAUDE_ROUTINE_REVISAR (secreto project-os-claude-routine-revisar-token), y lo mismo con _SEGUNDO y _CORREGIR.
 * Habilitan los botones «Lanzar revisión», «Lanzar segundo revisor» y «Pedir corrección» de /ordenes.
 * Opcional (ORD-POS-028, docs/escritura-v1-8.md §6): SECRET_VERSION_PM_AGENT, versión fijada del secreto
 * project-os-pm-agent-token-sha256 (hash del token del agente PM). Solo con WRITE_MODE=sheets; nunca el hash ni el token literal.
 * Opcional (ORD-POS-063, DEC-POS-014): PM_PUEDE_REGISTRAR_PR=true habilita REGISTRAR_PR del agente PM con el PR detectado.
 * Solo la exporta el propietario; exige SECRET_VERSION_PM_AGENT y SECRET_VERSION_GITHUB. Sin ella, el permiso queda apagado.
 */
const ROUTINE_ID = /^[A-Za-z0-9_-]{8,80}$/
const WRITE_SA = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/

function escritura(env, problems) {
  const mode = (env.WRITE_MODE ?? '').trim()
  const pmAgent = (env.SECRET_VERSION_PM_AGENT ?? '').trim()
  if (pmAgent && !/^[1-9][0-9]*$/.test(pmAgent)) problems.push('SECRET_VERSION_PM_AGENT no tiene el formato esperado')
  else if (pmAgent && mode !== 'sheets') problems.push('SECRET_VERSION_PM_AGENT exige WRITE_MODE=sheets')
  const registrarPr = (env.PM_PUEDE_REGISTRAR_PR ?? '').trim()
  if (registrarPr && registrarPr !== 'true') problems.push('PM_PUEDE_REGISTRAR_PR solo admite true')
  else if (registrarPr && (!pmAgent || !(env.SECRET_VERSION_GITHUB ?? '').trim())) problems.push('PM_PUEDE_REGISTRAR_PR exige SECRET_VERSION_PM_AGENT y SECRET_VERSION_GITHUB')
  if (mode === '' || mode === 'disabled') return ''
  if (mode !== 'sheets') {
    problems.push('WRITE_MODE debe ser disabled o sheets')
    return ''
  }
  const account = (env.WRITE_SERVICE_ACCOUNT ?? '').trim()
  const version = (env.SECRET_VERSION_WRITERS ?? '').trim()
  if (!WRITE_SA.test(account)) problems.push('WRITE_SERVICE_ACCOUNT no tiene el formato esperado')
  else if (account === (env.RUNTIME_SA ?? '').trim()) problems.push('WRITE_SERVICE_ACCOUNT no puede ser la cuenta runtime')
  else if (account.split('@')[1] !== `${(env.PROJECT_ID ?? '').trim()}.iam.gserviceaccount.com`) problems.push('WRITE_SERVICE_ACCOUNT debe pertenecer a PROJECT_ID')
  if (!/^[1-9][0-9]*$/.test(version)) problems.push('SECRET_VERSION_WRITERS no tiene el formato esperado')
  const github = (env.SECRET_VERSION_GITHUB ?? '').trim()
  if (github && !/^[1-9][0-9]*$/.test(github)) problems.push('SECRET_VERSION_GITHUB no tiene el formato esperado')
  const githubLines = github ? [
    '            - name: GITHUB_DISPATCH_TOKEN',
    '              valueFrom:',
    '                secretKeyRef:',
    '                  name: project-os-github-token',
    `                  key: '${github}'`,
  ] : []
  const routineId = (env.CLAUDE_ROUTINE_ID ?? '').trim()
  const routine = (env.SECRET_VERSION_CLAUDE_ROUTINE ?? '').trim()
  if (Boolean(routineId) !== Boolean(routine)) problems.push('CLAUDE_ROUTINE_ID y SECRET_VERSION_CLAUDE_ROUTINE van juntos')
  else if (routine && !github) problems.push('la rutina de Claude exige SECRET_VERSION_GITHUB')
  if (routineId && !ROUTINE_ID.test(routineId)) problems.push('CLAUDE_ROUTINE_ID no tiene el formato esperado')
  if (routine && !/^[1-9][0-9]*$/.test(routine)) problems.push('SECRET_VERSION_CLAUDE_ROUTINE no tiene el formato esperado')
  const routineLines = routineId && routine ? [
    '            - name: CLAUDE_ROUTINE_ID',
    `              value: ${routineId}`,
    '            - name: CLAUDE_ROUTINE_TOKEN',
    '              valueFrom:',
    '                secretKeyRef:',
    '                  name: project-os-claude-routine-token',
    `                  key: '${routine}'`,
  ] : []
  const supervisionLines = ['REVISAR', 'SEGUNDO', 'CORREGIR'].flatMap((nombre) => {
    const id = (env[`CLAUDE_ROUTINE_${nombre}_ID`] ?? '').trim()
    const version = (env[`SECRET_VERSION_CLAUDE_ROUTINE_${nombre}`] ?? '').trim()
    if (Boolean(id) !== Boolean(version)) problems.push(`CLAUDE_ROUTINE_${nombre}_ID y SECRET_VERSION_CLAUDE_ROUTINE_${nombre} van juntos`)
    else if (version && !github) problems.push(`la rutina ${nombre} exige SECRET_VERSION_GITHUB`)
    if (id && !ROUTINE_ID.test(id)) problems.push(`CLAUDE_ROUTINE_${nombre}_ID no tiene el formato esperado`)
    if (version && !/^[1-9][0-9]*$/.test(version)) problems.push(`SECRET_VERSION_CLAUDE_ROUTINE_${nombre} no tiene el formato esperado`)
    return id && version ? [
      `            - name: CLAUDE_ROUTINE_${nombre}_ID`, `              value: ${id}`, `            - name: CLAUDE_ROUTINE_${nombre}_TOKEN`,
      '              valueFrom:', '                secretKeyRef:', `                  name: project-os-claude-routine-${nombre.toLowerCase()}-token`, `                  key: '${version}'`,
    ] : []
  })
  const registrarPrLines = registrarPr === 'true' ? ['            - name: PM_PUEDE_REGISTRAR_PR', "              value: 'true'"] : []
  const pmAgentLines = pmAgent ? [
    '            - name: PM_AGENT_TOKEN_SHA256',
    '              valueFrom:',
    '                secretKeyRef:',
    '                  name: project-os-pm-agent-token-sha256',
    `                  key: '${pmAgent}'`,
  ] : []
  return [
    '            - name: PROJECT_OS_WRITE_MODE',
    '              value: sheets',
    '            - name: PROJECT_OS_WRITE_SERVICE_ACCOUNT',
    `              value: ${account}`,
    '            - name: AUTH_WRITER_EMAILS',
    '              valueFrom:',
    '                secretKeyRef:',
    '                  name: project-os-writer-emails',
    `                  key: '${version}'`,
    ...githubLines,
    ...routineLines,
    ...supervisionLines,
    ...pmAgentLines,
    ...registrarPrLines,
    '',
  ].join('\n')
}

/**
 * Opcional (ORD-POS-100, DEC-POS-022 y DEC-POS-014): SEGUNDO_GEMINI_SUPERVISADO=on hace contar el SEGUNDO de origen
 * gemini-supervisado en /ordenes y en REVISAR del PM. Solo la exporta el propietario; sin ella, el YAML no cambia y la
 * vía queda apagada (un SEGUNDO gemini-supervisado no cuenta). Es independiente de WRITE_MODE: /ordenes también lo lee.
 */
function segundoGemini(env, problems) {
  const valor = (env.SEGUNDO_GEMINI_SUPERVISADO ?? '').trim()
  if (!valor) return ''
  if (valor !== 'on') problems.push('SEGUNDO_GEMINI_SUPERVISADO solo admite on')
  return ['            - name: SEGUNDO_GEMINI_SUPERVISADO', "              value: 'on'", ''].join('\n')
}

/**
 * Opcional (ORD-POS-106, DEC-POS-023 y DEC-POS-014): cierre de tareas por el propietario desde el dashboard, apagado
 * por defecto. Las dos van juntas y solo las exporta el propietario:
 * - TAREAS_CIERRE_PROPIETARIO: solo `true`; exige WRITE_MODE=sheets (usa la escritura de PROJECT-OS).
 * - TAREAS_CIERRE_PROPIETARIO_EMAIL: un único correo (el servidor exige además que esté en AUTH_ALLOWED_EMAILS).
 * Sin ninguna de las dos, el YAML no cambia; nunca se imprime un valor.
 */
function cierrePropietario(env, problems) {
  const flag = (env.TAREAS_CIERRE_PROPIETARIO ?? '').trim()
  const owner = (env.TAREAS_CIERRE_PROPIETARIO_EMAIL ?? '').trim()
  if (!flag && !owner) return ''
  const antes = problems.length
  if (flag !== 'true') problems.push('TAREAS_CIERRE_PROPIETARIO solo admite true')
  if (!flag || !owner) problems.push('TAREAS_CIERRE_PROPIETARIO y TAREAS_CIERRE_PROPIETARIO_EMAIL van juntas')
  if ((env.WRITE_MODE ?? '').trim() !== 'sheets') problems.push('TAREAS_CIERRE_PROPIETARIO exige WRITE_MODE=sheets')
  if (owner && !UN_CORREO.test(owner)) problems.push('TAREAS_CIERRE_PROPIETARIO_EMAIL debe ser un único correo')
  if (problems.length > antes) return ''
  return [
    '            - name: TAREAS_CIERRE_PROPIETARIO',
    "              value: 'true'",
    '            - name: TAREAS_CIERRE_PROPIETARIO_EMAIL',
    `              value: '${owner}'`,
    '',
  ].join('\n')
}

/**
 * Opcional (ORD-POS-136, DEC-POS-029 a, b y g): edición en línea de FECHA_PLAN, HORAS_ESTIMADAS e HITO_ID desde la capa
 * Semana de /planificacion, apagada por defecto. Las dos van juntas y solo las exporta el propietario:
 * - PLANIFICACION_EDICION_PROPIETARIO: solo `true`; exige WRITE_MODE=sheets (usa la escritura de PROJECT-OS).
 * - PLANIFICACION_EDICION_PROPIETARIO_EMAIL: un único correo (el servidor exige además que esté en AUTH_ALLOWED_EMAILS).
 * Sin ninguna de las dos, el YAML no cambia; nunca se imprime un valor.
 */
function edicionPlanificacion(env, problems) {
  const flag = (env.PLANIFICACION_EDICION_PROPIETARIO ?? '').trim()
  const owner = (env.PLANIFICACION_EDICION_PROPIETARIO_EMAIL ?? '').trim()
  if (!flag && !owner) return ''
  const antes = problems.length
  if (flag && flag !== 'true') problems.push('PLANIFICACION_EDICION_PROPIETARIO solo admite true')
  if (!flag || !owner) problems.push('PLANIFICACION_EDICION_PROPIETARIO y PLANIFICACION_EDICION_PROPIETARIO_EMAIL van juntas')
  if ((env.WRITE_MODE ?? '').trim() !== 'sheets') problems.push('PLANIFICACION_EDICION_PROPIETARIO exige WRITE_MODE=sheets')
  if (owner && !UN_CORREO.test(owner)) problems.push('PLANIFICACION_EDICION_PROPIETARIO_EMAIL debe ser un único correo')
  if (problems.length > antes) return ''
  return [
    '            - name: PLANIFICACION_EDICION_PROPIETARIO',
    "              value: 'true'",
    '            - name: PLANIFICACION_EDICION_PROPIETARIO_EMAIL',
    `              value: '${owner}'`,
    '',
  ].join('\n')
}

/**
 * Opcional (ORD-POS-112, DEC-POS-025 y DEC-POS-014): rol Tiempos, apagado por defecto. Las dos van juntas y solo las
 * exporta el propietario:
 * - TIEMPOS_AGENTE: solo `true`. Enciende la lectura de /api/planificacion con el token de Tiempos y `tiempo.crear`
 *   del PM.
 * - SECRET_VERSION_TIEMPOS_AGENTE: versión del secreto project-os-tiempos-agente-token-sha256 (TIEMPOS_AGENTE_TOKEN_SHA256).
 * Sin ninguna de las dos, el YAML no cambia; nunca se imprime un valor.
 */
function tiemposAgente(env, problems) {
  const flag = (env.TIEMPOS_AGENTE ?? '').trim()
  const version = (env.SECRET_VERSION_TIEMPOS_AGENTE ?? '').trim()
  if (!flag && !version) return ''
  const antes = problems.length
  if (flag && flag !== 'true') problems.push('TIEMPOS_AGENTE solo admite true')
  if (!flag || !version) problems.push('TIEMPOS_AGENTE y SECRET_VERSION_TIEMPOS_AGENTE van juntas')
  if (version && !/^[1-9][0-9]*$/.test(version)) problems.push('SECRET_VERSION_TIEMPOS_AGENTE no tiene el formato esperado')
  if (problems.length > antes) return ''
  return [
    '            - name: TIEMPOS_AGENTE',
    "              value: 'true'",
    '            - name: TIEMPOS_AGENTE_TOKEN_SHA256',
    '              valueFrom:',
    '                secretKeyRef:',
    '                  name: project-os-tiempos-agente-token-sha256',
    `                  key: '${version}'`,
    '',
  ].join('\n')
}

/**
 * Opcional (ORD-POS-142, DEC-POS-029 e y g; docs/escritura-v1-8.md §11.3): calendario ICS de solo lectura, apagado por
 * defecto. Las dos van juntas y solo las exporta el propietario:
 * - PLANIFICACION_ICS: solo `true`. Enciende GET /api/planificacion/calendario.ics?token=<secreto>. No depende de WRITE_MODE.
 * - SECRET_VERSION_CALENDARIO_ICS: versión del secreto project-os-calendario-ics-token-sha256 (CALENDARIO_ICS_TOKEN_SHA256,
 *   el SHA-256 del secreto del enlace; nunca el secreto). Rotar = versión nueva del secreto y redespliegue.
 * Sin ninguna de las dos, el YAML no cambia; nunca se imprime un valor.
 */
function calendarioIcs(env, problems) {
  const flag = (env.PLANIFICACION_ICS ?? '').trim()
  const version = (env.SECRET_VERSION_CALENDARIO_ICS ?? '').trim()
  if (!flag && !version) return ''
  const antes = problems.length
  if (flag && flag !== 'true') problems.push('PLANIFICACION_ICS solo admite true')
  if (!flag || !version) problems.push('PLANIFICACION_ICS y SECRET_VERSION_CALENDARIO_ICS van juntas')
  if (version && !/^[1-9][0-9]*$/.test(version)) problems.push('SECRET_VERSION_CALENDARIO_ICS no tiene el formato esperado')
  if (problems.length > antes) return ''
  return [
    '            - name: PLANIFICACION_ICS',
    "              value: 'true'",
    '            - name: CALENDARIO_ICS_TOKEN_SHA256',
    '              valueFrom:',
    '                secretKeyRef:',
    '                  name: project-os-calendario-ics-token-sha256',
    `                  key: '${version}'`,
    '',
  ].join('\n')
}

/**
 * Opcional (ORD-POS-131, DEC-ECO-007 y DEC-POS-014): alta de ideas en PRODUCTS y SCORING de RADAROS por el agente PM,
 * apagada por defecto. Solo la exporta el propietario:
 * - ECO_IDEAS_ALTA: solo `true`. Exige WRITE_MODE=sheets y SECRET_VERSION_PM_AGENT (token del PM y AUDITORIA de
 *   PROJECT-OS) y ECO_PIPELINE_WRITE_MODE=sheets (usa la cuenta de escritura del pipeline y RADAROS_SHEET_ID).
 * Sin ella, el YAML no cambia.
 */
function ideasAlta(env, problems) {
  const flag = (env.ECO_IDEAS_ALTA ?? '').trim()
  if (!flag) return ''
  const antes = problems.length
  if (flag !== 'true') problems.push('ECO_IDEAS_ALTA solo admite true')
  if ((env.WRITE_MODE ?? '').trim() !== 'sheets' || !(env.SECRET_VERSION_PM_AGENT ?? '').trim()) problems.push('ECO_IDEAS_ALTA exige WRITE_MODE=sheets y SECRET_VERSION_PM_AGENT')
  if ((env.ECO_PIPELINE_WRITE_MODE ?? '').trim() !== 'sheets') problems.push('ECO_IDEAS_ALTA exige ECO_PIPELINE_WRITE_MODE=sheets (usa su cuenta de escritura)')
  if (problems.length > antes) return ''
  return ['            - name: ECO_IDEAS_ALTA', "              value: 'true'", ''].join('\n')
}

/**
 * Opcional (ORD-POS-145, DEC-ECO-008; docs/diseno-eco-pipeline.md §14.6): tabulador de cotizaciones de /eco/pipeline,
 * de solo lectura y apagado por defecto. Solo lo exporta el propietario:
 * - ECO_TABULADOR: solo `true`. Muestra la vista «Comparar cotizaciones»; no escribe nada ni depende de WRITE_MODE.
 * Sin ella, el YAML no cambia.
 */
function ecoTabulador(env, problems) {
  const flag = (env.ECO_TABULADOR ?? '').trim()
  if (!flag) return ''
  if (flag !== 'true') {
    problems.push('ECO_TABULADOR solo admite true')
    return ''
  }
  return ['            - name: ECO_TABULADOR', "              value: 'true'", ''].join('\n')
}

/**
 * Opcional (ORD-POS-155, DEC-POS-031; docs/diseno-eco-pipeline.md §18.4): bandeja de Gemini de /eco/pipeline, apagada por
 * defecto. Solo la exporta el propietario:
 * - ECO_BANDEJA_GEMINI: solo `true`. Exige ECO_PIPELINE_WRITE_MODE=sheets: confirmar y rechazar escriben con la cuenta,
 *   el guard y la auditoría del pipeline.
 * Sin ella, el YAML no cambia.
 */
function ecoBandejaGemini(env, problems) {
  const flag = (env.ECO_BANDEJA_GEMINI ?? '').trim()
  if (!flag) return ''
  const antes = problems.length
  if (flag !== 'true') problems.push('ECO_BANDEJA_GEMINI solo admite true')
  if ((env.ECO_PIPELINE_WRITE_MODE ?? '').trim() !== 'sheets') problems.push('ECO_BANDEJA_GEMINI exige ECO_PIPELINE_WRITE_MODE=sheets (escribe con la escritura del pipeline)')
  if (problems.length > antes) return ''
  return ['            - name: ECO_BANDEJA_GEMINI', "              value: 'true'", ''].join('\n')
}

/**
 * Opcional (ORD-POS-124, docs/diseno-planificacion-v2.md §9 pregunta 2, DEC-POS-028 punto 2): DEPLOY_COMMIT_SHA, el commit
 * que se despliega, como literal (no es secreto). El servidor la lee en solo lectura para «Desplegada» (/planificacion) y
 * «Fusionado sin desplegar» (Inicio). deploy.sh siempre la pasa (exportada o de `git rev-parse HEAD`); sin ella, el YAML
 * no cambia y esas dos fuentes quedan apagadas. Solo un SHA completo (40 hexadecimales en minúsculas), entre comillas.
 */
function commitDesplegado(env, problems) {
  const sha = (env.DEPLOY_COMMIT_SHA ?? '').trim()
  if (!sha) return ''
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    problems.push('DEPLOY_COMMIT_SHA debe ser un SHA completo (40 hexadecimales en minúsculas)')
    return ''
  }
  return ['            - name: DEPLOY_COMMIT_SHA', `              value: '${sha}'`, ''].join('\n')
}

/**
 * Opcional (ORD-POS-067, docs/diseno-eco-radaros.md §2 y §6): RADAROS_SHEET_ID, ID del libro de RADAROS para /eco.
 * Literal (no es credencial), con el formato de SHEETS_SPREADSHEET_ID y distinto de él; nunca se imprime el valor.
 * Sin ella, el YAML no cambia y /eco queda inerte. Es independiente de WRITE_MODE: /eco solo lee.
 */
const SPREADSHEET_ID = /^[A-Za-z0-9_-]{20,100}$/

function radaros(template, env, problems) {
  const id = (env.RADAROS_SHEET_ID ?? '').trim()
  if (!id) return ''
  const propia = /^ *- name: SHEETS_SPREADSHEET_ID\n *value: '?([A-Za-z0-9_-]+)'?$/m.exec(template)?.[1]
  if (!SPREADSHEET_ID.test(id)) problems.push('RADAROS_SHEET_ID no tiene el formato esperado')
  else if (!propia) problems.push('la plantilla no tiene SHEETS_SPREADSHEET_ID: no se puede validar RADAROS_SHEET_ID')
  else if (id === propia) problems.push('RADAROS_SHEET_ID no puede ser la hoja de PROJECT-OS')
  // Entre comillas: un ID solo de dígitos no debe leerse como número.
  return [`            - name: RADAROS_SHEET_ID`, `              value: '${id}'`, ''].join('\n')
}

/**
 * Opcional (ORD-POS-074, docs/diseno-finanzas.md §3 y §6): FINANZAS_SHEET_ID, ID del libro FINANZAS para /finanzas.
 * Literal, con el formato de SHEETS_SPREADSHEET_ID y distinto de ella y de RADAROS_SHEET_ID; nunca se imprime el valor.
 * Sin ella, el YAML no cambia y /finanzas queda inerte.
 */
function finanzas(template, env, problems) {
  const id = (env.FINANZAS_SHEET_ID ?? '').trim()
  if (!id) return ''
  const propia = /^ *- name: SHEETS_SPREADSHEET_ID\n *value: '?([A-Za-z0-9_-]+)'?$/m.exec(template)?.[1]
  if (!SPREADSHEET_ID.test(id)) problems.push('FINANZAS_SHEET_ID no tiene el formato esperado')
  else if (!propia) problems.push('la plantilla no tiene SHEETS_SPREADSHEET_ID: no se puede validar FINANZAS_SHEET_ID')
  else if (id === propia) problems.push('FINANZAS_SHEET_ID no puede ser la hoja de PROJECT-OS')
  else if (id === (env.RADAROS_SHEET_ID ?? '').trim()) problems.push('FINANZAS_SHEET_ID no puede ser la hoja de RADAROS')
  return [`            - name: FINANZAS_SHEET_ID`, `              value: '${id}'`, ''].join('\n')
}

/**
 * Opcional (ORD-POS-077, docs/diseno-finanzas-v2.md §7 con la opción C de §6): escritura de finanzas, apagada por
 * defecto. Las tres variables van juntas y solo las exporta el propietario:
 * - FINANZAS_WRITE_MODE: solo `sheets`; exige FINANZAS_SHEET_ID.
 * - FINANZAS_WRITE_SERVICE_ACCOUNT: cuenta exclusiva de FINANZAS, del mismo proyecto, distinta de la runtime (lectura) y
 *   de WRITE_SERVICE_ACCOUNT (escritura de PROJECT-OS).
 * - FINANZAS_WRITER_EMAIL: un único correo (el servidor exige además que esté en AUTH_ALLOWED_EMAILS).
 * Es independiente de WRITE_MODE. Sin ninguna de las tres, el YAML no cambia; nunca se imprime un valor.
 */
const UN_CORREO = /^[^@\s,;'"]+@[^@\s,;'"]+\.[^@\s,;'"]+$/

function finanzasEscritura(env, problems) {
  const mode = (env.FINANZAS_WRITE_MODE ?? '').trim()
  const account = (env.FINANZAS_WRITE_SERVICE_ACCOUNT ?? '').trim()
  const writer = (env.FINANZAS_WRITER_EMAIL ?? '').trim()
  if (!mode && !account && !writer) return ''
  const antes = problems.length
  if (mode !== 'sheets') problems.push('FINANZAS_WRITE_MODE solo admite sheets')
  if (!mode || !account || !writer) problems.push('FINANZAS_WRITE_MODE, FINANZAS_WRITE_SERVICE_ACCOUNT y FINANZAS_WRITER_EMAIL van juntas')
  if (!(env.FINANZAS_SHEET_ID ?? '').trim()) problems.push('FINANZAS_WRITE_MODE exige FINANZAS_SHEET_ID')
  if (account) {
    if (!WRITE_SA.test(account)) problems.push('FINANZAS_WRITE_SERVICE_ACCOUNT no tiene el formato esperado')
    else if (account === (env.RUNTIME_SA ?? '').trim()) problems.push('FINANZAS_WRITE_SERVICE_ACCOUNT no puede ser la cuenta runtime (lectura)')
    else if (account === (env.WRITE_SERVICE_ACCOUNT ?? '').trim()) problems.push('FINANZAS_WRITE_SERVICE_ACCOUNT no puede ser la cuenta de escritura de PROJECT-OS')
    else if (account.split('@')[1] !== `${(env.PROJECT_ID ?? '').trim()}.iam.gserviceaccount.com`) problems.push('FINANZAS_WRITE_SERVICE_ACCOUNT debe pertenecer a PROJECT_ID')
  }
  if (writer && !UN_CORREO.test(writer)) problems.push('FINANZAS_WRITER_EMAIL debe ser un único correo')
  if (problems.length > antes) return ''
  return [
    '            - name: FINANZAS_WRITE_MODE',
    '              value: sheets',
    '            - name: FINANZAS_WRITE_SERVICE_ACCOUNT',
    `              value: ${account}`,
    '            - name: FINANZAS_WRITER_EMAIL',
    `              value: '${writer}'`,
    '',
  ].join('\n')
}

/**
 * Opcional (ORD-POS-092, docs/diseno-finanzas-v3.md §8.1): rutas del agente de finanzas, apagadas por defecto. Las tres
 * variables van juntas y solo las exporta el propietario:
 * - FINANZAS_AGENTE_MODE: solo `sheets`; exige FINANZAS_SHEET_ID.
 * - FINANZAS_AGENTE_SERVICE_ACCOUNT: cuenta exclusiva del agente, del mismo proyecto, distinta de la runtime (lectura),
 *   de WRITE_SERVICE_ACCOUNT y de FINANZAS_WRITE_SERVICE_ACCOUNT (la del propietario).
 * - SECRET_VERSION_FINANZAS_AGENTE: versión fijada del secreto project-os-finanzas-agente-token-sha256 (hash del token
 *   del agente), montada como FINANZAS_AGENTE_TOKEN_SHA256; nunca el hash ni el token literal.
 * Es independiente de WRITE_MODE y de FINANZAS_WRITE_MODE. Sin ninguna de las tres, el YAML no cambia; nunca se imprime
 * un valor. Que el hash no sea el del PM no se puede ver aquí: lo comprueba el propietario y, en ejecución, el guard.
 */
function finanzasAgente(env, problems) {
  const mode = (env.FINANZAS_AGENTE_MODE ?? '').trim()
  const account = (env.FINANZAS_AGENTE_SERVICE_ACCOUNT ?? '').trim()
  const version = (env.SECRET_VERSION_FINANZAS_AGENTE ?? '').trim()
  if (!mode && !account && !version) return ''
  const antes = problems.length
  if (mode !== 'sheets') problems.push('FINANZAS_AGENTE_MODE solo admite sheets')
  if (!mode || !account || !version) problems.push('FINANZAS_AGENTE_MODE, FINANZAS_AGENTE_SERVICE_ACCOUNT y SECRET_VERSION_FINANZAS_AGENTE van juntas')
  if (!(env.FINANZAS_SHEET_ID ?? '').trim()) problems.push('FINANZAS_AGENTE_MODE exige FINANZAS_SHEET_ID')
  if (account) {
    if (!WRITE_SA.test(account)) problems.push('FINANZAS_AGENTE_SERVICE_ACCOUNT no tiene el formato esperado')
    else if (account === (env.RUNTIME_SA ?? '').trim()) problems.push('FINANZAS_AGENTE_SERVICE_ACCOUNT no puede ser la cuenta runtime (lectura)')
    else if (account === (env.WRITE_SERVICE_ACCOUNT ?? '').trim()) problems.push('FINANZAS_AGENTE_SERVICE_ACCOUNT no puede ser la cuenta de escritura de PROJECT-OS')
    else if (account === (env.FINANZAS_WRITE_SERVICE_ACCOUNT ?? '').trim()) problems.push('FINANZAS_AGENTE_SERVICE_ACCOUNT no puede ser la cuenta de escritura del propietario en FINANZAS')
    else if (account.split('@')[1] !== `${(env.PROJECT_ID ?? '').trim()}.iam.gserviceaccount.com`) problems.push('FINANZAS_AGENTE_SERVICE_ACCOUNT debe pertenecer a PROJECT_ID')
  }
  if (version && !/^[1-9][0-9]*$/.test(version)) problems.push('SECRET_VERSION_FINANZAS_AGENTE no tiene el formato esperado')
  if (problems.length > antes) return ''
  return [
    '            - name: FINANZAS_AGENTE_MODE',
    '              value: sheets',
    '            - name: FINANZAS_AGENTE_SERVICE_ACCOUNT',
    `              value: ${account}`,
    '            - name: FINANZAS_AGENTE_TOKEN_SHA256',
    '              valueFrom:',
    '                secretKeyRef:',
    '                  name: project-os-finanzas-agente-token-sha256',
    `                  key: '${version}'`,
    '',
  ].join('\n')
}

/**
 * Opcional (ORD-POS-102, docs/diseno-eco-pipeline.md §7.1): escritura del pipeline de /eco, apagada por defecto. Las
 * tres variables van juntas y solo las exporta el propietario:
 * - ECO_PIPELINE_WRITE_MODE: solo `sheets`; exige RADAROS_SHEET_ID.
 * - ECO_PIPELINE_WRITE_SERVICE_ACCOUNT: cuenta exclusiva del pipeline, del mismo proyecto, distinta de la runtime
 *   (lectura), de WRITE_SERVICE_ACCOUNT y de las dos de finanzas (FINANZAS_WRITE_SERVICE_ACCOUNT y
 *   FINANZAS_AGENTE_SERVICE_ACCOUNT).
 * - ECO_PIPELINE_WRITER_EMAIL: un único correo (el servidor exige además que esté en AUTH_ALLOWED_EMAILS).
 * Es independiente de WRITE_MODE y de FINANZAS_WRITE_MODE. Sin ninguna de las tres, el YAML no cambia; nunca se imprime
 * un valor.
 */
function ecoPipeline(env, problems) {
  const mode = (env.ECO_PIPELINE_WRITE_MODE ?? '').trim()
  const account = (env.ECO_PIPELINE_WRITE_SERVICE_ACCOUNT ?? '').trim()
  const writer = (env.ECO_PIPELINE_WRITER_EMAIL ?? '').trim()
  if (!mode && !account && !writer) return ''
  const antes = problems.length
  if (mode !== 'sheets') problems.push('ECO_PIPELINE_WRITE_MODE solo admite sheets')
  if (!mode || !account || !writer) problems.push('ECO_PIPELINE_WRITE_MODE, ECO_PIPELINE_WRITE_SERVICE_ACCOUNT y ECO_PIPELINE_WRITER_EMAIL van juntas')
  if (!(env.RADAROS_SHEET_ID ?? '').trim()) problems.push('ECO_PIPELINE_WRITE_MODE exige RADAROS_SHEET_ID')
  if (account) {
    if (!WRITE_SA.test(account)) problems.push('ECO_PIPELINE_WRITE_SERVICE_ACCOUNT no tiene el formato esperado')
    else if (account === (env.RUNTIME_SA ?? '').trim()) problems.push('ECO_PIPELINE_WRITE_SERVICE_ACCOUNT no puede ser la cuenta runtime (lectura)')
    else if (account === (env.WRITE_SERVICE_ACCOUNT ?? '').trim()) problems.push('ECO_PIPELINE_WRITE_SERVICE_ACCOUNT no puede ser la cuenta de escritura de PROJECT-OS')
    else if (account === (env.FINANZAS_WRITE_SERVICE_ACCOUNT ?? '').trim()) problems.push('ECO_PIPELINE_WRITE_SERVICE_ACCOUNT no puede ser la cuenta de escritura de FINANZAS')
    else if (account === (env.FINANZAS_AGENTE_SERVICE_ACCOUNT ?? '').trim()) problems.push('ECO_PIPELINE_WRITE_SERVICE_ACCOUNT no puede ser la cuenta del agente de finanzas')
    else if (account.split('@')[1] !== `${(env.PROJECT_ID ?? '').trim()}.iam.gserviceaccount.com`) problems.push('ECO_PIPELINE_WRITE_SERVICE_ACCOUNT debe pertenecer a PROJECT_ID')
  }
  if (writer && !UN_CORREO.test(writer)) problems.push('ECO_PIPELINE_WRITER_EMAIL debe ser un único correo')
  if (problems.length > antes) return ''
  return [
    '            - name: ECO_PIPELINE_WRITE_MODE',
    '              value: sheets',
    '            - name: ECO_PIPELINE_WRITE_SERVICE_ACCOUNT',
    `              value: ${account}`,
    '            - name: ECO_PIPELINE_WRITER_EMAIL',
    `              value: '${writer}'`,
    '',
  ].join('\n')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const template = readFileSync(path.join(import.meta.dirname, 'service.template.yaml'), 'utf8')
  try {
    process.stdout.write(render(template, process.env))
  } catch (error) {
    console.error(`No se generó el YAML: ${error.message}`)
    process.exit(1)
  }
}
