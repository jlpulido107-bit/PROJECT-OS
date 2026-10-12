# PROJECT-OS V1.6 — Acta de cierre (preparada; **sin aprobar**)

> **Qué es:** el acta que el propietario completa y firma **después** de:
>
> - la revisión independiente de ChatGPT;
> - las comprobaciones de la [hoja del propietario](hoja-propietario.md).
>
> La preparó Claude Code en la Misión 014.
>
> **Qué no es:** ninguna sección contiene una aprobación. Las casillas de decisión y la firma están vacías a propósito.
> Este documento **no aprueba ninguna funcionalidad de la V1.7**: la automatización futura está en una
> [propuesta aparte](propuesta-arquitectura-v1-7.md), no aprobada.

**Estado propuesto hoy: `LISTA PARA ACEPTACIÓN`.** El repositorio y las pruebas están terminados; faltan las
comprobaciones humanas. Queda sujeto a la revisión de ChatGPT del HEAD final y a la CI en verde de ese SHA. No es una
aprobación.

## 1. Identificadores de la línea base

| Elemento | Valor |
| --- | --- |
| Código desplegado | `7f44216bdf85a9832e014f45c27ac643e00ceff9` |
| Imagen (digest) | `sha256:f6e46596ef36522134096d97431f32036bb71298033f9694023137497d3d5c07` |
| Revisión | `project-os-dashboard-00001-gsk` (única, 100 % del tráfico) |
| Servicio · proyecto · región | `project-os-dashboard` · `project-os-511102` · `northamerica-south1` |
| URL estable | `https://project-os-dashboard-235975889400.northamerica-south1.run.app` |
| Build | `7768d6a3-332a-48bb-9872-db6b000e929a` (`SUCCESS`, cuenta `project-os-build`) |
| `main` | `bcabf8a` (Misión 013, PR #23) |
| PR de cierre | #24, rama `claude/adoring-fermat-8wm2yh`, en Draft |
| Detalle y evidencia | [Línea base](linea-base-v1-6.md) (EV-01 a EV-12, 2026-10-11) |

## 2. Alcance funcional de la V1.6

**Incluido, en producción y solo lectura:**

- dashboard privado con Google OAuth y lista explícita de correos;
- Inicio, Proyectos, Tareas, Actividad y Capacidad, con lectura de las 12 pestañas de Google Sheets;
- Planificación V1.5 (**simulación**);
- Centro de control V1.6 (alertas con hechos, inferencias e hipótesis; revisión **simulada**).

**Excluido:**

- escritura real (las operaciones V1.4 están deshabilitadas en Cloud Run);
- usuarios nuevos fuera de la lista revisada;
- automatizaciones y `schedule`;
- sincronizaciones automáticas;
- la V1.7.

El colector V1.0/V1.1 (GitHub → `EVIDENCIAS`) es anterior, manual y por opción.

## 3. Código desplegado frente a `main`

| Árbol | Código de la imagen | Diferencia con lo desplegado |
| --- | --- | --- |
| Producción | `7f44216` | — |
| `main` (`bcabf8a`) | Idéntico a `7f44216` | Solo documentos, herramientas de operación y pruebas |
| PR #24 (HEAD final) | Idéntico a `7f44216` | Solo documentos, herramientas de operación (`web/scripts/ops`, `web/deploy/infra`) y pruebas. **Sin cambios en `web/src`** |

Lo comprueba el preflight **P14** (y K2 del preflight de cierre), que falla si el código de la imagen se separa.
Fusionar el PR #24 **no despliega nada**.

## 4. Pruebas locales y de CI

**Locales**, sobre el árbol final del PR #24, sin credenciales reales y con los mismos valores falsos que la CI:

| Comprobación | Resultado |
| --- | --- |
| `npm ci` | OK: 426 paquetes del lockfile |
| `npm run lint` · `npm run typecheck` | Sin errores · sin errores |
| `npm test` (Vitest) | **960/960** en 28 archivos |
| `npm run build` | Compilado correctamente |
| `npm run audit:prod` · `npm run audit:critical` | 0 vulnerabilidades · 0 críticas (5 altas de desarrollo, X-2) |
| `npm run check:client-secrets -- --min-values=4` (valores falsos de la CI) | 22 archivos, 4 valores comparados, sin fugas |
| E2E: auth · integración · operaciones · planificación · control | 63/63 · 63/63 · 56/56 · 32/32 · 35/35 |
| `bash -n` y ShellCheck (`-S style`) de los scripts modificados | Sin avisos: `remediacion-v1-6.sh`, `gcloud` falso de las pruebas y `limpieza-artifact-v1-6.sh` |
| Preflight de aceptación · preflight de cierre · reglas de la matriz | 14 OK y P15 NO_VERIFICADO (decisión X-8) · K1–K10 OK, K11–K16 NO_VERIFICADO por diseño · 0 violaciones |
| Imagen Docker (`docker:smoke`) | No ejecutada en local: no hay *daemon* de Docker en esta sesión. La cubre el job `docker` de la CI; `web/src` no cambió |

**CI:**

- La CI del SHA final (jobs `web`, `docker` y `validate`), con sus enlaces, está en el **comentario de entrega del
  PR #24**: un commit no puede contener los resultados de su propia CI.
- Referencia anterior: `8b239e9` en verde, en los tres jobs:
  - [validate](https://github.com/jlpulido107-bit/PROJECT-OS/actions/runs/38201579958/job/114655946282);
  - [web](https://github.com/jlpulido107-bit/PROJECT-OS/actions/runs/38201579940/job/114655946593);
  - [docker](https://github.com/jlpulido107-bit/PROJECT-OS/actions/runs/38201579940/job/114655946413).
- Desde R3-1, el job `validate` ya no recibe la clave de Google ni lee la hoja real: valida con una hoja en memoria.
- `30f40b2` falló en [web](https://github.com/jlpulido107-bit/PROJECT-OS/actions/runs/38180290994/job/114591212949):
  una prueba alcanzó el `gcloud` del runner, sin credenciales. Lo corrigió `9118727` con un `PATH` hermético; el
  detalle está en el comentario de entrega.

**HTTP real** (`smoke:remote`, sin sesión): 26/26 en EV-03, EV-08 y EV-12. Lo ejecuta el propietario; nunca la CI.

## 5. Resultado de la matriz A–H

Estado de la [matriz](matriz-aceptacion.md) en el SHA final, sin violaciones de sus reglas (`scripts/ops/matriz.mjs`):

| Estado | n | Controles |
| --- | --- | --- |
| VERIFICADO | 10 | A1, A3, A4, A5, A6, A7, A8, A9, B1, D3 (código) |
| PARCIAL | 9 | A2, C1, C3, C4, C7, E1, E2, F1, F3 |
| PENDIENTE | 9 | C2, C5, C6, D1, D2, F2, G1, G3, H |
| NO_APLICA | 1 | G2 |

Límites que el estado refleja con precisión:

| Control | Tipo de límite | Precisión |
| --- | --- | --- |
| E1 | **Temporal** e **histórico** | La entrada `code=` del 2026-10-11 sale de la ventana el **2026-11-11**. La exclusión solo cubre `_Default` y está sin verificar como `CORRECTA`. No prueba nada sobre otros sinks, buckets o exportaciones |
| F3 | **Temporal** | La limpieza solo es observable con ≥ 5 imágenes y alguna de > 30 días; hoy hay 1. La política está comprobada (`PERMITIDO`); su efecto, no |
| C3 | **Opcional** | El 403 real exige retirar un correo (nueva versión del secreto y redespliegue). El 401 real está cubierto (B1). No se simula como real |
| G1 | **Opcional, con autorización** | El procedimiento está documentado; el ensayo cortaría el servicio. No se ensaya sin ventana ni autorización |
| G2 | **De aplicabilidad** | NO_APLICA hasta que exista una segunda revisión con su imagen. No se crea una revisión solo para cerrarlo |
| C2 | **De capa** (R3-2) | Solo cuenta el rechazo **de la app** a una cuenta elegible para el login de Google y fuera de la lista. Si Google rechaza la cuenta antes del callback (cliente en *Testing*), C2 queda NO_VERIFICADO; sin cuenta elegible, sigue PENDIENTE. No se crean usuarios de prueba sin autorización |

## 6. Evidencia humana incorporada

- **Hasta hoy:** EV-01 a EV-12, todas del **2026-10-11**, aportadas por el propietario y saneadas
  ([línea base §4](linea-base-v1-6.md)).
- **En esta misión:** ninguna. La Misión 014 no tuvo acceso a GCP, OAuth ni Sheets.
- **Lo que falta:** las respuestas de la [hoja](hoja-propietario.md), bloques 1–5. Se incorporarán como EV-13 y
  siguientes, con su fecha.

## 7. Riesgos residuales

| # | Riesgo | Severidad | Tratamiento |
| --- | --- | --- | --- |
| X-1 | Login público (`allUsers`, sin IAP ni CSP) | Baja | Aceptado en la preparación; IAP o CSP en el backlog V1.7 |
| X-2 | 5 altas en dependencias de **desarrollo** (`braces`); `audit:prod` 0 | Baja (sin exposición en producción) | Decisión D-DEP ([mantenimiento §0](mantenimiento-dependencias.md)) |
| X-3 | E1: entrada `code=` histórica | Baja (código de un solo uso, ya caducado) | Fecha 2026-11-11 y exclusión `CORRECTA` |
| X-4 | F3 no observable | Baja hoy | Repetir cuando se cumpla la condición |
| X-5 | G1 sin ensayo | Media en un incidente | Procedimiento documentado; ensayo solo con autorización |
| X-6 | Sin rollback de tráfico (G2) | Media en un incidente | *Fix forward* o reaplicar el manifiesto con el mismo digest |
| X-7 | 403 real sin probar (C3) | Baja | CI; excepción o prueba autorizada |
| X-8 | El workflow manual del colector usa una clave JSON de cuenta de servicio (según su guía, **Editor**; no verificado), solo con la opción `sync_to_sheets`. La CI de los PR ya no la recibe (R3-1) | Media | Decisión D-CI; P15 lo declara siempre. Si una credencial vuelve a la CI automática, P12 da FALLO |
| X-9 | Retención de 30 días de `_Default` supuesta | Baja | Confirmarla en la consola si E1 depende de ella |

## 8. Excepciones pendientes de decisión del propietario

Cada fila se decide aparte. Una excepción aceptada se registra **también** en la
[matriz §5](matriz-aceptacion.md), con la fecha y la referencia. Solo así cuenta para cerrar H.

| # | Excepción propuesta | Recomendación | Decisión (Aceptar / Rechazar) | Fecha | Referencia |
| --- | --- | --- | --- | --- | --- |
| C3 | Cerrar sin el 403 real | Aceptar: el riesgo lo cubren el código y la CI; la prueba exige un cambio de producción | | | |
| G1 | Cerrar sin el ensayo de cierre de acceso | Aceptar mientras no haya ventana; ensayar en el próximo mantenimiento autorizado | | | |
| X-2 | Mantener las 5 altas de desarrollo hasta que exista una corrección | Aceptar (D-DEP) | | | |
| X-8 | Mantener la clave JSON del colector **manual** (la CI de los PR ya no la usa desde R3-1) | Decidir: mantenerla con la opción explícita, retirarla o migrar a OIDC con una identidad propia (D-CI) | | | |
| E1 | Aceptar con la entrada `code=` histórica hasta el 2026-11-11 | Aceptar **solo** si la exclusión sale `CORRECTA` y `code=` no aumenta tras el login | | | |
| F3 | Aceptar sin el efecto real de la limpieza | Aceptar; repetir cuando haya ≥ 5 imágenes | | | |

## 9. Dependencias y seguridad

- **Dependencias:** `audit:prod` 0. `npm audit` da 5 altas de desarrollo y 0 críticas. No existe una actualización
  pequeña y segura ([mantenimiento §0](mantenimiento-dependencias.md)). No se aplicó `npm audit fix --force`.
- **Revisión offline del contrato:** 15 puntos ([auditoría §9](auditoria-seguridad.md)), sin defectos bloqueantes en
  `web/src`.
- **Corregido en esta misión (herramientas, no la app):**
  - el falso OK de P12;
  - E2 por severidad;
  - el recuento de E2;
  - la lectura fallida que mostraba «0»;
  - las compuertas de la remediación: revisión única, `--etag`, lector único y verificación posterior.

## 10. Costos y límite del presupuesto

- **El presupuesto de USD 5 es una alerta, no un límite.** No detiene el gasto y llega con retraso.
- **Techo de cómputo:** `maxScale` 1 en revisión y servicio. Con la instancia ocupada todo el mes, son unos USD 65; con
  1–2 personas, ≈ USD 0–1.
- **Sin techo:** las solicitudes (incluidos los bots contra `/login`) y la salida a Internet.
- **Pendiente:** F1 (umbrales) y F2 (gasto real por servicio), en la hoja, bloque 4.

## 11. Recuperación y continuidad

| Situación | Procedimiento |
| --- | --- |
| Incidente (403, callback, Sheets, 5xx, exposición, costo, pérdida de acceso) | [Runbook operativo §6](runbook-operativo.md) y su mapa (§7.1) |
| Cerrar el servicio temporalmente | Quitar `allUsers`, sin borrar nada y reversible ([runbook histórico §6](../despliegue-privado-v1-3.md)) |
| Recuperar sin revisión anterior (hoy) | *Fix forward*, reaplicar el manifiesto con el mismo digest o cerrar el acceso mientras tanto (runbook operativo §7) |
| Recuperar con dos o más revisiones (futuro) | `update-traffic` a la revisión anterior, si su imagen sigue protegida (`produccion-anterior`) |
| Desmantelar | [Runbook histórico §7](../despliegue-privado-v1-3.md) |
| Continuidad del conocimiento | Esta acta, la línea base, la matriz y el runbook, versionados en `main` tras la fusión autorizada |

## 12. Requisitos para cada estado

| Estado | Se declara cuando… |
| --- | --- |
| `LISTA PARA ACEPTACIÓN` | El repositorio y las pruebas están terminados: CI en verde en el SHA final, revisión de ChatGPT sin bloqueadores, matriz sin violaciones y preflight de cierre sin FALLO. Faltan las comprobaciones humanas |
| `ESTABLE CON EXCEPCIONES ACEPTADAS` | La hoja está completa sin ningún FALLO (bloques 1–5, salvo 5.4, que depende de la fecha). Los controles que no estén en VERIFICADO tienen una excepción **aceptada expresamente** por el propietario, con fecha y referencia, en la §8 y en la matriz §5 |
| `ACEPTADA` | Se cumplieron los criterios acordados: los controles de la matriz están en VERIFICADO, en NO_APLICA justificado (G2) o con una excepción aceptada; E1 comprobado a partir del 2026-11-11; H en VERIFICADO con la **aprobación del propietario** registrada como evidencia; y la firma de la §13 |
| `BLOQUEADA` | Un FALLO de seguridad, datos o configuración impide el acceso regular. Por ejemplo: C2 deja entrar a una cuenta no autorizada; D1 muestra ediciones de la cuenta runtime; A2 tiene otro callback; C7 permite escribir; la exclusión no es `CORRECTA` y `code=` aumenta; aparece un aviso `[project-os]` de categoría no reconocida; o el smoke da menos de 26/26. Se cierra el acceso si hay exposición (runbook §6) y se corrige con autorización |

Ninguna decisión del propietario activa por sí sola:

- la escritura;
- usuarios nuevos;
- automatizaciones o un `schedule`;
- un despliegue.

Cada uno es una autorización aparte (`AGENTS.md`).

## 13. Aprobación

| Campo | Valor |
| --- | --- |
| Revisión independiente (ChatGPT): SHA revisado y resultado | Pendiente |
| Estado declarado por el propietario | Pendiente |
| Fecha | Pendiente |
| Referencia (comentario o issue) | Pendiente |
| Propietario | Pendiente |

Hasta que el propietario complete esta tabla, la V1.6 **no** está aceptada. El issue #22 sigue abierto y el PR #24 en
Draft.
