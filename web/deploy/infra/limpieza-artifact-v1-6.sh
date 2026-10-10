#!/usr/bin/env bash
# PROJECT-OS V1.6 — Puerta C: política de limpieza del repositorio Docker de Artifact Registry.
# Preparado para revisión; --apply SOLO con autorización expresa del propietario.
# Modos:
#   --plan   (predeterminado) PLAN ESTÁTICO: valida el archivo de la política y explica qué haría. No invoca gcloud.
#   --check  Comprobación REAL de solo lectura (un `describe` del repositorio). Es el BLOQUEO antes del primer build
#            o push: termina con código 0 solo si el repositorio tiene exactamente la política del archivo y la
#            ejecución en seco (dry run) está desactivada. Nunca pide confirmación ni modifica GCP.
#   --apply  --check previo → confirmación AUTORIZO → `set-cleanup-policies` → mismo --check como verificación.
# Documentación: docs/puerta-c-v1-6.md. Pruebas: web/tests/puerta-c.test.ts.
set -Eeuo pipefail
IFS=$'\n\t'

readonly PROJECT_ID='project-os-511102'
readonly REGION='northamerica-south1'
readonly REPO='project-os'
readonly ACK_TEXT='AUTORIZO LIMPIEZA PROJECT-OS'
POLICY_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../cloudrun" && pwd)/artifact-cleanup-policy.json"
readonly POLICY_FILE

# Ayudante en Python. Normaliza la política del archivo (formato de gcloud) y la del repositorio (formato de la API:
# `describe --format=json`) para compararlas sin depender de mayúsculas, del orden ni de cómo se escriben las
# duraciones. La política esperada está fijada aquí: si alguien cambia el archivo, el script se detiene.
PY_HELPER="$(cat <<'PY'
import json, re, sys

EXPECTED = {
    'conservar-3-recientes': {'action': 'KEEP', 'condition': None, 'mostRecentVersions': {'keepCount': 3, 'packageNamePrefixes': []}},
    'borrar-mayores-30-dias': {'action': 'DELETE', 'condition': {'tagState': 'ANY', 'olderThan': 2592000.0}, 'mostRecentVersions': None},
}
UNITS = {'s': 1, 'm': 60, 'h': 3600, 'd': 86400}

def seconds(value):
    m = re.fullmatch(r'\s*([0-9]+(?:\.[0-9]+)?)\s*([smhd])\s*', str(value))
    if not m:
        raise ValueError('duración no reconocida')
    return float(m.group(1)) * UNITS[m.group(2)]

def normalize(policy):
    action = policy.get('action')
    if isinstance(action, dict):
        action = action.get('type')
    condition = policy.get('condition')
    if condition is not None:
        condition = dict(condition)
        for key in ('olderThan', 'newerThan', 'versionAge'):
            if key in condition:
                condition[key] = seconds(condition[key])
        if 'tagState' in condition:
            condition['tagState'] = str(condition['tagState']).upper()
    recent = policy.get('mostRecentVersions')
    if recent is not None:
        recent = {'keepCount': int(recent.get('keepCount', 0)), 'packageNamePrefixes': list(recent.get('packageNamePrefixes') or [])}
    return {'action': str(action or '').upper(), 'condition': condition, 'mostRecentVersions': recent}

def from_file(data):
    if not isinstance(data, list):
        raise ValueError('el archivo debe contener una lista de políticas')
    out = {}
    for p in data:
        if p.get('name') in out:
            raise ValueError('nombre de política repetido')
        out[p.get('name')] = normalize(p)
    return out

def from_repo(data):
    policies = data.get('cleanupPolicies') or {}
    return {name: normalize(p) for name, p in policies.items()}

def differences(found):
    msgs = []
    for name in sorted(set(EXPECTED) - set(found)):
        msgs.append('falta la política ' + name)
    for name in sorted(set(found) - set(EXPECTED)):
        msgs.append('política no prevista: ' + str(name))
    for name in sorted(set(EXPECTED) & set(found)):
        if found[name] != EXPECTED[name]:
            msgs.append('la política ' + name + ' no coincide con la esperada')
    return msgs

