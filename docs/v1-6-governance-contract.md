# PROJECT-OS V1.6 — Contrato del centro de control (decisiones, aprobaciones y ejecución)

> **Qué es:** una **capa de gobierno de solo lectura**. Reúne decisiones, bloqueos, dependencias, vencimientos,
> evidencias, discrepancias y compromisos sin capacidad, y explica **qué necesita atención y por qué**.
>
> **Qué no es:** un agente autónomo.
>
> **Qué no hace:**
> - no aprueba, cierra, envía ni ejecuta nada;
> - no escribe en Google Sheets.
>
> La revisión en pantalla es **local y simulada**.

Código: `web/src/lib/governance/`. Guía de uso: [`control-v1-6.md`](control-v1-6.md).

## 1. Principios

1. **Hechos, inferencias, hipótesis y acciones sugeridas van separados** en cada alerta (§3). Nunca se presenta una
   inferencia como un hecho ni una sugerencia como una acción realizada.
2. **No se inventan campos ni workflows.**
   - `DECISIONES.ESTADO` es un **registro**, no un sistema de autorizaciones.
   - Las solicitudes de aprobación que no caben en el esquema se modelan **solo en simulación local** (§6).
3. **Una decisión registrada no autoriza nada:** ni merge, ni despliegue, ni escritura real, ni gasto, ni cambios
   de infraestructura (§6.3).
4. **Sin falsos verdes.**
   - Si falta una pestaña o está truncada, la categoría afectada queda en "sin datos".
   - El panel nunca dice "todo bien": dice "sin alertas detectadas con los datos disponibles".
5. **Sin falsas acusaciones.** Lo que no tiene una regla formal (por ejemplo, la evidencia obligatoria) se marca como
   **revisión** con confianza baja, nunca como incumplimiento.
6. **Motor puro y determinista.**
   - Sin red, Sheets, OAuth, reloj global, azar ni IA.
   - La fecha de referencia y los datos se inyectan.
   - La misma entrada, en cualquier orden de filas, produce la misma salida.
7. **Minimización.**
   - El motor **no recibe texto libre**: ni títulos, ni notas, ni bloqueos, ni el texto de las decisiones.
   - Sus mensajes solo contienen IDs, códigos, fechas y números.
   - Los títulos que muestra la UI llegan aparte, solo para la página privada.

## 2. Inventario de datos (encabezados reales de `web/src/lib/schema.ts`, sin cambios)

| Pestaña | Columnas que usa el motor | Para qué |
| --- | --- | --- |
| `PROYECTOS` | `PROYECTO_ID`, `ESTADO` | Proyecto activo o inactivo, y referencias |
| `HITOS` | `HITO_ID`, `PROYECTO_ID`, `ESTADO`, `FECHA_OBJETIVO` | Vencimientos y coherencia con sus tareas |
| `TAREAS` | `TAREA_ID`, `PROYECTO_ID`, `HITO_ID`, `ESTADO`, `FECHA_LIMITE`, ¿`BLOQUEO` vacío? | Bloqueos, vencimientos, discrepancias |
| `DEPENDENCIAS` | `DEPENDENCIA_ID`, `TAREA_ID`, `DEPENDE_DE_TAREA_ID`, `ESTADO` | Dependencias sin resolver, ciclos, referencias rotas |
| `EVIDENCIAS` | `EVIDENCIA_ID`, `TAREA_ID`, `VERIFICACION` | Revisión de tareas completadas, vínculos rotos |
| `DECISIONES` | `DECISION_ID`, `PROYECTO_ID`, `FECHA`, `ESTADO` | Decisiones pendientes y coherencia |
| `TIEMPOS` | `SESION_ID`, `TAREA_ID` | Referencias rotas |
| `PLAN_DIARIO` | `PLAN_ID`, `FECHA`, `ESTADO` | Compromisos diarios vencidos sin cerrar |
| `PLAN_ITEMS` | `PLAN_ITEM_ID`, `PLAN_ID`, `TAREA_ID`, `MINUTOS_PLAN` | Compromisos sobre tareas no ejecutables y carga frente a capacidad |
| `CAPACIDAD_SEMANAL` | `SEMANA_ID`, `FECHA_INICIO`, `HORAS_DISPONIBLES`, `RESERVA_PCT` | Trabajo comprometido sin capacidad |
| `ASIGNACIONES` | `ASIGNACION_ID`, `SEMANA_ID`, `HORAS_OBJETIVO` | Horas asignadas frente a la capacidad |

