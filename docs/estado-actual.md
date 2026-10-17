# Estado actual — PROJECT-OS

Foto breve para arrancar una sesión. Fecha: 2026-10-17. Memoria duradera: [`brief-proyecto.md`](brief-proyecto.md).
Todo dato lleva su fuente; lo que no pude verificar va como **hipótesis**.

## Decisiones vigentes

- **DEC-POS-001** (2026-10-16): ChatGPT dirige y supervisa; sustituida en el reparto por DEC-POS-002. Fuente: [delegación](delegacion-codex.md).
- **DEC-POS-002** (2026-10-16): Claude planea, implementa, revisa y corrige en sesiones separadas; ChatGPT es auditor. Fuente: [`AGENTS.md`](../AGENTS.md).
- **DEC-POS-003** (2026-10-16): la revisión se gradúa por riesgo. Fuente: [política](delegacion-codex.md#política-de-revisión-por-riesgo-dec-pos-003).
- **DEC-POS-004** (2026-10-16): persistencia de la supervisión (D1 a D3), decidida y no implementada. Fuente: [migración](migracion-supervision.md).
- **DEC-POS-005**: el PM (Claude) solo escribe en la hoja por la API del dashboard (tareas, decisiones PENDIENTE y órdenes BORRADOR); nunca aprueba, cierra ni cambia estados del propietario. Fuente: pestaña DECISIONES.
- **DEC-POS-006**: interina hasta O5b; el PM añade filas en TAREAS, DECISIONES y ORDENES_CODEX con el conector de Google Sheets, solo con la skill `pm-escribir-hoja` y tras el «sí» del propietario; un solo escritor; caduca al desplegar O5b. Fuente: pestaña DECISIONES.

## En curso

- Órdenes (issues abiertos, 2026-10-17): ORD-POS-008 (#52), ORD-POS-020 (#72, esta memoria) y ORD-POS-021 (#71, hook de inicio).
- PR abierto: #51, skills de terceros (sin orden en el título).
- Verificación E1 de V1.6 el 2026-11-11 (issue #22). Fuente: [brief](brief-proyecto.md#riesgos).
- Metas (HITOS) y tareas (TAREAS): **hipótesis**, viven en la hoja y esta sesión no la leyó.

## Siguiente

- Fusión de las órdenes abiertas, decidida por el propietario.
- Implementar DEC-POS-004 con una orden por decisión. Fuente: [migración](migracion-supervision.md).

## Cómo se actualiza

Al cerrar cada orden se reescribe este archivo con la skill `cerrar-orden`. **Hipótesis:** esa skill aún no existe en
`.claude/skills/`; hasta entonces lo actualiza la orden que cambie el estado.
