# Diseño de Inicio v2 — tablero de operación

Orden ORD-POS-094 (tarea POS-031), riesgo BAJO (solo documento). Fecha: 2026-10-25. No cambia código, no escribe en
ninguna hoja ni despliega. Parte del Inicio de la ORD-POS-090 (✅ `web/src/lib/inicio.ts`, `web/src/app/(private)/page.tsx`)
y de las vistas /metricas (ORD-POS-072) y /agentes (ORD-POS-078 y ORD-POS-080). La idea de «tarjetas con tendencia y
gráficas de costo» viene del mapa del dashboard del propietario en NOTAS (`00-entrada/dashboard-mapa.canvas`,
referencias SalesPulse y NeuralDesk; paquete PAQ-2026-10-25-02). **Hipótesis:** el canvas no se leyó desde esta sesión
(NOTAS no está en su alcance); el diseño toma la idea tal como la resume el issue #221.

Marcas: ✅ verificado en el código de `main` (commit `21dc33c`) · 📄 según un diseño fusionado · ❓ por confirmar al
construir.

| Criterio de la orden | Sección |
| --- | --- |
| 1. Seis tarjetas con tendencia y su fuente exacta | §3 |
| 2. Dos gráficas, reutilizando /metricas y /agentes | §4 |
| 3. Estados: con datos, sin datos, fuente apagada | §2 y la columna «Estados» de §3 y §4 |
| 4. Límite de llamadas a GitHub por carga y caché | §5 |
| 5. Órdenes de construcción con su riesgo | §7 |

## 1. Qué es y qué no es

- Una franja nueva **arriba** de Inicio: seis tarjetas y dos gráficas que dicen «cómo va el sistema» sin entrar a otra
  página. Los bloques actuales (Proyectos, Mis pendientes, Finanzas, Agentes) se quedan debajo, sin cambio.
- **Solo lectura**, como todo Inicio: ninguna tarjeta escribe en la hoja, en FINANZAS ni en GitHub.
- **Funciones puras** en `web/src/lib/inicio-tablero.ts` sobre lo que ya leen Inicio, /metricas y /agentes; la página
  solo junta las fuentes. Nada se recalcula si ya existe (§6).
- Respeta el filtro `?proyecto=` de Inicio (✅ `parseFiltroInicio`). Con un proyecto que FINANZAS no registra (SIG, DEV,
  ALI), las tarjetas de dinero dicen «sin datos» con ese motivo (✅ igual que `finanzasInicio`).
- Sin dependencias nuevas: las gráficas son tablas con barras en CSS o SVG en línea, como el mapa de lanzamientos de
  /agentes (✅ `web/src/components/agentes/agentes.tsx`, tabla `mapa`), siempre con la tabla de datos accesible.

## 2. Estados y tendencia

### 2.1 Tres estados por tarjeta y por gráfica

Se amplía el tipo `Indicador<T>` de /agentes (✅ `{ estado: 'sin-datos' } | { estado: 'ok' }`) con un tercer estado:

| Estado | Cuándo | Qué muestra |
| --- | --- | --- |
| `ok` (con datos) | La fuente se leyó y hay al menos un dato que contar | El valor, la tendencia (§2.2) y la fuente |
| `sin-datos` | La fuente se leyó pero no alcanza para el valor (pestaña inválida, sin filas del filtro, GitHub no respondió o se acabó el tope) | «sin datos» y el motivo; **nunca un 0** |
| `apagada` (fuente apagada) | La fuente no existe en este despliegue o para esta sesión, por configuración: sin token de GitHub, sin `FINANZAS_SHEET_ID`, AUDITORIA sin escritura activa o para un lector no escritor, pestaña `RENDIMIENTO_CLAUDE` sin construir | «fuente apagada», qué falta y quién la enciende (el propietario) |

Un 0 solo aparece cuando la fuente se leyó y de verdad hay cero (p. ej. ninguna orden abierta en una ORDENES_CODEX
válida). La distinción `apagada` contra `sin-datos` evita que el propietario busque un fallo donde solo hay una variable
sin poner.

### 2.2 Tendencia contra la semana anterior

