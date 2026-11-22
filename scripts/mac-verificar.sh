#!/usr/bin/env bash
# Verificación de solo lectura de los candados de la Mac (ORD-POS-169; DEC-POS-034 y DEC-POS-040 punto 3).
# Uso: bash scripts/mac-verificar.sh [--propietario <usuario>] [--taller <usuario>] [--plantilla <archivo>]
# Imprime OK o FALLA por punto y termina con 0 (todo OK), 1 (alguna FALLA) o 2 (uso). Guía: docs/mac/candados.md.
# Solo lee: no instala, no cierra sesiones y no escribe ningún archivo. Los únicos comandos externos son `id` y `stat`;
# no ejecuta gcloud, gh ni clasp: mira los archivos donde cada uno guarda su sesión.
set -uo pipefail

USO="Uso: bash scripts/mac-verificar.sh [--propietario <usuario>] [--taller <usuario>] [--plantilla <archivo>]
  --propietario  cuenta del propietario (por defecto: \$SUDO_USER o la cuenta que lo ejecuta)
  --taller       cuenta estándar de los agentes (por defecto: taller)
  --plantilla    plantilla a comparar (por defecto: docs/mac/managed-settings.plantilla.json de este repositorio)
Si la carpeta de «taller» no se puede leer desde la cuenta del propietario, ejecútalo con sudo."

propietario=${SUDO_USER:-}
taller=taller
aqui=${BASH_SOURCE[0]%/*}; [ "$aqui" != "${BASH_SOURCE[0]}" ] || aqui=.
plantilla="$aqui/../docs/mac/managed-settings.plantilla.json"
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) echo "$USO"; exit 0 ;;
    --propietario|--taller|--plantilla)
      [ $# -ge 2 ] && [ -n "$2" ] || { echo "$USO" >&2; exit 2; }
      case "$1" in --propietario) propietario=$2 ;; --taller) taller=$2 ;; *) plantilla=$2 ;; esac
      shift 2 ;;
    *) echo "$USO" >&2; exit 2 ;;
  esac
done
[ -n "$propietario" ] || propietario=$(id -un) || { echo "No se pudo saber la cuenta: usa --propietario" >&2; exit 2; }
# El nombre entra en rutas: sin /, sin .. y sin espacios.
for cuenta in "$propietario" "$taller"; do
  [[ "$cuenta" =~ ^[A-Za-z0-9_][A-Za-z0-9._-]*$ ]] || { echo "Cuenta no válida: $cuenta" >&2; exit 2; }
done
[ "$propietario" != "$taller" ] || { echo "El propietario y «$taller» deben ser cuentas distintas" >&2; exit 2; }

# MAC_VERIFICAR_RAIZ existe solo para las pruebas: antepone una carpeta simulada a /Users y /Library.
raiz=${MAC_VERIFICAR_RAIZ:-}
casa_propietario="$raiz/Users/$propietario"
casa_taller="$raiz/Users/$taller"
instalado="$raiz/Library/Application Support/ClaudeCode/managed-settings.json"

fallas=0
ok() { echo "OK    $1"; }
falla() { echo "FALLA $1"; fallas=$((fallas + 1)); }

# ¿Se puede mirar dentro de la carpeta? Sin esto, «no existe» y «no me dejan ver» serían lo mismo.
legible() { [ -d "$1" ] && [ -r "$1" ] && [ -x "$1" ]; }
tiene_entradas() { local e; for e in "$1"/* "$1"/.[!.]*; do [ -e "$e" ] && return 0; done; return 1; }

# Devuelve el motivo si hay sesión de gcloud en esa carpeta de usuario; vacío si no la hay.
# atajo: mira archivos, no credentials.db (SQLite); si gcloud cambia dónde guarda la sesión, revisar aquí.
sesion_gcloud() {
  local dir="$1/.config/gcloud" conf linea
  [ -e "$dir" ] || return 0
  legible "$dir" || { echo "no se puede leer $dir"; return 0; }
  [ ! -e "$dir/application_default_credentials.json" ] || { echo "hay application_default_credentials.json"; return 0; }
  if [ -d "$dir/legacy_credentials" ]; then
    legible "$dir/legacy_credentials" || { echo "no se puede leer legacy_credentials"; return 0; }
    ! tiene_entradas "$dir/legacy_credentials" || { echo "hay cuentas en legacy_credentials"; return 0; }
  fi
  for conf in "$dir"/configurations/config_*; do
    [ -e "$conf" ] || continue
    [ -r "$conf" ] || { echo "no se puede leer $conf"; return 0; }
    while IFS= read -r linea || [ -n "$linea" ]; do
      [[ "$linea" =~ ^[[:space:]]*account[[:space:]]*=[[:space:]]*[^[:space:]] ]] && { echo "cuenta activa en ${conf##*/}"; return 0; }
    done < "$conf"
  done
  return 0
}

