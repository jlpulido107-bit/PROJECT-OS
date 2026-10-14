# Órdenes: el propietario decide, Claude ejecuta (V1.8)

Cómo el propietario, Codex/ChatGPT y Claude Code comparten trabajo sin perder el control. Aplica a PROJECT-OS (POS),
SIGSAH (SIG) y RADAROS (ECO). La hoja de Google sigue siendo la fuente operativa; GitHub es donde vive el trabajo
técnico.

**Cambio del 2026-10-14 (decisión del propietario).** Hasta V1.8 F4b, Codex ejecutaba las órdenes. Su conexión con
GitHub falló de forma repetida: `@codex` en issues no inicia tareas y las tareas lanzadas a mano abrían PRs incompletos.
Desde ahora el flujo va al revés: **el propietario decide con Codex/ChatGPT y Claude ejecuta.**

## Roles

| Quién | Hace | No hace |
| --- | --- | --- |
| Propietario | Decide metas y prioridades (con apoyo de Codex/ChatGPT), aprueba las órdenes en el dashboard, revisa y fusiona PRs, despliega. | — |
| Codex / ChatGPT | Asesora al propietario: ideas, alcance, priorización. | Tocar los repositorios. |
| Claude Code | Una sesión por repositorio: redacta órdenes cuando se le pide, **ejecuta las aprobadas** (rama → PR con la CI en verde) y revisa los PRs de órdenes. | Fusionar, desplegar, escribir en la hoja, ejecutar órdenes sin aprobar. |

## Ciclo

1. **Decidir.** El propietario define qué hacer, por su cuenta o con Codex/ChatGPT. Si quiere, Claude
   (`/planear-proyecto`) redacta los campos de la orden.
2. **Aprobar.** En el dashboard: *Órdenes → Nueva orden* y **Aprobar y crear el issue**. El issue lleva el título
   `[ORD-PRJ-NNN][PRJ-NNN] descripción`; si ya existe uno con ese ID, no se crea otro.
3. **Pedir.** **«Copiar para Claude»** en `/ordenes` y pegarlo en la sesión de Claude del repositorio, o decir
   «ejecuta ORD-PRJ-NNN».
4. **Ejecutar.** Claude (`/ejecutar-orden`) valida la orden y la ejecuta en su rama: código, pruebas y PR con el
   `ORDEN_ID` en el título, `Closes #<issue>`, cada criterio con su evidencia y la salida de las pruebas. Lleva la CI a
   verde.
5. **Registrar.** El dashboard detecta el PR: **Registrar el PR detectado** (`PR_ABIERTO`).
6. **Decidir.** El propietario revisa, fusiona o pide cambios, marca la orden y actualiza la tarea. Un PR fusionado no
   cierra la tarea por sí solo. Si hay que desplegar, Claude da el script y el propietario lo corre.

Si algún PR de una orden lo abre otro agente (por ejemplo, Codex), `/ejecutar-orden` lo revisa contra los criterios.

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

## Configurar Codex (opcional, solo para asesorar)

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
