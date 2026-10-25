#!/usr/bin/env bash
# Registro del corte por el agente de finanzas (reporte-consumo §4, ORD-POS-093; docs/diseno-finanzas-v3.md §4).
# Uso: bash scripts/agente-finanzas.sh <rendimiento|cargo-extra> <archivo.json> [--repetir]
# El host y la ruta son fijos. El token lo añade el proxy del entorno del agente: aquí no se lee, no se imprime ni se
# envía ninguna cabecera Authorization.
set -euo pipefail

DASHBOARD=https://project-os-dashboard-235975889400.northamerica-south1.run.app
uso() { echo "Uso: bash scripts/agente-finanzas.sh <rendimiento|cargo-extra> <archivo.json> [--repetir]" >&2; exit 2; }

[ $# -ge 2 ] && [ $# -le 3 ] || uso
tipo=$1; archivo=$2; repetir=${3:-}
[ -z "$repetir" ] || [ "$repetir" = "--repetir" ] || uso

# Campos de cada ruta (web/src/lib/finanzas/agente-validacion.ts): obligatorios y opcionales.
case "$tipo" in
  rendimiento) obligatorios='["corte","reporte","costoEquivUsd","sesiones","sesionesSinDato"]'; opcionales='["tokensEntrada","tokensSalida"]' ;;
  cargo-extra) obligatorios='["corte","reporte","facturaTotalUsd","fuente","proyecto"]'; opcionales='["tipoCambio"]' ;;
  *) echo "Tipo no permitido: $tipo (solo rendimiento o cargo-extra)" >&2; exit 2 ;;
esac

[ -f "$archivo" ] || { echo "No existe el archivo: $archivo" >&2; exit 2; }
enviado="${archivo%.enviado.json}"; enviado="${enviado%.json}.enviado.json"

if [ "$repetir" = "--repetir" ]; then
  [ -f "$enviado" ] || { echo "No hay $enviado que repetir" >&2; exit 2; }
else
  [ ! -e "$enviado" ] || { echo "Ya existe $enviado: usa --repetir para reenviar el mismo cuerpo" >&2; exit 2; }
  if jq -e 'has("requestId")' "$archivo" > /dev/null; then
    echo "El JSON no debe traer requestId: el script lo genera" >&2; exit 2
  fi
  # Nunca estima: sin un campo obligatorio no se envía. Lo demás lo vuelve a validar el servidor.
  errores=$(jq -r --argjson o "$obligatorios" --argjson p "$opcionales" '. as $b
    | def txt($k): ($b[$k] // "" | tostring);
      def monto($k): txt($k) | test("^[0-9]{1,10}(\\.[0-9]{1,2})?$");
      ($o[] | select(txt(.) == "") | "Falta \(.)"),
      (keys[] | select(IN($o[], $p[]) | not) | "Campo no permitido: \(.)"),
      (select(txt("corte") != "" and (txt("corte") | test("^[0-9]{4}-(0[1-9]|1[0-2])-Q[12]$") | not)) | "corte: AAAA-MM-Q1 o AAAA-MM-Q2"),
      (select(txt("reporte") != "" and (txt("reporte") | test("^session_[A-Za-z0-9]{10,40}$") | not)) | "reporte: ID de la sesión de reporte-consumo (session_…)"),
      (select(has("costoEquivUsd") and (monto("costoEquivUsd") | not)) | "costoEquivUsd: número ≥ 0, hasta 2 decimales"),
      (select(has("costoEquivUsd") and monto("costoEquivUsd") and (txt("costoEquivUsd") | tonumber) > 3000) | "costoEquivUsd excede el tope de 3,000 USD: no se envía"),
      (select(has("facturaTotalUsd") and (monto("facturaTotalUsd") | not)) | "facturaTotalUsd: número ≥ 0, hasta 2 decimales, el total que dio el propietario"),
      (select(has("fuente") and ((txt("fuente") | length) > 200
          or (txt("fuente") | startswith(txt("corte") + " «") | not)
          or (txt("fuente") | test("^[^«»]+ «[^«»]+» [0-9]{4}-[0-9]{2}-[0-9]{2}$") | not)))
        | "fuente: <corte> «<cita literal del propietario>» AAAA-MM-DD, con el corte del cuerpo, hasta 200 caracteres"),
      (select(has("proyecto") and (txt("proyecto") | IN("POS", "ECO") | not)) | "proyecto: POS o ECO, el que dio el propietario")' "$archivo")
  [ -z "$errores" ] || { echo "$errores" >&2; exit 2; }
  requestId=$(python3 -c 'import uuid; print(uuid.uuid4())')
  jq --arg r "$requestId" '. + {requestId: $r}' "$archivo" > "$enviado"
  bytes=$(wc -c < "$enviado")
  # Tope del cuerpo de la API (LIMITS.bodyBytes, 16 KiB).
  [ "$bytes" -le 16384 ] || { rm -f "$enviado"; echo "El cuerpo ocupa $bytes bytes: excede 16 KiB (16384); no se envió" >&2; exit 2; }
fi

echo "requestId=$(jq -r .requestId "$enviado") cuerpo=$enviado"
respuesta=$(mktemp); trap 'rm -f "$respuesta"' EXIT
codigo=$(curl -sS --max-time 60 -o "$respuesta" -w '%{http_code}' -X POST "$DASHBOARD/api/finanzas/agente/$tipo" \
  -H 'Content-Type: application/json' --data-binary @"$enviado") || { echo "Fallo de transporte: el resultado es incierto; usa --repetir (mismo requestId)" >&2; exit 1; }
echo "HTTP $codigo"; cat "$respuesta"; echo
error=$(jq -r '.error.codigo // empty' "$respuesta" 2>/dev/null || true)
rechazar() { rechazado="${enviado%.enviado.json}.rechazado.json"; mv -f "$enviado" "$rechazado"
  echo "$1 No se escribió nada. $enviado pasó a $rechazado; corrige $archivo y reenvíalo (requestId nuevo)" >&2; exit 1; }
case "$codigo" in
  2??) ;;
  3??) echo "Error: redirección inesperada (HTTP $codigo)" >&2; exit 1 ;;
  401|403) echo "Ruta inactiva o sin autorización (HTTP $codigo, ${error:-sin código}): no se escribió nada. No reintentes; avisa al propietario. Se conserva $enviado" >&2; exit 1 ;;
  409) case "$error" in
      corte-ya-registrado) echo "El corte ya está registrado con otro requestId: no se escribió nada. No lo repitas. Se conserva $enviado" >&2 ;;
      suscripcion-sin-confirmar) echo "Suscripción sin confirmar: el propietario confirma REC-CLAUDE del mes y luego usa --repetir (mismo requestId). Se conserva $enviado" >&2 ;;
      factura-no-cuadra) rechazar "El total no cuadra con la suscripción (HTTP 409 factura-no-cuadra): pide al propietario el total correcto." ;;
      # verificacion-fallida, auditoria-inconsistente, estado-divergente y conflicto-*: pueden llegar tras escribir.
      *) echo "HTTP 409 ${error:-sin código}: resultado incierto; no cambies el cuerpo: usa --repetir (mismo requestId). Se conserva $enviado" >&2 ;;
    esac; exit 1 ;;
  429) echo "Demasiadas solicitudes: espera un minuto y usa --repetir (mismo requestId). Se conserva $enviado" >&2; exit 1 ;;
  4??) rechazar "Rechazada (HTTP $codigo, ${error:-sin código})." ;;
  *) echo "Error HTTP $codigo: se conserva $enviado para --repetir" >&2; exit 1 ;;
esac
