#!/usr/bin/env bash
# Transición de orden del PM por la API de operaciones del dashboard (pm-escribir-api, DEC-POS-011).
# Uso: bash scripts/pm-transicion.sh <ORD-PRY-NNN> <archivo.json> [--repetir]
# Solo APROBAR, ENVIAR y REVISAR; el servidor valida estado, riesgo, «sí», fecha y dictamen.
# El host y la ruta son fijos. El token lo añade el proxy del entorno: aquí no se lee ni se envía ninguna cabecera Authorization.
set -euo pipefail

DASHBOARD=https://project-os-dashboard-235975889400.northamerica-south1.run.app
USO="Uso: bash scripts/pm-transicion.sh <ORD-PRY-NNN> <archivo.json> [--repetir]
  archivo.json: {\"accion\": \"APROBAR|ENVIAR|REVISAR\", \"expectedEstado\": \"...\", \"autorizacion\": \"ORD-PRY-NNN «sí…» AAAA-MM-DD\"}
  APROBAR y ENVIAR exigen autorizacion con el ID de la orden; REVISAR no la lleva. Sin url ni requestId (lo genera el script)."
uso() { echo "$USO" >&2; exit 2; }
falla() { echo "$1" >&2; exit 2; }

[ "${1:-}" != "--help" ] && [ "${1:-}" != "-h" ] || { echo "$USO"; exit 0; }
[ $# -ge 2 ] && [ $# -le 3 ] || uso
orden=$1; archivo=$2; repetir=${3:-}
[ -z "$repetir" ] || [ "$repetir" = "--repetir" ] || uso

# El ID es lo único variable de la ruta: con este formato no cabe otra ruta (ni tareas/, ni /, ni ..).
[[ "$orden" =~ ^ORD-[A-Z]{3}-[0-9]{3}$ ]] || falla "ID de orden no válido: $orden (formato ORD-PRY-NNN)"

[ -f "$archivo" ] || falla "No existe el archivo: $archivo"
enviado="${archivo%.enviado.json}"; enviado="${enviado%.json}.enviado.json"

# Chequeos locales (criterios 2 y 3 de ORD-POS-062); se aplican también al cuerpo que se repite.
validar() {
  jq -r --arg id "$orden" '
    if type != "object" then "El JSON debe ser un objeto"
    elif has("url") then "El cuerpo no debe traer url: ENVIAR con url es del propietario"
    elif (keys - ["accion", "expectedEstado", "autorizacion", "requestId"]) != [] then
      "Campos no permitidos: \(keys - ["accion", "expectedEstado", "autorizacion", "requestId"] | join(", "))"
    elif (.accion | IN("APROBAR", "ENVIAR", "REVISAR") | not) then
      "Acción no permitida: \(.accion) (solo APROBAR, ENVIAR o REVISAR)"
    elif (.expectedEstado | type) != "string" then "Falta expectedEstado"
    elif .accion == "REVISAR" then (if has("autorizacion") then "REVISAR no lleva autorizacion" else empty end)
    elif (.autorizacion | type) != "string" then "\(.accion) exige autorizacion: ORD-PRY-NNN «cita» AAAA-MM-DD"
    elif (.autorizacion | test("^ORD-[A-Z]{3}-[0-9]{3} «[^«»]+» [0-9]{4}-[0-9]{2}-[0-9]{2}$") | not) then
      "autorizacion no válida: formato ORD-PRY-NNN «cita» AAAA-MM-DD"
    elif (.autorizacion | split(" ")[0]) != $id then
      "El ID de la autorizacion (\(.autorizacion | split(" ")[0])) no coincide con el de la ruta (\($id))"
    else empty end' "$1"
}

if [ "$repetir" = "--repetir" ]; then
  [ -f "$enviado" ] || falla "No hay $enviado que repetir"
  cuerpo=$enviado
else
  [ ! -e "$enviado" ] || falla "Ya existe $enviado: usa --repetir para reenviar el mismo cuerpo"
  jq -e 'type == "object" and has("requestId")' "$archivo" > /dev/null && falla "El JSON no debe traer requestId: el script lo genera"
  cuerpo=$archivo
fi
error=$(validar "$cuerpo") || falla "El archivo no es JSON válido: $cuerpo"
[ -z "$error" ] || falla "$error; no se envió"

if [ "$repetir" != "--repetir" ]; then
  requestId=$(python3 -c 'import uuid; print(uuid.uuid4())')
  jq --arg r "$requestId" '. + {requestId: $r}' "$archivo" > "$enviado"
  bytes=$(wc -c < "$enviado")
  # Tope del cuerpo de la API (LIMITS.bodyBytes, 16 KiB).
  [ "$bytes" -le 16384 ] || { rm -f "$enviado"; falla "El cuerpo ocupa $bytes bytes: excede 16 KiB (16384); no se envió"; }
  cuerpo=$enviado
fi

echo "requestId=$(jq -r .requestId "$cuerpo") cuerpo=$cuerpo"
respuesta=$(mktemp); trap 'rm -f "$respuesta"' EXIT
codigo=$(curl -sS --max-time 60 -o "$respuesta" -w '%{http_code}' -X PATCH "$DASHBOARD/api/operaciones/ordenes/$orden" \
  -H 'Content-Type: application/json' --data-binary @"$cuerpo") || { echo "Fallo de transporte: el resultado es incierto" >&2; exit 1; }
echo "HTTP $codigo"; cat "$respuesta"; echo
case "$codigo" in
  2??) ;;
  3??) echo "Error: redirección inesperada (HTTP $codigo)" >&2; exit 1 ;;
  # 409 también llega tras escribir (verificacion-fallida, auditoria-inconsistente, estado-divergente).
  409) echo "HTTP 409: resultado incierto: relee la orden y AUDITORIA antes de repetir; si no cambió, usa --repetir (mismo requestId). Se conserva $enviado" >&2; exit 1 ;;
  4??) rechazado="${enviado%.enviado.json}.rechazado.json"; mv -f "$enviado" "$rechazado"
    echo "Rechazada (HTTP $codigo): no se escribió nada. $enviado pasó a $rechazado; corrige $archivo y reenvíalo (requestId nuevo)" >&2; exit 1 ;;
  *) echo "Error HTTP $codigo: resultado incierto; se conserva $enviado para --repetir" >&2; exit 1 ;;
esac
