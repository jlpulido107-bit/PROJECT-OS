---
name: ejecutar-orden
description: Ejecuta una orden aprobada (ORD-PRY-NNN) del dashboard de PROJECT-OS en el repositorio de esta sesión, de la rama al PR con la CI en verde, y revisa los PRs de órdenes abiertos. Usar cuando el propietario diga «ejecuta ORD-…», pegue el texto de «Copiar para Claude», diga «revisa las órdenes» o al revisar por la mañana.
---

# Ejecutar órdenes

Flujo (decidido por el propietario el 2026-10-14): el propietario decide con Codex/ChatGPT y aprueba la orden en el
dashboard; Claude la ejecuta. Reglas: https://github.com/jlpulido107-bit/PROJECT-OS/blob/main/docs/migracion-ordenes-codex.md

## A. Ejecutar una orden

1. **Proyecto.** Identifica el proyecto por `git remote get-url origin`: PROJECT-OS → POS, SIGSAH → SIG, RADAROS → ECO.
2. **Orden.** Busca el issue cuyo título empiece por `[ORDEN_ID]` en este repositorio, creado por la cuenta del
   propietario. Si hace falta, lee la pestaña ORDENES_CODEX de la hoja `16UXe7fm90fOTTVJhI_RZ8__I876u2buvjeLGr5cJ-Ic`
   con el conector de Google Drive, **solo lectura**.
3. **Aprobación.** Ejecuta solo órdenes en `ENVIADA` (aprobadas en el dashboard, con issue). Si está en `BORRADOR`,
   `CANCELADA` o no existe, detente: la aprobación vive en el dashboard, no en el chat. Si el propietario trae una idea
   sin orden, redacta los campos para que la cree en *Órdenes → Nueva orden*.
4. **Validar.** Si falla algo, no ejecutes y di qué corregir:
   - `ORDEN_ID` con el prefijo de tu proyecto y `TAREA_ID` de tu proyecto.
   - `OBJETIVO`, `CRITERIOS_ACEPTACION`, `FUERA_DE_ALCANCE` y `COMO_PROBAR` con contenido real.
   - `RIESGO` `BAJO` o `MEDIO`; `ALTO` no se ejecuta.
   - Sin secretos, correos ni datos personales o de pacientes.
5. **Ejecutar.** En la rama de la sesión, nunca en `main`. Lee `AGENTS.md` y `CLAUDE.md` del repositorio. Haz solo lo
   que piden los criterios y respeta «Fuera de alcance». Corre las pruebas del repositorio.
6. **PR.** Título `[ORDEN_ID][TAREA_ID] TITULO`. Descripción con `Closes #N` (el issue), cada criterio con su evidencia
   y la salida de las pruebas. Lleva la CI a verde. No fusiones ni despliegues.
7. **Informar.** Devuelve un TSV con `ORDEN_ID`, `ESTADO` sugerido (`PR_ABIERTO`) y `PR_URL`. El propietario lo registra
   en el dashboard (**Registrar el PR detectado**).

## B. Revisar los PRs de órdenes (por la mañana o a pedido)

1. **Buscar.** PRs abiertos con `[ORD-` en el título.
2. **Revisar** cada uno contra su orden:
   - cada criterio de aceptación: cumplido, no cumplido o no verificable;
   - que no se salga de «Fuera de alcance»;
   - que no toque workflows, secretos, permisos ni infraestructura;
   - que traiga pruebas, y que la CI esté en verde.
3. **Evaluar.** Deja la evaluación como comentario en el PR, con el pie de Claude Code. Termina con una recomendación:
   fusionar, pedir cambios o cerrar. Si el PR es tuyo y faltan cambios, hazlos.
4. **Informar.** Devuelve un TSV con `ORDEN_ID`, `ESTADO` sugerido (`PR_ABIERTO` o `REVISADA`) y `PR_URL`.

## Límites

- No escribir en la hoja.
- No cambiar estados: solo proponerlos.
- No fusionar ni desplegar.
- No activar ejecuciones programadas: eso requiere una prueba real aprobada por el propietario.
