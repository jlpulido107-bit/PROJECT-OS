#!/usr/bin/env bash
# Despliega el dashboard a Cloud Run en un solo comando: renderiza el YAML, compara los NOMBRES de variables con la
# revisión activa (nunca imprime valores), pide confirmación y aplica. Solo lo ejecuta el propietario (Cloud Shell).
#   web/deploy/cloudrun/deploy.sh [--dry-run]     (exporta antes las variables de render.mjs, p. ej. SECRET_VERSION_PM_AGENT=<versión vigente>)
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-project-os-511102}"
REGION="${REGION:-northamerica-south1}"
SERVICE_NAME="${SERVICE_NAME:-project-os-dashboard}"
export PROJECT_ID REGION SERVICE_NAME

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) echo "Uso: deploy.sh [--dry-run]" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
YAML="$WORK/service.yaml"

if ! node "$HERE/render.mjs" > "$YAML"; then
  echo "DETENTE: el render falló; no se aplicó nada." >&2
  exit 1
fi

if ! gcloud run services describe "$SERVICE_NAME" --project "$PROJECT_ID" --region "$REGION" --format=json > "$WORK/activa.json"; then
  echo "DETENTE: no se pudo leer la revisión activa; no se aplicó nada." >&2
  exit 1
fi

# Nombres (con dígitos) de las variables de la revisión activa y del YAML nuevo, y la imagen de cada una.
node -e '
  const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).spec.template.spec.containers[0]
  console.log((c.env ?? []).map((e) => e.name).join("\n"))
' "$WORK/activa.json" | sort -u | sed '/^$/d' > "$WORK/activas.txt"
grep -oE '^ *- name: [A-Z][A-Z0-9_]*$' "$YAML" | sed -E 's/^ *- name: //' | sort -u > "$WORK/nuevas.txt"
# Versión de cada secreto (NOMBRE secreto:versión): solo nombres y números, nunca valores.
node -e '
  const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).spec.template.spec.containers[0]
  for (const e of c.env ?? []) { const r = e.valueFrom?.secretKeyRef; if (r) console.log(`${e.name} ${r.name}:${r.key}`) }
' "$WORK/activa.json" > "$WORK/secretos-activos.txt"
awk '/^ *- name: [A-Z][A-Z0-9_]*$/ { sub(/^ *- name: /, ""); v = $0; ref = 0; next }
  /^ *secretKeyRef:/ { ref = 1; next }
  ref && /^ *name: / { sub(/^ *name: /, ""); s = $0; next }
  ref && /^ *key: / { sub(/^ *key: /, ""); gsub(/[\047"]/, ""); print v " " s ":" $0; ref = 0 }' "$YAML" > "$WORK/secretos-nuevos.txt"
SECRETOS_DISTINTOS="$(awk 'NR == FNR { a[$1] = $2; next }
  ($1 in a) && a[$1] != $2 { split(a[$1], x, ":"); split($2, y, ":"); print $1 ": " a[$1] " → " (x[1] == y[1] ? y[2] : $2) }' \
  "$WORK/secretos-activos.txt" "$WORK/secretos-nuevos.txt")"
IMAGEN_ACTIVA="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).spec.template.spec.containers[0].image ?? "")' "$WORK/activa.json")"
IMAGEN_NUEVA="$(grep -E '^ *(- )?image: ' "$YAML" | head -n 1 | sed -E 's/^ *(- )?image: //')"

FALTAN="$(comm -23 "$WORK/activas.txt" "$WORK/nuevas.txt")"
if [ -n "$FALTAN" ]; then
  echo "DETENTE: la revisión activa tiene variables que el YAML no trae:" >&2
  echo "$FALTAN" | sed 's/^/  - /' >&2
  exit 1
fi
AGREGADAS="$(comm -13 "$WORK/activas.txt" "$WORK/nuevas.txt")"

echo "Servicio: $SERVICE_NAME ($PROJECT_ID, $REGION)"
echo "Imagen activa: ${IMAGEN_ACTIVA:-desconocida}"
echo "Imagen nueva:  $IMAGEN_NUEVA"
echo "Variables nuevas:"
if [ -n "$AGREGADAS" ]; then echo "$AGREGADAS" | sed 's/^/  + /'; else echo "  (ninguna)"; fi
echo "Variables quitadas: (ninguna)"
echo "Secretos con versión distinta:"
if [ -n "$SECRETOS_DISTINTOS" ]; then echo "$SECRETOS_DISTINTOS" | sed 's/^/  ~ /'; else echo "  (ninguno)"; fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "--dry-run: no se aplicó nada."
  exit 0
fi

read -r -p "Escribe «desplegar» para aplicar: " RESPUESTA || RESPUESTA=""
if [ "$RESPUESTA" != "desplegar" ]; then
  echo "Cancelado: no se aplicó nada." >&2
  exit 1
fi

gcloud run services replace "$YAML" --project "$PROJECT_ID" --region "$REGION"
gcloud run revisions list --service "$SERVICE_NAME" --project "$PROJECT_ID" --region "$REGION" --limit 3
