# PROJECT-OS V1.6 — Evidencia saneada

> **Para qué:** registrar el resultado de las lecturas que hace el propietario, sin secretos ni PII, y evaluarlo de
> forma reproducible y sin ambigüedad. El formato es JSON con `version: 1`. El evaluador es
> `web/scripts/ops/evidencia.mjs` y es **offline**.

## 1. Flujo

1. **Claude, offline.** `node web/scripts/ops/plan-inspeccion.mjs` imprime los comandos de solo lectura.
   `--plantilla-evidencia` genera el esqueleto JSON.
2. **Propietario.** Ejecuta cada comando con su cuenta y copia **solo** el dato pedido en `observado`: un digest,
   nombres de variables, roles, un conteo, `OK` o `FALLO`. Rellena `fecha`.
3. **Cualquiera, offline.** `node web/scripts/ops/evidencia.mjs evidencia.json` valida y evalúa el archivo.
4. **Registro.** Se pega en el PR o en el issue **solo** la tabla de resultados (`OK`/`FALLO`/`NO_VERIFICADO` y el
   motivo). El JSON se guarda fuera del repositorio, salvo que el propietario decida versionarlo.

## 2. Esquema (`version: 1`)

| Campo | Tipo | Regla |
| --- | --- | --- |
| `version` | número | `1` |
| `fecha` | `AAAA-MM-DD` | Día de la lectura |
| `commit_desplegado` | SHA de 40 caracteres | Debe ser `7f44216…`. Si es otro, **FALLO** y no se evalúa nada más |
| `revision` | texto | Debe ser `project-os-dashboard-00001-gsk`. Si difiere o falta, hubo otro despliegue: **ningún control queda en OK** (requiere nueva validación) |
| `ejemplo_sintetico` | booleano, opcional | `true` solo en ejemplos: **ningún control queda en OK ni en FALLO** (nunca cuenta como producción) |
| `controles[]` | lista | `{ id, fuente, comando?, observado, nota? }` |
| `observado.error` | texto, opcional | Si la lectura falló (p. ej. `PERMISSION_DENIED`): **NO_VERIFICADO** |
| `observado.resultado` | `OK` / `FALLO` | Controles humanos (C, D, E2, F, G1, G3) |
| `observado.oauth_elegible` · `observado.capa_rechazo` | booleano · `app` / `google` | Solo C2 (R4-1): si la cuenta de prueba podía completar el login de Google y qué capa la rechazó. **Nunca** el correo |

Convención importante: `null` o `""` significa **sin dato** (NO_VERIFICADO). `[]` significa **"ninguno,
comprobado"** y solo lo escribe quien lo comprobó. La plantilla usa `null` para que un campo olvidado nunca produzca
un OK.

## 3. Reglas de evaluación

**Fusión, peor evidencia y cobertura.** Corrección de la revisión R1 de ChatGPT:

- Las lecturas de un mismo control se **fusionan** antes de evaluarlo (y, en A6 y E1, también las del mismo secreto
  o patrón). Dos lecturas con valores distintos para el mismo campo dan NO_VERIFICADO: nunca gana la última.
- Cada control se agrega con la **peor** evidencia (FALLO > NO_VERIFICADO > OK) y debe cumplir una **cobertura
  mínima**. Un control compuesto **nunca** queda en OK por una sola parte.
- El código de salida se calcula sobre los controles agregados. `--json` devuelve `controles` (agregados),
  `lecturas` (por grupo), `cobertura` y `limite`.

**Falla cerrado (Misión 014).** Además de las reglas por control:

