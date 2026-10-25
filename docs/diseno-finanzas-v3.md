# Diseño v3 de /finanzas — registro quincenal de Claude por el agente de finanzas

Orden ORD-POS-091 (tarea POS-030), riesgo BAJO. Fecha: 2026-10-25. Solo diseño: no hay código en `web/`, no se cambia
FINANZAS, no se activa ninguna escritura, no se toca IAM ni se despliega. La construcción va en otra orden (§9). Parte de
la [v1](diseno-finanzas.md) (esquema y vista) y de la [v2](diseno-finanzas-v2.md) (alta del propietario, RECURRENTES,
AUDITORIA de FINANZAS, opción C), construidas en ORD-POS-074 a 077 y 079, y de la skill
[`reporte-consumo`](../.claude/skills/reporte-consumo/SKILL.md) (ORD-POS-088; ORD-POS-089 la amplía con «costo real» y
«consumo equivalente», en revisión).

**Depende de DEC-POS-018** (PENDIENTE; texto propuesto por el PM el 2026-10-25): cortes el día 15 y a fin de mes; una
ruta exclusiva y auditada, sin editar ni borrar; (1) cargos adicionales a la suscripción según el total de factura que da
el propietario, y sin ese dato no se registra pago; (2) rendimiento = costo equivalente en tokens de `reporte-consumo`,
en un lugar que no suma al gasto; la suscripción solo como recurrente `CLAUDE` confirmado por el propietario; tope de
3,000 USD por fila. **Enmienda la opción C de v2 §6**: hoy solo escribe en FINANZAS el propietario; con DEC-POS-018
escribiría también el agente de finanzas, por su propia ruta y solo lo de §4. El PM sigue sin escribir ni leer FINANZAS.

Fuentes: v1 §2 (esquema), v2 §2 a §8 (guard, idempotencia, auditoría, opción C, inercia y activación), API de
operaciones (✅ `web/src/lib/authz.ts` y `web/src/lib/operations/guard.ts`: token del PM por SHA-256 en
`PM_AGENT_TOKEN_SHA256`), escritura de finanzas (✅ `web/src/lib/finanzas/escritura-*.ts`), vista (✅
`web/src/lib/finanzas/finanzas.ts`: `TIPOS`, `FUENTES`, `PREFIJOS`, `capitalUsado`), [runbook V1.8 §6](escritura-v1-8.md)
y DEC-POS-014. Marcas: ✅ verificado en el código · 📄 según un diseño fusionado · ❓ por confirmar al construir o al
activar.

| Criterio de la orden | Sección |
| --- | --- |
| 1. Quién escribe, cómo se autentica, qué no puede; dos opciones comparadas y una elegida | §2 |
| 2. IDs estables por corte, dónde vive el rendimiento, migración | §3, §4 y §7 |
| 3. Contra el doble conteo, con un mes con y sin cargo extra | §5 |
| 4. Fuente de la factura, tope de 3,000 USD, auditoría | §4.3, §4.4 y §6 |
| 5. Inercia, activación con `deploy.sh --desde-activa`, verificación, reversión y orden MEDIO | §8 y §9 |
| 6. Sin secretos, IDs de hojas, correos ni montos reales | §10 |

## 1. Qué es y qué no es

- Cada corte (§3.1), el agente de finanzas registra en FINANZAS **dos cosas distintas**:
  1. **Cargo extra:** lo facturado por Anthropic en el corte **por encima** de la suscripción, calculado con el total de
     factura que da el propietario. Es dinero: va a MOVIMIENTOS y suma al gasto.
  2. **Rendimiento:** el costo equivalente en tokens que reporta `reporte-consumo` (suma de `cost_usd`). **No es
     dinero**: va a una pestaña aparte que ninguna suma de gasto lee (§3.3).
- **La suscripción no la registra el agente.** Entra solo como el recurrente `CLAUDE` que confirma el propietario
  (📄 v2 §4.3, `REC-CLAUDE-AAAA-MM`). El agente solo la **lee** para restarla (§5).
- **Solo altas.** Ni `PATCH` ni `DELETE`; el agente no corrige: un cargo extra mal registrado lo ajusta el propietario
  con «Ajustar» (📄 v2 §3.4, `AJUSTE_DE` = `CLAUDE-EXTRA-…`).