Además, el motor recibe el **estado de lectura de cada pestaña** (legible, truncada, IDs duplicados, celdas
inválidas) y, de forma **opcional**, señales del planificador V1.5 (§7).

## 3. Anatomía de una alerta

| Campo | Significado |
| --- | --- |
| `id` | Estable: `regla-<hash8>`, donde el hash se calcula sobre la regla y los IDs ordenados de las entidades. No contiene datos privados y sirve para deduplicar y enlazar (`/control?alerta=…`) |
| `regla` | Código de la regla (§4) |
| `categoria` | `decisiones`, `bloqueos`, `dependencias`, `vencimientos`, `evidencias`, `discrepancias`, `capacidad` o `datos` |
| `tipo` | `incumplimiento`, `discrepancia`, `bloqueo`, `pendiente`, `riesgo`, `revision` o `diagnostico` |
| `severidad` | `critica`, `alta`, `media`, `baja` o `info` (§5) |
| `confianza` | **alta:** se deriva directamente de valores registrados. **media:** depende de fechas o de convenciones de estado. **baja:** heurística sin regla formal |
| `hechos[]` | Valores registrados tal cual (por ejemplo, "DECISIONES.ESTADO = PENDIENTE") |
| `inferencias[]` | Derivaciones deterministas (por ejemplo, "FECHA_LIMITE 2026-10-01 < 2026-10-09 ⇒ vencida hace 8 días") |
| `hipotesis[]` | Riesgos posibles, nunca afirmados como hechos (por ejemplo, "Riesgo de retraso del hito") |
| `acciones[]` | **Acciones sugeridas, no ejecutadas.** Siempre las hace una persona en Sheets o en GitHub |
| `entidades[]` | `{ tipo, id }` de las tareas, hitos, decisiones, proyectos, dependencias, evidencias, planes, semanas o pestañas implicadas |
| `proyectoId`, `diasVencido`, `fechaClave` | Para filtros y orden |

## 4. Reglas

Estados de referencia:

- **Tarea cerrada:** `COMPLETADO` o `CANCELADO` (igual que V1.2). **Tarea bloqueada:** estado `BLOQUEADO` o
  `BLOQUEO` no vacío.
- **Dependencia inactiva:** `RESUELTA`, `INACTIVA` o `CANCELADA`.
- **Hito cerrado:** `COMPLETADO` o `CANCELADO`.
- **Proyecto inactivo:** `COMPLETADO`, `CANCELADO`, `CERRADO`, `PAUSADO`, `SUSPENDIDO` o `ARCHIVADO`.
- **Decisión pendiente:** `PENDIENTE`, `EN_REVISION`, `PROPUESTA`, `POR_DECIDIR` o `BORRADOR`.
- **Decisión resuelta:** `APROBADA`, `RECHAZADA`, `DESCARTADA`, `CANCELADA`, `SUSTITUIDA` o `IMPLEMENTADA`.
  Cualquier otro valor es **desconocido**: se trata con seguridad, como revisión.
- **Plan diario cerrado:** `CERRADO`, `COMPLETADO`, `CANCELADO` o `DESCARTADO`.

