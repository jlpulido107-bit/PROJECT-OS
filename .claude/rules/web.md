---
paths:
  - "web/**"
---

# Reglas de web/

Se suman a [`AGENTS.md`](../../AGENTS.md); no las repiten.

- Lectura de Google Sheets: cuenta de servicio con alcance `spreadsheets.readonly`, solo `GET` y solo en el servidor (`web/src/lib/sheets-client.ts`).
- Escritura: solo por la API de operaciones con la cuenta de escritura dedicada (`web/src/lib/operations`, `web/src/lib/operations/write-credentials.ts`; ver [`docs/escritura-v1-8.md`](../../docs/escritura-v1-8.md)), y las únicas excepciones
  aprobadas: la escritura de finanzas (ORD-POS-077), solo en el libro FINANZAS, con su cuenta exclusiva y su guard sin agente
  (`web/src/lib/finanzas/escritura-*.ts`; ver [`docs/diseno-finanzas-v2.md`](../../docs/diseno-finanzas-v2.md)), y las rutas del agente de
  finanzas (ORD-POS-092), solo en FINANZAS, con su cuenta, su token y su guard propio, inertes sin `FINANZAS_AGENTE_MODE`
  (`web/src/lib/finanzas/agente-*.ts`; ver [`docs/diseno-finanzas-v3.md`](../../docs/diseno-finanzas-v3.md)), y la escritura del pipeline de /eco
  (ORD-POS-102), solo en las pestañas `PIPE_*` del libro de RADAROS, con su cuenta exclusiva y su guard sin agente, inerte sin
  `ECO_PIPELINE_WRITE_MODE` (`web/src/lib/radaros/pipeline-escritura-*.ts`; ver [`docs/diseno-eco-pipeline.md`](../../docs/diseno-eco-pipeline.md)),
  y el alta de ideas del PM (ORD-POS-131, DEC-ECO-007), solo filas nuevas en `PRODUCTS` (A:P) y `SCORING` (A:L) del libro
  de RADAROS, por la API de operaciones con el token del PM y la cuenta del pipeline, inerte sin `ECO_IDEAS_ALTA`
  (`web/src/lib/radaros/ideas-alta*.ts`; ver [`docs/escritura-v1-8.md`](../../docs/escritura-v1-8.md) §9).
  No crear otras vías de escritura.
- Escritura del PM (DEC-POS-005): solo la sesión PM escribe, por la API de operaciones y con la skill `pm-escribir-api`
  (ver [`AGENTS.md`](../../AGENTS.md)). Nadie escribe en la hoja con el conector; implementación y revisión tampoco.
- Antes de escribir código de Next.js, lee la guía correspondiente en `web/node_modules/next/dist/docs/`.
- Si cambias `web/`, corre en `web/`: `npm test`, `npm run lint`, `npm run typecheck` y `npm run check:client-secrets`.
- Usa `npm ci`; para cambiar dependencias, npm 11 (ver [`web/README.md`](../../web/README.md)).