- **Nunca estima.** Sin dato de factura no hay cargo extra: el corte queda «pendiente de factura» (§4.3).
- El agente de finanzas es una sesión de Claude con la skill de §9 (criterio 7), no el PM ni una sesión de
  implementación o revisión. No usa el conector de Google Sheets, como nadie (`AGENTS.md`).

## 2. Quién escribe y cómo se autentica (criterio 1)

### 2.1 Opciones

Todas usan una **ruta propia** del agente en el dashboard, `POST /api/finanzas/agente/…`, fuera de `/api/operaciones/`
(PM) y distinta de `/api/finanzas/movimientos` y `/api/finanzas/recurrentes/confirmar` (propietario). Lo que cambia es
con qué se autentica la sesión y con qué cuenta escribe el servidor.

| Aspecto | A. Ruta propia, cuenta `project-os-finanzas` (la del propietario, v2 §6 C) | B. Ruta propia y cuenta nueva `project-os-finanzas-agente` | C. El agente escribe directo en Sheets (conector o llave de cuenta) |
| --- | --- | --- | --- |
| Autenticación de la sesión | Token propio del agente; el dashboard guarda su SHA-256 (`FINANZAS_AGENTE_TOKEN_SHA256`), distinto del del PM | Igual que A | Credencial de Google dentro de la sesión |
| Identidad que escribe en FINANZAS | La misma del propietario | Una propia, Editor solo de FINANZAS | La de la sesión |
| Historial de versiones de la hoja | Cambios del agente y del propietario con el mismo autor | Autor distinto: control que no depende del código ni de la AUDITORIA | — |
| Revocar al agente | Bandera o token; quitar la cuenta del Compartir también apaga al propietario | Bandera, token **o** quitar su cuenta del Compartir, sin tocar al propietario | Revocar la credencial |
| IAM | Ninguno nuevo | Una cuenta y un `TokenCreator` (como v2 §7.2, pasos 3 y 4) | Llave o permiso de conector |
| Reglas del repositorio | Cumple | Cumple | **Rompe** `AGENTS.md` (nadie escribe con el conector) y v2 §11 (sin llaves) |

**Descartadas:** C, por las reglas; y dar al PM una operación de finanzas, porque v2 §2.1 lo prohíbe (sin rama de
agente) y el PM no es el agente de finanzas.

### 2.2 Elegida: B

La ruta propia (común a A y B) ya separa al agente del PM y del propietario en el código. B añade lo que el código no
puede dar: **otra identidad en Google**. Un error del guard del agente nunca escribe «como el propietario», el
historial de versiones de FINANZAS distingue quién escribió cada celda aunque la AUDITORIA fallara, y el propietario
corta al agente quitándole el Compartir sin perder su propia escritura. El costo (una cuenta y un `TokenCreator`) es el
mismo paso que ya hizo o hará el propietario para v2, y es suyo en la activación (§8.2). Con B, R3 sube en una cuenta
Editor de un solo libro, sin roles de proyecto.

### 2.3 Autenticación

Mismo patrón que el PM (✅ `authz.ts` y `guard.ts`), con token, hash, rutas y guard **propios**:

- **Token:** lo genera el propietario (§8.2) y lo guarda solo en el entorno de las sesiones del agente de finanzas,
  cuyo proxy lo añade a las rutas `/api/finanzas/agente/` del dashboard. La sesión nunca lo lee, lo imprime ni lo pide,
  y nunca pone una cabecera `Authorization` (como 📄 `pm-escribir-api`). El entorno del PM no lo tiene.
- **Hash:** `FINANZAS_AGENTE_TOKEN_SHA256`, montado desde un secreto (`project-os-finanzas-agente-token-sha256`) con
  versión fijada `SECRET_VERSION_FINANZAS_AGENTE`, nunca como literal (como `SECRET_VERSION_PM_AGENT`). Comparación en
  tiempo constante. Debe ser distinto del hash del PM: el render no lee el valor de los secretos, así que lo comprueba
  el propietario al activar (§8.2, paso 6) ❓ y, en ejecución, el guard rechaza la ruta si los dos hashes coinciden.
- **Proxy:** una lista propia (`FINANZAS_AGENT_ROUTES`) con solo las dos rutas de §2.4, `POST`. Con cookie de sesión
  presente, la petición **no** es del agente (como el PM).
