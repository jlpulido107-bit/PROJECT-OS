#!/usr/bin/env bash
# PROJECT-OS V1.6 — Remediación de los hallazgos de la auditoría en Cloud Shell (2026-10-11).
# Hallazgos:
#   - E1: coincidencias de «@» y «code=» en los logs del servicio;
#   - A6: una versión de secreto ENABLED que la revisión no usa;
#   - A7 / D-1: maxScale de servicio 3 frente a revisión 1.
# Esas correcciones YA se ejecutaron (docs/operacion-v1-6/remediacion-2026-10-11.md §5): no repetirlas. Lo que sigue
# siendo útil sin cambiar nada es el modo `diagnostico`.
#
# Modos (uno por invocación):
#   diagnostico                 (predeterminado) SOLO LECTURA. Clasifica E1 y E2 por origen (E2 incluye las líneas
#                               [project-os] de cualquier severidad), muestra el estado de la
#                               exclusión del callback OAuth, las versiones de los secretos y los límites de escala.
#                               Imprime solo conteos, nombres de log, códigos y números de versión: nunca contenido de
#                               logs, correos ni valores de secretos. Una lectura fallida se muestra como
#                               LECTURA_FALLIDA (nunca como 0) y el código de salida es 3 (incompleto).
#   deshabilitar-sobrantes      Mutación: deshabilita las versiones ENABLED que la revisión NO tiene fijadas.
#   destruir-version S N        Mutación IRREVERSIBLE: destruye SOLO la versión N del secreto S, si sigue DISABLED y no
#                               es la fijada. Nunca barre todas las DISABLED. Solo tras comprobar el login real.
#   alinear-max-servicio        Mutación: fija el máximo de instancias del SERVICIO en 1 (--max=1). Según la ayuda de
#                               gcloud, no despliega una revisión nueva; el script lo verifica.
#   excluir-callback-en-logs    Mutación: añade SOLO al sink _Default una exclusión para las peticiones al callback OAuth,
#                               cuya URL incluye el parámetro code. No borra registros existentes, que caducan a los
#                               30 días.
#
# Salvaguardas de las mutaciones de secretos (fallan CERRADO; revisiones R1 y R2 de ChatGPT, PR #24, y Misión 014):
#   1. El servicio sirve el 100 % del tráfico desde UNA revisión, la última lista; si no, otras revisiones podrían usar
#      versiones que el script no ve, y se detiene.
#   2. Se cuentan TODAS las referencias secreto/versión de esa revisión (variables de cada contenedor y volúmenes).
#   3. Tras la frase y antes de CADA mutación se relee el servicio (generación, revisión, tráfico y referencias) y el
#      estado de la versión; si algo cambió, se aborta lo que quede del plan.
#   4. La mutación lleva el etag de la versión recién leída (--etag): la API la rechaza si cambió entre esa lectura y
#      la llamada.
#   5. Destruir exige además que la cuenta del servicio sea el ÚNICO lector directo del secreto.
#   6. Después de cada mutación se relee el estado; si no es el esperado: NO_VERIFICADO.
#   Supuesto que el script no puede comprobar: ningún otro servicio o job que corra con la MISMA cuenta usa esas
#   versiones (los 3 secretos son exclusivos de project-os-dashboard).
# Cada mutación muestra antes lo que hará y exige escribir una frase exacta. Ejecutar en bash (Cloud Shell).
# Documentación: docs/operacion-v1-6/remediacion-2026-10-11.md.
set -Eeuo pipefail
IFS=$'\n\t'

readonly PROJECT_ID='project-os-511102'
readonly REGION='northamerica-south1'
readonly SERVICE='project-os-dashboard'
readonly SECRETS=(project-os-nextauth-secret project-os-google-client-secret project-os-allowed-emails)
readonly EXCLUSION='project-os-callback-oauth'
readonly SVC_FILTER="resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${SERVICE}\""
# Sin «=» ni «,»: va dentro de --add-exclusion=clave=valor,…
readonly EXCLUSION_FILTER="logName:\"run.googleapis.com%2Frequests\" AND resource.labels.service_name:\"${SERVICE}\" AND httpRequest.requestUrl:\"/api/auth/callback/google\""
# Patrones de E1 (los mismos 4 del plan de inspección): solo se cuentan, por origen.
readonly PATRONES_E1=('@' 'ya29.' 'Bearer ' 'code=')

