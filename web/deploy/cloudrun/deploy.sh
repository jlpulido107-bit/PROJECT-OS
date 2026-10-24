#!/usr/bin/env bash
# Despliega el dashboard a Cloud Run en un solo comando: renderiza el YAML, compara los NOMBRES de variables con la
# revisión activa (nunca imprime valores), pide confirmación y aplica. Solo lo ejecuta el propietario (Cloud Shell).
#   web/deploy/cloudrun/deploy.sh [--dry-run] [--desde-activa] [--quitar NOMBRE]...
# Sin --desde-activa, exporta antes las variables de render.mjs. Con ella, la revisión activa las aporta y lo ya exportado
# (p. ej. IMAGE=<digest nuevo>) prevalece. --quitar permite que esa variable falte en el YAML (repetible).
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-project-os-511102}"
REGION="${REGION:-northamerica-south1}"
SERVICE_NAME="${SERVICE_NAME:-project-os-dashboard}"
export PROJECT_ID REGION SERVICE_NAME

DRY_RUN=0
DESDE_ACTIVA=0
QUITAR=" "
USO="Uso: deploy.sh [--dry-run] [--desde-activa] [--quitar NOMBRE]..."
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --desde-activa) DESDE_ACTIVA=1 ;;
    --quitar)
      if [ $# -lt 2 ] || ! [[ "$2" =~ ^[A-Z][A-Z0-9_]*$ ]]; then echo "$USO (NOMBRE en mayúsculas)" >&2; exit 2; fi
      QUITAR="$QUITAR$2 "; shift ;;
    *) echo "$USO" >&2; exit 2 ;;
  esac
  shift
done

# ORD-POS-077: la escritura de finanzas va junta; --quitar de cualquiera de sus tres variables quita las tres.
case "$QUITAR" in
  *" FINANZAS_WRITE_MODE "*|*" FINANZAS_WRITE_SERVICE_ACCOUNT "*|*" FINANZAS_WRITER_EMAIL "*)
    for NOMBRE in FINANZAS_WRITE_MODE FINANZAS_WRITE_SERVICE_ACCOUNT FINANZAS_WRITER_EMAIL; do
      [[ "$QUITAR" == *" $NOMBRE "* ]] || QUITAR="$QUITAR$NOMBRE "
    done ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
YAML="$WORK/service.yaml"

leer_activa() {
  if ! gcloud run services describe "$SERVICE_NAME" --project "$PROJECT_ID" --region "$REGION" --format=json > "$WORK/activa.json"; then
    echo "DETENTE: no se pudo leer la revisión activa; no se aplicó nada." >&2
    exit 1
  fi
}

