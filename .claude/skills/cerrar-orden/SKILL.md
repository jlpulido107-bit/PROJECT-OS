---
name: cerrar-orden
description: Tras fusionar una o varias órdenes, deja docs/estado-actual.md al día con GitHub y con lo que el propietario indique de la hoja, en un PR pequeño de solo documentación. Usar cuando el propietario diga «cerrar-orden ORD-…». No escribe en la hoja ni cambia estados.
disable-model-invocation: true
---

# Cerrar orden (actualizar el estado actual)

Mantiene `docs/estado-actual.md` al día en un PR aparte, después de fusionar, para que los PRs de órdenes en paralelo
no choquen. Solo PROJECT-OS (no se copia a `docs/delegacion-codex/`). Riesgo BAJO, solo documentación (DEC-POS-003).

## Entrada

Uno o varios `ORDEN_ID` (`ORD-POS-NNN`). Opcional: datos de metas (HITOS) y tareas (TAREAS) que dé el propietario o el
PM en la petición. Esta sesión no lee la hoja ni usa el conector de Google Sheets.

## Pasos

1. **Comprobar.** Para cada `ORDEN_ID`, busca en GitHub el PR cuyo título empiece por `[ORDEN_ID]` y confirma que está
   **fusionado**. Si alguno no existe o no está fusionado, detente sin cambiar nada y di cuál y por qué.
2. **Leer.** `docs/estado-actual.md`, `AGENTS.md`, issues y PRs abiertos, y decisiones citadas en `docs/`.
3. **Rama.** Parte de `main` actualizado; rama propia `claude/…`, nunca `main`.
4. **Reescribir solo** las secciones `## Decisiones vigentes`, `## En curso` y `## Siguiente`, y la fecha de la
   cabecera. No toques las demás secciones ni otros archivos.
   - Cada dato lleva su fuente (enlace a issue, PR, documento o pestaña).
   - Lo que no verificaste va como **hipótesis**; no inventes progreso. Metas y tareas sin dato del propietario:
     hipótesis.
   - Quita de «En curso» lo ya fusionado; no escribas que algo está «cerrado».
   - El archivo no pasa de **60 líneas**.
5. **Pendientes del propietario.** En el cuerpo del PR (no en el archivo), lista lo que el propietario debe marcar en
   el dashboard (`REVISADA` o `CERRADA`), con su orden y PR. Tú no cambias estados.
6. **Pruebas.** `python -m unittest discover -s tests`; pega la salida en el PR.
7. **PR.** Título `[estado] Actualiza docs/estado-actual.md tras ORD-…`; las órdenes en el cuerpo; el diff toca solo
   `docs/estado-actual.md`. Ábrelo como borrador. No fusiones.

## Límites

- No escribir en la hoja ni cambiar estados: solo proponerlos.
- No fusionar ni desplegar.
- Sin secretos ni datos personales.
