#!/usr/bin/env bash
# PROJECT-OS V1.6 — Puerta B, infraestructura mínima (V2). Preparado para revisión; NO ejecutar sin aprobación.
# Modo predeterminado: --plan (no invoca gcloud ni modifica GCP).
# Ejecución futura, solo con autorización expresa: bash project-os-infra-minima-v1-6.sh --apply
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
# Muestra solo el dominio de una cuenta: el informe no expone correos personales.
mask_account() { printf '***@%s' "${1#*@}"; }
# Líneas exactas de una lista (salida `value(...)` de gcloud).
in_list() { printf '%s\n' "$1" | grep -Fxq -- "$2"; }
# El repositorio aparece con nombre corto (project-os) o completo (projects/…/repositories/project-os).
repo_in_list() { printf '%s\n' "$1" | grep -Eq "(^|/)${REPO}\$"; }
# El bucket aparece como nombre o como URL gs://.
bucket_in_list() { printf '%s\n' "$1" | grep -Eq "^(gs://)?${BUCKET}/?\$"; }
# APIs requeridas que no están en la lista de habilitadas (una por línea).
missing_apis() {
  local api
  for api in "${REQUIRED_APIS[@]}"; do in_list "$1" "$api" || printf '%s\n' "$api"; done
}

plan() {
  local IFS=' '   # une las listas con espacios en el texto del plan
  cat <<PLAN
PROJECT-OS / Puerta B (V2) — PLAN, SIN CAMBIOS
Proyecto: ${PROJECT_ID}   Región: ${REGION}

Requisitos previos (el script los comprueba y se detiene sin cambios si faltan):
  - gcloud y python3 disponibles; una cuenta de gcloud activa con permisos sobre el proyecto.
  - APIs ya habilitadas: ${REQUIRED_APIS[*]}.
  - La cuenta de compilación ${BUILD_SA} ya existe
    y no tiene roles de proyecto distintos de: ${ALLOWED_BUILD_PROJECT_ROLES[*]}.
  - No existen todavía: el repositorio ${REPO}, el bucket gs://${BUCKET} ni la cuenta runtime.

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
     sin imprimir políticas IAM ni correos.

FUERA DE ALCANCE: habilitar APIs (incluida Secret Manager); secretos y versiones; OAuth; acceso a Sheets;
presupuesto; IAM de otros principales; actAs de la persona; builds; Cloud Run; despliegue; claves JSON.
PENDIENTE ANTES DEL PRIMER DESPLIEGUE: política de limpieza de imágenes del repositorio (decisión aparte).
PLAN
}

