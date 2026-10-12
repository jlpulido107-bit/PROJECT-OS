# PROJECT-OS V1.6 — Línea base congelada

> **Qué es:** la referencia única para saber **qué está desplegado** y **qué evidencia lo respalda**. Misión 014.
>
> - **Fecha de corte:** 2026-10-11. Es el último día con evidencia real del propietario.
> - **Qué recoge:** fecha y procedencia de cada evidencia (§4), sin salidas crudas.
> - **Qué no hace:** no verifica recursos nuevos. Esta misión no hizo ninguna lectura ni cambio en Google Cloud, Google
>   Sheets ni OAuth.
> - **Si algo cambia:** un dato posterior a esta fecha, o un cambio de la §7, exige revalidar.
>
> Documentos que dependen de esta línea base:
>
> - [matriz de aceptación](matriz-aceptacion.md): estado por control, que cita las evidencias `EV-xx` de §4;
> - [acta de cierre](acta-cierre-v1-6.md): pendiente de aprobación;
> - [hoja del propietario](hoja-propietario.md): las comprobaciones humanas que faltan.

## 1. Qué está desplegado

| Elemento | Valor | Evidencia |
| --- | --- | --- |
| Repositorio | `jlpulido107-bit/PROJECT-OS` | — |
| Commit de la aplicación desplegada | `7f44216bdf85a9832e014f45c27ac643e00ceff9` | EV-01 |
| Imagen (por digest) | `northamerica-south1-docker.pkg.dev/project-os-511102/project-os/dashboard@sha256:f6e46596ef36522134096d97431f32036bb71298033f9694023137497d3d5c07` | EV-01, EV-06 |
| Digest | `sha256:f6e46596ef36522134096d97431f32036bb71298033f9694023137497d3d5c07` | EV-01 |
| Etiqueta `produccion` | Apunta a ese digest; la creó el propietario el 2026-10-11 (C9). No existe `produccion-anterior`: es el primer despliegue | EV-06 |
| Revisión | `project-os-dashboard-00001-gsk`, la **única**, con el 100 % del tráfico | EV-06, EV-12 |
| Servicio · proyecto · región | `project-os-dashboard` · `project-os-511102` · `northamerica-south1` | EV-01 |
| URL estable (NextAuth y OAuth) | `https://project-os-dashboard-235975889400.northamerica-south1.run.app` | EV-01 |
| Build | Cloud Build `7768d6a3-332a-48bb-9872-db6b000e929a`, `SUCCESS`, cuenta `project-os-build`, con el paso de identidad | EV-01, EV-06 |

## 2. Código desplegado frente a GitHub

