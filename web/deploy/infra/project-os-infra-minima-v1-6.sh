#!/usr/bin/env bash
# PROJECT-OS V1.6 — Puerta B. Preparado para revision; NO ejecutar sin aprobacion posterior.
# Modo predeterminado: --plan (sin invocar gcloud ni modificar GCP).
# Ejecucion futura: bash project-os-infra-minima-v1-6.sh --apply
set -Eeuo pipefail
IFS=$'\n\t'

PROJECT_ID='project-os-511102'
REGION='northamerica-south1'
REPO='project-os'
BUCKET='project-os-511102-project-os-build-src'
BUILD_SA="project-os-build@${PROJECT_ID}.iam.gserviceaccount.com"
RUNTIME_SA="project-os-dashboard-run@${PROJECT_ID}.iam.gserviceaccount.com"
MODE="${1:---plan}"

usage(){ echo "Uso: bash $0 [--plan|--apply]"; exit 2; }
[[ $# -le 1 ]] || usage
[[ "$MODE" == '--plan' || "$MODE" == '--apply' ]] || usage

plan(){
cat <<PLAN
PROJECT-OS / Puerta B — PLAN, SIN CAMBIOS
Proyecto: ${PROJECT_ID}
Region: ${REGION}
1. Verificar proyecto, cuenta activa, APIs y recursos existentes (solo lectura).
2. Habilitar SOLO Secret Manager API (si esta deshabilitada).
3. Crear repositorio privado Docker ${REPO} en ${REGION} (si no existe).
4. Crear bucket privado gs://${BUCKET} en ${REGION}, UBLA, PAP y soft delete=0 (si no existe).
5. Aplicar politica de ciclo de vida: borrar objetos de origen a los 7 dias.
6. Crear cuenta runtime ${RUNTIME_SA} sin roles ni claves (si no existe).
7. Otorgar a ${BUILD_SA} solamente:
   - roles/logging.logWriter en proyecto
   - roles/artifactregistry.writer en repositorio ${REPO}
   - roles/storage.objectViewer en bucket ${BUCKET}
8. Verificar resultados y generar reporte no sensible.
FUERA DE ALCANCE: secretos y versiones; acceso Sheets; OAuth; presupuesto; IAM de otros
principales; cuenta humana actAs; builds; Cloud Run; despliegue; claves JSON.
Nota: las APIs Cloud Build y Artifact Registry deben estar habilitadas previamente.
Nota: no asigna roles a la cuenta runtime ni acceso para iniciar compilaciones.
PLAN
}

plan
if [[ "$MODE" == '--plan' ]]; then
  echo; echo 'Modo vista previa: no se llamo a gcloud.'
  exit 0
fi

command -v gcloud >/dev/null || { echo 'ERROR: gcloud no disponible.' >&2; exit 1; }
command -v python3 >/dev/null || { echo 'ERROR: python3 no disponible.' >&2; exit 1; }

# Preflight: todas las consultas antes del primer cambio. Se aborta ante recursos
# preexistentes con configuracion desconocida; no se alteran automaticamente.
ACTIVE_ACCOUNT="$(gcloud auth list --filter='status:ACTIVE' --format='value(account)' | head -n 1)"
[[ -n "$ACTIVE_ACCOUNT" ]] || { echo 'ERROR: no hay cuenta gcloud activa.' >&2; exit 1; }
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
[[ "$PROJECT_NUMBER" =~ ^[0-9]+$ ]] || { echo 'ERROR: no se pudo verificar el proyecto.' >&2; exit 1; }

# Solo comprobar APIs; no habilitar otras distintas de Secret Manager.
for api in cloudbuild.googleapis.com artifactregistry.googleapis.com iam.googleapis.com storage.googleapis.com; do
  if ! gcloud services list --enabled --project="$PROJECT_ID" --format='value(config.name)' | grep -Fxq "$api"; then
    echo "ERROR: API prerrequisito no habilitada: $api. Detenido sin cambios." >&2; exit 1
  fi
done

BUILD_NAME="$(gcloud iam service-accounts describe "$BUILD_SA" --project="$PROJECT_ID" --format='value(email)')"
[[ "$BUILD_NAME" == "$BUILD_SA" ]] || { echo 'ERROR: identidad build incorrecta.' >&2; exit 1; }

# Rechazar permisos de proyecto elevados directos a la SA de build.
POLICY_FILE="$(mktemp)"
trap 'rm -f "$POLICY_FILE"' EXIT
chmod 600 "$POLICY_FILE"
gcloud projects get-iam-policy "$PROJECT_ID" --format=json > "$POLICY_FILE"
python3 - "$POLICY_FILE" "$BUILD_SA" <<'PY'
import json,sys
with open(sys.argv[1], encoding='utf-8') as f: p=json.load(f)
member='serviceAccount:'+sys.argv[2]
for b in p.get('bindings',[]):
    if member in b.get('members',[]) and b.get('role') in {'roles/editor','roles/owner'}:
        raise SystemExit('ERROR: build SA tiene Editor/Owner directos; no continuar')
PY

# Listados autorizados en lugar de `describe` con error suprimido: si falta
# permiso de lectura, se aborta en vez de confundir PermissionDenied con NotFound.
REPO_LIST="$(gcloud artifacts repositories list --project="$PROJECT_ID" --location="$REGION" --format='value(name)')" || exit 1
if printf '%s\n' "$REPO_LIST" | grep -Eq "(^|/)repositories/${REPO}$"; then
  echo 'ERROR: el repositorio ya existe; se detiene para revisarlo.' >&2; exit 1
fi
BUCKET_LIST="$(gcloud storage buckets list --project="$PROJECT_ID" --format='value(name)')" || exit 1
if printf '%s\n' "$BUCKET_LIST" | grep -Fxq "$BUCKET" || printf '%s\n' "$BUCKET_LIST" | grep -Eq "^gs://${BUCKET}/?$"; then
  echo 'ERROR: el bucket ya existe; se detiene para revisarlo.' >&2; exit 1
fi
# Los nombres de buckets son globales: un conflicto externo detendra su creacion.
SA_LIST="$(gcloud iam service-accounts list --project="$PROJECT_ID" --format='value(email)')" || exit 1
if printf '%s\n' "$SA_LIST" | grep -Fxq "$RUNTIME_SA"; then
  echo 'ERROR: runtime SA ya existe; detener para auditoria antes de modificar.' >&2; exit 1
fi

if gcloud services list --enabled --project="$PROJECT_ID" --format='value(config.name)' | grep -Fxq secretmanager.googleapis.com; then
  SECRET_API_ENABLED=1
else
  SECRET_API_ENABLED=0
fi

printf '\nCuenta activa: %s\nNumero de proyecto: %s\n' "$ACTIVE_ACCOUNT" "$PROJECT_NUMBER"
echo 'Preflight de lectura completado. Cambios permitidos: Secret Manager API + repo + bucket + runtime SA + IAM build minimo.'
read -r -p 'Para continuar escribe exactamente: AUTORIZO INFRA PROJECT-OS: ' ACK
[[ "$ACK" == 'AUTORIZO INFRA PROJECT-OS' ]] || { echo 'Cancelado sin cambios.'; exit 1; }

# A partir de aqui hay cambios REMOTOS. No hay rollback automatico de recursos.
if [[ "$SECRET_API_ENABLED" == 0 ]]; then
  gcloud services enable secretmanager.googleapis.com --project="$PROJECT_ID"
fi

gcloud artifacts repositories create "$REPO" \
  --project="$PROJECT_ID" --location="$REGION" --repository-format=docker \
  --description='PROJECT-OS dashboard: imagenes privadas'

# No aplica politica de retencion de imagenes hasta aprobar por separado una politica de limpieza.
gcloud storage buckets create "gs://${BUCKET}" \
  --project="$PROJECT_ID" --location="$REGION" \
  --uniform-bucket-level-access --public-access-prevention --soft-delete-duration=0

# Politica local con JSON estable: borra objetos del codigo fuente despues de 7 dias.
LIFECYCLE_FILE="$(mktemp --suffix=.json)"
trap 'rm -f "$POLICY_FILE" "$LIFECYCLE_FILE"' EXIT
chmod 600 "$LIFECYCLE_FILE"
cat > "$LIFECYCLE_FILE" <<'JSON'
{"rule":[{"action":{"type":"Delete"},"condition":{"age":7}}]}
JSON
gcloud storage buckets update "gs://${BUCKET}" --lifecycle-file="$LIFECYCLE_FILE"

gcloud iam service-accounts create project-os-dashboard-run \
  --project="$PROJECT_ID" --display-name='PROJECT-OS dashboard runtime (sin roles iniciales)'

# IAM: no usar roles/editor ni roles/owner. Solo alcances previstos.
gcloud projects add-iam-policy-binding "$PROJECT_ID" --condition=None \
  --member="serviceAccount:${BUILD_SA}" --role=roles/logging.logWriter

gcloud artifacts repositories add-iam-policy-binding "$REPO" \
  --project="$PROJECT_ID" --location="$REGION" \
  --member="serviceAccount:${BUILD_SA}" --role=roles/artifactregistry.writer

gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${BUILD_SA}" --role=roles/storage.objectViewer

# Auditoria post: solo lectura. Si falla, parar y revisar manualmente.
echo; echo '--- AUDITORIA POSTERIOR ---'
gcloud services list --enabled --project="$PROJECT_ID" --filter='config.name:secretmanager.googleapis.com' --format='table(config.name)'
gcloud artifacts repositories describe "$REPO" --project="$PROJECT_ID" --location="$REGION" --format='yaml(name,format,location)'
gcloud storage buckets describe "gs://${BUCKET}" --format='yaml(name,location,iamConfiguration.uniformBucketLevelAccess.enabled,iamConfiguration.publicAccessPrevention,softDeletePolicy,lifecycle)'
gcloud iam service-accounts describe "$RUNTIME_SA" --project="$PROJECT_ID" --format='value(email)'

# Verificacion textual de roles del proyecto, sin asumir que IAM heredado esta auditado.
gcloud projects get-iam-policy "$PROJECT_ID" --flatten='bindings[].members' \
  --filter="bindings.members:serviceAccount:${BUILD_SA}" --format='table(bindings.role)'
gcloud projects get-iam-policy "$PROJECT_ID" --flatten='bindings[].members' \
  --filter="bindings.members:serviceAccount:${RUNTIME_SA}" --format='table(bindings.role)'
gcloud artifacts repositories get-iam-policy "$REPO" --project="$PROJECT_ID" --location="$REGION" --format='yaml(bindings)'
gcloud storage buckets get-iam-policy "gs://${BUCKET}" --format='yaml(bindings)'
echo 'FINALIZADO: inspeccionar los resultados; NO se realizaron builds ni deploys.'