SOBRESCRITAS=""
if [ "$DESDE_ACTIVA" -eq 1 ]; then
  leer_activa
  # NOMBRE=valor\0 por variable de render.mjs que la activa define; los valores solo viajan por el entorno, nunca se imprimen.
  if ! node -e '
    const fs = require("fs")
    let spec, c
    try { spec = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).spec.template.spec; c = spec.containers[0] } catch { c = undefined }
    if (!c) { console.error("la revisión activa no es JSON válido o no tiene contenedor"); process.exit(1) }
    const env = new Map((c.env ?? []).map((e) => [e.name, e]))
    const literal = (n) => env.get(n)?.value
    const clave = (n) => env.get(n)?.valueFrom?.secretKeyRef?.key
    const m = {
      IMAGE: c.image, RUNTIME_SA: spec.serviceAccountName, SERVICE_URL: literal("NEXTAUTH_URL"), OAUTH_CLIENT_ID: literal("GOOGLE_CLIENT_ID"),
      SECRET_VERSION_NEXTAUTH: clave("NEXTAUTH_SECRET"), SECRET_VERSION_OAUTH: clave("GOOGLE_CLIENT_SECRET"),
      SECRET_VERSION_ALLOWLIST: clave("AUTH_ALLOWED_EMAILS"), SECRET_VERSION_WRITERS: clave("AUTH_WRITER_EMAILS"),
      SECRET_VERSION_GITHUB: clave("GITHUB_DISPATCH_TOKEN"), SECRET_VERSION_CLAUDE_ROUTINE: clave("CLAUDE_ROUTINE_TOKEN"),
      SECRET_VERSION_PM_AGENT: clave("PM_AGENT_TOKEN_SHA256"), WRITE_MODE: env.has("PROJECT_OS_WRITE_MODE") ? "sheets" : undefined,
      WRITE_SERVICE_ACCOUNT: literal("PROJECT_OS_WRITE_SERVICE_ACCOUNT"), CLAUDE_ROUTINE_ID: literal("CLAUDE_ROUTINE_ID"),
      PM_PUEDE_REGISTRAR_PR: literal("PM_PUEDE_REGISTRAR_PR"), RADAROS_SHEET_ID: literal("RADAROS_SHEET_ID"),
      FINANZAS_SHEET_ID: literal("FINANZAS_SHEET_ID"), FINANZAS_WRITE_MODE: literal("FINANZAS_WRITE_MODE"),
      FINANZAS_WRITE_SERVICE_ACCOUNT: literal("FINANZAS_WRITE_SERVICE_ACCOUNT"), FINANZAS_WRITER_EMAIL: literal("FINANZAS_WRITER_EMAIL"),
    }
    for (const n of ["REVISAR", "SEGUNDO", "CORREGIR"]) {
      m[`CLAUDE_ROUTINE_${n}_ID`] = literal(`CLAUDE_ROUTINE_${n}_ID`)
      m[`SECRET_VERSION_CLAUDE_ROUTINE_${n}`] = clave(`CLAUDE_ROUTINE_${n}_TOKEN`)
    }
    // Variable del YAML de la que sale cada una: con --quitar de esa variable no se toma de la activa.
    const de = { SERVICE_URL: "NEXTAUTH_URL", OAUTH_CLIENT_ID: "GOOGLE_CLIENT_ID", SECRET_VERSION_NEXTAUTH: "NEXTAUTH_SECRET",
      SECRET_VERSION_OAUTH: "GOOGLE_CLIENT_SECRET", SECRET_VERSION_ALLOWLIST: "AUTH_ALLOWED_EMAILS", SECRET_VERSION_WRITERS: "AUTH_WRITER_EMAILS",
      SECRET_VERSION_GITHUB: "GITHUB_DISPATCH_TOKEN", SECRET_VERSION_CLAUDE_ROUTINE: "CLAUDE_ROUTINE_TOKEN CLAUDE_ROUTINE_ID",
      CLAUDE_ROUTINE_ID: "CLAUDE_ROUTINE_ID CLAUDE_ROUTINE_TOKEN", SECRET_VERSION_PM_AGENT: "PM_AGENT_TOKEN_SHA256",
      WRITE_MODE: "PROJECT_OS_WRITE_MODE", WRITE_SERVICE_ACCOUNT: "PROJECT_OS_WRITE_SERVICE_ACCOUNT", PM_PUEDE_REGISTRAR_PR: "PM_PUEDE_REGISTRAR_PR",
      RADAROS_SHEET_ID: "RADAROS_SHEET_ID", FINANZAS_SHEET_ID: "FINANZAS_SHEET_ID", FINANZAS_WRITE_MODE: "FINANZAS_WRITE_MODE",
      FINANZAS_WRITE_SERVICE_ACCOUNT: "FINANZAS_WRITE_SERVICE_ACCOUNT", FINANZAS_WRITER_EMAIL: "FINANZAS_WRITER_EMAIL" }
    for (const n of ["REVISAR", "SEGUNDO", "CORREGIR"]) {
      de[`CLAUDE_ROUTINE_${n}_ID`] = de[`SECRET_VERSION_CLAUDE_ROUTINE_${n}`] = `CLAUDE_ROUTINE_${n}_ID CLAUDE_ROUTINE_${n}_TOKEN`
    }
    const quitar = process.argv[2].split(" ")
    const omitir = Object.keys(m).filter((k) => (de[k] ?? "").split(" ").some((n) => n && quitar.includes(n)))
    fs.writeFileSync(process.argv[3], ` ${omitir.join(" ")} `)
    for (const [k, v] of Object.entries(m)) if (v) process.stdout.write(`${k}=${v}\0`)
  ' "$WORK/activa.json" "$QUITAR" "$WORK/omitir.txt" > "$WORK/mapeo.bin"; then
    echo "DETENTE: no se pudo leer la configuración de la revisión activa; no se aplicó nada." >&2
    exit 1
  fi
  # Definida (aunque esté vacía) prevalece y el render valida su valor; la de una variable pedida con --quitar no se toma.
  OMITIR="$(cat "$WORK/omitir.txt")"
  while IFS='=' read -r -d '' NOMBRE VALOR; do
    if [ -n "${!NOMBRE+x}" ]; then SOBRESCRITAS="$SOBRESCRITAS $NOMBRE"
    elif [[ "$OMITIR" != *" $NOMBRE "* ]]; then export "$NOMBRE=$VALOR"; fi
  done < "$WORK/mapeo.bin"
