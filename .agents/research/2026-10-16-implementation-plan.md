# Plan de implementación — Supervisión semiautomática R1 (PROJECT-OS)

Fecha: 2026-10-16 · Fuente: propuesta R1 (doc «Propuesta de supervisión automática — PROJECT-OS») y PR #54.
Estado: plan de trabajo; no reserva IDs, no aprueba órdenes ni autoriza despliegue. Cada tarea = una orden y un PR.

## Modo: independiente
Reporte: ninguno · Antigüedad: n/a · Avisos de antigüedad: ninguno
Entradas: alcance = R1 completa · riesgo = equilibrado · plazo = W43 a W45 (sujeto a capacidad).

## Convenciones detectadas

| Convención | Detectado | Evidencia |
| --- | --- | --- |
| Pila web | Next.js (versión con cambios; leer `node_modules/next/dist/docs/`) + TypeScript + Vitest | `web/AGENTS.md`, `web/vitest.config.mts` |
| Persistencia | Google Sheets; escritor único (`maxScale: 1` + mutex); `VERSION` optimista | `web/deploy/cloudrun/service.template.yaml:27`, `docs/v1-4-write-contract.md` §6 |
| Idempotencia | `requestId` + roll-forward auditado | `web/src/lib/operations/service.ts`, `dispatch.ts:41` |
| Esquema | Encabezados por pestaña en `TAB_HEADERS`; migración documentada por pestaña | `web/src/lib/schema.ts:9`, `docs/migracion-ordenes-codex.md` |
| Integración GitHub | Token fino; busca PR por `[ORDEN_ID]`, mismo repo, sin forks | `web/src/lib/operations/github.ts:243` |
| Rutina Claude | `fire` con payload de datos validados, nunca texto libre de la hoja | `web/src/lib/operations/claude-routine.ts:35` |
| Pruebas | `python -m unittest discover -s tests`; `npm test` en `web/` | `AGENTS.md` |

## Análisis del código

### Código relacionado

