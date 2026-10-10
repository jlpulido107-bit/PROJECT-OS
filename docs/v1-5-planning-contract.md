# PROJECT-OS V1.5 — Contrato del motor de planificación

> **Qué es:** un motor **determinista y explicable** que genera **propuestas** de plan semanal y diario.
>
> **Qué no es:** IA, una agenda real ni un compromiso.
>
> **Qué no hace:**
> - no escribe en Google Sheets;
> - no guarda escenarios ni revisiones;
> - no aplica nada automáticamente.
>
> La aprobación y la escritura persistente quedan para una fase futura autorizada expresamente (ver
> [`planificacion-v1-5.md`](planificacion-v1-5.md) §6).

Código: `web/src/lib/planning/`. Pruebas: `web/tests/planning-*.test.ts` y `web/scripts/e2e-planning.mjs`.

## 1. Pureza y determinismo

`planWeek(input, escenario, { referenceDate, timeZone })` es una **función pura**:

- **No accede** a Sheets, OAuth, red, variables de entorno, reloj global (`Date.now`, `new Date()`) ni azar.
  Una prueba de seguridad lo verifica sobre el código fuente.
- **Fecha de referencia inyectada.** La calcula quien llama, con
  `referenceDateFor(instante, 'America/Merida')`:
  - la página usa el instante de lectura de los datos;
  - las pruebas usan un valor fijo.
- **Zona parametrizable.** Por defecto `America/Merida`. El motor solo trabaja con fechas civiles `YYYY-MM-DD`,
  sin conversiones UTC.
- **Mismo resultado siempre.** Misma entrada, en cualquier orden de filas, más mismo escenario y misma referencia
  ⇒ resultado idéntico. Todas las colecciones se ordenan por ID con orden natural determinista (`POS-2` < `POS-10`).
- **Huella.** `huella` es un hash FNV-1a (2 × 32 bits) de la entrada efectiva, el escenario, la referencia y la
  zona. Sirve para comprobar reproducibilidad, no para seguridad.
- **No muta la entrada.** Las pruebas la congelan en profundidad.

## 2. Entradas (solo lectura, encabezados reales de `schema.ts`)

`planningInputFromDataset(dataset)` proyecta **solo** las columnas necesarias. No incluye responsables, notas,
descripciones, URLs ni marcas de tiempo.

| Pestaña | Columnas usadas |
| --- | --- |
| `PROYECTOS` | `PROYECTO_ID`, `NOMBRE`, `ESTADO`, `PRIORIDAD` |
| `HITOS` | `HITO_ID`, `PROYECTO_ID`, `ESTADO` |
| `TAREAS` | `TAREA_ID`, `PROYECTO_ID`, `HITO_ID`, `TITULO`, `ESTADO`, `PRIORIDAD`, `FECHA_PLAN`, `FECHA_LIMITE`, `HORAS_ESTIMADAS`, `BLOQUEO` |
| `DEPENDENCIAS` | `DEPENDENCIA_ID`, `TAREA_ID`, `DEPENDE_DE_TAREA_ID`, `ESTADO` |
| `CAPACIDAD_SEMANAL` | `SEMANA_ID`, `FECHA_INICIO`, `HORAS_DISPONIBLES`, `RESERVA_PCT`, `ESTADO` |
| `ASIGNACIONES` | `ASIGNACION_ID`, `SEMANA_ID`, `PROYECTO_ID`, `HORAS_OBJETIVO` |
| `PLAN_DIARIO` | `PLAN_ID`, `FECHA`, `SEMANA_ID`, `ESTADO`, `HORAS_OBJETIVO` |
| `PLAN_ITEMS` | `PLAN_ITEM_ID`, `PLAN_ID`, `TAREA_ID`, `ORDEN`, `MINUTOS_PLAN` |
| `TIEMPOS` | `SESION_ID`, `TAREA_ID`, `FECHA`, `MINUTOS_REALES` |

También recibe dos listas:

- **Pestañas no disponibles:** ausentes, con encabezados inválidos o truncadas.
- **IDs duplicados:** el lector conserva la primera fila de cada uno.

**No hay cambios de esquema.**

## 3. Unidades y calendario

- **Duraciones:** internamente en **minutos enteros**. Horas → minutos con `round(h × 60)`. Nunca hay NaN ni
  negativos: una celda inválida llega como `null` y se trata como "sin dato".
- **`RESERVA_PCT`:** llega como fracción 0–1, porque el lector acepta `15%` o `0.15`. En el escenario, la reserva
  se expresa en **porcentaje** 0–100.
- **Semana:** ISO 8601, de lunes a domingo, con ID `AAAA-Www` (el año ISO es el del jueves). Probado en el
  cambio de año: `2027-01-01` ⇒ `2026-W53`.
