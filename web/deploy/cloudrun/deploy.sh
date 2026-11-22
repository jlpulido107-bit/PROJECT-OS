#!/usr/bin/env bash
# Despliega el dashboard a Cloud Run en un solo comando: renderiza el YAML, compara los NOMBRES de variables con la
# revisión activa (nunca imprime valores), pide confirmación y aplica. Solo lo ejecuta el propietario (Cloud Shell).
#   web/deploy/cloudrun/deploy.sh [--dry-run] [--desde-activa] [--solo-imagen] [--quitar NOMBRE]...
# Sin --desde-activa, exporta antes las variables de render.mjs. Con ella, la revisión activa las aporta y lo ya exportado
# (p. ej. IMAGE=<digest nuevo>) prevalece. --quitar permite que esa variable falte en el YAML (repetible).
# --solo-imagen (ORD-POS-162, para el despliegue desde CI): exige --desde-activa, no admite --quitar y pide IMAGE (por
# digest) y DEPLOY_COMMIT_SHA exportadas. Se detiene, también con --dry-run, si algo más que la imagen y DEPLOY_COMMIT_SHA
# cambiaría: variable nueva o quitada, cambio valor↔secreto, versión de secreto distinta, otra sobrescrita o, comparando
# el YAML completo con la revisión activa (comparar.mjs), el valor de una literal o un campo fuera de env (recursos,
# escala, timeout, cuenta, sondas, tráfico, anotaciones). Lo que no se puede comparar con seguridad también detiene.
# DEPLOY_COMMIT_SHA (ORD-POS-124): el commit de la imagen; si no se exporta, sale de git rev-parse HEAD de este clon.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-project-os-511102}"
REGION="${REGION:-northamerica-south1}"
SERVICE_NAME="${SERVICE_NAME:-project-os-dashboard}"
export PROJECT_ID REGION SERVICE_NAME

DRY_RUN=0
DESDE_ACTIVA=0
SOLO_IMAGEN=0
QUITAR=" "
USO="Uso: deploy.sh [--dry-run] [--desde-activa] [--solo-imagen] [--quitar NOMBRE]..."
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --desde-activa) DESDE_ACTIVA=1 ;;
    --solo-imagen) SOLO_IMAGEN=1 ;;
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
# ORD-POS-092: lo mismo con el agente de finanzas (modo, cuenta y hash del token).
case "$QUITAR" in
  *" FINANZAS_AGENTE_MODE "*|*" FINANZAS_AGENTE_SERVICE_ACCOUNT "*|*" FINANZAS_AGENTE_TOKEN_SHA256 "*)
    for NOMBRE in FINANZAS_AGENTE_MODE FINANZAS_AGENTE_SERVICE_ACCOUNT FINANZAS_AGENTE_TOKEN_SHA256; do
      [[ "$QUITAR" == *" $NOMBRE "* ]] || QUITAR="$QUITAR$NOMBRE "
    done ;;
esac
# ORD-POS-102: lo mismo con la escritura del pipeline de ECO (modo, cuenta y escritor).
case "$QUITAR" in
  *" ECO_PIPELINE_WRITE_MODE "*|*" ECO_PIPELINE_WRITE_SERVICE_ACCOUNT "*|*" ECO_PIPELINE_WRITER_EMAIL "*)
    for NOMBRE in ECO_PIPELINE_WRITE_MODE ECO_PIPELINE_WRITE_SERVICE_ACCOUNT ECO_PIPELINE_WRITER_EMAIL; do
      [[ "$QUITAR" == *" $NOMBRE "* ]] || QUITAR="$QUITAR$NOMBRE "
    done ;;
esac
# ORD-POS-106: lo mismo con el cierre de tareas del propietario (bandera y correo).
case "$QUITAR" in
  *" TAREAS_CIERRE_PROPIETARIO "*|*" TAREAS_CIERRE_PROPIETARIO_EMAIL "*)
    for NOMBRE in TAREAS_CIERRE_PROPIETARIO TAREAS_CIERRE_PROPIETARIO_EMAIL; do
      [[ "$QUITAR" == *" $NOMBRE "* ]] || QUITAR="$QUITAR$NOMBRE "
    done ;;