| Situación | Efecto | Motivo |
| --- | --- | --- |
| `ejemplo_sintetico: true` | Todos los controles NO_VERIFICADO (la tabla `Lecturas` muestra lo que diría la regla, rotulado) | Un ejemplo nunca se contabiliza como producción |
| `fecha` anterior a 2026-10-11 | Todos NO_VERIFICADO | No puede describir esta versión |
| `revision` distinta o ausente | Ningún OK; los FALLO se mantienen | Un cambio de revisión exige revalidar la línea base |
| A1 en FALLO (otro digest o una etiqueta) | Ningún otro OK | Un cambio de digest exige revalidar la línea base |
| Faltan controles del plan (`A1, A2, A4–A9, E1, F3, G2`) | Fila `COB` en NO_VERIFICADO: nunca «todo OK» | Una evidencia parcial no aprueba el conjunto. `--parcial` evalúa un subconjunto a propósito |
| F3 solo con `--check` | NO_VERIFICADO (cobertura) | `--check` prueba la configuración; el efecto real exige el conteo de imágenes |

Los motivos impresos nunca repiten texto libre de la evidencia: un `id` fuera del checklist se muestra como `??`, un
patrón de E1 desconocido o un `servicio_maxScale` no numérico no se repiten, y una clave arbitraria aparece como
`<clave>`.

| Control | OK solo si | FALLO si | NO_VERIFICADO si |
| --- | --- | --- | --- |
| A1 | La imagen es `…/dashboard@sha256:f6e46596…` | Otro digest o una etiqueta | Falta el dato |
| A2 | Hay **las tres** partes: la URL estable está entre las publicadas, **`nextauth_url`** es esa URL y **`callback_oauth`** es `URL/api/auth/callback/google` | Alguna parte es distinta | Falta cualquiera de las tres |
| A4 | Ninguna variable de escritura | `PROJECT_OS_WRITE_MODE` o `AUTH_WRITER_EMAILS` | Lista vacía o nula |
| A5 | Cuenta runtime y `roles_proyecto: []` | Otra cuenta o algún rol | Falta la cuenta o los roles son `null` |
| A6 | **Los 3 secretos**, cada uno con: una sola fila (`secretAccessor` para la runtime); **exactamente una** versión `ENABLED`; y `version_fijada` numérica, igual a la `ENABLED`. El ID de versión se acepta como número (`1`) o como ruta completa del **mismo** secreto (`projects/…/secrets/<secreto>/versions/1`) | Otra fila; ninguna o varias `ENABLED`; versión fijada `latest` o distinta de la `ENABLED` | Faltan miembros o versiones (`null` o `[]`), la versión fijada o alguno de los 3 secretos; filas ilegibles; rutas de **otro** secreto |
| A7 | **Configuración** de revisión `0` / `1` / `true` y de servicio `ninguno` o `1`; si hay métrica, ≤ 1 | Revisión distinta, o métrica > 1 | Sin configuración (**la métrica sola nunca aprueba**), servicio con otro valor (**D-1**) o datos faltantes |
| A8 | Cuenta `project-os-build` **y** ≥ 1 línea *"Identidad de compilación verificada"* en el log | Otra cuenta, o 0 líneas | Falta cualquiera de las dos |
| A9 | `digest_produccion` = digest desplegado | `NOT_FOUND` u otro digest | Falta el dato |
| E1 | **Los 4 patrones** (`correo`, `token`, `bearer`, `codigo_oauth`), cada uno con 0 coincidencias, `alcance: todos-los-campos` y `ventana_dias ≥ 30` | Cualquier conteo > 0 | Falta algún patrón, o el alcance es parcial (solo `textPayload`, menos de 30 días o sin declarar) |
| F3 | `--check` `PERMITIDO`; si hay conteos, ≥ 5 imágenes y 0 no protegidas de más de 30 días | `BLOQUEADO`, o alguna no protegida de más de 30 días | Faltan datos, o hay menos de 5 imágenes |
| G2 | ≥ 2 revisiones, la imagen anterior existe **y** `ensayo_rollback: OK` (ensayo **autorizado**) | La imagen anterior ya no existe, o el ensayo falló | Una sola revisión; imagen anterior sin comprobar; sin ensayo |
| C2 | `resultado: OK`, `oauth_elegible: true` **y** `capa_rechazo: app` (una cuenta elegible fuera de la lista, rechazada por la app sin datos) | `resultado: FALLO` (una cuenta no autorizada vio datos) | Cualquier otro caso: sin `oauth_elegible: true`, `capa_rechazo: google` (rechazo de Google antes del callback) o sin capa (un aviso de error sin saber quién rechazó) |
| Humanos (salvo C2) | `resultado: OK` | `resultado: FALLO` | Vacío |
| Otro id | — | — | Siempre: sin regla |