| Regla | Categoría | Tipo | Severidad | Confianza | Condición |
| --- | --- | --- | --- | --- | --- |
| `decision-pendiente` | decisiones | pendiente | media; **alta** si `FECHA` tiene ≥ 14 días | alta | Estado pendiente |
| `decision-sin-estado` | decisiones | diagnostico | baja | alta | `ESTADO` vacío |
| `decision-estado-desconocido` | decisiones | revision | baja | media | Estado fuera de las listas |
| `decision-proyecto-inactivo` | discrepancias | discrepancia | alta | alta | Decisión pendiente de un proyecto inactivo |
| `decision-proyecto-inexistente` | discrepancias | discrepancia | media | alta | `PROYECTO_ID` vacío o no registrado |
| `tarea-bloqueada` | bloqueos | bloqueo | media; **alta** si está vencida o vence en ≤ 7 días | alta | Tarea abierta bloqueada |
| `tarea-vencida` | vencimientos | incumplimiento | alta | alta | Abierta y `FECHA_LIMITE` < referencia |
| `tarea-vence-pronto` | vencimientos | riesgo | media | media | Abierta, sin bloqueo y `FECHA_LIMITE` en [hoy, hoy + 3] |
| `tarea-sin-estado` | discrepancias | diagnostico | baja | alta | `ESTADO` vacío |
| `tarea-referencia-rota` | discrepancias | discrepancia | media | alta | `PROYECTO_ID` o `HITO_ID` no registrados |
| `tarea-completada-sin-evidencia` | evidencias | **revision** | baja | **baja** | `COMPLETADO` sin ninguna evidencia, o solo con evidencias sin `CONFIRMADO`. **No hay regla formal**: nunca es un incumplimiento y no se revierte el estado |
| `dependencia-pendiente` | dependencias | bloqueo | media; **alta** si la dependiente vence en ≤ 7 días o está vencida | alta | Activa, dependiente abierta y prerrequisito no `COMPLETADO` |
| `dependencia-inexistente` | dependencias | discrepancia | alta | alta | El prerrequisito no existe en `TAREAS` |
| `dependencia-prerrequisito-cancelado` | dependencias | discrepancia | alta | alta | El prerrequisito está `CANCELADO` |
| `dependencia-circular` | dependencias | discrepancia | **critica** | alta | Ciclo de dependencias activas sin satisfacer (una alerta por ciclo) |
| `hito-vencido` | vencimientos | incumplimiento | alta | alta | Hito abierto y `FECHA_OBJETIVO` < referencia |
| `hito-completado-con-tareas-abiertas` | discrepancias | discrepancia | alta | alta | Hito `COMPLETADO` con tareas abiertas |
| `hito-en-riesgo` | vencimientos | riesgo | media | baja | Hito abierto que vence en ≤ 7 días con tareas abiertas |
| `hito-proyecto-inexistente` | discrepancias | discrepancia | media | alta | `PROYECTO_ID` no registrado |
| `proyecto-inactivo-con-trabajo-abierto` | discrepancias | revision | media | media | Proyecto inactivo con tareas o hitos abiertos |
| `evidencia-vinculo-roto` | evidencias | discrepancia | baja | alta | `TAREA_ID` que no existe |
| `tiempo-tarea-inexistente` | discrepancias | discrepancia | baja | alta | Sesión de `TIEMPOS` con una tarea que no existe |
| `compromiso-excede-capacidad` | capacidad | incumplimiento | alta | alta | Semana ISO de referencia: `PLAN_ITEMS` > capacidad neta |
| `asignaciones-exceden-capacidad` | capacidad | riesgo | media | alta | Σ `ASIGNACIONES` > capacidad neta |
| `capacidad-no-verificable` | capacidad | diagnostico | media | alta | Hay planes o asignaciones en la semana, pero no `HORAS_DISPONIBLES` |
| `plan-con-tarea-no-ejecutable` | capacidad | discrepancia | media | alta | Elemento de un plan de hoy o futuro sobre una tarea cerrada, bloqueada o inexistente |
| `plan-diario-sin-cerrar` | capacidad | revision | baja | media | `PLAN_DIARIO` con fecha pasada y estado no cerrado (compromiso vencido sin cierre) |
| `pestana-no-disponible` | datos | diagnostico | **critica** (`TAREAS`, `DECISIONES`, `PROYECTOS`); alta (resto) | alta | Pestaña ausente, con encabezados inválidos o truncada |
| `ids-duplicados` | datos | discrepancia | media | alta | IDs repetidos en una pestaña (el lector conserva la primera fila) |
| `celdas-invalidas` | datos | diagnostico | baja | alta | Celdas con formato inválido (solo el conteo por pestaña) |
| `planificacion-*` | capacidad | riesgo / revision | alta (`sobrecarga`, `planes-exceden-capacidad`, `asignaciones-exceden-capacidad`); baja (resto) | media | Señales **opcionales** del planificador V1.5 |

**Fórmula de capacidad:** igual que V1.2 y V1.5, `neta = HORAS_DISPONIBLES × 60 × (1 − RESERVA_PCT)` en minutos
enteros; con `RESERVA_PCT` vacía se usa 0 %. La semana es ISO (lunes a domingo) y contiene la fecha de referencia;
su fila es la que tiene `FECHA_INICIO` dentro de la semana. Con dos o más filas, la capacidad no es verificable.

## 5. Severidad, cobertura y orden

- **`critica`:** impide operar o verificar (ciclo de dependencias, pestaña esencial ilegible).
- **`alta`:** incumplimiento o contradicción que exige actuar.
- **`media`:** pendiente o riesgo que conviene atender.
- **`baja`:** revisión sugerida.
- **`info`:** reservada.

**Cobertura por categoría:**

| Estado | Cuándo |
| --- | --- |
| `con-alertas` | Hay alertas de esa categoría |
| `sin-alertas-detectadas` | No hay alertas y **todas** sus pestañas se leyeron completas |
| `sin-datos` | Falta alguna pestaña necesaria |