esac
# ORD-POS-136: lo mismo con la edición de la planificación por el propietario (bandera y correo).
case "$QUITAR" in
  *" PLANIFICACION_EDICION_PROPIETARIO "*|*" PLANIFICACION_EDICION_PROPIETARIO_EMAIL "*)
    for NOMBRE in PLANIFICACION_EDICION_PROPIETARIO PLANIFICACION_EDICION_PROPIETARIO_EMAIL; do
      [[ "$QUITAR" == *" $NOMBRE "* ]] || QUITAR="$QUITAR$NOMBRE "
    done ;;
esac
# ORD-POS-142: lo mismo con el calendario ICS (bandera y hash del secreto del enlace).
case "$QUITAR" in
  *" PLANIFICACION_ICS "*|*" CALENDARIO_ICS_TOKEN_SHA256 "*)
    for NOMBRE in PLANIFICACION_ICS CALENDARIO_ICS_TOKEN_SHA256; do
      [[ "$QUITAR" == *" $NOMBRE "* ]] || QUITAR="$QUITAR$NOMBRE "
    done ;;
esac
# ORD-POS-112: lo mismo con el rol Tiempos (bandera y hash del token).
case "$QUITAR" in
  *" TIEMPOS_AGENTE "*|*" TIEMPOS_AGENTE_TOKEN_SHA256 "*)
    for NOMBRE in TIEMPOS_AGENTE TIEMPOS_AGENTE_TOKEN_SHA256; do
      [[ "$QUITAR" == *" $NOMBRE "* ]] || QUITAR="$QUITAR$NOMBRE "
    done ;;
esac
# ORD-POS-170: lo mismo con la lectura del Director de Marketing (bandera y hash del token).
case "$QUITAR" in
  *" DIRECTOR_MKT_LECTURA "*|*" DIRECTOR_MKT_TOKEN_SHA256 "*)
    for NOMBRE in DIRECTOR_MKT_LECTURA DIRECTOR_MKT_TOKEN_SHA256; do
      [[ "$QUITAR" == *" $NOMBRE "* ]] || QUITAR="$QUITAR$NOMBRE "
    done ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
YAML="$WORK/service.yaml"

if [ "$SOLO_IMAGEN" -eq 1 ]; then
  if [ "$DESDE_ACTIVA" -ne 1 ] || [ "$QUITAR" != " " ]; then
    echo "$USO (--solo-imagen exige --desde-activa y no admite --quitar)" >&2
    exit 2
  fi
  # Antes de leer la activa y del render: IMAGE por digest, con la misma expresión de render.mjs. Nunca se imprime el valor.
  # «validar» es relleno: con la ruta de render.mjs en argv[1], render.mjs se creería el programa principal y renderizaría.
  if ! node -e 'import(require("url").pathToFileURL(process.argv[2])).then((m) => process.exit(m.REQUIRED.IMAGE.test(process.argv[3]) ? 0 : 1))' \
    validar "$HERE/render.mjs" "${IMAGE:-}"; then
    echo "DETENTE: --solo-imagen exige IMAGE exportada por digest (…-docker.pkg.dev/…@sha256:<64 hexadecimales>); no se aplicó nada." >&2
    exit 1
  fi
  if ! [[ "${DEPLOY_COMMIT_SHA:-}" =~ ^[0-9a-f]{40}$ ]]; then
    echo "DETENTE: --solo-imagen exige DEPLOY_COMMIT_SHA exportada (SHA completo de 40 hexadecimales); no se aplicó nada." >&2
    exit 1
  fi
