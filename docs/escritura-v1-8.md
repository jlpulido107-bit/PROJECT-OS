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

## 6. Acceso del agente PM (ORD-POS-027, DEC-POS-005)

Una sesión PM de Claude escribe por la misma API de operaciones con `Authorization: Bearer <token>`, sin cookie de sesión.
Sustituye la escritura interina con el conector (DEC-POS-006); retirarla es una orden aparte tras desplegar.

- **Token.** El servidor compara el SHA-256 del token con `PM_AGENT_TOKEN_SHA256` (64 hex) en tiempo constante. Sin la
  variable, o con token inválido, responde 401 sin decir el motivo. Token y cookie de sesión a la vez: 400. Generar el
  token, guardar el hash en Cloud Run y desplegar lo hace el propietario (riesgo ALTO, fuera de esta orden).
- **Permitido** (lista blanca): `tarea.crear`, `tarea.editar`, `decision.crear` (siempre PENDIENTE) y `orden.crear`
  (siempre BORRADOR, nunca ALTO). `tarea.editar` solo cambia `titulo`, `descripcion`, `prioridad`, `hitoId`,
  `fechaPlan`, `fechaLimite`, `horasEstimadas` y `criterioTerminado`, con control de VERSION.
- **Prohibido (403, no escribe nada):** aprobar, enviar, cancelar, registrar PR, revisar, cerrar y ejecutar órdenes,
  registrar tiempos y cualquier otro campo de tarea (`estado`, `bloqueo`, `tipo`, `responsable`).
- **Auditoría.** `ACTOR=agente-pm` y `;agente=pm` al final de `ORIGEN`. La idempotencia por `requestId` es la de siempre.
- **Frecuencia.** Límite propio (clave `agente-pm`): ráfaga de 5 y 1 operación por minuto; al excederlo, 429.
  El humano tiene ráfaga de 10 y 1 cada 20 s.
- **Revocar.** Borrar la variable `PM_AGENT_TOKEN_SHA256` y redesplegar: el acceso del agente queda deshabilitado
  (401). La escritura humana no se toca.
