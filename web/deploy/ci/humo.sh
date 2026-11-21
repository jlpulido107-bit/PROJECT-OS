#!/usr/bin/env bash
# Humo y reversión de tráfico tras un despliegue desde CI (ORD-POS-162). No despliega: solo lee el servicio y, si el humo
# falla, devuelve el tráfico a la revisión anotada antes del despliegue.
#   web/deploy/ci/humo.sh anotar      antes de deploy.sh: imprime por stdout SOLO la revisión que hoy sirve el 100 %
#   web/deploy/ci/humo.sh verificar   después: exige IMAGE (digest desplegado) y REVISION_ANTERIOR (la anotada)
# verificar comprueba que la última revisión creada está lista, es nueva, usa IMAGE y recibe el 100 %; si no, sale en rojo
# sin tocar el tráfico (con la sonda de arranque fallida Cloud Run deja sirviendo la anterior). Luego corre
# scripts/smoke-remote.mjs (solo GET, sin sesión); si falla, update-traffic a REVISION_ANTERIOR y rojo.
# Nunca imprime el JSON del servicio ni valores de variables: solo nombres de revisión y OK/FALLA.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-project-os-511102}"
REGION="${REGION:-northamerica-south1}"
SERVICE_NAME="${SERVICE_NAME:-project-os-dashboard}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
REVISION='^[a-z][a-z0-9-]{0,61}[a-z0-9]$'

# Deja en $WORK/estado.txt, una por línea: revisión al 100 % (vacía si no hay exactamente una), última creada, última
# lista, imagen de la plantilla y URL del servicio.
leer_servicio() {
  if ! gcloud run services describe "$SERVICE_NAME" --project "$PROJECT_ID" --region "$REGION" --format=json > "$WORK/servicio.json"; then
    echo "DETENTE: no se pudo leer el servicio." >&2
    exit 1
  fi
  if ! node -e '
    // Sin el try, el error de JSON.parse citaría un trozo de la respuesta, que lleva valores de variables.
    let s
    try { s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")) } catch { process.exit(1) }
    if (s === null || typeof s !== "object") process.exit(1)
    const st = s.status ?? {}
    // Una entrada con latestRevision y sin nombre apunta a la última lista.
    const al100 = (st.traffic ?? []).filter((t) => t.percent === 100).map((t) => t.revisionName ?? (t.latestRevision ? st.latestReadyRevisionName : ""))
    const uno = (v) => (typeof v === "string" && !/\s/.test(v) ? v : "")
    console.log([al100.length === 1 ? uno(al100[0]) : "", uno(st.latestCreatedRevisionName), uno(st.latestReadyRevisionName),
      uno(s.spec?.template?.spec?.containers?.[0]?.image), uno(st.url)].join("\n"))
  ' "$WORK/servicio.json" > "$WORK/estado.txt"; then
    echo "DETENTE: la respuesta del servicio no es JSON válido." >&2
    exit 1
  fi
  { IFS= read -r AL_100; IFS= read -r CREADA; IFS= read -r LISTA; IFS= read -r IMAGEN; IFS= read -r URL; } < "$WORK/estado.txt"
}

case "${1:-}" in
  anotar)
    [ $# -eq 1 ] || { echo "Uso: humo.sh anotar|verificar" >&2; exit 2; }
    leer_servicio
    if ! [[ "$AL_100" =~ $REVISION ]]; then
      echo "DETENTE: no hay exactamente una revisión con el 100 % del tráfico; no se puede anotar a cuál revertir." >&2
      exit 1
    fi
    echo "$AL_100"
    ;;
  verificar)
    [ $# -eq 1 ] || { echo "Uso: humo.sh anotar|verificar" >&2; exit 2; }
    if ! [[ "${REVISION_ANTERIOR:-}" =~ $REVISION ]]; then
      echo "DETENTE: falta REVISION_ANTERIOR (la que imprimió «humo.sh anotar» antes del despliegue)." >&2
      exit 1
    fi
    if ! node -e 'import(require("url").pathToFileURL(process.argv[2])).then((m) => process.exit(m.REQUIRED.IMAGE.test(process.argv[3]) ? 0 : 1))' \
      validar "$HERE/../cloudrun/render.mjs" "${IMAGE:-}"; then
      echo "DETENTE: falta IMAGE por digest (la que se desplegó)." >&2
      exit 1
    fi
    leer_servicio
    FALLA=""
    [[ "$CREADA" =~ $REVISION ]] && [ "$CREADA" = "$LISTA" ] || FALLA="la última revisión creada no está lista"
    [ -n "$FALLA" ] || [ "$LISTA" != "$REVISION_ANTERIOR" ] || FALLA="no hay revisión nueva: la última sigue siendo la anterior"
    [ -n "$FALLA" ] || [ "$IMAGEN" = "$IMAGE" ] || FALLA="la revisión no usa la imagen desplegada"
    [ -n "$FALLA" ] || [ "$AL_100" = "$LISTA" ] || FALLA="la revisión nueva no recibe el 100 % del tráfico"
    [ -n "$FALLA" ] || [[ "$URL" =~ ^https://[a-z0-9.-]+$ ]] || FALLA="el servicio no informa una URL https válida"
    if [ -n "$FALLA" ]; then
      echo "FALLA: $FALLA. No se tocó el tráfico; revisa el servicio (runbook §6)." >&2
      exit 1
    fi
    echo "OK: la revisión $LISTA está lista, usa la imagen desplegada y recibe el 100 % del tráfico."
    if node "$HERE/../../scripts/smoke-remote.mjs" --url "$URL"; then
      echo "OK: humo remoto correcto en $LISTA."
      exit 0
    fi
    echo "FALLA: el humo remoto falló en $LISTA; se devuelve el tráfico a $REVISION_ANTERIOR." >&2
    if ! gcloud run services update-traffic "$SERVICE_NAME" --project "$PROJECT_ID" --region "$REGION" \
      --to-revisions "$REVISION_ANTERIOR=100" > /dev/null; then
      echo "DETENTE: la reversión de tráfico falló; revierte a mano (runbook §6)." >&2
      exit 1
    fi
    leer_servicio
    if [ "$AL_100" != "$REVISION_ANTERIOR" ]; then
      echo "DETENTE: tras revertir, $REVISION_ANTERIOR no recibe el 100 % del tráfico; revierte a mano (runbook §6)." >&2
      exit 1
    fi
    echo "Tráfico revertido: $REVISION_ANTERIOR recibe el 100 %. El despliegue queda en rojo." >&2
    exit 1
    ;;
  *) echo "Uso: humo.sh anotar|verificar" >&2; exit 2 ;;
esac
