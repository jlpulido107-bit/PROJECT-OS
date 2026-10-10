#!/usr/bin/env bash
# Arnés de SIMULACIÓN de project-os-infra-minima-v1-6.sh con un `gcloud` FALSO. Nunca contacta a Google Cloud.
#
# Para ejecutarlo en un ENTORNO AUTORIZADO por el propietario (su equipo o Cloud Shell), antes de pedir permiso para
# --apply real:  bash web/deploy/infra/simular-infra-minima.sh
# Recorre: --plan, --check, --apply completo con AUTORIZO y cada aborto previsto. Comprueba que no hay ningún
# comando mutante antes de la confirmación ni en los abortos, el orden exacto de los cambios, la auditoría
# (OK / FALLA / NO VERIFICADO) y que la salida no contiene correos de personas.
# Este arnés NO se ha ejecutado en la sesión que lo preparó (allí solo pasó `bash -n` y ShellCheck).
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/project-os-infra-minima-v1-6.sh"
[[ -f "$SCRIPT" ]] || { echo "No se encuentra el script: $SCRIPT" >&2; exit 2; }
WORK="$(mktemp -d)"
[[ -d "$WORK" && "$WORK" == "${TMPDIR:-/tmp}"/* ]] || { echo 'Directorio temporal inesperado.' >&2; exit 2; }
trap 'rm -rf -- "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/gcloud-config" "$WORK/home"

# ---- gcloud falso: registra cada llamada y responde según el escenario (variables FAKE_*). ----
cat > "$WORK/bin/gcloud" <<'FAKE'
#!/usr/bin/env bash
# Tokenización EXPLÍCITA: el falso es otro proceso bash (no hereda el IFS del arnés), pero fija su IFS y usa arrays
# para no depender de ello. Las listas FAKE_* se separan por espacios.
IFS=$' \t\n'
printf '%s\n' "$*" >> "$FAKE_LOG"
args="$*"
SA_BUILD='project-os-build@project-os-511102.iam.gserviceaccount.com'
SA_RUN='project-os-dashboard-run@project-os-511102.iam.gserviceaccount.com'
case "$args" in
  *--help)
    flags=(--location --uniform-bucket-level-access '--[no-]public-access-prevention' --soft-delete-duration --lifecycle-file
      --repository-format --description --display-name --member --role --condition)
    for f in "${flags[@]}"; do [[ "$f" == *"${FAKE_DROP_FLAG:-@@}"* ]] || printf '  %s=VALUE\n' "$f"; done ;;
  "auth list"*) echo 'persona.operadora@example.com' ;;
  "projects describe"*) echo 123456789012 ;;
  "services list"*)
    if [[ -n "${FAKE_SERVICES_ERROR:-}" ]]; then echo 'ERROR: PERMISSION_DENIED para persona.operadora@example.com' >&2; exit 1; fi
    read -r -a apis <<< "${FAKE_APIS:-cloudbuild.googleapis.com artifactregistry.googleapis.com iam.googleapis.com storage.googleapis.com}"
    printf '%s\n' "${apis[@]}" ;;
  "iam service-accounts list"*)
    [[ -n "${FAKE_NO_BUILD_SA:-}" ]] || echo "$SA_BUILD"
    [[ -z "${FAKE_RUNTIME_EXISTS:-}" ]] || echo "$SA_RUN" ;;
  "projects get-iam-policy"*)
    read -r -a roles <<< "${FAKE_BUILD_ROLES:-}"
    if grep -q '^projects add-iam-policy-binding' "$FAKE_LOG"; then roles+=(roles/logging.logWriter); fi
    printf '{"bindings":['; sep=''
    for r in "${roles[@]}"; do printf '%s{"role":"%s","members":["serviceAccount:%s"]}' "$sep" "$r" "$SA_BUILD"; sep=','; done
    printf '%s{"role":"roles/owner","members":["user:persona.operadora@example.com"]}]}\n' "$sep" ;;
  "artifacts repositories list"*) [[ -z "${FAKE_REPO_NAME:-}" ]] || echo "$FAKE_REPO_NAME" ;;
  "storage buckets list"*) [[ -z "${FAKE_BUCKET_EXISTS:-}" ]] || echo 'project-os-511102-project-os-build-src' ;;
  "storage buckets describe"*)
    ubla="${FAKE_UBLA:-true}"
    printf '{"name":"project-os-511102-project-os-build-src","location":"NORTHAMERICA-SOUTH1","uniform_bucket_level_access":%s,"public_access_prevention":"enforced","soft_delete_policy":{"retentionDurationSeconds":"0"},"lifecycle_config":{"rule":[{"action":{"type":"Delete"},"condition":{"age":7}}]}}\n' "$ubla" ;;
  "artifacts repositories describe"*) echo DOCKER ;;
  "artifacts repositories get-iam-policy"*) printf '{"bindings":[{"role":"roles/artifactregistry.writer","members":["serviceAccount:%s"]}]}\n' "$SA_BUILD" ;;
  "storage buckets get-iam-policy"*) printf '{"bindings":[{"role":"roles/storage.objectViewer","members":["serviceAccount:%s"]}]}\n' "$SA_BUILD" ;;
  "iam service-accounts keys list"*) if [[ -n "${FAKE_KEYS_ERROR:-}" ]]; then echo 'ERROR: lectura denegada' >&2; exit 1; fi ;;
  *create*|*add-iam-policy-binding*) echo "Simulado: $1 $2 $3" >&2 ;;
  *) echo "gcloud falso: llamada no prevista: $args" >&2; exit 97 ;;
esac
FAKE
chmod +x "$WORK/bin/gcloud"

SAFE_PATH="$WORK/bin:/usr/bin:/bin"
resolved="$(PATH="$SAFE_PATH" command -v gcloud)"
[[ "$resolved" == "$WORK/bin/gcloud" ]] || { echo "ABORTADO: gcloud no resuelve al falso ($resolved)." >&2; exit 2; }

MUTATING='^(services enable|.*\bcreate\b|.*\bupdate\b|.*\bdelete\b|.*add-iam-policy-binding|.*remove-iam-policy-binding|.*set-iam-policy|builds |run )'
EXPECTED_ORDER='storage buckets create
artifacts repositories create
iam service-accounts create
projects add-iam-policy-binding
artifacts repositories add-iam-policy-binding
storage buckets add-iam-policy-binding'
ACK='AUTORIZO INFRA PROJECT-OS'
passed=0; failed=0

# escenario NOMBRE MODO ENTRADA CÓDIGO_ESPERADO MUTACIONES_ESPERADAS TEXTO_ESPERADO [VAR=valor…]
# ENTRADA '__EOF__' = sin entrada estándar (fin de archivo inmediato).
scenario() {
  local name="$1" mode="$2" input="$3" want_code="$4" want_muts="$5" want_text="$6"; shift 6
  local log="$WORK/$name.log" out code muts emails problems=''
  : > "$log"
  set +e
  if [[ "$input" == '__EOF__' ]]; then
    out="$(env -i PATH="$SAFE_PATH" HOME="$WORK/home" CLOUDSDK_CONFIG="$WORK/gcloud-config" FAKE_LOG="$log" "$@" \
      bash "$SCRIPT" "$mode" < /dev/null 2>&1)"
  else
    out="$(env -i PATH="$SAFE_PATH" HOME="$WORK/home" CLOUDSDK_CONFIG="$WORK/gcloud-config" FAKE_LOG="$log" "$@" \
      bash "$SCRIPT" "$mode" <<< "$input" 2>&1)"
  fi
  code=$?
  set -e
  muts="$(grep -v -- '--help$' "$log" | grep -cE "$MUTATING" || true)"
  [[ "$code" == "$want_code" ]] || problems+=" código=$code (esperado $want_code);"
  [[ "$muts" == "$want_muts" ]] || problems+=" mutaciones=$muts (esperadas $want_muts);"
  [[ -z "$want_text" || "$out" == *"$want_text"* ]] || problems+=" falta el texto «$want_text»;"
  # Sin `| grep -q` (falsos negativos por SIGPIPE con pipefail): se extraen los correos y se revisan aparte.
  emails="$(grep -Eo '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' <<< "$out" || true)"
  if [[ -n "$emails" ]] && grep -qv 'gserviceaccount\.com$' <<< "$emails"; then
    problems+=' la salida contiene un correo de persona;'
  fi
  if [[ "$mode" == '--plan' && -s "$log" ]]; then problems+=' --plan invocó gcloud;'; fi
  if [[ "$want_muts" == 6 ]]; then
    # Nombre del comando: `projects add-iam-policy-binding` tiene dos palabras; el resto, tres.
    [[ "$(grep -v -- '--help$' "$log" | grep -E "$MUTATING" \
      | sed -E 's/^(projects add-iam-policy-binding) .*/\1/; s/^([^ ]+ [^ ]+ [^ ]+) .*/\1/')" == "$EXPECTED_ORDER" ]] \
      || problems+=' orden de cambios inesperado;'
  fi
  if [[ -z "$problems" ]]; then echo "PASA   $name"; passed=$((passed + 1))
  else
    echo "FALLA  $name:$problems"; failed=$((failed + 1))
    # Diagnóstico reproducible: últimas líneas de la salida (ya sin correos de personas).
    printf '%s\n' "$out" | tail -n 6 | sed 's/^/         | /'
  fi
}

scenario plan                --plan  ''        0 0 'Modo vista previa'
scenario check-correcto      --check ''        0 0 'Modo --check: solo lectura'
scenario apply-correcto      --apply "$ACK"    0 6 'FINALIZADO: auditoría correcta'
scenario apply-ack-incorrecto --apply 'si'     1 0 'Cancelado sin cambios'
scenario apply-linea-vacia   --apply ''        1 0 'Cancelado sin cambios'
scenario apply-sin-entrada   --apply __EOF__   1 0 'sin confirmación; cancelado sin cambios'
scenario api-faltante        --apply "$ACK"    1 0 'APIs requeridas no habilitadas' FAKE_APIS='cloudbuild.googleapis.com iam.googleapis.com storage.googleapis.com'
scenario error-consulta-apis --apply "$ACK"    1 0 'no se pudieron consultar las APIs' FAKE_SERVICES_ERROR=1
scenario sin-cuenta-build    --apply "$ACK"    1 0 'falta la cuenta de compilación' FAKE_NO_BUILD_SA=1
scenario build-con-run-admin --apply "$ACK"    1 0 'roles de proyecto no permitidos' FAKE_BUILD_ROLES=roles/run.admin
scenario build-con-editor    --apply "$ACK"    1 0 'roles de proyecto no permitidos' FAKE_BUILD_ROLES=roles/editor
scenario runtime-existente   --apply "$ACK"    1 0 'la cuenta runtime ya existe' FAKE_RUNTIME_EXISTS=1
scenario repo-nombre-corto   --apply "$ACK"    1 0 'ya existe' FAKE_REPO_NAME=project-os
scenario repo-nombre-completo --apply "$ACK"   1 0 'ya existe' FAKE_REPO_NAME=projects/project-os-511102/locations/northamerica-south1/repositories/project-os
scenario bucket-existente    --apply "$ACK"    1 0 'el bucket de origen ya existe' FAKE_BUCKET_EXISTS=1
scenario gcloud-sin-flag     --apply "$ACK"    1 0 'el gcloud instalado no acepta' FAKE_DROP_FLAG=soft-delete-duration
scenario check-con-api-faltante --check ''     1 0 'APIs requeridas no habilitadas' FAKE_APIS='iam.googleapis.com'
scenario auditoria-no-verificada --apply "$ACK" 1 6 'NO VERIFICADO' FAKE_KEYS_ERROR=1
scenario auditoria-falla     --apply "$ACK"    1 6 'FALLA' FAKE_UBLA=false

echo
echo "Resultado: ${passed} escenarios correctos, ${failed} con problemas. Ninguna llamada salió del gcloud falso."
(( failed == 0 ))