- **Semana actual:** se planifica **desde la fecha de referencia** hasta el domingo.
- **Semana siguiente:** se planifica del lunes al domingo, sin días pasados.

## 4. Reglas

### 4.1 Capacidad

1. **Fila de la semana:** la de `CAPACIDAD_SEMANAL` cuya `FECHA_INICIO` cae entre el lunes y el domingo.
   - Si no es lunes, se acepta con aviso `semana-no-inicia-lunes`.
   - **Sin fila, o con `HORAS_DISPONIBLES` vacío ⇒ `datos-insuficientes`** y una pregunta concreta. No se genera
     un plan ficticio.
   - Solo el escenario "horas si falta la capacidad" permite continuar, y lo marca como **supuesto**.
   - **Dos o más filas ⇒ `ambigua`.** No se planifica hasta resolverlo.
2. **Capacidad neta:**
   `netaMin = round((HORAS_DISPONIBLES + ajuste) × 60 × (1 − reserva))`, acotada a ≥ 0.
   - `RESERVA_PCT` vacía se toma como 0 %, y se declara en `supuestos`.
   - Si el estado de la semana no es `APROBADA`, se avisa.
3. **Uso ya comprometido.** No hay doble descuento: por cada día y cada proyecto se cuenta una sola vez.
   - **Días anteriores a la referencia:** cuenta el tiempo real (`TIEMPOS`).
   - **Desde la referencia:** cuenta `máx(minutos de PLAN_ITEMS, minutos de TIEMPOS)`. Si alguien registra tiempo
     sobre un plan existente, no se resta dos veces.
   - Los planes en estado `CANCELADO` o `DESCARTADO` no reservan capacidad. Los demás se respetan íntegros y
     **nunca se alteran**.
4. **Saldo semanal y hueco colocable:**
   - `libre = máx(0, neta − uso total de la semana)` es el **saldo teórico**: incluye cuotas de días pasados que
     ya no se pueden usar.
   - `colocable = mín(libre, Σ libre(día) desde la referencia)` es lo que **realmente cabe**. Siempre se cumple
     propuesto ≤ colocable ≤ libre.
5. **Capacidad por día:**
   - la neta se reparte por igual entre los días laborables (el resto, minuto a minuto, a los primeros días);
   - un `PLAN_DIARIO` registrado con `HORAS_OBJETIVO` fija la capacidad de su día;
   - **la capacidad no usada de días pasados no se traslada** a los días restantes;
   - `libre(día) = máx(0, capacidad(día) − uso(día))`.

### 4.2 Elegibilidad (una tarea no elegible nunca se propone como ejecutable)

| Motivo | Regla |
| --- | --- |
| `cerrada` | `ESTADO` ∈ {`COMPLETADO`, `CANCELADO`}: se omite y se cuenta en `cerradasOmitidas` |
| `sin-estado` | `ESTADO` vacío |
| `bloqueada` | `ESTADO = BLOQUEADO` o `BLOQUEO` con texto |
| `dependencia-pendiente` | Dependencia activa cuyo prerrequisito no está `COMPLETADO` (un prerrequisito `CANCELADO` también bloquea y se pregunta) |
| `dependencia-inexistente` | El prerrequisito no existe en `TAREAS` |
| `ciclo-dependencias` | La tarea está en un ciclo (Tarjan, incluye autodependencias) |
| `id-duplicado` | `TAREA_ID` repetido en la hoja |
| `sin-proyecto`, `proyecto-inexistente`, `proyecto-inactivo` | Proyecto vacío, no registrado, o en estado `COMPLETADO`, `CANCELADO`, `CERRADO`, `PAUSADO`, `SUSPENDIDO` o `ARCHIVADO` |
| `programada-despues` | `FECHA_PLAN` posterior al domingo |
| `sin-estimacion` | `HORAS_ESTIMADAS` vacía o inválida, sin supuesto de escenario |
| `estimacion-agotada` | Con el supuesto de descuento activo, el tiempo registrado ya cubre la estimación |
| `ya-planificada` | Lo pendiente ya está en planes registrados de la semana |

Reglas de las dependencias:

- **Inactivas:** `RESUELTA`, `INACTIVA` y `CANCELADA` no exigen el prerrequisito.
- **Se ignoran con aviso:** las incompletas, las duplicadas (se cuentan una vez) y las de tareas inexistentes.
- **Tarea dependiente ya cerrada:** su dependencia no exige nada.

### 4.3 Necesidad de una tarea (minutos)