- **Ventana:** «esta semana» = los últimos 7 días civiles en `America/Merida`, hoy incluido; «la anterior» = los 7 días
  previos. Ventana móvil y no de lunes a domingo, para que el lunes no compare un día contra siete. Fechas con
  `todayInMerida`, `addDays` y `civilHourInZone` (✅ `web/src/lib/dates.ts`).
- **Flujos** (fusionadas, % CONFORME): valor de esta semana contra el de la anterior.
- **Existencias** (abiertas, hitos en riesgo, gasto del mes): valor hoy contra el valor reconstruido a hoy − 7. Si la
  fuente no guarda historia para reconstruirlo, la tendencia es `sin-datos` aunque el valor sí se muestre.
- La tarjeta muestra la diferencia con signo (`+2`, `−1`, `=`) y el valor anterior; la flecha no lleva color de «bueno» o
  «malo» (más órdenes abiertas no es malo en sí). La tendencia tiene su propio `Indicador`: una tarjeta puede ser `ok` con
  tendencia `sin-datos`.

## 3. Las seis tarjetas (criterios 1 y 3)

| # | Tarjeta | Valor | Tendencia | Fuente exacta | Estados |
| --- | --- | --- | --- | --- | --- |
| T1 | Órdenes abiertas | Órdenes del filtro en `BORRADOR`, `APROBADA`, `ENVIADA`, `PR_ABIERTO` o `REVISADA` (✅ `ESTADOS_ORDEN` sin `CERRADA` ni `CANCELADA`) | Existencia, reconstruida a hoy − 7 con AUDITORIA (§3.1) | Hoja: `ORDENES_CODEX.ESTADO`; tendencia: AUDITORIA (`orden.crear`, `orden.cerrar`, `orden.cerrar_fusionado`, `orden.cancelar`) | `sin-datos` si ORDENES_CODEX no es válida; tendencia `apagada` sin AUDITORIA |
| T2 | Fusionadas en la semana | PRs de órdenes del filtro con `merged_at` en esta semana | Flujo | GitHub: `PrFusion.fusionMs` de las listas de PRs que Inicio ya lee (✅ `githubDeAgentes`, `prsDeOrdenes`) | `apagada` sin token; `sin-datos` por proyecto si su GitHub falló; si la lista está truncada, nota «parcial» (✅ `truncados`) |
| T3 | % CONFORME a la primera | De las órdenes cerradas con fusión confirmada en la semana, % sin ninguna ronda de corrección (§3.2) | Flujo | AUDITORIA: `eventosOrdenes` (✅ `cierre`, `rondas`) | `apagada` sin AUDITORIA; `sin-datos` si ninguna orden se cerró en la semana (no es 0 % ni 100 %) |
| T4 | Hitos en riesgo | Hitos abiertos del filtro vencidos o que vencen en 7 días o menos (✅ `proyectosInicio` y `marcaDe`, `DIAS_PROXIMO`) | `sin-datos` en la v1 (§3.3) | Hoja: `HITOS.FECHA_OBJETIVO`, `HITOS.ESTADO`; avance de `TAREAS` | `sin-datos` si HITOS o TAREAS no son válidas |
| T5 | Gasto de Claude del mes | Gasto + Inversión de Claude del mes en curso, ECO + POS o el del filtro (✅ `finanzasInicio().claude.registradoCentavos`, `gastoClaudeMensual`) | Existencia: acumulado del mes a hoy contra el acumulado del mes de hoy − 7 a esa fecha (§3.4) | FINANZAS: `MOVIMIENTOS` (Herramientas, Claude), incluido el recurrente `REC-CLAUDE-AAAA-MM` confirmado | `apagada` sin `FINANZAS_SHEET_ID`; `sin-datos` con FINANZAS ilegible o filtro fuera de ECO y POS |
| T6 | Rendimiento en tokens | Último corte cerrado: `COSTO_EQUIV_USD` ÷ (suscripción + cargos extra del mes, en USD); con él, el consumo equivalente del corte | Contra el corte anterior (§3.5) | FINANZAS: `RENDIMIENTO_CLAUDE` (📄 [v3 §3.3 y §4.2](diseno-finanzas-v3.md#33-dónde-vive-el-rendimiento-pestaña-nueva-rendimiento_claude)) y la sección «Rendimiento de Claude (no suma)» de RESUMEN | `apagada` mientras la pestaña no exista o el agente de finanzas no esté activo; `sin-datos` sin cortes registrados |

### 3.1 T1: reconstruir las abiertas a hoy − 7

Una orden estaba abierta en `t` = hoy − 7 si su alta (`orden.crear`) es anterior a `t` y no tiene cierre ni
cancelación auditados anteriores a `t`. Reglas para las filas sin historia completa:

- Abierta hoy y sin alta en AUDITORIA: se creó antes de que existiera AUDITORIA, así que estaba abierta en `t`.
- CERRADA o CANCELADA hoy sin el evento auditado (✅ `cerradasSinAuditoria` de /metricas): se cerró antes de AUDITORIA,
  así que estaba cerrada en `t`.
- `eventosOrdenes` (✅) da el alta y el cierre; falta la cancelación. La construcción añade `canceladaMs` al mismo
  recorrido (`orden.cancelar` con `ESTADO` → `CANCELADA`), sin una segunda pasada por AUDITORIA.

### 3.2 T3: qué es «a la primera»

- Definición: una orden pasó «a la primera» si se cerró con `orden.cerrar_fusionado` (fusión confirmada, ✅ /metricas)
  sin ningún `orden.corregir_lanzar` con sesión (✅ `rondas` = 0). Toda corrección del dashboard nace de un dictamen
  CAMBIOS o de hallazgos del propietario, así que `rondas` = 0 equivale a que la primera revisión quedó CONFORME.
- **Por qué no se leen los dictámenes en GitHub:** desde la ORD-POS-080 /agentes no pide dictámenes de órdenes
  `CERRADA` ni `CANCELADA` (✅ `ESTADOS_SIN_DICTAMEN`), justo las de esta tarjeta; leerlos costaría hasta 5 llamadas por
  PR. AUDITORIA ya está en la carga y no cuesta llamadas a GitHub.
- Límite conocido: una corrección hecha fuera del dashboard (a mano en el PR) no deja `orden.corregir_lanzar` y la orden
  contaría como «a la primera». La tarjeta lo dice en su nota de fuente. Ver §8, pregunta 1.

### 3.3 T4: por qué no hay tendencia

HITOS no guarda cuándo un hito pasó a COMPLETADO (✅ `Hito` solo trae `actualizadoEn`, la última edición de la fila) y
el dashboard no escribe hitos, así que AUDITORIA tampoco lo sabe. Reconstruir el valor de hace 7 días obligaría a
suponer que un hito completado esta semana estaba abierto, y eso sería inventar. La tendencia es `sin-datos` con ese
motivo hasta que exista una fecha de cierre del hito (§8, pregunta 2). La tarjeta separa vencidos y próximos.

### 3.4 T5: el gasto necesita la fecha del movimiento

La vista de FINANZAS agrupa por mes y no guarda el día (✅ `Movimiento.mes`), aunque `MOVIMIENTOS.FECHA` es obligatoria
(📄 [v1 §2](diseno-finanzas.md)). La construcción añade `fecha` a `Movimiento` al leer (sin cambiar el esquema de la
hoja) para sumar «hasta el día X». Si hoy − 7 cae en el mes anterior, la tendencia compara con ese mes a esa fecha y la
tarjeta nombra el mes. Es dinero real: un solo cargo grande (la suscripción) mueve la tendencia de golpe, y es correcto.

### 3.5 T6: por qué la tendencia es por corte

`RENDIMIENTO_CLAUDE` tiene una fila por corte quincenal (📄 v3 §3.1: Q1 días 1 a 15, Q2 del 16 al fin de mes) y no tiene
detalle diario. Comparar contra «la semana anterior» obligaría a repartir un corte entre semanas, es decir, a inventar.
La tendencia de T6 es **último corte cerrado contra el anterior**, y la tarjeta lo dice («vs Q1 de octubre»). Es la única
tarjeta que se aparta de la ventana de §2.2, y solo porque la fuente es quincenal. El consumo equivalente **no es gasto**
y la tarjeta nunca lo suma a T5 (📄 v3 §1 y la nota obligatoria de `reporte-consumo`).

Hoy la vista de FINANZAS no lee `RENDIMIENTO_CLAUDE` (📄 v3 §3.3: «la vista no la lee»). La orden I-2 (§7) añade esa
lectura, solo lectura y fuera de toda suma de gasto o capital.

## 4. Las dos gráficas (criterios 2 y 3)

### G1: actividad por día

| | |
| --- | --- |
| Qué | Barras por día de los últimos 28 días: operaciones del dashboard con integridad completa en AUDITORIA, apiladas por entidad (órdenes, tareas, decisiones) |
| Cálculo | `parseAudit` y el filtro `integridad === 'completa'` de `mapaLanzamientos` (✅ `web/src/lib/agentes.ts`); en vez de día de la semana × hora, se agrupa por fecha civil con `civilHourInZone(...).date`. El filtro de proyecto usa `proyectoDeOrden` como /agentes |
| Fuente | AUDITORIA (`FECHA_HORA`, `OPERACION`, `ENTIDAD`, `ID`), leída con `auditTable` como /metricas y /agentes |
| Privacidad | AUDITORIA trae correos de actores: solo se leen para escritores (✅ `writeAccess`) y solo se muestran conteos |
| Estados | `apagada` si la escritura no está activa o el lector no es escritor (✅ los mismos dos casos de /metricas); `sin-datos` si AUDITORIA no se pudo leer o no hay operaciones en los 28 días; un día sin operaciones dentro de una AUDITORIA leída es un 0 real |

### G2: costo por rol y modelo

| | |
| --- | --- |
| Qué | Por corte (los últimos 4), barras del consumo equivalente en USD por rol (Implementador, Primer revisor, Segundo revisor, Corrector, PM, Ideas, Planeación, otro) y modelo; al lado, el costo real del mes (suscripción + cargos extra) como referencia, en otra escala |
| Cálculo | Suma por rol y modelo; el rendimiento de DEC-POS-018 (📄 v3 §4.2) es el mismo cociente de T6. Los roles son los canónicos de `reporte-consumo` (§2 de la skill) y de [operación](operacion.md) |
| Fuente | FINANZAS: pestaña nueva `RENDIMIENTO_CLAUDE_ROL` (§4.1). Hoy **no existe**: `RENDIMIENTO_CLAUDE` solo guarda el total del corte (📄 v3 §4.2) y el desglose por rol vive solo en el reporte de la sesión de `reporte-consumo` |
| Estados | `apagada` mientras `RENDIMIENTO_CLAUDE_ROL` no exista (la v1 del tablero nace así); `sin-datos` si existe sin filas del periodo; las sesiones sin `cost_usd` se muestran como «N sin dato», nunca como 0 (📄 `reporte-consumo` §1) |

### 4.1 Migración propuesta para G2 (no se hace en esta orden)

Pestaña nueva `RENDIMIENTO_CLAUDE_ROL` en FINANZAS, una fila por corte × rol × modelo, encabezados buscados por nombre:

| Columna | Formato | Regla |
| --- | --- | --- |
| `REND_ID` | `REND-CLAUDE-AAAA-MM-Q[12]` | El del corte en `RENDIMIENTO_CLAUDE` (📄 v3 §3.2); une las dos pestañas |
| `ROL` | uno de los roles canónicos u `otro` | Lo valida el servidor contra una lista fija |
| `MODELO` | `claude-…` o `sin dato` | ID del modelo que reporta la sesión; nunca un nombre inventado |
| `COSTO_EQUIV_USD` | número ≥ 0, 2 decimales | **No es gasto**; la suma por corte debe dar el `COSTO_EQUIV_USD` del corte (validación del servidor) |
| `SESIONES` / `SESIONES_SIN_DATO` | enteros ≥ 0 | Como en v3 §4.2 |

- La escribe el agente de finanzas en la misma operación de `POST /api/finanzas/agente/rendimiento` (un campo opcional
  `desglose`), con la misma idempotencia y auditoría (📄 v3 §3.2 y §6): sin desglose, el corte se registra igual y G2
  queda `sin-datos` para ese corte.
- Es escritura en FINANZAS y amplía lo que DEC-POS-018 deja escribir al agente: requiere que el propietario registre esa
  ampliación antes de construirla, y la construcción va inerte (DEC-POS-014).
- Ninguna suma de gasto ni de capital lee la pestaña, por la misma razón por la que se eligió `RENDIMIENTO_CLAUDE`
  (📄 v3 §3.3).

## 5. Llamadas a GitHub por carga y caché (criterio 4)

| Fuente | Llamadas por carga de Inicio | Caché |
| --- | --- | --- |
| GitHub, listas de PRs (T2 y el bloque Mis pendientes actual) | Las mismas que hoy, ninguna nueva: el tablero reusa `gh.prs` de `githubDeAgentes(client, filtro, null)` (✅ sin órdenes: no lee dictámenes). Por repositorio, `GET /user` una vez por cliente y hasta 5 páginas de `pulls` (✅ `MAX_PAGES`); con los 3 repositorios, 16 como máximo con la caché fría | Por repositorio `DASHBOARD_CACHE_SECONDS` (✅ 60 s por omisión, 300 s como máximo); un fallo, 60 s (`FALLO_MS`), y sin presupuesto no se guarda como fallo (✅ `prsDeProyecto`) |
| Tope duro | Cliente con `maxLlamadas: LLAMADAS_AGENTES` (✅ 40) y tiempo máximo global `LIMITE_GLOBAL_MS` (✅ 15 s), como la ORD-POS-080 | Lo que no cupo sale `sin-datos` y se lee en la carga siguiente desde la caché |
| Dictámenes | **Cero.** T3 sale de AUDITORIA (§3.2) | — |
| AUDITORIA (Sheets, no GitHub) | Una lectura por carga para escritores; hoy Inicio no la lee | Hoy `auditTable` lee sin caché (✅ `cache: 'no-store'` en `sheets-table-store.ts`). La construcción añade una caché en proceso de `DASHBOARD_CACHE_SECONDS` compartida por Inicio, /metricas y /agentes, para que abrir Inicio no sume una lectura de la API de Sheets por visita |
| FINANZAS (Sheets) | La misma lectura de hoy (✅ `getFinanzas`) | ✅ `DASHBOARD_CACHE_SECONDS`; error, 10 s |

Regla para la construcción: una prueba cuenta las llamadas del doble de GitHub en una carga de Inicio con caché fría y
comprueba que no pasan de las de hoy; con la caché caliente, cero.

## 6. Qué se reutiliza y qué es nuevo

| Pieza | Reutiliza (✅) | Nuevo |
| --- | --- | --- |
| T1 | `ESTADOS_ORDEN`, `ordenesDelFiltro`, `eventosOrdenes` | `canceladaMs` en `EventosOrden`; `abiertasEn(eventos, ordenes, t)` |
| T2 | `githubDeAgentes`, `PrFusion.fusionMs`, `truncados` | Conteo por ventana |
| T3 | `eventosOrdenes` (`cierre.fusion`, `rondas`) | Porcentaje por ventana |
| T4 | `proyectosInicio`, `marcaDe` | Conteo vencidos / próximos |
| T5 | `finanzasInicio`, `gastoClaudeMensual` | `fecha` en `Movimiento`; acumulado a una fecha |
| T6 | — | Lectura de `RENDIMIENTO_CLAUDE` en la vista de FINANZAS |
| G1 | `parseAudit`, filtro de `mapaLanzamientos`, `auditTable` | Agrupación por fecha; caché de AUDITORIA |
| G2 | Roles de `reporte-consumo` | `RENDIMIENTO_CLAUDE_ROL` (§4.1) y su lectura |
| Estados | `Indicador<T>` | Estado `apagada` |

## 7. Órdenes de construcción propuestas (criterio 5)

Para registrar como BORRADOR; no se crean desde esta orden.

### I-1 «Inicio v2: tablero de operación con T1 a T5 y G1» — riesgo **BAJO**

- **Por qué BAJO:** solo lectura de fuentes que el dashboard ya lee, sin escritura, sin permisos ni variables nuevas y
  sin llamadas nuevas a GitHub.
- **Criterios:** T1 a T5 con sus estados de §2.1 y tendencia de §2.2 (T4 con tendencia `sin-datos`); T6 y G2 en estado
  `apagada` con su motivo; G1 con sus estados; `canceladaMs` en `eventosOrdenes` y `fecha` en `Movimiento` con pruebas;
  caché de AUDITORIA de §5 con pruebas de vencimiento; la prueba de llamadas de §5; pruebas de que ningún estado
  `sin-datos` o `apagada` muestra un 0; los bloques actuales de Inicio sin cambio.
- **Fuera de alcance:** escritura, `RENDIMIENTO_CLAUDE_ROL`, lectura de dictámenes, variables, despliegue,
  `.github/workflows`.
- **Cómo probar:** `npm test`, `npm run lint` y `npm run typecheck` en `web/`; `python -m unittest discover -s tests`.

### I-2 «Inicio v2: T6, rendimiento en tokens desde RENDIMIENTO_CLAUDE» — riesgo **BAJO**

- **Por qué BAJO:** solo lectura de una pestaña que ya construyó la ORD-POS-092; sin la pestaña, `apagada`.
- **Criterios:** la vista de FINANZAS lee `RENDIMIENTO_CLAUDE` en un bloque propio que ninguna suma de gasto ni capital
  usa (prueba de que los totales no cambian con filas de rendimiento); T6 con tendencia por corte (§3.5); estados
  `apagada` sin pestaña y `sin-datos` sin cortes.
- **Depende de:** que el propietario active el agente de finanzas (📄 v3 §8.2) para que haya filas; se puede construir
  antes, inerte.

### I-3 «/finanzas v3.1: desglose por rol y modelo en RENDIMIENTO_CLAUDE_ROL, inerte» — riesgo **MEDIO**

- **Por qué MEDIO:** escritura en FINANZAS por la ruta del agente y migración de esquema (pestaña nueva), apagada por
  defecto como la ORD-POS-092 (DEC-POS-014). Revisión a ciegas, delta y segundo revisor (DEC-POS-008).
- **Requiere antes:** que el propietario registre la ampliación de DEC-POS-018 (§4.1).
- **Criterios:** campo opcional `desglose` en `rendimiento`, validado (roles fijos, suma igual al total del corte, tope
  de 📄 v3 §4.4) con la misma idempotencia y auditoría; migración explícita de `RENDIMIENTO_CLAUDE_ROL`; `reporte-consumo`
  envía el desglose que ya calcula; prueba de inercia (sin `FINANZAS_AGENTE_MODE`, cero llamadas); G2 en Inicio con sus
  estados.
- **Activación:** parte ALTO, solo del propietario: crear la pestaña en FINANZAS y desplegar.

## 8. Preguntas abiertas para el propietario

1. **T3 exacta.** ¿Basta con «sin rondas de corrección» (§3.2) o se quiere leer el dictamen PRIMERO en GitHub? Lo
   segundo exige una caché persistente de dictámenes de órdenes cerradas (que ya no cambian), porque la de hoy vive en
   memoria y se pierde en cada arranque; sería una orden MEDIO aparte.
2. **Tendencia de T4.** ¿Se añade una columna `FECHA_CIERRE` a HITOS (migración explícita en la hoja maestra) para
   tener la tendencia de hitos en riesgo? Sin ella se queda `sin-datos`.
3. **G2 y DEC-POS-018.** ¿Se registra la ampliación para guardar el desglose por rol y modelo (§4.1)? Sin ella G2 se
   queda `apagada` y el desglose sigue solo en el reporte de `reporte-consumo`.

## 9. Datos que nunca van al repositorio

Sin montos, IDs de libros, correos ni tokens: este diseño no cita cifras reales, y las pruebas de I-1 a I-3 usan datos
sintéticos. AUDITORIA solo se muestra agregada.
