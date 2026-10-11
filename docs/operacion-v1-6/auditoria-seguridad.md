# PROJECT-OS V1.6 — Auditoría de seguridad y confiabilidad (sin producción real)

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
