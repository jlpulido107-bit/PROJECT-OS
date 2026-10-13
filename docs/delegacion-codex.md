# Delegación a Codex (V1.7, fase 2)

Cómo el propietario, Claude Code y Codex comparten trabajo sin perder el control. Aplica a PROJECT-OS (POS),
SIGSAH (SIG) y RADAROS (ECO). La hoja de Google sigue siendo la fuente operativa; GitHub es donde vive el trabajo
técnico.

## Roles

| Quién | Hace | No hace |
| --- | --- | --- |
| Propietario | Decide metas y prioridades, aprueba tareas para Codex, revisa y fusiona PRs. | — |
| Claude Code | Revisa el estado, redacta tareas para Codex, revisa los PRs de Codex por la mañana. | Fusionar o desplegar sin autorización. |
| Codex | Ejecuta una tarea acotada y abre un PR con evidencia de pruebas. | Fusionar, desplegar, tocar secretos, escribir en sistemas reales. |

## Ciclo

Desde V1.7, las órdenes se aprueban en la pestaña ORDENES_CODEX de la hoja
([migración](migracion-ordenes-codex.md), [modelo de trabajo](mano-derecha.md)).

1. **Redactar.** En la sesión del proyecto, `/planear-proyecto` propone la orden como una fila en estado `BORRADOR`, ligada a
   una tarea de TAREAS.
2. **Aprobar.** El propietario la pega en la hoja y la pasa a `APROBADA`.
3. **Enviar.** `/orden-codex` valida la orden y abre el issue «Tarea para Codex». El título es
   `[ORD-PRJ-NNN][PRJ-NNN] descripción`, y si ya hay un issue con ese ID no se crea otro.
4. **Delegar.** El propietario lanza la tarea en Codex desde el issue. Si se puede lanzar mencionando a Codex en el
   issue, se confirma en la primera prueba (POS-009).
5. **Entregar.** Codex trabaja en una rama `codex/…` y abre un PR con el `ORDEN_ID` en el título, `Closes #<issue>` y la
   salida de las pruebas.
6. **Revisar.** Por la mañana, `/orden-codex` revisa el PR contra los criterios y deja su evaluación.
7. **Decidir.** El propietario fusiona, pide cambios o cierra, y actualiza la orden y la tarea en la hoja. Un PR
   fusionado no cierra la tarea por sí solo.

## Qué se puede delegar

- **Sí (riesgo bajo):** pruebas, documentación, refactors locales, correcciones con criterio verificable,
  scripts de solo lectura.
- **Solo con supervisión (riesgo medio):** cambios de comportamiento visibles para usuarios, cambios de esquema
  (requieren migración explícita).
- **Nunca:** despliegues, workflows, secretos, permisos, IAM, escritura en Google Sheets o Apps Script reales,
  datos clínicos o personales, decisiones de negocio o clínicas.

## Reglas para el agente

Cada repositorio tiene un `AGENTS.md` (Codex lo lee al empezar). Lo mínimo que dice:

- Una tarea = un PR pequeño a una rama propia. Nunca escribir en `main`.
- No fusionar, no desplegar, no cambiar `.github/workflows`, secretos ni permisos.
- Ejecutar las pruebas del repositorio y pegar la salida en el PR. Si no hay pruebas, decirlo.
- Si la tarea es ambigua o exige salir del alcance: parar y explicar en el PR, sin adivinar.
- Nunca inventar progreso ni marcar tareas como terminadas.

## Configurar Codex (una vez, lo hace el propietario)

1. En ChatGPT, abrir Codex y conectar GitHub.
2. Dar acceso solo a `PROJECT-OS`, `SIGSAH` y `RADAROS`.
3. Crear un entorno por repositorio. Sin secretos ni variables con credenciales. Acceso a internet: apagado o
   limitado a instalar dependencias.
4. Primera prueba con una tarea de riesgo bajo, supervisada. La ejecución programada (nocturna) solo se habilita
   cuando el propietario apruebe esa prueba real.

## Vínculo con la hoja

- El ID `PRJ-NNN` en el título del issue y del PR permite enlazar el trabajo con TAREAS.
- Hoy el colector deja `TAREA_ID` en blanco a propósito (`src/sync_sheets.py`). Enlazarlo por el ID del título es
  una mejora propuesta para V1.7, pendiente de aprobación; el colector seguirá sin cerrar tareas.