```
estimación = HORAS_ESTIMADAS × 60                       (o el supuesto del escenario, marcado)
estimación = round(estimación × (100 + sobrecarga%) / 100)
restante   = estimación                                  (por defecto: el tiempo registrado NO se descuenta)
restante   = máx(0, estimación − registrado)             (solo con el supuesto «descontar registrado»)
necesidad  = máx(0, restante − ya planificado desde la referencia en PLAN_ITEMS)
```

**El tiempo real no equivale a avance.** El esquema no tiene una columna de horas restantes, así que el motor
**no puede inferir el remanente**.

- Por defecto, se planifica la estimación completa menos lo ya planificado. Es la opción conservadora.
- Si lo registrado ≥ estimación, se pregunta por una re-estimación (`estimacion-excedida`).

### 4.4 Orden (desempates, de mayor a menor peso)

1. Vencida (`FECHA_LIMITE` < referencia).
2. Vence dentro de la semana (`FECHA_LIMITE` ≤ domingo).
3. Categoría de prioridad: `CRITICA` > `ALTA` > `MEDIA` > `BAJA` > desconocida o vacía.
   - Sinónimos aceptados: `URGENTE` → `CRITICA`, `NORMAL` → `MEDIA`.
   - Una prioridad desconocida **no se descarta**: va después de `BAJA` con aviso.
4. Desbloquea más tareas abiertas.
5. En curso (`EN_PROGRESO`) antes que el resto.
6. `FECHA_LIMITE` más próxima (sin fecha, al final).
7. ID en orden natural.

**Las prioridades se ordenan, no se suman.** El único número es el **peso de reparto entre proyectos**, que está
publicado:

| Prioridad del proyecto | Peso |
| --- | --- |
| `ALTA` (o `CRITICA`/`URGENTE`) | 3 |
| `MEDIA` (o `NORMAL`) | 2 |
| `BAJA` | 1 |
| Sin prioridad o desconocida | 1 |

### 4.5 Reparto semanal por proyecto (equidad sin inanición)

Sobre la capacidad libre `R`, en minutos enteros:

1. **Urgencia.** En el orden global, cada tarea vencida o que vence en la semana suma su necesidad al presupuesto
   de su proyecto.
2. **Piso anti-inanición.** Cada proyecto con demanda elegible recibe hasta **60 min** (por peso y luego por ID)
   mientras quede capacidad.
3. **Reparto proporcional.** El resto se reparte en proporción al peso (water-filling entero; si el redondeo deja
   restos, van al proyecto de mayor peso y menor ID).
4. **`ASIGNACIONES`** (si existen para la semana) son un **límite duro** por proyecto:
   `HORAS_OBJETIVO × 60 − uso del proyecto en la semana`.
   - Si suman más que la capacidad neta, hay un conflicto y **no se sobreasigna**.
   - Una asignación duplicada genera una pregunta y no limita.
5. Dentro de cada proyecto, las tareas toman su presupuesto en el orden global (pueden quedar parciales).

### 4.6 Secuencia diaria

Para cada día con capacidad libre, desde la referencia, se colocan tareas en orden global. La capacidad del día
manda, y el total nunca supera la capacidad libre semanal.

- **No antes de su `FECHA_PLAN`.** Una tarea no se coloca antes de esa fecha.
- **Pasada 1:** máximo **180 min** por tarea y día, para dar variedad y que una tarea no acapare la jornada.
- **Pasada 2:** el hueco restante se reparte **por turnos de 30 min** entre las tareas con trabajo pendiente, en el
  orden global. Una tarea solo supera los 180 min por delante de otra cuando esa otra ya no puede recibir más (sin
  objetivo pendiente o sin hueco). Así no acapara el día mientras haya alternativas.
- **Sin fragmentos menores de 30 min** en un día que ya tiene algo, salvo que sea el resto de la tarea. Un día cuya
  capacidad total es menor que un bloque sí se usa.
- **Si el presupuesto no se coloca** (por `FECHA_PLAN` o por días llenos), queda como "sin hueco diario" con
  explicación. **No se redistribuye a otros proyectos** (ver §9).

## 5. Escenarios (simulación, nunca datos)

| Parámetro | Rango | Efecto |
| --- | --- | --- |
| `semana` | `actual` / `siguiente` | Semana a planificar |
| `ajusteHoras` | −168 a 168 (pasos de 0,25) | ± horas sobre `HORAS_DISPONIBLES` |
| `reservaPct` | 0 a 100 o vacío | Reserva simulada |
| `horasSiFaltan` | 0 a 168 o vacío | Capacidad **supuesta** si no está registrada |
| `diasLaborables` | Subconjunto de 1–7 | Días entre los que se reparte la capacidad |
| `prioridadProyecto` | `ALTA` / `MEDIA` / `BAJA` por proyecto | Prioridad simulada |
| `horasSiSinEstimacion` | 0,25 a 40 o vacío | Estimación **supuesta** para tareas sin estimación |
| `sobrecargaPct` | 0 a 300 | Infla todas las estimaciones |
| `descontarRegistrado` | `true` / `false` | **Supuesto:** el tiempo registrado se descuenta de la estimación |