- **Guard propio** (`evaluateFinanzasAgenteRequest`), con este orden: 401 sin `Authorization` o con cookie → 401 token
  que no cuadra (incluido el del PM) → 403 `escritura-deshabilitada` sin modo (§8.1) → 415 → 413 → 429 → 400 JSON.
  El guard del propietario (v2 §2.1) sigue sin rama de agente: el token del agente en `/api/finanzas/movimientos` da
  401. El del agente en `/api/operaciones/` da 401: no está en `AGENT_ROUTES` ni cuadra con `PM_AGENT_TOKEN_SHA256`.
- **Frecuencia:** clave `finanzas-agente`, ráfaga de 3 y 1 alta por minuto (dos cortes al mes no necesitan más).
- **Escritura:** el servidor pide el token de Google por suplantación de `project-os-finanzas-agente` (alcance
  `spreadsheets`, 10 min, como ✅ `write-credentials.ts`), solo dentro de una petición que ya pasó el guard.

### 2.4 Qué puede y qué no

| Puede (solo con el modo activo, §8.1) | No puede (403 o 401, sin escribir) |
| --- | --- |
| `POST /api/finanzas/agente/rendimiento`: una fila `REND-CLAUDE-…` en RENDIMIENTO_CLAUDE (§4.2) | Editar o borrar cualquier fila; no hay `PATCH` ni `DELETE` |
| `POST /api/finanzas/agente/cargo-extra`: una fila `CLAUDE-EXTRA-…` en MOVIMIENTOS o el cierre «sin cargo» del corte (§4.3) | Escribir `MAN-`, `REC-`, `SPAPI-` o `CLAUDE-AAAA-MM`; confirmar la suscripción; ajustar |
| Leer, dentro de esas dos rutas, MOVIMIENTOS, PARAMETROS, RECURRENTES, RENDIMIENTO_CLAUDE y AUDITORIA | Escribir RECURRENTES, PARAMETROS o RESUMEN; leer la vista `/finanzas` (el proxy exige sesión) |
| Escribir sus filas de AUDITORIA | Cualquier ruta de `/api/operaciones/`; la hoja de PROJECT-OS; RADAROS |
| | Registrar un monto sin la cita del propietario; superar el tope (§4.4) |

## 3. Cortes, IDs y dónde vive el rendimiento (criterio 2)

### 3.1 Cortes

- **Q1** = días 1 a 15; **Q2** = día 16 al último del mes. Zona `America/Merida`, como la vista.
- Un corte se registra **cerrado**: Q1 desde el día 16, Q2 desde el día 1 del mes siguiente. Un corte abierto o futuro:
  400 `corte-no-cerrado`. Cortes más viejos que el mes anterior: 400 `corte-fuera-de-plazo` (se capturan a mano con
  «Nuevo movimiento», como los recurrentes viejos de v2 §4.2).

### 3.2 IDs estables e idempotentes

| Fila | ID | Regex |
| --- | --- | --- |
| Cargo extra (MOVIMIENTOS) | `CLAUDE-EXTRA-AAAA-MM-Q1` \| `-Q2` | `^CLAUDE-EXTRA-\d{4}-(0[1-9]\|1[0-2])-Q[12]$` |
| Rendimiento (RENDIMIENTO_CLAUDE) | `REND-CLAUDE-AAAA-MM-Q1` \| `-Q2` | `^REND-CLAUDE-\d{4}-(0[1-9]\|1[0-2])-Q[12]$` |

- El ID se deriva **solo del corte**: dos registros del mismo corte chocan siempre. Con otro requestId → 409
  `corte-ya-registrado`, sin escribir; con el mismo requestId y hash → `repetida` o roll-forward; con otro hash → 409
  `conflicto-idempotencia` (📄 v2 §3.3).
- `CLAUDE-EXTRA-` no choca con `CLAUDE-AAAA-MM` (✅ la regex de `anthropic` en `PREFIJOS` es exacta), que sigue
  reservado para una fuente automática (📄 v2 §4.4).
- El «sin cargo» de un corte (§4.3) usa el mismo ID en la AUDITORIA: un corte cerrado «sin cargo» tampoco admite
  después un cargo extra.

### 3.3 Dónde vive el rendimiento: pestaña nueva RENDIMIENTO_CLAUDE

