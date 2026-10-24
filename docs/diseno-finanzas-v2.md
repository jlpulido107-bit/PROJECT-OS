# Diseño v2 de /finanzas — registro de movimientos y cargos recurrentes

Orden ORD-POS-075 (tarea POS-026, paquete PAQ-2026-10-23-05), riesgo MEDIO. Fecha: 2026-10-24. Solo diseño: no hay
código en `web/`, no se cambian permisos, no se despliega y no se toca ninguna hoja real. La construcción va en otras
órdenes (§9). Parte de la v1 de /finanzas ([diseño](diseno-finanzas.md), ORD-POS-070; vista de solo lectura
ORD-POS-074, fusionada y desplegada, inerte sin `FINANZAS_SHEET_ID`).

> **Construcción (ORD-POS-077, F-2) y decisión del propietario del 2026-10-23: opción C de §6.** La escritura usa una
> cuenta de servicio nueva, exclusiva de FINANZAS (`FINANZAS_WRITE_SERVICE_ACCOUNT`), y un único escritor
> (`FINANZAS_WRITER_EMAIL`). Ni `project-os-writer` ni la cuenta de lectura ganan acceso a FINANZAS. §2.2, §6, §7, §10 y
> §11 ya reflejan esa decisión; lo demás se construyó como está escrito. Código: `web/src/lib/finanzas/escritura-*.ts`,
> `web/src/app/api/finanzas/` y `web/src/components/finanzas/forms.tsx`.

Fuentes: [diseño v1](diseno-finanzas.md), [runbook de escritura V1.8](escritura-v1-8.md), API de operaciones
([`web/src/lib/operations/`](../web/src/lib/operations/service.ts): `http.ts`, `guard.ts`, `config.ts`, `service.ts`,
`write-credentials.ts`), proxy ([`web/src/lib/authz.ts`](../web/src/lib/authz.ts)), vista de /finanzas
([`web/src/lib/finanzas/finanzas.ts`](../web/src/lib/finanzas/finanzas.ts)), riesgos R3 y R4 de la
[preparación V1.6](despliegue-v1-6-preparacion.md#5-riesgos-de-seguridad-y-costos), DEC-POS-014 (ORD-POS-061: ALTO se
parte en MEDIO inerte más activación del propietario) y el issue de la orden. Marcas: ✅ verificado en el código ·
📄 según un diseño fusionado · ❓ por confirmar al construir o al activar.

| Criterio de la orden | Sección |
| --- | --- |
| 1. Formulario «Nuevo movimiento», solo la sesión del propietario; rechaza el token del PM | §2 y §3 |
| 2. requestId, validación previa, auditoría; sin borrar ni editar | §3 y §5 |
| 3. Esquema de RECURRENTES; pendientes del mes; confirmar con `REC-<id>-AAAA-MM` | §4 |
| 4. Permisos: una cuenta pasa a Editor solo de FINANZAS; inerte sin `FINANZAS_WRITE_MODE` | §6 y §7 |
| 5. Órdenes de construcción (MEDIO) | §9 |
| 6. Sin montos reales, datos bancarios, RFC ni IDs de libros | §11 |

## 1. Qué es y qué no es

- Dos acciones nuevas en `/finanzas`: **«Nuevo movimiento»** (alta manual en MOVIMIENTOS) y **«Confirmar»** de los
  cargos recurrentes del mes (alta en MOVIMIENTOS desde RECURRENTES). Nada más escribe.
- **Las finanzas no se delegan.** Solo escribe el propietario, desde su sesión del dashboard. Nunca el PM, ni otra
  sesión de Claude, ni una rutina, ni el conector de Google Sheets. El PM no puede ni leer estas rutas.
- **Solo altas.** No hay ruta para editar ni borrar movimientos ni recurrentes desde el dashboard. Un error se corrige
  con otro movimiento (§3.4). RECURRENTES y PARAMETROS los mantiene el propietario a mano en la hoja.
- Mismo patrón que la API de operaciones (✅ `handleWrite`, `evaluateWriteRequest`, `OperationsService`): requestId
  idempotente, validación completa antes de escribir, auditoría antes de la entidad y verificación después. **No es**
  la API de operaciones: rutas, servicio, almacén y auditoría propios, ligados solo al libro FINANZAS.
