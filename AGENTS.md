# Instrucciones para agentes — PROJECT-OS

## Roles
- Propietario: aprueba las órdenes y decide fusión, despliegue y cierre.
- Claude Code (DEC-POS-002, 2026-10-16; sustituye el reparto de DEC-POS-001): planea (borradores que no aprueban nada),
  implementa, revisa y corrige, cada función en una sesión separada. El revisor nunca es la sesión que implementó, usa
  otro modelo y revisa a ciegas: solo la orden, el diff y el contrato, sin la descripción del PR.
- ChatGPT: auditor externo. Audita 1 de cada 5 órdenes de riesgo BAJO y toda orden de riesgo MEDIO antes de fusionar.
  No implementa código ni modifica repositorios. La gestión y los hallazgos que publique en los registros del PM
  quedan dentro de lo que el propietario autorice.
- No se exige un agente Codex separado. «Codex» sobrevive solo en nombres históricos (`ORDENES_CODEX`, `docs/delegacion-codex.md`).

Ciclo: implementación y autocontrol de Claude → revisión ciega de otra sesión de Claude (otro modelo) → auditoría de
ChatGPT cuando la política por riesgo la exige → decisión del propietario. Las correcciones vuelven a Claude, en el
mismo PR. Política por riesgo: [`docs/delegacion-codex.md`](docs/delegacion-codex.md#política-de-revisión-por-riesgo-dec-pos-003).
Un dictamen favorable (del revisor o del auditor) no autoriza fusión, despliegue ni cierre.

## Reglas
- No escribir directamente en main; trabajar con ramas y PR.
- No fusionar ni ejecutar despliegues sin autorización.
- No modificar código de repositorios fuente desde aquí.
- Google Sheets es la fuente operativa; jamás inventar progreso. La prohibición de escribir en Sheets reales aplica
  al ingeniero (Claude); no anula la gestión autorizada de ChatGPT como PM.
- No registrar secretos, tokens, datos clínicos ni datos personales.
- Los cambios de esquema requieren migración explícita, no cambios silenciosos.
- Reglas de estados, auditoría, concurrencia, IDs estables e idempotencia son obligatorias.
- Validar tests y diff antes de pedir revisión.
- No habilitar `schedule` hasta que el usuario apruebe una prueba real.
- El colector solo lee; no cierra tareas ni toma decisiones de negocio.

## Implementación y supervisión
- Quien implementa (Claude) crea la rama y el PR y publica los resultados en el issue y el PR. Su autocontrol (pruebas
  propias, revisión de su diff) no sustituye la revisión independiente.
- Quien revisa (otra sesión de Claude) y quien audita (ChatGPT) no son quien implementó: entregan su dictamen al
  propietario; ChatGPT puede publicar hallazgos y actualizar registros de gestión solo dentro de su autorización.
  Detalle del dictamen en
  [`docs/delegacion-codex.md`](docs/delegacion-codex.md#supervisión-independiente-chatgpt).
- Claude se ejecuta una sola vez al aprobar la orden en el dashboard; no se pide un lanzamiento manual duplicado.

## Órdenes (desde 2026-10-14: el propietario decide, Claude ejecuta)
- Protocolo completo: [`docs/delegacion-codex.md`](docs/delegacion-codex.md). Rutina: `/ejecutar-orden`.
- Solo se ejecutan órdenes aprobadas en el dashboard (estado `ENVIADA`, con issue `[ORD-PRJ-NNN]`).
- Una orden = un PR pequeño con `[ORD-PRJ-NNN]` en el título y `Closes #N`; rama propia, nunca `main`. No fusionar ni desplegar.
- No cambiar `.github/workflows`, secretos, permisos ni configuración de GCP.
- Ejecutar `python -m unittest discover -s tests` y, si se toca `web/`, `npm test` en `web/`; pegar la salida en el PR.
- Si la tarea es ambigua o se sale del alcance: parar y explicarlo al propietario.
- Estados y reglas de las órdenes: [migración](docs/migracion-ordenes-codex.md); planeación por proyecto: [mano derecha](docs/mano-derecha.md).
