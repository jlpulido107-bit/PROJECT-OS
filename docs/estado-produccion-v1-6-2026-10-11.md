# PROJECT-OS V1.6 — Registro de puesta en producción

**Fecha del registro:** 2026-10-11  
**Estado:** despliegue inicial operativo; validación funcional del propietario satisfactoria.  
**Ámbito:** registro de evidencias observadas durante el despliegue manual y las pruebas. No crea ni autoriza cambios de infraestructura.

> Este documento actualiza el estado histórico de preparación de la [Puerta C](puerta-c-v1-6.md) y el [runbook](despliegue-privado-v1-3.md). No sustituye la [lista completa de aceptación](despliegue-v1-6-aceptacion.md), que conserva comprobaciones operativas pendientes.

> **Estado vigente (Misión 014):** las §2 y §5 conservan lo observado **durante** el despliegue. Por ejemplo, la
> etiqueta `produccion` sin confirmar y el `maxScale` de servicio en 3. Las operaciones posteriores están en la **§7**.
> El estado congelado de la versión, con la fecha y la procedencia de cada evidencia, está en la
> [línea base V1.6](operacion-v1-6/linea-base-v1-6.md), y el estado de cada control en la
> [matriz](operacion-v1-6/matriz-aceptacion.md).

## 1. Identidad de la versión desplegada

