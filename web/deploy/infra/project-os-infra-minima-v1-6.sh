#!/usr/bin/env bash
# PROJECT-OS V1.6 — Puerta B, infraestructura mínima (V3). Preparado para revisión; NO ejecutar sin aprobación.
# Modos:
#   --plan   (predeterminado) PLAN ESTÁTICO: imprime lo que haría. No invoca gcloud, así que NO comprueba APIs, IAM
#            ni la existencia de recursos.
#   --check  Comprobación REAL de solo lectura: el mismo preflight de --apply (incluidas las flags del gcloud local).
#            Nunca pide confirmación ni modifica GCP.
#   --apply  Preflight de solo lectura → confirmación AUTORIZO → cambios → auditoría. Solo con autorización expresa.
# Revisión: docs/infra-minima-v1-6-revision.md. Pruebas estáticas: web/tests/infra-minima.test.ts.
set -Eeuo pipefail
IFS=$'\n\t'

readonly PROJECT_ID='project-os-511102'
readonly REGION='northamerica-south1'
readonly REPO='project-os'
readonly BUCKET="${PROJECT_ID}-project-os-build-src"
readonly BUILD_SA="project-os-build@${PROJECT_ID}.iam.gserviceaccount.com"
readonly RUNTIME_SA_NAME='project-os-dashboard-run'
readonly RUNTIME_SA="${RUNTIME_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
readonly ACK_TEXT='AUTORIZO INFRA PROJECT-OS'
# APIs que deben estar habilitadas ANTES (este script no habilita ninguna).
readonly REQUIRED_APIS=(cloudbuild.googleapis.com artifactregistry.googleapis.com iam.googleapis.com storage.googleapis.com)
# Únicos roles de PROYECTO que puede tener la cuenta de compilación (antes y después).
readonly ALLOWED_BUILD_PROJECT_ROLES=(roles/logging.logWriter)
# Flags que usan los comandos mutantes; el preflight comprueba con `gcloud … --help` (local, sin red) que existen en
# la versión instalada. `--project` y `--format` son globales de gcloud y no se listan.
readonly MUTATING_FLAGS=(
  'storage buckets create|location uniform-bucket-level-access public-access-prevention soft-delete-duration lifecycle-file'
  'artifacts repositories create|location repository-format description'
  'iam service-accounts create|display-name'
  'projects add-iam-policy-binding|member role condition'
  'artifacts repositories add-iam-policy-binding|location member role'
  'storage buckets add-iam-policy-binding|member role'
)
# Borra el código subido para compilar a los 7 días (igual que web/deploy/cloudbuild-source-lifecycle.json).
readonly LIFECYCLE_JSON='{"rule":[{"action":{"type":"Delete"},"condition":{"age":7}}]}'
# Archivo temporal del ciclo de vida (sin datos sensibles); globales para que el trap de salida los vea.
LIFECYCLE_DIR=''
LIFECYCLE_FILE=''

# Ayudante en Python: lee JSON por stdin (política IAM o descripción del bucket). Nunca imprime miembros ni correos.
PY_HELPER="$(cat <<'PY'
import json, sys
mode, args = sys.argv[1], sys.argv[2:]
try:
    data = json.load(sys.stdin)
except ValueError:
    print('JSON no válido', file=sys.stderr); sys.exit(2)

def roles_of(member):
    return sorted({b.get('role', '') for b in data.get('bindings', []) if member in b.get('members', [])})

if mode == 'roles':            # roles MEMBER -> roles del miembro, uno por línea
    print('\n'.join(roles_of(args[0])))
elif mode == 'unexpected':     # unexpected MEMBER ALLOWED... -> roles fuera de la lista; código 3 si hay alguno
    extra = [r for r in roles_of(args[0]) if r not in set(args[1:])]
    print('\n'.join(extra))
    sys.exit(3 if extra else 0)
elif mode == 'has':            # has MEMBER ROLE -> código 0 si existe el binding
    sys.exit(0 if args[1] in roles_of(args[0]) else 1)
