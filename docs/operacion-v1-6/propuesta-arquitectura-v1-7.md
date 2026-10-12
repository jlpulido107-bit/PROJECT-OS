# PROJECT-OS V1.7 — Propuesta de arquitectura para la automatización (NO APROBADA)

> **Estado: propuesta para discusión.**
>
> - No habilita ninguna automatización, no cambia producción y no autoriza trabajo.
> - Está **separada** del [acta de cierre de la V1.6](acta-cierre-v1-6.md): aprobar la V1.6 no aprueba nada de lo que
>   sigue.
> - Cada fase exige una decisión explícita del propietario, una revisión independiente (ChatGPT) y su propia misión.
>
> Antecedentes: [backlog V1.7](backlog-v1-7.md) (hipótesis), [contrato de escritura V1.4](../v1-4-write-contract.md),
> [planificación V1.5](../v1-5-planning-contract.md), [gobierno V1.6](../v1-6-governance-contract.md) y
> [sincronización del colector](../sheets-sync-setup.md).

## 1. Objetivo

Que PROJECT-OS **gestione y actualice** de forma asistida, con aprobación humana:

- tareas;
- decisiones;
- planificación;
- avances y evidencia de los proyectos.

«Automático» significa que el sistema **propone** y **ejecuta lo aprobado**. Nunca significa que decida solo.

## 2. Principios (de `AGENTS.md`; no negociables)

| Principio | Consecuencia de diseño |
| --- | --- |
| Google Sheets es la **fuente operativa** vigente | Toda escritura acaba en la hoja; cualquier otro almacén es, como mucho, una cola o una caché |
| **Jamás inventar progreso** | Un commit o un PR es **evidencia**, no una meta cumplida. Cerrar una tarea es siempre una decisión humana |
| **IDs estables** y validación del esquema | Ninguna fila se identifica por su posición; los encabezados se validan antes de cada escritura (`esquema-invalido`) |
| Cambios de esquema con **migración explícita** | Toda columna o pestaña nueva lleva su migración revisada, aplicada a mano con autorización |
| **Auditoría** de toda escritura | Auditoría primero, como en V1.4: si la auditoría falla, no se escribe la entidad |
| **Idempotencia** | `requestId` por operación; un reintento nunca duplica |
| **Control de concurrencia** | Escritor único y versión optimista; la pérdida de actualizaciones se **detecta** (no hay CAS en Sheets) |
| **Aprobación humana** antes de operaciones de riesgo | Una cola de propuestas: nada pasa de «propuesta» a «escrito» sin aprobación |
| **Hechos ≠ inferencias ≠ propuestas** | Tres tipos de dato distintos en el modelo y en la UI (como las alertas V1.6) |
| **Reversión** | Cada escritura aprobada guarda lo necesario para deshacerla con otra escritura auditada |
| **Permisos mínimos** | Credenciales separadas para leer, proponer y escribir; nunca claves JSON de larga duración en producción |
| **Fallas parciales** | Cada paso es reanudable (roll-forward) o compensable; la conciliación las lista |
| Sin `schedule` hasta una prueba real aprobada | Toda ejecución periódica empieza siendo manual (`workflow_dispatch`) |

## 3. Punto de partida (V1.6 congelada)

| Pieza | Estado hoy |
| --- | --- |
| Dashboard | Solo lectura (`spreadsheets.readonly`), en producción |
| Motor de escritura V1.4 | Implementado y probado en modo **simulado**: auditoría primero, idempotencia, versión optimista y conciliación. **Deshabilitado** en Cloud Run (A4) |
| Planificación V1.5 | Simulación pura y determinista; nunca escribe |
| Centro de control V1.6 | Alertas con hechos, inferencias e hipótesis; la revisión es simulada |
| Colector V1.0/V1.1 | Lee GitHub. Añade `EVIDENCIAS` y `SYNC_RUNS` (solo altas, sin duplicados por `REFERENCIA_EXTERNA_ID`) **a mano y por opción**, con una clave JSON de cuenta de servicio (riesgo X-8) |

## 4. Arquitectura propuesta: capas y flujo

```
 Fuentes (solo lectura)          Motor de propuestas            Aprobación             Escritor único
 ─────────────────────           ─────────────────────          ──────────             ──────────────
 Sheets (estado actual)  ──┐     reglas deterministas    ──►   cola de propuestas ──►  motor V1.4
 GitHub (PRs, issues)    ──┼──►  (hechos → inferencias   ──►   (humano aprueba,  ──►  (auditoría primero,
 Evidencia (EVIDENCIAS)  ──┘      → propuestas)                rechaza o edita)        idempotente, versión)
                                                                                           │
                                       conciliación  ◄─────────────────────────────────────┘
                                       (detecta divergencias, pérdidas y fallas parciales)
```

1. **Lectura:** los datos de las fuentes se normalizan con IDs estables (`POS-001`, `PR#…`, `github:<repo>:<tipo>:<id>`).
2. **Propuesta:**
   - el motor produce propuestas tipadas, por ejemplo «vincular PR #12 a `POS-007`» o «mover `POS-009` a la semana
     42»;
   - cada propuesta cita sus **hechos**, su **inferencia** y su **nivel de confianza**;
   - no escribe nada.
3. **Aprobación:**
   - una persona aprueba, rechaza o edita;
   - las operaciones de riesgo (cerrar tareas, cambiar decisiones, planes de varias semanas) exigen una aprobación
     explícita **por operación**;
   - las de bajo riesgo pueden aprobarse por lote, solo si el propietario lo decide.
