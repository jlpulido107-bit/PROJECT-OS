# Instrucciones para agentes — RADAROS (proyecto ECO)

Contexto del proyecto en [`README.md`](README.md). El código de `src/legacy/` es una reconstrucción no verificada del
Apps Script desplegado: no tomarlo como verdad sin compararlo.

## Órdenes (desde 2026-10-14 las ejecuta Claude)
- Protocolo: https://github.com/jlpulido107-bit/PROJECT-OS/blob/main/docs/delegacion-codex.md
- Solo se ejecutan órdenes aprobadas en el dashboard de PROJECT-OS: issue `[ORD-ECO-NNN]` creado por el propietario.
- Una orden = un PR pequeño con `[ORD-ECO-NNN]` al inicio del título y `Closes #N`, en una rama propia (`claude/…`).
- Nunca escribir en `main`, fusionar, desplegar ni ejecutar `clasp push`. No tocar la hoja real ni Apps Script.
- Nunca subir ni pedir `ML_CLIENT_SECRET`, tokens, URLs de autorización ni códigos OAuth.
- Ejecutar las pruebas que existan y pegar la salida en el PR. Si no hay, decirlo.
- Las hipótesis de negocio (productos, mercados) las decide el propietario; no darlas por validadas.
- Si la orden es ambigua o se sale del alcance: parar y explicarlo en el issue.
