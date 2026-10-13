# PROJECT-OS V1.6 — Checklist de aceptación posterior al despliegue privado

> **Uso:** solo después de que el usuario autorice y ejecute el despliegue (puertas 2 y 3 del
> [runbook](despliegue-privado-v1-3.md#1-puertas-de-autorización)). Este documento **no autoriza** nada por sí mismo.
>
> **Registro:** marca cada fila con ✅ / ❌ / N/A en una copia (issue o comentario del PR de despliegue), con la
> fecha y el SHA desplegado. **Nunca** pegues secretos, tokens, correos reales, IDs de cuenta de facturación ni
> capturas con datos de la hoja.

Variables usadas (las mismas del runbook, §5.0): `PROJECT_ID`, `REGION`, `SERVICE_NAME`, `SERVICE_URL`,
`RUNTIME_SA`.

> **Estado de cada fila (Misión 014):** [matriz de aceptación](operacion-v1-6/matriz-aceptacion.md), con evidencia
> fechada en la [línea base](operacion-v1-6/linea-base-v1-6.md). Lo que falta lo comprueba el propietario con la
> [hoja](operacion-v1-6/hoja-propietario.md). En E2, la búsqueda de `[project-os]` va **sin** filtro de severidad
> ([runbook operativo §5.1](operacion-v1-6/runbook-operativo.md)).

## A. Configuración desplegada (antes de abrir el acceso)

| # | Verificación | Cómo | Esperado |
| --- | --- | --- | --- |
| A1 | La imagen es la revisada, por digest | `gcloud run services describe "$SERVICE_NAME" --region "$REGION" --format='value(spec.template.spec.containers[0].image)'` | `…@sha256:` igual al `IMAGE` del runbook §5.5, construido desde el SHA de `main` aprobado |
| A2 | URL real = `NEXTAUTH_URL` = redirección OAuth | `…describe … --format='yaml(status.url,metadata.annotations)'` (C4v de la [Puerta C](puerta-c-v1-6.md)) y la consola de OAuth | `$SERVICE_URL` aparece en `run.googleapis.com/urls` **antes** de registrar el callback (C4b) y de abrir `allUsers`. El cliente OAuth tiene exactamente `$SERVICE_URL/api/auth/callback/google`, copiada de la URL verificada y no de un cálculo |
| A3 | Sonda de arranque | `curl -s -o /dev/null -w '%{http_code}' "$SERVICE_URL/api/health"` | `200`. **No prueba OAuth ni el acceso real a Sheets**: solo que la configuración es coherente |
| A4 | Sin modo de escritura | `…describe … --format='value(spec.template.spec.containers[0].env[].name)'` (solo nombres, nunca valores) | No aparecen `PROJECT_OS_WRITE_MODE` ni `AUTH_WRITER_EMAILS` |
| A5 | Identidad del servicio sin roles de proyecto | `…describe … --format='value(spec.template.spec.serviceAccountName)'` y la consulta de §5.4 del runbook | Es `$RUNTIME_SA`; la consulta de roles de proyecto sale **vacía** |
| A6 | Secret Manager con versión fijada y acceso mínimo | `gcloud secrets get-iam-policy SECRETO` para los 3 secretos (nunca `versions access`) | Solo `$RUNTIME_SA` con `roles/secretmanager.secretAccessor`; la plantilla usa versiones numéricas, no `latest` |
| A7 | Límites de costo aplicados | `…describe … --format='yaml(spec.template.metadata.annotations)'` | `minScale: '0'`, `maxScale: '1'`, `cpu-throttling: 'true'` |
| A8 | Identidad de compilación (solo D10-b) | Log del build en *Cloud Build → Historial* y `gcloud builds describe BUILD_ID --project="$PROJECT_ID" --region "$BUILD_REGION" --format='value(serviceAccount)'` | Es la **primera prueba real**: hasta ahora el metadata server solo está simulado en las pruebas. El paso `verificar-identidad` dice *"Identidad de compilación verificada"*. La cuenta es `project-os-build`. `gcloud projects get-iam-policy` (runbook §5.5, A.1) muestra solo `roles/logging.logWriter` para ella. N/A con Docker local |
| A9 | Imagen desplegada protegida | `gcloud artifacts docker images describe "${IMAGE_BASE}:produccion" --project="$PROJECT_ID" --format='value(image_summary.digest)'` | El digest coincide con el de A1. Si había una imagen anterior en producción, `produccion-anterior` apunta a ella (runbook §5.7, C9) |

## B. Smoke HTTP sin sesión

| # | Verificación | Cómo | Esperado |
| --- | --- | --- | --- |
| B1 | Todo lo privado está cerrado | desde `web/`: `npm run smoke:remote -- --url "$SERVICE_URL"` | `27/27` (26/26 hasta V1.6): 14 páginas con redirección a `/login`, 7 APIs con `401` sin datos, sonda `200`, `/login` `200`, HSTS, `no-store`, `DENY`, sesión vacía. Solo usa `GET` |

## C. Navegador (personas)

| # | Verificación | Cómo | Esperado |
| --- | --- | --- | --- |
| C1 | Invitado autorizado entra | Ventana privada → `$SERVICE_URL` → *Continuar con Google* con un correo de `AUTH_ALLOWED_EMAILS` | Inicio con origen **"Leído de Google Sheets"**, 12/12 pestañas válidas, totales iguales a la hoja |
| C2 | Cuenta no autorizada es rechazada | Otra cuenta de Google en ventana privada. En el caso **interno** (D9-a), probar dos: una de la organización que no esté en la lista y, si existe, una externa | Vuelve a `/login` con acceso denegado; ninguna página ni API muestra datos. La cuenta externa es rechazada por Google antes de llegar a la app |
| C3 | `401` y `403` | `401`: cubierto por B1. `403` (opcional): con una sesión abierta, retira ese correo de la lista (nueva versión del secreto + redespliegue) y recarga | `401` sin sesión; `403` o redirección con *AccessDenied* para una sesión cuyo correo ya no está permitido |
| C4 | Dashboard | Inicio, Proyectos, Tareas, Actividad, Capacidad y plan | Cargan con datos reales, sin errores |
| C5 | Planificación (V1.5) | `/planificacion` y un escenario simulado | Propuestas con explicaciones; aviso de que no se escribe nada; el escenario no cambia la hoja |
| C6 | Centro de control (V1.6) | `/control` y la revisión simulada de una alerta | Alertas con hechos, inferencias, hipótesis y acciones sugeridas; aviso **"Simulación — no se guardaron cambios"**; el estado global no es "verde" si faltan pestañas |
| C7 | Operaciones (V1.4) cerradas | Menú, `/operaciones` y `/tareas/nueva` | Sin enlace a Operaciones; los formularios indican que la escritura está deshabilitada |

## D. Solo lectura real

| # | Verificación | Cómo | Esperado |
| --- | --- | --- | --- |
| D1 | La cuenta de servicio no editó la hoja | Google Sheets → *Archivo → Historial de versiones* durante la ventana de prueba | Ningún cambio atribuido a `$RUNTIME_SA` |
| D2 | Permiso mínimo en la hoja | Google Sheets → *Compartir* | `$RUNTIME_SA` solo como **Lector**; acceso general **Restringido** |
| D3 | Alcance del token | Revisión de código (`web/src/lib/credentials.ts`, `sheets-client.ts`) | `spreadsheets.readonly` y solo peticiones `GET`. No hay comprobación en tiempo de ejecución: D1 y D2 son la evidencia real |

## E. Registros sin datos personales

| # | Verificación | Cómo | Esperado |
| --- | --- | --- | --- |
| E1 | Sin correos ni tokens | Logs Explorer, filtro `resource.type="cloud_run_revision" AND resource.labels.service_name="project-os-dashboard"` en la ventana de prueba; buscar `@`, `ya29.`, `Bearer`, `code=` | Sin coincidencias, salvo nombres de servicio de Google Cloud que no sean correos de personas |
| E2 | Solo códigos de la app | Mismo filtro, buscar `[project-os]` | Únicamente códigos (`write-mode`, `data-config`, nombres de error), sin valores ni contenido de la hoja |

## F. Facturación

| # | Verificación | Cómo | Esperado |
| --- | --- | --- | --- |
| F1 | Presupuesto y alertas existen | *Facturación → Presupuestos y alertas* | Presupuesto del proyecto con los umbrales acordados. Recordatorio: **avisa, no corta el gasto** |
| F2 | Costo real tras 24–48 h | *Facturación → Informes*, filtrado por el proyecto | Coherente con la estimación de [preparación §4](despliegue-v1-6-preparacion.md#4-costos-y-regiones-verificados); cualquier cargo inesperado se investiga antes de la puerta 4 |
| F3 | Almacenamiento de imágenes | *Artifact Registry → repositorio* y `bash web/deploy/infra/limpieza-artifact-v1-6.sh --check`. Repetir cuando haya al menos 5 imágenes y alguna tenga más de 30 días: `gcloud artifacts docker images list "$IMAGE_BASE" --include-tags --project="$PROJECT_ID"` | `--check` dice `PERMITIDO`. Con el tiempo, quedan `produccion`, `produccion-anterior` y las 3 más recientes, y ninguna otra de más de 30 días: es la validación real de la semántica de limpieza |

## G. Rollback y apagado (ensayo)

| # | Verificación | Cómo | Esperado |
| --- | --- | --- | --- |
| G1 | Cerrar el acceso sin borrar nada | Runbook §6, *Cerrar el acceso de inmediato* | La URL deja de responder a usuarios (error de Google, sin llegar a la app). Después se reabre con §5.7 |
| G2 | Volver a una revisión anterior | Runbook §6 (`update-traffic`), si existe más de una revisión | El tráfico pasa a la revisión indicada sin reconstruir |
| G3 | Procedimiento de desmantelamiento revisado | Runbook §7 | El usuario sabe qué borrar para detener todo el gasto |

## H. Cierre

- Todas las filas en ✅ (o N/A justificado) y el resultado registrado **sin datos sensibles**.
- Un ❌ en A, B, D o E bloquea la **puerta 4** (acceso regular): aplicar G1 y corregir antes de reabrir.
- La aceptación **no** autoriza escritura real (`PROJECT_OS_WRITE_MODE`), automatizaciones ni nuevos usuarios: cada
  una es una decisión aparte.
