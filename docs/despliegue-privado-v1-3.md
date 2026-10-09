# PROJECT-OS V1.3 — Despliegue privado en Google Cloud Run (manual)

**Estado:** preparado en código y documentación (Misión 005, issue #5). **No desplegado.** Este documento
**no autoriza** crear recursos facturables, habilitar billing, publicar la app ni activar automatizaciones.
Cada bloque de comandos es para **revisión y ejecución humana**; no hay ningún script de aprovisionamiento ni
despliegue desde CI.

Base técnica: `docs/analisis-hosting-v1-3.md` (decisión de hosting) y `web/README.md` (uso local).

## 1. Puertas de autorización

| # | Puerta | Quién decide | Estado |
| --- | --- | --- | --- |
| 1 | PR de código (este) revisado y aprobado, sin merge automático | Usuario (revisión ChatGPT) | Pendiente |
| 2 | Proyecto GCP, cuenta de facturación, región, dominio y gasto máximo | Usuario | Pendiente |
| 3 | Crear recursos facturables (secciones 5.1–5.8) y desplegar | Usuario, autorización separada | Pendiente |
| 4 | Habilitar acceso regular, mantenimiento y revisión de costos | Usuario | Pendiente |

### Valores por defecto propuestos (no acordados)

| Decisión | Propuesta | Alternativa / nota |
| --- | --- | --- |
| Proyecto | Proyecto **dedicado** `project-os-…` con su propio presupuesto | Reusar el proyecto actual de OAuth/V1.1 solo si se acepta compartir cuotas y permisos |
| Región | `us-central1` (tarifas Tier 1 y nivel gratuito documentado) | `northamerica-south1` (México) por latencia: **verificar** disponibilidad y tarifa antes de elegir |
| Dominio | URL `*.run.app` que asigna Cloud Run | Dominio propio en una iteración posterior |
| Gasto | Presupuesto de **USD 5/mes** con alertas al 50 %, 90 % y 100 % | Las alertas **no** detienen el gasto |
| Acceso | Solo el propietario en `AUTH_ALLOWED_EMAILS` | Otras personas requieren decisión explícita |

## 2. Arquitectura

```
Navegador ──HTTPS──▶ Cloud Run "project-os-dashboard" (min 0 / max 1, CPU por solicitud)
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

- **Fuente de datos:** Google Sheets sigue siendo la única fuente operativa. No hay base de datos adicional;
  solo una caché en memoria de 60 s por instancia.
- **Solo lectura, en tres capas:** cliente HTTP que solo emite `GET`, token con alcance
  `spreadsheets.readonly` y la cuenta de servicio con rol **Lector** en un único documento.
- **Imagen:** `web/Dockerfile`, multi-stage, Next.js `standalone`, Node 22 fijado por digest, usuario `node`
  (uid 1000) y código de solo lectura. Sin `.env`, claves, pruebas ni `.git` (`.dockerignore` con lista de
  permitidos). Unos 104 MB comprimida.
- **Sonda:** `GET /api/health` es pública y no lee Sheets ni la sesión. Responde solo
  `{"status":"ok"}` (200) o `{"status":"unavailable"}` (503). Una revisión con configuración insegura (URL
  sin HTTPS, clave JSON, datos sintéticos, falta de la cuenta esperada o de secretos) **no supera la sonda de
  arranque y no recibe tráfico**.
  - **Límite:** la sonda solo valida la **configuración** (variables y política de credenciales). **No**
    comprueba que la identidad ADC tenga acceso real a la hoja, que OAuth funcione ni que Secret Manager
    responda. Eso se acepta después de desplegar (§5.8). Un 200 en `/api/health` no equivale a "funciona".

### "Invocable desde Internet" no significa "datos públicos"

Para que Google OAuth funcione, el navegador debe alcanzar `/login` y `/api/auth/*`. Por eso el servicio
se despliega con `ingress: all` y el rol `roles/run.invoker` para `allUsers`. Eso **solo** expone la
superficie HTTP. Todas las páginas privadas y `/api/resumen` exigen una sesión válida de un correo
permitido, verificada en `proxy.ts` y otra vez en cada página y API. Sin sesión no se lee Sheets.

- Las únicas rutas públicas son `/login`, `/api/auth/*`, `/api/health`, `/robots.txt` y los archivos
  estáticos de Next.
- `roles/run.invoker` para `allUsers` **no** reemplaza la autenticación de usuarios.
- Si se quiere ocultar también la pantalla de login de Internet, la opción es **IAP** u otra capa (por
  ejemplo una VPN). Queda fuera de V1.3.

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

### Hechos documentados por Google (consultar antes de crear recursos)

Fuentes en `docs/analisis-hosting-v1-3.md`.

- **Cloud Run** con facturación por solicitud (`cpu-throttling: true`) y `minScale 0`: sin cobro por
  instancias inactivas. El nivel gratuito por cuenta de facturación incluye 2 M de solicitudes, 180 000
  vCPU-s y 360 000 GiB-s al mes (tarifa Tier 1).
- **Secret Manager:** 6 versiones activas y 10 000 accesos al mes gratuitos. Este diseño usa 3 secretos;
  Cloud Run los lee al arrancar cada instancia.
- **Artifact Registry:** 0,5 GiB-mes gratuitos. Con la política de limpieza (3 versiones, 30 días), unos
  3 × 104 MB ≈ 0,3 GB, aunque las capas compartidas reducen el total real.
- **Cloud Build:** nivel gratuito de 2 500 build-minutos al mes en la máquina elegible. Construir localmente
  y hacer push también es válido.
- **Cloud Logging:** cuota gratuita mensual de ingesta. La app no registra peticiones; solo advertencias sin
  datos.

### Estimación (no promesa)

Con 1–2 personas y unas pocas visitas al día, el cómputo de Cloud Run probablemente queda dentro del nivel
gratuito. La factura **puede no ser cero** por:

- almacenamiento de imágenes o builds fuera de cuota;
- egreso de red;
- cuotas gratuitas ya consumidas por otros servicios de la misma cuenta de facturación;
- la región elegida.

Antes de desplegar hay que verificarlo en la calculadora de precios.

### Controles

- `maxScale: 1`, `minScale: 0`, `cpu-throttling: true`, 1 vCPU y 512 MiB (subir a 1 GiB solo si una prueba
  real lo exige).
- Presupuesto de USD 5/mes con alertas al 50/90/100 % (sección 5.2). **Las alertas avisan; no son un límite
  duro.** Solo si Google ofrece un *spend cap* para estos servicios en la cuenta, se evaluará como decisión
  aparte.
- Política de limpieza de Artifact Registry (`web/deploy/cloudrun/artifact-cleanup-policy.json`).
- Revisión manual mensual en *Facturación → Informes*.
- Para detener el gasto por completo, ver la sección 7.

## 5. Despliegue manual paso a paso (requiere la puerta 3)

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
export PROJECT_ID="project-os-XXXXXX"          # decisión del usuario
export REGION="us-central1"                    # decisión del usuario
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

1. **Sin sesión:** desde `web/`, ejecuta `npm run smoke:remote -- --url "$SERVICE_URL"`. Solo imprime
   códigos HTTP. Esperado: `/api/health` 200, páginas privadas con 307 a `/login`, `/api/resumen` 401 y
   cabeceras HSTS, `no-store` y `DENY`.
2. **Navegador:** inicia sesión con el correo permitido y verifica el origen "Leído de Google Sheets",
   12/12 pestañas válidas y que los totales coinciden con la hoja.
3. **Acceso denegado:** con otra cuenta de Google en ventana privada, el acceso debe ser rechazado.
4. **Sin escrituras:** el historial de versiones del Sheets no muestra cambios de la cuenta de servicio.
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
- **Responsabilidades fuera de la app.** Facturación, cuotas compartidas y spend caps dependen de la cuenta
  de Google Cloud del usuario.
