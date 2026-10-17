#!/usr/bin/env bash
# Alta del PM por la API de operaciones del dashboard (pm-escribir-api, DEC-POS-005).
# Uso: bash scripts/pm-alta.sh <tareas|decisiones|ordenes> <archivo.json> [--repetir]
# El host y la ruta son fijos. El token lo añade el proxy del entorno: aquí no se lee ni se envía ninguna cabecera Authorization.
set -euo pipefail

DASHBOARD=https://project-os-dashboard-235975889400.northamerica-south1.run.app
uso() { echo "Uso: bash scripts/pm-alta.sh <tareas|decisiones|ordenes> <archivo.json> [--repetir]" >&2; exit 2; }

[ $# -ge 2 ] && [ $# -le 3 ] || uso
tipo=$1; archivo=$2; repetir=${3:-}
[ -z "$repetir" ] || [ "$repetir" = "--repetir" ] || uso

# Límites de longitud por tipo (web/src/lib/operations/constants.ts, LIMITS).
case "$tipo" in
  tareas) limites='{"titulo":160,"descripcion":2000,"criterioTerminado":1000,"responsable":80}' ;;
  decisiones) limites='{"asunto":200,"decision":2000,"justificacion":2000,"responsable":80,"evidenciaUrl":500}' ;;
  ordenes) limites='{"titulo":160,"objetivo":2000,"criterios":2000,"fueraDeAlcance":2000,"comoProbar":2000,"contexto":2000}' ;;
  *) echo "Tipo no permitido: $tipo (solo tareas, decisiones u ordenes)" >&2; exit 2 ;;
esac

[ -f "$archivo" ] || { echo "No existe el archivo: $archivo" >&2; exit 2; }
enviado="${archivo%.enviado.json}"; enviado="${enviado%.json}.enviado.json"

if [ "$repetir" = "--repetir" ]; then
  [ -f "$enviado" ] || { echo "No hay $enviado que repetir" >&2; exit 2; }
  cuerpo=$enviado
else
  [ ! -e "$enviado" ] || { echo "Ya existe $enviado: usa --repetir para reenviar el mismo cuerpo" >&2; exit 2; }
  if jq -e 'has("requestId")' "$archivo" > /dev/null; then
    echo "El JSON no debe traer requestId: el script lo genera" >&2; exit 2
  fi
  excedidos=$(jq -r --argjson l "$limites" '. as $b | $l | to_entries[]
    | select(($b[.key] | type) == "string" and ($b[.key] | length) > .value) | "\(.key) excede \(.value) caracteres"' "$archivo")
  [ -z "$excedidos" ] || { echo "$excedidos" >&2; exit 2; }
  requestId=$(python3 -c 'import uuid; print(uuid.uuid4())')
  jq --arg r "$requestId" '. + {requestId: $r}' "$archivo" > "$enviado"
  bytes=$(wc -c < "$enviado")
  # Tope del cuerpo de la API (LIMITS.bodyBytes, 16 KiB).
  [ "$bytes" -le 16384 ] || { rm -f "$enviado"; echo "El cuerpo ocupa $bytes bytes: excede 16 KiB (16384); no se envió" >&2; exit 2; }
  cuerpo=$enviado
fi

echo "requestId=$(jq -r .requestId "$cuerpo") cuerpo=$cuerpo"
respuesta=$(mktemp); trap 'rm -f "$respuesta"' EXIT
codigo=$(curl -sS --max-time 60 -o "$respuesta" -w '%{http_code}' -X POST "$DASHBOARD/api/operaciones/$tipo" \
  -H 'Content-Type: application/json' --data-binary @"$cuerpo") || { echo "Fallo de transporte: el resultado es incierto" >&2; exit 1; }
echo "HTTP $codigo"; cat "$respuesta"; echo
case "$codigo" in
  2??) ;;
  3??) echo "Error: redirección inesperada (HTTP $codigo)" >&2; exit 1 ;;
  4??) rechazado="${enviado%.enviado.json}.rechazado.json"; mv -f "$enviado" "$rechazado"
    echo "Rechazada (HTTP $codigo): no se escribió nada. $enviado pasó a $rechazado; corrige $archivo y reenvíalo (requestId nuevo)" >&2; exit 1 ;;
  *) echo "Error HTTP $codigo: se conserva $enviado para --repetir" >&2; exit 1 ;;
esac
