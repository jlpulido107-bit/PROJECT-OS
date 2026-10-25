# Estado actual — PROJECT-OS

Foto breve para arrancar una sesión. Fecha: 2026-10-25. Memoria duradera: [`brief-proyecto.md`](brief-proyecto.md).
Todo dato lleva su fuente; lo que no pude verificar va como **hipótesis**.
Quién hace qué, en qué entorno y cómo fluye una orden: [`operacion.md`](operacion.md).

## Decisiones vigentes

- **DEC-POS-001** (2026-10-16): ChatGPT dirige y supervisa; sustituida en el reparto por DEC-POS-002. Fuente: [delegación](delegacion-codex.md).
- **DEC-POS-002** (2026-10-16): Claude planea, implementa, revisa y corrige en sesiones separadas. Fuente: [`AGENTS.md`](../AGENTS.md).
- **DEC-POS-003** (2026-10-16): la revisión se gradúa por riesgo. Fuente: [política](delegacion-codex.md#política-de-revisión-por-riesgo-dec-pos-003).
- **DEC-POS-004** (2026-10-16): persistencia de la supervisión (D1 a D3), decidida y no implementada. Fuente: [migración](migracion-supervision.md).
- **DEC-POS-005** y **DEC-POS-007**: el PM escribe solo por la API del dashboard, nunca con el conector. Fuente: pestaña DECISIONES, según el PM; [`AGENTS.md`](../AGENTS.md).
- **DEC-POS-008** (2026-10-17): sin auditoría de ChatGPT; BAJO con revisor de otro modelo (solo docs, sin revisor); MEDIO con
  Sonnet, delta y segundo revisor Fable 5.1; máximo 2 rondas. Fuente: [delegación](delegacion-codex.md) ([PR #95](https://github.com/jlpulido107-bit/PROJECT-OS/pull/95)).
- **DEC-POS-009** (PENDIENTE del propietario): el dictamen vive solo en el PR y sustituye a D1 a D3. Fuente: [migración](migracion-supervision.md).
- **DEC-POS-010**: el [issue #205](https://github.com/jlpulido107-bit/PROJECT-OS/issues/205) la cita entre las decisiones nuevas;
  **hipótesis:** su contenido y su estado viven solo en DECISIONES.
- **DEC-POS-011** (2026-10-21): con el «sí» citado con la orden y su fecha, el PM aprueba y envía BAJO o MEDIO y marca REVISADA
  con CONFORME suficiente; CERRADA, CANCELADA y ALTO son del propietario. Fuente: [`AGENTS.md`](../AGENTS.md), [`escritura-v1-8.md` §6](escritura-v1-8.md).
- **DEC-POS-013** (enmienda de DEC-POS-008): el «sí PAQ-…» de POS · Ideas autoriza solo las altas del paquete, tras verificarlo
  el PM. Fuente: [`AGENTS.md`](../AGENTS.md); [PR #157](https://github.com/jlpulido107-bit/PROJECT-OS/pull/157) (ORD-POS-060).
- **DEC-POS-014**: ALTO se descompone en una orden MEDIO inerte más la activación del propietario. Fuente: [carril ALTO](delegacion-codex.md); [PR #160](https://github.com/jlpulido107-bit/PROJECT-OS/pull/160).
- **DEC-POS-015**: el [issue #205](https://github.com/jlpulido107-bit/PROJECT-OS/issues/205) la cita; **hipótesis:** no consta en el repositorio, vive en DECISIONES.
- **DEC-POS-016**: escritura directa limitada de POS · Ideas en NOTAS, comprobada con `scripts/notas-rutas.py`. Fuente:
  [`notas.md`](notas.md#escritura-directa-limitada-pos--ideas); issues [#178](https://github.com/jlpulido107-bit/PROJECT-OS/issues/178) y [#196](https://github.com/jlpulido107-bit/PROJECT-OS/issues/196).
- **DEC-POS-017** (APROBADA 2026-10-23): despliegue en menos de 24 h por capacidad nueva, 5 órdenes acumuladas o 7 días; el PM
  deja la nota de despliegue. Fuente: [operación](operacion.md#cuándo-se-despliega-dec-pos-017-aprobada); [issue #178](https://github.com/jlpulido107-bit/PROJECT-OS/issues/178).
- **DEC-SIG-002** (PENDIENTE, según el [issue #205](https://github.com/jlpulido107-bit/PROJECT-OS/issues/205)); **hipótesis:** su texto vive en DECISIONES.

## En curso

- Fusionadas desde el último estado (GitHub, 2026-10-25; 049 a 059 en el estado anterior):
  - PM y órdenes: 058 [#154](https://github.com/jlpulido107-bit/PROJECT-OS/pull/154), 060 [#157](https://github.com/jlpulido107-bit/PROJECT-OS/pull/157)
    («sí PAQ»), 061 [#160](https://github.com/jlpulido107-bit/PROJECT-OS/pull/160) (carril ALTO), 062 [#158](https://github.com/jlpulido107-bit/PROJECT-OS/pull/158)
    (`pm-transicion.sh`), 063 [#162](https://github.com/jlpulido107-bit/PROJECT-OS/pull/162) (REGISTRAR_PR, inerte), 071 [#175](https://github.com/jlpulido107-bit/PROJECT-OS/pull/175) (nota de despliegue y plan semanal).
  - Vistas del dashboard: 066 [#168](https://github.com/jlpulido107-bit/PROJECT-OS/pull/168) y 067 [#170](https://github.com/jlpulido107-bit/PROJECT-OS/pull/170) (/eco);
    072 [#179](https://github.com/jlpulido107-bit/PROJECT-OS/pull/179) (/metricas); 078 [#192](https://github.com/jlpulido107-bit/PROJECT-OS/pull/192) y 080 [#194](https://github.com/jlpulido107-bit/PROJECT-OS/pull/194) (/agentes).
  - /finanzas: 070 [#173](https://github.com/jlpulido107-bit/PROJECT-OS/pull/173), 074 [#182](https://github.com/jlpulido107-bit/PROJECT-OS/pull/182),
    075 [#184](https://github.com/jlpulido107-bit/PROJECT-OS/pull/184), 076 [#186](https://github.com/jlpulido107-bit/PROJECT-OS/pull/186),
    077 [#188](https://github.com/jlpulido107-bit/PROJECT-OS/pull/188) (escritura inerte sin `FINANZAS_WRITE_MODE`) y 079 [#191](https://github.com/jlpulido107-bit/PROJECT-OS/pull/191).
  - NOTAS: 065 [#166](https://github.com/jlpulido107-bit/PROJECT-OS/pull/166), 069 [#176](https://github.com/jlpulido107-bit/PROJECT-OS/pull/176),
    073 [#180](https://github.com/jlpulido107-bit/PROJECT-OS/pull/180), 081 [#198](https://github.com/jlpulido107-bit/PROJECT-OS/pull/198) (`notas-salud.py`),
    082 [#197](https://github.com/jlpulido107-bit/PROJECT-OS/pull/197) (`notas-rutas.py`) y 083 [#202](https://github.com/jlpulido107-bit/PROJECT-OS/pull/202) (ALI).
  - Otras: 064 [#164](https://github.com/jlpulido107-bit/PROJECT-OS/pull/164) (next 16.4.2) y 084 [#201](https://github.com/jlpulido107-bit/PROJECT-OS/pull/201) (escalera Ponytail en skills).
  - ORD-POS-068 no tiene PR en GitHub; **hipótesis:** se canceló o no se emitió.
- Órdenes abiertas (GitHub, 2026-10-25): ORD-POS-085 ([issue #203](https://github.com/jlpulido107-bit/PROJECT-OS/issues/203),
  [PR #204](https://github.com/jlpulido107-bit/PROJECT-OS/pull/204), sin fusionar) y ORD-POS-086 ([#205](https://github.com/jlpulido107-bit/PROJECT-OS/issues/205), este estado).
  Los PRs #51 y #116 ya no están abiertos.
- Despliegue: revisión activa `project-os-dashboard-00032-f87` (2026-10-24, commit `41f9ed8`, con 078 a 084; nota del PM en el
  [PR #194](https://github.com/jlpulido107-bit/PROJECT-OS/pull/194)); antes `00031-t7s` con 076 y 077 y `FINANZAS_SHEET_ID` ([PR #188](https://github.com/jlpulido107-bit/PROJECT-OS/pull/188)).
  Sin variables `FINANZAS_WRITE_*`: la escritura de finanzas sigue inerte. **Hipótesis:** 00028 a 00030 llevaron 060 a 075 (sin nota en el repositorio)
  y `PM_PUEDE_REGISTRAR_PR` sigue apagada.
- Rutinas: las 3 configuradas desde la revisión 00021 ([`rutina-claude.md`](rutina-claude.md)). Modelos: implementa y corrige Opus,
  revisa Sonnet, segundo revisor Fable 5.1 ([operación](operacion.md)).
- Riesgo conocido: la reserva supone una sola instancia (`maxScale: 1`); sin deduplicación multiinstancia ([migración](migracion-supervision.md)).
- Hitos, según el PM (pestaña HITOS): **POS-H1** vence 2026-10-31; **POS-H2** vence 2026-11-14 (falta la Puerta R; /metricas de
  POS-021 fusionada en el [PR #179](https://github.com/jlpulido107-bit/PROJECT-OS/pull/179)). **Hipótesis:** sin dato nuevo del PM.

## Siguiente

- Decidir DEC-POS-009, DEC-POS-010 (si sigue pendiente) y DEC-SIG-002 (propietario). Fuente: pestaña DECISIONES, según el PM.
- Revisar y decidir el PR #204 (ORD-POS-085) y este estado (ORD-POS-086).
- Activar la escritura de /finanzas con el runbook de [`diseno-finanzas-v2.md` §7.2](diseno-finanzas-v2.md) y, tras registrar la
  decisión que amplía DEC-POS-011, `PM_PUEDE_REGISTRAR_PR` (solo el propietario).
- Puerta R para POS-H2 y verificación E1 de V1.6 (el [issue #22](https://github.com/jlpulido107-bit/PROJECT-OS/issues/22) se cerró como «not planned»; **hipótesis:** sigue pendiente).

## Cómo se actualiza

Después de fusionar, en un PR aparte (evita conflictos entre PRs en paralelo), con la skill
[`cerrar-orden`](../.claude/skills/cerrar-orden/SKILL.md).
