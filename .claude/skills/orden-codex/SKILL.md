---
name: orden-codex
description: Envía a Codex las órdenes que el propietario aprobó en la pestaña ORDENES_CODEX de la hoja, sin duplicar, y revisa los PRs que Codex abra. Usar cuando el propietario diga «manda las órdenes», «envía a Codex», «revisa lo de Codex» o al revisar por la mañana los PRs de Codex.
---

# Órdenes a Codex

Reglas: https://github.com/jlpulido107-bit/PROJECT-OS/blob/main/docs/migracion-ordenes-codex.md

## A. Enviar órdenes aprobadas

1. **Proyecto.** Identifica el proyecto por `git remote get-url origin`: PROJECT-OS → POS, SIGSAH → SIG, RADAROS → ECO.
2. **Leer.** Lee la pestaña ORDENES_CODEX con el conector de Google Drive, **solo lectura**, en la hoja
   `16UXe7fm90fOTTVJhI_RZ8__I876u2buvjeLGr5cJ-Ic`. Si la pestaña no existe, detente y remite a la migración.
3. **Filtrar.** Toma solo las filas con `PROYECTO_ID` = tu proyecto y `ESTADO` = `APROBADA`. Nunca envíes una orden en
   `BORRADOR`, aunque te lo pidan en el chat: la aprobación vive en la hoja.
4. **Validar.** Revisa cada orden. Si falla algo, no la envíes y di qué corregir.
   - `ORDEN_ID` con el formato `ORD-<PRY>-NNN` y el prefijo de tu proyecto.
   - `TAREA_ID` existe en TAREAS y es de tu proyecto.
   - `OBJETIVO`, `CRITERIOS_ACEPTACION`, `FUERA_DE_ALCANCE` y `COMO_PROBAR` no están vacíos.
   - `RIESGO` es `BAJO` o `MEDIO`. Con `ALTO` no se envía.
   - Sin secretos, correos ni datos personales o de pacientes. Si los ves, no los copies al issue.
5. **Idempotencia.** Busca `[ORDEN_ID]` en los títulos de los issues del repositorio, abiertos y cerrados. Si ya existe,
   no crees otro: informa su URL.
6. **Crear el issue.**
   - Título: `[ORDEN_ID][TAREA_ID] TITULO`.
   - Etiqueta: `codex`, si existe.
   - Cuerpo con las secciones de la plantilla «Tarea para Codex»: ID de la tarea, Objetivo, Contexto y archivos,
     Criterios de aceptación, Fuera de alcance, Cómo probar y Riesgo. Termina con:
     «PR con `[ORDEN_ID]` en el título y `Closes #N`. No fusionar ni desplegar.»
   - Lanzar a Codex: hasta que la prueba POS-009 confirme el mecanismo, **no** lo hagas tú. Dile al propietario que lo
     lance desde Codex sobre ese issue.
7. **Informar.** Devuelve un TSV con `ORDEN_ID`, `ESTADO` sugerido (`ENVIADA`) e `ISSUE_URL`, para que el propietario
   actualice la hoja.

## B. Revisar los PRs de Codex (por la mañana)

1. **Buscar.** Busca los PRs abiertos que tengan `[ORD-` en el título.
2. **Revisar** cada uno contra su orden:
   - cada criterio de aceptación: cumplido, no cumplido o no verificable;
   - que no se salga de «Fuera de alcance»;
   - que no toque workflows, secretos, permisos ni infraestructura;
   - que traiga pruebas, y que la CI esté en verde.
3. **Evaluar.** Deja la evaluación como comentario en el PR, con el pie de Claude Code. Termina con una recomendación:
   fusionar, pedir cambios o cerrar.
4. **Informar.** Devuelve un TSV con `ORDEN_ID`, `ESTADO` sugerido (`PR_ABIERTO` o `REVISADA`) y `PR_URL`.

## Límites

- No escribir en la hoja.
- No cambiar estados: solo proponerlos.
- No fusionar ni desplegar.
- No activar ejecuciones programadas: eso requiere una prueba real aprobada por el propietario.