elif mode == 'bucket':         # bucket REGION -> verifica las protecciones del bucket (claves snake_case del SDK)
    checks = []
    checks.append(('ubicación ' + args[0], str(data.get('location', '')).lower() == args[0].lower()))
    checks.append(('acceso uniforme (uniform_bucket_level_access)', data.get('uniform_bucket_level_access') is True))
    checks.append(('prevención de acceso público (public_access_prevention)', str(data.get('public_access_prevention', '')).lower() == 'enforced'))
    sd = data.get('soft_delete_policy') or {}
    checks.append(('borrado diferido desactivado (soft_delete_policy)', str(sd.get('retentionDurationSeconds', '')) == '0'))
    rules = (data.get('lifecycle_config') or {}).get('rule') or []
    checks.append(('ciclo de vida: borrar a los 7 días (lifecycle_config)', rules == [{'action': {'type': 'Delete'}, 'condition': {'age': 7}}]))
    for name, ok in checks:
        print(('OK     ' if ok else 'FALLA  ') + name)
    sys.exit(0 if all(ok for _, ok in checks) else 1)
else:
    print('modo desconocido', file=sys.stderr); sys.exit(2)
PY
)"
readonly PY_HELPER

py() { python3 -c "$PY_HELPER" "$@"; }
die() { echo "ERROR: $*" >&2; exit 1; }
# Enmascara correos de personas (no los de cuentas de servicio) en un flujo de texto.
mask_emails() {
  sed -E 's/@([a-z0-9-]+\.iam\.gserviceaccount\.com)/__CUENTA_SERVICIO__\1/g;
          s/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/***@***/g;
          s/__CUENTA_SERVICIO__/@/g'
}
# Todas las llamadas a gcloud pasan por aquí: los mensajes de error del SDK se muestran sin correos de personas.
gcloud() { command gcloud "$@" 2> >(mask_emails >&2); }
# Muestra solo el dominio de una cuenta: el informe no expone correos personales.
mask_account() { printf '***@%s' "${1#*@}"; }
# Búsquedas con here-string, nunca `printf … | grep -q`: con `pipefail`, si `grep -q` termina antes de que el
# productor acabe de escribir un texto largo, el SIGPIPE convierte una coincidencia en un falso negativo.
# Líneas exactas de una lista (salida `value(...)` de gcloud).
in_list() { grep -Fxq -- "$2" <<< "$1"; }
# El repositorio aparece con nombre corto (project-os) o completo (projects/…/repositories/project-os).
repo_in_list() { grep -Eq "(^|/)${REPO}\$" <<< "$1"; }
# El bucket aparece como nombre o como URL gs://.
bucket_in_list() { grep -Eq "^(gs://)?${BUCKET}/?\$" <<< "$1"; }
# APIs requeridas que no están en la lista de habilitadas (una por línea).
missing_apis() {
  local api
  for api in "${REQUIRED_APIS[@]}"; do in_list "$1" "$api" || printf '%s\n' "$api"; done
}