**Transcripción de A6** (revisión R3). La versión fijada se obtiene con una extracción **estructurada** del JSON de la
revisión: un fragmento fijo de Python, validado literalmente por el plan, que imprime solo «VARIABLE secreto N» para
cada variable que viene de Secret Manager, nunca valores. No depende del orden de serialización YAML. La regla de copia
de las tres salidas (IAM, versiones y referencias) a los campos de A6 es `observadoA6()` en `evidencia.mjs`. Una prueba
de extremo a extremo con un `gcloud` falso la ejecuta: salida simulada → campos → evaluador.

**Conteos estrictos** (revisión R2). `coincidencias`, `ventana_dias`, `instancias_max_30d`, `imagenes`,
`mayores_30_dias_no_protegidas` y `lineas_identidad_verificada` deben ser enteros finitos ≥ 0, como número o texto de
solo dígitos. Cualquier otro valor (`LECTURA_FALLIDA`, texto, negativo, decimal, infinito) da **NO_VERIFICADO**,
nunca OK. Los comandos de conteo del plan se ejecutan con `pipefail` e imprimen una sola línea: `conteo=<n>`, o
`conteo=LECTURA_FALLIDA` si la lectura falló. En ese caso se anota `error: "LECTURA_FALLIDA"` y **nunca** un 0.

E1 en OK significa que no aparecen esos 4 patrones en ningún campo durante la retención. **No** demuestra la
ausencia de toda PII: la revisión humana de E2 sigue siendo necesaria.

Códigos de salida: `0` todo OK · `1` algún FALLO · `3` sin fallos pero con NO_VERIFICADO · `4` evidencia rechazada ·
`2` uso incorrecto.

## 4. Saneamiento (rechazo con código 4)

El evaluador rechaza el archivo completo, y nunca imprime el valor, si encuentra:

- correos que no sean de cuentas de servicio ni de `example.com`;
- tokens `ya29.`;
- cabeceras `Bearer`;
- JWT;
- claves privadas;
- claves de API;
- secretos de cliente OAuth;
- IDs de cuenta de facturación;
- `NOMBRE=valor` de variables;
- claves de log (`textPayload`, `jsonPayload`, `protoPayload`, `httpRequest`, `insertId`, `logName`,
  `receiveTimestamp`, `trace`);
- desde la Misión 014:
  - URLs con parámetros (`?…=`) y parámetros sensibles sueltos (`code=`, `state=`, `token=`, `client_secret=`…);
  - códigos de autorización (`4/0…`) y *refresh tokens* (`1//0…`) de Google;
  - IDs de cliente OAuth;
  - tokens de GitHub;
  - cookies de sesión de NextAuth;
  - enlaces a la hoja de cálculo;
  - direcciones IP;
  - claves cuyo nombre indica un secreto (`token`, `password`, `client_secret`, `cookie`…).

Muestra solo la ruta JSON (`$.controles[0].observado.nota`) y el tipo de hallazgo. Una clave que no sea un
identificador simple (p. ej. un correo usado como clave) aparece como `<clave>`.

**El saneamiento automático es una red, no una garantía.** El propietario revisa el archivo antes de compartirlo.

## 5. Ejemplo

[`evidencia-ejemplo.json`](evidencia-ejemplo.json) es **sintético**: tiene `ejemplo_sintetico: true` y
`fecha: 2000-01-01`, y sus valores son inventados. En `Lecturas` muestra lo que dirían las reglas: un FALLO (A9 sin
etiqueta), un NO_VERIFICADO por D-1 y un control humano sin rellenar. Los **controles** agregados quedan todos en
NO_VERIFICADO y el código de salida es 3. **No es evidencia de producción**, y ni la matriz ni el registro lo citan.
