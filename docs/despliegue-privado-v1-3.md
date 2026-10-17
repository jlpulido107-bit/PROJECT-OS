# PROJECT-OS V1.6 — Despliegue privado de pruebas en Google Cloud Run (manual)

> **Actualización 2026-10-11:** PROJECT-OS V1.6 **ya está desplegado y operativo** en Cloud Run. El apartado **Estado (Misión 012)** que sigue es un **registro histórico de preparación** y no representa el estado actual. Ver [evidencia de puesta en producción](estado-produccion-v1-6-2026-10-11.md) para versión, URL, validaciones y pendientes. Los comandos del runbook siguen sujetos a autorizaciones específicas; esta actualización no autoriza ejecutarlos.

> El nombre del archivo se conserva desde V1.3 para no romper enlaces. El contenido corresponde a **V1.6**.

**Estado (Misión 012):**

- **Código:** listo en `main` (V1.3–V1.6 y CI unificada).
- **Infraestructura mínima (Puerta B):** ejecutada por el propietario con el script V3, en el proyecto
  `project-os-511102` y la región `northamerica-south1`. Según su reporte, la auditoría final fue correcta: existen el
  bucket de origen, el repositorio Docker, la cuenta runtime y los permisos mínimos de `project-os-build` (§1.1).
- **Puerta C (preparación):** procedimientos en [Puerta C](puerta-c-v1-6.md). **Ninguna operación de la Puerta C está
  autorizada ni ejecutada.**
- **Despliegue:** **no desplegado.** No hay imágenes, secretos ni servicio de Cloud Run.
- **Compilación (Misión 011):** Cloud Build exige la cuenta dedicada `project-os-build` (§3.4 y §5.5).
- **Autorización:** este documento **no autoriza** crear recursos facturables, habilitar facturación, publicar la
  app ni activar automatizaciones.
- **Ejecución:** cada bloque de comandos es para **revisión y ejecución humana**. No hay ningún script de
  aprovisionamiento ni de despliegue desde CI.

Documentos relacionados:

- [Preparación V1.6](despliegue-v1-6-preparacion.md): matriz de decisiones del propietario, auditoría estática,
  costos y regiones verificados con fuentes oficiales, y riesgos.
- [Checklist de aceptación](despliegue-v1-6-aceptacion.md): lo que se comprueba después de desplegar.
- [`analisis-hosting-v1-3.md`](analisis-hosting-v1-3.md): decisión de hosting.
- [`web/README.md`](../web/README.md): uso local.

## 1. Puertas de autorización