plan() {
  local IFS=' '   # une las listas con espacios en el texto del plan
  cat <<PLAN
PROJECT-OS / Puerta B (V3) — PLAN ESTÁTICO, SIN CAMBIOS
Proyecto: ${PROJECT_ID}   Región: ${REGION}
Este plan NO consulta GCP: no comprueba APIs, IAM ni recursos. La comprobación real (solo lectura) es --check,
y es también el inicio obligatorio de --apply.

Requisitos previos (los verifican --check y --apply; si falta alguno, se detienen sin cambios):
  - gcloud y python3 disponibles; una cuenta de gcloud activa con permisos sobre el proyecto.
  - APIs ya habilitadas: ${REQUIRED_APIS[*]}.
  - La cuenta de compilación ${BUILD_SA} ya existe
    y no tiene roles de proyecto distintos de: ${ALLOWED_BUILD_PROJECT_ROLES[*]}.
  - No existen todavía: el repositorio ${REPO}, el bucket gs://${BUCKET} ni la cuenta runtime.
  - El gcloud instalado acepta las flags de los comandos que se van a usar (comprobado con --help, sin red).

Cambios, en este orden, solo tras escribir exactamente: ${ACK_TEXT}
  1. Bucket privado gs://${BUCKET} en ${REGION}: acceso uniforme, prevención de acceso público,
     borrado diferido desactivado y ciclo de vida (borrar objetos a los 7 días) desde la creación.
  2. Repositorio Docker privado ${REPO} en ${REGION}.
  3. Cuenta runtime ${RUNTIME_SA}, sin roles ni claves.
  4. Permisos mínimos SOLO para ${BUILD_SA}:
     - roles/logging.logWriter en el proyecto;
     - roles/artifactregistry.writer solo en el repositorio ${REPO};
     - roles/storage.objectViewer solo en el bucket gs://${BUCKET}.
  5. Auditoría de solo lectura que VERIFICA las protecciones del bucket, los permisos y la cuenta runtime,
     sin imprimir políticas IAM ni correos. Cada punto queda como OK, FALLA (configuración incorrecta) o
     NO VERIFICADO (no se pudo leer).

La lista de roles permitidos solo revisa roles DIRECTOS de proyecto de ${BUILD_SA}:
no certifica roles heredados (carpeta u organización), roles en otros recursos ni permisos efectivos.

FUERA DE ALCANCE: habilitar APIs (incluida Secret Manager); secretos y versiones; OAuth; acceso a Sheets;
presupuesto; IAM de otros principales; actAs de la persona; builds; Cloud Run; despliegue; claves JSON.
BLOQUEO ANTES DEL PRIMER BUILD O PUSH: el repositorio debe tener la política de limpieza de imágenes
(web/deploy/cloudrun/artifact-cleanup-policy.json); ver docs/infra-minima-v1-6-revision.md §6. Este script no la aplica.
PLAN
}

# Comprueba que el gcloud local acepta cada flag de los comandos mutantes (solo `--help`: sin red ni cambios).
# La ayuda se pide con TERM=dumb y, además, se le quitan los códigos ANSI y el sobreimpreso: en una terminal con color
# (p. ej. Cloud Shell) gcloud escribe `ESC[1m--flagESC[m=…` y un patrón sobre el texto crudo daba falsos negativos.
# La flag se busca como palabra completa (`--flag` o `--[no-]flag`), sin depender de la maquetación de la ayuda.
verify_flags() {
  local entry cmd flags flag help missing=''
  local -a words
  for entry in "${MUTATING_FLAGS[@]}"; do
    cmd="${entry%%|*}"; flags="${entry#*|}"
    IFS=' ' read -r -a words <<< "$cmd"
    help="$(TERM=dumb command gcloud "${words[@]}" --help 2>/dev/null)" || { missing+="${cmd} (sin ayuda), "; continue; }
    help="$(plain_text <<< "$help")"
    IFS=' ' read -r -a words <<< "$flags"
    for flag in "${words[@]}"; do
      grep -Eq -- "(^|[^A-Za-z0-9-])--(\[no-\])?${flag}([^A-Za-z0-9-]|\$)" <<< "$help" || missing+="${cmd} --${flag}, "
    done
  done
  [[ -z "$missing" ]] || die "el gcloud instalado no acepta: ${missing%, }. Revísalo con \`gcloud <comando> --help\`; detenido sin cambios."
}

# Texto sin códigos de escape ANSI (negrita, subrayado, color) ni sobreimpreso `x<BS>x`.
plain_text() {
  LC_ALL=C sed -e $'s/\x1b\\[[0-9;]*[A-Za-z]//g' -e $'s/.\x08//g'
}

