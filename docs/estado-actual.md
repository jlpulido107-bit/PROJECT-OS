# Estado actual — PROJECT-OS

Foto breve para arrancar una sesión. Fecha: 2026-10-17. Memoria duradera: [`brief-proyecto.md`](brief-proyecto.md).
Todo dato lleva su fuente; lo que no pude verificar va como **hipótesis**.

## Decisiones vigentes

- **DEC-POS-001** (2026-10-16): ChatGPT dirige y supervisa; sustituida en el reparto por DEC-POS-002. Fuente: [delegación](delegacion-codex.md).
- **DEC-POS-002** (2026-10-16): Claude planea, implementa, revisa y corrige en sesiones separadas; ChatGPT es auditor. Fuente: [`AGENTS.md`](../AGENTS.md), PR #70.
- **DEC-POS-003** (2026-10-16): la revisión se gradúa por riesgo. Fuente: [política](delegacion-codex.md#política-de-revisión-por-riesgo-dec-pos-003), PR #70.
- **DEC-POS-004** (2026-10-16): persistencia de la supervisión (D1 a D3), decidida y no implementada. Fuente: [migración](migracion-supervision.md).
- **DEC-POS-005** (2026-10-16): el PM (Claude) solo escribe en la hoja por la API del dashboard (tareas, decisiones PENDIENTE y órdenes BORRADOR); nunca aprueba, cierra ni cambia estados del propietario. Fuente: pestaña DECISIONES.
- **DEC-POS-006** (2026-10-16): interina hasta O5b; el PM añade filas en TAREAS, DECISIONES y ORDENES_CODEX con el conector de Google Sheets, solo con la skill `pm-escribir-hoja` y tras el «sí» del propietario; un solo escritor; caduca al desplegar O5b. Fuente: pestaña DECISIONES, [`AGENTS.md`](../AGENTS.md), PR #76.

## En curso

- Órdenes: ningún issue abierto en GitHub (consulta del 2026-10-17). Fusionadas desde la foto anterior: ORD-POS-018 (#70),
  020 (#73), 021 (#74), 022 (#76), 023 (#83), 024 (#84), 025 (#81) y 026 (#82).
- Skills de rutina en `.claude/skills/`: `ejecutar-orden`, `revisar-orden`, `corregir-pr`, `planear-proyecto`,
  `pm-escribir-hoja` y `cerrar-orden`. Fuente: PRs #76, #81, #82, #83 y #84.
- PR abierto: #51, skills de terceros (sin orden en el título).
- Verificación E1 de V1.6 el 2026-11-11. Fuente: [brief](brief-proyecto.md#riesgos). El issue #22 ya no está abierto.
- ORD-POS-008 (#52): el issue ya no está abierto y no hay PR `[ORD-POS-008]`; **hipótesis:** se canceló o se absorbió.
- Metas (HITOS) y tareas (TAREAS): **hipótesis**, viven en la hoja y esta sesión no la leyó.

## Siguiente

- El propietario marca en el dashboard el estado de las órdenes fusionadas (lista en el PR de esta actualización).
- Implementar DEC-POS-004 con una orden por decisión. Fuente: [migración](migracion-supervision.md).
- Desplegar O5b (API auditada para el agente), con lo que caduca DEC-POS-006. Fuente: [`AGENTS.md`](../AGENTS.md).
  **Hipótesis:** sin orden abierta todavía.

## Cómo se actualiza

Al cerrar cada orden se reescribe este archivo con la skill `cerrar-orden`. **Hipótesis:** esa skill aún no existe en
`.claude/skills/`; hasta entonces se actualiza en un PR aparte después de fusionar, no dentro de cada orden (evita
conflictos entre PRs en paralelo).
