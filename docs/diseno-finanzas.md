# Diseño de /finanzas — control de dinero de ECO y POS en el dashboard

Orden ORD-POS-070 (tarea POS-026, paquete PAQ-2026-10-23-02), riesgo MEDIO. Fecha: 2026-10-23. Solo diseño: no hay
código en `web/`, no se crea ni se comparte ninguna hoja, no se despliega y no se toca IAM. La construcción y la
automatización van en otras órdenes (§8 y §9). Sigue el patrón de /eco ([diseño](diseno-eco-radaros.md), ORD-POS-066;
construcción ORD-POS-067).

Escritura del propietario (alta de movimientos y cargos recurrentes): [diseño v2](diseno-finanzas-v2.md), ORD-POS-075.

Fuentes: diseño de /eco, cliente de lectura del dashboard ([`web/src/lib/sheets-client.ts`](../web/src/lib/sheets-client.ts)),
lector de /eco ([`web/src/lib/radaros/data.ts`](../web/src/lib/radaros/data.ts)), configuración
([`web/src/lib/config.ts`](../web/src/lib/config.ts)), riesgo R3 de la
[preparación V1.6](despliegue-v1-6-preparacion.md#5-riesgos-de-seguridad-y-costos) y el issue de la orden. Marcas: ✅
verificado en el código · 📄 según un diseño fusionado · ❓ por confirmar al construir o al activar.

## 1. Qué es y qué no es

- Una página privada más del dashboard (`/finanzas`, dentro de `(private)`: mismo login y misma lista de acceso) que
  muestra el dinero de **ECO** (RADAROS) y **POS** (PROJECT-OS), incluido el gasto en Claude. **SIG queda fuera**:
  es institucional y no se registra aquí.
- La fuente es una hoja nueva, **FINANZAS**, que crea el propietario. No es `ecommerce_os_v1` (RADAROS) ni la hoja
  de PROJECT-OS: es un libro aparte, para que compartirlo como Lector no abra nada más.
- **Captura manual por ahora:** el propietario escribe las filas en la hoja. La automatización futura (§9) añade
  filas con la misma regla de IDs, sin cambiar el esquema.
- **Solo lee.** Cliente de lectura existente: alcance `spreadsheets.readonly`, solo `GET`, solo en el servidor, con la
  cuenta de lectura de siempre (`project-os-dashboard-run`). No usa la API de operaciones ni la cuenta de escritura
  (`project-os-writer`) y no añade ninguna vía de escritura. No llama a SP-API, a Anthropic ni a ningún banco.
- No toca las demás páginas: lector aparte, con su propia caché, que ninguna otra página usa.

## 2. Esquema de la hoja FINANZAS (criterio 1)

Tres pestañas. Encabezados en la fila 1, exactamente como se escriben aquí; las columnas se buscan **por nombre**,
nunca por posición. Columnas nuevas siempre al final (no rompen la vista). Ningún cambio de nombre o de significado
sin una orden de migración explícita (`AGENTS.md`).

### 2.1 MOVIMIENTOS — un renglón por movimiento de dinero

| Columna | Obligatoria | Formato | Regla |
| --- | --- | --- | --- |
| `MOV_ID` | sí | texto | ID estable por fuente (§2.2); único en la pestaña |
| `FECHA` | sí | fecha (`AAAA-MM-DD`) | Fecha del cargo o abono; define el mes (zona `America/Merida`) |
| `PROYECTO` | sí | `ECO` \| `POS` | Nunca `SIG` |
| `TIPO` | sí | `Gasto` \| `Ingreso` \| `Inversión` | `Inversión` = compra de inventario o activo que consume capital (§2.4) |
| `CATEGORIA` | sí | lista cerrada (§2.3) | Validación de datos en la hoja |
| `CONCEPTO` | sí | texto corto | Qué fue (p. ej. «Suscripción Claude», «Muestras»). Sin datos personales ni bancarios |
| `PRODUCTO_ID` | no | texto | ID de la idea o producto de RADAROS (❓ mismo formato que `IDEA_ID`, p. ej. `EC-004`); vacío si no aplica |
| `MONTO_MXN` | sí | número > 0, 2 decimales | Monto en pesos, **siempre positivo**; el signo lo da `TIPO`. v2 §8: negativo solo en un ajuste (`AJUSTE_DE`) |
| `MONEDA_ORIG` | no | código ISO 4217 (`MXN`, `USD`) | Vacío = `MXN` |
| `MONTO_ORIG` | no | número > 0 | Monto en la moneda original; vacío si es `MXN` |
| `TIPO_CAMBIO` | no | número > 0 | MXN por unidad de `MONEDA_ORIG`; vacío = el de PARAMETROS. `MONTO_MXN` ya viene convertido |
| `IVA_MXN` | no | número ≥ 0 | IVA incluido en `MONTO_MXN` (informativo; no se resta) |
| `FUENTE` | sí | `manual` \| `sp-api` \| `anthropic` \| `recurrente` (v2 §8) | Debe cuadrar con el prefijo de `MOV_ID` (§2.2) |
| `COMPROBANTE` | sí | `sí` \| `no` | Si existe factura o recibo. **Sin enlaces, rutas ni números de factura** |

Una fila con `MOV_ID` vacío, duplicado o que no cuadra con `FUENTE`, `PROYECTO`/`TIPO`/`CATEGORIA` fuera de la lista
o `MONTO_MXN` no numérico **no se suma**: la vista la cuenta como «fila con problema» y dice el `MOV_ID` (o el número
de fila) y la columna, sin mostrar el monto. Así un error de captura se ve y no altera los totales en silencio.

### 2.2 Regla de `MOV_ID` estable por fuente (idempotencia)

> **Esquema v2** ([diseño v2](diseno-finanzas-v2.md) §8, vista desde ORD-POS-076): se añaden la fuente `recurrente`
> con `MOV_ID` `REC-<ID>-AAAA-MM` (cargos de la pestaña RECURRENTES, v2 §4), la columna opcional `AJUSTE_DE` al final
> de MOVIMIENTOS y los montos negativos, solo en un ajuste (v2 §3.4). Cuando la escritura de finanzas está activa
> (v2 §7), el `MAN-NNNN` **lo asigna el servidor** al dar de alta desde /finanzas (v2 §3.2), no el propietario a mano.

| Fuente | Formato | Quién lo genera | Ejemplo |
| --- | --- | --- | --- |
| `manual` | `MAN-NNNN` (4 dígitos, consecutivo) | El propietario, a mano; con la escritura activa, el servidor (v2 §3.2) | `MAN-0001` |
| `sp-api` | `SPAPI-<id>` | La automatización de §9.1, con el ID del evento financiero de Amazon | `SPAPI-<id del evento>` |
| `anthropic` | `CLAUDE-AAAA-MM` | Reservado para una fuente automática de Anthropic (v2 §4.4) | `CLAUDE-2026-10` |
| `recurrente` | `REC-<ID>-AAAA-MM` | La confirmación de un cargo de RECURRENTES (v2 §4.3) | `REC-<ID>-AAAA-MM` |

Reglas:

1. El ID se **deriva de la fuente**, no del orden de captura ni de la fecha de carga: el mismo hecho produce siempre
   el mismo ID. Volver a importar un periodo no duplica filas.
2. **Insertar si no existe; si existe, no se toca** (o se actualiza en su lugar, nunca se agrega otra fila). Nadie
   reutiliza un ID: un `MAN-NNNN` borrado o anulado no se vuelve a usar.
3. Una corrección es una fila nueva con su propio ID y `CONCEPTO` «Ajuste de `<MOV_ID>`», o la edición en su lugar
   de la fila original por el propietario; nunca dos filas para el mismo hecho.
4. `MAN-` es solo del propietario; `SPAPI-` y `CLAUDE-` solo de su automatización. Una fila manual que capture lo
   mismo que una automática se borra al encender esa automatización (§9.3).
5. La vista valida la unicidad y el prefijo (§2.1) y lo reporta; no corrige nada.

### 2.3 Categorías (lista cerrada)

| `CATEGORIA` | Incluye | `TIPO` habitual |
| --- | --- | --- |
| `Herramientas` | Claude, Keepa, GCP | Gasto |
| `Marketplace` | Plan de Amazon, comisiones, FBA, almacenaje | Gasto |
| `Producto` | Muestras, inventario, flete, empaque | Inversión (inventario) o Gasto (muestras) |
| `Marketing` | PPC, fotos | Gasto |
| `Legal y marca` | IMPI, GS1 | Gasto |
| `Ventas` | Ventas de producto | Ingreso |

Una categoría nueva se añade al final de esta lista con una orden; la vista muestra aparte, como «otra», cualquier
valor que no esté en la lista.

### 2.4 PARAMETROS — clave y valor

Dos columnas: `PARAMETRO`, `VALOR`. Una fila por parámetro; la vista solo lee estas claves:

| `PARAMETRO` | Formato | Uso |
| --- | --- | --- |
| `CAPITAL_TOPE_MXN` | número > 0 | Tope de capital del proyecto (lo fija el propietario; la orden trae la cifra) |
| `ALERTA_PCT` | número entre 1 y 100 | Umbral de alerta del capital usado; vacío = `80` |
| `TIPO_CAMBIO_DEFECTO` | número > 0 | MXN por USD cuando una fila en USD no trae `TIPO_CAMBIO` |
| `MES_INICIO` | `AAAA-MM` | Primer mes que cuenta para el capital y para las gráficas |

**Capital usado** = suma de `MONTO_MXN` de `Gasto` e `Inversión` de ECO y POS desde `MES_INICIO`, **sin restar
ingresos** (el tope mide cuánto dinero propio se ha puesto). ❓ Si el propietario prefiere capital neto (menos
`Ingreso`), se cambia esta regla con su orden; la vista mostraría ambas cifras.

### 2.5 RESUMEN — fórmulas para verse en la hoja

Pestaña de fórmulas (`QUERY`/`SUMIFS` sobre MOVIMIENTOS y PARAMETROS) para que el propietario vea lo mismo en Sheets:

| Sección | Contenido |
| --- | --- |
| Gasto por mes y proyecto | Mes × `PROYECTO`, con `Gasto` + `Inversión` e `Ingreso` en columnas separadas |
| Capital usado contra el tope | Capital usado, `CAPITAL_TOPE_MXN`, porcentaje y restante |
| P&L por producto | Por `PRODUCTO_ID`: `Ingreso` − (`Gasto` + `Inversión`) |
| Costo mensual de herramientas | Mes × `CONCEPTO` con `CATEGORIA` = `Herramientas` |

**La vista no lee RESUMEN:** calcula sus bloques con las mismas reglas a partir de MOVIMIENTOS y PARAMETROS (una sola
fuente de datos; RESUMEN es una vista derivada, como el dashboard). Si un total del dashboard no coincide con
RESUMEN, el error está en una fórmula o en una fila con problema, y la vista ayuda a encontrarlo porque lista las
filas que no sumó. Las sumas son aritmética simple, con pruebas.

## 3. Configuración y lecturas

| Variable | Dónde | Valor | Sin ella |
| --- | --- | --- | --- |
| `FINANZAS_SHEET_ID` | Cloud Run, literal (no es credencial; tampoco se publica en `docs/`) | ID del libro FINANZAS; formato `^[A-Za-z0-9_-]{20,100}$`, **distinto** de `SHEETS_SPREADSHEET_ID` y de `RADAROS_SHEET_ID` | «no configurado» y **ninguna lectura** |

Reglas (criterio 3):

1. La página resuelve la variable **antes** de pedir un token. Ausente, vacía, con formato no válido o igual a la hoja
   de PROJECT-OS o a la de RADAROS: muestra «FINANZAS no está configurado en este despliegue» (con «valor no válido»
   si lo hay) y los pasos de §6, y termina: cero peticiones a Google y cero tokens. El valor nunca se muestra ni se
   registra. Mismo patrón que `radarosConfig` (✅ `web/src/lib/config.ts`).
2. Con la variable válida, cada carga hace como máximo **2 lecturas**: metadatos (títulos de pestañas) y un
   `values:batchGet` solo con `MOVIMIENTOS` y `PARAMETROS` que existan. Caché propia de `DASHBOARD_CACHE_SECONDS`
   (60 s por defecto) y errores en caché 10 s, como /eco.
3. **Valores sin formato.** El cliente actual pide `FORMATTED_VALUE` (✅ `sheets-client.ts`), que convierte montos en
   texto con símbolo de moneda y separadores de miles. Para sumar sin interpretar texto, el lector de FINANZAS pide
   `UNFORMATTED_VALUE` (montos como número) con fechas `FORMATTED_STRING`; la orden de construcción añade esa opción
   a `readTabs` con el valor actual por defecto, de modo que las demás páginas no cambian.
4. Mismo límite de filas (`MAX_DATA_ROWS`, 5000) y rango `A1:Z`: si MOVIMIENTOS lo supera, la vista dice «truncado»
   y **no muestra totales** (serían parciales).

## 4. Bloques de la vista (criterio 2)

Todos los montos en MXN, con 2 decimales, ordenados y sin decimales inventados. Cada bloque resuelve su propio estado
(§5); ninguno escribe nada ni tiene botones.

### 4.1 Capital usado contra el tope

- Barra con capital usado / `CAPITAL_TOPE_MXN`, porcentaje y restante (regla de §2.4).
- **Alerta al 80 %** (o `ALERTA_PCT`): de 80 % a 99 %, aviso ámbar «capital al N % del tope»; desde 100 %, aviso rojo
  «tope de capital superado». Solo informa; no bloquea nada ni manda notificaciones.
- Desglose por proyecto (ECO y POS) del capital usado.
- Sin `CAPITAL_TOPE_MXN` válido: muestra el capital usado y «falta `CAPITAL_TOPE_MXN` en PARAMETROS», sin barra ni
  alerta.

### 4.2 Gasto mensual por proyecto y categoría

- Tabla de los últimos 12 meses desde `MES_INICIO` (filas: mes; columnas: ECO y POS), con `Gasto` + `Inversión`; al
  desplegar un mes, el detalle por `CATEGORIA`.
- `Ingreso` en una columna aparte, nunca restado del gasto en esta tabla.

### 4.3 Costo de herramientas

- Por mes, las filas de `CATEGORIA` = `Herramientas` agrupadas por `CONCEPTO` (Claude, Keepa, GCP…), con total
  mensual y promedio de los últimos 3 meses.
- Marca «sin registrar» un mes sin fila de una herramienta que sí tuvo cargo el mes anterior (ayuda a detectar una
  captura olvidada; no inventa el monto).

### 4.4 P&L por producto

- Por `PRODUCTO_ID`: ingresos, gastos e inversión, y resultado = ingresos − (gastos + inversión).
- Las filas sin `PRODUCTO_ID` no se reparten entre productos: aparecen como «sin producto» al pie.
- No calcula márgenes unitarios ni toma las estimaciones de tarifas de /eco: solo lo realmente capturado.

### 4.5 Filas con problema

Lista de las filas que no se sumaron (§2.1), con `MOV_ID` o número de fila y la columna que falla, sin montos. Vacía
→ no se muestra.

## 5. Estados de la página (criterio 3)

| Situación | Lo que se ve | Lecturas |
| --- | --- | --- |
| Sin `FINANZAS_SHEET_ID`, vacía o no válida | «FINANZAS no está configurado en este despliegue» y los pasos de §6 | 0 |
| 401 / 403 / 404 | Mensaje seguro del cliente (`permission`: «compártela como Lector con esa cuenta»), sin datos | 1 |
| Cuota, 5xx o tiempo agotado | Mensaje del cliente e «intenta en un minuto»; no se inventan bloques | 1–2 |
| Falta la pestaña MOVIMIENTOS o PARAMETROS | Cada bloque: «la pestaña `X` todavía no existe»; no se pide en el `batchGet` | 1 |
| Hoja vacía (solo encabezados) | Cada bloque con su estado vacío: «Sin movimientos todavía» (capital usado 0 contra el tope si está) | 2 |
| PARAMETROS sin una clave | El bloque que la necesita lo dice (§4.1); los demás siguen | 2 |
| Falta una columna obligatoria de MOVIMIENTOS | Todos los bloques: «falta la columna `X`», sin totales parciales | 2 |
| Filas con problema | Totales sin esas filas y el bloque §4.5 | 2 |
| MOVIMIENTOS truncada (> 5000 filas) | Aviso «truncado» y sin totales | 2 |

En ningún caso la página lanza una excepción no controlada: siempre se pinta. Las pruebas de la construcción cubren
cada fila de esta tabla con dobles de `fetch` y de token.

## 6. Activación del propietario (criterios 4 y 6)

Solo el propietario, después de que se fusione y despliegue la orden de construcción (§8). Ningún agente crea ni
comparte la hoja, pone la variable ni despliega.

1. **Crear la hoja FINANZAS** en su Drive, con las pestañas `MOVIMIENTOS`, `PARAMETROS` y `RESUMEN` y los
   encabezados de §2 (validaciones de datos para `PROYECTO`, `TIPO`, `CATEGORIA`, `FUENTE` y `COMPROBANTE`).
2. **Compartir la hoja.** Compartir → correo de la cuenta de lectura (el valor de `RUNTIME_SA` del
   [runbook](despliegue-privado-v1-3.md), §5.0) → **Lector** → desmarcar «Notificar» → Compartir. Acceso general:
   **Restringido**. No compartir la carpeta ni otros documentos, ni con la cuenta de escritura.
3. **Configurar la variable** en Cloud Shell, con el ID del libro (el tramo entre `/d/` y `/edit` de su URL; no lo
   pegues en issues, PR ni chats):

   ```bash
   export FINANZAS_SHEET_ID='<ID del libro FINANZAS>'
   web/deploy/cloudrun/deploy.sh --dry-run --desde-activa   # debe listar FINANZAS_SHEET_ID como variable nueva
   web/deploy/cloudrun/deploy.sh --desde-activa             # confirma y aplica
   ```
4. **Verificar.**
   - `/finanzas` aparece en la navegación y, con la hoja vacía, cada bloque muestra su estado vacío.
   - Una fila de prueba `MAN-0001` aparece en los bloques tras 60 s; luego se borra (y su ID no se reutiliza).
   - En Compartir de FINANZAS, la cuenta de lectura figura como **Lector** y no hay otras cuentas de servicio.
   - La cuenta de lectura sigue sin roles de proyecto (debe salir vacío):

     ```bash
     gcloud projects get-iam-policy "$PROJECT_ID" --flatten=bindings \
       --filter="bindings.members:serviceAccount:$RUNTIME_SA" --format='value(bindings.role)'
     ```
   - Las demás páginas siguen igual.
5. **Revertir.** `web/deploy/cloudrun/deploy.sh --desde-activa --quitar FINANZAS_SHEET_ID` (la página vuelve a «no
   configurado» sin lecturas) y quitar a la cuenta de lectura del Compartir de FINANZAS.

### Permisos y riesgo R3 (criterio 4)

- La cuenta de lectura **solo gana Lector sobre FINANZAS**, compartida desde la propia hoja: ni Editor ni Comentador,
  ni roles de proyecto, ni cambios en IAM, en la cuenta de escritura ni en las credenciales guardadas en GCP.
- Compartir como Lector abre **todo el libro**; por eso FINANZAS es un libro aparte que solo contiene lo de §2.
- El alcance OAuth sigue siendo `spreadsheets.readonly` y el cliente solo emite `GET`: aunque alguien diera Editor
  por error, la vista no puede escribir. Editor sería un permiso de más y la verificación de este paso lo detecta.
- R3 queda actualizado en la [preparación V1.6](despliegue-v1-6-preparacion.md#5-riesgos-de-seguridad-y-costos):
  Lector de **tres** documentos como máximo (PROJECT-OS y, si el propietario los activa, RADAROS y FINANZAS).

## 7. Qué cambia y qué no

| Cambia | No cambia |
| --- | --- |
| Una página nueva en `(private)`, un lector, una variable literal opcional y una opción de render en `readTabs` (por defecto la actual) | Hoja de PROJECT-OS, API de operaciones, cuenta de escritura, alcance OAuth, IAM, credenciales guardadas en GCP, `.github/workflows`, /eco |
| Lector sobre un documento más (al activar) | RADAROS: su código, sus hojas y sus llaves |

## 8. Propuesta de la orden de construcción (MEDIO, inerte por defecto)

Para registrar como BORRADOR; no se crea desde esta orden.

- **Título:** «/finanzas: vista de solo lectura de FINANZAS, inerte sin `FINANZAS_SHEET_ID`».
- **Riesgo:** MEDIO: lectura de una hoja más, sin escritura ni cambios de permisos en tiempo de ejecución. Revisión
  completa a ciegas, delta tras corrección y segundo revisor (DEC-POS-008).
- **Criterios:**
  1. `finanzasConfig(env)` en `web/src/lib/config.ts`: `null` sin variable, vacía, con formato no válido o igual a
     `SHEETS_SPREADSHEET_ID` o a `RADAROS_SHEET_ID`; nunca incluye el valor en un mensaje.
  2. `readTabs` acepta `valueRenderOption` opcional (por defecto `FORMATTED_VALUE`); pruebas de que las demás
     páginas siguen pidiendo lo mismo.
  3. Lector de FINANZAS con `createSheetsReader` (mismo alcance, solo `GET`, `server-only`), su caché y la lista fija
     `MOVIMIENTOS`, `PARAMETROS`; sin escritura y sin llamadas fuera de `sheets.googleapis.com`.
  4. Funciones puras de §2 y §4 (validación de filas, capital usado, alerta, gasto mensual, herramientas, P&L) con
     pruebas, incluidas filas con problema y `MOV_ID` duplicado.
  5. Página `/finanzas` en `(private)` con los bloques de §4 y los estados de §5.
  6. **Prueba de inercia:** sin `FINANZAS_SHEET_ID` (o con un valor no válido o igual a otra hoja), cero llamadas al
     doble de `fetch` y al de token.
  7. `render.mjs` acepta `FINANZAS_SHEET_ID` opcional y valida formato y distinción; `deploy.sh --desde-activa` la
     conserva como literal; sin la variable el YAML renderizado no cambia (prueba).
  8. Enlace a /finanzas en la navegación solo con la variable configurada.
- **Fuera de alcance:** crear o compartir la hoja, desplegar, poner la variable, cambiar IAM o la cuenta de
  escritura, tocar RADAROS, llamar a SP-API o a Anthropic.
- **Cómo probar:** `npm test`, `npm run lint`, `npm run typecheck` y `npm run check:client-secrets` en `web/`;
  `python -m unittest discover -s tests`; la prueba de inercia del criterio 6.
- **Activación:** la de §6, del propietario.

## 9. Automatización futura (criterio 5) — propuestas de órdenes

Ninguna se crea desde esta orden. Todas escriben **solo filas nuevas** en MOVIMIENTOS con la regla de §2.2 (insertar
si el `MOV_ID` no existe) y ninguna la hace el dashboard: su lectura sigue siendo de solo lectura.

### 9.1 ORD-ECO: movimientos de Amazon desde SP-API Finances (RADAROS)

- **Dónde:** RADAROS (Apps Script), que ya guarda las llaves de SP-API en sus Propiedades del Script; el dashboard
  nunca las conoce.
- **Qué:** leer los eventos financieros del periodo (ventas, comisiones, FBA, almacenaje, reembolsos) y escribir una
  fila por evento: `MOV_ID` = `SPAPI-<id del evento>`, `FUENTE` = `sp-api`, `PROYECTO` = `ECO`, `CATEGORIA`
  `Ventas` o `Marketplace`, `PRODUCTO_ID` desde el ASIN cuando haya correspondencia (❓ tabla de ASIN a idea en
  RADAROS), `COMPROBANTE` = `sí`.
- **Idempotencia:** volver a leer un periodo no duplica: se omite todo `MOV_ID` existente. ❓ Qué campo de la API da
  un ID único por evento (si no hay uno, un hash estable de los campos del evento, fijado en esa orden).
- **Riesgo:** ALTO por escribir en otra hoja con credenciales de SP-API; según DEC-POS-014 se descompone en MEDIO
  inerte (código apagado por bandera) más la activación del propietario (compartir FINANZAS como **Editor** con la
  identidad del script de RADAROS y encender la bandera). Esa escritura es de RADAROS, no del dashboard.

### 9.2 ORD-POS: filas recurrentes de herramientas

> **Sustituida por el [diseño v2](diseno-finanzas-v2.md) §4** (RECURRENTES y `REC-<ID>-AAAA-MM`): Claude y Keepa se
> cargan como recurrentes; `CLAUDE-` queda reservado para una fuente automática (v2 §4.4). La vista de pendientes del
> mes es de ORD-POS-076; la confirmación desde /finanzas, de la orden F-2 (v2 §9.2). Lo de abajo queda como historia.

- **Qué:** una fila mensual por herramienta con costo fijo conocido (Claude, Keepa; GCP según su factura):
  `MOV_ID` = `CLAUDE-AAAA-MM` para Claude (y un prefijo por herramienta, p. ej. `KEEPA-AAAA-MM`, ❓ a fijar en esa
  orden junto con su `FUENTE`), `FUENTE` = `anthropic` para Claude, `PROYECTO` = `POS` o `ECO` según a quién sirve.
- **Cómo:** la opción más simple es una plantilla de filas que el propietario copia cada mes con el ID ya calculado
  (sin código ni permisos nuevos). La automática (un script que inserta la fila del mes si no existe) solo se
  propone si la captura manual falla; ❓ si Anthropic ofrece una fuente de consumo que no requiera guardar llaves
  nuevas.
- **Idempotencia:** un `CLAUDE-AAAA-MM` por mes; si el cargo real difiere, se edita esa misma fila.

### 9.3 Paso a automático

Al encender 9.1 o 9.2, el propietario borra las filas `MAN-` que capturaban lo mismo en los meses ya cubiertos (§2.2,
regla 4). La vista no distingue fuentes al sumar; el bloque §4.3 puede mostrar la `FUENTE` de cada fila.

## 10. Datos que nunca van al repositorio ni a la hoja (criterio 7)

- Sin montos reales en `docs/`, issues ni PR: los ejemplos de este documento son formatos, no cifras.
- Sin datos bancarios (cuentas, CLABE, tarjetas), RFC, razones sociales de proveedores ni números de factura, ni en la
  hoja ni aquí: `CONCEPTO` describe el gasto, no a la persona, y `COMPROBANTE` es solo `sí`/`no`.
- Sin IDs de libros: `FINANZAS_SHEET_ID` vive solo en Cloud Run.