# ---- Preflight: SOLO LECTURA. Cualquier error de consulta detiene el script sin cambios. ----
# Deja en ACTIVE_ACCOUNT y PROJECT_NUMBER los datos para el resumen.
ACTIVE_ACCOUNT=''
PROJECT_NUMBER=''
preflight() {
  command -v gcloud >/dev/null || die 'gcloud no disponible.'
  command -v python3 >/dev/null || die 'python3 no disponible.'
  verify_flags

  local enabled_apis missing sa_list policy_json unexpected repo_list bucket_list
  ACTIVE_ACCOUNT="$(gcloud auth list --filter='status:ACTIVE' --format='value(account)' --limit=1)" \
    || die 'no se pudo consultar la cuenta activa de gcloud.'
  [[ -n "$ACTIVE_ACCOUNT" ]] || die 'no hay cuenta gcloud activa.'
  PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --project="$PROJECT_ID" --format='value(projectNumber)')" \
    || die 'no se pudo leer el proyecto (permiso o red); detenido sin cambios.'
  [[ "$PROJECT_NUMBER" =~ ^[0-9]+$ ]] || die 'no se pudo verificar el proyecto.'

  # Una sola consulta de APIs: un error de consulta es distinto de una API deshabilitada.
  enabled_apis="$(gcloud services list --enabled --project="$PROJECT_ID" --format='value(config.name)')" \
    || die 'no se pudieron consultar las APIs habilitadas (permiso o red); detenido sin cambios.'
  missing="$(missing_apis "$enabled_apis")"
  [[ -z "$missing" ]] || die "APIs requeridas no habilitadas: ${missing//$'\n'/, }. Este script no las habilita; detenido sin cambios."

  sa_list="$(gcloud iam service-accounts list --project="$PROJECT_ID" --format='value(email)')" \
    || die 'no se pudieron listar las cuentas de servicio; detenido sin cambios.'
  in_list "$sa_list" "$BUILD_SA" || die 'falta la cuenta de compilación project-os-build (requisito previo); detenido sin cambios.'
  ! in_list "$sa_list" "$RUNTIME_SA" || die 'la cuenta runtime ya existe; detener para auditarla antes de modificar nada.'

  # Lista de roles PERMITIDOS (solo roles directos de proyecto): cualquier otro rol de la cuenta de compilación
  # detiene el script. La política se procesa en memoria; no se escribe a disco ni se imprime.
  policy_json="$(gcloud projects get-iam-policy "$PROJECT_ID" --project="$PROJECT_ID" --format=json)" \
    || die 'no se pudo leer la política IAM del proyecto; detenido sin cambios.'
  if ! unexpected="$(printf '%s' "$policy_json" | py unexpected "serviceAccount:${BUILD_SA}" "${ALLOWED_BUILD_PROJECT_ROLES[@]}")"; then
    die "la cuenta de compilación tiene roles de proyecto no permitidos (${unexpected//$'\n'/, }); detenido sin cambios."
  fi

  repo_list="$(gcloud artifacts repositories list --project="$PROJECT_ID" --location="$REGION" --format='value(name)')" \
    || die 'no se pudieron listar los repositorios; detenido sin cambios.'
  ! repo_in_list "$repo_list" || die "el repositorio ${REPO} ya existe; detener para revisarlo."
  bucket_list="$(gcloud storage buckets list --project="$PROJECT_ID" --format='value(name)')" \
    || die 'no se pudieron listar los buckets; detenido sin cambios.'
  ! bucket_in_list "$bucket_list" || die 'el bucket de origen ya existe; detener para revisarlo.'

  printf '\nCuenta activa: %s\nNúmero de proyecto: %s\n' "$(mask_account "$ACTIVE_ACCOUNT")" "$PROJECT_NUMBER"
  echo 'Preflight de solo lectura completado: requisitos previos cumplidos.'
}