4. **Escritura:**
   - solo el escritor único escribe;
   - reutiliza el motor V1.4 (auditoría, idempotencia y versión), ampliado a las entidades nuevas con **migraciones**
     explícitas.
5. **Conciliación:** compara lo auditado con el estado real (`sin-efecto`, `divergente`, `actualizacion-perdida`…) y
   alimenta el centro de control.

## 5. Decisiones abiertas, con opciones

| # | Decisión | Opciones | Recomendación inicial | Depende de |
| --- | --- | --- | --- | --- |
| V7-1 | Dónde viven las propuestas | (a) Pestaña nueva `PROPUESTAS` en la hoja; (b) cola externa (p. ej. Firestore o Cloud Tasks); (c) solo en memoria y en un PR | (a): conserva Sheets como fuente única; exige una **migración** de esquema | Decisión del propietario sobre el esquema |
| V7-2 | Escritor único | (a) Dashboard con `maxScale` 1 y mutex (actual); (b) job dedicado de un solo consumidor; (c) almacén transaccional como fuente de escrituras | (a) para empezar; (b) si hay más de una fuente de escritura | D-1 resuelta; R6 del backlog |
| V7-3 | Identidad de escritura | (a) Cuenta de servicio separada solo con permiso de Editor en la hoja, con ADC y sin claves; (b) delegación del usuario con OAuth; (c) la clave JSON del colector (no recomendada) | (a), con Workload Identity Federation para GitHub Actions | X-8 (migrar el colector a OIDC) |
| V7-4 | Vinculación GitHub ↔ tareas | (a) Convención de IDs en el título o la rama del PR (`POS-007`); (b) etiquetas de GitHub; (c) inferencia por texto | (a), con validación; (c) solo como **propuesta** de baja confianza | R1 del backlog |
| V7-5 | Planificación aplicada | (a) Solo propuestas semanales aprobadas; (b) replanificación automática diaria | (a). (b) solo tras meses de (a) y con `schedule` aprobado | V1.5 y R4 |
| V7-6 | Reversión | (a) Escritura compensatoria auditada con los valores «antes» de `AUDITORIA`; (b) historial de versiones de Sheets | (a): reproducible y auditada. (b) es manual y de último recurso | Auditoría V1.4 |
| V7-7 | Frecuencia | (a) Manual (`workflow_dispatch`); (b) programada | (a) hasta una prueba real aprobada (`AGENTS.md`) | Prueba real y monitoreo |

## 6. Fases propuestas (cada una con su autorización)

| Fase | Contenido | Escribe en producción | Requisitos previos |
| --- | --- | --- | --- |
| 0 | Esquema y validación por pestaña (R2), diccionario de datos e IDs estables comprobados | No | — |
| 1 | Motor de propuestas en **solo lectura**: tareas ↔ PRs (R1), avances, alertas; se ven en el dashboard | No | Fase 0 |
| 2 | Cola de propuestas con aprobación humana, en modo **simulado** (como `mock` de V1.4) | No | Migración `PROPUESTAS` (V7-1) aprobada |
| 3 | Escritura real de **altas** de bajo riesgo aprobadas: tiempos, decisiones en estado inicial, vínculos de evidencia | Sí, limitada | Identidad de escritura (V7-3), runbook, ensayo de reversión, G1 y G2 resueltos, revisión de seguridad |
| 4 | Ediciones y planificación aprobadas | Sí | Fase 3 estable; conciliación sin divergencias durante un periodo acordado |
| 5 | Ejecución programada | Sí | Prueba real aprobada; monitoreo y alertas (X4); `schedule` autorizado |

## 7. Riesgos

| Riesgo | Efecto | Mitigación |
| --- | --- | --- |
| Pérdida de actualizaciones (Sheets sin CAS) | Un cambio humano o automático se pisa | Escritor único, versión optimista y detección `actualizacion-perdida` en la conciliación |
| Propuestas erróneas aprobadas por costumbre | Progreso inventado | Hechos, inferencias y propuestas separados; cerrar tareas nunca es automático; aprobación por operación en lo de riesgo |
| Credencial de escritura comprometida | Escrituras no autorizadas en la fuente operativa | Cuenta separada, sin claves (ADC u OIDC), solo Editor de una hoja, auditoría y alerta de divergencias |
| Falla parcial (auditoría sin entidad) | Estado intermedio | Roll-forward con el mismo `requestId`; la conciliación lo lista |
| Deriva del esquema | Escrituras en columnas equivocadas | Validación de encabezados antes de escribir (`esquema-invalido`) y migraciones explícitas |
| Costos (más lecturas, jobs) | Gasto y cuota de Sheets | Caché, lotes y presupuesto con alertas (que avisan, no cortan) |
| Varias instancias | Rompe el escritor único | `maxScale` 1 mientras haya escritura (D-1), o una cola de un solo consumidor |

## 8. Lo que esta propuesta **no** hace

- No activa `PROJECT_OS_WRITE_MODE`, no crea credenciales ni pestañas y no cambia permisos de la hoja.
- No crea workflows, `schedule`, colas ni jobs.
- No cambia la V1.6 desplegada ni su aceptación.
- No asume respuestas del propietario: las decisiones V7-1 a V7-7 están abiertas.
