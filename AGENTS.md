# Instrucciones para agentes — PROJECT-OS

## Roles
- Propietario: aprueba las órdenes y decide fusión, despliegue y cierre.
- Claude Code (DEC-POS-002, 2026-10-16; sustituye el reparto de DEC-POS-001): planea (borradores que no aprueban nada),
  implementa, revisa y corrige, cada función en una sesión separada. El revisor nunca es la sesión que implementó, usa
  otro modelo y revisa a ciegas: solo la orden, el diff y el contrato, sin la descripción del PR.
- Sin auditor externo (DEC-POS-008, 2026-10-17): el propietario canceló a ChatGPT. No se exige un agente Codex
  separado; «Codex» sobrevive solo en nombres históricos (`ORDENES_CODEX`, `docs/delegacion-codex.md`).

Ciclo: implementación y autocontrol de Claude → revisión ciega de otra sesión de Claude según el riesgo (en MEDIO, con
segundo revisor) → decisión del propietario. Las correcciones vuelven a Claude, en el mismo PR, con máximo 2 rondas.
Política por riesgo: [`docs/delegacion-codex.md`](docs/delegacion-codex.md#política-de-revisión-por-riesgo-dec-pos-003) (vigente con DEC-POS-008).
Guía de operación (roles, modelos, entornos, rutinas y flujo por riesgo en una página): [`docs/operacion.md`](docs/operacion.md).
Notas de ideas en Obsidian (repositorio NOTAS, qué leen los agentes y qué no): [`docs/notas.md`](docs/notas.md).
Un dictamen favorable no autoriza fusión, despliegue ni cierre.

## Reglas
- No escribir directamente en main; trabajar con ramas y PR.
- No fusionar ni ejecutar despliegues sin autorización.
- No modificar código de repositorios fuente desde aquí.
- Google Sheets es la fuente operativa; jamás inventar progreso. Las sesiones de implementación y de revisión no
  escriben en Sheets reales ni usan el conector de Google Sheets.
- Escritura del PM (DEC-POS-005): solo la sesión PM (Claude) escribe, únicamente por la API de operaciones del dashboard
  (tareas, decisiones PENDIENTE y órdenes BORRADOR), con la skill `pm-escribir-api` y tras el «sí» explícito del
  propietario; nunca cancela ni cierra nada ni cambia ESTADO o BLOQUEO de tareas. DEC-POS-011 (2026-10-21): con el «sí»
  citado y su fecha puede aprobar y enviar órdenes (nunca de riesgo ALTO) y marcar REVISADA con un dictamen válido del
  head actual; CERRADA y CANCELADA siguen siendo del propietario. Nadie escribe en Sheets con el conector. Un solo escritor.
  REVISADA exige CONFORME según DEC-POS-011: de PRIMERO o DELTA y, en MEDIO sensible, también SEGUNDO de otro modelo en el
  mismo head. MEDIO no sensible (columna SENSIBLE = NO) basta con PRIMERO o DELTA; vacía = sensible (DEC-POS-019). Un
  SEGUNDO gemini-supervisado (DEC-POS-022) mide «otro modelo» con el de los hallazgos (Gemini) y lo firma una sesión de
  Claude de modelo distinto del implementador; un modelo no reconocido nunca cuenta.
  REGISTRAR_PR del PM (ORD-POS-063) está apagado: solo con `PM_PUEDE_REGISTRAR_PR=true`, que enciende únicamente el
  propietario con `deploy.sh` tras registrar la decisión que amplía DEC-POS-011, registra el PR que /ordenes detecta.
  Ningún agente enciende esa bandera.
  DEC-POS-013 (enmienda de DEC-POS-008): el «sí PAQ-AAAA-MM-DD-NN» que el propietario da en la sesión POS · Ideas
  autoriza solo las altas de ese paquete, y solo después de que el PM lo verifica en la fuente (`pm-escribir-api`,
  sección «Altas con sí PAQ»); aprobar, enviar, cancelar y cerrar no cambian: un «sí PAQ» nunca vale para ellos.
- No registrar secretos, tokens, datos clínicos ni datos personales.
- Los cambios de esquema requieren migración explícita, no cambios silenciosos.
- Reglas de estados, auditoría, concurrencia, IDs estables e idempotencia son obligatorias.
- Validar tests y diff antes de pedir revisión.
- No habilitar `schedule` hasta que el usuario apruebe una prueba real.
- El colector solo lee; no cierra tareas ni toma decisiones de negocio.

## Implementación y supervisión
- Quien implementa (Claude) crea la rama y el PR y publica los resultados en el issue y el PR. Su autocontrol (pruebas
  propias, revisión de su diff) no sustituye la revisión independiente.
- Quien revisa (otra sesión de Claude, con otro modelo) no es quien implementó: entrega su dictamen al propietario. En
  MEDIO sensible, el SEGUNDO puede ser gemini-supervisado: Gemini aporta los hallazgos y una sesión de Claude de modelo
  distinto del implementador confirma o descarta cada uno con evidencia y firma (DEC-POS-022).
  Detalle del dictamen en
  [`docs/delegacion-codex.md`](docs/delegacion-codex.md#supervisión-independiente).
- Claude se ejecuta una sola vez al aprobar la orden en el dashboard; no se pide un lanzamiento manual duplicado.

## Órdenes (desde 2026-10-14: el propietario decide, Claude ejecuta)
- Protocolo completo: [`docs/delegacion-codex.md`](docs/delegacion-codex.md). Rutina: `/ejecutar-orden`.
- Solo se ejecutan órdenes aprobadas en el dashboard (estado `ENVIADA`, con issue `[ORD-PRJ-NNN]`).
- Una orden = un PR pequeño con `[ORD-PRJ-NNN]` en el título y `Closes #N`; rama propia, nunca `main`. No fusionar ni desplegar.
- No cambiar `.github/workflows`, secretos, permisos ni configuración de GCP.
- Ejecutar `python -m unittest discover -s tests` y, si se toca `web/`, `npm test` en `web/`; pegar la salida en el PR.
- Si la tarea es ambigua o se sale del alcance: parar y explicarlo al propietario.
- Estados y reglas de las órdenes: [migración](docs/migracion-ordenes-codex.md); planeación por proyecto: [mano derecha](docs/mano-derecha.md).
