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
  const writeBlock = escritura(env, problems)
  if (problems.length) throw new Error(problems.join('; '))
  const output = template.replace(/\$\{([A-Z_]+)\}/g, (match, name) => {
    if (!(name in REQUIRED)) throw new Error(`variable no reconocida en la plantilla: ${name}`)
    return env[name].trim()
  })
  const marker = /^ *# __ESCRITURA__.*\n/m
  if (writeBlock && !marker.test(output)) throw new Error('la plantilla no tiene el marcador __ESCRITURA__: no se puede agregar la escritura')
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
 * Opcional (ORD-POS-028, docs/escritura-v1-8.md §6): SECRET_VERSION_PM_AGENT, versión fijada del secreto
 * project-os-pm-agent-token-sha256 (hash del token del agente PM). Solo con WRITE_MODE=sheets; nunca el hash ni el token literal.
 */
const ROUTINE_ID = /^[A-Za-z0-9_-]{8,80}$/
const WRITE_SA = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/

function escritura(env, problems) {
  const mode = (env.WRITE_MODE ?? '').trim()
  const pmAgent = (env.SECRET_VERSION_PM_AGENT ?? '').trim()
  if (pmAgent && !/^[1-9][0-9]*$/.test(pmAgent)) problems.push('SECRET_VERSION_PM_AGENT no tiene el formato esperado')
  else if (pmAgent && mode !== 'sheets') problems.push('SECRET_VERSION_PM_AGENT exige WRITE_MODE=sheets')
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
    ...pmAgentLines,
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
