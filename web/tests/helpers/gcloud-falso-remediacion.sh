#!/bin/bash
# gcloud FALSO para tests/remediacion-v1-6.test.ts. Nunca contacta Google Cloud: responde con fixtures que imitan el
# estado auditado el 2026-10-11 (servicio maxScale 3, versión 1 sobrante de google-client-secret fijada en 2, «@» en
# auditoría y «code=» en el log de peticiones). Cada llamada se registra en $FAKE_LOG; el estado simulado cambia según
# las mutaciones ya registradas. La prueba escribe «--- run» al empezar cada ejecución del script.
#
# Variables de control (todas opcionales):
#   FAKE_FALLA=<regex>      las llamadas que coinciden fallan con PERMISSION_DENIED (código 1)
#   FAKE_INVALIDO=<regex>   las llamadas que coinciden devuelven texto que no es JSON
#   FAKE_VACIO=<regex>      las llamadas que coinciden no devuelven nada (código 0)
#   FAKE_NUEVA_REVISION=1   tras «run services update», la revisión activa es otra
#   FAKE_REV_MAX=<n>        maxScale de la revisión (1)
#   FAKE_FIJADA_CLIENTE=<n> versión fijada de google-client-secret (2)
#   FAKE_REF_EXTRA=volumen|variable   otra referencia a la versión 1 de google-client-secret desde el principio
#   FAKE_TRAFICO=repartido|otra|etiqueta|creada   el servicio no sirve el 100 % desde la última revisión lista
#   FAKE_CAMBIA=fijada|revision|volumen|variable|trafico|generacion   cambio concurrente desde la 2.ª lectura del servicio
#   FAKE_ESTADO_CAMBIA=1    la versión 1 de google-client-secret cambia de estado desde la 2.ª lectura de sus versiones
#   FAKE_RECHAZA=1          la API rechaza disable/destroy (etag desactualizado); no surte efecto
#   FAKE_TTL=1              el secreto tiene TTL de destrucción: destroy deja la versión DISABLED y programada
#   FAKE_SIN_EFECTO=disable|destroy   esa mutación responde bien pero no cambia el estado (verificación posterior)
#   FAKE_IAM=otros|condicion   la política IAM del secreto tiene otro lector o una condición
#   FAKE_SINK=distinta|deshabilitada|rota   estado de la exclusión del callback en _Default
#   FAKE_FILTRO=<json>      filtro esperado de la exclusión, ya codificado como cadena JSON
#   FAKE_NOMBRE_RARO=1      las versiones vienen con nombres no reconocibles
set -u
llamada="$*"
regex() { [[ -n "$1" && "$llamada" =~ $1 ]]; }

if [[ -n "${FAKE_RECHAZA:-}" && "${1:-} ${2:-} ${3:-}" =~ ^secrets\ versions\ (disable|destroy)$ ]]; then
  printf 'RECHAZADA %s\n' "$llamada" >> "$FAKE_LOG"
  echo 'ERROR: (gcloud.secrets.versions) ABORTED: el etag no coincide con el de la versión actual' >&2
  exit 1
fi
printf '%s\n' "$llamada" >> "$FAKE_LOG"
# Una mutación «hecha» es una llamada registrada y no rechazada.
hecho() { grep -v '^RECHAZADA' "$FAKE_LOG" | grep -q -- "$1"; }
# Lecturas de este tipo desde el inicio de la ejecución actual (incluida esta).
lecturas() { awk -v p="$1" '/^--- run$/ { n = 0 } index($0, p) == 1 { n++ } END { print n + 0 }' "$FAKE_LOG"; }

if regex "${FAKE_FALLA:-}"; then
  # El SDK puede incluir el correo de la cuenta en el error: el script debe enmascararlo.
  echo 'ERROR: (gcloud) PERMISSION_DENIED: persona.fuga@correo-falso.test no tiene permiso' >&2
  exit 1
fi
if regex "${FAKE_INVALIDO:-}"; then echo 'esto no es JSON { persona.fuga@correo-falso.test'; exit 0; fi
if regex "${FAKE_VACIO:-}"; then exit 0; fi

case "${1:-} ${2:-} ${3:-}" in
  "logging read "*)
    if [[ "$llamada" == *"--format=json"* ]]; then
      cat <<'JSON'
