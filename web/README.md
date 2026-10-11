# PROJECT-OS — Dashboard web (solo lectura)

Panel privado, usable en móvil y escritorio, que **lee** la Google Sheet operativa de PROJECT-OS.
No escribe en Sheets ni cierra tareas.

- **V1.2** (fusionada): ejecución local/privada, validada con Google OAuth y Sheets reales.
- **V1.3–V1.6**: imagen Docker y despliegue **manual** en Google Cloud Run con identidad de servicio (ADC, sin
  clave JSON), Secret Manager y costos controlados. **V1.6 desplegada** (commit `7f44216`); ver el
  [registro de producción](../docs/estado-produccion-v1-6-2026-10-11.md) y la
  [operación V1.6](../docs/operacion-v1-6/README.md).

- **Stack:** Next.js 16 (App Router) + TypeScript, NextAuth v4 (Google OAuth), `google-auth-library`; pruebas con Vitest 4.
- **Nota npm:** `npm ci` funciona con npm 10. Para *cambiar* dependencias usa npm 11 (`npx npm@11 install …`): npm 10 falla al resolver los peers opcionales de Vitest 4.
- **Datos:** Google Sheets API v4, cuenta de servicio, alcance `spreadsheets.readonly`, solo en el servidor.
  Credenciales con selección explícita (`SHEETS_CREDENTIALS`): clave local fuera del repo, o ADC en Cloud Run.
- **Pantallas:** Inicio ejecutivo · Proyectos (lista y detalle) · Tareas (filtros) · Actividad · Capacidad y plan diario.

Decisiones técnicas, riesgos y límites: [`docs/decisiones-dashboard-v1-2.md`](../docs/decisiones-dashboard-v1-2.md).

## Requisitos

- **Node.js 22 LTS o superior** y npm (`.nvmrc` = 22). `google-auth-library` 11 exige Node ≥ 22; con Node 20
  (sin soporte desde abril de 2026) `npm ci` muestra avisos `EBADENGINE` y la lectura real de Sheets no está garantizada.
- Para datos reales: una cuenta de servicio con acceso de **Lector** a la hoja.
- Para iniciar sesión: un cliente OAuth de Google (tipo *Aplicación web*).

## Inicio rápido con datos sintéticos (sin credenciales de Google Sheets)

```bash
cd web
npm ci
cp .env.example .env.local
# Edita .env.local:
#   DASHBOARD_DATA_SOURCE=fixtures
#   NEXTAUTH_SECRET=<salida de: openssl rand -base64 32>
#   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET  (ver "Autenticación")
#   AUTH_ALLOWED_EMAILS=tu-correo@dominio
npm run dev     # http://localhost:3000
```

El modo `fixtures` muestra una franja **"Datos sintéticos de demostración"** en todas las páginas.
Aun así exige iniciar sesión.

## Conexión con la Google Sheet real (solo lectura)

1. En Google Cloud, en un proyecto bajo tu control, habilita **Google Sheets API**.
2. Usa una **cuenta de servicio dedicada al dashboard** (recomendado) o la de V1.1. Para el dashboard basta con
   compartir la hoja como **Lector**; no compartirla por enlace público.
   - Aunque la cuenta tuviera permiso de Editor, el dashboard pide el alcance
     `https://www.googleapis.com/auth/spreadsheets.readonly` y solo emite peticiones `GET`.
3. Crea una clave JSON **solo si tu política lo permite** y guárdala **fuera del repositorio**, por ejemplo
   `~/.config/project-os/dashboard-sa.json` con permisos `600`.
4. En `web/.env.local`:
   ```
   DASHBOARD_DATA_SOURCE=sheets
   SHEETS_SPREADSHEET_ID=16UXe7fm90fOTTVJhI_RZ8__I876u2buvjeLGr5cJ-Ic
   SHEETS_CREDENTIALS=service-account-key
   PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_FILE=/ruta/absoluta/fuera/del/repo/dashboard-sa.json
   ```
   Si `SHEETS_CREDENTIALS` falta pero hay clave configurada, se usa la clave (compatibilidad con V1.2).
   Nunca se cae a otra credencial en silencio. En Cloud Run las claves JSON están **prohibidas**
   (`SHEETS_CREDENTIALS=adc` + `SHEETS_EXPECTED_SERVICE_ACCOUNT`).
5. `npm run dev` y abre el **Diagnóstico de datos** al final del Inicio: las 12 pestañas deben aparecer como
   *Válido*. Si falta o cambia una columna, la pestaña se marca y sus datos se muestran como "no disponibles",
   nunca como cero.

## Autenticación