| | Pestaña nueva `RENDIMIENTO_CLAUDE` (elegida) | `TIPO` nuevo (`Rendimiento`) en MOVIMIENTOS, excluido de RESUMEN |
| --- | --- | --- |
| Riesgo de sumar al gasto | Ninguno por construcción: ninguna fórmula ni la vista lee la pestaña | Cada `SUMIFS` de RESUMEN y cada suma de la vista debe excluirlo; una fórmula nueva que lo olvide suma tokens como gasto (p. ej. «costo mensual de herramientas», v1 §2.5, agrupa por `CATEGORIA`) |
| Vista actual | Sin cambio (✅ lee solo sus pestañas fijas) | Hoy marca un `TIPO` desconocido como fila con problema (✅ `canonico(…, TIPOS)`); habría que cambiar `TIPOS`, `capitalUsado` y los bloques |
| Columnas | Las del rendimiento (tokens, sesiones), sin `MONTO_MXN` | Forzaría `MONTO_MXN`, `CATEGORIA` y `COMPROBANTE`, que no aplican |

Se elige la **pestaña nueva**: separa lo que no es dinero del libro de dinero sin depender de que cada fórmula futura
recuerde un filtro. Esquema en §4.2.

## 4. Las dos rutas

Ambas siguen el orden de 📄 v2 §5: validar todo → idempotencia → AUDITORIA → fila → verificación; una sola cola en
proceso y un solo libro por operación.

### 4.1 Cuerpo común

| Campo | Regla |
| --- | --- |
| `requestId` | UUID v4, generado una vez por corte y guardado antes de enviar (como 📄 `scripts/pm-alta.sh`) |
| `corte` | `AAAA-MM-Q1` \| `AAAA-MM-Q2`, cerrado y dentro de plazo (§3.1) |
| `reporte` | ID de la sesión de `reporte-consumo` que dio las cifras (`session_` y 10 a 40 caracteres `[A-Za-z0-9]`) |

### 4.2 `POST /api/finanzas/agente/rendimiento`

Pestaña `RENDIMIENTO_CLAUDE`, una fila por corte, encabezados en la fila 1 buscados por nombre:

| Columna | Formato | Regla |
| --- | --- | --- |
| `REND_ID` | §3.2 | Lo deriva el servidor de `corte` |
| `CORTE_INICIO` / `CORTE_FIN` | `AAAA-MM-DD` | Los calcula el servidor (§3.1) |
| `COSTO_EQUIV_USD` | número ≥ 0, 2 decimales, ≤ 3,000.00 | Suma de `cost_usd` del corte según el reporte. **No es gasto** |
| `SESIONES` / `SESIONES_SIN_DATO` | enteros ≥ 0 | Sin dato no cuenta como 0 en el costo (📄 `reporte-consumo` §1) |
| `TOKENS_ENTRADA` / `TOKENS_SALIDA` | entero ≥ 0 o vacío | Vacío = sin dato; nunca 0 inventado |
| `REPORTE` | `reporte` del cuerpo | — |
| `FECHA_REGISTRO` | `AAAA-MM-DD` | Hoy en Mérida, lo pone el servidor |

El rendimiento (cuánto uso equivalente da cada dólar pagado) se calcula **con fórmula** en una sección nueva de
RESUMEN, «Rendimiento de Claude (no suma)»: `COSTO_EQUIV_USD` del mes ÷ (suscripción + cargos extra del mes, en USD). Esa
sección no entra en ningún total de gasto ni de capital.

### 4.3 `POST /api/finanzas/agente/cargo-extra`: fuente de la factura (criterio 4)

Campos además de los comunes:

| Campo | Regla |
| --- | --- |
| `facturaTotalUsd` | Número ≥ 0, 2 decimales: **total facturado por Anthropic con fecha dentro del corte**, como lo da el propietario |
| `fuente` | `<corte> «<cita literal del propietario>» AAAA-MM-DD`: la cita trae el total y la fecha es la del dato (hoy en Mérida, con 1 día de margen). Hasta 200 caracteres, saneada como `CONCEPTO` (rechaza correo, CLABE, tarjeta, RFC, URL y números de factura) |
| `proyecto` | `POS` \| `ECO`, el que diga el propietario con el dato; sin él, no se registra |
| `tipoCambio` | Opcional; vacío = `TIPO_CAMBIO_DEFECTO` de PARAMETROS |

- **El dato lo da solo el propietario**, en el chat del agente de finanzas, con un total por corte. Una rutina sin
  propietario delante **no llama a esta ruta**: registra el rendimiento y deja el corte «pendiente de factura».
