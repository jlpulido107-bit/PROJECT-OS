# Órdenes: el propietario decide, Claude ejecuta (V1.8)

Cómo el propietario, ChatGPT y Claude Code comparten trabajo sin perder el control. Aplica a PROJECT-OS (POS),
SIGSAH (SIG) y RADAROS (ECO). La hoja de Google sigue siendo la fuente operativa; GitHub es donde vive el trabajo
técnico.

**Cambio del 2026-10-14 (decisión del propietario).** Hasta V1.8 F4b, Codex ejecutaba las órdenes. Su conexión con
GitHub falló de forma repetida: `@codex` en issues no inicia tareas y las tareas lanzadas a mano abrían PRs incompletos.
Desde ahora el flujo va al revés: **el propietario decide, ChatGPT planea, Claude implementa y Codex supervisa.**

**Cambio del 2026-10-16, DEC-POS-001 (decisión del propietario).** ChatGPT dirige, gestiona y supervisa las entregas de
Claude; ya no se exige transferirlas a un agente Codex separado. El propietario conserva la aprobación de órdenes y la
decisión de fusión, despliegue y cierre. Lo anterior (ORD-POS-007 / PR #50) queda como antecedente histórico; los
nombres `ORDENES_CODEX` y este documento no se renombran.

**Cambio del 2026-10-16, DEC-POS-002, DEC-POS-003 y DEC-POS-004 (ORD-POS-018).** Claude planea, implementa, revisa y
corrige en sesiones separadas; ChatGPT pasa a **auditor externo**. La revisión se gradúa por riesgo (ver
[Política de revisión por riesgo](#política-de-revisión-por-riesgo-dec-pos-003)) y la persistencia de la supervisión
queda decidida en la [migración](migracion-supervision.md#persistencia-durable-análisis-y-propuesta). Esto sustituye
el reparto de DEC-POS-001; las reglas de seguridad no cambian.

## Roles

| Quién | Hace | No hace |
| --- | --- | --- |
| Propietario | Decide y aprueba: metas, prioridades y órdenes en el dashboard; revisa, fusiona y despliega. | — |
| Claude Code | Planea (borradores que no aprueban nada), implementa, revisa y corrige, **cada función en una sesión separada**; **ejecuta las órdenes aprobadas** (rama → PR con la CI en verde), hace su autocontrol y corrige en el mismo PR. El **revisor** nunca es la sesión que implementó, usa otro modelo y revisa a ciegas (orden, diff y contrato, sin la descripción del PR). | Fusionar, desplegar, escribir en Sheets reales, ejecutar órdenes sin aprobar. |
| ChatGPT | **Auditor externo**: audita 1 de cada 5 órdenes BAJO y toda orden MEDIO antes de fusionar, y verifica las correcciones. Puede crear y actualizar registros de gestión y publicar hallazgos dentro de su autorización. | Implementar código, modificar repositorios, aprobar órdenes, disparar agentes, fusionar, desplegar o cerrar. |

## Ciclo

1. **Planear.** Claude (`/planear-proyecto`) planea y redacta la orden (un borrador no aprueba ni dispara nada); el
   propietario decide.
2. **Aprobar.** En el dashboard: *Órdenes → Nueva orden* y **Aprobar y crear el issue**. El issue lleva el título
   `[ORD-PRJ-NNN][PRJ-NNN] descripción`; si ya existe uno con ese ID, no se crea otro.
3. **Llamar.** Con la [rutina de Claude](rutina-claude.md) configurada, aprobar llama a Claude una sola vez: esa es la
   ejecución inicial y no se pide un lanzamiento manual duplicado. Solo si la rutina no está configurada o la llamada
   falla: **Ejecutar con Claude** en `/ordenes`, o **«Copiar para Claude»** y pegarlo en la sesión del repositorio
   («ejecuta ORD-PRJ-NNN»). La integración pendiente no se da por activa hasta que el propietario la confirme.
4. **Implementar.** Claude (`/ejecutar-orden`) valida la orden y la ejecuta en su rama: código, pruebas y PR con el
   `ORDEN_ID` en el título, `Closes #<issue>`, cada criterio con su evidencia y la salida de las pruebas. Lleva la CI a
   verde.
5. **Registrar.** El dashboard detecta el PR: **Registrar el PR detectado** (`PR_ABIERTO`).
6. **Revisar y auditar.** Otra sesión de Claude revisa el PR a ciegas y, si la política lo exige, ChatGPT lo audita
   (ver abajo); ambos entregan su dictamen al propietario. El aviso matutino no sustituye esos dictámenes.
7. **Decidir.** El propietario revisa el dictamen, fusiona o pide cambios. Las correcciones se devuelven a Claude, que
   las implementa en el mismo PR; la autorización es vigente por orden y no se hereda retroactivamente. Un dictamen
   favorable no autoriza fusión, despliegue ni cierre, y un PR fusionado no cierra la tarea por sí solo. Si hay que
   desplegar, Claude da el script y el propietario lo corre.

Si algún PR de una orden lo abre otro agente, `/ejecutar-orden` lo revisa contra los criterios.

## Supervisión independiente (ChatGPT)

Hay tres controles distintos. El **autocontrol** es de Claude: corre las pruebas, revisa su propio diff y lo declara en
el PR. La **revisión independiente** es de otra sesión de Claude con otro modelo, a ciegas. La **auditoría** es de
ChatGPT. El autocontrol no sustituye a ninguna. ChatGPT no implementa ni corrige código ni modifica repositorios; sí
puede crear o actualizar registros de gestión y publicar hallazgos dentro de su autorización. El dictamen del revisor y
el del auditor exigen:

- **Identificación:** orden, tarea, PR y SHA base y final revisados.
- **Evaluación por criterio:** cada criterio de aceptación como cumplido, no cumplido o no verificable, con su
  evidencia.
- **Origen de la evidencia, en fuentes separadas:** las pruebas propias del supervisor, el resultado de la CI y las
  afirmaciones del autor del PR.
- **Hallazgos:** cada uno con ID, severidad, ubicación, condición, impacto y justificación de por qué es (o no)
  bloqueante.
- **Límites:** una aprobación técnica no autoriza fusión, despliegue ni cierre; la decisión es del propietario.

**Implementación vs. supervisión.** Las instrucciones de implementación (crear la rama y el PR, publicar resultados
en el issue y el PR) son de Claude. La corrección vuelve al mismo PR y la hace Claude.

## Política de revisión por riesgo (DEC-POS-003)

La revisión cara se concentra donde un error compartido cuesta más y se limita el consumo. «Corrección automática» es
la de Claude en el mismo PR, con el límite de rondas del [contrato](contrato-supervision-automatica.md#2-estados-de-supervisión).

| Riesgo | Revisión | Auditoría de ChatGPT | Corrección automática |
| --- | --- | --- | --- |
| BAJO | El revisor Claude revisa el diff | 1 de cada 5 órdenes | Sí, hasta 2 rondas |
| BAJO solo documentación | Sin revisor automático | Entra en el muestreo | — |
| MEDIO | Revisión completa de Claude | Obligatoria antes de fusionar | 2 rondas y luego escala |
| ALTO | No se delega | — | — |

**Métrica de auditoría (decidida por el propietario).** Por cada orden auditada se cuentan los hallazgos de ChatGPT que
bloquean, que el propietario confirma como reales y que el revisor Claude no reportó. Se registra en el PR de la orden
y se resume por mes como «hallazgos solo de auditoría / órdenes auditadas». Si en un mes es mayor que 0,5, se revisa la
política.

## Qué se puede delegar

- **Sí (riesgo bajo):** pruebas, documentación, refactors locales, correcciones con criterio verificable,
  scripts de solo lectura.
- **Solo con supervisión (riesgo medio):** cambios de comportamiento visibles para usuarios, cambios de esquema
  (requieren migración explícita).
- **Nunca (para el ingeniero):** despliegues, workflows, secretos, permisos, IAM, escritura en Google Sheets o Apps
  Script reales, datos clínicos o personales, decisiones de negocio o clínicas. La gestión autorizada de ChatGPT en
  los registros del PM no cae en esta prohibición.

## Reglas para el agente

Cada repositorio tiene un `AGENTS.md`. Lo mínimo que dice para quien implementa:

- Una tarea = un PR pequeño a una rama propia. Nunca escribir en `main`.
- No fusionar, no desplegar, no cambiar `.github/workflows`, secretos ni permisos.
- Ejecutar las pruebas del repositorio y pegar la salida en el PR. Si no hay pruebas, decirlo.
- Si la tarea es ambigua o exige salir del alcance: parar y explicar en el PR, sin adivinar.
- Nunca inventar progreso ni marcar tareas como terminadas.

## Configurar la auditoría de ChatGPT (opcional)

Ya no hace falta un agente Codex separado. Si se quiere que ChatGPT lea los PRs con una conexión propia:

1. En ChatGPT, conectar GitHub (solo lectura para la revisión).
2. Dar acceso solo a `PROJECT-OS`, `SIGSAH` y `RADAROS`.
3. Crear un entorno por repositorio. Sin secretos ni variables con credenciales. Acceso a internet: apagado o
   limitado a instalar dependencias.
4. Primera prueba con una tarea de riesgo bajo, supervisada. La ejecución programada (nocturna) solo se habilita
   cuando el propietario apruebe esa prueba real.

## Vínculo con la hoja

- El ID `PRJ-NNN` en el título del issue y del PR permite enlazar el trabajo con TAREAS.
- Hoy el colector deja `TAREA_ID` en blanco a propósito (`src/sync_sheets.py`). Enlazarlo por el ID del título es
  una mejora propuesta para V1.7, pendiente de aprobación; el colector seguirá sin cerrar tareas.