Autenticación real con **NextAuth v4 + Google OAuth** (no hay formularios de contraseña propios).

1. Google Cloud → *APIs y servicios* → *Pantalla de consentimiento OAuth*: tipo **Externo** en modo
   **Prueba** (o Interno si usas Workspace) y agrega tu correo como usuario de prueba.
2. *Credenciales* → *Crear ID de cliente OAuth* → **Aplicación web**.
   - Orígenes autorizados: `http://localhost:3000`
   - URI de redirección: `http://localhost:3000/api/auth/callback/google`
3. Copia el ID y el secreto a `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` en `.env.local`.
4. `NEXTAUTH_SECRET`: `openssl rand -base64 32`. `NEXTAUTH_URL=http://localhost:3000`.

### Política de usuarios y sesiones

- **Lista explícita** de correos en `AUTH_ALLOWED_EMAILS` (separados por coma, sin distinguir mayúsculas).
  Lista vacía ⇒ nadie entra.
- Google debe reportar el correo como **verificado** (`email_verified`).
- La lista se comprueba al iniciar sesión **y en cada petición** (proxy + cada página/API): quitar un correo
  revoca el acceso en la siguiente petición sin esperar a que caduque la sesión.
- Sesión en cookie **cifrada** (JWE, `httpOnly`, `SameSite=Lax`, `Secure` cuando `NEXTAUTH_URL` es https),
  duración máxima **8 h** (`AUTH_SESSION_MAX_AGE_SECONDS`, tope 7 días).
- Sin sesión válida: páginas → redirección a `/login`; `/api/resumen` → `401`; correo no permitido → `403`
  o `/login?error=AccessDenied`. Ninguna respuesta incluye datos de la hoja.

## Scripts

| Comando | Qué hace |
| --- | --- |
| `npm run dev` | Servidor de desarrollo. |
| `npm run build` / `npm start` | Build de producción y servidor local (`next start`). |
| `npm run lint` | ESLint (config de Next + TypeScript). |
| `npm run typecheck` | `tsc --noEmit` en modo estricto. |
| `npm test` | Pruebas unitarias (Vitest): parsing, fechas Mérida, conteos, vacíos, cliente Sheets, autorización de rutas, revisiones de seguridad. |
| `npm run test:e2e` | Requiere `npm run build`. Levanta `next start` con datos sintéticos y secretos aleatorios y comprueba, por HTTP real, que sin sesión válida ninguna página/API devuelve datos. |
| `npm run audit:prod` / `npm run audit:critical` | Fallan ante vulnerabilidades high/critical de producción o critical en cualquier dependencia. Detalle en `docs/decisiones-dashboard-v1-2.md`. |
| `npm run docker:smoke` | Construye la imagen y la prueba: usuario no root, sin archivos secretos, `PORT` configurable, autorización HTTP contra el contenedor, simulación de Cloud Run (configuración insegura → `/api/health` 503) y logs sin secretos. Sin Google Cloud. |
| `npm run smoke:remote -- --url https://…` | Solo tras autorizar un despliegue: comprobaciones **sin sesión** contra la URL (solo imprime códigos HTTP). No se ejecuta en CI. |
| `npm run check:client-secrets` | Requiere `npm run build`. Busca claves, tokens, correos y los valores de las variables secretas del entorno en `.next/static`. |

En CI, `.github/workflows/web-validation.yml` ejecuta esta misma secuencia en cada PR que toca `web/`.

Validación completa antes de pedir revisión:

```bash
npm ci && npm run audit:prod && npm run audit:critical && npm run lint && npm run typecheck && npm test && npm run build \
  && npm run test:e2e && npm run check:client-secrets && npm run docker:smoke
```

`docker:smoke` necesita Docker. Detrás de un proxy corporativo que intercepta TLS, usa
`EXTRA_CA_FILE=/ruta/ca.pem npm run docker:smoke`: la CA se monta solo durante `npm ci` y no queda en la imagen.

## Docker y Cloud Run (V1.3)

- `Dockerfile` multi-stage: Node 22 fijado por digest, `npm ci --ignore-scripts`, salida `standalone` de Next,
  usuario `node` sin privilegios, código de solo lectura y `PORT`/`HOSTNAME=0.0.0.0`.
- `.dockerignore` es una **lista de permitidos**: solo entran `package*.json`, `next.config.ts`,
  `tsconfig.json` y `src/`. Nunca entran `.env.local`, claves ni `.git`.