# Devuelve el motivo si gh tiene sesión guardada en esa carpeta de usuario (hosts.yml con contenido).
sesion_gh() {
  local dir="$1/.config/gh" linea
  [ -e "$dir" ] || return 0
  legible "$dir" || { echo "no se puede leer $dir"; return 0; }
  [ -e "$dir/hosts.yml" ] || return 0
  [ -r "$dir/hosts.yml" ] || { echo "no se puede leer hosts.yml"; return 0; }
  while IFS= read -r linea || [ -n "$linea" ]; do
    [[ "$linea" =~ ^[[:space:]]*(#.*)?$ ]] || { echo "hosts.yml tiene una sesión"; return 0; }
  done < "$dir/hosts.yml"
  return 0
}

echo "Candados de la Mac · propietario: $propietario · taller: $taller"

# 1. Carpeta del propietario con permisos 700.
if [ ! -d "$casa_propietario" ]; then
  falla "1. Carpeta del propietario: no existe $casa_propietario"
else
  modo=$(stat -f '%Lp' "$casa_propietario" 2>/dev/null) || modo=
  if [[ ! "$modo" =~ ^[0-7]{3,4}$ ]]; then falla "1. Carpeta del propietario: no se pudieron leer los permisos de $casa_propietario"
  elif [ "$modo" = 700 ]; then ok "1. Carpeta del propietario con permisos 700"
  else falla "1. Carpeta del propietario con permisos $modo (se espera 700)"; fi
fi

# 2. Usuario taller: estándar (fuera del grupo admin) y sin sesión de gh ni de gcloud.
if ! grupos=$(id -Gn "$taller" 2>/dev/null); then
  falla "2a. Usuario «$taller»: no existe"
elif [[ " $grupos " == *" admin "* ]]; then
  falla "2a. Usuario «$taller»: es administrador (se espera estándar)"
else
  ok "2a. Usuario «$taller» estándar"
fi
if ! legible "$casa_taller"; then
  falla "2b. «$taller» sin sesión de gh: no se puede leer $casa_taller (ejecuta con sudo)"
  falla "2c. «$taller» sin sesión de gcloud: no se puede leer $casa_taller (ejecuta con sudo)"
else
  motivo=$(sesion_gh "$casa_taller")
  [ -z "$motivo" ] && ok "2b. «$taller» sin sesión de gh" || falla "2b. «$taller» con sesión de gh: $motivo"
  motivo=$(sesion_gcloud "$casa_taller")
  [ -z "$motivo" ] && ok "2c. «$taller» sin sesión de gcloud" || falla "2c. «$taller» con sesión de gcloud: $motivo"
fi

# 3. gcloud del propietario sin sesión activa.
if ! legible "$casa_propietario"; then
  falla "3. gcloud del propietario: no se puede leer $casa_propietario"
else
  motivo=$(sesion_gcloud "$casa_propietario")
  [ -z "$motivo" ] && ok "3. gcloud del propietario sin sesión activa" || falla "3. gcloud del propietario con sesión: $motivo"
fi

# 4. clasp sin sesión abierta: no existe ~/.clasprc.json en ninguna de las dos cuentas.
if ! legible "$casa_propietario" || ! legible "$casa_taller"; then
  falla "4. clasp: no se pueden leer las dos carpetas de usuario (ejecuta con sudo)"
elif [ -e "$casa_propietario/.clasprc.json" ] || [ -L "$casa_propietario/.clasprc.json" ]; then
  falla "4. clasp con sesión abierta: existe $casa_propietario/.clasprc.json"
elif [ -e "$casa_taller/.clasprc.json" ] || [ -L "$casa_taller/.clasprc.json" ]; then
  falla "4. clasp con sesión abierta: existe $casa_taller/.clasprc.json"
else
  ok "4. clasp sin sesión abierta"
fi

# 5. managed-settings instalado e idéntico a la plantilla, byte a byte.
if [ ! -f "$plantilla" ] || [ ! -r "$plantilla" ]; then
  falla "5. managed-settings: no se puede leer la plantilla $plantilla"
elif [ ! -f "$instalado" ]; then
  falla "5. managed-settings: no está instalado en $instalado"
elif [ ! -r "$instalado" ]; then
  falla "5. managed-settings: no se puede leer $instalado"
else
  # read -d '' lee el archivo entero, con sus saltos de línea finales (un JSON no trae bytes nulos).
  IFS= read -r -d '' esperado < "$plantilla" || true
  IFS= read -r -d '' actual < "$instalado" || true
  if [ "$esperado" = "$actual" ]; then ok "5. managed-settings instalado e idéntico a la plantilla"
  else falla "5. managed-settings instalado pero distinto de la plantilla"; fi
fi

if [ "$fallas" -eq 0 ]; then echo "Resultado: todo OK"; exit 0; fi
echo "Resultado: $fallas FALLA(s)"; exit 1
