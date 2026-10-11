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
| `revision` | texto | Si difiere de `project-os-dashboard-00001-gsk`, NO_VERIFICADO: hubo otro despliegue |
| `ejemplo_sintetico` | booleano, opcional | `true` solo en ejemplos; el evaluador lo anuncia |
| `controles[]` | lista | `{ id, fuente, comando?, observado, nota? }` |
| `observado.error` | texto, opcional | Si la lectura falló (p. ej. `PERMISSION_DENIED`): **NO_VERIFICADO** |
| `observado.resultado` | `OK` / `FALLO` | Controles humanos (C, D, E2, F, G1, G3) |

Convención importante: `null` o `""` significa **sin dato** (NO_VERIFICADO). `[]` significa **"ninguno,
comprobado"** y solo lo escribe quien lo comprobó. La plantilla usa `null` para que un campo olvidado nunca produzca
un OK.

## 3. Reglas de evaluación

| Control | OK solo si | FALLO si | NO_VERIFICADO si |
| --- | --- | --- | --- |
| A1 | La imagen es `…/dashboard@sha256:f6e46596…` | Otro digest o una etiqueta | Falta el dato |
| A2 | Las URLs incluyen la URL de NextAuth | No la incluyen | Falta el dato |
| A4 | Ninguna variable de escritura | `PROJECT_OS_WRITE_MODE` o `AUTH_WRITER_EMAILS` | Lista vacía o nula |
| A5 | Cuenta runtime y `roles_proyecto: []` | Otra cuenta o algún rol | Falta la cuenta o los roles son `null` |
| A6 | Una sola fila: `secretAccessor` para la cuenta runtime; como máximo una versión `ENABLED` | Otra fila o varias versiones habilitadas | Faltan los miembros |
| A7 (anotaciones) | Revisión `0` / `1` / `true` y servicio `ninguno` o `1` | Revisión distinta | Servicio con otro valor (**D-1**: ambiguo, nunca OK) o falta el dato |
| A7 (métrica) | Máximo de instancias ≤ 1 | Más de 1 | Falta el dato |
| A8 | Cuenta `project-os-build` | Otra cuenta | Falta el dato |
| A9 | `digest_produccion` = digest desplegado | `NOT_FOUND` u otro digest | Falta el dato |
| E1 | 0 coincidencias | Más de 0 | Falta el conteo |
| F3 (`--check`) | `PERMITIDO` | `BLOQUEADO` u otro resultado | Falta el dato |
| F3 (efecto) | ≥ 5 imágenes y 0 no protegidas de más de 30 días | Alguna no protegida de más de 30 días | Menos de 5 imágenes |
| G2 | ≥ 2 revisiones | — | Una sola revisión (rollback NO_APLICA) |
| Humanos | `resultado: OK` | `resultado: FALLO` | Vacío |
| Otro id | — | — | Siempre: sin regla |

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
- claves de log (`textPayload`, `jsonPayload`, `protoPayload`, `httpRequest`).

Muestra solo la ruta JSON (`$.controles[0].observado.nota`) y el tipo de hallazgo.

**El saneamiento automático es una red, no una garantía.** El propietario revisa el archivo antes de compartirlo.

## 5. Ejemplo

[`evidencia-ejemplo.json`](evidencia-ejemplo.json) es **sintético**: tiene `ejemplo_sintetico: true` y
`fecha: 2000-01-01`, y sus valores son inventados. Muestra un FALLO (A9 sin etiqueta), un NO_VERIFICADO por D-1 y un
control humano sin rellenar. **No es evidencia de producción**, y ni la matriz ni el registro lo citan.
