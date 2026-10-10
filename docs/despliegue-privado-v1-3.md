# PROJECT-OS V1.6 — Despliegue privado de pruebas en Google Cloud Run (manual)

> El nombre del archivo se conserva desde V1.3 para no romper enlaces. El contenido corresponde a **V1.6**.

**Estado (Misión 010, issue #16):**

- **Código:** listo en `main`, en `372224f` (V1.3–V1.6 y CI unificada).
- **Despliegue:** **no desplegado y sin recursos creados.**
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
| 2 | Decisiones del propietario: proyecto, facturación, región, URL, correos, presupuesto y alertas ([matriz](despliegue-v1-6-preparacion.md#2-matriz-de-decisiones-del-propietario)) | Usuario | Pendiente |
| 3 | Crear recursos facturables (secciones 5.1–5.7) y desplegar | Usuario, autorización separada | Pendiente |
| 4 | Acceso regular tras el [checklist de aceptación](despliegue-v1-6-aceptacion.md), mantenimiento y revisión de costos | Usuario | Pendiente |

Completar una puerta **no** autoriza la siguiente. La Misión 010 solo prepara la puerta 2.

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
- `roles/cloudbuild.builds.editor`, solo si se construye con Cloud Build

GitHub Actions **no** recibe credenciales de Google Cloud.

### 3.3 Política de credenciales de la app (`SHEETS_CREDENTIALS`)

| Entorno | Valor | Credencial | Reglas |
| --- | --- | --- | --- |
| Cloud Run | `adc` | Identidad adjunta (metadata server) | Exige `SHEETS_EXPECTED_SERVICE_ACCOUNT`. Prohíbe `PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_*` y `GOOGLE_APPLICATION_CREDENTIALS` |
| Local (V1.2) | `service-account-key` (o vacío con clave configurada) | Clave JSON **fuera del repo** | Prohibido si existe `K_SERVICE` (Cloud Run) |
| Local opcional | `adc` | `gcloud auth application-default login --impersonate-service-account=…` | Con `SHEETS_EXPECTED_SERVICE_ACCOUNT`, una credencial de usuario normal es rechazada |

No hay fallback silencioso: si la variable falta y no hay clave, la app no lee datos y lo indica.

## 4. Costos

Los precios, niveles gratuitos, regiones y su fecha de verificación (2026-10-10) están en
[preparación §4](despliegue-v1-6-preparacion.md#4-costos-y-regiones-verificados), con fuentes oficiales y nivel de
confianza.

Resumen de la estimación, que **no es una promesa**:

- **Probablemente USD 0 al mes** si la cuenta de facturación no tiene otros consumos.
- **Menos de USD 1 al mes** si otros proyectos ya consumen los niveles gratuitos, que se cuentan **por cuenta de
  facturación**.
- Las dos regiones candidatas son Tier 1 en Cloud Run.

### Controles

- `maxScale: 1`, `minScale: 0`, `cpu-throttling: true`, 1 vCPU y 512 MiB (subir a 1 GiB solo si una prueba
  real lo exige).
- Presupuesto con alertas (importe y umbrales: decisiones D6 y D7; la sección 5.2 usa USD 5 y 50/90/100 % como
  ejemplo). **Las alertas avisan; no son un límite duro.** Los presupuestos con tope para Cloud Run están en
  Preview: solo se evaluarán como decisión aparte
  ([preparación §4.4](despliegue-v1-6-preparacion.md#44-presupuestos-y-alertas)).
- Al rotar secretos, **destruir** las versiones antiguas: las deshabilitadas siguen contando como activas.
- Política de limpieza de Artifact Registry (`web/deploy/cloudrun/artifact-cleanup-policy.json`).
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
export PROJECT_ID="project-os-XXXXXX"          # decisión D1 del propietario
export REGION="us-central1"                    # decisión D3: us-central1 o northamerica-south1
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

```bash
export BILLING_ACCOUNT="XXXXXX-XXXXXX-XXXXXX"   # Facturación → Cuentas
gcloud billing budgets create --billing-account="$BILLING_ACCOUNT" \
  --display-name="project-os-dashboard" --budget-amount=5USD \
  --filter-projects="projects/${PROJECT_ID}" \
  --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0
```

### 5.3 APIs mínimas

```bash
gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com sheets.googleapis.com
# Solo si se construye en Cloud Build:
# gcloud services enable cloudbuild.googleapis.com
```

### 5.4 Cuenta de servicio runtime y acceso de solo lectura a la hoja

```bash
gcloud iam service-accounts create project-os-dashboard-run \
  --display-name="PROJECT-OS dashboard (solo lectura)"
# Verificar que NO tenga roles de proyecto (la salida debe estar vacía):
gcloud projects get-iam-policy "$PROJECT_ID" --flatten='bindings[].members' \
  --filter="bindings.members:serviceAccount:${RUNTIME_SA}" --format='value(bindings.role)'
```

En Google Sheets, abre el maestro y pulsa **Compartir**. Pega el correo de `RUNTIME_SA` con rol
**Lector**, desmarca *Notificar* y deja **Acceso general: Restringido**.

### 5.5 Artifact Registry y la imagen

```bash
gcloud artifacts repositories create "$REPO" --repository-format=docker --location="$REGION" \
  --description="PROJECT-OS dashboard"
gcloud artifacts repositories set-cleanup-policies "$REPO" --location="$REGION" \
  --policy=web/deploy/cloudrun/artifact-cleanup-policy.json --no-dry-run
export IMAGE_TAG="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/dashboard:$(git rev-parse --short HEAD)"
```

**Opción A — Cloud Build** (usa minutos de build; `cloudbuild.yaml` fuerza BuildKit y `linux/amd64`):

```bash
# Prueba en seco, local y sin GCP: lista exactamente lo que se subiría al bucket de Cloud Build.
# Esperado: .dockerignore, Dockerfile, package.json, package-lock.json, next.config.ts, tsconfig.json y src/.
gcloud meta list-files-for-upload web
gcloud builds submit web --config web/deploy/cloudbuild.yaml --substitutions=_IMAGE_TAG="$IMAGE_TAG"
```

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

1. En *APIs y servicios → Credenciales*, crea un **ID de cliente OAuth nuevo** (Aplicación web), distinto
   del de localhost:
   - Orígenes autorizados: el valor de `$SERVICE_URL`.
   - URI de redirección: `$SERVICE_URL/api/auth/callback/google`, exacto.
   - Mantén la pantalla de consentimiento en modo *Prueba*, con solo los usuarios permitidos.
2. Copia el ID de cliente (no es secreto) a `OAUTH_CLIENT_ID`. El secreto del cliente se introduce de forma
   oculta:

```bash
export OAUTH_CLIENT_ID="NNNNNNNNNNNN-xxxxxxxx.apps.googleusercontent.com"

# Secreto de sesión NUEVO (no reutilizar el de localhost); nunca se muestra:
openssl rand -base64 32 | tr -d '\n' | gcloud secrets create project-os-nextauth-secret \
  --replication-policy=automatic --data-file=-

# Secreto del cliente OAuth de producción (entrada oculta, no queda en el historial):
read -r -s -p "GOOGLE_CLIENT_SECRET de producción: " V; echo
printf '%s' "$V" | gcloud secrets create project-os-google-client-secret \
  --replication-policy=automatic --data-file=-; unset V

# Correos permitidos (separados por coma), entrada oculta:
read -r -s -p "AUTH_ALLOWED_EMAILS: " V; echo
printf '%s' "$V" | gcloud secrets create project-os-allowed-emails \
  --replication-policy=automatic --data-file=-; unset V

for s in project-os-nextauth-secret project-os-google-client-secret project-os-allowed-emails; do
  gcloud secrets add-iam-policy-binding "$s" \
    --member="serviceAccount:${RUNTIME_SA}" --role=roles/secretmanager.secretAccessor
done

export SECRET_VERSION_NEXTAUTH=1 SECRET_VERSION_OAUTH=1 SECRET_VERSION_ALLOWLIST=1
```

### 5.7 Desplegar desde la plantilla revisada

```bash
cd web
node deploy/cloudrun/render.mjs > /tmp/project-os-service.yaml   # valida formatos; falla si falta algo
less /tmp/project-os-service.yaml                                # revisión humana
gcloud run services replace /tmp/project-os-service.yaml --region "$REGION"
# Confirma la URL real ANTES del primer login. Entre las URLs del servicio debe figurar $SERVICE_URL:
gcloud run services describe "$SERVICE_NAME" --region "$REGION" --format='yaml(status.url,metadata.annotations)'
# Navegador → OAuth requiere invocación pública (los datos siguen tras login + allowlist):
gcloud run services add-iam-policy-binding "$SERVICE_NAME" --region "$REGION" \
  --member=allUsers --role=roles/run.invoker
rm /tmp/project-os-service.yaml
```

- Cloud Run asigna dos URLs: la determinista `https://SERVICIO-NUMERO_PROYECTO.REGION.run.app` y otra
  con hash (`status.url`). Las dos se ven en la anotación `run.googleapis.com/urls`.
- **Si `$SERVICE_URL` no aparece, detente antes de probar el login:**
  1. pon la URL real en `SERVICE_URL`;
  2. corrige los orígenes y la redirección del cliente OAuth (5.6);
  3. vuelve a generar la plantilla y ejecuta `replace`. `NEXTAUTH_URL` sale de `SERVICE_URL`.
- Hasta entonces no se expone ningún dato: la sonda solo valida la configuración y las páginas exigen sesión.

Para los cambios posteriores, repite 5.5 → 5.7 con la nueva imagen. Cada `replace` crea una revisión nueva y
la anterior queda disponible para el rollback.

### 5.8 Verificación (requiere autorización del usuario)

La lista completa y verificable está en el [checklist de aceptación](despliegue-v1-6-aceptacion.md). Resumen:

1. **Sin sesión:** desde `web/`, ejecuta `npm run smoke:remote -- --url "$SERVICE_URL"`. Solo usa `GET` e
   imprime códigos HTTP. Esperado (26/26): `/api/health` 200, las 13 páginas privadas con 307 a `/login`, las 7
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
  actualiza `SECRET_VERSION_*` y redespliega (5.7). Después deshabilita la versión anterior.
- **Cerrar el acceso de inmediato** sin borrar nada:
  `gcloud run services remove-iam-policy-binding "$SERVICE_NAME" --region "$REGION" --member=allUsers --role=roles/run.invoker`.
  Esto solo cierra el acceso si el servicio usa el binding `allUsers`, que es el método de §5.7. Si en su lugar se
  desactivó la comprobación IAM del invocador (`--no-invoker-iam-check`), hay que reactivarla con
  `gcloud run services update "$SERVICE_NAME" --region "$REGION" --invoker-iam-check`.
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
```

Después:

- quita a la cuenta de servicio del **Compartir** del Sheets;
- si se usó Cloud Build, revisa en *Cloud Storage* los buckets que haya creado para el código subido y bórralos;
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
- **Responsabilidades fuera de la app.** Facturación, cuotas compartidas y spend caps dependen de la cuenta
  de Google Cloud del usuario.
