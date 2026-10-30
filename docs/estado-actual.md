# Estado actual — PROJECT-OS

Foto breve para arrancar una sesión. Fecha: 2026-10-29. Memoria duradera: [`brief-proyecto.md`](brief-proyecto.md).
Todo dato lleva su fuente; lo que no pude verificar va como **hipótesis**.
Quién hace qué, en qué entorno y cómo fluye una orden: [`operacion.md`](operacion.md).

## Decisiones vigentes

- **DEC-POS-001** a **DEC-POS-004** (2026-10-16): Claude planea, implementa, revisa y corrige en sesiones separadas (002 sustituye
  a 001); revisión por riesgo (003); D1 a D3 decididas y no implementadas (004). Fuente: [delegación](delegacion-codex.md), [migración](migracion-supervision.md).
- **DEC-POS-005** y **DEC-POS-007**: el PM escribe solo por la API del dashboard. **DEC-POS-011** (2026-10-21): con el «sí» citado
  aprueba y envía BAJO o MEDIO y marca REVISADA; CERRADA, CANCELADA y ALTO son del propietario. Fuente: [`AGENTS.md`](../AGENTS.md).
- **DEC-POS-008** (2026-10-17): sin ChatGPT; BAJO de solo docs sin revisor; MEDIO con Sonnet y delta. Fuente: [delegación](delegacion-codex.md) ([#95](https://github.com/jlpulido107-bit/PROJECT-OS/pull/95)).
- **DEC-POS-013** («sí PAQ», [#157](https://github.com/jlpulido107-bit/PROJECT-OS/pull/157)), **DEC-POS-014** (carril ALTO, [#160](https://github.com/jlpulido107-bit/PROJECT-OS/pull/160)), **DEC-POS-016** (escritura en NOTAS, [`notas.md`](notas.md))
  y **DEC-POS-017** (despliegue, [operación](operacion.md#cuándo-se-despliega-dec-pos-017-aprobada)). **Hipótesis:** 010 y 015 viven solo en DECISIONES.
- **DEC-POS-018** (APROBADA; PM, hoja, 2026-10-29): agente de finanzas por cortes (días 15 y fin de mes). Fuente: [`diseno-finanzas-v3.md`](diseno-finanzas-v3.md), [#219](https://github.com/jlpulido107-bit/PROJECT-OS/pull/219), [#220](https://github.com/jlpulido107-bit/PROJECT-OS/pull/220).
- **DEC-POS-019** (APROBADA): Fable como SEGUNDO solo en MEDIO sensible; columna SENSIBLE vacía = sensible. Fuente: [delegación](delegacion-codex.md), [#234](https://github.com/jlpulido107-bit/PROJECT-OS/pull/234).
- **DEC-POS-020** (APROBADA): prueba de Gemini hasta el 2026-11-02, como fija el §5 de [`prueba-gemini.md`](prueba-gemini.md). Fuente: [#230](https://github.com/jlpulido107-bit/PROJECT-OS/pull/230).
- **DEC-POS-021** y **DEC-POS-022** (APROBADA): Gemini supervisado como SEGUNDO desde el 2026-11-03 y su origen en el código. Fuente: [§8](prueba-gemini.md), [escritura §6](escritura-v1-8.md), [#237](https://github.com/jlpulido107-bit/PROJECT-OS/pull/237).
- **DEC-POS-009** (dictamen solo en el PR, [migración](migracion-supervision.md)) y **DEC-POS-023** a **DEC-POS-025** constan APROBADA
  (PM, hoja, 2026-10-29): 023 cierre de tareas por el propietario ([#247](https://github.com/jlpulido107-bit/PROJECT-OS/pull/247)), 024 rol Tiempos ([#249](https://github.com/jlpulido107-bit/PROJECT-OS/pull/249)) y
  025 lectura de /api/planificacion para Tiempos ([#260](https://github.com/jlpulido107-bit/PROJECT-OS/pull/260)); 023 y 025 inertes sin sus variables ([escritura §7 y §8](escritura-v1-8.md)).
- Pendiente del propietario: **DEC-SIG-002** (texto en DECISIONES). **Hipótesis:** sigue sin decidir.

## En curso

- Fusionadas desde el último estado (GitHub, 2026-10-29; 104 a 108 en el estado anterior):
  - /eco pipeline: 109 [#254](https://github.com/jlpulido107-bit/PROJECT-OS/pull/254) (hallazgos de 104) y 110 [#256](https://github.com/jlpulido107-bit/PROJECT-OS/pull/256) (formularios de alta y edición).
  - Tiempos: 111 [#259](https://github.com/jlpulido107-bit/PROJECT-OS/pull/259) (`planear-tiempo` v1.1) y 112 [#260](https://github.com/jlpulido107-bit/PROJECT-OS/pull/260) (lectura de /api/planificacion, inerte sin `TIEMPOS_AGENTE`).
  - /eco y lector: 113 [#262](https://github.com/jlpulido107-bit/PROJECT-OS/pull/262) (nombres, títulos y unidades) y 114 [#264](https://github.com/jlpulido107-bit/PROJECT-OS/pull/264) (Sheets hasta la columna AZ).
  - Según el PM (hoja, 2026-10-29), 109 a 114 están CERRADA, igual que ORD-ECO-014 a 017 (RADAROS [#34](https://github.com/jlpulido107-bit/RADAROS/issues/34),
    [#36](https://github.com/jlpulido107-bit/RADAROS/issues/36), [#39](https://github.com/jlpulido107-bit/RADAROS/issues/39), [#40](https://github.com/jlpulido107-bit/RADAROS/issues/40)).
- Órdenes abiertas (GitHub, 2026-10-29): ninguna, aparte de ORD-POS-116 ([issue #266](https://github.com/jlpulido107-bit/PROJECT-OS/issues/266), este estado).
- Despliegue (PM, registros de despliegue, 2026-10-29), smoke 52/52 en las cuatro revisiones:
  - `00041-r59` (commit `ef87895`, 109): variables nuevas `RADAROS_SHEET_ID`, `ECO_PIPELINE_WRITE_MODE`, `ECO_PIPELINE_WRITE_SERVICE_ACCOUNT`
    y `ECO_PIPELINE_WRITER_EMAIL`; /eco/pipeline activo ([registro del #254](https://github.com/jlpulido107-bit/PROJECT-OS/pull/254#issuecomment-6459739774)).
  - `00042-jt6` (`7e64bac`, 110, formularios; nota en [#256](https://github.com/jlpulido107-bit/PROJECT-OS/pull/256)); `00043-7px` (`3a0646c`, 111 y 112, sin variables; nota en [#260](https://github.com/jlpulido107-bit/PROJECT-OS/pull/260)).
  - Activa: `00044-ncz` (`4d5de3f`, 113 y 114, sin variables; nota en [#264](https://github.com/jlpulido107-bit/PROJECT-OS/pull/264)). Revertir: tráfico a `00043-7px`.
- Sin poner `TIEMPOS_AGENTE` ni `TAREAS_CIERRE_PROPIETARIO` (PM, hoja, 2026-10-29): su activación es la tarea POS-037.
- Pipeline real (PM, hoja, 2026-10-29): PRD-0003 (EC-006) en COTIZANDO con 3 cotizaciones SOLICITADA.
- Rutinas y modelos: implementa y corrige Opus, revisa Sonnet, SEGUNDO Fable 5.1 o gemini-supervisado ([operación](operacion.md)).
- Riesgo conocido: la reserva supone una sola instancia (`maxScale: 1`) ([migración](migracion-supervision.md)).
- **Hipótesis** (último dato del PM, 2026-10-28): **SIG-H1** COMPLETADO; **POS-H1** y **SIG-H2** vencen el 2026-10-31; POS-H2 el 2026-11-14.

## Siguiente

- POS-037: activar `TIEMPOS_AGENTE` y `TAREAS_CIERRE_PROPIETARIO` (solo el propietario, con `deploy.sh`; [escritura §7 y §8](escritura-v1-8.md)).
- Hallazgos abiertos (PM, hoja, 2026-10-29): 109 SEGUNDO H1 ([#254](https://github.com/jlpulido107-bit/PROJECT-OS/pull/254#issuecomment-6458814395)) y 110 SEGUNDO H1 y H2 ([#256](https://github.com/jlpulido107-bit/PROJECT-OS/pull/256)),
  BAJA, en /eco/pipeline; 113 PRIMERO H1 ([#262](https://github.com/jlpulido107-bit/PROJECT-OS/pull/262)), orden aparte.
- [`AGENTS.md`](../AGENTS.md) perdió en la fusión de [#260](https://github.com/jlpulido107-bit/PROJECT-OS/pull/260) la redacción de 111 ([#259](https://github.com/jlpulido107-bit/PROJECT-OS/pull/259)) sobre el paquete sin ID a POS · Ideas: orden aparte.
- Renovar `PROJECT_OS_GH_READ_TOKEN` antes del 2026-11-07 (propietario).
- POS-H1 y SIG-H2 vencen el 2026-10-31; prueba real del agente de finanzas el 2026-11-01 (primer corte de fin de mes).
- Cierre de la prueba Gemini el 2026-11-02 (DEC-POS-020); desde el 2026-11-03 el SEGUNDO es Gemini supervisado ([§8](prueba-gemini.md)).
- Primera corrida del rol Tiempos (`planear-tiempo`, modo LUNES) el lunes 2026-11-02; sin rutina programada.
- Decidir DEC-SIG-002 (propietario). **Hipótesis:** ORD-POS-068 sigue en BORRADOR, por cancelar.

## Cómo se actualiza

Después de fusionar, en un PR aparte (evita conflictos entre PRs en paralelo), con la skill
[`cerrar-orden`](../.claude/skills/cerrar-orden/SKILL.md).