main() {
  local mode="${1:---plan}"
  if [[ $# -gt 1 || ! "$mode" =~ ^--(plan|check|apply)$ ]]; then
    echo "Uso: bash $0 [--plan|--check|--apply]"
    echo '  --plan   plan estático, sin consultar GCP (predeterminado)'
    echo '  --check  comprobación real de solo lectura; nunca modifica GCP'
    echo '  --apply  comprobación + confirmación AUTORIZO + cambios (requiere autorización expresa)'
    exit 2
  fi

  plan
  if [[ "$mode" == '--plan' ]]; then
    echo; echo 'Modo vista previa: no se llamó a gcloud. Para comprobar el estado real (solo lectura) usa --check.'
    return 0
  fi

  preflight
  if [[ "$mode" == '--check' ]]; then
    echo 'Modo --check: solo lectura, no se modificó nada. Ejecutar --apply requiere autorización expresa.'
    return 0
  fi

  echo 'Cambios previstos: bucket + repositorio + cuenta runtime + IAM mínimo de project-os-build.'
  local ack=''
  read -r -p "Para continuar escribe exactamente: ${ACK_TEXT}: " ack || die 'sin confirmación; cancelado sin cambios.'
  [[ "$ack" == "$ACK_TEXT" ]] || { echo 'Cancelado sin cambios.'; exit 1; }

  # ---- A partir de aquí hay cambios REMOTOS. No hay rollback automático: si algo falla, revisar a mano. ----
  # 1. Bucket primero: su nombre es global y es el paso con más probabilidad de fallar. El ciclo de vida se
  #    aplica en la misma creación (sin ventana sin política).
  LIFECYCLE_DIR="$(mktemp -d)"
  LIFECYCLE_FILE="${LIFECYCLE_DIR}/lifecycle.json"
  trap 'rm -f -- "$LIFECYCLE_FILE"; rmdir -- "$LIFECYCLE_DIR" 2>/dev/null || true' EXIT
  printf '%s\n' "$LIFECYCLE_JSON" > "$LIFECYCLE_FILE"
  gcloud storage buckets create "gs://${BUCKET}" \
    --project="$PROJECT_ID" --location="$REGION" \
    --uniform-bucket-level-access --public-access-prevention --soft-delete-duration=0 \
    --lifecycle-file="$LIFECYCLE_FILE"

  # 2. Repositorio Docker privado. Sin política de limpieza: BLOQUEO antes del primer build o push (informe §6).
  gcloud artifacts repositories create "$REPO" \
    --project="$PROJECT_ID" --location="$REGION" --repository-format=docker \
    --description='PROJECT-OS dashboard: imagenes privadas'

  # 3. Cuenta runtime sin roles ni claves.
  gcloud iam service-accounts create "$RUNTIME_SA_NAME" \
    --project="$PROJECT_ID" --display-name='PROJECT-OS dashboard runtime (sin roles iniciales)'

  # 4. IAM mínimo de project-os-build. --format=none: no imprimir la política resultante (incluye correos).
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --project="$PROJECT_ID" --condition=None \
    --member="serviceAccount:${BUILD_SA}" --role=roles/logging.logWriter --format=none
  gcloud artifacts repositories add-iam-policy-binding "$REPO" \
    --project="$PROJECT_ID" --location="$REGION" \
    --member="serviceAccount:${BUILD_SA}" --role=roles/artifactregistry.writer --format=none
  gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" --project="$PROJECT_ID" \
    --member="serviceAccount:${BUILD_SA}" --role=roles/storage.objectViewer --format=none

  audit
}

# ---- Auditoría posterior: SOLO LECTURA. Cada punto queda como OK, FALLA (configuración incorrecta) o
# NO VERIFICADO (no se pudo leer: permiso, red o formato). Nunca se interrumpe a mitad ni imprime políticas o correos.
AUDIT_FAILED=0
AUDIT_UNVERIFIED=0
report() {   # report ESTADO TEXTO
  case "$1" in
    OK) echo "OK             $2" ;;
    FALLA) echo "FALLA          $2"; AUDIT_FAILED=$((AUDIT_FAILED + 1)) ;;
    *) echo "NO VERIFICADO  $2"; AUDIT_UNVERIFIED=$((AUDIT_UNVERIFIED + 1)) ;;
  esac
}
# check_json TEXTO JSON MODO ARGS…: evalúa con el ayudante. Sin lectura o JSON no válido (código 2) → NO VERIFICADO;
# condición no cumplida → FALLA.
check_json() {
  local label="$1" json="$2" status=0; shift 2
  if [[ -z "$json" ]]; then report 'NO VERIFICADO' "${label} (no se pudo leer)"; return 0; fi
  printf '%s' "$json" | py "$@" >/dev/null 2>&1 || status=$?
  case "$status" in
    0) report OK "$label" ;;
    2) report 'NO VERIFICADO' "${label} (formato no reconocido)" ;;
    *) report FALLA "$label" ;;
  esac
}

