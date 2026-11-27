#!/usr/bin/env bash
# Workload Identity Federation para el colector de evidencias (ORD-POS-174 y ORD-POS-176). Guía: docs/colector-wif.md.
# Solo lo ejecuta el propietario, en Cloud Shell; ningún agente usa --apply.
#   web/deploy/infra/wif-colector.sh           SIMULA (predeterminado): imprime los comandos y NO llama a gcloud.
#   web/deploy/infra/wif-colector.sh --apply   Lee el número del proyecto, pide escribir «AUTORIZO WIF COLECTOR» y aplica.
#   … --quitar-subject                         Opcional, con o sin --apply: además quita, si existe, el binding por
#                                              subject que creaba ORD-POS-174 y que no sirvió. Solo ese.
# Crea, si no existen, el pool «github-colector» (propio: no comparte identidades con el pool «github» del despliegue),
# su proveedor OIDC «github-actions» (solo el repositorio de PROJECT-OS, la rama main y el workflow
# manual-github-evidence.yml) y la cuenta del colector. A esa cuenta NO le da ningún rol: ni en el proyecto ni en ningún
# recurso. Solo permite que la identidad de GitHub la use (roles/iam.workloadIdentityUser sobre la propia cuenta). Lo
# único que podrá hacer es lo que el propietario le dé al compartirle la hoja maestra como Editor.
# El permiso va por repositorio (principalSet por attribute.repository), no por subject: el subject escrito a mano no
# coincidió con el del token (403 del 26 y el 27-nov-2026; causa en docs/colector-wif.md). Quién entra al pool lo sigue
# limitando la condición del proveedor: este repositorio, main y el workflow del colector.
# Sin claves: nunca crea ni descarga una clave de cuenta de servicio.
# Al final imprime la VARIABLE (no secret) del repositorio, COLECTOR_WIF_PROVIDER, y la cuenta con la que se comparte la hoja.
set -euo pipefail

readonly PROJECT_ID='project-os-511102'
readonly CUENTA_NOMBRE='project-os-colector'
readonly CUENTA="${CUENTA_NOMBRE}@${PROJECT_ID}.iam.gserviceaccount.com"
readonly POOL='github-colector'
readonly PROVEEDOR='github-actions'
readonly REPO_GITHUB='jlpulido107-bit/PROJECT-OS'
readonly WORKFLOW="${REPO_GITHUB}/.github/workflows/manual-github-evidence.yml@refs/heads/main"
readonly CONDICION="assertion.repository=='${REPO_GITHUB}' && assertion.ref=='refs/heads/main' && assertion.workflow_ref=='${WORKFLOW}'"
readonly MAPEO='google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref'
readonly ACK='AUTORIZO WIF COLECTOR'

APPLY=0
QUITAR_SUBJECT=0
case "$#:${1:-}:${2:-}" in
  0::) ;;
  1:--apply:) APPLY=1 ;;
  1:--quitar-subject:) QUITAR_SUBJECT=1 ;;
  2:--apply:--quitar-subject) APPLY=1; QUITAR_SUBJECT=1 ;;
  *) echo "Uso: wif-colector.sh [--apply] [--quitar-subject]" >&2; exit 2 ;;
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
# Todas las identidades del pool cuyo atributo «repository» es este repositorio; nunca otro ni el pool entero («/*»).
MIEMBRO_WIF="principalSet://iam.googleapis.com/${POOL_RUTA}/attribute.repository/${REPO_GITHUB}"
# El binding de ORD-POS-174, por subject exacto: ya no se crea; --quitar-subject lo retira.
MIEMBRO_SUBJECT="principal://iam.googleapis.com/${POOL_RUTA}/subject/repo:${REPO_GITHUB}:ref:refs/heads/main"

paso() { # comando: lo imprime (simulación) o lo ejecuta (--apply)
  if [ "$APPLY" -eq 1 ]; then
    "$@"
  else
    printf '  '; printf '%q ' "$@"; printf '\n'
  fi
}

