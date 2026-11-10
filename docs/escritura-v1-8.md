# V1.8 F2 — Activar la escritura real del dashboard (runbook del propietario)

Lo que hace el propietario en Cloud Shell para que el dashboard escriba en la hoja. Quedan dos límites:
- solo escribe el correo del propietario;
- solo en `TAREAS`, `TIEMPOS`, `DECISIONES` y `AUDITORIA` (y `ORDENES_CODEX` cuando llegue F3).

Diseño en el [plan V1.8](plan-v1-8-automatizacion.md) y en el [contrato de escritura](v1-4-write-contract.md).
Claude no ejecuta ningún paso: cada bloque lo revisa y lo corre el propietario.

## Cómo funciona

- **Lectura.** El dashboard sigue leyendo con su cuenta de siempre (`project-os-dashboard-run`), con el alcance de solo
  lectura.
- **Escritura.** Para escribir pide un token de 10 minutos de **otra** cuenta, `project-os-writer`. Esa cuenta es Editor
  **solo de la hoja** y no tiene roles en el proyecto. No existe ninguna clave: la cuenta del dashboard solo puede
  «hacerse pasar» por la de escritura (`roles/iam.serviceAccountTokenCreator` sobre esa cuenta y nada más).
- **Escritores.** La lista vive en un secreto nuevo, `project-os-writer-emails`, que se fija por versión. Si alguien no
  está en esa lista y en la de acceso, no escribe aunque el modo esté activo.
- **Arranque seguro.** Si la configuración no es válida, la sonda de arranque falla y sigue sirviendo la revisión
  anterior.

## 0. Antes de empezar

1. En la hoja, abre Archivo → Historial de versiones → **Asignar nombre a la versión actual** y llámala
   «antes de escritura V1.8».
2. En Cloud Shell, carga las variables del bloque 1 del despliegue de V1.7
   ([registro](estado-produccion-v1-7-2026-10-13.md)).

## 1. Cuenta de escritura y permisos

```bash
export WRITE_SA="project-os-writer@${PROJECT_ID}.iam.gserviceaccount.com"
gcloud services enable iamcredentials.googleapis.com --project="$PROJECT_ID"
gcloud iam service-accounts create project-os-writer --project="$PROJECT_ID" \
  --display-name="PROJECT-OS escritura (solo la hoja maestra)"
# La cuenta del dashboard puede pedir tokens SOLO de la cuenta de escritura:
gcloud iam service-accounts add-iam-policy-binding "$WRITE_SA" --project="$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SA}" --role=roles/iam.serviceAccountTokenCreator
# Verificación (solo lectura). Esperado: ningún rol de proyecto para la cuenta de escritura.
gcloud projects get-iam-policy "$PROJECT_ID" --flatten="bindings[].members" \
  --filter="bindings.members:serviceAccount:${WRITE_SA}" --format="value(bindings.role)"
```

Después, en la hoja: **Compartir** → pega el correo `project-os-writer@…` (es el valor de `$WRITE_SA`) → **Editor** →
desmarca «Notificar». Esa es la única cosa que esta cuenta puede editar.

## 2. Secreto con la lista de escritores

```bash
# Escribe tu correo cuando lo pida (no se muestra ni queda en el historial):
read -rs -p "Correo del escritor: " W && printf '%s' "$W" | gcloud secrets create project-os-writer-emails \
  --project="$PROJECT_ID" --replication-policy=automatic --data-file=- && unset W; echo
gcloud secrets add-iam-policy-binding project-os-writer-emails --project="$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SA}" --role=roles/secretmanager.secretAccessor
export SECRET_VERSION_WRITERS=1
```

## 2b. Token de GitHub para enviar órdenes a Codex (F4, opcional)

Con este token, al pulsar **Aprobar** el dashboard abre el issue en el repositorio del proyecto. La tarea se lanza en
Codex con el botón **«Copiar para Codex»** (el `@codex` en issues no la inicia). Sin el token, la orden queda aprobada
y se envía a mano.

1. En GitHub abre Settings → Developer settings → **Fine-grained tokens** → *Generate new token*.
   - **Nombre:** `project-os-dashboard-codex`. **Caducidad:** 90 días.
   - **Repository access:** *Only select repositories* → PROJECT-OS, SIGSAH y RADAROS.
   - **Permisos:** Issues = **Read and write**; Pull requests = **Read-only**; Metadata = Read-only (se marca solo). Nada
     más.
2. Copia el token y guárdalo como secreto, sin mostrarlo:

```bash
read -rs -p "Token de GitHub: " T && printf '%s' "$T" | gcloud secrets create project-os-github-token \
  --project="$PROJECT_ID" --replication-policy=automatic --data-file=- && unset T; echo
gcloud secrets add-iam-policy-binding project-os-github-token --project="$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SA}" --role=roles/secretmanager.secretAccessor
export SECRET_VERSION_GITHUB=1
```

Cuando el token caduque, crea uno nuevo, agrégalo como versión nueva
(`gcloud secrets versions add project-os-github-token --data-file=-`), sube `SECRET_VERSION_GITHUB` y vuelve a
desplegar.

## 3. Desplegar con escritura

Usa la imagen del commit fusionado de F2 y repite el despliegue de V1.7 (compilar, fijar `IMAGE` y reutilizar la
configuración). Antes de `render.mjs`, define también estas variables:

```bash
export WRITE_MODE=sheets WRITE_SERVICE_ACCOUNT="$WRITE_SA"
cd ~/PROJECT-OS/web
node deploy/cloudrun/render.mjs > /tmp/project-os-service.yaml && grep -c "PROJECT_OS_WRITE_MODE" /tmp/project-os-service.yaml
gcloud run services replace /tmp/project-os-service.yaml --region "$REGION"
rm -f /tmp/project-os-service.yaml
gcloud run revisions list --service "$SERVICE_NAME" --region "$REGION" --limit 2
```

- El `grep -c` debe imprimir `1`.
- Al final debe quedar una revisión nueva activa.
- Si la revisión no arranca, la anterior sigue sirviendo. En ese caso revisa en los logs el código `write-mode`.

## 4. Prueba real controlada

1. Entra al dashboard. Debajo del nombre debe decir **«escritura real»** y debe aparecer el menú **Operaciones**.
2. Crea una tarea de prueba en POS (Tareas → Nueva tarea). En la hoja comprueba:
   - la fila en `TAREAS`, con versión 1;
   - una fila por campo en `AUDITORIA`, con `ORIGEN` que empieza por `dashboard-v1.4;modo=sheets`.
3. Edítala (por ejemplo, la prioridad) y comprueba que la versión pasa a 2.
4. Registra un tiempo y una decisión de prueba.
5. En **Operaciones**, la conciliación debe decir **«Sin pendientes»**.
6. Si configuraste el token, crea una orden de prueba en **Órdenes → Nueva orden** y pulsa **Aprobar y enviar a
   Codex**. Comprueba tres cosas:
   - aparece el issue `[ORD-…]`;
   - la orden pasa a **Enviada**, con su issue y el botón **«Copiar para Codex»**;
   - al pegar ese texto en chatgpt.com/codex, Codex abre un PR `[ORD-…]` que el dashboard detecta.
7. Corre `node scripts/smoke-remote.mjs --url "$SERVICE_URL"`: deben salir todas las comprobaciones en OK.

**Si la primera escritura falla** («lectura fallida» o «escritura fallida»), lo normal es que falte un permiso. La sonda de
arranque no puede verificarlo, porque no usa la red. Revisa dos cosas:
- que la cuenta del dashboard tenga `TokenCreator` sobre `project-os-writer`;
- que `project-os-writer` sea Editor de la hoja.

Si acabas de quitar un permiso, el token anterior puede seguir en uso hasta 10 minutos.

## 5. Reversión (en cualquier momento)

1. Para cortar la escritura: vuelve a desplegar **sin** `WRITE_MODE`. La lectura sigue igual.
2. Quita el acceso de `project-os-writer@…` en Compartir de la hoja.
3. Opcional:
   `gcloud iam service-accounts disable "$WRITE_SA" --project="$PROJECT_ID"`.
4. Para corregir datos, usa `AUDITORIA` como guía. El panel no borra registros.

## 6. Acceso del agente PM (ORD-POS-027, DEC-POS-005, DEC-POS-011)

Una sesión PM de Claude escribe por la misma API de operaciones con `Authorization: Bearer <token>`, sin cookie de sesión.
Sustituye la escritura interina con el conector (DEC-POS-006); retirarla es una orden aparte tras desplegar.

