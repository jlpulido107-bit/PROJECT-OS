# PROJECT-OS V1.3 — Decisión de hosting privado (09-oct-2026)

**Estado:** propuesta arquitectónica para Claude Code / PR de preparación. **No es autorización de despliegue ni de habilitar facturación.**

## Objetivo y restricciones
Acceder al dashboard V1.2 desde navegador móvil/escritorio fuera de localhost. Mantener Google Sheets como fuente de verdad, Google OAuth y `AUTH_ALLOWED_EMAILS`; datos detrás de la autenticación, sin permitir escritura ni añadir otra base de datos. Mantener sin cambios los workflows existentes de sincronización GitHub → Sheets.

## Alternativas comparadas

| Plataforma | Modelo de precio de referencia | Identidad para Sheets | Juicio para PROJECT-OS |
| --- | --- | --- | --- |
| **Google Cloud Run** | Facturación por uso y nivel gratuito (ver abajo) | **Service identity / ADC sin JSON persistente** | Preferida por seguridad, escalado a cero y proximidad a Google APIs; setup más técnico |
| Railway Hobby | Mínimo USD 5/mes, con USD 5/mes de consumo incluido | Secretos o identidad federada | Buena simplicidad, pero gasto base mensual |
| Render Starter | USD 7/mes por servicio de 512 MiB | Secretos o identidad federada | Servidor sencillo, gasto fijo |
| Vercel Pro | USD 20/mes (Hobby USD 0 solo proyectos personales no comerciales) | Secretos o federación | Muy cómodo para Next.js, costo mayor cuando el uso no es exclusivamente personal |

**Fuentes de precio (consultadas 2026-10-09):**
- https://cloud.google.com/run/pricing
- https://docs.cloud.google.com/run/docs/configuring/min-instances
- https://railway.com/pricing
- https://render.com/pricing
- https://vercel.com/pricing
- https://vercel.com/docs/limits/fair-use-guidelines

## Decisión recomendada: Google Cloud Run (no ejecutada)

### Configuración objetivo
- Construcción de imagen de Next.js 16/Node 22 en `web/`; imagen segura con usuario no root.
- Cloud Run **request-based**, **min-instances=0**, **max-instances=1** de entrada, memoria 512 MiB o 1 GiB según prueba local. CPU inicial 1 vCPU; estimaciones sujetas a benchmark.
- Región propuesta `us-central1` (comparar `northamerica-south1` por proximidad antes de gastar).
- Cuenta de servicio dedicada **adjunta al servicio**: credenciales con ADC, scope `spreadsheets.readonly`, compartir **solo el documento maestro** con esa identidad como Lector. No almacenar ni desplegar claves privadas JSON.
- `GOOGLE_CLIENT_SECRET` y `NEXTAUTH_SECRET` mediante Secret Manager, con rol `secretmanager.secretAccessor` limitado a esos secretos. OAuth Client ID y allowlist se configuran en el entorno de Cloud Run, **no en Git**.
- Aplicación con HTTPS; el callback exacto aprobado será `https://HOST/api/auth/callback/google`; `NEXTAUTH_URL` debe coincidir.
- **Importante:** el servicio puede tener entrada HTTPS públicamente alcanzable para realizar Google OAuth; eso **no significa** que el dashboard o `/api/resumen` sean públicos. La app valida sesión y allowlist antes de servir datos. Cloud Run IAM `allUsers` no reemplaza autenticación de usuario. Si se necesita restringir también la *superficie de red* del login, evaluar IAP/VPN en otra iteración.
- Configurar alertas de facturación y rollback con intervención humana; no auto-deploy.

### Modelo de costos (hechos vs estimaciones)
**Hechos documentados por proveedor:**
- Cloud Run request-based tiene nivel gratuito de **2 millones de solicitudes/mes**, **180,000 vCPU-segundos** y **360,000 GiB-segundos** de memoria según tarifas Tier 1; los descuentos y consumo se agregan por cuenta de facturación y pueden variar por región. Fuente: https://cloud.google.com/run/pricing
- Con facturación request-based y min instances 0, las instancias inactivas no generan cobro por tiempo idle; no es lo mismo que instance-based. Fuente: https://docs.cloud.google.com/run/docs/configuring/min-instances
- Secret Manager: hasta **6 versiones activas** y **10,000 accesos/mes** incluidos en el nivel gratuito. Fuente: https://cloud.google.com/secret-manager/pricing
- Artifact Registry: primeros **0.5 GiB-mes** de almacenamiento incluido, tarifas adicionales a partir de ahí. Fuente: https://cloud.google.com/artifact-registry/pricing
- Cloud Build: nivel gratuito de **2,500 build-minutos/mes** en la clase de máquina elegible, sujeto a cambios. Fuente: https://cloud.google.com/build/pricing

**Estimación, no promesa:** con un panel usado por una o pocas personas, pocas visitas diarias, min instances 0 y consumo agregado de Google Cloud debajo de los límites gratuitos, el coste variable del cómputo Cloud Run podría ser **USD 0/mes**. La factura total puede **no ser cero** por build, almacenamiento, tráfico, logs, uso compartido de cuotas gratuitas y servicios habilitados. No conocemos aún las cuotas ya utilizadas por la cuenta de facturación, el tamaño de imagen ni la región final. Debe comprobarse en la calculadora de precios antes de desplegar.

**Controles de gasto propuestos:** presupuesto inicial de prueba **USD 5/mes** con alertas 50%/90%/100%, limpieza de imágenes y `max-instances=1`, revisiones manuales periódicas. Las **alertas por sí solas NO detienen el gasto**; evaluar spend caps solo si Google Cloud soporta ese límite para los servicios aplicables y está disponible en la cuenta. Fuentes:
- https://docs.cloud.google.com/billing/docs/how-to/budgets
- https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps

### Qué debe preparar Claude Code
- Un PR con contenedor, soporte ADC, tests, hardening, instrucciones de Cloud Run/OAuth/Secret Manager, presupuesto y rollback.
- Ninguna credencial, cuenta personal, output de API privada o JSON de service account debe estar en Git, imagen, CI o comentarios.
- No ejecutar `gcloud run deploy`, habilitar APIs de pago o crear servicios desde CI. Preparar comandos **documentados para revisión humana**, no script auto-ejecutable de provisioning.
- CI con fixtures, autenticación sin sesión, tests de acceso denegado, `npm run audit:prod`, `npm run audit:critical`, `npm run check:client-secrets`, pruebas de Docker si el runner lo permite.
- En la futura PR, desplazar el antiguo alcance «V1.3 — Informes y planificación» a **V1.4** sin descartar tareas. La V1.3 nueva es **Acceso remoto privado**.

### Puertas pendientes de aprobación
1. **PR de código** revisado, sin merge automático.
2. **Cuenta/proyecto GCP**, región, dominio y gasto máximo seleccionados por el usuario; autorización separada para recursos con facturación.
3. **Despliegue inicial** a HTTPS + nuevos redirect URIs OAuth; smoke tests sin sesión/con sesión, lectura Google Sheets y ausencia de escrituras.
4. **Habilitar acceso regular** y definir mantenimiento/costos.

## Referencias adicionales
- ADC y service identities: https://docs.cloud.google.com/docs/authentication y https://docs.cloud.google.com/run/docs/configuring/services/service-identity
- Misión completa: https://github.com/jlpulido107-bit/PROJECT-OS/issues/5