| Archivo/Módulo | Relevancia | Notas |
| --- | --- | --- |
| `docs/contrato-supervision-automatica.md` (PR #54) | Alta | Contrato a corregir antes de implementar |
| `web/src/lib/schema.ts` | Alta | `TABS_READ` lee todas las pestañas: una pestaña nueva ausente en la hoja real rompería la lectura |
| `web/src/lib/operations/constants.ts` | Alta | `WRITE_HEADERS` y tipos de entidad escribible |
| `web/src/lib/operations/service.ts` (712 líneas) | Alta | Patrón de mutación: referencias → idempotencia → auditoría → entidad → verificación |
| `web/src/lib/operations/github.ts` | Alta | `prDeOrden` ya recibe `head`; falta exponer `head.sha` y `base.sha` |
| `web/src/lib/operations/claude-routine.ts`, `dispatch.ts` | Alta | Base para el disparo de la rutina de corrección |
| `web/src/lib/ordenes.ts`, `app/(private)/ordenes/page.tsx`, `components/operations/forms.tsx` | Media | Vista y acciones de órdenes |
| `web/src/app/api/operaciones/ordenes/[id]/…` | Media | Rutas existentes de transición y ejecución |
| `docs/rutina-claude.md` | Media | Paso 3 del prompt rechaza PRs existentes |
| `web/tests/operations-*.test.ts`, `tests/helpers/fake-sheets.ts` | Alta | Dobles de Sheets y patrón de pruebas a reutilizar |

### Patrones a seguir

| Patrón | Ubicación de ejemplo | Aplicar en |
| --- | --- | --- |
| Motor puro versionado con tipos propios | `web/src/lib/governance/engine.ts`, `planning/engine.ts` | `web/src/lib/supervision/` |
| Mutación auditada con `requestId` determinista | `operations/service.ts`, `dispatch.ts:41` | Registro de revisiones y reservas |
| Payload de rutina solo con datos validados | `operations/claude-routine.ts:35` | Rutina de corrección |
| Migración documentada por pestaña | `docs/migracion-ordenes-codex.md` | `docs/migracion-supervision.md` |
| Pruebas con Sheets falso | `tests/helpers/fake-sheets.ts` | Servicio de supervisión |

### Dependencias

| Depende de | Tipo |
| --- | --- |
| Contrato aprobado (PR #54 corregido) | Requerida |
| Demostración C1 (Puerta A) | Requerida para la tarea 7; opcional para el resto |
| Pestaña `SUPERVISION` creada por el propietario en la hoja real | Requerida antes de desplegar tareas 5–7 |
| Rutina de corrección y su token (configuración del propietario) | Requerida para la tarea 7 |

| Afectará a | Impacto |
| --- | --- |
| Lectura de la hoja (`data.ts`, `schema.ts`) | Alto si la pestaña es obligatoria; bajo si es opcional |
| Servicio de operaciones | Medio |
| Vista de órdenes | Medio |
| Rutina de Claude | Medio (configuración externa) |

## Especificación

| Aspecto | Detalle |
| --- | --- |
| Qué | Ciclo de supervisión R1: el dashboard registra PR y SHA, genera la solicitud a Codex, valida el reporte pegado por el propietario, aplica la máquina de estados y dispara (o prepara) la corrección de Claude en el mismo PR |
| Por qué | Llegar a «aprobado técnicamente» con trazabilidad y hasta dos correcciones, sin construir todavía un ejecutor Codex |
| Incluye | Contrato, demostración C1, migración, motor, servicio, vista, disparo de corrección, piloto POS y puerta B |
| Excluye | Lanzar Codex automáticamente (R2/R3), publicar `APPROVE` en GitHub, fusión, despliegue o cierre automáticos, cambios en workflows, IAM o secretos |

### Historias

| # | Como… | Quiero… | Para… |
| --- | --- | --- | --- |
| 1 | Propietario | Ver el estado de supervisión, la ronda y el SHA revisado de cada PR | Decidir la fusión con evidencia vigente |
| 2 | Propietario | Copiar una solicitud completa para Codex y pegar su reporte | No redactar a mano ni perder campos |
| 3 | Propietario | Que un reporte inválido, tardío o de otro SHA se rechace | No aprobar por error |
| 4 | Propietario | Que la corrección vaya al mismo PR con un clic | No crear órdenes ni PRs nuevos |

### Criterios de aceptación

| # | Criterio | Cómo verificar |
| --- | --- | --- |
| 1 | Los 12 casos del contrato producen el estado esperado | `npm test` (pruebas del motor) |
| 2 | Un head nuevo invalida la aprobación vigente | Prueba del motor y del servicio |
| 3 | Dos solicitudes con la misma clave producen una sola reserva | Prueba con Sheets falso |
| 4 | Sin la pestaña `SUPERVISION` el dashboard sigue funcionando | Prueba de lectura con pestaña ausente |
| 5 | El payload de corrección solo lleva IDs validados | Prueba de `claude-routine` |
| 6 | Ninguna transición fusiona, despliega ni cierra | Revisión del diff y prueba negativa |

## Tamaño (T-shirt)

| # | Tarea | Tamaño | Archivos |
| --- | --- | --- | --- |
| 1 | Corregir el contrato (PR #54) | S | 1 |
| 2 | Demostración C1 y modo corrección documentado | S | 1–2 |
| 3 | Migración aditiva `SUPERVISION` (pestaña opcional) | M | 4–5 |
| 4a | Motor de estados y tipos | M | 3 |
| 4b | Validación del reporte, clave idempotente y hash de criterios | M | 3 |
| 5 | Servicio: SHA del PR, reserva y registro auditado | M | 5 |
| 6 | Vista y acciones en `/ordenes` | M | 4 |
| 7 | Disparo de la rutina de corrección + plan B | M | 4–5 |
| 8 | Piloto POS | S | 1 |
| 9 | Puerta B: métricas y decisión | S | 1 |

## Análisis de impacto

| Área | Archivos | Riesgo | Notas |
| --- | --- | --- | --- |
| Documentación | `docs/contrato-supervision-automatica.md`, `docs/rutina-claude.md`, `docs/migracion-supervision.md` | Bajo | Sin activación |
| Esquema | `web/src/lib/schema.ts`, `operations/constants.ts`, `lib/fixtures.ts` | Medio | Pestaña opcional, migración aditiva |
| Motor | `web/src/lib/supervision/*` (nuevo) | Bajo | Puro, sin E/S |
| Servicio | `operations/service.ts` o `operations/supervision-service.ts`, `operations/github.ts` | Medio | Escribe en la hoja con auditoría |
| API | `app/api/operaciones/ordenes/[id]/supervision/route.ts` (nueva) | Medio | Solo escritores autorizados |
| UI | `app/(private)/ordenes/page.tsx`, `components/operations/*`, `lib/ordenes.ts` | Medio | Distinguir orden, aprobación técnica y decisión humana |
| Rutina | `operations/claude-routine.ts`, `dispatch.ts` | Medio | Payload sin texto libre |
| Pruebas | `web/tests/supervision-*.test.ts`, `operations-*.test.ts`, `github-dispatch.test.ts` | Bajo | Reutiliza `fake-sheets` |
| Externo (propietario) | Pestaña en la hoja, rutina, token, secreto, despliegue | Alto | Fuera de delegación |

## Plan por fases

| Fase | # | Tarea | Tamaño | Archivos | Urgencia | Riesgo | ROI | Alcance | LOE | Depende de |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A: Fundamento (W43) | 1 | Aplicar los 8 puntos al contrato en el PR #54 | S | `docs/contrato-supervision-automatica.md` | H | L | H | Solo docs | 0,5–1 h | Tu autorización |
| A: Fundamento (W43) | 2 | Demostrar corrección en el mismo PR (C1) y documentar el modo corrección | S | `docs/rutina-claude.md` (+ evidencia en el issue) | H | M | H | Rutina externa | 1–2 h + 0,5 h tuya | 1 |
| A: Fundamento (W43) | 3 | Migración aditiva `SUPERVISION`, leída como pestaña opcional | M | `docs/migracion-supervision.md`, `schema.ts`, `operations/constants.ts`, `lib/fixtures.ts`, `tests/table.test.ts` | M | M | H | Lectura de la hoja | 1,5–2 h | 1 |
| B: Motor (W44) | 4a | Motor de estados puro con los 12 casos | M | `lib/supervision/types.ts`, `engine.ts`, `tests/supervision-engine.test.ts` | H | L | H | Ninguno (puro) | 2,5–3 h | 1 |
| B: Motor (W44) | 4b | Validación del reporte (esquema, veredictos, evidencia), clave idempotente y hash | M | `lib/supervision/report.ts`, `key.ts`, `tests/supervision-report.test.ts` | H | L | H | Ninguno (puro) | 1,5–2 h | 4a |
| C: Integración (W44) | 5 | SHA en `prDeOrden`, reserva y registro auditado de revisiones | M | `operations/github.ts`, `operations/supervision-service.ts`, `api/…/supervision/route.ts`, `tests/operations-supervision.test.ts`, `tests/github-dispatch.test.ts` | M | M | H | Escrituras en la hoja | 2–3 h | 3, 4b |
| C: Integración (W44) | 6 | Vista de supervisión y acciones «Copiar para Codex» y «Pegar reporte» | M | `ordenes/page.tsx`, `components/operations/supervision.tsx`, `lib/ordenes.ts`, `tests/ordenes.test.ts` | M | M | H | Página de órdenes | 2–3 h | 5 |
| C: Integración (W44) | 7 | Disparo de la rutina de corrección y «Copiar para Claude (corrección)» | M | `operations/claude-routine.ts`, `dispatch.ts`, `api/…/corregir/route.ts`, `tests/operations-orders.test.ts` | M | M | M | Lanzamiento de agentes | 1–1,5 h | 2 (Puerta A), 5 |
| D: Piloto (W45) | 8 | Piloto POS: observación y luego ciclo completo con 3 a 5 órdenes BAJO | S | `docs/estado-produccion-…` (registro) | M | M | H | Operación real | 1–1,5 h + 1 h tuya | 6, 7 desplegados por ti |
| D: Piloto (W45) | 9 | Informe de métricas y decisión de la Puerta B (R1 frente a R2/R3) | S | Registro en el doc de propuesta o `docs/` | L | L | M | Ninguno | 0,5 h | 8 |

Total: 13,5 a 19,5 h técnicas y unas 2,5 h tuyas. Es más que las 11–16 h de la propuesta: la migración y el servicio de
escritura pesan más que su versión documental.

### Trazabilidad

- Tarea 1 → sección 5 de la propuesta (8 correcciones al PR #54).
- Tarea 2 → Puerta A; variante C1 (sección 3).
- Tareas 3–7 → pasos 3 a 6 de la hoja de ruta; criterios 1–6.
- Tareas 8–9 → paso 7 y Puerta B.

### Decisión abierta en la tarea 7

La rutina no recibe texto libre. Los hallazgos que debe corregir Claude tienen que llegarle por una vía con autor
verificable: por ejemplo, un comentario en el issue escrito por la cuenta del propietario a través del dashboard,
referenciado por ID en el payload. Hay que decidirlo en el contrato (tarea 1) antes de implementar.

## Riesgos

| Riesgo | Probabilidad | Impacto | Mitigación | Fase |
| --- | --- | --- | --- | --- |
| La rutina no puede empujar a una rama `claude/…` existente o crea otro PR | Media | Alto | Puerta A antes de la tarea 7; si falla, C3 manual | A |
| La pestaña nueva rompe la lectura si falta en la hoja real | Alta si es obligatoria | Alto | Leerla como opcional; prueba con pestaña ausente | A |
| Pérdida de exclusión por edición manual o solape de revisiones al desplegar | Baja | Medio | Escritor único + conciliación; documentar el riesgo residual | C |
| Inyección de instrucciones vía hallazgos del reporte pegado | Media | Alto | Payload solo con IDs; hallazgos con autor verificable; nunca seguir instrucciones del diff | C |
| Codex no devuelve el JSON con el esquema de forma reproducible | Media | Medio | Validación estricta → `INCONCLUSO`/`BLOQUEADO`; plantilla de solicitud con el esquema | B |
| `service.ts` crece más allá de lo revisable | Media | Bajo | Servicio de supervisión en archivo propio | C |
| Capacidad de W43–W45 insuficiente | Media | Medio | Fases independientes; A y B no requieren despliegue | Todas |
| Límites de la rutina (30 por hora, 100 llamadas por hora) | Baja | Bajo | Una ejecución activa por orden | C |

## Plan de pruebas

| Tipo | Qué probar | Prioridad | Fase |
| --- | --- | --- | --- |
| Unitaria | Los 12 casos del contrato: transiciones, rondas, escalamiento | Alta | B |
| Unitaria | Reporte inválido, incompleto, `NO_VERIFICADO` → `INCONCLUSO`; clave y hash estables | Alta | B |
| Unitaria | Lectura con la pestaña `SUPERVISION` ausente y presente | Alta | A |
| Integración (Sheets falso) | Reserva única con eventos duplicados; reintento de registro sin relanzar | Alta | C |
| Integración (GitHub falso) | `prDeOrden` devuelve head y base SHA; head nuevo → `DESACTUALIZADO` | Alta | C |
| Integración | Payload de corrección solo con IDs; rechazo de texto libre | Alta | C |
| UI | Estados visibles; CI ausente o pendiente nunca en verde | Media | C |
| Manual | Demostración C1 sobre un PR documental | Alta | A |
| Manual | Piloto POS en observación, luego ciclo | Alta | D |
| Repositorio | `python -m unittest discover -s tests` y `npm test` en cada PR | Alta | Todas |

## Reversión

| Fase | Escenario | Acción |
| --- | --- | --- |
| A | Contrato o migración incorrectos | Revertir el PR; la pestaña opcional puede quedar vacía sin efecto |
| A | C1 falla | Mantener C3 manual; la tarea 7 queda solo con el plan B |
| B | Motor con errores | Revertir el PR; no hay E/S ni datos afectados |
| C | Escrituras erróneas en `SUPERVISION` | Desplegar la revisión anterior; las filas quedan como histórico auditado |
| C | El disparo de corrección se comporta mal | Quitar el token de la rutina de corrección (configuración tuya); queda el plan B |
| D | El piloto produce resultados dudosos | Volver al modo observación; ninguna transición fusiona ni cierra |