- **Token.** El servidor compara el SHA-256 del token con `PM_AGENT_TOKEN_SHA256` (64 hex) en tiempo constante. Sin la
  variable, o con token inválido, responde 401 sin decir el motivo. Token y cookie de sesión a la vez: 400. Generar el
  token, guardar el hash en Cloud Run y desplegar lo hace el propietario (riesgo ALTO, fuera de esta orden).
- **Proxy.** Sin sesión, el proxy (`web/src/lib/authz.ts`) solo deja pasar `POST` a `/api/operaciones/{tareas,decisiones,ordenes}`
  y `PATCH` a `/api/operaciones/tareas/<id>` y `/api/operaciones/ordenes/<id>` (DEC-POS-011) con `Bearer` cuyo SHA-256
  (Web Crypto) coincide con la variable. Cualquier otra ruta, método (incluido `GET`) o token sigue exigiendo sesión; la
  API vuelve a verificar token, operación, acción y campos. Desde ORD-POS-112 también deja pasar `POST` a
  `/api/operaciones/tiempos` (`tiempo.crear`), que la API rechaza con 403 sin `TIEMPOS_AGENTE=true` (§8).
- **Permitido** (lista blanca, `AGENT_OPERATIONS` y `AGENT_ORDER_ACTIONS` en `constants.ts`): `tarea.crear`,
  `tarea.editar`, `decision.crear` (siempre PENDIENTE), `orden.crear` (siempre BORRADOR, nunca ALTO) y, en el `PATCH` de
  una orden, las acciones `APROBAR`, `ENVIAR` y `REVISAR` (DEC-POS-011, ORD-POS-055, 057 y 059). `tarea.editar` solo
  cambia `titulo`, `descripcion`, `prioridad`, `hitoId`, `fechaPlan`, `fechaLimite`, `horasEstimadas` y
  `criterioTerminado`, con control de VERSION.
  - `tarea.crear` admite `instrucciones` (ORD-POS-105): hasta 4000 caracteres multilínea, saneadas como `descripcion`
    (fórmulas neutralizadas) y auditadas por campo. Solo si `TAREAS` tiene la columna `INSTRUCCIONES`
    ([migración](migracion-instrucciones.md)); sin ella, 422 `instrucciones-sin-columna` sin escribir nada. Editarlas es
    del propietario: `instrucciones` no está en la lista de campos de `tarea.editar` del PM (403).
  - `APROBAR` (BORRADOR → APROBADA y envío del issue) y `ENVIAR` (reintento del envío de una APROBADA, sin `url`) exigen
    `autorizacion` = `ORD-PRY-NNN «cita» AAAA-MM-DD`: el ID igual al de la ruta, la cita con «sí» como palabra y la fecha
    de hoy en Mérida con un día de margen; una cita y fecha valen para una sola orden. Nunca con riesgo ALTO
    (`riesgo-alto-pm`); si no, `autorizacion-no-valida`. `ENVIAR` con `url` (registro manual) es del propietario.
  - `REVISAR` (PR_ABIERTO → REVISADA) relee el PR en GitHub y solo pasa con un dictamen vigente del head actual y
    suficiente: CONFORME de PRIMERO o DELTA y, en MEDIO sensible, también SEGUNDO de otro modelo en el mismo head (ORD-POS-057);
    si no, `dictamen-no-valido` o `dictamen-insuficiente`. MEDIO no sensible (`SENSIBLE` = `NO` en ORDENES_CODEX) pasa
    con PRIMERO o DELTA; vacía = sensible (DEC-POS-019). Un SEGUNDO gemini-supervisado cuenta si el modelo de sus
    hallazgos es de otra familia que el del PRIMERO o DELTA y su firmante no es del modelo del implementador
    (DEC-POS-022, [delegación](delegacion-codex.md#política-de-revisión-por-riesgo-dec-pos-003)), y solo con
    `SEGUNDO_GEMINI_SUPERVISADO=on` (ver «Activar el SEGUNDO gemini-supervisado»); sin ella no cuenta.
  - `REGISTRAR_PR` (ENVIADA → PR_ABIERTO, ORD-POS-063) es inerte por defecto: responde `transicion-reservada-pm` salvo con
    `PM_PUEDE_REGISTRAR_PR=true`, que solo el propietario pone en Cloud Run (ver «Activar el registro del PR»). Encendida,
    sin `url` ni `autorizacion`: registra el PR que /ordenes detecta (`prDeOrden`) solo si es el único de la orden y está
    abierto; si no, `pr-no-detectado`. `AUTORIZACION` = `pr <url> head <sha>`.
  - Cada transición del PM queda en `AUDITORIA` con `AUTORIZACION` (la cita o el dictamen con head y comentario).
- **Prohibido (403, no escribe nada):** cancelar, registrar PR (salvo con la bandera de arriba), cerrar y ejecutar órdenes (`transicion-reservada-pm`),
  registrar tiempos (salvo `tiempo.crear` con `TIEMPOS_AGENTE=true`, §8) y cualquier otro campo de tarea (`estado`, `bloqueo`, `tipo`, `responsable`). Tampoco puede fijar `bloqueo` al crear una tarea (403).
  Cerrar una tarea (`POST …/tareas/<id>/completar`) tampoco: el proxy no deja pasar el token a esa ruta (401) y la API
  responde `cierre-no-permitido` a toda petición con `Authorization`, aun con `TAREAS_CIERRE_PROPIETARIO` encendida (§7).
- **Auditoría.** `ACTOR=agente-pm` y `;agente=pm` al final de `ORIGEN`. La idempotencia por `requestId` es la de siempre.
- **Frecuencia.** Límite propio (clave `agente-pm`): ráfaga de 5 y 1 operación por minuto; al excederlo, 429.
  El humano tiene ráfaga de 10 y 1 cada 20 s.
- **Activar (ORD-POS-028).** `render.mjs` monta `PM_AGENT_TOKEN_SHA256` desde el secreto
  `project-os-pm-agent-token-sha256` (valor: SHA-256 hex del token), solo si defines la versión fijada, junto con
  `WRITE_MODE=sheets`: `export SECRET_VERSION_PM_AGENT=<versión>`. Nunca acepta el hash ni el token como valor literal;
  una versión mal formada, o sin `WRITE_MODE=sheets`, hace fallar el render sin imprimir YAML. Comprobación:
  `grep -c PM_AGENT_TOKEN_SHA256 /tmp/project-os-service.yaml` debe dar `1` (`0` = acceso deshabilitado).
- **Activar el registro del PR (ORD-POS-063, DEC-POS-014).** Solo el propietario, después de registrar en DECISIONES la
  decisión que amplía DEC-POS-011 con REGISTRAR_PR: `PM_PUEDE_REGISTRAR_PR=true web/deploy/cloudrun/deploy.sh --desde-activa`
  (exige `SECRET_VERSION_PM_AGENT` y `SECRET_VERSION_GITHUB`; otro valor que `true` hace fallar el render). `--desde-activa`
  la conserva en los despliegues siguientes; para apagarla, `deploy.sh --desde-activa --quitar PM_PUEDE_REGISTRAR_PR`.
  Ningún agente exporta esta variable ni despliega.
- **Activar el SEGUNDO gemini-supervisado (ORD-POS-100, DEC-POS-022 y DEC-POS-014).** Apagado por defecto: sin la
  variable, un SEGUNDO de origen `gemini-supervisado` no cuenta en /ordenes ni en REVISAR. Solo el propietario lo
  enciende: `SEGUNDO_GEMINI_SUPERVISADO=on web/deploy/cloudrun/deploy.sh --desde-activa` (otro valor que `on` hace fallar
  el render; no depende de `WRITE_MODE`). `--desde-activa` la conserva; para apagarla,
  `deploy.sh --desde-activa --quitar SEGUNDO_GEMINI_SUPERVISADO`. Ningún agente exporta esta variable ni despliega.
- **Revocar.** Desplegar sin `SECRET_VERSION_PM_AGENT` (`unset SECRET_VERSION_PM_AGENT`, renderizar y `services replace`):
  la variable `PM_AGENT_TOKEN_SHA256` desaparece y el acceso del agente queda deshabilitado (401). La escritura humana no se toca.

## 7. Cierre de tareas por el propietario (ORD-POS-106, DEC-POS-023)

DEC-POS-023 (vigente solo si consta APROBADA en DECISIONES; ORD-POS-106): el propietario puede marcar una tarea
como `COMPLETADO` desde el dashboard con su sesión de Google. Nunca con el token del agente PM. `CANCELADO` y reabrir
siguen fuera del dashboard, y el PM sigue sin cerrar ni cambiar `ESTADO` o `BLOQUEO` (DEC-POS-005). Es un trabajo ALTO
partido según DEC-POS-014: el código es inerte por defecto y solo el propietario lo activa.

- **Bandera.** `TAREAS_CIERRE_PROPIETARIO`: solo el valor exacto `true` la enciende. Exige
  `TAREAS_CIERRE_PROPIETARIO_EMAIL` con **un único** correo que además esté en `AUTH_ALLOWED_EMAILS`; una lista, un
  valor que no sea correo o un correo fuera de la lista de acceso la dejan apagada (`tareasCierrePropietario` en
  `web/src/lib/operations/config.ts`).
- **Apagada (por defecto).** `POST /api/operaciones/tareas/<id>/completar` responde 422 `cierre-no-permitido` sin
  escribir nada, y la página de la tarea no muestra el botón. La edición sigue rechazando `COMPLETADO` y `CANCELADO`.
- **Encendida.** En `/tareas/<id>/editar`, solo la sesión del propietario ve **Marcar completada**. La confirmación
  muestra `CRITERIO_TERMINADO` y una nota de cierre opcional (hasta 500 caracteres) que va solo a `AUDITORIA`
  (`CAMPO` = `NOTA_CIERRE`), no a la tarea. Cualquier otro escritor recibe `cierre-no-permitido`.
- **Transición.** Solo de una tarea abierta a `COMPLETADO`, con `expectedVersion` (`conflicto-version` si no coincide),
  auditoría antes de la escritura, verificación posterior e idempotencia por `requestId` como en la edición. Una tarea ya
  cerrada da `tarea-cerrada`. La operación es `tarea.completar` y no está en `AGENT_OPERATIONS`.
- **Agente PM.** Toda petición con `Authorization` a esa ruta recibe `cierre-no-permitido` en la API; antes, el proxy
  ni siquiera la deja pasar sin sesión. Su lista de operaciones y de campos no cambia.

### Activar (solo el propietario, en Cloud Shell)

Requisitos: la escritura activa (`WRITE_MODE=sheets`) y la imagen que trae ORD-POS-106 (la orden se fusiona y se
despliega antes). Ningún agente exporta estas variables ni despliega.

```bash
export TAREAS_CIERRE_PROPIETARIO=true
export TAREAS_CIERRE_PROPIETARIO_EMAIL='<correo del propietario>'
web/deploy/cloudrun/deploy.sh --desde-activa --dry-run   # debe listar «+ TAREAS_CIERRE_PROPIETARIO» y «+ TAREAS_CIERRE_PROPIETARIO_EMAIL»
web/deploy/cloudrun/deploy.sh --desde-activa             # escribe «desplegar» para aplicar
```

Otro valor que `true`, una sola de las dos variables, un correo mal formado o una lista, o la falta de
`WRITE_MODE=sheets` hacen fallar el render sin aplicar nada. `--desde-activa` las conserva en los despliegues siguientes.

### Comprobar

1. Con la sesión del propietario, abre `/tareas/<id>/editar` de una tarea de prueba abierta: aparece **Marcar
   completada**. Con otra cuenta de escritura, no aparece.
2. Marca la tarea de prueba como completada con una nota. En `/operaciones`, «Tarea completada» muestra `ESTADO`,
   `VERSION` y `NOTA_CIERRE`, y la conciliación dice «Sin pendientes».
3. En la hoja, la tarea queda en `COMPLETADO` con `VERSION` + 1. La nota no está en `TAREAS`.

### Revertir

`web/deploy/cloudrun/deploy.sh --desde-activa --quitar TAREAS_CIERRE_PROPIETARIO` (quita también el correo). El botón
desaparece y la ruta vuelve a `cierre-no-permitido`. Las tareas ya completadas no se reabren solas: reabrir sigue fuera
del dashboard y lo hace el propietario en la hoja, con `AUDITORIA` como guía.

## 8. Rol Tiempos: lectura de /api/planificacion y filas de TIEMPOS (ORD-POS-112, DEC-POS-025)

DEC-POS-025 (**PENDIENTE**; vigente solo si consta APROBADA en DECISIONES) enmienda DEC-POS-024: el rol Tiempos lee
`/api/planificacion` con un token propio y el PM da de alta filas de `TIEMPOS` de un «sí PAQ». Es un trabajo ALTO
partido según DEC-POS-014: el código es inerte por defecto y solo el propietario lo activa.

- **Bandera.** `TIEMPOS_AGENTE`: solo el valor exacto `true` la enciende (`web/src/lib/tiempos-agente.ts`). Enciende las
  dos piezas a la vez.
- **Token de Tiempos.** `TIEMPOS_AGENTE_TOKEN_SHA256` (64 hex, desde el secreto `project-os-tiempos-agente-token-sha256`).
  Si es igual a `PM_AGENT_TOKEN_SHA256` o a `FINANZAS_AGENTE_TOKEN_SHA256`, no vale. Solo alcanza `GET /api/planificacion`
  (la simulación de solo lectura, sin correos ni responsables); cualquier otro método recibe 405 (`Allow: GET`) y
  cualquier otra ruta o página, 401 o `/login`. Con cookie de sesión no cuenta. No escribe nada.
- **`tiempo.crear` del PM.** `POST /api/operaciones/tiempos` con el token del PM: alta de una fila de `TIEMPOS` con los
  campos de `tiempo.registrar`, `AUDITORIA` por campo (`ACTOR=agente-pm`, `op=tiempo.crear`, `;agente=pm`) e
  idempotencia por `requestId`. `TIEMPOS` no tiene `VERSION`: es solo alta; ninguna operación edita ni borra filas.
  No está en `AGENT_OPERATIONS`: el guard la permite solo con la bandera. El token de Tiempos no escribe (401).
- **Apagada (por defecto).** El token de Tiempos recibe 401 en `/api/planificacion`, y `tiempo.crear` responde 403
  `operacion-no-permitida` sin escribir nada. Sin `TIEMPOS_AGENTE` ni `SECRET_VERSION_TIEMPOS_AGENTE`, el YAML no cambia.

### Activar (solo el propietario, en Cloud Shell, con DEC-POS-025 APROBADA)

Requisitos: la imagen que trae ORD-POS-112 desplegada; para `tiempo.crear`, además la escritura activa
(`WRITE_MODE=sheets`) y el token del PM (§6). Ningún agente crea el token, toca Secret Manager o IAM, exporta estas
variables ni despliega.

```bash
# 1. Token nuevo, fuera del repositorio: va solo a la configuración del entorno de las sesiones de Tiempos (no a Cloud
#    Run, al repositorio ni al chat). A Secret Manager va solo su SHA-256.
TOKEN="$(openssl rand -hex 32)"
printf '%s' "$TOKEN" | sha256sum | cut -d' ' -f1 | tr -d '\n' | gcloud secrets create project-os-tiempos-agente-token-sha256 \
  --project="$PROJECT_ID" --replication-policy=automatic --data-file=-
gcloud secrets add-iam-policy-binding project-os-tiempos-agente-token-sha256 --project="$PROJECT_ID" --condition=None \
  --member="serviceAccount:${RUNTIME_SA}" --role=roles/secretmanager.secretAccessor --format=none
# Guarda "$TOKEN" en el entorno de las sesiones de Tiempos (solo para /api/planificacion) y bórralo de aquí:
unset TOKEN

# 2. Variables y despliegue (la versión del secreto recién creado es 1):
export TIEMPOS_AGENTE=true SECRET_VERSION_TIEMPOS_AGENTE=1
web/deploy/cloudrun/deploy.sh --desde-activa --dry-run   # debe listar «+ TIEMPOS_AGENTE» y «+ TIEMPOS_AGENTE_TOKEN_SHA256»
web/deploy/cloudrun/deploy.sh --desde-activa             # escribe «desplegar» para aplicar
```

Otro valor que `true`, una sola de las dos variables o una versión que no sea un número hacen fallar el render sin
aplicar nada. `--desde-activa` las conserva en los despliegues siguientes. Para rotar el token, agrega una versión al
secreto (`gcloud secrets versions add … --data-file=-`) y despliega con la nueva `SECRET_VERSION_TIEMPOS_AGENTE`.

### Comprobar

1. Hash distinto: el valor del secreto no es el de `project-os-pm-agent-token-sha256` ni el de
   `project-os-finanzas-agente-token-sha256` (compáralos sin imprimirlos; si coinciden, el token de Tiempos no entra).
2. Desde la sesión de Tiempos: `GET /api/planificacion` → 200 con `"simulacion": true` y sin correos; `POST` al mismo
   path → 405; `GET /api/resumen` → 401. El token del PM en `GET /api/planificacion` → 401.
3. Con un «sí PAQ» real y DEC-POS-025 APROBADA, el PM da de alta una fila de prueba con
   `bash scripts/pm-alta.sh tiempos <archivo.json>`: 201; en `/operaciones`, «Tiempo registrado por el PM» con sus campos
   y la conciliación «Sin pendientes»; repetir con `--repetir` da `repetida=true` sin otra fila.

### Revertir

`web/deploy/cloudrun/deploy.sh --desde-activa --quitar TIEMPOS_AGENTE` (quita también `TIEMPOS_AGENTE_TOKEN_SHA256`). El
token de Tiempos vuelve a 401 y `tiempo.crear` a 403 sin escribir. Para revocar solo el token, deshabilita su versión
(`gcloud secrets versions disable <versión> --secret=project-os-tiempos-agente-token-sha256`) después de quitarla del
despliegue. Las filas de `TIEMPOS` ya creadas no se borran solas: el propietario las corrige en la hoja, con `AUDITORIA`
como guía.

## 9. Alta de ideas en RADAROS por el PM (ORD-POS-131, DEC-ECO-007)

DEC-ECO-007 amplía DEC-POS-005 y DEC-POS-011 al libro de RADAROS, solo para dar de alta ideas: una fila nueva al final
de `PRODUCTS` (A a P) y otra de `SCORING` (A a L), solo por esta API y solo con el «sí PAQ» del propietario (DEC-POS-013).
El código es inerte por defecto y solo el propietario lo activa.

- **Operación.** `POST /api/operaciones/ideas` (`idea.alta`), solo con el token del PM; una sesión de navegador recibe
  403 `operacion-no-permitida`. No está en `AGENT_OPERATIONS`: el guard la permite solo con la bandera.
- **Cuerpo.** `requestId` (UUID v4), `autorizacion` (`PAQ-AAAA-MM-DD-NN «sí PAQ-AAAA-MM-DD-NN …» AAAA-MM-DD`, con el
  mismo paquete en la cita), `producto` (PRODUCTS B, obligatorio) y, opcionales, `categoria`, `bucket`,
  `clienteObjetivo`, `problema`, `canalInicial`, `nivel`, `estado`, `confidence`, `precioObservadoMxn`,
  `capitalPruebaMxn` (números), `redFlag`, `porValidar`, `siguienteDecision`, `owner` (C a P) y `puntajes`
  (`demanda`, `competencia`, `unitEconomics`, `diferenciacion`, `capital`, `logistica`, `riesgo`, `tendencia`,
  `complejidad`, `marca`: enteros del 1 al 5 o vacíos; son hipótesis que el propietario revisa en el paquete).
  Cualquier otro campo se rechaza (422).
- **ID.** Automático: el siguiente `EC-NNN` según la columna A de `PRODUCTS`. Si ese ID ya está en `SCORING`, no escribe
  (409 `conflicto-concurrente`). SCORING B se copia de PRODUCTS B: el nombre es uno solo.
- **Antes de escribir** (si algo falla, no escribe nada, ni la auditoría):
  - encabezados exactos de `PRODUCTS` A a P y de `SCORING` A a L (`web/src/lib/radaros/ideas-alta.ts`); si difieren,
    409 `idea-encabezados-distintos` con las letras de columna;
  - fila de `PRODUCTS`: la primera con A vacía; si tiene algo en B a P, 409 `idea-fila-ocupada`;
  - fila de `SCORING`: la primera con A a L vacías, que debe traer ya las fórmulas por fila de M a P (no son
    ARRAYFORMULA); si no, 409 `scoring-sin-formulas` y tampoco se escribe `PRODUCTS`. Preparar filas con fórmulas lo
    hace el propietario a mano.
- **Escritura.** Un solo rango por pestaña, `A<n>:P<n>` y `A<n>:L<n>`, con `values:batchUpdate` en `RAW`; nunca
  `append`, nunca otra pestaña ni las columnas M en adelante de `SCORING` (`web/src/lib/radaros/ideas-alta-store.ts`,
  lista cerrada `PRODUCTS` y `SCORING`).
- **Después de escribir.** Relee las dos filas: deben coincidir y M de `SCORING` debe tener valor; si M queda vacía,
  409 `idea-sin-calculo` (la fila queda escrita y se reporta).
- **Auditoría e idempotencia.** `AUDITORIA` de PROJECT-OS antes de escribir en RADAROS: `ACTOR=agente-pm`,
  `ENTIDAD=PRODUCTS`, `REGISTRO_ID=EC-NNN`, una fila por celda (`PRODUCT_ID`, `PRODUCTS!<encabezado>`,
  `SCORING!<encabezado>`) y `AUTORIZACION` con el «sí PAQ»; `ORIGEN` con `op=idea.alta` y `;agente=pm`. El mismo
  `requestId` no duplica: responde `repetida` y, si la escritura quedó a medias, completa lo que falta con lo auditado.
- **Cuenta y libro (criterio 2).** Usa la cuenta de escritura del pipeline de /eco (`ECO_PIPELINE_WRITE_SERVICE_ACCOUNT`,
  Editor del libro de RADAROS) y `RADAROS_SHEET_ID`, con todas las comprobaciones de `ecoPipelineWriteStatus`. No hace
  falta una cuenta dedicada: ese libro ya es de esa cuenta y DEC-ECO-007 no amplía a otro libro. La auditoría usa la
  escritura de PROJECT-OS (`PROJECT_OS_WRITE_MODE=sheets`).
- **Apagada (por defecto).** Sin `ECO_IDEAS_ALTA=true` exacto, 403 `operacion-no-permitida` sin leer el cuerpo. Con la
  bandera pero sin la escritura del pipeline activa o sin la de PROJECT-OS en `sheets`, 403 `escritura-deshabilitada`.

### Activar (solo el propietario, en Cloud Shell)

Requisitos: la imagen que trae ORD-POS-131 desplegada, `WRITE_MODE=sheets` con el token del PM (§6) y la escritura del
pipeline de /eco activa (`ECO_PIPELINE_WRITE_MODE=sheets`, docs/diseno-eco-pipeline.md). `render.mjs` rechaza la bandera
sin ellos. Ningún agente exporta la variable ni despliega.

```bash
export ECO_IDEAS_ALTA=true
web/deploy/cloudrun/deploy.sh --desde-activa --dry-run   # debe listar «+ ECO_IDEAS_ALTA»
web/deploy/cloudrun/deploy.sh --desde-activa             # escribe «desplegar» para aplicar
```

`--desde-activa` conserva la bandera en los despliegues siguientes.

### Revertir

```bash
web/deploy/cloudrun/deploy.sh --desde-activa --quitar ECO_IDEAS_ALTA
```

Quitar `ECO_PIPELINE_WRITE_MODE` sin quitar también `ECO_IDEAS_ALTA` hace fallar el render: no se aplica nada.

## 10. Edición de la planificación por el propietario (ORD-POS-136, DEC-POS-029)

DEC-POS-029 (b, f y g): el propietario edita `FECHA_PLAN`, `HORAS_ESTIMADAS` e `HITO_ID` desde la tarjeta de cada tarea
de la capa Semana de `/planificacion`, con su sesión de Google. `ESTADO`, `BLOQUEO`, cancelar y reabrir siguen fuera;
Tiempos sigue proponiendo por paquete (DEC-POS-024). Capacidad, escenarios y calendario ICS son órdenes aparte.

- **Bandera.** `PLANIFICACION_EDICION_PROPIETARIO`: solo `true`. Exige `PLANIFICACION_EDICION_PROPIETARIO_EMAIL` con un
  único correo que esté en `AUTH_ALLOWED_EMAILS` (la misma comprobación que §7; `planificacionEdicionPropietario` en
  `web/src/lib/operations/config.ts`), y la escritura habilitada.
- **Apagada (por defecto), o con otra sesión.** Cada tarjeta dice «Edición apagada» y no hay formulario; el navegador no
  recibe versiones.
- **Encendida.** **Editar** abre los 3 campos; **Guardar** manda `PATCH /api/operaciones/tareas/<id>` con
  `expectedVersion` y solo esos campos (vacío = celda vacía, nunca 0). Es la ruta y la operación `tarea.editar` de
  siempre: el servidor no cambia, y valida, audita (`ACTOR` = el correo de la sesión) y verifica como en cualquier
  edición. Tras guardar, la vista se recalcula con `router.refresh()`. En conflicto de versión se recarga la vista y
  se muestran el valor actual y el tuyo, con «Usar el actual» o «Guardar el mío sobre el actual».
- **Límite conocido.** La bandera solo decide qué muestra la tarjeta: cualquier escritor de `AUTH_WRITER_EMAILS` ya podía
  editar esos campos por `/tareas/<id>/editar` y la API, y lo sigue pudiendo.

### Activar (solo el propietario, en Cloud Shell)

```bash
export PLANIFICACION_EDICION_PROPIETARIO=true
export PLANIFICACION_EDICION_PROPIETARIO_EMAIL='<correo del propietario>'
web/deploy/cloudrun/deploy.sh --desde-activa --dry-run   # debe listar las dos con «+»
web/deploy/cloudrun/deploy.sh --desde-activa             # escribe «desplegar» para aplicar
```

Otro valor que `true`, una sola de las dos, un correo mal formado o la falta de `WRITE_MODE=sheets` hacen fallar el
render sin aplicar nada.

### Revertir

`web/deploy/cloudrun/deploy.sh --desde-activa --quitar PLANIFICACION_EDICION_PROPIETARIO` (quita también el correo).
Las tarjetas vuelven a «Edición apagada»; lo ya guardado queda en la hoja y en `AUDITORIA`.

## 11. Planificación editable por el propietario (ORD-POS-138, DEC-POS-029)

DEC-POS-029 (APROBADA el 2026-11-02 según la orden ORD-POS-138, fila 41 de `DECISIONES`; amplía DEC-POS-023 y
DEC-POS-024): el propietario edita la planificación desde `/planificacion` y puede suscribirse a un calendario ICS de
solo lectura. Esta sección fija el contrato **antes del código**: operaciones, migraciones, banderas, idempotencia y
datos del calendario. El código lo traen ORD-POS-139 a ORD-POS-142; el reparto entre ellas lo fija cada orden.
Lo que ya está hecho vive en §10 (ORD-POS-136) y esta sección no lo cambia: la edición de `FECHA_PLAN`,
`HORAS_ESTIMADAS` e `HITO_ID` desde la tarjeta con `tarea.editar`, y la bandera `PLANIFICACION_EDICION_PROPIETARIO` con
su correo; si algo de aquí parece contradecirla, manda §10. **Estado:** `capacidad.registrar` implementada por
ORD-POS-139 (panel «Capacidad de la semana» de la capa Semana, `POST /api/operaciones/capacidad`), inerte sin la bandera
y sin la migración `VERSION` de `CAPACIDAD_SEMANAL`; `plan.dia.guardar` implementada por ORD-POS-140 («Aplicar
movimientos al plan» de la propuesta por día, `POST /api/operaciones/plan-dia`), inerte sin la bandera y sin la migración
`VERSION` de `PLAN_DIARIO`; `escenario.guardar` y `escenario.archivar` implementadas por ORD-POS-141 (panel «Escenarios
guardados», `POST /api/operaciones/escenarios` y `/escenarios/archivar`), inertes sin la bandera y sin la pestaña
`ESCENARIOS`; calendario ICS implementado por ORD-POS-142 (`GET /api/planificacion/calendario.ics`, panel «Calendario
(solo lectura)» de `/planificacion`), inerte sin `PLANIFICACION_ICS` y su secreto (§11.3). Nada migrado
ni encendido. Es un trabajo ALTO partido según DEC-POS-014: el código llega inerte y
solo el propietario aplica las migraciones, crea el secreto y enciende las banderas.

Reglas que no cambian: la hoja es la fuente; toda edición pasa por el servidor, con versión esperada y `AUDITORIA`
antes de escribir (§7 del [contrato](v1-4-write-contract.md#7-auditoría-y-consistencia-sin-prometer-atomicidad)), nunca del
navegador a Sheets; `ESTADO`, `BLOQUEO`, cancelar y reabrir tareas siguen fuera del dashboard (§7 de este documento);
Tiempos solo propone por paquete (DEC-POS-024) y el PM solo escribe con el «sí PAQ» verificado (DEC-POS-013); vacío ≠ 0;
sin dependencias nuevas (el arrastre es HTML nativo).

### 11.1 Quién puede y operaciones (criterio 1)

**Actor único: el propietario**, con su sesión de Google y la misma comprobación de correo de §7 y §10: un único correo en
`PLANIFICACION_EDICION_PROPIETARIO_EMAIL`, que además esté en `AUTH_ALLOWED_EMAILS`; una lista, un valor que no sea
correo o un correo fuera de la lista de acceso dejan la edición apagada. `ACTOR` en `AUDITORIA` es ese correo.

| Operación | Ruta (`POST`) | Pestañas que escribe | Campos que acepta |
| --- | --- | --- | --- |
| `tarea.editar` (existente) | `/api/operaciones/tareas/<id>` (`PATCH`) | `TAREAS` | Desde `/planificacion` solo `fechaPlan`, `horasEstimadas` e `hitoId`, con `expectedVersion`; ya implementada, ver §10 |
| `capacidad.registrar` | `/api/operaciones/capacidad` | `CAPACIDAD_SEMANAL` | `semanaId`, `fechaInicio`, `horasDisponibles`, `reservaPct`, `estado` y, al editar, `expectedVersion` |
| `plan.dia.guardar` | `/api/operaciones/plan-dia` | `PLAN_DIARIO` y `PLAN_ITEMS` | `fecha`, `estado`, `horasObjetivo`, `items` (`tareaId`, `orden`, `minutosPlan`) y, si el plan existe, `expectedVersion` |
| `escenario.guardar` | `/api/operaciones/escenarios` | `ESCENARIOS` | `nombre`, `semanaId`, `parametros` (los del `Scenario` de `web/src/lib/planning/types.ts`) y `huella` |
| `escenario.archivar` (ORD-POS-141) | `/api/operaciones/escenarios/archivar` | `ESCENARIOS` | `escenarioId` y `expectedVersion` |

- **Rechazos.** Toda petición con `Authorization` (token del PM, de Tiempos o de finanzas) a las tres rutas nuevas recibe
  403 `operacion-no-permitida` sin leer el cuerpo; antes, el proxy (`web/src/lib/authz.ts`) no las deja pasar sin sesión
  (401). El token de Tiempos sigue limitado a `GET /api/planificacion` (§8). Otra sesión de escritura que no sea la del
  propietario recibe 403 `operacion-no-permitida`. Las tres operaciones **no** entran en `AGENT_OPERATIONS`.
- **`capacidad.registrar`.** Alta si `SEMANA_ID` no existe (sin `expectedVersion`; con él, 422) y edición si existe
  (`expectedVersion` obligatorio, `conflicto-version` si no coincide). `NOTAS` no se toca; `ACTUALIZADO_EN` y `VERSION`
  los pone el servidor. `horasDisponibles` y `reservaPct` vacíos se guardan vacíos, nunca como 0.
  Implementación (ORD-POS-139): horas 0–168 y reserva 0–100 con hasta 2 decimales; la reserva se escribe como `N%`, que
  el lector ya acepta, y `0.15` en la hoja y `15` en el formulario cuentan como el mismo valor (sin cambio falso). Con
  expectedVersion y sin fila, 422 `semana-inexistente`; otra fila con `FECHA_INICIO` en la misma semana ISO, 409
  `capacidad-semana-ocupada` (la capacidad quedaría ambigua). El panel muestra «Edición apagada» sin la bandera, el
  motivo si falta la migración o la fila no tiene `VERSION`, y «Sin capacidad registrada» o «Sin reserva registrada»
  para los vacíos, nunca 0. `/capacidad` sigue de solo lectura.
- **`plan.dia.guardar`.** Un solo plan activo por `FECHA` (el motor ya avisa `plan-diario-duplicado`): si no existe, alta
  de `PLAN_DIARIO` con `VERSION` 1; si existe, edición con `expectedVersion`. Toda guardada sube `VERSION` del plan
  aunque solo cambien los elementos: esa versión protege también sus `PLAN_ITEMS`, que no llevan `VERSION`. Nunca se
  borran filas: una tarea quitada del día conserva su fila con `MINUTOS_PLAN` = `0` explícito (no vacío, que el motor
  marca como `plan-item-sin-minutos`), y las vistas no la listan. Solo tareas abiertas existentes.
  **Hipótesis:** el criterio 1 de la orden pide esta operación y DEC-POS-029 no nombra `PLAN_DIARIO`; se lee como parte de
  «planificación editable». Si el propietario no la da por cubierta, queda fuera hasta una decisión.
  Implementación (ORD-POS-140): una llamada por día con su `requestId`. Las filas de `PLAN_ITEMS` del plan que no vienen
  en `items` no se tocan (quitar una tarea es mandarla con `minutosPlan` `0`, nunca implícito); `estado` y
  `horasObjetivo` ausentes no se tocan y en un alta quedan vacíos, como `SEMANA_ID` (vacío ≠ 0). Plan activo = fila con
  `PLAN_ID`, esa `FECHA` y `ESTADO` distinto de `CANCELADO`/`DESCARTADO` (las reglas del motor). Rechazos sin escribir
  nada: `FECHA` anterior a hoy en Mérida, 422 `dia-pasado`; dos planes activos, 409 `plan-diario-duplicado`; dos filas
  de la misma tarea en el plan, 409 `plan-item-duplicado`; `expectedVersion` distinta, ausente con plan existente o
  presente sin plan, 409 `conflicto-version` con `detalle.planActual` (`planId`, `version` y sus elementos tal como están
  en la hoja); tarea inexistente o cerrada, `tarea-inexistente` o `tarea-cerrada`; nada distinto, `sin-cambios`.
  Escribe primero los `PLAN_ITEMS` (edición guardada por su `MINUTOS_PLAN` anterior, altas en un bloque) y al final el
  plan: su `VERSION` es la marca de que el día quedó completo. `AUDITORIA` del día va en un solo lote antes de escribir:
  `PLAN_DIARIO` con el `requestId` y cada elemento escrito como `PLAN_ITEMS` con un `requestId` derivado
  (`plan-item:<TAREA_ID>`); `TAREAS` solo se lee. La vista (`web/src/components/planning/aplicar-plan.tsx`) registra
  solo los bloques movidos de la simulación, sumados a los minutos que la tarea ya tenga en el plan de ese día; muestra
  antes la lista por día y no escribe sin «Confirmar y guardar»; informa cada día (guardado, conflicto con el plan
  actual o error) y quita de la simulación los movimientos de los días guardados.
- **`escenario.guardar`.** Solo alta (ORD-POS-141: «solo altas y archivar»): ninguna operación borra escenarios ni
  edita su nombre, parámetros o huella. `parametros` se valida con `normalizeScenario` (`web/src/lib/planning/scenario.ts`,
  los rangos del motor, por ejemplo `sobrecargaPct` 0–300; otra clave se rechaza) y se guarda como JSON canónico de hasta
  2000 caracteres. `huella` es la huella de los datos de entrada del motor (`huellaDatos` en
  `web/src/lib/planificacion-escenarios.ts`: el `PlanningInput`, sin escenario ni fecha). La fila nace `ESTADO` `ACTIVO` y
  `VERSION` `1`. Guardar no lee ni escribe ninguna otra pestaña de datos: no cambia el plan (aplicar es ORD-POS-140).
- **`escenario.archivar`** (ORD-POS-141). `ESTADO` `ACTIVO` → `ARCHIVADO` y `VERSION` + 1, con `expectedVersion`
  (`conflicto-version` si no coincide; ya archivado, 409 `escenario-archivado`). La fila no se borra; la vista deja de
  listarla.
- **Cargar** (ORD-POS-141) no es una operación: el navegador valida `PARAMETROS` con `normalizeScenario` y re-simula con
  los datos de ahora; si la huella guardada no es la de ahora, avisa «Los datos cambiaron desde que lo guardaste». Un
  `PARAMETROS` que no valida no se carga.
- **Auditoría.** Una fila por campo, `ENTIDAD` = la pestaña escrita (`CAPACIDAD_SEMANAL`, `PLAN_DIARIO`, `PLAN_ITEMS` o
  `ESCENARIOS`), `ORIGEN` con `op=<operación>;req=<requestId>;h=<hash>`. Amplía la lista de pestañas del inicio de este
  documento solo con esas cuatro.

### 11.2 Migraciones explícitas (criterio 2)

Las aplica **solo el propietario, a mano en la hoja**, después de fusionar y desplegar el código que las lee y antes de
usar las tres operaciones nuevas. Si `PLANIFICACION_EDICION_PROPIETARIO` ya está encendida por §10, esas operaciones
responden 422 `migracion-pendiente` hasta entonces; la edición de §10 no las necesita. Ningún agente las aplica. Como con `INSTRUCCIONES`
([migración](migracion-instrucciones.md)), la lectura no las exige: sin ellas, el dashboard lee igual y las operaciones
responden 422 `migracion-pendiente` (con la pestaña) sin escribir nada, ni en `AUDITORIA`.

| Pestaña | Cambio | Columna |
| --- | --- | --- |
| `CAPACIDAD_SEMANAL` | `VERSION` al final, después de `ACTUALIZADO_EN` | H |
| `PLAN_DIARIO` | `VERSION` al final, después de `ACTUALIZADO_EN` | H |
| `ESCENARIOS` (nueva) | Pestaña nueva, al final del libro, con fila 1 exacta: `ESCENARIO_ID`, `NOMBRE`, `SEMANA_ID`, `PARAMETROS`, `CREADO_EN`, `HUELLA`, `ESTADO`, `VERSION` | A a H |

- **Filas existentes.** En `CAPACIDAD_SEMANAL` y `PLAN_DIARIO`, el propietario escribe `1` en `VERSION` de cada fila con
  datos. Una fila con `VERSION` vacía o no entera no se edita (409 `version-faltante`); el servidor nunca la supone. Las
  otras columnas no cambian. `ESCENARIOS` empieza vacía.
- **ESCENARIOS, columnas F a H** (ORD-POS-141). La orden pide guardar la huella de entrada y la versión, y archivar:
  `HUELLA`, `ESTADO` y `VERSION` amplían, al final, la fila 1 que fijó ORD-POS-138 (A a E). Como la pestaña aún no
  existe, el propietario la crea de una vez con las 8 columnas. Sin la pestaña, o sin alguna de las 8, las dos operaciones
  no escriben nada (422 `migracion-pendiente` o 503 `esquema-invalido`) y la vista dice «Falta la migración».
- **Encabezados.** Exactos, en mayúsculas, sin espacios y sin repetirse. `ESCENARIOS` se lee como pestaña opcional
  (`OPTIONAL_TABS`): si falta, el resto se lee igual.
- **Comprobar.** `/planificacion` sin avisos de esquema; una edición de prueba deja `VERSION` + 1 y sus filas en
  `AUDITORIA`.
- **Revertir.** Apagar la bandera (§11.3) y después borrar las columnas `VERSION` completas y la pestaña `ESCENARIOS`.
  Lo guardado queda en `AUDITORIA` como historial.

### 11.3 Banderas, secreto del calendario y rotación (criterio 3)

| Bandera | Enciende | Requisitos | Apagada |
| --- | --- | --- | --- |
| `PLANIFICACION_EDICION_PROPIETARIO` = `true` | Arrastre y formularios de `/planificacion`, y las tres operaciones | `PLANIFICACION_EDICION_PROPIETARIO_EMAIL` válido (§11.1) y `WRITE_MODE=sheets` | Las tres operaciones nuevas: 403 `operacion-no-permitida` sin leer el cuerpo; la página no muestra controles de edición. `tarea.editar` sigue como dice §10 (su límite conocido incluido) |
| `PLANIFICACION_ICS` = `true` | `GET /api/planificacion/calendario.ics?token=<secreto>` | `SECRET_VERSION_CALENDARIO_ICS` (no depende de `WRITE_MODE`) | 404, igual que sin secreto o con un token inválido |

Solo el valor exacto `true` las enciende; otro valor, o una sin sus requisitos, hace fallar el render sin aplicar nada.
Las pone **únicamente el propietario** con `deploy.sh`; ningún agente crea el token, toca Secret Manager o IAM, exporta
estas variables ni despliega. `--desde-activa` las conserva en los despliegues siguientes.

- **Token del calendario.** El secreto va en la URL del enlace (`?token=<secreto>`); a Secret Manager va solo su SHA-256
  (`project-os-calendario-ics-token-sha256`), y el servidor compara el SHA-256 del secreto recibido con
  `CALENDARIO_ICS_TOKEN_SHA256` en tiempo constante. Si ese hash es igual al del PM, de Tiempos o de finanzas, no vale.
  Sin `PLANIFICACION_ICS=true`, sin hash válido, sin `token` o con uno que no coincide, la ruta responde 404 sin leer la
  hoja. Solo alcanza esa ruta y ese método; no abre otra ruta ni escribe. Límite conocido: la URL, con el secreto, queda
  en los registros de solicitudes de Cloud Run; por eso el secreto solo da lectura del calendario y se rota.
- **Exención en el proxy.** El proxy (`web/src/lib/authz.ts`, función `decide`) deja pasar sin sesión **una sola**
  combinación: método `GET` y ruta exactamente `/api/planificacion/calendario.ics` (comparación exacta, sin prefijos,
  sin barra final ni otras extensiones; la cadena de consulta no cuenta para la ruta). La exención no va en
  `isPublicPath` de `web/src/lib/access.ts`, que vale para cualquier método. El proxy no valida el secreto ni lee la hoja:
  lo hace la ruta, que responde 404 en los casos de arriba. Cualquier otro método en esa ruta (`POST`, `HEAD`, etc.) y
  cualquier otra ruta, incluida `/api/planificacion`, siguen el camino normal y piden sesión (401 en API, redirección a
  `/login` en páginas). La exención tampoco amplía el token de Tiempos: `TIEMPOS_AGENTE_RUTA` sigue siendo exactamente
  `/api/planificacion` y solo `GET`.

```bash
# Activar (solo el propietario, en Cloud Shell, con la imagen que trae el calendario desplegada)
TOKEN="$(openssl rand -hex 32)"
printf '%s' "$TOKEN" | sha256sum | cut -d' ' -f1 | tr -d '\n' | gcloud secrets create project-os-calendario-ics-token-sha256 \
  --project="$PROJECT_ID" --replication-policy=automatic --data-file=-
gcloud secrets add-iam-policy-binding project-os-calendario-ics-token-sha256 --project="$PROJECT_ID" --condition=None \
  --member="serviceAccount:${RUNTIME_SA}" --role=roles/secretmanager.secretAccessor --format=none
# El enlace <url del dashboard>/api/planificacion/calendario.ics?token=$TOKEN va solo a la app de calendario del propietario; bórralo de aquí:
unset TOKEN
export PLANIFICACION_ICS=true SECRET_VERSION_CALENDARIO_ICS=1
web/deploy/cloudrun/deploy.sh --desde-activa --dry-run   # debe listar «+ PLANIFICACION_ICS» y «+ CALENDARIO_ICS_TOKEN_SHA256»
web/deploy/cloudrun/deploy.sh --desde-activa             # escribe «desplegar» para aplicar
```

La edición se enciende y se revierte como dice §10 («Activar» y «Revertir»), con la misma bandera y el mismo correo;
esta sección no añade otro paso. Con el código de ORD-POS-139 a 142 desplegado, esa bandera enciende además las tres
operaciones nuevas, que esperan las migraciones de §11.2.

- **Enlace en la vista (ORD-POS-142).** El servidor solo tiene el SHA-256, así que no puede mostrar el secreto: el panel
  «Calendario (solo lectura)» de `/planificacion`, solo para la sesión del propietario, muestra el enlace con el secreto
  oculto (`?token=••••••••`) y «Copiar enlace» lo arma en el navegador con el secreto que el propietario pega en un campo
  de contraseña; el secreto no se envía al servidor ni se guarda. Avisa que Google Calendar relee el enlace cada varias
  horas. Apagado, el panel dice «Calendario apagado».
- **Rotar.** Token nuevo como arriba, `gcloud secrets versions add project-os-calendario-ics-token-sha256 --data-file=-`,
  despliegue con la nueva `SECRET_VERSION_CALENDARIO_ICS` y, después, `gcloud secrets versions disable <anterior>`. El
  enlace viejo responde 404; el propietario cambia la suscripción en su calendario.
- **Revertir.** `deploy.sh --desde-activa --quitar PLANIFICACION_ICS` (quita también el hash); la edición, como en §10
  («Revertir»). Lo ya escrito no se
  deshace solo: el propietario lo corrige en la hoja con `AUDITORIA` como guía.

### 11.4 Idempotencia (criterio 4)

| Operación | Clave | Reintento | Choque |
| --- | --- | --- | --- |
| `capacidad.registrar` | `requestId` (UUID v4) + `SEMANA_ID` | Mismo `requestId` y hash: `repetida`, o completa lo auditado (roll-forward, contrato §8) | Alta de un `SEMANA_ID` que ya existe: 409 `conflicto-concurrente` |
| `plan.dia.guardar` | `requestId` + `FECHA` | Igual; los `PLAN_ITEMS` se completan con lo auditado | Dos planes activos para la fecha o `VERSION` distinta: 409 |
| `escenario.guardar` | `requestId` | Igual; no crea otra fila | Mismo `requestId` con otro cuerpo: 409 `conflicto-idempotencia` |
| `escenario.archivar` | `requestId` + `ESCENARIO_ID` | Igual; completa lo auditado si la fila sigue en la versión anterior | `VERSION` distinta: 409 `conflicto-version` |

- **IDs estables.** `PLAN_ID` = `PLAN-AAAA-MM-DD` de su fecha; `PLAN_ITEM_ID` = `<PLAN_ID>-<TAREA_ID>`, de modo que volver
  a poner una tarea en el día reutiliza su fila; `ESCENARIO_ID` = `ESC-NNN`, el siguiente de la columna A. Las filas
  existentes conservan su ID.
- **Calendario.** `UID` estable por tarea y fecha: `<TAREA_ID>-<AAAA-MM-DD>-plan@project-os` para el evento del plan y
  `<TAREA_ID>-<AAAA-MM-DD>-vence@project-os` para el vencimiento. La misma tarea en la misma fecha es siempre el mismo
  evento; si cambia de fecha, el evento de la fecha anterior deja de salir y aparece otro con el `UID` de la nueva.
  `DTSTAMP` sale de la hoja (el `ACTUALIZADO_EN` del plan o de la tarea), nunca del reloj. Pedir el calendario dos veces
  el mismo día da el mismo archivo si la hoja no cambió.

### 11.5 Qué sale en el calendario y qué nunca (criterio 5)

Eventos de día completo (`DTSTART;VALUE=DATE`) de los próximos 14 días: hoy y los 13 siguientes, en fecha civil de
Mérida (`America/Merida`, la zona del motor). Dos clases de evento, nada más:

- **Plan:** por cada ítem de `PLAN_ITEMS` registrado en un plan de `PLAN_DIARIO` de esa fecha, un evento con `SUMMARY` =
  `<TITULO> · <TAREA_ID> · <MINUTOS_PLAN> min` (por ejemplo «Revisar contrato · POS-045 · 45 min»), con sus minutos tal
  como están en la hoja. Un ítem con `MINUTOS_PLAN` = `0` (tarea quitada del día, §11.1) o vacío no sale: vacío ≠ 0 y
  nunca se inventan minutos. `UID` `<TAREA_ID>-<AAAA-MM-DD>-plan@project-os` (§11.4).
- **Vencimiento:** por cada tarea abierta con `FECHA_LIMITE` dentro de la ventana, un evento con `SUMMARY` =
  `Vence: <TITULO> · <TAREA_ID>` en esa fecha. `UID` `<TAREA_ID>-<AAAA-MM-DD>-vence@project-os` (§11.4).
- **Sin plan registrado** para un día, ese día solo tiene vencimientos; `FECHA_PLAN` o `HORAS_ESTIMADAS` no generan
  eventos por sí solas. Las tareas `COMPLETADO` y `CANCELADO` no salen.
- **Sale:** solo `SUMMARY`, la fecha, `UID` y `DTSTAMP`; sin `DESCRIPTION`.
- **Nunca sale:** `DESCRIPCION`, `INSTRUCCIONES`, `NOTAS`, `CRITERIO_TERMINADO`, `BLOQUEO`, `RESPONSABLE`, correos
  (sin `ORGANIZER` ni `ATTENDEE`), enlaces internos, `AUDITORIA`, `TIEMPOS`, `ESCENARIOS`
  ni datos de otras pestañas u otros libros: solo lee `TAREAS`, `PLAN_DIARIO` y `PLAN_ITEMS`.
- **Respuesta:** `Content-Type: text/calendar`, `Cache-Control: no-store` y `X-Robots-Tag: noindex`; texto escapado según
  RFC 5545. Es solo lectura: no usa Google Tasks y no hay ida y vuelta; un cambio en el calendario no toca la hoja.

## 12. Límite de filas y rotación de AUDITORIA (ORD-POS-143, ORD-POS-153)

El dashboard lee cada pestaña de la hoja maestra hasta `MAX_DATA_ROWS` filas de datos (5000, `web/src/lib/schema.ts`).
Si una pestaña pasa de ahí, la lectura falla (`503 lectura-fallida`, motivo `limite-filas`) y se bloquean todas las
escrituras que la leen. Pasó con `AUDITORIA` el 2026-11-04 (hallazgo DIS-01). `AUDITORIA` es la que más crece: cada
operación añade una fila por campo. Desde ORD-POS-153, `AUDITORIA` llena ya no bloquea: rota por periodo (§12.1).

- **Aviso al 80 %.** Si una escritura deja una pestaña escrita (que no sea la auditoría) con 4000 filas de datos o
  más, la respuesta ok trae `aviso`. El dashboard lo muestra junto a «Guardado», en los formularios, en la edición de
  /planificacion y en «Aplicar movimientos al plan». Las pestañas solo leídas no avisan.
- **En el tope, 503 sin escribir.** Antes de la primera escritura, si una pestaña leída por la operación ya tiene 5000
  filas, o si la pestaña donde se escribe las pasaría con las filas nuevas, la API responde `503 pestana-llena` con
  `detalle.pestana`. No se escribe nada, tampoco `AUDITORIA`. Lo mismo pasa antes de cada alta posterior. Vale para
  todas las pestañas menos la auditoría, que rota.
- **Límite conocido.** Los lanzamientos de revisión y corrección (`orden.supervision_*`) respetan el tope, pero su
  respuesta no lleva `aviso`.

### 12.1 AUDITORIA por periodo (ORD-POS-153)

`AUDITORIA` es una pestaña lógica (`web/src/lib/operations/auditoria-periodo.ts`). Sus pestañas físicas son la base
`AUDITORIA` y las de periodo `AUDITORIA_AAAA_MM` (mes de Mérida), con `_2`, `_3`… si rota más de una vez en el mismo mes.
La vigente es la más nueva.

- **Escritura.** El lote de la operación va a la vigente si cabe en 5000 filas. Si no, la API crea la siguiente
  pestaña con una migración explícita: `addSheet` con el título y el encabezado de la vigente, copiado tal cual, en la
  fila 1. La migración es idempotente: si la pestaña ya existe con ese encabezado no hace nada; si existe vacía le pone
  el encabezado; con otro encabezado falla. Después relee la pestaña nueva y escribe ahí el lote completo, sin partirlo.
  La pestaña anterior no se toca: ni se mueven ni se borran filas.
- **Fallo cerrado.** La auditoría sigue yendo antes que la entidad. Si no se puede crear o leer la pestaña nueva, la
  API responde `503 pestana-llena` (con `detalle.rotacion: "fallida"` y `detalle.pestanaNueva`) y no escribe nada. Si
  no se puede saber qué pestañas hay, `503 lectura-fallida`. Una pestaña creada sin encabezado no bloquea: se ignora al
  leer y la siguiente rotación la reusa.
- **Lectura.** La idempotencia por `requestId`, el roll-forward, la conciliación, /agentes, Inicio y /metricas leen la
  vigente y la anterior, con un solo encabezado. Si sus encabezados difieren, `esquema-invalido`. Un `requestId`
  auditado justo antes del cambio de pestaña sigue reconociéndose. Lo de pestañas más viejas ya no se ve (abajo).
- **Aviso.** La respuesta ok dice en qué pestaña escribe la auditoría cuando la operación rotó («sigue en la pestaña
  nueva `AUDITORIA_AAAA_MM`») o cuando la vigente pasa del 80 % («`AUDITORIA` escribe en …»). No pide archivar.
- **Permisos.** Crear la pestaña usa la misma cuenta de escritura (Editor del libro maestro); no hace falta otro permiso.
  La API solo crea pestañas cuyo nombre es `AUDITORIA` o `AUDITORIA_AAAA_MM[_N]`.

### Archivar AUDITORIA (opcional, solo el propietario, a mano)

Ya no hace falta para seguir escribiendo. Sirve para ordenar pestañas viejas. **Nunca por la API:** no hay ruta que
borre ni archive. Ningún agente lo hace. El límite no se sube.

1. **Pausa.** No escribas desde el dashboard ni con el PM mientras archivas.
2. **Respaldo.** En la hoja maestra: Archivo → Historial de versiones → Nombrar la versión actual, por ejemplo
   «antes de archivar AUDITORIA AAAA-MM-DD».
3. **Mover.** Mueve a otro libro solo las pestañas de auditoría que no son ni la vigente ni la anterior. Nunca borres
   filas de la vigente ni de la anterior. No renombres las pestañas `AUDITORIA_AAAA_MM`: el orden sale de su nombre.
4. **Comprobar.** Recarga el dashboard. Las vistas que leen `AUDITORIA` (órdenes, operaciones, Inicio) cargan sin
   error.

**Efectos sobre lo que no es la vigente ni la anterior** (la API no lo lee, esté o no archivado):

- Un `requestId` de ahí ya no se reconoce como repetido. Si se reenvía, se aplica otra vez.
- Una intención auditada sin efecto (`escritura-fallida` sin reintento) ya no se completa al reintentar. La
  conciliación tampoco la lista. Revisa que la conciliación no tenga pendientes cuando veas el aviso de rotación.
- Una cita «sí» del propietario usada por el PM (DEC-POS-011) ya no cuenta como usada para otra orden.
- Las reservas de lanzamiento caducan a las 2 horas: una rotación no les afecta.
- Las métricas, Inicio y /agentes solo cuentan lo que hay en la vigente y la anterior.

## 13. Bandeja de Gemini de /eco/pipeline (ORD-POS-155, DEC-POS-031)

DEC-POS-031 (enmienda de DEC-POS-030) deja que Gemini **proponga** proveedores y cotizaciones en una pestaña aparte del
libro de RADAROS, `PIPE_BANDEJA_GEMINI`, y que **solo el propietario** las confirme desde Compras > Bandeja. No cambia
quién escribe en `PIPE_*` ni las transiciones de estado. Diseño: [`diseno-eco-pipeline.md` §18](diseno-eco-pipeline.md#18-bandeja-de-gemini-ord-pos-155-pos-056).

- **Quién escribe.** La sesión del propietario (`ECO_PIPELINE_WRITER_EMAIL`), por las rutas de la escritura del pipeline:
  `POST /api/eco/pipeline/bandeja/<BAN-NNNN>/confirmar` (`eco.bandeja.confirmar`) y `…/rechazar`
  (`eco.bandeja.rechazar`). Mismo guard sin agente (§4.1 y §4.2 del diseño): con el token del PM o cualquier
  `Authorization`, 401 antes de leer sesión o cuerpo. Gemini no recibe ninguna credencial y el dashboard no lee Gmail.
- **Qué escribe.** Confirmar crea o actualiza el proveedor o la cotización con las operaciones de siempre (validación,
  `safeCellText`, rechazo de fórmulas, idempotencia por `requestId` y auditoría en `PIPE_AUDITORIA`) y luego marca la fila
  `CONFIRMADA` con el ID resultante. Rechazar la marca `RECHAZADA` y agrega el motivo al final de `NOTAS`. En la bandeja
  solo escribe `ESTADO_BANDEJA`, `RESULTADO_ID` y `NOTAS`; nunca agrega ni borra filas.
- **Apagada (por defecto).** Sin `ECO_BANDEJA_GEMINI=true` exacto: no hay enlace ni sección en Compras, el lector no pide
  la pestaña y las dos rutas responden 403 `operacion-no-permitida` sin leer sesión ni cuerpo.

### Activar (solo el propietario, en Cloud Shell)

Requisitos: la imagen que trae ORD-POS-155 desplegada, la escritura del pipeline activa (`ECO_PIPELINE_WRITE_MODE=sheets`)
y la migración de la pestaña aplicada a mano (diseño §18.1). `render.mjs` rechaza la bandera sin la escritura del
pipeline. Ningún agente exporta la variable ni despliega.

```bash
export ECO_BANDEJA_GEMINI=true
web/deploy/cloudrun/deploy.sh --desde-activa --dry-run   # debe listar «+ ECO_BANDEJA_GEMINI»
web/deploy/cloudrun/deploy.sh --desde-activa             # escribe «desplegar» para aplicar
```

Comprobar: en `/eco/pipeline` aparece «Bandeja» junto a Productos y Proveedores (solo para el propietario).

### Revertir

```bash
web/deploy/cloudrun/deploy.sh --desde-activa --quitar ECO_BANDEJA_GEMINI
```

Quitar `ECO_PIPELINE_WRITE_MODE` sin quitar también `ECO_BANDEJA_GEMINI` hace fallar el render: no se aplica nada. La
pestaña y sus filas se quedan como están.
