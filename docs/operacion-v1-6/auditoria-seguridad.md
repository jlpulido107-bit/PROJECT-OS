# PROJECT-OS V1.6 — Auditoría de seguridad y confiabilidad (sin producción real)

> **Actualización (Misión 014):** §1–§8 conservan el análisis de la Misión 013, anterior a la auditoría en Cloud Shell
> del 2026-10-11. Desde entonces:
>
> - A6 está inspeccionado (EV-06);
> - la etiqueta `produccion` está aplicada (EV-06, S-1);
> - el `maxScale` de servicio está en 1 (EV-11, S-2).
>
> La revisión final offline del contrato está en **§9**, y el seguimiento de los hallazgos en **§10**. Estado y
> evidencia: [línea base](linea-base-v1-6.md).
>
> **Método:** revisión estática del código desplegado (`web/` de `7f44216`, idéntico a `main` `509458b`) y de las
> pruebas que ya existen. **No** se accedió a GCP, OAuth, Secret Manager ni a la hoja. Cada afirmación indica su
> evidencia: **[código]** archivo, **[prueba]** prueba automatizada en CI, **[registro]** el registro de producción
> del propietario o **[hipótesis]**.

## 1. Defensa en profundidad del acceso

| Capa | Qué hace | Evidencia |
| --- | --- | --- |
| 1. Proxy de Next.js | Toda ruta salvo `_next/static`, `_next/image` y `favicon.ico` pasa por `decide()`. Sin cookie válida: páginas → 307 a `/login`, APIs → `401`. Correo fuera de la lista: páginas → `/login?error=AccessDenied`, APIs → `403`. Siempre con `no-store` | [código] `src/proxy.ts`, `src/lib/authz.ts` · [prueba] `authz.test.ts`, E2E de auth (63) |
| 2. Layout privado | `(private)/layout.tsx` llama a `requireUser()`, que redirige si falta la sesión o el correo ya no está permitido | [código] · [prueba] `integration-security.test.ts` ("las 13 páginas privadas…") |
| 3. Cada API | Toda API salvo NextAuth y `/api/health` exige sesión en el servidor antes de leer o escribir | [prueba] `integration-security.test.ts` ("toda API…"), `security.test.ts` |
| 4. NextAuth | Proveedor Google con alcances `openid email profile`; `signIn` exige `email_verified === true` y el correo en `AUTH_ALLOWED_EMAILS`; JWT sin imagen, correo en minúsculas; sesión de 8 h | [código] `src/lib/auth.ts`, `src/lib/access.ts` |
| 5. Lista explícita | `parseAllowedEmails`: lista vacía = nadie entra; entradas sin formato de correo se ignoran. La lista se comprueba **en cada petición** (capas 1–3), así que retirar un correo surte efecto en la siguiente petición, tras la nueva versión del secreto y el redespliegue | [código] `access.ts` · [prueba] `authz.test.ts` |
| 6. Sin filtraciones | Sin variables `NEXT_PUBLIC_`; módulos con credenciales marcados `server-only`; sin tokens ni cuerpos en logs; `/api/health` no lee la sesión ni la hoja | [prueba] `security.test.ts` |
| 7. Escritura | El cliente de Sheets solo emite `GET` con alcance `spreadsheets.readonly`; en Cloud Run cualquier modo de escritura o lista de escritores hace fallar la sonda (503), así que la revisión no recibe tráfico | [prueba] `security.test.ts`, `integration-security.test.ts` · [registro] escritura deshabilitada |

**Conclusión:** no se encontró ningún camino que sirva datos sin sesión y correo permitido. Las rutas públicas son
exactamente `/login`, `/api/health`, `/robots.txt`, `/favicon.ico`, `/api/auth/*` y los estáticos de Next
(`isPublicPath`). `smoke:remote` 26/26 lo confirmó en producción **sin sesión** (B1).

## 2. Exposición pública frente a acceso a datos

- Cloud Run tiene `allUsers` con `roles/run.invoker` e `ingress: all` [registro]. Eso permite **alcanzar** el login
  y la sonda; **no** concede lectura de la hoja ni de los secretos.
- La hoja la lee la **cuenta runtime** (ADC), nunca la identidad del visitante. Un visitante sin sesión no
  desencadena lecturas: el proxy corta antes. [código] `proxy.ts`
- Riesgo residual: solicitudes de bots contra `/login` y `/api/auth/*`, que generan costo de solicitudes y ruido en
  los logs. Ver el runbook operativo §2 (señales) y la preparación R1.

## 3. Identidades y mínimo privilegio