- **Sin dato, «pendiente de factura»:** no hay fila ni auditoría. El agente lo dice en su reporte y lo vuelve a listar
  en cada corte hasta que el propietario dé el total. Nunca usa `cost_usd`, el monto de RECURRENTES ni otro corte como
  estimado: el campo es obligatorio y el servidor no lo rellena.
- El servidor calcula el cargo extra con la regla de §5 y:
  - **extra > 0** → fila en MOVIMIENTOS: `MOV_ID` = `CLAUDE-EXTRA-…`, `FECHA` = `CORTE_FIN`, `PROYECTO`, `TIPO` =
    `Gasto`, `CATEGORIA` = `Herramientas`, `CONCEPTO` = «Claude: cargo adicional `<corte>`», `MONEDA_ORIG` = `USD`,
    `MONTO_ORIG` = extra, `TIPO_CAMBIO`, `MONTO_MXN` = `round(extra × tipo de cambio, 2)`, `FUENTE` =
    `agente-finanzas`, `COMPROBANTE` = `sí` (hay factura);
  - **extra = 0** → ninguna fila en MOVIMIENTOS; la AUDITORIA cierra el corte «sin cargo» (§6);
  - **extra < 0**, o suscripción del corte sin confirmar → 409 `factura-no-cuadra` o `suscripcion-sin-confirmar`, sin
    escribir (§5).

### 4.4 Tope de 3,000 USD por fila

`MONTO_ORIG` del cargo extra y `COSTO_EQUIV_USD` del rendimiento ≤ 3,000.00 USD; más → 400 `monto-excede-tope`, sin
escribir. El tope es una constante del código, no una variable: subirlo exige otra decisión y otra orden. Un corte real
que lo supere lo captura el propietario a mano con «Nuevo movimiento».

## 5. Contra el doble conteo (criterio 3)

**Regla:** la suscripción entra **solo** por `REC-CLAUDE-AAAA-MM`, que confirma el propietario. El agente resta esa
fila del total de factura del corte en que cae, y nunca da de alta la suscripción.

- La suscripción **cae** en el corte que contiene la `FECHA` de `REC-CLAUDE-AAAA-MM` (por defecto, `DIA_COBRO` de
  RECURRENTES, 📄 v2 §4.3).
- `S` = `MONTO_ORIG` en USD de `REC-CLAUDE-AAAA-MM` si cae en el corte; si no cae, `S` = 0. `T` = `facturaTotalUsd`.
- **Cargo extra del corte = `T − S`.**
- Si el `DIA_COBRO` de `CLAUDE` cae en el corte y `REC-CLAUDE-AAAA-MM` todavía no existe → 409
  `suscripcion-sin-confirmar`: el agente no resta un monto esperado; le pide al propietario confirmar el recurrente.
- `T − S < 0` → 409 `factura-no-cuadra` (el total no incluye la suscripción, o la suscripción se confirmó con otro
  monto): nada se escribe y el agente lo reporta.
- `costo equivalente` nunca entra en `T`, en `S` ni en MOVIMIENTOS.

Ejemplos con **cifras sintéticas** (no son montos del propietario): suscripción `S` = 50.00 USD, `DIA_COBRO` = 10, así
que cae en Q1.

**Mes sin cargo extra** (2027-01):

| Corte | Dato del propietario `T` | Cálculo | MOVIMIENTOS | RENDIMIENTO_CLAUDE |
| --- | --- | --- | --- | --- |
| — | (confirma el recurrente) | — | `REC-CLAUDE-2027-01`: 50.00 USD | — |
| Q1 | 50.00 | 50.00 − 50.00 = 0 | ninguna fila; AUDITORIA «sin cargo» | `REND-CLAUDE-2027-01-Q1`: 300.00 |
| Q2 | 0.00 | 0.00 − 0 = 0 | ninguna fila; AUDITORIA «sin cargo» | `REND-CLAUDE-2027-01-Q2`: 280.00 |

Gasto de Claude del mes = **50.00 USD**. El costo equivalente (580.00) no suma.

**Mes con cargo extra** (2027-02):

