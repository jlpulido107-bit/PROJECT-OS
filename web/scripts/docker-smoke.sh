#!/usr/bin/env bash
# Smoke test de la imagen Docker del dashboard (local o CI).
# - No usa Google Cloud ni Google Sheets: datos SINTÉTICOS y secretos aleatorios de un solo uso.
# - Comprueba: usuario no root, ausencia de archivos secretos en la imagen, puerto configurable,
#   las 60+ comprobaciones HTTP de autorización contra el contenedor, la simulación de Cloud Run
#   (configuraciones inseguras → /api/health 503) y que los logs no contengan secretos.
#
# Variables opcionales:
#   IMAGE=project-os-web:smoke   imagen a construir/probar
#   SMOKE_BUILD=0                no construir (usar IMAGE existente)
#   NODE_IMAGE=…                 imagen base alternativa (p. ej. mirror.gcr.io/library/node:…@sha256:…)
#   EXTRA_CA_FILE=/ruta/ca.pem   CA de un proxy corporativo, solo para `npm ci` durante el build
#   SMOKE_PORT=18080             puerto local
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="${IMAGE:-project-os-web:smoke}"
PORT="${SMOKE_PORT:-18080}"
ALT_PORT=$((PORT + 1))
SIM_PORT=$((PORT + 2))
BASE="http://127.0.0.1:${PORT}"
NAMES=(project-os-smoke project-os-smoke-port project-os-smoke-cr)