mode = sys.argv[1]
try:
    data = json.load(sys.stdin)
    if mode == 'file':          # archivo de la política (stdin) -> idéntico a la esperada
        diffs = differences(from_file(data))
        for d in diffs: print('FALLA  archivo: ' + d)
        sys.exit(0 if not diffs else 1)
    if mode == 'existing':      # describe del repo -> 0 sin políticas, 10 idénticas a las esperadas, 1 otras
        found = from_repo(data)
        sys.exit(0 if not found else (10 if not differences(found) else 1))
    if mode == 'docker':        # describe del repo -> 0 si es de formato DOCKER
        sys.exit(0 if str(data.get('format', '')).upper() == 'DOCKER' else 1)
    if mode == 'repo':          # describe del repo -> verificación completa (bloqueo antes del primer build)
        checks = [
            ('formato DOCKER', str(data.get('format', '')).upper() == 'DOCKER'),
            ('ejecución en seco desactivada (cleanupPolicyDryRun)', data.get('cleanupPolicyDryRun', False) is False),
        ]
        diffs = differences(from_repo(data))
        checks.append(('políticas idénticas a artifact-cleanup-policy.json' + ('' if not diffs else ': ' + '; '.join(diffs)), not diffs))
        for name, ok in checks:
            print(('OK     ' if ok else 'FALLA  ') + name)
        sys.exit(0 if all(ok for _, ok in checks) else 1)
    print('modo desconocido', file=sys.stderr); sys.exit(2)
except (ValueError, TypeError, AttributeError) as error:
    print('FALLA  formato no reconocido: ' + str(error)); sys.exit(1)
PY
)"
readonly PY_HELPER

py() { python3 -c "$PY_HELPER" "$@"; }
die() { echo "ERROR: $*" >&2; exit 1; }
# Enmascara correos de personas (no los de cuentas de servicio) en un flujo de texto.
mask_emails() {
  sed -E 's/@([a-z0-9-]+\.iam\.gserviceaccount\.com)/__CUENTA_SERVICIO__\1/g;
          s/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/***@***/g;
          s/__CUENTA_SERVICIO__/@/g'
}
# Todas las llamadas a gcloud pasan por aquí: los mensajes de error del SDK se muestran sin correos de personas.
gcloud() { command gcloud "$@" 2> >(mask_emails >&2); }

plan() {
  cat <<PLAN
PROJECT-OS / Puerta C — política de limpieza de Artifact Registry — PLAN ESTÁTICO, SIN CAMBIOS
Proyecto: ${PROJECT_ID}   Región: ${REGION}   Repositorio: ${REPO}
Archivo: web/deploy/cloudrun/artifact-cleanup-policy.json
  - conservar-3-recientes (Keep): conserva las 3 versiones más recientes de cada imagen.
  - borrar-mayores-30-dias (Delete): borra versiones con o sin etiqueta de más de 30 días.
  - Si una versión cumple las dos, se CONSERVA: Keep tiene prioridad sobre Delete.

--check (solo lectura): un describe del repositorio. Exige formato DOCKER, exactamente esas dos políticas y la
ejecución en seco desactivada. Si falla, NO se compila ni se sube ninguna imagen.
--apply, solo tras escribir exactamente: ${ACK_TEXT}
  1. Se detiene sin cambios si el repositorio no existe, no es DOCKER o ya tiene OTRAS políticas
     (set-cleanup-policies las reemplazaría).
  2. gcloud artifacts repositories set-cleanup-policies con --policy=<archivo> y --no-dry-run (un único cambio).
  3. Repite --check como verificación posterior.
FUERA DE ALCANCE: builds, pushes, borrado manual de imágenes, IAM, APIs, secretos, OAuth, Cloud Run.
PLAN
}

