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
6. Corre `node scripts/smoke-remote.mjs --url "$SERVICE_URL"`: deben salir todas las comprobaciones en OK.

## 5. Reversión (en cualquier momento)

1. Para cortar la escritura: vuelve a desplegar **sin** `WRITE_MODE`. La lectura sigue igual.
2. Quita el acceso de `project-os-writer@…` en Compartir de la hoja.
3. Opcional:
   `gcloud iam service-accounts disable "$WRITE_SA" --project="$PROJECT_ID"`.
4. Para corregir datos, usa `AUDITORIA` como guía. El panel no borra registros.
