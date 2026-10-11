# PROJECT-OS — Backlog V1.7 (hipótesis, **no aprobadas**)

> Ninguna entrada de este documento es una funcionalidad aprobada ni autoriza trabajo. Son **hipótesis** para
> priorizar con el propietario. Lo que exige mutaciones de producción, escritura real o automatizaciones requiere una
> decisión explícita aparte.

**Escala:** valor y riesgo en A (alto), M (medio) o B (bajo). Costo en S (horas), M (días) o L (semanas).

## 1. Quick wins (bajo riesgo, solo repositorio)

| # | Hipótesis | Valor | Riesgo | Dependencia | Costo | Prioridad |
| --- | --- | --- | --- | --- | --- | --- |
| Q1 | Completar la evidencia real de la matriz con `plan-inspeccion` + `evidencia` y registrar la tabla | A | B | Lecturas del propietario | S | **P0** |
| Q2 | Versión de `web/package.json` a `1.6.0` y descripción actualizada (D-6) | B | B | — | S | P3 |
| Q3 | Reporte de calidad de datos: por pestaña, filas descartadas, columnas faltantes y fechas inválidas, sin valores. Ya existe el contador "12/12 pestañas válidas" | M | B | — | M | P2 |
| Q4 | Que los PR solo de `docs/**` también ejecuten `npm test` en CI (hoy el filtro es `web/**`) | M | B | Cambio de workflow | S | P2 |
| Q5 | Prueba que vincule el resumen de la matriz con el registro de producción al actualizar estados | B | B | — | S | P3 |
| Q6 | Añadir `favicon.ico`: hoy responde 404 (visto en E2), sin efecto funcional | B | B | Cambio de código, desplegado en el próximo build autorizado | S | P3 |

## 2. Mejoras arquitectónicas (repositorio; exigen diseño y revisión)

| # | Hipótesis | Valor | Riesgo | Dependencia | Costo | Prioridad |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | **Trazabilidad Sheets ↔ GitHub:** vincular IDs de tarea (`POS-001`) con PRs e issues usando el colector existente (`src/collect_activity.py`), en solo lectura | A | M | Convención de IDs en commits y PRs | M | P1 |
| R2 | **Esquema y validaciones:** diccionario de datos y validación por pestaña con errores tipificados (roadmap V1.1) | A | B | Q3 | M | P1 |
| R3 | **Decisiones y tiempos:** historial consultable en solo lectura (V1.4 ya define el contrato de escritura simulada) | M | B | R2 | M | P2 |
| R4 | **Planificación:** comparar el plan simulado con el avance real por semana, en solo lectura | M | M | R1, R2 | M | P2 |
| R5 | CSP con *nonces* por petición (R7 de la preparación) | M | M | Pruebas E2E de UI | M | P2 |
| R6 | Caché y limitador compartidos o explícitamente por instancia; prerrequisito si D-1 resulta > 1 o si se activa la escritura | M | M | D-1 | M | P2 |

## 3. Cambios que exigen autorización explícita del propietario

| # | Hipótesis | Valor | Riesgo | Por qué requiere autorización | Prioridad |
| --- | --- | --- | --- | --- | --- |
| X1 | Etiquetar el digest desplegado como `produccion` (C9) | A | B | Mutación en Artifact Registry | **P0**, antes del próximo build |
| X2 | Alinear el `maxScale` de servicio a 1 (D-1), tras medirlo | M | B | Cambia un recurso de Cloud Run | P1 |
| X3 | IAP delante de Cloud Run, para ocultar el login de Internet | M | M | Cambia el acceso y los costos; afecta a OAuth | P2 |
| X4 | Alertas de Monitoring (sonda, errores 5xx) | M | B | Crea recursos y notificaciones | P2 |
| X5 | Sincronización programada GitHub → Sheets | M | M | `AGENTS.md`: no habilitar `schedule` sin una prueba real aprobada | P3 |
| X6 | **Escritura real en Sheets** (V1.4 en modo `sheets`) | A | **A** | Exige el contrato V1.4: escritor único, auditoría, idempotencia y concurrencia; D-1 resuelta; nuevo alcance OAuth/IAM; revisión de seguridad | P3, solo tras R6 y X2 |
| X7 | Presupuesto con tope de gasto (Preview) o corte automático | B | A | Automatización con efectos destructivos | No recomendado |

## 4. Orden sugerido

1. Q1, X1.
2. X2, R2.
3. R1, Q3, Q4.
4. R3–R6.
5. X3–X6, cada una con su propia misión y autorización.