| Elemento | Valor / resultado |
| --- | --- |
| Repositorio | `jlpulido107-bit/PROJECT-OS` |
| Rama de origen | `main` |
| Commit de la **aplicación desplegada** | `7f44216bdf85a9832e014f45c27ac643e00ceff9` |
| Proyecto GCP | `project-os-511102` |
| Región | `northamerica-south1` |
| Servicio | `project-os-dashboard` |
| Revisión | `project-os-dashboard-00001-gsk` |
| URL estable utilizada por NextAuth y OAuth | [PROJECT-OS](https://project-os-dashboard-235975889400.northamerica-south1.run.app) |
| Imagen en Artifact Registry | `northamerica-south1-docker.pkg.dev/project-os-511102/project-os/dashboard:7f44216` |
| Digest de la imagen | `sha256:f6e46596ef36522134096d97431f32036bb71298033f9694023137497d3d5c07` |
| Cloud Build | `7768d6a3-332a-48bb-9872-db6b000e929a` — `SUCCESS` |

El despliegue se ejecutó con `gcloud run services replace` a partir del manifiesto renderizado y con imagen fijada por digest. La revisión informó `Ready=True`, `ConfigurationsReady=True` y `RoutesReady=True`. La nueva documentación en Git **no cambia la imagen ya desplegada**.

## 2. Controles de infraestructura observados

- Compilación con cuenta dedicada `project-os-build@project-os-511102.iam.gserviceaccount.com`, con logs de Cloud Build; imagen publicada en Artifact Registry.
- Ejecución con cuenta `project-os-dashboard-run@project-os-511102.iam.gserviceaccount.com`; Google Sheets en modo lectura mediante ADC, sin clave JSON de servicio en el contenedor.
- Tres secretos de runtime administrados con Secret Manager: `project-os-nextauth-secret`, `project-os-google-client-secret` y `project-os-allowed-emails`. **No** se registran valores, tokens ni credenciales.
- Política de limpieza de Artifact Registry verificada con `PERMITIDO`: conservar 3 versiones recientes, preservar etiquetas `produccion*` y eliminar versiones antiguas según la política. La **etiqueta `produccion` para el digest desplegado no se ha confirmado aplicada**; ver pendientes.
- Servicio con instancia mínima 0, límite de revisión de 1 instancia y CPU por solicitud (`cpu-throttling: true`); 1 vCPU y 512 MiB. Se observó también una anotación de servicio `run.googleapis.com/maxScale: '3'`; revisar la interacción de límites sin modificarla automáticamente.
- Presupuesto mensual de USD 5 con alertas, **reportado por el propietario**; no se verificaron importes facturados. Las alertas no son un límite duro de gasto.
- Cliente OAuth de producción tipo *Web application*, con origen `https://project-os-dashboard-235975889400.northamerica-south1.run.app` y callback `https://project-os-dashboard-235975889400.northamerica-south1.run.app/api/auth/callback/google`; el propietario confirmó las entradas y el estado *Testing*.
- Por autorización explícita, IAM de Cloud Run incluye `allUsers` con `roles/run.invoker` **solo para este servicio**, con `ingress: all`. Esto expone la superficie HTTP, no los datos: NextAuth y la lista explícita de correos protegen las rutas privadas.

## 3. Evidencias de validación

| Comprobación | Resultado comunicado / observado |
| --- | --- |
| `npm test` | **563/563** pruebas aprobadas en 26 archivos |
| `npm run typecheck` | Sin errores |
| `npm run build` | Next.js 16.3.8 compiló correctamente en Cloud Shell |
| `npm run test:e2e` | **63/63**, autenticación HTTP local con datos sintéticos |
| `npm run test:e2e:integration` | **63/63**, roles, errores, modos de escritura y flujos simulados locales |
| `npm run check:client-secrets` | 22 archivos estáticos revisados; sin coincidencias de claves, tokens ni correos. **0 valores reales del entorno comparados**, por lo que esta parte no se validó frente a secretos de producción |
| `npm run audit:prod` | **0 vulnerabilidades reportadas** en dependencias de producción |
| `npm run audit:critical` | **5 vulnerabilidades altas**, asociadas al árbol de herramientas de desarrollo ESLint (`braces` → `micromatch` → `fast-glob` → `@next/eslint-plugin-next` → `eslint-config-next`); no hay críticos reportados. No se aplicó `npm audit fix --force` |
| `npm run smoke:remote -- --url https://project-os-dashboard-235975889400.northamerica-south1.run.app` | **26/26**, health 200, login público, páginas privadas redirigen, APIs privadas 401 y cabeceras de seguridad |
| Navegador con Google OAuth real | El propietario confirmó inicio de sesión y uso del dashboard **sin errores** |
| Google Sheets real | Lectura funcional indicada por el propietario al comprobar el dashboard. No se compararon en esta sesión las 12 pestañas ni los totales contra la hoja |

**Total de comprobaciones con conteo explícito:** 563 unitarias + 63 E2E autenticación + 63 E2E integración + 26 remotas = **715 aprobadas**. Build, TypeScript, auditorías y validación manual son verificaciones adicionales sin sumar al conteo.

La prueba remota fue **sin sesión**; no suplanta la prueba humana con OAuth ni la prueba de revocación con una cuenta no autorizada. Las E2E usan datos sintéticos, no modifican Google Sheets.

## 4. Seguridad y restricciones vigentes

1. El proxy de Next.js aplica la política de rutas públicas y privadas; el layout `(private)` llama a `requireUser()`, y los manejadores de API/escritura repiten controles de servidor.
2. Google OAuth exige correo verificado y perteneciente a `AUTH_ALLOWED_EMAILS`. Sesiones JWT; páginas sin sesión redirigen y APIs privadas devuelven `401`; correos no autorizados se rechazan.
3. El modo de escritura de operaciones se mantiene **deshabilitado en Cloud Run**. Los tests de escritura `mock` fueron locales y sintéticos; la aplicación de producción **no escribe en Sheets**.
4. No se guardan secretos, correos personales, valores de la hoja, JSON de cuentas de servicio ni IDs de facturación en este registro.
5. Toda mutación futura (build, despliegue, configuración OAuth, IAM, secretos, etiquetado de imágenes o scripts programados) requiere autorización específica. El commit documental no concede esas autorizaciones.

## 5. Pendientes operativos, sin ejecución automática

- **A9 — Etiqueta de protección del digest:** verificar si `dashboard:produccion` apunta al digest desplegado; si no, solicitar autorización independiente para aplicar el etiquetado. La política de limpieza conserva tres versiones recientes, pero esa retención por sí sola no garantiza protección indefinida del digest desplegado ante múltiples builds futuros.
- **Aceptación completa:** recorrer [checklist](despliegue-v1-6-aceptacion.md), especialmente cuenta no autorizada (C2), conciliación con pestañas/totales de Sheets (C1), lectura estricta e historial de cambios (D1–D2), logs sin datos sensibles (E1–E2) y procedimientos de rollback/apagado (G1–G3).
- **Costos reales:** revisar informes tras 24–48 horas y periódicamente (F2); presupuesto es alerta, no tope.
- **Límites de escalado:** conciliar anotación de servicio `maxScale: 3` con configuración de revisión `maxScale: 1`; no ajustar sin diagnóstico y autorización.
- **Dependencias de desarrollo:** analizar las cinco alertas altas del árbol ESLint en mantenimiento, evitando `npm audit fix --force` sin plan de compatibilidad.
- **Retención de imágenes:** evaluar el efecto real de la política al acumular imágenes suficientes y superar 30 días (F3).

## 6. Continuidad y fuente de verdad

- **Código efectivamente desplegado:** commit `7f44216`; **documentar el despliegue en Git no redepliega el servicio**.
- **Estado operacional observado:** este registro fechado; las políticas y el estado actual de GCP deben verificarse de nuevo antes de cambios futuros.
- **Comandos y rollback:** [runbook de despliegue](despliegue-privado-v1-3.md); [checklist posterior](despliegue-v1-6-aceptacion.md).
- **Documentación y cambios en GitHub:** `main`, con revisión humana para futuras mutaciones de producción.

## 7. Operaciones posteriores al despliegue (2026-10-11, Cloud Shell)

Ejecutadas por el propietario tras la auditoría de solo lectura ([remediación](operacion-v1-6/remediacion-2026-10-11.md)).
Cada mutación se hizo con confirmación expresa y se verificó de inmediato. **Ninguna cambió la imagen ni la revisión.**

| Operación | Resultado verificado |
| --- | --- |
| C9: etiqueta `dashboard:produccion` → digest desplegado `sha256:f6e46596…5c07` | A9 = OK. Primer despliegue: no hay `produccion-anterior` |
| Versión 1 de `project-os-google-client-secret`, no usada: deshabilitada, login comprobado y luego **destruida** | Cada secreto tiene exactamente 1 versión `ENABLED`, que es la fijada en la revisión |
| Máximo de instancias del **servicio** 3 → 1 (`gcloud run services update --max=1`) | Servicio 1, revisión 1; sigue `project-os-dashboard-00001-gsk` con el 100 % del tráfico |
| Exclusión `project-os-callback-oauth` en el sink `_Default` (peticiones al callback OAuth) | Exclusión activa. La entrada anterior con `code=` caduca en ≤ 30 días |
| `npm run smoke:remote` posterior | **26/26** |

Pendientes en navegador: callback en la consola OAuth (A2), 12 pestañas y totales (C1), cuenta no autorizada (C2),
historial y permisos de la hoja (D1, D2), presupuesto y gasto (F1, F2) y máximo histórico de instancias (A7).

**Nota (Misión 014):** la herramienta que añadió la exclusión solo comprobó que existiera **con ese nombre**. El filtro
y `disabled=false` no se verificaron, y la exclusión solo cubre el sink `_Default`. Su estado (`CORRECTA` esperado) lo
muestra `diagnostico` ([hoja del propietario](operacion-v1-6/hoja-propietario.md), bloque 5).
