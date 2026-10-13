# Instrucciones para agentes — PROJECT-OS

## Roles
- Usuario: dueño del producto y aprobación final.
- ChatGPT: arquitectura, prioridades, revisión y especificaciones.
- Claude Code: implementación, pruebas y propuesta de cambios.

## Reglas
- No escribir directamente en main; trabajar con ramas y PR.
- No fusionar ni ejecutar despliegues sin autorización.
- No modificar código de repositorios fuente desde aquí.
- Google Sheets es la fuente operativa; jamás inventar progreso.
- No registrar secretos, tokens, datos clínicos ni datos personales.
- Los cambios de esquema requieren migración explícita, no cambios silenciosos.
- Reglas de estados, auditoría, concurrencia, IDs estables e idempotencia son obligatorias.
- Validar tests y diff antes de pedir revisión.
- No habilitar `schedule` hasta que el usuario apruebe una prueba real.
- El colector solo lee; no cierra tareas ni toma decisiones de negocio.

## Delegación a Codex
- Protocolo completo: [`docs/delegacion-codex.md`](docs/delegacion-codex.md).
- Una tarea = un issue con la plantilla «Tarea para Codex» y un PR pequeño con `[PRJ-NNN]` en el título.
- Trabajar en una rama propia (`codex/PRJ-NNN-…`); nunca en `main`. No fusionar ni desplegar.
- No cambiar `.github/workflows`, secretos, permisos ni configuración de GCP.
- Ejecutar `python -m unittest discover -s tests` y, si se toca `web/`, `npm test` en `web/`; pegar la salida en el PR.
- Si la tarea es ambigua o se sale del alcance: parar y explicarlo en el PR.