[{"logName":"projects/p/logs/run.googleapis.com%2Fstderr","severity":"WARNING","textPayload":"[project-os] Configuración inválida: SHEETS_CREDENTIALS"},
 {"logName":"projects/p/logs/run.googleapis.com%2Fstderr","severity":"WARNING","textPayload":"persona.ficticia@correo-falso.test texto libre"},
 {"logName":"projects/p/logs/run.googleapis.com%2Frequests","severity":"WARNING","timestamp":"2026-10-11T03:04:05Z","httpRequest":{"status":404,"requestUrl":"https://x.run.app/wp-login.php?u=x&code=SECRETO"}},
 {"logName":"projects/p/logs/run.googleapis.com%2Fstderr","severity":"ERROR","textPayload":"[project-os] usuario.fuga@correo-falso.test token=TOKEN-FUGA-1"},
 {"logName":"projects/p/logs/run.googleapis.com%2Fstderr","severity":"ERROR","textPayload":"[project-os] operación rechazada: titular.fuga@correo-falso.test"},
 {"logName":"projects/p/logs/run.googleapis.com%2Fstderr","severity":"WARNING","textPayload":"[next-auth][warn][NO_SECRET] cuenta.fuga@correo-falso.test"},
 {"logName":"projects/p/logs/run.googleapis.com%2Frequests","severity":"WARNING","timestamp":"2026-10-11T04:00:00Z","httpRequest":{"status":404,"requestUrl":"https://x.run.app/usuarios/ruta.fuga@dominio.test?token=TOKEN-FUGA-2"}},
 {"logName":"projects/p/logs/run.googleapis.com%2Frequests","severity":"WARNING","timestamp":"2026-10-11T04:00:00Z","httpRequest":{"status":404,"requestUrl":"https://x.run.app/reset/TOKEN-FUGA-3"}},
 {"logName":"projects/p/logs/run.googleapis.com%2Frequests","severity":"WARNING","timestamp":"2026-10-11T04:00:00Z","httpRequest":{"status":400,"requestUrl":"https://x.run.app/api/auth/callback/google?code=CODIGO-FUGA&state=ESTADO-FUGA"}},
 {"logName":"projects/p/logs/run.googleapis.com%2Frequests","severity":"WARNING","timestamp":"2026-10-11T04:00:00Z","httpRequest":{"status":404,"requestUrl":"https://x.run.app/proyectos/id.fuga@correo-falso.test"}},
 {"logName":"projects/p/logs/run.googleapis.com%2Frequests","severity":"sev.fuga@correo-falso.test","timestamp":"fecha.fuga@correo-falso.test","httpRequest":{"status":"estado.fuga@correo-falso.test","requestUrl":"/"}},
 {"logName":"projects/p/logs/log.fuga%40correo-falso.test","severity":"WARNING","textPayload":"texto libre"}]
