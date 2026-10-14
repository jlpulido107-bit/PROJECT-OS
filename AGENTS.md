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

## Órdenes (desde 2026-10-14: el propietario decide, Claude ejecuta)
- Protocolo completo: [`docs/delegacion-codex.md`](docs/delegacion-codex.md). Rutina: `/ejecutar-orden`.
- Solo se ejecutan órdenes aprobadas en el dashboard (estado `ENVIADA`, con issue `[ORD-PRJ-NNN]`).
- Una orden = un PR pequeño con `[ORD-PRJ-NNN]` en el título y `Closes #N`; rama propia, nunca `main`. No fusionar ni desplegar.
- No cambiar `.github/workflows`, secretos, permisos ni configuración de GCP.
- Ejecutar `python -m unittest discover -s tests` y, si se toca `web/`, `npm test` en `web/`; pegar la salida en el PR.
- Si la tarea es ambigua o se sale del alcance: parar y explicarlo al propietario.
- Estados y reglas de las órdenes: [migración](docs/migracion-ordenes-codex.md); planeación por proyecto: [mano derecha](docs/mano-derecha.md).
