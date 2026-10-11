#!/usr/bin/env bash
# PROJECT-OS V1.6 — Remediación de los hallazgos de la auditoría en Cloud Shell (2026-10-11).
# Hallazgos:
#   - E1: coincidencias de «@» y «code=» en los logs del servicio;
#   - A6: una versión de secreto ENABLED que la revisión no usa;
#   - A7 / D-1: maxScale de servicio 3 frente a revisión 1.
#
# Modos (uno por invocación):
#   diagnostico                 (predeterminado) SOLO LECTURA. Clasifica E1 y E2 por origen, muestra versiones de
#                               secretos y límites de escala. Imprime solo conteos, nombres de log, códigos y números
#                               de versión: nunca contenido de logs, correos ni valores de secretos.
#   deshabilitar-sobrantes      Mutación: deshabilita las versiones ENABLED que la revisión NO tiene fijadas.
#   destruir-version S N        Mutación IRREVERSIBLE: destruye SOLO la versión N del secreto S, si sigue DISABLED y no
#                               es la fijada. Nunca barre todas las DISABLED. Solo tras comprobar el login real.
#   alinear-max-servicio        Mutación: fija el máximo de instancias del SERVICIO en 1 (--max=1). Según la ayuda de
#                               gcloud, no despliega una revisión nueva; el script lo verifica.
#   excluir-callback-en-logs    Mutación: añade SOLO al sink _Default una exclusión para las peticiones al callback OAuth,
#                               cuya URL incluye el parámetro code. No borra registros existentes, que caducan a los
#                               30 días.
# Cada mutación muestra antes lo que hará y exige escribir una frase exacta. Ejecutar en bash (Cloud Shell).
# Documentación: docs/operacion-v1-6/remediacion-2026-10-11.md.
set -Eeuo pipefail
IFS=$'\n\t'

readonly PROJECT_ID='project-os-511102'
readonly REGION='northamerica-south1'
readonly SERVICE='project-os-dashboard'
readonly SECRETS=(project-os-nextauth-secret project-os-google-client-secret project-os-allowed-emails)
readonly EXCLUSION='project-os-callback-oauth'
readonly SVC_FILTER="resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${SERVICE}\""
# Sin «=» ni «,»: va dentro de --add-exclusion=clave=valor,…
readonly EXCLUSION_FILTER="logName:\"run.googleapis.com%2Frequests\" AND resource.labels.service_name:\"${SERVICE}\" AND httpRequest.requestUrl:\"/api/auth/callback/google\""

PY_HELPER="$(cat <<'PY'
import json, re, sys, urllib.parse
from collections import Counter
mode = sys.argv[1]
# Vocabulario CERRADO: solo se imprimen nombres de log, categorías de la app y rutas de listas fijas; cualquier otra cosa
# se sustituye por un marcador. Nunca se imprime texto libre de un log (revisión R1 de ChatGPT, PR #24).
LOGS = {
    'cloudaudit.googleapis.com/activity': 'auditoría de Google (esperado: registra quién cambia el servicio)',
    'cloudaudit.googleapis.com/system_event': 'auditoría de Google (esperado: registra quién cambia el servicio)',
    'cloudaudit.googleapis.com/data_access': 'auditoría de Google (esperado: registra quién cambia el servicio)',
    'run.googleapis.com/requests': 'peticiones HTTP (plataforma: URL completa)',
    'run.googleapis.com/stdout': 'SALIDA DE LA APP: investigar en el código',
    'run.googleapis.com/stderr': 'SALIDA DE LA APP: investigar en el código',
    'run.googleapis.com/varlog/system': 'sistema de Cloud Run',
}
APP = ('Configuración incompleta o insegura', 'Configuración inválida', 'operación rechazada',
       'error inesperado en operación', 'Error inesperado al leer datos')
