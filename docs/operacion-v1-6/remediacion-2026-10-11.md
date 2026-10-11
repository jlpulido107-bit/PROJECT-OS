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
| 5 | Solo si el paso 4 está bien: `bash web/deploy/infra/remediacion-v1-6.sh destruir-deshabilitadas` | Mutación **irreversible** (frase `AUTORIZO DESTRUIR VERSIONES TRAS VERIFICAR EL LOGIN`) | Qué versión se destruyó |
| 6 | *Metrics Explorer* → instancias de `project-os-dashboard`, máximo de 30 días | Lectura en la consola | El número máximo |
| 7 | `bash web/deploy/infra/remediacion-v1-6.sh alinear-max-servicio` | Mutación (frase `AUTORIZO MAX SERVICIO 1`) | La salida (máximo 1 y la misma revisión activa) |
| 8 | Repetir el paso 4 (smoke y login) | Comprobación | ✅ y 26/26 |
| 9 | Solo si se decide en §3: `bash web/deploy/infra/remediacion-v1-6.sh excluir-callback-en-logs` | Mutación (frase `AUTORIZO EXCLUIR CALLBACK OAUTH DE LOS LOGS`) | "exclusión activa" |

Si una frase no se escribe exactamente, el script cancela sin cambios. Cada mutación se verifica sola al terminar.

## 3. E1 — cómo decidir

El diagnóstico clasifica cada coincidencia por **nombre de log**, sin mostrar contenido:

| Origen | Qué significa | Acción |
| --- | --- | --- |
| `cloudaudit.googleapis.com/activity` | Auditoría de Google: guarda el correo de quien desplegó o cambió IAM (`principalEmail`) | **Esperado.** No es una fuga de la app y no se suprime. El plan de inspección E1 ya excluye estos registros |
| `run.googleapis.com/requests` | La plataforma guarda la URL completa de cada petición. Con `code=`, es el callback OAuth: un código de un solo uso que caduca en minutos | Riesgo bajo pero real. Recomendado: paso 9 (excluir las peticiones al callback). Los registros existentes caducan solos a los 30 días |
| `run.googleapis.com/stdout` o `stderr` | **Salida de la propia app** | **Investigar en el código** antes que nada. No copiar las líneas: comunicar solo el conteo y el código `[project-os] …` |

Con el paso 9 aplicado, E1 debe quedar en 0 en los comandos del plan **a partir de los 30 días**, cuando caduquen los
registros anteriores.

## 4. A6 y A7 — por qué y qué no hacen

- **A6:** solo se tocan las versiones `ENABLED` que la revisión **no** tiene fijadas. El script se detiene si la
  versión fijada no está `ENABLED`. Deshabilitar es reversible (`gcloud secrets versions enable`). Destruir no lo es, y
  por eso va después de comprobar el login. Una versión solo deshabilitada sigue facturándose.
- **A7:** `--max=1` cambia el máximo del **servicio** sin desplegar una revisión nueva, según la ayuda de gcloud. El
  script lo comprueba: compara la revisión activa antes y después y avisa si cambió. **No** usa `--max-instances`, que
  sí crea una revisión nueva.

## 5. Ejecución (2026-10-11)

| Paso | Resultado |
| --- | --- |
| 1 `diagnostico` | E1: `@` solo en auditoría de Google (3, luego 6 con estas operaciones); `code=` 1 en peticiones. E2: 0 avisos de la app; 401/403/404 de la plataforma. A6: versión 1 sobrante. A7: servicio 3 |
| 3 `deshabilitar-sobrantes` | Versión 1 de `project-os-google-client-secret` deshabilitada; `smoke:remote` 26/26 |
| 5 `destruir-deshabilitadas` | Versión 1 destruida, tras comprobar el login. Dos intentos previos se cancelaron sin cambios por la frase (espacios y errata); desde `cc24d13` se ignoran los espacios al pegar |
| 7 `alinear-max-servicio` | Servicio 1, revisión 1, misma revisión activa |
| 9 `excluir-callback-en-logs` | Exclusión activa |
| Cierre | `smoke:remote` 26/26; `diagnostico`: A6 sin versiones sobrantes, servicio `maxScale` 1 |

Pendiente: el paso 6, el máximo histórico de instancias en *Metrics Explorer*.

Hallazgo de la herramienta: en Cloud Shell, `--format='value(name.basename(),state)'` dejó vacía la lista de versiones.
El script se detuvo sin cambios. Desde `2282a05` se lee el JSON y se extrae el número en Python, y el plan usa
`value(name,state)`.

## 6. Lo que sigue siendo manual

- **A2:** en la consola OAuth, el callback es exactamente `…run.app/api/auth/callback/google`.
- **C1 y C4–C7:** 12/12 pestañas, totales y recorrido de las páginas.
- **C2:** una cuenta no autorizada es rechazada.
- **D1 y D2:** historial de versiones y *Compartir* de la hoja.
- **E2:** revisar por **código** los avisos que muestra el diagnóstico.
- **F1 y F2:** presupuesto de USD 5 y gasto real.

Ver la [hoja del propietario](hoja-propietario.md).