**Estado global:**

| Estado | Cuándo |
| --- | --- |
| `critico` | Hay alguna alerta crítica |
| `requiere-atencion` | Hay alertas altas o medias |
| `datos-incompletos` | Alguna categoría está sin datos |
| `revisiones-sugeridas` | Solo hay alertas de severidad baja |
| `sin-alertas-detectadas` | Ninguna de las anteriores. **No equivale a "todo bien"** |

**Orden (desempates documentados):**

1. Severidad.
2. Tipo: incumplimiento → discrepancia → bloqueo → pendiente → riesgo → revisión → diagnóstico.
3. Días vencido (descendente).
4. Proyecto.
5. Regla.
6. IDs de las entidades (orden natural).
7. `id`.

## 6. Decisiones, aprobaciones y revisión

### 6.1 Ciclo de vida documentado (no impuesto)

`DECISIONES.ESTADO` no tiene historial. El motor no puede verificar transiciones; solo clasifica el estado actual.
Transiciones esperadas, que una persona registra en Sheets:

```
PENDIENTE / PROPUESTA / BORRADOR / EN_REVISION / POR_DECIDIR → APROBADA | RECHAZADA | DESCARTADA
APROBADA → IMPLEMENTADA | SUSTITUIDA
```

### 6.2 Revisión local (simulada)

| Estado local | Transición | Significado |
| --- | --- | --- |
| `pendiente` | (inicial) | Sin revisar en esta sesión |
| `revisado` | pendiente → revisado | Alguien la leyó; **no** la resuelve |
| `pospuesto` | pendiente → pospuesto (con fecha) | Recordatorio local; la alerta sigue existiendo |
| `resolucion-propuesta` | pendiente → resolución propuesta (texto local) | Borrador de resolución; **no** se aplica ni se envía |
| — | cualquiera → pendiente | Deshacer |

- Todo vive en memoria de la pestaña: **recargar restaura** el estado inicial.
- El aviso permanente "Simulación — no se guardaron cambios" está siempre visible.
- No hay exportación de texto libre.

**Migración futura (no incluida):** una pestaña nueva `APROBACIONES` con `APROBACION_ID`, `ENTIDAD`,
`REGISTRO_ID`, `ALCANCE`, `SOLICITADO_EN`, `RESUELTO_POR`, `RESUELTO_EN`, `ESTADO` y `EVIDENCIA_URL`. Requiere
una migración explícita y aprobada (AGENTS.md), y escribirse a través de las operaciones auditadas de V1.4.

### 6.3 Una decisión no es una autorización

`APROBADA` en `DECISIONES` **no** habilita merges, despliegues, escrituras reales, gasto ni cambios de
infraestructura. Esas autorizaciones son externas y deben ser:

- **explícitas:** las da el usuario por escrito;
- **específicas:** indican la acción, el recurso y el alcance;
- **verificables:** por ejemplo, un comentario del usuario en el PR o issue correspondiente.

La UI lo recuerda en cada decisión. Ninguna acción del panel las sustituye.

## 7. Integración (desacoplada)

- **`GovernanceInput`:** se construye con `governanceInputFromDataset(dataset)` a partir del `Dataset` actual.
- **Señales V1.5 (opcional):**
  - el campo `planificacion` es `{ semanaIso, conflictos: [{ codigo, refs }] }`;
  - coincide con `PlanResult.conflictos` del PR #10 **sin importar su código**;
  - cuando #10 esté fusionado, `/control` podrá pasarlo con una línea.
- **V1.4 (operaciones):** el panel no escribe. En una misión autorizada, "proponer resolución" podría generar un
  borrador de operación V1.4 (por ejemplo, editar el estado de una tarea), con la auditoría, la validación y la
  confirmación humana de V1.4.

## 8. Decisiones pendientes (ver también el PR)

1. **Umbrales:**
   - antigüedad de una decisión pendiente: 14 días ⇒ alta;
   - "vence pronto": 3 días;
   - ventana de riesgo de bloqueo o hito: 7 días.
2. **Evidencia:** ¿qué tipos de tarea deben exigir evidencia formalmente? Hasta definirlo, todo es revisión de
   confianza baja.
3. **Listas de estados** de decisiones, proyectos y planes: confirmar con los valores reales de la hoja.
4. **`APROBACIONES`** como pestaña futura (§6.2) frente a seguir solo con `DECISIONES`.
5. **Severidad de `tarea-vencida`:** hoy alta en todos los casos. Alternativa: crítica a partir de N días.
