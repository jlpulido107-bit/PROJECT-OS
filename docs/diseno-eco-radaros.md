# Diseño de /eco — vista de solo lectura de RADAROS en el dashboard

Orden ORD-POS-066 (tarea POS-026, paquete PAQ-2026-10-22-07), riesgo MEDIO. Fecha: 2026-10-23. Solo diseño: no hay
código en `web/`, no se comparte ninguna hoja, no se despliega y no se toca IAM. La construcción va en otra orden
(§8), cuando se fusione la ORD-ECO-008 (diseño de V1.3 en RADAROS).

Fuentes: diseño V1.2 de RADAROS ([`RADAROS/docs/diseno-v1-2.md`](https://github.com/jlpulido107-bit/RADAROS/blob/main/docs/diseno-v1-2.md),
PR #13, fusionado), código V1.1 de RADAROS (`src/legacy/RadarV11.gs`, función `radarV11ConstruirAnalisis_`), cliente
de lectura del dashboard ([`web/src/lib/sheets-client.ts`](../web/src/lib/sheets-client.ts)), riesgo R3 de la
[preparación V1.6](despliegue-v1-6-preparacion.md#5-riesgos-de-seguridad-y-costos) y el carril ALTO de
[DEC-POS-014](delegacion-codex.md#política-de-revisión-por-riesgo-dec-pos-003-vigente-con-dec-pos-008). Marcas: ✅ verificado en el código o
la hoja · 📄 según un diseño fusionado · ❓ por confirmar al construir.

## 1. Qué es y qué no es

- Una página privada más del dashboard (`/eco`, dentro de `(private)`: exige el mismo login y la misma lista de
  acceso que el resto) que muestra el estado del motor de decisión de RADAROS, hoja `ecommerce_os_v1`.
- **Solo lee.** Usa el cliente de lectura existente: alcance `spreadsheets.readonly`, solo `GET`, solo en el
  servidor, con la cuenta de lectura de siempre (`project-os-dashboard-run`). No usa la API de operaciones ni la
  cuenta de escritura (`project-os-writer`), y no añade ninguna vía de escritura.
- **No llama a Keepa ni a SP-API** ni a Mercado Libre: solo lee lo que el motor ya dejó en la hoja. Las llaves de
  RADAROS viven en las Propiedades del Script de RADAROS y el dashboard nunca las conoce.
- No calcula puntuaciones ni márgenes: la puntuación y sus pesos son fórmulas de SCORING (📄 diseño V1.2 §1). La
  página muestra valores formateados (`FORMATTED_VALUE`), igual que el resto del dashboard.
- No toca las demás páginas: si /eco falla, el resto del dashboard sigue igual, porque la lectura de RADAROS es un
  lector aparte y ninguna otra página la usa.

## 2. Configuración y lecturas

| Variable | Dónde | Valor | Sin ella |
| --- | --- | --- | --- |
| `RADAROS_SHEET_ID` | Cloud Run, literal (no es una credencial; tampoco se publica en `docs/`) | ID del libro de RADAROS; mismo formato que `SHEETS_SPREADSHEET_ID` (`^[A-Za-z0-9_-]{20,100}$`) y **distinto** de él | La página muestra «no configurado» y **no hace ninguna lectura** |

Reglas (criterio 2):

1. La página resuelve la variable **antes** de pedir un token. Sin ella, vacía o con un valor que no cumple el
   formato: muestra «RADAROS no está configurado en este despliegue» (con «valor no válido» si lo hay) y termina:
   cero peticiones a Google, cero tokens. El valor nunca se muestra ni se registra.
2. Si coincide con `SHEETS_SPREADSHEET_ID`, se trata como no válido: /eco nunca lee la hoja de PROJECT-OS.
3. `render.mjs` rechaza al desplegar un valor con formato no válido o igual al de PROJECT-OS (sin imprimirlo) y
   `deploy.sh --desde-activa` la conserva como literal, igual que `PM_PUEDE_REGISTRAR_PR` (✅ ORD-POS-067). Sin la
   variable, el YAML renderizado no cambia.
4. Con la variable válida, cada carga hace como máximo **2 lecturas**: una de metadatos (`?fields=sheets.properties.title`,
   como `sheetTitles()`) y un `values:batchGet` solo con las pestañas de §3 que existen. Caché en memoria de
   `DASHBOARD_CACHE_SECONDS` (60 s por defecto), separada de la caché de PROJECT-OS. Con 1 o 2 usuarios queda muy
   por debajo de la cuota (R9).
5. Mismo límite de filas que el dashboard (`MAX_DATA_ROWS`, 5000) y rango `A1:Z`: si una pestaña lo supera, el
   bloque lo dice («truncado») en lugar de mostrar datos parciales sin aviso.

## 3. Bloques y sus fuentes (criterio 1)

Las columnas se buscan **por nombre de encabezado** (fila 1), nunca por posición: así las columnas `AMZ_*` que V1.2
añade al final de SCORING y UNIT_ECONOMICS no rompen nada, y una columna que falte se reporta en su bloque. La página
solo lee las columnas listadas; cualquier otra se ignora y no se muestra.

### 3.1 Estado del motor — `AMZ_CORRIDAS` (📄 V1.2 §5)

| Columnas que lee | Qué muestra |
| --- | --- |
| `CORRIDA_ID`, `SEMANA`, `MARKETPLACE`, `INICIO`, `FIN`, `ESTADO`, `IDEAS`, `ASINS_OK`, `ASINS_FALTAN`, `KEEPA_TOKENS_CONSUMIDOS`, `KEEPA_TOKENS_RESTANTES`, `SPAPI_LLAMADAS`, `MENSAJE` | Última corrida (la de `INICIO` más reciente) en una tarjeta con su `ESTADO` (`OK`, `OMITIDA`, `PARCIAL`, `ERROR`, `NEEDS_REAUTH`, `INERTE`), tokens de Keepa consumidos y restantes, y las últimas 8 corridas en una tabla. `MENSAJE` se recorta a 200 caracteres y se muestra como texto escapado |

Avisos derivados, sin escribir nada: `NEEDS_REAUTH` → «el propietario debe reautorizar SP-API»; `INERTE` → «el motor
está apagado (`AMZ_ACTIVO` sin activar)»; sin corrida en la semana ISO actual (zona `America/Merida`) → «sin corrida
esta semana». Obligatorias: `SEMANA`, `INICIO`, `ESTADO`; las demás, si faltan, se muestran vacías.

### 3.2 Ranking de ideas — `SCORING` y `AMZ_RESUMEN` (📄 V1.2 §2.1 y §5)

| Fuente | Columnas que lee | Uso |
| --- | --- | --- |
| `SCORING` | columna de ID de la idea (❓ nombre exacto; **hipótesis:** `IDEA_ID`, valores `EC-004` a `EC-009`, V1.2 §1); columna de puntuación final (❓ nombre exacto, la definen las fórmulas actuales); `AMZ_SEMANA`, `AMZ_DEMANDA_BSR_AVG90`, `AMZ_DEMANDA_CAIDAS_BSR_30D`, `AMZ_DEMANDA_VENTAS_MES`, `AMZ_DEMANDA_RANK_CATEGORIA`, `AMZ_COMPETENCIA_OFERTAS`, `AMZ_COMPETENCIA_OFERTAS_FBA`, `AMZ_COMPETENCIA_AMAZON_VENDE`, `AMZ_COMPETENCIA_RESENAS`, `AMZ_COMPETENCIA_RATING`, `AMZ_TENDENCIA_BSR_30_VS_90`, `AMZ_TENDENCIA_VENTAS_DELTA90`, `AMZ_TENDENCIA_PRECIO_30_VS_90`, `AMZ_TENDENCIA_GTRENDS`, `AMZ_ESTADO` | Tabla del ranking, ordenada por la puntuación de SCORING (mayor primero); con sus insumos en columnas plegables (Demanda, Competencia, Tendencia) |
| `AMZ_RESUMEN` | `SEMANA`, `MARKETPLACE`, `IDEA_ID`, `ASINS_USADOS`, `ESTADO` | Por idea: estado de la última semana y cuántas semanas tiene historial (no recalcula nada; los valores ya están en SCORING) |
| `PRODUCTS` (ORD-POS-113) | columna de ID (❓ la primera de `IDEA_ID` o `ID`; las pruebas de RADAROS usan `ID`) y columna de nombre (❓ la primera de `NOMBRE`, `PRODUCTO`, `NOMBRE_PRODUCTO`, `IDEA`, `DESCRIPCION`), sin distinguir mayúsculas ni acentos | «ID · nombre» en el ranking, en las tablas de Demanda, Competencia y Tendencia y en Unit economics; sin pestaña, sin columnas reconocidas o sin nombre, solo el ID |

Reglas: la página **no ordena por su cuenta con otro criterio**; sin columna de puntuación, el bloque muestra las
ideas por ID con el aviso «SCORING no tiene columna de puntuación reconocida». Las dos ❓ quedan como constantes en
[`web/src/lib/radaros/eco.ts`](../web/src/lib/radaros/eco.ts) (ORD-POS-067), **por confirmar en la activación** con los
encabezados reales: `COLUMNA_ID_IDEA = IDEA_ID` (hipótesis: el nombre de `AMZ_IDEA_ASIN` y `AMZ_RESUMEN`, V1.2 §5) y
`COLUMNAS_PUNTUACION` (la primera que exista de `PUNTUACION_FINAL`, `PUNTUACION`, `SCORE_FINAL`, `SCORE`). Si el
nombre real es otro, se cambia la constante y su prueba.

Presentación (ORD-POS-113): los encabezados `AMZ_*` se muestran con su título en español, su unidad y una ayuda (ⓘ)
de una línea, todo en un solo mapa constante,
[`web/src/lib/radaros/eco-columnas.ts`](../web/src/lib/radaros/eco-columnas.ts) (significados de V1.2 §2.1 y §2.2);
un encabezado sin traducción se muestra tal cual. Formato: separador de miles, MXN con su signo y porcentaje con `%`;
vacío, no numérico en una columna numérica o columna sin leer (el lector pide `A1:Z`, así que una `AMZ_*` después de
`Z` no llega) se muestra «—» con la leyenda «sin dato», nunca un error. Las columnas de nombre de `PRODUCTS` son ❓
hasta la activación: confirmar con los encabezados reales y, si es otro, ajustar `COLUMNAS_NOMBRE_PRODUCTS` en
[`eco.ts`](../web/src/lib/radaros/eco.ts) y su prueba.

### 3.3 Unit economics — `UNIT_ECONOMICS` (📄 V1.2 §2.2)

| Columnas que lee | Qué muestra |
| --- | --- |
| columna de ID de la idea (la misma ❓ de §3.2), `AMZ_ASIN_REF`, `AMZ_PRECIO_MXN`, `AMZ_PRECIO_MXN_AVG90`, `AMZ_COMISION_MXN`, `AMZ_COMISION_PCT`, `AMZ_FBA_MXN`, `AMZ_OTRAS_TARIFAS_MXN`, `AMZ_TARIFAS_FECHA` | Una fila por idea con precio, comisión, FBA y otras tarifas, y la fecha de la estimación. Leyenda fija: «Las tarifas de SP-API son estimaciones no garantizadas» (V1.2 §2.2 y §8) |

El costo del producto, el flete y el margen los captura el propietario en la hoja (V1.2 §2.2); si sus columnas
existen, la orden de construcción puede añadirlas por nombre, pero este diseño no las fija (❓ nombres).

### 3.4 Candidatos — `AMZ_CANDIDATOS` (V1.3, ❓ hasta la ORD-ECO-008)

| Columnas que lee | Qué muestra |
| --- | --- |
| **Hipótesis** (bosquejo V1.2 §7: «los mismos insumos de §2 y `DECISION_HUMANA`»): `SEMANA`, `ASIN`, las columnas de §2.1 y §2.2 sin el prefijo `AMZ_` y `DECISION_HUMANA` | Candidatos de la última semana, con `DECISION_HUMANA` vacía primero (pendientes de decidir). Promover un candidato es del propietario en la hoja; /eco no tiene botones |

La lista exacta la fija el diseño de V1.3. Mientras no exista, /eco **no pide** `AMZ_CANDIDATOS` en el `batchGet` y el
bloque muestra «pendiente de V1.3» (ORD-POS-067); la orden que lo complete copia esa lista y actualiza esta tabla.

### 3.5 Tendencias — `ML_TRENDS_ANALISIS_AUTO` (✅ código V1.1)

| Columnas que lee | Qué muestra |
| --- | --- |
| `KEYWORD`, `SEMANAS_DISTINTAS`, `PRIMERA_SEMANA`, `ULTIMA_SEMANA`, `ESTADO` (`RECURRENTE` / `UNA_SEMANA`), `ETIQUETA_PRELIMINAR`, `POSICION_ULTIMA` | Términos en el orden de la hoja (V1.1 ya los ordena por semanas distintas), con filtro por `ESTADO` y `ETIQUETA_PRELIMINAR`. La columna `URL` no se lee: es un enlace externo que no aporta a la decisión |

`POSICION_ULTIMA` no es un ranking (son tres listas concatenadas; auditoría de RADAROS §1.4): la página lo dice al pie
del bloque. `ML_TRENDS_RAW` no se lee.

## 4. Estados de la página (criterios 2 y 3)

| Situación | Lo que se ve | Lecturas |
| --- | --- | --- |
| Sin `RADAROS_SHEET_ID` o no válida | «RADAROS no está configurado en este despliegue» y los pasos de §6 | 0 |
| 401 / 403 / 404 en la lectura | Mensaje seguro del cliente (`permission`: «compártela como Lector con esa cuenta»), sin datos | 1 |
| Cuota, 5xx o tiempo agotado | Mensaje del cliente y «intenta en un minuto»; los demás bloques no se inventan | 1–2 |
| Pestaña que todavía no existe (`AMZ_*` antes de activar V1.2, `AMZ_CANDIDATOS` antes de V1.3) | El bloque muestra su estado vacío: «`AMZ_CORRIDAS` todavía no existe: se crea en la activación de V1.2» (o «… de V1.3») | no se pide en el `batchGet` |
| Pestaña con solo encabezado | «Sin filas todavía» con la explicación del bloque (p. ej. «el motor no ha corrido») | 2 |
| Falta una columna obligatoria | El bloque dice cuál falta y no muestra datos parciales; los demás bloques siguen | 2 |
| Pestaña truncada (> 5000 filas) | Aviso «truncado» en el bloque | 2 |

En ningún caso la página lanza una excepción no controlada: cada bloque resuelve su propio estado y la página
siempre se pinta. Las pruebas de la construcción cubren cada fila de esta tabla con dobles de `fetch` (§8).

## 5. Permisos y riesgo R3 (criterio 4)

- La cuenta de lectura **solo gana Lector sobre la hoja de RADAROS**, compartida desde la propia hoja. Nada más: ni
  Editor ni Comentador, ni roles de proyecto, ni cambios en IAM, en la cuenta de escritura ni en las credenciales guardadas en GCP.
- **Alcance real: todo el libro.** Compartir como Lector es por documento, no por pestaña: la cuenta podrá leer todas
  las pestañas de RADAROS, incluidas `AMZ_KEEPA_RAW` y `AMZ_SPAPI_RAW`, aunque /eco solo pida las de §3. Sigue
  siendo solo lectura; quien aprueba la activación (§6) acepta ese alcance.
- La cuenta de escritura (`project-os-writer`) **no** se comparte con RADAROS: el dashboard nunca escribe allí.
- El alcance OAuth sigue siendo `spreadsheets.readonly`: aunque alguien diera Editor por error, el cliente no puede
  escribir. Aun así, Editor sería un permiso de más y la verificación de §6 lo detecta.
- El riesgo R3 queda actualizado en la [preparación V1.6](despliegue-v1-6-preparacion.md#5-riesgos-de-seguridad-y-costos):
  Lector de **dos** documentos como máximo (PROJECT-OS y, al activar /eco, RADAROS), con la verificación de §6.

## 6. Activación del propietario

Solo el propietario, después de que se fusione y despliegue la orden de construcción (§8). Ningún agente comparte la
hoja, pone la variable ni despliega.

1. **Compartir la hoja.** En la hoja de RADAROS: Compartir → pega el correo de la cuenta de lectura (el valor de
   `RUNTIME_SA` de las [runbook](despliegue-privado-v1-3.md), §5.0) → **Lector** → desmarca
   «Notificar» → Compartir. No compartas la carpeta ni otros documentos.
2. **Configurar la variable** en Cloud Shell, con el ID del libro (el tramo entre `/d/` y `/edit` de su URL; no lo
   pegues en issues, PR ni chats):

   ```bash
   export RADAROS_SHEET_ID='<ID del libro de RADAROS>'
   web/deploy/cloudrun/deploy.sh --dry-run --desde-activa   # debe listar RADAROS_SHEET_ID como variable nueva
   web/deploy/cloudrun/deploy.sh --desde-activa             # confirma y aplica
   ```
3. **Verificar.**
   - `/eco` muestra los bloques; antes de activar V1.2, `AMZ_*` aparecen como «todavía no existe» y Tendencias con
     sus términos.
   - En la hoja de RADAROS, Compartir: la cuenta de lectura figura como **Lector** y no hay otras cuentas de
     servicio nuevas.
   - La cuenta de lectura sigue sin roles de proyecto (debe salir vacío):

     ```bash
     gcloud projects get-iam-policy "$PROJECT_ID" --flatten=bindings \
       --filter="bindings.members:serviceAccount:$RUNTIME_SA" --format='value(bindings.role)'
     ```
   - Las demás páginas siguen igual.
4. **Revertir.** `web/deploy/cloudrun/deploy.sh --desde-activa --quitar RADAROS_SHEET_ID` (la página vuelve a «no
   configurado» sin lecturas) y quitar a la cuenta de lectura del Compartir de la hoja de RADAROS.

## 7. Qué cambia y qué no

| Cambia | No cambia |
| --- | --- |
| Una página nueva en `(private)`, un lector y una variable literal opcional | Hoja de PROJECT-OS, API de operaciones, cuenta de escritura, alcance OAuth, IAM, credenciales guardadas en GCP, `.github/workflows` |
| Lector sobre un documento más (al activar) | RADAROS: su código, sus hojas y sus llaves |

## 8. Propuesta de la orden de construcción (MEDIO, inerte por defecto)

Para registrar como BORRADOR cuando se fusione la ORD-ECO-008; no se crea desde esta orden.

- **Título:** «/eco: vista de solo lectura de RADAROS, inerte sin `RADAROS_SHEET_ID`».
- **Riesgo:** MEDIO (DEC-POS-014): toca la lectura de una hoja más, pero sin escritura ni cambios de permisos en
  tiempo de ejecución. Revisión completa a ciegas, delta tras corrección y segundo revisor Fable 5.1 (DEC-POS-008).
- **Objetivo:** construir /eco según este documento, apagada mientras el propietario no ponga la variable.
- **Criterios:**
  1. `radarosSheetId(env)` en `web/src/lib/config.ts`: devuelve `null` sin variable, vacía, con formato no válido o
     igual a `SHEETS_SPREADSHEET_ID`; nunca incluye el valor en un mensaje.
  2. Lector de RADAROS que reutiliza `createSheetsReader` (mismo alcance, solo `GET`, `server-only`), con su propia
     caché y la lista fija de pestañas de §3; sin escritura y sin llamadas fuera de `sheets.googleapis.com`.
  3. Página `/eco` en `(private)` con los 5 bloques de §3, búsqueda de columnas por encabezado y los estados de §4.
  4. **Prueba de inercia:** sin `RADAROS_SHEET_ID`, la página muestra «no configurado» y el doble de `fetch` y el
     de token registran **cero** llamadas (y lo mismo con un valor no válido o igual al de PROJECT-OS).
  5. Pruebas de cada fila de §4 con dobles: pestañas `AMZ_*` ausentes, solo encabezado, columna obligatoria
     ausente, 403 y truncado; y que el `batchGet` no pide pestañas que no existen.
  6. `render.mjs` acepta `RADAROS_SHEET_ID` opcional y valida su formato; `deploy.sh --desde-activa` la conserva
     como literal; con la configuración actual el YAML renderizado no cambia (prueba).
  7. Enlace a /eco en la navegación solo si la variable está configurada.
  8. Las dos ❓ de §3.2 (ID de idea y puntuación de SCORING) y la lista de `AMZ_CANDIDATOS` de la ORD-ECO-008
     quedan fijadas como constantes, con su fuente citada en el PR.
- **Fuera de alcance:** compartir la hoja, desplegar, poner la variable, cambiar IAM o la cuenta de escritura,
  tocar RADAROS, llamar a Keepa o a SP-API.
- **Cómo probar:** `npm test`, `npm run lint`, `npm run typecheck` y `npm run check:client-secrets` en `web/`;
  `python -m unittest discover -s tests`; la prueba de inercia del criterio 4.
- **Activación:** la de §6, del propietario.

## 9. Preguntas abiertas

> **Pipeline de productos y proveedores (ORD-POS-095):** la escritura del propietario en pestañas `PIPE_*` de RADAROS
> se diseña aparte, en [`diseno-eco-pipeline.md`](diseno-eco-pipeline.md); esta vista de solo lectura no cambia.

- ❓ Nombres exactos de la columna de ID de idea y de la puntuación final en SCORING (y del ID en UNIT_ECONOMICS):
  se leen en la construcción.
- ❓ Columnas de `AMZ_CANDIDATOS`: las fija la ORD-ECO-008.
- ❓ Si el propietario quiere ver también `AMZ_IDEA_ASIN` (ASIN propuestos sin activar): no está en esta orden; se
  añadiría como un bloque más con el mismo patrón.
