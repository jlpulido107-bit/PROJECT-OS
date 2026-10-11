# PROJECT-OS V1.6 — Matriz de aceptación con trazabilidad

> **Fecha de corte:** 2026-10-11. **Base:** `main` `509458b`. **Código desplegado:** `7f44216`
> (`web/` idéntico en ambos). Imagen `sha256:f6e46596ef36522134096d97431f32036bb71298033f9694023137497d3d5c07`,
> revisión `project-os-dashboard-00001-gsk`.
>
> **Actualización 2026-10-11 (tarde):** incorpora la auditoría y la remediación ejecutadas por el propietario en Cloud
> Shell ([remediación](remediacion-2026-10-11.md)). Solo se registran estados y conteos, nunca salidas crudas.
>
> Esta matriz **no ejecuta** nada ni cambia el estado de ningún control por sí misma. Se construyó solo con el
> repositorio, la CI y el [registro de producción](../estado-produccion-v1-6-2026-10-11.md). **El despliegue
> funciona; eso no significa que la aceptación esté completa.**

## 1. Criterio de estados

| Estado | Significado | Qué **no** basta |
| --- | --- | --- |
| **VERIFICADO** | Hay un resultado concreto y reproducible: salida de un comando registrada con fecha (p. ej. `smoke:remote` 26/26), una prueba en CI o una revisión de código con prueba automatizada | Una descripción, una plantilla, una prueba con fixtures para un hecho de producción, o "funciona" sin dato concreto |
| **PARCIAL** | Hay evidencia real pero incompleta: un reporte del propietario sin la salida del comando, o solo una parte del control | — |
| **PENDIENTE** | Sin evidencia del estado real | — |
| **NO_APLICA** | El control no puede ejecutarse en el estado actual (p. ej. rollback sin revisión anterior). Se dice por qué y cuándo deja de aplicar | Usarlo para esquivar un control incómodo |

Tipos de evidencia:

- **H** — hecho registrado: salida de comando o resultado de CI, con fecha.
- **R** — reporte del propietario, sin salida adjunta.
- **O** — offline: código, plantilla o prueba local. Prueba el diseño, no el estado real.

Modo de prueba:

- **offline:** Claude, sin red.
- **lectura remota:** comando de solo lectura que ejecuta el propietario, generado por `plan-inspeccion.mjs`.
- **propietario:** acción humana en navegador o consola.
- **mutación aprobada:** requiere una autorización específica.

## 2. Matriz

