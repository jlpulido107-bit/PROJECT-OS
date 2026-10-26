# Órdenes: el propietario decide, Claude ejecuta (V1.8)

Cómo el propietario y Claude Code comparten trabajo sin perder el control. Aplica a PROJECT-OS (POS),
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

**Cambio del 2026-10-17, DEC-POS-008 (ORD-POS-031).** El propietario canceló a ChatGPT como auditor externo. No hay
muestreo ni auditoría externa: la revisión es solo de Claude, según el riesgo (ver la política abajo). Los cambios
anteriores quedan como antecedente histórico.

## Roles

| Quién | Hace | No hace |
| --- | --- | --- |
| Propietario | Decide y aprueba: metas, prioridades y órdenes en el dashboard; revisa, fusiona y despliega. | — |
| Claude Code | Planea (borradores que no aprueban nada), implementa, revisa y corrige, **cada función en una sesión separada**; **ejecuta las órdenes aprobadas** (rama → PR con la CI en verde), hace su autocontrol y corrige en el mismo PR. El **revisor** nunca es la sesión que implementó, usa otro modelo y revisa a ciegas (orden, diff y contrato, sin la descripción del PR). | Fusionar, desplegar, escribir en Sheets reales, ejecutar órdenes sin aprobar. |

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
6. **Revisar.** Otra sesión de Claude revisa el PR a ciegas según el riesgo (ver abajo) y entrega su dictamen al
   propietario. El aviso matutino no sustituye ese dictamen.
7. **Decidir.** El propietario revisa el dictamen, fusiona o pide cambios. Las correcciones se devuelven a Claude, que
   las implementa en el mismo PR; la autorización es vigente por orden y no se hereda retroactivamente. Un dictamen
   favorable no autoriza fusión, despliegue ni cierre, y un PR fusionado no cierra la tarea por sí solo. Si hay que
   desplegar, Claude da el script y el propietario lo corre.

Si algún PR de una orden lo abre otro agente, `/ejecutar-orden` lo revisa contra los criterios.

## Supervisión independiente

Hay dos controles distintos. El **autocontrol** es de Claude: corre las pruebas, revisa su propio diff y lo declara en
el PR. La **revisión independiente** es de otra sesión de Claude con otro modelo, a ciegas. El autocontrol no la
sustituye. El dictamen del revisor exige:

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

## Política de revisión por riesgo (DEC-POS-003, vigente con DEC-POS-008)

