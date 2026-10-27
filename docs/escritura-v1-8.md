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
  API vuelve a verificar token, operación, acción y campos.
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
  registrar tiempos y cualquier otro campo de tarea (`estado`, `bloqueo`, `tipo`, `responsable`). Tampoco puede fijar `bloqueo` al crear una tarea (403).
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

DEC-POS-023 (APROBADA, 2026-10-27, según el propietario al lanzar ORD-POS-106): el propietario puede marcar una tarea
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
