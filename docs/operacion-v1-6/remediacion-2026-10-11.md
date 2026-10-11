# PROJECT-OS V1.6 — Remediación tras la auditoría en Cloud Shell (2026-10-11)

> **Origen:** auditoría ejecutada por el propietario en Cloud Shell el 2026-10-11. Este documento resume sus resultados
> (solo estados y conteos) y prepara las correcciones. **Nada de esto se ha ejecutado desde el repositorio.** Cada
> mutación la ejecuta el propietario, con autorización expresa, escribiendo la frase de confirmación del script
> `web/deploy/infra/remediacion-v1-6.sh`.

## 1. Resultado de la auditoría (resumen saneado)

| Control | Resultado | Nota |
| --- | --- | --- |
| A1, A4, A5, A8 (cuenta, build `SUCCESS`, paso de identidad) y B1 (26/26) | OK | — |
| A9 / C9 | OK | La etiqueta `produccion` se **creó** en esa sesión y apunta al digest desplegado `sha256:f6e46596…5c07`. Fue una mutación hecha por el propietario. Al ser el primer despliegue no existe `produccion-anterior` |
| A6 `project-os-google-client-secret` | REVISAR | 2 versiones `ENABLED`; la fijada en la revisión es una de ellas |
| A7 (D-1) | REVISAR | Revisión `maxScale` 1; servicio `maxScale` 3 |
| E1 | REVISAR | 3 coincidencias de `@` y 1 de `code=` |
| E2 | REVISAR | 15 avisos (`severity>=WARNING`) |
| A2 | Pendiente | El callback OAuth se comprueba en la consola |
| F3, G2 | No evaluable todavía | 1 imagen y 1 revisión |

## 2. Pasos, en orden

Desde la raíz de un clon actualizado del repositorio en Cloud Shell, siempre en **bash**.

| Paso | Comando | Tipo | Qué compartir |
| --- | --- | --- | --- |
| 1 | `bash web/deploy/infra/remediacion-v1-6.sh diagnostico` | Solo lectura | La salida completa del script: son solo conteos, nombres de log, códigos y números de versión |
| 2 | Según el paso 1, E1 (§3) | Decisión | — |
| 3 | `bash web/deploy/infra/remediacion-v1-6.sh deshabilitar-sobrantes` | Mutación (frase `AUTORIZO DESHABILITAR VERSIONES`) | Qué versión se deshabilitó |
| 4 | Login real en el navegador y `cd web && npm run smoke:remote -- --url https://project-os-dashboard-235975889400.northamerica-south1.run.app` | Comprobación | ✅/❌ y 26/26 |
| 5 | Solo si el paso 4 está bien: `bash web/deploy/infra/remediacion-v1-6.sh destruir-version <secreto> <versión>`, con el par exacto que imprime el paso 3 | Mutación **irreversible** (frase `AUTORIZO DESTRUIR VERSION TRAS VERIFICAR EL LOGIN`) | Qué versión se destruyó |
| 6 | *Metrics Explorer* → instancias de `project-os-dashboard`, máximo de 30 días | Lectura en la consola | El número máximo |
| 7 | `bash web/deploy/infra/remediacion-v1-6.sh alinear-max-servicio` | Mutación (frase `AUTORIZO MAX SERVICIO 1`) | La salida (máximo 1 y la misma revisión activa) |
| 8 | Repetir el paso 4 (smoke y login) | Comprobación | ✅ y 26/26 |
| 9 | Solo si se decide en §3: `bash web/deploy/infra/remediacion-v1-6.sh excluir-callback-en-logs` | Mutación (frase `AUTORIZO EXCLUIR CALLBACK OAUTH DE LOS LOGS`) | "exclusión activa, con el filtro esperado" |

Si una frase no se escribe exactamente, el script cancela sin cambios. Cada mutación se verifica sola al terminar
(desde la Misión 014, también deshabilitar y destruir: releen el estado de la versión).

> **Ya ejecutado (§5): no repetir.** Esta tabla queda como registro de cómo se hizo. Si en el futuro hiciera falta
> otra vez, empezar siempre por el paso 1 y decidir con su salida.

## 3. E1 — cómo decidir

El diagnóstico clasifica cada coincidencia por **nombre de log**, sin mostrar contenido:

| Origen | Qué significa | Acción |
| --- | --- | --- |
| `cloudaudit.googleapis.com/activity` | Auditoría de Google: guarda el correo de quien desplegó o cambió IAM (`principalEmail`) | **Esperado.** No es una fuga de la app y no se suprime. El plan de inspección E1 ya excluye estos registros |
| `run.googleapis.com/requests` | La plataforma guarda la URL completa de cada petición. Con `code=`, es el callback OAuth: un código de un solo uso que caduca en minutos | Riesgo bajo pero real. Recomendado: paso 9 (excluir las peticiones al callback). Los registros existentes caducan solos a los 30 días |
| `run.googleapis.com/stdout` o `stderr` | **Salida de la propia app** | **Investigar en el código** antes que nada. No copiar las líneas: comunicar solo el conteo y el código `[project-os] …` |

