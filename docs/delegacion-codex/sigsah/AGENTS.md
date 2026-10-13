# Instrucciones para agentes — SIGSAH

Las reglas de trabajo y el mapa del sistema están en [`CLAUDE.md`](CLAUDE.md) y en `docs/`; aplican igual a Codex.
Leer `CLAUDE.md` y los documentos de `docs/` que toque la tarea antes de cambiar nada.

## Delegación a Codex
- Protocolo: https://github.com/jlpulido107-bit/PROJECT-OS/blob/main/docs/delegacion-codex.md
- Una tarea = un issue «Tarea para Codex» y un PR pequeño con `[SIG-NNN]` en el título, en una rama `codex/SIG-NNN-…`.
- Nunca escribir en `main`, fusionar, desplegar ni ejecutar `clasp push`. No tocar los libros reales (UNIDO_PRUEBA,
  CREADOR DE MENUS SUSULA, producción).
- Valores clínicos y nutricionales: nunca determinarlos; solo citar la fuente. Los valida nutrición del hospital.
- Sin datos de pacientes, del personal ni credenciales en el repositorio, issues o PRs.
- Ejecutar las pruebas que existan (por ejemplo `node UNIDO/tests/<archivo>.test.js`) y pegar la salida en el PR. Si no
  hay, decirlo.
- Si la tarea es ambigua o se sale del alcance: parar y explicarlo en el PR.
