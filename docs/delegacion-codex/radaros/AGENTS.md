# Instrucciones para agentes — RADAROS (proyecto ECO)

Contexto del proyecto en [`README.md`](README.md). El código de `src/legacy/` es una reconstrucción no verificada del
Apps Script desplegado: no tomarlo como verdad sin compararlo.

## Delegación a Codex
- Protocolo: https://github.com/jlpulido107-bit/PROJECT-OS/blob/main/docs/delegacion-codex.md
- Una tarea = un issue «Tarea para Codex» y un PR pequeño con `[ECO-NNN]` en el título, en una rama `codex/ECO-NNN-…`.
- Nunca escribir en `main`, fusionar, desplegar ni ejecutar `clasp push`. No tocar la hoja real ni Apps Script.
- Nunca subir ni pedir `ML_CLIENT_SECRET`, tokens, URLs de autorización ni códigos OAuth.
- Ejecutar las pruebas que existan y pegar la salida en el PR. Si no hay, decirlo.
- Las hipótesis de negocio (productos, mercados) las decide el propietario; no darlas por validadas.
- Si la tarea es ambigua o se sale del alcance: parar y explicarlo en el PR.