ok() { echo "OK    $*"; }
fail() { echo "FALLA $*" >&2; exit 1; }
cleanup() { docker rm -f "${NAMES[@]}" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

random_secret() { node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"; }

wait_status() { # url esperado
  local url=$1 want=$2 code=000
  for _ in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$url" || true)
    [ "$code" = "$want" ] && return 0
    sleep 0.5
  done
  echo "última respuesta de $url: $code" >&2
  return 1
}

if [ "${SMOKE_BUILD:-1}" = "1" ]; then
  build_args=()
  [ -n "${NODE_IMAGE:-}" ] && build_args+=(--build-arg "NODE_IMAGE=${NODE_IMAGE}")
  [ -n "${EXTRA_CA_FILE:-}" ] && build_args+=(--secret "id=extra_ca,src=${EXTRA_CA_FILE}")
  docker build "${build_args[@]}" -t "$IMAGE" .
fi

# --- 1. Imagen -------------------------------------------------------------------------------
user=$(docker image inspect "$IMAGE" --format '{{.Config.User}}')
[ -n "$user" ] && [ "$user" != "root" ] && [ "$user" != "0" ] || fail "la imagen debe ejecutarse sin root (USER=$user)"
ok "usuario sin privilegios: $user"

found=$(docker run --rm --entrypoint sh "$IMAGE" -c '
  find /app \( -name ".env*" -o -name "*.pem" -o -name "*.key" -o -name "*.p12" -o -name "*ca-bundle*" \) -print 2>/dev/null
  grep -rlE "\"private_key\"|BEGIN [A-Z ]*PRIVATE KEY" /app --include=*.json 2>/dev/null
  for d in tests scripts docs .git; do [ -e "/app/$d" ] && echo "/app/$d"; done
  true')
[ -z "$found" ] || fail "archivos que no deben estar en la imagen: $found"
ok "sin .env, claves, CA de build, pruebas, scripts ni .git en /app"

writable=$(docker run --rm --entrypoint sh "$IMAGE" -c 'touch /app/server.js 2>/dev/null && echo escribible || echo solo-lectura')
[ "$writable" = "solo-lectura" ] || fail "el código de la app no debe ser modificable por el proceso"
ok "código de la aplicación de solo lectura para el proceso"

echo "      tamaño de la imagen: $(docker image inspect "$IMAGE" --format '{{.Size}}' | awk '{printf "%.0f MB", $1/1000000}')"

# --- 2. Arranque con datos sintéticos --------------------------------------------------------
SECRET=$(random_secret)
CLIENT_SECRET="smoke-client-secret-$(random_secret | tr -dc 'a-zA-Z0-9' | head -c 16)"
common_env=(
  -e DASHBOARD_DATA_SOURCE=fixtures
  -e "NEXTAUTH_SECRET=${SECRET}"
  -e AUTH_ALLOWED_EMAILS=revisor@example.com
  -e GOOGLE_CLIENT_ID=smoke-client-id.apps.googleusercontent.com
  -e "GOOGLE_CLIENT_SECRET=${CLIENT_SECRET}"
)
docker run -d --name project-os-smoke -p "127.0.0.1:${PORT}:8080" "${common_env[@]}" \
  -e "NEXTAUTH_URL=${BASE}" "$IMAGE" >/dev/null
wait_status "${BASE}/api/health" 200 || { docker logs project-os-smoke | tail -20; fail "el contenedor no quedó sano"; }
ok "contenedor sano en el puerto 8080 (/api/health 200)"

# Puerto configurable (Cloud Run inyecta PORT).
docker run -d --name project-os-smoke-port -p "127.0.0.1:${ALT_PORT}:9090" "${common_env[@]}" \
  -e PORT=9090 -e "NEXTAUTH_URL=http://127.0.0.1:${ALT_PORT}" "$IMAGE" >/dev/null
wait_status "http://127.0.0.1:${ALT_PORT}/login" 200 || fail "no respeta PORT=9090"
ok "respeta PORT configurable (9090) y sirve /login"

# --- 3. Autorización por HTTP contra el contenedor --------------------------------------------
E2E_BASE_URL="$BASE" E2E_NEXTAUTH_SECRET="$SECRET" node scripts/e2e-auth.mjs
ok "pruebas HTTP de autorización contra el contenedor"

# --- 4. Simulación de Cloud Run (K_SERVICE): configuraciones inseguras no pasan la sonda -----
expect_health() { # descripción código-esperado args-extra…
  local desc=$1 want=$2; shift 2
  docker rm -f project-os-smoke-cr >/dev/null 2>&1 || true
  docker run -d --name project-os-smoke-cr -p "127.0.0.1:${SIM_PORT}:8080" \
    -e K_SERVICE=project-os-dashboard -e "NEXTAUTH_SECRET=${SECRET}" \
    -e AUTH_ALLOWED_EMAILS=revisor@example.com \
    -e GOOGLE_CLIENT_ID=smoke-client-id.apps.googleusercontent.com -e "GOOGLE_CLIENT_SECRET=${CLIENT_SECRET}" \
    -e SHEETS_SPREADSHEET_ID=16UXe7fm90fOTTVJhI_RZ8__I876u2buvjeLGr5cJ-Ic \
    "$@" "$IMAGE" >/dev/null
  wait_status "http://127.0.0.1:${SIM_PORT}/api/health" "$want" || fail "$desc: se esperaba $want"
  ok "Cloud Run simulado — $desc → $want"
}
GOOD_URL=https://project-os-dashboard-000000000000.us-central1.run.app
SA=project-os-dashboard-run@proyecto-ejemplo.iam.gserviceaccount.com
FAKE_KEY_JSON='{"type":"service_account","client_email":"x@y.iam.gserviceaccount.com","private_key":"FALSA"}'
expect_health "configuración ADC correcta" 200 \
  -e "NEXTAUTH_URL=${GOOD_URL}" -e SHEETS_CREDENTIALS=adc -e "SHEETS_EXPECTED_SERVICE_ACCOUNT=${SA}"
expect_health "datos sintéticos" 503 \
  -e "NEXTAUTH_URL=${GOOD_URL}" -e DASHBOARD_DATA_SOURCE=fixtures
expect_health "clave JSON de cuenta de servicio" 503 \
  -e "NEXTAUTH_URL=${GOOD_URL}" -e SHEETS_CREDENTIALS=service-account-key \
  -e "PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_JSON=${FAKE_KEY_JSON}"
expect_health "ADC sin cuenta esperada" 503 \
  -e "NEXTAUTH_URL=${GOOD_URL}" -e SHEETS_CREDENTIALS=adc
expect_health "NEXTAUTH_URL sin HTTPS" 503 \
  -e "NEXTAUTH_URL=http://project-os.example" -e SHEETS_CREDENTIALS=adc -e "SHEETS_EXPECTED_SERVICE_ACCOUNT=${SA}"

# --- 5. Los logs no contienen secretos -------------------------------------------------------
logs=$(docker logs project-os-smoke 2>&1; docker logs project-os-smoke-port 2>&1; docker logs project-os-smoke-cr 2>&1)
for value in "$SECRET" "$CLIENT_SECRET" "FALSA" "revisor@example.com"; do
  if grep -qF -- "$value" <<<"$logs"; then fail "un secreto o correo apareció en los logs"; fi
done
ok "logs del contenedor sin secretos ni correos"

echo "Smoke test de Docker completado."