| Identidad | Permisos esperados | Estado real |
| --- | --- | --- |
| `project-os-dashboard-run@PROJECT_ID.iam.gserviceaccount.com` (runtime) | Sin roles de proyecto; `secretAccessor` solo en los 3 secretos; **Lector** de una sola hoja | PARCIAL: Puerta B auditó "sin roles de proyecto ni claves" [registro]. Los permisos sobre secretos y la hoja no están inspeccionados (A6, D2) |
| `project-os-build@PROJECT_ID.iam.gserviceaccount.com` (build) | `logging.logWriter` (proyecto), `artifactregistry.writer` (repositorio), `storage.objectViewer` (bucket) | PARCIAL: auditoría de la Puerta B [registro]; uso en el build `7768d6a3…` (A8) |
| Visitante de Internet | `run.invoker` (alcanza HTTP); nada más | Por diseño [registro] |
| Propietario | Propietario del proyecto | Fuera de alcance |

- La app exige `SHEETS_EXPECTED_SERVICE_ACCOUNT` igual a la identidad real; si no coincide, no lee [código]
  `credentials.ts` · [prueba] `credentials.test.ts`.
- **Herencia de proyecto [hipótesis por verificar]:** los Propietarios y, si existe con Editor, la cuenta
  predeterminada de Compute podrían leer secretos por roles de proyecto. Comando de lectura: A6 en
  `plan-inspeccion.mjs`.

## 4. Secretos

- **Versiones fijadas:** la plantilla referencia números de versión, nunca `latest` [prueba]
  `deploy-template.test.ts` y preflight P4. Un cambio exige una versión nueva y redespliegue: queda auditado.
- **Nunca se leen valores:** ninguna herramienta de esta carpeta usa `versions access`; el plan de inspección lo
  prohíbe y una prueba lo comprueba.
- **Rotación:** la versión sustituida se **destruye** tras comprobar la nueva; una deshabilitada sigue facturándose.
  Ver el runbook histórico §6.

## 5. Alcance real de `check:client-secrets`

| Ejecución | Valores comparados | Qué prueba |
| --- | --- | --- |
| Propietario en Cloud Shell (2026-10-11) | **0** [registro] | Solo los patrones genéricos: clave PEM, JSON de cuenta de servicio, correo de cuenta de servicio, token `ya29.`, nombres de variables secretas y correos que no son de `example.com`. **No** compara valores reales |
| CI (`web-validation.yml`) | **4 valores falsos** del job: 3 variables + 1 correo | Que los valores de configuración **de ese build** no terminan en `.next/static`. Desde esta misión, `--min-values=4` hace fallar el paso si faltan |
| Autoprueba (`operacion-v1-6.test.ts`) | Canarios inventados | **Control positivo:** el script detecta una fuga de cada valor y de los patrones, sin imprimir el valor, y sale con 1. Sin valores y con `--min-values` sale con 3 (NO_VERIFICADO), nunca con un OK falso |

**Límite que no se puede cerrar sin secretos reales:** ninguna ejecución compara los valores **de producción**. Esto
no es un hueco práctico: los valores de producción viven en Secret Manager y se inyectan en tiempo de ejecución, no
en el build. La CI construye con valores falsos y comprueba que el mecanismo no los incrusta, que es el riesgo
real. No se recomienda ejecutar el script con secretos reales en la terminal.

## 6. Retención de imágenes y etiqueta `produccion` (A9)

**Hecho:** la política activa tiene tres reglas, Keep `produccion*`, Keep 3 recientes y Delete > 30 días
(`--check` `PERMITIDO`) [registro]. **No confirmado:** que `dashboard:produccion` apunte al digest desplegado.

**Riesgo hoy:** bajo. El digest en uso es la única imagen, así que está entre las 3 recientes. El riesgo aparece tras
3 builds posteriores sin desplegar y con la imagen en uso de más de 30 días. Entonces la regla Delete la borraría, y
un arranque en frío de Cloud Run podría fallar al no encontrar la imagen [hipótesis no verificada]. Cuando exista
una segunda revisión, también fallaría el rollback (G2).

**Verificación de solo lectura:** comando A9 de `plan-inspeccion.mjs`, evaluado con `evidencia.mjs`. El resultado
es `OK` solo si el digest de la etiqueta coincide con el desplegado.

**Propuesta de mutación (aparte, NO ejecutada, requiere autorización específica):** etiquetar el digest desplegado
como `produccion`. Es la operación C9 del runbook §5.7, aplicada al digest `sha256:f6e46596…5c07`. Al ser el primer
despliegue, no hay `produccion-anterior` que mover. Ninguna herramienta de este PR lo ejecuta.

## 7. Límites de escalado: `maxScale` de servicio frente a revisión (D-1)