RUTAS = {'/', '/login', '/robots.txt', '/favicon.ico', '/api/health', '/proyectos', '/tareas', '/actividad', '/capacidad',
         '/planificacion', '/control', '/operaciones', '/tareas/nueva', '/tiempos/nuevo', '/decisiones/nueva',
         '/api/resumen', '/api/planificacion', '/api/control', '/api/operaciones/tareas', '/api/operaciones/tiempos',
         '/api/operaciones/decisiones', '/api/auth/session', '/api/auth/csrf', '/api/auth/providers', '/api/auth/signin',
         '/api/auth/signout', '/api/auth/error', '/api/auth/signin/google', '/api/auth/callback/google', '/api/auth/_log'}
PLANTILLAS = ((r'/proyectos/[^/]+', '/proyectos/[id]'), (r'/tareas/[^/]+/editar', '/tareas/[id]/editar'),
              (r'/api/operaciones/tareas/[^/]+', '/api/operaciones/tareas/[id]'), (r'/_next/static/.+', '/_next/static/…'))
SEVERIDADES = {'DEFAULT', 'DEBUG', 'INFO', 'NOTICE', 'WARNING', 'ERROR', 'CRITICAL', 'ALERT', 'EMERGENCY'}

def log_name(raw):
    name = urllib.parse.unquote(str(raw or '').split('/logs/')[-1])
    return name if name in LOGS else '[log-omitido]'

def ruta_segura(url):
    ruta = urllib.parse.urlparse(str(url or '')).path or '/'
    if ruta in RUTAS: return ruta
    for patron, plantilla in PLANTILLAS:
        if re.fullmatch(patron, ruta): return plantilla
    return '[ruta-omitida]'

def codigo_app(txt):
    for categoria in APP:
        if txt.startswith(f'[project-os] {categoria}'): return f'[project-os] {categoria}'
    return '[project-os] (categoría no reconocida; no se muestra)'

if mode == 'lognames':          # una línea por entrada: logName → conteo por origen clasificado
    c = Counter()
    for line in sys.stdin:
        if not line.strip(): continue
        name = log_name(line.strip())
        c[(name, LOGS.get(name, 'otro'))] += 1
    for (name, tipo), n in sorted(c.items()): print(f'  {n:>5}  {name}  [{tipo}]')
    if not c: print('      0  (sin coincidencias)')
elif mode == 'codigos':         # JSON de entradas → conteo por severidad, log, categoría/ruta y día; nunca el texto
    c = Counter()
    for e in json.load(sys.stdin):
        name = log_name(e.get('logName'))
        sev = e.get('severity') if e.get('severity') in SEVERIDADES else '?'
        dia = str(e.get('timestamp', ''))[:10]
        dia = dia if re.fullmatch(r'\d{4}-\d{2}-\d{2}', dia) else '?'
        txt = e.get('textPayload')
        if isinstance(txt, str) and txt.startswith('[project-os]'):
            codigo = codigo_app(txt)
        elif isinstance(txt, str) and (m := re.match(r'\[next-auth\]\[(warn|error|debug)\]\[[A-Z_]{1,40}\]', txt)):
            codigo = m.group(0)
        elif name == 'run.googleapis.com/requests':
            hr = e.get('httpRequest') or {}
            st = hr.get('status')
            st = st if isinstance(st, int) and 100 <= st <= 599 else '?'
            codigo = f'petición HTTP {st} {ruta_segura(hr.get("requestUrl"))}'
        else:
            codigo = '(otro; no se muestra)'
        c[(sev, name, codigo, dia)] += 1
    for (sev, name, codigo, dia), n in sorted(c.items(), key=lambda kv: tuple(map(str, kv[0]))):
        print(f'  {n:>5}  {sev:<8} {name}  {codigo} ({dia})')
    if not c: print('      0  (sin avisos)')
elif mode == 'fijadas':         # JSON del servicio → «secreto versión» por cada variable de Secret Manager
    svc = json.load(sys.stdin)
    for e in svc['spec']['template']['spec']['containers'][0].get('env', []):
        ref = (e.get('valueFrom') or {}).get('secretKeyRef')
        if ref: print(ref['name'], ref['key'])