main() {
  local mode="${1:---plan}"
  [[ $# -le 1 && ( "$mode" == '--plan' || "$mode" == '--apply' ) ]] || { echo "Uso: bash $0 [--plan|--apply]"; exit 2; }

  plan
  if [[ "$mode" == '--plan' ]]; then
    echo; echo 'Modo vista previa: no se llamó a gcloud.'
    return 0
  fi

  command -v gcloud >/dev/null || die 'gcloud no disponible.'
  command -v python3 >/dev/null || die 'python3 no disponible.'

  # ---- Preflight: SOLO LECTURA. Cualquier error de consulta detiene el script sin cambios. ----
  local active_account project_number enabled_apis missing sa_list policy_json unexpected repo_list bucket_list
  active_account="$(gcloud auth list --filter='status:ACTIVE' --format='value(account)' --limit=1)" \
    || die 'no se pudo consultar la cuenta activa de gcloud.'
  [[ -n "$active_account" ]] || die 'no hay cuenta gcloud activa.'
  project_number="$(gcloud projects describe "$PROJECT_ID" --project="$PROJECT_ID" --format='value(projectNumber)')" \
    || die 'no se pudo leer el proyecto (permiso o red); detenido sin cambios.'
  [[ "$project_number" =~ ^[0-9]+$ ]] || die 'no se pudo verificar el proyecto.'

  # Una sola consulta de APIs: un error de consulta es distinto de una API deshabilitada.
  enabled_apis="$(gcloud services list --enabled --project="$PROJECT_ID" --format='value(config.name)')" \
    || die 'no se pudieron consultar las APIs habilitadas (permiso o red); detenido sin cambios.'
  missing="$(missing_apis "$enabled_apis")"
  [[ -z "$missing" ]] || die "APIs requeridas no habilitadas: ${missing//$'\n'/, }. Este script no las habilita; detenido sin cambios."

  sa_list="$(gcloud iam service-accounts list --project="$PROJECT_ID" --format='value(email)')" \
    || die 'no se pudieron listar las cuentas de servicio; detenido sin cambios.'
  in_list "$sa_list" "$BUILD_SA" || die 'falta la cuenta de compilación project-os-build (requisito previo); detenido sin cambios.'
  ! in_list "$sa_list" "$RUNTIME_SA" || die 'la cuenta runtime ya existe; detener para auditarla antes de modificar nada.'

  # Lista de roles PERMITIDOS: cualquier otro rol de proyecto de la cuenta de compilación detiene el script.
  # La política se procesa en memoria; no se escribe a disco ni se imprime.
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

  printf '\nCuenta activa: %s\nNúmero de proyecto: %s\n' "$(mask_account "$active_account")" "$project_number"
  echo 'Preflight de solo lectura completado. Cambios previstos: bucket + repositorio + cuenta runtime + IAM mínimo de project-os-build.'
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

  # 2. Repositorio Docker privado (sin política de limpieza: pendiente antes del primer despliegue).
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

  # ---- Auditoría posterior: SOLO LECTURA. Verifica en lugar de solo mostrar; no imprime políticas ni correos. ----
  echo; echo '--- AUDITORÍA POSTERIOR ---'
  local failures=0 runtime_keys
  echo 'Bucket de origen:'
  if ! gcloud storage buckets describe "gs://${BUCKET}" --project="$PROJECT_ID" \
    --format='json(name,location,uniform_bucket_level_access,public_access_prevention,soft_delete_policy,lifecycle_config)' \
    | py bucket "$REGION"; then
    failures=$((failures + 1))
  fi

  echo 'Repositorio:'
  if [[ "$(gcloud artifacts repositories describe "$REPO" --project="$PROJECT_ID" --location="$REGION" --format='value(format)')" == 'DOCKER' ]]; then
    echo 'OK     repositorio Docker'
  else
    echo 'FALLA  repositorio Docker'; failures=$((failures + 1))
  fi

  echo 'Permisos de project-os-build:'
  policy_json="$(gcloud projects get-iam-policy "$PROJECT_ID" --project="$PROJECT_ID" --format=json)" \
    || die 'no se pudo releer la política IAM del proyecto; revisar a mano.'
  if printf '%s' "$policy_json" | py unexpected "serviceAccount:${BUILD_SA}" "${ALLOWED_BUILD_PROJECT_ROLES[@]}" >/dev/null \
    && printf '%s' "$policy_json" | py has "serviceAccount:${BUILD_SA}" roles/logging.logWriter; then
    echo 'OK     proyecto: solo roles/logging.logWriter'
  else
    echo 'FALLA  proyecto: roles distintos de los permitidos'; failures=$((failures + 1))
  fi
  if gcloud artifacts repositories get-iam-policy "$REPO" --project="$PROJECT_ID" --location="$REGION" --format=json \
    | py has "serviceAccount:${BUILD_SA}" roles/artifactregistry.writer; then
    echo 'OK     repositorio: roles/artifactregistry.writer'
  else
    echo 'FALLA  repositorio: falta roles/artifactregistry.writer'; failures=$((failures + 1))
  fi
  if gcloud storage buckets get-iam-policy "gs://${BUCKET}" --project="$PROJECT_ID" --format=json \
    | py has "serviceAccount:${BUILD_SA}" roles/storage.objectViewer; then
    echo 'OK     bucket: roles/storage.objectViewer'
  else
    echo 'FALLA  bucket: falta roles/storage.objectViewer'; failures=$((failures + 1))
  fi

  echo 'Cuenta runtime:'
  if [[ -z "$(printf '%s' "$policy_json" | py roles "serviceAccount:${RUNTIME_SA}")" ]]; then
    echo 'OK     sin roles de proyecto'
  else
    echo 'FALLA  tiene roles de proyecto'; failures=$((failures + 1))
  fi
  runtime_keys="$(gcloud iam service-accounts keys list --iam-account="$RUNTIME_SA" --project="$PROJECT_ID" --managed-by=user --format='value(name)')" \
    || die 'no se pudieron listar las claves de la cuenta runtime; revisar a mano.'
  if [[ -z "$runtime_keys" ]]; then
    echo 'OK     sin claves gestionadas por el usuario'
  else
    echo 'FALLA  tiene claves gestionadas por el usuario'; failures=$((failures + 1))
  fi

  if (( failures > 0 )); then
    die "auditoría con ${failures} falla(s): revisar a mano; NO se realizaron builds ni despliegues."
  fi
  echo 'FINALIZADO: auditoría correcta. NO se realizaron builds ni despliegues.'
}

# Solo se ejecuta al invocarlo como script; al cargarlo con `source` (pruebas) solo define funciones.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