- La lectura de la v1 no cambia de cuenta ni de alcance: sigue con la cuenta de lectura, `spreadsheets.readonly` y solo
  `GET` (📄 [v1 §1](diseno-finanzas.md#1-qué-es-y-qué-no-es)).

## 2. Quién puede escribir (criterio 1)

### 2.1 Rutas fuera de la lista del PM

| Método y ruta | Operación |
| --- | --- |
| `POST /api/finanzas/movimientos` | `finanzas.movimiento.crear` |
| `POST /api/finanzas/recurrentes/confirmar` | `finanzas.recurrente.confirmar` |

- Viven en `/api/finanzas/`, **fuera de `/api/operaciones/`**. La lista `AGENT_ROUTES` del proxy (✅ `authz.ts`: solo
  `POST` a `tareas|decisiones|ordenes` y `PATCH` a `tareas|ordenes/<id>`) no se toca, así que el proxy nunca trata una
  petición a `/api/finanzas/` como del agente: exige la cookie de sesión.
- **Rechazo explícito del token del PM, en dos capas.** (1) Proxy: sin cookie de sesión válida, 401. (2) Ruta: el guard
  de finanzas **no tiene rama de agente**. Si la petición trae cualquier cabecera `Authorization`, responde 401
  `no-autenticado` antes de leer el cuerpo, de pedir token a Google o de tocar el limitador, aunque también traiga
  cookie y aunque el token sea el del PM. Se usa un guard propio (`evaluateFinanzasWriteRequest`), no
  `evaluateWriteRequest` con una opción, para que un cambio futuro en la rama del agente no abra estas rutas.
- No se añade ninguna operación de finanzas a `AGENT_OPERATIONS` ni a `OperationName`: el nombre de operación de
  finanzas es de otro tipo (`FinanzasOperationName`), y una prueba de tipos lo impide.

### 2.2 Solo el propietario

Orden de verificaciones (la de V1.4, ✅ `guard.ts`, sin agente): 401 sin sesión o con `Authorization` → 403 fuera de
`AUTH_ALLOWED_EMAILS` → 403 origen/CSRF (`x-project-os-csrf`) → 403 `escritura-deshabilitada` sin modo (§7) → 403
escritor → 415 → 413 → 429 → 400 JSON.

- **Escritor de finanzas** (ORD-POS-077) = `FINANZAS_WRITER_EMAIL`, **exactamente un correo**, que además debe estar en
  `AUTH_ALLOWED_EMAILS` (✅ `finanzas/escritura-config.ts`). Vacía, con una lista o fuera de la lista de lectores: la
  escritura de finanzas queda deshabilitada (403 `escritura-deshabilitada`). No depende de `AUTH_WRITER_EMAILS`: añadir
  un escritor a la hoja de PROJECT-OS no le da finanzas, y quitarle finanzas al propietario no le quita PROJECT-OS.
  Con la escritura activa, otra cuenta permitida recibe 403 `sin-permiso-escritura`.
- Límite de frecuencia propio (clave `finanzas`): ráfaga de 5 y 1 alta cada 10 s; al excederlo, 429.
- Los botones solo se pintan si `finanzasCanWrite(email)` (modo activo y escritor único); el servidor repite todo.

## 3. «Nuevo movimiento» (criterios 1 y 2)

### 3.1 Campos del formulario

Los de MOVIMIENTOS ([v1 §2.1](diseno-finanzas.md#21-movimientos--un-renglón-por-movimiento-de-dinero)), más la columna
nueva de §8. Lo que no captura el propietario lo pone el servidor.

| Columna | En el formulario | Regla al validar |
| --- | --- | --- |
| `MOV_ID` | no (lo asigna el servidor) | `MAN-NNNN` siguiente (§3.2) |
| `FECHA` | sí, fecha | `AAAA-MM-DD` válida, no futura (hoy en `America/Merida` con 1 día de margen) y no anterior a `MES_INICIO` si existe |
| `PROYECTO` | sí, lista | `ECO` \| `POS` |
| `TIPO` | sí, lista | `Gasto` \| `Ingreso` \| `Inversión` |
| `CATEGORIA` | sí, lista | Lista cerrada de [v1 §2.3](diseno-finanzas.md#23-categorías-lista-cerrada) |
| `CONCEPTO` | sí, texto | 3 a 80 caracteres en el texto final de la celda, prefijo de un ajuste incluido (§3.4; ✅ ORD-POS-079), saneado como los textos de operaciones (✅ `sanitize.ts`); rechaza lo que parezca correo, CLABE (18 dígitos), tarjeta (13 a 19 dígitos), RFC o URL |
| `PRODUCTO_ID` | no, texto | Vacío o `^EC-\d{3,4}$` (❓ mismo formato que `IDEA_ID` de RADAROS, v1) |
| `MONEDA_ORIG` | sí, lista | `MXN` (por defecto) \| `USD` |
| `MONTO_ORIG` | sí si `USD` | Número > 0, hasta 2 decimales |
| `TIPO_CAMBIO` | sí si `USD` (precargado con `TIPO_CAMBIO_DEFECTO`) | Número > 0, hasta 4 decimales |
| `MONTO_MXN` | sí si `MXN`; si `USD`, lo calcula el servidor | Número > 0, 2 decimales. En `USD`: `round(MONTO_ORIG × TIPO_CAMBIO, 2)`, que el formulario muestra antes de enviar; si el cliente manda otro valor, 400 `monto-no-cuadra` |
| `IVA_MXN` | no | Vacío o 0 ≤ `IVA_MXN` ≤ `MONTO_MXN` |
| `FUENTE` | no | Siempre `manual` |
| `COMPROBANTE` | sí, `sí`/`no` | — |
| `AJUSTE_DE` | solo en «Ajustar» (§3.4) | Vacío, o un `MOV_ID` existente (§3.4) |

`TIPO` y `CATEGORIA` sin cruce obligatorio (la tabla de v1 da el `TIPO` habitual, no una regla). Los montos se manejan
en centavos enteros, como la vista (✅ `finanzas.ts`).

### 3.2 `MAN-NNNN` estable

- El servidor asigna el siguiente: `max(NNNN)` de los `MAN-` de MOVIMIENTOS **y** de AUDITORIA de FINANZAS, más 1.
  Leer también la auditoría cumple la regla v1 de no reutilizar un ID borrado a mano (📄 v1 §2.2, regla 2).
- `MAN-9999` es el último: después, 409 `finanzas-ids-agotados` (❓ ampliar a 5 dígitos con una orden de migración si
  se acerca).
- El ID queda fijado en la fila de auditoría (§5) antes de escribir la fila; un reintento con el mismo requestId
  recupera el mismo ID, nunca asigna otro.

### 3.3 requestId e idempotencia

- El formulario genera un UUID (`crypto.randomUUID()`) al abrirse y lo reenvía en cada reintento; se renueva solo tras
  un alta correcta. Mismo formato que hoy (✅ `^[0-9a-f-]{36}$`, `http.ts`).
- El servidor guarda en la auditoría el requestId y el hash del cuerpo normalizado (como ✅ `replayCreate`):
  - mismo requestId y mismo hash, ya aplicado → 200 con `repetida: true` y el mismo `MOV_ID`;
  - mismo requestId y mismo hash, auditado pero sin fila (caída a medias) → completa la fila (roll-forward) y 200;
  - mismo requestId con otro hash → 409 `conflicto-idempotencia`, sin escribir.
- Doble clic, recarga o red lenta no duplican: el botón se desactiva al enviar y el servidor decide por requestId.
- Tras una respuesta que pudo dejar la auditoría sin su fila (`escritura-fallida`, `verificacion-fallida`,
  `auditoria-fallida`, `conflicto-concurrente`, error interno o sin respuesta), el formulario reenvía el **mismo** cuerpo
  con el mismo requestId aunque se haya editado, hasta completar ese `MAN` (✅ ORD-POS-079, `finanzas/envio.ts`): ningún
  `MAN` queda auditado sin fila por un reenvío ni deja hueco. Lo que estuviera mal se corrige después con «Ajustar».
- Un error permanente al reenviar ese cuerpo (`validacion`, `auditoria-inconsistente`, `estado-divergente`) lo
  descongela para corregir el formulario (✅ ORD-POS-080): con `validacion` se conserva el requestId; con los otros dos,
  cuya auditoría queda para revisión manual, se renueva. En «Ajustar», mientras está congelado, la lista del original se
  bloquea y muestra el `ajusteDe` congelado: el original enviado es siempre el que se ve.

### 3.4 Sin borrar ni editar: correcciones con otro movimiento

- No existen `PATCH` ni `DELETE` en `/api/finanzas/`. El formulario no carga una fila para editarla.
- **«Ajustar»** junto a cada movimiento de la lista abre el mismo formulario con `AJUSTE_DE` = ese `MOV_ID` y con
  `PROYECTO`, `TIPO` y `CATEGORIA` copiados y bloqueados. El alta de ajuste:
  - lleva su propio `MAN-NNNN` y `CONCEPTO` «Ajuste de `<MOV_ID>`: …»;
  - admite `MONTO_MXN` **negativo** (contrapartida), y solo en un ajuste;
  - exige que el `MOV_ID` referido exista y que la suma del original más sus ajustes no quede por debajo de 0
    (409 `ajuste-excede-original`).
- Anular = un ajuste por el monto completo en negativo. Corregir un monto = un ajuste por la diferencia (o anular y dar
  de alta el correcto). El original nunca se toca.
- La edición a mano en la hoja sigue siendo posible para el propietario (es su libro), pero el dashboard no la ofrece;
  la regla 3 de v1 §2.2 se actualiza en la orden de construcción para preferir el ajuste.

## 4. Cargos recurrentes (criterio 3)

### 4.1 Esquema de RECURRENTES

Pestaña nueva que agrega el propietario. Una fila por cargo que se repite cada mes. Encabezados en la fila 1, buscados
por nombre; columnas nuevas siempre al final.

| Columna | Obligatoria | Formato | Regla |
| --- | --- | --- | --- |
| `ID` | sí | `^[A-Z0-9]{2,12}$` | Estable y único en la pestaña (p. ej. `CLAUDE`, `KEEPA`). Nunca se renombra ni se reutiliza: forma parte del `MOV_ID` |
| `CONCEPTO` | sí | texto corto | Como en MOVIMIENTOS: sin datos personales ni bancarios |
| `PROYECTO` | sí | `ECO` \| `POS` | Nunca `SIG` |
| `CATEGORIA` | sí | lista cerrada de v1 §2.3 | — |
| `MONTO` | sí | número > 0, 2 decimales | Monto **esperado** en `MONEDA`; se puede cambiar al confirmar |
| `MONEDA` | sí | `MXN` \| `USD` | — |
| `DIA_COBRO` | sí | entero 1 a 31 | En meses más cortos, el último día del mes |
| `DESDE` | sí | `AAAA-MM` | Primer mes con cargo |
| `HASTA` | no | `AAAA-MM` ≥ `DESDE` | Último mes con cargo; vacío = vigente. Para dar de baja, se pone `HASTA` (nunca se borra la fila) |

Reglas fijas que no son columnas: `TIPO` = `Gasto` y `FUENTE` = `recurrente` (§8). Una fila con `ID` vacío,
duplicado o fuera de formato, o con otra columna fuera de regla, **no genera pendientes**: aparece en «recurrentes con
problema» con su `ID` (o número de fila) y la columna, sin monto, como las filas con problema de la v1.

### 4.2 Pendientes del mes en /finanzas

- La vista lee RECURRENTES junto con MOVIMIENTOS y PARAMETROS, en el mismo `values:batchGet` (sigue en 2 lecturas por
  carga, 📄 v1 §3); sin la pestaña, el bloque dice «la pestaña RECURRENTES todavía no existe».
- **Mes actual** M = mes de hoy en `America/Merida`. Un recurrente está **pendiente en M** si está vigente en M
  (`DESDE` ≤ M y `HASTA` vacío o ≥ M) y `REC-<ID>-M` no existe en MOVIMIENTOS.
- Se muestran los pendientes de M y, marcados «atrasado», los del mes anterior (un cargo del último día se confirma
  al día siguiente). Meses más viejos no se listan: se capturan con «Nuevo movimiento».
- Cada pendiente muestra concepto, proyecto, monto esperado, moneda y día de cobro, y «aún no vence» si hoy es anterior
  a `DIA_COBRO`. Con escritura activa (§7) lleva el botón **«Confirmar»**; sin ella, la lista se ve igual, sin botón.
- La lista es función pura de las filas leídas (como `construirFinanzas`), con pruebas; no escribe nada al leer.

### 4.3 Confirmar con `MOV_ID` estable

El botón abre un formulario corto, precargado:

| Campo | Precarga | Editable | Regla |
| --- | --- | --- | --- |
| Monto | `MONTO` de RECURRENTES | sí | Número > 0, 2 decimales, en `MONEDA` |
| Tipo de cambio (solo `USD`) | `TIPO_CAMBIO_DEFECTO` de PARAMETROS | sí | Número > 0, hasta 4 decimales |
| Fecha | M-`DIA_COBRO` (ajustado al último día) | sí, dentro del mes M | — |
| Comprobante | `no` | sí | `sí` \| `no` |

El cuerpo enviado lleva `requestId`, `recurrenteId`, `mes` (`AAAA-MM`) y esos cuatro campos. El servidor:

1. Relee RECURRENTES y valida que el `ID` exista, sea válido y esté vigente en `mes`, y que `mes` sea M o M−1.
2. Construye la fila: `MOV_ID` = **`REC-<ID>-AAAA-MM`**, `FECHA`, `PROYECTO`/`CATEGORIA`/`CONCEPTO` del recurrente,
   `TIPO` = `Gasto`, `FUENTE` = `recurrente`, `MONEDA_ORIG`/`MONTO_ORIG`/`TIPO_CAMBIO` si `USD`, `MONTO_MXN` (directo
   en `MXN`; `round(monto × tipo de cambio, 2)` en `USD`), `COMPROBANTE`.
3. **Nunca se duplica:** si `REC-<ID>-AAAA-MM` ya está en MOVIMIENTOS o en la auditoría con **otro** requestId → 409
   `recurrente-ya-confirmado`, sin escribir. Con el mismo requestId y hash → `repetida` (o roll-forward), como §3.3.
   El ID se deriva solo de `ID` y del mes, así que dos confirmaciones del mismo cargo y mes chocan siempre.
4. Audita, escribe y verifica (§5).

Si el monto real difiere del esperado, se edita en el formulario antes de confirmar; un error descubierto después se
corrige con un ajuste (§3.4) que referencia el `REC-…`. Cambiar el monto **esperado** de meses futuros es editar
`MONTO` en RECURRENTES (lo hace el propietario en la hoja).

### 4.4 Relación con `CLAUDE-AAAA-MM` (v1 §9.2)

RECURRENTES sustituye la «plantilla de filas que el propietario copia cada mes» de v1 §9.2: Claude y Keepa se cargan
como recurrentes (`REC-CLAUDE-AAAA-MM`). `CLAUDE-` queda reservado para una fuente automática de Anthropic, si algún
día se construye; al encenderla, el propietario pone `HASTA` en el recurrente `CLAUDE` (misma regla que v1 §9.3), y
nunca conviven dos filas del mismo mes.

## 5. Validar, auditar, escribir y verificar (criterio 2)

Mismo orden que ✅ `OperationsService` («referencias → idempotencia → AUDITORÍA → entidad → verificación»):

1. **Validar todo antes de escribir.** Cuerpo, campos (§3.1 o §4.3), referencias (`AJUSTE_DE`, recurrente vigente),
   unicidad del `MOV_ID` y encabezados de MOVIMIENTOS (si falta una columna obligatoria o hay columnas repetidas,
   400 `finanzas-esquema-invalido` y nada se escribe). Cualquier fallo: ninguna escritura.
2. **Idempotencia** por requestId contra la auditoría (§3.3).
3. **Auditoría primero.** Una fila por campo en la pestaña **AUDITORIA del libro FINANZAS**, con las columnas de la
   auditoría actual (✅ `AUDIT_ID`, `FECHA_HORA`, `ACTOR`, `ENTIDAD` = `MOVIMIENTOS`, `REGISTRO_ID` = `MOV_ID`, `CAMPO`,
   `VALOR_ANTES` vacío, `VALOR_DESPUES`, `ORIGEN` = `dashboard-finanzas;modo=sheets;req=<requestId>;hash=<hash>`).
4. **Entidad.** Una fila nueva al final de MOVIMIENTOS, columnas en el orden de los encabezados leídos.
5. **Verificación.** Relee la fila por `MOV_ID`; si no cuadra con lo auditado, 409 `verificacion-fallida` (mismo código que operaciones) (el
   reintento con el mismo requestId hace roll-forward).

Por qué la auditoría vive **en FINANZAS** y no en la AUDITORIA de PROJECT-OS: llevaría montos a la hoja que lee el PM
y daría a la cuenta de escritura una razón para cruzar libros en una misma operación. Así cada operación de finanzas
toca un solo libro.

**Concurrencia.** La misma cola en proceso que el servicio de operaciones (✅ `queue` en `service.ts`), propia del
servicio de finanzas; supone una instancia (`maxScale: 1`, riesgo conocido de [estado actual](estado-actual.md)). Si
la relectura del paso 1 y la del paso 5 encuentran dos filas con el mismo `MOV_ID`, 409 `conflicto-concurrente` y la
vista lo marca como fila con problema.

## 6. Permisos: qué cuenta pasa a Editor de FINANZAS (criterio 4)

Nota del PM: comparar dar Editor sobre FINANZAS a la cuenta de escritura (`project-os-writer`) o a la de lectura
(`project-os-dashboard-run`, hoy solo Lector; riesgo R4).

| Aspecto | A. Cuenta de escritura `project-os-writer` | B. Cuenta de lectura `project-os-dashboard-run` |
| --- | --- | --- |
| Cómo obtiene el token | Suplantación con `generateAccessToken`, 10 min, alcance `spreadsheets` (✅ `write-credentials.ts`); solo en una petición de escritura | ADC de Cloud Run, en cada carga de página |
| Qué ganaría con Editor | Un libro más: PROJECT-OS y FINANZAS | Escritura posible en FINANZAS desde la identidad que ya usa toda la lectura |
| R4 (escritura accidental) | Sin cambio: la lectura sigue sin poder escribir (Lector + `spreadsheets.readonly` + solo `GET`) | **Empeora:** basta un cambio de alcance en el cliente de lectura para escribir; se pierde la defensa «aunque alguien diera Editor por error, la vista no puede escribir» (📄 v1 §6) |
| R3 (permisos de más) | La cuenta de escritura pasa de 1 a 2 libros; sigue sin roles de proyecto | La cuenta de lectura deja de ser «solo Lector»; la verificación de v1 §6 («Editor sería un permiso de más») dejaría de valer |
| IAM y GCP | Ninguno: el `TokenCreator` de la cuenta de lectura sobre `project-os-writer` ya existe (📄 [escritura V1.8 §1](escritura-v1-8.md#1-cuenta-de-escritura-y-permisos)) | Ninguno, pero rompe la separación lectura/escritura de V1.8 |
| Riesgo propio | El PM también escribe (en PROJECT-OS) con esta cuenta, y el alcance `spreadsheets` vale para todo libro compartido con ella | Toda petición, incluida la de un lector, corre con una identidad capaz de escribir |

**Propuesta del diseño (sustituida): A, `project-os-writer`.** Mantenía la regla de V1.8 —la identidad de lectura nunca escribe; la de escritura
solo existe 10 minutos y solo en una escritura— y no empeora R4. Su riesgo propio (un libro más al alcance de la
cuenta que también usa el PM) se contiene en el código, no en IAM:

- El servicio de finanzas y su almacén reciben **solo** `FINANZAS_SHEET_ID`; el servicio de operaciones recibe solo
  `SHEETS_SPREADSHEET_ID`. Ninguno acepta el ID por parámetro de petición. `finanzasConfig` ya exige que el ID sea
  distinto del de PROJECT-OS y del de RADAROS (✅ `config.ts`).
- Las rutas del PM no llegan al servicio de finanzas (§2.1) y las de finanzas no llegan al de operaciones (pruebas
  cruzadas en §9).
- La lectura de /finanzas sigue con la cuenta de lectura; la cuenta de escritura solo se usa en las dos rutas `POST`.

**Decidida por el propietario (2026-10-23): C, una cuenta nueva solo para FINANZAS** (p. ej. `project-os-finanzas`),
Editor solo de FINANZAS. Aísla mejor que A: el PM escribe en PROJECT-OS con `project-os-writer`, que nunca gana acceso a
FINANZAS, y ninguna identidad puede escribir en los dos libros. Su costo (crear la cuenta y un `TokenCreator` en IAM) es
del propietario, en la activación (§7.2). El código lo asegura así (✅ ORD-POS-077):

- `FINANZAS_WRITE_SERVICE_ACCOUNT` es obligatoria, con formato de cuenta de servicio y **distinta** de la cuenta de
  lectura (`SHEETS_EXPECTED_SERVICE_ACCOUNT`) y de `PROJECT_OS_WRITE_SERVICE_ACCOUNT`; `render.mjs` exige además que sea
  del mismo proyecto y distinta de la runtime y de `WRITE_SERVICE_ACCOUNT`.
- El token se pide por suplantación de esa cuenta (✅ `write-credentials.ts`, alcance `spreadsheets`, 10 min) y solo
  dentro de una petición de escritura que ya pasó el guard.
- El servicio y el almacén de finanzas solo reciben `FINANZAS_SHEET_ID` y esa cuenta; el de operaciones, solo
  `SHEETS_SPREADSHEET_ID` y `project-os-writer` (pruebas cruzadas en `tests/finanzas-cruce.test.ts`).

**R3 y R4 tras activar.** R3: la cuenta de lectura sigue Lector de tres libros como máximo; `project-os-writer` sigue
Editor solo de PROJECT-OS; la cuenta nueva es Editor solo de FINANZAS; ninguna tiene roles de proyecto. R4: sin cambio
para la lectura; la escritura en FINANZAS exige modo, libro, cuenta propia, escritor único y su sesión. Tabla actualizada
en la [preparación V1.6](despliegue-v1-6-preparacion.md#5-riesgos-de-seguridad-y-costos).

## 7. Inercia y activación del propietario (criterio 4, DEC-POS-014)

### 7.1 Inerte por defecto

`finanzasWriteMode(env)` devuelve `sheets` **solo** si se cumplen todas (✅ `finanzas/escritura-config.ts`, opción C):

- `FINANZAS_WRITE_MODE` = `sheets` exacto (cualquier otro valor, o ausente: deshabilitada);
- `finanzasConfig` válido (📄 v1 §3: `FINANZAS_SHEET_ID` presente, con formato y distinto de las otras hojas);
- `FINANZAS_WRITE_SERVICE_ACCOUNT` válida y distinta de la de lectura y de la de escritura de PROJECT-OS (§6); sin
  `SHEETS_EXPECTED_SERVICE_ACCOUNT` no se puede comprobar y queda deshabilitada (`sin-cuenta-de-lectura`, ✅ ORD-POS-079);
- escritor único `FINANZAS_WRITER_EMAIL`, presente en `AUTH_ALLOWED_EMAILS` (§2.2).

No depende de `PROJECT_OS_WRITE_MODE`: la escritura de finanzas se enciende y se apaga sola.

Sin eso: las rutas responden 403 `escritura-deshabilitada` **antes** de pedir un token (cero llamadas a
`iamcredentials.googleapis.com` y a Sheets), la página no pinta «Nuevo movimiento» ni «Confirmar» y muestra la lista de
pendientes solo como lectura. No hay modo `mock` para finanzas en Cloud Run.

`render.mjs` acepta `FINANZAS_WRITE_MODE`, `FINANZAS_WRITE_SERVICE_ACCOUNT` y `FINANZAS_WRITER_EMAIL`, **las tres juntas**:
el modo solo `sheets` y con `FINANZAS_SHEET_ID`, la cuenta con formato, del proyecto y distinta de la runtime y de
`WRITE_SERVICE_ACCOUNT`, y el escritor un único correo. Cualquier otra combinación hace fallar el render sin imprimir
valores ni YAML. Sin ninguna, el YAML no cambia. `deploy.sh --desde-activa` las conserva y `--quitar` de cualquiera de
las tres las retira todas.

### 7.2 Activación (solo el propietario, tras fusionar y desplegar F-2) — opción C

Ningún agente crea la cuenta, toca IAM, comparte la hoja, pone las variables ni despliega. En Cloud Shell, con
`PROJECT_ID=project-os-511102`:

1. **Respaldo.** En la hoja FINANZAS: Archivo → Historial de versiones → nombrar la versión «antes de escritura de
   finanzas».
2. **Esquema.** Crear las pestañas `RECURRENTES` (§4.1) y `AUDITORIA` (encabezados de §5, paso 3, en la fila 1), la
   columna `AJUSTE_DE` al final de MOVIMIENTOS y añadir `recurrente` a la validación de `FUENTE` (§8). Sin `RECURRENTES`
   o sin `AUDITORIA`, las dos rutas responden 400 sin escribir. `FECHA` se escribe como texto `AAAA-MM-DD` (RAW): si
   alguna fórmula de RESUMEN agrupa por fecha, debe aceptar ese texto (❓ revisar al activar).
3. **Crear la cuenta exclusiva** (sin claves, sin roles de proyecto):

   ```bash
   gcloud iam service-accounts create project-os-finanzas --project "$PROJECT_ID" \
     --display-name "PROJECT-OS escritura de FINANZAS"
   ```
4. **TokenCreator de la cuenta de lectura sobre ella** (y nada más):

   ```bash
   gcloud iam service-accounts add-iam-policy-binding \
     "project-os-finanzas@$PROJECT_ID.iam.gserviceaccount.com" --project "$PROJECT_ID" \
     --member "serviceAccount:project-os-dashboard-run@$PROJECT_ID.iam.gserviceaccount.com" \
     --role roles/iam.serviceAccountTokenCreator
   ```
5. **Compartir FINANZAS** → correo de `project-os-finanzas` → **Editor** → desmarcar «Notificar». La cuenta de lectura
   sigue **Lector**; `project-os-writer` no se agrega; no compartir nada más con la cuenta nueva.
6. **Variables** (las tres juntas; el correo es el del propietario y debe estar en la lista de lectores):

   ```bash
   export FINANZAS_WRITE_MODE=sheets
   export FINANZAS_WRITE_SERVICE_ACCOUNT="project-os-finanzas@$PROJECT_ID.iam.gserviceaccount.com"
   export FINANZAS_WRITER_EMAIL='<correo del propietario>'
   web/deploy/cloudrun/deploy.sh --dry-run --desde-activa   # debe listar las tres como nuevas
   web/deploy/cloudrun/deploy.sh --desde-activa
   ```
7. **Verificar:**
   - en /finanzas aparecen «Nuevo movimiento», «Ajustar» y «Confirmar» solo con la sesión del propietario; con otra
     cuenta permitida, no;
   - un alta de prueba crea `MAN-…` en MOVIMIENTOS y sus filas en la AUDITORIA de FINANZAS; un ajuste por el monto
     completo la anula (no se borra);
   - en Compartir de FINANZAS: `project-os-finanzas` Editor, cuenta de lectura Lector, ninguna otra cuenta de servicio;
     en Compartir de PROJECT-OS, `project-os-finanzas` no aparece;
   - sin roles de proyecto para la cuenta nueva (debe salir vacío):

     ```bash
     gcloud projects get-iam-policy "$PROJECT_ID" --flatten="bindings[].members" \
       --filter="bindings.members:serviceAccount:project-os-finanzas@" --format="value(bindings.role)"
     ```
   - en la política de la cuenta nueva, solo `roles/iam.serviceAccountTokenCreator` para la cuenta de lectura
     (`gcloud iam service-accounts get-iam-policy project-os-finanzas@$PROJECT_ID.iam.gserviceaccount.com`);
   - con el token del PM, `POST /api/finanzas/movimientos` responde 401 y no escribe.
8. **Revertir:** `web/deploy/cloudrun/deploy.sh --desde-activa --quitar FINANZAS_WRITE_MODE` (retira las tres
   variables), quitar a `project-os-finanzas` del Compartir de FINANZAS y, si no se volverá a usar, quitar el
   `TokenCreator` (`gcloud iam service-accounts remove-iam-policy-binding …` con los mismos argumentos del paso 4) y
   deshabilitar la cuenta (`gcloud iam service-accounts disable …`). La vista de solo lectura sigue igual.

## 8. Migración del esquema de FINANZAS

Cambios explícitos sobre v1 §2 (`AGENTS.md`: sin cambios silenciosos). Todos son aditivos: las filas existentes siguen
válidas.

| Cambio | Antes (v1) | Después (v2) |
| --- | --- | --- |
| `FUENTE` | `manual` \| `sp-api` \| `anthropic` | Se añade `recurrente` |
| Prefijos de `MOV_ID` (v1 §2.2) | `MAN-`, `SPAPI-`, `CLAUDE-` | Se añade `REC-<ID>-AAAA-MM` (`^REC-[A-Z0-9]{2,12}-\d{4}-(0[1-9]\|1[0-2])$`) con `FUENTE` = `recurrente` |
| MOVIMIENTOS | 14 columnas | Se añade `AJUSTE_DE` al final (opcional; `MOV_ID` existente) |
| `MONTO_MXN` | > 0 siempre | > 0; negativo solo con `AJUSTE_DE` |
| Pestañas | MOVIMIENTOS, PARAMETROS, RESUMEN | Se añaden RECURRENTES (§4.1) y AUDITORIA (§5) |

La vista de la v1 (✅ `finanzas.ts`, `PREFIJOS` y `FUENTES`) hoy marcaría como «fila con problema» un `REC-…` o un monto
negativo: la primera orden de §9 la actualiza **antes** de que exista la escritura, y las fórmulas de RESUMEN (v1 §2.5)
ya suman bien los negativos de `SUMIFS`. En los bloques, un ajuste suma con su signo en el mes de su propia `FECHA`.

## 9. Propuesta de las órdenes de construcción (MEDIO)

Para registrar como BORRADOR; no se crean desde esta orden. Las dos son MEDIO: revisión completa a ciegas, delta tras
corrección y segundo revisor (DEC-POS-008). La activación de §7.2 es la parte ALTO, del propietario (DEC-POS-014).

### 9.1 F-1 «/finanzas v2: esquema y pendientes de recurrentes, solo lectura»

- **Riesgo:** MEDIO (lectura de una pestaña más; sin escritura).
- **Criterios:**
  1. `FUENTE` `recurrente`, prefijo `REC-`, columna `AJUSTE_DE` y montos negativos solo en ajustes (§8), con pruebas
     de filas válidas y con problema.
  2. Lectura de RECURRENTES en el mismo `batchGet` (máximo 2 lecturas por carga, prueba con doble de `fetch`).
  3. Funciones puras: validación de RECURRENTES, pendientes de M y M−1, «aún no vence», «atrasado», último día del mes
     para `DIA_COBRO`; recurrentes con problema sin monto.
  4. Bloque «Recurrentes del mes» en /finanzas, sin botones, con sus estados (sin pestaña, vacía, con problema).
  5. Docs: v1 §2.2 y §9.2 remiten a este diseño.
- **Fuera de alcance:** escritura, rutas `POST`, permisos, despliegue, hojas reales.
- **Cómo probar:** `npm test`, `npm run lint`, `npm run typecheck`, `npm run check:client-secrets` en `web/`;
  `python -m unittest discover -s tests`.

### 9.2 F-2 «/finanzas v2: alta de movimientos y confirmación de recurrentes, inerte sin `FINANZAS_WRITE_MODE`»

- **Riesgo:** MEDIO (código de escritura apagado por defecto; la activación es del propietario).
- **Criterios:**
  1. `finanzasWriteMode` y `finanzasCanWrite` (§7.1, §2.2) con pruebas de cada condición, incluido escritor ambiguo.
  2. Guard propio sin rama de agente: `Authorization` presente → 401 antes de leer el cuerpo; prueba con el token
     válido del PM, con y sin cookie. `AGENT_ROUTES` y `AGENT_OPERATIONS` sin cambios (prueba).
  3. Servicio y almacén de finanzas ligados solo a `FINANZAS_SHEET_ID`; pruebas cruzadas de que operaciones nunca
     escribe en FINANZAS ni finanzas en PROJECT-OS.
  4. `POST /api/finanzas/movimientos`: validación de §3.1, `MAN-NNNN` de §3.2, idempotencia de §3.3 (repetida,
     roll-forward, conflicto), ajustes de §3.4.
  5. `POST /api/finanzas/recurrentes/confirmar`: §4.3, incluido `recurrente-ya-confirmado` con otro requestId y monto y
     tipo de cambio editados.
  6. Auditoría en FINANZAS antes de la fila y verificación después (§5), con pruebas de fallo en cada paso.
  7. **Prueba de inercia:** sin `FINANZAS_WRITE_MODE=sheets` (o sin cualquiera de las condiciones de §7.1), cero
     llamadas a los dobles de token y de `fetch`, 403 y sin botones.
  8. `render.mjs` y `deploy.sh --desde-activa` aceptan, validan y conservan `FINANZAS_WRITE_MODE` (§7.1); sin ella el
     YAML no cambia (prueba).
  9. Formularios «Nuevo movimiento», «Ajustar» y «Confirmar» con requestId por apertura y botón desactivado al enviar.
  10. Docs: runbook de activación (§7.2) y R3/R4 en la preparación V1.6.
- **Fuera de alcance:** compartir la hoja, poner la variable, desplegar, IAM, cuentas nuevas, editar o borrar
  movimientos, escribir RECURRENTES o PARAMETROS, cualquier acceso del PM.
- **Cómo probar:** los mismos comandos de F-1 y la prueba de inercia del criterio 7.

## 10. Qué cambia y qué no

| Cambia (al construir y activar) | No cambia |
| --- | --- |
| Dos rutas `POST` de finanzas, un guard y un servicio propios, formularios en /finanzas, tres variables opcionales que van juntas | API de operaciones, `AGENT_ROUTES`, `AGENT_OPERATIONS`, permisos del PM, hoja de PROJECT-OS |
| Cuenta nueva `project-os-finanzas`, Editor solo de FINANZAS, con `TokenCreator` de la cuenta de lectura (opción C; la crea el propietario) | Cuenta de lectura (Lector), `project-os-writer` (sin FINANZAS), alcance `spreadsheets.readonly` de la lectura, `.github/workflows` |
| Esquema de FINANZAS: §8 | RADAROS y /eco |

## 11. Datos que nunca van al repositorio (criterio 6)

- Sin montos reales en `docs/`, issues, PR ni pruebas: los ejemplos son formatos (`MAN-NNNN`, `REC-<ID>-AAAA-MM`),
  no cifras; las pruebas usan montos sintéticos.
- Sin datos bancarios (cuentas, CLABE, tarjetas), RFC, razones sociales ni números de factura; el formulario los
  rechaza en `CONCEPTO` (§3.1) y `COMPROBANTE` sigue siendo `sí`/`no`.
- Sin IDs de libros ni correos: `FINANZAS_SHEET_ID` y `FINANZAS_WRITER_EMAIL` viven solo en Cloud Run (`deploy.sh` nunca
  imprime sus valores); las pruebas usan correos y cuentas sintéticos.