check_policy_file() {
  [[ -f "$POLICY_FILE" ]] || die "no se encuentra ${POLICY_FILE}."
  command -v python3 >/dev/null || die 'python3 no disponible.'
  py file < "$POLICY_FILE" || die 'el archivo de la política no es el revisado; detenido sin cambios.'
}

describe_repo() {
  gcloud artifacts repositories describe "$REPO" --project="$PROJECT_ID" --location="$REGION" --format=json
}

# Verificación de solo lectura. Imprime OK/FALLA por punto; devuelve 0 solo si todo es correcto.
verify_repo() {
  local repo_json
  repo_json="$(describe_repo)" || { echo 'FALLA  no se pudo leer el repositorio'; return 1; }
  py repo <<< "$repo_json"
}

main() {
  local mode="${1:---plan}"
  if [[ $# -gt 1 || ! "$mode" =~ ^--(plan|check|apply)$ ]]; then
    echo "Uso: bash $0 [--plan|--check|--apply]"
    echo '  --plan   plan estático, sin consultar GCP (predeterminado)'
    echo '  --check  comprobación real de solo lectura; bloqueo antes del primer build o push'
    echo '  --apply  comprobación + confirmación AUTORIZO + aplicar la política (requiere autorización expresa)'
    exit 2
  fi

  plan
  check_policy_file
  if [[ "$mode" == '--plan' ]]; then
    echo; echo 'Modo vista previa: archivo de la política correcto; no se llamó a gcloud.'
    return 0
  fi

  command -v gcloud >/dev/null || die 'gcloud no disponible.'
  if [[ "$mode" == '--check' ]]; then
    echo; echo 'Modo --check: solo lectura.'
    if verify_repo; then
      echo 'PERMITIDO: la política de limpieza está activa. No se modificó nada.'
      return 0
    fi
    die 'BLOQUEADO: no compilar ni subir imágenes hasta que --check pase. No se modificó nada.'
  fi

  local repo_json status=0
  repo_json="$(describe_repo)" || die 'no se pudo leer el repositorio; detenido sin cambios.'
  py existing <<< "$repo_json" || status=$?
  case "$status" in
    0) ;;
    10) if py repo <<< "$repo_json"; then echo 'La política ya está aplicada y activa: nada que hacer.'; return 0; fi
        echo 'Las políticas ya existen pero no están activas: se volverán a aplicar sin dry run.' ;;
    *) die 'el repositorio ya tiene otras políticas de limpieza; set-cleanup-policies las reemplazaría. Detenido sin cambios.' ;;
  esac
  py docker <<< "$repo_json" || die 'el repositorio no es de formato DOCKER; detenido sin cambios.'

  echo 'Cambio previsto: aplicar la política de limpieza (Keep 3 recientes + Delete > 30 días), sin dry run.'
  local ack=''
  read -r -p "Para continuar escribe exactamente: ${ACK_TEXT}: " ack || die 'sin confirmación; cancelado sin cambios.'
  [[ "$ack" == "$ACK_TEXT" ]] || { echo 'Cancelado sin cambios.'; exit 1; }

  gcloud artifacts repositories set-cleanup-policies "$REPO" --project="$PROJECT_ID" --location="$REGION" \
    --policy="$POLICY_FILE" --no-dry-run --format=none \
    || die 'set-cleanup-policies falló. Ejecuta --check: si el repositorio no cambió, no hay nada que revertir (docs/puerta-c-v1-6.md §3, C1).'

  echo; echo 'Verificación posterior (solo lectura):'
  verify_repo || die 'la verificación posterior falló: NO compilar. Revisar a mano (docs/puerta-c-v1-6.md §3, C1).'
  echo 'FINALIZADO: política de limpieza activa y verificada. NO se realizaron builds ni pushes.'
}

# Solo se ejecuta al invocarlo como script; al cargarlo con `source` (pruebas) solo define funciones.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
