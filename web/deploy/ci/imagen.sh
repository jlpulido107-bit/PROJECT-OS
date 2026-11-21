#!/usr/bin/env bash
# Construye y publica la imagen del dashboard para el despliegue desde CI (ORD-POS-162). No despliega ni toca Cloud Run.
#   web/deploy/ci/imagen.sh construir   docker build de web/ para linux/amd64, con la etiqueta del commit
#   web/deploy/ci/imagen.sh publicar    docker push de esa etiqueta; imprime por stdout SOLO la imagen por digest
# Entre los dos pasos va el humo local de la imagen (IMAGE=<etiqueta> SMOKE_BUILD=0 npm run docker:smoke).
# Exige DEPLOY_COMMIT_SHA (40 hexadecimales): es la etiqueta. El digest sale del push, nadie lo teclea, y se valida con
# la misma expresión de render.mjs antes de imprimirlo: uso `IMAGE="$(imagen.sh publicar)"`. Lo demás va a stderr.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-project-os-511102}"
REGION="${REGION:-northamerica-south1}"
REPOSITORIO="${REPOSITORIO:-project-os}"
NOMBRE_IMAGEN="${NOMBRE_IMAGEN:-dashboard}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB="$(cd "$HERE/../.." && pwd)"

if ! [[ "${DEPLOY_COMMIT_SHA:-}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "DETENTE: falta DEPLOY_COMMIT_SHA (SHA completo de 40 hexadecimales); no se construyó ni se publicó nada." >&2
  exit 1
fi
RUTA="$REGION-docker.pkg.dev/$PROJECT_ID/$REPOSITORIO/$NOMBRE_IMAGEN"
ETIQUETA="$RUTA:$DEPLOY_COMMIT_SHA"
valida() { # imagen por digest, con la expresión de render.mjs
  node -e 'import(require("url").pathToFileURL(process.argv[2])).then((m) => process.exit(m.REQUIRED.IMAGE.test(process.argv[3]) ? 0 : 1))' \
    validar "$HERE/../cloudrun/render.mjs" "$1"
}
# La ruta se valida antes de construir, con un digest de relleno: un PROJECT_ID, REGION o nombre raro no llega a docker.
if ! valida "$RUTA@sha256:$(printf '0%.0s' {1..64})"; then
  echo "DETENTE: REGION, PROJECT_ID, REPOSITORIO o NOMBRE_IMAGEN no forman una ruta de Artifact Registry válida; no se hizo nada." >&2
  exit 1
fi

case "${1:-}" in
  construir)
    [ $# -eq 1 ] || { echo "Uso: imagen.sh construir|publicar" >&2; exit 2; }
    docker build --platform linux/amd64 -t "$ETIQUETA" "$WEB" >&2
    echo "Imagen construida con la etiqueta del commit $DEPLOY_COMMIT_SHA." >&2
    ;;
  publicar)
    [ $# -eq 1 ] || { echo "Uso: imagen.sh construir|publicar" >&2; exit 2; }
    SALIDA="$(mktemp)"
    trap 'rm -f "$SALIDA"' EXIT
    if ! docker push "$ETIQUETA" > "$SALIDA" 2>&1; then
      cat "$SALIDA" >&2
      echo "DETENTE: docker push falló; no hay imagen que desplegar." >&2
      exit 1
    fi
    cat "$SALIDA" >&2
    # El push termina con «<etiqueta>: digest: sha256:… size: N». Debe haber exactamente un digest.
    DIGESTS="$(grep -oE 'digest: sha256:[0-9a-f]+' "$SALIDA" | sed 's/^digest: //' | sort -u || true)"
    if [ "$(echo "$DIGESTS" | grep -c .)" -ne 1 ] || ! valida "$RUTA@$DIGESTS"; then
      echo "DETENTE: el push no devolvió un único digest sha256 bien formado; no hay imagen que desplegar." >&2
      exit 1
    fi
    echo "$RUTA@$DIGESTS"
    ;;
  *) echo "Uso: imagen.sh construir|publicar" >&2; exit 2 ;;
esac