- **Producción** sirve el código de `7f44216`.
- **`main`** está en `bcabf8a` (Misión 013, PR #23). Lo único posterior a `7f44216` son documentos, herramientas de
  operación (`web/scripts/ops`, `web/deploy/infra`) y pruebas.
- **El PR #24** (remediación del 2026-10-11 y Misión 014) tampoco cambia el código de la imagen.
- **La imagen** solo incluye `web/package.json`, `web/package-lock.json`, `web/next.config.ts`, `web/tsconfig.json` y
  `web/src/**` (`web/.dockerignore`).
- **La comprobación:** el preflight **P14** (`git diff --quiet 7f44216 HEAD -- web/src …`) lo comprueba en cada
  ejecución y da `FALLO` si el código de la imagen se separa del desplegado. En CI, con un clon superficial, P14 queda en
  NO_VERIFICADO: nunca cuenta como OK.
- **Sin despliegue:** documentar en Git **no redespliega** nada, y ningún commit de esta línea base autoriza un despliegue.

## 3. Configuración de producción conocida

| Aspecto | Valor conocido | Tipo | Evidencia (fecha) |
| --- | --- | --- | --- |
| Escalado | Revisión `maxScale` 1, `minScale` 0, CPU por solicitud. **Servicio** `maxScale` 1 desde el 2026-10-11; antes era 3 (D-1) | Real | EV-11, EV-12 (2026-10-11) |
| Recursos por instancia | 1 vCPU, 512 MiB | Real | EV-01 (registro §2) |
| Identidad del servicio | Cuenta runtime `project-os-dashboard-run@…`, **0** roles de proyecto | Real | EV-06 |
| Secretos | 3 secretos, cada uno con **1** versión `ENABLED` igual a la fijada en la revisión: `nextauth` 1, `google-client-secret` 2, `allowed-emails` 1. Un solo lector directo por secreto | Real | EV-06, EV-12 |
| Versión 1 de `google-client-secret` | gcloud respondió *"Destroyed version [1]"*. Que esté `DESTROYED`, y no `DISABLED` con destrucción programada, se confirma con `estados=[…]` del diagnóstico actual | Real (parcial) | EV-10 |
| Escritura | Sin `PROJECT_OS_WRITE_MODE` ni `AUTH_WRITER_EMAILS` en la revisión: la app no escribe en Sheets | Real | EV-06 |
| Acceso HTTP | `allUsers` con `roles/run.invoker` e `ingress: all`, por decisión explícita del propietario. Expone el login, no los datos | Reportado | EV-05 |
| OAuth | Cliente *Web application* con el origen y el callback de la URL estable, en estado *Testing*. El propietario dijo haberlos confirmado al desplegar; falta el ✅ explícito de la sesión de cierre (A2) | Reportado | EV-05 |
| Logs | Exclusión `project-os-callback-oauth` en el sink **`_Default`** (solo ese sink). La herramienta de entonces solo comprobó el **nombre**; el filtro y `disabled=false` están **sin verificar** | Real (parcial) | EV-09 |
| Retención de logs | 30 días en `_Default`: es el valor por defecto de Google y no se ha leído en el proyecto | Supuesto | — |
| Artifact Registry | Política de limpieza (Keep `produccion*`, Keep 3 recientes, Delete > 30 días), `--check` `PERMITIDO`; 1 imagen | Real | EV-06 |
| Presupuesto | USD 5 con alertas. **Es una alerta, no un límite de gasto** | Reportado | EV-05 |
| Hoja de cálculo | Leída con ADC por la cuenta runtime, alcance `spreadsheets.readonly`, solo `GET` (código). El permiso **Lector** y el historial están sin comprobar (D1, D2) | Código + pendiente | CI |

## 4. Registro de evidencia (fecha y procedencia)

Toda la evidencia real es del **2026-10-11**, aportada por el propietario y saneada: solo conteos, estados y códigos.

Tipos de evidencia:

- **P:** salida o resultado concreto;
- **R:** reporte sin salida adjunta.

| Ref. | Fecha | Medio | Qué se registró | Tipo | Dónde |
| --- | --- | --- | --- | --- | --- |
| EV-01 | 2026-10-11 | Despliegue manual (Cloud Build y `run services replace`) | Build `7768d6a3…` `SUCCESS`; imagen por digest; revisión `Ready=True`; URL estable | P | [Registro §1–§2](../estado-produccion-v1-6-2026-10-11.md) |
| EV-02 | 2026-10-11 | Pruebas en Cloud Shell | `npm test` 563/563, typecheck, build, E2E de auth 63/63 y de integración 63/63, `audit:prod` 0, `audit:critical` 5 altas de desarrollo, `check:client-secrets` con **0** valores reales comparados | P | [Registro §3](../estado-produccion-v1-6-2026-10-11.md) |
| EV-03 | 2026-10-11 | `smoke:remote` tras el despliegue | 26/26 | P | [Registro §3](../estado-produccion-v1-6-2026-10-11.md) |
| EV-04 | 2026-10-11 | Navegador con OAuth real | Login y uso del dashboard sin errores, leyendo Sheets. **No** se compararon las 12 pestañas ni los totales | R | [Registro §3](../estado-produccion-v1-6-2026-10-11.md) |
| EV-05 | 2026-10-11 | Consola, reportado | Presupuesto de USD 5 con alertas; cliente OAuth con origen y callback de la URL estable, estado *Testing*; `allUsers` e `ingress: all` | R | [Registro §2](../estado-produccion-v1-6-2026-10-11.md) |
| EV-06 | 2026-10-11 | Auditoría propia del propietario en Cloud Shell (salida resumida) | A1 OK; A2 `REVISAR` porque el callback requiere la consola; A4 OK; A5 OK con 0 roles; A6: 1 acceso directo por secreto, y `google-client-secret` con 2 versiones `ENABLED`; A7 revisión 1, servicio 3, mínimo 0, CPU por solicitud; A8: cuenta OK, `SUCCESS` y 1 línea de identidad; A9 OK tras **crear** la etiqueta `produccion` (C9, única mutación de esa auditoría); F3: política OK y 1 imagen; G2: 1 revisión; E1: `@` 3, tokens 0, `Bearer` 0, `code=` 1; E2: 15 avisos; B1 26/26 | P | [Remediación §1](remediacion-2026-10-11.md) |
| EV-07 | 2026-10-11 | `remediacion-v1-6.sh diagnostico` (versión `2282a05`) | E1: `@` en auditoría (3) y `code=` en peticiones (1). E2: 22 avisos de la plataforma, `severity>=WARNING` (14 × 401, 7 × 403, 1 × 404). A6: versión 1 sobrante. A7: servicio 3 | P | [Remediación §5](remediacion-2026-10-11.md) |
| EV-08 | 2026-10-11 | `deshabilitar-sobrantes`, login y `smoke:remote` | Versión 1 de `google-client-secret` deshabilitada; login comprobado (reportado); smoke 26/26 | P | [Remediación §5](remediacion-2026-10-11.md) |
| EV-09 | 2026-10-11 | `excluir-callback-en-logs` (versión que solo comprobaba el nombre) | *"exclusión activa"*; filtro y `disabled` **sin comprobar** | P | [Remediación §3 y §5](remediacion-2026-10-11.md) |
| EV-10 | 2026-10-11 | `destruir-deshabilitadas` (modo retirado) | *"Destroyed version [1]"* de `google-client-secret`, tras dos intentos cancelados por la frase | P | [Remediación §5](remediacion-2026-10-11.md) |
| EV-11 | 2026-10-11 | `alinear-max-servicio` | Servicio 3 → 1, revisión 1, misma revisión activa | P | [Remediación §5](remediacion-2026-10-11.md) |
| EV-12 | 2026-10-11 | `smoke:remote` y `diagnostico` finales | Smoke 26/26. A6: 1 `ENABLED` = fijada en los 3 secretos. A7: servicio 1, revisión 1, mínimo 0, `00001-gsk` con el 100 %. E1: `@` 6, todos en auditoría de Google; `code=` 1, la entrada anterior. E2, leído con `severity>=WARNING`: 0 avisos de la app y 29 de la plataforma (21 × 401, 7 × 403, 1 × 404; contexto en [remediación §5.1](remediacion-2026-10-11.md)) | P | [Remediación §5](remediacion-2026-10-11.md) |

Ninguna de estas referencias es el [ejemplo sintético](evidencia-ejemplo.json): este nunca cuenta como producción.

**Evidencia técnica (CI y simulada)** que **no** describe el estado real:

- pruebas unitarias y E2E sintéticas;
- preflight de plantilla y código;
- `gcloud` falso de la remediación;
- evaluador de evidencia.

Se citan en la matriz como `CI` o `S`. La CI de cada SHA está en los comentarios de entrega del PR #24.

## 5. Controles: qué está comprobado y qué no

El estado de cada control y su evidencia están en la [matriz](matriz-aceptacion.md). Resumen tras la Misión 014:

| Estado | Controles | Nota |
| --- | --- | --- |
| VERIFICADO (10) | A1, A3, A4, A5, A6, A7, A8, A9, B1, D3 | D3 es de código (CI), no de producción |
| PARCIAL (9) | A2, C1, C3, C4, C7, E1, E2, F1, F3 | Hay evidencia real, pero incompleta |
| PENDIENTE (9) | C2, C5, C6, D1, D2, F2, G1, G3, H | Sin evidencia real |
| NO_APLICA (1) | G2 | Hasta que exista una segunda revisión con su imagen |

E2 pasa de VERIFICADO a PARCIAL en esta misión. Su evidencia se leyó con `severity>=WARNING`, pero las líneas que la app
escribe con `console.warn` o `console.error` pueden no llevar nivel de log. La documentación de Google para Cloud Run
functions lo indica así; para los servicios de Cloud Run no se ha comprobado. Desde la Misión 014, el diagnóstico lee
también las líneas `[project-os]` de cualquier severidad. Ver la [matriz §3](matriz-aceptacion.md).

## 6. Excepciones y riesgos aceptables (**propuestas**: el propietario debe aceptarlas expresamente)

| # | Riesgo o límite | Por qué es aceptable | Mientras tanto |
| --- | --- | --- | --- |
| X-1 | Login público (`allUsers`, sin IAP) | Decisión explícita del propietario al desplegar. Los datos exigen sesión y estar en la lista; B1 26/26 | Backlog V1.7: IAP o CSP con *nonces* |
| X-2 | 5 alertas altas en dependencias de **desarrollo** (`braces` ≤ 3.0.3 vía `eslint-config-next`) | No hay versión corregida publicada; `audit:prod` 0; no entra en la imagen | [Mantenimiento §1](mantenimiento-dependencias.md): decisión D-DEP |
| X-3 | E1: la entrada `code=` del 2026-10-11 sigue en los logs | Código OAuth de un solo uso, caducado en minutos; sale de la ventana de 30 días el **2026-11-11** | Exclusión en `_Default`, pendiente de verificar como `CORRECTA` |
| X-4 | F3: el efecto real de la limpieza no es observable con 1 imagen | La política se comprobó (`PERMITIDO`) | Repetir cuando haya ≥ 5 imágenes y alguna de > 30 días |
| X-5 | G1: el cierre de acceso no se ha ensayado | El ensayo cortaría el servicio; exige ventana y autorización | Procedimiento documentado (runbook §6) |
| X-6 | G2: sin rollback de tráfico (1 revisión) | No se crea una revisión solo para cerrar el control | *Fix forward* o reaplicar el manifiesto con el mismo digest (runbook §7) |
| X-7 | C3: el 403 real no se ha probado | Exige retirar un correo: nueva versión del secreto y redespliegue | Código y pruebas del 403 (CI) |
| X-8 | El workflow **manual** del colector V1.1 (`manual-github-evidence.yml`) usa una clave JSON de cuenta de servicio para añadir filas a la hoja, solo con la opción `sync_to_sheets`. Según `docs/sheets-sync-setup.md`, esa cuenta se comparte como **Editor** (no verificado). Desde R3 (PR #24), la CI de los PR ya **no** recibe esa clave ni lee la hoja real: valida con una hoja en memoria | Es anterior al dashboard; solo se ejecuta a mano y con opción explícita; nadie la ha ejecutado en esta misión | Decisión D-CI del propietario (preflight P15): mantener con la opción, retirar la clave o migrar a OIDC con identidad propia. Si vuelve una credencial a la CI automática, P12 da **FALLO** |
| X-9 | La retención de 30 días de `_Default` es un supuesto, no una lectura | Es el valor por defecto de Google | Confirmarla en la consola si E1 depende de ella |

## 7. Condiciones que obligan a reabrir la aceptación

Cualquiera de estas invalida esta línea base para los controles afectados. Las pruebas del repositorio lo detectan
cuando el cambio pasa por Git.

1. **Otro despliegue:** otro commit, digest o revisión.
   - Afecta a A1–A9, B1 y C1–C7.
   - La matriz, el evaluador y el preflight exigen revalidar: si cambia `produccion-v1-6.mjs`, la prueba de identidad
     de la matriz falla. El evaluador no da ningún OK con otra revisión u otro digest.
2. **Código de la imagen distinto de `7f44216`** en el árbol: P14 da `FALLO`.
3. **Cambio de IAM** del servicio o de los secretos, una **nueva versión** de un secreto o un cambio de la lista de
   correos. Afecta a A5, A6, C1–C3.
4. **Escritura, usuarios o automatizaciones:**
   - activar escritura (`PROJECT_OS_WRITE_MODE`, `AUTH_WRITER_EMAILS`);
   - añadir usuarios fuera de la lista revisada;
   - crear un `schedule` o una sincronización automática.

   Cada una es una decisión aparte (`AGENTS.md`).
5. **Cambio del cliente OAuth** (origen, callback, estado *Testing* o *Producción*): afecta a A2 y C1–C2.
6. **Cambio de la política de limpieza** o de la etiqueta `produccion`: afecta a A9 y F3.
7. **Cambio o borrado de la exclusión de logs**, o aparición en los logs de alguno de estos: un aviso `[project-os]`,
   un 403 nuevo, un `code=` posterior al 2026-10-11 o un correo fuera de la auditoría. Afecta a E1 y E2.
8. **`smoke:remote` distinto de 26/26**, o un `FALLO` de `evidencia.mjs`: afecta a B1 y al control que falle.
9. **Alerta de presupuesto o gasto inesperado:** afecta a F1 y F2.
10. **Una segunda revisión:** G2 deja de ser NO_APLICA y exige su ensayo.

## 8. Coherencia entre documentos (auditoría de la Misión 014)

Los documentos de preparación son **registros históricos**: no se reescriben, llevan un aviso al principio y remiten a
esta línea base.

| # | Tema | Estado vigente | Documentos actualizados | Históricos, con aviso |
| --- | --- | --- | --- | --- |
| 1 | Imagen desplegada frente al HEAD | `7f44216`; el HEAD solo cambia documentos, herramientas y pruebas (P14) | `README.md`, `web/README.md`, esta línea base | `despliegue-privado-v1-3.md` («no desplegado»: preparación) |
| 2 | Etiqueta `produccion` | Creada y verificada (EV-06) | Registro §7, matriz A9, `README.md` (ya no figura como pendiente), auditoría §9 | Registro §2 y §5 (aviso), `puerta-c-v1-6.md`, `despliegue-privado-v1-3.md` §1.1 |
| 3 | Máximo de instancias | Revisión 1 y servicio 1 (EV-11) | Registro §7, matriz A7 y D-1, runbook operativo §2–§3, auditoría §9 | Registro §2 y §5 (aviso), auditoría §7 (D-1: hipótesis anterior) |
| 4 | Versiones activas de secretos | 1 `ENABLED` = fijada en cada uno (EV-12) | Registro §7, matriz A6, remediación §5 | Auditoría §3 («no inspeccionados»: anterior a EV-06) |
| 5 | Exclusión del callback OAuth | Creada solo en `_Default`; filtro sin verificar (EV-09) | Remediación §3, matriz E1, registro §7 (nota), runbook §5.1 | — |
| 6 | CI y pruebas HTTP | CI en verde por SHA (comentarios del PR #24); smoke 26/26 (EV-03, EV-08, EV-12) | Acta §4 | Registro §3: los conteos de 563 pruebas son del día del despliegue |
| 7 | Segunda revisión para rollback | No existe (G2 NO_APLICA) | Runbook operativo §7, matriz G2 | `despliegue-privado-v1-3.md` §6 (procedimiento genérico) |
| 8 | Presupuesto de USD 5 | Alerta, no límite | Runbook §3, acta §10 | Coherente en todos |
| 9 | Escritura deshabilitada | Sin variables de escritura (EV-06) | Matriz A4 y C7 | Coherente en todos |
| 10 | V1.6 frente a V1.7 | V1.6 congelada: solo lectura, sin automatizaciones | `roadmap.md` (aviso), [propuesta V1.7](propuesta-arquitectura-v1-7.md), no aprobada | `backlog-v1-7.md` (hipótesis) |

Discrepancias corregidas en esta misión, con su explicación en la [matriz §3](matriz-aceptacion.md):

- **E2:** se contaron 28 avisos cuando eran **29**, y se dio por VERIFICADO con una lectura que no veía las líneas de la
  app.
- **Preflight P12:** decía que ningún workflow usaba credenciales de Google, pero la CI del colector usa una.
- **Exclusión de logs:** el registro decía «activa», pero solo se había comprobado el nombre.