fi

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
    // Solo con --solo-imagen: una literal vacía de la activa también se mapea, para que exportarla cuente como sobrescrita.
    const vacias = process.argv[4] === "1"
    const literal = (n) => env.get(n)?.value ?? (vacias && env.has(n) && !env.get(n).valueFrom ? "" : undefined)
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
      FINANZAS_AGENTE_MODE: literal("FINANZAS_AGENTE_MODE"), FINANZAS_AGENTE_SERVICE_ACCOUNT: literal("FINANZAS_AGENTE_SERVICE_ACCOUNT"),
      SECRET_VERSION_FINANZAS_AGENTE: clave("FINANZAS_AGENTE_TOKEN_SHA256"), SEGUNDO_GEMINI_SUPERVISADO: literal("SEGUNDO_GEMINI_SUPERVISADO"),
      SUPERVISION_MODELO_SESION: literal("SUPERVISION_MODELO_SESION"),
      ECO_PIPELINE_WRITE_MODE: literal("ECO_PIPELINE_WRITE_MODE"), ECO_PIPELINE_WRITE_SERVICE_ACCOUNT: literal("ECO_PIPELINE_WRITE_SERVICE_ACCOUNT"),
      ECO_PIPELINE_WRITER_EMAIL: literal("ECO_PIPELINE_WRITER_EMAIL"), TAREAS_CIERRE_PROPIETARIO: literal("TAREAS_CIERRE_PROPIETARIO"),
      TAREAS_CIERRE_PROPIETARIO_EMAIL: literal("TAREAS_CIERRE_PROPIETARIO_EMAIL"), TIEMPOS_AGENTE: literal("TIEMPOS_AGENTE"),
      SECRET_VERSION_TIEMPOS_AGENTE: clave("TIEMPOS_AGENTE_TOKEN_SHA256"), ECO_IDEAS_ALTA: literal("ECO_IDEAS_ALTA"),
      PLANIFICACION_EDICION_PROPIETARIO: literal("PLANIFICACION_EDICION_PROPIETARIO"),
      PLANIFICACION_EDICION_PROPIETARIO_EMAIL: literal("PLANIFICACION_EDICION_PROPIETARIO_EMAIL"),
      PLANIFICACION_ICS: literal("PLANIFICACION_ICS"), SECRET_VERSION_CALENDARIO_ICS: clave("CALENDARIO_ICS_TOKEN_SHA256"),
      ECO_TABULADOR: literal("ECO_TABULADOR"), ECO_BANDEJA_GEMINI: literal("ECO_BANDEJA_GEMINI"),
      DIRECTOR_MKT_LECTURA: literal("DIRECTOR_MKT_LECTURA"), SECRET_VERSION_DIRECTOR_MKT: clave("DIRECTOR_MKT_TOKEN_SHA256"),
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
      FINANZAS_WRITE_SERVICE_ACCOUNT: "FINANZAS_WRITE_SERVICE_ACCOUNT", FINANZAS_WRITER_EMAIL: "FINANZAS_WRITER_EMAIL",
      SEGUNDO_GEMINI_SUPERVISADO: "SEGUNDO_GEMINI_SUPERVISADO", SUPERVISION_MODELO_SESION: "SUPERVISION_MODELO_SESION", ECO_IDEAS_ALTA: "ECO_IDEAS_ALTA",
      ECO_TABULADOR: "ECO_TABULADOR", ECO_BANDEJA_GEMINI: "ECO_BANDEJA_GEMINI" }
    const agente = "FINANZAS_AGENTE_MODE FINANZAS_AGENTE_SERVICE_ACCOUNT FINANZAS_AGENTE_TOKEN_SHA256"
    for (const k of ["FINANZAS_AGENTE_MODE", "FINANZAS_AGENTE_SERVICE_ACCOUNT", "SECRET_VERSION_FINANZAS_AGENTE"]) de[k] = agente
    const eco = "ECO_PIPELINE_WRITE_MODE ECO_PIPELINE_WRITE_SERVICE_ACCOUNT ECO_PIPELINE_WRITER_EMAIL"
    for (const k of eco.split(" ")) de[k] = eco
    const cierre = "TAREAS_CIERRE_PROPIETARIO TAREAS_CIERRE_PROPIETARIO_EMAIL"
    for (const k of cierre.split(" ")) de[k] = cierre
    const edicion = "PLANIFICACION_EDICION_PROPIETARIO PLANIFICACION_EDICION_PROPIETARIO_EMAIL"
    for (const k of edicion.split(" ")) de[k] = edicion
    const tiempos = "TIEMPOS_AGENTE TIEMPOS_AGENTE_TOKEN_SHA256"
    for (const k of ["TIEMPOS_AGENTE", "SECRET_VERSION_TIEMPOS_AGENTE"]) de[k] = tiempos
    const mkt = "DIRECTOR_MKT_LECTURA DIRECTOR_MKT_TOKEN_SHA256"
    for (const k of ["DIRECTOR_MKT_LECTURA", "SECRET_VERSION_DIRECTOR_MKT"]) de[k] = mkt
    const calendario = "PLANIFICACION_ICS CALENDARIO_ICS_TOKEN_SHA256"
    for (const k of ["PLANIFICACION_ICS", "SECRET_VERSION_CALENDARIO_ICS"]) de[k] = calendario
    for (const n of ["REVISAR", "SEGUNDO", "CORREGIR"]) {
      de[`CLAUDE_ROUTINE_${n}_ID`] = de[`SECRET_VERSION_CLAUDE_ROUTINE_${n}`] = `CLAUDE_ROUTINE_${n}_ID CLAUDE_ROUTINE_${n}_TOKEN`
    }
    const quitar = process.argv[2].split(" ")
    const omitir = Object.keys(m).filter((k) => (de[k] ?? "").split(" ").some((n) => n && quitar.includes(n)))
    fs.writeFileSync(process.argv[3], ` ${omitir.join(" ")} `)
    for (const [k, v] of Object.entries(m)) if (v || (vacias && v === "")) process.stdout.write(`${k}=${v}\0`)
  ' "$WORK/activa.json" "$QUITAR" "$WORK/omitir.txt" "$SOLO_IMAGEN" > "$WORK/mapeo.bin"; then
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

