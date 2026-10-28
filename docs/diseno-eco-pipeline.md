# Diseño del pipeline de ECOMMERCE en /eco — productos y proveedores

Orden ORD-POS-095 (tarea POS-031, paquete PAQ-2026-10-25-02), riesgo MEDIO: el paquete decía BAJO y el PM lo subió
porque este diseño fija una ruta de escritura y su autorización (DEC-POS-014, como ORD-POS-091). Fecha: 2026-10-25.
**Solo diseño:** no hay código en `web/`, no se crea ninguna pestaña, no se comparte ninguna hoja, no se toca IAM, no se
activa ninguna escritura, no se llama a SP-API y no se despliega. La construcción va en otras órdenes (§10).

**Camino b** (decidido por el propietario el 2026-10-25): la hoja de RADAROS (`ecommerce_os_v1`) es la **única fuente**
del pipeline. Ni la hoja de PROJECT-OS ni FINANZAS guardan productos, proveedores ni cotizaciones; el dashboard lee y
escribe ese libro y nada más para esta función.

Fuentes: [diseño /eco](diseno-eco-radaros.md) (ORD-POS-066; vista de solo lectura construida en ORD-POS-067, ✅
[`web/src/lib/radaros/eco.ts`](../web/src/lib/radaros/eco.ts)), [diseño v2 de /finanzas](diseno-finanzas-v2.md) (§2,
§5 a §7: guard sin agente, auditoría en el propio libro, cuenta exclusiva, inercia; construido en ORD-POS-077, ✅
`web/src/lib/finanzas/escritura-*.ts`), API de operaciones (✅ `web/src/lib/operations/service.ts`: `VERSION`,
`expectedVersion`, `conflicto-version`, escritura guardada por ID y VERSION), proxy (✅ `web/src/lib/authz.ts`:
`AGENT_ROUTES` y `FINANZAS_AGENT_ROUTES`), diseño V1.2 de RADAROS
([`RADAROS/docs/diseno-v1-2.md`](https://github.com/jlpulido107-bit/RADAROS/blob/main/docs/diseno-v1-2.md): Keepa,
`AMZ_*`, `AMZ_CANDIDATOS` en V1.3), el mapa del dashboard en NOTAS (`00-entrada/dashboard-mapa.canvas`, referencias
SalesPulse y NeuralDesk, según el issue de la orden) y DEC-POS-014. Marcas: ✅ verificado en el código · 📄 según un
diseño fusionado · ❓ por confirmar al construir o al activar.

| Criterio de la orden | Sección |
| --- | --- |
| 1. Fase 1: pipeline de 6 etapas con arrastrar y soltar, fichas de producto y proveedor, seguimiento con fechas | §1, §2 y §5 |
| 2. Esquema: pestañas nuevas en RADAROS con su migración explícita | §3 y §8 |
| 3. Escritura: ruta propia solo a esas pestañas, apagada por defecto, bandera propia, auditoría, IDs estables, sin borrar filas; solo el propietario | §4, §6 y §7 |
| 4. Migración de los candidatos del radar de Keepa (artifact) a la hoja | §9 |
| 5. Fase 2 bosquejada (depende de SP-API) | §11 |

## 1. Qué es y qué no es

- Una sección nueva de `/eco` (subruta `/eco/pipeline`, dentro de `(private)`: mismo login y misma lista de acceso) que
  lleva cada producto desde que alguien lo sugiere hasta que se vende o se descarta, con sus proveedores, cotizaciones,
  muestras y embarques.
- **Etapas fijas, en este orden:** `SUGERIDO` → `EVALUANDO` → `COTIZANDO` → `MUESTRA` → `EN_VENTA`, más `DESCARTADO`
  (columna aparte, a la derecha). En pantalla: Sugerido, Evaluando, Cotizando, Muestra, En venta, Descartado.
- **Solo escribe el propietario**, desde su sesión del dashboard. Nunca el PM, ni otra sesión de Claude, ni una rutina,
  ni el conector de Google Sheets. El token del PM no entra (§4.1).
- **Sin borrar filas.** No hay ruta de borrado. Descartar es una etapa; un proveedor que ya no sirve pasa a `INACTIVO`;
  una cotización que no se usa pasa a `RECHAZADA`. Las ediciones cambian celdas con su auditoría (antes y después).
- **No calcula** puntuaciones, márgenes ni el costo máximo: son fórmulas de la hoja (SCORING y UNIT_ECONOMICS, 📄 V1.2
  §1 y §2.2) o datos del propietario. El dashboard muestra y compara (por ejemplo, «costo aterrizado mayor que el costo
  máximo»), pero no convierte monedas ni decide.
- **No toca lo que escribe el motor de RADAROS.** El script de Apps Script sigue escribiendo solo sus `AMZ_*`; el
  dashboard escribe solo las pestañas `PIPE_*` de §3. Ninguno escribe en las del otro (§6.2).
- **No llama a Keepa ni a SP-API.** Los datos de Keepa de la ficha son una foto copiada al dar de alta o migrar (§3.1 y
  §9); la Fase 2, que sí depende de SP-API, solo se bosqueja (§11).

## 2. Pantallas (criterio 1)

Patrón visual del mapa en NOTAS (SalesPulse para el tablero, NeuralDesk para las fichas, según el issue): **hipótesis**,
no leí el canvas; la construcción lo consulta para el estilo, no para el comportamiento, que fija este documento.

### 2.1 Tablero

- Seis columnas, una por etapa, con el número de productos de cada una. Cada tarjeta muestra `NOMBRE`, `ASIN`, días en
  la etapa (desde `ETAPA_DESDE`), el proveedor elegido si lo hay y una marca si alguna fecha de seguimiento está vencida
  (§5).
- **Arrastrar y soltar** con la API nativa de HTML (`draggable`, `dragover`, `drop`): sin dependencias nuevas
  (escalera de [`ejecutar-orden`](../.claude/skills/ejecutar-orden/SKILL.md#escalera-antes-de-escribir-código)).
- **Accesible sin ratón:** cada tarjeta tiene un control «Mover a…» (lista de las etapas permitidas por §5.1) que llama
  a la misma operación. El arrastre es un atajo, no la única vía.
- Al soltar, la tarjeta **no se mueve** hasta que el servidor confirma; si responde error (`conflicto-version`,
  `transicion-no-permitida`, `requisito-faltante`), vuelve a su columna con el mensaje. Nada optimista.
- `DESCARTADO` y `REABRIR` piden un motivo en un diálogo antes de enviar (§5.1).
- Filtros: proveedor, origen (§3.1) y «con seguimiento vencido». Sin la escritura activa (§7.1), el tablero se pinta
  igual pero sin arrastre ni botones.

### 2.2 Ficha de producto

| Bloque | Campos (§3.1) | Quién los llena |
| --- | --- | --- |
| Identidad | `PRODUCTO_ID`, `NOMBRE`, `ASIN`, `IDEA_ID`, `ORIGEN`, `ETAPA`, `ETAPA_DESDE` | El propietario; `PRODUCTO_ID`, `ETAPA_DESDE` y `ORIGEN` los pone el servidor |
| Keepa (foto) | `KEEPA_FECHA`, `KEEPA_PRECIO_MXN_AVG90`, `KEEPA_BSR_AVG90`, `KEEPA_VENTAS_MES`, `KEEPA_OFERTAS` | Alta o migración (§9); solo lectura en la ficha. Para datos vivos, el enlace al ranking de /eco por `IDEA_ID` |
| Costo máximo | `COSTO_MAX_MXN` | El propietario, o una fórmula de la hoja (❓ §12); el dashboard no lo calcula |
| Criterios K1–K6 | `K1` … `K6` | Los del radar de Keepa (§9); su significado vive en `PIPE_PARAMETROS` (§3.6) |
| Proveedor | `PROVEEDOR_ELEGIDO_ID` y la tabla de sus cotizaciones con muestra (§3.3) | El propietario |
| Seguimiento | Fechas de §5 y embarques (§3.4) | El propietario |
| Notas e historial | `NOTAS`; historial de etapas leído de `PIPE_AUDITORIA` (`CAMPO` = `ETAPA`) | El propietario; el historial lo deja la auditoría |

### 2.3 Ficha de proveedor

`PROVEEDOR_ID`, `NOMBRE`, `CANAL`, `PAIS`, `CONTACTO`, `ESTADO` y `NOTAS` (§3.2), con la lista de sus cotizaciones
(precio, MOQ, plazo, estado y muestra) y los productos en los que es el elegido. Lista de proveedores con filtro por
`ESTADO`.

## 3. Esquema: pestañas nuevas en RADAROS (criterio 2)

**Por qué el prefijo `PIPE_` y no `CANDIDATOS` a secas.** RADAROS V1.3 ya reserva `AMZ_CANDIDATOS` para la salida del
motor (📄 V1.2 §7) y el libro tiene `PRODUCTS` (ideas `EC-004` a `EC-009`, **hipótesis** de V1.2 §1). Un nombre propio
separa lo que escribe el dashboard (`PIPE_*`) de lo que escribe el motor (`AMZ_*`) y de lo que mantiene el propietario a
mano (`PRODUCTS`, `SCORING`, `UNIT_ECONOMICS`), y permite que la regla de §6.2 sea un prefijo fijo. Muestras van dentro
de la cotización (una muestra por cotización basta para la Fase 1) y embarques en su propia pestaña, porque un producto
tiene varios (pedido inicial y resurtidos) y la Fase 2 los suma.

Reglas comunes:

- Fila 1 = encabezados; las columnas se buscan **por nombre**, nunca por posición (como /eco, 📄 diseño /eco §3).
  Columnas nuevas, siempre al final.
- IDs estables `PREFIJO-NNNN` (cuatro dígitos con ceros; al pasar de 9999 se admiten más dígitos). Los asigna el
  servidor: el mayor `NNNN` existente + 1, releído dentro de la cola de escritura (§6.3). Nunca se reusan ni se renumeran.
- `VERSION` (entero desde `1`) en las cuatro pestañas editables: cada edición la sube en 1 y exige `expectedVersion`
  (como `TAREAS`, ✅ `service.ts`).
- `CREADO` y `ACTUALIZADO` en ISO 8601 con zona (`America/Merida`), los pone el servidor.
- Fechas de negocio (`FECHA_*`) como texto `AAAA-MM-DD` escrito en `RAW`.
- Montos: número con punto decimal; la moneda va en su propia columna. Ningún monto se convierte.

### 3.1 `PIPE_PRODUCTOS`

| Columna | Tipo | Regla |
| --- | --- | --- |
| `PRODUCTO_ID` | `PRD-NNNN` | Obligatoria, única, del servidor |
| `NOMBRE` | texto ≤ 120 | Obligatoria |
| `ASIN` | `^[A-Z0-9]{10}$` o vacío (10 caracteres, no solo `B0…`; ORD-POS-097) | Única entre filas no descartadas; un ASIN descartado puede volver solo con `REABRIR` (§5.1), no con un alta nueva |
| `IDEA_ID` | texto o vacío | Si viene, debe existir en `PRODUCTS` (❓ nombre de la columna, el mismo de `COLUMNA_ID_IDEA`, ✅ `eco.ts`) |
| `ORIGEN` | `RADAR_KEEPA`, `AMZ_CANDIDATOS`, `MANUAL` | Del servidor según la ruta (§4.2 y §9) |
| `ORIGEN_REF` | texto ≤ 80 o vacío | Referencia de origen (lote de migración o fila de `AMZ_CANDIDATOS`) |
| `ETAPA` | una de §1 | Alta siempre en `SUGERIDO`; solo cambia por la operación de §5.1 |
| `ETAPA_DESDE` | fecha y hora | Del servidor en cada cambio de etapa |
| `MOTIVO_DESCARTE` | texto ≤ 300 | Obligatorio al descartar; se conserva al reabrir (el historial está en la auditoría) |
| `KEEPA_FECHA`, `KEEPA_PRECIO_MXN_AVG90`, `KEEPA_BSR_AVG90`, `KEEPA_VENTAS_MES`, `KEEPA_OFERTAS` | fecha y números | Foto de Keepa; solo en alta o migración, no editables después |
| `COSTO_MAX_MXN` | número ≥ 0 o vacío | Editable |
| `K1` … `K6` | texto ≤ 40 cada uno | Editables; valores tal como los da el radar (❓ §9) |
| `PROVEEDOR_ELEGIDO_ID` | `PRV-NNNN` o vacío | Debe existir y estar `ACTIVO` |
| `NOTAS` | texto ≤ 1000 | Editable |
| `CREADO`, `ACTUALIZADO`, `VERSION` | | Del servidor |

### 3.2 `PIPE_PROVEEDORES`

| Columna | Regla |
| --- | --- |
| `PROVEEDOR_ID` | `PRV-NNNN`, del servidor |
| `NOMBRE` | Obligatorio, ≤ 120; nombre comercial |
| `CANAL` | `ALIBABA`, `1688`, `MADE_IN_CHINA`, `NACIONAL`, `OTRO` (❓ lista final del propietario) |
| `PAIS` | ISO 3166-1 alfa-2 |
| `CONTACTO` | texto ≤ 200: canal de contacto **comercial** (tienda, chat de la plataforma, correo de ventas). Ver §6.4 |
| `ESTADO` | `ACTIVO` o `INACTIVO`; nunca se borra |
| `NOTAS`, `CREADO`, `ACTUALIZADO`, `VERSION` | Como en §3.1 |

### 3.3 `PIPE_COTIZACIONES` (incluye la muestra)

| Columna | Regla |
| --- | --- |
| `COTIZACION_ID` | `COT-NNNN`, del servidor |
| `PRODUCTO_ID`, `PROVEEDOR_ID` | Obligatorios; deben existir; producto no descartado |
| `ESTADO` | `SOLICITADA` → `RECIBIDA` → `ELEGIDA`, o `RECHAZADA` desde cualquiera; una sola `ELEGIDA` por producto |
| `FECHA_SOLICITUD`, `FECHA_RESPUESTA_ESPERADA`, `FECHA_RECIBIDA` | Seguimiento de la cotización (§5.2) |
| `PRECIO_UNIT`, `MONEDA` (`USD`, `CNY`, `MXN`), `MOQ` (entero > 0), `PLAZO_PRODUCCION_DIAS`, `INCOTERM` (`EXW`, `FOB`, `CIF`, `DDP`, `OTRO`) | Obligatorios para pasar a `RECIBIDA` |
| `COSTO_ATERRIZADO_MXN` | Número o vacío: lo captura el propietario o lo da una fórmula de la hoja (❓ §12); es el que se compara con `COSTO_MAX_MXN` |
| `MUESTRA_ESTADO` | `NO_PEDIDA`, `PEDIDA`, `RECIBIDA`, `APROBADA`, `RECHAZADA` |
| `MUESTRA_FECHA_PEDIDO`, `MUESTRA_FECHA_ESPERADA`, `MUESTRA_FECHA_RECIBIDA`, `MUESTRA_COSTO`, `MUESTRA_MONEDA` | Seguimiento de la muestra |
| `NOTAS`, `CREADO`, `ACTUALIZADO`, `VERSION` | Como en §3.1 |

### 3.4 `PIPE_EMBARQUES`

| Columna | Regla |
| --- | --- |
| `EMBARQUE_ID` | `EMB-NNNN`, del servidor |
| `PRODUCTO_ID`, `COTIZACION_ID` | Obligatorios; la cotización debe ser `ELEGIDA` y del mismo producto |
| `UNIDADES` | Entero > 0 |
| `ESTADO` | `PLANEADO` → `PAGADO` → `EN_TRANSITO` → `RECIBIDO_FBA`, o `CANCELADO` |
| `FECHA_PAGO`, `FECHA_SALIDA`, `FECHA_LLEGADA_ESPERADA`, `FECHA_LLEGADA` | Seguimiento del embarque (§5.2) |
| `COSTO_TOTAL`, `MONEDA` | Lo que se pagó; lo usa la Fase 2 (capital, §11) |
| `NOTAS`, `CREADO`, `ACTUALIZADO`, `VERSION` | Como en §3.1 |

### 3.5 `PIPE_AUDITORIA`

Mismas columnas que la auditoría actual (✅ `AUDIT_ID`, `FECHA_HORA`, `ACTOR`, `ENTIDAD`, `REGISTRO_ID`, `CAMPO`,
`VALOR_ANTES`, `VALOR_DESPUES`, `ORIGEN`), con `ORIGEN` =
`dashboard-eco;modo=sheets;req=<requestId>;hash=<hash>` (o `migracion-radar;lote=<LOTE>`, §9). Vive **en RADAROS**, no
en la AUDITORIA de PROJECT-OS, por la misma razón que la de FINANZAS (📄 v2 §5): cada operación toca un solo libro y no
lleva datos de proveedores a la hoja que lee el PM. Solo altas; nunca se edita.

### 3.6 `PIPE_PARAMETROS`

Clave y valor, mantenida **a mano** por el propietario (el dashboard solo la lee): `K1_NOMBRE` … `K6_NOMBRE` (etiqueta
de cada criterio del radar), `DIAS_ALERTA_ETAPA` (por defecto 14) y, para la Fase 2, `META_INGRESOS_MES` y
`CAPITAL_TOPE` con su moneda (§11). Sin la pestaña, el dashboard usa `K1` … `K6` como etiquetas y los valores por
defecto.

## 4. Rutas de escritura (criterio 3)

### 4.1 Fuera de las rutas de agente

| Método y ruta | Operación |
| --- | --- |
| `POST /api/eco/pipeline/productos` | `eco.producto.crear` |
| `PATCH /api/eco/pipeline/productos/<PRODUCTO_ID>` | `eco.producto.editar` (campos editables de §3.1, nunca `ETAPA`) |
| `POST /api/eco/pipeline/productos/<PRODUCTO_ID>/etapa` | `eco.producto.mover` (§5.1) |
| `POST /api/eco/pipeline/proveedores` · `PATCH …/proveedores/<PROVEEDOR_ID>` | `eco.proveedor.crear` · `eco.proveedor.editar` |
| `POST /api/eco/pipeline/cotizaciones` · `PATCH …/cotizaciones/<COTIZACION_ID>` | `eco.cotizacion.crear` · `eco.cotizacion.editar` |
| `POST /api/eco/pipeline/embarques` · `PATCH …/embarques/<EMBARQUE_ID>` | `eco.embarque.crear` · `eco.embarque.editar` |

- Viven en `/api/eco/`, fuera de `/api/operaciones/` y de `/api/finanzas/`. `AGENT_ROUTES` y `FINANZAS_AGENT_ROUTES`
  (✅ `authz.ts`) **no se tocan**: el proxy nunca trata una petición a `/api/eco/` como de un agente y exige la cookie
  de sesión.
- **Guard propio sin rama de agente** (`evaluateEcoWriteRequest`, como `evaluateFinanzasWriteRequest`, 📄 v2 §2.1): con
  cualquier cabecera `Authorization` (el token del PM, el del agente de finanzas o cualquier otro) responde 401
  `no-autenticado` antes de leer el cuerpo, de pedir un token a Google o de tocar el limitador.
- Las operaciones `eco.*` son de su propio tipo (`EcoOperationName`), fuera de `OperationName` y de `AGENT_OPERATIONS`;
  una prueba de tipos lo impide. No existe ninguna ruta `DELETE`.

### 4.2 Solo el propietario

Orden de verificaciones (el de v2 §2.2): 401 sin sesión o con `Authorization` → 403 fuera de `AUTH_ALLOWED_EMAILS` →
403 origen/CSRF (`x-project-os-csrf`) → 403 `escritura-deshabilitada` sin modo (§7.1) → 403 `sin-permiso-escritura`
si el correo no es `ECO_PIPELINE_WRITER_EMAIL` → 415 → 413 → 429 (clave `eco`, ráfaga de 10 y 1 cada 3 s: el arrastre
genera más operaciones que finanzas) → 400 JSON.

- **Escritor** = `ECO_PIPELINE_WRITER_EMAIL`, exactamente un correo, que además debe estar en `AUTH_ALLOWED_EMAILS`. No
  depende de `AUTH_WRITER_EMAILS` ni de `FINANZAS_WRITER_EMAIL`: dar o quitar uno no da ni quita los otros.
- Los controles de escritura (arrastre, «Mover a…», botones de alta y edición) solo se pintan si
  `ecoPipelineCanWrite(email)`; el servidor repite todas las verificaciones.

### 4.3 Cuerpo común

`requestId` (UUID v4, obligatorio), `expectedVersion` en todo `PATCH` y en `mover`, y los campos de la operación.
Campos desconocidos: 400 `campo-no-permitido` (no se ignoran en silencio). Textos saneados como en finanzas (sin
fórmulas: un valor que empiece por `=`, `+`, `-` o `@` se rechaza, porque se escribiría en una hoja con fórmulas).

## 5. Etapas y seguimiento (criterio 1)

### 5.1 Transiciones de `eco.producto.mover`

Cuerpo: `requestId`, `expectedVersion`, `expectedEtapa`, `etapa` y `motivo` (obligatorio para `DESCARTADO` y para
reabrir). El servidor relee la fila; si `ETAPA` ≠ `expectedEtapa` o `VERSION` ≠ `expectedVersion`, 409
`conflicto-version` con la etapa y la versión actuales.

| Desde | Puede ir a | Requisito (si falta: 409 `requisito-faltante`, sin escribir) |
| --- | --- | --- |
| `SUGERIDO` | `EVALUANDO` | — |
| `EVALUANDO` | `COTIZANDO`, `SUGERIDO` | A `COTIZANDO`: `COSTO_MAX_MXN` presente |
| `COTIZANDO` | `MUESTRA`, `EVALUANDO` | A `MUESTRA`: al menos una cotización `RECIBIDA` o `ELEGIDA` |
| `MUESTRA` | `EN_VENTA`, `COTIZANDO` | A `EN_VENTA`: una cotización `ELEGIDA` con `MUESTRA_ESTADO` = `APROBADA` y `PROVEEDOR_ELEGIDO_ID` igual a su proveedor |
| `EN_VENTA` | `MUESTRA` (con motivo) | — |
| cualquiera menos `DESCARTADO` | `DESCARTADO` | `motivo` |
| `DESCARTADO` | `SUGERIDO` o `EVALUANDO` (reabrir) | `motivo`; el ASIN no debe estar en otro producto no descartado |

Saltar etapas hacia adelante no se permite: así cada requisito se comprueba una vez y el historial es legible. Los
requisitos son de **integridad de datos** (que la etapa siguiente tenga lo que muestra), no de negocio: que el costo
aterrizado supere el costo máximo es un **aviso** en la tarjeta y en la ficha, nunca un bloqueo. La decisión es del
propietario.

### 5.2 Fechas de seguimiento

Sin calendario ni recordatorios externos: el tablero marca como **vencida** una tarjeta cuando, con la fecha de hoy en
`America/Merida`:

| Qué | Vencida si |
| --- | --- |
| Cotización | `ESTADO` = `SOLICITADA` y `FECHA_RESPUESTA_ESPERADA` < hoy |
| Muestra | `MUESTRA_ESTADO` = `PEDIDA` y `MUESTRA_FECHA_ESPERADA` < hoy |
| Embarque | `ESTADO` ∈ {`PAGADO`, `EN_TRANSITO`} y `FECHA_LLEGADA_ESPERADA` < hoy |
| Etapa | Días desde `ETAPA_DESDE` > `DIAS_ALERTA_ETAPA` (§3.6), salvo `EN_VENTA` y `DESCARTADO` |

Validaciones de fechas al escribir: `FECHA_RECIBIDA` ≥ `FECHA_SOLICITUD`, `MUESTRA_FECHA_RECIBIDA` ≥
`MUESTRA_FECHA_PEDIDO`, `FECHA_LLEGADA` ≥ `FECHA_SALIDA` ≥ `FECHA_PAGO` cuando existen; ninguna fecha de «recibida» o
«llegada» en el futuro.

## 6. Validar, auditar, escribir y verificar (criterio 3)

### 6.1 Orden de cada escritura

El de ✅ `OperationsService` y 📄 v2 §5: (1) validar todo antes de escribir (cuerpo, referencias, transición, unicidad,
encabezados de la pestaña: columna obligatoria ausente o repetida → 400 `eco-esquema-invalido` y nada se escribe);
(2) idempotencia por `requestId` contra `PIPE_AUDITORIA` (repetida, roll-forward o `conflicto-idempotencia`, como en
operaciones); (3) **auditoría primero**, una fila por campo con antes y después; (4) entidad: fila nueva al final o
celdas de la fila existente, escrita solo si, releída justo antes, conserva el mismo ID y la misma `VERSION` (✅
`writeGuarded`); (5) verificación releyendo por ID; si no cuadra, 409 `verificacion-fallida`.

### 6.2 Solo las pestañas `PIPE_*`

- El almacén del pipeline recibe una **lista cerrada** de pestañas: `PIPE_PRODUCTOS`, `PIPE_PROVEEDORES`,
  `PIPE_COTIZACIONES`, `PIPE_EMBARQUES` y `PIPE_AUDITORIA`. Cualquier otro nombre lanza un error de programación antes
  de pedir token. `PIPE_PARAMETROS`, `PRODUCTS`, `AMZ_*`, `SCORING` y `UNIT_ECONOMICS` solo se leen, con la cuenta de
  lectura.
- Rangos siempre `'<PESTAÑA>'!A<n>:<col><n>` construidos por el servidor; nunca un rango que venga en la petición.
- **Defensa en la hoja** (activación, §7.2 paso 2): el propietario protege todas las pestañas que no son `PIPE_*` con
  «Solo tú puedes editar». La cuenta de escritura es Editor del libro, pero un rango protegido rechaza su escritura
  aunque el código fallara. El script de RADAROS corre como el propietario, así que la protección no lo afecta (❓
  confirmar en la activación con una corrida inerte).
- El servicio y el almacén del pipeline solo reciben `RADAROS_SHEET_ID` y la cuenta de §7; los de operaciones y
  finanzas, solo sus libros y sus cuentas (pruebas cruzadas en §10).

### 6.3 Concurrencia

Cola en proceso propia del servicio del pipeline (como la de ✅ `service.ts`), con el riesgo conocido de una sola
instancia (`maxScale: 1`, [estado actual](estado-actual.md)). La asignación de `PREFIJO-NNNN` y la escritura de la fila
nueva ocurren dentro de la misma tarea de la cola; si la verificación encuentra dos filas con el mismo ID, 409
`conflicto-concurrente` y la vista marca la fila con problema. Dos pestañas del navegador que arrastran la misma
tarjeta: la segunda recibe `conflicto-version` y la tarjeta vuelve a su sitio con la etapa real.

### 6.4 Datos personales y registros

- `CONTACTO` es un dato comercial que vive solo en la hoja del propietario. Nunca va al repositorio, a issues, a PRs, a
  los registros de Cloud Run ni a mensajes de error; las pruebas usan valores sintéticos. La auditoría lo guarda en
  `PIPE_AUDITORIA` del mismo libro.
- Los registros de la ruta llevan operación, ID, código de resultado y duración; nunca valores de campos.
- La cuenta de lectura ya es Lector de todo el libro de RADAROS al activar /eco (📄 diseño /eco §5): con esta función
  también podrá leer `PIPE_PROVEEDORES`. Quien activa (§7.2) acepta ese alcance.

## 7. Permisos, inercia y activación (criterio 3, DEC-POS-014)

### 7.1 Cuenta exclusiva e inercia

Mismo razonamiento que la opción C de 📄 v2 §6: una cuenta de servicio nueva, **solo** para el pipeline (p. ej.
`project-os-eco`), Editor solo del libro de RADAROS. Ni `project-os-writer` (que usa el PM) ni las cuentas de finanzas
ni la de lectura ganan escritura en RADAROS. Token por suplantación (alcance `spreadsheets`, 10 min, ✅
[`web/src/lib/operations/write-credentials.ts`](../web/src/lib/operations/write-credentials.ts)), solo dentro de una petición que ya pasó
el guard.

`ecoPipelineWriteMode(env)` devuelve `sheets` **solo** si se cumplen todas:

- `ECO_PIPELINE_WRITE_MODE` = `sheets` exacto (ausente o cualquier otro valor: deshabilitada);
- `RADAROS_SHEET_ID` válido según `radarosSheetId(env)` (✅ `config.ts`: con formato y distinto de PROJECT-OS; FINANZAS
  ya exige ser distinto de RADAROS en `finanzasConfig`);
- `ECO_PIPELINE_WRITE_SERVICE_ACCOUNT` con formato de cuenta de servicio y **distinta** de la de lectura
  (`SHEETS_EXPECTED_SERVICE_ACCOUNT`), de `PROJECT_OS_WRITE_SERVICE_ACCOUNT` y de las dos de finanzas; sin
  `SHEETS_EXPECTED_SERVICE_ACCOUNT` no se puede comprobar y queda deshabilitada;
- `ECO_PIPELINE_WRITER_EMAIL`, un único correo presente en `AUTH_ALLOWED_EMAILS`.

No depende de `PROJECT_OS_WRITE_MODE` ni de `FINANZAS_WRITE_MODE`. Sin eso, las rutas responden 403
`escritura-deshabilitada` **antes** de pedir un token (cero llamadas a `iamcredentials.googleapis.com` y a Sheets) y el
tablero se pinta solo como lectura. Sin modo `mock` en Cloud Run.

`render.mjs` acepta las tres variables **juntas** (modo solo `sheets` y con `RADAROS_SHEET_ID`; cuenta con formato, del
proyecto y distinta de la runtime, de `WRITE_SERVICE_ACCOUNT` y de las de finanzas; escritor un único correo); cualquier
otra combinación hace fallar el render sin imprimir valores. Sin ninguna, el YAML no cambia. `deploy.sh --desde-activa`
las conserva y `--quitar` de cualquiera retira las tres.

**R3 y R4 tras activar:** la cuenta de lectura sigue Lector; `project-os-writer` sigue Editor solo de PROJECT-OS; la
cuenta nueva es Editor solo de RADAROS, sin roles de proyecto y con `TokenCreator` solo de la cuenta de lectura. La
fila R3 de la [preparación V1.6](despliegue-v1-6-preparacion.md#5-riesgos-de-seguridad-y-costos) se actualiza en la
orden de construcción, no aquí.

### 7.2 Activación (solo el propietario, tras fusionar y desplegar P-2)

Ningún agente crea la cuenta, toca IAM, comparte la hoja, crea pestañas, pone variables ni despliega. Requisito previo:
/eco activa (`RADAROS_SHEET_ID`, 📄 diseño /eco §6).

1. **Respaldo.** En la hoja de RADAROS: Archivo → Historial de versiones → nombrar la versión «antes del pipeline».
2. **Esquema y protecciones** (§8): crear las pestañas `PIPE_*` con sus encabezados y proteger todas las demás
   pestañas con «Solo tú puedes editar».
3. **Cuenta exclusiva** sin claves ni roles de proyecto:

   ```bash
   gcloud iam service-accounts create project-os-eco --project "$PROJECT_ID" \
     --display-name "PROJECT-OS escritura del pipeline de ECO"
   ```
4. **`TokenCreator` de la cuenta de lectura sobre ella**, y nada más:

   ```bash
   gcloud iam service-accounts add-iam-policy-binding \
     "project-os-eco@${PROJECT_ID}.iam.gserviceaccount.com" --project "$PROJECT_ID" \
     --member "serviceAccount:${RUNTIME_SA}" --role roles/iam.serviceAccountTokenCreator
   ```
5. **Compartir** la hoja de RADAROS con `project-os-eco@…` como **Editor**, sin notificar. No compartir carpetas ni
   otros documentos.
6. **Variables** (no pegues sus valores en issues, PRs ni chats):

   ```bash
   export ECO_PIPELINE_WRITE_MODE=sheets
   export ECO_PIPELINE_WRITE_SERVICE_ACCOUNT="project-os-eco@${PROJECT_ID}.iam.gserviceaccount.com"
   export ECO_PIPELINE_WRITER_EMAIL='<correo del propietario>'
   web/deploy/cloudrun/deploy.sh --dry-run --desde-activa   # debe listar las tres como variables nuevas
   web/deploy/cloudrun/deploy.sh --desde-activa
   ```
7. **Verificar:** un producto de prueba (`NOMBRE` «PRUEBA»), moverlo a `EVALUANDO` y a `DESCARTADO` con motivo; en la
   hoja, tres juegos de filas en `PIPE_AUDITORIA` y la fila en `PIPE_PRODUCTOS` con `VERSION` 3. Intentar editar
   `SCORING` con la cuenta nueva no es posible (rango protegido). La cuenta nueva no tiene roles de proyecto (el mismo
   `get-iam-policy` del diseño /eco §6 sale vacío para ella). Si la prueba lleva `IDEA_ID`, comprobar a mano que esa
   idea existe en `PRODUCTS` de RADAROS: la ruta solo valida el formato (§10.1, H3).
8. **Revertir:** `deploy.sh --desde-activa --quitar ECO_PIPELINE_WRITE_MODE` (retira las tres; el tablero vuelve a solo
   lectura), quitar a `project-os-eco` del Compartir y, si se quiere, borrar el binding del paso 4. Las pestañas `PIPE_*`
   y su auditoría se quedan.
9. **Archivar `PIPE_AUDITORIA`** (solo el propietario, a mano), cuando el tablero avise del 80 % de 5000 filas o la
   escritura falle con 409 `eco-pestana-llena`. Nunca por la ruta: no hay `DELETE`.
   1. No mover tarjetas mientras tanto y nombrar una versión como en el paso 1.
   2. Copiar las filas más antiguas (dejar al menos las del último mes) a otro libro o a una pestaña
      `PIPE_AUDITORIA_ARCHIVO_AAAA`, fuera de la lista cerrada de §6.2 (la ruta nunca la lee), y borrarlas de
      `PIPE_AUDITORIA` sin tocar el encabezado.
   3. Efectos: un `requestId` archivado ya no se reconoce como repetido, y los IDs que solo consten en filas archivadas
      se podrían reutilizar si su fila de entidad se borró a mano (no borrar filas de las otras `PIPE_*`).
   Las otras `PIPE_*` no se archivan así: si una llega al aviso, se pide una orden.

## 8. Migración explícita del esquema de RADAROS (criterio 2)

Es aditiva: pestañas nuevas, ninguna columna nueva en pestañas existentes, nada se renombra ni se borra. La hace el
propietario a mano en la activación (§7.2 paso 2), con encabezados en la fila 1 exactamente como §3.1 a §3.6.

| Paso | Cambio | Reversión |
| --- | --- | --- |
| M1 | Crear `PIPE_PRODUCTOS`, `PIPE_PROVEEDORES`, `PIPE_COTIZACIONES`, `PIPE_EMBARQUES`, `PIPE_AUDITORIA` y `PIPE_PARAMETROS` | Ocultarlas (no borrar, para conservar la auditoría) |
| M2 | Validación de datos en `ETAPA`, `ESTADO`, `MONEDA`, `MUESTRA_ESTADO`, `CANAL` e `INCOTERM` con las listas de §3 (ayuda a la edición a mano; el servidor valida igual) | Quitar la validación |
| M3 | Proteger las pestañas que no son `PIPE_*` (§6.2) | Quitar la protección |
| M4 | Migración del radar de Keepa (§9) | Filas con `ORIGEN` = `RADAR_KEEPA` y su lote: descartarlas con motivo, nunca borrarlas |

Una prueba de la construcción fija los encabezados como constantes y comprueba que la vista reporta «pestaña sin
crear» (estado vacío, cero escrituras) y «columna obligatoria ausente» (400 sin escribir), como /eco §4. El motor de
RADAROS no lee `PIPE_*`: su código no cambia.

## 9. Migración de los candidatos del radar de Keepa (criterio 4)

El radar de Keepa es un artifact de claude.ai; **no lo leí** (no hay enlace en la orden ni acceso desde esta sesión).
Sus columnas exactas son ❓; la tabla de abajo es la correspondencia **propuesta**, a confirmar con el artifact en la
orden P-3.

| Del radar (❓ nombre exacto) | A `PIPE_PRODUCTOS` |
| --- | --- |
| Nombre o título del producto | `NOMBRE` (recortado a 120) |
| ASIN | `ASIN` (validado; sin ASIN válido, la fila va al informe de rechazos) |
| Precio promedio, BSR, ventas al mes, ofertas | `KEEPA_PRECIO_MXN_AVG90`, `KEEPA_BSR_AVG90`, `KEEPA_VENTAS_MES`, `KEEPA_OFERTAS` |
| Fecha de la consulta | `KEEPA_FECHA` (si falta, la fecha de exportación del artifact) |
| Costo máximo | `COSTO_MAX_MXN` |
| Criterios K1 a K6 | `K1` … `K6`; sus etiquetas, a `PIPE_PARAMETROS` |
| Estado o recomendación del radar | `NOTAS` (texto), nunca `ETAPA`: todo entra en `SUGERIDO` |

Procedimiento (nadie escribe con el conector y ningún agente escribe en la hoja):

1. **El propietario exporta** el radar a CSV desde el artifact (o lo copia como tabla) y lo guarda fuera del
   repositorio.
2. **Script local de solo transformación** `scripts/eco-migrar-radar.py` (orden P-3): lee el CSV y `PIPE_PRODUCTOS`
   exportada como CSV (para no duplicar), y genera dos TSV para pegar: filas de `PIPE_PRODUCTOS` y sus filas de
   `PIPE_AUDITORIA` (`ACTOR` = el propietario, `ORIGEN` = `migracion-radar;lote=RADAR-AAAA-MM-DD`). Además, un informe
   de rechazos (ASIN inválido o repetido, campos que no cumplen §3.1). No hace red, no lee secretos, no escribe en Sheets.
3. **Idempotencia por ASIN:** un ASIN que ya existe en `PIPE_PRODUCTOS` (en cualquier etapa) se omite y va al informe.
   Repetir la migración con el mismo CSV no genera filas nuevas. Los `PRD-NNNN` siguen al mayor existente.
4. **El propietario pega** los dos TSV al final de sus pestañas, primero la auditoría, y revisa el informe. Con la
   escritura activa, la alternativa es dar de alta uno por uno desde el tablero (mismo resultado, `ORIGEN` =
   `MANUAL`).
5. La migración no inventa datos: un campo que el radar no trae queda vacío.

Después de la migración, el radar deja de ser fuente: los productos nuevos entran desde el tablero (`MANUAL`) o, con
V1.3, desde `AMZ_CANDIDATOS` (`ORIGEN` = `AMZ_CANDIDATOS`, `ORIGEN_REF` = semana y ASIN), por una acción «Pasar al
pipeline» que es un `eco.producto.crear` más (fuera de esta Fase 1 hasta que V1.3 fije sus columnas).

## 10. Propuesta de las órdenes de construcción (MEDIO)

Para registrar como BORRADOR; no se crean desde esta orden. La activación de §7.2 es la parte ALTO, del propietario
(DEC-POS-014). Revisión completa a ciegas, delta y segundo revisor en cada una (DEC-POS-008).

### P-1 «/eco pipeline: tablero y fichas de solo lectura»

- **Criterios:** el lector de /eco pide además las pestañas `PIPE_*` que existan (sigue en 2 lecturas por carga); vista
  pura de §2 y §5.2 con búsqueda por encabezado y los estados vacíos de §8; navegación a `/eco/pipeline` solo con
  `RADAROS_SHEET_ID`; pruebas de cada estado y de las alertas de §5.2 con fechas fijas.
- **Fuera de alcance:** cualquier escritura, arrastre, variables nuevas.

### P-2 «/eco pipeline: escritura del propietario, inerte sin `ECO_PIPELINE_WRITE_MODE`»

- **Criterios:**
  1. Configuración de §7.1 con pruebas de cada condición, incluida la cuenta igual a cualquiera de las otras cuatro.
  2. Guard propio (§4.1 y §4.2): pruebas de que el token del PM, el del agente de finanzas y cualquier `Authorization`
     dan 401; `AGENT_ROUTES`, `FINANZAS_AGENT_ROUTES` y `AGENT_OPERATIONS` sin cambios (prueba).
  3. Las 9 operaciones de §4.1 con IDs de §3, `expectedVersion`, idempotencia (repetida, roll-forward, conflicto) y la
     tabla de transiciones de §5.1 completa como pruebas.
  4. Auditoría antes de la entidad y verificación después (§6.1), con pruebas de fallo en cada paso.
  5. Lista cerrada de pestañas (§6.2): prueba de que una escritura a `SCORING` o `AMZ_CORRIDAS` lanza antes de pedir
     token; pruebas cruzadas de que el servicio del pipeline no recibe los libros ni las cuentas de operaciones ni de
     finanzas, y viceversa.
  6. **Prueba de inercia:** sin cualquiera de las condiciones de §7.1, cero llamadas a los dobles de token y de `fetch`.
  7. Arrastre nativo y «Mover a…» accesible (§2.1), sin dependencias nuevas; la tarjeta vuelve a su sitio ante un 409.
  8. `render.mjs` y `deploy.sh --desde-activa` aceptan, validan y conservan las tres variables; sin ellas el YAML no
     cambia (prueba).
  9. Docs: R3 en la preparación V1.6, una sección «Construcción» en este diseño y la excepción nueva en
     [`.claude/rules/web.md`](../.claude/rules/web.md), que hoy prohíbe otras vías de escritura fuera de operaciones y finanzas.
- **Fuera de alcance:** crear la cuenta, IAM, compartir la hoja, crear pestañas, poner variables, desplegar, borrar
  filas, tocar RADAROS, SP-API, `.github/workflows`.

### P-3 «Migración del radar de Keepa a `PIPE_PRODUCTOS`»

- **Criterios:** confirmar con el artifact la tabla de §9 y fijarla en el script; `scripts/eco-migrar-radar.py` con
  pruebas en `tests/` (CSV sintético: alta, ASIN repetido, ASIN inválido, segunda corrida sin filas nuevas, sin red);
  instrucciones del paso 4 de §9 en este documento.
- **Fuera de alcance:** pegar en la hoja (lo hace el propietario), datos reales en el repositorio.

**Cómo probar (las tres):** `npm test`, `npm run lint`, `npm run typecheck` y `npm run check:client-secrets` en `web/`;
`python -m unittest discover -s tests`.

## 10.1 Construcción (ORD-POS-102, P-2)

Construida en ORD-POS-102 ([issue #236](https://github.com/jlpulido107-bit/PROJECT-OS/issues/236)), **inerte**: sin
las tres variables de §7.1 las rutas responden 403 sin pedir token y el tablero se pinta como en P-1. Ningún agente
creó la cuenta, tocó IAM, compartió la hoja, creó pestañas ni puso variables; la activación de §7.2 sigue siendo del
propietario (DEC-POS-014). Código en `web/src/lib/radaros/` y `web/src/app/api/eco/pipeline/`:

| Pieza | Archivo | Qué hace |
| --- | --- | --- |
| Configuración (§7.1) | `pipeline-escritura-config.ts` | `ecoPipelineWriteStatus`: modo `sheets` exacto, `RADAROS_SHEET_ID` válido, cuenta propia distinta de la de lectura, de la de PROJECT-OS y de las dos de finanzas, escritor único dentro de `AUTH_ALLOWED_EMAILS` |
| Guard (§4.1–§4.2) | `pipeline-escritura-guard.ts` | `evaluateEcoWriteRequest`, sin rama de agente; limitador `eco` de 10 y 1 cada 3 s |
| Núcleo de la ruta | `pipeline-escritura-handler.ts` | 401 con `Authorization` antes de sesión y cuerpo; servicio solo tras el guard |
| Validación (§3, §4.3) | `pipeline-escritura-validacion.ts` | Lista cerrada de campos por operación (camelCase, uno por columna); 400 `campo-no-permitido` |
| Servicio (§5, §6) | `pipeline-escritura-service.ts` | Las 9 operaciones, IDs `PREFIJO-NNNN`, transiciones, auditoría en `PIPE_AUDITORIA`, verificación |
| Almacén (§6.2) | `pipeline-escritura-store.ts` | Lista cerrada de las cinco pestañas `PIPE_*` que se escriben; solo `RAW` |
| Runtime | `pipeline-escritura-runtime.ts`, `pipeline-escritura-http.ts` | Único lugar que construye el almacén, con `RADAROS_SHEET_ID` y `ECO_PIPELINE_WRITE_SERVICE_ACCOUNT` |
| Tablero (§2.1) | `web/src/components/eco/tablero-escritura.tsx`, `pipeline-transiciones.ts` | Arrastre nativo y «Mover a…» con las etapas de §5.1; motivo en un `<dialog>` |
| Despliegue (§7.1) | `web/deploy/cloudrun/render.mjs`, `deploy.sh` | Las tres variables juntas; `--desde-activa` las conserva y `--quitar` de una retira las tres |

Decisiones de la construcción (las que el diseño dejaba abiertas o no fijaba):

- **Edición celda por celda.** Un `PATCH` o un `mover` escribe solo las columnas que cambian, más `ACTUALIZADO` y
  `VERSION`, con rangos `'<PESTAÑA>'!X<n>:X<n>` en un `values:batchUpdate` RAW: no pisa fórmulas ni columnas que el
  propietario añada al final. Antes de auditar, la pestaña se relee y la fila se ubica por ID; solo se escribe si
  conserva la `VERSION`; tras auditar se relee de nuevo y se escribe en la fila con ese ID y esa `VERSION` (ORD-POS-104 y 109).
- **Fórmulas (❓ §12).** Antes de auditar, la fila ubicada en esa relectura se lee con `valueRenderOption=FORMULA`; si alguna celda que cambia
  es fórmula (por ejemplo `COSTO_MAX_MXN` o `COSTO_ATERRIZADO_MXN`), 409 `campo-solo-lectura` y nada se escribe. Así
  la ruta las rechaza sin fijar ahora cuáles son fórmulas.
- **Auditoría.** `ENTIDAD` = nombre de la pestaña; `ORIGEN` = `dashboard-eco;modo=sheets;req=<requestId>;hash=<hash>`
  (el hash incluye la operación y el ID de la ruta); `AUDIT_ID` con lote e índice, como finanzas, para detectar una
  auditoría a medias. El motivo de un movimiento que no es descarte va en una fila `CAMPO` = `MOTIVO`.
- **Idempotencia.** Mismo `requestId` y mismo hash: repetida si la fila ya tiene lo auditado; roll-forward si la fila
  sigue como antes (alta sin fila, o edición con la `VERSION` anterior); `estado-divergente` si no; otro hash:
  `conflicto-idempotencia`.
- **Estados de cotización y embarque.** `SOLICITADA` → `RECIBIDA` → `ELEGIDA`, `RECHAZADA` desde las tres; `PLANEADO`
  → `PAGADO` → `EN_TRANSITO` → `RECIBIDO_FBA`, `CANCELADO` antes de recibir. `RECIBIDA` y `ELEGIDA` exigen los cinco
  datos de §3.3.
- **`IDEA_ID`.** Solo se valida el formato (`EC-004`): el servicio no lee pestañas fuera de `PIPE_*` y la columna de
  `PRODUCTS` es ❓. Queda como atajo anotado en el código hasta la activación.
- **`CONTACTO`** acepta un `+` inicial (teléfono): se escribe tal cual en RAW, sin apóstrofo; `=`, `-` y `@`
  iniciales siguen rechazados. Las `NOTAS` del proveedor se ocultan a quien no escribe, como `CONTACTO` (H1 de la revisión de P-1).
- **Caché.** Tras una escritura correcta sube una generación en el proceso y el lector de /eco descarta su caché: la
  tarjeta aparece en su nueva columna al refrescar.
- **Alta y edición desde la pantalla.** Esta orden pinta solo el arrastre y «Mover a…» (criterio 7); las rutas de alta
  y edición existen y están probadas, y sus formularios quedan para otra orden.

Hallazgos no bloqueantes de los dictámenes del PR #239, corregidos en ORD-POS-104
([issue #241](https://github.com/jlpulido107-bit/PROJECT-OS/issues/241)), también inerte:

| Hallazgo | Cómo quedó |
| --- | --- |
| PRIMERO H1 (MEDIA): montos con 2 decimales | `PRECIO_UNIT`, `COSTO_ATERRIZADO_MXN`, `MUESTRA_COSTO` y `COSTO_TOTAL` admiten hasta 4 (0.125); los demás números siguen con 2 |
| PRIMERO H2 (MEDIA): más de 5000 filas | Al 80 % la respuesta ok trae `aviso` y el tablero lo muestra; al 100 %, 409 `eco-pestana-llena` con la pestaña; archivado manual en §7.2 paso 9 |
| PRIMERO H3 (BAJA): `IDEA_ID` solo valida el formato | Límite aceptado: la lista cerrada de §6.2 no cambia; comprobación manual en §7.2 paso 7 |
| PRIMERO H4 (BAJA): apóstrofo visible en `CONTACTO` | Sin apóstrofo: RAW basta |
| SEGUNDO H1 (BAJA): fórmulas en la fila de la lectura inicial | Las fórmulas se leen en la fila ubicada por ID en la misma relectura que usa la escritura |

Hallazgos no bloqueantes de los dictámenes del PR #243 (head `9a9f5ab`), corregidos en ORD-POS-109
([issue #253](https://github.com/jlpulido107-bit/PROJECT-OS/issues/253)), también inerte:

| Hallazgo | Cómo quedó |
| --- | --- |
| PRIMERO H1 (MEDIA): la fila se ubica antes de auditar y `aplicar()` escribe sin releer | `aplicar()` relee y ubica la fila por ID y `VERSION` después de la auditoría: si se movió, escribe en su nueva posición; si cambió, 409 `conflicto-concurrente` sin escribir. Límite aceptado: la ventana entre esa relectura y el update (Sheets no tiene escritura condicional) la cubre la verificación |
| PRIMERO H2 (BAJA): reintento en el tope de filas con 409 | El tope se mira después de la idempotencia: un reintento ya aplicado responde «repetida» aun con la pestaña en 5000 filas; un alta o edición nueva sigue con 409 `eco-pestana-llena`, y un roll-forward de alta, si su pestaña está en el tope |
| SEGUNDO H1 (BAJA): `escritura-fallida` sin auditoría | La relectura previa a la auditoría falla con 503 `lectura-fallida` («no se escribió nada»); la de `aplicar()`, ya auditada, conserva `escritura-fallida` |

## 11. Fase 2 (bosquejo; depende de SP-API)

No se construye con estas órdenes. Necesita que RADAROS lea ventas reales con SP-API (Orders, Finances o Reports;
alcance a fijar en un diseño V1.x de RADAROS, carril ALTO) y las deje en pestañas `AMZ_*` nuevas que escribe **el motor
de RADAROS**, no el dashboard. El dashboard solo las lee.

| Vista | Fuente propuesta | Cálculo |
| --- | --- | --- |
| Ingresos contra meta | `AMZ_VENTAS` (❓, por día y ASIN) y `META_INGRESOS_MES` de `PIPE_PARAMETROS` | Suma del mes contra la meta; fórmula de la hoja o pura en la vista, a decidir en su diseño |
| Margen real | `AMZ_VENTAS`, comisiones y FBA reales (`AMZ_LIQUIDACIONES` ❓) y `COSTO_TOTAL` de `PIPE_EMBARQUES` entre unidades | Ingreso − comisiones − FBA − costo aterrizado, por producto `EN_VENTA` |
| Capital contra $30,000 | `PIPE_EMBARQUES` (`COSTO_TOTAL` pagado) + muestras − lo recuperado en ventas; `CAPITAL_TOPE` = 30,000 (❓ moneda: MXN o USD) | Capital comprometido y disponible; aviso al acercarse al tope |
| Ranking de productos | Margen real y unidades por producto | Orden por margen total del periodo; no sustituye al SCORING de ideas |
| Comisiones | Liquidaciones de SP-API | Comisión y FBA reales contra las estimadas de `UNIT_ECONOMICS` |
| Canales | `CANAL_VENTA` (Amazon MX primero; Mercado Libre después, ❓) | Ingresos y margen por canal |

Dependencias abiertas: alcance de SP-API para ventas y liquidaciones, la moneda del tope de capital, y si el capital de
ECO se cruza con FINANZAS (hoy no: camino b deja FINANZAS fuera; cruzarlos sería otra decisión).

## 12. Preguntas abiertas

- ❓ Columnas y significado de K1–K6 del radar de Keepa, y formato de exportación del artifact (§9, P-3).
- ❓ Si `COSTO_MAX_MXN` y `COSTO_ATERRIZADO_MXN` los captura el propietario o son fórmulas de la hoja (si son fórmulas,
  esas columnas pasan a solo lectura en el dashboard y la ruta las rechaza).
- ❓ Lista final de `CANAL` de proveedores y si hace falta más de una muestra por cotización.
- ❓ Que la protección de pestañas (§6.2) no estorbe al activador de RADAROS (corrida inerte en la activación).
- ❓ Moneda del tope de $30,000 (§11).

## 13. Datos que nunca van al repositorio

- Sin IDs de libros, correos, tokens ni nombres de cuentas reales con su proyecto: viven en Cloud Run y en la hoja.
- Sin proveedores, contactos, precios ni ASIN reales: los ejemplos y las pruebas son sintéticos.
- El CSV del radar y los TSV de la migración se guardan fuera del repositorio; `.gitignore` no basta como control, así
  que el script escribe su salida fuera del árbol del repositorio por defecto (P-3).
