---
name: pm-escribir-api
description: Da de alta una tarea, una decisión PENDIENTE o una orden BORRADOR de PROJECT-OS por la API de operaciones del dashboard (agente-pm, DEC-POS-005), tras el «sí» explícito del propietario. Solo la sesión PM, solo cuando el propietario lo pide.
disable-model-invocation: true
---

# PM escribe por la API de operaciones (DEC-POS-005)

Hoja: `16UXe7fm90fOTTVJhI_RZ8__I876u2buvjeLGr5cJ-Ic`. Dashboard: `https://project-os-dashboard-235975889400.northamerica-south1.run.app`.
Campos, límites y permisos: [`docs/escritura-v1-8.md`](../../../docs/escritura-v1-8.md) (§6) y `web/src/lib/operations/validation.ts`.

## Token

El proxy del entorno añade el token a las rutas `/api/operaciones/` del dashboard. Nunca lo leas, imprimas ni pidas, y
nunca pongas una cabecera `Authorization` en el `curl`. Si responde 401, detente e infórmalo: no busques otro token.

## Qué puede y qué no

- Solo **altas**: tarea (`PENDIENTE`), decisión (`PENDIENTE`) u orden (`BORRADOR`, riesgo `BAJO` o `MEDIO`).
- Nunca intentes aprobar, enviar, cancelar, registrar PR, revisar, cerrar ni ejecutar órdenes, ni cambiar `ESTADO` o
  `BLOQUEO`, ni crear una tarea con bloqueo, ni borrar o editar filas.
- Nunca escribas en Sheets con el conector. Sin secretos, correos ni datos personales, clínicos o de pacientes.

## Pasos

1. **Releer.** Justo antes de cada alta, lee la pestaña destino (`TAREAS`, `DECISIONES` u `ORDENES_CODEX`) con el
   conector de Drive, **solo lectura**. Si ya hay una fila equivalente (mismo proyecto y título o asunto), detente y
   dilo: así se evitan duplicados.
2. **Proponer y esperar.** Muestra al propietario el cuerpo completo, campo por campo, y valida los límites
   (título 160, descripción 2000, criterio 1000, responsable 80, asunto 200, decisión 2000, justificación 2000,
   textos de orden 2000). Espera un **«sí» literal** del propietario; cualquier otra respuesta o el silencio es no: no
   escribas. El «sí» puede darse en el chat del escritor o en el del PM; en el segundo caso el PM lo reenvía al escritor
   citando su texto literal (DEC-POS-008).
3. **POST.** Escribe los campos (sin `requestId`) en un archivo JSON y envíalos con el script fijo, que valida los
   límites, genera el `requestId` (UUID v4) **una sola vez**, guarda el cuerpo exacto en `<archivo>.enviado.json`
   **antes** de enviar y hace un solo `curl`, sin `Authorization`:

   ```bash
   bash scripts/pm-alta.sh <tareas|decisiones|ordenes> <archivo.json>
   ```

   Anota `requestId` y la ruta del `.enviado.json` en la conversación: son los únicos que valen para repetir esta alta.
   - `tareas`: `proyectoId`, `titulo`, `tipo`, `prioridad`, `criterioTerminado`; opcionales `hitoId`, `descripcion`,
     `responsable`, `fechaPlan`, `fechaLimite`, `horasEstimadas`.
   - `decisiones`: `proyectoId`, `asunto`, `decision`, `justificacion`, `responsable`; opcionales `fecha`, `evidenciaUrl`.
   - `ordenes`: `proyectoId`, `tareaId`, `titulo`, `objetivo`, `criterios`, `fueraDeAlcance`, `comoProbar`, `riesgo`;
     opcional `contexto`.
4. **Verificar.** Con `201`, relee la fila (una sola vez, con los valores propuestos) y `AUDITORIA` (`ACTOR` =
   `agente-pm`, `ORIGEN` termina en `;agente=pm`). Informa ID, fila y auditoría.
5. **Errores.** Si el script termina con 4xx o 5xx, detente e informa código y mensaje. Un 429 espera al menos un
   minuto.
6. **Resultado incierto.** Si el script informa fallo de transporte (salida distinta de 0 sin código HTTP, timeout) o
   no hay respuesta clara, la alta pudo escribirse: detente, informa y reconcilia releyendo la pestaña y `AUDITORIA`
   antes de cualquier otra alta.
7. **Repetir.** Nunca generes otro `requestId` ni otro cuerpo para la misma alta. Solo si el propietario autoriza
   repetir, usa `bash scripts/pm-alta.sh <tipo> <archivo.json> --repetir`, que reenvía el **mismo** `.enviado.json`
   (mismo `requestId`, idempotente); si se perdió, vuelve al paso 1.