# Crea solo si no existe: en la simulación imprime el «create» con su condición.
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
  echo "Se aplicará WIF para el colector de $REPO_GITHUB (rama main, workflow manual-github-evidence.yml) en $PROJECT_ID."
  read -r -p "Escribe «$ACK» para aplicar: " RESPUESTA || RESPUESTA=""
  if [ "$RESPUESTA" != "$ACK" ]; then
    echo "Cancelado: no se cambió nada." >&2
    exit 1
  fi
else
  echo "SIMULACIÓN: no se llama a gcloud. Para aplicar: web/deploy/infra/wif-colector.sh --apply (solo el propietario)."
  echo "NUMERO_PROYECTO sale de: gcloud projects describe $PROJECT_ID --format='value(projectNumber)'"
fi

DESCRIBE=(gcloud iam workload-identity-pools describe "$POOL" --project "$PROJECT_ID" --location global)
crear_si_falta "el pool $POOL" gcloud iam workload-identity-pools create "$POOL" --project "$PROJECT_ID" --location global \
  --display-name 'GitHub Actions colector'

DESCRIBE=(gcloud iam workload-identity-pools providers describe "$PROVEEDOR" --project "$PROJECT_ID" --location global
  --workload-identity-pool "$POOL")
crear_si_falta "el proveedor $PROVEEDOR" gcloud iam workload-identity-pools providers create-oidc "$PROVEEDOR" \
  --project "$PROJECT_ID" --location global --workload-identity-pool "$POOL" --display-name 'PROJECT-OS main colector' \
  --issuer-uri 'https://token.actions.githubusercontent.com' --attribute-mapping "$MAPEO" --attribute-condition "$CONDICION"

DESCRIBE=(gcloud iam service-accounts describe "$CUENTA" --project "$PROJECT_ID")
crear_si_falta "la cuenta $CUENTA" gcloud iam service-accounts create "$CUENTA_NOMBRE" --project "$PROJECT_ID" \
  --display-name 'Colector de evidencias desde GitHub (WIF)'

# El único permiso que se concede: que la identidad de GitHub use la cuenta del colector.
paso gcloud iam service-accounts add-iam-policy-binding "$CUENTA" --project "$PROJECT_ID" \
  --role roles/iam.workloadIdentityUser --member "$MIEMBRO_WIF"

# Opcional: quitar el binding por subject. Idempotente: solo llama a «remove» si ese miembro exacto está en la política.
if [ "$QUITAR_SUBJECT" -eq 1 ]; then
  QUITAR=(gcloud iam service-accounts remove-iam-policy-binding "$CUENTA" --project "$PROJECT_ID"
    --role roles/iam.workloadIdentityUser --member "$MIEMBRO_SUBJECT")
  if [ "$APPLY" -eq 0 ]; then
    echo "# Si existe el binding por subject (el de ORD-POS-174):"
    paso "${QUITAR[@]}"
  else
    MIEMBROS="$(gcloud iam service-accounts get-iam-policy "$CUENTA" --project "$PROJECT_ID" \
      --flatten 'bindings[].members' --filter 'bindings.role:roles/iam.workloadIdentityUser' --format 'value(bindings.members)')"
    if grep -Fxq -- "$MIEMBRO_SUBJECT" <<< "$MIEMBROS"; then
      "${QUITAR[@]}"
      echo "Quitado: el binding por subject."
    else
      echo "No existe el binding por subject (no se cambia)."
    fi
  fi
fi

echo
echo "Variable del repositorio (Settings → Secrets and variables → Actions → Variables; no es un secret):"
echo "  COLECTOR_WIF_PROVIDER=${POOL_RUTA}/providers/${PROVEEDOR}"
echo "Cuenta con la que se comparte la hoja maestra, como Editor y solo esa hoja:"
echo "  ${CUENTA}"
if [ "$APPLY" -eq 0 ]; then echo "SIMULACIÓN terminada: no se cambió nada."; fi