| ID | Riesgo / objetivo | Evidencia disponible (ruta · SHA · fecha) | Estado | Modo de prueba | Responsable | Evidencia faltante | Siguiente acción |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A1 | La imagen servida es la revisada y está fijada por digest | **H:** auditoría y remediación en Cloud Shell, 2026-10-11 ([remediación](remediacion-2026-10-11.md)): la imagen de la revisión activa es el digest `f6e46596…`. **O:** `render.mjs` exige `@sha256:` | VERIFICADO | lectura remota | — | — | Repetir tras cada despliegue |
| A2 | URL real = `NEXTAUTH_URL` = callback OAuth | **H:** auditoría y remediación en Cloud Shell, 2026-10-11 ([remediación](remediacion-2026-10-11.md)): URL estable OK. **R:** login real correcto. Falta ver el callback en la consola | PARCIAL | propietario | Propietario | ✅ del callback exacto en la consola OAuth | Navegador (hoja, paso 1) |
| A3 | Sonda de arranque válida | **H:** `smoke:remote` 26/26, `/api/health` 200 (registro §3, 2026-10-11). Revisión `Ready=True` (R) | VERIFICADO | lectura remota | — | — | Repetir tras cada despliegue |
| A4 | Sin modo de escritura en producción | **H:** auditoría y remediación en Cloud Shell, 2026-10-11 ([remediación](remediacion-2026-10-11.md)): sin variables de escritura en la revisión. **O:** `deploy-template.test.ts`, sonda 503 | VERIFICADO | lectura remota | — | — | Repetir tras cada despliegue |
| A5 | La identidad del servicio no tiene roles de proyecto | **H:** auditoría y remediación en Cloud Shell, 2026-10-11 ([remediación](remediacion-2026-10-11.md)): el servicio corre con la cuenta runtime y esta tiene 0 roles de proyecto | VERIFICADO | lectura remota | — | — | Repetir tras cambios de IAM |
| A6 | Solo la cuenta runtime lee los 3 secretos, con versión fijada | **H:** auditoría y remediación en Cloud Shell, 2026-10-11 ([remediación](remediacion-2026-10-11.md)): 1 acceso directo por secreto; tras la remediación, exactamente 1 versión `ENABLED` por secreto, igual a la fijada (versión 1 de `project-os-google-client-secret` deshabilitada y destruida) | VERIFICADO | lectura remota | — | — | Destruir la versión sustituida en cada rotación |
| A7 | Límites de costo aplicados | **H:** auditoría y remediación en Cloud Shell, 2026-10-11 ([remediación](remediacion-2026-10-11.md)): tras alinear el servicio (`--max=1`), máximo de servicio **1**, revisión 1, `minScale` 0, CPU por solicitud. Misma revisión activa | VERIFICADO (configuración) | lectura remota | Propietario (métrica) | Máximo histórico de instancias en *Metrics Explorer* (no cambia el estado) | Navegador/consola |
| A8 | El build usó la cuenta dedicada | **H:** auditoría y remediación en Cloud Shell, 2026-10-11 ([remediación](remediacion-2026-10-11.md)): cuenta `project-os-build`, build `SUCCESS`, 1 línea *"Identidad de compilación verificada"* | VERIFICADO | lectura remota | — | — | — |
| A9 | La imagen desplegada está protegida frente a la limpieza | **H:** auditoría y remediación en Cloud Shell, 2026-10-11 ([remediación](remediacion-2026-10-11.md)): etiqueta `produccion` **creada** (C9, mutación del propietario) y apuntando al digest desplegado | VERIFICADO | lectura remota | — | — | Mover `produccion` y `produccion-anterior` en cada despliegue (runbook §5.7) |
| B1 | Todo lo privado está cerrado sin sesión | **H:** `smoke:remote` 26/26 (registro §3). **O:** E2E de auth 63/63 | VERIFICADO | lectura remota | — | — | Repetir tras cada despliegue |
| C1 | El usuario autorizado entra y ve datos reales correctos | **R:** login real y uso sin errores (registro §3). **No** se compararon las 12 pestañas ni los totales | PARCIAL | propietario | Propietario | 12/12 pestañas válidas y totales iguales a la hoja (✅/❌, sin cifras) | Hoja del propietario, paso 2 |
| C2 | Una cuenta no autorizada es rechazada | **O:** `signIn` exige correo verificado y en la lista (`auth.ts`); E2E de auth 63/63 con correos sintéticos. **Sin** prueba real | **PENDIENTE** | propietario | Propietario | Intento real con una cuenta fuera de la lista | Hoja del propietario, paso 3 |
| C3 | 401 sin sesión; 403 para una sesión ya no permitida | **H:** 401 cubierto por B1. **O:** 403 en `authz.ts` y sus pruebas | PARCIAL | propietario (403 opcional) | Propietario | 403 real (opcional: exige nueva versión del secreto y redespliegue) | Posponer el 403 real hasta un cambio autorizado de la lista |
| C4 | Las páginas del dashboard cargan con datos reales | **R:** "uso del dashboard sin errores" (registro §3), sin detalle por página | PARCIAL | propietario | Propietario | ✅/❌ por página | Hoja del propietario, paso 2 |
| C5 | Planificación V1.5 simula sin escribir | **O:** E2E de planificación en CI; `planning-security.test.ts` | PENDIENTE (real) | propietario | Propietario | Recorrido real de `/planificacion` | Hoja del propietario, paso 2 |
| C6 | Centro de control V1.6 con aviso de simulación | **O:** E2E de control en CI; `governance-security.test.ts` | PENDIENTE (real) | propietario | Propietario | Recorrido real de `/control` | Hoja del propietario, paso 2 |
| C7 | Operaciones V1.4 cerradas en producción | **O:** `integration-security.test.ts` (sonda 503 con escritura); navegación sin Operaciones sin escritor. **R:** escritura deshabilitada | PARCIAL | propietario | Propietario | Menú sin Operaciones y formularios con aviso | Hoja del propietario, paso 2 |
| D1 | La cuenta de servicio no editó la hoja | **O:** cliente solo `GET`, alcance `readonly` (`security.test.ts`) | **PENDIENTE** | propietario | Propietario | Historial de versiones de la hoja en la ventana de prueba | Hoja del propietario, paso 4 |
| D2 | Permiso mínimo en la hoja (Lector, acceso restringido) | Ninguna evidencia registrada sobre el diálogo *Compartir* | **PENDIENTE** | propietario | Propietario | ✅/❌ del diálogo *Compartir* | Hoja del propietario, paso 4 |
| D3 | Alcance del token y solo `GET` | **O + CI:** `security.test.ts` ("el cliente de Sheets solo emite GET", "ningún código usa el alcance de escritura") en `main` | VERIFICADO (código) | offline | Claude | — | D1 y D2 son la prueba real |
| E1 | Logs sin correos ni tokens | **H:** auditoría y remediación en Cloud Shell, 2026-10-11 ([remediación](remediacion-2026-10-11.md)): `@` solo en auditoría de Google (esperado; excluida del plan); 0 tokens y 0 `Bearer`; 1 `code=` en el log de peticiones (URL del callback OAuth). **Mitigado:** exclusión `project-os-callback-oauth` en `_Default` | PARCIAL | lectura remota | Propietario | E1 = 0 en el plan cuando caduque la entrada anterior (≤ 30 días) | Repetir E1 tras la caducidad |
| E2 | Solo códigos de la app en los logs | **H:** auditoría y remediación en Cloud Shell, 2026-10-11 ([remediación](remediacion-2026-10-11.md)): en 30 días, **0 avisos de la app** (`[project-os]`); los 28 avisos son respuestas HTTP 401/403/404 de la plataforma (smoke sin sesión y peticiones antes de `allUsers`) | VERIFICADO | lectura remota | — | — | Revisión semanal (runbook §2) |
| F1 | Presupuesto y alertas existen | **R:** USD 5 con alertas (registro §2) | PARCIAL | propietario | Propietario | Captura sin ID de facturación, o ✅ con umbrales | Hoja, paso 6 |
| F2 | El costo real es coherente con la estimación | Ninguna | **PENDIENTE** | propietario | Propietario | Informe de 24–48 h y mensual, por servicio, sin IDs | Hoja, paso 6 |
| F3 | Retención de imágenes efectiva | **H:** auditoría y remediación en Cloud Shell, 2026-10-11 ([remediación](remediacion-2026-10-11.md)): `--check` `PERMITIDO`. Hay 1 imagen: el efecto real solo se observa con ≥ 5 imágenes y alguna de > 30 días | PARCIAL | lectura remota (en el tiempo) | Propietario | Lista de imágenes cuando se cumpla la condición | Runbook operativo §4 |
| G1 | Cerrar el acceso sin borrar nada | **O:** procedimiento en el runbook §6. No ensayado, y **no** debe ensayarse en producción sin decisión | PENDIENTE (procedimiento listo) | mutación aprobada | Propietario | Decisión de ensayo y ventana | Runbook operativo §6; ensayo solo con autorización |
| G2 | Volver a una revisión anterior | **H:** auditoría y remediación en Cloud Shell, 2026-10-11 ([remediación](remediacion-2026-10-11.md)): 1 revisión (`…-00001-gsk`) con el 100 % del tráfico | **NO_APLICA** hasta que exista una 2.ª revisión recuperable | mutación aprobada | Propietario | Revisión anterior **con su imagen** (`produccion-anterior`) | Reevaluar tras el próximo despliegue |
| G3 | El propietario sabe desmantelar | **O:** runbook §7 | PENDIENTE | propietario | Propietario | ✅ de lectura del procedimiento | Hoja, paso 7 |
| H | Cierre de la aceptación | Depende de las filas anteriores | **PENDIENTE** | — | Propietario | Filas A, B, D y E en ✅ (regla del checklist) | Tras los pasos de la hoja del propietario |