La revisión cara se concentra donde un error compartido cuesta más y se limita el consumo. «Corrección automática» es
la de Claude en el mismo PR, con el límite de rondas del [contrato](contrato-supervision-automatica.md#2-estados-de-supervisión).
DEC-POS-008 retiró el muestreo de 1 de cada 5 y toda auditoría externa.

| Riesgo | Revisión | Corrección automática |
| --- | --- | --- |
| BAJO | Revisor Claude a ciegas, con modelo distinto al que implementó | Sí, hasta 2 rondas |
| BAJO solo documentación | Sin revisor automático | — |
| MEDIO | Revisión completa a ciegas (Sonnet); tras cada corrección, re-revisión del delta; si la orden es sensible, segundo revisor (Fable 5.1, o gemini-supervisado) antes de fusionar | Hasta 2 rondas y luego escala |
| ALTO | No se delega tal cual (DEC-POS-014): se descompone en una orden MEDIO de código inerte por defecto más la activación del propietario; si no se puede, va en vivo con el propietario y se registra en DECISIONES | — (la orden MEDIO sigue su fila) |

**Carril ALTO (DEC-POS-014).** ALTO es el código que cambia en tiempo de ejecución la autorización o los permisos de
agentes, la escritura en la hoja o datos clínicos; los cambios solo de documentación o skills sobre esos temas son
MEDIO con doble revisor. Un ALTO nunca se reclasifica como MEDIO: se parte en
1. una orden **MEDIO** cuyo mecanismo queda **inerte por defecto** (apagado mientras falte una bandera, variable o
   secreto que solo pone el propietario; con la configuración actual nada cambia), con una prueba de que lo está;
2. la **activación del propietario**: el script exacto (comandos, comprobación y cómo revertir) que el propietario
   corre por su cuenta. Ningún agente la aplica: no despliega, no enciende la bandera en producción ni crea o monta
   secretos.

Precedentes: `WRITE_MODE` ([escritura V1.8](escritura-v1-8.md)) y ORD-POS-027 / ORD-POS-028
([acceso del agente PM](escritura-v1-8.md#6-acceso-del-agente-pm-ord-pos-027-dec-pos-005-dec-pos-011)). Si el
mecanismo no puede quedar inerte, no hay orden: el cambio se hace en vivo con el propietario y se registra en
DECISIONES. El revisor marca «riesgo mal clasificado» cuando una orden MEDIO debió ser ALTO o su código no queda
inerte por defecto ([`revisar-orden`](../.claude/skills/revisar-orden/SKILL.md#riesgo-mal-clasificado-dec-pos-014)).

El máximo es de 2 rondas de corrección por orden. El segundo revisor de MEDIO revisa a ciegas, sin el dictamen del
primero. Ningún dictamen autoriza fusión, despliegue ni cierre.

**MEDIO sensible y SEGUNDO gemini-supervisado (DEC-POS-019 y DEC-POS-022, ORD-POS-100).** La columna `SENSIBLE` de
ORDENES_CODEX ([migración](migracion-ordenes-codex.md#columna-sensible-dec-pos-019)) decide si un MEDIO necesita
segundo revisor: con `NO`, un CONFORME de `PRIMERO` o `DELTA` basta para «Listo para tu decisión»; vacía, ausente o
`SI` = sensible, y sigue exigiendo un `SEGUNDO` CONFORME de otro modelo sobre el mismo head. El `SEGUNDO` puede ser:
- de origen `claude` (o sin origen): su modelo, de otra familia que la del `PRIMERO` o `DELTA`;
- de origen `gemini-supervisado`: los hallazgos los produce Gemini (`modeloHallazgos`, de otra familia que la del
  `PRIMERO` o `DELTA`) y una sesión de Claude los confirma o descarta uno por uno con evidencia (`hallazgosGemini`) y
  firma; el modelo del firmante no es el del implementador (Opus).

«Otro modelo» se compara por familia (Opus, Sonnet, Haiku, Fable, Gemini), nunca por el texto libre de `modelo`: un
sufijo distinto del mismo modelo o un nombre inventado no cuentan. Formato:
[contrato §3.1](contrato-supervision-automatica.md#contrato-versión-2-rol-y-modelo-del-revisor).

## Qué se puede delegar

- **Sí (riesgo bajo):** pruebas, documentación, refactors locales, correcciones con criterio verificable,
  scripts de solo lectura.
- **Solo con supervisión (riesgo medio):** cambios de comportamiento visibles para usuarios, cambios de esquema
  (requieren migración explícita).
- **Nunca (para el ingeniero):** despliegues, workflows, secretos, permisos, IAM, escritura en Google Sheets o Apps
  Script reales, datos clínicos o personales, decisiones de negocio o clínicas.

## Reglas para el agente

Cada repositorio tiene un `AGENTS.md`. Lo mínimo que dice para quien implementa:

- Una tarea = un PR pequeño a una rama propia. Nunca escribir en `main`.
- No fusionar, no desplegar, no cambiar `.github/workflows`, secretos ni permisos.
- Ejecutar las pruebas del repositorio y pegar la salida en el PR. Si no hay pruebas, decirlo.
- Si la tarea es ambigua o exige salir del alcance: parar y explicar en el PR, sin adivinar.
- Nunca inventar progreso ni marcar tareas como terminadas.

## Vínculo con la hoja

- El ID `PRJ-NNN` en el título del issue y del PR permite enlazar el trabajo con TAREAS.
- Hoy el colector deja `TAREA_ID` en blanco a propósito (`src/sync_sheets.py`). Enlazarlo por el ID del título es
  una mejora propuesta para V1.7, pendiente de aprobación; el colector seguirá sin cerrar tareas.