PY_HELPER="$(cat <<'PY'
import json, re, sys, urllib.parse
from collections import Counter
mode = sys.argv[1]
# Vocabulario CERRADO: solo se imprimen nombres de log, categorías de la app y rutas de listas fijas; cualquier otra cosa
# se sustituye por un marcador. Nunca se imprime texto libre de un log (revisión R1 de ChatGPT, PR #24).
LOGS = {
    'cloudaudit.googleapis.com/activity': 'auditoría de Google (esperado: registra quién cambia el servicio)',
    'cloudaudit.googleapis.com/system_event': 'auditoría de Google (esperado: registra quién cambia el servicio)',
    'cloudaudit.googleapis.com/data_access': 'auditoría de Google (esperado: registra quién cambia el servicio)',
    'run.googleapis.com/requests': 'peticiones HTTP (plataforma: URL completa)',
    'run.googleapis.com/stdout': 'SALIDA DE LA APP: investigar en el código',
    'run.googleapis.com/stderr': 'SALIDA DE LA APP: investigar en el código',
    'run.googleapis.com/varlog/system': 'sistema de Cloud Run',
}
APP = ('Configuración incompleta o insegura', 'Configuración inválida', 'operación rechazada',
       'error inesperado en operación', 'Error inesperado al leer datos')
RUTAS = {'/', '/login', '/robots.txt', '/favicon.ico', '/api/health', '/proyectos', '/tareas', '/actividad', '/capacidad',
         '/planificacion', '/control', '/operaciones', '/tareas/nueva', '/tiempos/nuevo', '/decisiones/nueva',
         '/api/resumen', '/api/planificacion', '/api/control', '/api/operaciones/tareas', '/api/operaciones/tiempos',
         '/api/operaciones/decisiones', '/api/auth/session', '/api/auth/csrf', '/api/auth/providers', '/api/auth/signin',
         '/api/auth/signout', '/api/auth/error', '/api/auth/signin/google', '/api/auth/callback/google', '/api/auth/_log'}
PLANTILLAS = ((r'/proyectos/[^/]+', '/proyectos/[id]'), (r'/tareas/[^/]+/editar', '/tareas/[id]/editar'),
              (r'/api/operaciones/tareas/[^/]+', '/api/operaciones/tareas/[id]'), (r'/_next/static/.+', '/_next/static/…'))
SEVERIDADES = {'DEFAULT', 'DEBUG', 'INFO', 'NOTICE', 'WARNING', 'ERROR', 'CRITICAL', 'ALERT', 'EMERGENCY'}
ESTADOS_VERSION = {'ENABLED', 'DISABLED', 'DESTROYED'}

def log_name(raw):
    name = urllib.parse.unquote(str(raw or '').split('/logs/')[-1])
    return name if name in LOGS else '[log-omitido]'

def ruta_segura(url):
    ruta = urllib.parse.urlparse(str(url or '')).path or '/'
    if ruta in RUTAS: return ruta
    for patron, plantilla in PLANTILLAS:
        if re.fullmatch(patron, ruta): return plantilla
    return '[ruta-omitida]'

def referencias(svc):        # TODAS las referencias secreto/versión: env de cada contenedor y volúmenes de secretos
    refs, spec = set(), svc['spec']['template']['spec']
    for c in spec.get('containers') or []:
        for e in c.get('env') or []:
            ref = (e.get('valueFrom') or {}).get('secretKeyRef')
            if ref: refs.add((str(ref.get('name', '?')), str(ref.get('key', 'latest'))))
    for v in spec.get('volumes') or []:
        sec = v.get('secret')
        if sec:
            for it in sec.get('items') or [{'key': 'latest'}]:
                refs.add((str(sec.get('secretName', '?')), str(it.get('key', 'latest'))))
    return sorted(refs)

def trafico(svc):
    return ';'.join(f"{x.get('revisionName', 'latest')}={x.get('percent', 0)}" for x in svc.get('status', {}).get('traffic', []))

def servida(svc):            # UNICA solo si TODO el tráfico (también el etiquetado) va a la última revisión lista
    st = svc.get('status') or {}
    lista, creada = st.get('latestReadyRevisionName'), st.get('latestCreatedRevisionName')
    entradas = st.get('traffic') or []
    if not lista: return 'SIN_REVISION_LISTA'
    if creada != lista: return 'ULTIMA_REVISION_NO_LISTA'
    revisiones = {x.get('revisionName') or (lista if x.get('latestRevision') else '?') for x in entradas}
    if revisiones != {lista}: return 'TRAFICO_EN_VARIAS_REVISIONES'
    if sum(x.get('percent') or 0 for x in entradas) != 100: return 'TRAFICO_INCOMPLETO'
    return 'UNICA'

def codigo_app(txt):
    for categoria in APP:
        if txt.startswith(f'[project-os] {categoria}'): return f'[project-os] {categoria}'
    return '[project-os] (categoría no reconocida; no se muestra)'