- **Observado [registro]:**
  - revisión: `autoscaling.knative.dev/maxScale: '1'`;
  - servicio: `run.googleapis.com/maxScale: '3'`.

  La plantilla solo define el de revisión.
- **Documentado por Google [M]:**
  - cualquier máximo configurado, de servicio o de revisión, impide escalar por encima de ese valor;
  - los límites de revisión se aplican por revisión y pueden **superarse temporalmente** tras un despliegue;
  - Google recomienda el máximo de servicio.

  Fuente: [máximo de instancias](https://cloud.google.com/run/docs/configuring/max-instances).
- **Hipótesis (no verificada):** con una sola revisión al 100 %, el tope efectivo es 1; durante un despliegue
  futuro podría haber más de una instancia, hasta el máximo de servicio (3).
- **Qué depende de ello:**
  - el techo teórico de cómputo, ≈ USD 65 al mes por instancia;
  - la caché de 60 s y el `RateLimiter`, que son **por instancia** (`rate-limit.ts` asume "maxScale 1 = límite
    global");
  - el supuesto de escritor único del contrato V1.4. Hoy no aplica porque la escritura está deshabilitada, pero
    **bloquearía** cualquier activación futura de escritura.
- **Verificación de solo lectura:** comando A7, que lee las dos anotaciones, y la métrica de instancias en *Metrics
  Explorer* (`plan-inspeccion.mjs`).
- **Propuesta (aparte, no ejecutada):** alinear el máximo de servicio a 1. Es una decisión del propietario: cambia
  un recurso de producción y requiere autorización específica.

## 8. Hallazgos

| # | Hallazgo | Severidad | Bloquea | Propuesta |
| --- | --- | --- | --- | --- |
| S-1 | A9: el digest en uso no tiene la etiqueta `produccion` confirmada | Media (a futuro) | El próximo build o despliegue | Lectura A9; C9 con autorización (§6) |
| S-2 | D-1: límite de escalado ambiguo | Baja hoy, sin escritura · **Alta** si se activa la escritura | Activación de escritura (V1.7) | Lectura A7; decisión del propietario |
| S-3 | `check:client-secrets` sin control positivo y con 0 valores en la ejecución manual | Baja | — | **Corregido en este PR:** autoprueba con canarios y `--min-values=4` en CI |
| S-4 | Login público alcanzable (R1) y sin CSP (R7) | Baja (aceptado) | — | Backlog V1.7 (IAP o CSP con *nonces*) |
| S-5 | C2 sin prueba real con una cuenta no autorizada | Media (falta evidencia; el código y la E2E lo cubren) | Puerta 4 | Hoja del propietario, paso 3 |

**Ninguna falla crítica.** No se hizo ningún refactor de seguridad en este PR.

## 9. Revisión final offline del contrato V1.6 (Misión 014)

**Método:**

- relectura del código **actual** de `web/src`, idéntico al desplegado según P14;
- relectura de la plantilla, los scripts y los workflows;
- sin acceso a GCP, OAuth ni Sheets.

No se cambió `web/src`: no apareció ningún defecto bloqueante. Las correcciones de esta misión son de herramientas,
pruebas y documentos.

| # | Punto del contrato | Evidencia en el código y las pruebas | Estado | Riesgo residual |
| --- | --- | --- | --- | --- |
| 1 | OAuth y lista de correos | `auth.ts`: `signIn` exige `email_verified === true` y el correo en `AUTH_ALLOWED_EMAILS`; alcances `openid email profile`; sesión JWT de 8 h (`access.ts`). Lista vacía = nadie entra | Correcto (CI) | C2: falta la prueba real con una cuenta fuera de la lista |
| 2 | Protección de páginas y APIs | `proxy.ts`: el matcher cubre todo salvo `_next/static`, `_next/image` y `favicon.ico`; `decide()` en cada petición; `(private)/layout.tsx` llama a `requireUser()`; cada API repite la comprobación | Correcto (CI y B1 real) | — |
| 3 | Respuestas 401 y 403 | `authz.ts`: API sin sesión → 401 JSON sin datos; correo no permitido → 403; páginas → `/login` (`AccessDenied`); siempre `no-store` | 401 real (B1), 403 por CI | C3: 403 real opcional (X-7) |
| 4 | Escritura bloqueada en Cloud Run | `deployment.ts`: con `K_SERVICE`, cualquier `PROJECT_OS_WRITE_MODE` distinto de `disabled` o un `AUTH_WRITER_EMAILS` → `write-mode` → `/api/health` 503: la revisión no recibe tráfico | Correcto (CI) y sin variables de escritura (A4 real) | — |
| 5 | Alcance `spreadsheets.readonly` | `sheets-client.ts`: `SHEETS_READONLY_SCOPE` y solo `GET`; `credentials.ts` pide ese alcance en ambos modos | Correcto (CI, D3) | D1 y D2 (navegador) |
| 6 | Sin claves ni secretos en el cliente | Ninguna `NEXT_PUBLIC_` (solo un comentario); `server-only` en los módulos con credenciales; `check:client-secrets --min-values=4` en CI con valores falsos | Correcto (CI) | Nunca se comparan valores reales: se inyectan en tiempo de ejecución (§5) |
| 7 | Variables y credenciales de compilación | `Dockerfile`: la configuración llega en tiempo de ejecución; el único secreto del build es la CA opcional (`--mount=type=secret`), que no queda en ninguna capa. El build usa la cuenta `project-os-build` (A8 real) | Correcto | — |
| 8 | Imagen por digest | `render.mjs` exige `@sha256:`; A1 real | Correcto | — |
| 9 | Retención y limpieza | Política Keep `produccion*` y Keep 3, Delete > 30 días (P6); etiqueta `produccion` aplicada (A9 real) | Correcto | F3: efecto real no observable aún (X-4) |
| 10 | `/login` público frente a páginas privadas | `isPublicPath`: `/login`, `/api/health`, `/robots.txt`, `/favicon.ico`, `/api/auth/*` y estáticos. `/api/health` no lee la sesión ni la hoja | Correcto (B1 real) | X-1: login alcanzable (bots, costo de solicitudes) |
| 11 | Script reutilizable de remediación | Salvaguardas 1–5 ([remediación §4](remediacion-2026-10-11.md)); 89 pruebas con `gcloud` falso y control negativo | Correcto (S) | Supuesto: ningún otro consumidor con la misma cuenta |
| 12 | Respuesta ante errores de Sheets | `data.ts`: los errores se clasifican por código (`permission`, `quota`, `auth`, `not-found`, `timeout`, `unavailable`, `config`); la página muestra el error sin datos; las APIs dan 503 con `code`; el log solo lleva categorías | Correcto (CI) | — |
| 13 | Escalado y costos | Revisión y servicio con `maxScale` 1 (A7 real), `minScale` 0, CPU por solicitud; presupuesto de USD 5 **solo alerta** | Correcto | F1 y F2 (consola); las solicitudes no tienen techo |
| 14 | Logs de la app frente a logs de la plataforma | La app escribe 5 categorías fijas con `console.warn` y `console.error`; la plataforma registra las peticiones con su URL completa, de ahí el `code=` del callback y la exclusión en `_Default` | Corregido en las herramientas (D-12, D-13) | E2: falta leer las líneas `[project-os]` de cualquier severidad |
| 15 | Deriva entre documentación y código | Se encontraron y corrigieron: P12 (falso OK; nuevo P15), recuento de E2 (28 → 29), E2 por severidad, exclusión verificada solo por nombre, defectos del diagnóstico. Sin deriva en `web/src` | Corregido | Ver matriz §3 (D-9 a D-13) |

## 10. Seguimiento de los hallazgos (Misión 014)

| # | Hallazgo | Estado |
| --- | --- | --- |
| S-1 | Etiqueta `produccion` sin confirmar | **Resuelto** (EV-06, C9) |
| S-2 | Límite de escalado ambiguo (D-1) | **Resuelto** (EV-11) |
| S-3 | `check:client-secrets` sin control positivo | Resuelto en la Misión 013 |
| S-4 | Login público y sin CSP | Aceptado en la preparación; excepción X-1 propuesta al propietario |
| S-5 | C2 sin prueba real | Pendiente: [hoja](hoja-propietario.md), bloque 1 |
| S-6 | La CI del colector V1.1 usa una clave JSON de cuenta de servicio de Google (`pr-validation.yml`: lectura de la hoja en dry-run en **cada PR** del repositorio; `manual-github-evidence.yml`: escritura opcional). Según las instrucciones de `docs/sheets-sync-setup.md`, esa cuenta se comparte como Editor de la hoja (no verificado) | Nuevo. Riesgo X-8: decisión del propietario. El preflight lo declara en P15, nunca como OK. No es del dashboard |
| S-7 | E2 se dio por verificado con una lectura que no veía las líneas de la app | Corregido en las herramientas; E2 → PARCIAL (D-12) |
| S-8 | Una lectura fallida del diagnóstico mostraba un «0» | Corregido (D-13) |
| S-9 | Exclusión del callback verificada solo por su nombre | Pendiente de leer como `CORRECTA` (hoja, bloque 5) |