Con el paso 9 aplicado, E1 debe quedar en 0 en los comandos del plan **a partir de los 30 días**, cuando caduquen los
registros anteriores.

**Alcance de la exclusión:** solo el sink `_Default` (y su bucket `_Default`). No afecta a otros sinks ni a
exportaciones, si los hubiera (no se ha verificado cuáles existen), ni borra los registros ya guardados. El script solo
da la exclusión por buena si, con su nombre, el **filtro** coincide con el esperado y **no** está deshabilitada; si
existe con otro filtro o deshabilitada, se detiene con `NO_VERIFICADO` y no la modifica.

**Verificación pendiente de la exclusión ya creada.** El propietario la añadió el 2026-10-11 con la versión del script
de entonces, que solo comprobaba que existiera una exclusión **con ese nombre**. El filtro y `disabled=false` no se
comprobaron. Desde la Misión 014, `diagnostico` (solo lectura) muestra su estado: `CORRECTA` es lo esperado. Si sale
`DISTINTA` porque la API reescribió el filtro con otro formato, se revisa en la consola. No se corrige en automático.

## 4. A6 y A7 — por qué y qué no hacen

- **A6:** solo se deshabilitan las versiones `ENABLED` que la revisión **no** tiene fijadas. El script se detiene si la
  versión fijada no está `ENABLED`. Deshabilitar es reversible (`gcloud secrets versions enable`). Destruir no lo es, y
  por eso va después de comprobar el login. Una versión solo deshabilitada sigue facturándose.
- **Destruir es por par exacto:** `destruir-version <secreto> <versión>` nunca barre todas las `DISABLED`, que pueden
  ser históricas o de recuperación. Rechaza un secreto fuera de la lista, la versión fijada y cualquier versión que no
  esté `DISABLED`, y vuelve a comprobar el estado justo antes de destruir.
- **Revalidación tras la confirmación (R2-1):** `deshabilitar-sobrantes` y `destruir-version` guardan una huella del
  servicio al hacer el plan: revisión activa, tráfico y **todas** las referencias a secretos (variables de cada
  contenedor y volúmenes). Tras escribir la frase, y antes de **cada** mutación, la vuelven a leer. Si cambió, o si la
  versión objetivo pasó a estar referenciada o cambió de estado, se detienen y abortan lo que quede del plan.
- **Salvaguardas añadidas en la Misión 014** (sin ejecutar nada en GCP; probadas con un `gcloud` falso). Todas fallan
  cerrado:
  1. **Revisión única:** antes de mutar secretos, el servicio debe servir el 100 % del tráfico, también el etiquetado,
     desde la última revisión lista. Si no, otras revisiones podrían usar versiones que el script no ve, y se detiene.
  2. **Mutación condicional:** `disable` y `destroy` llevan el `--etag` de la versión recién leída. Si la versión cambia
     entre esa lectura y la llamada, la API rechaza la operación.
  3. **Verificación posterior:** tras deshabilitar o destruir, se relee el estado. Si no es el esperado, termina en
     `NO_VERIFICADO`. Una versión de un secreto con TTL de destrucción queda `DISABLED` con destrucción programada, y así
     lo informa.
  4. **Lector único:** destruir exige que la cuenta del servicio sea el único lector directo del secreto (como A6).
  5. **Lecturas fallidas:** en `diagnostico`, una lectura fallida, vacía o con JSON inválido se muestra solo como
     `LECTURA_FALLIDA`, nunca acompañada de un «0». El código de salida es 3 (diagnóstico incompleto) y no se imprimen
     trazas de Python.

  Supuesto que el script no puede comprobar: ningún otro servicio o job que corra con la **misma** cuenta usa esas
  versiones. Los 3 secretos son exclusivos de `project-os-dashboard`, y A6 comprueba que esa cuenta es su único lector.
- **A7:** `--max=1` cambia el máximo del **servicio** sin desplegar una revisión nueva, según la ayuda de gcloud. El
  script lo comprueba: compara la revisión activa antes y después y avisa si cambió. **No** usa `--max-instances`, que
  sí crea una revisión nueva.

## 5. Ejecución (2026-10-11)

