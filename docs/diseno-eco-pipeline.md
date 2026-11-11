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
| Costo máximo | `COSTO_MAX_MXN` | El propietario, o una fórmula de la hoja (❓ §12); el dashboard lo calcula aparte en «Comparar» (§14.4) sin tocar esta columna |
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
| `PRECIO_UNIT`, `MONEDA` (`USD`, `CNY`, `MXN`), `MOQ` (entero > 0), `PLAZO_PRODUCCION_DIAS`, `INCOTERM` (`EXW`, `FOB`, `CIF`, `DDP`, `OTRO`) | Obligatorios para pasar a `RECIBIDA`. Desde ORD-POS-149 (§16.3), la edición a `RECIBIDA` pide todos menos el plazo, que se exige al pasar a `ELEGIDA`; el alta con `RECIBIDA` sigue pidiendo los cinco |
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
| `POST /api/eco/pipeline/cotizaciones/pedir` (ORD-POS-149, §16.2) | `eco.cotizacion.pedir` |
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
| Servicio (§5, §6) | `pipeline-escritura-service.ts` | Las 9 operaciones (10 desde ORD-POS-149, con `eco.cotizacion.pedir`), IDs `PREFIJO-NNNN`, transiciones, auditoría en `PIPE_AUDITORIA`, verificación |
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
- **Alta y edición desde la pantalla.** ORD-POS-102 pintó solo el arrastre y «Mover a…» (criterio 7). Los formularios
  quedaron construidos en ORD-POS-110 ([issue #255](https://github.com/jlpulido107-bit/PROJECT-OS/issues/255)), solo UI
  sobre las 8 rutas de §4.1, sin cambiar el servidor (`web/src/components/eco/formularios-pipeline.tsx`,
  `web/src/lib/radaros/pipeline-formularios.ts`): alta de producto y proveedor en el tablero y en Proveedores; edición
  del producto, alta de cotización y embarque y edición de cada una en la ficha de producto; edición del proveedor en
  su ficha. Los campos salen de la lista cerrada `CAMPOS` de la validación; cada envío lleva un `requestId` nuevo, la
  edición manda solo las columnas que cambiaron y `expectedVersion`, y un 409 se muestra con la versión actual sin
  reintentar. Nada se da por guardado antes del ok; tras él la vista se relee de la hoja. Solo los ve
  `ecoPipelineCanWrite`.

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
  esas columnas pasan a solo lectura en el dashboard y la ruta las rechaza). Desde ORD-POS-145 el dashboard calcula
  ambos aparte, sin tocar esas columnas (§14).
- ❓ Lista final de `CANAL` de proveedores y si hace falta más de una muestra por cotización.
- ❓ Que la protección de pestañas (§6.2) no estorbe al activador de RADAROS (corrida inerte en la activación).
- ❓ Moneda del tope de $30,000 (§11). ORD-POS-145 lo usa en MXN para el capital del primer lote (§14.5).

## 13. Datos que nunca van al repositorio

- Sin IDs de libros, correos, tokens ni nombres de cuentas reales con su proyecto: viven en Cloud Run y en la hoja.
- Sin proveedores, contactos, precios ni ASIN reales: los ejemplos y las pruebas son sintéticos.
- El CSV del radar y los TSV de la migración se guardan fuera del repositorio; `.gitignore` no basta como control, así
  que el script escribe su salida fuera del árbol del repositorio por defecto (P-3).

## 14. Tabulador de cotizaciones (ORD-POS-145, DEC-ECO-008)

Orden ORD-POS-145 (tarea POS-048, espejo de ECO-019; paquetes PAQ-2026-11-04-03 y PAQ-2026-11-04-05), riesgo MEDIO.
Fuente de las fórmulas: DEC-ECO-008 (DECISIONES, **PENDIENTE** al escribir esto) y las respuestas del propietario del
2026-11-04, publicadas por el PM en el [issue #323](https://github.com/jlpulido107-bit/PROJECT-OS/issues/323#issuecomment-6644077749).
Código: [`web/src/lib/radaros/pipeline-tabulador.ts`](../web/src/lib/radaros/pipeline-tabulador.ts) (funciones puras) y la
sección «Comparar cotizaciones» de `/eco/pipeline`. **Solo lectura:** no escribe en ninguna pestaña, no crea vías de
escritura y no cambia la escritura del pipeline (§6), SCORING ni el kill flag. Las columnas manuales `COSTO_ATERRIZADO_MXN`
(cotización) y `COSTO_MAX_MXN` (producto) no se tocan; el cálculo se muestra junto a ellas.

### 14.1 Migración explícita de `PIPE_COTIZACIONES`

La aplica **solo el propietario, a mano en la hoja de RADAROS**, después de fusionar y desplegar. Ningún agente la aplica.
Antes de aplicarla todo sigue igual: la lectura no exige las columnas nuevas, la escritura del pipeline (§6) solo valida
las 23 de §3.3 y escribe por celda, y «Comparar» dice «Migración pendiente» y deja «Por confirmar» lo que falte.

1. En la fila 1 de `PIPE_COTIZACIONES`, después de `VERSION` (columna W), escribir en este orden, exactos y sin repetir:
   `PAIS_ORIGEN`, `CERTIFICADO_ORIGEN`, `UNIDADES_POR_SET`, `CANTIDAD_COTIZADA`, `TIPO_CAMBIO`, `TIPO_CAMBIO_FECHA`,
   `FLETE_LOCAL_EXPORT`, `FLETE_INTERNACIONAL`, `SEGURO`, `IGI_PCT`, `DTA`, `AGENTE_ADUANAL`, `FLETE_CEDIS` y
   `COSTO_ATERRIZADO_CALC_MXN` (columnas X a AK; el lector llega a AZ). Desde ORD-POS-147 (§14.7), además `PRECIO_POR`
   al final (columna AL).
2. `VERSION` queda donde está y no cambia en ninguna fila: agregar columnas no es editar filas.
3. Idempotente: si alguna ya existe, se agregan solo las que faltan, al final (`migracionCotizaciones`, probada).
4. Comprobar: `/eco/pipeline` → «Comparar cotizaciones» sin el aviso «Migración pendiente».
5. Revertir: borrar esas columnas completas. Nada más depende de ellas.

Unidades de cada celda (por embarque cotizado, `CANTIDAD_COTIZADA` unidades):

| Columna | Contenido |
| --- | --- |
| `PAIS_ORIGEN` | Código de 2 letras; decide `IGI_PCT_<país>` (CN, US, VN, CO; cualquier otro → OTRO) |
| `CERTIFICADO_ORIGEN` | `SI` o `NO` (T-MEC o CPTPP). `SI` → IGI 0 %. Vacío → se supone `NO` y se marca SUPUESTO |
| `UNIDADES_POR_SET` | Piezas por set, la unidad de venta. Solo se usa si el precio es por pieza |
| `CANTIDAD_COTIZADA` | Cantidad del embarque cotizado (el lote), en la unidad de `PRECIO_POR` |
| `TIPO_CAMBIO`, `TIPO_CAMBIO_FECHA` | MXN por USD y su fecha; solo con `MONEDA` = USD |
| `FLETE_LOCAL_EXPORT`, `FLETE_INTERNACIONAL`, `SEGURO` | Montos del embarque en la `MONEDA` de la cotización |
| `IGI_PCT`, `DTA` | Porcentajes en puntos (20 = 20 %) sobre el valor en aduana |
| `AGENTE_ADUANAL`, `FLETE_CEDIS` | MXN por embarque. `FLETE_CEDIS` = 0 en DDP: ya incluido |
| `COSTO_ATERRIZADO_CALC_MXN` | Costo aterrizado **por set** en MXN. El dashboard no lo escribe; si tiene valor y difiere del cálculo en más de 1 MXN, «Comparar» lo señala |
| `PRECIO_POR` | `PIEZA` o `SET` (ORD-POS-147): unidad de `PRECIO_UNIT`, `CANTIDAD_COTIZADA` y `MOQ`. Vacía → por pieza y SUPUESTO |

### 14.2 Claves de `PIPE_PARAMETROS`

Las da de alta el propietario (columnas `CLAVE` y `VALOR`). Porcentajes en puntos, con o sin «%» (`0.8` = 0.8 %).

| Clave | Uso |
| --- | --- |
| `TIPO_CAMBIO_USD_MXN`, `TIPO_CAMBIO_USD_MXN_FECHA` | Tipo de cambio si la cotización no trae el suyo |
| `IGI_PCT_CN`, `IGI_PCT_US`, `IGI_PCT_VN`, `IGI_PCT_CO`, `IGI_PCT_OTRO` | IGI por país de origen |
| `DTA_PCT` | DTA, porcentaje del valor en aduana (referencia 0.8 % ❓, la verifica el propietario con su agente aduanal) |
| `AGENTE_ADUANAL_REF`, `FLETE_CEDIS_REF` | MXN por embarque |
| `MARGEN_K2_PCT`, `PPC_PCT`, `DEVOLUCIONES_PCT` | 25, 15 y 8; sin la clave se usan esos valores de la orden |

Si la cotización deja vacío un componente que tiene parámetro, se usa el parámetro y se marca **SUPUESTO**. Si tampoco
hay parámetro (o el componente no tiene: precio, cantidad, fletes y seguro), el componente y el total quedan
**«Por confirmar»**: un faltante nunca vale 0. Un valor que no es número (por ejemplo «1,000.50» con separador de miles)
se trata como vacío y se avisa.

### 14.3 Costo aterrizado (normalizado a DDP en el CEDIS de Amazon MX)

Mercancía = `PRECIO_UNIT` × `CANTIDAD_COTIZADA` × tipo de cambio (1 en MXN; solo MXN y USD). Valor en aduana = mercancía +
los fletes y el seguro que el incoterm no incluye. IGI y DTA = porcentaje × valor en aduana.

| Incoterm | Se suma a la mercancía |
| --- | --- |
| EXW | flete local y despacho de exportación + flete internacional + seguro + IGI + DTA + agente aduanal + flete al CEDIS |
| FOB (y FCA) | flete internacional + seguro + IGI + DTA + agente aduanal + flete al CEDIS |
| CIF (y DAP) | IGI + DTA + agente aduanal + flete al CEDIS |
| DDP | flete al CEDIS, solo si no lo incluye |

Otro valor de `INCOTERM` (incluido `OTRO`) deja la cotización «Por confirmar». Costo por set: con `PRECIO_POR` = `SET`,
total ÷ `CANTIDAD_COTIZADA`; con `PIEZA`, total ÷ (`CANTIDAD_COTIZADA` ÷ `UNIDADES_POR_SET`) (§14.7). El IVA de
importación no entra: va aparte, como flujo de efectivo.

### 14.4 `COSTO_MAX_MXN` por producto

COSTO_MAX_MXN = precio − comisión − FBA − 0.15 × precio − 0.08 × precio − 0.25 × precio (todos sobre el mismo precio).
El producto se liga a su idea por `IDEA_ID`. Precio: `AMZ_PRECIO_MXN` de UNIT_ECONOMICS; si está vacío, `PRECIO_MXN` de la
última semana `OK` de AMZ_RESUMEN. Comisión (`*_COMISION_MXN`, o `*_COMISION_PCT` × precio) y FBA (`*_FBA_MXN`): primero
UNIT_ECONOMICS y después AMZ_RESUMEN. «Fecha de sus datos»: `TARIFAS_FECHA` (o la semana) de AMZ_RESUMEN si el precio sale
de ahí; si sale de UNIT_ECONOMICS, su `AMZ_TARIFAS_FECHA` o «sin fecha». Sin precio, comisión o FBA: «Por confirmar».
Referencias de DEC-ECO-008 por verificar: EC-006 unos 65 MXN, EC-015 unos 96 MXN.

### 14.5 Vista «Comparar cotizaciones»

`/eco/pipeline?comparar=<PRODUCTO_ID>#comparar`. Para el producto: COSTO_MAX_MXN calculado con su fecha, sus insumos y
el valor manual de la hoja. Cotizaciones ordenadas por costo aterrizado por set (menor primero; «Por confirmar» y
`DESCARTADA` al final) con ESTADO, PROVEEDOR, PAÍS, INCOTERM, precio por, MOQ y cantidad cotizada (con su unidad), plazo,
«Cumple» o «No cumple por X MXN», el capital del primer lote contra el tope de 30,000 MXN, el mínimo del proveedor y los sets
que caben en el tope (§14.7). Cada cotización tiene su desglose plegable.
Estados válidos: desde ORD-POS-146 (§15.4), la misma lista de §3.3, `SOLICITADA`, `RECIBIDA`, `ELEGIDA` y `RECHAZADA`;
`RECHAZADA` va al final con «Por confirmar». Cualquier otro (incluidos los antiguos `RECIBIDA (PARCIAL)` y `DESCARTADA`)
se muestra con «Estado no válido» y no se oculta ni se reescribe.

### 14.6 Bandera `ECO_TABULADOR`

Apagada por defecto: sin `ECO_TABULADOR=true` exacto, `/eco/pipeline` no muestra «Comparar» ni el desglose, aunque llegue
`?comparar=`. La pone **solo el propietario** con `deploy.sh`; ningún agente la enciende. No depende de `WRITE_MODE` ni de
la escritura del pipeline.

```bash
export ECO_TABULADOR=true
web/deploy/cloudrun/deploy.sh --desde-activa --dry-run   # debe listar «+ ECO_TABULADOR»
web/deploy/cloudrun/deploy.sh --desde-activa
# Apagar:
web/deploy/cloudrun/deploy.sh --desde-activa --quitar ECO_TABULADOR
```

Límites conocidos: el «mínimo del proveedor» (§14.7) escala el costo por unidad del lote cotizado al MOQ, aunque los fletes
no son lineales; el capital del primer lote ya no (usa la cantidad cotizada). Desde ORD-POS-146 (§15) la escritura acepta FCA y DAP y el alta de cotización captura las columnas de
§14.1 (salvo `COSTO_ATERRIZADO_CALC_MXN`, que el dashboard nunca escribe).

**Corrección (ORD-POS-146).** En «Fuera de alcance», la orden ORD-POS-145 decía «escribir cotizaciones (sigue siendo del
PM con «sí»)». Ese texto no es correcto: en las pestañas `PIPE_*` solo escribe el propietario con su sesión del dashboard
(§1 y §4.1); el PM, las sesiones de Claude y las rutinas nunca escriben cotizaciones, ni con «sí».

### 14.7 Precio por pieza o por set, DDP con entrega y capital del primer lote (ORD-POS-147)

Orden ORD-POS-147 ([issue #329](https://github.com/jlpulido107-bit/PROJECT-OS/issues/329), tarea POS-050, paquete
PAQ-2026-11-05-06), riesgo MEDIO. Corrige tres fallas que salieron al cargar cotizaciones reales; mientras no esté
desplegada y migrada, sigue valiendo el arreglo manual del propietario (`UNIDADES_POR_SET` = 1 y `FLETE_CEDIS` = 0).

1. **Pieza o set.** El alta de cotización pide, obligatorio, «El precio es por» (`PRECIO_POR`: `PIEZA` o `SET`).
   `PRECIO_UNIT`, `CANTIDAD_COTIZADA` y `MOQ` se leen en esa unidad. Con `SET`, sets = `CANTIDAD_COTIZADA` y el costo por
   set = total ÷ sets, sin `UNIDADES_POR_SET` (ejemplo: 12.76 USD × 500 sets → 12.76 × TC por set en DDP con entrega
   incluida). Con `PIEZA`, como antes: sets = `CANTIDAD_COTIZADA` ÷ `UNIDADES_POR_SET`. Una fila sin `PRECIO_POR` (las
   anteriores a la orden) se lee por pieza y se marca **SUPUESTO**; nunca se reescribe. Otro valor → «Por confirmar».
2. **DDP con entrega.** La casilla «Incluye entrega en CEDIS Amazon» (alta y pegado) guarda `FLETE_CEDIS` = 0; no es
   columna y no se envía. Sin la casilla, en DDP se pide el monto, salvo que haya `FLETE_CEDIS_REF` en `PIPE_PARAMETROS`
   (el tabulador lo usa como SUPUESTO). La casilla fuera de DDP, o con un flete distinto de 0, es un error en pantalla.
   Regla: `reglaEntregaCedis` (`pipeline-formularios.ts`).
3. **Capital del primer lote** = `CANTIDAD_COTIZADA` × costo aterrizado por unidad del precio (el total del lote cotizado),
   contra `TOPE_CAPITAL_MXN` (30,000, sin cambio). Sin cantidad: «Por confirmar»; nunca usa el MOQ en su lugar. Junto a
   él: **mínimo del proveedor** = `MOQ` × ese costo, y **sets que caben en el tope** = ⌊30,000 ÷ costo por set⌋. Ejemplo:
   500 sets × ~197 MXN ≈ 98,500 MXN → «Excede»; el MOQ de 10 sets da un mínimo de ~1,970 MXN.
4. **Unidades.** En el formulario, las etiquetas de `MOQ` y `CANTIDAD_COTIZADA` dicen «(sets)» o «(piezas)» según lo
   elegido; en «Comparar», «10 sets», «500 sets».
5. **Filas existentes.** El criterio opcional de convertirlas desde la pantalla no se implementó: el propietario escribe
   `PRECIO_POR` a mano en las filas que quiera (por ejemplo COT-0004 a COT-0006, y entonces deshace su arreglo manual).

**Migración explícita (solo el propietario, a mano en la hoja de RADAROS, después de fusionar y desplegar).** En la fila 1
de `PIPE_COTIZACIONES`, escribir `PRECIO_POR` después de la última columna de §14.1 (`COSTO_ATERRIZADO_CALC_MXN`). `VERSION`
no cambia en ninguna fila. **Hasta aplicarla, el alta de cotización responde 409 `eco-migracion-pendiente`** («aún no tiene
PRECIO_POR») y no escribe nada, porque el campo es obligatorio; la lectura y «Comparar» siguen funcionando (por pieza,
SUPUESTO). Comprobar: «Comparar» sin «Migración pendiente». Revertir: borrar la columna completa.

**Pegado.** La tabla B del Gem 3 no trae `PRECIO_POR`: cada borrador lo pide antes de poder confirmarse. Si la tabla trae
columnas `PRECIO_POR` («pieza», «pcs», «set», «juego»…), `CANTIDAD_COTIZADA`, `FLETE_CEDIS` o `INCLUYE_ENTREGA_CEDIS`
(«SI», «sí», «x»), se usan.

## 15. Alta rápida de proveedores y cotizaciones (ORD-POS-146, POS-050)

Orden ORD-POS-146 ([issue #327](https://github.com/jlpulido107-bit/PROJECT-OS/issues/327); paquete PAQ-2026-11-05-05),
riesgo MEDIO. Sección «Alta rápida» de `/eco/pipeline` (`#alta-rapida`), visible solo con `ecoPipelineCanWrite(email)`:
alta de proveedor, alta de cotización con las columnas del tabulador y «Pegar tabla de Gemini». Reúsa `FormularioEco`, las
rutas de alta de §4.1 y su guard; no crea rutas, operaciones ni vías de escritura, y sigue inerte sin
`ECO_PIPELINE_WRITE_MODE` (§7.1). Código: `pipeline-escritura-validacion.ts` (campos), `pipeline-escritura-service.ts`
(duplicados, migración, estado inicial), `pipeline-formularios.ts` (revisión en pantalla), `pipeline-pegado.ts` (pegado),
`pipeline-tabulador.ts` (`pistasCotizacion`) y `web/src/components/eco/pegar-gemini.tsx`.

**Solo escribe la sesión del propietario** (§1, §4.1 y §4.2): con el token del PM, el del agente de finanzas o cualquier
`Authorization`, las rutas responden 401 antes de leer la sesión, el cuerpo o pedir el servicio. Ni el PM ni otra sesión
de Claude escriben cotizaciones (ver la corrección al final de §14.6).

### 15.1 Proveedores y migración explícita de `PIPE_PROVEEDORES`

Formulario de alta: `NOMBRE`, `CANAL`, `PAIS`, `ANOS_PLATAFORMA` (años en la plataforma, entero ≥ 0), `VERIFIED_SUPPLIER`
y `TRADE_ASSURANCE` (`SI` o `NO`) y `NOTAS`. El alta ya no pide `CONTACTO`; el contacto comercial (§6.4) se sigue
capturando al editar. En `NOMBRE` y `NOTAS` se rechaza un correo o un teléfono (10 dígitos o más): 400 «Sin correos ni
teléfonos de personas», en la pantalla y en el servidor.

**Sin duplicados por nombre.** Antes de enviar, la pantalla compara el nombre con los proveedores leídos y avisa «Ya existe
PRV-NNNN»; el servidor repite la comparación con la hoja recién leída (409 `proveedor-duplicado`, con el ID, sin escribir).
Se compara sin acentos, mayúsculas, signos ni espacios: «Fábrica Uno, S.A.» = «fabrica uno sa». Renombrar al editar a un
nombre que ya existe también es 409.

Migración, **solo el propietario, a mano en la hoja de RADAROS**, después de fusionar y desplegar:

1. En la fila 1 de `PIPE_PROVEEDORES`, después de `VERSION` (columna J), escribir en este orden, exactos y sin repetir:
   `ANOS_PLATAFORMA`, `VERIFIED_SUPPLIER` y `TRADE_ASSURANCE` (columnas K a M).
2. `VERSION` no cambia en ninguna fila: agregar columnas no es editar filas.
3. Antes de aplicarla todo sigue igual: el alta sin esos tres campos funciona y llenarlos responde 409
   `eco-migracion-pendiente` con la pestaña y las columnas, sin auditoría ni fila (igual con las columnas de §14.1 en
   `PIPE_COTIZACIONES`). La escritura nunca crea columnas.
4. Revertir: borrar esas columnas completas.

### 15.2 Cotizaciones con las columnas del tabulador

El alta de cotización incluye todas las columnas de §14.1 salvo `COSTO_ATERRIZADO_CALC_MXN` (`PAIS_ORIGEN`,
`CERTIFICADO_ORIGEN`, `UNIDADES_POR_SET`, `CANTIDAD_COTIZADA`, `TIPO_CAMBIO`, `TIPO_CAMBIO_FECHA`, `FLETE_LOCAL_EXPORT`,
`FLETE_INTERNACIONAL`, `SEGURO`, `IGI_PCT`, `DTA`, `AGENTE_ADUANAL`, `FLETE_CEDIS`), más `INCOTERM` y la muestra.
`INCOTERM` acepta EXW, FCA, FOB, CIF, DAP, DDP y OTRO; `IGI_PCT` y `DTA` son puntos de 0 a 100. Desde ORD-POS-147
(§14.7), también «El precio es por» (`PRECIO_POR`, obligatorio) y la casilla «Incluye entrega en CEDIS Amazon».

- **Pistas.** Debajo de cada campo del tabulador se lee qué tomará si queda vacío, con el valor tal como está en
  `PIPE_PARAMETROS` (§14.2): `TIPO_CAMBIO_USD_MXN` con su fecha, `IGI_PCT_<país>` de cada país, `DTA_PCT`,
  `AGENTE_ADUANAL_REF` y `FLETE_CEDIS_REF`; «se supone NO» en `CERTIFICADO_ORIGEN`; «Por confirmar» si no hay clave o el
  componente no tiene parámetro (cantidad, unidades por set, fletes y seguro). Se muestran aunque `ECO_TABULADOR` esté
  apagada: solo leen texto, no calculan.
- **Estado inicial.** El alta acepta `ESTADO` `SOLICITADA` (por defecto), `RECIBIDA` (con `FECHA_RECIBIDA` y los cinco
  datos de §3.3, si no 409 `requisito-faltante`) o `RECHAZADA`. `ELEGIDA` sigue siendo solo por edición.
- La edición de cotizaciones existentes no cambia (fuera de alcance). **Cambió con ORD-POS-149 (§16.3):** la edición
  suma `PRECIO_POR`, las columnas de §14.1 y `EVIDENCIA_URL`, porque «Recibir» edita la misma fila.

### 15.3 «Pegar tabla de Gemini»

Recibe la tabla B del Gem 3 («Módulo 3 · Compras», tarea B, en `POS/referencia/gemini-gems.md` de NOTAS), en Markdown o
copiada de una hoja (tabuladores), con estas columnas: `COTIZACION_ID | PRD / EC | PROVEEDOR (empresa) | ESTADO |
FECHA_RECIBIDA | PRECIO_UNIT | MONEDA | MOQ | PLAZO_PRODUCCION_DIAS | INCOTERM | PAIS_ORIGEN | CERTIFICADO_ORIGEN |
UNIDADES_POR_SET | FLETE_INTERNACIONAL | IGI_PCT | COSTO_ATERRIZADO_MXN | MUESTRA_COSTO | MUESTRA_MONEDA | NOTAS`.

1. «Generar borradores» interpreta el texto **en el navegador** y no envía nada. Un borrador por fila, con los campos del
   alta de cotización ya llenos y editables.
2. `PRD / EC`: el `PRD-NNNN`; si solo trae la idea (`EC-006`), el único producto no descartado con ese `IDEA_ID`.
   `PROVEEDOR (empresa)`: por nombre (misma comparación de §15.1) o un `PRV-NNNN`; si no existe, la fila lo marca y se da
   de alta antes en «Nuevo proveedor». `COTIZACION_ID` de Gemini no se guarda: el ID lo pone la hoja.
3. `ESTADO`: `RECIBIDA (PARCIAL)` → `RECIBIDA` con «parcial» al inicio de `NOTAS`; `DESCARTADA` → `RECHAZADA`. «por
   confirmar», «[NV]» y «—» → vacío; «(DATO)» y «(SUPUESTO)» se quitan y se anotan; «1,000» → 1000; «20 %» → 20.
4. Marcadas y **nunca guardadas**: columnas no reconocidas (se listan), filas con otro número de celdas o encabezado
   repetido (se muestra su texto), filas **duplicadas** (mismo `COTIZACION_ID` que la hoja, o mismo producto, proveedor,
   incoterm, precio y moneda que una de la hoja, que una fila anterior del pegado o que una ya guardada en esa pantalla) y
   filas con errores (valores fuera de su lista o formato, producto descartado o inexistente, correos o teléfonos).
5. El propietario corrige y pulsa «Confirmar y guardar esta fila»: la pantalla revisa otra vez lo corregido y lo envía a
   `POST /api/eco/pipeline/cotizaciones`, una fila por vez y con un `requestId` nuevo. El servidor repite todo.

No conecta Gmail ni Gemini: el propietario copia la tabla de su documento en «ECO-RADAROS › Para Ideas» y la pega.

### 15.4 Una sola lista de estados

`ESTADOS_COTIZACION` (en `pipeline.ts`) es la única lista: `SOLICITADA · RECIBIDA · ELEGIDA · RECHAZADA`. La usan el
formulario, la escritura (§3.3) y el tabulador (§14.5), que deja de marcar `RECHAZADA` como «Estado no válido». Las filas
que digan `RECIBIDA (PARCIAL)` o `DESCARTADA` no se reescriben: el tabulador las muestra con «Estado no válido» y el
propietario las corrige a mano si quiere.

## 16. Bandeja de cotizaciones en 3 pasos (ORD-POS-149, POS-052; desde ORD-POS-150 dentro de /eco/pipeline, §17)

Orden ORD-POS-149 ([issue #333](https://github.com/jlpulido107-bit/PROJECT-OS/issues/333); paquete PAQ-2026-11-07-01),
riesgo MEDIO. Página `/eco/cotizaciones`, enlazada desde `/eco/pipeline` y en el menú RADAROS: el propietario pide,
recibe y decide una cotización con pocas casillas y el precio objetivo a la vista. Reúsa `PIPE_COTIZACIONES`,
`PIPE_PROVEEDORES`, `PIPE_PARAMETROS`, el tabulador (§14 y §14.7) y el pegado de Gemini (§15.3); no duplica cálculos.
Código: `web/src/lib/radaros/pipeline-bandeja.ts` (reparto, valores por defecto, seguimiento),
`pipeline-tabulador.ts` (`precioObjetivo`), `pipeline-escritura-service.ts` (`pedirCotizacion`, edición con historial),
`pipeline-pegado.ts` (`borradorRespuesta`), `web/src/components/eco/bandeja-cotizaciones.tsx` (pantalla) y
`web/src/app/(private)/eco/cotizaciones/page.tsx`.

**Solo escribe la sesión del propietario** (§1, §4.1 y §4.2): mismas rutas y mismo guard sin agente; con el token del PM
o cualquier `Authorization`, 401 antes de leer sesión o cuerpo, sin pedir el servicio. Inerte sin
`ECO_PIPELINE_WRITE_MODE` (§7.1). Los controles solo los ve `ecoPipelineCanWrite(email)`; un lector ve la bandeja sin
botones. Costo por set, veredicto, precio objetivo y capital solo con `ECO_TABULADOR=true` (§14.6), como «Comparar».

### 16.1 Migración explícita de `PIPE_COTIZACIONES`

La aplica **solo el propietario, a mano en la hoja de RADAROS**, después de fusionar y desplegar. En la fila 1, después de
`PRECIO_POR` (§14.7), escribir en este orden, exactos y sin repetir: `EVIDENCIA_URL` y `PRECIO_HISTORIAL`. `VERSION` no
cambia en ninguna fila. Idempotente (`migracionCotizaciones`: solo agrega las que faltan, al final). Hasta aplicarla, la
bandeja funciona, pero guardar una evidencia o una contraoferta responde 409 `eco-migracion-pendiente` y no escribe nada.
Comprobar: «Migración pendiente» desaparece de `/eco/cotizaciones` y de «Comparar». Revertir: borrar las dos columnas.

| Columna | Contenido |
| --- | --- |
| `EVIDENCIA_URL` | Liga `https://drive.google.com/…` o `https://docs.google.com/…` (hasta 300 caracteres, sin «@»). Nunca correos ni teléfonos |
| `PRECIO_HISTORIAL` | Precios anteriores, una entrada por contraoferta: `AAAA-MM-DD: <precio> <moneda> por <PIEZA/SET> <incoterm>`, separadas por ` \| `. La escribe solo el servidor |

### 16.2 Paso 1: pedir

Tres campos: producto (no descartado), proveedor con autocompletado entre los `ACTIVO` (por nombre, con la comparación
de §15.1) y canal. Un proveedor nuevo pide solo `NOMBRE` y `PAIS`, y el canal elegido; se da de alta por la ruta de §15.1
y luego se pide la cotización (si la segunda falla, el proveedor ya queda y el siguiente intento lo reúsa por nombre).
Un proveedor existente conserva su canal. `POST /api/eco/pipeline/cotizaciones/pedir` (operación `eco.cotizacion.pedir`,
solo `productoId` y `proveedorId`) crea la fila `SOLICITADA` con `FECHA_SOLICITUD` = hoy en America/Merida y
`FECHA_RESPUESTA_ESPERADA` = hoy + 7 (`DIAS_RESPUESTA`), `MUESTRA_ESTADO` = `NO_PEDIDA`.

### 16.3 Paso 2: recibir, y paso 3: decidir

**Recibir** edita la misma fila (`PATCH`, `expectedVersion`; una versión vieja es 409 sin escribir). Visibles y
obligatorios: precio, «el precio es por» (pieza o set), `INCOTERM`, `CANTIDAD_COTIZADA` y `MOQ`. Con su valor visible antes
de guardar, donde la hoja está vacía: `MONEDA` USD, `PAIS_ORIGEN` del proveedor, `CERTIFICADO_ORIGEN` NO y
`UNIDADES_POR_SET` de otra cotización del mismo producto, más la casilla «Incluye entrega en CEDIS Amazon» marcada (en DDP
guarda `FLETE_CEDIS` = 0; con otro incoterm no aplica). «Más detalles», plegado: fletes, `SEGURO`, `IGI_PCT`, `DTA`,
`AGENTE_ADUANAL`, plazo, tipo de cambio, muestra, `FECHA_RECIBIDA`, `EVIDENCIA_URL` y `NOTAS`; vacíos, el tabulador usa
`PIPE_PARAMETROS` (§14.2). Solo se envían los campos que se ven y cambiaron: uno que no se pinta nunca se vacía.
«Llenar borrador» acepta una fila de la tabla B de Gemini (con encabezado) o líneas `COLUMNA: valor`, con las limpiezas de
§15.3; llena el formulario y no guarda nada hasta «Guardar». El servidor, al pasar de `SOLICITADA` a `RECIBIDA`: pide
precio, moneda, MOQ, incoterm y, si la columna existe, `PRECIO_POR`; pone `FECHA_RECIBIDA` = hoy si viene vacía. El plazo
se exige al pasar a `ELEGIDA` (`REQUISITOS_RECIBIDA` y `REQUISITOS_ELEGIDA`).

**Decidir:** `ELEGIDA` en 1 clic (sigue la regla de una sola `ELEGIDA` por producto); `RECHAZADA` en 1 clic con un
motivo de una línea que se agrega al final de `NOTAS` («Rechazada: …», sin borrar lo anterior). **Contraoferta:** el
precio nuevo se guarda en `PRECIO_UNIT` y el servidor agrega el anterior a `PRECIO_HISTORIAL` en la misma escritura (con
su auditoría de antes y después). Nunca borra entradas ni cotizaciones.

### 16.4 Bandeja y precio objetivo

| Columna | Qué entra |
| --- | --- |
| Esperando respuesta | `SOLICITADA`; vencida (respuesta esperada anterior a hoy) en rojo, primero, con «Copiar seguimiento» |
| Por completar | `RECIBIDA` (o `ELEGIDA`) sin costo por set del tabulador; lista lo que le falta |
| Listas para comparar | `RECIBIDA` o `ELEGIDA` con costo por set: costo, «Cumple / No cumple por X», precio objetivo y capital del lote |

`RECHAZADA` y los estados fuera de la lista no entran; se cuentan y se ven en `/eco/pipeline`.

**Precio objetivo** (`precioObjetivo`): el precio unitario máximo, en la `MONEDA`, el `INCOTERM` y la unidad de la
cotización, que deja el costo por set en el `COSTO_MAX_MXN` calculado del producto (§14.4). El costo por set es lineal en
`PRECIO_UNIT` (mercancía, IGI y DTA crecen con él; fletes, agente y CEDIS no): se evalúa el tabulador con precio 0 y 1 y se
despeja. Sin máximo, con un dato del tabulador faltante o con costos fijos que ya superan el máximo, «Por confirmar» con
el motivo; si usa un SUPUESTO de `PIPE_PARAMETROS`, se marca. Caso Sandes (10.59 USD DDP por set de 6, entrega incluida,
TC 18.5, máximo 65 MXN): objetivo 65 ÷ 18.5 ≈ **3.51 USD por set**.

**Seguimiento:** «Copiar seguimiento» copia un texto corto en inglés (proveedor, producto y fecha de la solicitud; pide
precio por pieza o set, MOQ, incoterm y plazo). No envía nada, no conecta Gmail y no lleva correos ni teléfonos.


## 17. Compras por producto: pipeline y cotizaciones en una vista (ORD-POS-150, POS-053)

Solo presentación y navegación (`web/src/app/(private)/eco/pipeline/page.tsx`, funciones puras en
`web/src/lib/radaros/pipeline-compras.ts`). No cambian el tabulador (§14), el precio objetivo (§16.4), las rutas de
escritura, su guard, sus banderas, el esquema de `PIPE_*` ni las pestañas que se leen.

- **Chips** con los conteos de `construirBandeja` (§16.4): Esperando respuesta (con las vencidas), Por completar y Listas
  para decidir. Un chip (`?paso=`) deja en la lista solo los productos con cotizaciones en ese paso.
- **Lista**, un renglón por producto: nombre · ID, etapa y días, costo máximo, mejor cotización con «Cumple / No cumple
  por X», conteo por paso y alerta de seguimiento. Filtro de etapa (`?etapa=`): «Activas» (sin Descartado) por omisión,
  «Todas» o una etapa. La mejor cotización es la primera con costo por set en el orden de «Comparar»; una RECHAZADA nunca
  lo es. «Vista tablero» (`?vista=tablero`) es el tablero por etapas de §2.1, con arrastre y «Mover a…».
- **Ficha** (`?producto=`; `?comparar=` abre la misma ficha): 4 indicadores (costo máximo, mejor cotización, precio
  objetivo de esa cotización y capital del lote contra el tope), las cotizaciones del producto en 3 columnas con las
  acciones de §16 («Completar» es «Recibir» en el paso 2), «Pedir a otro proveedor» con el producto elegido y «Comparar»
  con 6 columnas; el resto en «Más columnas» y el desglose plegado. Identidad y Keepa, Seguimiento y embarques, y Notas
  e historial van plegados.
- **Proveedores**: subpestaña (`?seccion=proveedores`, `?proveedor=` o `?estado=`), con su lista y su ficha sin cambios.
- **Alta rápida** (§15) deja de ser sección: el alta de proveedor queda en «Pedir cotización» y el pegado de la tabla de
  Gemini en «Recibir varias». `/eco/cotizaciones` verifica la sesión, no lee datos y redirige a `/eco/pipeline`
  conservando `?paso=`. En el menú, RADAROS queda con Ideas (`/eco`) y Compras (`/eco/pipeline`).
- Sin `ECO_TABULADOR=true` no hay números ni «Comparar», y la ficha dice por qué. Los controles solo con
  `ecoPipelineCanWrite(email)` (§4.2); el token del PM sigue recibiendo 401 en las rutas.

## 18. Bandeja de Gemini (ORD-POS-155, POS-056)

Orden ORD-POS-155 ([issue #345](https://github.com/jlpulido107-bit/PROJECT-OS/issues/345); paquete PAQ-2026-11-10-03),
riesgo MEDIO, sensible: cambia el camino por el que llegan datos a `PIPE_*`. Aplica DEC-POS-031 (enmienda de DEC-POS-030).
Gemini propone proveedores y cotizaciones en una pestaña aparte; **solo el propietario** los confirma en Compras > Bandeja
(`/eco/pipeline?seccion=bandeja`). Nada llega a `PIPE_PROVEEDORES` ni a `PIPE_COTIZACIONES` por otra vía: confirmar usa las
mismas operaciones de §4 y §15. Gemini no recibe ninguna credencial y el dashboard no lee Gmail. Quién llena la pestaña
queda fuera de esta orden: el dashboard nunca le agrega filas.

Código: `web/src/lib/radaros/pipeline-bandeja-gemini.ts` (migración, lectura, bloqueos y borradores),
`pipeline-escritura-service.ts` (`confirmarBandeja`, `rechazarBandeja`), `pipeline-escritura-validacion.ts`
(`parseBandejaConfirmar`, `parseBandejaRechazar`), las rutas `web/src/app/api/eco/pipeline/bandeja/[id]/confirmar` y
`…/rechazar`, y la pantalla `web/src/components/eco/bandeja-gemini.tsx`. Activación: [escritura §13](escritura-v1-8.md#13-bandeja-de-gemini-de-ecopipeline-ord-pos-155-dec-pos-031).

### 18.1 Migración explícita de `PIPE_BANDEJA_GEMINI`

La aplica **solo el propietario, a mano en la hoja de RADAROS**, después de fusionar y desplegar. Ningún agente ni el
dashboard crean la pestaña ni sus columnas.

1. Crear la pestaña `PIPE_BANDEJA_GEMINI` (si no existe) y escribir en la fila 1, en este orden, exactos y sin repetir:

| Grupo | Columnas |
| --- | --- |
| Control | `BANDEJA_ID`, `FECHA_CAPTURA`, `TIPO` (`PROVEEDOR` o `COTIZACION`), `PRODUCTO_ID`, `PROVEEDOR` (empresa) |
| Tabla B del Gem 3, en el orden de `PIPE_COTIZACIONES` | `ESTADO`, `FECHA_RECIBIDA`, `PRECIO_UNIT`, `MONEDA`, `MOQ`, `PLAZO_PRODUCCION_DIAS`, `INCOTERM`, `COSTO_ATERRIZADO_MXN`, `MUESTRA_COSTO`, `MUESTRA_MONEDA`, `PAIS_ORIGEN`, `CERTIFICADO_ORIGEN`, `UNIDADES_POR_SET`, `FLETE_INTERNACIONAL`, `IGI_PCT` |
| Trazabilidad | `VERSION` (versión del Gem que produjo la fila; texto), `EVIDENCIA_URL` (liga de Drive) |
| Estado | `ESTADO_BANDEJA` (`PENDIENTE`, `CONFIRMADA` o `RECHAZADA`), `RESULTADO_ID`, `NOTAS` |

2. Idempotente (`migracionBandeja`, probada): si la pestaña ya tiene algunas, se agregan solo las que faltan, al final;
   nunca se reordena, renombra ni borra. Columnas propias del propietario al final se aceptan.
3. Cada fila nueva: `BANDEJA_ID` único con formato `BAN-NNNN` y `ESTADO_BANDEJA` = `PENDIENTE`. `COTIZACION_ID` de Gemini no
   va: el ID lo pone la hoja al confirmar. Solo valores escritos, sin fórmulas ni datos personales (§18.4).
4. Comprobar: con `ECO_BANDEJA_GEMINI=true`, Compras > Bandeja lista las filas `PENDIENTE` sin «falta la columna».
5. Revertir: apagar la bandera; la pestaña puede quedarse (el dashboard no la lee apagada) o borrarse a mano.

### 18.2 Lectura

Solo con `ECO_BANDEJA_GEMINI=true`, el lector de /eco pide la pestaña en su propio GET con `valueRenderOption=FORMULA`
(sigue siendo la cuenta de solo lectura) para ver las fórmulas. Columnas por nombre; una que falta o un encabezado repetido
se nombran en pantalla y no se muestran filas. Se muestran solo las `PENDIENTE`, con el conteo de confirmadas, rechazadas y
las de estado vacío o no válido. La sección solo la ve `ecoPipelineCanWrite(email)`.

### 18.3 Confirmar y rechazar

- **Revisión en pantalla.** Cada fila `COTIZACION` pasa por el mismo intérprete y los mismos chequeos de «Recibir varias»
  (§15.3, `parsearFilasGemini`): producto por `PRD-NNNN` o por idea, proveedor por nombre o `PRV-NNNN`, listas y formatos,
  requisitos de `RECIBIDA`, correos o teléfonos y duplicados contra la hoja y contra las filas anteriores de la bandeja.
  Como en el pegado, `PRECIO_POR` se elige antes de confirmar. Una fila `PROVEEDOR` pide los campos del alta de proveedor
  (§15.1) y avisa si ya existe uno con ese nombre.
- **Confirmar** (`eco.bandeja.confirmar`). El servidor relee la fila: debe estar `PENDIENTE`, ser del `TIPO` enviado y no
  tener bloqueos (§18.4). Después:
  - `PROVEEDOR`: si ya existe uno con ese nombre (comparación de §15.1), se liga sin escribir en `PIPE_PROVEEDORES`; si no,
    alta con `eco.proveedor.crear`.
  - `COTIZACION`: con un proveedor que ya existe (una fila `PROVEEDOR` se confirma antes). Si el producto tiene **una
    sola** cotización `SOLICITADA` a ese proveedor, la actualiza como «Recibir» (§16.3, con `expectedVersion`, sin vaciar
    celdas); si no (ninguna o más de una), alta con `eco.cotizacion.crear` más `EVIDENCIA_URL`. Una igual a una de la hoja
    (producto, proveedor, incoterm, precio y moneda) es 409 `cotizacion-duplicada`.
  - Luego marca la fila: `ESTADO_BANDEJA` = `CONFIRMADA` y `RESULTADO_ID` = el `PRV-NNNN` o `COT-NNNN`.
- **Rechazar** (`eco.bandeja.rechazar`). Motivo de una línea (1 a 300 caracteres, sin correos ni teléfonos): `ESTADO_BANDEJA`
  = `RECHAZADA` y «Rechazada: <motivo>» al final de `NOTAS`, sin borrar lo anterior. No se rechaza una fila desde la que ya
  se escribió un proveedor o una cotización (confirmación a medias): se termina de confirmar. La comprobación se repite
  dentro de la sección exclusiva de la marca, y la entidad solo se escribe si la fila sigue `PENDIENTE` dentro de la suya:
  un «Rechazar» y un «Confirmar» simultáneos nunca dejan `RECHAZADA` una fila desde la que se escribió (uno de los dos
  responde 409 `bandeja-no-pendiente`).
- **Errores sin datos de la hoja.** `bandeja-no-pendiente` y el error de `TIPO` solo nombran el estado o el tipo de la
  celda si es de la lista cerrada (`PENDIENTE`, `CONFIRMADA`, `RECHAZADA`; `PROVEEDOR`, `COTIZACION`); si no, solo el
  código o «un tipo no válido».
- **Lo único que se escribe en la bandeja:** `ESTADO_BANDEJA`, `RESULTADO_ID` y `NOTAS`, celda por celda en `RAW`. El
  almacén rechaza `append` en esta pestaña y no hay borrado; el servicio rechaza cualquier otra columna.
- **Auditoría e idempotencia.** La entidad, como siempre (§6.1). La marca de la bandeja también va primero a
  `PIPE_AUDITORIA` (`ENTIDAD` = `PIPE_BANDEJA_GEMINI`, `REGISTRO_ID` = `BAN-NNNN`, una fila por celda con antes y después),
  y luego se escribe solo si la fila sigue `PENDIENTE`, con verificación. El mismo `requestId` responde `repetida`. La
  escritura de la entidad usa un `requestId` derivado del `BANDEJA_ID`: un reintento, con el mismo `requestId` o con otro,
  sigue el camino ya auditado y nunca crea un segundo proveedor o cotización desde la misma fila. Una fila ya `CONFIRMADA`
  responde `repetida` con su `RESULTADO_ID`.
- **Reintento tras una marca fallida.** Si la entidad ya está auditada con el `requestId` derivado y la marca falló, un
  nuevo «Confirmar», aunque traiga otro cuerpo (por ejemplo, otras `NOTAS` tras recargar), no vuelve a crear ni a editar:
  completa la entidad con lo auditado (repetida o roll-forward, §6.1), ignora el cuerpo y termina la marca `CONFIRMADA`
  con el ID auditado.

### 18.4 Datos personales y fórmulas (criterio 4)

Una fila con un correo o un teléfono (10 dígitos o más; `pareceContacto`) en **cualquier** celda, o con una fórmula, se
marca en pantalla con la columna (sin mostrar el valor) y no tiene «Confirmar». El servidor lo repite con la fila releída
(valores y `valueRenderOption=FORMULA`): 422 `bandeja-bloqueada` con las columnas, sin escribir nada. Las fechas y las ligas
de Drive no cuentan como teléfono por sus dígitos. Rechazar sí se permite, salvo que `ESTADO_BANDEJA`, `RESULTADO_ID` o
`NOTAS` tengan fórmula o datos personales (no se copian a la auditoría): esa fila se corrige a mano.

### 18.5 Columnas por nombre en `PIPE_COTIZACIONES` y `PIPE_PROVEEDORES` (criterio 5)

La lectura (§3, `leerTabla`) y la escritura (`tabla` del servicio) buscan las columnas por nombre y aceptan columnas
extra al final, que nunca se escriben (en un alta quedan vacías). Si falta una requerida, la vista dice «columna obligatoria
ausente (X)» y la escritura responde 400 `eco-esquema-invalido` con la pestaña y la columna en el mensaje («La pestaña
PIPE_PROVEEDORES no tiene la columna ESTADO…»); un encabezado repetido también se nombra.

### 18.6 Bandera `ECO_BANDEJA_GEMINI`

Apagada por defecto: sin `ECO_BANDEJA_GEMINI=true` exacto no hay enlace ni sección, el lector no pide la pestaña y las rutas
responden 403 `operacion-no-permitida` antes de leer sesión o cuerpo. La pone **solo el propietario** con `deploy.sh`
([escritura §13](escritura-v1-8.md#13-bandeja-de-gemini-de-ecopipeline-ord-pos-155-dec-pos-031)); `render.mjs` la rechaza
sin `ECO_PIPELINE_WRITE_MODE=sheets`. Ningún agente la enciende.
