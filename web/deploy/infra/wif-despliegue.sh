#!/usr/bin/env bash
# Workload Identity Federation para el botón de despliegue (ORD-POS-163; DEC-POS-036, PENDIENTE). Guía:
# docs/despliegue-boton.md. Solo lo ejecuta el propietario, en Cloud Shell; ningún agente usa --apply.
#   web/deploy/infra/wif-despliegue.sh           SIMULA (predeterminado): imprime los comandos y NO llama a gcloud.
#   web/deploy/infra/wif-despliegue.sh --apply   Lee el número del proyecto, pide escribir «AUTORIZO WIF» y aplica.
# Crea, si no existen, el pool «github», su proveedor OIDC «github-actions» (solo el repositorio de PROJECT-OS, la rama
# main y el environment produccion) y la cuenta de despliegue; le da, con el mínimo alcance posible:
#   roles/run.developer en el servicio, roles/run.viewer en el proyecto (lectura: `revisions list` de deploy.sh),
#   roles/iam.serviceAccountUser sobre la cuenta de ejecución del servicio y roles/artifactregistry.writer en el
#   repositorio de imágenes. Sin claves: nunca crea ni descarga una clave de cuenta de servicio.
# Al final imprime los dos valores que van como VARIABLES (no secrets) del repositorio: WIF_PROVIDER y WIF_SERVICE_ACCOUNT.
set -euo pipefail

readonly PROJECT_ID='project-os-511102'
readonly REGION='northamerica-south1'
readonly SERVICE_NAME='project-os-dashboard'
readonly REPO_IMAGENES='project-os'
readonly RUNTIME_SA="project-os-dashboard-run@${PROJECT_ID}.iam.gserviceaccount.com"
readonly CUENTA_NOMBRE='project-os-despliegue'
readonly CUENTA="${CUENTA_NOMBRE}@${PROJECT_ID}.iam.gserviceaccount.com"
readonly POOL='github'
readonly PROVEEDOR='github-actions'
readonly REPO_GITHUB='jlpulido107-bit/PROJECT-OS'
readonly ENTORNO='produccion'
readonly CONDICION="assertion.repository=='${REPO_GITHUB}' && assertion.ref=='refs/heads/main' && assertion.environment=='${ENTORNO}'"
readonly MAPEO='google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref,attribute.environment=assertion.environment'
readonly ACK='AUTORIZO WIF'

APPLY=0
case "$#:${1:-}" in
  0:) ;;
  1:--apply) APPLY=1 ;;
  *) echo "Uso: wif-despliegue.sh [--apply]" >&2; exit 2 ;;
esac

# En la simulación el número del proyecto no se consulta: queda la variable de shell, que --apply llena.
NUMERO_PROYECTO='$NUMERO_PROYECTO'
if [ "$APPLY" -eq 1 ]; then
  NUMERO_PROYECTO="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
  if ! [[ "$NUMERO_PROYECTO" =~ ^[0-9]{6,20}$ ]]; then
    echo "DETENTE: no se pudo leer el número del proyecto; no se cambió nada." >&2
    exit 1
  fi
fi
POOL_RUTA="projects/${NUMERO_PROYECTO}/locations/global/workloadIdentityPools/${POOL}"
MIEMBRO_WIF="principal://iam.googleapis.com/${POOL_RUTA}/subject/repo:${REPO_GITHUB}:environment:${ENTORNO}"

paso() { # comando: lo imprime (simulación) o lo ejecuta (--apply)
  if [ "$APPLY" -eq 1 ]; then
    "$@"
  else
    printf '  '; printf '%q ' "$@"; printf '\n'
  fi
}

# Crea solo si no existe: en la simulación imprime el «describe» como condición y el «create».
crear_si_falta() { # descripción, comando describe (en un array global DESCRIBE), comando create
  local que=$1; shift
  if [ "$APPLY" -eq 1 ]; then
    if "${DESCRIBE[@]}" > /dev/null 2>&1; then
      echo "Ya existe: $que (no se cambia)."
      return 0
    fi
    "$@"
  else
    echo "# Si no existe $que:"
    printf '  '; printf '%q ' "$@"; printf '\n'
  fi
}

if [ "$APPLY" -eq 1 ]; then
  echo "Se aplicará WIF para $REPO_GITHUB (rama main, environment $ENTORNO) en $PROJECT_ID."
  read -r -p "Escribe «$ACK» para aplicar: " RESPUESTA || RESPUESTA=""
  if [ "$RESPUESTA" != "$ACK" ]; then
    echo "Cancelado: no se cambió nada." >&2
    exit 1
  fi
else
  echo "SIMULACIÓN: no se llama a gcloud. Para aplicar: web/deploy/infra/wif-despliegue.sh --apply (solo el propietario)."
  echo "NUMERO_PROYECTO sale de: gcloud projects describe $PROJECT_ID --format='value(projectNumber)'"
fi

DESCRIBE=(gcloud iam workload-identity-pools describe "$POOL" --project "$PROJECT_ID" --location global)
crear_si_falta "el pool $POOL" gcloud iam workload-identity-pools create "$POOL" --project "$PROJECT_ID" --location global \
  --display-name 'GitHub Actions'

DESCRIBE=(gcloud iam workload-identity-pools providers describe "$PROVEEDOR" --project "$PROJECT_ID" --location global
  --workload-identity-pool "$POOL")
crear_si_falta "el proveedor $PROVEEDOR" gcloud iam workload-identity-pools providers create-oidc "$PROVEEDOR" \
  --project "$PROJECT_ID" --location global --workload-identity-pool "$POOL" --display-name 'PROJECT-OS main produccion' \
  --issuer-uri 'https://token.actions.githubusercontent.com' --attribute-mapping "$MAPEO" --attribute-condition "$CONDICION"

DESCRIBE=(gcloud iam service-accounts describe "$CUENTA" --project "$PROJECT_ID")
crear_si_falta "la cuenta $CUENTA" gcloud iam service-accounts create "$CUENTA_NOMBRE" --project "$PROJECT_ID" \
  --display-name 'Despliegue del dashboard desde GitHub (WIF)'

paso gcloud iam service-accounts add-iam-policy-binding "$CUENTA" --project "$PROJECT_ID" \
  --role roles/iam.workloadIdentityUser --member "$MIEMBRO_WIF"
paso gcloud run services add-iam-policy-binding "$SERVICE_NAME" --project "$PROJECT_ID" --region "$REGION" \
  --role roles/run.developer --member "serviceAccount:$CUENTA"
paso gcloud projects add-iam-policy-binding "$PROJECT_ID" --role roles/run.viewer --member "serviceAccount:$CUENTA" \
  --condition None
paso gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" --project "$PROJECT_ID" \
  --role roles/iam.serviceAccountUser --member "serviceAccount:$CUENTA"
paso gcloud artifacts repositories add-iam-policy-binding "$REPO_IMAGENES" --project "$PROJECT_ID" --location "$REGION" \
  --role roles/artifactregistry.writer --member "serviceAccount:$CUENTA"

echo
echo "Variables del repositorio (Settings → Secrets and variables → Actions → Variables; no son secrets):"
echo "  WIF_PROVIDER=${POOL_RUTA}/providers/${PROVEEDOR}"
echo "  WIF_SERVICE_ACCOUNT=${CUENTA}"
if [ "$APPLY" -eq 0 ]; then echo "SIMULACIÓN terminada: no se cambió nada."; fi
