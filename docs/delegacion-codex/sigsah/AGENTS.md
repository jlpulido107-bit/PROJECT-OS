# Instrucciones para agentes — SIGSAH

Las reglas de trabajo y el mapa del sistema están en [`CLAUDE.md`](CLAUDE.md) y en `docs/`; aplican igual a cualquier agente.
Leer `CLAUDE.md` y los documentos de `docs/` que toque la tarea antes de cambiar nada.

## Órdenes (desde 2026-10-14 las ejecuta Claude)
- Protocolo: https://github.com/jlpulido107-bit/PROJECT-OS/blob/main/docs/delegacion-codex.md
- Solo se ejecutan órdenes aprobadas en el dashboard de PROJECT-OS: issue `[ORD-SIG-NNN]` creado por el propietario.
- Una orden = un PR pequeño con `[ORD-SIG-NNN]` al inicio del título y `Closes #N`, en una rama propia (`claude/…`).
- Nunca escribir en `main`, fusionar, desplegar ni ejecutar `clasp push`. No tocar los libros reales (UNIDO_PRUEBA,
  CREADOR DE MENUS SUSULA, producción).
- Valores clínicos y nutricionales: nunca determinarlos; solo citar la fuente. Los valida nutrición del hospital.
- Sin datos de pacientes, del personal ni credenciales en el repositorio, issues o PRs.
- Ejecutar las pruebas que existan (por ejemplo `node UNIDO/tests/<archivo>.test.js`) y pegar la salida en el PR. Si no
  hay, decirlo.
- Si la orden es ambigua o se sale del alcance: parar y explicarlo en el issue.