fi

if ! node "$HERE/render.mjs" > "$YAML"; then
  echo "DETENTE: el render falló; no se aplicó nada." >&2
  exit 1
fi
if ! grep -q '[^[:space:]]' "$YAML"; then
  echo "DETENTE: el YAML renderizado está vacío; no se aplicó nada." >&2
  exit 1
fi
for NOMBRE in $QUITAR; do
  if grep -qE "^ *- name: $NOMBRE\$" "$YAML"; then
    echo "DETENTE: se pidió --quitar $NOMBRE pero el YAML renderizado la trae; no se aplicó nada." >&2
    exit 1
  fi
done

[ "$DESDE_ACTIVA" -eq 1 ] || leer_activa

# Nombres (con dígitos) de las variables de la revisión activa y del YAML nuevo, y la imagen de cada una.
if ! node -e '
  let c
  try { c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).spec.template.spec.containers[0] } catch { c = undefined }
  if (!c) process.exit(1)
  console.log((c.env ?? []).map((e) => e.name).join("\n"))
' "$WORK/activa.json" > "$WORK/activas.raw"; then
  echo "DETENTE: la revisión activa no es JSON válido o no tiene contenedor; no se aplicó nada." >&2
  exit 1
fi
sort -u "$WORK/activas.raw" | sed '/^$/d' > "$WORK/activas.txt"
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
# Tipo de cada variable (literal o secreto), para resumir los cambios valor↔secreto.
node -e '
  const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).spec.template.spec.containers[0]
  for (const e of c.env ?? []) console.log(`${e.name} ${e.valueFrom?.secretKeyRef ? "secreto" : "literal"}`)
' "$WORK/activa.json" > "$WORK/tipos-activos.txt"
awk '/^ *- name: [A-Z][A-Z0-9_]*$/ { sub(/^ *- name: /, ""); v = $0; t[v] = "literal"; o[++n] = v; next }
  /^ *secretKeyRef:/ { t[v] = "secreto" }
  END { for (i = 1; i <= n; i++) print o[i] " " t[o[i]] }' "$YAML" > "$WORK/tipos-nuevos.txt"
CAMBIOS_TIPO="$(awk 'NR == FNR { a[$1] = $2; next } ($1 in a) && a[$1] != $2 { print $1 ": " a[$1] " → " $2 }' \
  "$WORK/tipos-activos.txt" "$WORK/tipos-nuevos.txt")"
SECRETOS_DISTINTOS="$(awk 'NR == FNR { a[$1] = $2; next }
  ($1 in a) && a[$1] != $2 { split(a[$1], x, ":"); split($2, y, ":"); print $1 ": " a[$1] " → " (x[1] == y[1] ? y[2] : $2) }' \
  "$WORK/secretos-activos.txt" "$WORK/secretos-nuevos.txt")"
IMAGEN_ACTIVA="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).spec.template.spec.containers[0].image ?? "")' "$WORK/activa.json")"
IMAGEN_NUEVA="$(grep -E '^ *(- )?image: ' "$YAML" | head -n 1 | sed -E 's/^ *(- )?image: //')"

FALTAN=""
QUITADAS=""
for NOMBRE in $(comm -23 "$WORK/activas.txt" "$WORK/nuevas.txt"); do
  case "$QUITAR" in
    *" $NOMBRE "*) QUITADAS="${QUITADAS:+$QUITADAS$'\n'}$NOMBRE" ;;
    *) FALTAN="${FALTAN:+$FALTAN$'\n'}$NOMBRE" ;;
  esac
done
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
echo "Variables quitadas:"
if [ -n "$QUITADAS" ]; then echo "$QUITADAS" | sed 's/^/  - /'; else echo "  (ninguna)"; fi
if [ "$DESDE_ACTIVA" -eq 1 ]; then
  echo "Variables sobrescritas (ya exportadas, prevalecen sobre la activa):"
  if [ -n "$SOBRESCRITAS" ]; then echo "$SOBRESCRITAS" | tr ' ' '\n' | sed '/^$/d' | sed 's/^/  ! /'; else echo "  (ninguna)"; fi
fi
echo "Cambios valor↔secreto:"
if [ -n "$CAMBIOS_TIPO" ]; then echo "$CAMBIOS_TIPO" | sed 's/^/  ~ /'; else echo "  (ninguno)"; fi
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