def ejecutar():
    if mode == 'lognames':          # una línea por entrada: logName → conteo por origen clasificado
        c = Counter()
        for line in sys.stdin:
            if not line.strip(): continue
            name = log_name(line.strip())
            c[(name, LOGS.get(name, 'otro'))] += 1
        for (name, tipo), n in sorted(c.items()): print(f'  {n:>5}  {name}  [{tipo}]')
        if not c: print('      0  (sin coincidencias)')
    elif mode == 'codigos':         # JSON de entradas → conteo por severidad, log, categoría/ruta y día; nunca el texto
        c = Counter()
        for e in json.load(sys.stdin):
            name = log_name(e.get('logName'))
            sev = e.get('severity') if e.get('severity') in SEVERIDADES else '?'
            dia = str(e.get('timestamp', ''))[:10]
            dia = dia if re.fullmatch(r'\d{4}-\d{2}-\d{2}', dia) else '?'
            txt = e.get('textPayload')
            if isinstance(txt, str) and txt.startswith('[project-os]'):
                codigo = codigo_app(txt)
            elif isinstance(txt, str) and (m := re.match(r'\[next-auth\]\[(warn|error|debug)\]\[[A-Z_]{1,40}\]', txt)):
                codigo = m.group(0)
            elif name == 'run.googleapis.com/requests':
                hr = e.get('httpRequest') or {}
                st = hr.get('status')
                st = st if isinstance(st, int) and 100 <= st <= 599 else '?'
                codigo = f'petición HTTP {st} {ruta_segura(hr.get("requestUrl"))}'
            else:
                codigo = '(otro; no se muestra)'
            c[(sev, name, codigo, dia)] += 1
        for (sev, name, codigo, dia), n in sorted(c.items(), key=lambda kv: tuple(map(str, kv[0]))):
            print(f'  {n:>5}  {sev:<8} {name}  {codigo} ({dia})')
        if not c: print('      0  (sin avisos)')
    elif mode == 'fijadas':         # JSON del servicio → «secreto versión» por cada referencia (contenedores y volúmenes)
        for n, k in referencias(json.load(sys.stdin)): print(n, k)
    elif mode == 'huella':          # JSON del servicio → lo que debe seguir igual entre el plan y cada mutación
        svc = json.load(sys.stdin)
        st = svc.get('status') or {}
        print('generacion', (svc.get('metadata') or {}).get('generation', '?'))
        print('revision_activa', st.get('latestReadyRevisionName', '?'))
        print('revision_creada', st.get('latestCreatedRevisionName', '?'))
        print('trafico', trafico(svc))
        for n, k in referencias(svc): print('ref', n, k)
    elif mode == 'servida':         # JSON del servicio → UNICA | motivo por el que no se pueden ver todas las referencias
        print(servida(json.load(sys.stdin)))
    elif mode == 'cuenta':          # JSON del servicio → cuenta de servicio de la revisión (vacío si no tiene el formato)
        cuenta = str(json.load(sys.stdin)['spec']['template']['spec'].get('serviceAccountName') or '')
        ok = re.fullmatch(r'[a-z][a-z0-9-]{4,29}@[a-z][a-z0-9-]{4,29}\.iam\.gserviceaccount\.com', cuenta)
        print(cuenta if ok else '')
    elif mode == 'lector_unico':    # política IAM del secreto + miembro esperado → SI | NO (una sola fila, sin condiciones)
        b = json.load(sys.stdin).get('bindings') or []
        ok = (len(b) == 1 and b[0].get('role') == 'roles/secretmanager.secretAccessor'
              and b[0].get('members') == [sys.argv[2]] and 'condition' not in b[0])
        print('SI' if ok else 'NO')
    elif mode == 'escala':          # JSON del servicio → límites, revisión activa y si el tráfico es de una sola revisión
        svc = json.load(sys.stdin)
        print('servicio_maxScale', svc['metadata'].get('annotations', {}).get('run.googleapis.com/maxScale', 'ninguno'))
        t = svc['spec']['template']['metadata'].get('annotations', {})
        print('revision_maxScale', t.get('autoscaling.knative.dev/maxScale', 'ninguno'))
        print('revision_minScale', t.get('autoscaling.knative.dev/minScale', 'ninguno'))
        print('revision_activa', svc.get('status', {}).get('latestReadyRevisionName', '?'))
        print('trafico', trafico(svc))
        print('trafico_unico', 'SI' if servida(svc) == 'UNICA' else f'NO ({servida(svc)})')
    elif mode == 'versiones':       # «secrets versions list» en JSON → «N ESTADO ETAG PROGRAMADA» por versión
        for v in json.load(sys.stdin) or []:
            m = re.search(r'/versions/(\d+)$', str(v.get('name', '')))
            estado = v.get('state') if v.get('state') in ESTADOS_VERSION else '?'
            etag = str(v.get('etag') or '')
            etag = etag if re.fullmatch(r'[A-Za-z0-9"_.:/+=-]{1,128}', etag) else '?'
            print(m.group(1) if m else '?', estado, etag, 'programada' if v.get('scheduledDestroyTime') else '-')
    elif mode == 'exclusion':       # JSON del sink + nombre + filtro esperado → AUSENTE | CORRECTA | DISTINTA | DESHABILITADA
        nombre, esperado = sys.argv[2], ' '.join(sys.argv[3].split())
        ex = [x for x in (json.load(sys.stdin).get('exclusions') or []) if x.get('name') == nombre]
        if not ex: print('AUSENTE')
        elif ' '.join(str(ex[0].get('filter', '')).split()) != esperado: print('DISTINTA')
        elif ex[0].get('disabled') is True: print('DESHABILITADA')
        else: print('CORRECTA')
    else:
        print('modo desconocido', file=sys.stderr); sys.exit(2)

