# Plan V1.8 — Todo desde el dashboard y revisión automática de Codex

**Decidido por el propietario el 2026-10-13:**
1. El dashboard escribe en la hoja, pero solo para el propietario y solo en ciertas pestañas.
2. Al aprobar una orden en el dashboard, se envía a Codex en ese momento.
3. Claude revisa cada mañana los PRs de Codex.

Cada fase es un PR independiente, con pruebas. Ningún despliegue ni cambio de GCP se hace sin autorización expresa.

| Fase | Qué entrega | Cambia la seguridad | Infraestructura que aplica el propietario |
| --- | --- | --- | --- |
| **F1. Lectura de órdenes** | Página `/ordenes`: órdenes con su estado, issue y PR. Se lee `ORDENES_CODEX` | No: solo lectura | Redesplegar |
| **F2. Escritura real limitada** | Modo `sheets` activo solo para `AUTH_WRITER_EMAILS` y solo en `ORDENES_CODEX`, `TAREAS`, `TIEMPOS`, `DECISIONES` y `AUDITORIA` | **Sí** | Cuenta de servicio de escritura dedicada, Editor solo de la hoja. La cuenta del dashboard la suplanta. Dos variables nuevas |
| **F3. Órdenes en el dashboard** | Crear orden en `BORRADOR`, aprobar y cancelar desde `/ordenes`, con auditoría y control de versión | Usa F2 | Redesplegar |
| **F4. Envío a GitHub al aprobar** | Al aprobar: busca el issue por `ORDEN_ID` para no duplicarlo, lo crea, menciona a `@codex` y escribe `ENVIADA` con el `ISSUE_URL`. `/ordenes` muestra el PR que abra Codex | **Sí**: un token de GitHub en el servicio | Token de grano fino (Issues: lectura y escritura; Pull requests: lectura) solo para los 3 repos, en Secret Manager |
| **F5. Revisión matutina** | Rutina programada de Claude: cada mañana revisa los PRs `[ORD-…]` contra sus criterios, comenta en el PR y nunca fusiona | No toca el dashboard | Solo la aprobación expresa, después de que la prueba `ORD-POS-001` salga bien (regla de `AGENTS.md`) |

## Principios que se mantienen

- **Hoja.** Sigue siendo la fuente operativa. El dashboard escribe por nombre de columna, con `RAW` y auditoría por
  campo (contrato V1.4).
- **Lectura y escritura separadas.** El lector conserva el alcance `spreadsheets.readonly`. La escritura usa otra
  identidad.
- **Escritor único.** Mientras `maxScale` sea 1, solo hay un escritor. Se mantiene la concurrencia optimista con
  `VERSION`.
- **Cierres.** Nada se cierra solo: una orden `CERRADA` no cierra su tarea, y el dashboard no cierra tareas.
- **Fusiones.** Codex nunca fusiona y Claude nunca fusiona sin la autorización del propietario.