| Corte | Dato del propietario `T` | Cálculo | MOVIMIENTOS | RENDIMIENTO_CLAUDE |
| --- | --- | --- | --- | --- |
| — | (confirma el recurrente) | — | `REC-CLAUDE-2027-02`: 50.00 USD | — |
| Q1 | 50.00 | 50.00 − 50.00 = 0 | ninguna fila; AUDITORIA «sin cargo» | `REND-CLAUDE-2027-02-Q1`: 310.00 |
| Q2 | 20.00 | 20.00 − 0 = 20.00 | `CLAUDE-EXTRA-2027-02-Q2`: 20.00 USD | `REND-CLAUDE-2027-02-Q2`: 450.00 |

Gasto de Claude del mes = 50.00 + 20.00 = **70.00 USD**; rendimiento en RESUMEN = 760.00 ÷ 70.00. Si el propietario
diera en Q1 un total de 70.00 (suscripción más extra en la misma factura), el extra sería `CLAUDE-EXTRA-2027-02-Q1`:
20.00 y el resultado del mes, el mismo.

**Error que la regla atrapa:** si en Q1 el propietario da 50.00 sin haber confirmado `REC-CLAUDE-2027-02`, el agente
recibe `suscripcion-sin-confirmar`; si escribiera 50.00 como extra, la suscripción contaría dos veces al confirmarse.

## 6. Auditoría (criterio 4)

En la **AUDITORIA de FINANZAS** (📄 v2 §5, mismas columnas), antes de la fila y una fila por campo:

- `ACTOR` = `agente-finanzas`; `ENTIDAD` = `MOVIMIENTOS` o `RENDIMIENTO_CLAUDE`; `REGISTRO_ID` = el ID de §3.2.
- `ORIGEN` = `agente-finanzas;modo=sheets;req=<requestId>;hash=<hash>;reporte=<reporte>;fuente=<fuente>`, con
  `fuente` = la cita fechada de §4.3 en el cargo extra, o `reporte-consumo` en el rendimiento. Así cada fila cita el
  reporte y la fuente del dato.
- El cierre «sin cargo» es una fila de auditoría sin entidad: `ENTIDAD` = `MOVIMIENTOS`, `REGISTRO_ID` =
  `CLAUDE-EXTRA-…`, `CAMPO` = `ESTADO`, `VALOR_DESPUES` = `sin-cargo`, con la cita del total en `ORIGEN`.
- Verificación después de escribir (relee la fila por ID; si no cuadra, 409 `verificacion-fallida` y el reintento hace
  roll-forward).

## 7. Migración del esquema de FINANZAS (criterio 2)

Aditiva, sobre v2 §8 (`AGENTS.md`: sin cambios silenciosos). Las filas existentes siguen válidas.

| Cambio | Antes (v2) | Después (v3) |
| --- | --- | --- |
| `FUENTE` | `manual` \| `sp-api` \| `anthropic` \| `recurrente` | Se añade `agente-finanzas` |
| Prefijos de `MOV_ID` | `MAN-`, `SPAPI-`, `CLAUDE-AAAA-MM`, `REC-<ID>-AAAA-MM` | Se añade `CLAUDE-EXTRA-AAAA-MM-Q1/Q2` (§3.2), solo con `FUENTE` = `agente-finanzas` y `TIPO` = `Gasto` |
| Pestañas | MOVIMIENTOS, PARAMETROS, RESUMEN, RECURRENTES, AUDITORIA | Se añade `RENDIMIENTO_CLAUDE` (§4.2) |
| RESUMEN | v1 §2.5 | Sección nueva «Rendimiento de Claude (no suma)» (§4.2) |
| `AJUSTE_DE` | Un `MOV_ID` existente | Sin cambio: también puede referir un `CLAUDE-EXTRA-…` (lo ajusta el propietario) |

La vista hoy marcaría `CLAUDE-EXTRA-…` como fila con problema (✅ `PREFIJOS` y `FUENTES` no lo conocen): la orden de §9
la actualiza **antes** de que exista la escritura. La validación de datos de `FUENTE` en la hoja la cambia el
propietario al activar (§8.2).

## 8. Inercia y activación (criterio 5, DEC-POS-014)

### 8.1 Inerte por defecto

La ruta del agente escribe **solo** si se cumplen todas:

- bandera nueva `FINANZAS_AGENTE_MODE` = `sheets` exacto (ausente o con otro valor: deshabilitada);
- `finanzasConfig` válido (📄 v1 §3);
- `FINANZAS_AGENTE_SERVICE_ACCOUNT` con formato, del proyecto y **distinta** de la runtime, de `WRITE_SERVICE_ACCOUNT`
  y de `FINANZAS_WRITE_SERVICE_ACCOUNT`;
