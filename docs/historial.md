# Historial — PROJECT-OS

Lo que ya no es vigente y salió de [estado actual](estado-actual.md): órdenes fusionadas y despliegues anteriores.
Lo más nuevo arriba. Cada dato con su fuente; lo no verificado va como **hipótesis**. Lo anterior al 2026-10-29 vive
en el historial de git de `docs/estado-actual.md` (p. ej. [#252](https://github.com/jlpulido107-bit/PROJECT-OS/pull/252)).

## Órdenes fusionadas

### 2026-10-30

- 115 [#270](https://github.com/jlpulido107-bit/PROJECT-OS/pull/270) (/eco: comisión de Amazon en porcentaje y fecha de tarifas legible;
  PRIMERO con CAMBIOS, DELTA CONFORME; según el PM se cerró sin pasar por REVISADA).
- 116 [#268](https://github.com/jlpulido107-bit/PROJECT-OS/pull/268) (estado actual tras 109 a 114) y 117
  [#269](https://github.com/jlpulido107-bit/PROJECT-OS/pull/269) (AGENTS.md: paquete sin ID de Tiempos y DEC-POS-023 a 025 APROBADA).

### 2026-10-29 (104 a 108 en el estado anterior)

- /eco pipeline: 109 [#254](https://github.com/jlpulido107-bit/PROJECT-OS/pull/254) (hallazgos de 104) y 110 [#256](https://github.com/jlpulido107-bit/PROJECT-OS/pull/256) (formularios de alta y edición).
- Tiempos: 111 [#259](https://github.com/jlpulido107-bit/PROJECT-OS/pull/259) (`planear-tiempo` v1.1) y 112 [#260](https://github.com/jlpulido107-bit/PROJECT-OS/pull/260) (lectura de /api/planificacion, inerte sin `TIEMPOS_AGENTE`).
- /eco y lector: 113 [#262](https://github.com/jlpulido107-bit/PROJECT-OS/pull/262) (nombres, títulos y unidades) y 114 [#264](https://github.com/jlpulido107-bit/PROJECT-OS/pull/264) (Sheets hasta la columna AZ).
- Según el PM (hoja, 2026-10-29), 109 a 114 están CERRADA, igual que ORD-ECO-014 a 017 (RADAROS [#34](https://github.com/jlpulido107-bit/RADAROS/issues/34),
  [#36](https://github.com/jlpulido107-bit/RADAROS/issues/36), [#39](https://github.com/jlpulido107-bit/RADAROS/issues/39), [#40](https://github.com/jlpulido107-bit/RADAROS/issues/40)).
- Hallazgo resuelto por 117: [`AGENTS.md`](../AGENTS.md) había perdido en la fusión de [#260](https://github.com/jlpulido107-bit/PROJECT-OS/pull/260) la redacción de 111 ([#259](https://github.com/jlpulido107-bit/PROJECT-OS/pull/259)).

## Despliegues anteriores

- `00045` (2026-10-29, según el propietario vía POS · Ideas): 105, 106, 112, 113 y 114; encendió `TAREAS_CIERRE_PROPIETARIO`
  y `TIEMPOS_AGENTE` (tarea POS-037) ([registro en #270](https://github.com/jlpulido107-bit/PROJECT-OS/pull/270#issuecomment-6532847729)).
- Registros de despliegue del PM (2026-10-29), smoke 52/52 en las cuatro revisiones:
  - `00041-r59` (commit `ef87895`, 109): variables nuevas `RADAROS_SHEET_ID`, `ECO_PIPELINE_WRITE_MODE`, `ECO_PIPELINE_WRITE_SERVICE_ACCOUNT`
    y `ECO_PIPELINE_WRITER_EMAIL`; /eco/pipeline activo ([registro del #254](https://github.com/jlpulido107-bit/PROJECT-OS/pull/254#issuecomment-6459739774)).
  - `00042-jt6` (`7e64bac`, 110, formularios; nota en [#256](https://github.com/jlpulido107-bit/PROJECT-OS/pull/256)); `00043-7px` (`3a0646c`, 111 y 112, sin variables; nota en [#260](https://github.com/jlpulido107-bit/PROJECT-OS/pull/260)).
  - `00044-ncz` (`4d5de3f`, 113 y 114, sin variables; nota en [#264](https://github.com/jlpulido107-bit/PROJECT-OS/pull/264)).

## Hitos y fechas pasadas

- Último dato del PM (2026-10-28): SIG-H1 COMPLETADO; POS-H1 y SIG-H2 vencían el 2026-10-31; POS-H2 el 2026-11-14.
  Según el PM (orden ORD-POS-119, 2026-10-30), los cuatro quedaron COMPLETADO.
- ORD-POS-116 ([issue #266](https://github.com/jlpulido107-bit/PROJECT-OS/issues/266)) fue la última orden abierta del estado del 2026-10-29.