| # | Puerta | Quién decide | Estado |
| --- | --- | --- | --- |
| 1 | Código revisado y fusionado en `main`, sin merge automático | Usuario (revisión ChatGPT) | Completada: #6 (`82a7fa7`), #8, #10, #12 y #15 → `main` `372224f`, con CI de `push` en verde ([run 38010650421](https://github.com/jlpulido107-bit/PROJECT-OS/actions/runs/38010650421)) |
| 2 | Decisiones del propietario: proyecto, facturación, región, URL, correos, presupuesto y alertas ([matriz](despliegue-v1-6-preparacion.md#2-matriz-de-decisiones-del-propietario)) | Usuario | Pendiente (parcial: el proyecto y la región ya se usaron en la Puerta B; faltan D5–D11) |
| 3 | Crear recursos facturables (secciones 5.1–5.7) y desplegar | Usuario, autorización separada | Pendiente (parcial: infraestructura mínima de la Puerta B creada; Puerta C, build y despliegue sin autorizar) |
| 4 | Acceso regular tras el [checklist de aceptación](despliegue-v1-6-aceptacion.md), mantenimiento y revisión de costos | Usuario | Pendiente |

Completar una puerta **no** autoriza la siguiente. La Misión 010 solo prepara la puerta 2.

> **Nota (Misión 014):** esta tabla es el registro de **preparación** y no se reescribe. Las puertas 2 y 3 se
> ejecutaron con la autorización del propietario: despliegue del 2026-10-11, [registro](estado-produccion-v1-6-2026-10-11.md).
> La puerta 4 (acceso regular) sigue pendiente de la [aceptación](operacion-v1-6/acta-cierre-v1-6.md). Estado de los
> recursos: [línea base](operacion-v1-6/linea-base-v1-6.md).

### 1.1 Estado de los recursos

Las etiquetas significan:

- **Existente (Puerta B):** creado por el propietario.
- **Pendiente:** no existe todavía.
- **Requiere autorización:** su creación o cambio necesita una autorización expresa y separada.

Detalle de cada operación (comando, precondiciones, impacto, verificación y fallos): [Puerta C](puerta-c-v1-6.md).

| Recurso | Estado | Operación |
| --- | --- | --- |
| APIs `cloudbuild`, `artifactregistry`, `iam`, `storage` | Existente (Puerta B) | — |
| Bucket de origen `PROJECT_ID-project-os-build-src` (privado, 7 días, sin borrado diferido) | Existente (Puerta B) | — |
| Repositorio Docker `project-os` | Existente (Puerta B) | — |
| Cuenta runtime `project-os-dashboard-run` (sin roles ni claves) | Existente (Puerta B) | — |
| Cuenta `project-os-build` con `logging.logWriter`, `artifactregistry.writer` (repositorio) y `storage.objectViewer` (bucket) | Existente (Puerta B) | — |
| Política de limpieza del repositorio | Pendiente · Requiere autorización | Puerta C, C1 y C1v (**bloquea el primer build**) |
| APIs `run`, `secretmanager`, `sheets` | Pendiente · Requiere autorización | Puerta C, C2 |
| Presupuesto y alertas | Pendiente · Requiere autorización | Puerta C, C3 |
| Cliente OAuth de producción (sin URIs) | Pendiente · Requiere autorización | Puerta C, C4a |
| Origen y callback OAuth con la URL real verificada | Pendiente · Requiere autorización | Puerta 3: §5.7 (C4v y C4b) |
| Etiqueta `produccion` de la imagen desplegada | Pendiente · Requiere autorización | Puerta 3: §5.7 (C9) |
| 3 secretos y acceso de la cuenta runtime | Pendiente · Requiere autorización | Puerta C, C5 y C6 |
| Lector del Sheets maestro para la cuenta runtime | Pendiente · Requiere autorización | Puerta C, C7 |
| Imagen, servicio de Cloud Run e invocación pública | Pendiente · Requiere autorización | Puerta 3: §5.5–§5.7, después de C8 |

Las lecturas (C0, C1v, C8) no cambian nada; aun así, solo las ejecuta el propietario.

### Responsables

| Rol | Quién | Hace | No hace |
| --- | --- | --- | --- |
| Propietario | Usuario | Decide la matriz; crea el proyecto, la facturación y el cliente OAuth; ejecuta los comandos; acepta o revierte | — |
| Revisión | ChatGPT | Revisa el runbook, los riesgos y la evidencia | Ejecutar comandos |
| Preparación | Claude Code | Documenta, prepara el preflight y las pruebas estáticas | Usar `gcloud` contra un proyecto, crear recursos, desplegar o fusionar |

Los valores propuestos (proyecto dedicado, región, URL `run.app`, presupuesto) están ahora en la
[matriz de decisiones](despliegue-v1-6-preparacion.md#2-matriz-de-decisiones-del-propietario), **sin respuestas
asumidas**.

## 2. Arquitectura

```
Navegador ──HTTPS──▶ Cloud Run "project-os-dashboard" (min 0 / max 1, CPU por solicitud)
                      │  Páginas: Inicio, Control (V1.6), Proyectos, Tareas, Actividad, Capacidad y plan,
                      │  Planificación (V1.5). Operaciones (V1.4) sin escritura: bloqueada en Cloud Run
                      │  proxy.ts + cada página/API: sesión NextAuth (cookie __Secure-, JWE)
                      │  + AUTH_ALLOWED_EMAILS  → sin sesión válida: 307 a /login o 401/403
                      │
                      ├─ Secret Manager: NEXTAUTH_SECRET, GOOGLE_CLIENT_SECRET, AUTH_ALLOWED_EMAILS
                      │   (solo la cuenta de servicio del servicio puede leer esos 3 secretos)
                      │
                      └─ Identidad adjunta "project-os-dashboard-run" (ADC, sin clave JSON)
                          token con alcance spreadsheets.readonly ──GET──▶ Google Sheets maestro
                                                                         (compartido como Lector)
Google OAuth ◀──── /api/auth/callback/google (redirect URI HTTPS registrado explícitamente)
```

- **V1.4–V1.6 en producción:**
  - planificación y control son **solo lectura**: sus APIs solo exponen `GET` y sus propuestas no se aplican;
  - el modo `mock` de V1.4 está **prohibido en Cloud Run** (`K_SERVICE`);
  - `sheets` está bloqueado en código;
  - si la revisión define `PROJECT_OS_WRITE_MODE` (distinto de `disabled`) o `AUTH_WRITER_EMAILS`, la sonda
    responde 503 y la revisión **no recibe tráfico**.
- **Fechas:** planificación y control calculan "hoy" en `America/Merida`, sin depender de la zona horaria del
  contenedor (UTC en Cloud Run).
- **Fuente de datos:** Google Sheets sigue siendo la única fuente operativa. No hay base de datos adicional;
  solo una caché en memoria de 60 s por instancia.
- **Solo lectura, en tres capas:** cliente HTTP que solo emite `GET`, token con alcance
  `spreadsheets.readonly` y la cuenta de servicio con rol **Lector** en un único documento.
- **Imagen:** `web/Dockerfile`, multi-stage, Next.js `standalone`, Node 22 fijado por digest, usuario `node`
  (uid 1000) y código de solo lectura. Sin `.env`, claves, pruebas ni `.git` (`.dockerignore` con lista de
  permitidos). Unos 104 MB comprimida.
- **Sonda:** `GET /api/health` es pública y no lee Sheets ni la sesión. Responde solo
  `{"status":"ok"}` (200) o `{"status":"unavailable"}` (503). Una revisión con configuración insegura (URL
  sin HTTPS, clave JSON, datos sintéticos, falta de la cuenta esperada o de secretos, o un modo de
  escritura de V1.4 activo) **no supera la sonda de
  arranque y no recibe tráfico**.
  - **Límite:** la sonda solo valida la **configuración** (variables y política de credenciales). `/api/health`
    **no prueba OAuth ni el acceso real a Google Sheets**, y tampoco que Secret Manager responda. Eso se acepta
    después de desplegar ([checklist](despliegue-v1-6-aceptacion.md)). Un 200 en `/api/health` no equivale a
    "funciona".

### "Invocable desde Internet" no significa "datos públicos"

Para que Google OAuth funcione, el navegador debe alcanzar `/login` y `/api/auth/*`. Por eso el servicio
se despliega con `ingress: all` y el rol `roles/run.invoker` para `allUsers`. Eso **solo** expone la
superficie HTTP. Todas las páginas privadas y `/api/resumen` exigen una sesión válida de un correo
permitido, verificada en `proxy.ts` y otra vez en cada página y API. Sin sesión no se lee Sheets.

- Las únicas rutas públicas son `/login`, `/api/auth/*`, `/api/health`, `/robots.txt` y los archivos
  estáticos de Next. Las 13 páginas privadas y las 7 APIs privadas (incluidas `/api/planificacion`,
  `/api/control` y `/api/operaciones/*`) responden 307 a `/login` o 401 sin sesión. `npm run smoke:remote` lo
  comprueba.
- `roles/run.invoker` para `allUsers` **no** reemplaza la autenticación de usuarios.
- Si se quiere ocultar también la pantalla de login de Internet, la opción es **IAP** u otra capa (por
  ejemplo una VPN). Las alternativas, con su estado verificado, están en
  [preparación §3.6](despliegue-v1-6-preparacion.md#36-invocación-pública-frente-a-login-privado).

## 3. Identidades y permisos mínimos

### 3.1 Cuenta de servicio del servicio (runtime)

`project-os-dashboard-run@PROJECT_ID.iam.gserviceaccount.com`:

- **Sin ningún rol de proyecto.** No usar la cuenta por defecto de Compute, que suele tener rol Editor.
- `roles/secretmanager.secretAccessor` **solo** sobre los 3 secretos de la sección 5.6.
- **Lector** del Sheets maestro, compartido desde Google Sheets. No compartir otros documentos ni carpetas.
- La app exige `SHEETS_EXPECTED_SERVICE_ACCOUNT` igual a esta cuenta. Si Cloud Run ejecutara con otra
  identidad, la lectura falla con un error de configuración y no hay fallback.
- **Nunca** se crea una clave JSON para esta cuenta.

### 3.2 Quien despliega (persona)

Para el aprovisionamiento inicial, lo más simple es la cuenta propietaria del proyecto. Para despliegues
posteriores basta con:

- `roles/run.admin`
- `roles/iam.serviceAccountUser` **sobre la cuenta runtime** (no sobre el proyecto)
- `roles/artifactregistry.writer` sobre el repositorio
- `roles/secretmanager.secretVersionAdder` para rotar secretos
- Solo si se construye con Cloud Build (D10-b), ver §3.4:
  - `roles/cloudbuild.builds.editor`;
  - `roles/iam.serviceAccountUser` **sobre la cuenta de compilación**, no sobre el proyecto;
  - escritura de objetos en el bucket de origen.

GitHub Actions **no** recibe credenciales de Google Cloud.

### 3.3 Política de credenciales de la app (`SHEETS_CREDENTIALS`)

| Entorno | Valor | Credencial | Reglas |
| --- | --- | --- | --- |
| Cloud Run | `adc` | Identidad adjunta (metadata server) | Exige `SHEETS_EXPECTED_SERVICE_ACCOUNT`. Prohíbe `PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_*` y `GOOGLE_APPLICATION_CREDENTIALS` |
| Local (V1.2) | `service-account-key` (o vacío con clave configurada) | Clave JSON **fuera del repo** | Prohibido si existe `K_SERVICE` (Cloud Run) |
| Local opcional | `adc` | `gcloud auth application-default login --impersonate-service-account=…` | Con `SHEETS_EXPECTED_SERVICE_ACCOUNT`, una credencial de usuario normal es rechazada |

No hay fallback silencioso: si la variable falta y no hay clave, la app no lee datos y lo indica.

### 3.4 Cuenta de compilación (Cloud Build, opción D10-b)

`project-os-build@PROJECT_ID.iam.gserviceaccount.com`. Solo construye y sube la imagen; **no despliega**.

| Permiso | Ámbito | Para qué |
| --- | --- | --- |
| `roles/logging.logWriter` | Proyecto (el único rol de proyecto) | Con una cuenta propia, Cloud Build exige guardar los logs en Cloud Logging o en un bucket propio. Aquí, solo Cloud Logging |
| `roles/artifactregistry.writer` | Solo el repositorio `project-os` | Subir la imagen |
| `roles/storage.objectViewer` | Solo el bucket de origen `PROJECT_ID-project-os-build-src` | Leer el código subido |

- **Nunca** Editor, Propietario ni roles sobre Cloud Run, Secret Manager o la hoja. No actúa como la cuenta runtime.
- La identidad se exige en **cuatro capas**:
  1. **Configuración:** `web/deploy/build-command.mjs` convierte `web/deploy/cloudbuild.template.yaml` en un YAML
     **literal** del proyecto. Ese YAML declara `serviceAccount: projects/PROJECT_ID/serviceAccounts/project-os-build@…`
     y no conserva ninguna interpolación de Cloud Build: solo el escape documentado `$$` del script.
  2. **Comando:** el mismo generador imprime `gcloud builds submit` con `--project=PROJECT_ID` explícito, para no
     depender del proyecto activo de gcloud, y `--service-account` con **la misma** cuenta.
     - Rechaza las cuentas predeterminadas (Compute, la heredada de Cloud Build, App Engine) y la runtime.
     - En el SDK local, `--service-account` solo sobrescribe `serviceAccount` de la configuración
       (`submit_util._SetServiceAccount`); con el mismo valor no hay conflicto.
  3. **Paso `verificar-identidad`:** es el primer paso del build. Consulta al metadata server con qué cuenta corre el
     build y lo **aborta antes de construir o subir** si no es la dedicada. Es una defensa adicional por si se enviara
     otra configuración o se omitiera la cuenta.
  4. **IAM:** aunque algo fallara, la cuenta dedicada solo tiene los tres permisos acotados de la tabla.
- **La plantilla no se envía tal cual.** Sus marcadores `__PROJECT_ID__`, `__BUILD_SERVICE_ACCOUNT__` e
  `__IMAGE_TAG__` no forman una cuenta ni una imagen válidas: si alguien la enviara sin generar, el build no tendría
  identidad válida y el paso 3 abortaría.
- No se crean *triggers*: en los builds lanzados por *triggers*, el campo `serviceAccount` de la configuración se
  ignora.
- **La comprobación contra el metadata server solo está simulada.** `web/tests/cloudbuild.test.ts` ejecuta el
  script real del paso 3 con un `curl` falso, con la cuenta dedicada, las predeterminadas, la runtime, la de otro
  proyecto, una respuesta vacía y sin respuesta. **Necesita una prueba real posterior, con autorización** (puerta 3):
  el primer build debe registrar *"Identidad de compilación verificada"* (checklist A8). Hasta entonces no se sabe si
  el metadata server responde dentro del build; si no responde, el build falla cerrado.

## 4. Costos

Los precios, niveles gratuitos, regiones y su fecha de verificación (2026-10-10) están en
[preparación §4](despliegue-v1-6-preparacion.md#4-costos-y-regiones-verificados), con fuentes oficiales y nivel de
confianza.

La estimación se hace **por escenario** y no es una promesa ni un techo
([§4.3](despliegue-v1-6-preparacion.md#43-estimación-de-costo-por-escenario-no-es-una-promesa-ni-un-techo)):

- Con la carga esperada de 1–2 personas, la cifra depende de si quedan niveles gratuitos en la cuenta de
  facturación, porque se cuentan **por cuenta**, no por proyecto:
  - si quedan, ≈ USD 0;
  - si otros proyectos ya los consumen, ≈ USD 0,45, más salida a Internet y builds.
- Con tráfico anómalo o bots, o con la instancia ocupada de forma continua, el gasto **puede superar USD 1 o USD
  5**. El techo teórico de cómputo con `maxScale: 1` es ≈ USD 65 al mes, más solicitudes y salida a Internet.
- Las dos regiones candidatas son Tier 1 en Cloud Run.

### Compilación (Cloud Build) y verificación de costos

- **Nivel gratuito:** 2 500 minutos de build al mes por cuenta de facturación (e2-standard-2). Después, unos USD
  0,006 por minuto ([preparación §4.1](despliegue-v1-6-preparacion.md#41-precios-y-niveles-gratuitos)).
- **Contar los builds y su duración:**
  `gcloud builds list --project="$PROJECT_ID" --region "$BUILD_REGION" --format='table(id,createTime,finishTime,status)'`.
- **Facturación:** en *Facturación → Informes*, filtra por el proyecto y por los servicios *Cloud Build*, *Cloud
  Storage* y *Artifact Registry*.
- **Almacenamiento:** el bucket de origen se vacía solo a los 7 días y sin borrado diferido, y la política de
  Artifact Registry conserva 3 versiones. Los logs de build entran en los 50 GiB gratuitos de Cloud Logging.
- **Alternativa sin Cloud Build:** Docker local (D10-a). No crea la cuenta, el bucket ni los minutos de build.

### Controles

- `maxScale: 1`, `minScale: 0`, `cpu-throttling: true`, 1 vCPU y 512 MiB (subir a 1 GiB solo si una prueba
  real lo exige).
- Presupuesto con alertas (importe y umbrales: decisiones D6 y D7; la sección 5.2 usa USD 5 y 50/90/100 % como
  ejemplo). **Las alertas avisan; no son un límite duro.** Los presupuestos con tope para Cloud Run están en
  Preview: solo se evaluarán como decisión aparte
  ([preparación §4.4](despliegue-v1-6-preparacion.md#44-presupuestos-y-alertas)).
- Al rotar secretos, **destruir** las versiones antiguas: las deshabilitadas siguen contando como activas.
- Política de limpieza de Artifact Registry (`web/deploy/cloudrun/artifact-cleanup-policy.json`): conserva las imágenes
  `produccion` y `produccion-anterior` y las 3 más recientes, y borra el resto a los 30 días.
- Revisión manual mensual en *Facturación → Informes*.
- Para detener el gasto por completo, ver la sección 7.

## 5. Despliegue manual paso a paso (requiere las puertas 2 y 3)

### 5.-1 Preflight local (sin Google Cloud; repetir el mismo día del despliegue)

1. `git fetch origin main && git checkout <SHA aprobado>`. El SHA debe ser el de `main` con CI de `push` en verde
   (jobs `web` y `docker`).
2. Desde `web/`:
   - `npm ci && npm run lint && npm run typecheck && npm test && npm run build`;
   - las cinco suites E2E (`test:e2e`, `:ops`, `:planning`, `:control`, `:integration`);
   - `npm run docker:smoke`.
3. `npx vitest run tests/deploy-template.test.ts tests/deploy-docs.test.ts`. Comprueba plantilla sin escritura,
   documentación sin datos sensibles, puertas y cobertura del smoke remoto.
4. `gcloud version` ≥ 570.0.0. Vuelve a revisar precios y regiones con las
   [referencias oficiales](despliegue-v1-6-preparacion.md#4-costos-y-regiones-verificados) si pasaron más de 30
   días desde su fecha de verificación.
5. Ten a mano la [matriz de decisiones](despliegue-v1-6-preparacion.md#2-matriz-de-decisiones-del-propietario)
   completada **fuera del repositorio**: correos e ID de facturación no se escriben aquí.

> Ejecutar en una terminal **bash** con `gcloud` autenticado como la persona que despliega, desde la raíz del
> repo y en la versión fusionada en `main`. Ningún comando imprime secretos. Revisa cada bloque antes de
> ejecutarlo.

> **Comandos verificados de forma estática** con Google Cloud SDK 570.0.0, sin llamadas a GCP:
> - cada comando y flag de esta sección existe en la ayuda local (`gcloud … --help`);
> - `--no-dry-run` existe porque `--dry-run` es un booleano de tres estados en la definición del SDK;
> - la política de `artifact-cleanup-policy.json` se procesa con el parser del propio SDK.
>
> **No se ejecutaron contra un proyecto real.** Usa esa versión o una posterior (`gcloud version`) y revisa
> cada error antes de continuar.

### 5.0 Variables (no secretas)

```bash
export PROJECT_ID="project-os-511102"          # proyecto usado en la Puerta B
export REGION="northamerica-south1"            # región usada en la Puerta B
export SERVICE_NAME="project-os-dashboard"
export REPO="project-os"
export RUNTIME_SA="project-os-dashboard-run@${PROJECT_ID}.iam.gserviceaccount.com"
export PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
# URL determinista de Cloud Run (se conoce antes del primer despliegue):
export SERVICE_URL="https://${SERVICE_NAME}-${PROJECT_NUMBER}.${REGION}.run.app"
gcloud config set project "$PROJECT_ID"
```

### 5.1 Proyecto y facturación (consola, decisión del usuario)

Crear o seleccionar el proyecto y vincular la cuenta de facturación en *Facturación → Gestionar
proyectos*.

### 5.2 Presupuesto y alertas

> **Estado:** pendiente: operación C3 de la [Puerta C](puerta-c-v1-6.md). Se recomienda la consola; el comando de
> abajo exige además habilitar `billingbudgets.googleapis.com`.

```bash
export BILLING_ACCOUNT="XXXXXX-XXXXXX-XXXXXX"   # Facturación → Cuentas
gcloud billing budgets create --billing-account="$BILLING_ACCOUNT" \
  --display-name="project-os-dashboard" --budget-amount=5USD \
  --filter-projects="projects/${PROJECT_ID}" \
  --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0
```

### 5.3 APIs mínimas

> **Estado:** `artifactregistry` (y `cloudbuild`, `iam` y `storage`) ya están habilitadas por la Puerta B. Las
> pendientes (`run`, `secretmanager`, `sheets`) son la operación C2 de la [Puerta C](puerta-c-v1-6.md).

```bash
# Solo las pendientes (C2, requiere autorización):
gcloud services enable run.googleapis.com secretmanager.googleapis.com sheets.googleapis.com --project="$PROJECT_ID"
```

### 5.4 Cuenta de servicio runtime y acceso de solo lectura a la hoja

> **Estado:** la cuenta runtime **ya existe** (Puerta B), sin roles ni claves. Este runbook ya no incluye el comando
> para crearla. Solo queda la verificación de solo lectura. Compartir la hoja es la operación C7 de la
> [Puerta C](puerta-c-v1-6.md).

```bash
# Solo lectura. La cuenta existe y no está deshabilitada (esperado: False):
gcloud iam service-accounts describe "$RUNTIME_SA" --project="$PROJECT_ID" --format='value(disabled)'
# No tiene roles de proyecto (la salida debe estar vacía):
gcloud projects get-iam-policy "$PROJECT_ID" --flatten='bindings[].members' \
  --filter="bindings.members:serviceAccount:${RUNTIME_SA}" --format='value(bindings.role)'
```

Compartir la hoja (C7): en Google Sheets, abre el maestro y pulsa **Compartir**. Pega el correo de `RUNTIME_SA` con
rol **Lector**, desmarca *Notificar* y deja **Acceso general: Restringido**.

### 5.5 Artifact Registry y la imagen

> **Estado:** el repositorio Docker `project-os` **ya existe** (Puerta B), **sin** política de limpieza. Este runbook
> ya no incluye el comando para crearlo. La política se aplica y se verifica **solo** con el script de la Puerta C (C1
> y C1v).

```bash
export IMAGE_BASE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/dashboard"
export IMAGE_TAG="${IMAGE_BASE}:$(git rev-parse --short HEAD)"
```

**Bloqueo antes del primer build o push.** El repositorio se creó con el script de infraestructura mínima, que no
aplica la política de limpieza. Antes de **cada** sesión de compilación o subida:

```bash
bash web/deploy/infra/limpieza-artifact-v1-6.sh --check   # solo lectura; debe terminar con PERMITIDO (código 0)
# Si dice BLOQUEADO, NO compiles ni subas imágenes. Aplicar la política es la operación C1 (Puerta C), con
# autorización: bash web/deploy/infra/limpieza-artifact-v1-6.sh --apply
# Consulta manual equivalente (solo lectura), si hiciera falta:
gcloud artifacts repositories list-cleanup-policies "$REPO" --project="$PROJECT_ID" --location="$REGION"
# Esperado: conservar-produccion, conservar-3-recientes y borrar-mayores-30-dias, con "Dry run is disabled."
```

**Opción A — Cloud Build con cuenta dedicada (D10-b).** Usa minutos de build. La configuración generada declara la
cuenta, verifica la identidad y fuerza BuildKit y `linux/amd64`. Todos los comandos fijan `--project`, para no
depender del proyecto activo de gcloud.

A.1 Identidad, permisos mínimos y bucket de origen (§3.4): **ya existen** (Puerta B).

> **Estado:** los creó el propietario con el [script de infraestructura mínima](infra-minima-v1-6-revision.md):
>
> - la cuenta `project-os-build` con sus tres permisos acotados;
> - el bucket de origen, privado, sin borrado diferido y con el ciclo de vida de
>   `web/deploy/cloudbuild-source-lifecycle.json`;
> - la API `cloudbuild`.
>
> Este runbook ya **no** incluye los comandos para crearlos; para conciliar diferencias, ver la revisión de ese script.
> No se concede `actAs` (`roles/iam.serviceAccountUser`) a ninguna persona: la cuenta propietaria ya puede actuar
> como la cuenta de compilación. Solo haría falta si compilara otra persona (decisión D-C3 de la
> [Puerta C](puerta-c-v1-6.md)), y entonces sobre esa cuenta concreta, nunca sobre el proyecto.

```bash
# Solo lectura.
export BUILD_REGION="$REGION"   # Cloud Build y Cloud Storage admiten las dos regiones candidatas (nota más abajo)
export BUILD_SA="project-os-build@${PROJECT_ID}.iam.gserviceaccount.com"
export BUILD_BUCKET="${PROJECT_ID}-project-os-build-src"
# Esperado: solo roles/logging.logWriter (nunca roles/editor ni roles/owner).
gcloud projects get-iam-policy "$PROJECT_ID" --flatten='bindings[].members' \
  --filter="bindings.members:serviceAccount:${BUILD_SA}" --format='value(bindings.role)'
# Esperado: el bucket existe en $BUILD_REGION (no se imprime su política).
gcloud storage buckets describe "gs://${BUILD_BUCKET}" --project="$PROJECT_ID" --format='value(location)'
```

A.2 En cada compilación:

```bash
# Prueba en seco, local y sin GCP: lista exactamente lo que se subiría al bucket de origen.
# Esperado: .dockerignore, Dockerfile, package.json, package-lock.json, next.config.ts, tsconfig.json y src/.
gcloud meta list-files-for-upload web
# Genera la configuración literal y el comando (sin GCP). Falla si falta algo o si se pide otra identidad.
node web/deploy/build-command.mjs --config-out=/tmp/project-os-cloudbuild.yaml
less /tmp/project-os-cloudbuild.yaml   # revisión humana: serviceAccount, cuenta esperada e imagen del proyecto
# Revisa la salida y ejecútala. Debe coincidir con esto:
gcloud builds submit web \
  --project="$PROJECT_ID" \
  --config=/tmp/project-os-cloudbuild.yaml \
  --region="$BUILD_REGION" \
  --service-account="projects/${PROJECT_ID}/serviceAccounts/${BUILD_SA}" \
  --gcs-source-staging-dir="gs://${BUILD_BUCKET}/source"
rm /tmp/project-os-cloudbuild.yaml
```

- `--config-out` solo acepta rutas absolutas terminadas en `.yaml` o `.yml` con letras, dígitos, `.`, `_`, `-` y
  `/`, sin segmentos `.` ni `..`. El comando impreso no contiene caracteres con significado para el shell (comillas,
  `$`, `;`, backticks…) y se puede pegar tal cual.
- **Nunca** se envía un build sin la configuración generada y sin `--service-account`: Cloud Build usaría la
  cuenta predeterminada. Si ocurre, el paso `verificar-identidad` aborta el build antes de construir o subir.
- **Logs:** solo en Cloud Logging (*Cloud Build → Historial* o *Logs Explorer*). Si la terminal no los muestra,
  se consultan en la consola. El log del primer build debe decir *"Identidad de compilación verificada"*.
- **Origen:** `--gcs-source-staging-dir` evita el bucket predeterminado `PROJECT_ID_cloudbuild`, que es
  multirregional y no se limpia solo. El bucket propio borra lo subido a los 7 días y no conserva copias
  borradas (`--soft-delete-duration=0`).
- **Región:** `--region` usa un pool regional de Cloud Build, y `BUILD_REGION=REGION`.
  - La documentación oficial incluye `northamerica-south1` (México) tanto para Cloud Build como para Cloud Storage
    (verificado el 2026-10-10):
    - la [página de precios de Cloud Build](https://cloud.google.com/build/pricing) la lista entre sus regiones
      (leída directamente) [A];
    - las [ubicaciones de buckets de Cloud Storage](https://cloud.google.com/storage/docs/locations) la incluyen
      como región única de Querétaro [M].
  - `us-central1` también figura en ambas.
  - La región sigue siendo la decisión **D3** del propietario: este cambio no elige región ni crea recursos.
  - `BUILD_REGION` puede ser distinta de `REGION`. La imagen sigue en el repositorio de `REGION`, y el cambio
    puede generar un cargo menor por transferencia entre regiones.
- `--config` se lee **localmente** y se envía con la petición de build, por lo que no necesita estar
  dentro del código subido.
- `web/.gcloudignore` es una lista de permitidos. Sin ella, gcloud subiría todo lo que no excluya
  `.gitignore`: un `.env` o una clave JSON dejados por error en `web/` terminarían en el bucket. Se
  comprobó con la prueba en seco anterior.
- Docker aplica después su propio `.dockerignore` dentro del build.

**Opción B — Docker local:**

```bash
gcloud auth configure-docker "${REGION}-docker.pkg.dev"
docker build --platform linux/amd64 -t "$IMAGE_TAG" web
docker push "$IMAGE_TAG"
```

Fija la imagen por digest (inmutable):

```bash
export IMAGE="${IMAGE_TAG%:*}@$(gcloud artifacts docker images describe "$IMAGE_TAG" --format='value(image_summary.digest)')"
```

Antes de subir la imagen, valida localmente: `cd web && npm ci && npm run docker:smoke`.

### 5.6 Cliente OAuth de producción y secretos

> **Estado:** pendiente. Son las operaciones C4a (OAuth), C5 (secretos) y C6 (acceso) de la
> [Puerta C](puerta-c-v1-6.md), que añaden `--project`, la verificación previa al build y el procedimiento ante fallos.

> **Estado:** ningún inicio de sesión real contra Cloud Run se ha probado todavía. La primera evidencia es el
> checklist C1/C2. Una configuración de OAuth correcta en la consola no prueba que el login funcione.

1. **Pantalla de consentimiento** (*Google Auth Platform*), según la decisión D9:
   - **Caso interno.** Aplica si el proyecto pertenece a una organización de Google Workspace o Cloud Identity y
     todas las personas autorizadas tienen cuenta en esa organización. Tipo de usuario: **Interno**.
     - Solo las cuentas de la organización pueden autorizar la app.
     - No hay lista de usuarios de prueba ni límite de 100, ni pantalla de "app no verificada".
     - Un administrador de la organización puede tener que aprobar la app.
     - **`AUTH_ALLOWED_EMAILS` sigue siendo la autorización real.** *Interno* no da acceso a toda la
       organización: un correo de la organización que no esté en la lista es rechazado por la app.
     - Con organización, sus políticas pueden afectar al despliegue. La restricción *Domain Restricted Sharing*
       puede impedir `allUsers` en §5.7; en ese caso se usa la opción (c), `--no-invoker-iam-check`
       ([preparación §3.6](despliegue-v1-6-preparacion.md#36-invocación-pública-frente-a-login-privado)).
   - **Caso externo.** Aplica si no hay organización, por ejemplo con una cuenta personal; el tipo *Interno* no
     está disponible. Tipo de usuario: **Externo**, en estado *Prueba*, con los usuarios de prueba = D5.
2. En *Clientes*, crea un **ID de cliente OAuth nuevo** (Aplicación web), distinto del de localhost, **sin
   orígenes ni URI de redirección todavía** (operación C4a de la [Puerta C](puerta-c-v1-6.md)):
   - `$SERVICE_URL` es una URL **calculada**. No se registra hasta confirmar en §5.7 que Cloud Run la publica de
     verdad.
   - El origen y la redirección se añaden en §5.7 (C4b), **antes** de abrir la invocación pública.
   - Los cambios pueden tardar de minutos a horas en aplicarse: deja margen entre C4b y el primer login.
3. Copia el ID de cliente (no es secreto) a `OAUTH_CLIENT_ID`. El secreto del cliente se introduce de forma
   oculta:

```bash
export OAUTH_CLIENT_ID="NNNNNNNNNNNN-xxxxxxxx.apps.googleusercontent.com"

# Secreto de sesión NUEVO (no reutilizar el de localhost); nunca se muestra:
openssl rand -base64 32 | tr -d '\n' | gcloud secrets create project-os-nextauth-secret \
  --project="$PROJECT_ID" --replication-policy=automatic --data-file=-

# Secreto del cliente OAuth de producción (entrada oculta, no queda en el historial):
read -r -s -p "GOOGLE_CLIENT_SECRET de producción: " V; echo
printf '%s' "$V" | gcloud secrets create project-os-google-client-secret \
  --project="$PROJECT_ID" --replication-policy=automatic --data-file=-; unset V

# Correos permitidos (separados por coma), entrada oculta:
read -r -s -p "AUTH_ALLOWED_EMAILS: " V; echo
printf '%s' "$V" | gcloud secrets create project-os-allowed-emails \
  --project="$PROJECT_ID" --replication-policy=automatic --data-file=-; unset V

for s in project-os-nextauth-secret project-os-google-client-secret project-os-allowed-emails; do
  gcloud secrets add-iam-policy-binding "$s" --project="$PROJECT_ID" --condition=None \
    --member="serviceAccount:${RUNTIME_SA}" --role=roles/secretmanager.secretAccessor --format=none
done

export SECRET_VERSION_NEXTAUTH=1 SECRET_VERSION_OAUTH=1 SECRET_VERSION_ALLOWLIST=1
```

### 5.7 Desplegar desde la plantilla revisada

Acceso del agente PM (opcional, solo con `WRITE_MODE=sheets`): `export SECRET_VERSION_PM_AGENT=<versión>` antes de
`render.mjs`; compruébalo con `grep -c PM_AGENT_TOKEN_SHA256 /tmp/project-os-service.yaml` (`1` = activo). Para revocarlo,
despliega sin esa variable. Detalle en [`escritura-v1-8.md` §6](escritura-v1-8.md).

```bash
cd web
node deploy/cloudrun/render.mjs > /tmp/project-os-service.yaml   # valida formatos; falla si falta algo
less /tmp/project-os-service.yaml                                # revisión humana
gcloud run services replace /tmp/project-os-service.yaml --region "$REGION"
# El servicio todavía NO es invocable desde Internet: sin allUsers, IAM rechaza a los navegadores.
# 1) Verificación de la URL REAL (solo lectura). Debe listar exactamente $SERVICE_URL:
gcloud run services describe "$SERVICE_NAME" --region "$REGION" --format='yaml(status.url,metadata.annotations)'
gcloud run services describe "$SERVICE_NAME" --region "$REGION" \
  --format='value(metadata.annotations."run.googleapis.com/urls")' | tr ',' '\n' | grep -Fx -- "$SERVICE_URL" \
  || echo "DETENTE: Cloud Run no publica $SERVICE_URL (ver la nota de abajo)"
# 2) Solo si la verificación anterior encontró la URL, registra en el cliente OAuth (consola, C4b):
#    origen = $SERVICE_URL; redirección = $SERVICE_URL/api/auth/callback/google. Espera a que se propague.
# 3) Después, invocación pública para el navegador (los datos siguen tras login + allowlist):
gcloud run services add-iam-policy-binding "$SERVICE_NAME" --region "$REGION" \
  --member=allUsers --role=roles/run.invoker
# Caso interno: si una política de la organización rechaza allUsers, usa EN SU LUGAR (decisión D8-c):
# gcloud run services update "$SERVICE_NAME" --region "$REGION" --no-invoker-iam-check
rm /tmp/project-os-service.yaml
```

- Cloud Run asigna dos URLs: la determinista `https://SERVICIO-NUMERO_PROYECTO.REGION.run.app` y otra
  con hash (`status.url`). Las dos se ven en la anotación `run.googleapis.com/urls`.
- **Si `$SERVICE_URL` no aparece, detente: no registres el callback ni abras la invocación.**
  1. Pon en `SERVICE_URL` la URL real de la anotación, la determinista. Nunca la URL con hash: NextAuth solo
     funciona desde la URL de `NEXTAUTH_URL`.
  2. Vuelve a generar la plantilla y ejecuta `replace`. `NEXTAUTH_URL` sale de `SERVICE_URL`.
  3. Repite la verificación de la URL; solo entonces haz los pasos 2 y 3 del bloque.
- Hasta entonces no se expone ningún dato: la sonda solo valida la configuración y las páginas exigen sesión.

**Proteger la imagen desplegada (después de cada despliegue correcto).** La regla `conservar-produccion` de la
política de limpieza conserva siempre las versiones con etiqueta `produccion…`. Primero se mueve `produccion-anterior`
a la imagen que estaba en producción, para tener un rollback garantizado; después se mueve `produccion` a la nueva:

```bash
# Imagen que estaba en producción (vacío en el primer despliegue):
PREV="$(gcloud artifacts docker images describe "${IMAGE_BASE}:produccion" --project="$PROJECT_ID" \
  --format='value(image_summary.digest)' 2>/dev/null || true)"
[ -z "$PREV" ] || gcloud artifacts docker tags add "${IMAGE_BASE}@${PREV}" "${IMAGE_BASE}:produccion-anterior" \
  --project="$PROJECT_ID"
gcloud artifacts docker tags add "$IMAGE" "${IMAGE_BASE}:produccion" --project="$PROJECT_ID"
# Verificación (solo lectura): "produccion" apunta al digest desplegado (el de $IMAGE).
gcloud artifacts docker images describe "${IMAGE_BASE}:produccion" --project="$PROJECT_ID" \
  --format='value(image_summary.digest)'
```

- `tags add` **mueve** la etiqueta si ya existía: según el SDK, borra la etiqueta y la vuelve a crear sobre la nueva
  versión.
- Si se olvida este paso, la imagen desplegada solo queda protegida mientras esté entre las 3 más recientes o tenga
  30 días o menos (checklist A9).

Para los cambios posteriores, repite 5.5 → 5.7 con la nueva imagen. Cada `replace` crea una revisión nueva y
la anterior queda disponible para el rollback. El rollback a `produccion-anterior` está garantizado; a revisiones
más antiguas, solo si su imagen sigue en el repositorio.

### 5.8 Verificación (requiere autorización del usuario)

La lista completa y verificable está en el [checklist de aceptación](despliegue-v1-6-aceptacion.md). Resumen:

1. **Sin sesión:** desde `web/`, ejecuta `npm run smoke:remote -- --url "$SERVICE_URL"`. Solo usa `GET` e
   imprime códigos HTTP. Esperado (28/28): `/api/health` 200, las 15 páginas privadas con 307 a `/login`, las 7
   APIs privadas con 401 y cabeceras HSTS, `no-store` y `DENY`.
2. **Navegador:** inicia sesión con el correo permitido y verifica el origen "Leído de Google Sheets",
   12/12 pestañas válidas y que los totales coinciden con la hoja.
3. **Acceso denegado:** con otra cuenta de Google en ventana privada, el acceso debe ser rechazado.
4. **Sin escrituras:** el historial de versiones del Sheets no muestra cambios de la cuenta de servicio.
   La plantilla no define `PROJECT_OS_WRITE_MODE` ni `AUTH_WRITER_EMAILS` (V1.4); deben seguir ausentes, o
   `PROJECT_OS_WRITE_MODE=disabled`, en producción. Una prueba lo verifica (`deploy-template.test.ts`).
5. **Logs:** en Cloud Run → *Registros* no aparecen tokens, correos ni datos. Solo advertencias de
   configuración, con códigos.
6. Registra el resultado (✅/❌, sin secretos ni correos) en el PR o issue correspondiente.

## 6. Rollback

```bash
# Ver revisiones y volver a una anterior que funcionaba (sin reconstruir):
gcloud run revisions list --service "$SERVICE_NAME" --region "$REGION"
gcloud run services update-traffic "$SERVICE_NAME" --region "$REGION" --to-revisions=REVISION_ANTERIOR=100
```

- **Secreto comprometido:** agrega una versión nueva (`gcloud secrets versions add … --data-file=-`),
  actualiza `SECRET_VERSION_*` y redespliega (5.7). Comprueba que la nueva revisión funciona y después **destruye** la
  versión anterior (`gcloud secrets versions destroy N --secret=SECRETO --project="$PROJECT_ID"`). Una versión solo
  deshabilitada sigue contando como activa y facturándose.
- **Cerrar el acceso de inmediato** sin borrar nada:
  `gcloud run services remove-iam-policy-binding "$SERVICE_NAME" --region "$REGION" --member=allUsers --role=roles/run.invoker`.
  Esto solo cierra el acceso si el servicio usa el binding `allUsers`, que es el método de §5.7. Si en su lugar se
  desactivó la comprobación IAM del invocador (`--no-invoker-iam-check`), hay que reactivarla con
  `gcloud run services update "$SERVICE_NAME" --region "$REGION" --invoker-iam-check`.
- **Compilación (D10-b):** un build nunca despliega, así que una imagen defectuosa no llega a producción si no se
  pasa a §5.7.
  - Cancelar un build en curso: `gcloud builds cancel BUILD_ID --project="$PROJECT_ID" --region "$BUILD_REGION"`.
  - Borrar una imagen defectuosa: `gcloud artifacts docker images delete "IMAGEN@sha256:…" --delete-tags`.
  - Suspender la cuenta de compilación sin borrar nada: `gcloud iam service-accounts disable "$BUILD_SA"`.
    Se reactiva con `enable`.
- **Revocar sesiones:** rotar `project-os-nextauth-secret` (nueva versión, redespliegue) invalida todas las
  cookies. Quitar un correo de la lista (nueva versión de `project-os-allowed-emails`, redespliegue) lo bloquea en
  la siguiente petición, porque cada página y API vuelve a comprobar la lista.

## 7. Desmantelar (detener todo gasto)

```bash
gcloud run services delete "$SERVICE_NAME" --region "$REGION"
gcloud artifacts repositories delete "$REPO" --location "$REGION"
for s in project-os-nextauth-secret project-os-google-client-secret project-os-allowed-emails; do
  gcloud secrets delete "$s"
done
gcloud iam service-accounts delete "$RUNTIME_SA"
# Solo si se usó Cloud Build (D10-b): bucket de origen con su contenido, rol de logs y cuenta de compilación.
gcloud storage rm --recursive "gs://${BUILD_BUCKET}"
gcloud projects remove-iam-policy-binding "$PROJECT_ID" --condition=None \
  --member="serviceAccount:${BUILD_SA}" --role=roles/logging.logWriter
gcloud iam service-accounts delete "$BUILD_SA"
```

Después:

- quita a la cuenta de servicio del **Compartir** del Sheets;
- revisa en *Cloud Storage* que no exista el bucket predeterminado `PROJECT_ID_cloudbuild`. Solo aparece si se lanzó
  un build sin el comando generado; en ese caso, bórralo;
- elimina el cliente OAuth de producción;
- si el proyecto es dedicado, puedes cerrarlo (`gcloud projects delete`), lo que detiene toda la facturación
  del proyecto.

## 8. Uso local (sin cambios respecto a V1.2)

`web/.env.local` con `SHEETS_CREDENTIALS=service-account-key`, o vacío si ya hay
`PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_FILE`, sigue funcionando igual. Para probar la imagen localmente:
`cd web && npm run docker:smoke`, con datos sintéticos y sin credenciales de Google.

## 9. Riesgos y limitaciones

- **Superficie de login pública.** La pantalla de login es alcanzable desde Internet (ver sección 2). La
  mitigación es la allowlist con verificación por petición, cookies `__Secure-`, HSTS y sesiones de 8 h. IAP
  queda para una iteración futura.
- **Integración ADC real no probada.** ADC se probó con un proveedor simulado; la integración con el metadata
  server de Cloud Run real no se ha verificado. La verificación de identidad y la sonda reducen el riesgo, y
  la prueba real es la sección 5.8.
- **Alcance del token en el metadata server.** Cloud Run entrega tokens con los alcances solicitados
  (`?scopes=`). Aunque no lo hiciera, la cuenta solo es **Lector** de un documento y el cliente solo hace
  `GET`.
- **Caché por instancia.** Con `maxScale: 1` hay una sola caché; un arranque en frío vuelve a leer Sheets.
- **Arranque en frío.** Con `minScale: 0`, la primera visita tras inactividad tarda unos segundos (decisión
  de costo).
- **Dependencias de lint.** El aviso alto de `braces` (GHSA-vfj7-8cjw-p6xm) es solo de desarrollo y no
  entra en la imagen (`npm ls --omit=dev braces` vacío).
- **Sin Content-Security-Policy.** La app envía `X-Frame-Options`, HSTS, `nosniff`, `Referrer-Policy` y
  `Permissions-Policy`, pero no una CSP. React escapa el contenido de la hoja y no se usa HTML sin escapar. Una
  CSP estricta con Next exige *nonces* por petición: queda como mejora separada (ver
  [preparación §5](despliegue-v1-6-preparacion.md#5-riesgos-de-seguridad-y-costos)).
- **Heurísticas del control V1.6.** Pueden generar alertas ruidosas con datos reales: la aceptación debe
  revisarlas sin tomarlas como decisiones.
- **Cuenta predeterminada de Compute.** En proyectos sin organización suele recibir el rol Editor. Ni el servicio
  ni el build la usan: la runtime y la de compilación son dedicadas y el build la rechaza. Quitarle Editor es una
  decisión aparte del propietario, porque puede afectar a otros usos del proyecto.
- **Verificación de identidad del build no probada contra GCP.** Depende de que el metadata server responda dentro
  del build. Si no responde, el build **falla cerrado**: es seguro, pero bloquea. La evidencia es el checklist A8.
- **Responsabilidades fuera de la app.** Facturación, cuotas compartidas y spend caps dependen de la cuenta
  de Google Cloud del usuario.