- `FINANZAS_AGENTE_TOKEN_SHA256` montado (con `SECRET_VERSION_FINANZAS_AGENTE`).

No depende de `FINANZAS_WRITE_MODE` ni de `PROJECT_OS_WRITE_MODE`: se enciende y se apaga sola. Sin ella, las dos rutas
responden 401 o 403 **antes** de pedir un token de Google (cero llamadas a `iamcredentials` y a Sheets). `render.mjs`
acepta la bandera, la cuenta y la versión del secreto **las tres juntas**; cualquier otra combinación hace fallar el
render sin imprimir valores. Sin ninguna, el YAML no cambia. `deploy.sh --desde-activa` las conserva y `--quitar` de
cualquiera retira las tres.

### 8.2 Activación (solo el propietario, tras aprobar DEC-POS-018, fusionar y desplegar F-3)

Ningún agente crea la cuenta o el token, toca IAM, comparte la hoja, pone las variables ni despliega. En Cloud Shell,
con `PROJECT_ID` del proyecto:

1. **Respaldo** de FINANZAS: Historial de versiones → «antes del agente de finanzas».
2. **Esquema** (§7): pestaña `RENDIMIENTO_CLAUDE` con los encabezados de §4.2, `agente-finanzas` en la validación de
   `FUENTE`, la sección nueva de RESUMEN.
3. **Cuenta exclusiva**, sin claves ni roles de proyecto:
   `gcloud iam service-accounts create project-os-finanzas-agente --project "$PROJECT_ID" --display-name "PROJECT-OS agente de finanzas"`.
4. **TokenCreator** de la cuenta de lectura sobre ella, y nada más (mismo comando que v2 §7.2, paso 4, con la cuenta
   nueva).
5. **Compartir FINANZAS** con `project-os-finanzas-agente` como **Editor**, sin notificar; nada más se comparte con ella.
6. **Token:** generar uno aleatorio fuera del repositorio (p. ej. `openssl rand -hex 32`), guardar su SHA-256 como
   versión nueva del secreto `project-os-finanzas-agente-token-sha256` y poner el token en la configuración del entorno
   de las sesiones del agente de finanzas, para las rutas `/api/finanzas/agente/`. Comprobar que el hash no es el del
   PM. El token nunca va a Cloud Run, al repositorio ni al chat.
7. **Variables y despliegue:**

   ```bash
   export FINANZAS_AGENTE_MODE=sheets
   export FINANZAS_AGENTE_SERVICE_ACCOUNT="project-os-finanzas-agente@$PROJECT_ID.iam.gserviceaccount.com"
   export SECRET_VERSION_FINANZAS_AGENTE=<versión>
   web/deploy/cloudrun/deploy.sh --dry-run --desde-activa   # debe listar las tres como nuevas
   web/deploy/cloudrun/deploy.sh --desde-activa
   ```

8. **Prueba real** (antes de cualquier `schedule`, `AGENTS.md`): un corte cerrado con el agente en sesión interactiva.

### 8.3 Verificación

- `REND-CLAUDE-…` aparece en RENDIMIENTO_CLAUDE con sus filas de AUDITORIA (`ACTOR` = `agente-finanzas`, `reporte=`);
  el total de gasto y el capital usado de /finanzas no cambian.
- Con un total de factura: `CLAUDE-EXTRA-…` o el cierre «sin cargo», según §5; repetir el mismo corte da
  `corte-ya-registrado` o `repetida`.
- Sin `REC-CLAUDE` del mes y con la suscripción en el corte: `suscripcion-sin-confirmar`.
- El token del agente en `/api/finanzas/movimientos` y en `/api/operaciones/tareas` → 401; el token del PM en
  `/api/finanzas/agente/rendimiento` → 401; con cookie del propietario → 401.
- Historial de versiones: las celdas del agente con el autor `project-os-finanzas-agente`.
- Compartir de FINANZAS: la cuenta nueva Editor y nada más nuevo; en PROJECT-OS no aparece. Sin roles de proyecto
  (`gcloud projects get-iam-policy … --filter="bindings.members:serviceAccount:project-os-finanzas-agente@"` vacío).
- `grep -c FINANZAS_AGENTE_TOKEN_SHA256` en el YAML renderizado da `1`.