- `GET /api/health` es público y no lee Sheets ni la sesión. Responde `200 {"status":"ok"}` o
  `503 {"status":"unavailable"}` si la configuración es insegura: URL sin HTTPS, secretos ausentes, clave
  JSON o datos sintéticos en Cloud Run, o falta de `SHEETS_EXPECTED_SERVICE_ACCOUNT`. Es la sonda de
  arranque de Cloud Run.
- `deploy/cloudrun/service.template.yaml` es una plantilla declarativa (min 0 / max 1, CPU por solicitud,
  512 MiB, secretos de Secret Manager por versión). `deploy/cloudrun/render.mjs` la valida y genera el YAML.
  `deploy/cloudbuild.template.yaml` es solo para build manual: `deploy/build-command.mjs` genera la configuración literal con la cuenta dedicada.
- El despliegue, el costo, el rollback y la eliminación de recursos están en
  [`docs/despliegue-privado-v1-3.md`](../docs/despliegue-privado-v1-3.md). Nada se despliega desde CI.

## Datos: reglas de lectura

- Encabezados validados **por nombre exacto** (`src/lib/schema.ts`); el orden puede variar; columnas extra se ignoran.
- Celdas vacías ⇒ `null` ("Sin registrar", "Sin datos"); nunca se convierten en 0.
- Números: coma o punto decimal; textos o negativos se reportan como incidencia (sin mostrar el valor).
- Fechas `AAAA-MM-DD` = fecha civil; fechas con hora y zona se muestran en **hora de Mérida**; fecha-hora sin zona
  se interpreta como hora de Mérida; formatos ambiguos (`08/10/2026`) se marcan como inválidos.
- Hasta 5 000 filas por pestaña en una sola lectura `batchGet`; al superarlo se avisa que los totales pueden estar incompletos.
- Caché en memoria de 60 s (configurable, máx. 300 s). El botón **Actualizar datos** fuerza una relectura
  (como mucho una vez cada 10 s). No hay actualización en tiempo real.
- Estados: una tarea es *abierta* si su `ESTADO` no está vacío y no es `COMPLETADO`/`CANCELADO`.
  *Bloqueada* = abierta con `BLOQUEO` no vacío o `ESTADO=BLOQUEADO`. Las dependencias pendientes se muestran aparte.
- Evidencias: *evento observado* (sin `TAREA_ID`) ≠ *tarea validada* (vinculada a tarea con `COMPLETADO`
  registrado por una persona). `VERIFICACION=CONFIRMADO` solo confirma el evento en su fuente.

## Estructura

```
web/
  src/proxy.ts                 # barrera de autenticación (Next 16 "proxy", antes middleware)
  src/lib/schema.ts            # diccionario de datos exacto
  src/lib/parse.ts, dates.ts   # normalización de celdas, números y fechas (America/Merida)
  src/lib/table.ts             # validación de encabezados y mapeo tipado de filas
  src/lib/aggregate.ts         # conteos, bloqueos, tiempos, capacidad, filtros, paginación
  src/lib/sheets-client.ts     # cliente GET-only de Sheets API (server-only)
  src/lib/credentials.ts       # política explícita: clave local o ADC (Cloud Run) + identidad esperada
  src/lib/deployment.ts        # comprobaciones de configuración para /api/health
  src/lib/data.ts              # selección de fuente + caché corta (server-only)
  src/lib/auth.ts, access.ts, authz.ts  # NextAuth, lista de permitidos, decisión de acceso
  src/lib/fixtures.ts          # datos SINTÉTICOS (no es copia de la hoja real)
  src/app/(private)/…          # páginas privadas
  tests/                       # Vitest
  scripts/                     # e2e de autorización, smoke Docker/remoto y revisión de secretos en assets
  Dockerfile, .dockerignore    # imagen de producción
  deploy/                      # plantilla Cloud Run, render, Cloud Build y limpieza de Artifact Registry
```

## Capturas (datos sintéticos)

| Escritorio | Móvil | Móvil (modo oscuro) |
| --- | --- | --- |
| ![Inicio en escritorio](docs/capturas/escritorio-inicio.png) | ![Inicio en móvil](docs/capturas/movil-inicio.png) | ![Tareas en móvil, modo oscuro](docs/capturas/movil-oscuro-tareas.png) |

Más: [tareas en escritorio](docs/capturas/escritorio-tareas.png), [capacidad en móvil](docs/capturas/movil-capacidad.png),
[inicio de sesión](docs/capturas/movil-login.png).

## Fuera de alcance

Escritura/CRUD, auditoría de cambios, reglas de cierre `COMPLETADO`, planificador, scheduling, despliegue
automático (CD) y cualquier segunda base de datos. El despliegue manual de V1.3 requiere autorización
explícita del usuario.