try:
    ejecutar()
except Exception:
    # Entrada vacía, JSON inválido o con otra forma: falla sin traza, para no reproducir nada de lo leído.
    print(f'ENTRADA_ILEGIBLE ({mode})', file=sys.stderr)
    sys.exit(1)
PY
)"
readonly PY_HELPER

py() { python3 -c "$PY_HELPER" "$@"; }
die() { echo "ERROR: $*" >&2; exit 1; }
mask_emails() {
  sed -E 's/@([a-z0-9-]+\.iam\.gserviceaccount\.com)/__CS__\1/g; s/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/***@***/g; s/__CS__/@/g'
}
# Toda llamada a gcloud: errores del SDK sin correos de personas.
gcloud() { command gcloud "$@" 2> >(mask_emails >&2); }

describe_service() { gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" --format=json; }

# Versiones de un secreto como «N ESTADO ETAG PROGRAMADA». Se lee el JSON y se extrae el número final de la ruta en
# Python: no depende de transformaciones de --format (en Cloud Shell, value(name.basename(),state) dejó la lista vacía).
versions_of() { gcloud secrets versions list "$1" --project="$PROJECT_ID" --format=json | py versiones; }

pinned_of() {   # $1 = salida de «fijadas», $2 = secreto → versiones referenciadas separadas por comas (vacío si no hay)
  awk -v s="$2" '$1 == s { printf "%s%s", sep, $2; sep = "," }' <<< "$1"
}
numeric_list() { [[ "$1" =~ ^[1-9][0-9]*(,[1-9][0-9]*)*$ ]]; }
in_list() { [[ ",$2," == *",$1,"* ]]; }   # $1 está en la lista separada por comas $2
# Versiones ENABLED de la lista $1 (salida de versions_of) que NO están en la lista de referencias $2.
no_referenciadas() { awk -v f="$2" 'BEGIN { split(f, a, ","); for (i in a) r[a[i]] = 1 } $2 == "ENABLED" && !($1 in r) { print $1 }' <<< "$1"; }
estado_de() { awk -v n="$2" '$1 == n { print $2 }' <<< "$1"; }   # estado de la versión $2 en la salida $1
etag_de() { awk -v n="$2" '$1 == n { print $3 }' <<< "$1"; }     # etag de la versión $2 («?» si no es legible)
programada_de() { awk -v n="$2" '$1 == n { print $4 }' <<< "$1"; }
estados_de() { awk '{ printf "%s%s:%s%s", sep, $1, $2, ($4 == "programada" ? "-programada" : ""); sep = " " }' <<< "$1"; }

# Salvaguarda 1: sin tráfico al 100 % en la última revisión lista, el script no ve las referencias de las demás.
servicio_comprobable() {   # $1 = JSON del servicio
  local r
  r="$(py servida <<< "$1")" || die 'no se pudo interpretar el servicio; detenido sin cambios.'
  [[ "$r" == 'UNICA' ]] || die "el servicio no sirve todo el tráfico desde una única revisión lista (${r}): otras revisiones podrían usar versiones que el script no ve. Detenido sin cambios."
}

# Salvaguarda 3 (revisión R2-1): revisión activa, tráfico, generación y todas las referencias a secretos deben seguir
# como en el plan; si no, se aborta lo que quede.
revalidar_servicio() {   # $1 = huella del plan
  local ahora
  ahora="$(describe_service | py huella)" || die 'no se pudo releer el servicio tras la confirmación; abortado lo que quedaba.'
  [[ "$ahora" == "$1" ]] || die 'el servicio cambió (revisión, tráfico o referencias a secretos) desde el plan; abortado lo que quedaba. Vuelve a ejecutar el modo para recalcular el plan.'
}

# Salvaguarda 5: la cuenta del servicio es el único lector directo del secreto (A6). 0 si lo es.
lector_unico() {   # $1 = secreto, $2 = cuenta del servicio
  local r
  r="$(gcloud secrets get-iam-policy "$1" --project="$PROJECT_ID" --format=json | py lector_unico "serviceAccount:$2")" \
    || die "no se pudo leer la política IAM de $1; detenido sin cambios."
  [[ "$r" == 'SI' ]]
}

confirm() {     # $1 = frase exacta
  local ack=''
  read -r -p "Para continuar escribe exactamente: $1: " ack || die 'sin confirmación; cancelado sin cambios.'
  # Se ignoran los espacios al principio y al final (p. ej. al pegar); el texto en sí debe ser idéntico.
  ack="${ack#"${ack%%[![:space:]]*}"}"; ack="${ack%"${ack##*[![:space:]]}"}"
  [[ "$ack" == "$1" ]] || { echo "Cancelado sin cambios: la frase no coincide (se esperaba «$1»)."; exit 1; }
}

# ---- Diagnóstico (solo lectura) ----
FALLIDAS=0
# Ejecuta una lectura y SOLO muestra su salida si terminó bien: una lectura fallida nunca deja un «0» a la vista.
leer() {
  local salida
  if salida="$("$@")"; then
    printf '%s\n' "$salida"
  else
    echo '  LECTURA_FALLIDA (no es un 0: repetir la lectura)'
    FALLIDAS=$((FALLIDAS + 1))
  fi
}
coincidencias_por_log() {   # $1 = patrón
  gcloud logging read "${SVC_FILTER} AND \"$1\"" --project="$PROJECT_ID" --freshness=30d --limit=100000 --format='value(logName)' | py lognames
}
# Avisos de la plataforma (severity>=WARNING) Y líneas de la app de CUALQUIER severidad: el texto sin estructura que la
# app escribe con console.warn/error puede no llevar nivel de log, y un filtro solo por severidad no lo vería (E2).
avisos_por_codigo() {
  gcloud logging read "${SVC_FILTER} AND (severity>=WARNING OR textPayload:\"[project-os]\")" --project="$PROJECT_ID" --freshness=30d --limit=10000 --format=json | py codigos
}
sink_exclusion() {   # estado de la exclusión en el sink _Default: AUSENTE | CORRECTA | DISTINTA | DESHABILITADA
  gcloud logging sinks describe _Default --project="$PROJECT_ID" --format=json | py exclusion "$EXCLUSION" "$EXCLUSION_FILTER"
}
estado_exclusion() {
  local e
  e="$(sink_exclusion)" || return 1
  if [[ "$e" == 'CORRECTA' ]]; then echo "  estado: CORRECTA (nombre, filtro esperado y activa)"
  else echo "  estado: ${e} → NO_VERIFICADO: revisar en la consola (no se corrige automáticamente)"; fi
}
escala_de() { py escala <<< "$1" | sed 's/^/  /'; }

diagnostico() {
  local p svc fijadas s v fij enabled sobrantes
  echo "== E1: coincidencias por ORIGEN (30 días; solo nombres de log y conteos) =="
  for p in "${PATRONES_E1[@]}"; do
    echo "Patrón «${p}»:"
    leer coincidencias_por_log "$p"
  done
  echo "Exclusión «${EXCLUSION}» del callback OAuth (solo el sink _Default; no cubre otros sinks ni registros ya guardados):"
  leer estado_exclusion
  echo
  echo "== E2: avisos (severity>=WARNING) y líneas [project-os] de cualquier severidad, 30 días, por severidad, log y CÓDIGO (nunca el texto) =="
  leer avisos_por_codigo
  echo
  if svc="$(describe_service)" && fijadas="$(py fijadas <<< "$svc")"; then
    echo "== A6: versiones de los secretos (número y estado; nunca el valor) =="
    for s in "${SECRETS[@]}"; do
      if ! v="$(versions_of "$s")"; then echo "  $s: LECTURA_FALLIDA"; FALLIDAS=$((FALLIDAS + 1)); continue; fi
      if grep -q '^?' <<< "$v"; then
        echo "  $s: VERSIONES_ILEGIBLES (no se reconoce el número de versión)"; FALLIDAS=$((FALLIDAS + 1)); continue
      fi
      fij="$(pinned_of "$fijadas" "$s")"
      enabled="$(awk '$2 == "ENABLED" { printf "%s ", $1 }' <<< "$v")"
      sobrantes="$(no_referenciadas "$v" "$fij" | tr '\n' ' ')"
      echo "  $s: fijada=${fij:-?}; ENABLED=[${enabled% }]; ENABLED_no_fijadas=[${sobrantes% }]; estados=[$(estados_de "$v")]"
    done
    echo
    echo "== A7: límites de escala =="
    leer escala_de "$svc"
  else
    echo '== A6 y A7: LECTURA_FALLIDA (no se pudo leer el servicio) =='
    FALLIDAS=$((FALLIDAS + 1))
  fi
  echo
  if (( FALLIDAS > 0 )); then
    echo "Diagnóstico INCOMPLETO: ${FALLIDAS} lectura(s) fallaron → NO_VERIFICADO (una lectura fallida nunca es un 0). No se modificó nada."
    exit 3
  fi
  echo 'Diagnóstico de solo lectura: no se modificó nada. Comparte solo estas líneas, sin salidas crudas de gcloud.'
}

# ---- Mutaciones ----
deshabilitar_sobrantes() {
  local svc fijadas huella s v fij f n etag plan=()
  svc="$(describe_service)" || die 'no se pudo leer el servicio.'
  servicio_comprobable "$svc"
  fijadas="$(py fijadas <<< "$svc")" || die 'no se pudieron leer las referencias del servicio; detenido sin cambios.'
  huella="$(py huella <<< "$svc")" || die 'no se pudo leer el servicio; detenido sin cambios.'
  for s in "${SECRETS[@]}"; do
    v="$(versions_of "$s")" || die "no se pudieron leer las versiones de $s."
    ! grep -q '^?' <<< "$v" || die "$s: versiones ilegibles; detenido sin cambios."
    fij="$(pinned_of "$fijadas" "$s")"
    numeric_list "$fij" || die "$s: la revisión no fija versiones numéricas (${fij:-ninguna}); detenido sin cambios."
    for f in ${fij//,/$'\n'}; do
      [[ "$(estado_de "$v" "$f")" == 'ENABLED' ]] || die "$s: la versión fijada $f no está ENABLED; detenido sin cambios (el servicio la necesita)."
    done
    while read -r n; do [[ -n "$n" ]] && plan+=("$s $n"); done < <(no_referenciadas "$v" "$fij")
  done
  if [[ ${#plan[@]} -eq 0 ]]; then echo 'No hay versiones ENABLED sin usar: nada que hacer.'; return 0; fi
  echo 'Se DESHABILITARÁN (la revisión no las usa; se pueden volver a habilitar con «versions enable»):'
  printf '  %s\n' "${plan[@]}"
  confirm 'AUTORIZO DESHABILITAR VERSIONES'
  local item
  for item in "${plan[@]}"; do
    s="${item% *}"; n="${item#* }"
    revalidar_servicio "$huella"
    v="$(versions_of "$s")" || die "no se pudieron releer las versiones de $s; abortado lo que quedaba."
    [[ "$(estado_de "$v" "$n")" == 'ENABLED' ]] || die "$s versión $n ya no está ENABLED; abortado lo que quedaba."
    etag="$(etag_de "$v" "$n")"
    [[ -n "$etag" && "$etag" != '?' ]] || die "$s versión $n sin etag legible: no se puede deshabilitar de forma condicional; abortado lo que quedaba."
    gcloud secrets versions disable "$n" --secret="$s" --etag="$etag" --project="$PROJECT_ID" --format=none \
      || die "la API rechazó deshabilitar $s versión $n (¿cambió desde la última lectura?); abortado lo que quedaba."
    v="$(versions_of "$s")" || die "no se pudo verificar $s versión $n tras deshabilitarla: NO_VERIFICADO; revisar en la consola."
    [[ "$(estado_de "$v" "$n")" == 'DISABLED' ]] || die "$s versión $n no quedó DISABLED: NO_VERIFICADO; revisar en la consola."
    echo "  deshabilitada (verificado): $s versión $n"
  done
  echo
  echo 'Verifica AHORA el login real en el navegador y npm run smoke:remote. Si todo funciona, destruye cada una así:'
  for item in "${plan[@]}"; do echo "  bash web/deploy/infra/remediacion-v1-6.sh destruir-version ${item% *} ${item#* }"; done
}

# Destruye UNA versión concreta, indicada por argumentos (revisión R1-2): nunca barre todas las DISABLED, que pueden ser
# históricas o de recuperación. Comprueba justo antes que el par sigue DISABLED y no está referenciado.
destruir_version() {
  local s="$1" n="$2" svc fijadas huella cuenta v fij estado etag
  in_secrets "$s" || die "secreto no reconocido: $s; detenido sin cambios."
  [[ "$n" =~ ^[1-9][0-9]*$ ]] || die "versión no numérica: $n; detenido sin cambios."
  svc="$(describe_service)" || die 'no se pudo leer el servicio.'
  servicio_comprobable "$svc"
  fijadas="$(py fijadas <<< "$svc")" || die 'no se pudieron leer las referencias del servicio; detenido sin cambios.'
  huella="$(py huella <<< "$svc")" || die 'no se pudo leer el servicio; detenido sin cambios.'
  cuenta="$(py cuenta <<< "$svc")" || die 'no se pudo leer la cuenta del servicio; detenido sin cambios.'
  [[ -n "$cuenta" ]] || die 'la revisión no declara una cuenta de servicio reconocible; detenido sin cambios.'
  fij="$(pinned_of "$fijadas" "$s")"
  numeric_list "$fij" || die "$s: sin versiones fijadas numéricas; detenido sin cambios."
  ! in_list "$n" "$fij" || die "$s versión $n es la FIJADA en la revisión: nunca se destruye. Detenido sin cambios."
  lector_unico "$s" "$cuenta" || die "$s tiene lectores distintos de la cuenta del servicio: otro consumidor podría usar esa versión. Detenido sin cambios."
  v="$(versions_of "$s")" || die "no se pudieron leer las versiones de $s."
  estado="$(estado_de "$v" "$n")"
  [[ "$estado" == 'DISABLED' ]] || die "$s versión $n está en estado «${estado:-inexistente}», no DISABLED; detenido sin cambios."
  [[ "$(programada_de "$v" "$n")" != 'programada' ]] || die "$s versión $n ya tiene una destrucción programada: nada que hacer."
  echo "Se DESTRUIRÁ de forma IRREVERSIBLE: $s versión $n (DISABLED; la fijada es $fij)."
  confirm 'AUTORIZO DESTRUIR VERSION TRAS VERIFICAR EL LOGIN'
  # Segunda comprobación inmediatamente antes de destruir (R2-1): el servicio (revisión activa, tráfico y TODAS las
  # referencias) sigue como en el plan, la versión sigue sin referenciarse, el lector sigue siendo único y la versión
  # sigue DISABLED. La destrucción lleva el etag de esta última lectura.
  revalidar_servicio "$huella"
  fijadas="$(describe_service | py fijadas)" || die 'no se pudo releer el servicio; detenido sin cambios.'
  ! in_list "$n" "$(pinned_of "$fijadas" "$s")" || die "$s versión $n pasó a estar referenciada; detenido sin cambios."
  lector_unico "$s" "$cuenta" || die "$s tiene ahora lectores distintos de la cuenta del servicio; detenido sin cambios."
  v="$(versions_of "$s")" || die "no se pudieron releer las versiones de $s."
  [[ "$(estado_de "$v" "$n")" == 'DISABLED' ]] || die "$s versión $n cambió de estado; detenido sin cambios."
  etag="$(etag_de "$v" "$n")"
  [[ -n "$etag" && "$etag" != '?' ]] || die "$s versión $n sin etag legible: no se puede destruir de forma condicional; detenido sin cambios."
  gcloud secrets versions destroy "$n" --secret="$s" --etag="$etag" --project="$PROJECT_ID" --quiet --format=none \
    || die "la API rechazó destruir $s versión $n (¿cambió desde la última lectura?); no se destruyó nada."
  # Verificación posterior: DESTROYED, o DISABLED con destrucción programada si el secreto tiene una TTL de destrucción.
  v="$(versions_of "$s")" || die "no se pudo verificar $s versión $n tras destruirla: NO_VERIFICADO; revisar en la consola."
  estado="$(estado_de "$v" "$n")"
  if [[ "$estado" == 'DESTROYED' ]]; then echo "  destruida (verificado): $s versión $n"
  elif [[ "$estado" == 'DISABLED' && "$(programada_de "$v" "$n")" == 'programada' ]]; then
    echo "  destrucción PROGRAMADA (verificado): $s versión $n sigue DISABLED hasta la fecha que fija la TTL del secreto"
  else die "$s versión $n quedó en estado «${estado:-inexistente}» tras destruirla: NO_VERIFICADO; revisar en la consola."; fi
}

in_secrets() { local x; for x in "${SECRETS[@]}"; do [[ "$x" == "$1" ]] && return 0; done; return 1; }

alinear_max_servicio() {
  local antes despues rev_antes rev_despues svc_max rev_max
  antes="$(describe_service | py escala)" || die 'no se pudo leer el servicio.'
  svc_max="$(awk '$1 == "servicio_maxScale" { print $2 }' <<< "$antes")"
  rev_max="$(awk '$1 == "revision_maxScale" { print $2 }' <<< "$antes")"
  rev_antes="$(awk '$1 == "revision_activa" { print $2 }' <<< "$antes")"
  [[ "$rev_max" == '1' ]] || die "la revisión no tiene maxScale 1 (${rev_max}); detenido sin cambios."
  if [[ "$svc_max" == '1' ]]; then echo 'El máximo de servicio ya es 1: nada que hacer.'; return 0; fi
  echo "Cambio: máximo de instancias del SERVICIO ${svc_max} → 1 (gcloud run services update --max=1)."
  echo "Revisión activa antes: ${rev_antes}. Según la ayuda de gcloud, --max no despliega una revisión nueva."
  confirm 'AUTORIZO MAX SERVICIO 1'
  gcloud run services update "$SERVICE" --project="$PROJECT_ID" --region="$REGION" --max=1 --format=none
  despues="$(describe_service | py escala)" || die 'no se pudo releer el servicio; revisar en la consola.'
  rev_despues="$(awk '$1 == "revision_activa" { print $2 }' <<< "$despues")"
  printf '  %s\n' "${despues//$'\n'/$'\n  '}"
  [[ "$(awk '$1 == "servicio_maxScale" { print $2 }' <<< "$despues")" == '1' ]] || die 'el máximo de servicio no quedó en 1: revisar.'
  if [[ "$rev_despues" != "$rev_antes" ]]; then
    echo "AVISO: la revisión activa cambió (${rev_antes} → ${rev_despues}). Ejecuta smoke:remote y A1/A9 antes de nada más."
  else
    echo 'OK: máximo de servicio 1, misma revisión activa. Ejecuta npm run smoke:remote para confirmar.'
  fi
}

# Alcance: SOLO el sink _Default (y su bucket). No afecta a otros sinks ni a registros ya guardados.
excluir_callback_en_logs() {
  local estado
  estado="$(sink_exclusion)" || die 'no se pudo leer el sink _Default.'
  case "$estado" in
    CORRECTA) echo "La exclusión $EXCLUSION ya existe con el filtro esperado y activa: nada que hacer."; return 0 ;;
    DISTINTA|DESHABILITADA) die "la exclusión $EXCLUSION existe pero está ${estado} (filtro distinto o deshabilitada): NO_VERIFICADO. No se modifica automáticamente; revisar en la consola." ;;
    AUSENTE) ;;
    *) die "estado de la exclusión no reconocido: NO_VERIFICADO." ;;
  esac
  echo "Se añadirá al sink _Default (solo ese sink) la exclusión «${EXCLUSION}» con el filtro:"
  echo "  ${EXCLUSION_FILTER}"
  echo 'Efecto: las peticiones al callback OAuth dejan de guardarse en _Default (URL con code, estado y latencia).'
  echo 'No afecta a otros sinks ni borra registros ya guardados: caducan con la retención de 30 días.'
  confirm 'AUTORIZO EXCLUIR CALLBACK OAUTH DE LOS LOGS'
  gcloud logging sinks update _Default --project="$PROJECT_ID" \
    --add-exclusion="name=${EXCLUSION},description=PROJECT-OS: no guardar URLs del callback OAuth,filter=${EXCLUSION_FILTER}" --format=none
  estado="$(sink_exclusion)" || die 'no se pudo releer el sink: NO_VERIFICADO.'
  [[ "$estado" == 'CORRECTA' ]] || die "tras el cambio, la exclusión está ${estado}: NO_VERIFICADO; revisar en la consola."
  echo "OK: exclusión ${EXCLUSION} activa, con el filtro esperado."
}

main() {
  local modo="${1:-diagnostico}"
  local uso="Uso: bash $0 [diagnostico|deshabilitar-sobrantes|destruir-version <secreto> <versión>|alinear-max-servicio|excluir-callback-en-logs]"
  if [[ "$modo" == 'destruir-version' ]]; then [[ $# -eq 3 ]] || { echo "$uso"; exit 2; }
  else [[ $# -le 1 ]] || { echo "$uso"; exit 2; }; fi
  # «type -P» busca el EJECUTABLE: «command -v» encontraría la función gcloud() de este script y nunca fallaría.
  type -P gcloud >/dev/null || die 'gcloud no disponible.'
  type -P python3 >/dev/null || die 'python3 no disponible.'
  echo "PROJECT-OS V1.6 — remediación (${modo}) · ${PROJECT_ID} · ${REGION} · ${SERVICE}"
  case "$modo" in
    diagnostico) diagnostico ;;
    deshabilitar-sobrantes) deshabilitar_sobrantes ;;
    destruir-version) destruir_version "$2" "$3" ;;
    alinear-max-servicio) alinear_max_servicio ;;
    excluir-callback-en-logs) excluir_callback_en_logs ;;
    *) echo "Modo desconocido: $modo"; exit 2 ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