**Resumen (2026-10-11, tras la auditoría y la remediación en Cloud Shell):**

| Estado | Controles |
| --- | --- |
| VERIFICADO (11) | A1, A3, A4, A5, A6, A7, A8, A9, B1, D3 (código), E2 |
| PARCIAL (8) | A2, C1, C3, C4, C7, E1, F1, F3 |
| PENDIENTE (9) | C2, C5, C6, D1, D2, F2, G1, G3, H |
| NO_APLICA (1) | G2 |

El conteo exacto lo comprueba una prueba (`operacion-v1-6.test.ts`) contra la tabla de §2: el resumen no puede
quedar desfasado.

## 3. Discrepancias detectadas

| # | Discrepancia | Evidencia | Semántica documentada | Efecto | Acción |
| --- | --- | --- | --- | --- | --- |
| D-1 | **Resuelta (2026-10-11):** el servicio quedó en `maxScale` 1 con `--max=1`, sin revisión nueva. Antes: anotación de **servicio** `run.googleapis.com/maxScale: '3'` frente a la de **revisión** `autoscaling.knative.dev/maxScale: '1'` | Registro §2 (observado); la plantilla solo define la de revisión | Google indica que cualquier máximo, de servicio o de revisión, impide escalar por encima de ese valor; también que los límites de revisión pueden **superarse temporalmente** tras un despliegue [M] ([max instances](https://cloud.google.com/run/docs/configuring/max-instances)). **Hipótesis, no verificada:** tope efectivo = 1. Origen del `3` desconocido | Si el tope efectivo fuera 3: techo teórico de cómputo ≈ 3 × USD 65; caché y límite de peticiones por instancia; el supuesto de **escritor único** del contrato V1.4 dejaría de valer (hoy no aplica: escritura deshabilitada) | Comando A7 (anotaciones) y métrica de instancias (`plan-inspeccion.mjs`). Decisión del propietario: alinear el servicio a 1 en un cambio **autorizado aparte** |
| D-2 | El checklist A7 solo mira anotaciones de revisión | `despliegue-v1-6-aceptacion.md` A7 | — | A7 podía darse por bueno con un límite de servicio distinto | La matriz y el plan de inspección leen ambos niveles |
| D-3 | `web/README.md` dice "No está desplegado" | `web/README.md` línea 8 | — | Confusión de estado | Corregido en la Entrega C (cambio mínimo) |
| D-4 | El runbook §6 asume una revisión anterior para el rollback | Solo existe `…-00001-gsk` | Rollback de tráfico = mover el 100 % a otra revisión existente | G2 no es viable hoy | G2 = NO_APLICA; runbook operativo §6 |
| D-5 | `check:client-secrets`: el propietario comparó **0** valores; la CI compara 4 valores **falsos** | Registro §3; `web-validation.yml` (env del job `web`) | El script compara solo valores presentes en el entorno | Ninguna ejecución compara valores reales, y no había control positivo de detección | Autoprueba con canarios (Entrega A); límite documentado en `auditoria-seguridad.md` §5 |
| D-6 | `package.json` dice versión `1.3.0` y "V1.3" | `web/package.json` | Metadatos sin efecto en ejecución | Cosmético | Backlog V1.7 (no se cambia aquí) |
| D-7 | **Resuelta con D-1.** El estimador de costo E4 supone `maxScale 1` | `despliegue-v1-6-preparacion.md` §4.3 | — | Subestima el techo si D-1 resulta 3 | Depende de D-1 |
| D-8 | **Resuelta (2026-10-11):** etiqueta `produccion` aplicada al digest desplegado. La política de limpieza solo protege la imagen en uso si tiene la etiqueta `produccion` | Política + A9 PENDIENTE | Keep tiene prioridad sobre Delete [M] | Hoy el digest en uso es la única imagen: está entre las 3 recientes y protegido **de hecho**. Deja de estarlo tras 3 builds sin desplegar con más de 30 días | A9; ver §4 |

## 4. Bloqueadores frente a deuda técnica

Ninguno impide que el servicio **funcione hoy**. Se clasifican respecto de la **puerta 4** (acceso regular) y del
**próximo despliegue**.

| Clase | Controles | Motivo |
| --- | --- | --- |
| **Bloquea la puerta 4** (regla del checklist: A, B, D y E en ✅) | A2 (callback en la consola), D1, D2, E1 (caducidad de la entrada anterior) | A1, A4–A9 y E2 ya están verificados; lo que queda es navegador o tiempo |
| **Bloquea la puerta 4 por seguridad** | C2 | La barrera real es la lista de correos; no se probó con una cuenta real fuera de ella |
| **Bloquea el próximo build o despliegue** | Ninguno | A9 resuelto (etiqueta `produccion`) y D-1 resuelto (servicio `maxScale` 1) |
| **Deuda no bloqueante** | C3 (403 real), C5, C6, C7, F2, F3, G1, G3, D-3, D-6 | Comprobaciones funcionales, de costo o de procedimiento que no afectan a la exposición de datos |

## 5. Mutaciones que esta matriz **no** realiza

Cada una requiere una autorización específica del propietario y se ejecuta a mano:

- etiquetar `produccion` (C9);
- alinear `run.googleapis.com/maxScale`;
- ensayar el cierre de acceso (G1);
- redesplegar.

La matriz solo prepara lecturas.