elif mode == 'escala':          # JSON del servicio → límites y revisión activa
    svc = json.load(sys.stdin)
    print('servicio_maxScale', svc['metadata'].get('annotations', {}).get('run.googleapis.com/maxScale', 'ninguno'))
    t = svc['spec']['template']['metadata'].get('annotations', {})
    print('revision_maxScale', t.get('autoscaling.knative.dev/maxScale', 'ninguno'))
    print('revision_minScale', t.get('autoscaling.knative.dev/minScale', 'ninguno'))
    print('revision_activa', svc.get('status', {}).get('latestReadyRevisionName', '?'))
    print('trafico', ';'.join(f"{x.get('revisionName', 'latest')}={x.get('percent', 0)}" for x in svc.get('status', {}).get('traffic', [])))
elif mode == 'versiones':       # JSON de «secrets versions list» → «N ESTADO» (N = número final de la ruta; ? si no hay)
    for v in json.load(sys.stdin) or []:
        m = re.search(r'/versions/(\d+)$', str(v.get('name', '')))
        print(m.group(1) if m else '?', v.get('state', '?'))
elif mode == 'exclusion':       # JSON del sink + nombre + filtro esperado → AUSENTE | CORRECTA | DISTINTA | DESHABILITADA
    nombre, esperado = sys.argv[2], ' '.join(sys.argv[3].split())
    ex = [x for x in (json.load(sys.stdin).get('exclusions') or []) if x.get('name') == nombre]
    if not ex: print('AUSENTE')
    elif ' '.join(str(ex[0].get('filter', '')).split()) != esperado: print('DISTINTA')
    elif ex[0].get('disabled') is True: print('DESHABILITADA')
    else: print('CORRECTA')
else:
    print('modo desconocido', file=sys.stderr); sys.exit(2)
PY
)"
readonly PY_HELPER

py() { python3 -c "$PY_HELPER" "$@"; }
die() { echo "ERROR: $*" >&2; exit 1; }
mask_emails() {
  sed -E 's/@([a-z0-9-]+\.iam\.gserviceaccount\.com)/__CS__\1/g; s/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/***@***/g; s/__CS__/@/g'
}
# Toda llamada a gcloud: errores del SDK sin correos de personas.
gcloud() { command gcloud "$@" 2> >(mask_emails >&2); }