| Paso | Resultado |
| --- | --- |
| 1 `diagnostico` | E1: `@` solo en auditoría de Google (3); `code=` 1 en peticiones. E2: 0 avisos de la app; 22 de la plataforma (14 × 401, 7 × 403, 1 × 404). A6: versión 1 sobrante. A7: servicio 3 |
| 3 `deshabilitar-sobrantes` | Versión 1 de `project-os-google-client-secret` deshabilitada; `smoke:remote` 26/26 |
| 5 `destruir-deshabilitadas` (modo retirado; hoy `destruir-version`) | gcloud respondió *"Destroyed version [1]"*, tras comprobar el login. Dos intentos previos se cancelaron sin cambios por la frase (espacios y errata); desde `cc24d13` se ignoran los espacios al pegar. El diagnóstico de entonces solo listaba las versiones `ENABLED`. Que la 1 esté `DESTROYED`, y no `DISABLED` con destrucción programada por una TTL del secreto, se confirma con `estados=[…]` del diagnóstico actual. A6 no depende de ello |
| 7 `alinear-max-servicio` | Servicio 1, revisión 1, misma revisión activa |
| 9 `excluir-callback-en-logs` | *"exclusión activa"* según el script de entonces, que **solo** comprobaba el nombre (ver §3) |
| Cierre | `smoke:remote` 26/26. `diagnostico`: A6, una sola versión `ENABLED` por secreto, igual a la fijada; servicio `maxScale` 1, revisión 1, `minScale` 0, misma revisión con el 100 % del tráfico. E1: `@` 6, todos en auditoría de Google (2 `activity` + 4 `system_event`); `code=` 1 en peticiones, la entrada anterior. E2: **0 avisos de la app** y **29 de la plataforma**, detallados en §5.1 |

Pendiente: el paso 6, el máximo histórico de instancias en *Metrics Explorer*.

### 5.1 Contexto de los avisos de E2 (diagnóstico final del 2026-10-11)

Todos son del log de **peticiones** de la plataforma (`run.googleapis.com/requests`), con severidad `WARNING`. La app no
emitió ninguno.

| Código | Rutas (veces) | Contexto |
| --- | --- | --- |
| 401 (21) | Las 7 APIs privadas, 3 veces cada una | Las 3 ejecuciones de `smoke:remote` **sin sesión**. Es el comportamiento diseñado (B1), no una falla |
| 403 (7) | `/` (2), `/favicon.ico` (3), `/api/health` (1), `/api/auth/callback/google` (1) | **Inferencia** fundada: vienen de la comprobación IAM de Cloud Run, antes de conceder `allUsers` (runbook §5.7: verificar la URL antes de abrir la invocación). La app nunca responde 403 en rutas públicas como `/api/health`, `/favicon.ico` o `/api/auth/*`, ni en páginas como `/`: allí redirige a `/login`. Se reevalúa si aparecen 403 nuevos |
| 404 (1) | `/favicon.ico` | La app no sirve un favicon: es cosmético (backlog Q6) |

Los 401 de solicitudes sin sesión son compatibles con el diseño y **no** cuentan como fallas. Un 401 con sesión
iniciada, un 403 nuevo o cualquier aviso `[project-os]` sí se investigan (runbook operativo §6).

Revisión R1 (ChatGPT, PR #24), aplicada después de la ejecución y sin repetir nada en GCP:

- **R1-1:** el diagnóstico usa un vocabulario cerrado. Solo imprime nombres de log, categorías de la app y rutas de
  listas fijas (o plantillas como `/proyectos/[id]`); lo demás sale como `[log-omitido]`, `[ruta-omitida]` o
  `categoría no reconocida`.
- **R1-2:** `destruir-deshabilitadas` se sustituyó por `destruir-version <secreto> <versión>`.
- **R1-3:** la exclusión se verifica por nombre, filtro y estado; alcance solo `_Default`.

Revisión R2 (ChatGPT, PR #24): **R2-1**, revalidar el servicio tras la confirmación y antes de cada mutación (§4).
Endurece el script reutilizable; no implica que hubiera concurrencia en la ejecución del 2026-10-11.

Misión 014 (sin ejecutar nada en GCP): salvaguardas 1–5 de §4 y estado de la exclusión en `diagnostico`. Se
corrigieron defectos reproducibles con el `gcloud` falso:

- una lectura fallida en E1 mostraba «0 (sin coincidencias)» junto a `LECTURA_FALLIDA`;
- la comprobación «gcloud no disponible» nunca fallaba, porque `command -v` encontraba la función `gcloud()` del propio
  script;
- con el tráfico repartido entre revisiones, una versión usada por otra revisión no se veía;
- deshabilitar y destruir no verificaban el estado final.

Hallazgo de la herramienta: en Cloud Shell, `--format='value(name.basename(),state)'` dejó vacía la lista de versiones.
El script se detuvo sin cambios. Desde `2282a05` se lee el JSON y se extrae el número en Python, y el plan usa
`value(name,state)`.

## 6. Lo que sigue siendo manual

- **A2:** en la consola OAuth, el callback es exactamente `…run.app/api/auth/callback/google`.
- **C1 y C4–C7:** 12/12 pestañas, totales y recorrido de las páginas.
- **C2:** una cuenta no autorizada es rechazada.
- **D1 y D2:** historial de versiones y *Compartir* de la hoja.
- **E2:** con el diagnóstico final del 2026-10-11 no queda nada que revisar a mano (§5.1). Se repite con el
  diagnóstico si aparecen avisos nuevos.
- **E1:** el estado `CORRECTA` de la exclusión (§3) y el recuento cuando caduque la entrada anterior, a partir del
  **2026-11-11**.
- **F1 y F2:** presupuesto de USD 5 y gasto real.

Ver la [hoja del propietario](hoja-propietario.md).