audit() {
  echo; echo '--- AUDITORÍA POSTERIOR (solo lectura) ---'
  local bucket_json repo_format policy_json repo_policy bucket_policy runtime_roles runtime_keys
  bucket_json="$(gcloud storage buckets describe "gs://${BUCKET}" --project="$PROJECT_ID" \
    --format='json(name,location,uniform_bucket_level_access,public_access_prevention,soft_delete_policy,lifecycle_config)')" || bucket_json=''
  local status=0
  if [[ -z "$bucket_json" ]]; then
    report 'NO VERIFICADO' 'bucket de origen (no se pudo leer)'
  else
    echo 'Bucket de origen (detalle por protección):'
    printf '%s' "$bucket_json" | py bucket "$REGION" || status=$?
    case "$status" in
      0) report OK 'bucket de origen: todas las protecciones' ;;
      2) report 'NO VERIFICADO' 'bucket de origen (formato no reconocido)' ;;
      *) report FALLA 'bucket de origen: alguna protección no coincide (ver detalle)' ;;
    esac
  fi

  repo_format="$(gcloud artifacts repositories describe "$REPO" --project="$PROJECT_ID" --location="$REGION" --format='value(format)')" || repo_format=''
  if [[ -z "$repo_format" ]]; then report 'NO VERIFICADO' 'repositorio (no se pudo leer)'
  elif [[ "$repo_format" == 'DOCKER' ]]; then report OK 'repositorio Docker'
  else report FALLA "repositorio con formato ${repo_format}"
  fi

  policy_json="$(gcloud projects get-iam-policy "$PROJECT_ID" --project="$PROJECT_ID" --format=json)" || policy_json=''
  check_json 'project-os-build: roles directos de proyecto dentro de la lista permitida' "$policy_json" \
    unexpected "serviceAccount:${BUILD_SA}" "${ALLOWED_BUILD_PROJECT_ROLES[@]}"
  check_json 'project-os-build: roles/logging.logWriter en el proyecto' "$policy_json" \
    has "serviceAccount:${BUILD_SA}" roles/logging.logWriter
  repo_policy="$(gcloud artifacts repositories get-iam-policy "$REPO" --project="$PROJECT_ID" --location="$REGION" --format=json)" || repo_policy=''
  check_json 'project-os-build: roles/artifactregistry.writer en el repositorio' "$repo_policy" \
    has "serviceAccount:${BUILD_SA}" roles/artifactregistry.writer
  bucket_policy="$(gcloud storage buckets get-iam-policy "gs://${BUCKET}" --project="$PROJECT_ID" --format=json)" || bucket_policy=''
  check_json 'project-os-build: roles/storage.objectViewer en el bucket' "$bucket_policy" \
    has "serviceAccount:${BUILD_SA}" roles/storage.objectViewer

  if [[ -z "$policy_json" ]]; then
    report 'NO VERIFICADO' 'cuenta runtime: roles de proyecto (no se pudo leer la política)'
  else
    if ! runtime_roles="$(printf '%s' "$policy_json" | py roles "serviceAccount:${RUNTIME_SA}" 2>/dev/null)"; then
      report 'NO VERIFICADO' 'cuenta runtime: roles de proyecto (formato no reconocido)'
    elif [[ -z "$runtime_roles" ]]; then report OK 'cuenta runtime sin roles de proyecto'
    else report FALLA 'cuenta runtime con roles de proyecto'
    fi
  fi
  if runtime_keys="$(gcloud iam service-accounts keys list --iam-account="$RUNTIME_SA" --project="$PROJECT_ID" --managed-by=user --format='value(name)')"; then
    if [[ -z "$runtime_keys" ]]; then report OK 'cuenta runtime sin claves gestionadas por el usuario'
    else report FALLA 'cuenta runtime con claves gestionadas por el usuario'
    fi
  else
    report 'NO VERIFICADO' 'cuenta runtime: claves (no se pudo leer)'
  fi

  echo
  if (( AUDIT_FAILED > 0 )); then
    die "auditoría: ${AUDIT_FAILED} FALLA y ${AUDIT_UNVERIFIED} NO VERIFICADO. Revisar a mano (docs/infra-minima-v1-6-revision.md §5); NO se realizaron builds ni despliegues."
  fi
  if (( AUDIT_UNVERIFIED > 0 )); then
    die "auditoría incompleta: ${AUDIT_UNVERIFIED} NO VERIFICADO (sin fallas detectadas). Repetir las lecturas a mano; NO se realizaron builds ni despliegues."
  fi
  echo 'FINALIZADO: auditoría correcta. NO se realizaron builds ni despliegues.'
}

# Solo se ejecuta al invocarlo como script; al cargarlo con `source` (pruebas) solo define funciones.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