### 8.4 Reversión

`web/deploy/cloudrun/deploy.sh --desde-activa --quitar FINANZAS_AGENTE_MODE` (retira las tres variables; las rutas
vuelven a 401/403), quitar el token del entorno del agente, quitar la cuenta del Compartir de FINANZAS y, si no se
volverá a usar, quitar el `TokenCreator` y deshabilitar la cuenta (como v2 §7.2, paso 8). Las filas ya escritas se
quedan (solo altas); un cargo extra erróneo se anula con «Ajustar». La escritura del propietario y la vista no cambian.

## 9. Propuesta de la orden de construcción (MEDIO)

Para registrar como BORRADOR; no se crea desde esta orden. Solo tras aprobar DEC-POS-018. La activación de §8.2 es la
parte ALTO, del propietario (DEC-POS-014).

### F-3 «/finanzas v3: registro quincenal de Claude por el agente de finanzas, inerte sin `FINANZAS_AGENTE_MODE`»

- **Riesgo:** MEDIO (código de escritura apagado por defecto). Revisión completa a ciegas, delta y segundo revisor
  (DEC-POS-008).
- **Criterios:**
  1. Vista: `FUENTE` `agente-finanzas` y prefijo `CLAUDE-EXTRA-…` válidos solo juntos y con `TIPO` `Gasto` (§7), con
     pruebas de filas válidas y con problema; los totales los suman como cualquier gasto.
  2. Configuración de §8.1 con pruebas de cada condición, incluida la cuenta igual a cualquiera de las otras tres.
  3. Proxy y guard propios (§2.3): pruebas de que el token del PM, la cookie del propietario y la ausencia de token dan
     401 en las rutas del agente, y de que el token del agente da 401 en las del propietario y del PM. `AGENT_ROUTES` y
     `AGENT_OPERATIONS` sin cambios (prueba).
  4. `rendimiento` (§4.2) y `cargo-extra` (§4.3) con IDs de §3.2, idempotencia (repetida, roll-forward, conflicto,
     `corte-ya-registrado`), cortes cerrados y en plazo, tope de §4.4 y la regla de §5, con los dos meses de ejemplo
     como pruebas.
  5. Auditoría de §6 antes de la fila y verificación después, con pruebas de fallo en cada paso.
  6. **Prueba de inercia:** sin cualquiera de las condiciones de §8.1, cero llamadas a los dobles de token y de `fetch`.
  7. Skill nueva del agente de finanzas (o una sección de `reporte-consumo`, la que diga la revisión): toma las cifras del
     reporte del corte, pide el total de factura al propietario, envía con un script fijo que genera y guarda el
     `requestId` (como `scripts/pm-alta.sh`), nunca estima y deja «pendiente de factura»; con prueba en `tests/`.
  8. `render.mjs` y `deploy.sh --desde-activa` aceptan, validan y conservan las tres variables (§8.1); sin ellas el YAML
     no cambia (prueba).
  9. Docs: runbook §8.2 en este diseño, R3 en la [preparación V1.6](despliegue-v1-6-preparacion.md#5-riesgos-de-seguridad-y-costos) y la fila del agente en [operación](operacion.md).
- **Fuera de alcance:** crear la cuenta o el token, IAM, compartir la hoja, poner variables, desplegar, `schedule`,
  editar o borrar movimientos, registrar la suscripción, cualquier acceso del PM a FINANZAS, `.github/workflows`.
- **Cómo probar:** `npm test`, `npm run lint`, `npm run typecheck` y `npm run check:client-secrets` en `web/`;
  `python -m unittest discover -s tests`; la prueba de inercia del criterio 6.

## 10. Datos que nunca van al repositorio (criterio 6)

- Sin montos reales del propietario: las cifras de §5 son sintéticas, y la suscripción vive solo en RECURRENTES.
  El tope de 3,000 USD es una regla de DEC-POS-018, no un monto.
- Sin IDs de libros, correos, tokens ni hashes: `FINANZAS_SHEET_ID` y la cuenta viven en Cloud Run; el hash, en Secret
  Manager; el token, solo en el entorno del agente. Las pruebas usan valores sintéticos.
- Sin números de factura ni datos bancarios: la `fuente` cita el total y la fecha, y el saneado los rechaza (§4.3).
- Las sesiones se citan por ID, nunca por correo o contenido (📄 `reporte-consumo`).