# ORD-POS-124: commit que se despliega, literal DEPLOY_COMMIT_SHA («Desplegada» y «Fusionado sin desplegar»). Lo exportado
# prevalece; si no, el HEAD del clon. Nunca se toma de la revisión activa: la activa trae el commit anterior.
if [ -z "${DEPLOY_COMMIT_SHA:-}" ]; then
  if ! DEPLOY_COMMIT_SHA="$(git -C "$HERE" rev-parse HEAD 2>/dev/null)"; then
    echo "DETENTE: no se pudo leer el commit con git rev-parse HEAD; exporta DEPLOY_COMMIT_SHA. No se aplicó nada." >&2
    exit 1
  fi
fi
export DEPLOY_COMMIT_SHA

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
echo "Commit desplegado (DEPLOY_COMMIT_SHA): $DEPLOY_COMMIT_SHA"
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

if [ "$SOLO_IMAGEN" -eq 1 ]; then
  # Solo nombres, como el resumen de arriba; nunca valores. Una variable quitada ya detuvo arriba: aquí no hay --quitar.
  EXTRA=""
  motivo() { [ -z "$2" ] || EXTRA="$EXTRA$1: $(echo "$2" | tr '\n' ' ')"$'\n'; }
  motivo "variables nuevas" "$(echo "$AGREGADAS" | grep -vx 'DEPLOY_COMMIT_SHA' || true)"
  motivo "cambios valor↔secreto" "$(echo "$CAMBIOS_TIPO" | sed 's/:.*//')"
  motivo "secretos con versión distinta" "$(echo "$SECRETOS_DISTINTOS" | sed 's/:.*//')"
  motivo "variables sobrescritas" "$(echo "$SOBRESCRITAS" | tr ' ' '\n' | grep -vxE 'IMAGE|DEPLOY_COMMIT_SHA|' || true)"
  # El YAML completo contra la activa: valores de literales y campos fuera de env. comparar.mjs solo imprime nombres.
  if ! DISTINTOS="$(node "$HERE/comparar.mjs" "$YAML" "$WORK/activa.json")"; then
    echo "DETENTE: --solo-imagen no pudo comparar el YAML con la revisión activa; no se aplicó nada." >&2
    exit 1
  fi
  motivo "campos o valores distintos de la revisión activa" "$DISTINTOS"
  if [ -n "$EXTRA" ]; then
    echo "DETENTE: --solo-imagen solo admite cambiar la imagen y DEPLOY_COMMIT_SHA; no se aplicó nada. Sobran:" >&2
    echo -n "$EXTRA" | sed 's/^/  - /' >&2
    exit 1
  fi
fi

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
