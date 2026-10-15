# Órdenes: el propietario decide, Claude ejecuta (V1.8)

Cómo el propietario, ChatGPT, Claude Code y Codex comparten trabajo sin perder el control. Aplica a PROJECT-OS (POS),
SIGSAH (SIG) y RADAROS (ECO). La hoja de Google sigue siendo la fuente operativa; GitHub es donde vive el trabajo
técnico.

**Cambio del 2026-10-14 (decisión del propietario).** Hasta V1.8 F4b, Codex ejecutaba las órdenes. Su conexión con
GitHub falló de forma repetida: `@codex` en issues no inicia tareas y las tareas lanzadas a mano abrían PRs incompletos.
Desde ahora el flujo va al revés: **el propietario decide, ChatGPT planea, Claude implementa y Codex supervisa.**

## Roles

| Quién | Hace | No hace |
| --- | --- | --- |
| Propietario | Decide y aprueba: metas, prioridades y órdenes en el dashboard; revisa, fusiona y despliega. | — |
| ChatGPT | Planea y redacta las órdenes: ideas, alcance, priorización, criterios. | Tocar los repositorios. |
| Claude Code | Implementa y corrige: una sesión por repositorio; **ejecuta las órdenes aprobadas** (rama → PR con la CI en verde) y atiende las correcciones que le devuelva la supervisión. | Fusionar, desplegar, escribir en la hoja, ejecutar órdenes sin aprobar. |
| Codex | Supervisa de forma independiente los PRs de órdenes y devuelve su reporte al propietario. | Corregir, escribir en GitHub o Sheets, fusionar, desplegar. |

## Ciclo

1. **Planear.** ChatGPT planea y redacta la orden; el propietario decide. Si quiere, Claude (`/planear-proyecto`)
   redacta los campos.
2. **Aprobar.** En el dashboard: *Órdenes → Nueva orden* y **Aprobar y crear el issue**. El issue lleva el título
   `[ORD-PRJ-NNN][PRJ-NNN] descripción`; si ya existe uno con ese ID, no se crea otro.
3. **Llamar.** Con la [rutina de Claude](rutina-claude.md) configurada, aprobar ya llama a Claude. Si no está
   configurada o la llamada falla: **Ejecutar con Claude** en `/ordenes`, o **«Copiar para Claude»** y pegarlo en la
   sesión del repositorio («ejecuta ORD-PRJ-NNN»).
4. **Implementar.** Claude (`/ejecutar-orden`) valida la orden y la ejecuta en su rama: código, pruebas y PR con el
   `ORDEN_ID` en el título, `Closes #<issue>`, cada criterio con su evidencia y la salida de las pruebas. Lleva la CI a
   verde.
5. **Registrar.** El dashboard detecta el PR: **Registrar el PR detectado** (`PR_ABIERTO`).
6. **Supervisar.** Codex revisa el PR de forma independiente (ver abajo) y entrega su reporte al propietario.
7. **Decidir.** El propietario revisa el reporte, fusiona o pide cambios. Las correcciones se devuelven a Claude, que
   las implementa en el mismo PR. Un PR fusionado no cierra la tarea por sí solo. Si hay que desplegar, Claude da el
   script y el propietario lo corre.

Si algún PR de una orden lo abre otro agente, `/ejecutar-orden` lo revisa contra los criterios.

## Supervisión independiente (Codex)

Codex supervisa; no implementa ni corrige. Su reporte exige:

- **Identificación:** orden, tarea, PR y commits base y final revisados.
- **Evaluación por criterio:** cada criterio de aceptación como cumplido, no cumplido o no verificable, con su
  evidencia.
- **Origen de la evidencia:** separar las pruebas que Codex ejecutó por su cuenta, el resultado de la CI y las
  afirmaciones del autor del PR.
- **Hallazgos:** cada uno con severidad, ubicación, condiciones, impacto y justificación de por qué es (o no)
  bloqueante.
- **Límites:** una revisión favorable no autoriza fusión, despliegue ni cierre automático; la decisión es del
  propietario.

**Implementación vs. supervisión.** Las instrucciones de implementación (crear la rama y el PR, publicar resultados
en el issue y el PR) son de Claude. La supervisión devuelve su reporte al propietario, sin escrituras externas.

## Qué se puede delegar

- **Sí (riesgo bajo):** pruebas, documentación, refactors locales, correcciones con criterio verificable,
  scripts de solo lectura.
- **Solo con supervisión (riesgo medio):** cambios de comportamiento visibles para usuarios, cambios de esquema
  (requieren migración explícita).
- **Nunca:** despliegues, workflows, secretos, permisos, IAM, escritura en Google Sheets o Apps Script reales,
  datos clínicos o personales, decisiones de negocio o clínicas.

## Reglas para el agente

Cada repositorio tiene un `AGENTS.md`. Lo mínimo que dice para quien implementa:

- Una tarea = un PR pequeño a una rama propia. Nunca escribir en `main`.
- No fusionar, no desplegar, no cambiar `.github/workflows`, secretos ni permisos.
- Ejecutar las pruebas del repositorio y pegar la salida en el PR. Si no hay pruebas, decirlo.
- Si la tarea es ambigua o exige salir del alcance: parar y explicar en el PR, sin adivinar.
- Nunca inventar progreso ni marcar tareas como terminadas.

## Configurar Codex (opcional, solo para supervisar)

1. En ChatGPT, abrir Codex y conectar GitHub (solo lectura).
2. Dar acceso solo a `PROJECT-OS`, `SIGSAH` y `RADAROS`.
3. Crear un entorno por repositorio. Sin secretos ni variables con credenciales. Acceso a internet: apagado o
   limitado a instalar dependencias.
4. Primera prueba con una tarea de riesgo bajo, supervisada. La ejecución programada (nocturna) solo se habilita
   cuando el propietario apruebe esa prueba real.

## Vínculo con la hoja

- El ID `PRJ-NNN` en el título del issue y del PR permite enlazar el trabajo con TAREAS.
- Hoy el colector deja `TAREA_ID` en blanco a propósito (`src/sync_sheets.py`). Enlazarlo por el ID del título es
  una mejora propuesta para V1.7, pendiente de aprobación; el colector seguirá sin cerrar tareas.