describe_service() { gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" --format=json; }

# Versiones de un secreto como «N ESTADO». Se lee el JSON y se extrae el número final de la ruta en Python: no depende
# de transformaciones de --format (en Cloud Shell, value(name.basename(),state) dejó la lista vacía, 2026-10-11).
versions_of() { gcloud secrets versions list "$1" --project="$PROJECT_ID" --format=json | py versiones; }

pinned_of() {   # $1 = salida de «fijadas», $2 = secreto → versión fijada (vacío si no hay)
  awk -v s="$2" '$1 == s { print $2 }' <<< "$1"
}

confirm() {     # $1 = frase exacta
  local ack=''
  read -r -p "Para continuar escribe exactamente: $1: " ack || die 'sin confirmación; cancelado sin cambios.'
  # Se ignoran los espacios al principio y al final (p. ej. al pegar); el texto en sí debe ser idéntico.
  ack="${ack#"${ack%%[![:space:]]*}"}"; ack="${ack%"${ack##*[![:space:]]}"}"
  [[ "$ack" == "$1" ]] || { echo "Cancelado sin cambios: la frase no coincide (se esperaba «$1»)."; exit 1; }
}

diagnostico() {
  local svc fijadas p
  echo "== E1: coincidencias por ORIGEN (30 días; solo nombres de log y conteos) =="
  for p in '@' 'code='; do
    echo "Patrón «${p}»:"
    ( set -o pipefail; gcloud logging read "${SVC_FILTER} AND \"${p}\"" --project="$PROJECT_ID" --freshness=30d \
        --limit=100000 --format='value(logName)' | py lognames ) || echo '  LECTURA_FALLIDA'
  done
  echo
  echo "== E2: avisos (severity>=WARNING, 30 días) por severidad, log y CÓDIGO (nunca el texto) =="
  ( set -o pipefail; gcloud logging read "${SVC_FILTER} AND severity>=WARNING" --project="$PROJECT_ID" --freshness=30d \
      --limit=10000 --format=json | py codigos ) || echo '  LECTURA_FALLIDA'
  echo
  svc="$(describe_service)" || die 'no se pudo leer el servicio.'
  fijadas="$(py fijadas <<< "$svc")"
  echo "== A6: versiones de los secretos (número y estado; nunca el valor) =="
  local s v fij enabled sobrantes
  for s in "${SECRETS[@]}"; do
    v="$(versions_of "$s")" || { echo "  $s: LECTURA_FALLIDA"; continue; }
    fij="$(pinned_of "$fijadas" "$s")"
    if grep -q '^?' <<< "$v"; then echo "  $s: VERSIONES_ILEGIBLES (no se reconoce el número de versión)"; continue; fi
    enabled="$(awk '$2 == "ENABLED" { printf "%s ", $1 }' <<< "$v")"
    sobrantes="$(awk -v f="$fij" '$2 == "ENABLED" && $1 != f { printf "%s ", $1 }' <<< "$v")"
    echo "  $s: fijada=${fij:-?}; ENABLED=[${enabled% }]; ENABLED_no_fijadas=[${sobrantes% }]"
  done
  echo
  echo "== A7: límites de escala =="
  py escala <<< "$svc" | sed 's/^/  /'
  echo
  echo 'Diagnóstico de solo lectura: no se modificó nada. Comparte solo estas líneas, sin salidas crudas de gcloud.'
}

deshabilitar_sobrantes() {
  local svc fijadas s v fij sobrantes n plan=()
  svc="$(describe_service)" || die 'no se pudo leer el servicio.'
  fijadas="$(py fijadas <<< "$svc")"
  for s in "${SECRETS[@]}"; do
    v="$(versions_of "$s")" || die "no se pudieron leer las versiones de $s."
    ! grep -q '^?' <<< "$v" || die "$s: versiones ilegibles; detenido sin cambios."
    fij="$(pinned_of "$fijadas" "$s")"
    [[ "$fij" =~ ^[1-9][0-9]*$ ]] || die "$s: la revisión no fija una versión numérica (${fij:-ninguna}); detenido sin cambios."
    awk -v f="$fij" '$1 == f && $2 == "ENABLED" { ok=1 } END { exit !ok }' <<< "$v" \
      || die "$s: la versión fijada $fij no está ENABLED; detenido sin cambios (el servicio la necesita)."
    while read -r n; do [[ -n "$n" ]] && plan+=("$s $n"); done < <(awk -v f="$fij" '$2 == "ENABLED" && $1 != f { print $1 }' <<< "$v")
  done
  if [[ ${#plan[@]} -eq 0 ]]; then echo 'No hay versiones ENABLED sin usar: nada que hacer.'; return 0; fi
  echo 'Se DESHABILITARÁN (la revisión no las usa; se pueden volver a habilitar con «versions enable»):'
  printf '  %s\n' "${plan[@]}"
  confirm 'AUTORIZO DESHABILITAR VERSIONES'
  local item
  for item in "${plan[@]}"; do
    s="${item% *}"; n="${item#* }"
    gcloud secrets versions disable "$n" --secret="$s" --project="$PROJECT_ID" --format=none
    echo "  deshabilitada: $s versión $n"
  done
  echo
  echo 'Verifica AHORA el login real en el navegador y npm run smoke:remote. Si todo funciona, destruye cada una así:'
  for item in "${plan[@]}"; do echo "  bash web/deploy/infra/remediacion-v1-6.sh destruir-version ${item% *} ${item#* }"; done
}

# Destruye UNA versión concreta, indicada por argumentos (revisión R1-2): nunca barre todas las DISABLED, que pueden ser
# históricas o de recuperación. Comprueba justo antes que el par sigue DISABLED y no está fijado en la revisión.
destruir_version() {
  local s="$1" n="$2" svc fijadas v fij estado
  in_secrets "$s" || die "secreto no reconocido: $s; detenido sin cambios."
  [[ "$n" =~ ^[1-9][0-9]*$ ]] || die "versión no numérica: $n; detenido sin cambios."
  svc="$(describe_service)" || die 'no se pudo leer el servicio.'
  fijadas="$(py fijadas <<< "$svc")"
  fij="$(pinned_of "$fijadas" "$s")"
  [[ "$fij" =~ ^[1-9][0-9]*$ ]] || die "$s: sin versión fijada numérica; detenido sin cambios."
  [[ "$n" != "$fij" ]] || die "$s versión $n es la FIJADA en la revisión: nunca se destruye. Detenido sin cambios."
  v="$(versions_of "$s")" || die "no se pudieron leer las versiones de $s."
  estado="$(awk -v n="$n" '$1 == n { print $2 }' <<< "$v")"
  [[ "$estado" == 'DISABLED' ]] || die "$s versión $n está en estado «${estado:-inexistente}», no DISABLED; detenido sin cambios."
  echo "Se DESTRUIRÁ de forma IRREVERSIBLE: $s versión $n (DISABLED; la fijada es $fij)."
  confirm 'AUTORIZO DESTRUIR VERSION TRAS VERIFICAR EL LOGIN'
  # Segunda comprobación inmediatamente antes de destruir: nada cambió durante la confirmación.
  v="$(versions_of "$s")" || die "no se pudieron releer las versiones de $s."
  [[ "$(awk -v n="$n" '$1 == n { print $2 }' <<< "$v")" == 'DISABLED' ]] || die "$s versión $n cambió de estado; detenido sin cambios."
  gcloud secrets versions destroy "$n" --secret="$s" --project="$PROJECT_ID" --quiet --format=none
  echo "  destruida: $s versión $n"
}

in_secrets() { local x; for x in "${SECRETS[@]}"; do [[ "$x" == "$1" ]] && return 0; done; return 1; }

alinear_max_servicio() {
  local antes despues rev_antes rev_despues svc_max rev_max
  antes="$(describe_service | py escala)" || die 'no se pudo leer el servicio.'
  svc_max="$(awk '$1 == "servicio_maxScale" { print $2 }' <<< "$antes")"
  rev_max="$(awk '$1 == "revision_maxScale" { print $2 }' <<< "$antes")"
  rev_antes="$(awk '$1 == "revision_activa" { print $2 }' <<< "$antes")"
  [[ "$rev_max" == '1' ]] || die "la revisión no tiene maxScale 1 (${rev_max}); detenido sin cambios."
  if [[ "$svc_max" == '1' ]]; then echo 'El máximo de servicio ya es 1: nada que hacer.'; return 0; fi
  echo "Cambio: máximo de instancias del SERVICIO ${svc_max} → 1 (gcloud run services update --max=1)."
  echo "Revisión activa antes: ${rev_antes}. Según la ayuda de gcloud, --max no despliega una revisión nueva."
  confirm 'AUTORIZO MAX SERVICIO 1'
  gcloud run services update "$SERVICE" --project="$PROJECT_ID" --region="$REGION" --max=1 --format=none
  despues="$(describe_service | py escala)" || die 'no se pudo releer el servicio; revisar en la consola.'
  rev_despues="$(awk '$1 == "revision_activa" { print $2 }' <<< "$despues")"
  printf '  %s\n' "${despues//$'\n'/$'\n  '}"
  [[ "$(awk '$1 == "servicio_maxScale" { print $2 }' <<< "$despues")" == '1' ]] || die 'el máximo de servicio no quedó en 1: revisar.'
  if [[ "$rev_despues" != "$rev_antes" ]]; then
    echo "AVISO: la revisión activa cambió (${rev_antes} → ${rev_despues}). Ejecuta smoke:remote y A1/A9 antes de nada más."
  else
    echo 'OK: máximo de servicio 1, misma revisión activa. Ejecuta npm run smoke:remote para confirmar.'
  fi
}

sink_exclusion() {   # estado de la exclusión en el sink _Default: AUSENTE | CORRECTA | DISTINTA | DESHABILITADA
  gcloud logging sinks describe _Default --project="$PROJECT_ID" --format=json | py exclusion "$EXCLUSION" "$EXCLUSION_FILTER"
}

# Alcance: SOLO el sink _Default (y su bucket). No afecta a otros sinks ni a registros ya guardados.
excluir_callback_en_logs() {
  local estado
  estado="$(sink_exclusion)" || die 'no se pudo leer el sink _Default.'
  case "$estado" in
    CORRECTA) echo "La exclusión $EXCLUSION ya existe con el filtro esperado y activa: nada que hacer."; return 0 ;;
    DISTINTA|DESHABILITADA) die "la exclusión $EXCLUSION existe pero está ${estado} (filtro distinto o deshabilitada): NO_VERIFICADO. No se modifica automáticamente; revisar en la consola." ;;
    AUSENTE) ;;
    *) die "estado de la exclusión no reconocido: NO_VERIFICADO." ;;
  esac
  echo "Se añadirá al sink _Default (solo ese sink) la exclusión «${EXCLUSION}» con el filtro:"
  echo "  ${EXCLUSION_FILTER}"
  echo 'Efecto: las peticiones al callback OAuth dejan de guardarse en _Default (URL con code, estado y latencia).'
  echo 'No afecta a otros sinks ni borra registros ya guardados: caducan con la retención de 30 días.'
  confirm 'AUTORIZO EXCLUIR CALLBACK OAUTH DE LOS LOGS'
  gcloud logging sinks update _Default --project="$PROJECT_ID" \
    --add-exclusion="name=${EXCLUSION},description=PROJECT-OS: no guardar URLs del callback OAuth,filter=${EXCLUSION_FILTER}" --format=none
  estado="$(sink_exclusion)" || die 'no se pudo releer el sink: NO_VERIFICADO.'
  [[ "$estado" == 'CORRECTA' ]] || die "tras el cambio, la exclusión está ${estado}: NO_VERIFICADO; revisar en la consola."
  echo "OK: exclusión ${EXCLUSION} activa, con el filtro esperado."
}

main() {
  local modo="${1:-diagnostico}"
  local uso="Uso: bash $0 [diagnostico|deshabilitar-sobrantes|destruir-version <secreto> <versión>|alinear-max-servicio|excluir-callback-en-logs]"
  if [[ "$modo" == 'destruir-version' ]]; then [[ $# -eq 3 ]] || { echo "$uso"; exit 2; }
  else [[ $# -le 1 ]] || { echo "$uso"; exit 2; }; fi
  command -v gcloud >/dev/null || die 'gcloud no disponible.'
  command -v python3 >/dev/null || die 'python3 no disponible.'
  echo "PROJECT-OS V1.6 — remediación (${modo}) · ${PROJECT_ID} · ${REGION} · ${SERVICE}"
  case "$modo" in
    diagnostico) diagnostico ;;
    deshabilitar-sobrantes) deshabilitar_sobrantes ;;
    destruir-version) destruir_version "$2" "$3" ;;
    alinear-max-servicio) alinear_max_servicio ;;
    excluir-callback-en-logs) excluir_callback_en_logs ;;
    *) echo "Modo desconocido: $modo"; exit 2 ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