JSON
    elif [[ "${3:-}" == *'"@"'* ]]; then
      for _ in 1 2 3; do echo 'projects/project-os-511102/logs/cloudaudit.googleapis.com%2Factivity'; done
      echo 'projects/project-os-511102/logs/nombre.fuga%40correo-falso.test'
    elif [[ "${3:-}" == *'"code="'* ]]; then
      echo 'projects/project-os-511102/logs/run.googleapis.com%2Frequests'
    fi ;;  # «ya29.» y «Bearer »: sin coincidencias
  "run services describe")
    N=$(lecturas 'run services describe')
    MAX=3; GEN=1
    if hecho 'run services update'; then MAX=1; GEN=2; fi
    REV=project-os-dashboard-00001-gsk
    if [[ -n "${FAKE_NUEVA_REVISION:-}" ]] && hecho 'run services update'; then REV=project-os-dashboard-00002-xyz; fi
    FIJ="${FAKE_FIJADA_CLIENTE:-2}"; EXTRA="${FAKE_REF_EXTRA:-}"; TRAF="${FAKE_TRAFICO:-}"
    if (( N >= 2 )); then
      case "${FAKE_CAMBIA:-}" in
        fijada) FIJ=1 ;;
        revision) REV=project-os-dashboard-00003-cmb ;;
        volumen|variable) EXTRA="$FAKE_CAMBIA" ;;
        trafico) TRAF=repartido ;;
        generacion) GEN=$((GEN + 1)) ;;
      esac
    fi
    CREADA="$REV"
    TRAFICO="[{\"revisionName\":\"$REV\",\"percent\":100,\"latestRevision\":true}]"
    case "$TRAF" in
      repartido) TRAFICO="[{\"revisionName\":\"$REV\",\"percent\":90},{\"revisionName\":\"project-os-dashboard-00000-old\",\"percent\":10}]" ;;
      otra) TRAFICO='[{"revisionName":"project-os-dashboard-00000-old","percent":100}]' ;;
      etiqueta) TRAFICO="[{\"revisionName\":\"$REV\",\"percent\":100},{\"revisionName\":\"project-os-dashboard-00000-old\",\"percent\":0,\"tag\":\"anterior\"}]" ;;
      creada) CREADA=project-os-dashboard-00009-new ;;
    esac
    ENV_EXTRA=''; VOLS='[]'
    if [[ "$EXTRA" == variable ]]; then
      ENV_EXTRA=',{"name":"GOOGLE_CLIENT_SECRET_ANTERIOR","valueFrom":{"secretKeyRef":{"name":"project-os-google-client-secret","key":"1"}}}'
    elif [[ "$EXTRA" == volumen ]]; then
      VOLS='[{"name":"extra","secret":{"secretName":"project-os-google-client-secret","items":[{"key":"1","path":"v"}]}}]'
    fi
    printf '{"metadata":{"generation":%s,"annotations":{"run.googleapis.com/maxScale":"%s"}},"spec":{"template":{"metadata":{"annotations":{"autoscaling.knative.dev/maxScale":"%s","autoscaling.knative.dev/minScale":"0"}},"spec":{"serviceAccountName":"project-os-dashboard-run@project-os-511102.iam.gserviceaccount.com","containers":[{"env":[{"name":"NEXTAUTH_URL","value":"VALOR-NO-DEBE-SALIR"},{"name":"NEXTAUTH_SECRET","valueFrom":{"secretKeyRef":{"name":"project-os-nextauth-secret","key":"1"}}},{"name":"GOOGLE_CLIENT_SECRET","valueFrom":{"secretKeyRef":{"key":"%s","name":"project-os-google-client-secret"}}},{"name":"AUTH_ALLOWED_EMAILS","valueFrom":{"secretKeyRef":{"name":"project-os-allowed-emails","key":"1"}}}%s]}],"volumes":%s}}},"status":{"latestReadyRevisionName":"%s","latestCreatedRevisionName":"%s","traffic":%s}}\n' \
      "$GEN" "$MAX" "${FAKE_REV_MAX:-1}" "$FIJ" "$ENV_EXTRA" "$VOLS" "$REV" "$CREADA" "$TRAFICO" ;;
  "secrets versions list")
    # JSON real de Secret Manager: «name» es la ruta completa y cada versión trae su etag (cambia con el estado).
    V="projects/123/secrets/${4:-}/versions"
    if [[ -n "${FAKE_NOMBRE_RARO:-}" ]]; then echo '[{"name":"desconocido","state":"ENABLED","etag":"\"x\""}]'; exit 0; fi
    if [[ "${4:-}" == project-os-google-client-secret ]]; then
      if [[ "${FAKE_SIN_EFECTO:-}" != destroy ]] && hecho 'versions destroy 1 --secret=project-os-google-client-secret'; then S1=DESTROYED
      elif [[ "${FAKE_SIN_EFECTO:-}" != disable ]] && hecho 'versions disable 1 --secret=project-os-google-client-secret'; then S1=DISABLED
      else S1=ENABLED; fi
      PROG=''
      if [[ -n "${FAKE_TTL:-}" && "$S1" == DESTROYED ]]; then S1=DISABLED; PROG=',"scheduledDestroyTime":"2026-11-11T00:00:00Z"'; fi
      if [[ -n "${FAKE_ESTADO_CAMBIA:-}" ]] && (( $(lecturas 'secrets versions list project-os-google-client-secret') >= 2 )); then
        case "$S1" in ENABLED) S1=DISABLED ;; DISABLED) S1=ENABLED ;; esac
      fi
      # La versión 3 es DISABLED ajena a la remediación (histórica o de recuperación): nunca debe destruirse.
      printf '[{"name":"%s/2","state":"ENABLED","etag":"\\"e2-ENABLED\\""},{"name":"%s/1","state":"%s","etag":"\\"e1-%s\\""%s},{"name":"%s/3","state":"DISABLED","etag":"\\"e3-DISABLED\\""}]\n' \
        "$V" "$V" "$S1" "$S1" "$PROG" "$V"
    else
      printf '[{"name":"%s/1","state":"ENABLED","etag":"\\"e1-ENABLED\\""}]\n' "$V"
    fi ;;
  "secrets get-iam-policy "*)
    M='serviceAccount:project-os-dashboard-run@project-os-511102.iam.gserviceaccount.com'
    case "${FAKE_IAM:-}" in
      otros) printf '{"bindings":[{"role":"roles/secretmanager.secretAccessor","members":["%s","user:lector.fuga@correo-falso.test"]}],"etag":"BwX"}\n' "$M" ;;
      condicion) printf '{"bindings":[{"role":"roles/secretmanager.secretAccessor","members":["%s"],"condition":{"title":"t","expression":"true"}}],"etag":"BwX"}\n' "$M" ;;
      *) printf '{"bindings":[{"role":"roles/secretmanager.secretAccessor","members":["%s"]}],"etag":"BwX","version":1}\n' "$M" ;;
    esac ;;
  "secrets versions disable"|"secrets versions destroy"|"run services update"|"logging sinks update") ;;
  "logging sinks describe")
    # Sin FAKE_SINK: ausente hasta el update y luego correcta. distinta/deshabilitada: así desde el inicio.
    # rota: tras el update queda con otro filtro.
    ex() { printf '{"name":"_Default","exclusions":[{"name":"project-os-callback-oauth","filter":%s,"disabled":%s}]}\n' "$1" "$2"; }
    case "${FAKE_SINK:-}" in
      distinta) ex '"logName:\"otro\""' false ;;
      deshabilitada) ex "$FAKE_FILTRO" true ;;
      rota) if hecho 'logging sinks update'; then ex '"logName:\"otro\""' false; else echo '{"name":"_Default"}'; fi ;;
      *) if hecho 'logging sinks update'; then ex "$FAKE_FILTRO" false; else echo '{"name":"_Default"}'; fi ;;
    esac ;;
  *) echo "gcloud falso: llamada no prevista: $llamada" >&2; exit 97 ;;
esac