Reglas comunes:

- Un valor fuera de rango **se rechaza** (`ScenarioError` / HTTP 400); nunca se corrige en silencio.
- Todo supuesto aparece en `supuestos` y en la interfaz.

## 6. Salida (`PlanResult`)

- `estado`: `propuesta` o `datos-insuficientes`.
- `referencia`: fecha, zona, semana ISO, lunes, domingo y día desde el que se planifica.
- `capacidad`: origen (`dato`, `supuesto`, `faltante` o `ambigua`), horas, reserva, neta, usado, libre (saldo semanal
  teórico), colocable y propuesto.
- `proyectos[]`: prioridad (y si es simulada), peso, asignación, uso, demanda, presupuesto y propuesto.
- `tareas[]`: categoría (`propuesta`, `parcial`, `sin-capacidad` o `excluida`), motivos, estimación (y si es
  supuesta), registrado, ya planificado, necesidad, propuesto, rango, cuántas tareas desbloquea y
  **explicación en español**.
- `dias[]`: capacidad, plan existente, real, usado, libre y propuesto por día, más los bloques con orden y motivo
  corto.
- `conflictos[]` y `preguntas[]` con código, mensaje y referencias (IDs). Las preguntas son lo que el motor
  **no puede decidir**.
- `supuestos[]` y `huella`.

## 7. Invariantes (verificadas con 400 casos aleatorios reproducibles)

- **Capacidad respetada:**
  - Σ propuesto ≤ colocable ≤ saldo libre ≤ capacidad neta;
  - en cada día, propuesto ≤ libre;
  - con datos insuficientes, propuesto = 0.
- **Asignaciones respetadas:** por proyecto con asignación, propuesto ≤ asignación − uso.
- **Nunca se propone:**
  - una tarea excluida, cerrada, bloqueada, sin estado o con ID duplicado;
  - una tarea con un prerrequisito activo no `COMPLETADO`;
  - una tarea antes de su `FECHA_PLAN`;
  - una tarea sin estimación, salvo con supuesto de escenario.
- **Propuesto por tarea:** ≤ su necesidad, igual a la suma de sus bloques y una sola entrada por tarea y día.
- **Números válidos:** todos los números del resultado son finitos y ≥ 0.
- **Determinismo:** el resultado es idéntico al repetir y al barajar las filas, y la entrada no se modifica.

## 8. Ejemplos reproducibles (de `tests/planning-engine.test.ts`)

| Caso | Resultado |
| --- | --- |
| 20 h, reserva 15 % | Neta 1 020 min |
| 20 h, referencia el jueves, una tarea de 40 h | 240 min/día (jueves y viernes) ⇒ 480 min. La capacidad del lunes al miércoles no se traslada |
| Miércoles con plan de 120 min y 45 min reales | Uso del día 120 min (no 165) |
| 10 h, proyecto ALTA y MEDIA con 40 h de demanda cada uno | Piso 60 + 60, resto 480 en proporción 3:2 ⇒ **348 / 252 min** |
| Mismas prioridades | Desbloquea > en curso > límite > ID natural: `POS-5, POS-3, POS-4, POS-2, POS-10` |
| Reserva 100 % | Neta 0, nada propuesto, conflicto `capacidad-cero` |

## 9. Limitaciones conocidas

- **Una sola persona:** no se usa `RESPONSABLE` para repartir entre varias personas.
- **Sin redistribución:** el presupuesto de un proyecto que no se pudo colocar en días (`FECHA_PLAN` tardía) no se
  redistribuye a otros proyectos.
- **Sin dependencias encadenadas:** el motor no planifica un prerrequisito y su dependiente en la misma semana. El
  dependiente se habilita solo cuando una persona marca `COMPLETADO` en Sheets.
- **La equidad es semanal:** no hay memoria entre semanas.
- **Pesos fijos y documentados:** 3/2/1. Cambiarlos requiere aprobación.

## 10. Riesgos

- **Supuestos confundidos con datos.** Mitigación: cada supuesto se muestra en la interfaz y se exporta en
  `supuestos`.
- **Recomendación tomada por compromiso.** Mitigación: el aviso permanente "Simulación — sin cambios guardados", la
  revisión local y la ausencia de cualquier método para aplicar la propuesta.
