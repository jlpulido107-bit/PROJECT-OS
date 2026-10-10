# PROJECT-OS V1.6 — Preparación del primer despliegue privado de pruebas

> **Misión 010 (issue #16).** Solo preparación: **no se creó, habilitó ni desplegó nada**. No se usó `gcloud` contra
> ningún proyecto, ni se modificó Google Sheets, ni se activó escritura. Este documento **no equivale a aprobación de
> despliegue**: las puertas 2–4 del [runbook](despliegue-privado-v1-3.md#1-puertas-de-autorización) siguen
> pendientes.

## 1. Punto de partida verificado

| Hecho | Evidencia |
| --- | --- |
| `main` en `372224f7fec5e3d84491f346c2d4d9f9e82f0a01` integra V1.3–V1.6 y la CI unificada | `git log`; PR #15 (squash) sobre los merges de #6, #8, #10 y #12 |
| CI de `push` en `main` en verde para ese SHA (jobs `web` y `docker`) | [run 38010650421](https://github.com/jlpulido107-bit/PROJECT-OS/actions/runs/38010650421) |
| Plantilla de Cloud Run sin modo de escritura, con ADC, secretos por versión y límites de costo | [`service.template.yaml`](../web/deploy/cloudrun/service.template.yaml) y `web/tests/deploy-template.test.ts` |
| Smoke remoto ampliado a V1.6: 13 páginas y 7 APIs privadas, solo `GET` (26 comprobaciones) | [`smoke-remote.mjs`](../web/scripts/smoke-remote.mjs), probado contra un build local de producción: 26/26 |
| Comandos del runbook presentes en Google Cloud SDK 570.0.0 (`--help` local, sin llamadas a GCP), incluidos `--[no-]invoker-iam-check` y `--[no-]iap` en `gcloud run services update` | Verificación local del 2026-10-10 |
| **No verificado:** OAuth real, ADC real contra el metadata server, permisos reales en la hoja, IAM y facturación | Solo se verifican después de desplegar ([checklist](despliegue-v1-6-aceptacion.md)) |

## 2. Matriz de decisiones del propietario

Las recomendaciones **no son decisiones**. Las respuestas se dan fuera del repositorio cuando incluyan datos
privados (correos, ID de facturación, número de proyecto). En el repositorio solo se registra "decidido" y la
opción elegida, sin esos datos.

| # | Decisión | Opciones | Recomendación (no vinculante) | Consecuencias | Decisión del propietario |
| --- | --- | --- | --- | --- | --- |
| D1 | Proyecto GCP | (a) dedicado nuevo; (b) reutilizar el del cliente OAuth / V1.1 | (a): aísla IAM, cuotas y presupuesto; borrar el proyecto detiene todo su gasto | (b) mezcla permisos y cuotas, y complica el apagado | Pendiente |
| D2 | Cuenta de facturación | (a) la existente del propietario; (b) una nueva | (a), si no tiene otros consumos relevantes | Los niveles gratuitos son **por cuenta de facturación** ([§4](#4-costos-y-regiones-verificados)): otros proyectos los consumen | Pendiente |
| D3 | Región | `us-central1` (Iowa) o `northamerica-south1` (Querétaro) | Ver [§4.2](#42-región) | Precio, latencia, disponibilidad de servicios y mapeo de dominio | Pendiente |
| D4 | URL | (a) `*.run.app` determinista; (b) dominio propio | (a) para la prueba | (b) añade DNS, certificados y, según la región, un balanceador con costo fijo ([§4.2](#42-región)) | Pendiente |
| D5 | Correos autorizados | Solo el propietario; propietario + invitados con nombre | Propietario + como máximo 1 invitado de prueba, más una cuenta **no** autorizada para la prueba C2 | Se guardan solo en Secret Manager y como usuarios de prueba de OAuth; nunca en el repositorio | Pendiente |
| D6 | Presupuesto mensual | Importe en USD (p. ej. 5) | Un importe bajo, del orden de USD 5, sabiendo que **no es un corte** de gasto | Solo genera avisos | Pendiente |
| D7 | Alertas | Umbrales y destinatarios; opcional, desactivar la facturación automáticamente | 50 / 90 / 100 % del gasto real, más 100 % del previsto, al correo de administradores de facturación. **Sin** automatización de corte | Un corte automático es una automatización con efectos destructivos ([§4.4](#44-presupuestos-y-alertas)) y requiere aprobación aparte | Pendiente |
| D8 | Acceso a la app | (a) `allUsers` invocador + login de la app; (b) IAP; (c) desactivar la comprobación IAM del invocador | Ver [§3.6](#36-invocación-pública-frente-a-login-privado) | Cambia quién alcanza `/login` y el procedimiento de cierre | Pendiente |
| D9 | Pantalla de consentimiento OAuth | Tipo *Externo*; estado *Prueba* o *En producción* | *Externo* en *Prueba*, con los usuarios de prueba = D5 | Ver [§3.1](#31-oauth) | Pendiente |
| D10 | Construcción de la imagen | (a) Docker local; (b) Cloud Build | (a) si hay Docker; si no, (b) | (b) usa minutos de build y un bucket de origen | Pendiente |
| D11 | Duración de la prueba | Fecha de revisión y de apagado | Ventana fija (p. ej. 14 días) y después: puerta 4 o desmantelar (runbook §7) | Evita recursos olvidados | Pendiente |
| D12 | Ejecución | Quién ejecuta y cuándo | El propietario, en una sola sesión, con el runbook y el checklist | Claude Code no ejecuta `gcloud` sobre el proyecto | Pendiente |

## 3. Auditoría estática

Leyenda: ✅ verificado en código o plantilla · ⚠️ riesgo aceptado o mejora pendiente · ⏳ solo verificable tras
desplegar.

### 3.1 OAuth

| Punto | Estado | Detalle |
| --- | --- | --- |
| Alcances mínimos | ✅ | `openid email profile` y `prompt=select_account` (`web/src/lib/auth.ts`). No pide acceso a Drive ni Sheets del usuario |
| Correo verificado y lista | ✅ | `signIn` exige `email_verified === true` y el correo en `AUTH_ALLOWED_EMAILS`. Cada página y API vuelve a comprobar la lista en cada petición |
| Sesión | ✅ | JWE de NextAuth, 8 h (`AUTH_SESSION_MAX_AGE_SECONDS=28800`, máximo 7 días). Sin *refresh tokens* de Google guardados. Bajo HTTPS la cookie es `__Secure-` |
| Cliente de producción | ✅ (runbook) | Cliente **nuevo**, distinto del de localhost. Origen `$SERVICE_URL` y redirección exacta `$SERVICE_URL/api/auth/callback/google` |
| Estado de publicación | ⚠️ | Ver [§4.5](#45-oauth). En *Prueba* solo entran los usuarios de prueba; la lista de la app sigue siendo la barrera real |
| Login real | ⏳ | Checklist C1 y C2 |

### 3.2 ADC y solo lectura

| Punto | Estado | Detalle |
| --- | --- | --- |
| Credencial explícita | ✅ | `SHEETS_CREDENTIALS=adc` en la plantilla. En Cloud Run se rechazan claves JSON y `GOOGLE_APPLICATION_CREDENTIALS` (`credentials.ts`) |
| Identidad esperada | ✅ | `SHEETS_EXPECTED_SERVICE_ACCOUNT` obligatorio en Cloud Run. Si la identidad del servidor no coincide, no se lee nada |
| Alcance y método | ✅ | Token con `spreadsheets.readonly`; el cliente HTTP solo emite `GET` (`sheets-client.ts`) |
| Escritura | ✅ | V1.4: `mock` prohibido con `K_SERVICE` y `sheets` bloqueado. Sonda 503 si hay variables de escritura (`deployment.ts`). Plantilla sin esas variables (prueba) |
| Permiso real | ⏳ | Rol **Lector** en un único documento (runbook §5.4); checklist D1 y D2 |
| Token en el metadata server | ⏳ | Ver [§4.6](#46-otros-límites-y-referencias) |

### 3.3 IAM de mínimo privilegio

| Identidad | Permisos | Estado |
| --- | --- | --- |
| `project-os-dashboard-run@PROJECT_ID.iam.gserviceaccount.com` (runtime) | **Ningún** rol de proyecto; `secretAccessor` solo en los 3 secretos; Lector de la hoja | ✅ diseño · ⏳ checklist A5, A6 y D2 |
| Cuenta por defecto de Compute | No se usa: la plantilla fija `serviceAccountName` | ✅ |
| Persona que despliega | Propietario en el alta. Después: `run.admin`, `iam.serviceAccountUser` **sobre la cuenta runtime**, `artifactregistry.writer`, `secretmanager.secretVersionAdder` y, solo con Cloud Build, `cloudbuild.builds.editor` | ✅ runbook §3.2 |
| GitHub Actions | Sin credenciales de Google Cloud | ✅ |
| Cloud Build (opción D10-b) | Usa su propia cuenta de servicio de build: revisar qué cuenta usa el proyecto antes del primer build ([§4.6](#46-otros-límites-y-referencias)) | ⏳ |

### 3.4 Secret Manager

| Punto | Estado | Detalle |
| --- | --- | --- |
| Secretos | ✅ | `project-os-nextauth-secret`, `project-os-google-client-secret` y `project-os-allowed-emails` (la lista es dato personal) |
| Versión fijada | ✅ | La plantilla referencia versiones numéricas, no `latest`. Un cambio exige versión nueva más redespliegue (auditable) |
| Creación sin eco | ✅ | `read -s` y `--data-file=-`. El runbook nunca usa `versions access` |
| Rotación y revocación | ✅ | Runbook §6: rotar el secreto de sesión invalida todas las sesiones |

### 3.5 Callback y URL

| Punto | Estado | Detalle |
| --- | --- | --- |
| URL conocida antes de desplegar | ✅ | `https://SERVICIO-NUMERO_PROYECTO.REGION.run.app` (runbook §5.0); su disponibilidad se confirma tras el despliegue (§5.7) |
| `NEXTAUTH_URL` = URL del cliente OAuth | ✅ | Ambas salen de `SERVICE_URL`; `render.mjs` exige HTTPS |
| URL con hash | ⚠️ | Cloud Run también publica una URL con hash. NextAuth construye la redirección con `NEXTAUTH_URL`, así que el login funciona solo desde la URL determinista. Se documenta como la única URL de uso |
| Coincidencia real | ⏳ | Checklist A2 |

### 3.6 Invocación pública frente a login privado

Para el login con Google, el navegador debe alcanzar `/login` y `/api/auth/*`. Opciones (D8):

| Opción | Quién alcanza la app | Estado verificado | Pros | Contras |
| --- | --- | --- | --- | --- |
| (a) `allUsers` con `roles/run.invoker` + login de la app | Cualquiera ve `/login`; los datos exigen sesión y lista | Mecanismo clásico, vigente [M] | Es el diseño del runbook, probado en E2E y en el smoke. Se cierra quitando el binding (runbook §6) | La pantalla de login es pública |
| (b) IAP directo en Cloud Run (`--iap`, sin balanceador) | Solo identidades autorizadas en IAP; después, el login de la app | **GA el 2026-03-13** según las notas de versión [M]. Funciones básicas sin costo [A] | Oculta incluso `/login` | Doble inicio de sesión. Fuera de una organización exige un cliente OAuth propio para IAP y roles adicionales. No probado con NextAuth en este repositorio |
| (c) Desactivar la comprobación IAM del invocador (`--no-invoker-iam-check`) | Igual que (a) | **GA el 2025-03-28** [M]. Google la presenta como la forma recomendada de hacer pública una app, sobre todo con la política *Domain Restricted Sharing* | Funciona aunque una política de organización prohíba `allUsers` | Misma exposición que (a). El cierre cambia: hay que reactivar la comprobación (runbook §6) |

**Recomendación:** (a) para la primera prueba, porque es lo validado. (b) es la mejora natural tras la aceptación, en
una misión aparte con pruebas propias. (c) solo si el proyecto queda bajo una organización que bloquee `allUsers`.

### 3.7 Límites de Cloud Run (plantilla)

| Parámetro | Valor | Motivo |
| --- | --- | --- |
| `minScale` / `maxScale` | 0 / 1 | Sin costo en reposo y una sola instancia como techo de cómputo |
| Facturación | Por solicitud (`cpu-throttling: 'true'`), sin *startup CPU boost* | Sin CPU fuera de las peticiones |
| Recursos | 1 vCPU, 512 MiB | Suficiente con datos de una hoja; subir a 1 GiB solo con evidencia |
| `containerConcurrency` / `timeoutSeconds` | 20 / 60 s | Pocas personas; las lecturas de Sheets tardan segundos, no minutos |
| Sonda de arranque | `/api/health`, 3 s × 10 intentos | Una revisión mal configurada no recibe tráfico |
| `ingress` | `all` | Necesario para OAuth desde el navegador ([§3.6](#36-invocación-pública-frente-a-login-privado)) |

### 3.8 Qué prueba y qué no prueba `/api/health`

| Prueba | No prueba |
| --- | --- |
| Variables de autenticación presentes y seguras (secreto ≥ 32, cliente OAuth, lista no vacía, `NEXTAUTH_URL` HTTPS) | Que Google acepte el cliente OAuth y la redirección |
| Política de credenciales coherente (ADC, cuenta esperada, sin claves) | Que la identidad ADC exista ni que tenga acceso a la hoja |
| Ausencia de modo de escritura y de escritores en Cloud Run | Que Secret Manager responda en tiempo de ejecución (Cloud Run resuelve los secretos al arrancar) |
| — | Que los datos de la hoja sean válidos (12/12 pestañas) |

`/api/health` **no prueba OAuth ni el acceso real a Google Sheets**. Esos puntos se aceptan con el
[checklist](despliegue-v1-6-aceptacion.md) (C1, C2, D1 y D2).

### 3.9 Alertas y apagado

- **Costo:** presupuesto y alertas (D6, D7). No son un límite ([§4.4](#44-presupuestos-y-alertas)).
- **Errores de la app:** revisión manual de *Registros* durante la prueba (checklist E). No se crean *uptime checks*
  ni políticas de Monitoring en esta fase, para no añadir recursos.
- **Cerrar el acceso** sin borrar nada: runbook §6. **Desmantelar:** runbook §7. **Apagado total:** borrar el
  proyecto dedicado (D1-a).

### 3.10 Registros y cabeceras

| Punto | Estado | Detalle |
| --- | --- | --- |
| Mensajes de la app | ✅ | Solo cinco `console.*`, todos con códigos o nombres de error, sin valores, correos ni contenido de la hoja |
| Logs de NextAuth | ⏳ | Sin `debug` ni *logger* propio. Sus errores de OAuth se revisan en el checklist E1 |
| Cabeceras | ✅ / ⚠️ | HSTS, `DENY`, `nosniff`, `no-referrer`, `Permissions-Policy`, `noindex` y `no-store` en lo privado. **Sin CSP** ([§5](#5-riesgos-de-seguridad-y-costos)) |
| ID de la hoja en la plantilla | ⚠️ | No es un secreto: el acceso lo controla *Compartir*. Ya era público en la CI |

## 4. Costos y regiones verificados

**Fecha de verificación:** 2026-10-10. Ninguna página consultada muestra fecha de actualización. Confianza de cada
dato:

- **[A] alta:** página oficial de precios leída completa. La pertenencia de las dos regiones a Tier 1 se comprobó dos
  veces sobre `cloud.google.com/run/pricing`.
- **[M] media:** documentación oficial consultada mediante el buscador, limitado a dominios de Google. El proxy de
  esta sesión bloquea `docs.cloud.google.com`, `developers.google.com` y `support.google.com`, así que **el
  propietario debe confirmar en el navegador los puntos [M]** antes de decidir.

Los precios están en USD, para servicios con **facturación por solicitud** (la de la plantilla).

### 4.1 Precios y niveles gratuitos

| Servicio | Nivel gratuito | Precio fuera del nivel gratuito | Fuente |
| --- | --- | --- | --- |
| Cloud Run | 180 000 vCPU-s, 360 000 GiB-s y 2 M de solicitudes al mes. Se suma **por cuenta de facturación** entre proyectos y se aplica como descuento a precio Tier 1 | Tier 1: USD 0,000024/vCPU-s, USD 0,0000025/GiB-s, USD 0,40/M de solicitudes. Las instancias inactivas que no son mínimas **no se cobran**; las solicitudes rechazadas por IAM no se facturan | [A] [precios de Cloud Run](https://cloud.google.com/run/pricing) |
| Secret Manager | 6 versiones activas, 10 000 accesos y 3 notificaciones de rotación al mes, por cuenta de facturación | USD 0,06 por versión activa al mes; USD 0,03 por 10 000 accesos. Las versiones **deshabilitadas siguen contando**; las destruidas no | [A] [precios de Secret Manager](https://cloud.google.com/secret-manager/pricing) |
| Artifact Registry | 0,5 GiB-mes por cuenta de facturación | Unos USD 0,10/GiB-mes. Transferencia gratis dentro de la misma ubicación | [A] [precios de Artifact Registry](https://cloud.google.com/artifact-registry/pricing) |
| Cloud Build (solo D10-b) | 2 500 minutos de build al mes por cuenta de facturación (e2-standard-2, sujeto a cambios) | USD 0,006/min (e2-standard-2) | [A] [precios de Cloud Build](https://cloud.google.com/build/pricing) |
| Cloud Logging | 50 GiB por proyecto al mes; el bucket `_Default` guarda 30 días sin costo | USD 0,50/GiB | [A] [precios de observabilidad](https://cloud.google.com/products/observability/pricing) |
| Salida a Internet (Cloud Run) | 1 GiB al mes dentro de Norteamérica | Según la tabla de red | [A] [precios de Cloud Run](https://cloud.google.com/run/pricing) |
| Google Sheets API | Sin costo adicional; 300 lecturas/min por proyecto y 60/min por usuario y proyecto | Google anuncia cargos **por exceder la cuota** "más adelante en 2026", con 90 días de aviso | [M] [límites de la API de Sheets](https://developers.google.com/workspace/sheets/api/limits) |

### 4.2 Región

| Criterio | `us-central1` (Iowa) | `northamerica-south1` (Querétaro) |
| --- | --- | --- |
| Tarifa de Cloud Run | Tier 1 [A] | Tier 1 [A] |
| Cloud Run, Artifact Registry y Secret Manager | Disponibles [M] | Disponibles: Artifact Registry desde 2024-11-20 y Secret Manager regional desde 2024-11-17 [M] |
| Mapeo de dominio propio de Cloud Run | Disponible, pero en **Preview** y "no recomendado para producción" [M] | **No disponible** [M]. Un dominio propio exigiría un balanceador de aplicaciones global (con costo fijo) o Firebase Hosting |
| Latencia desde Mérida | Mayor (centro de EE. UU.) | Menor (centro de México). Es una estimación geográfica, no una medición |
| Cumplimiento del formato de `render.mjs` | ✅ | ✅ |

**Recomendación (D3, no vinculante):** con URL `run.app` (D4-a) las dos regiones cuestan lo mismo. Se sugiere
`northamerica-south1` por cercanía. Conviene elegir `us-central1` si el propietario prevé un dominio propio mediante
mapeo de Cloud Run, o si prefiere la región con más funciones disponibles primero. Artifact Registry y el servicio
deben estar en la **misma** región: la transferencia es gratis dentro de una ubicación.

### 4.3 Estimación de costo (no es una promesa)

Supuestos: 1–2 personas, unas 1 000 páginas al mes (≈ 30 000 solicitudes con los archivos estáticos), unos 0,3 s
de CPU por solicitud, 3 secretos, 3 imágenes de unos 104 MB y builds locales.

| Escenario | Cálculo aproximado | Resultado |
| --- | --- | --- |
| La cuenta de facturación no tiene otros consumos | ≈ 9 000 vCPU-s, ≈ 4 500 GiB-s, 0,03 M de solicitudes, 3 versiones de secretos y ≈ 0,3 GB de imágenes: todo dentro de los niveles gratuitos | **Probablemente USD 0** |
| Los niveles gratuitos ya los gastan otros proyectos | CPU ≈ USD 0,22; memoria ≈ USD 0,01; solicitudes ≈ USD 0,01; secretos ≈ USD 0,18; imágenes ≈ USD 0,03 | **Menos de USD 1 al mes** |
| Desvíos posibles | Bucles de recarga, bots contra `/login`, versiones de secretos sin destruir, imágenes sin limpiar, Cloud Build, dominio con balanceador | Detectables con alertas (D7) y el checklist F |

Antes de la puerta 3, el propietario debe revisar la calculadora oficial con la región elegida.

### 4.4 Presupuestos y alertas

- **Un presupuesto no es un corte de gasto.** Google: *"Setting a budget does not automatically cap Google Cloud
  or Google Maps Platform usage or spending"*, y hay retraso entre el uso y su registro [M]
  ([presupuestos](https://cloud.google.com/billing/docs/how-to/budgets)).
- **Desactivar la facturación automáticamente** con Pub/Sub y una función **detiene todos los servicios del
  proyecto**, incluido el nivel gratuito. La recuperación es manual y no está garantizada; el ejemplo oficial da a
  una cuenta de servicio el rol de administrador de facturación [M]
  ([guía](https://cloud.google.com/billing/docs/how-to/disable-billing-with-notifications)). **No se recomienda**
  en esta fase: es una automatización destructiva y requiere aprobación aparte.
- **Presupuestos con tope de gasto (Preview).** Incluyen Cloud Run, por proyecto y servicio y en periodo mensual.
  Pausan el servicio al 100 %, pero la aplicación no es instantánea y el exceso se cobra [M]
  ([guía](https://cloud.google.com/billing/docs/how-to/budgets-spend-caps)). Es una opción a evaluar por el
  propietario (D7); por estar en Preview, no se asume.

### 4.5 OAuth

- **Estado *Prueba*:** máximo **100 usuarios de prueba** [M]. La caducidad de 7 días del consentimiento y del
  *refresh token* **no aplica** si los únicos alcances son nombre, correo y perfil, que es este caso [M]
  ([guía](https://support.google.com/cloud/answer/15549945)).
- **Verificación:** con alcances no sensibles no se requiere la verificación completa. Mostrar nombre y logotipo
  exige *brand verification*, de unos 2–3 días hábiles [M]
  ([guía](https://support.google.com/cloud/answer/13464323)). Para la prueba no hace falta.
- **Redirección:** coincidencia exacta, HTTPS salvo `localhost`, sin comodines [M]
  ([OAuth web](https://developers.google.com/identity/protocols/oauth2/web-server)).
- **Propagación:** *"It may take 5 minutes to a few hours for changes made to these settings to take effect"* [M]
  ([guía](https://support.google.com/cloud/answer/15549257)). Hay que crear el cliente **antes** de la ventana de
  despliegue.

### 4.6 Otros límites y referencias

| Punto | Dato | Encaje con la plantilla |
| --- | --- | --- |
| Timeout de solicitud | Por defecto 5 min, máximo 60 min [M] | 60 s ✅ |
| Memoria | Por defecto 512 MiB; 512 MiB es el mínimo de la segunda generación [M] | 512 MiB ✅ |
| Sonda de arranque | `failureThreshold × periodSeconds` ≤ 600 s [M] ([guía](https://cloud.google.com/run/docs/configuring/healthchecks)) | 10 × 3 s = 30 s ✅ |
| URL determinista | `https://SERVICIO-NUMERO_PROYECTO.REGION.run.app`, si el segmento DNS tiene ≤ 63 caracteres; siempre hay además una URL con hash [M] ([guía](https://cloud.google.com/run/docs/triggering/https-request)) | `project-os-dashboard-` + 12 dígitos ≈ 33 caracteres ✅ |
| Token con alcances propios | El metadata server acepta `?scopes=` en Cloud Run [M] ([identidad del servicio](https://cloud.google.com/run/docs/securing/service-identity)) | Lo usa `spreadsheets.readonly` ✅ (⏳ checklist C1) |
| Container Registry | Cerrado en 2025: solo Artifact Registry (`*-docker.pkg.dev`) [M] | El runbook y `render.mjs` ya exigen Artifact Registry ✅ |
| Cuenta de servicio de Cloud Build | En proyectos nuevos usa por defecto la cuenta de Compute, y Google recomienda indicar una propia [M] ([cambios](https://cloud.google.com/build/docs/cloud-build-service-account-updates)) | Otro motivo para preferir D10-a (Docker local). Si se elige D10-b, revisar esa cuenta antes del primer build |
| `gcloud` | Última versión 588.0.0 (2026-10-06) [M]. Los comandos del runbook se comprobaron con `--help` en 570.0.0 | Actualizar y repetir la comprobación del runbook §5.-1 |

## 5. Riesgos de seguridad y costos

| # | Riesgo | Prob. | Impacto | Mitigación | Residual |
| --- | --- | --- | --- | --- | --- |
| R1 | Login público alcanzable desde Internet (fuerza bruta o bots) | Media | Bajo | Lista explícita, correo verificado, sesión de 8 h, HSTS, `__Secure-`; las peticiones rechazadas no leen Sheets | Ruido en registros y algunas solicitudes facturables; IAP como mejora (§3.6) |
| R2 | Correo de la lista comprometido | Baja | Alto (lectura de la hoja) | Lista mínima (D5); revocar con nueva versión del secreto y redespliegue; rotar `NEXTAUTH_SECRET` | Ventana hasta la revocación |
| R3 | Cuenta de servicio con más permisos de los previstos | Baja | Alto | Sin roles de proyecto; Lector de un solo documento; identidad esperada verificada; checklist A5 y D2 | Depende de que el propietario no comparta otros documentos con ella |
| R4 | Escritura accidental | Muy baja | Alto | Token de solo lectura, cliente solo `GET`, rol Lector, `mock` prohibido en Cloud Run, sonda 503 con variables de escritura, prueba de plantilla | Ninguno conocido en esta versión |
| R5 | Gasto inesperado | Baja | Bajo–medio | `maxScale 1`, facturación por solicitud, limpieza de imágenes, alertas (D7), checklist F, apagado (runbook §7) | Un presupuesto **no es un corte**: hay retraso y no hay tope automático |
| R6 | Datos personales en registros | Baja | Medio | Solo códigos en los `console.*`; sin registro de peticiones de `/api/auth/*`; checklist E | Errores de terceros (NextAuth, Google) sin revisar hasta la prueba real |
| R7 | Sin CSP | Baja | Medio | React escapa el contenido, no hay HTML sin escapar ni contenido de terceros, `DENY` contra framing | Una CSP con *nonces* queda como mejora en un PR separado, sin cambiar la lógica en esta misión |
| R8 | URL o redirección OAuth incorrecta | Media | Bajo | URL determinista conocida de antemano; comprobación §5.7 antes del primer login; checklist A2 | La propagación de cambios de OAuth puede tardar horas (§4.5) |
| R9 | Cuota de Sheets o futuros cargos por excederla | Baja | Bajo | Caché de 60 s por instancia; 1–2 usuarios, muy por debajo de 60 lecturas/min | Política de cargos 2026 aún sin tarifas publicadas [M] |
| R10 | Datos [M] desactualizados o mal indexados | Media | Bajo–medio | Fecha de verificación, fuentes enlazadas y revisión del propietario antes de la puerta 3 | — |
| R11 | Recursos olvidados tras la prueba | Media | Bajo | Ventana fija (D11), proyecto dedicado (D1), runbook §7 | — |
| R12 | Alertas ruidosas del control V1.6 con datos reales | Media | Bajo | Son sugerencias, no acciones; revisión en el checklist C6 | Ajustar umbrales en una misión aparte |

**Conclusión:** no hay defectos críticos que obliguen a cambiar la lógica funcional antes de la prueba. Las mejoras
(CSP, IAP) quedan propuestas para PRs separados.
